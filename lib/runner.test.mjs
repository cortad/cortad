import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { homeOf } from "./home.mjs";
import { claimRunner, readRunner, releaseRunner, startedAtOf, writeRunner } from "./runner.mjs";

const RUNNER = new URL("./runner.mjs", import.meta.url).href;
const mine = (state = "starting") => ({ pid: process.pid, startedAt: startedAtOf(), by: "test", state, at: new Date().toISOString() });

// A process that asks for the project's lock the way local.mjs does, says whether it got it, and
// then holds it until told to leave.
function contender(base) {
  const code = `
    import { claimRunner, releaseRunner, startedAtOf } from ${JSON.stringify(RUNNER)};
    process.on("exit", () => releaseRunner("p1", ${JSON.stringify(base)}));
    process.on("SIGTERM", () => process.exit(0));
    const held = claimRunner("p1", { pid: process.pid, startedAt: startedAtOf(), by: "test", state: "starting" }, ${JSON.stringify(base)});
    console.log(held ? "held " + held.pid : "won");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  return { child, said: once(child.stdout, "data").then(([d]) => String(d).trim()) };
}

test("one runner per project: of eight processes asking at once exactly one holds it, and the others are told who", { timeout: 20_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), "cortad-lock-"));
  const all = Array.from({ length: 8 }, () => contender(base));
  try {
    const said = await Promise.all(all.map((c) => c.said));
    const winners = all.filter((_, i) => said[i] === "won");
    assert.equal(winners.length, 1, said.join(", "));
    const winner = winners[0].child.pid;
    assert.ok(said.every((s) => s === "won" || s === `held ${winner}`), said.join(", "));
    assert.equal(readRunner("p1", base).pid, winner);
    assert.equal(statSync(join(homeOf("p1", base), "runner.json")).mode & 0o777, 0o600);
  } finally { for (const c of all) c.child.kill("SIGKILL"); }
});

test("a record left by a runner that ended is taken over, and so is one whose pid now belongs to another process", async () => {
  const base = mkdtempSync(join(tmpdir(), "cortad-lock-"));
  const gone = spawn(process.execPath, ["-e", ""]);
  await once(gone, "exit");
  assert.equal(claimRunner("p1", { pid: gone.pid, startedAt: new Date().toISOString(), by: "test", state: "up" }, base), null);
  assert.equal(readRunner("p1", base), null, "a dead pid is no runner");
  assert.equal(claimRunner("p1", mine(), base), null);
  assert.equal(readRunner("p1", base).pid, process.pid);

  // This process's pid, recorded by a process that started an hour before it: a pid handed on.
  const other = mkdtempSync(join(tmpdir(), "cortad-lock-"));
  assert.equal(claimRunner("p1", { ...mine(), pid: process.ppid, startedAt: new Date(Date.now() - 3_600_000).toISOString() }, other), null);
  assert.equal(readRunner("p1", other), null, "a pid now running another process is no runner");
  assert.equal(claimRunner("p1", mine(), other), null);
});

test("the holder's state is rewritten whole, and only the holder removes the record", () => {
  const base = mkdtempSync(join(tmpdir(), "cortad-lock-"));
  assert.equal(claimRunner("p1", mine(), base), null);
  writeRunner("p1", { ...mine("failed"), error: "port 8000 is in use by another program (pid 4242, python main.py)" }, base);
  assert.deepEqual([readRunner("p1", base).state, readRunner("p1", base).error], ["failed", "port 8000 is in use by another program (pid 4242, python main.py)"]);
  releaseRunner("p1", base, process.pid + 1);
  assert.equal(readRunner("p1", base).pid, process.pid, "a runner ending late never takes its successor's record");
  releaseRunner("p1", base);
  assert.equal(existsSync(join(homeOf("p1", base), "runner.json")), false);
});
