// The states where nothing was tested. Each one of these shipped wrong once: offline sent the
// schema it promised not to, and an app that never answered exited clean.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { MESSAGE } from "../lib/schema.mjs";
import { MESSAGES, multiTurn } from "../lib/play.mjs";

const run = promisify(execFile);
const CLI = new URL("../bin/cortad.mjs", import.meta.url).pathname;

const schemaAt = (dir, url) => {
  writeFileSync(join(dir, "cortad.json"), JSON.stringify({
    app: "a support assistant for a shoe store",
    endpoint: { url, method: "POST", body: { text: MESSAGE }, reply: "reply" },
    rules: ["never promise a refund past 30 days"],
  }));
  return dir;
};

const cortad = (dir, args, env = {}) =>
  run("node", [CLI, ...args], { cwd: dir, env: { ...process.env, CORTAD_HOME: dir, NO_COLOR: "1", ...env } })
    .then((r) => ({ ...r, code: 0 }))
    .catch((e) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code }));

test("offline sends nothing and writes nothing, instead of writing simulations over the wire", async () => {
  const dir = schemaAt(mkdtempSync(join(tmpdir(), "cortad-gate-")), "http://127.0.0.1:1/chat");
  let reached = false;
  const spy = createServer((_req, res) => { reached = true; res.writeHead(500); res.end("{}"); });
  await new Promise((d) => spy.listen(0, "127.0.0.1", d));

  const { stderr, code } = await cortad(dir, ["plan"], {
    CORTAD_OFFLINE: "1",
    CORTAD_ORIGIN: `http://127.0.0.1:${spy.address().port}`,
  });
  spy.close();

  assert.equal(reached, false, "offline must not call the hosted side at all");
  assert.equal(code, 1);
  assert.match(stderr, /Nothing was sent/);
});

test("an app that never answers fails the command, so a dead app cannot pass a gate", async () => {
  const dir = schemaAt(mkdtempSync(join(tmpdir(), "cortad-gate-")), "http://127.0.0.1:1/chat");
  const hosted = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/users"
      ? { cases: [{ id: "a", title: "t", turns: ["hi"], questions: [{ ask: "did it answer", answer: "yes" }] }] }
      : { answers: [] }));
  });
  await new Promise((d) => hosted.listen(0, "127.0.0.1", d));

  const at = { CORTAD_ORIGIN: `http://127.0.0.1:${hosted.address().port}` };
  await cortad(dir, ["plan", "-n", "1"], at);
  const { stdout, code } = await cortad(dir, ["--full"], at);
  hosted.close();

  assert.equal(code, 1, "zero conversations answered is not a pass");
  assert.match(stdout, /Your app answered none of them/);
  assert.match(stdout, /POST http:\/\/127\.0\.0\.1:1\/chat is not answering.*Is your app up\?/);
});

test("help and version answer instead of complaining about a missing config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cortad-gate-"));
  for (const args of [["--help"], ["-h"], ["help"]]) {
    const { stdout, code } = await cortad(dir, args);
    assert.equal(code, 0, `${args} should exit clean`);
    assert.match(stdout, /says what your change did/);
  }
  const { stdout, code } = await cortad(dir, ["--version"]);
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("an endpoint that keeps its own history by thread is multi-turn", () => {
  assert.equal(multiTurn({ url: "http://x/chat", body: { text: MESSAGE } }), false);
  assert.equal(multiTurn({ url: "http://x/chat", body: { text: MESSAGE, thread: "{{thread}}" } }), true);
  assert.equal(multiTurn({ url: "http://x/chat/{{thread}}", body: { text: MESSAGE } }), true);
  assert.equal(multiTurn({ url: "http://x/chat", body: { messages: MESSAGES } }), true);
});

test("a thread app gets every turn on one thread, and no history array it never asked for", async () => {
  const seen = [];
  const app = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      seen.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reply: "ok" }));
    });
  });
  await new Promise((d) => app.listen(0, "127.0.0.1", d));
  const { playCase } = await import("../lib/play.mjs");
  const endpoint = { url: `http://127.0.0.1:${app.address().port}/chat`, method: "POST", headers: {}, body: { text: MESSAGE, thread: "{{thread}}" }, reply: "reply" };
  const played = await playCase(endpoint, { id: "a", title: "t", turns: ["one", "two", "three"] });
  app.close();

  assert.equal(played.transcript.length, 6, "three turns, three replies");
  assert.deepEqual(seen.map((s) => s.text), ["one", "two", "three"]);
  assert.equal(new Set(seen.map((s) => s.thread)).size, 1, "one thread for the whole conversation");
  assert.ok(seen.every((s) => !("messages" in s)), "an app that did not ask for history is not sent any");
});
