// Their own eval files, read and asked as questions. A team with an evals folder gets a suite in
// thirty seconds without writing anything, and every question it asks carries the file and the row
// it came from, so a failure has an address in their repository rather than in ours.
//
// Nothing is guessed about a file's meaning. A row has to name both a thing someone asked and a
// thing the answer has to do, or it is not read at all.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ASKED = ["question", "input", "prompt", "query", "user", "message", "text", "instruction"];
const MUST = ["must", "must_contain", "mustContain", "contains", "expected", "expect", "expected_output", "expectedOutput", "answer", "ideal", "reference", "ground_truth", "groundTruth"];
const MUST_NOT = ["must_not", "mustNot", "must_not_contain", "mustNotContain", "forbidden", "unexpected"];

const SKIP = new Set(["node_modules", ".git", "cortad", "dist", "build", "coverage", ".next", "vendor", "__pycache__"]);
const MOST_FILES = 400;

const first = (row, keys) => keys.map((k) => row?.[k]).find((v) => typeof v === "string" && v.trim().length > 0) ?? null;
const listOf = (row, keys) => keys.flatMap((k) => (Array.isArray(row?.[k]) ? row[k] : [])).filter((v) => typeof v === "string" && v.trim());

function rowsIn(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try { const parsed = JSON.parse(trimmed); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  if (trimmed.startsWith("{")) {
    // A whole-file object: the rows are the first array of objects inside it.
    try {
      const parsed = JSON.parse(trimmed);
      const found = Object.values(parsed).find((v) => Array.isArray(v) && v.some((x) => x && typeof x === "object"));
      return Array.isArray(found) ? found : [];
    } catch { /* fall through to lines */ }
  }
  const lines = [];
  for (const line of trimmed.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try { lines.push(JSON.parse(line)); } catch { /* not a row */ }
  }
  return lines;
}

// Three rows that each name something asked and something required. Two is a coincidence.
export function looksLikeEvals(rows) {
  const usable = rows.filter((row) => row && typeof row === "object" && first(row, ASKED) && (first(row, MUST) || listOf(row, MUST).length || first(row, MUST_NOT) || listOf(row, MUST_NOT).length));
  return usable.length >= 3 ? usable : null;
}

export function filesUnder(root = ".", found = [], at = root) {
  if (found.length >= MOST_FILES) return found;
  let entries;
  try { entries = readdirSync(at, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    const path = join(at, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) filesUnder(root, found, path);
    } else if (/\.(json|jsonl)$/.test(entry.name)) {
      try { if (statSync(path).size < 4_000_000) found.push(path); } catch { /* gone between the two calls */ }
    }
    if (found.length >= MOST_FILES) break;
  }
  return found;
}

const id = (file, at) => `${relative(".", file).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}-${at + 1}`.slice(-80).replace(/^-/, "");
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function questionsFrom(row) {
  const out = [];
  for (const want of [first(row, MUST), ...listOf(row, MUST)].filter(Boolean)) {
    // A long expectation is prose to compare against, not a string to look for.
    out.push(want.length > 120
      ? { ask: `did it answer the same thing as this: ${clip(want, 600)}`, answer: "yes" }
      : { ask: `did it say "${want}"`, answer: "yes", contains: [want] });
  }
  for (const avoid of [first(row, MUST_NOT), ...listOf(row, MUST_NOT)].filter(Boolean)) {
    out.push(avoid.length > 120
      ? { ask: `did it say the same thing as this: ${clip(avoid, 600)}`, answer: "no" }
      : { ask: `did it say "${avoid}"`, answer: "no", contains: [avoid] });
  }
  return out;
}

export function simulationsFrom(file, rows, root = ".") {
  const out = [];
  rows.forEach((row, at) => {
    const asked = first(row, ASKED);
    const questions = questionsFrom(row);
    if (!asked || !questions.length) return;
    out.push({
      id: id(file, at),
      who: `someone asking: ${clip(asked.replace(/\s+/g, " "), 100)}`,
      says: [asked],
      questions,
      from: `${relative(root, file)}:${at + 1}`,
    });
  });
  return out;
}

export function findEvals(root = ".") {
  const found = [];
  for (const file of filesUnder(root)) {
    let rows;
    try { rows = rowsIn(readFileSync(file, "utf8")); } catch { continue; }
    const usable = looksLikeEvals(rows);
    if (!usable) continue;
    const simulations = simulationsFrom(file, usable, root);
    if (simulations.length) found.push({ file: relative(root, file), rows: usable.length, simulations });
  }
  return found;
}
