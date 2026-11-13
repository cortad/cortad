import { documentAt, readable } from "./document.mjs";

const HOP = /^(?:host|content-length|connection|keep-alive|transfer-encoding|upgrade|expect|te|trailer|accept-encoding|x-cortad-as|x-cortad-turn)$/i;

const PLAIN_HEADER = /^(?:accept(?:-.*)?|content-.*|user-agent|origin|referer|cookie|cache-control|pragma|priority|dnt|sec-.*|x-forwarded-.*|x-real-ip|if-.*)$/i;

const SETTING = /^(?:model|role|type|id|object|stream|tool_choice|response_format|stop|user|name|tool_call_id|call_id|index|encoding_format|service_tier|reasoning_effort|modalities)$/;

const SAMPLE = 600, SAMPLE_REPLY = 4000;
const PROBLEMS_MAX = 12;

const str = (v) => (typeof v === "string" ? v : "");
const arr = (v) => (Array.isArray(v) ? v : []);
const parse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}...` : s);

const LINK_MAX = 200;
const clipAtWord = (s, n) => {
  if (s.length <= n) return s;
  const link = [...s.matchAll(/https?:\/\/\S+/g)].find((m) => m.index < n && m.index + m[0].length > n);
  const end = link ? Math.min(link.index + link[0].length, link.index + LINK_MAX) : s.lastIndexOf(" ", n);
  return end >= s.length ? s : `${s.slice(0, end > 0 ? end : n)}...`;
};

const once = (fn) => { const seen = new WeakMap(); return (ex) => { if (!seen.has(ex)) seen.set(ex, fn(ex)); return seen.get(ex); }; };
const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

export const norm = (s) => String(s ?? "")
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\[nrt]/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  .toLowerCase().replace(/\s+/g, " ").trim();

const SESSION_NAME = /^(?:session|conversation|thread|chat|dialog(?:ue)?|convo)(?:[_-]?(?:id|key|token|uuid))?$|^(?:id|uuid)$/i;
const idLike = (v) => /^\d{6,}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-|^[0-9a-f]{12,}$/i.test(v) || v.split(/[-_.:]/).some((s) => s.length >= 12 && /\d/.test(s) && /[a-z]/i.test(s));

function leaves(v, at = [], out = [], max = 400) {
  if (out.length >= max || at.length > 10) return out;
  if (typeof v === "string" || typeof v === "number") out.push({ at, value: String(v) });
  else if (Array.isArray(v)) v.forEach((x, i) => leaves(x, [...at, i], out, max));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, [...at, k], out, max);
  return out;
}

const fieldOf = (at) => { const i = at.findIndex((k) => typeof k === "number"); return (i < 0 ? at : at.slice(0, i)).join("."); };
const inList = (at) => at.some((k) => typeof k === "number");

const request = (r) => (r && typeof r === "object" && typeof r.method === "string" && str(r.path).startsWith("/") ? {
  at: Number(r.at) || 0, ms: Number(r.ms) || 0, method: r.method.toUpperCase(), path: r.path, body: str(r.body), status: Number(r.status) || 0,
  reply: str(r.reply), cookies: arr(r.cookies).filter((c) => typeof c === "string"), ...(r.cut === true ? { cut: true } : {}),
} : null);

function turnOf(ex, steps) {
  const asked = steps.at(-1);
  if (!asked) return ex;
  return {
    ...ex, at: asked.at, ms: ex.at + ex.ms - asked.at, method: asked.method, path: asked.path, body: asked.body,
    cookies: [...new Set([...steps.flatMap((s) => s.cookies), ...ex.cookies])],
    answer: { method: ex.method, path: ex.path, asked: asked.reply }, before: steps.slice(0, -1),
  };
}

const AT = /^[^\n\r\t]{1,300}:\d{1,7}$/;
const EVENT = /^[\w.:-]{1,40}$/;
export const sitesOf = (v) => arr(v).filter((s) => s && typeof s.at === "string" && AT.test(s.at) && typeof s.text === "string").slice(0, 16)
  .map((s) => ({ at: s.at, ...(typeof s.event === "string" && EVENT.test(s.event) ? { event: s.event } : {}), text: s.text.slice(0, 300) }));

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

export const provingOf = (exchanges) => { const own = exchanges.filter((ex) => !ex.trial); return own.length ? own : exchanges; };

const CANARY = /^canary:(\d{1,10}):([ab]):([12])$/;
export const isCanary = (ex) => CANARY.test(ex.turn ?? "");

const REACH = /^reach:/;

const routeRe = (template) => new RegExp(`^${template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^/{}]+\}/g, "([^/]+)")}/?$`);

export function doorOf(ex, routes = []) {
  const bare = ex.path.split("?")[0];
  const fits = routes.filter((r) => r && r.method === ex.method && typeof r.path === "string" && routeRe(r.path).test(bare))
    .sort((a, b) => (a.path.match(/\{/g) ?? []).length - (b.path.match(/\{/g) ?? []).length);
  const path = fits[0]?.path ?? bare.split("/").map((s) => (/^\d+$/.test(s) || idLike(s) ? "{id}" : s)).join("/");
  return { method: ex.method, path, key: `${ex.method} ${path}` };
}

const paramsOf = (template, path) => {
  const names = [...template.matchAll(/\{([^/{}]+)\}/g)].map((m) => m[1]);
  const m = routeRe(template).exec(path.split("?")[0]);
  return m ? Object.fromEntries(names.map((n, i) => [n, m[i + 1]])) : {};
};

const PATH_VALUE = /^(?!\.\.?$)[^/?#\s]{1,200}$/;
const pathValuesOf = (template, path) => {
  const kept = Object.entries(paramsOf(template, path)).filter(([k, v]) => /^[^/{}\s]{1,100}$/.test(k) && PATH_VALUE.test(v ?? ""));
  return kept.length ? { pathValues: Object.fromEntries(kept.slice(0, 20)) } : {};
};

const headerOf = (headers, name) => Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
const bodyOf = once((ex) => {
  const json = parse(ex.body);
  if (json && typeof json === "object") return json;
  if (/x-www-form-urlencoded/i.test(str(headerOf(ex.headers, "content-type")))) return Object.fromEntries(new URLSearchParams(ex.body));
  return null;
});

const promptOf = once((ex) => norm(ex.sent.map((s) => {
  const v = parse(s);
  return v && typeof v === "object" ? leaves(v, [], [], 5000).filter((l) => !SETTING.test(String(l.at.at(-1)))).map((l) => l.value).join("\n") : s;
}).join("\n")));
const generation = (ex) => ex.calls.filter((c) => !c.embedding);
const answeredCalls = (ex) => generation(ex).filter((c) => typeof c.reply === "string" && c.reply);

const tokensOf = (s) => str(s).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
const modelWords = (ex) => {
  const calls = answeredCalls(ex);
  if (calls.length < 2) return str(calls.at(-1)?.reply);
  const body = new Set(tokensOf(ex.reply));
  const carried = (c) => tokensOf(c.reply).filter((t) => body.has(t)).length;
  return str(calls.reduce((best, c) => (carried(c) >= carried(best) ? c : best)).reply);
};

const estimatedTokens = (exchanges) => {
  const prompt = median(exchanges.map((ex) => Math.ceil(promptOf(ex).length / 4)));
  return prompt ? { prompt, completion: median(exchanges.map((ex) => Math.ceil(modelWords(ex).length / 4))) ?? 0, estimated: true } : null;
};

const overlap = (pieces, words) => pieces.reduce((n, p) => { const t = norm(p); return n + (t && words.includes(t) ? p.length : 0); }, 0);

export const replyOf = once((ex) => {
  if (ex.later) return { text: modelWords(ex), path: null, stream: false };
  const words = norm(modelWords(ex));
  const whole = parse(ex.reply);
  const stream = /event-stream|ndjson|jsonl|stream/i.test(ex.type) || (ex.writes > 1 && whole === undefined);
  if (!stream && whole && typeof whole === "object") {
    const best = leaves(whole).filter((l) => /\D/.test(l.value))
      .map((l) => ({ l, score: words ? overlap([l.value], words) : l.value.length }))
      .sort((a, b) => b.score - a.score || b.l.value.length - a.l.value.length)[0];

    const text = best ? documentAt(whole, best.l.at) ?? readable(best.l.value) : "";
    return { text, path: best ? newestReply(whole, best.l.at).join(".") : null, stream: false };
  }
  if (!stream) return { text: readable(typeof whole === "string" ? whole : ex.reply), path: null, stream: false };
  const { events, loose } = eventsOf(ex.reply);

  return threaded(events, words) ?? { text: readable(assembled(events, loose, words, ex.reply)), path: null, stream: true };
});

const NO_TEXT = "the reply's stream finished on an error before any text";
const withError = (error) => (error === NO_TEXT ? "and its reply ended on an error before any text" : `with an error: "${clipAtWord(error, 160)}"`);

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

    const said = !sse || line.startsWith("data:") ? eventError(v, part?.[1] === "3" ? "error" : named, data) : "";
    if (said) errors.push(said);
    if (v === undefined || v === null || typeof v !== "object" && typeof v !== "string") loose.push(data);
    else events.push(v);
  }

  const is = (v, type) => v && typeof v === "object" && v.type === type;
  if (!errors.length && events.some((v) => is(v, "finish") && v.finishReason === "error") && !events.some((v) => is(v, "text-delta") && str(v.delta).trim())) errors.push(NO_TEXT);
  return { events, loose, errors: sse || !loose.length ? errors : [] };
}

function eventError(v, named, data) {
  const o = v && typeof v === "object" ? v : {};
  if (named !== "error" && typeof o.type === "string" && !/error|fail/i.test(o.type)) return "";
  const e = o.error ?? (o.type === "error" || named === "error" ? o.message ?? o.detail ?? o.errorText : undefined);
  const said = (typeof e === "string" ? e : str(e?.message)).trim();
  return said || (named === "error" ? (typeof v === "string" ? v : data).trim() : "");
}

const at = (v, path) => path.reduce((o, k) => (o === null || typeof o !== "object" ? undefined : Array.isArray(o) && k === -1 ? o.at(-1) : o[k]), v);

const newest = (v, path) => path.map((k, i) => { const list = at(v, path.slice(0, i)); return typeof k === "number" && isTurns(list) && k === list.length - 1 ? -1 : k; });

const TURNS_NAME = /^(?:turns|messages|history|exchanges|replies)$/i;
const newestReply = (v, path) => path.map((k, i) => {
  const list = at(v, path.slice(0, i));
  const named = i > 0 && TURNS_NAME.test(String(path[i - 1])) && Array.isArray(list) && list.every((e) => e && typeof e === "object" && !Array.isArray(e));
  return typeof k === "number" && (named || isTurns(list)) && k === list.length - 1 ? -1 : k;
});

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

  const thread = best?.path.some((k, i) => { const list = arr(at(events.find((v) => at(v, best.path) !== undefined), best.path.slice(0, i))); return typeof k === "number" && list.length > 1 && (k === -1 || isTurns(list)); });
  if (!thread) return null;
  const pieces = events.map((v) => at(v, best.path)).filter((s) => typeof s === "string");
  return { text: pieces.at(-1) ?? "", path: best.path.join("."), stream: true };
}

const NOT_ANSWER = /reason|think|tool|^(?:status|progress|ping|heartbeat)$/i;

const LABEL = /^(?:type|event|kind|role|model|name|object|status|finishReason|finish_reason|id|uuid|sequence|index)$|(?:Id|_id)$/;
function assembled(events, loose, words, raw) {
  const groups = new Map();
  for (const v of events) {
    if (v && typeof v === "object" && NOT_ANSWER.test(str(v.type))) continue;
    for (const l of typeof v === "string" ? [{ at: [], value: v }] : leaves(v)) {

      if (l.at.some((k) => typeof k === "string" && THINKING.test(k))) continue;
      if (LABEL.test(String(l.at.at(-1) ?? ""))) continue;
      const key = l.at.map((k) => (typeof k === "number" ? "[]" : k)).join(".");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(l.value);
    }
  }

  const prose = (pieces) => pieces.filter((v) => /\s|[^\x00-\x7F]/.test(v)).join("").length;

  const best = [...groups.values()]
    .map((pieces) => ({ text: pieces.join(""), score: words ? overlap(pieces, words) : prose(pieces) }))
    .filter((g) => g.score || /\p{L}/u.test(g.text))
    .sort((a, b) => b.score - a.score || b.text.length - a.text.length)[0];
  return (best?.score ? best.text : loose.join(raw.includes("data:") ? "" : "\n")) || best?.text || "";
}

const SYSTEM_ROLE = /^(?:system|developer)$/;

const TOLD_MIN = 12;
const textIn = (v) => norm(typeof v === "string" ? v : leaves(v, [], [], 5000).filter((l) => !SETTING.test(String(l.at.at(-1)))).map((l) => l.value).join(" "));

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

const MESSAGE_NAME = /^(?:user_?)?(?:message|msg|query|question|input|text|content|ask)$/i;
const INSTRUCTIONS_NAME = /system|instruction|persona|preamble|developer/i;
const nameRank = (l) => { const key = String(l.at.at(-1)); return INSTRUCTIONS_NAME.test(key) ? 2 : MESSAGE_NAME.test(key) ? 0 : 1; };

const MODEL_SIDE = /^(?:assistant|ai|bot|chatbot|model|system|developer|tool|function|agent)$/i;
const askable = (body, at) => {
  if (TURN_ROLE.test(String(at.at(-1)))) return false;
  const i = at.findIndex((k) => typeof k === "number");
  const list = i < 0 ? null : at.slice(0, i).reduce((v, k) => v?.[k], body);
  return !isTurns(list) || (at[i] === list.length - 1 && !Object.entries(list[at[i]]).some(([k, v]) => TURN_ROLE.test(k) && MODEL_SIDE.test(String(v))));
};
const words = (v) => /\s/.test(v) || (v.match(/[\p{L}\p{N}]/gu) ?? []).length >= TOLD_MIN;

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

  const best = [...tally.values()].sort((a, b) => app.has(a.field) - app.has(b.field) || b.hits.size - a.hits.size || (b.values.size > 1) - (a.values.size > 1) || a.url - b.url || a.rank - b.rank || a.list - b.list || b.longest - a.longest)[0];
  return best?.field ? { field: best.field, list: best.list, appFields: [...app].filter((f) => f !== best.field) } : null;
}

function askIn(ex, ask) {
  const body = bodyOf(ex);
  if (!ask || !body) return "";
  const prompt = promptOf(ex);
  return leaves(body).filter((l) => fieldOf(l.at) === ask.field && askable(body, l.at) && (!ask.list || prompt.includes(norm(l.value)))).at(-1)?.value ?? "";
}

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

function carriedFrom(later, earlier, ask) {
  const prompt = promptOf(later);
  const before = promptOf(earlier);
  const own = norm(askIn(later, ask));
  const replies = [norm(modelWords(earlier)).slice(0, 80), norm(replyOf(earlier).text).slice(0, 80)].filter((t) => !before.includes(t));
  return [norm(askIn(earlier, ask)), ...replies].filter((t) => t.length >= 8 && (own.includes(t) ? prompt.split(t).length > 2 : prompt.includes(t)));
}

const cookiesIn = (ex) => Object.fromEntries(str(headerOf(ex.headers, "cookie")).split(";").map((c) => c.trim().split("=")).filter(([k, v]) => k && v !== undefined).map(([k, ...v]) => [k, v.join("=")]));

const READS_AS_CREDENTIAL = /auth|token|jwt|csrf|xsrf|secret|key|sid$|sessionid|connect\.sid|phpsessid|jsessionid|__session|__host-|__secure-|^sb-|clerk|supabase|laravel_session/i;
const READS_AS_CONVERSATION = /conv|thread|chat|dialog|session[-_]?id/i;
const namesConversation = (name) => READS_AS_CONVERSATION.test(name) && !READS_AS_CREDENTIAL.test(name);

export function carrierOf(earlier, later, ask, door) {
  const same = (a, b) => a !== undefined && a !== "" && a === b;
  const before = new Map(leaves(bodyOf(earlier) ?? {}).map((l) => [l.at.join("."), l.value]));
  const own = leaves(bodyOf(later) ?? {}).filter((l) => !inList(l.at) && fieldOf(l.at) !== ask?.field);

  const handedBack = norm(earlier.reply);

  const named = own.find((l) => /^\S{6,}$/.test(l.value) && (/\d/.test(l.value) || l.value.length >= 16) && handedBack.includes(norm(l.value)) && before.get(l.at.join(".")) !== l.value);

  if (named) return { carrier: "body", key: named.at.join("."), minted: "app" };
  const fields = own.filter((l) => same(l.value, before.get(l.at.join("."))));
  const params = paramsOf(door.path, later.path);
  const was = paramsOf(door.path, earlier.path);
  const segment = Object.keys(params).find((k) => same(params[k], was[k]));
  if (segment) return { carrier: "path", key: segment, minted: "client" };

  const idField = fields.find((l) => idLike(l.value) && SESSION_NAME.test(String(l.at.at(-1))));
  if (idField) return { carrier: "body", key: idField.at.join("."), minted: "client" };
  const jar = cookiesIn(later);
  const jarBefore = cookiesIn(earlier);

  const set = Object.keys(jar).find((k) => earlier.cookies.includes(k) && (jarBefore[k] === undefined || namesConversation(k)));
  if (set) return { carrier: "cookie", key: set, minted: "app" };
  const header = Object.keys(later.headers).find((k) => !HOP.test(k) && !PLAIN_HEADER.test(k) && namesConversation(k) && same(later.headers[k], headerOf(earlier.headers, k.toLowerCase())));
  if (header) return { carrier: "header", key: header.toLowerCase(), minted: "client" };
  const cookie = Object.keys(jar).find((k) => namesConversation(k) && same(jar[k], jarBefore[k]));
  if (cookie) return { carrier: "cookie", key: cookie, minted: "client" };
  return { carrier: "none", key: null };
}

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

  return tried ? { held: false, ...carried, tried: true } : { held: false, carrier: "none", key: null };
}

const TIE = /^(?=.*\d)[\w.:-]{6,200}$/;
const TURN_ROLE = /^(?:role|sender|from|author|speaker)$/i;
const isTurns = (v) => Array.isArray(v) && v.length > 0 && v.every((e) => e && typeof e === "object" && !Array.isArray(e)) && v.some((e) => Object.keys(e).some((k) => TURN_ROLE.test(k)));

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

const TAG = /<\|[\w-]{1,40}\|>|<\/?([a-z][\w-]{0,40})(?:\s[^<>]{0,120})?\/?>/gi;
const FORMATTING = /^(?:a|b|i|u|s|em|strong|br|p|ul|ol|li|code|pre|span|div|table|thead|tbody|tr|td|th|h[1-6]|img|sup|sub|blockquote|hr|small|mark|del|ins|kbd|details|summary|figure|figcaption|caption|section|article|nav|header|footer|main|button|label|input|form)$/i;
const REASONING = /^(?:think|thinking|reasoning)$/i;
const PLACEHOLDER = /\{\{\s*[\w.]{1,40}\s*\}\}|\$\{\s*[\w.]{1,40}\s*\}|\{[a-z_][a-z0-9_]{1,40}\}|%\([a-z_]\w{0,40}\)s/gi;
const ERROR_OPEN = /^\s*(?:error:|exception:|traceback \(most recent call last\)|internal server error|an? (?:unexpected |internal )?error (?:has )?occurred|something went wrong)/i;
const ok = (status) => status >= 200 && status < 300;

const prose = (text) => text.replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, " ").replace(/`[^`\n]*`/g, " ");

const errorWords = (body, field) => {
  const v = body[field];
  return [v, v?.message, arr(v)[0]?.message, body.message].find((s) => typeof s === "string" && s.trim()) ?? JSON.stringify(v);
};

function errorOf(ex, reply) {
  const body = parse(ex.reply);
  const field = body && typeof body === "object" && !Array.isArray(body) ? ["error", "errors"].find((k) => body[k] && (typeof body[k] !== "object" || Object.keys(body[k]).length)) : null;
  if (field) return errorWords(body, field);
  const [said] = eventsOf(ex.reply).errors;
  if (said) return said;
  const words = norm(modelWords(ex));
  return ERROR_OPEN.test(reply.text) && !(words && words.includes(norm(reply.text).slice(0, 60))) ? reply.text.trim() : "";
}

const endedInError = (ex, reply = replyOf(ex)) => !ok(ex.status) || Boolean(errorOf(ex, reply));

const callFailed = (c) => { const status = Number(c.status) || 0; return status === 0 || status >= 400; };
const modelCall = (c) => { const status = Number(c.status) || 0; return `model call to ${str(c.host)}${c.model ? ` for ${c.model}` : ""} ${status ? `answered ${status}` : "got no answer"}`; };

const REFUSED = new Set([401, 402, 403, 404]);

function refusalOf(ex, problems) {
  const call = ex.calls.findLast((c) => REFUSED.has(Number(c.status)));
  const error = problems.find((p) => p.kind === "error-status" || p.kind === "error-under-2xx");
  return call ? { refused: [`A ${modelCall(call)}.`, error?.said].filter(Boolean).join(" ") } : {};
}

const RAISED = /^raised \S/;
function toolErrorsIn(ex) {
  const out = new Map();

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

function endedOnTool(ex) {
  const last = generation(ex).at(-1);
  if (str(last?.reply).trim()) return null;
  const asked = [...new Set(arr(last?.called).map((c) => str(c?.name)).filter(Boolean))];
  if (!asked.length) return null;
  const inApp = new Set(ex.deps.flatMap((d) => arr(d.called).map((c) => str(c?.name))));
  const streamed = eventsOf(str(ex.reply)).events.some((e) => e && typeof e === "object" && /tool.*(?:output|result)/i.test(str(e.type)));
  return asked.some((name) => inApp.has(name)) || streamed ? asked : null;
}

const ERROR_LINE = /(?:error|exception)\b|\bunhandled\b|\bfatal\b|\bpanic\b/i;
const NOT_ERROR = /warn|Traceback \(most recent|\bcortad: /i;

const RELAYED = /^(?:\[[^\]\s]{1,60}\] |(?:@[\w.-]+\/)?[\w.-]+:[\w.-]+: |[a-z][\w.-]*\s*\| )/i;

const FRAME = /^\s*\d+ \| /;
const CARET = /^\s*\^+\s*$/;
const AT_LINE = /^\S+:\d+$/;
const PY_FRAME = /File "[^"]+", line \d+/;
const sourceAt = (lines, n) => FRAME.test(lines[n]) || CARET.test(lines[n + 1] ?? "") || (AT_LINE.test(lines[n]) && CARET.test(lines[n + 2] ?? ""))
  || PY_FRAME.test(lines[n]) || (PY_FRAME.test(lines[n - 1] ?? "") && /^\s/.test(lines[n]));

const FIELD = /^[\s│├└─]*([\w.]+)\s*[:=]\s*(.*)$/;
const ERROR_FIELD = /^(?:\w+\.)?err(?:or)?(?:[._]?message)?$|^message$/i;
function firstError(text) {
  const printed = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split(/\r?\n/);
  const lines = printed.map((l) => l.replace(RELAYED, ""));

  const i = printed.findIndex((l, n) => ERROR_LINE.test(l) && !NOT_ERROR.test(l) && !sourceAt(lines, n) && !/^\s*[│├└]/.test(lines[n]));
  if (i < 0) return "";
  const block = [];
  for (const l of lines.slice(i + 1, i + 200)) { if (!/^\s+\S/.test(l)) break; block.push(l); }
  const fields = block.map((l) => FIELD.exec(l)).filter(Boolean);

  const record = fields.length > 1;
  const [, key, said] = (record && fields.find(([, name]) => ERROR_FIELD.test(name))) || [];
  const under = key ? [/(?:^|\s)message=(.*?)(?:\s+stack=|$)/.exec(said)?.[1] ?? `${key}: ${said}`] : record ? [] : block.slice(0, 4);

  return clip(scrubbed([lines[i], ...under].join(" ").slice(0, 2_000).replace(/\s+/g, " ").trim()), 300);
}

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

  const tokens = new Set(), reasoning = new Set(), fromPrompt = new Map();
  for (const [tag, name] of said.matchAll(TAG)) {
    if (!name) tokens.add(tag);
    else if (REASONING.test(name)) reasoning.add(tag);
    else if (!FORMATTING.test(name) && prompt.includes(`<${name.toLowerCase()}`) && !fromPrompt.has(name.toLowerCase())) fromPrompt.set(name.toLowerCase(), tag);
  }
  const listed = (set) => [...set].map((t) => `"${t}"`).join(", ");

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
  if (told.length && told.every((c) => !c.rules.length)) add("rules-not-carried", "The prompt your app sent the model carried none of the rules Cortad found in your code.", frame(told[0].caller));

  const line = ex.trial && !REACH.test(ex.turn ?? "") ? "" : printedLine(ex);
  if (line) add("app-printed", `Your app printed "${line}" while it answered.`, null);
  return out;
}

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

export function proofOf(exchanges, door, { find = () => null, base = "", printed = () => "", firstErrors = new Map(), others = exchanges } = {}) {
  const at = (f) => {
    const m = /^(.*):(\d+)$/.exec(str(f));
    return m ? { file: base ? `${base.replace(/\/+$/, "")}/${m[1]}` : m[1], line: Number(m[2]) } : null;
  };
  const frame = (frames) => at(arr(frames)[0]);
  const near = (ex) => [...new Set(ex.calls.flatMap((c) => arr(c.caller).map(at)).filter(Boolean).map((p) => p.file))];
  const fallback = !exchanges.some((ex) => !ex.trial);
  exchanges = provingOf(exchanges);

  const later = exchanges.every((ex) => ex.later);
  if (!later) exchanges = exchanges.map(({ later: _later, ...ex }) => ex);
  const ask = askOf(exchanges);
  const replies = exchanges.map(replyOf);
  const latest = exchanges.at(-1);

  const uncut = exchanges.findLastIndex((ex) => !ex.cut);
  const shown = uncut < 0 ? exchanges.length - 1 : uncut;
  const session = sessionOf(exchanges, ask, door);

  const turnsIn = (ex) => { const list = String(session.key ?? "").split(".").reduce((v, k) => v?.[k], bodyOf(ex)); return Array.isArray(list) && list.length > 0; };
  const shape = session.carrier === "history" ? exchanges.findLast(turnsIn) ?? latest : latest;
  const echoes = echoesOf(exchanges, ask, session);

  const served = (ex) => generation(ex).filter((c) => !callFailed(c));
  const metered = exchanges.filter((ex) => served(ex).some((c) => c.usage));
  const tokens = (key) => median(metered.map((ex) => served(ex).reduce((n, c) => n + (Number(c[key]) || 0), 0)));

  const cached = tokens("cachedTokens");

  const byModel = new Map();
  for (const ex of metered) for (const c of served(ex)) {
    const key = str(c.answered) || str(c.model);
    if (!c.usage || !key) continue;
    const host = str(c.host).replace(/:\d+$/, "").toLowerCase();
    const m = byModel.get(key) ?? { model: key, host: /^[a-z0-9.-]{1,200}$/.test(host) ? host : "", calls: 0, prompt: 0, completion: 0, cached: 0 };
    m.calls += 1;
    m.prompt += Number(c.promptTokens) || 0;
    m.completion += Number(c.completionTokens) || 0;
    m.cached += Number(c.cachedTokens) || 0;
    byModel.set(key, m);
  }
  const perExchange = (n) => Math.round((n / metered.length) * 100) / 100;
  const models = [...byModel.values()].map((m) => ({
    model: m.model, ...(m.host ? { host: m.host } : {}), calls: perExchange(m.calls),
    prompt: Math.round(m.prompt / metered.length), completion: Math.round(m.completion / metered.length), ...(m.cached ? { cached: Math.round(m.cached / metered.length) } : {}),
  }));

  const wrote = exchanges.map((ex) => answeredCalls(ex).filter((c) => !callFailed(c)).at(-1)).filter(Boolean);
  const writers = (wrote.length ? wrote : exchanges.flatMap(served)).map((c) => str(c.answered) || str(c.model)).filter(Boolean);
  const count = (m) => writers.filter((x) => x === m).length;
  const seconds = median(exchanges.map((ex) => ex.ms / 1000));

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
      model: [...new Set(writers)].sort((a, b) => count(b) - count(a))[0] ?? null,
      tokens: metered.length ? { prompt: tokens("promptTokens"), completion: tokens("completionTokens"), ...(cached ? { cached } : {}) } : estimatedTokens(exchanges),
      ...(models.length ? { models } : {}),
      replySeconds: seconds === null ? null : Math.round(seconds * 10) / 10,
      purpose: null,
      at: new Date(latest.at).toISOString(),
      ...insideOf(exchanges),
      ...(answer ? { answer } : {}),
      ...(later ? { later: true } : {}),
      ...(fallback ? { fallback: true } : {}),
    },
    problems,

    sample: { ask: clip(askIn(exchanges[shown], ask), SAMPLE), reply: clip(replies[shown].text, SAMPLE_REPLY), ...(exchanges[shown].cut ? { cut: true } : {}),
      ...(endedInError(exchanges[shown], replies[shown]) ? { error: true, ...refusalOf(exchanges[shown], each[shown]) } : {}) },
  };
}

const NONCE = /\bzq\d{8}\b/;

const PIECE_MIN = 24, PIECES = 5, SHORT_MIN = 8;

const WORDING = /\p{L}{2,}(?:\s+\p{L}{2,}){3}/u;
const piecesOf = (text) => {
  const long = text.split(/[\n\r"'`\\]+/).map((p) => p.trim()).filter((p) => p.length >= PIECE_MIN).slice(0, PIECES);
  return long.length || text.trim().length < SHORT_MIN ? long : [text.trim()];
};

const asksInInstructions = (own) => {
  const ask = askOf(own);
  return own.some((ex) => { const words = norm(askIn(ex, ask)); return words.length >= 8 && toldApart(ex).system.some((t) => t.includes(words)); });
};

function metIn(ex, own) {
  const mine = own.filter((o) => !o.trial);
  const last = mine.findLast((o) => !o.cut) ?? mine.at(-1);
  if (!ok(ex.status) || !last || !endedInError(last)) return "";
  const calls = generation(ex);
  const refused = calls.length && calls.every(callFailed) ? calls.at(-1) : null;
  const error = errorOf(ex, replyOf(ex)).replace(/\s+/g, " ").trim();
  if (!refused && !error) return "";
  return `A test message sent the way a simulation sends it was answered with an error${error && error !== NO_TEXT ? `, "${clipAtWord(error, 160)}"` : ""}, as your own request was${refused ? `: a ${modelCall(refused)}` : ""}. Fix that and send one more request.`;
}

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

    const calls = generation(a1);
    const refused = calls.length && calls.every((c) => REFUSED.has(Number(c.status))) ? calls.at(-1) : null;
    add("unreadable", refused ? "theirs" : "ours", refused ? `The first message reached your app's model, and the ${modelCall(refused)}, so no words came back.` : "The reply to the first message held no words Cortad could take.");
  }
  const instructions = str(generation(a1).find((c) => typeof c.instructions === "string")?.instructions).trim();
  const pieces = piecesOf(instructions);
  const request = norm(a1.body);

  const carriedIn = pieces.filter((p) => WORDING.test(p) && request.includes(norm(p)));
  if (found && carriedIn.length && !pieces.some(found)) {
    add("instructions-not-in-code", "ours", `The instructions the model was given are not written in your code: "${clip(instructions.replace(/\s+/g, " "), 200)}". They came from the request this endpoint answered.`);
  }
  return { n: Number(n), passed: !problems.length, problems };
}

export function doorsOf(exchanges, routes = []) {
  const doors = new Map();
  for (const ex of exchanges) {
    const door = doorOf(ex, routes);
    if (!doors.has(door.key)) doors.set(door.key, { door, exchanges: [] });
    doors.get(door.key).exchanges.push(ex);
  }
  return doors;
}

export function proofsOf(rows, { routes = [], ...opts } = {}) {
  const all = exchangesOf(rows);
  return new Map([...doorsOf(all.filter((ex) => !isCanary(ex)), routes)].map(([key, { door, exchanges }]) => [key, proofOf(exchanges, door, { others: all, ...opts })]));
}
