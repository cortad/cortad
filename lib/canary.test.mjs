import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canaryOf, exchangesOf, proofsOf } from "./proof.mjs";
import { identityOf, makeCapture, sourceFinder } from "./replay.mjs";

// The canary as the backend sends it (src/local/canary.ts) through the fixture app under the real
// hook: a fact in the first turn, a second turn of that conversation, and a new conversation. Read
// off what the hook recorded, the way the command reads it.
const HOOK = new URL("./trace.cjs", import.meta.url).pathname;
const settle = () => new Promise((r) => setTimeout(r, 400));
const FACT = "Please note my order number is ZQ48213907 for later.";
const QUESTION = "Which order number did I give you earlier?";

async function app(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "canary-"));
  copyFileSync(new URL("./proof-app.cjs", import.meta.url), join(dir, "proof-app.cjs"));
  const file = join(dir, "trace.jsonl");
  const child = spawn(process.execPath, ["--require", HOOK, "proof-app.cjs"], { cwd: dir, env: { ...process.env, CORTAD_TRACE_FILE: file, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  const post = (path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then((r) => r.text());
  const rows = () => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const found = (literal) => Boolean(sourceFinder(dir, () => ["proof-app.cjs"])(literal, [], true));
  return { dir, child, post, rows, found };
}

// The three canary requests through one door; `body(words, first)` builds each, `first` holding the
// reply to the first turn.
async function canary(post, path, body, n = 7) {
  const tag = (t) => ({ "x-cortad-turn": `canary:${n}:${t}` });
  const first = await post(path, body(FACT, null), tag("a:1"));
  await post(path, body(QUESTION, first), tag("a:2"));
  await post(path, body(QUESTION, null), tag("b:1"));
}

const canaryRows = (rows) => exchangesOf(rows).filter((ex) => ex.turn.startsWith("canary:"));

test("a door that keeps each conversation apart, told the fact as the person's words, passes", async () => {
  const a = await app();
  try {
    const first = JSON.parse(await a.post("/api/chat", { message: "a weekend in Lisbon" }));
    await a.post("/api/chat", { message: "the night trains to Vienna", sessionId: first.sessionId });
    await canary(a.post, "/api/chat", (message, reply) => ({ message, ...(reply ? { sessionId: JSON.parse(reply).sessionId } : {}) }));
    await settle();
    const door = proofsOf(a.rows()).get("POST /api/chat");
    assert.equal(door.proof.exchanges, 2, "the canary is never part of the door's proof");
    assert.deepEqual(canaryOf(canaryRows(a.rows()), door.proof, a.found), { n: 7, passed: true, problems: [] });
  } finally { a.child.kill(); }
});

test("words that reach the model as the app's instructions fail the canary, and so do instructions written nowhere in the code", async () => {
  const a = await app();
  try {
    await canary(a.post, "/api/persona", (words) => ({ system: words, message: "hello there" }));
    await settle();
    const got = canaryOf(canaryRows(a.rows()), { session: { held: false } }, a.found);
    assert.equal(got.passed, false);
    assert.deepEqual(got.problems.map((p) => [p.kind, p.side]), [["ask-in-instructions", "ours"], ["instructions-not-in-code", "ours"]]);
    assert.match(got.problems[1].said, /"Please note my order number is ZQ48213907 for later\."/);
  } finally { a.child.kill(); }
});

// One customer writes the id of the site a request asks about into its own prompt. Read as instructions
// the request carried and the code does not hold, it left the only endpoint out of every run.
test("an id of the request's that the app writes into its own instructions is not instructions the request carried", () => {
  const site = "2f43cf20-17c6-4ba7-97eb-475bb0747e84";
  const body = (text) => JSON.stringify({ websiteId: site, messages: [{ role: "user", text }] });
  const asked = (text) => JSON.stringify({ model: "m", messages: [{ role: "system", content: `You are the assistant for shop.example.com today.\n<website_id>"${site}"</website_id>` }, { role: "user", content: text }] });
  const turn = (id, tag, text, at) => [
    { ex: id, at, ms: 20, method: "POST", path: "/chat", body: body(text), status: 200, type: "application/json", reply: JSON.stringify({ reply: "Noted." }), sent: [asked(text)], turn: `canary:7:${tag}` },
    { call: { ex: id, host: "127.0.0.1:9", model: "m", status: 200, reply: "Noted.", instructions: `You are the assistant for shop.example.com today.\n<website_id>"${site}"</website_id>`, turn: `canary:7:${tag}` } },
  ];
  const rows = [...turn("1.1", "a:1", FACT, 1000), ...turn("1.2", "a:2", QUESTION, 2000), ...turn("1.3", "b:1", QUESTION, 3000)];
  const got = canaryOf(exchangesOf(rows), { session: { held: false } }, () => false);
  assert.deepEqual(got.problems.filter((p) => p.kind === "instructions-not-in-code"), []);
});

// A provider that refuses every call, behind an app that answers 200 with a shape of its own: the test
// message passed, Run was offered, and every conversation would have met the refusal.
test("a test message the model never answered fails on the app's side when the person's own request ended in an error too", () => {
  const turn = (id, tag, text, at, calls, reply = { error: true, message: "Your card was declined" }) => [
    { ex: id, at, ms: 20, method: "POST", path: "/chat", body: JSON.stringify({ message: text }), status: 200, type: "application/json", reply: JSON.stringify(reply), sent: [JSON.stringify({ model: "m", messages: [{ role: "user", content: text }] })], ...(tag ? { turn: `canary:7:${tag}` } : {}) },
    ...calls.map((status) => ({ call: { ex: id, host: "api.openai.com", model: "gpt-4o", status, ...(tag ? { turn: `canary:7:${tag}` } : {}) } })),
  ];
  const canary = (calls, reply) => exchangesOf([...turn("1.1", "a:1", FACT, 1000, calls, reply), ...turn("1.2", "a:2", QUESTION, 2000, calls, reply), ...turn("1.3", "b:1", QUESTION, 3000, calls, reply)]);
  const refusedOwn = exchangesOf(turn("0.1", null, "how many visitors this week", 500, [403]));
  const declined = canaryOf(canary([403, 403, 403]), { session: { held: false } }, null, refusedOwn);
  assert.deepEqual([declined.passed, declined.problems.map((p) => [p.kind, p.side, p.said])], [false, [["unreadable", "theirs",
    'A test message sent the way a run sends it was answered with an error, "Your card was declined", as your own request was: a model call to api.openai.com for gpt-4o answered 403. Fix that and send one more request.']]]);
  const fallback = canaryOf(canary([403], { reply: "Sorry, I am unavailable." }), { session: { held: false } }, null, refusedOwn);
  assert.deepEqual(fallback.problems.map((p) => p.said), ["A test message sent the way a run sends it was answered with an error, as your own request was: a model call to api.openai.com for gpt-4o answered 403. Fix that and send one more request."], "a reply the app wrote in place of its model's is no answer either");
  const answeredOwn = exchangesOf(turn("0.1", null, "how many visitors this week", 500, [200], { reply: "412 visitors." }));
  assert.deepEqual(canaryOf(canary([503]), { session: { held: false } }, null, answeredOwn).problems, [], "a provider failing the test message alone is not the app's to fix");
  assert.deepEqual(canaryOf(canary([404, 200], { reply: "Noted." }), { session: { held: false } }, null, refusedOwn).problems, [], "a fallback that answered is an answer");
});

// The twin of an ask-then-poll API with a wrong key in its env file: the thread ended with no words,
// its model call answered 401, and Run was held as a reply "could not be read as words", ours.
test("a first reply with no words because the app's model refused it is the app's, with the call named", () => {
  const turn = (id, tag, text, at, status) => [
    { ex: id, at, ms: 20, method: "POST", path: "/v2/research/ask", body: JSON.stringify({ request: text }), status: 200, type: "application/json", reply: "", sent: [JSON.stringify({ model: "m", messages: [{ role: "user", content: text }] })], turn: `canary:7:${tag}` },
    { call: { ex: id, host: "127.0.0.1:18431", model: "gpt-6-astra", status, turn: `canary:7:${tag}` } },
  ];
  const sent = (status) => exchangesOf([...turn("1.1", "a:1", FACT, 1000, status), ...turn("1.2", "a:2", QUESTION, 2000, status), ...turn("1.3", "b:1", QUESTION, 3000, status)]);
  const refused = canaryOf(sent(401), { session: { held: false } });
  assert.deepEqual(refused.problems.filter((p) => p.kind === "unreadable").map((p) => [p.side, p.said]), [["theirs", "The first message reached your app's model, and the model call to 127.0.0.1:18431 for gpt-6-astra answered 401, so no words came back."]]);
  assert.deepEqual(canaryOf(sent(503), { session: { held: false } }).problems.filter((p) => p.kind === "unreadable").map((p) => p.side), ["ours"], "a provider's own failure is not a refusal");
});

test("an endpoint whose request has no place for a person's words fails the canary instead of saying nothing", async () => {
  const a = await app();
  try {
    await canary(a.post, "/api/once", () => ({}));
    await settle();
    const got = canaryOf(canaryRows(a.rows()), { session: { held: false } }, a.found);
    assert.deepEqual([got.n, got.passed, got.problems.map((p) => [p.kind, p.side])], [7, false, [["ask-nowhere", "ours"]]]);
  } finally { a.child.kill(); }
});

test("a history every caller shares fails the canary: the new conversation carried the first one's fact", async () => {
  const a = await app();
  try {
    await canary(a.post, "/api/assist", (q) => ({ q }));
    await settle();
    const got = canaryOf(canaryRows(a.rows()), { session: { held: true } }, a.found);
    assert.deepEqual(got.problems.map((p) => [p.kind, p.side]), [["shared-history", "theirs"]]);
  } finally { a.child.kill(); }
});

test("the command posts the door's canary with its proof, and what the person's sign-in is without its value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "canary-capture-"));
  copyFileSync(new URL("./proof-app.cjs", import.meta.url), join(dir, "proof-app.cjs"));
  const sent = [];
  const capture = makeCapture({ work: dir, keepSecret: () => {}, onProof: (p) => sent.push(p), root: dir, files: () => ["proof-app.cjs"] });
  const child = spawn(process.execPath, ["proof-app.cjs"], { cwd: dir, env: { ...process.env, ...capture.env(process.env) }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  const exp = Math.floor(Date.now() / 1000) + 1800;
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify({ sub: "u-1", exp })).toString("base64url"), "c2lnbmF0dXJlLXZhbHVl"].join(".");
  const post = (path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${jwt}`, ...headers }, body: JSON.stringify(body) }).then((r) => r.text());
  try {
    const first = JSON.parse(await post("/api/chat", { message: "a weekend in Lisbon" }));
    await post("/api/chat", { message: "the night trains to Vienna", sessionId: first.sessionId });
    await canary(post, "/api/chat", (message, reply) => ({ message, ...(reply ? { sessionId: JSON.parse(reply).sessionId } : {}) }), 12);
    await settle();
    capture.alive();
    const last = sent.at(-1);
    assert.deepEqual([last.proof.exchanges, last.template.body.message], [2, "the night trains to Vienna"], "the proof is the person's two requests");
    assert.deepEqual(last.proof.canary, { n: 12, passed: true, problems: [] });
    assert.equal(last.proof.identity.kind, "bearer");
    assert.ok(Math.abs(last.proof.identity.expiresInS - 1800) <= 5, `expires in ${last.proof.identity.expiresInS}s`);
    assert.ok(!JSON.stringify(sent).includes(jwt), "the sign-in never leaves");
  } finally { child.kill(); }
});

test("a sign-in with nothing that says when it ends has no expiry, never a guess", () => {
  assert.deepEqual(identityOf({ cookie: "sid=opaque-session-value" }), { kind: "cookie", expiresInS: null });
  assert.deepEqual(identityOf({ "content-type": "application/json" }), { kind: "none", expiresInS: null });
  assert.equal(identityOf(null), null);
});

test("instructions the request never carried came from the app's side, wherever it keeps them, and are never questioned", async () => {
  const a = await app();
  try {
    await canary(a.post, "/api/chat", (message, reply) => ({ message, ...(reply ? { sessionId: JSON.parse(reply).sessionId } : {}) }));
    await settle();
    const nowhere = () => false;
    assert.deepEqual(canaryOf(canaryRows(a.rows()), { session: { held: true } }, nowhere).problems, []);
  } finally { a.child.kill(); }
});

test("the repository holds instructions kept in a text, Markdown or template file, never in a test", () => {
  const dir = mkdtempSync(join(tmpdir(), "canary-tree-"));
  for (const [rel, text] of [["prompts/support.txt", "You are Juno, the support agent for PanWatch."], ["docs/persona.md", "You are Mira and you only answer about billing."], ["tests/fixture.txt", "You are a test double that answers anything."]]) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  const find = sourceFinder(dir, () => ["prompts/support.txt", "docs/persona.md", "tests/fixture.txt"]);
  assert.deepEqual(find("You are Juno, the support agent", [], true), { file: "prompts/support.txt", line: 1 });
  assert.deepEqual(find("You are Mira and you only answer", [], true), { file: "docs/persona.md", line: 1 });
  assert.equal(find("You are a test double", [], true), null);
  assert.equal(find("You are Juno, the support agent"), null, "a problem's place is still only ever code");
});

test("an app that writes the person's words into its instructions for their own requests too is not failed for it", async () => {
  const a = await app();
  try {
    await a.post("/api/templated", { message: "a weekend in Lisbon" });
    await canary(a.post, "/api/templated", (message) => ({ message }));
    await settle();
    const own = exchangesOf(a.rows()).filter((ex) => !ex.trial);
    assert.deepEqual(canaryOf(canaryRows(a.rows()), { session: { held: false } }, a.found, own).problems, []);
    assert.deepEqual(canaryOf(canaryRows(a.rows()), { session: { held: false } }, a.found).problems.map((p) => p.kind), ["ask-in-instructions"], "without the person's own requests it is");
  } finally { a.child.kill(); }
});

test("every request of the person's is kept, so signing in again and sending one more renews what the run carries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "canary-renew-"));
  copyFileSync(new URL("./proof-app.cjs", import.meta.url), join(dir, "proof-app.cjs"));
  const sent = [];
  const capture = makeCapture({ work: dir, keepSecret: () => {}, onProof: (p) => sent.push(p), root: dir, files: () => ["proof-app.cjs"] });
  const child = spawn(process.execPath, ["proof-app.cjs"], { cwd: dir, env: { ...process.env, ...capture.env(process.env) }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  const jwt = (inS) => ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify({ sub: "u-1", exp: Math.floor(Date.now() / 1000) + inS })).toString("base64url"), "c2lnbmF0dXJlLXZhbHVl"].join(".");
  const csrf = jwt(5);
  const post = (token) => fetch(`http://127.0.0.1:${port}/api/once`, { method: "POST", headers: { "content-type": "application/json", cookie: `csrf_token=${csrf}; session=${token}` }, body: JSON.stringify({ message: "what is on today" }) }).then((r) => r.text());
  try {
    for (let i = 0; i < 5; i++) await post(jwt(60));
    await post(jwt(3600));
    await settle();
    capture.alive();
    const last = sent.at(-1);
    assert.equal(last.proof.identity.kind, "cookie");
    assert.ok(Math.abs(last.proof.identity.expiresInS - 3600) <= 5, `the newest sign-in, not the CSRF token: ${last.proof.identity.expiresInS}s`);
  } finally { child.kill(); }
});
