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

// The API's side of the wire, recording what the command said. `job`: the one job it hands the
// command (or several), or a function giving it once it is due.
async function wire({ app = () => [200, { jobId: "raise" }], job = null } = {}) {
  let handed = false;
  const said = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const reply = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    said.push({ method: req.method, url: req.url, body: body && !req.url.includes("/tree") ? JSON.parse(body) : null });
    if (req.url === "/api/local/attach") return reply(200, { box: `lo_${String(said.length).padStart(24, "0")}`, key: "k" });
    if (req.url.includes("/tree")) return reply(200, { id: "c", resumed: true });
    if (req.url.endsWith("/app")) return reply(...app());
    if (req.url.includes("/jobs")) {
      const due = typeof job === "function" ? job() : job;
      if (!due || handed) return setTimeout(() => { res.writeHead(204); res.end(); }, 500);
      handed = true;
      return reply(200, { jobs: [due].flat() });
    }
    return reply(200, { ok: true });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  server.unref();
  return { said, port: server.address().port, close: () => server.close() };
}

// One `npx cortad`: a connect with a code from the screen, or a runner a verb started with the key.
function command(r, api, { token = false, name = "a", path = "/usr/bin:/bin:/usr/sbin:/sbin" } = {}) {
  const env = { PATH: path, HOME: r.home, TMPDIR: tmpdir(), CORTAD_ORIGIN: `http://127.0.0.1:${api.port}`, PIDFILE: join(r.home, `${name}.pid`), STARTS: join(r.home, `${name}.starts`) };
  const child = spawn(NODE, [LOCAL, ...(token ? ["--token"] : ["ABCD2345"]), "--start", `"${NODE}" app.js`], { cwd: r.root, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  return { child, out: () => out, app: () => pidIn(env.PIDFILE), starts: () => { try { return readFileSync(env.STARTS, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } } };
}
const up = (c) => until(() => /your app is answering on port/.test(c.out()), 30_000);
const kill = (...pids) => { for (const pid of pids) { try { if (pid) process.kill(pid, "SIGKILL"); } catch { /* gone */ } } };

// Their app keeps every address in an env file its own loader reads, and nothing is in the shell.
// Handed this terminal's values alone, the reader had no address for their store and reported it as
// not set, which told a customer their own environment was wrong when it was ours that was thin.
test("their own store is read at the address their env file holds, not only the shell's", { timeout: 90_000 }, async () => {
  const r = repo();
  mkdirSync(join(r.root, "corpus"));
  writeFileSync(join(r.root, "corpus/appeal-windows.md"), "# An appeal is filed within thirty days\nmore\n");
  writeFileSync(join(r.root, ".env"), "DOCS_PATH=corpus\n");
  const api = await wire({ job: { id: "read-their-stores", verb: "sample", body: { stores: [{ road: "retrieval.files", kind: "files", env: ["DOCS_PATH"] }] } } });
  const c = command(r, api, { name: "stores" });
  try {
    assert.ok(await up(c), c.out());
    assert.ok(await until(() => api.said.some((s) => s.url.endsWith("/jobs/read-their-stores")), 30_000), c.out());
    const store = api.said.find((s) => s.url.endsWith("/jobs/read-their-stores")).body.report.stores[0];
    assert.equal(store.status, "sampled");
    assert.deepEqual(store.rows, [{ where: "DOCS_PATH#appeal-windows.md", fields: { file: "appeal-windows.md", heading: "An appeal is filed within thirty days" } }]);
  } finally { kill(c.child.pid, c.app()); api.close(); }
});

// A tool whose function the hook did not wrap was said never to have run (2026-11-02). The usage
// answer a run reads says which listed tools this start of the app wrapped and which it could not.
test("the usage answer says which listed tools the app's start wrapped and which it could not", { timeout: 60_000 }, async () => {
  const r = repo();
  writeFileSync(join(r.root, "tools.js"), "exports.makeCards = (topic) => [{ front: topic, back: \"a force\" }];\n");
  writeFileSync(join(r.root, "app.js"), `
    require("./tools.js");
    require("node:fs").writeFileSync(process.env.PIDFILE, String(process.pid));
    require("node:http").createServer((q, r) => r.end("ok")).listen(0, "127.0.0.1");
  `);
  writeFileSync(join(homeOf(r.project, r.base), "tools.json"), JSON.stringify([{ name: "make_cards", file: "tools.js", function: "makeCards" }, { name: "view_page", file: "tools.js", function: "viewPage" }]));
  let c;
  const api = await wire({ job: () => (c && /your app is answering on port/.test(c.out()) ? { id: "usage", verb: "usage", body: {} } : null) });
  c = command(r, api, { name: "usage" });
  try {
    assert.ok(await up(c), c.out());
    assert.ok(await until(() => api.said.some((s) => s.url.endsWith("/jobs/usage")), 30_000), c.out());
    assert.deepEqual(api.said.find((s) => s.url.endsWith("/jobs/usage")).body.tools, { wrapped: ["make_cards"], unwatched: ["view_page"] });
  } finally { kill(c.child.pid, c.app()); api.close(); }
});

// The server may ask this machine for its own named operations and nothing else: a command it writes
// is refused and noted here, the project's test command runs offline with no env file readable, and
// the app's output comes back 2,000 bytes at most.
test("a command the server sends is refused and noted; the named test operation runs locked and offline; a log answer is capped", { timeout: 90_000, skip: process.platform !== "darwin" && process.platform !== "linux" }, async () => {
  const r = repo();
  writeFileSync(join(r.root, "package.json"), JSON.stringify({ name: "life", version: "1.0.0", scripts: { test: "node probe.js" } }));
  writeFileSync(join(r.root, ".env"), "SECRET_NOTE=the-env-file-was-read\n");
  writeFileSync(join(r.root, "probe.js"), `
    let env = "hidden"; try { env = require("node:fs").readFileSync(".env", "utf8").trim(); } catch {}
    require("node:net").connect(443, "1.1.1.1").on("connect", () => { console.log("online", env); process.exit(0); }).on("error", () => { console.log("offline", env); process.exit(0); });
  `);
  writeFileSync(join(r.root, "app.js"), `
    console.log("y".repeat(6000));
    require("node:fs").writeFileSync(process.env.PIDFILE, String(process.pid));
    require("node:http").createServer((q, r) => r.end("ok")).listen(0, "127.0.0.1");
  `);
  const pwned = join(r.root, "pwned");
  let c;
  const api = await wire({ job: () => (c && /your app is answering on port/.test(c.out()) ? [
    { id: "free", verb: "exec", body: { cmd: `touch ${pwned}`, opts: { app: true } } },
    { id: "unknown", verb: "exec", body: { op: "constructor" } },
    { id: "tests", verb: "exec", body: { op: "test" } },
    { id: "log", verb: "log", body: { bytes: 200000 } },
  ] : null) });
  c = command(r, api, { name: "ops", path: `${dirname(NODE)}:/usr/bin:/bin:/usr/sbin:/sbin` });
  const answer = (id) => api.said.find((s) => s.url.endsWith(`/jobs/${id}`))?.body;
  try {
    assert.ok(await up(c), c.out());
    assert.ok(await until(() => ["free", "unknown", "tests", "log"].every(answer), 60_000), c.out());
    for (const id of ["free", "unknown"]) assert.deepEqual([answer(id).success, answer(id).exitCode, /^refused/.test(answer(id).stderr)], [false, 126, true], id);
    assert.ok(!existsSync(pwned), "the server's command ran");
    assert.match(readFileSync(join(homeOf(r.project, r.base), "refused.log"), "utf8"), /touch .*pwned/);
    assert.match(c.out(), /refused a command Cortad's server sent/);
    assert.match(answer("tests").stdout, /offline hidden/, JSON.stringify(answer("tests")));
    assert.ok(answer("log").text.length <= 2000 && answer("log").text.length > 1000, String(answer("log").text.length));
  } finally { kill(c.child.pid, c.app()); api.close(); }
});

describe("the runner owns the app's life", { concurrency: true }, () => {
  test("a second connect in the same project is refused before it signs in, and a runner a verb starts beside it leaves: one runner, one app", { timeout: 90_000 }, async () => {
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

      const attaches = api.said.filter((s) => s.url === "/api/local/attach").length;
      second = command(r, api, { name: "b" });
      const [refused] = await once(second.child, "exit");
      assert.equal(refused, 1);
      assert.match(second.out(), new RegExp(`another cortad is already connected in this folder: pid ${first.child.pid}, started \\d\\d:\\d\\d, with your app answering on port \\d+\\. Nothing was changed\\.`));
      assert.equal(api.said.filter((s) => s.url === "/api/local/attach").length, attaches, "the refused connect never signed in");
      assert.equal(second.starts(), 0);
      assert.ok(alive(first.child.pid) && alive(firstApp), "the first connect and its app run on");

      third = command(r, api, { token: true, name: "c" });
      const [code] = await once(third.child, "exit");
      assert.equal(code, 0);
      assert.match(third.out(), new RegExp(`pid ${first.child.pid} already holds this project's app up and serves the simulation`));
      assert.equal(third.starts(), 0, "the runner that left never started an app");
      assert.equal(readRunner(r.project, r.base).pid, first.child.pid);

      first.child.kill("SIGTERM");
      await once(first.child, "exit");
      assert.equal(alive(firstApp), false);
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

// `npx -y cortad --help` connected with the saved key and start command, and the server ended the
// session running in that folder, which stopped the person's app.
test("help, and any flag this version does not know, print the usage and connect nothing", { timeout: 30_000 }, async () => {
  const r = repo();
  writeFileSync(join(homeOf(r.project, r.base), "start.json"), JSON.stringify({ cmd: `"${NODE}" app.js` }));
  const api = await wire();
  try {
    for (const args of [["--help"], ["-h"], ["help"], ["--bogus"], ["ABCD2345", "--nope", "--", "npm", "start"]]) {
      const child = spawn(NODE, [LOCAL, ...args], { cwd: r.root, env: { PATH: "/usr/bin:/bin", HOME: r.home, TMPDIR: tmpdir(), CORTAD_ORIGIN: `http://127.0.0.1:${api.port}` }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      const [code] = await once(child, "exit");
      assert.equal(code, 0, args.join(" "));
      assert.match(out, /^usage: npx cortad /, args.join(" "));
    }
    assert.deepEqual(api.said, [], "nothing reached the server");
  } finally { api.close(); }
});
