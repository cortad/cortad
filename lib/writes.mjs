// What your app writes into its own folder during a run is put back when the run ends. A run
// creates carts, tickets and uploads by the hundred; an app that keeps them in files beside its
// code kept every one after the run, and the developer's own tests read them. The hook the app
// was started with records each file the app writes while a run is on, with a copy from before
// its first write, and the command that reads the run's end puts every one back and says which.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export const writesDirOf = (home) => join(home, "writes");

// A run has started: from now until it ends, the hook records what the app writes. A record that
// is already open is kept when `keep` is set: an app started again mid-run keeps the copies made
// before it went down.
export function markRun(dir, jobId, { keep = false } = {}) {
  if (keep && existsSync(join(dir, "run"))) return;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fresh */ }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "run"), String(jobId), { mode: 0o600 });
}

// The run has ended: every file written since the record began is put back, and the line says
// which. The record begins when the command starts the app (the first run starts itself on the
// server's side, so no verb marks it) and again at every run a verb starts, so what a person wrote
// between two runs is dropped from the record rather than undone.
export function putBack(dir, root) {
  const rows = rowsOf(dir);
  const base = resolve(root);
  const done = [];
  for (const row of rows) {
    if (typeof row.path !== "string" || done.includes(row.path)) continue;
    const abs = resolve(base, row.path);
    if (!abs.startsWith(base + sep)) continue;
    try {
      if (row.before) { if (!existsSync(row.before)) continue; mkdirSync(dirname(abs), { recursive: true }); copyFileSync(row.before, abs); }
      else if (existsSync(abs)) unlinkSync(abs);
      done.push(row.path);
    } catch { /* left as the simulation left it, and not named as put back */ }
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
  return saidOf(done);
}

function rowsOf(dir) {
  try {
    return readFileSync(join(dir, "written.jsonl"), "utf8").split("\n").filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// The files the app itself wrote since the record began: its data, never a change to its code.
export const writtenPaths = (dir) => new Set(rowsOf(dir).map((row) => row.path).filter((p) => typeof p === "string"));

export function saidOf(paths) {
  if (!paths.length) return "";
  const named = paths.slice(0, 3).join(", ") + (paths.length > 3 ? ` and ${paths.length - 3} more` : "");
  return paths.length === 1
    ? `Your app wrote to ${named} during this simulation; Cortad restored it afterwards.`
    : `Your app wrote to ${named} during this simulation; Cortad restored them afterwards.`;
}
