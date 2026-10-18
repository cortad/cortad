// What a door is proven to do, from the exchanges the hook recorded inside the app: requests that
// reached a model, what the app answered and the model calls on the way. Everything here is read off
// those rows; nothing is guessed from code. The shape is the backend's DoorProof
// (src/local/door-proof.ts). Pure: the one lookup into the repository is handed in as `find`.
import { documentAt, readable } from "./document.mjs";

const HOP = /^(?:host|content-length|connection|keep-alive|transfer-encoding|upgrade|expect|te|trailer|accept-encoding|x-cortad-as|x-cortad-turn)$/i;
// Headers every client sends: never what holds a conversation.
const PLAIN_HEADER = /^(?:accept(?:-.*)?|content-.*|user-agent|origin|referer|cookie|cache-control|pragma|priority|dnt|sec-.*|x-forwarded-.*|x-real-ip|if-.*)$/i;
// A provider request's settings, as every provider names them: not what the model was told.
const SETTING = /^(?:model|role|type|id|object|stream|tool_choice|response_format|stop|user|name|tool_call_id|call_id|index|encoding_format|service_tier|reasoning_effort|modalities)$/;
// The last ask as asked, clipped; the reply whole, to the bound the run keeps a model's words to.
const SAMPLE = 600, SAMPLE_REPLY = 4000;
const PROBLEMS_MAX = 12;

const str = (v) => (typeof v === "string" ? v : "");
const arr = (v) => (Array.isArray(v) ? v : []);
const parse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}...` : s);
// A provider's message quoted to the person, cut at a space before `n` and never inside a link, which is
// kept whole up to LINK_MAX: OpenAI's quota error ends on the page that says what to do about it.
const LINK_MAX = 200;
const clipAtWord = (s, n) => {
  if (s.length <= n) return s;
  const link = [...s.matchAll(/https?:\/\/\S+/g)].find((m) => m.index < n && m.index + m[0].length > n);
  const end = link ? Math.min(link.index + link[0].length, link.index + LINK_MAX) : s.lastIndexOf(" ", n);
  return end >= s.length ? s : `${s.slice(0, end > 0 ? end : n)}...`;
};
// Read once per exchange: a prompt can run to a quarter of a megabyte and is asked of many times.
const once = (fn) => { const seen = new WeakMap(); return (ex) => { if (!seen.has(ex)) seen.set(ex, fn(ex)); return seen.get(ex); }; };
const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
// The hook's own normal form: JSON escapes read as the characters they stand for, case and spacing folded.
export const norm = (s) => String(s ?? "")
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\[nrt]/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  .toLowerCase().replace(/\s+/g, " ").trim();
// A value made to name one thing: a number of six digits or more, a uuid, hex, or a run of letters
// and digits too long to be a word. "gpt-4o-mini" is none of them.
const SESSION_NAME = /^(?:session|conversation|thread|chat|dialog(?:ue)?|convo)(?:[_-]?(?:id|key|token|uuid))?$|^(?:id|uuid)$/i;
const idLike = (v) => /^\d{6,}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-|^[0-9a-f]{12,}$/i.test(v) || v.split(/[-_.:]/).some((s) => s.length >= 12 && /\d/.test(s) && /[a-z]/i.test(s));

// Every scalar leaf, with its path: object keys, and list positions as numbers.
function leaves(v, at = [], out = [], max = 400) {
  if (out.length >= max || at.length > 10) return out;
  if (typeof v === "string" || typeof v === "number") out.push({ at, value: String(v) });
  else if (Array.isArray(v)) v.forEach((x, i) => leaves(x, [...at, i], out, max));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, [...at, k], out, max);
  return out;
}
// A leaf's field: its keys up to the first list. A leaf inside a list is part of that list.
const fieldOf = (at) => { const i = at.findIndex((k) => typeof k === "number"); return (i < 0 ? at : at.slice(0, i)).join("."); };
const inList = (at) => at.some((k) => typeof k === "number");

// ---- rows to exchanges

const request = (r) => (r && typeof r === "object" && typeof r.method === "string" && str(r.path).startsWith("/") ? {
  at: Number(r.at) || 0, ms: Number(r.ms) || 0, method: r.method.toUpperCase(), path: r.path, body: str(r.body), status: Number(r.status) || 0,
  reply: str(r.reply), cookies: arr(r.cookies).filter((c) => typeof c === "string"), ...(r.cut === true ? { cut: true } : {}),
} : null);

// An answer that came on a second request is one exchange: the request that asked is the door, the
// second step carried the reply, and the requests sent just before it in the same turn go first.
function turnOf(ex, steps) {
  const asked = steps.at(-1);
  if (!asked) return ex;
  return {
    ...ex, at: asked.at, ms: ex.at + ex.ms - asked.at, method: asked.method, path: asked.path, body: asked.body,
    cookies: [...new Set([...steps.flatMap((s) => s.cookies), ...ex.cookies])],
    answer: { method: ex.method, path: ex.path, asked: asked.reply }, before: steps.slice(0, -1),
  };
}

// The app's own lines that wrote a reply ("path:line"), each with the event it sent there, when the
// reply names its events, and the first bytes it wrote there.
const AT = /^[^\n\r\t]{1,300}:\d{1,7}$/;
const EVENT = /^[\w.:-]{1,40}$/;
export const sitesOf = (v) => arr(v).filter((s) => s && typeof s.at === "string" && AT.test(s.at) && typeof s.text === "string").slice(0, 16)
  .map((s) => ({ at: s.at, ...(typeof s.event === "string" && EVENT.test(s.event) ? { event: s.event } : {}), text: s.text.slice(0, 300) }));

// Trace rows come from inside a process this command does not control: every field is checked.
export function exchangesOf(rows) {
  const byId = new Map();
  const slot = (id) => { if (!byId.has(id)) byId.set(id, { calls: [], deps: [], sites: [] }); return byId.get(id); };
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    if (typeof r.ex === "string" && request(r)) slot(r.ex).row = r;
    else if (r.call && typeof r.call.ex === "string") slot(r.call.ex).calls.push(r.call);
    else if (r.dep && typeof r.dep.ex === "string") slot(r.dep.ex).deps.push(r.dep);
    else if (r.sites && typeof r.sites.ex === "string") slot(r.sites.ex).sites = sitesOf(r.sites.list);
  }
  return [...byId.values()].filter((x) => x.row).map(({ row, calls, deps, sites }) => turnOf({
    id: row.ex, ...request(row), headers: row.headers && typeof row.headers === "object" ? row.headers : {}, trial: typeof row.turn === "string", turn: str(row.turn),
    sent: arr(row.sent).filter((s) => typeof s === "string"), type: str(row.type), writes: Number(row.writes) || 0, calls, deps, sites,
    ...(row.later === true ? { later: true } : {}),
  }, arr(row.after).map(request).filter(Boolean))).sort((a, b) => a.at - b.at);
}

// A request Cortad sent carries a turn tag, the person's own never does. A door is proven by the
// person's requests; ours prove it only when no request of theirs reached it, and the proof says so.
export const provingOf = (exchanges) => { const own = exchanges.filter((ex) => !ex.trial); return own.length ? own : exchanges; };
// The three requests Cortad sends through a door after each proof (backend src/local/canary.ts):
// "a" a conversation of two turns, "b" a new one. Never part of the door's proof.
const CANARY = /^canary:(\d{1,10}):([ab]):([12])$/;
export const isCanary = (ex) => CANARY.test(ex.turn ?? "");
// Cortad's test request to an endpoint before any run (lib/reach.mjs).
const REACH = /^reach:/;

// ---- which door an exchange came through

const routeRe = (template) => new RegExp(`^${template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^/{}]+\}/g, "([^/]+)")}/?$`);

// The app's own route that answered, from its framework's table; without one, the path, with a
// segment that reads as an id standing for any.
export function doorOf(ex, routes = []) {
  const bare = ex.path.split("?")[0];
  const fits = routes.filter((r) => r && r.method === ex.method && typeof r.path === "string" && routeRe(r.path).test(bare))
    .sort((a, b) => (a.path.match(/\{/g) ?? []).length - (b.path.match(/\{/g) ?? []).length);
  const path = fits[0]?.path ?? bare.split("/").map((s) => (/^\d+$/.test(s) || idLike(s) ? "{id}" : s)).join("/");
  return { method: ex.method, path, key: `${ex.method} ${path}` };
}

// The value each {name} of the template took in this exchange's path.
const paramsOf = (template, path) => {
  const names = [...template.matchAll(/\{([^/{}]+)\}/g)].map((m) => m[1]);
  const m = routeRe(template).exec(path.split("?")[0]);
  return m ? Object.fromEntries(names.map((n, i) => [n, m[i + 1]])) : {};
};

// What each {name} of the route took in the person's own request, which every trial sends again.
// A value that would move the request to another route is left out (the backend refuses it too).
const PATH_VALUE = /^(?!\.\.?$)[^/?#\s]{1,200}$/;
const pathValuesOf = (template, path) => {
  const kept = Object.entries(paramsOf(template, path)).filter(([k, v]) => /^[^/{}\s]{1,100}$/.test(k) && PATH_VALUE.test(v ?? ""));
  return kept.length ? { pathValues: Object.fromEntries(kept.slice(0, 20)) } : {};
};

// ---- what went in, what the model was told, what came back

const headerOf = (headers, name) => Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
const bodyOf = once((ex) => {
  const json = parse(ex.body);
  if (json && typeof json === "object") return json;
  if (/x-www-form-urlencoded/i.test(str(headerOf(ex.headers, "content-type")))) return Object.fromEntries(new URLSearchParams(ex.body));
  return null;
});
// Every string the app sent its models in this exchange, settings left out.
const promptOf = once((ex) => norm(ex.sent.map((s) => {
  const v = parse(s);
  return v && typeof v === "object" ? leaves(v, [], [], 5000).filter((l) => !SETTING.test(String(l.at.at(-1)))).map((l) => l.value).join("\n") : s;
}).join("\n")));
const generation = (ex) => ex.calls.filter((c) => !c.embedding);
const answeredCalls = (ex) => generation(ex).filter((c) => typeof c.reply === "string" && c.reply);
// The words the model answered with on the call the app's reply carries most of, the last such call
// on a tie: LearnHouse answers in one call and writes follow-up suggestions in a second, and taking
// the last call's words showed the suggestions as the reply and missed that the next turn went on
// from the answer.
const tokensOf = (s) => str(s).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
const modelWords = (ex) => {
  const calls = answeredCalls(ex);
  if (calls.length < 2) return str(calls.at(-1)?.reply);
  const body = new Set(tokensOf(ex.reply));
  const carried = (c) => tokensOf(c.reply).filter((t) => body.has(t)).length;
  return str(calls.reduce((best, c) => (carried(c) >= carried(best) ? c : best)).reply);
};
// A stream that carried no counts is priced from its text, four characters to a token, and marked so:
// yunqiao's quote had no figure at all for a model its provider publishes a price for.
const estimatedTokens = (exchanges) => {
  const prompt = median(exchanges.map((ex) => Math.ceil(promptOf(ex).length / 4)));
  return prompt ? { prompt, completion: median(exchanges.map((ex) => Math.ceil(modelWords(ex).length / 4))) ?? 0, estimated: true } : null;
};
// How much of the pieces the model said, by length.
const overlap = (pieces, words) => pieces.reduce((n, p) => { const t = norm(p); return n + (t && words.includes(t) ? p.length : 0); }, 0);

// The reply read whole: JSON at the leaf the model's words sit in (the longest leaf when they are not
// known), a stream put back together from its events, text as it is. A request answered later, by
// its model after its own reply went out, was answered with the model's last words.
export const replyOf = once((ex) => {
  if (ex.later) return { text: modelWords(ex), path: null, stream: false };
  const words = norm(modelWords(ex));
  const whole = parse(ex.reply);
  const stream = /event-stream|ndjson|jsonl|stream/i.test(ex.type) || (ex.writes > 1 && whole === undefined);
  if (!stream && whole && typeof whole === "object") {
    const best = leaves(whole).filter((l) => /\D/.test(l.value))
      .map((l) => ({ l, score: words ? overlap([l.value], words) : l.value.length }))
      .sort((a, b) => b.score - a.score || b.l.value.length - a.l.value.length)[0];
    // The leaf names the field the run reads; the reply is the document it sits in, when it sits in one.
    const text = best ? documentAt(whole, best.l.at) ?? readable(best.l.value) : "";
    return { text, path: best ? newestReply(whole, best.l.at).join(".") : null, stream: false };
  }
  if (!stream) return { text: readable(typeof whole === "string" ? whole : ex.reply), path: null, stream: false };
  const { events, loose } = eventsOf(ex.reply);
  // The words of the call the reply carries most of (modelWords): the last call of an agent can be a
  // memory write, and a second call can write follow-up suggestions, neither of them the answer.
  return threaded(events, words) ?? { text: readable(assembled(events, loose, words, ex.reply)), path: null, stream: true };
});

// Ours, for a stream that ended on an error and said nothing: never quoted as the app's words.
const NO_TEXT = "the reply's stream finished on an error before any text";
const withError = (error) => (error === NO_TEXT ? "and its reply ended on an error before any text" : `with an error: "${clipAtWord(error, 160)}"`);
// A stream's events: SSE data lines, JSON lines, or a JSON value behind a short prefix per line.
// An SSE event named for the model's reasoning carries its thinking, never the answer (yunqiao's
// stream sends `event: thinking` before its answer). `errors`: what its events say as an error, read
// from its data lines when it has any, else only when every line is an event, as the run reads a
// stream (backend src/customer/endpoint.ts streamFrames).
const THINKING = /reason|think/i;
function eventsOf(raw) {
  const events = [];
  const loose = [];
  const errors = [];
  const sse = /^data:/m.test(raw);
  let named = "";
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) { named = ""; continue; }
    const event = /^event:\s*(.*)$/.exec(line);
    if (event) { named = event[1].trim(); continue; }
    if (/^(?:id|retry):|^:/.test(line) || THINKING.test(named)) continue;
    const data = line.startsWith("data:") ? line.slice(5).replace(/^ /, "") : line;
    if (data.trim() === "[DONE]") continue;
    let v = parse(data);
    const part = v === undefined ? /^(\w{1,3}):/.exec(data) : null;
    if (part) v = parse(data.slice(part[0].length));
    // The AI SDK data stream says its error as part 3.
    const said = !sse || line.startsWith("data:") ? eventError(v, part?.[1] === "3" ? "error" : named, data) : "";
    if (said) errors.push(said);
    if (v === undefined || v === null || typeof v !== "object" && typeof v !== "string") loose.push(data);
    else events.push(v);
  }
  // A stream that finishes on an error with no word written is the app's own error (one rule with the
  // backend's readError): the AI SDK ends a reply whose model call failed with finishReason "error".
  const is = (v, type) => v && typeof v === "object" && v.type === type;
  if (!errors.length && events.some((v) => is(v, "finish") && v.finishReason === "error") && !events.some((v) => is(v, "text-delta") && str(v.delta).trim())) errors.push(NO_TEXT);
  return { events, loose, errors: sse || !loose.length ? errors : [] };
}

// What one event says as an error, as the run reads it (backend endpoint.ts readError): its error field,
// a string or {message}; the words of an event typed or named "error"; whatever an event named "error"
// carries. An event of another type with an error beside it is a note: resumeforge's
// {"type":"sources","error":"no public sources found"} went on to a full answer.
function eventError(v, named, data) {
  const o = v && typeof v === "object" ? v : {};
  if (named !== "error" && typeof o.type === "string" && !/error|fail/i.test(o.type)) return "";
  const e = o.error ?? (o.type === "error" || named === "error" ? o.message ?? o.detail ?? o.errorText : undefined);
  const said = (typeof e === "string" ? e : str(e?.message)).trim();
  return said || (named === "error" ? (typeof v === "string" ? v : data).trim() : "");
}

// A path read the way the run reads one: `-1` is a list's last entry.
const at = (v, path) => path.reduce((o, k) => (o === null || typeof o !== "object" ? undefined : Array.isArray(o) && k === -1 ? o.at(-1) : o[k]), v);
// A concrete path with the last entry of a list of turns written -1, so it still names the newest
// turn when the list holds more of them. A list of anything else is positional and keeps its index.
const newest = (v, path) => path.map((k, i) => { const list = at(v, path.slice(0, i)); return typeof k === "number" && isTurns(list) && k === list.length - 1 ? -1 : k; });
// A reply's place in a thread the app answers with is its newest turn, also where the turns carry no
// side: Nitham's {turns: [{n, kind, request, markdown}]} was read at turns.0.markdown, the first answer,
// on every later turn. Only a reply's path; a request's history keeps the role rule.
const TURNS_NAME = /^(?:turns|messages|history|exchanges|replies)$/i;
const newestReply = (v, path) => path.map((k, i) => {
  const list = at(v, path.slice(0, i));
  const named = i > 0 && TURNS_NAME.test(String(path[i - 1])) && Array.isArray(list) && list.every((e) => e && typeof e === "object" && !Array.isArray(e));
  return typeof k === "number" && (named || isTurns(list)) && k === list.length - 1 ? -1 : k;
});

// A stream whose events carry the whole thread (a queue's completed event holds every turn so far)
// has the reply at one entry of a list, not spread over the events: the leaf the model's words match
// best, named by its path, and read at that path in every event. Null for any other stream.
function threaded(events, words) {
  if (!words) return null;
  let best = null;
  for (const v of events) {
    if (typeof v !== "object") continue;
    for (const l of leaves(v)) {
      const score = overlap([l.value], words);
      if (score && score >= (best?.score ?? 0)) best = { score, path: newest(v, l.at) };
    }
  }
  // A list of records that is not a conversation (a quiz's questions) is a document, read whole.
  const thread = best?.path.some((k, i) => { const list = arr(at(events.find((v) => at(v, best.path) !== undefined), best.path.slice(0, i))); return typeof k === "number" && list.length > 1 && (k === -1 || isTurns(list)); });
  if (!thread) return null;
  const pieces = events.map((v) => at(v, best.path)).filter((s) => typeof s === "string");
  return { text: pieces.at(-1) ?? "", path: best.path.join("."), stream: true };
}

// Each JSON event's text is grouped by where it sits, and the group the model's words run through is
// the reply.
// An event of the app's own stream that carries the model's reasoning or a tool's traffic, never the
// answer: the AI SDK sends reasoning and text as the same `delta`, told apart only by their type.
const NOT_ANSWER = /reason|think|tool|^(?:status|progress|ping|heartbeat)$/i;
// A leaf that names its event and says nothing: the type, an id, how the stream finished. A reply
// that ran its tools and ended with no words is nothing but these, and joined together they were
// shown as what Databuddy answered ("startstart-stepfinish-step").
const LABEL = /^(?:type|event|kind|role|model|name|object|status|finishReason|finish_reason|id|uuid|sequence|index)$|(?:Id|_id)$/;
function assembled(events, loose, words, raw) {
  const groups = new Map();
  for (const v of events) {
    if (v && typeof v === "object" && NOT_ANSWER.test(str(v.type))) continue;
    for (const l of typeof v === "string" ? [{ at: [], value: v }] : leaves(v)) {
      // An OpenAI-compatible stream passed straight through carries the model's thinking beside its
      // answer, in `delta.reasoning_content`.
      if (l.at.some((k) => typeof k === "string" && THINKING.test(k))) continue;
      if (LABEL.test(String(l.at.at(-1) ?? ""))) continue;
      const key = l.at.map((k) => (typeof k === "number" ? "[]" : k)).join(".");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(l.value);
    }
  }
  // Without the model's words, the reply is the group that reads as language: ids and event names
  // repeat on every event and outweigh the words by length, but never hold a space or a non-Latin letter.
  const prose = (pieces) => pieces.filter((v) => /\s|[^\x00-\x7F]/.test(v)).join("").length;
  // With nothing that reads as language, a one-word answer still stands; a count beside it does not.
  const best = [...groups.values()]
    .map((pieces) => ({ text: pieces.join(""), score: words ? overlap(pieces, words) : prose(pieces) }))
    .filter((g) => g.score || /\p{L}/u.test(g.text))
    .sort((a, b) => b.score - a.score || b.text.length - a.text.length)[0];
  return (best?.score ? best.text : loose.join(raw.includes("data:") ? "" : "\n")) || best?.text || "";
}

// ---- the ask

const SYSTEM_ROLE = /^(?:system|developer)$/;
// Fewer letters and digits than this, inside a longer instruction, can sit there by chance ("chat",
// "user"): the hook's own floor for words told, not said (lib/wire.cjs TOLD_MIN).
const TOLD_MIN = 12;
const textIn = (v) => norm(typeof v === "string" ? v : leaves(v, [], [], 5000).filter((l) => !SETTING.test(String(l.at.at(-1)))).map((l) => l.value).join(" "));
// What the model calls were given as the app's instructions and what as the person's turn, apart, in
// the provider shapes the hook reads (lib/wire.cjs instructionsIn), and the models they asked for.
const toldApart = once((ex) => {
  const system = [], person = [];
  const add = (side, v) => { const t = textIn(v); if (t) side.push(t); };
  for (const s of ex.sent) {
    const body = parse(s);
    if (!body || typeof body !== "object") continue;
    for (const v of [body.system, body.instructions, body.systemInstruction?.parts]) if (v !== undefined) add(system, v);
    for (const m of [...arr(body.messages), ...arr(body.input)]) {
      if (SYSTEM_ROLE.test(m?.role)) add(system, m.content);
      else if (m?.role === "user") add(person, m.content);
    }
    for (const c of arr(body.contents)) if (c && c.role !== "model") add(person, c.parts);
    for (const v of [body.input, body.prompt]) if (typeof v === "string") add(person, v);
  }
  return { system, person, models: new Set(generation(ex).map((c) => str(c.model)).filter(Boolean)) };
});

// How a field's own name reads: 0 as the person's message, 2 as the model's instructions, 1 either.
const MESSAGE_NAME = /^(?:user_?)?(?:message|msg|query|question|input|text|content|ask)$/i;
const INSTRUCTIONS_NAME = /system|instruction|persona|preamble|developer/i;
const nameRank = (l) => { const key = String(l.at.at(-1)); return INSTRUCTIONS_NAME.test(key) ? 2 : MESSAGE_NAME.test(key) ? 0 : 1; };
// What the person can be asking in this request: never a turn's side ("user", "assistant"), and in a
// list of turns only its newest, unless its side names the app, since a history ends on the app's reply.
// The person's side goes by any word (a "parent", an id), so only the app's own are told apart.
// One word counts only where the person's turn carried it: a word of the app's instructions matches by
// chance. ulaim's "the Arabic root" made "language" its message, and its history's sides made
// "conversationHistory" its message after that.
const MODEL_SIDE = /^(?:assistant|ai|bot|chatbot|model|system|developer|tool|function|agent)$/i;
const askable = (body, at) => {
  if (TURN_ROLE.test(String(at.at(-1)))) return false;
  const i = at.findIndex((k) => typeof k === "number");
  const list = i < 0 ? null : at.slice(0, i).reduce((v, k) => v?.[k], body);
  return !isTurns(list) || (at[i] === list.length - 1 && !Object.entries(list[at[i]]).some(([k, v]) => TURN_ROLE.test(k) && MODEL_SIDE.test(String(v))));
};
const words = (v) => /\s/.test(v) || (v.match(/[\p{L}\p{N}]/gu) ?? []).length >= TOLD_MIN;

// The body leaves the app's own client set for its model: words the model was given as a whole
// instruction message or only inside one, while another field reached it as the person's turn, and a
// field that named the model it called. A turn of a list is the person's by the role it carries. Two
// fields of their own holding the same words, given once as the instructions and once as the turn,
// are told apart by name, since the words cannot: the one named most like a message is the person's.
// Each other is named the app's, so no trial sends the agent's words there without the run saying so.
function appLeaves(ex, found) {
  const { system, person, models } = toldApart(ex);
  const said = (v) => person.some((t) => t.includes(v));
  const toldOnly = (v) => !said(v) && (v.match(/[\p{L}\p{N}]/gu) ?? []).length >= TOLD_MIN;
  const told = found.filter((l) => !inList(l.at)
    && system.some((t) => t === l.v || (toldOnly(l.v) && t.includes(l.v)))
    && found.some((o) => fieldOf(o.at) !== fieldOf(l.at) && said(o.v)));
  const twins = (l) => told.filter((o) => fieldOf(o.at) !== fieldOf(l.at) && o.v === l.v);
  const persons = (l) => twins(l).length > 0 && twins(l).every((o) => nameRank(l) < nameRank(o) || (nameRank(l) === nameRank(o) && told.indexOf(l) < told.indexOf(o)));
  return [...told.filter((l) => !persons(l)), ...leaves(bodyOf(ex)).filter((l) => !inList(l.at) && models.has(l.value))];
}

// The field whose value reached the model as the person's words: never one the app's client set for
// the model, then in the most exchanges, one that changes between them, a field of its own before a
// list, then the longest. A list holding the ask is named by its field. `appFields`: the fields the
// app's client set for its model, which a trial fills with the app's own values, never the person's.
function askOf(exchanges) {
  const tally = new Map();
  const app = new Set();
  for (const ex of exchanges) {
    const prompt = promptOf(ex);
    const body = bodyOf(ex);
    if (!prompt || !body) continue;
    const { person } = toldApart(ex);
    const found = leaves(body).map((l) => ({ ...l, v: norm(l.value) })).filter((l) => l.v.length >= 3 && /[a-z\u00c0-\uffff]/.test(l.v) && askable(body, l.at) && prompt.includes(l.v)
      && (words(l.v) || person.some((t) => t.includes(l.v))));
    for (const l of appLeaves(ex, found)) app.add(fieldOf(l.at));
    for (const l of found) {
      const field = fieldOf(l.at);
      const t = tally.get(field) ?? { field, list: inList(l.at), hits: new Set(), values: new Set(), longest: 0, rank: nameRank(l), url: true };
      if (!/^https?:\/\//i.test(String(l.value).trim())) t.url = false;
      t.hits.add(ex.id);
      t.values.add(l.v);
      t.longest = Math.max(t.longest, l.v.length);
      tally.set(field, t);
    }
  }
  // An address is never what a person says, and a field named as the message is theirs before a longer
  // one: AI Answers puts the page URL in its prompt verbatim and rewrites the French question, and the
  // URL, longer, was taken for the ask.
  const best = [...tally.values()].sort((a, b) => app.has(a.field) - app.has(b.field) || b.hits.size - a.hits.size || (b.values.size > 1) - (a.values.size > 1) || a.url - b.url || a.rank - b.rank || a.list - b.list || b.longest - a.longest)[0];
  return best?.field ? { field: best.field, list: best.list, appFields: [...app].filter((f) => f !== best.field) } : null;
}

// The ask in one exchange: the field's value, or the list's last entry the model was told.
function askIn(ex, ask) {
  const body = bodyOf(ex);
  if (!ask || !body) return "";
  const prompt = promptOf(ex);
  return leaves(body).filter((l) => fieldOf(l.at) === ask.field && askable(body, l.at) && (!ask.list || prompt.includes(norm(l.value)))).at(-1)?.value ?? "";
}

// ---- the session

// Where the conversation rides in the history the client sends, a conversation id every request of
// the agent's carried is the agent's own conversation, not a trial's: AI Answers refused 44 of 44
// trials with "ChatId does not belong to session". It is left out of the template, so each trial
// opens a conversation of its own, which the app answers (checked: no chatId, 200).
function withoutConversation(body, session) {
  if (session?.carrier !== "history" || !body || typeof body !== "object") return body;
  const out = structuredClone(body);
  const strip = (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return;
    for (const k of Object.keys(v)) {
      if (SESSION_NAME.test(k) && /^(?:id|uuid)$/i.test(k) === false && typeof v[k] === "string" && idLike(v[k])) delete v[k];
      else strip(v[k]);
    }
  };
  strip(out);
  return out;
}

// The earlier exchange's words the later prompt carried: its ask, the model's reply, the app's reply.
// Reply words the earlier prompt already held are the prompt's own text (a scripted greeting), and
// words asked twice are in the later prompt as its own ask: carried, they are there twice.
function carriedFrom(later, earlier, ask) {
  const prompt = promptOf(later);
  const before = promptOf(earlier);
  const own = norm(askIn(later, ask));
  const replies = [norm(modelWords(earlier)).slice(0, 80), norm(replyOf(earlier).text).slice(0, 80)].filter((t) => !before.includes(t));
  return [norm(askIn(earlier, ask)), ...replies].filter((t) => t.length >= 8 && (own.includes(t) ? prompt.split(t).length > 2 : prompt.includes(t)));
}

const cookiesIn = (ex) => Object.fromEntries(str(headerOf(ex.headers, "cookie")).split(";").map((c) => c.trim().split("=")).filter(([k, v]) => k && v !== undefined).map(([k, ...v]) => [k, v.join("=")]));

// A sign-in is never the conversation. A cookie or a header a trial is sent without is one that only
// names the conversation: Databuddy's sign-in cookie, refreshed on every reply, was taken for one, and
// each trial sent without it was refused; an Authorization header that stayed the same would be too.
const READS_AS_CREDENTIAL = /auth|token|jwt|csrf|xsrf|secret|key|sid$|sessionid|connect\.sid|phpsessid|jsessionid|__session|__host-|__secure-|^sb-|clerk|supabase|laravel_session/i;
const READS_AS_CONVERSATION = /conv|thread|chat|dialog|session[-_]?id/i;
const namesConversation = (name) => READS_AS_CONVERSATION.test(name) && !READS_AS_CREDENTIAL.test(name);

// What stayed the same from the earlier exchange to the later one and is not the ask: a field the app
// handed back, a path segment, a field that reads as an id, a cookie the app set, a header, another
// cookie. The first found carries the session.
export function carrierOf(earlier, later, ask, door) {
  const same = (a, b) => a !== undefined && a !== "" && a === b;
  const before = new Map(leaves(bodyOf(earlier) ?? {}).map((l) => [l.at.join("."), l.value]));
  const own = leaves(bodyOf(later) ?? {}).filter((l) => !inList(l.at) && fieldOf(l.at) !== ask?.field);
  // A value the app handed back in its earlier reply: the first request had none to send.
  const handedBack = norm(earlier.reply);
  // The earlier request must not have sent it already: LearnHouse's activity_uuid is in every request
  // and echoed in every reply, and taken for a handed-back id it was dropped from 40 of 40 trials.
  const named = own.find((l) => /^\S{6,}$/.test(l.value) && (/\d/.test(l.value) || l.value.length >= 16) && handedBack.includes(norm(l.value)) && before.get(l.at.join(".")) !== l.value);
  // `minted` says who opened the conversation: the app handed the value back (a trial opens its own by
  // sending none), or the client made it up (a trial makes up its own).
  if (named) return { carrier: "body", key: named.at.join("."), minted: "app" };
  const fields = own.filter((l) => same(l.value, before.get(l.at.join("."))));
  const params = paramsOf(door.path, later.path);
  const was = paramsOf(door.path, earlier.path);
  const segment = Object.keys(params).find((k) => same(params[k], was[k]));
  if (segment) return { carrier: "path", key: segment, minted: "client" };
  // A constant id is a conversation only when its name says so; a lesson, workspace or agent id the
  // client sends with every message is a fixed field, replayed as captured, never made up per trial.
  const idField = fields.find((l) => idLike(l.value) && SESSION_NAME.test(String(l.at.at(-1))));
  if (idField) return { carrier: "body", key: idField.at.join("."), minted: "client" };
  const jar = cookiesIn(later);
  const jarBefore = cookiesIn(earlier);
  // A cookie the app set on the earlier reply, sent back, which the earlier request could not carry.
  // One that request already carried was only refreshed: a session the person signed in with, unless
  // its name says it is the conversation.
  const set = Object.keys(jar).find((k) => earlier.cookies.includes(k) && (jarBefore[k] === undefined || namesConversation(k)));
  if (set) return { carrier: "cookie", key: set, minted: "app" };
  const header = Object.keys(later.headers).find((k) => !HOP.test(k) && !PLAIN_HEADER.test(k) && namesConversation(k) && same(later.headers[k], headerOf(earlier.headers, k.toLowerCase())));
  if (header) return { carrier: "header", key: header.toLowerCase(), minted: "client" };
  const cookie = Object.keys(jar).find((k) => namesConversation(k) && same(jar[k], jarBefore[k]));
  if (cookie) return { carrier: "cookie", key: cookie, minted: "client" };
  return { carrier: "none", key: null };
}

// Body fields a later request sent back with a value the reply to an earlier one handed out, which
// that earlier request had not sent there: AI Answers signs each conversation's history and refuses a
// follow-up without the signature its last reply carried. A trial sends back what its own last reply
// handed out. The conversation's own carrier is the session's, not one of these.
function echoesOf(exchanges, ask, session) {
  const out = new Set();
  for (let i = 1; i < exchanges.length; i++) {
    for (const l of leaves(bodyOf(exchanges[i]) ?? {})) {
      const at = l.at.join(".");
      if (inList(l.at) || fieldOf(l.at) === ask?.field || (session.carrier === "body" && at === session.key)) continue;
      if (!/^\S{6,}$/.test(l.value) || !(/\d/.test(l.value) || l.value.length >= 16)) continue;
      const handed = exchanges.slice(0, i).some((earlier) => norm(earlier.reply).includes(norm(l.value))
        && leaves(bodyOf(earlier) ?? {}).find((e) => e.at.join(".") === at)?.value !== l.value);
      if (handed) out.add(at);
    }
  }
  return [...out];
}

// Held when a later prompt carried an earlier exchange's words. A body that carried them in a field
// other than its own ask holds the conversation itself; otherwise what stayed the same carries it.
// `tried`: a later request went on from an earlier one (it sent back what that one was handed, or
// kept its id, cookie or header) and still the app held nothing; without it, `held: false` is only
// that no request went on from another, which says nothing about the door.
function sessionOf(exchanges, ask, door) {
  let tried = false;
  let carried = null;
  for (let i = 1; i < exchanges.length; i++) {
    for (let j = i - 1; j >= 0; j--) {
      const texts = carriedFrom(exchanges[i], exchanges[j], ask);
      if (!texts.length) {
        const went = carrierOf(exchanges[j], exchanges[i], ask, door);
        if (went.carrier !== "none") { tried = true; carried ??= went; }
        continue;
      }
      const own = norm(askIn(exchanges[i], ask));
      const history = leaves(bodyOf(exchanges[i]) ?? {}).find((l) => norm(l.value) !== own && texts.some((t) => norm(l.value).includes(t)));
      if (history) return { held: true, carrier: "history", key: fieldOf(history.at) };
      return { held: true, ...carrierOf(exchanges[j], exchanges[i], ask, door) };
    }
  }
  // Held or not, what carried the request on is named: a conversation id the app handed back is
  // never a constant for trials to replay. wecom-sales-agent keeps a profile of each conversation
  // rather than its words, so its next prompt carried none of them, and all 44 trials were sent the
  // one id; the app answers one request per conversation at a time, and none came back.
  return tried ? { held: false, ...carried, tried: true } : { held: false, carrier: "none", key: null };
}

// ---- an answer that came on a second request

// What the hook ties the two requests on (lib/tied.cjs): a value made to name one thing.
const TIE = /^(?=.*\d)[\w.:-]{6,200}$/;
const TURN_ROLE = /^(?:role|sender|from|author|speaker)$/i;
const isTurns = (v) => Array.isArray(v) && v.length > 0 && v.every((e) => e && typeof e === "object" && !Array.isArray(e)) && v.some((e) => Object.keys(e).some((k) => TURN_ROLE.test(k)));

// Where one request of the turn holds the person's words and the conversation: the leaf the ask was
// in, and a list of turns, the one the ask sits in when it sits in one. The run writes each trial's
// turn at these paths in the recorded body. A leaf in the ask's own field is the one, and a field the
// app's client set for its model never is, whatever words it shares with the ask.
function placesIn(body, words, ask) {
  if (!body || typeof body !== "object") return { askPath: null, historyPath: null };
  const own = norm(words);
  const hits = own ? leaves(body, [], [], 5000).filter((l) => norm(l.value) === own && !ask?.appFields.includes(fieldOf(l.at))) : [];
  const hit = hits.filter((l) => fieldOf(l.at) === ask?.field).at(-1) ?? hits.at(-1);
  const lists = [];
  const walk = (v, path) => {
    if (isTurns(v)) lists.push(path);
    if (v && typeof v === "object" && path.length < 12) for (const [k, x] of Object.entries(v)) walk(x, [...path, Array.isArray(v) ? Number(k) : k]);
  };
  walk(body, []);
  const holding = hit && lists.find((p) => p.length < hit.at.length && p.every((k, i) => k === hit.at[i]));
  const history = holding ?? lists[0];
  return { askPath: hit ? newest(body, hit.at).join(".") : null, historyPath: history ? newest(body, history).join(".") : null };
}

// The second step as the run makes it: its method and address with the tying value named by where
// the asking request had it (`sent` in its body, or `got` back in its reply), where the ask and the
// turns sit in the asking request, and the requests sent before it in the same turn. Tied by the
// asking request's own address, the value is the door's own and the address is kept as it was.
function answerOf(ex, ask) {
  const { method, path, asked } = ex.answer;
  const [where, ...rest] = path.split("?");
  const query = rest.join("?");
  const address = [...where.split("/"), ...new URLSearchParams(query).values()];
  const fields = (v, from) => (v && typeof v === "object" ? leaves(v) : []).filter((l) => TIE.test(l.value) && address.includes(l.value)).map((l) => ({ key: l.at.join("."), value: l.value, from }));
  const tie = [...fields(bodyOf(ex), "sent"), ...fields(parse(asked), "got")][0];
  const slot = tie && `{${tie.key}}`;
  const named = !tie ? path : where.split("/").map((s) => (s === tie.value ? slot : s)).join("/")
    + (query ? `?${query.split("&").map((p) => { const [k, ...v] = p.split("="); return decodeURIComponent(v.join("=")) === tie.value ? `${k}=${slot}` : p; }).join("&")}` : "");
  const words = askIn(ex, ask);
  return {
    method, path: named, tie: tie ? { key: tie.key, from: tie.from } : null, ...placesIn(bodyOf(ex), words, ask),
    before: ex.before.map((s) => { const body = parse(s.body); return { method: s.method, path: s.path, ...(body !== undefined ? { body } : {}), ...placesIn(body, words, ask) }; }),
  };
}

// ---- problems a line of code decides

const TAG = /<\|[\w-]{1,40}\|>|<\/?([a-z][\w-]{0,40})(?:\s[^<>]{0,120})?\/?>/gi;
const FORMATTING = /^(?:a|b|i|u|s|em|strong|br|p|ul|ol|li|code|pre|span|div|table|thead|tbody|tr|td|th|h[1-6]|img|sup|sub|blockquote|hr|small|mark|del|ins|kbd|details|summary|figure|figcaption|caption|section|article|nav|header|footer|main|button|label|input|form)$/i;
const REASONING = /^(?:think|thinking|reasoning)$/i;
const PLACEHOLDER = /\{\{\s*[\w.]{1,40}\s*\}\}|\$\{\s*[\w.]{1,40}\s*\}|\{[a-z_][a-z0-9_]{1,40}\}|%\([a-z_]\w{0,40}\)s/gi;
const ERROR_OPEN = /^\s*(?:error:|exception:|traceback \(most recent call last\)|internal server error|an? (?:unexpected |internal )?error (?:has )?occurred|something went wrong)/i;
const ok = (status) => status >= 200 && status < 300;
// Markup a reply shows as code is the answer, not a leak: fenced blocks and inline code are left out.
const prose = (text) => text.replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, " ").replace(/`[^`\n]*`/g, " ");

// An error field's own words: the field, its message or its first entry's, or the message beside a flag
// ({"error": true, "message": "Your card was declined"} was quoted as "true").
const errorWords = (body, field) => {
  const v = body[field];
  return [v, v?.message, arr(v)[0]?.message, body.message].find((s) => typeof s === "string" && s.trim()) ?? JSON.stringify(v);
};

// The app's error on a 2xx: an error field in its JSON, an error its stream says (eventsOf), or a reply
// that opens as an error and is not the model's own words.
function errorOf(ex, reply) {
  const body = parse(ex.reply);
  const field = body && typeof body === "object" && !Array.isArray(body) ? ["error", "errors"].find((k) => body[k] && (typeof body[k] !== "object" || Object.keys(body[k]).length)) : null;
  if (field) return errorWords(body, field);
  const [said] = eventsOf(ex.reply).errors;
  if (said) return said;
  const words = norm(modelWords(ex));
  return ERROR_OPEN.test(reply.text) && !(words && words.includes(norm(reply.text).slice(0, 60))) ? reply.text.trim() : "";
}
// The reply is the app's error, so the model never answered the request.
const endedInError = (ex, reply = replyOf(ex)) => !ok(ex.status) || Boolean(errorOf(ex, reply));

const callFailed = (c) => { const status = Number(c.status) || 0; return status === 0 || status >= 400; };
const modelCall = (c) => { const status = Number(c.status) || 0; return `model call to ${str(c.host)}${c.model ? ` for ${c.model}` : ""} ${status ? `answered ${status}` : "got no answer"}`; };
// A refusal every later call meets: a key, a card, a quota plan, a retired model. A timeout, a dropped
// connection, a limiter and a provider's own failure are for the test message before a run to judge.
const REFUSED = new Set([401, 402, 403, 404]);
// Said from one request alone, its refused call and its own error: a door's problems span its last
// requests, and a key fixed since was quoted beside a newer request's card error.
function refusalOf(ex, problems) {
  const call = ex.calls.findLast((c) => REFUSED.has(Number(c.status)));
  const error = problems.find((p) => p.kind === "error-status" || p.kind === "error-under-2xx");
  return call ? { refused: [`A ${modelCall(call)}.`, error?.said].filter(Boolean).join(" ") } : {};
}

// A tool behind the request that came back as an error, in the words it came back with: an answer
// that opens as an error or carries an error field, an exception the app's own tool raised, a call a
// provider marked failed, or a call whose arguments the tool's declared schema refused. Said literally;
// whether an error is the tool broken or its way of saying "not found" is the run's judgment.
const RAISED = /^raised \S/;
function toolErrorsIn(ex) {
  const out = new Map();
  // "web_search_call failed" is the provider's own status for a call, never an app tool's answer.
  const said = (text, provider) => {
    const t = str(text).trim();
    const body = parse(t);
    const field = body && typeof body === "object" && !Array.isArray(body) ? ["error", "errors"].find((k) => body[k] && (typeof body[k] !== "object" || Object.keys(body[k]).length)) : null;
    return ERROR_OPEN.test(t) || RAISED.test(t) || (provider && /_call failed$/.test(t)) || Boolean(field);
  };
  for (const r of [...ex.calls, ...ex.deps]) {
    for (const t of arr(r.tools)) if (str(t.name) && said(t.text, t.provider === true)) out.set(`${t.name}|${t.text}`, { name: str(t.name), said: str(t.text).trim(), provider: t.provider === true });
    for (const c of arr(r.called)) if (str(c.name) && str(c.refused)) out.set(`${c.name}|${c.refused}`, { name: str(c.name), said: str(c.refused), refused: true });
  }
  return [...out.values()];
}

// Who put `piece` into the reply: the model, when its own words behind the reply hold it, else the line
// of the app that sent it, the write whose first bytes carry it. Neither unless the hook read the
// words of every call behind the reply whole, the hooks cutting them at WORDS_CUT.
const WORDS_CUT = 4000;
function whoSent(ex, piece, frame) {
  const words = generation(ex).map((c) => c.reply);
  if (!words.join("") || !words.every((w) => typeof w === "string" && w.length < WORDS_CUT)) return {};
  if (norm(words.join("\n")).includes(norm(piece))) return { model: true };
  const site = ex.sites.find((s) => norm(s.text).includes(norm(piece)));
  return site ? { site, at: frame([site.at]) } : {};
}
const sentence = ({ model, site }) => (model ? " The model said it."
  : site ? ` The model never said it: your app's own code sent it here${site.event ? `, in its "${site.event}" event` : ""}.` : "");

// The tools the request's last model call asked for, when they ran inside this request and no model
// call came after them: the app closed the request before the model could answer from their result
// (an AI SDK route left at one step). A tool the page runs itself and sends back is not this.
// A last call that wrote words answered: its request carries the tool calls before it in its history
// (MIT Learn AI's answering call resent search_courses), which is not the request stopping there.
function endedOnTool(ex) {
  const last = generation(ex).at(-1);
  if (str(last?.reply).trim()) return null;
  const asked = [...new Set(arr(last?.called).map((c) => str(c?.name)).filter(Boolean))];
  if (!asked.length) return null;
  const inApp = new Set(ex.deps.flatMap((d) => arr(d.called).map((c) => str(c?.name))));
  const streamed = eventsOf(str(ex.reply)).events.some((e) => e && typeof e === "object" && /tool.*(?:output|result)/i.test(str(e.type)));
  return asked.some((name) => inApp.has(name)) || streamed ? asked : null;
}

// The first error the app printed, with the indented lines under it that carry its cause, as one
// line: "ERROR: request failed" alone is a banner. A warning, a traceback's opening, or a line the
// hook printed about a call it held is not one. One rule with the backend's firstErrorOf
// (src/simulate/failure.ts), tested there on the same outputs.
const ERROR_LINE = /(?:error|exception)\b|\bunhandled\b|\bfatal\b|\bpanic\b/i;
const NOT_ERROR = /warn|Traceback \(most recent|\bcortad: /i;
// The prefix a process manager puts on every line it relays, read past: concurrently's "[api] ",
// turbo's "@scope/api:dev: ", overmind's "web    | ".
const RELAYED = /^(?:\[[^\]\s]{1,60}\] |(?:@[\w.-]+\/)?[\w.-]+:[\w.-]+: |[a-z][\w.-]*\s*\| )/i;
// The source a runtime prints around a throw is not the error: Bun numbers its lines
// ("321 |   return new GatewayError({"), Node puts a caret under the one that threw and its file and
// line above that, and Python prints each frame's line under the frame.
const FRAME = /^\s*\d+ \| /;
const CARET = /^\s*\^+\s*$/;
const AT_LINE = /^\S+:\d+$/;
const PY_FRAME = /File "[^"]+", line \d+/;
const sourceAt = (lines, n) => FRAME.test(lines[n]) || CARET.test(lines[n + 1] ?? "") || (AT_LINE.test(lines[n]) && CARET.test(lines[n + 2] ?? ""))
  || PY_FRAME.test(lines[n]) || (PY_FRAME.test(lines[n - 1] ?? "") && /^\s/.test(lines[n]));
// A record printed as fields under its first line (a wide event) is quoted by its error field alone.
// The fields are the request's: the first four under databuddy's "ERROR [api] POST /v1/agent/ask"
// were its request id, how it signed in, and its user's id and email, and the provider's refusal sat
// twenty-five fields further down.
const FIELD = /^[\s│├└─]*([\w.]+)\s*[:=]\s*(.*)$/;
const ERROR_FIELD = /^(?:\w+\.)?err(?:or)?(?:[._]?message)?$|^message$/i;
function firstError(text) {
  const printed = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split(/\r?\n/);
  const lines = printed.map((l) => l.replace(RELAYED, ""));
  // A field of a record is not an error line of its own: databuddy's INFO record of a request its
  // client closed carried "└─ rpc_abort_reason: AbortError", and that leaf was quoted as the problem.
  const i = printed.findIndex((l, n) => ERROR_LINE.test(l) && !NOT_ERROR.test(l) && !sourceAt(lines, n) && !/^\s*[│├└]/.test(lines[n]));
  if (i < 0) return "";
  const block = [];
  for (const l of lines.slice(i + 1, i + 200)) { if (!/^\s+\S/.test(l)) break; block.push(l); }
  const fields = block.map((l) => FIELD.exec(l)).filter(Boolean);
  // A record's fields other than its error are never quoted, named error or not: a record whose
  // error sat under "reason" sent its request id, user id and email in its place.
  const record = fields.length > 1;
  const [, key, said] = (record && fields.find(([, name]) => ERROR_FIELD.test(name))) || [];
  const under = key ? [/(?:^|\s)message=(.*?)(?:\s+stack=|$)/.exec(said)?.[1] ?? `${key}: ${said}`] : record ? [] : block.slice(0, 4);
  // Scrubbed over a bounded piece: a logger that prints a whole prompt on its error line handed
  // 250,000 characters to patterns that walk back over every run of letters.
  return clip(scrubbed([lines[i], ...under].join(" ").slice(0, 2_000).replace(/\s+/g, " ").trim()), 300);
}
// What a quoted line of the app's own log never carries off this machine: an address that reaches a
// person, a sign-in, a generated id. The line says what failed, never for whom.
const scrubbed = (line) => line
  .replace(/(\b[a-z][\w+.-]*:\/\/)[^\s/@:]*:[^\s/@]+@/gi, "$1[hidden]@")
  .replace(/[\w.+-]+@(?:[\w-]+\.)+[a-z]{2,}/gi, "[email]")
  .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, "$1 [hidden]")
  .replace(/\b((?:set-)?cookie|session(?:[_-]?(?:id|token))?|token|secret|password|passwd|api[_-]?key|authorization)\b(["']?\s*[:=]\s*)(?!\[hidden\]|Bearer |Basic )("[^"]*"|[^\s;,]+(?:;\s*[^\s;,=]+=[^\s;,]+)*)/gi, "$1$2[hidden]")
  .replace(/(?<![\w-])(?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]{24,}(?![\w-])/gi, "[id]");

function problemsIn(ex, reply, find, frame, printedLine) {
  const out = [];
  const add = (kind, said, where) => out.push({ kind, said, file: where?.file ?? null, line: where?.line ?? null });
  const prompt = promptOf(ex);
  const words = norm(modelWords(ex));
  const call = frame(generation(ex)[0]?.caller);
  const said = prose(reply.text);
  // One problem per kind of leak, every tag of that kind named once: a reply that leaked a block of
  // prompt markup is one defect, not one per tag.
  const tokens = new Set(), reasoning = new Set(), fromPrompt = new Map();
  for (const [tag, name] of said.matchAll(TAG)) {
    if (!name) tokens.add(tag);
    else if (REASONING.test(name)) reasoning.add(tag);
    else if (!FORMATTING.test(name) && prompt.includes(`<${name.toLowerCase()}`) && !fromPrompt.has(name.toLowerCase())) fromPrompt.set(name.toLowerCase(), tag);
  }
  const listed = (set) => [...set].map((t) => `"${t}"`).join(", ");
  // Text meant for the model is placed where it was sent from when the model never said it.
  const placed = (kind, piece, text, where, note = "") => {
    const who = whoSent(ex, piece, frame);
    add(kind, `${text}${who.at ? "" : note}${sentence(who)}`, who.at ?? where);
  };
  if (tokens.size) placed("leaked-markup", [...tokens][0], `The reply carried chat template tokens meant for the model: ${listed(tokens)}.`, call);
  if (reasoning.size) placed("leaked-markup", [...reasoning][0], `The reply carried the model's reasoning markup: ${listed(reasoning)}.`, call);
  if (fromPrompt.size) {
    const written = [...fromPrompt.keys()].map((name) => find(`<${name}`)).find(Boolean);
    const tags = new Set(fromPrompt.values());
    placed("leaked-markup", [...tags][0], `The reply carried markup from the prompt your app sent the model: ${listed(tags)}.`, written ?? call,
      written ? "" : " None of it is written in your code; this is the line that made the model call.");
  }
  // A SLOT IS ONLY A SLOT WHERE A LINE OF THEIR CODE WRITES IT.
  //
  // Both branches now need `find(p)`. The first one asked only whether the same braces appear in the
  // runtime prompt, which on a maths tutor they always do: LaTeX. `\text{kg}` in a reply and the same
  // in the prompt reported an unfilled placeholder and addressed it to the line that made the model
  // call, while holding the proof that no code of theirs writes the token. Measured on one customer's
  // 64 replies: 17 of them carry a brace group this pattern matches, and `\begin{bmatrix}`,
  // `\frac{dy}`, `{dx}` and `{T_y}` are not slots. Every `placeholder` problem this rule has ever
  // recorded, 12 of them across six days, was that same false reading, and none was ever real.
  for (const [p] of said.matchAll(PLACEHOLDER)) {
    const written = find(p);
    if (!written) continue;
    if (prompt.includes(norm(p))) placed("placeholder", p, `The reply carried "${p}", a placeholder still unfilled in the prompt sent to the model.`, written);
    else if (!words.includes(norm(p))) add("placeholder", `The reply carried "${p}", a placeholder your code never filled.`, written);
  }
  const stopped = endedOnTool(ex);
  if (stopped) add("ended-on-tool", `The request ended right after ${stopped.join(", ")} ran: no model call came after it, so the reply holds no answer written from the tool's result.`, frame(generation(ex).at(-1)?.caller) ?? call);
  if (ex.status >= 500) add("error-status", `Your app answered ${ex.status} after it called the model.`, null);
  const error = ok(ex.status) ? errorOf(ex, reply) : "";
  if (error) {
    const flat = error.replace(/\s+/g, " ");
    add("error-under-2xx", `Your app answered ${ex.status} ${withError(flat)}.`, find(flat.slice(0, 60)) ?? find(flat.slice(0, 24)) ?? whoSent(ex, flat.slice(0, 60), frame).at ?? call);
  }
  for (const c of ex.calls.filter(callFailed)) add("model-call-failed", `A ${modelCall(c)}.`, frame(c.caller));
  for (const d of ex.deps.filter((x) => x.retrieval && !arr(x.passages).length)) {
    const status = Number(d.status) || 0;
    add("retrieval-empty", `A retrieval from ${str(d.host)} ${ok(status) ? "returned nothing" : status ? `answered ${status} and returned nothing` : "got no answer"}.`, frame(d.caller));
  }
  for (const t of toolErrorsIn(ex)) {
    const flat = clip(t.said.replace(/\s+/g, " "), 200);
    add("tool-failed", t.refused
      ? `The model called the tool ${t.name} with arguments its declared schema refuses: ${flat}.`
      : `The tool ${t.name} came back as an error${t.provider ? " from your model provider, which runs it" : ""}: "${flat}"`, find(t.name) ?? call);
  }
  const told = generation(ex).filter((c) => Array.isArray(c.rules));
  if (told.length && told.every((c) => !c.rules.length)) add("rules-not-carried", "The prompt your app sent the model carried none of the rules read from your code.", frame(told[0].caller));
  // The person's own request or Cortad's test request before a run, never a run's trial: the hook
  // keeps the person's requests over a run's, so a trial's neighbours may be gone. ponytail: a logger
  // that writes after a second's grace (a worker thread flushing late) is missed; the hook's own
  // capture of the app's output if that is ever seen.
  const line = ex.trial && !REACH.test(ex.turn ?? "") ? "" : printedLine(ex);
  if (line) add("app-printed", `Your app printed "${line}" while it answered.`, null);
  return out;
}

// ---- the door's proof

// What the requests did inside the app, as ids, names and counts: the provider host, the read's rules
// any prompt carried (absent when the hook had no rules to look for), the tools that ran, whether the
// model asked for them or the app's own code did, and the passages the latest request was handed.
function insideOf(exchanges) {
  const calls = exchanges.flatMap(generation);
  const hosts = calls.map((c) => str(c.host).replace(/:\d+$/, "").toLowerCase()).filter((h) => /^[a-z0-9.-]{1,200}$/.test(h));
  const told = calls.filter((c) => Array.isArray(c.rules));
  const latest = exchanges.at(-1);
  const names = (rows) => rows.flatMap((r) => arr(r.called).map((t) => str(t?.name))).filter(Boolean);
  return {
    ...(hosts.length ? { host: hosts.sort((a, b) => hosts.filter((h) => h === b).length - hosts.filter((h) => h === a).length)[0] } : {}),
    ...(told.length ? { rules: [...new Set(told.flatMap((c) => c.rules.filter((r) => typeof r === "string" && /^[\w:-]{1,64}$/.test(r))))].slice(0, 300) } : {}),
    tools: [...new Set(exchanges.flatMap((ex) => [...names(ex.calls), ...names(ex.deps)]))].slice(0, 40),
    passages: [...latest.calls, ...latest.deps].reduce((n, r) => n + arr(r.passages).length, 0),
  };
}

// `find(literal, near)` says where the repository's own code holds a literal, as { file, line }, or
// null, searching `near` (the files the exchange's model calls came from) first.
// `base` is the folder the app runs in, relative to the repository: the hook's frames start there.
// `printed(from, to)`: what the app printed between two times, on the hook's clock. `firstErrors`
// keeps the first error each request printed, by its id, once one is found or the second after its
// answer has passed: what the app printed is held only until newer output rolls it out.
export function proofOf(exchanges, door, { find = () => null, base = "", printed = () => "", firstErrors = new Map(), others = exchanges } = {}) {
  const at = (f) => {
    const m = /^(.*):(\d+)$/.exec(str(f));
    return m ? { file: base ? `${base.replace(/\/+$/, "")}/${m[1]}` : m[1], line: Number(m[2]) } : null;
  };
  const frame = (frames) => at(arr(frames)[0]);
  const near = (ex) => [...new Set(ex.calls.flatMap((c) => arr(c.caller).map(at)).filter(Boolean).map((p) => p.file))];
  const fallback = !exchanges.some((ex) => !ex.trial);
  exchanges = provingOf(exchanges);
  // Answered later only when no request of the proof answered in its own reply: one that did is the
  // endpoint's shape, and a request answered later beside it is read as the reply it got.
  const later = exchanges.every((ex) => ex.later);
  if (!later) exchanges = exchanges.map(({ later: _later, ...ex }) => ex);
  const ask = askOf(exchanges);
  const replies = exchanges.map(replyOf);
  const latest = exchanges.at(-1);
  // A reply cut short, by either side, is not the reply: the latest whole one stands.
  const uncut = exchanges.findLastIndex((ex) => !ex.cut);
  const shown = uncut < 0 ? exchanges.length - 1 : uncut;
  const session = sessionOf(exchanges, ask, door);
  // The person's own request is the shape trials take; ours only when there is none. Where the history
  // carries the conversation, one whose history holds turns: a first message's empty list says nothing
  // of how the app writes a turn, and AI Answers' follow-ups went out as {role:"assistant"} where it
  // writes and signs {sender:"ai"}, refused 403 every one.
  const turnsIn = (ex) => { const list = String(session.key ?? "").split(".").reduce((v, k) => v?.[k], bodyOf(ex)); return Array.isArray(list) && list.length > 0; };
  const shape = session.carrier === "history" ? exchanges.findLast(turnsIn) ?? latest : latest;
  const echoes = echoesOf(exchanges, ask, session);
  // A failed call is neither the endpoint's model nor part of its price: llama-3.1-8b answered 404,
  // glm-5p3 wrote the reply, and status named the first and quoted the run at its price.
  const served = (ex) => generation(ex).filter((c) => !callFailed(c));
  const metered = exchanges.filter((ex) => served(ex).some((c) => c.usage));
  const tokens = (key) => median(metered.map((ex) => served(ex).reduce((n, c) => n + (Number(c[key]) || 0), 0)));
  // Of the prompt, what the provider served from its cache: the quote prices it at the cache-read rate.
  const cached = tokens("cachedTokens");
  // The call that wrote the reply names the endpoint's model (the backend's wroteIt): the last one that
  // answered with words, by the model that answered; any call that did not fail only when none wrote.
  const wrote = exchanges.map((ex) => answeredCalls(ex).filter((c) => !callFailed(c)).at(-1)).filter(Boolean);
  const models = (wrote.length ? wrote : exchanges.flatMap(served)).map((c) => str(c.answered) || str(c.model)).filter(Boolean);
  const count = (m) => models.filter((x) => x === m).length;
  const seconds = median(exchanges.map((ex) => ex.ms / 1000));
  // A line the app printed belongs to one request or to none: its window closes at the next request's
  // start, and a request another overlapped gets nothing. Six requests sent at once each carried
  // "SALES_JWT_SECRET missing", printed by one of them. `others`: every request the hook kept.
  // ponytail: a request still open when this one's proof is read is not among them yet; the hook's
  // own count of requests in flight if a line is ever pinned on the wrong one that way.
  const printedLine = (ex) => {
    if (firstErrors.has(ex.id)) return firstErrors.get(ex.id);
    const rest = others.filter((o) => o.id !== ex.id);
    const until = Math.min(ex.at + ex.ms + 1000, ...rest.filter((o) => o.at >= ex.at).map((o) => o.at));
    const crossed = rest.some((o) => o.at < ex.at + ex.ms && o.at + o.ms > ex.at);
    const line = crossed ? "" : firstError(str(printed(ex.at, until)));
    if (line || crossed || Date.now() > until) firstErrors.set(ex.id, line);
    return line;
  };
  const seen = new Set();
  // Whether an endpoint answers after a tool is said by its latest request that ran one. An earlier one
  // that stopped there is not the endpoint's shape once a later one went on to answer: on databuddy a
  // provider's rate limit fell between one request's tool and its answer, and Run stayed held through
  // every clean request sent after it, with "send one more request" as the only advice.
  const lastTool = exchanges.findLastIndex((ex) => generation(ex).some((c) => arr(c.called).length));
  const each = exchanges.map((ex, i) => {
    const files = near(ex);
    return problemsIn(ex, replies[i], (literal) => find(literal, files), frame, printedLine).filter((p) => p.kind !== "ended-on-tool" || i === lastTool);
  });
  const problems = each.flat().filter((p) => !seen.has(`${p.kind}|${p.said}`) && seen.add(`${p.kind}|${p.said}`)).slice(0, PROBLEMS_MAX);
  const query = shape.path.includes("?") ? `?${shape.path.split("?").slice(1).join("?")}` : "";
  const answer = shape.answer ? answerOf(shape, ask) : null;
  return {
    door: { method: door.method, path: `${door.path}${query}` },
    template: {
      body: withoutConversation(parse(shape.body) ?? shape.body, session),
      headerNames: Object.keys(shape.headers).filter((k) => !HOP.test(k)).map((k) => k.toLowerCase()).sort(),
      askField: ask?.field ?? null,
      sessionKey: session.key,
      ...pathValuesOf(door.path, shape.path),
    },
    proof: {
      exchanges: exchanges.length,
      askField: ask?.field ?? null,
      ...(ask?.appFields.length ? { appFields: ask.appFields } : {}),
      session,
      ...(echoes.length ? { echoes } : {}),
      replyPath: replies[shown].path,
      stream: replies[shown].stream,
      modelCalls: median(exchanges.map((ex) => generation(ex).length)) ?? 0,
      model: [...new Set(models)].sort((a, b) => count(b) - count(a))[0] ?? null,
      tokens: metered.length ? { prompt: tokens("promptTokens"), completion: tokens("completionTokens"), ...(cached ? { cached } : {}) } : estimatedTokens(exchanges),
      replySeconds: seconds === null ? null : Math.round(seconds * 10) / 10,
      purpose: null,
      at: new Date(latest.at).toISOString(),
      ...insideOf(exchanges),
      ...(answer ? { answer } : {}),
      ...(later ? { later: true } : {}),
      ...(fallback ? { fallback: true } : {}),
    },
    problems,
    // `error`: the reply shown is the app's error, so the model never answered this request.
    // `refused`: its model provider refused that request's call, said from it alone (refusalOf).
    sample: { ask: clip(askIn(exchanges[shown], ask), SAMPLE), reply: clip(replies[shown].text, SAMPLE_REPLY), ...(exchanges[shown].cut ? { cut: true } : {}),
      ...(endedInError(exchanges[shown], replies[shown]) ? { error: true, ...refusalOf(exchanges[shown], each[shown]) } : {}) },
  };
}

// ---- the canary

// The fact the canary's first turn states (backend src/local/canary.ts), as norm() reads it.
const NONCE = /\bzq\d{8}\b/;
// Pieces of the app's instructions long enough to stand for one place in its code, and how many
// are looked for: a prompt built around a date or a name is still found by its other lines.
const PIECE_MIN = 24, PIECES = 5, SHORT_MIN = 8;
// Four words in a row: what instructions are made of, and an id, a date or a host name is not.
const WORDING = /\p{L}{2,}(?:\s+\p{L}{2,}){3}/u;
const piecesOf = (text) => {
  const long = text.split(/[\n\r"'`\\]+/).map((p) => p.trim()).filter((p) => p.length >= PIECE_MIN).slice(0, PIECES);
  return long.length || text.trim().length < SHORT_MIN ? long : [text.trim()];
};

// An app that writes the person's words into its own instructions does it to the person's own
// requests (`own`) as well: there, the words in the instructions are its design, not our config.
const asksInInstructions = (own) => {
  const ask = askOf(own);
  return own.some((ex) => { const words = norm(askIn(ex, ask)); return words.length >= 8 && toldApart(ex).system.some((t) => t.includes(words)); });
};

// What the test message met where the model's answer belongs, said as the backend says what a first
// reply met (src/local/canary.ts refusedOf): every model call failed, or the app answered with its error.
// Theirs to fix only when the person's own newest request ended in an error too: a provider failing a test
// message alone is not their fault, and their request that answers again sends the test message again.
function metIn(ex, own) {
  const mine = own.filter((o) => !o.trial);
  const last = mine.findLast((o) => !o.cut) ?? mine.at(-1);
  if (!ok(ex.status) || !last || !endedInError(last)) return "";
  const calls = generation(ex);
  const refused = calls.length && calls.every(callFailed) ? calls.at(-1) : null;
  const error = errorOf(ex, replyOf(ex)).replace(/\s+/g, " ").trim();
  if (!refused && !error) return "";
  return `A test message sent the way a run sends it was answered with an error${error && error !== NO_TEXT ? `, "${clipAtWord(error, 160)}"` : ""}, as your own request was${refused ? `: a ${modelCall(refused)}` : ""}. Fix that and send one more request.`;
}

// What the newest complete canary through a door shows. Its first turn states a fact, which must reach
// the model as the person's words and never as the app's instructions, unless the person's own
// requests show the app puts them there; the second turn of that conversation must carry it when the
// person's own requests showed the door holds a conversation; a new conversation must not; the reply
// must read as words; and instructions the request itself carried must be written in the repository
// (`found`, skipped when there is no repository to look in). Instructions the request did not carry
// came from the app's own side (a file, a setting, a store) and are never ours to question. Null until
// all three requests of one canary are recorded.
export function canaryOf(exchanges, proof, found = null, own = []) {
  const byN = new Map();
  for (const ex of exchanges) {
    const [, n, conversation, turn] = CANARY.exec(ex.turn ?? "") ?? [];
    if (!n) continue;
    if (!byN.has(n)) byN.set(n, {});
    byN.get(n)[`${conversation}${turn}`] = ex;
  }
  const [n, sent] = [...byN].filter(([, s]) => s.a1 && s.a2 && s.b1).sort(([, x], [, y]) => y.b1.at - x.b1.at)[0] ?? [];
  if (!sent) return null;
  // The fact went nowhere in the request: the endpoint has no place for a person's words.
  const nonce = NONCE.exec(norm(sent.a1.body))?.[0];
  if (!nonce) return { n: Number(n), passed: false, problems: [{ kind: "ask-nowhere", side: "ours", said: "This endpoint's request has no place for a person's message, so a test conversation's words would reach nothing." }] };
  const { a1, a2, b1 } = sent;
  const problems = [];
  const add = (kind, side, said) => problems.push({ kind, side, said });
  const told = toldApart(a1);
  const shaped = told.system.length > 0 || told.person.length > 0;
  const inInstructions = told.system.some((t) => t.includes(nonce));
  if (!generation(a1).length) add("no-model-call", "ours", "The first message Cortad sent reached no model call.");
  else if (inInstructions && !asksInInstructions(own)) add("ask-in-instructions", "ours", "A test conversation's words reached the model as your app's instructions, not as the person's turn.");
  else if (!inInstructions && (shaped ? !told.person.some((t) => t.includes(nonce)) : !promptOf(a1).includes(nonce))) add("ask-not-in-turn", "ours", "A test conversation's words never reached the model as the person's turn.");
  const ask = askOf([a1, a2, b1]);
  const carried = (later) => carriedFrom(later, a1, ask).length > 0 || promptOf(later).includes(nonce);
  if (proof?.session?.held && !carried(a2)) add("not-carried", "ours", "The second message of one conversation did not carry the first, though your own requests showed this endpoint holds a conversation.");
  if (carried(b1)) add("shared-history", "theirs", "A new conversation carried an earlier one's words: every conversation on this endpoint shares what your app keeps, so test conversations would read each other's.");
  const met = metIn(a1, own);
  if (met) add("unreadable", "theirs", met);
  else if (!ok(a1.status)) add("unreadable", "theirs", `Your app answered ${a1.status} to the first message.`);
  else if (!replyOf(a1).text.trim()) {
    // No words because the app's own model refused it is the app's key, card or model, never our
    // reading: a wrong key in the twin's env file held Run as "could not be read as words", ours.
    const calls = generation(a1);
    const refused = calls.length && calls.every((c) => REFUSED.has(Number(c.status))) ? calls.at(-1) : null;
    add("unreadable", refused ? "theirs" : "ours", refused ? `The first message reached your app's model, and the ${modelCall(refused)}, so no words came back.` : "The reply to the first message could not be read as words.");
  }
  const instructions = str(generation(a1).find((c) => typeof c.instructions === "string")?.instructions).trim();
  const pieces = piecesOf(instructions);
  const request = norm(a1.body);
  // Carried by the request as instructions: wording the request holds. An id, a date or an address
  // the app writes into its own prompt is its design: Databuddy's prompt names the site the request
  // asks about, and that id held every run.
  const carriedIn = pieces.filter((p) => WORDING.test(p) && request.includes(norm(p)));
  if (found && carriedIn.length && !pieces.some(found)) {
    add("instructions-not-in-code", "ours", `The instructions the model was given are not written in your code: "${clip(instructions.replace(/\s+/g, " "), 200)}". They came from the request this endpoint answered.`);
  }
  return { n: Number(n), passed: !problems.length, problems };
}

// The exchanges grouped by the door they came through, keyed by door.
export function doorsOf(exchanges, routes = []) {
  const doors = new Map();
  for (const ex of exchanges) {
    const door = doorOf(ex, routes);
    if (!doors.has(door.key)) doors.set(door.key, { door, exchanges: [] });
    doors.get(door.key).exchanges.push(ex);
  }
  return doors;
}

// Every door the rows' exchanges came through, with its proof, keyed by door.
export function proofsOf(rows, { routes = [], ...opts } = {}) {
  const all = exchangesOf(rows);
  return new Map([...doorsOf(all.filter((ex) => !isCanary(ex)), routes)].map(([key, { door, exchanges }]) => [key, proofOf(exchanges, door, { others: all, ...opts })]));
}
