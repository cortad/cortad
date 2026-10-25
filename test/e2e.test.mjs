// The whole command, run as a person runs it: a real app on a port, a real process, real output.
// Only the two hosted calls are stood in for, so this costs nothing and still proves the wiring.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const CLI = new URL("../bin/cortad.mjs", import.meta.url).pathname;

const serve = (handler) => new Promise((done) => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", async () => {
      const answer = await handler(req, body ? JSON.parse(body) : null);
      res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  }).listen(0, "127.0.0.1", () => done({ server, port: server.address().port }));
});

const CASES = [
  { id: "late-refund", title: "wants a refund from January", turns: ["refund please, I bought these in January"], checks: [{ id: "no-late-refund", require: "Never promises a refund past 30 days" }] },
  { id: "normal", title: "asks the opening hours", turns: ["what time do you open"], checks: [{ id: "answers", require: "Answers the question asked" }] },
];

test("a run that finds a broken rule prints the card and leaves a failing exit code", async () => {
  const app = await serve((_req, sent) => ({
    body: { reply: sent.text.includes("refund") ? "Of course, your refund is approved in full." : "We open at nine." },
  }));
  const hosted = await serve((req, sent) => {
    if (req.url === "/users") return { body: { cases: CASES, left: 4 } };
    const broke = sent.transcript[1].text.includes("refund is approved");
    return { body: { rulings: [{ id: sent.checks[0].id, broke, turn: broke ? 2 : null, evidence: broke ? "Of course, your refund is approved in full." : null }] } };
  });

  const dir = mkdtempSync(join(tmpdir(), "cortad-e2e-"));
  writeFileSync(join(dir, "cortad.json"), JSON.stringify({
    app: "a support assistant for a shoe store",
    endpoint: { url: `http://127.0.0.1:${app.port}/chat`, method: "POST", body: { text: "{{message}}" }, reply: "reply" },
    rules: ["never promise a refund past 30 days"],
  }));

  const { stdout, code } = await run("node", [CLI], {
    cwd: dir,
    env: { ...process.env, CORTAD_ORIGIN: `http://127.0.0.1:${hosted.port}`, CORTAD_HOME: dir, NO_COLOR: "1" },
  }).then((r) => ({ ...r, code: 0 })).catch((e) => ({ stdout: e.stdout, code: e.code }));

  app.server.close();
  hosted.server.close();

  assert.equal(code, 1, "a broken rule must fail the command, so CI can gate on it");
  assert.match(stdout, /wants a refund from January/);
  assert.match(stdout, /your rule: Never promises a refund past 30 days/);
  assert.match(stdout, /your app answered, and that is the break/);
  assert.match(stdout, /1 of your own rules broke across 2 conversations/);
  assert.match(stdout, /2 conversations written for this app and played on this machine/);
});

test("a run where nothing breaks says so and exits clean", async () => {
  const app = await serve(() => ({ body: { reply: "Refunds run for 30 days. Yours is past that, but I can send a store credit." } }));
  const hosted = await serve((req, sent) => {
    if (req.url === "/users") return { body: { cases: [CASES[0]], left: 4 } };
    return { body: { rulings: [{ id: sent.checks[0].id, broke: false, turn: null, evidence: null }] } };
  });

  const dir = mkdtempSync(join(tmpdir(), "cortad-e2e-"));
  writeFileSync(join(dir, "cortad.json"), JSON.stringify({
    app: "a support assistant for a shoe store",
    endpoint: { url: `http://127.0.0.1:${app.port}/chat`, method: "POST", body: { text: "{{message}}" }, reply: "reply" },
    rules: ["never promise a refund past 30 days"],
  }));

  const { stdout, code } = await run("node", [CLI], {
    cwd: dir,
    env: { ...process.env, CORTAD_ORIGIN: `http://127.0.0.1:${hosted.port}`, CORTAD_HOME: dir, NO_COLOR: "1" },
  }).then((r) => ({ ...r, code: 0 })).catch((e) => ({ stdout: e.stdout, code: e.code }));

  app.server.close();
  hosted.server.close();

  assert.equal(code, 0);
  assert.match(stdout, /Nothing broke across 1 conversation,/);
});

test("init writes a schema that the command then refuses until it is filled in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cortad-e2e-"));
  const env = { ...process.env, CORTAD_HOME: dir, NO_COLOR: "1" };
  const written = await run("node", [CLI, "init"], { cwd: dir, env });
  assert.match(written.stdout, /Wrote cortad\.json/);

  const { stderr, code } = await run("node", [CLI], { cwd: dir, env })
    .then(() => ({ stderr: "", code: 0 }))
    .catch((e) => ({ stderr: e.stderr, code: e.code }));
  assert.equal(code, 1);
  assert.match(stderr, /app: one sentence/);
  assert.match(stderr, /rules: at least one rule/);
});
