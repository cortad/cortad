// The connect command runs the person's own start command and nothing else: no guess acted on, no env
// file handed to the app, nothing copied or started beside it. One customer's app was handed a test file's
// placeholder key and its library was copied into an empty container (2026-10-14); their coding agent
// knew how the app starts and was never asked.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { homeOf, projectOf } from "./home.mjs";

const LOCAL = join(dirname(fileURLToPath(import.meta.url)), "..", "local.mjs");
// An app that answers on the port its terminal gives it and says what its environment holds.
const APP = `require("node:http").createServer((q, s) => { s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ flag: process.env.SECRET_FLAG ?? null })); }).listen(process.env.PORT, "127.0.0.1");\n`;

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cortad-attach-")));
  writeFileSync(join(root, "app.js"), APP);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "attach-test", scripts: { start: "node app.js" } }));
  // Read by the app's own loader if it had one; the command must never hand it over.
  writeFileSync(join(root, ".env"), "SECRET_FLAG=from-the-env-file\n");
  const home = mkdtempSync(join(tmpdir(), "cortad-attach-home-"));
  return { root, home, project: homeOf(projectOf(root), join(home, ".cortad")) };
}

// A stand-in for the server: what the command announced, and how many requests reached it at all.
async function api() {
  const seen = { hits: 0, apps: [], stopped: [] };
  let announced;
  const told = new Promise((r) => { announced = r; });
  const server = createServer(async (req, res) => {
    seen.hits += 1;
    let body = "";
    for await (const d of req) body += d;
    const reply = (data, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/local/attach") return reply({ box: "lo_0123456789abcdef01234567", key: "k" });
    if (req.url.includes("/tree")) return reply({ id: "c", resumed: true, machineKey: "cm_test" });
    if (req.url.endsWith("/commits/last")) return reply({ sha: null });
    if (req.url.endsWith("/app")) { const b = JSON.parse(body); seen.apps.push(b); announced(b); return reply({ ok: true }); }
    if (req.url.endsWith("/stopped")) { seen.stopped.push(JSON.parse(body)); return reply({ ok: true }); }
    if (req.url.includes("/jobs")) return setTimeout(() => { res.writeHead(204); res.end(); }, 500);
    reply({ ok: true });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, seen, told, origin: `http://127.0.0.1:${server.address().port}` };
}

const run = (args, { root, home, origin, extra = {} }) => {
  const child = spawn(process.execPath, [LOCAL, ...args], { cwd: root, env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(), CORTAD_NO_REGISTER: "1", CORTAD_ORIGIN: origin, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  return { child, out: () => out };
};
const freePort = async () => { const s = createServer().listen(0, "127.0.0.1"); await once(s, "listening"); const port = s.address().port; s.close(); return port; };

test("with no start command the one suggestion is printed, nothing is sent, and nothing starts", async () => {
  const { root, home } = repo();
  const { server, seen, origin } = await api();
  const { child, out } = run(["ABCD2345"], { root, home, origin });
  const [code] = await once(child, "exit");
  server.close();
  assert.equal(code, 2);
  assert.match(out(), /how does your app start\? Run this again with your command after --:/);
  assert.match(out(), /npx cortad ABCD2345 -- npm run start   \(from this folder that looks like it; change it if not\)/);
  assert.match(out(), /or, if your app is already running:   npx cortad ABCD2345 --port <its port>/);
  assert.equal(seen.hits, 0, "nothing was sent");
});

test("the command runs as typed with the terminal's environment and the hook, the env file is never handed over, and the start is kept for the runner", { timeout: 90_000 }, async () => {
  const { root, home, project } = repo();
  const { server, seen, told, origin } = await api();
  const port = await freePort();
  const { child, out } = run(["ABCD2345", "--", "node", "app.js"], { root, home, origin, extra: { PORT: String(port) } });
  const body = await Promise.race([told, once(child, "exit").then(() => null), new Promise((r) => setTimeout(r, 60_000, null))]);
  assert.ok(body, `no announce; the command said:\n${out()}`);
  assert.equal(body.port, port, "the app answers on the port its terminal gave it");
  assert.equal(body.cmd, "node app.js");
  assert.equal(body.proves, true, "the hook is inside the app");
  assert.deepEqual(Object.keys(body).sort(), ["cmd", "lifted", "metered", "port", "proves", "reached", "watching"], "no copy, hold, setup or account field travels");
  assert.deepEqual(body.lifted, []);
  const answered = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.json());
  assert.equal(answered.flag, null, "the env file's value never reached the app from the command");
  const kept = JSON.parse(readFileSync(join(project, "start.json"), "utf8"));
  assert.deepEqual(kept, { cmd: "node app.js" });
  assert.match(out(), /starting your app with: node app\.js/);
  assert.ok(!/copy|copied|compose/.test(out()), `nothing about copies is said:\n${out()}`);
  child.kill("SIGINT");
  await once(child, "exit");
  server.close();
  assert.ok(seen.stopped.length === 0, "a clean exit is not a stop of the app's");
});

test("a reconnect with the code alone reuses the saved start command, and says so", { timeout: 90_000 }, async () => {
  const { root, home, project } = repo();
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "start.json"), JSON.stringify({ cmd: "node app.js" }));
  const { server, told, origin } = await api();
  const port = await freePort();
  const { child, out } = run(["ABCD2345"], { root, home, origin, extra: { PORT: String(port) } });
  const body = await Promise.race([told, once(child, "exit").then(() => null), new Promise((r) => setTimeout(r, 60_000, null))]);
  assert.ok(body, `no announce; the command said:\n${out()}`);
  assert.equal(body.cmd, "node app.js");
  assert.match(out(), /starting your app with: node app\.js \(saved from your last connect\)/);
  child.kill("SIGINT");
  await once(child, "exit");
  server.close();
});

test("the runner started for a later simulation reuses the saved start command", { timeout: 90_000 }, async () => {
  const { root, home, project } = repo();
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "token"), "cm_test");
  writeFileSync(join(project, "start.json"), JSON.stringify({ cmd: "node app.js" }));
  const { server, told, origin } = await api();
  const port = await freePort();
  const { child, out } = run(["--token"], { root, home, origin, extra: { PORT: String(port) } });
  const body = await Promise.race([told, once(child, "exit").then(() => null), new Promise((r) => setTimeout(r, 60_000, null))]);
  assert.ok(body, `no announce; the runner said:\n${out()}`);
  assert.equal(body.cmd, "node app.js");
  assert.match(out(), /starting your app with: node app\.js \(saved from your last connect\)/);
  child.kill("SIGINT");
  await once(child, "exit");
  server.close();
});

test("a runner with no saved start command says what to run once, and starts nothing", async () => {
  const { root, home, project } = repo();
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "token"), "cm_test");
  const { server, seen, origin } = await api();
  const { child, out } = run(["--token"], { root, home, origin });
  const [code] = await once(child, "exit");
  server.close();
  assert.equal(code, 1);
  assert.match(out(), /no saved start command\. Run npx cortad <code> -- <how you start your app> in this folder once\./);
  assert.equal(seen.hits, 0);
  assert.ok(!existsSync(join(project, "start.json")));
});
