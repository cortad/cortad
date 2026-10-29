// The states where nothing was tested. Each one of these shipped wrong once: offline sent the
// schema it promised not to, and an app that never answered exited clean.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { MESSAGE, MESSAGES } from "../lib/schema.mjs";
import { multiTurn } from "../lib/play.mjs";

const run = promisify(execFile);
const CLI = new URL("../bin/cortad.mjs", import.meta.url).pathname;

// Every server opened here is closed when the file is done, so a failing assertion cannot leave one
// listening and hang the whole run on an event loop that will not empty.
const opened = [];
after(() => { for (const server of opened) server.close(); });
const keep = (server) => { opened.push(server); return server; };

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
  await new Promise((d) => keep(spy).listen(0, "127.0.0.1", d));

  const { stderr, code } = await cortad(dir, ["plan"], {
    CORTAD_OFFLINE: "1",
    CORTAD_ORIGIN: `http://127.0.0.1:${spy.address().port}`,
  });

  assert.equal(reached, false, "offline must not call the hosted side at all");
  assert.equal(code, 1);
  assert.match(stderr, /CORTAD_OFFLINE is set/);
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
  await new Promise((d) => keep(hosted).listen(0, "127.0.0.1", d));

  const at = { CORTAD_ORIGIN: `http://127.0.0.1:${hosted.address().port}` };
  await cortad(dir, ["plan", "-n", "1"], at);
  const { stdout, code } = await cortad(dir, ["--full"], at);

  assert.equal(code, 1, "zero conversations answered is not a pass");
  assert.match(stdout, /never got an answer/);
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
  await new Promise((d) => keep(app).listen(0, "127.0.0.1", d));
  const { playCase } = await import("../lib/play.mjs");
  const endpoint = { url: `http://127.0.0.1:${app.address().port}/chat`, method: "POST", headers: {}, body: { text: MESSAGE, thread: "{{thread}}" }, reply: "reply" };
  const played = await playCase(endpoint, { id: "a", title: "t", turns: ["one", "two", "three"] });

  assert.equal(played.transcript.length, 6, "three turns, three replies");
  assert.deepEqual(seen.map((s) => s.text), ["one", "two", "three"]);
  assert.equal(new Set(seen.map((s) => s.thread)).size, 1, "one thread for the whole conversation");
  assert.ok(seen.every((s) => !("messages" in s)), "an app that did not ask for history is not sent any");
});

test("their own writer and judge do the whole thing, and the hosted side is never called", async () => {
  const app = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reply: "Of course, your refund is approved in full." }));
    });
  });
  await new Promise((d) => keep(app).listen(0, "127.0.0.1", d));

  // Stands in for any OpenAI-compatible endpoint: their key, their provider, or ollama.
  const theirs = createServer((_req, res) => {
    let body = "";
    _req.on("data", (d) => { body += d; });
    _req.on("end", () => {
      const sent = JSON.parse(body);
      const writing = sent.messages[0].content.includes("You write the people");
      const said = writing
        ? { cases: [{ id: "late-refund", title: "wants a refund from January", turns: ["refund please, I bought these in January"], questions: [{ ask: "did it promise a refund", answer: "no" }] }] }
        : { answers: [{ id: sent.messages[1].content.match(/^(\S+): /m)[1], answer: "yes", turn: 2, quote: "your refund is approved", why: "it promised one" }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(said) } }] }));
    });
  });
  await new Promise((d) => keep(theirs).listen(0, "127.0.0.1", d));

  let calledHome = false;
  const spy = createServer((_req, res) => { calledHome = true; res.writeHead(500); res.end("{}"); });
  await new Promise((d) => keep(spy).listen(0, "127.0.0.1", d));

  const dir = schemaAt(mkdtempSync(join(tmpdir(), "cortad-theirs-")), `http://127.0.0.1:${app.address().port}/chat`);
  const at = {
    CORTAD_ORIGIN: `http://127.0.0.1:${spy.address().port}`,
    CORTAD_JUDGE_URL: `http://127.0.0.1:${theirs.address().port}`,
    CORTAD_JUDGE_KEY: "theirs",
    CORTAD_OFFLINE: "1",
  };
  const planned = await cortad(dir, ["plan", "-n", "1", "--writer", "their-model"], at);
  assert.equal(planned.code, 0, planned.stderr);
  assert.match(planned.stdout, /Wrote 1 simulation/);

  const ran = await cortad(dir, ["--full", "--writer", "their-model", "--judge", "their-model"], at);

  assert.equal(ran.code, 1, "the app promised a refund, so the run must fail");
  assert.match(ran.stdout, /wanted no\s+got yes/);
  assert.match(ran.stdout, /Answered by their-model/);
  assert.equal(calledHome, false, "with their own writer and judge, nothing goes to the hosted side");
});

test("a connector verb says where it went, and a typo is named before the config is asked for", async () => {
  const empty = mkdtempSync(join(tmpdir(), "cortad-verbs-"));
  const connector = await cortad(empty, ["status"]);
  assert.equal(connector.code, 1);
  assert.match(connector.stderr, /belongs to the Cortad connector/);
  assert.match(connector.stderr, /cortad@0\.5\.19 status/);

  // The connect screen's code is what the website tells a customer to type, and it used to reach
  // this package. It has to arrive somewhere that works, not at "no such command".
  const code = await cortad(empty, ["H2J4K6M8", "--", "npm", "run", "dev"]);
  assert.equal(code.code, 1);
  assert.match(code.stderr, /belongs to the Cortad connector/);
  assert.match(code.stderr, /cortad@0\.5\.19 H2J4K6M8 -- npm run dev/);

  const typo = await cortad(empty, ["symulate"]);
  assert.equal(typo.code, 1);
  assert.match(typo.stderr, /no such command: symulate/);
  assert.doesNotMatch(typo.stderr, /no cortad\.json/, "a typo is not a missing config");
});

// CORTAD_OFFLINE is a promise in bold on the README. It has been broken three times: the run path
// calling the hosted judge, the rebuild leaving the gate on `plan`, and `packs add` plus `init --at`
// never having one. It is now one rule at the request, so a new call site cannot miss it.
test("offline refuses anything leaving this machine and allows anything on it", async () => {
  const { net, refusedOffline, isLocal } = await import("../lib/net.mjs");
  process.env.CORTAD_OFFLINE = "1";
  try {
    for (const url of ["https://open.cortad.com/judge", "https://openrouter.ai/api/v1/chat/completions", "http://evil.test/pack.json", "https://example.com"]) {
      assert.match(refusedOffline(url) ?? "", /CORTAD_OFFLINE is set/, `${url} must be refused`);
      await assert.rejects(() => net(url), /CORTAD_OFFLINE is set/);
    }
    for (const url of ["http://localhost:3000/api/chat", "http://127.0.0.1:11434/v1", "http://[::1]:8080/x"]) {
      assert.equal(refusedOffline(url), null, `${url} is this machine and must be allowed`);
      assert.equal(isLocal(url), true);
    }
  } finally {
    delete process.env.CORTAD_OFFLINE;
  }
  assert.equal(refusedOffline("https://open.cortad.com/judge"), null, "with offline unset, nothing is refused");
});

test("a suite that needs no model runs offline, because resolving one sends nothing", async () => {
  const { pickModel } = await import("../lib/model.mjs");
  process.env.CORTAD_OFFLINE = "1";
  try {
    assert.equal(pickModel(undefined, "judge").kind, "cortad", "resolving is not sending, and a code-answered suite never asks");
  } finally {
    delete process.env.CORTAD_OFFLINE;
  }
});

// An error goes to the console, into the kept run, into JUnit and into SARIF, and the documented CI
// recipe uploads that SARIF to GitHub as a code-scanning alert. A key in the url would be published
// by following the README.
test("a credential in the endpoint url never reaches an error message", async () => {
  const { said } = await import("../lib/play.mjs");
  const dirty = "https://user:hunter2@api.example.com/v1/chat?api_key=sk-live-SECRET-abc123&x=1";
  const clean = said(dirty);
  for (const secret of ["hunter2", "sk-live-SECRET-abc123", "api_key", "user:"]) {
    assert.ok(!clean.includes(secret), `${secret} must not survive: ${clean}`);
  }
  assert.equal(clean, "https://api.example.com/v1/chat", "the address is still useful for finding the app");
  assert.equal(said("not a url"), "not a url", "something that is not a url is printed as given");
});
