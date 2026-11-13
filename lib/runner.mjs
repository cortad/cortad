import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeOf } from "./home.mjs";
import { elapsedMs } from "./proc.mjs";

const fileOf = (project, base) => join(homeOf(project, base), "runner.json");
const read = (file) => { try { const r = JSON.parse(readFileSync(file, "utf8")); return Number.isInteger(r?.pid) ? r : null; } catch { return null; } };
const same = (a, b) => a?.pid === b?.pid && a?.startedAt === b?.startedAt;

export function startedAtOf(pid = process.pid) {
  if (pid === process.pid) return new Date(Date.now() - process.uptime() * 1000).toISOString();
  try { return new Date(Date.now() - elapsedMs(execFileSync("ps", ["-o", "etime=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim())).toISOString(); } catch { return null; }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

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
      if (same(read(file), held)) { try { rmSync(file); } catch {  } }
    }
    throw new Error("could not take this project's lock: another process keeps rewriting it");
  } finally { rmSync(mine, { force: true }); }
}

export function writeRunner(project, record, base) {
  const file = fileOf(project, base);
  writeFileSync(`${file}.${record.pid}`, JSON.stringify(record), { mode: 0o600 });
  renameSync(`${file}.${record.pid}`, file);
}

export function releaseRunner(project, base, pid = process.pid) {
  if (read(fileOf(project, base))?.pid === pid) rmSync(fileOf(project, base), { force: true });
}
