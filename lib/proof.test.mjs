import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canaryOf, exchangesOf, isCanary, proofsOf, replyOf, carrierOf } from "./proof.mjs";
import { makeCapture, sourceFinder, withoutCarriers } from "./replay.mjs";

// Real apps under the real hooks: each door holds a conversation its own way, a client drives two
// turns through it the way the app's own client would, and the proof is read off what was recorded.
const HOOK = new URL("./trace.cjs", import.meta.url).pathname;
const PYHOOK = new URL("./pyhook/", import.meta.url).pathname;
const PY = new URL("../.scratch/py-app/.venv/bin/python", import.meta.url).pathname;
const rowsOf = (file) => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const settle = () => new Promise((r) => setTimeout(r, 400));

function inFolder(name) {
  const dir = mkdtempSync(join(tmpdir(), "proof-"));
  copyFileSync(new URL(`./${name}`, import.meta.url), join(dir, name));
  return dir;
}

async function nodeApp(env = {}) {
  const dir = inFolder("proof-app.cjs");
  const file = join(dir, "trace.jsonl");
  const child = spawn(process.execPath, ["--require", HOOK, "proof-app.cjs"], { cwd: dir, env: { ...process.env, CORTAD_TRACE_FILE: file, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  const post = (path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { dir, file, child, post, port };
}

// Two turns on each of the Node app's doors, each the way that door's own client holds a conversation.
async function twoTurns(post) {
  const first = await (await post("/api/chat", { message: "a weekend in Lisbon" }, { authorization: "Bearer tok-4f9a8b7c6d5e4f3a2b1c" })).json();
  await (await post("/api/chat", { message: "the leak season in Porto", sessionId: first.sessionId }, { authorization: "Bearer tok-4f9a8b7c6d5e4f3a2b1c" })).json();
  const streamed = await (await post("/api/stream", { messages: [{ role: "user", content: "hiking in Madeira" }] })).text();
  const said = streamed.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)).content ?? "").join("");
  await (await post("/api/stream", { messages: [{ role: "user", content: "hiking in Madeira" }, { role: "assistant", content: said }, { role: "user", content: "the Azores in winter" }] })).text();
  for (const text of ["museums in Madrid", "tapas near Retiro"]) await (await post("/api/threads/t-8f3a2c9d1e7b4a6c/messages", { text })).json();
  for (const q of ["trains from Paris to Nice", "night trains to Vienna"]) await (await post("/api/assist", { q }, { "x-conversation": "c-7d1e2f3a4b5c6d7e8f9a" })).text();
  for (let i = 0; i < 2; i++) await (await post("/api/once", { message: "a day trip to Sintra" })).json();
  const handed = await (await post("/api/forgets", { message: "a ferry to the Berlengas" })).json();
  await (await post("/api/forgets", { message: "the ferry back at five", sessionId: handed.sessionId })).json();
  for (const message of ["is it ok to put an angry caller on hold?", "and if they refuse to hold?"]) await (await post("/api/lessons", { message, activity_uuid: "activity_5f1c446f-ebed-4931-bf92-54d99c730567" })).json();
  const page = "https://www.canada.ca/en/employment-social-development/services/sin.html";
  const chatId = "2a2281d1-091b-41e9-8115-ecfac601449d";
  const opened = await (await post("/api/answers", { input: { userMessage: "how do I get a SIN?", referringUrl: page, chatId, visitorId: "d4fe81bd-dd66-447f-bbae-11a0e5e848b7", historySignature: null, conversationHistory: [] } })).json();
  await (await post("/api/answers", { input: { userMessage: "can I apply online?", referringUrl: page, chatId, visitorId: "d4fe81bd-dd66-447f-bbae-11a0e5e848b7", historySignature: opened.historySignature, conversationHistory: [{ sender: "user", text: "how do I get a SIN?" }, { sender: "ai", text: opened.answer }] } })).json();
  await (await post("/api/answers", { input: { userMessage: "what does a SIN cost?", referringUrl: page, chatId, visitorId: "d4fe81bd-dd66-447f-bbae-11a0e5e848b7", historySignature: null, conversationHistory: [] } })).json();
  await (await post("/api/once", { message: "the code for a trip card" })).json();
  await (await post("/api/broken", { message: "is it raining in Rome" })).json();
}

test("Node: each door's ask, session, reply and model are read off two real turns", async () => {
  const app = await nodeApp();
  try { await twoTurns(app.post); await settle(); } finally { app.child.kill(); }
  const proofs = proofsOf(rowsOf(app.file), { find: sourceFinder(app.dir, () => ["proof-app.cjs"]) });
  const of = (key) => proofs.get(key)?.proof;
  assert.deepEqual([...proofs.keys()].sort(), ["POST /api/answers", "POST /api/assist", "POST /api/broken", "POST /api/chat", "POST /api/forgets", "POST /api/lessons", "POST /api/once", "POST /api/stream", "POST /api/threads/{id}/messages"]);
  // AI Answers: the page URL reaches the prompt as it is and is longer than the question, but an
  // address is never what a person says; and the chat id every request carried is the agent's own
  // conversation, left out so each trial opens its own.
  const answers = proofs.get("POST /api/answers");
  assert.equal(answers.proof.askField, "input.userMessage");
  assert.equal(answers.proof.session.carrier, "history");
  assert.equal("chatId" in answers.template.body.input, false, "the agent's conversation id is not replayed");
  assert.equal(answers.template.body.input.visitorId, "d4fe81bd-dd66-447f-bbae-11a0e5e848b7", "an id that is not the conversation's stays");
  // The signature its first reply handed out went back with the follow-up: each trial sends back its own.
  assert.deepEqual(answers.proof.echoes, ["input.historySignature"]);
  // A new conversation came last, its history empty: trials copy the request that shows how a turn is written.
  assert.deepEqual(answers.template.body.input.conversationHistory.map((t) => t.sender), ["user", "ai"]);
  assert.equal(of("POST /api/lessons").echoes, undefined, "an id the client sent first is not one handed back");
  // A lesson id sent with every message and echoed back is a fixed field, not a conversation id: it
  // stays in the template as captured and no trial opens without it or makes one up.
  assert.deepEqual([of("POST /api/lessons").session.carrier, of("POST /api/lessons").session.key], ["none", null], "an id the client sent first is not one the app handed back");
  assert.equal(proofs.get("POST /api/lessons").template.body.activity_uuid, "activity_5f1c446f-ebed-4931-bf92-54d99c730567");
  assert.equal(proofs.get("POST /api/lessons").template.sessionKey, null);

  assert.deepEqual(of("POST /api/chat").session, { held: true, carrier: "body", key: "sessionId", minted: "app" }, "the id the app handed back in its first reply");
  assert.deepEqual([of("POST /api/chat").askField, of("POST /api/chat").replyPath, of("POST /api/chat").stream], ["message", "reply", false]);
  assert.deepEqual([of("POST /api/chat").exchanges, of("POST /api/chat").modelCalls, of("POST /api/chat").model], [2, 1, "fixture-model"]);
  assert.deepEqual(of("POST /api/chat").tokens, { prompt: 50, completion: 12 }, "the provider's own counts, the median of the two turns");
  assert.equal(typeof of("POST /api/chat").replySeconds, "number");

  assert.deepEqual(of("POST /api/stream").session, { held: true, carrier: "history", key: "messages" });
  assert.deepEqual([of("POST /api/stream").askField, of("POST /api/stream").replyPath, of("POST /api/stream").stream], ["messages", null, true]);
  assert.equal(proofs.get("POST /api/stream").sample.reply, "About the Azores in winter: pack light. Earlier you asked about hiking in Madeira.", "the stream put back together from its events");

  assert.deepEqual(of("POST /api/threads/{id}/messages").session, { held: true, carrier: "path", key: "id", minted: "client" });
  assert.deepEqual(proofs.get("POST /api/threads/{id}/messages").template.pathValues, { id: "t-8f3a2c9d1e7b4a6c" }, "the route values the person's request carried go with the template");
  assert.equal(proofs.get("POST /api/chat").template.pathValues, undefined, "a route with no values sends none");
  assert.deepEqual(of("POST /api/assist").session, { held: true, carrier: "header", key: "x-conversation", minted: "client" });
  assert.equal(of("POST /api/assist").replyPath, null, "a plain text reply is read whole");
  assert.deepEqual(of("POST /api/once").session, { held: false, carrier: "none", key: null }, "the same words asked twice are not a conversation held, nor one tried");
  assert.deepEqual(of("POST /api/forgets").session, { held: false, carrier: "body", key: "sessionId", minted: "app", tried: true },
    "the id it handed back was sent back and it held nothing, and the id is named so no trial replays it");
});

test("Node: the problems a line of code decides are named with the line that holds them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proof-rules-"));
  writeFileSync(join(dir, "rules.json"), JSON.stringify([{ id: "rule:short", text: "Keep answers short." }]));
  const app = await nodeApp({ CORTAD_RULES_FILE: join(dir, "rules.json") });
  try { await twoTurns(app.post); await settle(); } finally { app.child.kill(); }
  // The same literals in a doc, a test and another code file: the file the call came from answers.
  const others = { "README.md": "Our prompt uses <system-reminder> tags.", "docs/prompt.js": "// <system-reminder>", "test/app.test.js": "// The assistant is unavailable right now.", "prompts.js": "export const TAG = '<system-reminder>';" };
  mkdirSync(join(app.dir, "docs"));
  mkdirSync(join(app.dir, "test"));
  for (const [rel, text] of Object.entries(others)) writeFileSync(join(app.dir, rel), text);
  const proofs = proofsOf(rowsOf(app.file), { find: sourceFinder(app.dir, () => [...Object.keys(others), "proof-app.cjs"]) });
  const source = readFileSync(join(app.dir, "proof-app.cjs"), "utf8").split("\n");
  const lineOf = (text) => source.findIndex((l) => l.includes(text)) + 1;
  const problems = (key) => proofs.get(key).problems;

  assert.deepEqual(problems("POST /api/chat"), [{ kind: "leaked-markup", said: 'The reply carried markup from the prompt your app sent the model: "</system-reminder>". The model said it.', file: "proof-app.cjs", line: lineOf("<system-reminder>") }]);
  const broken = problems("POST /api/broken");
  assert.deepEqual(broken.map((p) => p.kind), ["error-under-2xx", "model-call-failed"]);
  assert.deepEqual([broken[0].file, broken[0].line], ["proof-app.cjs", lineOf("The assistant is unavailable right now.")], "the error sentence found where the app wrote it");
  assert.match(broken[1].said, /^A model call to 127\.0\.0\.1:\d+ for fixture-model answered 503\.$/);
  assert.equal(proofs.get("POST /api/broken").sample.error, true, "an error shown as the reply is said to be one, so nothing takes it for the model's answer");
  assert.equal("error" in proofs.get("POST /api/chat").sample, false);
  assert.deepEqual([broken[1].file, broken[1].line], ["proof-app.cjs", lineOf("const complete = ")], "the app's own line that made the call");
  assert.deepEqual(problems("POST /api/assist").map((p) => [p.kind, p.line]), [["rules-not-carried", lineOf("const complete = ")]], "its own system prompt carried none of the read's rules");
  assert.deepEqual(problems("POST /api/stream"), []);
  assert.deepEqual(problems("POST /api/once"), [], "the prompt's markup shown inside a code block is the answer, not a leak");
  const chat = proofs.get("POST /api/chat").proof;
  assert.deepEqual([chat.host, chat.rules, chat.tools, chat.passages], ["127.0.0.1", ["rule:short"], [], 0], "the host without its port, the rule the prompts carried");
  assert.deepEqual(proofs.get("POST /api/assist").proof.rules, [], "carried none, said as none");
});

// yunqiao's streaming code sent the reminder its agent framework adds to the prompt as a "hint" event
// of its own, and the finding named the model call. The same shape here: the model never says the
// block, and the leak is placed at the line that sent it, written straight to the response or put
// into a web stream the app hands its server to pipe.
const HINTED = 'The reply carried markup from the prompt your app sent the model: "<system-reminder>". The model never said it: your app\'s own code sent it here, in its "hint" event.';
test("Node: a block the model never said is placed at the line of the app that sent it", async () => {
  const app = await nodeApp();
  try {
    for (const door of ["/api/hinted", "/api/web", "/api/logged"]) await (await app.post(door, { messages: [{ role: "user", content: "hiking in Madeira" }] })).text();
    await settle();
  } finally { app.child.kill(); }
  const proofs = proofsOf(rowsOf(app.file), { find: sourceFinder(app.dir, () => ["proof-app.cjs"]) });
  const source = readFileSync(join(app.dir, "proof-app.cjs"), "utf8").split("\n");
  const lineOf = (text) => source.findIndex((l) => l.includes(text)) + 1;
  assert.deepEqual(proofs.get("POST /api/hinted").problems, [{ kind: "leaked-markup", said: HINTED, file: "proof-app.cjs", line: lineOf('res.write(event("hint"') }]);
  assert.deepEqual(proofs.get("POST /api/web").problems, [{ kind: "leaked-markup", said: HINTED, file: "proof-app.cjs", line: lineOf('controller.enqueue(bytes.encode(event("hint"') }]);
  assert.equal(proofs.get("POST /api/web").sample.reply, "<system-reminder>Keep answers short.</system-reminder>About hiking in Madeira: pack light.", "the reply as the person read it");
  assert.deepEqual(proofs.get("POST /api/logged").problems, [{ kind: "leaked-markup", said: HINTED.replace(', in its "hint" event', ""), file: "proof-app.cjs", line: lineOf("return res.end(JSON.stringify({ reply: `${REMINDER}") }],
    "the handler that wrote the reply, not the res.end the app put in front of the one it replaced");

  // The hooks keep a model's first 4000 characters: past them the block may be the model's own.
  const cut = rowsOf(app.file).map((r) => (r.call?.reply ? { ...r, call: { ...r.call, reply: r.call.reply.padEnd(4000, ".") } } : r));
  const unplaced = proofsOf(cut, { find: sourceFinder(app.dir, () => ["proof-app.cjs"]) }).get("POST /api/hinted").problems;
  const atPrompt = [{ kind: "leaked-markup", said: 'The reply carried markup from the prompt your app sent the model: "<system-reminder>".', file: "proof-app.cjs", line: lineOf("<system-reminder>") }];
  assert.deepEqual(unplaced, atPrompt);
  // A line whose writes never carried the block is not where it was sent, though it is the only line seen.
  const deltas = rowsOf(app.file).map((r) => (r.sites ? { ...r, sites: { ...r.sites, list: r.sites.list.filter((s) => s.event === "delta") } } : r));
  assert.deepEqual(proofsOf(deltas, { find: sourceFinder(app.dir, () => ["proof-app.cjs"]) }).get("POST /api/hinted").problems, atPrompt);
});

test("the command hands on the model's words and the lines that wrote the reply for the turn asked about, and for no other", async () => {
  const dir = inFolder("proof-app.cjs");
  const capture = makeCapture({ work: dir, keepSecret: () => {} });
  const child = spawn(process.execPath, ["proof-app.cjs"], { cwd: dir, env: { ...process.env, ...capture.env(process.env) }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  const turn = "case_3:1";
  try {
    for (const tag of [turn, "case_4:1"]) await (await fetch(`http://127.0.0.1:${port}/api/hinted`, { method: "POST", headers: { "content-type": "application/json", "x-cortad-turn": tag }, body: JSON.stringify({ messages: [{ role: "user", content: "hiking in Madeira" }] }) })).text();
    await settle();
  } finally { child.kill(); }
  const source = readFileSync(join(dir, "proof-app.cjs"), "utf8").split("\n");
  const at = (text) => `proof-app.cjs:${source.findIndex((l) => l.includes(text)) + 1}`;
  const rows = capture.usage(turn).rows;
  const [asked, other] = [turn, "case_4:1"].map((tag) => rows.find((r) => r.turn === tag));
  assert.equal(asked.said, "About hiking in Madeira: pack light.");
  assert.deepEqual(asked.sites.map((s) => [s.at, s.event]), [[at('res.write(event("hint"'), "hint"], [at('res.write(event("delta"'), "delta"], [at('res.end(event("done"'), "done"]]);
  assert.match(asked.sites[0].text, /<system-reminder>Keep answers short\.<\/system-reminder>/);
  assert.ok(other.said === undefined && other.sites === undefined, "another turn's rows carry neither");
  assert.ok(capture.usage().rows.every((r) => r.said === undefined && r.sites === undefined), "a report for no turn carries neither");
});

// The provider stream recorded from a real app that offers a web search its account cannot run: the
// agent's own first request shows the tool coming back as an error, at the line that offers it.
test("Node: a tool the model's provider ran that came back as an error is a problem at the line that offers it", async () => {
  const fx = JSON.parse(readFileSync(new URL("./hook-fixture.json", import.meta.url), "utf8"));
  const stream = join(mkdtempSync(join(tmpdir(), "proof-stream-")), "stream.txt");
  writeFileSync(stream, fx.providerTools.reply);
  const app = await nodeApp({ PROVIDER_STREAM: stream });
  try { await (await app.post("/api/search", { message: "what happened in the news this week?" })).json(); await settle(); } finally { app.child.kill(); }
  const proofs = proofsOf(rowsOf(app.file), { find: sourceFinder(app.dir, () => ["proof-app.cjs"]) });
  const source = readFileSync(join(app.dir, "proof-app.cjs"), "utf8").split("\n");
  const search = proofs.get("POST /api/search");
  assert.deepEqual(search.problems, [{
    kind: "tool-failed",
    said: 'The tool web_search_preview came back as an error from your model provider, which runs it: "Error: Web search is not enabled for this account (allow-search-gateway)."',
    file: "proof-app.cjs", line: source.findIndex((l) => l.includes('type: "web_search_preview"')) + 1,
  }]);
  assert.deepEqual(search.proof.tools, ["web_search_preview"], "the tool it called, as the app offered it");
});

test("every request of the person's is kept and the first four of ours per route, whatever id the path carries", async () => {
  const app = await nodeApp();
  try {
    for (let i = 0; i < 6; i++) await (await app.post(`/api/threads/t-${i}f3a2c9d1e7b4a6c/messages`, { text: `museum ${i}` })).json();
    for (let i = 0; i < 6; i++) await (await app.post(`/api/threads/t-${i}a1b2c3d4e5f6a7b/messages`, { text: `gallery ${i}` }, { "x-cortad-turn": `cortad-${i}` })).json();
    await settle();
  } finally { app.child.kill(); }
  const rows = rowsOf(app.file).filter((r) => r.ex && r.method);
  assert.deepEqual([rows.filter((r) => !r.turn).length, rows.filter((r) => r.turn).length], [6, 4]);
  assert.equal(rowsOf(app.file).filter((r) => r.call).length, 12, "every model call is still metered");
});

test("the command sends each door once it is proven and again only when a new exchange changes it; header values stay here", async () => {
  const dir = inFolder("proof-app.cjs");
  const sent = [];
  const kept = [];
  const capture = makeCapture({ work: dir, keepSecret: (v) => kept.push(v), onProof: (p) => sent.push(p), root: dir, files: () => ["proof-app.cjs"] });
  const child = spawn(process.execPath, ["proof-app.cjs"], { cwd: dir, env: { ...process.env, ...capture.env(process.env) }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  const post = (body) => fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok-4f9a8b7c6d5e4f3a2b1c" }, body: JSON.stringify(body) }).then((r) => r.json());
  try {
    const first = await post({ message: "a weekend in Lisbon" });
    await settle();
    capture.alive();
    assert.equal(sent.length, 1, "proven by one exchange");
    assert.deepEqual([sent[0].proof.exchanges, sent[0].proof.session.held], [1, false]);
    capture.alive();
    assert.equal(sent.length, 1, "nothing new, nothing sent");
    await post({ message: "the leak season in Porto", sessionId: first.sessionId });
    await settle();
    capture.alive();
    const last = sent.at(-1);
    assert.deepEqual([last.proof.exchanges, last.proof.session], [2, { held: true, carrier: "body", key: "sessionId", minted: "app" }]);
    assert.deepEqual(last.door, { method: "POST", path: "/api/chat" });
    assert.deepEqual(last.template, { body: { message: "the leak season in Porto", sessionId: first.sessionId }, headerNames: ["accept", "accept-language", "authorization", "content-type", "sec-fetch-mode", "user-agent"], askField: "message", sessionKey: "sessionId" });
    assert.ok(!JSON.stringify(sent).includes("tok-4f9a8b7c6d5e4f3a2b1c"), "a sign-in value never leaves");
    assert.ok(kept.includes("tok-4f9a8b7c6d5e4f3a2b1c"), "and is kept to be masked out of anything that does");
    assert.equal(capture.headers().authorization, "Bearer tok-4f9a8b7c6d5e4f3a2b1c", "speaking as the person uses their own header, here");
  } finally { child.kill(); }
});

test("a literal outside the call's own files is placed only when one code file holds it", () => {
  const dir = mkdtempSync(join(tmpdir(), "finder-"));
  const files = { "a.jsx": "<p>Hello {name}</p>", "b.jsx": "<b>{name}</b>", "c.py": 'PROMPT = "Answer as {persona}."', "README.md": "{persona} is set per user." };
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(dir, rel), text);
  const find = sourceFinder(dir, () => ["README.md", ...Object.keys(files)]);
  assert.equal(find("{name}"), null, "two components hold it: neither is the address");
  assert.deepEqual(find("{name}", ["b.jsx"]), { file: "b.jsx", line: 1 }, "the file the call came from answers first");
  assert.deepEqual(find("{persona}"), { file: "c.py", line: 1 }, "the doc never answers");
  writeFileSync(join(dir, "unlisted.py"), 'X = "{persona}"');
  assert.deepEqual(find("{persona}", ["unlisted.py"]), { file: "c.py", line: 1 }, "a frame file outside the shareable files is never read");
});

const skipPy = !existsSync(PY);

test("Python: a cookie the app set, an id the client minted, a stream, and a retrieval that came back empty", { skip: skipPy }, async () => {
  const dir = inFolder("proof_app.py");
  const file = join(dir, "trace.jsonl");
  const port = 4391;
  const child = spawn(PY, ["-m", "uvicorn", "proof_app:app", "--port", String(port)], { cwd: dir, env: { ...process.env, PYTHONPATH: PYHOOK, CORTAD_TRACE_FILE: file }, stdio: "ignore" });
  const post = (path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${port}/nothing`); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
    const one = await post("/chat", { message: "a mushroom risotto" });
    const cookie = one.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    await one.json();
    await (await post("/chat", { message: "a lemon tart for six" }, { cookie })).json();
    for (const question of ["crispy tofu at home", "a quick peanut sauce"]) await (await post("/ask", { thread_id: "7f3c2a9e-1b4d-4c8e-9a2f-6d5e4c3b2a10", question })).text();
    await (await post("/recipes", { q: "vegan lasagne" })).json();
    for (const door of ["/hinted", "/behind/hinted", "/timed/told"]) await (await post(door, { question: "a lemon tart" })).text();
    await settle();
  } finally { child.kill("SIGKILL"); }
  const rows = rowsOf(file);
  const proofs = proofsOf(rows, { find: sourceFinder(dir, () => ["proof_app.py"]), routes: rows.find((r) => r.routes)?.routes.routes });
  const of = (key) => proofs.get(key).proof;
  assert.deepEqual(of("POST /chat").session, { held: true, carrier: "cookie", key: "conv", minted: "app" });
  assert.deepEqual([of("POST /chat").askField, of("POST /chat").replyPath, of("POST /chat").tokens], ["message", "answer", { prompt: 40, completion: 9 }]);
  assert.deepEqual(of("POST /ask").session, { held: true, carrier: "body", key: "thread_id", minted: "client" });
  assert.deepEqual([of("POST /ask").askField, of("POST /ask").stream], ["question", true]);
  assert.equal(proofs.get("POST /ask").sample.reply, "For a quick peanut sauce, swap butter for olive oil. You also asked about crispy tofu at home.", "a stream whose events say token keeps its words");
  const source = readFileSync(join(dir, "proof_app.py"), "utf8").split("\n");
  assert.equal(of("POST /recipes").rules, undefined, "no rules file, so nothing is claimed about rules");
  assert.deepEqual(proofs.get("POST /recipes").problems, [{ kind: "retrieval-empty", said: "A retrieval from 127.0.0.1 returned nothing.", file: "proof_app.py", line: source.findIndex((l) => l.includes("found = httpx.post(")) + 1 }]);
  const hint = [{ kind: "leaked-markup", said: HINTED, file: "proof_app.py", line: source.findIndex((l) => l.includes('yield "event: hint')) + 1 }];
  assert.deepEqual(proofs.get("POST /hinted").problems, hint, "the line of the generator that made the event, not the one that passed it along");
  assert.deepEqual(proofs.get("POST /behind/hinted").problems, hint, "behind a middleware that hands the reply over from another task");
  assert.deepEqual(proofs.get("POST /timed/told").problems, [{ kind: "leaked-markup", said: 'The reply carried markup from the prompt your app sent the model: "<system-reminder>".', file: "proof_app.py", line: source.findIndex((l) => l.includes("<system-reminder>")) + 1 }],
    "no line of the app wrote a reply the framework rendered, least of all the middleware that only passed the request on: the block stays where the code writes it");
});

const FLASK_APP = `import json
from flask import Flask, Response, stream_with_context

app = Flask(__name__)
REMINDER = "<system-reminder>The kitchen closes at 22:00.</system-reminder>"


def events():
    yield "event: hint\\ndata: %s\\n\\n" % json.dumps({"text": REMINDER})
    for word in ["For", " a", " lemon", " tart"]:
        yield "event: delta\\ndata: %s\\n\\n" % json.dumps({"text": word})


@app.post("/hinted")
def hinted():
    return Response(stream_with_context(events()), mimetype="text/event-stream")


if __name__ == "__main__":
    app.run(port=4393)
`;

test("Python, WSGI: each part of a streamed reply is placed at the line of the generator that made it", { skip: skipPy }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "proof-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "flask_hinted.py"), FLASK_APP);
  const child = spawn(PY, ["flask_hinted.py"], { cwd: dir, env: { ...process.env, PYTHONPATH: PYHOOK, CORTAD_TRACE_FILE: file }, stdio: "ignore" });
  try {
    for (let i = 0; i < 80; i++) { try { await fetch("http://127.0.0.1:4393/nothing"); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
    await (await fetch("http://127.0.0.1:4393/hinted", { method: "POST", headers: { "x-cortad-turn": "case_7:1" } })).text();
    await settle();
  } finally { child.kill("SIGKILL"); }
  const lineOf = (text) => `flask_hinted.py:${FLASK_APP.split("\n").findIndex((l) => l.includes(text)) + 1}`;
  const { sites } = rowsOf(file).find((r) => r.sites);
  assert.equal(sites.turn, "case_7:1");
  assert.deepEqual(sites.list.map((s) => [s.at, s.event]), [[lineOf('yield "event: hint'), "hint"], [lineOf('yield "event: delta'), "delta"]]);
});

test("speaking as the person never sends what carries a proven conversation", () => {
  const person = { authorization: "Bearer t", cookie: "conv=abc; theme=dark", "x-conversation": "c-1" };
  assert.deepEqual(withoutCarriers(person, [{ carrier: "cookie", key: "conv" }, { carrier: "header", key: "x-conversation" }]),
    { authorization: "Bearer t", cookie: "theme=dark" });
  assert.deepEqual(withoutCarriers({ cookie: "conv=abc" }, [{ carrier: "cookie", key: "conv" }]), {});
});

// A Next.js app on the AI SDK streams its UI message events; with no model words to match, the ids on
// every event outweighed the text and the sample the agent read was a run of message ids.
test("a UI message stream is read as its words, not its ids or event names", () => {
  const frames = [
    { type: "start", messageId: "x8dBiDJwSGF8fiWi" }, { type: "start-step" },
    { type: "reasoning-start", id: "rs_b4caa19f4ccc49088c3d663f6257c1de:0" },
    { type: "text-start", id: "msg_2ca540be544544beb9bdd07de7d8386b" },
    ...["Two ", "benefits: ", "early errors ", "and better tooling."].map((delta) => ({ type: "text-delta", id: "msg_2ca540be544544beb9bdd07de7d8386b", delta })),
    { type: "text-end", id: "msg_2ca540be544544beb9bdd07de7d8386b" }, { type: "finish" },
  ];
  const reply = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  const ex = { reply, type: "text/event-stream", writes: frames.length, calls: [], deps: [], sent: [], body: "{}", headers: {}, path: "/api/chat", method: "POST" };
  assert.equal(replyOf(ex).text, "Two benefits: early errors and better tooling.");
});

// yunqiao sends its thinking as an SSE event named for it; an OpenAI-compatible stream passed straight
// through carries it in delta.reasoning_content. Neither is the answer.
test("a stream's thinking, as a named SSE event or a reasoning field, is never taken as the reply", () => {
  const ex = (reply) => ({ reply, type: "text/event-stream", writes: 4, calls: [], deps: [], sent: [], body: "{}", headers: {}, path: "/api/chat", method: "POST" });
  const named = "event: thinking\ndata: {\"text\":\"Let me look at the refund policy before I answer this one.\"}\n\nevent: message\ndata: {\"text\":\"Your refund was sent on Monday.\"}\n\n";
  assert.equal(replyOf(ex(named)).text, "Your refund was sent on Monday.");
  const passed = [{ choices: [{ delta: { reasoning_content: "The user wants the refund date, so I should check the order first." } }] }, { choices: [{ delta: { content: "Your refund was sent on Monday." } }] }]
    .map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  assert.equal(replyOf(ex(passed)).text, "Your refund was sent on Monday.");
});

// A chat that answered 200 and streamed its own fallback as an error event, after its model call failed.
test("an error event inside a 200 stream is the reply's error, placed at the line that wrote it", () => {
  const busy = "The assistant is busy right now. Please try again in a moment.";
  const rows = [
    { ex: "1.1", at: 1000, ms: 50, method: "POST", path: "/api/rag", body: JSON.stringify({ message: "when is my exam" }), status: 200, type: "text/event-stream", writes: 2, sent: [],
      reply: `data: ${JSON.stringify({ type: "start" })}\n\ndata: ${JSON.stringify({ type: "error", message: busy })}\n\n` },
    { call: { ex: "1.1", host: "127.0.0.1:9", model: "m", status: 404, caller: ["src/rag.ts:40"] } },
  ];
  const find = (literal) => (busy.startsWith(literal) ? { file: "src/rag.ts", line: 88 } : null);
  const problems = proofsOf(rows, { find }).get("POST /api/rag").problems;
  assert.deepEqual(problems.find((p) => p.kind === "error-under-2xx"), { kind: "error-under-2xx", said: `Your app answered 200 with an error: "${busy}".`, file: "src/rag.ts", line: 88 });
});

// The same bodies the backend's readError reads in its test/door-dialects.test.ts: a refusal one side
// read as a reply held nothing there, while the other sent its test message into it.
const STREAMED_ERRORS = [
  ['data: {"error":"401 Incorrect API key provided"}\n\n', true],
  ['data: {"type":"error","error":{"message":"Overloaded"}}\n\n', true],
  ['data: {"type":"start"}\n\ndata: {"type":"error","errorText":"AI Gateway requires a valid credit card on file."}\n\ndata: [DONE]\n\n', true],
  ['data: {"type":"error","message":"The assistant is busy right now."}\n\n', true],
  ['data: {"type":"error","detail":"quota exceeded"}\n\n', true],
  ['event: error\ndata: {"message":"Rate limit reached"}\n\n', true],
  ['event: error\ndata: Upstream refused the request\n\n', true],
  ['f:{"messageId":"msg-1"}\n3:"AI Gateway requires a valid credit card on file."\n', true],
  ['{"type":"start"}\n{"error":{"message":"Invalid key"}}\n', true],
  ['data: {"type":"start"}\n\ndata: {"type":"start-step"}\n\ndata: {"type":"finish-step"}\n\ndata: {"type":"finish","finishReason":"error"}\n\ndata: [DONE]\n\n', true],
  ['data: {"type":"text-delta","delta":"Here is what I found so far."}\n\ndata: {"type":"finish","finishReason":"error"}\n\n', false],
  ['data: {"type":"sources","error":"no public sources found"}\n\ndata: {"type":"text-delta","delta":"Here is the answer."}\n\n', false],
  ['data: {"type":"tool-output-error","toolCallId":"c1","errorText":"not found"}\n\ndata: {"type":"text-delta","delta":"I could not find it."}\n\n', false],
  ['data: {"type":"text-delta","delta":"Hello there."}\n\n', false],
  ['f:{"messageId":"msg-1"}\n0:"Hello"\n0:" there."\ne:{"finishReason":"stop"}\n', false],
];
test("an error the app streamed is its error in every shape the backend reads as one, and a note beside a full answer is not", () => {
  for (const [reply, error] of STREAMED_ERRORS) {
    const rows = [{ ex: "1.1", at: 1000, ms: 50, method: "POST", path: "/api/chat", body: JSON.stringify({ message: "how many visitors" }), status: 200, type: "text/event-stream", writes: 3, reply, sent: [] }];
    assert.equal(proofsOf(rows).get("POST /api/chat").sample.error === true, error, reply);
  }
});

// A door's problems span its last requests and the sample shows only the newest: a key fixed since
// was quoted beside a newer card error, and an earlier retried 429 was blamed for a later 500.
test("a refusal is said from the request the sample shows alone, and only one every later call would meet", () => {
  let at = 1000;
  const exchange = (id, reply, calls, status = 200) => [
    { ex: id, at: (at += 1000), ms: 50, method: "POST", path: "/api/chat", body: JSON.stringify({ message: `question ${id}` }), status, type: "application/json", reply: JSON.stringify(reply), sent: [] },
    ...calls.map((c) => ({ call: { ex: id, host: "ai-gateway.vercel.sh", model: "gpt-4o", ...c } })),
  ];
  const sample = (...rows) => proofsOf(rows.flat()).get("POST /api/chat").sample;
  const key = exchange("a", { error: "Invalid API key" }, [{ status: 401 }]);
  const card = exchange("b", { error: "AI Gateway requires a valid credit card on file." }, [{ status: 403 }]);
  assert.equal(sample(key, card).refused, 'A model call to ai-gateway.vercel.sh for gpt-4o answered 403. Your app answered 200 with an error: "AI Gateway requires a valid credit card on file.".');
  assert.equal(sample(exchange("c", { error: "Unauthorized" }, [{ status: 401 }], 401)).refused, "A model call to ai-gateway.vercel.sh for gpt-4o answered 401.", "a status passed through says only the call");
  const retried = exchange("d", { reply: "412 visitors this week." }, [{ status: 429 }, { status: 200, reply: "412 visitors this week." }]);
  const saveFailed = exchange("e", { error: "Failed to save chat" }, [{ status: 200, reply: "You had 412 visitors." }], 500);
  assert.deepEqual([sample(retried, saveFailed).error, "refused" in sample(retried, saveFailed)], [true, false], "an earlier request's call is not this one's cause");
  const overloaded = exchange("f", { error: "Overloaded" }, [{ status: 529 }, { status: 0 }]);
  assert.deepEqual([sample(overloaded).error, "refused" in sample(overloaded)], [true, false], "an outage or a dropped call is no refusal");
  const fellBack = exchange("g", { reply: "412 visitors this week." }, [{ status: 404 }, { status: 200, reply: "412 visitors this week." }]);
  assert.deepEqual(["error" in sample(fellBack), "refused" in sample(fellBack)], [false, false], "a refusal behind a reply that came is no refusal of the request");
});

// OpenAI's quota error ends on the page that says what to do about it, and a cut at 160 characters
// fell inside that link.
test("a provider's message quoted to the person is cut at a word, and never inside a link", () => {
  const said = (error) => proofsOf([{ ex: "1.1", at: 1000, ms: 50, method: "POST", path: "/api/chat", body: JSON.stringify({ message: "hi" }), status: 200, type: "application/json", reply: JSON.stringify({ error }), sent: [] }])
    .get("POST /api/chat").problems.find((p) => p.kind === "error-under-2xx").said;
  const quota = "You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.";
  assert.equal(said(quota), `Your app answered 200 with an error: "${quota}".`);
  assert.equal(said("word ".repeat(40).trim()), `Your app answered 200 with an error: "${"word ".repeat(32).trim()}...".`);
  const endless = `See https://example.com/${"a".repeat(400)}`;
  assert.equal(said(endless), `Your app answered 200 with an error: "${endless.slice(0, 204)}...".`, "a link is kept whole up to a bound");
  const silent = proofsOf([{ ex: "1.1", at: 1000, ms: 50, method: "POST", path: "/api/chat", body: JSON.stringify({ message: "hi" }), status: 200, type: "text/event-stream", reply: 'data: {"type":"start"}\n\ndata: {"type":"finish","finishReason":"error"}\n\n', sent: [] }])
    .get("POST /api/chat").problems.find((p) => p.kind === "error-under-2xx").said;
  assert.equal(silent, "Your app answered 200 and its reply ended on an error before any text.", "our own words for a stream that said nothing are never quoted as the app's");
});

// A retrieval that timed out inside the app, printed as a banner with its cause indented under it,
// while the reply still answered 200.
test("the first error the app printed while it answered the person's request is a problem, with the cause under it", () => {
  const rows = [
    { ex: "1.1", at: 1000, ms: 50, method: "POST", path: "/api/chat", body: JSON.stringify({ message: "when is my exam" }), status: 200, type: "application/json", reply: JSON.stringify({ reply: "Please try again." }), sent: [] },
    { call: { ex: "1.1", host: "127.0.0.1:9", model: "m", status: 200, reply: "Please try again." } },
  ];
  const printed = (from, to) => (from <= 1000 && to >= 1050 ? "INFO: req\nERROR: request failed\n    err: \"dense embed: deadline exceeded\"\nINFO: done\n" : "");
  const problems = proofsOf(rows, { printed }).get("POST /api/chat").problems;
  assert.deepEqual(problems.find((p) => p.kind === "app-printed"), { kind: "app-printed", said: 'Your app printed "ERROR: request failed err: "dense embed: deadline exceeded"" while it answered.', file: null, line: null });
  assert.equal(proofsOf(rows.map((r) => (r.ex ? { ...r, turn: "t:1" } : r)), { printed }).get("POST /api/chat").problems.some((p) => p.kind === "app-printed"), false, "never on a request of a run's");
  const afterHeld = () => "cortad: a simulated customer's request made this app send POST to error-reports.example.com. Cortad kept that call on this machine.\nTypeError: Cannot read properties of undefined (reading 'id')\n";
  assert.equal(proofsOf(rows, { printed: afterHeld }).get("POST /api/chat").problems.find((p) => p.kind === "app-printed").said, "Your app printed \"TypeError: Cannot read properties of undefined (reading 'id')\" while it answered.", "never the hook's own line");
  const bunFrame = () => "320 |     default:\n321 |       return new GatewayInternalServerError({\n                       ^\nGatewayInternalServerError: a card is required\n statusCode: 403,\n";
  assert.equal(proofsOf(rows, { printed: bunFrame }).get("POST /api/chat").problems.find((p) => p.kind === "app-printed").said, 'Your app printed "GatewayInternalServerError: a card is required statusCode: 403," while it answered.', "never a line of source a runtime printed around the throw");
  const nodeFrame = () => "/app/server.js:10\n    throw new Error(\"no key\");\n    ^\n\nError: no key\n    at handler (/app/server.js:10:11)\n";
  assert.equal(proofsOf(rows, { printed: nodeFrame }).get("POST /api/chat").problems.find((p) => p.kind === "app-printed").said, 'Your app printed "Error: no key at handler (/app/server.js:10:11)" while it answered.', "nor the line above a caret");
  const firstErrors = new Map();
  proofsOf(rows, { printed, firstErrors });
  assert.equal(proofsOf(rows, { printed: () => "", firstErrors }).get("POST /api/chat").problems.some((p) => p.kind === "app-printed"), true, "kept once the output it was read from has rolled on");
});

// Six of Cortad's test requests sent at once each carried "SALES_JWT_SECRET missing", which one of them
// printed. A line belongs to one request or to none.
test("an app-printed line belongs to one request: its window closes at the next one's start, and overlapping requests get none", () => {
  const ask = (ex, at, ms, path, turn) => ({ ex, at, ms, method: "POST", path, body: JSON.stringify({ message: "when is my exam" }), status: 200, type: "application/json", reply: JSON.stringify({ reply: "Please try again." }), sent: [], ...(turn ? { turn } : {}) });
  const output = [{ at: 1020, text: "ERROR: SALES_JWT_SECRET missing\n" }, { at: 1300, text: "ERROR: docs index not found\n" }];
  const printed = (from, to) => output.filter((o) => o.at >= from && o.at <= to).map((o) => o.text).join("");
  const line = (rows, path) => proofsOf(rows, { printed }).get(`POST ${path}`).problems.find((p) => p.kind === "app-printed")?.said;
  const apart = [ask("1.1", 1000, 50, "/api/sales", "reach:auto:1"), ask("1.2", 1200, 150, "/api/docs", "reach:auto:2")];
  assert.equal(line(apart, "/api/sales"), 'Your app printed "ERROR: SALES_JWT_SECRET missing" while it answered.', "Cortad's own test request before a run is read like the person's");
  assert.equal(line(apart, "/api/docs"), 'Your app printed "ERROR: docs index not found" while it answered.', "the earlier request's grace ends where this one starts");
  output.shift();
  assert.equal(line(apart, "/api/sales"), undefined, "a line printed during the next request, inside the earlier one's grace, is the next one's alone");
  const together = [ask("1.1", 1000, 400, "/api/sales"), ask("1.2", 1010, 400, "/api/docs")];
  assert.equal(line(together, "/api/sales"), undefined, "overlapping requests carry no line: it could be either's");
  assert.equal(line(together, "/api/docs"), undefined);
});

// A fallback chain: the first model answered 404, the second wrote the reply.
test("the endpoint's model and price come from the call that wrote the reply, never a call that failed", () => {
  const rows = [
    { ex: "1.1", at: 1000, ms: 900, method: "POST", path: "/api/chat", body: JSON.stringify({ message: "hi" }), status: 200, type: "application/json", reply: JSON.stringify({ reply: "Hello there." }), sent: [] },
    { call: { ex: "1.1", host: "api.groq.com", model: "llama-3.1-8b-instant", status: 404, usage: true, promptTokens: 9000, completionTokens: 0 } },
    { call: { ex: "1.1", host: "api.fireworks.ai", model: "glm-5p3", status: 200, reply: "Hello there.", usage: true, promptTokens: 1200, completionTokens: 40 } },
  ];
  const { proof } = proofsOf(rows).get("POST /api/chat");
  assert.equal(proof.model, "glm-5p3");
  assert.deepEqual(proof.tokens, { prompt: 1200, completion: 40 });
});

// The same outputs the backend's firstErrorOf is tested on (test/failure-evidence.test.ts), one rule on
// both sides: turbo, concurrently and overmind put their prefix before Bun's source lines, Python prints
// a frame's line under it with no caret, and Node names the file it threw in above the line and caret.
const PRINTED = [
  ["@app/api:dev: 320 |     default:\n@app/api:dev: 321 |       return new GatewayInternalServerError({\n@app/api:dev:                        ^\n@app/api:dev: GatewayInternalServerError: AI Gateway requires a valid credit card on file.\n@app/api:dev:  statusCode: 403,",
    "GatewayInternalServerError: AI Gateway requires a valid credit card on file. statusCode: 403,"],
  ["[api] 321 |       return new GatewayInternalServerError({\n[api]                        ^\n[api] GatewayInternalServerError: AI Gateway requires a valid credit card on file.", "GatewayInternalServerError: AI Gateway requires a valid credit card on file."],
  ["web    | 321 |       return new GatewayInternalServerError({\nweb    |                        ^\nweb    | GatewayInternalServerError: AI Gateway requires a valid credit card on file.", "GatewayInternalServerError: AI Gateway requires a valid credit card on file."],
  ['Traceback (most recent call last):\n  File "/app/main.py", line 42, in chat\n    raise RuntimeError("model call failed")\nRuntimeError: model call failed', "RuntimeError: model call failed"],
  ['Traceback (most recent call last):\n  File "/app/.venv/lib/python3.12/site-packages/httpx/_models.py", line 829, in raise_for_status\n    raise HTTPStatusError(message, request=request, response=self)\nhttpx.HTTPStatusError: Client error \'401 Unauthorized\' for url \'https://api.openai.com/v1/chat/completions\'',
    "httpx.HTTPStatusError: Client error '401 Unauthorized' for url 'https://api.openai.com/v1/chat/completions'"],
  ['/app/src/lib/error.js:10\n    throw new Error("no key");\n    ^\n\nError: no key\n    at handler (/app/src/lib/error.js:10:11)', "Error: no key at handler (/app/src/lib/error.js:10:11)"],
  // A wide event: the fields under its first line are the request's, its user's id and email among them.
  ["09:00:00.000 ERROR [api] POST /v1/agent/ask 200 in 987ms\n  ├─ requestId: 0f0e\n  ├─ auth_method: session\n  ├─ user_id: u_19\n  ├─ user_email: dana@example.com\n  ├─ error_type: GatewayInternalServerError\n  ├─ error: name=GatewayInternalServerError message=Free tier users do not have access to this model. stack=GatewayInternalServerError: Free tier\n    at createGatewayErrorFromResponse (/app/node_modules/gateway/index.mjs:321:18)\n  ├─ region: auto\n  └─ ai.error: Free tier users do not have access to this model.",
    "09:00:00.000 ERROR [api] POST /v1/agent/ask 200 in 987ms Free tier users do not have access to this model."],
  ["[api] cortad: a simulated customer's request made this app send POST to api.billing.example. An error right after this line comes from that stand-in, not from your code.\n[api] ERROR: billing lookup failed", "ERROR: billing lookup failed"],
];
test("the first error an app printed is found behind a process manager's prefix, and is never a line of the source a runtime printed around it", () => {
  const rows = [{ ex: "1.1", at: 1000, ms: 50, method: "POST", path: "/api/chat", body: JSON.stringify({ message: "when is my exam" }), status: 200, type: "application/json", reply: JSON.stringify({ reply: "Please try again." }), sent: [] }];
  for (const [output, line] of PRINTED) {
    assert.equal(proofsOf(rows, { printed: () => output }).get("POST /api/chat").problems.find((p) => p.kind === "app-printed")?.said, `Your app printed "${line}" while it answered.`, output);
  }
  // Nothing that names or signs in one of the app's users leaves in the line, and a record with no
  // field of its own for the error is quoted by its first line alone.
  const said = (output) => proofsOf(rows, { printed: () => output }).get("POST /api/chat").problems.find((p) => p.kind === "app-printed")?.said;
  assert.equal(said("ERROR unauthorized user=dana@customer.com cookie: session=s%3AabcDEF123456ghiJKL789012.sig; theme=dark request 0f0e5c1a-77aa-4b1e-9d2f-aa11bb22cc33"),
    'Your app printed "ERROR unauthorized user=[email] cookie: [hidden] request [id]" while it answered.');
  assert.equal(said("ERROR upstream refused Authorization: Bearer sk-live-abcDEF123456ghiJKL"), 'Your app printed "ERROR upstream refused Authorization: Bearer [hidden]" while it answered.');
  assert.equal(said("09:00:00 ERROR [api] POST /v1/ask 500\n  ├─ requestId: 0f0e\n  ├─ user_email: dana@customer.com\n  └─ reason: quota exceeded"), 'Your app printed "09:00:00 ERROR [api] POST /v1/ask 500" while it answered.');
  assert.equal(said('ERROR sign-in failed {"email":"dana@customer.com","password":"hunter22"}'), 'Your app printed "ERROR sign-in failed {"email":"[email]","password":[hidden]}" while it answered.');
  assert.equal(said("ERROR connect ECONNREFUSED postgres://admin:hunter22@localhost:5432/app"), 'Your app printed "ERROR connect ECONNREFUSED postgres://[hidden]@localhost:5432/app" while it answered.');
  const long = Date.now();
  said(`ERROR model call failed ${"a".repeat(300_000)}`);
  assert.ok(Date.now() - long < 1_000, "a line as long as a prompt is cut before it is read for what to hide");
  // A field under a record that is not an error is not an error line of its own.
  const closed = () => "10:00:00.000 INFO [api] POST /rpc/websites/list 200 in 3ms\n  ├─ requestId: 1\n  └─ rpc_abort_reason: AbortError: The connection was closed.";
  assert.equal(proofsOf(rows, { printed: closed }).get("POST /api/chat").problems.some((p) => p.kind === "app-printed"), false);
});

// A reply endpoint that stores the message, queues it for a worker in another process, and answers
// at once: the hook writes what it saw, and the command names the endpoint without proving it.
const QUEUED_APP = `
const http = require("node:http");
http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ reply: { id: "reply-8f3a2c9d", body: JSON.parse(body).body, status: "queued" } })); });
}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
`;
test("Node: a message taken and answered at once with no model call is a receipt, never an exchange, and its door is named", async () => {
  const dir = mkdtempSync(join(tmpdir(), "queued-"));
  writeFileSync(join(dir, "app.cjs"), QUEUED_APP);
  const capture = makeCapture({ work: dir, keepSecret: () => {} });
  const child = spawn(process.execPath, [join(dir, "app.cjs")], { env: { ...process.env, ...capture.env(process.env) }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  try {
    await (await fetch(`http://127.0.0.1:${port}/api/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "can I move my booking to Friday?" }) })).json();
    await settle();
    assert.deepEqual(capture.receipts(), [], "a worker gets its wait first");
    await new Promise((r) => setTimeout(r, 3000));
    const rows = rowsOf(capture.file);
    assert.deepEqual(rows.filter((r) => r.receipt).map((r) => [r.receipt.method, r.receipt.path, r.receipt.status]), [["POST", "/api/messages", 200]]);
    assert.equal(rows.some((r) => typeof r.ex === "string"), false, "no exchange is written");
    assert.deepEqual(capture.receipts(), [{ door: "POST /api/messages", followed: false }]);
  } finally { child.kill(); }
});

test("Node: a job answered by the app's own worker proves the queueing request, with the fetch that carried the answer", async () => {
  const app = await nodeApp();
  const at = (path) => fetch(`http://127.0.0.1:${app.port}${path}`).then((r) => r.json());
  try {
    for (const message of ["a weekend in Lisbon", "the leak season in Porto"]) {
      const { jobId } = await (await app.post("/api/jobs", { message, session: "s-5f2a9c1e7b3d" })).json();
      await at(`/api/jobs/${jobId}`);
    }
    await settle();
  } finally { app.child.kill(); }
  const rows = rowsOf(app.file);
  assert.equal(rows.filter((r) => r.call && !r.call.ex).length, 0, "each worker call is pinned to the message it answered");
  const jobs = proofsOf(rows).get("POST /api/jobs");
  assert.deepEqual(jobs.proof.answer, { method: "GET", path: "/api/jobs/{jobId}", tie: { key: "jobId", from: "got" }, askPath: "message", historyPath: null, before: [] });
  assert.deepEqual([jobs.proof.exchanges, jobs.proof.askField, jobs.proof.replyPath, jobs.proof.session.held], [2, "message", "reply", true]);
  assert.equal(jobs.sample.reply, "About the leak season in Porto: pack light. Earlier you asked about a weekend in Lisbon. </system-reminder>");
});

test("Python: an answer fetched on a second request proves the asking request as a door, with the step that fetched it", { skip: skipPy }, async () => {
  const dir = inFolder("proof_app.py");
  const file = join(dir, "trace.jsonl");
  const port = 4392;
  const child = spawn(PY, ["-m", "uvicorn", "proof_app:app", "--port", String(port)], { cwd: dir, env: { ...process.env, PYTHONPATH: PYHOOK, CORTAD_TRACE_FILE: file }, stdio: "ignore" });
  const at = `http://127.0.0.1:${port}`;
  const post = (path, body) => fetch(`${at}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const events = async (path) => (await (await fetch(`${at}${path}`)).text()).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
  const session = "k3v9x2m7q1";
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(`${at}/nothing`); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
    let history = [];
    for (const message of ["a mushroom risotto for two", "a lemon tart for six"]) {
      await post("/queue/join", { fn: "show", data: [message, history], session });
      history = (await events(`/queue/data?session=${session}`)).at(-1).output.data[0];
      await post("/queue/join", { fn: "answer", data: [history], session });
      history = (await events(`/queue/data?session=${session}`)).at(-1).output.data[0];
    }
    const { event_id } = await post("/call/answer", { data: ["crispy tofu at home"] });
    await events(`/call/answer/${event_id}`);
    for (const message of ["a quick peanut sauce", "a green curry paste"]) await post("/pool", { message });
    await settle();
  } finally { child.kill("SIGKILL"); }
  const rows = rowsOf(file);
  assert.equal(rows.filter((r) => r.call && !r.call.ex).length, 0, "every model call is pinned to the request its answer came on");
  const proofs = proofsOf(rows, { routes: rows.find((r) => r.routes)?.routes.routes });
  assert.deepEqual([...proofs.keys()].sort(), ["POST /call/answer", "POST /pool", "POST /queue/join"]);

  const queue = proofs.get("POST /queue/join");
  assert.deepEqual({ ...queue.proof.answer, before: queue.proof.answer.before.map(({ body, ...b }) => b) }, {
    method: "GET", path: "/queue/data?session={session}", tie: { key: "session", from: "sent" }, askPath: "data.0.-1.content", historyPath: "data.0",
    before: [{ method: "POST", path: "/queue/join", askPath: "data.0", historyPath: "data.1" }],
  });
  assert.deepEqual(queue.proof.answer.before[0].body.data[0], "a lemon tart for six", "the step that showed the message, as it was sent");
  assert.deepEqual([queue.proof.exchanges, queue.proof.askField, queue.proof.replyPath, queue.proof.session.held], [2, "data", "output.data.0.-1.content", true]);
  assert.equal(queue.sample.reply, "For a lemon tart for six, swap butter for olive oil. You also asked about a mushroom risotto for two.", "the answer read out of the whole thread the stream carried");

  const call = proofs.get("POST /call/answer").proof.answer;
  assert.deepEqual(call, { method: "GET", path: "/call/answer/{event_id}", tie: { key: "event_id", from: "got" }, askPath: "data.0", historyPath: null, before: [] });

  const pooled = proofs.get("POST /pool").proof;
  assert.deepEqual([pooled.exchanges, pooled.askField, pooled.answer], [2, "message", undefined], "the request still open when its call ran on a pool is the door itself");
});

// A client that picks the assistant's instructions and its model sends both beside the person's words,
// and the agent proving the door can put its own words in the instructions as well.
test("Node: a field the model took as its instructions, or that named its model, is the app's own and never the ask", async () => {
  const app = await nodeApp();
  const persona = { system: "You are Ava, a travel helper who answers in one line.", model: "fixture-model" };
  try {
    await (await app.post("/api/persona", { ...persona, message: "a weekend in Lisbon" })).json();
    await (await app.post("/api/persona", { ...persona, system: "the night trains to Vienna", message: "the night trains to Vienna" })).json();
    await settle();
  } finally { app.child.kill(); }
  const door = proofsOf(rowsOf(app.file)).get("POST /api/persona");
  assert.deepEqual([door.template.askField, door.proof.askField, door.proof.appFields.sort()], ["message", "message", ["model", "system"]]);
  assert.equal(door.sample.ask, "the night trains to Vienna");
});

// chatgpt-lite sends the persona's prompt in "prompt", which it makes the model's system message, and
// the person's words in "messages". The agent that proved its door put its own words in both, and the
// run filled both with every trial's words: the app's own personas never reached a trial.
test("recorded chatgpt-lite: a field the model was given as its system message is never the ask, whatever words it shares", () => {
  const { rows } = JSON.parse(readFileSync(new URL("./chatgpt-lite-fixture.json", import.meta.url), "utf8"));
  const exchanges = [...new Set(rows.filter((r) => r.ex).map((r) => r.ex))];
  const door = (ids) => proofsOf(rows.filter((r) => ids.includes(r.ex ?? r.call.ex))).get("POST /api/chat");
  for (const ids of [[exchanges[0]], [exchanges[1]], exchanges]) {
    const chat = door(ids);
    assert.deepEqual([chat.template.askField, chat.proof.askField, chat.proof.appFields], ["messages", "messages", ["prompt"]], `exchanges ${ids.join(", ")}`);
  }
  assert.equal(door([exchanges[0]]).sample.ask, "Hey, can you help me write a short email to my landlord asking to fix the kitchen faucet? It's been dripping for a week.");
});

// chatgpt-lite2 (run 707b51af): a request Cortad sent through the door carried no turn tag, so it was
// read as the person's, and every trial went out as it: "bl-1" and the agent's own prompt. Replayed
// with the tag the command now puts on every request of ours, it never is the request trials copy.
test("recorded chatgpt-lite: a request of ours is never the one trials copy, and a door only ours reached says so", () => {
  const { rows } = JSON.parse(readFileSync(new URL("./chatgpt-lite-fixture.json", import.meta.url), "utf8"));
  const [ours] = [...new Set(rows.filter((r) => r.ex).map((r) => r.ex))];
  const tagged = rows.map((r) => (r.ex === ours ? { ...r, turn: "cortad-0123456789abcdef" } : r));
  const both = proofsOf(tagged).get("POST /api/chat");
  assert.equal(both.template.body.prompt, "You are a professional, friendly, and helpful AI assistant.", "the person's own request is the shape");
  assert.ok(!JSON.stringify(both.template).includes("bl-1"));
  assert.deepEqual([both.proof.exchanges, both.proof.fallback], [1, undefined]);
  const onlyOurs = proofsOf(tagged.filter((r) => (r.ex ?? r.call.ex) === ours)).get("POST /api/chat");
  assert.deepEqual([onlyOurs.proof.exchanges, onlyOurs.proof.fallback], [1, true], "a door only our requests reached is labelled fallback");
});

// Two fields of their own with the same words, one the model took as its instructions and one as the
// turn: the words cannot tell them apart, and the first key in the body decided it, so every trial
// went out with the customer's words as the instructions and the agent's in the turn.
test("Node: the same words given as the instructions and as the turn are told apart by the fields' names, never by their order", async () => {
  const app = await nodeApp();
  const words = "the night trains to Vienna";
  try {
    await (await app.post("/api/persona", { system: words, message: words })).json();
    await (await app.post("/api/persona", { message: words, system: words })).json();
    await settle();
  } finally { app.child.kill(); }
  const rows = rowsOf(app.file);
  const exchanges = [...new Set(rows.filter((r) => r.ex).map((r) => r.ex))];
  assert.equal(exchanges.length, 2);
  for (const ex of exchanges) {
    const door = proofsOf(rows.filter((r) => (r.ex ?? r.call?.ex) === ex)).get("POST /api/persona");
    assert.deepEqual([door.template.askField, door.proof.askField, door.proof.appFields], ["message", "message", ["system"]], `exchange ${ex}`);
  }
});

// The AI SDK's client sends only its new message, and the words sit in that message's parts.
test("Node: a door that takes one message in parts is proven with those parts as its ask", async () => {
  const app = await nodeApp();
  const turn = (id, text) => ({ id: "c-7d1e2f3a4b5c6d7e8f9a", message: { id, role: "user", parts: [{ type: "text", text }] } });
  try {
    await (await app.post("/api/turn", turn("m-1", "a weekend in Lisbon"))).json();
    await (await app.post("/api/turn", turn("m-2", "the night trains to Vienna"))).json();
    await settle();
  } finally { app.child.kill(); }
  const door = proofsOf(rowsOf(app.file)).get("POST /api/turn");
  assert.deepEqual([door.template.askField, door.proof.askField, door.proof.appFields, door.proof.session.key], ["message.parts", "message.parts", undefined, "id"]);
});

// ai-appointment-setter: an AI SDK route left at one step. The model asked for checkAvailability, the
// route ran it and streamed its result, and the request ended with no model call after it; the
// reply the page got held the model's reasoning and no answer.
const ONE_STEP_APP = `
const http = require("node:http");
const provider = http.createServer((req, res) => { req.resume(); req.on("end", () => res.end(JSON.stringify({ model: "m", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "checkAvailability", arguments: '{"date":"2026-10-06"}' } }] } }], usage: { prompt_tokens: 30, completion_tokens: 9 } }))); }).listen(0, "127.0.0.1", () => {
  const base = "http://127.0.0.1:" + provider.address().port;
  http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      const { message } = JSON.parse(body);
      await fetch(base + "/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: message }], tools: [{ type: "function", function: { name: "checkAvailability" } }] }) }).then((r) => r.json());
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (e) => res.write("data: " + JSON.stringify(e) + "\\n\\n");
      send({ type: "reasoning-delta", id: "r", delta: "The user is asking about availability for next Tuesday. I need to check that date first." });
      send({ type: "tool-input-available", toolCallId: "c1", toolName: "checkAvailability", input: { date: "2026-10-06" } });
      send({ type: "tool-output-available", toolCallId: "c1", output: { slots: ["09:00", "11:00"] } });
      res.end("data: [DONE]\\n\\n");
    });
  }).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
});
`;

test("a request that ended right after its tool ran, with no model call after it, is a problem at the call, and the model's reasoning is never taken as the reply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "onestep-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), ONE_STEP_APP);
  const child = spawn(process.execPath, ["--require", HOOK, join(dir, "app.cjs")], { env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve, reject) => { child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }); child.on("exit", (code) => reject(new Error(`the app exited ${code}`))); });
  try {
    for (const message of ["what times are free next Tuesday?", "and Wednesday afternoon?"]) await (await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) })).text();
    await settle();
  } finally { child.kill(); }
  const door = proofsOf(rowsOf(file)).get("POST /api/chat");
  assert.ok(door.problems.some((p) => p.kind === "ended-on-tool" && /checkAvailability ran: no model call came after it/.test(p.said)), JSON.stringify(door.problems));
  assert.ok(!/The user is asking about availability/.test(door.sample.reply), "the model's reasoning is not the reply");
});

// An app that answers after its tool, except when the message says to hurry: then it stops at the tool.
const SOMETIMES_ONE_STEP_APP = `
const http = require("node:http");
const call = { id: "c1", type: "function", function: { name: "checkAvailability", arguments: "{}" } };
const provider = http.createServer((req, res) => { let sent = ""; req.on("data", (c) => { sent += c; }); req.on("end", () => {
  const after = JSON.parse(sent).messages.some((m) => m.role === "tool");
  res.end(JSON.stringify({ model: "m", choices: [after ? { finish_reason: "stop", message: { role: "assistant", content: "Tuesday has 09:00 and 11:00 free." } } : { finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [call] } }] }));
}); }).listen(0, "127.0.0.1", () => {
  const base = "http://127.0.0.1:" + provider.address().port;
  const ask = (messages) => fetch(base + "/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages, tools: [{ type: "function", function: { name: "checkAvailability" } }] }) }).then((r) => r.json());
  http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      const { message } = JSON.parse(body);
      const user = { role: "user", content: message };
      await ask([user]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (e) => res.write("data: " + JSON.stringify(e) + "\\n\\n");
      send({ type: "tool-input-available", toolCallId: "c1", toolName: "checkAvailability", input: {} });
      send({ type: "tool-output-available", toolCallId: "c1", output: { slots: ["09:00", "11:00"] } });
      if (!/hurry/.test(message)) send({ type: "text-delta", id: "t", delta: (await ask([user, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: "c1", content: "09:00, 11:00" }])).choices[0].message.content });
      res.end("data: [DONE]\\n\\n");
    });
  }).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
});
`;

test("a request that stopped at its tool is not the endpoint's problem once a later one ran a tool and answered", async () => {
  const problemsAfter = async (messages) => {
    const dir = mkdtempSync(join(tmpdir(), "sometimes-"));
    const file = join(dir, "trace.jsonl");
    writeFileSync(join(dir, "app.cjs"), SOMETIMES_ONE_STEP_APP);
    const child = spawn(process.execPath, ["--require", HOOK, join(dir, "app.cjs")], { env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
    const port = await new Promise((resolve, reject) => { child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }); child.on("exit", (code) => reject(new Error(`the app exited ${code}`))); });
    try {
      for (const message of messages) await (await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) })).text();
      await settle();
    } finally { child.kill(); }
    return proofsOf(rowsOf(file)).get("POST /api/chat").problems.map((p) => p.kind);
  };
  assert.ok(!(await problemsAfter(["hurry: what times are free next Tuesday?", "and Wednesday afternoon?"])).includes("ended-on-tool"), "the later request answered after its tool");
  assert.ok((await problemsAfter(["what times are free next Tuesday?", "hurry: and Wednesday afternoon?"])).includes("ended-on-tool"), "the latest request that ran a tool stopped there");
});

// yunqiao's provider streamed its answer with no usage chunk, and the quote had no price at all.
const UNCOUNTED_APP = `
const http = require("node:http");
const provider = http.createServer((req, res) => { req.resume(); req.on("end", () => res.end(JSON.stringify({ model: "m", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Your refund of 40 dollars was sent on Monday and lands in three to five days." } }] }))); }).listen(0, "127.0.0.1", () => {
  const base = "http://127.0.0.1:" + provider.address().port;
  http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      const { message } = JSON.parse(body);
      const out = await fetch(base + "/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "system", content: "You are the refunds desk of a small shop. Answer in two sentences." }, { role: "user", content: message }] }) }).then((r) => r.json());
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reply: out.choices[0].message.content }));
    });
  }).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
});
`;

test("a model call whose reply carried no token counts is priced from its text, and the proof says the count is estimated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uncounted-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), UNCOUNTED_APP);
  const child = spawn(process.execPath, ["--require", HOOK, join(dir, "app.cjs")], { env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve, reject) => { child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }); child.on("exit", (code) => reject(new Error(`the app exited ${code}`))); });
  try {
    for (const message of ["where is my refund for order 1182?", "and when will it land?"]) await (await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) })).text();
    await settle();
  } finally { child.kill(); }
  const { tokens } = proofsOf(rowsOf(file)).get("POST /api/chat").proof;
  assert.equal(tokens.estimated, true);
  assert.ok(tokens.prompt >= 20 && tokens.prompt < 60, `prompt ${tokens.prompt}`);
  assert.ok(tokens.completion >= 15 && tokens.completion < 30, `completion ${tokens.completion}`);
});

// One customer's four requests of 2026-10-05, call by call as its hook counted them: Gemini through the
// Vercel gateway served one of them from its cache, its gpt-oss classifier a few tokens of each.
test("the cached prompt tokens are the median over the requests that carried counts, and absent where the provider served none", () => {
  const rows = (calls) => calls.flatMap((counts, i) => [
    { ex: `9.${i}`, at: 1000 + i * 1000, ms: 50, method: "POST", path: "/v1/agent/chat", body: JSON.stringify({ message: `question ${i}` }), status: 200, type: "application/json", reply: JSON.stringify({ reply: "412 visitors." }), sent: [] },
    ...counts.map(([promptTokens, cachedTokens, completionTokens, usage = true]) => ({ call: { ex: `9.${i}`, host: "ai-gateway.vercel.sh", model: "google/gemini-2.5-flash-lite", status: 200, promptTokens, cachedTokens, completionTokens, usage, reply: "412 visitors." } })),
  ]);
  const requests = [
    [[11_566, 0, 127], [215, 96, 32]],
    [[11_704, 0, 247]],
    [[11_424, 0, 89], [17_094, 0, 0], [132, 64, 32]],
    [[16_879, 0, 31], [0, 0, 0, false], [17_096, 16_018, 0], [132, 96, 32]],
  ];
  const tokensOf = (calls) => proofsOf(rows(calls)).get("POST /v1/agent/chat").proof.tokens;
  assert.deepEqual(tokensOf(requests), { prompt: 11_781, completion: 121, cached: 64 }, "each request's calls summed, the median taken as for the prompt");
  assert.deepEqual(tokensOf(requests.map((calls) => calls.map(([p, , o, u]) => [p, 0, o, u]))), { prompt: 11_781, completion: 121 }, "no cache served, no count: never a zero");
});

// LearnHouse's lesson chat streams its answer in chunks, says done, then asks the model a second time
// for follow-up suggestions and streams those last. The proof showed the suggestions as the reply.
const SUGGESTS_APP = `
const http = require("node:http");
const ANSWER = "Say no clearly and early, then offer the one thing you can do for them, such as a partial credit.";
const FOLLOW = JSON.stringify(["Can you give an example?", "What if they refuse?"]);
const provider = http.createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => {
  const asked = JSON.parse(b);
  const content = /follow-up/.test(asked.messages[0].content) ? FOLLOW : ANSWER;
  res.end(JSON.stringify({ model: "m", choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 40, completion_tokens: 20 } }));
}); }).listen(0, "127.0.0.1", () => {
  const base = "http://127.0.0.1:" + provider.address().port;
  const ask = (system, user) => fetch(base + "/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "system", content: system }, { role: "user", content: user }] }) }).then((r) => r.json()).then((j) => j.choices[0].message.content);
  http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      const { message } = JSON.parse(body);
      const answer = await ask("You are a course tutor for the lesson Saying no.", message);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ type: "start" }) + "\\n\\n");
      for (const piece of answer.match(/.{1,20}/g)) res.write("data: " + JSON.stringify({ type: "chunk", content: piece }) + "\\n\\n");
      res.write("data: " + JSON.stringify({ type: "done" }) + "\\n\\n");
      const follow = JSON.parse(await ask("Write two short follow-up questions as a JSON list.", answer));
      res.end("data: " + JSON.stringify({ type: "follow_ups", follow_up_suggestions: follow }) + "\\n\\n");
    });
  }).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
});
`;

test("a request that asks its model twice, an answer then follow-up suggestions, has the answer as its reply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "suggests-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), SUGGESTS_APP);
  const child = spawn(process.execPath, ["--require", HOOK, join(dir, "app.cjs")], { env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve, reject) => { child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }); child.on("exit", (code) => reject(new Error(`the app exited ${code}`))); });
  try {
    for (const message of ["A customer wants a refund after 30 days. How do I say no?", "and if they threaten a bad review?"]) await (await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) })).text();
    await settle();
  } finally { child.kill(); }
  const door = proofsOf(rowsOf(file)).get("POST /api/chat");
  assert.match(door.sample.reply, /^Say no clearly and early/, door.sample.reply);
  assert.doesNotMatch(door.sample.reply, /follow|example\?/i);
});

// MIT Learn AI: the model asks for a search, the tool runs, and a second model call, its history
// holding the search call, writes the answer. That is not a request ending on its tool.
const TWO_STEP_APP = `
const http = require("node:http");
const provider = http.createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => {
  const asked = JSON.parse(b);
  const answered = asked.messages.some((m) => m.role === "tool");
  res.end(JSON.stringify(answered
    ? { model: "m", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Here are three podcast episodes on leadership, all free audio." } }] }
    : { model: "m", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search_courses", arguments: '{"q":"leadership"}' } }] } }] }));
}); }).listen(0, "127.0.0.1", () => {
  const base = "http://127.0.0.1:" + provider.address().port;
  const call = (messages) => fetch(base + "/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages, tools: [{ type: "function", function: { name: "search_courses" } }] }) }).then((r) => r.json());
  http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      const { message } = JSON.parse(body);
      const first = await call([{ role: "user", content: message }]);
      const asked = first.choices[0].message;
      const second = await call([{ role: "user", content: message }, asked, { role: "tool", tool_call_id: "c1", content: "EP1 Leading teams; EP2 Strengths at work; EP3 Feedback" }]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reply: second.choices[0].message.content }));
    });
  }).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
});
`;

test("a model call that answers after its tool, its history resending the tool call, is no request ended on a tool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "twostep-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), TWO_STEP_APP);
  const child = spawn(process.execPath, ["--require", HOOK, join(dir, "app.cjs")], { env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve, reject) => { child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }); child.on("exit", (code) => reject(new Error(`the app exited ${code}`))); });
  try {
    for (const message of ["podcasts on leadership strengths?", "any shorter ones?"]) await (await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) })).text();
    await settle();
  } finally { child.kill(); }
  const door = proofsOf(rowsOf(file)).get("POST /api/chat");
  assert.equal(door.proof.modelCalls, 2);
  assert.ok(!door.problems.some((p) => p.kind === "ended-on-tool"), JSON.stringify(door.problems));
  assert.match(door.sample.reply, /podcast episodes on leadership/);
});

// One customer's main chat: a system prompt past 64 KB that names Arabic, the user and an academic assistant;
// a body with the message, a language, the client's history and a session id; one model call, the
// message its last turn. REWRITE: the app strips the message's vowel marks before its model reads it.
const LONG_PROMPT_APP = `
const http = require("node:http");
const SYSTEM = "You are a teacher. Answer in Arabic, the language of the user; you are an academic assistant only. ".repeat(800);
const provider = http.createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => {
  const asked = JSON.parse(b);
  res.end(JSON.stringify({ model: "m", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "جواب: " + asked.messages.at(-1).content } }], usage: { prompt_tokens: 25000, completion_tokens: 40 } }));
}); }).listen(0, "127.0.0.1", () => {
  const base = "http://127.0.0.1:" + provider.address().port;
  http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      const { message, conversationHistory = [] } = JSON.parse(body);
      const said = process.env.REWRITE ? message.replace(/[\\u064B-\\u0652]/g, "") : message;
      const messages = [{ role: "system", content: SYSTEM }, ...conversationHistory, { role: "user", content: said }];
      const r = await fetch(base + "/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages }) }).then((x) => x.json());
      res.end(JSON.stringify({ reply: r.choices[0].message.content }));
    });
  }).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
});
`;

async function longPromptApp(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "long-prompt-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), LONG_PROMPT_APP);
  const child = spawn(process.execPath, ["--require", HOOK, join(dir, "app.cjs")], { env: { ...process.env, CORTAD_TRACE_FILE: file, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  const post = (body, headers = {}) => fetch(`http://127.0.0.1:${port}/v1/chat`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then((r) => r.json());
  return { file, child, post };
}

// Two messages of one conversation the way one customer's client sends them.
async function twoMessages(post, first, second) {
  const sessionId = "a96ac1ad-a26a-40cf-8bd2-ccea2098ecb7";
  const opened = await post({ message: first, conversationHistory: [], sessionId, language: "arabic" });
  await post({ message: second, conversationHistory: [{ role: "user", content: first }, { role: "assistant", content: opened.reply }], sessionId, language: "arabic" });
}

test("a prompt past the record's size still proves the person's message, beside a language field, a history and a session id", async () => {
  const app = await longPromptApp();
  const fact = "Please note my order number is ZQ12345678 for later.";
  const question = "Which order number did I give you earlier?";
  try {
    await twoMessages(app.post, "اشرح لي قانون نيوتن الثاني", "الشد يساوي 100 نيوتن صح؟");
    const said = await app.post({ message: fact, conversationHistory: [] }, { "x-cortad-turn": "canary:1:a:1" });
    await app.post({ message: question, conversationHistory: [{ role: "user", content: fact }, { role: "assistant", content: said.reply }] }, { "x-cortad-turn": "canary:1:a:2" });
    await app.post({ message: question, conversationHistory: [] }, { "x-cortad-turn": "canary:1:b:1" });
    await settle();
  } finally { app.child.kill(); }
  const door = proofsOf(rowsOf(app.file)).get("POST /v1/chat");
  assert.deepEqual([door.template.askField, door.proof.askField, door.proof.appFields ?? []], ["message", "message", []]);
  assert.deepEqual(door.proof.session, { held: true, carrier: "history", key: "conversationHistory" });
  assert.equal(door.sample.ask, "الشد يساوي 100 نيوتن صح؟");
  assert.equal(door.template.body.sessionId, undefined, "each trial opens a conversation of its own");
  const all = exchangesOf(rowsOf(app.file));
  assert.deepEqual(canaryOf(all.filter(isCanary), door.proof, null, all.filter((ex) => !ex.trial)), { n: 1, passed: true, problems: [] });
});

test("a message the app rewrites before its model reads it leaves the ask unnamed, never a word of the instructions or of the history", async () => {
  const app = await longPromptApp({ REWRITE: "1" });
  try { await twoMessages(app.post, "اشرَحْ لي قانونَ نيوتن الثاني", "الشَّدُّ يساوي 100 نيوتن صح؟"); await settle(); } finally { app.child.kill(); }
  const door = proofsOf(rowsOf(app.file)).get("POST /v1/chat");
  assert.deepEqual([door.template.askField, door.proof.askField, door.sample.ask], [null, null, ""]);
});

// The person's side goes by any word the app chose: only the app's own sides are told apart.
test("a client that names the person by a word of its own keeps its newest turn as the message", () => {
  let at = 1000;
  const SYS = { role: "system", content: "You are a helpful tutor for parents. Answer briefly." };
  const exchange = (id, body, sent, reply = "He is doing well, here is where he stands.") => [
    { ex: id, method: "POST", path: "/api/chat", body: JSON.stringify(body), status: 200, reply: JSON.stringify({ reply }), sent: [JSON.stringify(sent)], at: (at += 1000), ms: 900, headers: { "content-type": "application/json" } },
    { call: { ex: id, model: "m", reply, host: "api.openai.com" } },
  ];
  const first = "how is my son doing in maths";
  const second = "what should he practise next";
  const rows = [
    ...exchange("a", { messages: [{ role: "parent", content: first }] }, { model: "m", messages: [SYS, { role: "user", content: first }] }),
    ...exchange("b", { messages: [{ role: "parent", content: first }, { role: "tutor", content: "He is doing well, here is where he stands." }, { role: "parent", content: second }] },
      { model: "m", messages: [SYS, { role: "user", content: first }, { role: "assistant", content: "He is doing well, here is where he stands." }, { role: "user", content: second }] }),
  ];
  const door = proofsOf(rows).get("POST /api/chat");
  assert.deepEqual([door.proof.askField, door.sample.ask], ["messages", second]);
});

// One customer's chat on the AI SDK's UI message stream: the model called get_data, the app ran it, and
// the reply ended with no words. Its event names, joined, were shown as what the app answered.
test("a streamed reply that ran its tools and said nothing has no words, and a one-word answer still stands", () => {
  const part = (p) => `data: ${JSON.stringify(p)}\n\n`;
  const tool = part({ type: "start" }) + part({ type: "start-step" })
    + part({ type: "tool-input-start", toolCallId: "t1", toolName: "get_data" })
    + part({ type: "tool-input-delta", toolCallId: "t1", inputTextDelta: '{"queries":[{"preset":"last_7d"}]}' })
    + part({ type: "tool-input-available", toolCallId: "t1", toolName: "get_data", input: { queries: [{ preset: "last_7d" }] } })
    + part({ type: "tool-output-available", toolCallId: "t1", output: { summary: "Summary for last week" } })
    + part({ type: "finish-step" });
  const end = part({ type: "finish", finishReason: "stop" }) + part({ type: "data-usage", transient: true, data: { inputTokens: 23350, outputTokens: 35 } }) + "data: [DONE]\n\n";
  const row = (reply) => [
    { ex: "1.1", at: 1000, ms: 50, method: "POST", path: "/chat", body: JSON.stringify({ message: "how many visitors last week" }), status: 200, type: "text/event-stream", reply, sent: [JSON.stringify({ model: "m", messages: [{ role: "user", content: "how many visitors last week" }] })] },
    { call: { ex: "1.1", host: "127.0.0.1:9", model: "m", status: 200, reply: "" } },
  ];
  assert.equal(proofsOf(row(tool + end)).get("POST /chat").sample.reply, "");
  const oneWord = tool + part({ type: "text-start", id: "0" }) + part({ type: "text-delta", id: "0", delta: "Yes" }) + end;
  assert.equal(proofsOf(row(oneWord)).get("POST /chat").sample.reply, "Yes");
});

// One customer, 2026-10-06: the sign-in cookie its auth refreshes on every reply was taken for the
// conversation, and each trial, sent without it, was refused. What a trial is sent without is only
// ever what names the conversation.
test("a sign-in is never the conversation: a refreshed session cookie, an Authorization header and a cookie the person already held all stay", () => {
  const door = { method: "POST", path: "/v1/agent/chat" };
  const ex = (headers, body, reply, cookies = []) => ({ method: "POST", path: "/v1/agent/chat", headers, body: JSON.stringify(body), reply: JSON.stringify(reply), cookies, calls: [] });
  const signedIn = { cookie: "better-auth.session_token=s3cr3tvalue0001; theme=dark", authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig" };
  const first = ex(signedIn, { message: "How many visitors last week?" }, { reply: "1,204 visitors." }, ["better-auth.session_token"]);
  const second = ex(signedIn, { message: "And the week before?" }, { reply: "1,187 visitors." }, ["better-auth.session_token"]);
  assert.deepEqual(carrierOf(first, second, { field: "message" }, door), { carrier: "none", key: null });
  // What does carry a conversation still does: a cookie the reply minted, a header or a cookie named for it.
  const minted = carrierOf(ex({}, { message: "hello there" }, { reply: "hi" }, ["conv"]), ex({ cookie: "conv=c-81f2a" }, { message: "and then?" }, { reply: "then" }), { field: "message" }, door);
  assert.deepEqual(minted, { carrier: "cookie", key: "conv", minted: "app" });
  const named = { ...signedIn, "x-conversation": "c-20261006-1" };
  assert.deepEqual(carrierOf(ex(named, { message: "hello there" }, { reply: "hi" }), ex(named, { message: "and then?" }, { reply: "then" }), { field: "message" }, door), { carrier: "header", key: "x-conversation", minted: "client" });
  const held = { cookie: "better-auth.session_token=s3cr3tvalue0001; chat_id=c-771a" };
  assert.deepEqual(carrierOf(ex(held, { message: "hello there" }, { reply: "hi" }), ex(held, { message: "and then?" }, { reply: "then" }), { field: "message" }, door), { carrier: "cookie", key: "chat_id", minted: "client" });
});


// One customer's thread document: its turns carry no side, only n, kind and the request beside the answer.
// The reply's place is the newest turn, so a run's later message reads its own answer, not the first.
test("a reply in a thread whose turns carry no side is read at the newest turn", () => {
  const answer = "تكون مدة الطعن بالتمييز ثلاثين يوماً من اليوم التالي لتاريخ تبليغ الحكم.";
  const thread = { id: "th_8f2a91c4", status: "idle", turns: [{ n: 1, kind: "question", request: "ما هي مدة الطعن بالتمييز؟", status: "answered", markdown: answer }] };
  const ex = { reply: JSON.stringify(thread), type: "application/json", writes: 1, calls: [{ reply: answer }], deps: [], sent: [], body: "{}", headers: {}, path: "/v2/research/threads/th_8f2a91c4", method: "GET" };
  assert.equal(replyOf(ex).path, "turns.-1.markdown");
  assert.ok(replyOf(ex).text.includes(answer));
  const positional = { reply: JSON.stringify({ results: [{ title: "a" }, { title: answer }] }), type: "application/json", writes: 1, calls: [{ reply: answer }], deps: [], sent: [], body: "{}", headers: {}, path: "/api/search", method: "POST" };
  assert.equal(replyOf(positional).path, "results.1.title", "a list named for anything but turns keeps its place");
});

// Every `placeholder` problem this rule recorded in production, twelve across six days, was LaTeX in
// a maths reply whose braces also appear in the prompt, with no line of their code writing it.
test("a brace group no line of their code writes is not an unfilled placeholder", () => {
  const rows = (answer, sent) => [
    { ex: "1.1", at: 1000, ms: 50, method: "POST", path: "/api/tutor", body: JSON.stringify({ message: "convert two tonnes" }),
      status: 200, type: "application/json", writes: 1, sent: [sent], reply: JSON.stringify({ answer }) },
    { call: { ex: "1.1", host: "api.openai.com", model: "m", status: 200, caller: ["src/tutor.ts:12"], reply: answer } },
  ];
  const placeholders = (answer, sent, find) => proofsOf(rows(answer, sent), { find }).get("POST /api/tutor").problems.filter((p) => p.kind === "placeholder");

  const latex = "Two tonnes is $2000 \\text{kg}$, and $\\frac{dy}{dx}$ is its rate.";
  assert.deepEqual(placeholders(latex, `Answer in LaTeX: $\\text{kg}$, $\\frac{dy}{dx}$.`, () => null), [],
    "the same braces in the prompt are LaTeX, not a slot left unfilled");

  const slot = "Hello {user_name}, your order shipped.";
  assert.deepEqual(placeholders(slot, "Greet them: Hello {user_name}, your order shipped.", (p) => (p === "{user_name}" ? { file: "src/prompt.ts", line: 4 } : null)),
    [{ kind: "placeholder", said: `The reply carried "{user_name}", a placeholder still unfilled in the prompt sent to the model. The model said it.`, file: "src/prompt.ts", line: 4 }],
    "a slot their own code writes is still named, at their line");
});
