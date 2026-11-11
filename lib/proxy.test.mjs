import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { homeOf, projectOf } from "./home.mjs";
import { openProxy } from "./proxy.mjs";

// An app the hook cannot load into, seen through the local proxy instead: a Node app started with
// no hook stands in for Go, Ruby or Java, its model on a provider of the test's own, and our API a
// stand-in that hands out jobs and keeps what comes back. The whole command, as a person runs it.
const LOCAL = join(dirname(fileURLToPath(import.meta.url)), "..", "local.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (done, ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await done()) return true; return done(); };
const KEY = "sk-proxytest-4f9a8b7c6d5e4f3a2b1c";
const FACT = "Please note my order number is ZQ48213907 for later.";
const QUESTION = "Which order number did I give you earlier?";

// Reads its model's address from OPENAI_BASE_URL, as every SDK does, and its key from its env file.
const APP = (port, modelUrl = "process.env.OPENAI_BASE_URL") => `
  require("node:http").createServer(async (req, res) => {
    if (req.method !== "POST") return res.end("ok");
    let body = "";
    for await (const d of req) body += d;
    const message = JSON.parse(body || "{}").message ?? "";
    const got = await fetch(${modelUrl} + "/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + process.env.OPENAI_API_KEY },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "system", content: "You help with travel plans and nothing else." }, { role: "user", content: message }] }) }).then((r) => r.json());
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ reply: got.choices[0].message.content }));
  }).listen(${port}, "127.0.0.1");
`;

async function listening(handler) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}
const bodyOf = async (req) => { let body = ""; for await (const d of req) body += d; return body; };

// The provider: answers with the person's own words in it, and counts what it was sent.
async function provider() {
  const heard = [];
  const server = await listening(async (req, res) => {
    const body = JSON.parse(await bodyOf(req));
    heard.push({ path: req.url, auth: req.headers.authorization });
    const asked = body.messages.at(-1).content;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: "gpt-test", choices: [{ message: { role: "assistant", content: `About ${asked}: pack light.` }, finish_reason: "stop" }], usage: { prompt_tokens: 21, completion_tokens: 6 } }));
  });
  return { server, heard };
}

// Our API: attach, upload, the app's port, proofs, and jobs handed out to the command.
async function api() {
  const queued = [];
  const results = new Map();
  const proofs = [];
  const apps = [];
  const server = await listening(async (req, res) => {
    const body = await bodyOf(req);
    const reply = (data) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/local/attach") return reply({ box: "lo_000000000000000000000003", key: "k" });
    if (req.url.includes("/tree")) return reply({ id: "c", resumed: true });
    if (req.url.endsWith("/app")) { apps.push(JSON.parse(body)); return reply({ ok: true }); }
    if (req.url.endsWith("/proof")) { proofs.push(JSON.parse(body)); return reply({ ok: true }); }
    if (req.url === "/api/mcp/status") return reply({ repository: { name: "travel-go" }, run: null });
    const done = /\/jobs\/([\w-]+)$/.exec(req.url);
    if (done) { results.set(done[1], JSON.parse(body || "{}")); return reply({ ok: true }); }
    if (req.url.includes("/jobs")) { await until(() => queued.length > 0, 500); return reply({ jobs: queued.splice(0) }); }
    reply({ ok: true });
  });
  let n = 0;
  const give = (body) => { const id = `j${++n}`; queued.push({ id, verb: "fetch", body }); return id; };
  return { server, proofs, apps, results, give };
}

// A repository in a folder of its own, its app on a free port, connected by its stored key.
async function connect({ files, start, providerPort, apiPort, modelUrl, app = APP, bin = "" }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cortad-proxy-")));
  const probe = await listening(() => {});
  const appPort = probe.address().port;
  probe.close();
  writeFileSync(join(root, "app.js"), app(appPort, modelUrl));
  writeFileSync(join(root, ".env"), `OPENAI_BASE_URL=http://127.0.0.1:${providerPort}/v1\nOPENAI_API_KEY=${KEY}\n`);
  for (const [name, text] of Object.entries(files)) { writeFileSync(join(root, name), text); chmodSync(join(root, name), 0o755); }
  const home = mkdtempSync(join(tmpdir(), "cortad-proxy-home-"));
  mkdirSync(homeOf(projectOf(root), join(home, ".cortad")), { recursive: true });
  writeFileSync(join(homeOf(projectOf(root), join(home, ".cortad")), "token"), "machine-key");
  // The app's settings are in the terminal the command runs from, as they are where the person starts it; its .env is read by the app's own loader, never by the command.
  const env = { PATH: `${bin ? `${bin}:` : ""}/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: tmpdir(), CORTAD_ORIGIN: `http://127.0.0.1:${apiPort}`, OPENAI_BASE_URL: `http://127.0.0.1:${providerPort}/v1`, OPENAI_API_KEY: KEY };
  const child = spawn(process.execPath, [LOCAL, "--token", "--start", start], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const trace = () => { try { return readFileSync(join(tmpdir(), `cortad-${child.pid}`, "trace.jsonl"), "utf8"); } catch { return ""; } };
  const rows = () => trace().trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const status = () => promisify(execFile)(process.execPath, [LOCAL, "status"], { cwd: root, env }).then((r) => r.stdout);
  const stop = async () => { child.kill("SIGTERM"); await once(child, "exit"); };
  return { root, appPort, child, out: () => out, trace, rows, status, stop };
}

const frontOf = (out) => Number(/send requests to port (\d+)/.exec(out)?.[1]);

test("an app the hook cannot load into is seen through the proxy: the agent's request proves its endpoint, a run's conversation gets its reply, and the canary passes", { timeout: 90_000 }, async () => {
  const model = await provider();
  const ours = await api();
  // Started behind a shell, as a runtime the hook has no loader for would be: the hook never enters the app.
  const app = await connect({ files: { "go.mod": "module travel\n" }, start: `sh -c '"${process.execPath}" app.js'`, providerPort: model.server.address().port, apiPort: ours.server.address().port });
  try {
    assert.ok(await until(() => /your app is answering on port/.test(app.out()) && frontOf(app.out()), 30_000), app.out());
    const front = frontOf(app.out());
    assert.notEqual(front, app.appPort);
    assert.match(app.out(), /seen through a local proxy on this machine/);
    assert.deepEqual([ours.apps.at(-1).port, ours.apps.at(-1).proves], [front, true], "the run is told the front's port, and that requests there prove an endpoint");

    // The agent's one real request, sent where the command said.
    const said = await fetch(`http://127.0.0.1:${front}/chat`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer person-9e8d7c6b5a4f3e2d1c0b" }, body: JSON.stringify({ message: "a weekend in Lisbon" }) }).then((r) => r.json());
    assert.equal(said.reply, "About a weekend in Lisbon: pack light.");
    assert.ok(await until(() => ours.proofs.length > 0, 10_000), app.out());
    const proof = ours.proofs.at(-1);
    assert.deepEqual([proof.door, proof.template.body, proof.proof.exchanges, proof.proof.modelCalls, proof.proof.model, proof.proof.askField, proof.proof.host],
      [{ method: "POST", path: "/chat" }, { message: "a weekend in Lisbon" }, 1, 1, "gpt-test", "message", "127.0.0.1"]);
    assert.deepEqual(proof.proof.tokens, { prompt: 21, completion: 6 });
    assert.equal(proof.sample.reply, "About a weekend in Lisbon: pack light.");

    // The model call, its instructions told apart from the person's words, pinned to the request.
    const exchange = app.rows().find((r) => r.ex && r.path === "/chat");
    const call = app.rows().find((r) => r.call)?.call;
    assert.deepEqual([call.ex, call.host, call.status, call.instructions, call.reply], [exchange.ex, `127.0.0.1:${model.server.address().port}`, 200, "You help with travel plans and nothing else.", "About a weekend in Lisbon: pack light."]);
    assert.equal(model.heard[0].auth, `Bearer ${KEY}`, "the provider got the app's own key");
    assert.ok(!app.trace().includes(KEY), "no header value of the model call is written");

    // A run's conversation through the job the run hands the command.
    const trial = ours.give({ port: front, path: "/chat", method: "POST", headers: { "content-type": "application/json", "x-cortad-turn": "case-1:1" }, body: JSON.stringify({ message: "the night trains to Vienna" }) });
    assert.ok(await until(() => ours.results.has(trial), 10_000), app.out());
    assert.deepEqual([ours.results.get(trial).status, JSON.parse(ours.results.get(trial).body).reply], [200, "About the night trains to Vienna: pack light."]);
    assert.ok(await until(() => app.rows().some((r) => r.call?.turn === "case-1:1"), 5000), "the run's model call is pinned to its turn");

    // The canary as the backend sends it: a fact, the second turn of that conversation, a new one.
    for (const [turn, message] of [["a:1", FACT], ["a:2", QUESTION], ["b:1", QUESTION]]) {
      const id = ours.give({ port: front, path: "/chat", method: "POST", headers: { "content-type": "application/json", "x-cortad-turn": `canary:7:${turn}` }, body: JSON.stringify({ message }) });
      assert.ok(await until(() => ours.results.has(id), 10_000), app.out());
    }
    assert.ok(await until(() => ours.proofs.some((p) => p.proof.canary), 10_000), app.out());
    assert.deepEqual(ours.proofs.findLast((p) => p.proof.canary).proof.canary, { n: 7, passed: true, problems: [] });

    const status = await app.status();
    assert.doesNotMatch(status, /no model call came through/);
    assert.match(status, new RegExp(`App: answering on port ${front}\\.`));
    assert.match(status, new RegExp(`Model calls are seen through a local proxy, so the line of code that made each call is not known\\. Send requests to port ${front}; requests sent straight to your app on port ${app.appPort} are not seen\\.`));
  } finally {
    await app.stop();
    for (const s of [ours.server, model.server]) { s.closeAllConnections(); s.close(); }
  }
});

test("a Node app the hook could not load into, started by a shell script, is started again behind the proxy", { timeout: 90_000 }, async () => {
  const model = await provider();
  const ours = await api();
  // A package.json says Node, so the hook is tried first; the script starts the app without it.
  const app = await connect({
    files: { "package.json": JSON.stringify({ name: "travel", version: "1.0.0" }), "serve.sh": `#!/bin/sh\nexec env -u NODE_OPTIONS "${process.execPath}" app.js\n` },
    start: "./serve.sh", providerPort: model.server.address().port, apiPort: ours.server.address().port,
  });
  try {
    assert.ok(await until(() => frontOf(app.out()), 45_000), app.out());
    const front = frontOf(app.out());
    await fetch(`http://127.0.0.1:${front}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "a weekend in Lisbon" }) });
    assert.ok(await until(() => ours.proofs.length > 0, 10_000), app.out());
    assert.deepEqual([ours.proofs.at(-1).proof.modelCalls, ours.proofs.at(-1).proof.model], [1, "gpt-test"]);
  } finally {
    await app.stop();
    for (const s of [ours.server, model.server]) { s.closeAllConnections(); s.close(); }
  }
});

test("an app whose model calls do not go through its model settings is told which request showed it, and how to have its calls seen", { timeout: 90_000 }, async () => {
  const model = await provider();
  const ours = await api();
  const app = await connect({ files: { "Cargo.toml": "[package]\nname = \"travel\"\n" }, start: `sh -c '"${process.execPath}" app.js'`, providerPort: model.server.address().port, apiPort: ours.server.address().port, modelUrl: `"http://127.0.0.1:${model.server.address().port}/v1"` });
  try {
    assert.ok(await until(() => frontOf(app.out()), 30_000), app.out());
    await fetch(`http://127.0.0.1:${frontOf(app.out())}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "a weekend in Lisbon" }) });
    assert.ok(await until(() => /no model call came through the proxy/.test(app.out()), 10_000), app.out());
    assert.match(app.out(), /A request to POST \/chat was answered in words and no model call came through the proxy\. If that endpoint uses a model, your app's model calls do not go through OPENAI_BASE_URL/);
    assert.match(await app.status(), /A request to POST \/chat was answered in words and no model call came through the proxy\. If that endpoint uses a model, your app's model calls do not go through OPENAI_BASE_URL \(or ANTHROPIC_BASE_URL or GOOGLE_GEMINI_BASE_URL\): have it take its model's address from that setting, then save\./);
  } finally {
    await app.stop();
    for (const s of [ours.server, model.server]) { s.closeAllConnections(); s.close(); }
  }
});

// Sends a person to sign in first, as a Rails app does: /chat builds the address from the Host it was
// sent, /ask from its own port, as an app that keeps its address in its settings does.
const SIGN_IN_APP = (port) => `
  const own = "http://127.0.0.1:${port}";
  require("node:http").createServer(async (req, res) => {
    let body = "";
    for await (const d of req) body += d;
    const path = req.url.split("?")[0];
    if (path === "/login") { res.writeHead(302, { "set-cookie": "session=s1; Path=/; HttpOnly", location: "/" }); return res.end(); }
    if (!/session=s1/.test(req.headers.cookie || "")) { res.writeHead(302, { location: (path === "/ask" ? own : "http://" + req.headers.host) + "/login" }); return res.end(); }
    if (req.method !== "POST") return res.end("ok");
    const message = JSON.parse(body || "{}").message ?? "";
    const got = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + process.env.OPENAI_API_KEY },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: message }] }) }).then((r) => r.json());
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ reply: got.choices[0].message.content, host: req.headers.host }));
  }).listen(${port}, "127.0.0.1");
`;

test("an app that sends a person to sign in first gets its session through the proxy, whichever port its redirect names", { timeout: 90_000 }, async () => {
  const model = await provider();
  const ours = await api();
  const app = await connect({ files: { Gemfile: "source 'https://rubygems.org'\n" }, start: `sh -c '"${process.execPath}" app.js'`, providerPort: model.server.address().port, apiPort: ours.server.address().port, app: SIGN_IN_APP });
  try {
    assert.ok(await until(() => frontOf(app.out()), 30_000), app.out());
    const front = frontOf(app.out());
    for (const [path, turn] of [["/chat", "case-1:1"], ["/ask", "case-2:1"]]) {
      const id = ours.give({ port: front, path, method: "POST", headers: { "content-type": "application/json", "x-cortad-turn": turn }, body: JSON.stringify({ message: "a weekend in Lisbon" }) });
      assert.ok(await until(() => ours.results.has(id), 10_000), app.out());
      const got = ours.results.get(id);
      assert.equal(got.status, 200, `${path}: ${JSON.stringify(got)}`);
      assert.deepEqual(JSON.parse(got.body), { reply: "About a weekend in Lisbon: pack light.", host: `127.0.0.1:${front}` }, "the app is sent the Host its caller used");
    }
    assert.doesNotMatch(app.out(), /no model call came through/);
  } finally {
    await app.stop();
    for (const s of [ours.server, model.server]) { s.closeAllConnections(); s.close(); }
  }
});

test("an app started in a container is not started again behind the proxy, since its settings do not reach the container", { timeout: 90_000 }, async () => {
  const model = await provider();
  const ours = await api();
  // A docker that runs the app on this machine without the hook, and counts how often it was started.
  const bin = mkdtempSync(join(tmpdir(), "cortad-proxy-bin-"));
  writeFileSync(join(bin, "docker"), `#!/bin/sh\necho up >> starts\nexec env -u NODE_OPTIONS "${process.execPath}" app.js\n`);
  chmodSync(join(bin, "docker"), 0o755);
  const app = await connect({ files: { "package.json": JSON.stringify({ name: "travel", version: "1.0.0" }) }, start: "docker compose up", providerPort: model.server.address().port, apiPort: ours.server.address().port, bin });
  try {
    assert.ok(await until(() => frontOf(app.out()), 45_000), app.out());
    assert.equal(readFileSync(join(app.root, "starts"), "utf8"), "up\n", app.out());
  } finally {
    await app.stop();
    for (const s of [ours.server, model.server]) { s.closeAllConnections(); s.close(); }
  }
});

// A server on 127.0.0.1 for one test, closed with the proxy.
const served = async (handler) => { const s = await listening(handler); return { s, url: `http://127.0.0.1:${s.address().port}` }; };
const UNSEEN_WAIT = 3500;

test("a request is said unseen only when it was answered in words, its own words in, and no model call began", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cortad-proxy-unseen-"));
  const replies = {
    "/login": [200, { message: "Signed in successfully" }],
    "/conversations": [201, { id: "c_12345678", title: "New chat" }],
    "/queue": [202, { status: "queued", id: "job_123456" }],
    "/chat": [200, { reply: "A weekend in Lisbon starts at the castle." }],
  };
  const app = await served(async (req, res) => {
    await bodyOf(req);
    const [status, body] = replies[req.url];
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const said = [];
  const proxy = await openProxy({ file: join(dir, "trace.jsonl"), rulesFile: join(dir, "rules.json"), target: () => ({ host: "127.0.0.1", port: app.s.address().port }), onUnseen: (door) => said.push(door) });
  const post = (path, body) => fetch(`http://127.0.0.1:${proxy.port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.text());
  try {
    await post("/login", { email: "ana@example.com", password: "hunter22" });
    await post("/conversations", { title: "New chat" });
    await post("/queue", { message: "a weekend in Lisbon" });
    await sleep(UNSEEN_WAIT);
    assert.deepEqual(said, [], "a sign-in, a new conversation and a message taken for later say nothing about the model");
    await post("/chat", { message: "a weekend in Lisbon" });
    await sleep(UNSEEN_WAIT);
    assert.deepEqual(said, ["POST /chat"]);
  } finally {
    proxy.close();
    app.s.closeAllConnections(); app.s.close();
  }
});

test("a chat whose page answers at once and whose model is called just after is not said unseen", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cortad-proxy-later-"));
  const model = await provider();
  let base = "";
  // A Rails chat: the page shows the person's message at once, and a job asks the model after.
  const app = await served(async (req, res) => {
    const { message } = JSON.parse(await bodyOf(req));
    res.writeHead(200, { "content-type": "text/vnd.turbo-stream.html" });
    res.end(`<turbo-stream action="append" target="messages"><template><p>${message}</p><p>Thinking about it now.</p></template></turbo-stream>`);
    await sleep(500);
    await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: message }] }) });
  });
  const said = [];
  const proxy = await openProxy({ file: join(dir, "trace.jsonl"), rulesFile: join(dir, "rules.json"), target: () => ({ host: "127.0.0.1", port: app.s.address().port }), onUnseen: (door) => said.push(door) });
  base = proxy.env({ OPENAI_BASE_URL: `http://127.0.0.1:${model.server.address().port}/v1` }).OPENAI_BASE_URL;
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "a weekend in Lisbon" }) }).then((r) => r.text());
    await sleep(UNSEEN_WAIT);
    assert.deepEqual([said, proxy.seen(), model.heard.length], [[], true, 1]);
  } finally {
    proxy.close();
    for (const s of [app.s, model.server]) { s.closeAllConnections(); s.close(); }
  }
});

test("a streamed model call the app stops reading is stopped at the provider too", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cortad-proxy-abort-"));
  let cut = null;
  const upstream = await served(async (req, res) => {
    await bodyOf(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.on("close", () => { cut = !res.writableFinished; });
    for (let i = 0; i < 60 && !res.destroyed; i++) { res.write(`data: {"choices":[{"delta":{"content":"word ${i} "}}]}\n\n`); await sleep(50); }
    res.end();
  });
  const proxy = await openProxy({ file: join(dir, "trace.jsonl"), rulesFile: join(dir, "rules.json"), target: () => ({ host: "127.0.0.1", port: 1 }) });
  const { OPENAI_BASE_URL } = proxy.env({ OPENAI_BASE_URL: `${upstream.url}/v1` });
  try {
    const stop = new AbortController();
    const got = await fetch(`${OPENAI_BASE_URL}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "a weekend in Lisbon" }] }), signal: stop.signal });
    const reader = got.body.getReader();
    await reader.read();
    stop.abort();
    assert.ok(await until(() => cut !== null, 1500), "the provider's stream was closed before its end");
    assert.equal(cut, true);
  } finally {
    proxy.close();
    upstream.s.closeAllConnections(); upstream.s.close();
  }
});

test("each model setting of the app is pointed at the proxy, and only those", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cortad-proxy-env-"));
  const proxy = await openProxy({ file: join(dir, "trace.jsonl"), rulesFile: join(dir, "rules.json"), target: () => ({ host: "127.0.0.1", port: 1 }) });
  try {
    const env = proxy.env({ ANTHROPIC_BASE_URL: "https://gateway.example.com/anthropic", LLM_BASE_URL: "https://api.fireworks.ai/inference/v1", QDRANT_URL: "http://localhost:6333", OPENAI_API_KEY: "https://api.openai.com/not-a-url-setting", HOME: "/x" });
    const here = `http://127.0.0.1:${proxy.modelPort}/u/`;
    const { HTTPS_PROXY, https_proxy, NO_PROXY, no_proxy, ...models } = env;
    assert.deepEqual(Object.keys(models).sort(), ["ANTHROPIC_BASE_URL", "GOOGLE_GEMINI_BASE_URL", "LLM_BASE_URL", "OPENAI_BASE_URL"]);
    assert.ok(Object.values(models).every((v) => v.startsWith(here)));
    assert.equal(new Set(Object.values(models)).size, 4, "each upstream has a place of its own");
    assert.equal(HTTPS_PROXY, `http://127.0.0.1:${proxy.modelPort}`);
    assert.equal(https_proxy, HTTPS_PROXY);
    assert.equal(no_proxy, NO_PROXY);
    assert.match(NO_PROXY, /127\.0\.0\.1/);
    assert.equal(proxy.env({ HTTPS_PROXY: "http://corp:3128" }).HTTPS_PROXY, undefined, "a proxy of the app's own stays");
  } finally { proxy.close(); }
});

// A Go or Rust app with its provider's address in its code, or a Bedrock call signed with SigV4: the
// TLS goes through HTTPS_PROXY sealed, so the call is seen and every byte arrives as the app signed it.
test("a call through HTTPS_PROXY is tunnelled byte for byte, and a model host's tunnel counts as seen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cortad-proxy-tunnel-"));
  let seen = 0;
  const proxy = await openProxy({ file: join(dir, "trace.jsonl"), rulesFile: join(dir, "rules.json"), target: () => ({ host: "127.0.0.1", port: 1 }), onSeen: () => { seen += 1; } });
  const { connect } = await import("node:net");
  const tunnel = (to, send) => new Promise((resolve) => {
    const s = connect(proxy.modelPort, "127.0.0.1", () => s.write(`CONNECT ${to} HTTP/1.1\r\nHost: ${to}\r\n\r\n`));
    let got = "";
    s.on("data", (c) => { got += c; if (/^HTTP\/1\.1 200[^]*\r\n\r\n$/.test(got) && send) { s.write(send); send = null; } });
    s.on("close", () => resolve(got));
    s.on("error", () => resolve(got));
    setTimeout(() => s.destroy(), 3000).unref();
  });
  let heard = null;
  const signed = await listening(async (req, res) => { heard = { host: req.headers.host, auth: req.headers.authorization, body: await bodyOf(req) }; res.end("ok"); });
  try {
    const at = `127.0.0.1:${signed.address().port}`;
    const request = `POST /model/x/converse HTTP/1.1\r\nHost: bedrock-runtime.us-east-1.amazonaws.com\r\nAuthorization: AWS4-HMAC-SHA256 Signature=ab12\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`;
    assert.match(await tunnel(at, request), /200 Connection Established[^]*ok$/);
    assert.deepEqual(heard, { host: "bedrock-runtime.us-east-1.amazonaws.com", auth: "AWS4-HMAC-SHA256 Signature=ab12", body: "{}" });
    assert.equal(seen, 0, "a tunnel to a host that is not a model's is not a model call");
    await tunnel("bedrock-runtime.us-east-1.amazonaws.com:443");
    assert.equal(seen, 1);
    assert.equal(proxy.seen(), true);
  } finally { proxy.close(); signed.close(); }
});

test("an app that names its own model setting is pointed at the proxy too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cortad-proxy-model-"));
  const proxy = await openProxy({ file: join(dir, "trace.jsonl"), rulesFile: join(dir, "rules.json"), target: () => ({ host: "127.0.0.1", port: 1 }) });
  try {
    // One customer's own setting: not an SDK's name, and the only address its model is reached at.
    const env = proxy.env({ MODEL_ENDPOINT: "http://127.0.0.1:11434", MODEL_NAME: "qwen3:4b", DATA_DIR: ".data" });
    assert.ok(env.MODEL_ENDPOINT?.startsWith(`http://127.0.0.1:${proxy.modelPort}/u/`), "the model address is taken over");
    assert.equal(env.MODEL_NAME, undefined, "a setting that names a model rather than addressing one is left alone");
    assert.equal(env.DATA_DIR, undefined);
  } finally { proxy.close(); }
});

test("a streamed Anthropic call passes through as it streams, and its row carries the words, the counts and the instructions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cortad-proxy-stream-"));
  const events = [
    { type: "message_start", message: { model: "claude-test", usage: { input_tokens: 30, output_tokens: 1 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Pack " } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "light." } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
  ];
  const anthropic = await listening(async (req, res) => {
    await bodyOf(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const e of events) { res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); await sleep(20); }
    res.end();
  });
  const proxy = await openProxy({ file: join(dir, "trace.jsonl"), rulesFile: join(dir, "rules.json"), target: () => ({ host: "127.0.0.1", port: app.address().port }) });
  const { ANTHROPIC_BASE_URL } = proxy.env({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${anthropic.address().port}` });
  // The app passes the model's stream straight on to its own caller.
  const app = await listening(async (req, res) => {
    const { message } = JSON.parse(await bodyOf(req));
    const got = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ model: "claude-test", stream: true, max_tokens: 200, system: "Answer in one line.", messages: [{ role: "user", content: message }] }) });
    res.writeHead(200, { "content-type": "text/event-stream" });
    for await (const c of got.body) res.write(c);
    res.end();
  });
  try {
    const got = await fetch(`http://127.0.0.1:${proxy.port}/api/stream`, { method: "POST", headers: { "content-type": "application/json", "x-cortad-turn": "case-2:1" }, body: JSON.stringify({ message: "what to pack for Oslo" }) });
    const pieces = [];
    for await (const c of got.body) pieces.push(Buffer.from(c).toString("utf8"));
    assert.ok(pieces.length > 1, "the reply arrived as it streamed");
    assert.match(pieces.join(""), /"text":"light\."/);
    await sleep(100);
    const rows = readFileSync(join(dir, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const exchange = rows.find((r) => r.ex);
    const { call } = rows.find((r) => r.call);
    assert.deepEqual([exchange.path, exchange.turn, JSON.parse(exchange.sent[0]).messages[0].content], ["/api/stream", "case-2:1", "what to pack for Oslo"]);
    assert.deepEqual([call.ex, call.turn, call.model, call.promptTokens, call.completionTokens, call.reply, call.instructions], [exchange.ex, "case-2:1", "claude-test", 30, 4, "Pack light.", "Answer in one line."]);
    assert.ok(!readFileSync(join(dir, "trace.jsonl"), "utf8").includes(KEY));
  } finally {
    proxy.close();
    for (const s of [app, anthropic]) { s.closeAllConnections(); s.close(); }
  }
});
