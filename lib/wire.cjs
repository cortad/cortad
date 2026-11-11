// What lib/trace.cjs and lib/proxy.mjs both read off the wire: a model call's prompt and reply in
// every provider's shape, and the exchange a request and its model calls make. The hook sees them
// from inside the app's process; the proxy from outside it, for an app the hook cannot load into.
// Both write the same rows, so the command reads them one way (lib/replay.mjs). Pure functions,
// and one recorder per process. Nothing here talks to a network.
"use strict";
const fs = require("node:fs");
const { messageText } = require("./message-text.cjs");
// Every value a trace row carries passes one mask, whichever path wrote it: a key inside a value
// ("sk-...", a bearer token, a JWT) and what anyone wrote after "password is" or "token:". The
// door row's sign-in headers are kept on purpose: the command replays them from this machine.
const SECRET_TEXT = [
  /((?:pass(?:word|phrase|wd)|pwd|密码|口令)["']?\s*(?:is\b|was\b|[:=：]|是|为)\s*["']?)([^\s"'\\,;}，。；、]+)/gi,
  /((?:secret(?:[ _-]?key)?|api[ _-]?key|apikey|access[ _-]?key|private[ _-]?key|client[ _-]?secret|(?:auth|access|refresh)[ _-]?token|token)["']?\s*[:=：]\s*["']?)([^\s"'\\,;}，。；、]+)/gi,
];
const SECRET_WORD = /\b(?:Bearer\s+(?=[\w.~+/=-]*\d)[\w.~+/=-]{16,}|[spr]k[-_](?=[\w-]*\d)[\w-]{8,}|gh[po]_\w{16,}|github_pat_\w{16,}|xox[abpr]-[\w-]{8,}|AKIA[0-9A-Z]{12,}|AIza[\w-]{20,}|eyJ[\w-]{10,}\.[\w-]{4,}\.[\w-]*)/g;
const maskText = (s) => SECRET_TEXT.reduce((t, re) => t.replace(re, "$1[secret]"), s).replace(SECRET_WORD, "[secret]");
const scrub = (v, depth = 0) => (typeof v === "string" ? maskText(v)
  : Array.isArray(v) ? v.map((x) => scrub(x, depth + 1))
    : v && typeof v === "object" && depth < 12 ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "headers" && depth === 0 ? x : scrub(x, depth + 1)])) : v);
// A door's body goes up to the run as JSON, so it is masked as JSON: its string values, never its shape.
const bodyScrubbed = (text) => { try { const b = JSON.parse(text); return b && typeof b === "object" ? JSON.stringify(scrub(b)) : maskText(text); } catch { return maskText(text); } };
// A reply is JSON, or a stream of JSON events: masked the same way, event by event, so a stream
// whose events say {"token": "..."} keeps its words.
const replyScrubbed = (text) => {
  try { const b = JSON.parse(text); if (b && typeof b === "object") return JSON.stringify(scrub(b)); } catch { /* a stream, or text */ }
  return text.split("\n").map((line) => { const m = /^(data:\s?)?([{[].*)$/.exec(line); return m ? (m[1] || "") + bodyScrubbed(m[2]) : maskText(line); }).join("\n");
};
// A row as it is written: the four plain kinds as they are, every other one masked.
const scrubbed = (value) => {
  const plain = value.hello || value.listen || value.routes || value.conn;
  const out = plain ? value : scrub(value);
  if (!plain && typeof value.body === "string") out.body = bodyScrubbed(value.body);
  if (!plain && typeof value.reply === "string") out.reply = replyScrubbed(value.reply);
  if (!plain && Array.isArray(value.sent)) out.sent = value.sent.map(bodyScrubbed);
  if (!plain && Array.isArray(value.after)) out.after = value.after.map((s, i) => ({ ...out.after[i], body: bodyScrubbed(s.body), reply: replyScrubbed(s.reply) }));
  return out;
};

const MAX = 65536;
// The turn a message came in under, when the run tagged it: one opaque id per request, so a
// model call and its prompt can be pinned to the reply they produced even while five turns are
// in flight. It is read here and never shown to your app's own code path beyond the header.
const TURN = /^[A-Za-z0-9:_.-]{1,80}$/;
const turnOf = (headers) => {
  const t = headers && (typeof headers.get === "function" ? headers.get("x-cortad-turn") : headers["x-cortad-turn"]);
  return typeof t === "string" && TURN.test(t) ? t : undefined;
};
const norm = (s) => String(s || "")
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\[nrt]/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  .toLowerCase().replace(/\s+/g, " ").trim();
// A sentence with a slot in it ("answer in {language}") is matched by its literal parts.
const partsOf = (text) => text.split(/\{[^}]*\}|\$\{[^}]*\}|%[sd]|<[^>]{1,40}>/).map(norm).filter((p) => p.length >= 12);
// What the app's tools answered, as the prompt of the next model call carries them: the tool
// messages of a chat body, the function outputs of a responses body, the tool_result blocks of
// an Anthropic one, the functionResponse parts of a Gemini one. They are the material a reply's
// facts rest on, and without them a real ticket id read as invented. Bounded per call.
// A tool's answer is kept to the cap the reader takes (12,000 characters), and one longer says it was
// cut: MIT Learn AI's 8,000-character search results were kept at 3,000, and a podcast episode in
// the part cut off was graded as made up. A cut answer stands the passage questions down.
const TOOL_TEXT = 12000, TOOLS_MAX = 12;
const toolText = (name, full, extra = {}) => ({ name: String(name || "").slice(0, 80), text: full.slice(0, TOOL_TEXT), ...extra, ...(full.length > TOOL_TEXT ? { cut: true } : {}) });
const textOf = messageText;
// Only what came after the person's latest message belongs to this turn: a thread the app
// resends whole carries every earlier turn's tool answers too.
const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
const since = (items, isPerson) => { let at = -1; items.forEach((m, i) => { if (isPerson(m)) at = i; }); return items.slice(at + 1); };
// A user message that only hands a tool's answer back ("Observation: ...", <tool_response>) is
// the agent loop talking, not the person.
const HANDED_BACK = /^\s*(?:Observation\s*:|<(?:tool_response|tool_result|function_results?)>)/i;
const personSaid = (m) => m.role === "user" && !(Array.isArray(m.content) && m.content.some((c) => c && c.type === "tool_result")) && !HANDED_BACK.test(textOf(m.content));
const personAsked = (c) => c.role === "user" && !list(c.parts).some((p) => p.functionResponse);
const toolsIn = (sent) => {
  let body; try { body = JSON.parse(sent); } catch { return undefined; }
  if (!body || typeof body !== "object") return undefined;
  const out = [];
  const names = new Map();
  const add = (name, text) => { const full = textOf(text); const t = full.slice(0, TOOL_TEXT); if (t.trim() && out.length < TOOLS_MAX && !out.some((o) => o.text === t)) out.push(toolText(name, full)); };
  for (const m of list(body.messages)) {
    for (const c of list(m.tool_calls)) if (c.id && c.function) names.set(c.id, c.function.name);
    for (const c of list(m.content)) if (c.type === "tool_use" && c.id) names.set(c.id, c.name);
  }
  for (const m of since(list(body.messages), personSaid)) {
    if (m.role === "tool" || m.role === "function") add(m.name || names.get(m.tool_call_id), m.content);
    for (const c of list(m.content)) if (c.type === "tool_result") add(names.get(c.tool_use_id), c.content);
  }
  const items = list(body.input);
  for (const it of items) if (it.type === "function_call" && it.call_id) names.set(it.call_id, it.name);
  for (const it of since(items, (x) => x.role === "user")) if (it.type === "function_call_output") add(names.get(it.call_id), it.output);
  for (const c of since(list(body.contents), personAsked)) for (const p of list(c.parts)) if (p.functionResponse) add(p.functionResponse.name, p.functionResponse.response);
  const declared = declaredIn(body);
  for (const o of observedIn(turnTexts(body, true, declared), declared)) add(o.name, o.text);
  return out.length ? out : undefined;
};

// What the model asked the app to run: chat tool_calls (a stream's pieces joined by position), a
// legacy function_call, a responses function_call item, an Anthropic or Bedrock tool use, a
// Gemini functionCall. Read off the model's reply, and off this turn's earlier calls as the
// prompt resends them. Names and arguments only: every value clipped, a secret never written.
const CALLS_MAX = 12, VALUE_MAX = 200, ARGS_MAX = 1200;
const SECRET_KEY = /(?:^|_)(?:pass(?:word|phrase)?|secret|token|api_?key|authorization|cookie|session(?:_id)?|credentials?|private_key)$/;
const SECRET_VALUE = /^(?:Bearer\s|Basic\s|sk-|pk_|rk_|ghp_|gho_|github_pat_|xox[abpr]-|AKIA|AIza|eyJ[\w-]{10,}\.)/;
const clipped = (v, depth, max = VALUE_MAX) => {
  if (typeof v === "string") return SECRET_VALUE.test(v) ? "[secret]" : v.length > max ? v.slice(0, max) + "…" : v;
  if (Array.isArray(v)) return depth > 4 ? [] : v.slice(0, 20).map((x) => clipped(x, depth + 1, max));
  if (!v || typeof v !== "object") return v;
  const o = {};
  if (depth > 4) return o;
  for (const [k, x] of Object.entries(v).slice(0, 40)) o[k] = SECRET_KEY.test(k.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()) ? "[secret]" : clipped(x, depth + 1, max);
  return o;
};
const argsText = (raw) => {
  let v = raw;
  if (typeof raw === "string") { try { v = raw.trim() ? JSON.parse(raw) : {}; } catch { v = raw; } }
  return JSON.stringify(clipped(v === undefined || v === null ? {} : v, 0)).slice(0, ARGS_MAX);
};
// Each function tool the request declares, in every provider's shape: its name, what its
// description says it does, and its JSON schema (null where it declares none).
const toolDefs = (body) => {
  const out = [];
  const add = (name, does, schema) => { if (typeof name === "string" && name) out.push({ name, does: typeof does === "string" ? does : "", schema: schema && typeof schema === "object" ? schema : null }); };
  for (const t of [...list(body && body.tools), ...list(body && body.toolConfig && body.toolConfig.tools)]) {
    if (t.function) add(t.function.name, t.function.description, t.function.parameters);
    else if (t.toolSpec) add(t.toolSpec.name, t.toolSpec.description, t.toolSpec.inputSchema && t.toolSpec.inputSchema.json);
    else add(t.name, t.description, t.parameters || t.input_schema || t.inputSchema);
    for (const d of list(t.functionDeclarations || t.function_declarations)) add(d.name, d.description, d.parameters);
  }
  for (const f of list(body && body.functions)) add(f.name, f.description, f.parameters);
  return out;
};
const schemasOf = (body) => new Map(toolDefs(body).filter((d) => d.schema).map((d) => [d.name, d.schema]));
// What a tool's declared schema refuses in the arguments the model sent, said plainly, or null.
// Read before any value is clipped: a clipped value is ours, never the model's.
const refusedBy = (schema, raw) => {
  let args = raw === undefined || raw === null ? {} : raw;
  if (typeof args === "string") { if (!args.trim()) args = {}; else { try { args = JSON.parse(args); } catch { return "the arguments are not valid JSON"; } } }
  if (!args || typeof args !== "object" || Array.isArray(args)) return "the arguments are not a JSON object";
  const missing = (Array.isArray(schema.required) ? schema.required : []).find((k) => typeof k === "string" && !Object.prototype.hasOwnProperty.call(args, k));
  return missing ? `the required input "${missing}" is missing` : null;
};
// `schemas`: the request's declared tools, so each call the reply makes is checked against its own.
const callsOf = (events, schemas) => {
  const whole = new Map();
  const parts = new Map();
  let n = 0;
  const put = (key, name, args) => { if (name) whole.set(key || `w${n++}`, { name, args }); };
  const piece = (key, name, args) => {
    const p = parts.get(key) || { name: "", args: "" };
    if (name && !p.name) p.name = name;
    if (typeof args === "string") p.args += args;
    parts.set(key, p);
  };
  const blocks = (content) => {
    for (const b of list(content)) {
      if (b.type === "tool_use") put(b.id, b.name, b.input);
      if (b.type === "tool-call") put(b.toolCallId, b.toolName, b.input);
      if (b.toolUse) put(b.toolUse.toolUseId, b.toolUse.name, b.toolUse.input);
    }
  };
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    for (const c of list(e.choices)) {
      const m = c.message;
      if (m) {
        for (const t of list(m.tool_calls)) if (t.function) put(t.id, t.function.name, t.function.arguments);
        if (m.function_call) put(null, m.function_call.name, m.function_call.arguments);
      }
      const d = c.delta;
      if (d) {
        for (const t of list(d.tool_calls)) piece(`c${c.index || 0}.${t.index ?? t.id}`, t.function && t.function.name, t.function && t.function.arguments);
        if (d.function_call) piece(`f${c.index || 0}`, d.function_call.name, d.function_call.arguments);
      }
    }
    for (const it of [...list(e.output), ...list(e.item ? [e.item] : []), ...list(e.response && e.response.output)]) {
      if (it.type === "function_call") put(it.call_id || it.id, it.name, it.arguments);
    }
    blocks(e.content);
    blocks(e.message && e.message.content);
    blocks(e.output && e.output.message && e.output.message.content);
    if (e.type === "content_block_start" && e.content_block && e.content_block.type === "tool_use") piece(`a${e.index}`, e.content_block.name, "");
    if (e.type === "content_block_delta" && e.delta && e.delta.type === "input_json_delta") piece(`a${e.index}`, "", e.delta.partial_json);
    for (const c of list(e.candidates)) for (const p of list(c.content && c.content.parts)) if (p.functionCall) put(null, p.functionCall.name, p.functionCall.args);
    if (e.type === "tool-call" && e.toolName) put(e.toolCallId, e.toolName, e.input);
  }
  return [...whole.values(), ...parts.values()].filter((p) => p.name).map((p) => {
    const refused = schemas && schemas.has(p.name) ? refusedBy(schemas.get(p.name), p.args) : null;
    return { name: String(p.name).slice(0, 80), arguments: argsText(p.args), ...(refused ? { refused } : {}) };
  });
};
// This turn's earlier calls, as the prompt resends them after the person's latest message.
const calledBefore = (body) => callsOf([
  ...since(list(body.messages), personSaid).filter((m) => m.role === "assistant").map((m) => ({ choices: [{ message: m }], content: m.content })),
  { output: since(list(body.input), (x) => x.role === "user") },
  ...since(list(body.contents), personAsked).filter((c) => c.role === "model").map((c) => ({ candidates: [{ content: c }] })),
]);
// Tool use a model writes in its words instead of as a structured call. A ReAct agent (CrewAI,
// LangChain) writes "Action: name" then "Action Input: {...}" and is handed "Observation: ..."
// back in its next prompt; others write <tool_call>{...}</tool_call>, <function=name>,
// <invoke name="..."> or a JSON object that names the tool. A name counts only when the request
// declares that tool, in its tools field or in the tool list its prompt carries, so a thought, a
// "Final Answer" or prose that says Action is never a call.
const FINAL = /^final[\s_-]*answer$/i;
const TOOL_NAME = /^[A-Za-z_][\w.-]{0,79}$/;
const promptText = (body) => [
  ...list(body.messages).filter((m) => m.role !== "assistant").map((m) => textOf(m.content)),
  textOf(body.system), textOf(body.instructions), typeof body.prompt === "string" ? body.prompt : "", typeof body.input === "string" ? body.input : "",
  ...list(body.input).filter((x) => x.role && x.role !== "assistant").map((x) => textOf(x.content)),
  textOf(body.systemInstruction && body.systemInstruction.parts), ...list(body.contents).filter((c) => c.role !== "model").map((c) => textOf(c.parts)),
].join("\n");
const declaredIn = (body) => {
  const out = new Set();
  const add = (n) => { const s = typeof n === "string" ? n.trim().replace(/^["'`]+|["'`]+$/g, "") : ""; if (TOOL_NAME.test(s) && !FINAL.test(s)) out.add(s); };
  for (const d of toolDefs(body)) add(d.name);
  const text = promptText(body).slice(0, 200000);
  for (const m of text.matchAll(/^[ \t]*Tool Name:[ \t]*([^\n]+)/gim)) add(m[1]);
  for (const m of text.matchAll(/\b(?:one of|name of|names? from)[ \t]*\[([^\]\n]{1,2000})\]/gi)) for (const x of m[1].split(",")) add(x);
  for (const m of text.matchAll(/valid "?action"? values?:?[ \t]*([^\n]{1,2000})/gi)) for (const x of m[1].split(/,|\bor\b/)) add(x);
  for (const m of text.matchAll(/<(tools|functions)>([\s\S]*?)<\/\1>/gi)) for (const k of m[2].matchAll(/"name"\s*:\s*"([^"]+)"/g)) add(k[1]);
  for (const m of text.matchAll(/"name"\s*:\s*"([^"]+)"\s*,\s*"(?:description|parameters|input_schema)"/g)) add(m[1]);
  for (const m of text.matchAll(/<(?:tool|function)\s+name\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  return out;
};
const REACT = /(?:^|\n)[ \t>*_#]*Action[ \t]*\d*[ \t*_]*:[ \t*_`]*([^\n`*]*?)[ \t*_`]*\n+[ \t>*_#]*Action[ \t]*\d*[ \t_]*Input[ \t*_]*:[ \t*_]*([\s\S]*?)(?=\n[ \t>*_#]*(?:Observation|Thought|Final[ \t]*Answer|Action)\b|\u0000|$)/gi;
const TAG_CALL = /<(tool_call|function_call|tool_use)>([\s\S]*?)<\/\1>/gi;
const FN_TAG = /<function=([\w.-]+)>([\s\S]*?)<\/function>/gi;
const INVOKE = /<invoke\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/gi;
const OBSERVED = /(?:^|\n)[ \t>*_]*Observation[ \t*_]*:[ \t]*([\s\S]*?)(?=\n[ \t>*_#]*(?:Thought|Action|Final[ \t]*Answer)\b|\u0000|$)|<(tool_response|tool_result|function_results?|observation)>([\s\S]*?)<\/\2>/gi;
const paramsOf = (s) => { const o = {}; for (const m of s.matchAll(/<parameter(?:=|\s+name\s*=\s*["'])([\w.-]+)["']?\s*>([\s\S]*?)<\/parameter>/gi)) o[m[1]] = m[2].trim(); return o; };
// Each balanced JSON object in the text, outermost first; its insides are not read again.
const objectsIn = (text) => {
  const out = [];
  for (let i = text.indexOf("{"); i !== -1 && out.length < 20; i = text.indexOf("{", i + 1)) {
    let depth = 0, str = false, esc = false, end = -1;
    for (let j = i; j < text.length && j < i + 20000; j++) {
      const ch = text[j];
      if (str) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') str = false; continue; }
      if (ch === '"') str = true; else if (ch === "{") depth++; else if (ch === "}" && --depth === 0) { end = j; break; }
    }
    const v = end === -1 ? null : parse(text.slice(i, end + 1));
    if (v && typeof v === "object") { out.push({ at: i, v }); i = end; }
  }
  return out;
};
// An Action Input that opens with a JSON object is that object: a model that runs on past it
// ("Observ: ...") does not put its own invention into the arguments.
const leadingJson = (s) => { const t = s.trim(); const o = t[0] === "{" ? objectsIn(t)[0] : null; return o && o.at === 0 ? o.v : t; };
// A tool's schema carries a description; a call does not.
const jsonCall = (v) => {
  const f = v.function && typeof v.function === "object" ? v.function : v;
  if ("description" in f) return null;
  const name = [f.name, v.tool, v.tool_name, v.action, typeof v.function === "string" ? v.function : undefined].find((x) => typeof x === "string");
  return name ? { name, args: [f.arguments, f.args, f.parameters, v.action_input, v.tool_input, v.input, v.args, v.arguments, v.parameters].find((x) => x !== undefined) } : null;
};
const writtenCalls = (text, declared) => {
  const found = [];
  if (!text || !declared.size) return found;
  const s = text.slice(0, 50000);
  const take = (at, name, args) => { const n = String(name || "").trim(); if (declared.has(n)) found.push({ at, name: n, args: typeof args === "string" ? args.trim() : args }); };
  for (const m of s.matchAll(REACT)) take(m.index, m[1], leadingJson(m[2]));
  for (const m of s.matchAll(TAG_CALL)) { const v = parse(m[2].trim()); const c = v && typeof v === "object" && jsonCall(v); if (c) take(m.index, c.name, c.args); }
  for (const m of s.matchAll(FN_TAG)) { const v = parse(m[2].trim()); take(m.index, m[1], v && typeof v === "object" ? v : paramsOf(m[2])); }
  for (const m of s.matchAll(INVOKE)) take(m.index, m[1], paramsOf(m[2]));
  for (const { at, v } of objectsIn(s)) { const c = jsonCall(v); if (c) take(at, c.name, c.args); }
  return found.sort((a, b) => a.at - b.at);
};
// What a tool answered, named by the call written just before it.
const observedIn = (text, declared) => {
  const s = String(text || "").slice(0, 50000);
  const calls = writtenCalls(s, declared);
  const out = [];
  if (calls.length) for (const m of s.matchAll(OBSERVED)) { const call = calls.filter((c) => c.at < m.index).pop(); if (call) out.push({ name: call.name, text: (m[1] ?? m[3]).trim() }); }
  return out;
};
// The model's own words: the text it answered, whole or streamed, in every provider's shape. A
// responses stream sends its words as deltas and then whole again in its closing event: the
// closing copy counts only where no delta came.
const replyText = (events) => {
  let s = "", closing = "", streamed = false;
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    for (const c of list(e.choices)) { if (c.message) s += textOf(c.message.content); if (c.delta && typeof c.delta.content === "string") s += c.delta.content; if (typeof c.text === "string") s += c.text; }
    if (e.type === "response.output_text.delta" && typeof e.delta === "string") { s += e.delta; streamed = true; }
    for (const it of list(e.output)) if (it.type === "message") for (const p of list(it.content)) if (typeof p.text === "string") s += p.text;
    for (const it of list(e.response && e.response.output)) if (it.type === "message") for (const p of list(it.content)) if (typeof p.text === "string") closing += p.text;
    if (e.type === "content_block_delta" && e.delta && typeof e.delta.text === "string") s += e.delta.text;
    if (e.type === "text-delta" && typeof e.delta === "string") s += e.delta;
    for (const b of [...list(e.content), ...list(e.message && e.message.content), ...list(e.output && e.output.message && e.output.message.content)]) if (typeof b.text === "string" && b.type !== "reasoning") s += b.text;
    if (e.message && typeof e.message.content === "string" && !e.choices) s += e.message.content;
    for (const c of list(e.candidates)) for (const p of list(c.content && c.content.parts)) if (typeof p.text === "string" && !p.thought) s += p.text;
    if (typeof e.response === "string") s += e.response;
  }
  return streamed ? s : s + closing;
};
// This turn as the prompt carries it: the model's earlier words after the person's latest
// message, and everything from that message on, where a single-prompt agent keeps its scratchpad.
// A user message right after the model wrote a tool call is the agent loop's nudge ("Analyze the
// tool result"), never the person: after a call, only the loop speaks.
const turnTexts = (body, withPerson, declared) => {
  const from = (items, isPerson) => { const at = items.findLastIndex(isPerson); return items.slice(withPerson ? Math.max(0, at) : at + 1); };
  const ours = (r) => withPerson ? r !== "system" && r !== "developer" : r === "assistant" || r === "model";
  const ms = list(body.messages);
  const person = (m) => personSaid(m) && !(ms[ms.indexOf(m) - 1] && ms[ms.indexOf(m) - 1].role === "assistant" && writtenCalls(textOf(ms[ms.indexOf(m) - 1].content), declared).length);
  return [
    ...from(ms, person).filter((m) => ours(m.role)).map((m) => textOf(m.content)),
    ...from(list(body.input), (x) => x.role === "user").filter((x) => ours(x.role)).map((x) => textOf(x.content ?? x.output)),
    ...from(list(body.contents), personAsked).filter((c) => ours(c.role)).map((c) => textOf(c.parts)),
    ...(withPerson ? [typeof body.prompt === "string" ? body.prompt : "", typeof body.input === "string" ? body.input : ""] : []),
  ].join("\u0000\n");
};

const calledIn = (sent, events, provided = []) => {
  const body = parse(sent);
  const out = [];
  const declared = body && typeof body === "object" ? declaredIn(body) : new Set();
  const written = [...writtenCalls(body && typeof body === "object" ? turnTexts(body, false, declared) : "", declared), ...writtenCalls(replyText(events), declared)].map((c) => ({ name: c.name, arguments: argsText(c.args) }));
  for (const c of [...(body && typeof body === "object" ? calledBefore(body) : []), ...callsOf(events, schemasOf(body)), ...provided, ...written]) {
    if (out.length < CALLS_MAX && !out.some((o) => o.name === c.name && o.arguments === c.arguments)) out.push(c);
  }
  return out.length ? out : undefined;
};

// Tools the model's provider runs for the app (a web search, a file search, a code interpreter, a
// remote MCP server): the calls come back in the model's own reply, and so does what each answered
// where the provider says it. A call it marks failed, or an error it hands back, is the tool failing
// there, in the provider's own words. Answers pair with calls in the order the reply lists them.
const PROVIDER_CALL = /^(web_search|file_search|code_interpreter|image_generation|mcp)_call$/;
const PROVIDER_RESULT = /^\w+_tool_result$/;
const providerIn = (sent, events) => {
  const body = parse(sent);
  const offered = list(body && body.tools).map((t) => t.type).filter((t) => typeof t === "string" && t !== "function" && t !== "custom");
  const named = (kind) => offered.find((t) => t.startsWith(kind)) || kind;
  const calls = new Map(), names = new Map(), answers = [];
  const answer = (name, text) => { const full = textOf(text); const t = full.slice(0, TOOL_TEXT); if (name && t.trim() && answers.length < TOOLS_MAX && !answers.some((a) => a.name === name && a.text === t)) answers.push(toolText(name, full, { provider: true })); };
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    const order = [];
    for (const it of [...list(e.output), ...list(e.item ? [e.item] : []), ...list(e.response && e.response.output)]) {
      const m = PROVIDER_CALL.exec(it.type || "");
      if (m) {
        const name = m[1] === "mcp" ? String(it.name || "mcp") : named(m[1]);
        order.push(name);
        if (it.id) calls.set(it.id, { name: name.slice(0, 80), arguments: argsText(it.action ?? it.arguments ?? {}) });
        if (it.status === "failed" || it.error) answer(name, it.error || `${it.type} ${it.status}`);
      } else if (it.type === "tool_output") answer(order.shift() || (offered.length === 1 ? offered[0] : ""), it.output);
    }
    for (const b of [...list(e.content), ...list(e.message && e.message.content), ...list(e.content_block ? [e.content_block] : [])]) {
      if ((b.type === "server_tool_use" || b.type === "mcp_tool_use") && b.id) { names.set(b.id, b.name); calls.set(b.id, { name: String(b.name).slice(0, 80), arguments: argsText(b.input ?? {}) }); }
      const c = b.content;
      if (PROVIDER_RESULT.test(b.type || "") && (b.is_error === true || (c && !Array.isArray(c) && typeof c === "object" && /_error$/.test(c.type || "")))) answer(names.get(b.tool_use_id) || b.type.replace(/_tool_result$/, ""), c);
    }
  }
  return { calls: [...calls.values()], answers };
};

// What the prompt was handed besides its instructions, of two kinds. What the app retrieved: a
// block it labels as context, documents, knowledge, sources or search results. And its own
// record of the person, passed beside the ask: a profile, a résumé, an account, orders, a JSON
// or key: value block of their data, under any heading or none ("data"). A reply's fact taken
// from either was given, not made up: resumeforge put the saved profile into every prompt, and
// its replies' facts from it were read as invention. In the system prompt or from the person's
// latest message on, and Anthropic document and search_result blocks.
const PASSAGE_TEXT = 3000, PASSAGES_MAX = 6;
const MATERIAL = /\b(?:retriev\w*|context|knowledge|documents?|sources?|search[ _-]?results?|references?|passages?|excerpts?|snippets?|chunks?|background|faq|relevant)\b|检索|知识|参考资料|资料|上下文|文档|背景|相关/i;
const RECORD = /\b(?:profiles?|r[eé]sum[eé]s?|cv|(?<!into )accounts?|orders|purchases|records|(?:user|customer|member|patient|student|client|candidate)[ _]?(?:info\w*|data|details?|facts)|(?:order|purchase|account|medical|payment|employment|transaction|work) history)\b|个人资料|用户资料|个人信息|用户信息|简历|档案|订单|账户|账号|会员/i;
const nameOf = (label) => label.replace(/[#:：[\]=]/g, "").trim().replace(/(?:开始|\s+(?:start|begin))$/i, "").trim();
// A record is named by a label that ends in its word ("User profile", "[已选个人资料开始]"): a
// heading of the instructions that only mentions one ("关于简历通本身与使用平台") is not it.
const RECORD_END = new RegExp(`(?:${RECORD.source})$`, "i");
const isRecord = (label) => RECORD_END.test(nameOf(label));
const isLabel = (label) => MATERIAL.test(label) || isRecord(label);
const kindOf = (label) => (isRecord(label) ? "data" : undefined);
const HEADING = /^\s*(?:#{1,6}\s+[^\n]{1,80}|[^\n]{1,80}[:：]\s*(?:\([^\n)]*\))?|\[[^\n\]]{1,80}\]|={2,}\s*[^\n]{1,80}?\s*={2,})\s*$/;
// An inline label is a noun phrase that ends in the label word ("context:", "background:",
// "user profile:"): "4. Knowledge:" in a numbered instruction and a JSON key are not.
const INLINE = /^\s*(?:[-*]\s+)?([A-Za-z一-鿿][A-Za-z一-鿿 '’_-]{0,29})[:：]\s*\S/;
const NAMED = new RegExp(`(?:${MATERIAL.source}|${RECORD.source})\\s*$`, "i");
const TAGGED = /<([A-Za-z][\w-]*)[^>]*>([\s\S]*?)<\/\1>/g;
// A label's block runs on to the next heading of its own kind: "资料：" over retrieved chunks
// that open on markdown headings holds every chunk, where stopping at its first paragraph kept
// one chunk of five and the reader called the knowledge base's own 1% fee made up. A markdown
// label holds deeper headings. A closing paragraph that opens on a label of its own ("问题：...",
// "Question: ...") is the prompt's ask, not material. A long block is several passages, cut
// between its paragraphs, then its lines.
const MARKDOWN = /^\s*(#{1,6})\s/;
const endsBlock = (label, line) => {
  if (!HEADING.test(line)) return false;
  const outer = MARKDOWN.exec(label), inner = MARKDOWN.exec(line);
  return !inner || Boolean(outer && inner[1].length <= outer[1].length);
};
const asks = (para) => { const m = INLINE.exec(para.split("\n")[0]); return Boolean(m && !NAMED.test(m[1])); };
// A heading inside a fenced block is the material's own text: a README chunk's "## Features".
const FENCE = /^\s*(?:```|~~~)/;
const fences = (para) => para.split("\n").filter((l) => FENCE.test(l)).length;
const pieces = (p) => (p.length <= PASSAGE_TEXT ? [p] : p.split("\n").flatMap((l) => l.match(new RegExp(`[\\s\\S]{1,${PASSAGE_TEXT}}`, "g")) || []));
const addBlock = (add, name, paras, kind) => {
  let text = "";
  for (const para of paras) {
    pieces(para).forEach((p, j) => {
      if (text && text.length + p.length + 2 > PASSAGE_TEXT) { add(name, text, kind); text = ""; }
      text += (text ? (j ? "\n" : "\n\n") : "") + p;
    });
  }
  add(name, text, kind);
};
// The person's data with no label word: a JSON object, or key: value lines (YAML too) under a
// heading. A transcript pasted as "User: ... / Assistant: ..." is the conversation; a tool's
// schema, an agent's Thought/Action scaffold and an answer's shape are instructions.
const KV = /^\s*(?:[-*]\s+)?["']?([\p{L}_][\p{L}\p{N} _.'’()/-]{0,39})["']?\s*[:：]\s*(\S.*)?$/u;
const ROLE = /^(?:user|assistant|human|ai|system|bot|model|agent|customer|用户|助手|客服|顾客|系统)$/i;
const SCAFFOLD = /^(?:tool\b.*|action(?: input)?|thought|observation|final answer|question|answer|input|output)$/i;
const SHAPE = /format|schema|example|output|respon|return|reply|格式|示例|输出|返回/i;
const TOOL_SCHEMA = /"(?:parameters|input_schema|inputSchema)"\s*:/;
// "[已选岗位结束]": the closing marker an app puts after a record is not part of it.
const CLOSER = /^\s*\[[^\]\n]{1,80}\]\s*$/;
const dataIn = (para, before) => {
  const lines = para.split("\n");
  const head = HEADING.test(lines[0]) ? lines[0] : null;
  const body = (head ? lines.slice(1) : lines).filter((l) => l.trim() && !FENCE.test(l));
  if (body.length > 1 && CLOSER.test(body[body.length - 1])) body.pop();
  const name = head || (before && !before.includes("\n") && HEADING.test(before) ? before : "");
  const text = body.join("\n");
  if (SHAPE.test(name)) return null;
  if (/^\s*[{[]/.test(text)) {
    try { const v = JSON.parse(text); return v && typeof v === "object" && Object.keys(v).length && !TOOL_SCHEMA.test(text) ? { name: nameOf(name) || "data", text } : null; } catch { return null; }
  }
  const kv = body.map((l) => KV.exec(l));
  const valued = kv.filter((m) => m && m[2]).map((m) => m[1].trim());
  const shaped = name && body.every((l, i) => kv[i] || /^\s+\S|^\s*-\s/.test(l));
  return shaped && valued.length >= 2 && valued.filter((k) => ROLE.test(k)).length < 2 && !valued.some((k) => SCAFFOLD.test(k)) ? { name: nameOf(name), text } : null;
};
const labelled = (text, add) => {
  const rest = String(text || "").replace(TAGGED, (all, tag, inner) => { const label = tag.replace(/_/g, " "); if (isLabel(label)) { add(tag, inner, kindOf(label)); return ""; } return all; });
  const paras = rest.split(/\n\s*\n/);
  for (let i = 0; i < paras.length; i++) {
    const lines = paras[i].split("\n");
    const head = lines[0];
    if (HEADING.test(head) && isLabel(head)) {
      const block = [lines.slice(1).join("\n")];
      let fenced = fences(block[0]) % 2 === 1;
      while (i + 1 < paras.length && (fenced || (!endsBlock(head, paras[i + 1].split("\n")[0]) && !(i + 2 === paras.length && asks(paras[i + 1]))))) {
        block.push(paras[++i]);
        if (fences(paras[i]) % 2 === 1) fenced = !fenced;
      }
      // A block that opens on a record's own label ("[已选个人资料开始]" under "参考资料：") is that record.
      const inner = block[0].trimStart().split("\n")[0];
      const label = HEADING.test(inner) && isRecord(inner) ? inner : head;
      addBlock(add, nameOf(label), block, kindOf(label));
      continue;
    }
    const inline = lines.map((l) => INLINE.exec(l)).find((m) => m && NAMED.test(m[1]));
    if (inline) { add(inline[1].trim(), paras[i], kindOf(inline[1])); continue; }
    const data = dataIn(paras[i], paras[i - 1]);
    if (data) addBlock(add, data.name, [data.text], "data");
  }
};
const passagesIn = (sent) => {
  const body = parse(sent);
  if (!body || typeof body !== "object") return undefined;
  const out = [];
  const add = (name, text, kind) => { const t = String(text || "").trim().slice(0, PASSAGE_TEXT); if (t.length >= 20 && out.length < PASSAGES_MAX && !out.some((o) => o.text === t)) out.push({ name: String(name || "").slice(0, 80), text: t, ...(kind ? { kind } : {}) }); };
  const scan = (content) => {
    if (typeof content === "string") return labelled(content, add);
    for (const b of list(content)) {
      if (b.type === "document") add(b.title || "document", b.source ? textOf(b.source.data ?? b.source.content) : textOf(b.content));
      else if (b.type === "search_result") add(b.title || b.source || "search result", textOf(b.content));
      else if (typeof b.text === "string") labelled(b.text, add);
    }
  };
  const messages = list(body.messages);
  for (const m of messages) if (m.role === "system" || m.role === "developer") scan(m.content);
  for (const m of messages.slice(Math.max(0, messages.findLastIndex(personSaid)))) if (m.role === "user") scan(m.content);
  scan(body.system);
  scan(body.instructions);
  scan(body.systemInstruction && body.systemInstruction.parts);
  const input = typeof body.input === "string" ? [{ role: "user", content: body.input }] : list(body.input);
  for (const it of input.slice(Math.max(0, input.findLastIndex((x) => x.role === "user")))) if (it.role === "user" || it.role === "system" || it.role === "developer") scan(it.content);
  return out.length ? out : undefined;
};
// The passages a retrieval call answered with: a vector store, a search index or a web search,
// read off its reply when it is JSON. Text fields only, bounded like the rest.
const RETRIEVAL_HOST = /pinecone\.io|qdrant|weaviate|chroma|zilliz|milvus|turbopuffer|upstash\.io|algolia|typesense|meilisearch|elastic|opensearch|vespa|tavily\.com|exa\.ai|serper\.dev|serpapi\.com|search\.brave\.com|bing\.microsoft\.com|jina\.ai/i;
const RETRIEVAL_PATH = /\/(?:query|search|_search|retrieve|similarity_search|rerank|hybrid)(?:\/|$)|\/points\/(?:search|query)|\/rpc\/match\w*/i;
const isRetrieval = (u) => RETRIEVAL_HOST.test(u.hostname) || RETRIEVAL_PATH.test(u.pathname);
// A call to one Qdrant collection, by Qdrant's own REST shape: /collections/{name}[/...]. `write`:
// the call changes the collection. Every PUT, PATCH and DELETE does; a POST does unless it is one
// of Qdrant's reads spelled as a POST (search, query, scroll, recommend, discover, count, facet, a
// retrieve of points by id at /points itself). A path under /collections that names no collection
// (/collections/aliases) is a write of the server, not of one collection: `collection` is null.
// `kind`, on a write: "points" changes what the collection holds (an upsert, a delete, a payload or
// vector change, a batch) and is what a copy stands in for; "create" makes the collection; anything
// else ("schema": a payload index, an alias, a snapshot, a shard, the collection's own settings or
// its deletion) changes the collection's shape and is held, never copied. One customer creates a payload
// index on every one of its 300 collections at its first request, and copying each of them for
// that filled its cluster with copies and its searches with 503s.
const QDRANT_COLLECTION = /^\/collections\/([^/]+)(\/.*)?$/;
const QDRANT_READ_POST = /^\/points(?:\/(?:search|query|recommend|discover)(?:\/(?:batch|groups))?|\/scroll|\/count|\/facet|\/search\/matrix\/(?:pairs|offsets))?$/;
const QDRANT_POINTS = /^\/points(?:\/(?:delete|payload|payload\/delete|payload\/clear|vectors|vectors\/delete|batch))?(?:\?.*)?$/;
const qdrantCall = (u, method) => {
  const m = QDRANT_COLLECTION.exec(u.pathname);
  if (!m) return null;
  const [, name, rest = ""] = m;
  const collection = name === "aliases" ? null : decodeURIComponent(name);
  const verb = String(method || "GET").toUpperCase();
  const write = verb === "PUT" || verb === "PATCH" || verb === "DELETE" || (verb === "POST" && !QDRANT_READ_POST.test(rest));
  const kind = !write ? null : rest === "" && verb === "PUT" ? "create" : QDRANT_POINTS.test(rest) && verb !== "DELETE" ? "points" : "schema";
  return { collection, rest, write, kind };
};
const PASSAGE_KEY = /^(?:text|content|page_?content|pageContent|chunk|snippet|passage|body|document|documents|description|answer|raw_content|highlights?|excerpt)$/i;
const passagesFrom = (raw) => {
  const out = [];
  let nodes = 0;
  const walk = (v, key, depth) => {
    if (out.length >= PASSAGES_MAX || depth > 7 || ++nodes > 4000) return;
    const t = typeof v === "string" ? v.trim().slice(0, PASSAGE_TEXT) : "";
    if (t) { if (PASSAGE_KEY.test(key) && t.length >= 20 && !out.some((o) => o.text === t)) out.push({ name: key, text: t }); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, key, depth + 1); return; }
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
  };
  walk(parse(raw), "", 0);
  return out.length ? out : undefined;
};

// What the app told the model on this call: its system prompt and every block it or its framework
// put among the messages (a reminder, injected context, a prompt template), in prompt order. Never
// the person's words: what a request carried is taken out of the person's side, and a message
// that held only that is not told. Never the model's own words or a tool's answer. A reply is
// read against this, and a block of it the reply repeats is a leak code decides.
const INSTRUCTIONS_MAX = 12000, TOLD_MIN = 12;
// The fields read below, in the shapes they are read in. A body with none of them is a shape
// this hook cannot read: its instructions stay unrecorded, so the run keeps the read's copy of
// the prompt, and "" always means the call really carried none.
const shapeOf = (v) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
const TOLD_FIELDS = { system: /^(?:string|array|object)$/, instructions: /^(?:string|array|object)$/, systemInstruction: /^object$/, messages: /^array$/, input: /^(?:string|array)$/, contents: /^array$/, prompt: /^string$/ };
const instructionsIn = (body, words) => {
  if (!Object.entries(TOLD_FIELDS).some(([k, shape]) => shape.test(shapeOf(body[k])))) return undefined;
  // Longest first, so a short phrase the person repeated never splits a longer message of theirs.
  const said = [...words].sort((a, b) => b.length - a.length);
  const told = [];
  const own = (content) => { const t = textOf(content).trim(); if (t) told.push(t); };
  const added = (text) => {
    let left = text;
    for (const w of said) if (left.includes(w)) left = left.split(w).join(" ");
    if ((left.match(/[\p{L}\p{N}]/gu) || []).length >= TOLD_MIN) told.push(left.trim());
  };
  const texts = (content) => (typeof content === "string" ? [content] : list(content).filter((p) => typeof p.text === "string").map((p) => p.text));
  own(body.system);
  own(body.instructions);
  own(body.systemInstruction && body.systemInstruction.parts);
  for (const m of list(body.messages)) {
    if (m.role === "system" || m.role === "developer") own(m.content);
    else if (m.role === "user" && !HANDED_BACK.test(textOf(m.content))) texts(m.content).forEach(added);
  }
  for (const it of typeof body.input === "string" ? [{ role: "user", content: body.input }] : list(body.input)) {
    if (it.role === "system" || it.role === "developer") own(it.content);
    else if (it.role === "user") texts(it.content).forEach(added);
  }
  for (const c of list(body.contents)) if (c.role !== "model") texts(c.parts).forEach(added);
  if (typeof body.prompt === "string") added(body.prompt);
  return told.join("\n\n").slice(0, INSTRUCTIONS_MAX);
};
// The tools the call offered its model: each by name, a provider's own tool by its type, and the
// declared ones as their schemas say: what each does and the inputs it requires.
const TOOLS_OFFERED = 60, DOES_MAX = 300, INPUTS_MAX = 12;
// `words`: what the person said, taken out of the instructions.
const toldOf = (body, words) => {
  const provider = list(body.tools).filter((t) => !t.name && !t.function && typeof t.type === "string" && !/^(?:function|custom)$/.test(t.type)).map((t) => t.type);
  const offered = [...new Set([...[...declaredIn(body)].sort(), ...provider])].slice(0, TOOLS_OFFERED);
  const declared = [...new Map(toolDefs(body).filter((d) => d.schema).map((d) => [d.name, d])).values()].slice(0, TOOLS_OFFERED).map((d) => ({
    name: d.name.slice(0, 80),
    ...(d.does.trim() ? { does: d.does.trim().slice(0, DOES_MAX) } : {}),
    requires: (Array.isArray(d.schema.required) ? d.schema.required : []).filter((k) => typeof k === "string").slice(0, INPUTS_MAX),
  }));
  const instructions = instructionsIn(body, words);
  return { ...(instructions !== undefined ? { instructions } : {}), ...(offered.length ? { offered } : {}), ...(declared.length ? { declared } : {}) };
};
// Where models are served, by host, and the paths every OpenAI-shaped or vendor endpoint ends with.
const MODEL_HOST = /(?:^|\.)(?:openai\.com|anthropic\.com|fireworks\.ai|openrouter\.ai|groq\.com|mistral\.ai|together\.xyz|together\.ai|deepseek\.com|cohere\.ai|cohere\.com|perplexity\.ai|x\.ai|googleapis\.com|openai\.azure\.com|cognitiveservices\.azure\.com|amazonaws\.com|replicate\.com|huggingface\.co|cerebras\.ai|deepinfra\.com|novita\.ai|moonshot\.cn|dashscope\.aliyuncs\.com|bigmodel\.cn|ai-gateway\.vercel\.sh|gateway\.ai\.cloudflare\.com|helicone\.ai|portkey\.ai)$/i;
const MODEL_PATH = /\/(?:chat\/completions|completions|responses|messages|embeddings|language-model|embedding-model)$|:(?:generateContent|streamGenerateContent)|\/invoke(?:-with-response-stream)?$|\/api\/(?:chat|generate)$/i;
// An embedding call answers nobody, so where it was made names no path a reply came down.
const EMBEDDING = /\/(?:embeddings|embedding-model)$/i;
// The OpenAI shape's own paths name a model call wherever they are served: a gateway whose base URL
// has no /v1 (LiteLLM, a self-hosted proxy) is called at plain /chat/completions, and Ask A
// Question's five model calls a request went unseen. /messages and /responses stay behind a
// version or /api/, since other services name routes that way.
const OPENAI_PATH = /\/(?:chat\/completions|completions|embeddings)$/i;
// /messages and /responses name a model call only as the two APIs spell them. Mailgun's
// /v3/<domain>/messages, WhatsApp's /v19.0/<id>/messages and Discord's /api/v10/channels/<id>/messages
// end the same way and send a real message: each passed as a model call and was never held in a run
// (the release review of 2026-10-05). Vonage sends at the very path Anthropic answers on, so the
// senders that share it are named.
const NAMED_PATH = /\/(?:messages|responses)$/i;
const AS_SPELLED = /\/v1\/(?:messages|responses)$/i;
const MESSAGING_HOST = /(?:^|\.)(?:nexmo\.com|vonage\.com|telnyx\.com|twilio\.com|mailgun\.net|sinch\.com|messagebird\.com|bird\.com)$/i;
const isModelCall = (host, path) => {
  const h = String(host || "").replace(/:\d+$/, "");
  const p = String(path || "").split("?")[0];
  if (/googleapis\.com$/i.test(h)) return /generativelanguage|aiplatform/i.test(h) && MODEL_PATH.test(p);
  if (/amazonaws\.com$/i.test(h)) return /^bedrock/i.test(h);
  if (MODEL_HOST.test(h) || OPENAI_PATH.test(p)) return true;
  if (NAMED_PATH.test(p)) return AS_SPELLED.test(p) && !MESSAGING_HOST.test(h);
  return MODEL_PATH.test(p) && /\/v\d|\/api\//.test(p);
};

const cookieNames = (v) => [].concat(v || []).map((c) => String(c).split(";")[0].split("=")[0].trim()).filter(Boolean).slice(0, 20);
const bodyOf = (ctx) => (ctx.bodyText ?? Buffer.concat(ctx.chunks).toString("utf8")).slice(0, MAX);

// The meter. One row per model call: host, model id, status, and the provider's own token counts.
const zlib = require("node:zlib");
const REPLY_MAX = 8 * 1024 * 1024;
const decoded = (buf, encoding) => {
  try {
    const e = String(encoding || "").toLowerCase();
    return (e === "gzip" ? zlib.gunzipSync(buf) : e === "br" ? zlib.brotliDecompressSync(buf) : e === "deflate" ? zlib.inflateSync(buf) : buf).toString("utf8");
  } catch { return ""; }
};
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
// A model request is kept whole when it fits. A longer one keeps its shape and every value short
// enough to be a turn, its longest texts cut in their middle: every provider puts the newest turn
// last, and cutting the body's end kept one customer's 25,000-token prompt without the person's words.
// ponytail: a turn longer than the cap that fits is cut too; keep turns whole if one is ever lost.
const fitted = (text) => {
  if (text.length <= MAX) return text;
  const body = parse(text);
  for (let cap = MAX / 2; body && typeof body === "object" && cap >= 256; cap /= 2) {
    const out = JSON.stringify(body, (_, v) => (typeof v === "string" && v.length > cap ? `${v.slice(0, cap / 2)} [...] ${v.slice(-cap / 2)}` : v));
    if (out.length <= MAX) return out;
  }
  return text.slice(0, MAX);
};
const n = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
// The shapes the providers answer in. promptTokens is the whole input, cache included, so totals add up.
const tokensOf = (u) => {
  if (!u || typeof u !== "object") return null;
  if (u.tokens && typeof u.tokens === "object") return tokensOf(u.tokens);
  if ("prompt_tokens" in u) return { promptTokens: n(u.prompt_tokens), cachedTokens: n(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens), completionTokens: n(u.completion_tokens) };
  if ("input_tokens" in u && u.input_tokens_details) return { promptTokens: n(u.input_tokens), cachedTokens: n(u.input_tokens_details.cached_tokens), completionTokens: n(u.output_tokens) };
  if ("input_tokens" in u) { const read = n(u.cache_read_input_tokens); return { promptTokens: n(u.input_tokens) + read + n(u.cache_creation_input_tokens), cachedTokens: read, completionTokens: n(u.output_tokens) }; }
  // The AI SDK's own counts, as a gateway answers them: by kind in its newer protocol, flat before it.
  if (u.inputTokens && typeof u.inputTokens === "object") return { promptTokens: n(u.inputTokens.total), cachedTokens: n(u.inputTokens.cacheRead), completionTokens: n(u.outputTokens && u.outputTokens.total) };
  if ("inputTokens" in u && "cachedInputTokens" in u) return { promptTokens: n(u.inputTokens), cachedTokens: n(u.cachedInputTokens), completionTokens: n(u.outputTokens) };
  if ("inputTokens" in u) { const read = n(u.cacheReadInputTokens); return { promptTokens: n(u.inputTokens) + read + n(u.cacheWriteInputTokens), cachedTokens: read, completionTokens: n(u.outputTokens) }; }
  if ("promptTokenCount" in u) return { promptTokens: n(u.promptTokenCount), cachedTokens: n(u.cachedContentTokenCount), completionTokens: n(u.candidatesTokenCount) };
  return null;
};
// The model stopped because it reached the output cap its request set, in each provider's words: its
// answer is cut short or, for a reasoning model, may never have been written.
const stoppedAtLimit = (e) => {
  const r = e.response || e;
  return (Array.isArray(e.choices) && e.choices.some((c) => c && c.finish_reason === "length"))
    || (r.status === "incomplete" && Boolean(r.incomplete_details) && r.incomplete_details.reason === "max_output_tokens")
    || e.stop_reason === "max_tokens" || Boolean(e.delta && e.delta.stop_reason === "max_tokens") || e.stopReason === "max_tokens"
    || (Array.isArray(e.candidates) && e.candidates.some((c) => c && c.finishReason === "MAX_TOKENS"))
    || (e.type === "finish" && (e.finishReason === "length" || Boolean(e.finishReason && e.finishReason.unified === "length")));
};
const reasoningOf = (u) => n((u.output_tokens_details && u.output_tokens_details.reasoning_tokens) || (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || u.thoughtsTokenCount || (u.outputTokens && u.outputTokens.reasoning));
// An answered reply the provider sent no counts for (Anthropic's OpenAI compatible stream sends
// none) is counted from its text at four characters a token, the request whole as it was sent,
// and marked estimated: a run cap and a price that counted nothing let any spend through.
const CHARS_PER_TOKEN = 4;
const estimateOf = (sent, events, status) => (status >= 200 && status < 400
  ? { promptTokens: Math.ceil(String(sent || "").length / CHARS_PER_TOKEN), cachedTokens: 0, completionTokens: Math.ceil(replyText(events).length / CHARS_PER_TOKEN), estimated: true }
  : { promptTokens: 0, cachedTokens: 0, completionTokens: 0 });
// The output cap the app's request set, in each provider's field.
const capOf = (b) => (b && typeof b === "object" ? n(b.max_tokens) || n(b.max_completion_tokens) || n(b.max_output_tokens) || n(b.maxOutputTokens) || n(b.generationConfig && b.generationConfig.maxOutputTokens) || n(b.inferenceConfig && b.inferenceConfig.maxTokens) || null : null);
// A stream spreads its counts over events (Anthropic's input in the first, output in the last);
// later values win, so the fold ends on the final figures.
const readReply = (type, text) => {
  const events = /event-stream/i.test(type || "")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => parse(l.slice(5).trim()))
    : [].concat(parse(text));
  const usage = {};
  let model = null;
  let limit = false;
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    const part = e.usage || (e.message && e.message.usage) || (e.response && e.response.usage) || e.usageMetadata;
    if (part && typeof part === "object") Object.assign(usage, part);
    model = e.model || (e.message && e.message.model) || (e.response && e.response.model) || e.modelVersion || (e.type === "response-metadata" && e.modelId) || model;
    limit = limit || stoppedAtLimit(e);
  }
  return { tokens: tokensOf(Object.keys(usage).length ? usage : null), model, events, limit, reasoning: reasoningOf(usage) };
};
// The model that answered, when a gateway or proxy answered with another than the one asked for
// (a dated version of the same model is the same model).
const answeredBy = (asked, got) => (got && asked && !String(got).includes(asked) && !String(asked).includes(got) ? { answered: String(got).slice(0, 160) } : {});
// The model asked for, from what was sent; Gemini and Bedrock put it in the path instead.
const askedFor = (path, sent) => {
  const body = parse(sent);
  if (body && typeof body.model === "string") return body.model;
  const m = /\/models\/([^/:]+):|\/model\/([^/]+)\/(?:invoke|converse)/.exec(path || "");
  return m ? decodeURIComponent(m[1] || m[2]) : "";
};

// The AI SDK speaks its own format to a gateway (Vercel's AI Gateway): the model's id rides in a
// header, the conversation is a list under `prompt`, and tool calls and their results are typed
// parts. It is read as the chat format every reader here already knows; any other body is left as
// sent. One customer's calls went unpriced and unread: no model, no counts, no words.
const GATEWAY_MODEL = ["ai-language-model-id", "ai-model-id"];
const resultText = (o) => (o && typeof o === "object" && "value" in o ? (typeof o.value === "string" ? o.value : JSON.stringify(o.value)) : textOf(o));
const asChat = (sent, model) => {
  const body = parse(sent);
  if (!body || typeof body !== "object" || Array.isArray(body)) return sent;
  const named = model && typeof body.model !== "string" ? { model: String(model).slice(0, 160) } : {};
  const turns = Array.isArray(body.prompt) && body.prompt.length && body.prompt.every((m) => m && typeof m === "object" && typeof m.role === "string") ? body.prompt : null;
  if (!turns) return Object.keys(named).length ? JSON.stringify({ ...body, ...named }) : sent;
  const messages = [];
  for (const m of turns) {
    const parts = list(m.content);
    if (m.role === "tool") { for (const p of parts) if (p.type === "tool-result") messages.push({ role: "tool", tool_call_id: p.toolCallId, name: p.toolName, content: resultText(p.output) }); continue; }
    const calls = m.role === "assistant" ? parts.filter((p) => p.type === "tool-call").map((p) => ({ id: p.toolCallId, type: "function", function: { name: p.toolName, arguments: typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? {}) } })) : [];
    const text = typeof m.content === "string" ? m.content : parts.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
    messages.push({ role: m.role, content: text, ...(calls.length ? { tool_calls: calls } : {}) });
  }
  const { prompt: _turns, ...rest } = body;
  return JSON.stringify({ ...rest, ...named, messages });
};

// The exchanges and model calls of one process, written as rows by `row`. `onTurn`: a request the
// run tagged has arrived. `onEnded(ctx, steps)`: a request has been answered, before its row is written.
function makeRecorder({ row, rulesFile, onTurn = () => {}, onEnded = () => {} }) {
  // The customer's own rule sentences, written beside the trace by the run, so each model call can
  // say which of them its prompt carried: a rule is then asked only of a reply whose call was told
  // it. Absent file, nothing is claimed either way. Reloaded when the file changes.
  const RULES = rulesFile;
  let rules = null, rulesAt = -1;
  const rulesNow = () => {
    if (!RULES) return null;
    try {
      const at = fs.statSync(RULES).mtimeMs;
      if (at !== rulesAt) {
        rulesAt = at;
        const list = JSON.parse(fs.readFileSync(RULES, "utf8"));
        rules = Array.isArray(list)
          ? list.filter((r) => r && typeof r.id === "string" && typeof r.text === "string").map((r) => ({ id: r.id, parts: partsOf(r.text) })).filter((r) => r.parts.length)
          : [];
      }
    } catch { /* not written yet, or gone */ }
    return rules;
  };
  const rulesIn = (sent) => {
    const list = rulesNow();
    // An empty list claims nothing either way: "carried none" needs rules to carry.
    if (!list || !list.length) return undefined;
    const body = norm(sent);
    return list.filter((r) => r.parts.every((p) => body.includes(p))).map((r) => r.id);
  };

  // What the person said to the app: every text value requests carried in their bodies and
  // addresses, long enough to tell apart, the newest kept. A model call's prompt is told apart from
  // them whichever side keeps the conversation. Kept by value, not by request: with trials side by
  // side a trial's opening message sat up to 282 requests back, and a window of the last 32 would
  // have told it as the app's own words on 114 of 132 later turns.
  // Bounded by characters as well as count: a raw body is one value, and 2000 of them at 64 KB would
  // hold about 128 MB inside the app.
  const HEARD_KEPT = 2000, HEARD_CHARS = 2_000_000, HEARD_MAX = 200, SAID_ASCII = 8, SAID_OTHER = 4;
  const heard = new Set();
  let heardChars = 0;
  const heardIn = (ctx) => {
    const out = new Set();
    const add = (s) => {
      const t = typeof s === "string" ? s.trim() : "";
      if (out.size < HEARD_MAX && t.length >= (/[^\x00-\x7F]/.test(t) ? SAID_OTHER : SAID_ASCII) && /\p{L}/u.test(t)) out.add(t);
    };
    const walk = (v, depth) => { if (typeof v === "string") add(v); else if (v && typeof v === "object" && depth < 12) for (const x of Object.values(v)) walk(x, depth + 1); };
    const raw = bodyOf(ctx);
    const json = parse(raw);
    if (json && typeof json === "object") walk(json, 0);
    else if (/^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(raw)) for (const v of new URLSearchParams(raw).values()) add(v);
    else add(raw);
    for (const v of new URLSearchParams(ctx.path.split("?")[1] || "").values()) add(v);
    return out;
  };
  const hear = (ctx) => {
    try {
      for (const w of heardIn(ctx)) {
        if (heard.delete(w)) heardChars -= w.length;
        heard.add(w);
        heardChars += w.length;
      }
      for (const w of heard) {
        if (heard.size <= HEARD_KEPT && heardChars <= HEARD_CHARS) break;
        heard.delete(w);
        heardChars -= w.length;
      }
    } catch { /* nothing heard */ }
  };
  // An exchange is kept when the request makes its first model call, for the first few requests
  // per route, and written once the app has answered. Model calls and tool rows carry the request's
  // id whether kept or not; the command joins them to the exchange it has.
  // The person's requests, ours (a run's turns, a knock) and the canary's each have their own count,
  // so a run that knocked first never takes the places of the requests that prove a door. Every one
  // of the person's is kept: their newest is the sign-in and the proof a run takes, and the command
  // keeps only the newest few per door.
  // ponytail: the trace file grows by one row per request of the person's; a cap per route if a person's own load test fills it.
  const EXCHANGES_PER_ROUTE = 4, CANARY_PER_ROUTE = 30, ROUTES_KEPT = 1000, SENT_MAX = 4, MODEL_WORDS = 4000, SAID_KEPT = 12;
  const slotOf = (turn) => (!turn ? { cls: "", max: Infinity } : /^canary:/.test(turn) ? { cls: "canary ", max: CANARY_PER_ROUTE } : { cls: "ours ", max: EXCHANGES_PER_ROUTE });
  const perRoute = new Map();
  // One route whatever id its path carries: a conversation in the path is a new path every trial.
  const routeKey = (method, path) => `${method} ${path.split("?")[0].split("/").map((s) => (/^\d+$/.test(s) || (s.length >= 8 && /\d/.test(s)) ? "{id}" : s)).join("/")}`;
  let lastExchange = 0;
  const { makeTied, sentencesIn } = require("./tied.cjs");
  const tied = makeTied({ norm, bodyOf, replyOf: (ctx) => (ctx.reply ? ctx.reply.text.slice(0, MAX) : ""), saidOf: (ctx) => (ctx.late ? ctx.saidAll || [] : undefined) });
  const requestCtx = (method, path, headers, turn) => {
    if (turn) onTurn();
    const ctx = { id: `${process.pid}.${++lastExchange}`, at: Date.now(), method, path, headers, chunks: [], size: 0, noted: false, kept: false, sent: [], turn, sites: [], traced: 0 };
    tied.opened(ctx);
    return ctx;
  };
  // The request a model call is pinned to, returned so the call's row carries it: the one it was
  // made inside, else the request that asked for it (lib/tied.cjs), else `alone`, the one request
  // open when a caller outside the app sees that much and no more.
  const note = (ctx, sent, alone) => {
    tied.sent(sent || "");
    if (!ctx) { try { ctx = tied.pinned(String(sent || "")) ?? (alone && tied.inside(alone, String(sent || ""))); } catch { ctx = undefined; } }
    else { try { ctx = tied.inside(ctx, String(sent || "")); } catch { /* its own, as before */ } }
    if (!ctx) return ctx;
    if (!ctx.noted) {
      ctx.noted = true;
      const { cls, max } = slotOf(ctx.turn);
      const key = cls + routeKey(ctx.method, ctx.path);
      const n = perRoute.get(key) || 0;
      if (n < max && (n || perRoute.size < ROUTES_KEPT)) { perRoute.set(key, n + 1); ctx.kept = true; }
    }
    if (ctx.kept && ctx.sent.length < SENT_MAX) ctx.sent.push(fitted(String(sent || "")));
    return ctx;
  };
  const rowOf = (ctx) => {
    const { reply } = ctx;
    return { at: ctx.at, ms: ctx.ended - ctx.at, method: ctx.method, path: ctx.path, body: bodyOf(ctx), status: reply.status, type: String(reply.type || ""), ...(reply.writes ? { writes: reply.writes } : {}), reply: reply.text.slice(0, MAX), ...(reply.cookies.length ? { cookies: reply.cookies } : {}), ...(reply.cut ? { cut: true } : {}) };
  };
  // An answer that came on a second request is written as that request's row under the id of the
  // request that asked, with the requests of its turn in `after` (the one that asked last) and the
  // headers they were sent with: one line, so a reader never sees half a turn.
  const answered = (ctx, steps = []) => {
    const asker = steps.at(-1) || ctx;
    if (!asker.kept || asker.written) return;
    asker.written = true;
    const turn = ctx.turn || asker.turn;
    row({ ex: asker.id, ...rowOf(ctx), headers: Object.assign({}, ...steps.map((s) => s.headers), ctx.headers), ...(turn ? { turn } : {}), sent: asker.sent, ...(steps.length ? { after: steps.map(rowOf) } : {}) });
  };
  // A request answered later by its model is written once its calls have gone quiet, marked
  // `later`, in the time its model took to answer it; a run's turn also gets the model's last words,
  // the answer the command hands the run (lib/replay.mjs). Only an answer settles it: a call that
  // came back 2xx with no words (a model asking for a tool) is a step, and the next call is waited
  // for, as long as the run waits.
  // ponytail: a fixed settle; after a step that answers in words, more than this of the app's own
  // work before the next call cuts the answer at that step. A call whose words match only a request
  // already settled is the evidence: a settle measured per door when one is seen.
  const SETTLE_MS = 5000;
  // The turn's answer is written once the calls are quiet even while a read the hook took for a fetch
  // of it is open (the person's page polling the sender): the answer is the model's words either way.
  // The exchange is written as answered later only when no fetch came to complete it (tied.settled).
  const answeredLater = (ctx) => {
    const said = ctx.said;
    if (ctx.turn && !ctx.turnAnswered) { ctx.turnAnswered = true; row({ answer: { ex: ctx.id, turn: ctx.turn, status: said.status, reply: said.words } }); }
    if (tied.settled(ctx) && ctx.kept) row({ ex: ctx.id, ...rowOf(ctx), ms: said.at - ctx.at, later: true, headers: ctx.headers, ...(ctx.turn ? { turn: ctx.turn } : {}), sent: ctx.sent });
  };
  const settle = (ctx) => {
    clearTimeout(ctx.settling);
    const said = ctx.said;
    if (!said || (!said.words && said.status >= 200 && said.status < 300)) return;
    ctx.settling = setTimeout(() => { try { if (!ctx.callsOpen && !ctx.waiting) answeredLater(ctx); } catch { /* the app goes on */ } }, SETTLE_MS);
    if (ctx.settling.unref) ctx.settling.unref();
  };
  // Once the app has answered and a streamed body has been read whole.
  const ended = (ctx, reply) => {
    if (ctx.ended) return;
    ctx.ended = Date.now();
    ctx.reply = reply;
    const done = () => {
      hear(ctx);
      const steps = tied.closed(ctx);
      onEnded(ctx, steps);
      if (steps) answered(ctx, steps);
      else if (ctx.late) settle(ctx);
      else if (!ctx.callsOpen) answered(ctx);
      // A message taken and answered at once with no model call inside it: its model may answer later,
      // in a process this hook is not in. The command names the endpoint (lib/replay.mjs receipts).
      if (!ctx.noted && !steps && ctx.method !== "GET" && reply.status >= 200 && reply.status < 300 && sentencesIn(bodyOf(ctx)).length) {
        row({ receipt: { ex: ctx.id, at: ctx.at, ms: ctx.ended - ctx.at, method: ctx.method, path: ctx.path, status: reply.status, ...(ctx.turn ? { turn: ctx.turn } : {}) } });
      }
    };
    if (ctx.body) ctx.body.then(done);
    else done();
  };
  const meter = ({ host, path, sent, status, type, body, ctx, t0, caller }) => {
    try {
      const reply = readReply(type, String(body || "").slice(0, REPLY_MAX));
      const rules = rulesIn(sent);
      const provided = providerIn(sent, reply.events);
      const answered = [...(toolsIn(sent) || []), ...provided.answers];
      const tools = answered.length ? answered : undefined;
      const called = calledIn(sent, reply.events, provided.calls);
      const passages = passagesIn(sent);
      const turn = ctx && ctx.turn;
      const asked = parse(sent);
      const told = asked && typeof asked === "object" && !EMBEDDING.test(path) ? toldOf(asked, ctx ? new Set([...heard, ...heardIn(ctx)]) : heard) : {};
      tied.done(ctx);
      if (ctx && ctx.late) {
        if (!EMBEDDING.test(path)) {
          ctx.said = { status, words: replyText(reply.events).slice(0, MODEL_WORDS), at: Date.now() };
          ctx.saidAll = [...(ctx.saidAll || []), ctx.said.words].slice(-SAID_KEPT);
        }
        settle(ctx);
      }
      row({ call: { at: Date.now(), ms: Date.now() - t0, host: String(host).replace(/:443$/, ""), model: String(askedFor(path, sent) || reply.model || "").slice(0, 160), ...answeredBy(askedFor(path, sent), reply.model), status, ...(reply.tokens || estimateOf(sent, reply.events, status)), usage: Boolean(reply.tokens), ...(EMBEDDING.test(path) ? { embedding: true } : {}), ...(ctx ? { ex: ctx.id } : {}), ...(ctx && (ctx.kept || ctx.turn) ? { reply: replyText(reply.events).slice(0, MODEL_WORDS) } : {}), ...(turn ? { turn } : {}), ...(rules ? { rules } : {}), ...(tools ? { tools } : {}), ...(called ? { called } : {}), ...(passages ? { passages } : {}), ...(caller ? { caller } : {}), ...(reply.limit ? { limit: { cap: capOf(asked), reasoning: reply.reasoning } } : {}), ...told } });
    } catch { /* the command is gone */ }
  };
  return { tied, requestCtx, note, ended, meter };
}

module.exports = {
  MAX, REPLY_MAX, EMBEDDING, TOOL_TEXT, MODEL_HOST,
  scrubbed, list, clipped, argsText, turnOf, toolText, isModelCall, isRetrieval, qdrantCall, passagesFrom, decoded, cookieNames,
  fitted, makeRecorder, asChat, GATEWAY_MODEL,
};
