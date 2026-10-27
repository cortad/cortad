// The suite is files in their repository. They open them, rewrite a goal that is wrong, delete a
// question they disagree with, add their own, and commit the diff. Nothing here keeps state
// anywhere else, so the suite works when we are not reachable and keeps working if they stop paying.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashOf } from "./tiers.mjs";
import { questionsOf as fromPacks, read as readPacks } from "./packs.mjs";

export const DIR = join("cortad", "simulations");
export const RUNS = join("cortad", "runs");

const str = (v) => typeof v === "string" && v.trim().length > 0;
const idOf = (file) => file.replace(/\.json$/, "");

export function problems(simulation) {
  const found = [];
  if (!str(simulation?.who)) found.push("who: one line on the person and what they want");
  if (!Array.isArray(simulation?.says) || simulation.says.length === 0 || !simulation.says.every(str)) {
    found.push("says: what this person types, one entry per message");
  }
  const questions = simulation?.questions;
  if (!Array.isArray(questions) || questions.length === 0) found.push("questions: at least one question asked of the replies");
  else {
    questions.forEach((q, at) => {
      if (!str(q?.ask)) found.push(`questions.${at}.ask: the question, in plain words`);
      if (q?.answer !== "yes" && q?.answer !== "no") found.push(`questions.${at}.answer: the answer this app must give, "yes" or "no"`);
    });
  }
  return found;
}

// A question's id has to be stable across runs or two runs cannot be compared. It is the file and
// the question's own words, so reordering a file does not rename its questions.
const questionsOf = (id, questions) =>
  questions.map((q, at) => ({ ...q, id: `${id}#${hashOf(`${id}|${q.ask}`).toString(36)}`, at }));

export function read(root = ".") {
  const dir = join(root, DIR);
  const installed = readPacks(root);
  if (!existsSync(dir)) return { simulations: [], problems: installed.problems };
  const simulations = [];
  const found = [...installed.problems];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const at = join(dir, file);
    let parsed;
    try { parsed = JSON.parse(readFileSync(at, "utf8")); } catch (e) { found.push(`${at}: not valid JSON, ${e.message}`); continue; }
    const wrong = problems(parsed);
    if (wrong.length) { found.push(`${at}:\n    ${wrong.join("\n    ")}`); continue; }
    const id = idOf(file);
    simulations.push({
      ...parsed,
      id,
      file: at,
      questions: [...questionsOf(id, parsed.questions), ...fromPacks(installed.packs, id)],
    });
  }
  return { simulations, problems: found, packs: installed.packs };
}

// What the suite was when a run played it. A comparison across two different suites is not a before
// and an after, and this is how the next run can tell.
export const suiteKey = (simulations) =>
  hashOf(simulations.map((s) => `${s.id}|${s.says.join("|")}|${s.questions.map((q) => `${q.ask}>${q.answer}`).join("|")}`).join("\n")).toString(36);

export function write(simulation, root = ".") {
  const dir = join(root, DIR);
  mkdirSync(dir, { recursive: true });
  const { id, file, questions, ...rest } = simulation;
  const body = { ...rest, questions: questions.map(({ id: _i, at: _a, ...q }) => q) };
  const at = join(dir, `${id}.json`);
  writeFileSync(at, `${JSON.stringify(body, null, 2)}\n`);
  return at;
}
