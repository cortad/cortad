// Every run is kept, in their repository, as a file they can read. A run is what makes the next one
// mean anything: the same people answered the same questions, so what moved is the change they made
// and not the weather.
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNS } from "./suite/files.mjs";

// ponytail: the last twenty. A run holds its transcripts, so keeping every one of them forever grows
// a repository for no one's benefit. Twenty is enough for a trend and small enough to commit.
const KEEP = 20;

const numbered = (root) => {
  const dir = join(root, RUNS);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).sort();
};

export function write(run, root = ".") {
  const dir = join(root, RUNS);
  mkdirSync(dir, { recursive: true });
  const held = numbered(root);
  const next = String(Number(held.at(-1)?.replace(".json", "") ?? 0) + 1).padStart(4, "0");
  const at = join(dir, `${next}.json`);
  writeFileSync(at, `${JSON.stringify(run, null, 2)}\n`);
  for (const old of held.slice(0, Math.max(0, held.length + 1 - KEEP))) unlinkSync(join(dir, old));
  return at;
}

export function last(root = ".") {
  const held = numbered(root);
  const at = held.at(-1);
  if (!at) return null;
  try { return JSON.parse(readFileSync(join(root, RUNS, at), "utf8")); } catch { return null; }
}

export function all(root = ".") {
  return numbered(root).map((f) => {
    try { return JSON.parse(readFileSync(join(root, RUNS, f), "utf8")); } catch { return null; }
  }).filter(Boolean);
}
