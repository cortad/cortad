"use strict";
const fs = require("node:fs");
const { messageText } = require("./message-text.cjs");

const SECRET_TEXT = [
  /((?:pass(?:word|phrase|wd)|pwd|密码|口令)["']?\s*(?:is\b|was\b|[:=：]|是|为)\s*["']?)([^\s"'\\,;}，。；、]+)/gi,
  /((?:secret(?:[ _-]?key)?|api[ _-]?key|apikey|access[ _-]?key|private[ _-]?key|client[ _-]?secret|(?:auth|access|refresh)[ _-]?token|token)["']?\s*[:=：]\s*["']?)([^\s"'\\,;}，。；、]+)/gi,
];
const SECRET_WORD = /\b(?:Bearer\s+(?=[\w.~+/=-]*\d)[\w.~+/=-]{16,}|[spr]k[-_](?=[\w-]*\d)[\w-]{8,}|gh[po]_\w{16,}|github_pat_\w{16,}|xox[abpr]-[\w-]{8,}|AKIA[0-9A-Z]{12,}|AIza[\w-]{20,}|eyJ[\w-]{10,}\.[\w-]{4,}\.[\w-]*)/g;
const maskText = (s) => SECRET_TEXT.reduce((t, re) => t.replace(re, "$1[secret]"), s).replace(SECRET_WORD, "[secret]");
const scrub = (v, depth = 0) => (typeof v === "string" ? maskText(v)
  : Array.isArray(v) ? v.map((x) => scrub(x, depth + 1))
    : v && typeof v === "object" && depth < 12 ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "headers" && depth === 0 ? x : scrub(x, depth + 1)])) : v);

const bodyScrubbed = (text) => { try { const b = JSON.parse(text); return b && typeof b === "object" ? JSON.stringify(scrub(b)) : maskText(text); } catch { return maskText(text); } };

const replyScrubbed = (text) => {
  try { const b = JSON.parse(text); if (b && typeof b === "object") return JSON.stringify(scrub(b)); } catch {  }
  return text.split("\n").map((line) => { const m = /^(data:\s?)?([{[].*)$/.exec(line); return m ? (m[1] || "") + bodyScrubbed(m[2]) : maskText(line); }).join("\n");
};

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

const TURN = /^[A-Za-z0-9:_.-]{1,80}$/;
const turnOf = (headers) => {
  const t = headers && (typeof headers.get === "function" ? headers.get("x-cortad-turn") : headers["x-cortad-turn"]);
  return typeof t === "string" && TURN.test(t) ? t : undefined;
};
const norm = (s) => String(s || "")
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\[nrt]/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  .toLowerCase().replace(/\s+/g, " ").trim();

const partsOf = (text) => text.split(/\{[^}]*\}|\$\{[^}]*\}|%[sd]|<[^>]{1,40}>/).map(norm).filter((p) => p.length >= 12);

const TOOL_TEXT = 12000, TOOLS_MAX = 12;
const toolText = (name, full, extra = {}) => ({ name: String(name || "").slice(0, 80), text: full.slice(0, TOOL_TEXT), ...extra, ...(full.length > TOOL_TEXT ? { cut: true } : {}) });
const textOf = messageText;

const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
const since = (items, isPerson) => { let at = -1; items.forEach((m, i) => { if (isPerson(m)) at = i; }); return items.slice(at + 1); };

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

const refusedBy = (schema, raw) => {
  let args = raw === undefined || raw === null ? {} : raw;
  if (typeof args === "string") { if (!args.trim()) args = {}; else { try { args = JSON.parse(args); } catch { return "the arguments are not valid JSON"; } } }
  if (!args || typeof args !== "object" || Array.isArray(args)) return "the arguments are not a JSON object";
  const missing = (Array.isArray(schema.required) ? schema.required : []).find((k) => typeof k === "string" && !Object.prototype.hasOwnProperty.call(args, k));
  return missing ? `the required input "${missing}" is missing` : null;
};

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

const calledBefore = (body) => callsOf([
  ...since(list(body.messages), personSaid).filter((m) => m.role === "assistant").map((m) => ({ choices: [{ message: m }], content: m.content })),
  { output: since(list(body.input), (x) => x.role === "user") },
  ...since(list(body.contents), personAsked).filter((c) => c.role === "model").map((c) => ({ candidates: [{ content: c }] })),
]);

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

const leadingJson = (s) => { const t = s.trim(); const o = t[0] === "{" ? objectsIn(t)[0] : null; return o && o.at === 0 ? o.v : t; };

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

const observedIn = (text, declared) => {
  const s = String(text || "").slice(0, 50000);
  const calls = writtenCalls(s, declared);
  const out = [];
  if (calls.length) for (const m of s.matchAll(OBSERVED)) { const call = calls.filter((c) => c.at < m.index).pop(); if (call) out.push({ name: call.name, text: (m[1] ?? m[3]).trim() }); }
  return out;
};

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

const PASSAGE_TEXT = 3000, PASSAGES_MAX = 6;
const MATERIAL = /\b(?:retriev\w*|context|knowledge|documents?|sources?|search[ _-]?results?|references?|passages?|excerpts?|snippets?|chunks?|background|faq|relevant)\b|检索|知识|参考资料|资料|上下文|文档|背景|相关/i;
const RECORD = /\b(?:profiles?|r[eé]sum[eé]s?|cv|(?<!into )accounts?|orders|purchases|records|(?:user|customer|member|patient|student|client|candidate)[ _]?(?:info\w*|data|details?|facts)|(?:order|purchase|account|medical|payment|employment|transaction|work) history)\b|个人资料|用户资料|个人信息|用户信息|简历|档案|订单|账户|账号|会员/i;
const nameOf = (label) => label.replace(/[#:：[\]=]/g, "").trim().replace(/(?:开始|\s+(?:start|begin))$/i, "").trim();

const RECORD_END = new RegExp(`(?:${RECORD.source})$`, "i");
const isRecord = (label) => RECORD_END.test(nameOf(label));
const isLabel = (label) => MATERIAL.test(label) || isRecord(label);
const kindOf = (label) => (isRecord(label) ? "data" : undefined);
const HEADING = /^\s*(?:#{1,6}\s+[^\n]{1,80}|[^\n]{1,80}[:：]\s*(?:\([^\n)]*\))?|\[[^\n\]]{1,80}\]|={2,}\s*[^\n]{1,80}?\s*={2,})\s*$/;

const INLINE = /^\s*(?:[-*]\s+)?([A-Za-z一-鿿][A-Za-z一-鿿 '’_-]{0,29})[:：]\s*\S/;
const NAMED = new RegExp(`(?:${MATERIAL.source}|${RECORD.source})\\s*$`, "i");
const TAGGED = /<([A-Za-z][\w-]*)[^>]*>([\s\S]*?)<\/\1>/g;

const MARKDOWN = /^\s*(#{1,6})\s/;
const endsBlock = (label, line) => {
  if (!HEADING.test(line)) return false;
  const outer = MARKDOWN.exec(label), inner = MARKDOWN.exec(line);
  return !inner || Boolean(outer && inner[1].length <= outer[1].length);
};
const asks = (para) => { const m = INLINE.exec(para.split("\n")[0]); return Boolean(m && !NAMED.test(m[1])); };

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

const KV = /^\s*(?:[-*]\s+)?["']?([\p{L}_][\p{L}\p{N} _.'’()/-]{0,39})["']?\s*[:：]\s*(\S.*)?$/u;
const ROLE = /^(?:user|assistant|human|ai|system|bot|model|agent|customer|用户|助手|客服|顾客|系统)$/i;
const SCAFFOLD = /^(?:tool\b.*|action(?: input)?|thought|observation|final answer|question|answer|input|output)$/i;
const SHAPE = /format|schema|example|output|respon|return|reply|格式|示例|输出|返回/i;
const TOOL_SCHEMA = /"(?:parameters|input_schema|inputSchema)"\s*:/;

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

const RETRIEVAL_HOST = /pinecone\.io|qdrant|weaviate|chroma|zilliz|milvus|turbopuffer|upstash\.io|algolia|typesense|meilisearch|elastic|opensearch|vespa|tavily\.com|exa\.ai|serper\.dev|serpapi\.com|search\.brave\.com|bing\.microsoft\.com|jina\.ai/i;
const RETRIEVAL_PATH = /\/(?:query|search|_search|retrieve|similarity_search|rerank|hybrid)(?:\/|$)|\/points\/(?:search|query)|\/rpc\/match\w*/i;
const isRetrieval = (u) => RETRIEVAL_HOST.test(u.hostname) || RETRIEVAL_PATH.test(u.pathname);

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

const INSTRUCTIONS_MAX = 12000, TOLD_MIN = 12;

const shapeOf = (v) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
const TOLD_FIELDS = { system: /^(?:string|array|object)$/, instructions: /^(?:string|array|object)$/, systemInstruction: /^object$/, messages: /^array$/, input: /^(?:string|array)$/, contents: /^array$/, prompt: /^string$/ };
const instructionsIn = (body, words) => {
  if (!Object.entries(TOLD_FIELDS).some(([k, shape]) => shape.test(shapeOf(body[k])))) return undefined;

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

const TOOLS_OFFERED = 60, DOES_MAX = 300, INPUTS_MAX = 12;

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

const MODEL_HOST = /(?:^|\.)(?:openai\.com|anthropic\.com|fireworks\.ai|openrouter\.ai|groq\.com|mistral\.ai|together\.xyz|together\.ai|deepseek\.com|cohere\.ai|cohere\.com|perplexity\.ai|x\.ai|googleapis\.com|openai\.azure\.com|cognitiveservices\.azure\.com|amazonaws\.com|replicate\.com|huggingface\.co|cerebras\.ai|deepinfra\.com|novita\.ai|moonshot\.cn|dashscope\.aliyuncs\.com|bigmodel\.cn|ai-gateway\.vercel\.sh|gateway\.ai\.cloudflare\.com|helicone\.ai|portkey\.ai)$/i;
const MODEL_PATH = /\/(?:chat\/completions|completions|responses|messages|embeddings|language-model|embedding-model)$|:(?:generateContent|streamGenerateContent)|\/invoke(?:-with-response-stream)?$|\/api\/(?:chat|generate)$/i;

const EMBEDDING = /\/(?:embeddings|embedding-model)$/i;

const OPENAI_PATH = /\/(?:chat\/completions|completions|embeddings)$/i;

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

const zlib = require("node:zlib");
const REPLY_MAX = 8 * 1024 * 1024;
const decoded = (buf, encoding) => {
  try {
    const e = String(encoding || "").toLowerCase();
    return (e === "gzip" ? zlib.gunzipSync(buf) : e === "br" ? zlib.brotliDecompressSync(buf) : e === "deflate" ? zlib.inflateSync(buf) : buf).toString("utf8");
  } catch { return ""; }
};
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

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

const tokensOf = (u) => {
  if (!u || typeof u !== "object") return null;
  if (u.tokens && typeof u.tokens === "object") return tokensOf(u.tokens);
  if ("prompt_tokens" in u) return { promptTokens: n(u.prompt_tokens), cachedTokens: n(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens), completionTokens: n(u.completion_tokens) };
  if ("input_tokens" in u && u.input_tokens_details) return { promptTokens: n(u.input_tokens), cachedTokens: n(u.input_tokens_details.cached_tokens), completionTokens: n(u.output_tokens) };
  if ("input_tokens" in u) { const read = n(u.cache_read_input_tokens); return { promptTokens: n(u.input_tokens) + read + n(u.cache_creation_input_tokens), cachedTokens: read, completionTokens: n(u.output_tokens) }; }

  if (u.inputTokens && typeof u.inputTokens === "object") return { promptTokens: n(u.inputTokens.total), cachedTokens: n(u.inputTokens.cacheRead), completionTokens: n(u.outputTokens && u.outputTokens.total) };
  if ("inputTokens" in u && "cachedInputTokens" in u) return { promptTokens: n(u.inputTokens), cachedTokens: n(u.cachedInputTokens), completionTokens: n(u.outputTokens) };
  if ("inputTokens" in u) { const read = n(u.cacheReadInputTokens); return { promptTokens: n(u.inputTokens) + read + n(u.cacheWriteInputTokens), cachedTokens: read, completionTokens: n(u.outputTokens) }; }
  if ("promptTokenCount" in u) return { promptTokens: n(u.promptTokenCount), cachedTokens: n(u.cachedContentTokenCount), completionTokens: n(u.candidatesTokenCount) };
  return null;
};

const stoppedAtLimit = (e) => {
  const r = e.response || e;
  return (Array.isArray(e.choices) && e.choices.some((c) => c && c.finish_reason === "length"))
    || (r.status === "incomplete" && Boolean(r.incomplete_details) && r.incomplete_details.reason === "max_output_tokens")
    || e.stop_reason === "max_tokens" || Boolean(e.delta && e.delta.stop_reason === "max_tokens") || e.stopReason === "max_tokens"
    || (Array.isArray(e.candidates) && e.candidates.some((c) => c && c.finishReason === "MAX_TOKENS"))
    || (e.type === "finish" && (e.finishReason === "length" || Boolean(e.finishReason && e.finishReason.unified === "length")));
};
const reasoningOf = (u) => n((u.output_tokens_details && u.output_tokens_details.reasoning_tokens) || (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || u.thoughtsTokenCount || (u.outputTokens && u.outputTokens.reasoning));

const CHARS_PER_TOKEN = 4;
const estimateOf = (sent, events, status) => (status >= 200 && status < 400
  ? { promptTokens: Math.ceil(String(sent || "").length / CHARS_PER_TOKEN), cachedTokens: 0, completionTokens: Math.ceil(replyText(events).length / CHARS_PER_TOKEN), estimated: true }
  : { promptTokens: 0, cachedTokens: 0, completionTokens: 0 });

const capOf = (b) => (b && typeof b === "object" ? n(b.max_tokens) || n(b.max_completion_tokens) || n(b.max_output_tokens) || n(b.maxOutputTokens) || n(b.generationConfig && b.generationConfig.maxOutputTokens) || n(b.inferenceConfig && b.inferenceConfig.maxTokens) || null : null);

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

const answeredBy = (asked, got) => (got && asked && !String(got).includes(asked) && !String(asked).includes(got) ? { answered: String(got).slice(0, 160) } : {});

const askedFor = (path, sent) => {
  const body = parse(sent);
  if (body && typeof body.model === "string") return body.model;
  const m = /\/models\/([^/:]+):|\/model\/([^/]+)\/(?:invoke|converse)/.exec(path || "");
  return m ? decodeURIComponent(m[1] || m[2]) : "";
};

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

function makeRecorder({ row, rulesFile, onTurn = () => {}, onEnded = () => {} }) {

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
    } catch {  }
    return rules;
  };
  const rulesIn = (sent) => {
    const list = rulesNow();

    if (!list || !list.length) return undefined;
    const body = norm(sent);
    return list.filter((r) => r.parts.every((p) => body.includes(p))).map((r) => r.id);
  };

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
    } catch {  }
  };

  const EXCHANGES_PER_ROUTE = 4, CANARY_PER_ROUTE = 30, ROUTES_KEPT = 1000, SENT_MAX = 4, MODEL_WORDS = 4000, SAID_KEPT = 12;
  const slotOf = (turn) => (!turn ? { cls: "", max: Infinity } : /^canary:/.test(turn) ? { cls: "canary ", max: CANARY_PER_ROUTE } : { cls: "ours ", max: EXCHANGES_PER_ROUTE });
  const perRoute = new Map();

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

  const note = (ctx, sent, alone) => {
    tied.sent(sent || "");
    if (!ctx) { try { ctx = tied.pinned(String(sent || "")) ?? (alone && tied.inside(alone, String(sent || ""))); } catch { ctx = undefined; } }
    else { try { ctx = tied.inside(ctx, String(sent || "")); } catch {  } }
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

  const answered = (ctx, steps = []) => {
    const asker = steps.at(-1) || ctx;
    if (!asker.kept || asker.written) return;
    asker.written = true;
    const turn = ctx.turn || asker.turn;
    row({ ex: asker.id, ...rowOf(ctx), headers: Object.assign({}, ...steps.map((s) => s.headers), ctx.headers), ...(turn ? { turn } : {}), sent: asker.sent, ...(steps.length ? { after: steps.map(rowOf) } : {}) });
  };

  const SETTLE_MS = 5000;

  const answeredLater = (ctx) => {
    const said = ctx.said;
    if (ctx.turn && !ctx.turnAnswered) { ctx.turnAnswered = true; row({ answer: { ex: ctx.id, turn: ctx.turn, status: said.status, reply: said.words } }); }
    if (tied.settled(ctx) && ctx.kept) row({ ex: ctx.id, ...rowOf(ctx), ms: said.at - ctx.at, later: true, headers: ctx.headers, ...(ctx.turn ? { turn: ctx.turn } : {}), sent: ctx.sent });
  };
  const settle = (ctx) => {
    clearTimeout(ctx.settling);
    const said = ctx.said;
    if (!said || (!said.words && said.status >= 200 && said.status < 300)) return;
    ctx.settling = setTimeout(() => { try { if (!ctx.callsOpen && !ctx.waiting) answeredLater(ctx); } catch {  } }, SETTLE_MS);
    if (ctx.settling.unref) ctx.settling.unref();
  };

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
    } catch {  }
  };
  return { tied, requestCtx, note, ended, meter };
}

module.exports = {
  MAX, REPLY_MAX, EMBEDDING, TOOL_TEXT, MODEL_HOST,
  scrubbed, list, clipped, argsText, turnOf, toolText, isModelCall, isRetrieval, qdrantCall, passagesFrom, decoded, cookieNames,
  fitted, makeRecorder, asChat, GATEWAY_MODEL,
};
