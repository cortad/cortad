// The one process holding a project's app up, and the app's state as that process last wrote it.
// ~/.cortad/<project>/runner.json is both the lock and the record:
//   { pid, startedAt, by, version, state: "starting" | "up" | "failed", at, port?, host?, app?, error? }
// It exists only while its runner lives, so "stopped" is the absence of one. The runner is the only
// writer; every reader takes the app's state from here and never works it out again.
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeOf } from "./home.mjs";
import { elapsedMs } from "./proc.mjs";

const fileOf = (project, base) => join(homeOf(project, base), "runner.json");
const read = (file) => { try { const r = JSON.parse(readFileSync(file, "utf8")); return Number.isInteger(r?.pid) ? r : null; } catch { return null; } };
const same = (a, b) => a?.pid === b?.pid && a?.startedAt === b?.startedAt;

// When a process started, to the second: with the pid, what tells a runner from a later process that
// was handed the same pid.
export function startedAtOf(pid = process.pid) {
  if (pid === process.pid) return new Date(Date.now() - process.uptime() * 1000).toISOString();
  try { return new Date(Date.now() - elapsedMs(execFileSync("ps", ["-o", "etime=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim())).toISOString(); } catch { return null; }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
// The pid is alive and is still the process that wrote the record; ps rounds to the second.
// ponytail: a machine with no ps is taken at the pid alone, as before this check existed.
function isLive(runner) {
  if (!alive(runner.pid)) return false;
  if (runner.pid === process.pid) return true;
  const now = startedAtOf(runner.pid);
  return now === null || Math.abs(Date.parse(now) - Date.parse(runner.startedAt)) < 3000;
}

export function readRunner(project, base) {
  const runner = read(fileOf(project, base));
  return runner && isLive(runner) ? runner : null;
}

// Takes the lock for this process and returns null, or returns the live runner that holds it. A
// record left by a runner that has ended is taken over. The record is written whole and then linked
// into place, which fails if the file exists: two processes asking at once never both get it.
// ponytail: two processes finding the same stale record in the same millisecond can race on its
// removal; each re-reads it first, which leaves a window of one file operation.
export function claimRunner(project, record, base) {
  const file = fileOf(project, base);
  const mine = `${file}.${record.pid}`;
  mkdirSync(homeOf(project, base), { recursive: true, mode: 0o700 });
  writeFileSync(mine, JSON.stringify(record), { mode: 0o600 });
  try {
    for (let tries = 0; tries < 5; tries++) {
      try { linkSync(mine, file); return null; } catch (e) { if (e.code !== "EEXIST") throw e; }
      const held = read(file);
      if (held && isLive(held)) return held;
      if (same(read(file), held)) { try { rmSync(file); } catch { /* taken first; asked again */ } }
    }
    throw new Error("could not take this project's lock: another process keeps rewriting it");
  } finally { rmSync(mine, { force: true }); }
}

// The runner's own record, rewritten whole with each change of state and renamed into place, so a
// reader never sees half of it.
export function writeRunner(project, record, base) {
  const file = fileOf(project, base);
  writeFileSync(`${file}.${record.pid}`, JSON.stringify(record), { mode: 0o600 });
  renameSync(`${file}.${record.pid}`, file);
}

// Removed only by the process that holds it: a runner ending late never takes its successor's lock.
export function releaseRunner(project, base, pid = process.pid) {
  if (read(fileOf(project, base))?.pid === pid) rmSync(fileOf(project, base), { force: true });
}
