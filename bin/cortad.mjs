#!/usr/bin/env node
// Plays people against your app and tells you which of your own rules it broke.
//
//   npx cortad init        writes cortad.json for you or your coding agent to fill
//   npx cortad             plays the conversations and prints what broke
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readSchema, SCHEMA_FILE, SKELETON } from "../lib/schema.mjs";
import { multiTurn, playAll } from "../lib/play.mjs";
import { pickJudge, rule } from "../lib/judge.mjs";
import { HostedError, offline, ORIGIN, writeUsers } from "../lib/hosted.mjs";
import { bold, CLOSING, dim, report } from "../lib/report.mjs";

const argv = process.argv.slice(2);
// Every flag here takes a value, so the word after one is never the command.
const TAKES_VALUE = new Set(["-n", "--conversations", "--judge", "--schema"]);
const flag = (name, fallback) => {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : argv[at + 1];
};
const verb = argv.find((a, i) => !a.startsWith("-") && !TAKES_VALUE.has(argv[i - 1])) ?? "run";
const file = resolve(flag("--schema", SCHEMA_FILE));
const die = (message) => { console.error(`\n  ${message}\n`); process.exit(1); };

if (verb === "init") {
  if (existsSync(file)) die(`${file} is already here.`);
  writeFileSync(file, `${JSON.stringify(SKELETON, null, 2)}\n`);
  console.log(`
  Wrote ${SCHEMA_FILE}.

  Fill it in yourself, or hand it to the coding agent in this repository:

      Fill in cortad.json from this codebase: what this app does, the endpoint
      its chat goes to and the body that endpoint takes, and every rule the
      system prompt tells the model to keep.
`);
  process.exit(0);
}

if (verb !== "run") die(`no such command: ${verb}. Try: npx cortad init, or npx cortad`);
if (!existsSync(file)) die(`no ${SCHEMA_FILE} here. Run npx cortad init to write one.`);

let schema;
try { schema = readSchema(readFileSync(file, "utf8")); } catch (e) { die(e.message); }

let judge;
try { judge = pickJudge(flag("--judge")); } catch (e) { die(e.message); }

const count = Math.max(1, Math.min(200, Number(flag("-n", flag("--conversations", 20))) || 20));

console.log(`
  ${bold(schema.app)}
  ${dim(`${schema.rules.length} ${schema.rules.length === 1 ? "rule" : "rules"} to hold, judged by ${judge.name}`)}
`);

if (!offline()) {
  console.log(dim(`  Your rules and this app's description go to ${new URL(ORIGIN()).host} so the conversations
  can be written. Nothing else leaves this machine: not your code, not your keys, not
  your environment. The conversations and the verdicts are kept and used to make this
  better. Set CORTAD_OFFLINE=1 and name your own judge to send nothing at all.
`));
}

let cases;
try {
  cases = await writeUsers(schema, count);
} catch (e) {
  if (e instanceof HostedError && e.status === 429) die(`${e.message}. Try again later, or write your own cortad.json cases.`);
  die(e.message);
}

if (!multiTurn(schema.endpoint)) {
  console.log(dim(`  Your body takes one message, so each conversation is one turn. Put {{messages}} where
  the turn list goes to play conversations that keep going.
`));
}

const live = process.stdout.isTTY;
const played = await playAll(schema.endpoint, cases, {
  onDone: (_r, done, all) => { if (live) process.stdout.write(`\r  ${done} of ${all} conversations played`); },
});
if (live) process.stdout.write(`\r${" ".repeat(40)}\r`);

const byId = new Map(cases.map((c) => [c.id, c]));
const broke = [];
const errors = played.filter((p) => p.error);
for (const one of played) {
  if (one.error) continue;
  const checks = byId.get(one.id)?.checks ?? [];
  if (!checks.length) continue;
  let rulings;
  try { rulings = await rule(judge, one.transcript, checks); } catch (e) { die(e.message); }
  const failed = rulings.filter((x) => x.broke);
  if (!failed.length) continue;
  // The card is the conversation, so it is placed at the first reply that broke something.
  const at = Math.min(...failed.map((f) => f.turn));
  broke.push({
    title: one.title,
    said: one.transcript[at - 2]?.text ?? one.transcript[0].text,
    reply: one.transcript[at - 1].text,
    failed: failed.map((f) => ({ require: f.require, evidence: f.evidence })),
  });
}

console.log(report({ broke, played: played.length - errors.length, conversations: cases.length, errors, judgeName: judge.name }));
console.log("");
console.log(CLOSING(cases.length));
console.log("");
process.exit(broke.length ? 1 : 0);
