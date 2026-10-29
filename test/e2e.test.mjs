// The whole command, run as a person runs it: a real app on a port, a real process, real output.
// Only the two hosted calls are stood in for, so this costs nothing and still proves the wiring.
// The states where nothing was tested are pinned in gate.test.mjs, not here.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const CLI = new URL("../bin/cortad.mjs", import.meta.url).pathname;

// Every server opened here is closed when the file is done, so a failing assertion cannot leave one
// listening and hang the whole run on an event loop that will not empty.
const opened = [];
after(() => { for (const server of opened) server.close(); });

const serve = (handler) => new Promise((done) => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", async () => {
      const answer = await handler(req, body ? JSON.parse(body) : null);
      res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  }).listen(0, "127.0.0.1", () => {
    opened.push(server);
    done({ server, port: server.address().port });
  });
});

const CASES = [
  { id: "late-refund", title: "wants a refund from January",
    turns: ["refund please, I bought these in January"],
    questions: [{ ask: "did it promise a refund", answer: "no" }] },
  { id: "opening-hours", title: "asks the opening hours",
    turns: ["what time do you open"],
    questions: [{ ask: "did it answer the question", answer: "yes" }] },
];

// The judge, standing in: it answers from the words, so a test never needs a model.
const answersOf = (sent) => (sent.questions ?? []).map((q) => {
  const at = (sent.transcript ?? []).findIndex((t) => t.role === "app" && /refund is approved/.test(t.text));
  if (/promise a refund/.test(q.ask) && at !== -1) {
    return { id: q.id, answer: "yes", turn: at + 1, quote: "your refund is approved", why: "it promised one" };
  }
  if (/answer the question/.test(q.ask)) return { id: q.id, answer: "yes", turn: 2, quote: "We open at nine", why: "it answered" };
  return { id: q.id, answer: "no", turn: null, quote: "", why: "nothing says so" };
});

const hostedFor = (cases = CASES) => serve((req, sent) =>
  req.url === "/users" ? { body: { cases, left: 19 } } : { body: { answers: answersOf(sent) } });

function repo(port, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cortad-e2e-"));
  writeFileSync(join(dir, "cortad.json"), JSON.stringify({
    app: "a support assistant for a shoe store",
    endpoint: { url: `http://127.0.0.1:${port}/chat`, method: "POST", body: { text: "{{message}}" }, reply: "reply" },
    rules: ["never promise a refund past 30 days"],
    ...extra,
  }));
  return dir;
}

const cli = (dir, hosted, args) =>
  exec("node", [CLI, ...args], { cwd: dir, env: { ...process.env, CORTAD_ORIGIN: `http://127.0.0.1:${hosted.port}`, NO_COLOR: "1" } });

const failed = async (dir, hosted, args) => {
  try { await cli(dir, hosted, args); return null; } catch (e) { return e; }
};

test("plan writes the simulations into the repository, with the format beside them", async () => {
  const app = await serve(() => ({ body: { reply: "We open at nine." } }));
  const hosted = await hostedFor();
  const dir = repo(app.port);
  const { stdout } = await cli(dir, hosted, ["plan", "-n", "2"]);
  assert.match(stdout, /Wrote 2 simulations/);
  const written = JSON.parse(readFileSync(join(dir, "cortad/simulations/late-refund.json"), "utf8"));
  assert.equal(written.who, "wants a refund from January");
  assert.deepEqual(written.questions, [{ ask: "did it promise a refund", answer: "no" }]);
  assert.match(readFileSync(join(dir, "cortad/simulations/README.md"), "utf8"), /A simulation file/);
  assert.match(readFileSync(join(dir, "cortad/.gitignore"), "utf8"), /trace\.jsonl/);
});

test("a question the app gets wrong fails the run and leaves a failing exit code", async () => {
  const app = await serve((_req, sent) => ({
    body: { reply: sent.text.includes("refund") ? "Of course, your refund is approved in full." : "We open at nine." },
  }));
  const hosted = await hostedFor();
  const dir = repo(app.port);
  await cli(dir, hosted, ["plan", "-n", "2"]);
  const e = await failed(dir, hosted, ["--full"]);
  assert.ok(e, "a failed question must leave a failing exit code");
  assert.equal(e.code, 1);
  assert.match(e.stdout, /late-refund/);
  assert.match(e.stdout, /did it promise a refund/);
  assert.match(e.stdout, /wanted no\s+got yes/);
  assert.match(e.stdout, /your refund is approved/);
});

test("a run where nothing fails says so and exits clean", async () => {
  const app = await serve(() => ({ body: { reply: "We open at nine, and I cannot refund that." } }));
  const hosted = await hostedFor();
  const dir = repo(app.port);
  await cli(dir, hosted, ["plan", "-n", "2"]);
  const { stdout } = await cli(dir, hosted, ["--full"]);
  assert.match(stdout, /Nothing failed/);
});

test("the second run says what moved, on the same simulations", async () => {
  let broken = true;
  const app = await serve((_req, sent) => ({
    body: { reply: broken && sent.text.includes("refund") ? "Of course, your refund is approved in full." : "We open at nine, and I cannot refund that." },
  }));
  const hosted = await hostedFor();
  const dir = repo(app.port);
  await cli(dir, hosted, ["plan", "-n", "2"]);
  await failed(dir, hosted, ["--full"]);
  broken = false;
  const { stdout } = await cli(dir, hosted, ["--full"]);
  assert.match(stdout, /1 answer moved\s+1 better, 0 worse/);
});

test("verify plays only what failed, and says whether the fix held", async () => {
  let broken = true;
  const app = await serve((_req, sent) => ({
    body: { reply: broken && sent.text.includes("refund") ? "Of course, your refund is approved in full." : "We open at nine, and I cannot refund that." },
  }));
  const hosted = await hostedFor();
  const dir = repo(app.port);
  await cli(dir, hosted, ["plan", "-n", "2"]);
  await failed(dir, hosted, ["--full"]);
  broken = false;
  const { stdout } = await cli(dir, hosted, ["verify"]);
  assert.match(stdout, /held\s+did it promise a refund/);
  assert.match(stdout, /1 of 1 fixed/);
});

test("a question about what the app did reads could not tell until the app records it", async () => {
  const app = await serve(() => ({ body: { reply: "We open at nine." } }));
  const hosted = await hostedFor([{ id: "tooling", title: "asks for a refund", turns: ["refund please"],
    questions: [{ ask: "did it call issueRefund", answer: "no", tool: "issueRefund" }] }]);
  const dir = repo(app.port);
  await cli(dir, hosted, ["plan", "-n", "1"]);
  const { stdout } = await cli(dir, hosted, ["--full"]);
  assert.match(stdout, /1 question could not be settled/);
  assert.match(stdout, /could not tell/);
});

test("a changed file nothing reaches says to write one, instead of passing", async () => {
  const app = await serve(() => ({ body: { reply: "We open at nine." } }));
  const hosted = await hostedFor();
  const dir = repo(app.port);
  await cli(dir, hosted, ["plan", "-n", "2"]);
  const e = await failed(dir, hosted, ["--changed", "src/cancel.ts"]);
  assert.ok(e, "a changed file with no coverage must not pass");
  assert.match(e.stderr, /nothing reaches src\/cancel\.ts/);
  assert.match(e.stderr, /Write a simulation for it/);
});

test("a run with no simulations says what to do instead of passing", async () => {
  const app = await serve(() => ({ body: { reply: "hi" } }));
  const hosted = await hostedFor();
  const dir = repo(app.port);
  const e = await failed(dir, hosted, ["--full"]);
  assert.ok(e);
  assert.match(e.stderr, /no simulations yet/);
});

test("init writes a config the command then refuses until it is filled in", async () => {
  const hosted = await hostedFor();
  const dir = mkdtempSync(join(tmpdir(), "cortad-init-"));
  // --at a dead address on purpose: with no address, init looks at the usual dev ports, and what is
  // listening on this machine is not something a test gets to depend on.
  const { stdout } = await cli(dir, hosted, ["init", "--at", "http://127.0.0.1:1"]);
  assert.match(stdout, /Wrote cortad\.json/);
  assert.match(stdout, /Nothing at http:\/\/127\.0\.0\.1:1 answered like a chat/);
  const e = await failed(dir, hosted, ["plan"]);
  assert.ok(e, "an empty config must not be runnable");
  assert.match(e.stderr, /app: one sentence/);
});
