import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerAsk, askReach, makeAutoReach, takeAsk } from "./auto-reach.mjs";
import { homeOf, projectOf } from "./home.mjs";
import { makeVerbs } from "./verbs.mjs";
import { reach, testedLine, withImages } from "./reach.mjs";

const API = "https://cortad.test/api";
const json = (status, body) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) });
const memory = () => { let value = null; return { read: () => value, write: (p) => { value = p; } }; };
const SECRET = "s3cr3t-session-token-9f2c";

// A stand-in for the person's app: each request is held 200 ms before its answer, so requests sent
// at once are open together.
async function standIn() {
  const seen = [];
  let open = 0;
  let most = 0;
  const server = createServer(async (req, res) => {
    open += 1;
    most = Math.max(most, open);
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, path: req.url, headers: req.headers, body });
    await new Promise((r) => setTimeout(r, 200));
    open -= 1;
    const [status, said] = req.url === "/api/assist" ? [400, '{"error":"orgId is required"}']
      : req.url === "/api/private" ? [401, `Not signed in with ${req.headers.cookie}`] : [200, '{"reply":"Hello"}'];
    res.writeHead(status, { "content-type": "application/json" }).end(said);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { port: server.address().port, seen, most: () => most, close: () => new Promise((r) => server.close(r)) };
}

const ready = (path, body = { message: "Hi. What can you help me with?" }) => ({ names: [], method: "POST", path, file: null, line: null, request: { method: "POST", path, body } });
const contact = { proven: [], notCalled: [
  ready("/api/chat"), ready("/api/summarize", { text: "Summarize my week." }), ready("/api/assist"), ready("/api/private"),
  { ...ready("/api/contact", { topic: "Hi. What can you help me with?" }), unsure: true, why: "Listed only because the request its client sends has a \"topic\" field." },
  { names: [], method: "POST", path: "/api/threads/:id/runs", file: null, line: null, byHand: "Its address takes a value from your app's own data." },
] };

// The connector's own sign-in, as its own test requests carry it: the agent's reach passes none.
const signed = (runner, headers, asked = []) => reach({ runner, contact, headers, fetchImpl: (url, init) => { asked.push(String(url)); return fetch(url, init); } });

// The server answers status; every other address is the app on this machine, asked for real.
const verbsFor = (runner, asked = []) => makeVerbs({ api: API, token: "k", pending: memory(), runner: () => runner,
  fetchImpl: async (url, init) => { asked.push(String(url)); return String(url).startsWith(API) ? json(200, { contact }) : fetch(url, init); } });

test("reach sends every endpoint it has a request for at once, and prints each one's status and time, the app's words where it was not 2xx", async (t) => {
  const app = await standIn();
  t.after(app.close);
  const out = await signed({ state: "up", port: app.port, host: "127.0.0.1" }, { cookie: `session=${SECRET}`, "x-cortad-turn": "run:1:a" });
  assert.equal(app.most(), 4, "the four were open at the same time");
  assert.deepEqual(app.seen.map((r) => r.path).sort(), ["/api/assist", "/api/chat", "/api/private", "/api/summarize"]);
  assert.ok(app.seen.every((r) => r.headers.cookie === `session=${SECRET}` && !("x-cortad-turn" in r.headers) && r.headers["content-type"] === "application/json"));
  assert.deepEqual(JSON.parse(app.seen.find((r) => r.path === "/api/summarize").body), { text: "Summarize my week." });
  const lines = out.text.split("\n");
  assert.equal(lines[0], `Sent 4 requests to your app on port ${app.port} at once, with the headers cookie:`);
  assert.match(out.text, /\n {2}POST \/api\/chat: 200 in \d+\.\d seconds\.\n/);
  assert.match(out.text, /\n {2}POST \/api\/assist: 400 in \d+\.\d seconds\. Your app answered: "\{"error":"orgId is required"\}"\n/);
  assert.match(out.text, /\n {2}POST \/api\/private: 401 in \d+\.\d seconds\. Your app answered: "Not signed in with \[sign-in\]"\n/);
  assert.ok(!out.text.includes(SECRET), "a header's value is never printed, even where the app wrote it back");
  assert.deepEqual(lines.slice(5), [
    "Not sent:",
    "  POST /api/contact: Cortad is not sure it reaches your model; name its path in test with endpoints to send it.",
    "  POST /api/threads/:id/runs: Its address takes a value from your app's own data.",
    "status shows which of them reached your model.",
    "next: status",
  ]);
  assert.equal(out.isError, undefined);
});

test("the agent's reach carries no header it is handed: the sign-in is the connector's own", async (t) => {
  const app = await standIn();
  t.after(app.close);
  await verbsFor({ state: "up", port: app.port, host: "127.0.0.1" }).reach({ headers: { cookie: `session=${SECRET}` } });
  assert.ok(app.seen.length && app.seen.every((r) => !("cookie" in r.headers)));
});

test("an endpoint marked by hand is sent when its path is named, and only the named ones are", async (t) => {
  const app = await standIn();
  t.after(app.close);
  const out = await verbsFor({ state: "up", port: app.port, host: "127.0.0.1" }).reach({ paths: ["/api/contact", "/api/nowhere"] });
  assert.deepEqual(app.seen.map((r) => r.path), ["/api/contact"]);
  assert.match(out.text, /^Sent 1 request to your app on port \d+ at once:\n {2}POST \/api\/contact: 200 in \d+\.\d seconds\.\nNot among the endpoints no request has reached: \/api\/nowhere\.\nstatus shows which of them reached your model\.\nnext: status$/);
});

test("an app that is not on this machine, or a header that would end its line, is refused and nothing is sent", async (t) => {
  const app = await standIn();
  t.after(app.close);
  for (const host of ["10.0.0.8", "example.com", "0.0.0.0"]) {
    const asked = [];
    const out = await signed({ state: "up", port: app.port, host }, { cookie: `session=${SECRET}` }, asked);
    assert.equal(out.isError, true);
    assert.equal(out.text, `${host} is not this machine; reach sends only to your app on this machine. Nothing was sent.\nnext: status`);
    assert.deepEqual(asked, [], "nothing was sent");
  }
  const here = { state: "up", port: app.port, host: "127.0.0.1" };
  const broken = await signed(here, { cookie: `${SECRET}\r\nx-admin: 1` });
  assert.equal(broken.text, "The value of the header cookie holds a line break. Nothing was sent.\nnext: status");
  const unnamed = await signed(here, { [`Bearer ${SECRET}`]: null });
  assert.ok(unnamed.isError && !unnamed.text.includes(SECRET));
  assert.equal((await verbsFor(null).reach({})).text, "No connect command is running for this repository, so no app is up on this machine. Run npx cortad in this folder as a background command to connect it again. Nothing was sent.\nnext: status");
  assert.deepEqual(app.seen, []);
});

// The server names the endpoint and prepares its request; the command sends only that endpoint's own.
test("reach never sends a request prepared for one endpoint to another address, nor one to an address that administers the app", async (t) => {
  const app = await standIn();
  t.after(() => app.close());
  const steered = { proven: [], notCalled: [
    { names: [], method: "POST", path: "/api/chat", file: null, line: null, request: { method: "POST", path: "/api/admin/delete-everything", body: {} } },
    { names: [], method: "POST", path: "/api/threads/:id/runs", file: null, line: null, request: { method: "POST", path: "/api/threads/t_1/runs", body: { message: "Hi." } } },
    { names: [], method: "POST", path: "/api/settings/model", file: null, line: null, request: { method: "POST", path: "/api/settings/model", body: { model: "x" } } },
  ] };
  const verbs = makeVerbs({ api: API, token: "k", pending: memory(), runner: () => ({ state: "up", port: app.port, host: "127.0.0.1" }),
    fetchImpl: async (url, init) => (String(url).startsWith(API) ? json(200, { contact: steered }) : fetch(url, init)) });
  const { text: out } = await verbs.reach({});
  assert.match(out, /POST \/api\/chat: not sent, the request prepared for it goes to another address\./);
  assert.match(out, /POST \/api\/settings\/model: not sent, its address says it administers your app\./);
  assert.match(out, /POST \/api\/threads\/:id\/runs: 200 in /, "a value filled into the listed address is still that endpoint");
  assert.deepEqual(app.seen.map((r) => r.path), ["/api/threads/t_1/runs"], "only the one that is its endpoint's own left the command");
});

// A round of the agent's requests (lib/auto-reach.mjs): up to four at a time, tagged as the agent's,
// with the origin given; a refused visitor is asked once more with the sign-in the person's request carried.
test("a round sends each listed endpoint once, at most four at a time, tagged as the agent's, and says one line for the batch", async (t) => {
  const app = await standIn();
  t.after(app.close);
  const said = [];
  let stamp = "a";
  const round = makeAutoReach({
    status: async () => ({ contact, read: { complete: false } }),
    runner: () => ({ state: "up", port: app.port, host: "127.0.0.1" }),
    waiting: async () => null,
    origin: () => "http://localhost:5173",
    signIn: async () => ({ name: "authorization", value: `Bearer ${SECRET}` }),
    stampOf: (m) => (m.path === "/api/chat" ? stamp : ""),
    say: (line) => said.push(line),
  });
  const first = await round();
  assert.ok(app.most() > 1 && app.most() <= 4, `at most four open at once, ${app.most()} were`);
  assert.deepEqual(app.seen.map((r) => r.path).sort(), ["/api/assist", "/api/chat", "/api/private", "/api/private", "/api/summarize"]);
  assert.deepEqual(app.seen.map((r) => r.headers["x-cortad-turn"]).sort(), ["reach:agent:1", "reach:agent:2", "reach:agent:3", "reach:agent:4", "reach:agent:5"]);
  assert.ok(app.seen.every((r) => r.headers.origin === "http://localhost:5173"));
  assert.equal(app.seen.at(-1).headers.authorization, `Bearer ${SECRET}`, "the 401 is asked again as the test account");
  assert.ok(!app.seen.slice(0, -1).some((r) => r.headers.authorization), "nobody else is signed in");
  assert.deepEqual(said, ["tested 4 endpoints: 2 answered, 2 failed; 4 of 6 endpoints tested so far"], "refused as the test account too is a failure, not a missing sign-in; the round says where it leaves the whole");
  assert.match(first.text, /POST \/api\/private: 401 in \d+\.\d seconds\. Your app answered: "Not signed in with undefined" Sent as a test account\./);
  assert.ok(!first.text.includes(SECRET));
  assert.equal(first.wait, 5_000, "looked at again soon while the code is still being read");

  await round();
  assert.equal(app.seen.length, 5, "each endpoint once per connection");
  stamp = "b";
  await round();
  assert.deepEqual(app.seen.slice(5).map((r) => r.path), ["/api/chat"], "again when its file changed");
  await round({ paths: ["/api/assist"] });
  assert.deepEqual(app.seen.slice(6).map((r) => r.path), ["/api/assist"], "and when the agent asks");
});

// The gate a run's requests wait at holds the agent's too, and an ask waiting stops a round between two sends.
test("a round's requests wait where a simulation's do, and stop between two sends for the agent's ask", async (t) => {
  const app = await standIn();
  t.after(app.close);
  let held = "Your app is being started again.";
  let asked = false;
  let trip = true;
  const round = makeAutoReach({
    status: async () => ({ contact, read: { complete: true } }),
    runner: () => ({ state: "up", port: app.port, host: "127.0.0.1" }),
    waiting: async () => held,
    origin: () => null,
    signIn: async () => null,
    stampOf: () => "",
    asked: () => asked,
    say: () => {},
    fetchImpl: async (url, init) => { asked = trip; return fetch(url, init); },
  });
  assert.match((await round()).text, /started again.*Nothing was sent/);
  assert.deepEqual(app.seen, []);
  held = null;
  const out = await round();
  assert.equal(app.seen.length, 1, "the ask is taken before the next send");
  assert.equal(app.seen[0].headers.origin, undefined, "no Origin where the env names no page of the app's");
  assert.equal(out.wait, 60_000);
  asked = trip = false;
  await round();
  assert.deepEqual(app.seen.slice(1).map((r) => r.path), ["/api/summarize", "/api/assist", "/api/private"], "the rest go next round, the first not again");
});

test("the terminal line counts only requests that reached the app, and a test account refused too as failed", () => {
  assert.equal(testedLine([{ ok: false, status: 0, unsent: true }, { ok: false, status: 0, down: true }]), null);
  assert.equal(testedLine([{ ok: true, status: 200 }, { ok: false, status: 0, unsent: true }, { ok: false, status: 401 }, { ok: false, status: 403, signedIn: true }]),
    "tested 3 endpoints: 1 answered, 1 failed, 1 needs a signed-in user");
});

test("the agent's reach is sent by the connect command, and its answer handed back", async () => {
  const home = mkdtempSync(join(tmpdir(), "reach-ask-"));
  const asked = askReach(home, ["/api/chat"], { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), waitMs: 5_000 });
  let ask = null;
  for (let i = 0; i < 50 && !ask; i++) { ask = takeAsk(home); if (!ask) await new Promise((r) => setTimeout(r, 20)); }
  assert.deepEqual(ask.paths, ["/api/chat"]);
  assert.equal(takeAsk(home), null, "taken once");
  answerAsk(home, ask.id, "Sent 1 request\nnext: status");
  assert.deepEqual(await asked, { text: "Sent 1 request\nnext: status" });
  rmSync(home, { recursive: true, force: true });
});

test("reach goes to the connect command that holds the app, and headers handed to it never leave the shell", async (t) => {
  const app = await standIn();
  t.after(app.close);
  const root = mkdtempSync(join(tmpdir(), "reach-root-"));
  const home = homeOf(projectOf(root));
  mkdirSync(home, { recursive: true });
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); });
  const runner = { state: "up", port: app.port, host: "127.0.0.1", reach: "ask" };
  const verbs = makeVerbs({ api: API, token: "k", pending: memory(), root, runner: () => runner,
    fetchImpl: async (url, init) => (String(url).startsWith(API) ? json(200, { contact }) : fetch(url, init)) });
  for (const given of [{ paths: ["/api/chat"] }, { headers: { cookie: `session=${SECRET}` }, paths: ["/api/chat"] }]) {
    const asked = verbs.reach(given);
    let ask = null;
    for (let i = 0; i < 100 && !ask; i++) { ask = takeAsk(home); if (!ask) await new Promise((r) => setTimeout(r, 20)); }
    assert.deepEqual(ask.paths, ["/api/chat"]);
    answerAsk(home, ask.id, "sent by the connect command");
    assert.equal((await asked).text, "sent by the connect command");
  }
  assert.deepEqual(app.seen, [], "nothing left the shell");
});

test("an image field gets a real 64x64 PNG unless it already holds an image or a link", () => {
  const out = withImages({ message: "Hi", imageBase64: "sample", mimeType: "text/plain", nested: { image_url: "x", photo: "https://cdn.example/p.png" } });
  const bytes = Buffer.from(out.imageBase64, "base64");
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(bytes.readUInt32BE(16), 64);
  assert.equal(bytes.readUInt32BE(20), 64);
  assert.equal(out.mimeType, "image/png");
  assert.match(out.nested.image_url, /^data:image\/png;base64,iVBOR/);
  assert.equal(out.nested.photo, "https://cdn.example/p.png");
  assert.equal(out.message, "Hi");
  assert.deepEqual(withImages({ imageBase64: out.imageBase64, mime: "image/jpeg" }), { imageBase64: out.imageBase64, mime: "image/jpeg" }, "the server's own image stays");
});
