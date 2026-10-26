#!/usr/bin/env node
// Plays people against your app and tells you which of your own rules it broke.
//
//   cortad init        writes cortad.json for you or your coding agent to fill
//   cortad             plays the conversations and prints what broke
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

const HELP = `
  cortad      plays people against your AI app and tells you which of your own rules it broke

  cortad init                     writes cortad.json for you or your coding agent to fill
  cortad                          plays the conversations and prints what broke

  -n <number>                     how many conversations to play (default 20)
  --judge <model>                 judge with your own model instead of ours
  --judge ollama/<model>          judge on this machine
  --schema <path>                 a schema somewhere other than ./cortad.json

  CORTAD_JUDGE_KEY                the key for your judge
  CORTAD_JUDGE_URL                where that key goes (default https://openrouter.ai/api/v1)
  CORTAD_OFFLINE=1                send nothing anywhere, and run nothing

  It exits non-zero when a rule broke, and when your app answered nothing.
  https://github.com/cortad/cortad
`;

if (argv.includes("--help") || argv.includes("-h") || verb === "help") { console.log(HELP); process.exit(0); }
if (argv.includes("--version") || argv.includes("-v")) {
  console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  process.exit(0);
}
if (verb !== "run") die(`no such command: ${verb}. Try: cortad init, cortad, or cortad --help`);
if (!existsSync(file)) die(`no ${SCHEMA_FILE} here. Run cortad init to write one.`);

// Offline means offline, and it is settled before anything else so no path can reach the wire.
// The conversations are written by us, so there is nothing to play without that call, and sending
// the schema anyway would make the promise on the tin a lie.
if (offline()) {
  die(`CORTAD_OFFLINE is set, and the conversations are written by ${new URL(ORIGIN()).host}, so there are none to play.
  Nothing was sent. Unset CORTAD_OFFLINE to run.`);
}

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
  better. Set CORTAD_OFFLINE=1 to send nothing at all.
`));
}

let cases;
try {
  cases = await writeUsers(schema, count);
} catch (e) {
  if (e instanceof HostedError && e.status === 429) die(`${e.message}. Try again tomorrow: the limit is on writing the conversations, and your own judge does not lift it.`);
  die(e.message);
}

if (!multiTurn(schema.endpoint)) {
  console.log(dim(`  Each conversation is one turn, because nothing here carries the ones before it. Put
  {{messages}} where your endpoint takes the turn list, or {{thread}} where it takes an id
  and keeps the history itself. Single turns miss what breaks on the fourth one.
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

const answered = played.length - errors.length;
console.log(report({ broke, played: answered, conversations: cases.length, errors, judgeName: judge.name }));
console.log("");
console.log(CLOSING(cases.length));
console.log("");
// Nothing judged is not nothing wrong. A gate that goes green because the app never answered is
// worse than no gate, so the only clean exit is one where conversations were played and held.
process.exit(broke.length || answered === 0 ? 1 : 0);
