#!/usr/bin/env node
// How often a judge agrees with a person, and how often it says yes when the person said no.
//
// Nobody in this field publishes this about their own judge, which is why it is here and why it is
// re-runnable rather than a number in a README. It takes a file of labelled conversations, one JSON
// object per line:
//
//   {"transcript":[{"role":"user","text":"..."},{"role":"app","text":"..."}],
//    "ask":"did it promise a refund","label":"yes"}
//
// The label is what a person said, and it has to come from a set people labelled. Labelling our own
// examples and reporting the agreement would be measuring our opinion against itself.
//
//   node bench/agreement.mjs labelled.jsonl --judge ollama/qwen3
import { readFileSync } from "node:fs";
import { decide, pickJudge } from "../lib/answer/judge.mjs";
import { NO, settled, YES } from "../lib/answer/verdict.mjs";
import { rate } from "../lib/stats.mjs";

const argv = process.argv.slice(2);
const at = argv.find((a) => !a.startsWith("-"));
const judgeName = argv[argv.indexOf("--judge") + 1];
if (!at) {
  console.error("\n  node bench/agreement.mjs <labelled.jsonl> [--judge <model>]\n");
  process.exit(1);
}

const rows = readFileSync(at, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const judge = pickJudge(judgeName);

let agreed = 0;
let asked = 0;
let falseYes = 0;
let saidNo = 0;
let unsettled = 0;

for (const [i, row] of rows.entries()) {
  const question = { id: `q${i}`, ask: row.ask, answer: row.label };
  const answers = await decide(judge, row.transcript, [question]);
  const got = answers.get(question.id)?.answer;
  if (!settled(got)) { unsettled += 1; continue; }
  asked += 1;
  if (got === row.label) agreed += 1;
  if (row.label === NO) {
    saidNo += 1;
    if (got === YES) falseYes += 1;
  }
}

const how = rate(agreed, asked);
console.log(`
  ${rows.length} labelled conversations, judged by ${judge.kind === "cortad" ? "Cortad" : judge.name}

  agreement        ${how.percent}%, give or take ${how.plusMinus}, over ${asked} settled
  said yes wrongly ${saidNo ? Math.round((falseYes / saidNo) * 100) : 0}% of ${saidNo} the person answered no
  could not tell   ${unsettled}
`);
