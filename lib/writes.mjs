import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export const writesDirOf = (home) => join(home, "writes");

export function markRun(dir, jobId, { keep = false } = {}) {
  if (keep && existsSync(join(dir, "run"))) return;
  try { rmSync(dir, { recursive: true, force: true }); } catch {  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "run"), String(jobId), { mode: 0o600 });
}

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
    } catch {  }
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch {  }
  return saidOf(done);
}

function rowsOf(dir) {
  try {
    return readFileSync(join(dir, "written.jsonl"), "utf8").split("\n").filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export const writtenPaths = (dir) => new Set(rowsOf(dir).map((row) => row.path).filter((p) => typeof p === "string"));

export function saidOf(paths) {
  if (!paths.length) return "";
  const named = paths.slice(0, 3).join(", ") + (paths.length > 3 ? ` and ${paths.length - 3} more` : "");
  return paths.length === 1
    ? `Your app wrote to ${named} during this simulation; Cortad restored it afterwards.`
    : `Your app wrote to ${named} during this simulation; Cortad restored them afterwards.`;
}
