import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { homeOf, projectOf } from "./home.mjs";
import { readRunner } from "./runner.mjs";

// The whole command, run as a person or an agent runs it, against real small apps. A stand-in for
// our API answers the wire (sign-in, upload, the app's announce, the job poll), which is all the
// lifecycle touches; every process here is real, and every one is looked for after it should be gone.
const LOCAL = join(dirname(fileURLToPath(import.meta.url)), "..", "local.mjs");
const NODE = process.execPath;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (done, ms) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await done()) return true; return done(); };
const pidIn = (file) => { try { return Number(readFileSync(file, "utf8").trim()) || null; } catch { return null; } };

// A repository whose app writes its pid where the test can find it and counts each start. `port`:
// set in the app's own code; otherwise it takes any free port. `host`: "" binds every interface.
function repo({ port = 0, host = "127.0.0.1" } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cortad-life-")));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "life", version: "1.0.0" }));
  writeFileSync(join(root, "app.js"), `
    const fs = require("node:fs");
    fs.appendFileSync(process.env.STARTS, "start\\n");
    fs.writeFileSync(process.env.PIDFILE, String(process.pid));
    require("node:http").createServer((q, r) => r.end("ok")).listen(${port}${host ? `, "${host}"` : ""});
  `);
  const home = mkdtempSync(join(tmpdir(), "cortad-life-home-"));
  mkdirSync(homeOf(projectOf(root), join(home, ".cortad")), { recursive: true });
  writeFileSync(join(homeOf(projectOf(root), join(home, ".cortad")), "token"), "machine-key");
  return { root, home, base: join(home, ".cortad"), project: projectOf(root) };
}

// The API's side of the wire, recording what the command said.
async function wire({ app = () => [200, { jobId: "raise" }] } = {}) {
  const said = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const reply = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    said.push({ method: req.method, url: req.url, body: body && !req.url.includes("/tree") ? JSON.parse(body) : null });
    if (req.url === "/api/local/attach") return reply(200, { box: `lo_${String(said.length).padStart(24, "0")}`, key: "k" });
    if (req.url.includes("/tree")) return reply(200, { id: "c", resumed: true });
    if (req.url.endsWith("/app")) return reply(...app());
    if (req.url.includes("/jobs")) return setTimeout(() => { res.writeHead(204); res.end(); }, 500);
    return reply(200, { ok: true });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  server.unref();
  return { said, port: server.address().port, close: () => server.close() };
}

// One `npx cortad`: a connect with a code from the screen, or a runner a verb started with the key.
function command(r, api, { token = false, name = "a" } = {}) {
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: r.home, TMPDIR: tmpdir(), CORTAD_ORIGIN: `http://127.0.0.1:${api.port}`, PIDFILE: join(r.home, `${name}.pid`), STARTS: join(r.home, `${name}.starts`) };
  const child = spawn(NODE, [LOCAL, ...(token ? ["--token"] : ["ABCD2345"]), "--start", `"${NODE}" app.js`], { cwd: r.root, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  return { child, out: () => out, app: () => pidIn(env.PIDFILE), starts: () => { try { return readFileSync(env.STARTS, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } } };
}
const up = (c) => until(() => /your app is answering on port/.test(c.out()), 30_000);
const kill = (...pids) => { for (const pid of pids) { try { if (pid) process.kill(pid, "SIGKILL"); } catch { /* gone */ } } };

describe("the runner owns the app's life", { concurrency: true }, () => {
  test("a second connect in the same project replaces the first, and a runner a verb starts beside it leaves: one runner, one app", { timeout: 90_000 }, async () => {
    const r = repo();
    const api = await wire();
    const first = command(r, api, { name: "a" });
    let second, third;
    try {
      assert.ok(await up(first), first.out());
      assert.equal(readRunner(r.project, r.base).pid, first.child.pid);
      assert.equal(readRunner(r.project, r.base).state, "up");
      assert.equal(readRunner(r.project, r.base).host, "127.0.0.1", "where reach sends, read off the record");
      const firstApp = first.app();

      second = command(r, api, { name: "b" });
      assert.ok(await up(second), second.out());
      assert.match(second.out(), new RegExp(`an earlier cortad \\(pid ${first.child.pid}\\) is holding this project's app up; stopping it so only this one runs`));
      assert.equal(first.child.exitCode, 0, first.out());
      assert.equal(alive(firstApp), false, "the first connect's app is gone");
      assert.ok(alive(second.app()));
      assert.deepEqual([readRunner(r.project, r.base).pid, readRunner(r.project, r.base).app !== null], [second.child.pid, true]);

      third = command(r, api, { token: true, name: "c" });
      const [code] = await once(third.child, "exit");
      assert.equal(code, 0);
      assert.match(third.out(), new RegExp(`pid ${second.child.pid} already holds this project's app up and serves the run`));
      assert.equal(third.starts(), 0, "the runner that left never started an app");
      assert.equal(readRunner(r.project, r.base).pid, second.child.pid);

      const secondApp = second.app();
      second.child.kill("SIGTERM");
      await once(second.child, "exit");
      assert.equal(alive(secondApp), false);
      assert.equal(existsSync(join(homeOf(r.project, r.base), "runner.json")), false, "the record goes with its runner");
    } finally { kill(first.child.pid, second?.child.pid, third?.child.pid, first.app(), second?.app()); api.close(); }
  });

  // A customer stopped this command and ran it again for every environment variable he changed,
  // because nothing here read his env file; one of his apps was left running each time he did it.
  test("a value saved in an env file starts the app again on the connection that is already open, once", { timeout: 90_000 }, async () => {
    const r = repo();
    writeFileSync(join(r.root, ".env"), "GREETING=hello\n");
    const api = await wire();
    const c = command(r, api, { name: "env" });
    try {
      assert.ok(await up(c), c.out());
      const was = c.app();
      assert.equal(c.starts(), 1);
      writeFileSync(join(r.root, ".env"), "GREETING=hola\n");
      assert.ok(await until(() => c.starts() === 2, 30_000), c.out());
      assert.match(c.out(), /starting your app again so it reads the value you saved in your env file, which your app reads only when it starts/);
      assert.ok(await until(() => c.app() && c.app() !== was, 30_000), c.out());
      assert.equal(alive(was), false, "the app that read the old value is gone");
      assert.equal(c.child.exitCode, null, "the connection held: nobody had to stop this command");
      assert.equal(readRunner(r.project, r.base).pid, c.child.pid);
      await new Promise((done) => setTimeout(done, 5000));
      assert.equal(c.starts(), 2, "started again for the save, and not once more");
    } finally { kill(c.child.pid, c.app()); api.close(); }
  });

  for (const [how, signal] of [["hung up on (its terminal or shell closed)", "SIGHUP"], ["killed outright", "SIGKILL"]]) {
    test(`a runner ${how} takes its app with it`, { timeout: 60_000 }, async () => {
      const r = repo();
      const api = await wire();
      const c = command(r, api, { token: true });
      try {
        assert.ok(await up(c), c.out());
        const app = c.app();
        c.child.kill(signal);
        await once(c.child, "exit");
        assert.ok(await until(() => !alive(app), 8000), `app ${app} outlived its runner`);
        assert.equal(readRunner(r.project, r.base), null);
      } finally { kill(c.child.pid, c.app()); api.close(); }
    });
  }

  test("a runner that fails after the app is up stops the app on its way out", { timeout: 60_000 }, async () => {
    const r = repo();
    const api = await wire({ app: () => [409, { error: "upload the tree first" }] });
    const c = command(r, api, { token: true });
    try {
      const [code] = await once(c.child, "exit");
      assert.equal(code, 1, c.out());
      assert.match(c.out(), /upload the tree first/);
      assert.ok(await until(() => !alive(c.app()), 5000), "the app outlived the runner's failure");
      assert.equal(readRunner(r.project, r.base), null);
    } finally { kill(c.child.pid, c.app()); api.close(); }
  });

  // Bound to loopback, Node names the port as 127.0.0.1:PORT; bound to every interface, as :::PORT.
  // The second once restarted the app about every second, forever; the first attached to the other
  // program as if it were the app.
  for (const host of ["127.0.0.1", ""]) test(`a port the app sets in its own code (${host || "every interface"}), held by another program, is named once with its pid and command, and the app is not started again`, { timeout: 60_000 }, async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "cortad-elsewhere-"));
    writeFileSync(join(elsewhere, "holder.js"), `const s = require("node:http").createServer((q, r) => r.end("another program")); s.listen(0, ${host ? `"${host}"` : "undefined"}, () => console.log(s.address().port));`);
    const holder = spawn(NODE, ["holder.js"], { cwd: elsewhere, stdio: ["ignore", "pipe", "inherit"] });
    const port = Number(String((await once(holder.stdout, "data"))[0]).trim());
    const r = repo({ port, host });
    const api = await wire();
    const c = command(r, api, { token: true });
    try {
      assert.ok(await until(() => readRunner(r.project, r.base)?.state === "failed", 30_000), c.out());
      const held = `port ${port} is in use by another program (pid ${holder.pid}, node holder.js), so your app cannot listen there. Stop that program and save a file here, and your app is started again by itself; or run this command with --port ${port} to use the one running as it is.`;
      assert.ok(readRunner(r.project, r.base).error.startsWith(held), readRunner(r.project, r.base).error);
      await new Promise((done) => setTimeout(done, 8000));
      assert.equal(c.starts(), 1, "started once, never again against the same holder");
      assert.equal(c.out().split(held).length - 1, 1, c.out());
      assert.equal(api.said.filter((s) => s.url.endsWith("/stopped")).length, 1);
      assert.equal(c.child.exitCode, null, "the runner stays, waiting for a change");
      assert.ok(alive(holder.pid), "the other program is never touched");
      assert.doesNotMatch(c.out(), /your app is already running/, "another program is never taken for the app");
    } finally { kill(c.child.pid, c.app(), holder.pid); api.close(); }
  });
});
