import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { homeOf, projectOf } from "./home.mjs";

// music-store-support, 2026-09-29 (job 1c7500f0): a Gradio app, whose queue serves one event at a
// time and keeps an event after its caller leaves. The run ended with requests the command still held
// open there, the agent saved a fix, and its own test chat waited five minutes behind the backlog on
// the old code. Here the whole command runs against an app built the same way: its own queue, one at
// a time, started outside every request, its model on a server of the test's. A stand-in for our API
// hands the command its jobs, as the bus does, and records what comes back.
const LOCAL = join(dirname(fileURLToPath(import.meta.url)), "..", "local.mjs");
const NODE = process.execPath;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (done, ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await done()) return true; return done(); };
const linesOf = (file) => { try { return readFileSync(file, "utf8").split("\n").filter(Boolean); } catch { return []; } };

// `slowMs`: what a message with "slow" in it waits before its model call, in this version of the code.
// The port is set in the code, as a real app sets its own.
const appCode = (version, slowMs, port) => `
  const fs = require("node:fs");
  fs.appendFileSync(process.env.STARTS, "start\\n");
  const queue = [];
  let busy = false;
  setInterval(async () => {
    if (busy || !queue.length) return;
    busy = true;
    const { message, res } = queue.shift();
    if (message.includes("slow")) await new Promise((r) => setTimeout(r, ${slowMs}));
    const got = await fetch(process.env.MODEL_URL, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: message }] }) }).then((r) => r.json());
    res.end(JSON.stringify({ reply: "${version} " + got.choices[0].message.content }));
    busy = false;
  }, 20);
  require("node:http").createServer((req, res) => {
    if (req.url !== "/chat") return res.end("ok");
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const message = JSON.parse(body || "{}").message ?? "";
      fs.appendFileSync(process.env.ASKED, message + "\\n");
      res.on("close", () => { if (!res.writableFinished) fs.appendFileSync(process.env.LEFT, message + "\\n"); });
      queue.push({ message, res });
    });
  }).listen(${port}, "127.0.0.1");
`;

// The same shape of app with no queue: each request is served as it comes, side by side with any
// other, in three model calls one after another, and goes on after its caller leaves.
const sideCode = (version, slowMs, port) => `
  const fs = require("node:fs");
  fs.appendFileSync(process.env.STARTS, "start\\n");
  const ask = (content) => fetch(process.env.MODEL_URL, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content }] }) }).then((r) => r.json());
  require("node:http").createServer(async (req, res) => {
    if (req.url !== "/chat") return res.end("ok");
    let body = "";
    for await (const d of req) body += d;
    const message = JSON.parse(body || "{}").message ?? "";
    fs.appendFileSync(process.env.ASKED, message + "\\n");
    res.on("close", () => { if (!res.writableFinished) fs.appendFileSync(process.env.LEFT, message + "\\n"); });
    if (message.includes("slow")) await new Promise((r) => setTimeout(r, ${slowMs}));
    let said = message;
    for (let i = 0; i < 3; i++) said = (await ask(said)).choices[0].message.content;
    res.end(JSON.stringify({ reply: "${version} " + said }));
  }).listen(${port}, "127.0.0.1");
`;

// An app that takes `bootMs` to listen, answering with its version and the words of a second source
// file; "broken" throws as it starts.
const bootCode = (version, bootMs, port) => `
  require("node:fs").appendFileSync(process.env.STARTS, "start\\n");
  ${version === "broken" ? 'throw new Error("broken on purpose");' : ""}
  const words = require("./words.js");
  setTimeout(() => require("node:http").createServer((req, res) => res.end("${version} " + words)).listen(${port}, "127.0.0.1"), ${bootMs});
`;

// Their model provider: each call answered after `ms`, recorded with when it came.
async function model(ms) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body).messages?.[0]?.content ?? "";
    calls.push({ message, at: Date.now() });
    setTimeout(() => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ model: "m", choices: [{ message: { role: "assistant", content: `answer to ${message}` } }] })); }, ms);
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, calls, close: () => { server.closeAllConnections(); server.close(); } };
}

// Our API's side: the connect, and a job poll that hands out what the test queues.
async function wire() {
  const queued = [];
  const results = new Map();
  const posted = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    posted.push(req.url);
    const reply = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/local/attach") return reply(200, { box: "lo_000000000000000000000001", key: "k" });
    if (req.url.includes("/tree")) return reply(200, { id: "c", resumed: true });
    if (req.url.endsWith("/app")) return reply(200, { jobId: "raise" });
    const done = /\/jobs\/([\w-]+)$/.exec(req.url);
    if (done) { results.set(done[1], JSON.parse(body || "{}")); return reply(200, { ok: true }); }
    if (req.url.includes("/jobs")) {
      await until(() => queued.length > 0, 500);
      return reply(200, { jobs: queued.splice(0) });
    }
    return reply(200, { ok: true });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  let n = 0;
  const give = (verb, body) => { const id = `j${++n}`; queued.push({ id, verb, body }); return id; };
  return { port: server.address().port, give, results, posted, close: () => { server.closeAllConnections(); server.close(); } };
}

async function freePort() {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

async function repo(ai, code = appCode) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cortad-slow-")));
  const port = await freePort();
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "slow", version: "1.0.0" }));
  writeFileSync(join(root, "app.js"), code("v1", 40_000, port));
  const home = mkdtempSync(join(tmpdir(), "cortad-slow-home-"));
  const base = join(home, ".cortad");
  mkdirSync(homeOf(projectOf(root), base), { recursive: true });
  writeFileSync(join(homeOf(projectOf(root), base), "token"), "machine-key");
  const at = (name) => join(home, name);
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, TMPDIR: tmpdir(), MODEL_URL: ai.url, STARTS: at("starts"), ASKED: at("asked"), LEFT: at("left") };
  const save = (version, slowMs) => writeFileSync(join(root, "app.js"), code(version, slowMs, port));
  return { root, port, env, save, starts: () => linesOf(env.STARTS).length, asked: () => linesOf(env.ASKED), left: () => linesOf(env.LEFT) };
}

function command(r, api) {
  const child = spawn(NODE, [LOCAL, "--token", "--start", `"${NODE}" app.js`], { cwd: r.root, env: { ...r.env, CORTAD_ORIGIN: `http://127.0.0.1:${api.port}` }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const port = () => Number(/your app is answering on port (\d+)/.exec(out)?.[1]);
  return { child, out: () => out, port };
}

// A turn of the run, asked through the command the way a world asks: its port, its path, its tag.
const ask = (api, c, message, turn) => api.give("fetch", {
  port: c.port(), path: "/chat", method: "POST", headers: { "content-type": "application/json", "x-cortad-turn": turn }, body: JSON.stringify({ message }), waitMs: 120_000,
});

describe("a simulation meets an app that serves one request at a time", { concurrency: true }, () => {
  test("requests the simulation gives up on are cancelled at the app, and a queue that keeps them anyway is said once with the count", { timeout: 90_000 }, async () => {
    const ai = await model(1500);
    const api = await wire();
    const r = await repo(ai);
    const c = command(r, api);
    try {
      assert.ok(await until(() => c.port() > 0, 30_000), c.out());
      const jobs = [1, 2, 3, 4].map((i) => ask(api, c, `question number ${i} about my invoices`, `trial-${i}:1`));
      assert.ok(await until(() => r.asked().length === 4 && ai.calls.length === 1, 10_000), "all four are at the app, the first with its model");
      for (const id of jobs) api.give("cancel", { id });
      assert.ok(await until(() => jobs.every((id) => api.results.has(id)), 10_000), "every cancelled request comes back");
      for (const id of jobs) assert.deepEqual(api.results.get(id), { error: "cancelled by the run" });
      assert.ok(await until(() => r.left().length === 4, 5000), `the app saw all four callers leave (${r.left().length})`);
      // This app's queue works through them anyway, and the hook in it sees the next one reach its
      // model: three were still waiting in it, the fourth was already at work.
      const kept = /your app took up a request after the simulation cancelled it: its own queue keeps requests after the caller leaves, so up to 3 the simulation cancelled may be ahead of anything sent to your app until they are done or your app restarts/;
      assert.ok(await until(() => kept.test(c.out()), 15_000), c.out());

      // A save starts it again at once, since nothing of the run is still waiting on it: the backlog goes with the old process.
      r.save("v2", 0);
      assert.ok(await until(() => r.starts() === 2, 20_000), c.out());
      const calls = ai.calls.length;
      await sleep(4000);
      assert.ok(ai.calls.length <= calls + 1, `the old backlog stopped reaching the model after the restart (${ai.calls.length - calls} more)`);
      assert.equal(c.out().match(/your app took up a request after the simulation cancelled it/g)?.length, 1, "said once");
    } finally { c.child.kill("SIGTERM"); await once(c.child, "exit"); api.close(); ai.close(); }
  });

  test("a save restarts an app that does not reload, after a bounded wait for a request still open, which is sent again and answered by the saved code", { timeout: 90_000 }, async () => {
    const ai = await model(300);
    const api = await wire();
    const r = await repo(ai);
    const c = command(r, api);
    try {
      assert.ok(await until(() => c.port() > 0, 30_000), c.out());
      // Forty seconds on the old code, longer than a restart waits for it.
      const job = ask(api, c, "a slow question about my invoices", "trial-9:1");
      assert.ok(await until(() => r.asked().length === 1, 10_000));
      const saved = Date.now();
      r.save("v2", 0);
      assert.ok(await until(() => /starting your app again so it runs the code you saved/.test(c.out()), 10_000), c.out());
      assert.ok(await until(() => r.starts() === 2, 40_000), c.out());
      const waited = Date.now() - saved;
      assert.ok(waited >= 15_000 && waited < 35_000, `the restart waited for the open request, then went ahead (${waited} ms)`);
      assert.ok(await until(() => api.results.has(job), 20_000), c.out());
      const got = api.results.get(job);
      assert.equal(got.status, 200, JSON.stringify(got));
      assert.equal(JSON.parse(got.body).reply, "v2 answer to a slow question about my invoices");
      assert.equal(got.heldForRestart, true);
    } finally { c.child.kill("SIGTERM"); await once(c.child, "exit"); api.close(); ai.close(); }
  });

  // Said to an app with no queue, the line blamed it for something that was not happening.
  const QUEUE_LINE = /your app took up a request after the simulation cancelled it/;

  test("an app with no queue that goes on with a request it was already answering is never said to have a queue", { timeout: 60_000 }, async () => {
    const ai = await model(1500);
    const api = await wire();
    const r = await repo(ai, sideCode);
    const c = command(r, api);
    try {
      assert.ok(await until(() => c.port() > 0, 30_000), c.out());
      const job = ask(api, c, "question one about my invoices", "trial-1:1");
      assert.ok(await until(() => ai.calls.length === 1, 10_000), "at its first model call");
      api.give("cancel", { id: job });
      assert.ok(await until(() => api.results.has(job), 10_000), c.out());
      assert.deepEqual(api.results.get(job), { error: "cancelled by the run" });
      // It makes its second and third calls after the cancel, as an app with no queue does.
      assert.ok(await until(() => ai.calls.length === 3, 10_000), `the app went on (${ai.calls.length} calls)`);
      await sleep(6000);
      assert.doesNotMatch(c.out(), QUEUE_LINE);
    } finally { c.child.kill("SIGTERM"); await once(c.child, "exit"); api.close(); ai.close(); }
  });

  test("an app seen answering two requests at once is never said to have a queue, even for a request cancelled before its first model call", { timeout: 60_000 }, async () => {
    const ai = await model(800);
    const api = await wire();
    const r = await repo(ai, sideCode);
    r.save("v1", 4000);
    const c = command(r, api);
    try {
      assert.ok(await until(() => c.port() > 0, 30_000), c.out());
      const pair = [ask(api, c, "question one about my invoices", "trial-1:1"), ask(api, c, "question two about my invoices", "trial-2:1")];
      assert.ok(await until(() => pair.every((id) => api.results.get(id)?.status === 200), 15_000), c.out());
      // Four seconds of its own work before the model, and cancelled in them.
      const job = ask(api, c, "a slow question about my invoices", "trial-3:1");
      assert.ok(await until(() => r.asked().length === 3, 10_000));
      api.give("cancel", { id: job });
      assert.ok(await until(() => api.results.has(job), 10_000), c.out());
      assert.ok(await until(() => ai.calls.length === 9, 20_000), `the app went on (${ai.calls.length} calls)`);
      await sleep(6000);
      assert.doesNotMatch(c.out(), QUEUE_LINE);
    } finally { c.child.kill("SIGTERM"); await once(c.child, "exit"); api.close(); ai.close(); }
  });

  test("a second file saved while the command brings back an app that crashed waits for that start, then starts it once more", { timeout: 150_000 }, async () => {
    const ai = await model(10);
    const api = await wire();
    const r = await repo(ai);
    const write = (name, text) => writeFileSync(join(r.root, name), text);
    write("app.js", bootCode("v1", 0, r.port));
    write("words.js", 'module.exports = "first words";');
    const c = command(r, api);
    const answer = () => fetch(`http://127.0.0.1:${r.port}/`).then((res) => res.text()).catch(() => "");
    try {
      assert.ok(await until(() => c.port() > 0, 30_000), c.out());
      write("app.js", bootCode("broken", 0, r.port));
      assert.ok(await until(() => /your app did not come back/.test(c.out()), 60_000), c.out());
      // The fix takes eight seconds to listen; the second file is saved while it does.
      const before = c.out().length;
      write("app.js", bootCode("v2", 8000, r.port));
      await sleep(4500);
      write("words.js", 'module.exports = "second words";');
      assert.ok(await until(() => /your app is answering again/.test(c.out().slice(before)), 30_000), c.out());
      assert.ok(await until(async () => (await answer()) === "v2 second words", 40_000), c.out());
      const after = c.out().slice(before);
      assert.doesNotMatch(after, /did not come back/, after);
      assert.match(after, /starting your app again so it runs the code you saved/);
      assert.ok(api.posted.findLastIndex((u) => u.endsWith("/app")) > api.posted.findLastIndex((u) => u.endsWith("/stopped")), "the screen was told the app answers after it was told it stopped");
    } finally { c.child.kill("SIGTERM"); await once(c.child, "exit"); api.close(); ai.close(); }
  });
});
