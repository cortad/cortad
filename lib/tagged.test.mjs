import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { homeOf, projectOf } from "./home.mjs";

// chatgpt-lite2 (run 707b51af): a request the backend sent through the command with no turn tag was
// recorded as the person's, became the request every trial copied, and would have been the sign-in a
// trial speaking as the person carried. The whole command here, against an app whose model is a
// server of the test's and a stand-in for our API that hands out jobs and keeps what comes back.
const LOCAL = join(dirname(fileURLToPath(import.meta.url)), "..", "local.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (done, ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await done()) return true; return done(); };

const APP = (port) => `
  const fs = require("node:fs");
  require("node:http").createServer(async (req, res) => {
    let body = "";
    for await (const d of req) body += d;
    const message = JSON.parse(body || "{}").message ?? "";
    fs.appendFileSync(process.env.SEEN, JSON.stringify({ at: req.method + " " + req.url, auth: req.headers.authorization ?? null, message }) + "\\n");
    const got = await fetch(process.env.MODEL_URL, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "system", content: "You help with travel." }, { role: "user", content: message }] }) }).then((r) => r.json());
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ reply: got.choices[0].message.content }));
  }).listen(${port}, "127.0.0.1");
`;

async function listening(handler) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

test("a request of ours carries a turn tag, is never the request trials copy, and never lends a trial its sign-in", { timeout: 60_000 }, async () => {
  const model = await listening(async (req, res) => {
    let body = "";
    for await (const d of req) body += d;
    const asked = JSON.parse(body).messages.at(-1).content;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: "m", choices: [{ message: { role: "assistant", content: `About ${asked}: pack light.` } }] }));
  });
  const queued = [];
  const results = new Map();
  const proofs = [];
  const api = await listening(async (req, res) => {
    let body = "";
    for await (const d of req) body += d;
    const reply = (data) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/local/attach") return reply({ box: "lo_000000000000000000000002", key: "k" });
    if (req.url.includes("/tree")) return reply({ id: "c", resumed: true });
    if (req.url.endsWith("/app")) return reply({ jobId: "raise" });
    if (req.url.endsWith("/proof")) { proofs.push(JSON.parse(body)); return reply({ ok: true }); }
    const done = /\/jobs\/([\w-]+)$/.exec(req.url);
    if (done) { results.set(done[1], JSON.parse(body || "{}")); return reply({ ok: true }); }
    if (req.url.includes("/jobs")) { await until(() => queued.length > 0, 500); return reply({ jobs: queued.splice(0) }); }
    reply({ ok: true });
  });
  let n = 0;
  const give = (body) => { const id = `j${++n}`; queued.push({ id, verb: "fetch", body }); return id; };

  const root = realpathSync(mkdtempSync(join(tmpdir(), "cortad-tagged-")));
  const probe = await listening(() => {});
  const port = probe.address().port;
  probe.close();
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "tagged", version: "1.0.0" }));
  writeFileSync(join(root, "app.js"), APP(port));
  const home = mkdtempSync(join(tmpdir(), "cortad-tagged-home-"));
  mkdirSync(homeOf(projectOf(root), join(home, ".cortad")), { recursive: true });
  writeFileSync(join(homeOf(projectOf(root), join(home, ".cortad")), "token"), "machine-key");
  const seenFile = join(home, "seen");
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, TMPDIR: tmpdir(), MODEL_URL: `http://127.0.0.1:${model.address().port}/v1/chat/completions`, SEEN: seenFile, CORTAD_ORIGIN: `http://127.0.0.1:${api.address().port}` };
  const child = spawn(process.execPath, [LOCAL, "--token", "--start", `"${process.execPath}" app.js`], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const seen = () => { try { return readFileSync(seenFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const person = "Bearer person-4f9a8b7c6d5e4f3a2b1c";
  try {
    assert.ok(await until(() => /your app is answering on port/.test(out), 30_000), out);
    await fetch(`http://127.0.0.1:${port}/chat`, { method: "POST", headers: { "content-type": "application/json", authorization: person }, body: JSON.stringify({ message: "a weekend in Lisbon" }) });
    const knock = give({ port, path: "/chat", method: "POST", headers: { "content-type": "application/json", authorization: "Bearer knock-9e8d7c6b5a4f3e2d1c0b" }, body: JSON.stringify({ message: "bl-1 the knock's own words" }) });
    assert.ok(await until(() => results.has(knock), 10_000), out);
    // The hook takes the tag off before the app reads the request; its own record keeps it.
    const traced = () => readFileSync(join(tmpdir(), `cortad-${child.pid}`, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.ex);
    assert.ok(await until(() => traced().length === 2, 5000));
    assert.deepEqual(traced().map((r) => r.turn ?? null), [null, `cortad-${knock}`], "the knock was recorded as ours");

    assert.ok(await until(() => proofs.some((p) => p.proof.exchanges === 1), 10_000), "the person's request proved the door");
    await sleep(1500);
    const last = proofs.at(-1);
    assert.deepEqual([last.template.body, last.proof.fallback], [{ message: "a weekend in Lisbon" }, undefined], "the knock is never the request trials copy");

    const trial = give({ port, path: "/chat", method: "POST", headers: { "content-type": "application/json", "x-cortad-as": "captured", "x-cortad-turn": "case-1:1" }, body: JSON.stringify({ message: "a trial's words" }) });
    assert.ok(await until(() => results.has(trial), 10_000), out);
    // Found by its words: the command's own look at the app's health is a request too, and under load
    // one came in after the trial.
    assert.equal(seen().find((r) => r.message === "a trial's words")?.auth, person, "a trial speaking as the person carries the person's sign-in, not the knock's");

    // The sign-in goes to the method and route the person's own request used, and nowhere else.
    const as = { "content-type": "application/json", "x-cortad-as": "captured" };
    const elsewhere = [
      give({ port, path: "/account/bodies", method: "POST", headers: as, body: JSON.stringify({ message: "another route" }) }),
      give({ port, path: "/chat?x=1", method: "GET", headers: as }),
    ];
    const refused = [
      give({ port, path: "/chat", method: "DELETE", headers: as }),
      give({ port, path: "/chat", method: "PUT", headers: as, body: "{}" }),
      give({ port, path: "/api/admin/reset", method: "POST", headers: as, body: "{}" }),
      give({ port, path: "/api/x/..%2F..%2Fusers/1", method: "POST", headers: as, body: "{}" }),
      give({ port, path: "/api/%75sers/1", method: "GET", headers: as }),
    ];
    assert.ok(await until(() => [...elsewhere, ...refused].every((id) => results.has(id)), 10_000), out);
    assert.equal(seen().find((r) => r.at === "POST /account/bodies")?.auth, null, "another route is sent without the person's sign-in");
    assert.equal(seen().find((r) => r.at === "GET /chat?x=1")?.auth, null, "another method on the same route is sent without it");
    for (const id of refused) assert.match(results.get(id).error ?? "", /^refused/, JSON.stringify(results.get(id)));
    // The command's own look at the app's health is a GET or HEAD of / and is left out.
    assert.deepEqual(seen().map((r) => r.at).filter((at) => !/^(?:POST \/chat|POST \/account\/bodies|GET \/chat\?x=1|(?:GET|HEAD) \/)$/.test(at)), [], "no refused request reached the app");
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    for (const s of [api, model]) { s.closeAllConnections(); s.close(); }
  }
});
