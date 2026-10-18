import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { holderOf, portInError, spawnTied } from "./proc.mjs";

const PROC = new URL("./proc.mjs", import.meta.url).href;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const refused = (port) => new Promise((done) => { const s = connect({ host: "127.0.0.1", port }); s.once("connect", () => { s.destroy(); done(false); }); s.once("error", () => done(true)); });
const until = async (done, ms) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await done()) return true; return done(); };

// An app the way a dev server runs: a server, and a worker it starts in a process group of its own,
// as nodemon and concurrently do with the real server.
function appDir() {
  const dir = mkdtempSync(join(tmpdir(), "cortad-proc-"));
  writeFileSync(join(dir, "app.js"), `
    const { spawn } = require("node:child_process");
    const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    const s = require("node:http").createServer((q, r) => r.end("ok"));
    s.listen(0, "127.0.0.1", () => console.log("up", s.address().port, process.pid, worker.pid));
  `);
  return dir;
}

// A runner in its own process: it starts the app tied to itself, says where it is, then ends the way
// the test asks. "wait" leaves the ending to a signal.
async function runner(ending) {
  const dir = appDir();
  const code = `
    import { spawnTied } from ${JSON.stringify(PROC)};
    const app = spawnTied(${JSON.stringify(`"${process.execPath}" app.js`)}, { cwd: ${JSON.stringify(dir)}, env: process.env });
    app.stdout.on("data", (d) => {
      process.stdout.write(d);
      if (${JSON.stringify(ending)} === "throw") setTimeout(() => { throw new Error("a bug in the runner"); }, 50);
    });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
  const [line] = await once(child.stdout, "data");
  const [, port, app, worker] = String(line).trim().split(" ").map(Number);
  return { child, port, app, worker };
}

describe("an app started tied to its runner", { concurrency: true }, () => {
  for (const [how, end] of [["killed outright", (r) => r.child.kill("SIGKILL")], ["ended by an uncaught error", () => {}], ["hung up on", (r) => r.child.kill("SIGHUP")]]) {
    test(`stops with the runner ${how}, the worker in its own group with it, and frees its port`, { timeout: 20_000 }, async () => {
      const r = await runner(how === "ended by an uncaught error" ? "throw" : "wait");
      try {
        assert.ok(alive(r.app) && alive(r.worker) && !(await refused(r.port)));
        end(r);
        await once(r.child, "exit");
        assert.ok(await until(() => !alive(r.app) && !alive(r.worker), 8000), `app ${r.app} or worker ${r.worker} outlived the runner`);
        assert.ok(await refused(r.port));
      } finally {
        for (const pid of [r.app, r.worker]) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      }
    });
  }
});

// A customer's second connect found the app from his first one still serving: his start command
// handed the port to a child and exited, nothing read the group it left, and the watchdog had gone
// with the leader. Two copies of his app were alive on his machine, writing to his data.
test("a server the start command hands off and leaves behind is stopped as its leader exits, while the runner is still up", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cortad-handoff-"));
  writeFileSync(join(dir, "hand.js"), `
    const serve = "process.on('SIGTERM', () => {}); const s = require('node:http').createServer((q, r) => r.end('ok')); s.listen(0, '127.0.0.1', () => console.log('up', s.address().port, process.pid));";
    require("node:child_process").spawn(process.execPath, ["-e", serve], { stdio: ["ignore", "inherit", "inherit"] });
    setTimeout(() => process.exit(3), 300);
  `);
  const app = spawnTied(`"${process.execPath}" hand.js`, { cwd: dir, env: process.env });
  const [line] = await once(app.stdout, "data");
  const [, port, served] = String(line).trim().split(" ").map(Number);
  try {
    assert.ok(alive(served) && !(await refused(port)));
    const [code] = await once(app, "exit");
    assert.equal(code, 3, "the leader exited and the server it started did not");
    assert.ok(await until(() => !alive(served), 10_000), `the server ${served} outlived the start command that left it`);
    assert.ok(await refused(port), "its port is free for the next start");
  } finally { try { process.kill(served, "SIGKILL"); } catch { /* gone */ } }
});

test("the holder of a port is named by its pid, its program and its first argument, and the folder it runs in", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cortad-holder-"));
  writeFileSync(join(dir, "holder.js"), `const s = require("node:http").createServer(); s.listen(0, "127.0.0.1", () => console.log(s.address().port));`);
  const child = spawn(process.execPath, ["holder.js", "--token=never-shown"], { cwd: dir, stdio: ["ignore", "pipe", "inherit"] });
  try {
    const port = Number(String((await once(child.stdout, "data"))[0]).trim());
    assert.deepEqual(await holderOf(port), { port, pid: child.pid, command: "node holder.js", cwd: realpathSync(dir) });
    child.kill("SIGKILL");
    await once(child, "exit");
    assert.equal(await holderOf(port), null);
  } finally { child.kill("SIGKILL"); }
});

test("the port a bind failure names is read from each framework's own words, and none from words that name none", () => {
  assert.equal(portInError("Error: listen EADDRINUSE: address already in use 127.0.0.1:51597"), 51597);
  assert.equal(portInError("Error: listen EADDRINUSE: address already in use :::3000"), 3000);
  assert.equal(portInError("ERROR:    [Errno 48] error while attempting to bind on address ('0.0.0.0', 8000): address already in use"), 8000);
  assert.equal(portInError("listen tcp 0.0.0.0:8080: bind: address already in use"), 8080);
  assert.equal(portInError("Address already in use - bind(2) for \"127.0.0.1\" port 3000 (Errno::EADDRINUSE)"), 3000);
  assert.equal(portInError("OSError: [Errno 98] Address already in use"), 0);
});
