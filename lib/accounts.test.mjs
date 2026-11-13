import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeAccounts, makeCapture } from "./replay.mjs";

// The fixture app under the real hook, with a door that answers each signed-in customer by name and
// plan. The agent's requests sign in as different customers; each becomes an account a run's
// conversations are handed in turn, and no sign-in value is ever in what the command posts.
const settle = () => new Promise((r) => setTimeout(r, 400));
const jwt = (sub, inS) => ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + inS })).toString("base64url"), "c2lnbmF0dXJlLXZhbHVl"].join(".");

test("each customer the agent's requests signed in as is an account of its own, and conversations are split across them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "accounts-"));
  copyFileSync(new URL("./proof-app.cjs", import.meta.url), join(dir, "proof-app.cjs"));
  const sent = [];
  const capture = makeCapture({ work: dir, keepSecret: () => {}, onProof: (p) => sent.push(p), root: dir, files: () => ["proof-app.cjs"] });
  const child = spawn(process.execPath, ["proof-app.cjs"], { cwd: dir, env: { ...process.env, ...capture.env(process.env) }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  const post = (path, message, headers) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ message }) }).then((r) => r.json());
  const as = (token) => ({ authorization: `Bearer ${token}` });
  const door = () => sent.filter((p) => p.door.path === "/api/account").at(-1);
  const tokens = { ana: jwt("u-ana", 1200), anaAgain: jwt("u-ana", 3600), ben: jwt("u-ben", 900) };
  try {
    await post("/api/account", "what does my plan include", as(tokens.ana));
    await post("/api/account", "and the weekend rates", as(tokens.anaAgain));
    await post("/api/once", "a day trip to Sintra", {});
    await settle();
    capture.alive();
    assert.equal(door().proof.accounts, undefined, "Ana signed in again is still one account, and a request with no sign-in is none");
    assert.equal(capture.headers("captured", "POST /api/account").authorization, `Bearer ${tokens.anaAgain}`, "the first account speaks with its newest sign-in");

    await post("/api/account", "what does my plan include", as(tokens.ben));
    await settle();
    capture.alive();
    assert.equal(door().proof.accounts, 2);
    assert.equal(sent.filter((p) => p.door.path === "/api/once").at(-1).proof.accounts, 2, "every door is sent again when an account is added");
    assert.deepEqual([door().proof.identity.kind, door().proof.identity.account], ["bearer", 2], "the sign-in that ends first is Ben's");
    assert.ok(Math.abs(door().proof.identity.expiresInS - 900) <= 5, `ends in ${door().proof.identity.expiresInS}s`);

    // The run hands the cast's people the accounts in turn; the command puts each one's sign-in in.
    const roles = ["captured", "captured:account2", "captured", "captured:account2"];
    const replies = [];
    for (const [i, role] of roles.entries()) replies.push((await post("/api/account", "is breakfast included", { ...capture.headers(role, "POST /api/account"), "x-cortad-turn": `case_${i}:1` })).reply);
    assert.deepEqual(replies.map((r) => r.split(",")[0]), ["Ana", "Ben", "Ana", "Ben"]);
    assert.equal(capture.headers("captured:account3", "POST /api/account").authorization, `Bearer ${tokens.anaAgain}`, "an account this command no longer holds speaks as the first");
    assert.equal(capture.headers("clerk:p1a2b3c4", "POST /api/account"), null, "a test account the command signs in itself is not a captured one");
    await settle();
    capture.alive();
    assert.equal(door().proof.accounts, 2, "the simulation's own requests are never accounts");

    for (const sub of ["u-cy", "u-dee", "u-eve"]) await post("/api/account", "what does my plan include", as(jwt(sub, 3600)));
    await settle();
    capture.alive();
    assert.equal(door().proof.accounts, 4, "four at most");
    assert.match((await post("/api/account", "hello", capture.headers("captured:account4", "POST /api/account"))).reply, /^Dee,/, "the fifth customer is not kept");
    assert.ok(!Object.values(tokens).some((t) => JSON.stringify(sent).includes(t)), "no sign-in value is in anything posted");

    // A server that restarted holds only what an earlier connection proved and takes its sign-ins for
    // gone; this process still has them, and says so by proving every door again.
    await settle();
    capture.alive();
    const before = sent.length;
    capture.alive();
    assert.equal(sent.length, before, "a proof that has not changed is not sent twice");
    capture.proveAgain();
    assert.deepEqual(sent.slice(before).map((p) => p.door.path).sort(), ["/api/account", "/api/once"], "every door goes up again once the server has forgotten this terminal");
  } finally { child.kill(); }
});

// One customer's chat takes the id of the site a customer asks about. A run's request is built from one
// customer's own, so every conversation played as a second customer asked about the first one's site
// and was refused.
test("a simulation speaking as another customer sends that customer's own ids, and never touches what the simulation wrote", () => {
  const accounts = makeAccounts();
  const ana = { authorization: `Bearer ${jwt("u-ana", 3600)}` }, ben = { authorization: `Bearer ${jwt("u-ben", 3600)}` };
  const door = "POST /v1/chat";
  accounts.keep(ana, door, JSON.stringify({ siteId: "site-ana", scope: { org: "org-ana" }, timezone: "UTC", id: "chat-1", messages: [{ role: "user", text: "hello" }] }));
  accounts.keep(ben, door, { siteId: "site-ben", scope: { org: "org-ben" }, timezone: "UTC", id: "chat-2", messages: [{ role: "user", text: "hi" }] });
  const trial = { siteId: "site-ben", scope: { org: "org-ben" }, timezone: "UTC", id: "conversation-of-the-run", messages: [{ role: "user", text: "site-ben is slow today" }] };
  assert.deepEqual(accounts.bodyAs("captured", door, trial), { ...trial, siteId: "site-ana", scope: { org: "org-ana" } }, "the first customer's own site and workspace");
  assert.equal(accounts.bodyAs("captured:account2", door, trial), trial, "already the second customer's: nothing to change");
  assert.deepEqual(JSON.parse(accounts.bodyAs("captured", door, JSON.stringify(trial))), { ...trial, siteId: "site-ana", scope: { org: "org-ana" } }, "a body sent as text is read and written back as text");
  assert.equal(accounts.bodyAs("captured", "POST /v1/other", { siteId: "site-ben" }).siteId, "site-ben", "only where a customer's own request to that endpoint showed the value");
  const alone = makeAccounts();
  alone.keep(ana, door, { siteId: "site-ana" });
  assert.deepEqual(alone.bodyAs("captured", door, { siteId: "anything" }), { siteId: "anything" }, "one customer: the body goes as written");
});

test("Cortad's own test request lends a simulation its page: with no request of the person's, a simulation speaks with the Origin the test request carried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "accounts-"));
  copyFileSync(new URL("./proof-app.cjs", import.meta.url), join(dir, "proof-app.cjs"));
  const capture = makeCapture({ work: dir, keepSecret: () => {}, onProof: () => {}, root: dir, files: () => ["proof-app.cjs"] });
  const child = spawn(process.execPath, ["proof-app.cjs"], { cwd: dir, env: { ...process.env, ...capture.env(process.env) }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  const post = (headers) => fetch(`http://127.0.0.1:${port}/api/once`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ message: "hello" }) }).then((r) => r.json());
  try {
    await post({ origin: "http://localhost:5174", "x-cortad-turn": "case_1:1" });
    await settle();
    capture.alive();
    assert.equal(capture.headers("captured", "POST /api/once")?.origin, undefined, "a simulation's own request lends nothing");
    await post({ origin: "http://localhost:5174", "x-cortad-turn": "reach:auto:1" });
    await settle();
    capture.alive();
    assert.equal(capture.headers("captured", "POST /api/once")?.origin, "http://localhost:5174");
    assert.equal(capture.headers("captured", "POST /api/once")?.["x-cortad-turn"], undefined, "the test request's own tag is not spoken again");
  } finally { child.kill(); }
});

// One customer, 2026-10-06: every reconnect lost the sign-in its agent had sent, and its endpoints
// stayed left out until another signed-in request.
test("a sign-in is kept between connects in a file only this user can read, and one that has ended is not read back", () => {
  const file = join(mkdtempSync(join(tmpdir(), "signins-")), "home", "sign-ins.json");
  const jwt = (exp) => `Bearer ${[{ alg: "none" }, { sub: "u1", exp }].map((p) => Buffer.from(JSON.stringify(p)).toString("base64url")).join(".")}.x`;
  const first = makeAccounts(file);
  first.keep({ authorization: jwt(Math.floor(Date.now() / 1000) + 3600) }, "POST /chat", JSON.stringify({ websiteId: "w1" }));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const again = makeAccounts(file);
  assert.deepEqual(again.kept(), first.kept());
  assert.equal(again.speak("captured", "POST /chat").authorization, first.speak("captured", "POST /chat").authorization);
  const ended = makeAccounts(file);
  ended.keep({ authorization: jwt(Math.floor(Date.now() / 1000) - 60) }, "POST /chat", "{}");
  writeFileSync(file, JSON.stringify([{ key: "x", headers: { authorization: jwt(1) }, bodies: {} }]));
  assert.deepEqual(makeAccounts(file).kept(), []);
  // A visitor who is not signed in: what their client sent is spoken again after a reconnect.
  const guest = makeAccounts(file);
  guest.keep({ origin: "http://localhost:3000", "content-type": "application/json" }, "POST /chat", "{}");
  assert.equal(makeAccounts(file).speak("captured", "POST /chat").origin, "http://localhost:3000");
});

// A sign-in is kept on this machine only after the person's yes: until then it is used for this
// connect from memory, and the file is neither written nor read.
test("before the person's yes no sign-in is written to ~/.cortad or read back from it; after it, both", () => {
  const file = join(mkdtempSync(join(tmpdir(), "signins-")), "home", "sign-ins.json");
  const jwt = `Bearer ${[{ alg: "none" }, { sub: "u1", exp: Math.floor(Date.now() / 1000) + 3600 }].map((p) => Buffer.from(JSON.stringify(p)).toString("base64url")).join(".")}.x`;
  let yes = false;
  const accounts = makeAccounts(file, { stored: () => yes });
  accounts.keep({ authorization: jwt }, "POST /chat", "{}");
  assert.equal(accounts.speak("captured", "POST /chat").authorization, jwt, "used for this connect");
  assert.throws(() => statSync(file), "written before the yes");
  yes = true;
  accounts.keep({ authorization: jwt }, "POST /chat", "{}");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(makeAccounts(file, { stored: () => false }).speak("captured", "POST /chat"), null, "read back without the yes");
  assert.equal(makeAccounts(file, { stored: () => true }).speak("captured", "POST /chat").authorization, jwt);
});
