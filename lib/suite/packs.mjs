// A pack is a file of questions for a kind of app: refunds and returns, citation and jurisdiction,
// clinical guidance and referral. Every question in an installed pack is asked of every
// conversation, which works because a question whose situation never arose answers "did not come
// up" and leaves the count. There is no matcher to get wrong.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashOf } from "./tiers.mjs";
import { net } from "../net.mjs";

export const DIR = join("cortad", "packs");

const str = (v) => typeof v === "string" && v.trim().length > 0;
const NAME = /^[a-z0-9][a-z0-9-]{0,60}$/;

export function problems(pack) {
  const found = [];
  if (!str(pack?.name) || !NAME.test(pack.name)) found.push("name: lower case letters, numbers and dashes");
  if (!str(pack?.version)) found.push("version: a string, so a run can say which one it asked");
  if (!Array.isArray(pack?.questions) || pack.questions.length === 0) found.push("questions: at least one");
  else {
    pack.questions.forEach((q, at) => {
      if (!str(q?.ask)) found.push(`questions.${at}.ask: the question, in plain words`);
      if (q?.answer !== "yes" && q?.answer !== "no") found.push(`questions.${at}.answer: "yes" or "no"`);
      // A pack cannot carry their own code: a file from somewhere else does not get to name a
      // function in this repository and have it run.
      if (q?.fn !== undefined) found.push(`questions.${at}.fn: a pack cannot name a function in your repository`);
    });
  }
  return found;
}

export function read(root = ".") {
  const dir = join(root, DIR);
  if (!existsSync(dir)) return { packs: [], problems: [] };
  const packs = [];
  const found = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const at = join(dir, file);
    let parsed;
    try { parsed = JSON.parse(readFileSync(at, "utf8")); } catch (e) { found.push(`${at}: not valid JSON, ${e.message}`); continue; }
    const wrong = problems(parsed);
    if (wrong.length) { found.push(`${at}:\n    ${wrong.join("\n    ")}`); continue; }
    packs.push(parsed);
  }
  return { packs, problems: found };
}

// A pack's question is named by the pack, so a run can say where a failure came from and two packs
// asking the same thing do not collide.
export const questionsOf = (packs, simulationId) =>
  packs.flatMap((pack) => pack.questions.map((q) => ({
    ...q,
    pack: pack.name,
    id: `${pack.name}#${hashOf(`${simulationId}|${pack.name}|${q.ask}`).toString(36)}`,
  })));

export async function add(from, root = ".") {
  const text = /^https?:\/\//.test(from)
    ? await net(from, { signal: AbortSignal.timeout(20_000) }).then((r) => {
        if (!r.ok) throw new Error(`${from} answered ${r.status}`);
        return r.text();
      })
    : readFileSync(from, "utf8");
  let pack;
  try { pack = JSON.parse(text); } catch (e) { throw new Error(`${from} is not valid JSON: ${e.message}`); }
  const wrong = problems(pack);
  if (wrong.length) throw new Error(`${from} is not a pack:\n  ${wrong.join("\n  ")}`);
  const dir = join(root, DIR);
  mkdirSync(dir, { recursive: true });
  const at = join(dir, `${pack.name}.json`);
  writeFileSync(at, `${JSON.stringify(pack, null, 2)}\n`);
  return { at, name: pack.name, version: pack.version, questions: pack.questions.length };
}
