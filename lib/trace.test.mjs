import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeCapture } from "./replay.mjs";

const readRows = (file) => { try { return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

// A small app under the hook: one route calls a model (a host that does not resolve; the hook notes
// the call as it is made, not when it answers), one route does not.
const APP = `
const http = require("node:http");
http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    if (req.url === "/api/talk") await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: JSON.parse(body).text }] }) }).catch(() => {});
    res.end(JSON.stringify({ ok: true, got: body.length }));
  });
}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
`;

test("the request during which the app called a model is written down, with its body, sign-in and what the app answered; others are not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), APP);
  const child = spawn(process.execPath, ["--require", new URL("./trace.cjs", import.meta.url).pathname, join(dir, "app.cjs")], { env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer their-session" }, body: JSON.stringify(body) }).then((r) => r.json());
  assert.equal((await post("/api/save", { title: "not a chat" })).ok, true);
  const answered = await post("/api/talk", { text: "hello from me", thread: 7 });
  assert.equal(answered.got, JSON.stringify({ text: "hello from me", thread: 7 }).length, "the app still read its own body whole");
  await new Promise((r) => setTimeout(r, 300));
  child.kill();
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].hello, "node", "the hook says it is there");
  const rows = lines.filter((l) => !l.hello && !l.call && !l.listen && !l.routes && !l.conn && !l.receipt);
  assert.equal(rows.length, 1);
  assert.equal(`${rows[0].method} ${rows[0].path}`, "POST /api/talk");
  assert.deepEqual(JSON.parse(rows[0].body), { text: "hello from me", thread: 7 });
  assert.equal(rows[0].headers.authorization, "Bearer their-session");
  assert.match(rows[0].sent[0], /hello from me/);
  assert.deepEqual([rows[0].status, JSON.parse(rows[0].reply)], [200, { ok: true, got: answered.got }]);
  assert.ok(lines.some((l) => l.listen === port), "the port it serves is said, so watching means this app");
});

// One customer's API is Elysia on Bun: Bun.serve, never node:http, and its models behind Vercel's gateway.
// Under the command the hook arrives through BUN_OPTIONS, which must also leave `bun run` working.
const BUN = spawnSync("bun", ["--version"]).status === 0 ? "bun" : null;
const BUN_APP = `
export default {
  port: 0,
  async fetch(req) {
    const body = await req.text();
    if (new URL(req.url).pathname === "/v1/agent/chat") await fetch("https://ai-gateway.vercel.sh/v1/ai/language-model", { method: "POST", body: JSON.stringify({ prompt: JSON.parse(body).messages }) }).catch(() => {});
    return Response.json({ got: body.length });
  },
};
`;
test("Bun: the request that called a model through a gateway is written down, and the port it serves", { skip: !BUN }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-bun-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.ts"), BUN_APP);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", scripts: { dev: "bun app.ts" } }));
  const capture = makeCapture({ work: dir, keepSecret: () => {} });
  // Its own process group: `bun run` starts the app as a child, and killing only the runner leaves it serving.
  const child = spawn(BUN, ["run", "dev"], { cwd: dir, env: { ...process.env, ...capture.env(process.env) }, stdio: "ignore", detached: true });
  try {
    const port = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("the app never listened")), 8000);
      const look = setInterval(() => {
        const listen = readRows(file).find((l) => l.listen);
        if (listen) { clearInterval(look); clearTimeout(deadline); resolve(listen.listen); }
      }, 100);
    });
    const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: "better-auth.session_token=theirs" }, body: JSON.stringify(body) }).then((r) => r.json());
    await post("/v1/flags", { key: "not a chat" });
    const chat = { messages: [{ role: "user", parts: [{ type: "text", text: "visitors this week?" }] }], websiteId: "w1" };
    assert.equal((await post("/v1/agent/chat", chat)).got, JSON.stringify(chat).length, "the app still read its own body whole");
    await new Promise((r) => setTimeout(r, 300));
    const rows = readRows(file).filter((l) => !l.hello && !l.call && !l.listen && !l.routes && !l.conn && !l.receipt);
    assert.equal(rows.length, 1);
    assert.equal(`${rows[0].method} ${rows[0].path}`, "POST /v1/agent/chat");
    assert.deepEqual(JSON.parse(rows[0].body), chat);
    assert.deepEqual([rows[0].status, JSON.parse(rows[0].reply)], [200, { got: JSON.stringify(chat).length }], "what the app answered, read from a copy of its Response");
    assert.equal(rows[0].headers.cookie, "better-auth.session_token=theirs");
    assert.equal(capture.watching(port), true);
    assert.equal(capture.watching(port + 1), false, "a hooked process on another port is not this app");
  } finally { process.kill(-child.pid, "SIGKILL"); }
});

// A provider on this machine answering the three ways real ones do: JSON with its counts, a stream
// with none, and gzip over plain http.request.
const METERED = `
const http = require("node:http");
const zlib = require("node:zlib");
const provider = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const { model, stream } = JSON.parse(body);
    if (stream) { res.writeHead(200, { "content-type": "text/event-stream" }); res.end('data: {"model":"' + model + '","choices":[{"delta":{"content":"hi"}}]}\\n\\ndata: [DONE]\\n\\n'); return; }
    const out = JSON.stringify({ model, choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 11, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } });
    if (req.headers["accept-encoding"] === "gzip") { res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" }); res.end(zlib.gzipSync(out)); return; }
    res.writeHead(200, { "content-type": "application/json" }); res.end(out);
  });
}).listen(0, "127.0.0.1", async function () {
  const url = "http://127.0.0.1:" + this.address().port + "/v1/chat/completions";
  const post = (body) => fetch(url, { method: "POST", body: JSON.stringify(body) }).then((r) => r.text());
  await post({ model: "their-json-model" });
  await post({ model: "their-stream-model", stream: true });
  await new Promise((done) => {
    const req = http.request(url, { method: "POST", headers: { "accept-encoding": "gzip" } }, (res) => { res.on("data", () => {}); res.on("end", done); });
    req.end(JSON.stringify({ model: "their-gzip-model" }));
  });
  setTimeout(() => { provider.close(); console.log("DONE"); }, 200);
});
`;

test("every model call the app makes is metered: its model, status and the provider's own counts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meter-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), METERED);
  const child = spawn(process.execPath, ["--require", new URL("./trace.cjs", import.meta.url).pathname, join(dir, "app.cjs")], { env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve) => child.stdout.on("data", (d) => { if (/DONE/.test(String(d))) resolve(); }));
  child.kill();
  const calls = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.call).map((l) => l.call);
  const by = Object.fromEntries(calls.map((c) => [c.model, c]));
  assert.equal(calls.length, 3);
  assert.deepEqual([by["their-json-model"].promptTokens, by["their-json-model"].cachedTokens, by["their-json-model"].completionTokens, by["their-json-model"].usage], [11, 4, 3, true]);
  assert.equal(by["their-stream-model"].usage, false, "a stream with no counts is still a call, marked as unread");
  assert.equal(by["their-stream-model"].status, 200);
  assert.deepEqual([by["their-gzip-model"].promptTokens, by["their-gzip-model"].usage], [11, true], "gzip over http.request is read");
  assert.ok(calls.every((c) => /^127\.0\.0\.1:\d+$/.test(c.host)));
  assert.ok(!readFileSync(file, "utf8").includes('"content":"hi"'), "no reply text is written down");
});

// One customer calls its models through Vercel's AI Gateway with the AI SDK, which speaks its own format
// there: the model's id in a header, the conversation under "prompt", counts nested by kind. Every
// call was written with no model, no counts and no words, so a run had no price and no spend.
const GATEWAY = `
const http = require("node:http");
const sse = (parts) => parts.map((p) => "data: " + JSON.stringify(p) + "\\n\\n").join("") + "data: [DONE]\\n\\n";
const usage = { inputTokens: { total: 2350, noCache: 2100, cacheRead: 250, cacheWrite: 0 }, outputTokens: { total: 35, text: 30, reasoning: 5 } };
const gateway = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (req.headers["ai-language-model-streaming"] !== "true") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ content: [{ type: "reasoning", text: "they want a title" }, { type: "text", text: "Visitors this week" }], finishReason: { unified: "stop", raw: "stop" }, usage })); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse([{ type: "stream-start", warnings: [] }, { type: "response-metadata", modelId: "gemini-2.5-flash-lite" }, { type: "tool-call", toolCallId: "t1", toolName: "get_data", input: JSON.stringify({ preset: "last_7d" }) }, { type: "text-start", id: "0" }, { type: "text-delta", id: "0", delta: "412 visitors " }, { type: "text-delta", id: "0", delta: "this week." }, { type: "text-end", id: "0" }, { type: "finish", finishReason: { unified: "stop", raw: "STOP" }, usage }]));
  });
}).listen(0, "127.0.0.1", function () {
  const url = "http://127.0.0.1:" + this.address().port + "/v3/ai/language-model";
  const tools = [{ type: "function", name: "get_data", description: "Reads the site's analytics.", inputSchema: { type: "object", properties: { preset: { type: "string" } } } }];
  const ask = (model, streaming, prompt) => fetch(url, { method: "POST", headers: { "content-type": "application/json", "ai-language-model-specification-version": "3", "ai-language-model-id": model, "ai-language-model-streaming": String(streaming) }, body: JSON.stringify({ prompt, tools }) }).then((r) => r.text());
  http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      const { text } = JSON.parse(body);
      await ask("openai/gpt-oss-120b", false, [{ role: "user", content: [{ type: "text", text: "Write a title for: " + text }] }]);
      await ask("google/gemini-2.5-flash-lite", true, [
        { role: "system", content: "You are the analytics assistant. Never invent a number." },
        { role: "user", content: [{ type: "text", text }] },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "t0", toolName: "get_data", input: { preset: "last_14d" } }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "t0", toolName: "get_data", output: { type: "json", value: { visitors: 380 } } }] },
      ]);
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ reply: "412 visitors this week." }));
    });
  }).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
});
`;

test("a call the AI SDK makes to a gateway in its own format is read like any other: its model, counts, words, tools and what it was told", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gateway-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), GATEWAY);
  const child = spawn(process.execPath, ["--require", new URL("./trace.cjs", import.meta.url).pathname, join(dir, "app.cjs")], { env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  await fetch(`http://127.0.0.1:${port}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "how many visitors came this week" }) }).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 300));
  child.kill();
  const lines = readRows(file);
  const by = Object.fromEntries(lines.filter((l) => l.call).map((l) => [l.call.model, l.call]));
  const chat = by["google/gemini-2.5-flash-lite"], title = by["openai/gpt-oss-120b"];
  assert.ok(chat && title, `the model named in the header names the call: ${Object.keys(by).join(", ")}`);
  assert.deepEqual([chat.promptTokens, chat.cachedTokens, chat.completionTokens, chat.usage], [2350, 250, 35, true]);
  assert.equal(chat.answered, undefined, "the gateway naming the same model without its maker is no other model");
  assert.equal(chat.reply, "412 visitors this week.");
  assert.equal(title.reply, "Visitors this week", "never the model's reasoning");
  assert.deepEqual(chat.called.map((c) => [c.name, JSON.parse(c.arguments)]), [["get_data", { preset: "last_14d" }], ["get_data", { preset: "last_7d" }]]);
  assert.deepEqual(chat.tools.map((t) => [t.name, t.text]), [["get_data", '{"visitors":380}']]);
  assert.match(chat.instructions, /Never invent a number/);
  assert.deepEqual(chat.offered, ["get_data"]);
  const ex = lines.find((l) => l.path === "/chat");
  assert.ok(ex && ex.sent.some((s) => /how many visitors came this week/.test(s)), "the request is tied to the calls by the person's words");
});

// resumeforge's provider class spent three of the lines kept on its own stream, post and retry, and
// the line that says which path ran was past them. Five are kept, nearest first, then the rest drop.
const NESTED = `
const http = require("node:http");
const provider = http.createServer((req, res) => { req.resume(); req.on("end", () => res.end("{}")); }).listen(0, "127.0.0.1", async () => {
  const base = "http://127.0.0.1:" + provider.address().port;
  const post = () => fetch(base + "/v1/chat/completions", { method: "POST", body: "{}" });
  const retry = () => post();
  const stream = () => retry();
  const generate = () => stream();
  const route = () => generate();
  const handler = () => route();
  await handler();
  console.log("DONE");
});
`;
test("a model call keeps the five lines of the app nearest it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nested-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), NESTED);
  const child = spawn(process.execPath, ["--require", new URL("./trace.cjs", import.meta.url).pathname, join(dir, "app.cjs")], { cwd: dir, env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve) => child.stdout.on("data", (d) => { if (/DONE/.test(String(d))) resolve(); }));
  await new Promise((r) => setTimeout(r, 200));
  child.kill();
  const call = readRows(file).find((l) => l.call)?.call;
  const lines = NESTED.split("\n");
  const lineOf = (text) => `app.cjs:${lines.findIndex((l) => l.includes(text)) + 1}`;
  assert.deepEqual(call?.caller, ["const post = ", "const retry = ", "const stream = ", "const generate = ", "const route = "].map(lineOf));
});

// The run tags each message with a turn and writes the customer's rule sentences beside the trace;
// the hook pins every model call to its turn and says which of those sentences the prompt carried,
// through JSON escapes and non-ASCII text, and the tag never reaches the door row it replays from.
test("a model call carries its turn and the rule ids its prompt held", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-"));
  const file = join(dir, "trace.jsonl");
  const rulesFile = join(dir, "rules.json");
  writeFileSync(rulesFile, JSON.stringify([
    { id: "rule:aaaaaaaaaa", text: "Never invent an order number.\nAsk for the phone's last four digits." },
    { id: "rule:bbbbbbbbbb", text: "始终只使用手机号后四位定位用户" },
    { id: "rule:cccccccccc", text: "Answer in {language} and nothing else, ever." },
    { id: "rule:dddddddddd", text: "This sentence is not in any prompt." },
  ]));
  writeFileSync(join(dir, "app.cjs"), `
const http = require("node:http");
http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    const system = "Rules:\\nNever invent an order number.\\n  Ask for the phone's last four digits.\\n始终只使用手机号后四位定位用户\\nAnswer in Arabic and nothing else, ever.";
    await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-x", messages: [{ role: "system", content: system }, { role: "user", content: JSON.parse(body).text }] }) }).catch(() => {});
    res.end(JSON.stringify({ ok: true }));
  });
}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
`);
  const child = spawn(process.execPath, ["--require", new URL("./trace.cjs", import.meta.url).pathname, join(dir, "app.cjs")], { env: { ...process.env, CORTAD_TRACE_FILE: file, CORTAD_RULES_FILE: rulesFile }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  await fetch(`http://127.0.0.1:${port}/api/talk`, { method: "POST", headers: { "content-type": "application/json", "x-cortad-turn": "case_9:2" }, body: JSON.stringify({ text: "hi" }) }).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 400));
  child.kill();
  const lines = readRows(file);
  const call = lines.find((l) => l.call)?.call;
  assert.equal(call?.turn, "case_9:2");
  assert.deepEqual(call?.rules, ["rule:aaaaaaaaaa", "rule:bbbbbbbbbb", "rule:cccccccccc"]);
  const door = lines.find((l) => l.path === "/api/talk");
  assert.equal(door?.headers["x-cortad-turn"], undefined, "the tag is ours, never replayed as theirs");
});

// A tool's answer rides on the next model call as a tool message; the hook hands it over as the
// material the reply's facts rest on, named by the call that produced it.
test("what the app's tools answered is read off the next prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), `
const http = require("node:http");
http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", async () => {
    const messages = [
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup_ticket", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "{\\"ticket\\":\\"TK5063AB3D63\\",\\"status\\":\\"open\\"}" },
    ];
    await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-x", messages }) }).catch(() => {});
    res.end("{}");
  });
}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
`);
  const child = spawn(process.execPath, ["--require", new URL("./trace.cjs", import.meta.url).pathname, join(dir, "app.cjs")], { env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  await fetch(`http://127.0.0.1:${port}/api/talk`, { method: "POST", body: "{}" });
  await new Promise((r) => setTimeout(r, 400));
  child.kill();
  const call = readRows(file).find((l) => l.call)?.call;
  assert.deepEqual(call?.tools, [{ name: "lookup_ticket", text: '{"ticket":"TK5063AB3D63","status":"open"}' }]);
});

// What a later call's prompt adds within one turn is not tool evidence: an observation no call
// named is left out, as is the person's own message and a second chain's system prompt.
test("within one turn, prompt text a later call adds is never read as a tool's answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), `
const http = require("node:http");
http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", async () => {
    const system = { role: "system", content: "You are a shop assistant." };
    const user = { role: "user", content: "Where is order YQ1?" };
    await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-x", messages: [system, user] }) }).catch(() => {});
    await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-x", messages: [system, user, { role: "assistant", content: "Thought: look it up" }, { role: "user", content: "Observation: {\\"order\\":\\"YQ1\\",\\"status\\":\\"shipped\\"}" }] }) }).catch(() => {});
    res.end("{}");
  });
}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
`);
  const child = spawn(process.execPath, ["--require", new URL("./trace.cjs", import.meta.url).pathname, join(dir, "app.cjs")], { env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  await fetch(`http://127.0.0.1:${port}/api/talk`, { method: "POST", headers: { "x-cortad-turn": "case_1:1" }, body: "{}" });
  await new Promise((r) => setTimeout(r, 500));
  child.kill();
  const calls = readRows(file).filter((l) => l.call).map((l) => l.call);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.tools), [undefined, undefined]);
});

// An app whose own code picks the tool from a classifier's answer: the fixture's shop, in Node. The
// run's list names the tool by file and function; the hook wraps it as the file loads.
const DISPATCH_APP = (fx, kind) => `
const http = require("node:http");
const load = ${kind === "cjs" ? `async () => require("./${fx.module}.cjs")` : `() => import("./${fx.module}.mjs")`};
load().then(({ query_order }) => {
const styles = [${JSON.stringify(fx.classify)}, ${JSON.stringify(fx.answer)}];
const provider = http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => { const s = styles.find((x) => x.path === req.url); res.writeHead(200, { "content-type": s.type }); res.end(s.reply); });
}).listen(0, "127.0.0.1", () => {
  const base = "http://127.0.0.1:" + provider.address().port;
  const ask = (s) => fetch(base + s.path, { method: "POST", body: JSON.stringify(s.sent) }).then((r) => r.json());
  http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      const { message } = JSON.parse(body);
      const intent = JSON.parse((await ask(styles[0])).choices[0].message.content).intent;
      if (intent === "order") query_order(message);
      await ask(styles[1]);
      res.end("{}");
    });
  }).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
});
});
`;
// The same tools written the two ways a Node app keeps them: declarations exported through
// module.exports, and ES module consts that importers bind to.
const SHOP_TOOLS = (fx, kind) => (kind === "cjs" ? `
function query_order(message) { return ${JSON.stringify(fx.returns)}; }
function search_faq(question) { return "never asked"; }
const REFUND_POLICY = "seven days";
module.exports = { query_order, search_faq, REFUND_POLICY };
` : `
export const query_order = (message) => ${JSON.stringify(fx.returns)};
export async function search_faq(question) { return "never asked"; }
export const REFUND_POLICY = "seven days";
`);
const dispatched = async (listFirst, kind) => {
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8")).dispatched;
  const dir = mkdtempSync(join(tmpdir(), "dispatch-"));
  writeFileSync(join(dir, "app.cjs"), DISPATCH_APP(fx, kind));
  writeFileSync(join(dir, `${fx.module}.${kind}`), SHOP_TOOLS(fx, kind));
  const list = JSON.stringify(fx.tools.map((t) => ({ ...t, file: t.file === "app" ? "app.cjs" : `${fx.module}.${kind}` })));
  const capture = makeCapture({ work: dir, keepSecret: () => {} });
  if (listFirst) writeFileSync(join(dir, "tools.json"), list);
  const child = spawn(process.execPath, [join(dir, "app.cjs")], { cwd: dir, env: { ...process.env, ...capture.env(process.env) }, stdio: ["ignore", "pipe", "pipe"] });
  let said = "";
  child.stderr.on("data", (d) => { said += d; });
  try {
    const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
    if (!listFirst) writeFileSync(join(dir, "tools.json"), list);
    for (const turn of ["case_4:1", "case_4:2"]) await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "x-cortad-turn": turn }, body: JSON.stringify({ message: fx.message }) });
    await new Promise((r) => setTimeout(r, 400));
  } finally { child.kill(); }
  return { fx, capture, said, text: readFileSync(join(dir, "trace.jsonl"), "utf8"), rows: readRows(join(dir, "trace.jsonl")) };
};
for (const kind of ["cjs", "mjs"]) test(`${kind}: a tool the app's own code runs is recorded with its arguments and what it returned; a password never is`, async () => {
  const { fx, capture, said, text, rows } = await dispatched(true, kind);
  const ran = rows.filter((l) => l.dep && l.dep.host === "in-app").map((l) => l.dep);
  assert.deepEqual(ran.map((d) => [d.turn, d.called, d.tools]), [["case_4:1", fx.called, fx.toolRows], ["case_4:2", fx.called, fx.toolRows]], "one row per call, on its turn; search_faq was never called");
  const calls = rows.filter((l) => l.call).map((l) => l.call);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c.tools === undefined), "the second chain's prompt and the person's message are not a tool's answer");
  assert.ok(rows.every((l) => ![...(l.call?.tools ?? []), ...(l.dep?.tools ?? [])].some((t) => !t.name)), "nothing in tools has an empty name");
  assert.ok(!text.includes("hunter2"), "the password the person typed is in no row");
  assert.equal(said.split(fx.unwatched.replace("%s", kind)).length - 1, 1, "a named tool that is not a function is said once in the app's log");
  // The command hands the rows on to the run in the shape a model call's row has (its meter is one
  // per process, so this test's rows are the newest two).
  assert.deepEqual(capture.usage().deps.filter((d) => d.host === "in-app").slice(0, 2).map((d) => [d.turn, d.called, d.tools]), [["case_4:2", fx.called, fx.toolRows], ["case_4:1", fx.called, fx.toolRows]]);
  const start = { wrapped: ["query_order", "search_faq"], unwatched: ["query_order (router)", "refund_policy"] };
  assert.deepEqual(rows.filter((l) => l.tools).map((l) => l.tools), [start], "one row for this start: the tools wrapped, and those that could not be");
  assert.deepEqual(capture.tools(), start);
});

// A tool not wrapped was said to have never run (2026-11-02). The reason said is the one the hook
// found, and nothing is promised of a later start.
for (const kind of ["cjs", "mjs"]) test(`${kind}: a list that arrives after a Node app loaded its tools is said once in its log, and no tool is said to be wrapped`, async () => {
  const { fx, said, rows } = await dispatched(false, kind);
  assert.equal(rows.filter((l) => l.dep && l.dep.host === "in-app").length, 0, "a function the app took before the list arrived cannot be reached");
  assert.equal(said.split(`cortad: calls to query_order in ${fx.module}.${kind} are not recorded: the file was loaded before Cortad's list of tools named it.`).length - 1, 1);
  assert.doesNotMatch(said, /next start/);
  assert.deepEqual(rows.filter((l) => l.tools).map((l) => l.tools), [{ wrapped: [], unwatched: ["query_order", "query_order (router)", "refund_policy", "search_faq"] }]);
});

// A module a loader put in place without Node compiling it (a bundler's own registry) never passed
// the hook: that is what is said, not that the list came late.
test("a tool's file a loader made without Node compiling it is said so, with the list there from the start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unseen-"));
  writeFileSync(join(dir, "app.cjs"), `
const Module = require("node:module");
const file = require("node:path").join(__dirname, "tools.cjs");
const m = new Module(file, module);
Object.assign(m, { filename: file, loaded: true, exports: { makeCards: (topic) => [topic] } });
require.cache[file] = m;
require("node:http").createServer((req, res) => { req.on("data", () => {}); req.on("end", () => res.end("{}")); }).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
`);
  writeFileSync(join(dir, "tools.json"), JSON.stringify([{ name: "make_cards", file: "tools.cjs", function: "makeCards" }]));
  const capture = makeCapture({ work: dir, keepSecret: () => {} });
  const child = spawn(process.execPath, [join(dir, "app.cjs")], { cwd: dir, env: { ...process.env, ...capture.env(process.env) }, stdio: ["ignore", "pipe", "pipe"] });
  let said = "";
  child.stderr.on("data", (d) => { said += d; });
  try {
    const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
    await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", body: "{}" });
    await new Promise((r) => setTimeout(r, 300));
  } finally { child.kill(); }
  assert.equal(said, "cortad: calls to make_cards in tools.cjs are not recorded: the file was loaded by a loader this hook cannot add to.\n");
  assert.deepEqual(capture.tools(), { wrapped: [], unwatched: ["make_cards"] });
});

// tsx, ts-node and babel read a TypeScript file themselves and hand Node the JavaScript they made of
// it, past any load hook: the run's list was there before the file loaded, no call to a tool was
// recorded, and the app's log said the list had come late. tsx's JavaScript is the file's code inside
// a function, its exports read through getters and a const declared mid-line (tsx 4.21, as compiled);
// the TypeScript compiler's is plain exports.
const ESBUILD_TOOLS = `"use strict";var __defProp=Object.defineProperty;var __getOwnPropDesc=Object.getOwnPropertyDescriptor;var __getOwnPropNames=Object.getOwnPropertyNames;var __hasOwnProp=Object.prototype.hasOwnProperty;var __export=(target,all)=>{for(var name in all)__defProp(target,name,{get:all[name],enumerable:true})};var __copyProps=(to,from,except,desc)=>{if(from&&typeof from==="object"||typeof from==="function"){for(let key of __getOwnPropNames(from))if(!__hasOwnProp.call(to,key)&&key!==except)__defProp(to,key,{get:()=>from[key],enumerable:!(desc=__getOwnPropDesc(from,key))||desc.enumerable})}return to};var __toCommonJS=mod=>__copyProps(__defProp({},"__esModule",{value:true}),mod);var tools_exports={};__export(tools_exports,{generateCards:()=>generateCards,searchPages:()=>searchPages});module.exports=__toCommonJS(tools_exports);async function generateCards(kind,content){return{type:kind,data:[{front:content,back:"a force"}]}}const searchPages=async query=>["page about "+query];`;
const TSC_TOOLS = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchPages = void 0;
exports.generateCards = generateCards;
async function generateCards(kind, content) { return { type: kind, data: [{ front: content, back: "a force" }] }; }
const searchPages = async (query) => ["page about " + query];
exports.searchPages = searchPages;
`;
const LOADERS = {
  tsx: { code: ESBUILD_TOOLS, compiled: "(code, file) => `__filename=${JSON.stringify(file)};(()=>{\\n${code}\\n})()\\n\\n//# sourceMappingURL=data:application/json;base64,e30=\\n`" },
  "ts-node": { code: TSC_TOOLS, compiled: "(code) => code" },
};
const LOADED_APP = (compiled) => `
const http = require("node:http");
const fs = require("node:fs");
const compiled = ${compiled};
require.extensions[".ts"] = (m, file) => m._compile(compiled(fs.readFileSync(file, "utf8"), file), file);
const tools = require("./tools.ts");
http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", async () => res.end(JSON.stringify(await tools.generateCards("flashcards", "Newton's laws"))));
}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
`;
for (const [loader, { code, compiled }] of Object.entries(LOADERS)) test(`${loader}: a tool in a file a transpiler loads is recorded, and the start says it is wrapped`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "loaded-"));
  writeFileSync(join(dir, "app.cjs"), LOADED_APP(compiled));
  writeFileSync(join(dir, "tools.ts"), code);
  writeFileSync(join(dir, "tools.json"), JSON.stringify([{ name: "generate_cards", file: "tools.ts", function: "generateCards" }, { name: "search_pages", file: "tools.ts", function: "searchPages" }]));
  const capture = makeCapture({ work: dir, keepSecret: () => {} });
  const child = spawn(process.execPath, [join(dir, "app.cjs")], { cwd: dir, env: { ...process.env, ...capture.env(process.env) }, stdio: ["ignore", "pipe", "pipe"] });
  let said = "";
  child.stderr.on("data", (d) => { said += d; });
  let reply;
  try {
    const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
    reply = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "x-cortad-turn": "case_1:1" }, body: "{}" }).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 400));
  } finally { child.kill(); }
  const rows = readRows(join(dir, "trace.jsonl"));
  assert.deepEqual(reply, { type: "flashcards", data: [{ front: "Newton's laws", back: "a force" }] }, "the app answers as it would without the hook");
  assert.deepEqual(rows.filter((l) => l.dep?.host === "in-app").map((l) => [l.dep.turn, l.dep.called]), [["case_1:1", [{ name: "generate_cards", arguments: JSON.stringify({ kind: "flashcards", content: "Newton's laws" }) }]]]);
  assert.deepEqual(capture.tools(), { wrapped: ["generate_cards", "search_pages"], unwatched: [] });
  assert.doesNotMatch(said, /not recorded/);
});

// One turn through three SDK styles and a vector store: the tools the model asked for, streamed or
// whole, with values clipped and secrets left out; this turn's tool answers and not an earlier
// turn's; the passages the prompt labels as retrieved; and what the store answered.
const FIXTURE = new URL("./hook-fixture.json", import.meta.url).pathname;
// Tool use written in the reply text: CrewAI and LangChain ReAct, a tool tag, JSON, and prose that
// only says Action.
const WRITTEN = ["reactCrew", "reactLangchain", "xmlTag", "jsonText", "reactProse"];
test("a model call carries the tools it asked for, the passages its prompt was handed and the line of the app that made it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), `
const http = require("node:http");
const fx = JSON.parse(require("node:fs").readFileSync(${JSON.stringify(FIXTURE)}, "utf8"));
const styles = [fx.chat, fx.chatJson, fx.responses, fx.responsesStream, fx.anthropic, fx.store, fx.reactCrew, fx.reactLangchain, fx.xmlTag, fx.jsonText, fx.reactProse, fx.ragBlock, fx.ragCode, fx.records];
const provider = http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => { const s = styles.find((x) => x.path === req.url); res.writeHead(200, { "content-type": s.type }); res.end(s.reply); });
}).listen(0, "127.0.0.1", () => {
  const base = "http://127.0.0.1:" + provider.address().port;
  http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", async () => {
      for (const s of styles) {
        const r = await fetch(base + s.path, { method: "POST", body: JSON.stringify(s.sent || {}) });
        const reader = r.body.getReader(); while (!(await reader.read()).done);
      }
      res.end("{}");
    });
  }).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
});
`);
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const capture = makeCapture({ work: dir, keepSecret: () => {} });
  const child = spawn(process.execPath, [join(dir, "app.cjs")], { cwd: dir, env: { ...process.env, ...capture.env(process.env) }, stdio: ["ignore", "pipe", "inherit"] });
  try {
    const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
    await fetch(`http://127.0.0.1:${port}/api/talk`, { method: "POST", headers: { "x-cortad-turn": fx.turn }, body: "{}" });
    await new Promise((r) => setTimeout(r, 400));
  } finally { child.kill(); }
  const rows = readRows(file);
  const calls = Object.fromEntries(rows.filter((l) => l.call).map((l) => [l.call.model, l.call]));
  const line = readFileSync(join(dir, "app.cjs"), "utf8").split("\n").findIndex((l) => l.includes("await fetch(base + s.path")) + 1;
  for (const style of ["chat", "chatJson", "responses", "responsesStream", "anthropic", ...WRITTEN, "ragBlock", "ragCode", "records"]) {
    const call = calls[fx[style].sent.model];
    assert.equal(call?.turn, fx.turn, style);
    assert.deepEqual(call.called, fx[style].called, `${style}: the tools it asked for`);
    assert.deepEqual(call.passages, fx[style].passages, `${style}: the passages it was handed`);
  }
  for (const call of Object.values(calls)) assert.deepEqual(call.caller, [`app.cjs:${line}`], `${call.model}: the line of the app that made the call`);
  assert.deepEqual(calls["chat-stream"].tools, fx.chat.tools, "this turn's tool answer, and not an earlier turn's");
  assert.deepEqual(calls["responses-json"].tools, fx.responses.tools);
  for (const style of ["reactCrew", "reactLangchain", "xmlTag"]) assert.deepEqual(calls[fx[style].sent.model].tools, fx[style].tools, `${style}: what the tool answered, named`);
  assert.ok(!/abc123|sk-livekey|hunter2/.test(readFileSync(file, "utf8")), "a secret argument is never written");
  const store = rows.find((l) => l.dep && l.dep.passages)?.dep;
  assert.deepEqual([store?.turn, store?.passages], [fx.turn, fx.store.passages], "what the store answered, pinned to the turn");
  // The command hands both on to the run exactly as the hook wrote them, on the turn the run asks for.
  const report = capture.usage(fx.turn);
  assert.deepEqual(report.rows.find((r) => r.model === "chat-stream")?.called, fx.chat.called);
  assert.deepEqual(report.rows.find((r) => r.model === "anthropic-stream")?.passages, fx.anthropic.passages);
  assert.deepEqual(report.rows.find((r) => r.model === "rag-block")?.caller, [`app.cjs:${line}`]);
  assert.deepEqual(report.deps.find((d) => d.passages)?.passages, fx.store.passages);
});

// A tool the model's provider runs comes back in the model's own reply, and so does the error it met
// there: the recorded stream marks both searches completed and hands back one error per call. A call
// whose arguments miss what the tool's own schema requires is refused as sent; the other is not.
test("the tools a provider ran and what they answered, and a call its schema refuses, ride on the model call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), `
const http = require("node:http");
const fx = JSON.parse(require("node:fs").readFileSync(${JSON.stringify(FIXTURE)}, "utf8"));
const styles = [fx.providerTools, fx.refusedArgs];
const provider = http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => { const s = styles.find((x) => x.path === req.url); res.writeHead(200, { "content-type": s.type }); res.end(s.reply); });
}).listen(0, "127.0.0.1", () => {
  const base = "http://127.0.0.1:" + provider.address().port;
  http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", async () => {
      for (const s of styles) {
        const r = await fetch(base + s.path, { method: "POST", body: JSON.stringify(s.sent) });
        const reader = r.body.getReader(); while (!(await reader.read()).done);
      }
      res.end("{}");
    });
  }).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
});
`);
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const capture = makeCapture({ work: dir, keepSecret: () => {} });
  const child = spawn(process.execPath, [join(dir, "app.cjs")], { cwd: dir, env: { ...process.env, ...capture.env(process.env) }, stdio: ["ignore", "pipe", "inherit"] });
  try {
    const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
    await fetch(`http://127.0.0.1:${port}/api/talk`, { method: "POST", headers: { "x-cortad-turn": fx.turn }, body: "{}" });
    await new Promise((r) => setTimeout(r, 400));
  } finally { child.kill(); }
  const calls = Object.fromEntries(readRows(file).filter((l) => l.call).map((l) => [l.call.model, l.call]));
  assert.deepEqual(calls["responses-provider-tools"]?.called, fx.providerTools.called, "both searches, by the name the app offered");
  assert.deepEqual(calls["responses-provider-tools"]?.tools, fx.providerTools.tools, "the error the provider handed back, once");
  assert.deepEqual(calls["refused-args"]?.called, fx.refusedArgs.called);
  const report = capture.usage();
  assert.deepEqual(report.rows.find((r) => r.model === "responses-provider-tools")?.tools, fx.providerTools.tools, "the command hands the provider's answer on as the hook wrote it");
  assert.deepEqual(report.rows.find((r) => r.model === "refused-args")?.called, fx.refusedArgs.called);
});

// The route table read off the app itself: Express 4 and 5 through a router mounted under a prefix
// and a mounted sub-app, handed to the runner and answered by port.
const NODE_APP = new URL("../.scratch/py-app/node-app/", import.meta.url).pathname;
const hasNodeApps = (() => { try { readFileSync(join(NODE_APP, "node_modules/express4/package.json")); return true; } catch { return false; } })();
for (const version of ["express", "express4"]) {
  test(`${version}: every route is written with its mount prefix, and the runner answers it`, { skip: !hasNodeApps }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "routes-"));
    const capture = makeCapture({ work: dir, keepSecret: () => {} });
    const child = spawn(process.execPath, [join(NODE_APP, "express-app.cjs")], { cwd: NODE_APP, env: { ...process.env, ...capture.env({}), EXPRESS: version }, stdio: ["ignore", "pipe", "inherit"] });
    try {
      const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
      await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.text());
      await new Promise((r) => setTimeout(r, 300));
      const table = capture.registry(port);
      const said = table.routes.map((r) => `${r.method} ${r.path}`);
      assert.equal(table.framework, "express");
      assert.equal(table.port, port);
      for (const want of ["POST /api/chat", "GET /api/threads/{id}", "DELETE /api/threads/{id}", "PUT /admin/users/{userId}", "GET /health"]) assert.ok(said.includes(want), `${want} in ${said}`);
      assert.ok(said.includes("POST /late"), "a route added after listening is there by the first request");
      assert.deepEqual(table.routes.find((r) => r.path === "/api/chat"), { method: "POST", path: "/api/chat", file: "express-app.cjs", handler: "chat" });
    } finally { child.kill(); }
  });
}

test("the runner keeps the newest table per port, answers the app's port first and drops what is malformed", () => {
  const dir = mkdtempSync(join(tmpdir(), "routes-"));
  const rows = [
    { routes: { framework: "express", port: 4000, routes: [{ method: "post", path: "/api/chat", file: "a.js", handler: "chat" }], openapi: null } },
    { routes: { framework: "fastapi", port: 5000, routes: [{ method: "POST", path: "/old" }], openapi: null } },
    { routes: { framework: "made-up", port: 5000, routes: [{ method: "GET", path: "/new" }, { method: "POST", path: "no-slash" }, { method: 7, path: "/x" }, { method: "PATCH", path: "/y".repeat(900) }], openapi: [] } },
  ];
  writeFileSync(join(dir, "trace.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const capture = makeCapture({ work: dir, keepSecret: () => {} });
  assert.deepEqual(capture.registry(4000).routes, [{ method: "POST", path: "/api/chat", file: "a.js", handler: "chat" }]);
  const other = capture.registry(5000);
  assert.deepEqual([other.framework, other.openapi, other.routes.map((r) => r.path.length)], ["unknown", null, [4, 1024]]);
  assert.equal(capture.registry(9999).port, 5000, "an unknown port gets the newest table");
  assert.deepEqual(makeCapture({ work: mkdtempSync(join(tmpdir(), "routes-")), keepSecret: () => {} }).registry(1), {});
});

// Fastify through its diagnostics channel, Koa and Hono through the apps held as they are made.
for (const framework of ["fastify", "koa", "hono"]) {
  test(`${framework}: a prefixed route with a path parameter is written as {name}`, { skip: !hasNodeApps }, async () => {
    const file = join(mkdtempSync(join(tmpdir(), "routes-")), "trace.jsonl");
    const child = spawn(process.execPath, ["--require", new URL("./trace.cjs", import.meta.url).pathname, join(NODE_APP, "others.cjs"), framework], { cwd: NODE_APP, env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: "ignore" });
    try {
      let table;
      for (let i = 0; i < 50 && !table; i++) { await new Promise((r) => setTimeout(r, 100)); table = readRows(file).find((l) => l.routes)?.routes; }
      assert.equal(table?.framework, framework);
      assert.deepEqual(table.routes.map((r) => `${r.method} ${r.path} ${r.handler}`), ["POST /api/chat/{id} chat"]);
    } finally { child.kill(); }
  });
}

// A reasoning model that spends its whole output cap thinking writes no answer; the app then fails
// the reply. The provider says so in its own words, and the call says it with the cap the app set.
const CAPPED = `
const http = require("node:http");
const replies = {
  "/v1/chat/completions": { model: "chat-model", choices: [{ finish_reason: "length", message: { content: "" } }], usage: { prompt_tokens: 20, completion_tokens: 350, completion_tokens_details: { reasoning_tokens: 350 } } },
  "/v1/responses": { model: "responses-model", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens: 350, output_tokens_details: { reasoning_tokens: 340 } } },
  "/v1/messages": { model: "claude-model", stop_reason: "max_tokens", usage: { input_tokens: 20, output_tokens: 64 } },
  "/v1/chat/completions?proxied": { model: "accounts/fireworks/models/glm-5p3-flash", choices: [{ finish_reason: "stop", message: { content: "Hi" } }], usage: { prompt_tokens: 20, completion_tokens: 2 } },
  "/v1/chat/completions?dated": { model: "gpt-4o-2024-08-06", choices: [{ finish_reason: "stop", message: { content: "Hi" } }], usage: { prompt_tokens: 20, completion_tokens: 2 } },
  "/v1/chat/completions?done": { model: "done-model", choices: [{ finish_reason: "stop", message: { content: "Hello" } }], usage: { prompt_tokens: 20, completion_tokens: 5 } },
};
const provider = http.createServer((req, res) => { req.resume(); req.on("end", () => res.end(JSON.stringify(replies[req.url]))); }).listen(0, "127.0.0.1", async () => {
  const base = "http://127.0.0.1:" + provider.address().port;
  await fetch(base + "/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "chat-model", max_completion_tokens: 350 }) });
  await fetch(base + "/v1/responses", { method: "POST", body: JSON.stringify({ model: "responses-model", max_output_tokens: 350 }) });
  await fetch(base + "/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-model", max_tokens: 64 }) });
  await fetch(base + "/v1/chat/completions?done", { method: "POST", body: JSON.stringify({ model: "done-model", max_tokens: 900 }) });
  await fetch(base + "/v1/chat/completions?proxied", { method: "POST", body: JSON.stringify({ model: "llama-3.3-70b-versatile" }) });
  await fetch(base + "/v1/chat/completions?dated", { method: "POST", body: JSON.stringify({ model: "gpt-4o" }) });
  console.log("DONE");
});
`;

test("a model call says when it stopped at its output cap, and which model answered when a proxy answered with another", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capped-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), CAPPED);
  const child = spawn(process.execPath, ["--require", new URL("./trace.cjs", import.meta.url).pathname, join(dir, "app.cjs")], { env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve) => child.stdout.on("data", (d) => { if (/DONE/.test(String(d))) resolve(); }));
  // The hook writes a call once it has read the reply, a moment after the app's own await returns.
  for (let i = 0; i < 40 && readRows(file).filter((l) => l.call).length < 6; i++) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  const calls = readRows(file).filter((l) => l.call).map((l) => l.call);
  assert.equal(calls.find((c) => c.model === "llama-3.3-70b-versatile")?.answered, "accounts/fireworks/models/glm-5p3-flash", "a proxy that answered with another model says which");
  assert.equal(calls.find((c) => c.model === "gpt-4o")?.answered, undefined, "a dated version of the model asked for is the same model");
  const by = Object.fromEntries(calls.filter((c) => !["llama-3.3-70b-versatile", "gpt-4o"].includes(c.model)).map((c) => [c.model, c.limit ?? null]));
  assert.deepEqual(by, {
    "chat-model": { cap: 350, reasoning: 350 },
    "responses-model": { cap: 350, reasoning: 340 },
    "claude-model": { cap: 64, reasoning: 0 },
    "done-model": null,
  });
});
