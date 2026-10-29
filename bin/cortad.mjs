#!/usr/bin/env node
// Every verb, dispatched. What each one does is in HELP below, which is the copy a person reads.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readSchema, SCHEMA_FILE } from "../lib/schema.mjs";
import { HostedError, offline, ORIGIN } from "../lib/hosted.mjs";
import { plan } from "../lib/cli/plan.mjs";
import { run } from "../lib/cli/run.mjs";
import { held, whatToVerify } from "../lib/cli/verify.mjs";
import { replay } from "../lib/cli/replay.mjs";
import { configFrom, findApp } from "../lib/cli/init.mjs";
import { report, bold, dim, green, red } from "../lib/report.mjs";
import { coverage } from "../lib/changed.mjs";
import { last } from "../lib/run.mjs";
import { read, write } from "../lib/suite/files.mjs";
import { findEvals } from "../lib/evals/read.mjs";
import { add as addPack, read as readPacks } from "../lib/suite/packs.mjs";
import { asJson } from "../lib/out/json.mjs";
import { asJunit } from "../lib/out/junit.mjs";
import { asSarif } from "../lib/out/sarif.mjs";

const argv = process.argv.slice(2);
const TAKES_VALUE = new Set(["-n", "--judge", "--writer", "--schema", "--changed", "--junit", "--sarif", "--at"]);
const MOST = 50;
const flag = (name, fallback) => {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : argv[at + 1];
};
const has = (name) => argv.includes(name);
const verb = argv.find((a, i) => !a.startsWith("-") && !TAKES_VALUE.has(argv[i - 1])) ?? "run";
const file = resolve(flag("--schema", SCHEMA_FILE));
const die = (message) => { console.error(`\n  ${message}\n`); process.exit(1); };
const say = (message) => console.log(`\n${message}\n`);

const live = process.stdout.isTTY;
const progress = (what) => (_result, done, all) => { if (live) process.stdout.write(`\r  ${done} of ${all} ${what}`); };
const clearLine = () => { if (live) process.stdout.write(`\r${" ".repeat(40)}\r`); };

const HELP = `
  cortad      runs a simulation against your AI app and says what your change did

  cortad init                     finds your app's AI and writes ${SCHEMA_FILE}
  cortad init --at <url>          where to look, if it is not on a usual dev port
  cortad plan                     writes the simulations into cortad/simulations
  cortad                          plays the small set and prints what moved
  cortad --all                    plays everything but the set held for a release
  cortad --full                   plays everything
  cortad --changed <files>        plays only what reaches the files you edited
  cortad verify                   plays the ones that failed, says whether the fix held
  cortad coverage                 says which of your files the simulations reach
  cortad replay <run>             answers a kept run again, without touching your app
  cortad evals                    reads your own eval files and writes simulations from them
  cortad packs                    the question packs installed here
  cortad packs add <file or url>  install one

  -n <number>                     how many simulations to write (default 20, most ${MOST})
  --writer <model>                write the simulations with your own model
  --writer ollama/<model>         write them on this machine
  --judge <model>                 answer the questions with your own model
  --judge ollama/<model>          answer them on this machine
  --schema <path>                 a config somewhere other than ./${SCHEMA_FILE}
  --json                          the whole run on stdout, for anything that reads JSON
  --junit <path>                  write JUnit XML, for your CI's test panel
  --sarif <path>                  write SARIF, so a failure lands on a line in the pull request

  CORTAD_JUDGE_KEY                the key for your judge
  CORTAD_JUDGE_URL                where that key goes (default https://openrouter.ai/api/v1)
  CORTAD_OFFLINE=1                send nothing anywhere

  It exits non-zero when a question failed, and when your app answered nothing.
  https://github.com/cortad/cortad
`;

if (has("--help") || has("-h") || verb === "help") { console.log(HELP); process.exit(0); }
if (has("--version") || has("-v")) {
  console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  process.exit(0);
}

if (verb === "init") {
  if (existsSync(file)) die(`${file} is already here.`);
  if (live) process.stdout.write("  looking for your app");
  const app = await findApp({ at: flag("--at"), onTry: () => { if (live) process.stdout.write("."); } });
  if (live) process.stdout.write(`\r${" ".repeat(60)}\r`);
  const best = app.found[0];
  writeFileSync(file, `${JSON.stringify(configFrom(best), null, 2)}\n`);

  const alsoFound = app.found.slice(1);
  say([
    best
      ? `  ${bold(`Your app answers at ${best.url}`)}\n  ${dim(`It takes ${best.shape}, and the reply is at ${best.reply}. Both are in ${SCHEMA_FILE}.`)}`
      : `  ${bold(`Wrote ${SCHEMA_FILE}.`)}\n  ${dim(app.base ? `Nothing at ${app.base} answered like a chat, so the endpoint is a guess to fill in.` : "No app is running here, so the endpoint is a guess to fill in.")}`,
    ...(alsoFound.length ? ["", dim(`  These answered too: ${alsoFound.map((f) => f.path).join(", ")}. Change the url if one of them is the chat.`)] : []),
    "",
    "  Two things are still yours to write, and the coding agent in this repository can:",
    "",
    "      Fill in cortad.json from this codebase: one sentence on what this app does,",
    "      and every rule the system prompt tells the model to keep, in the prompt's",
    "      own words. Read the prompt files, not the README.",
    "",
    "  Then: cortad plan",
  ].join("\n"));
  process.exit(0);
}

// The paid connector answers to these, and it used to be the package called cortad. An agent
// reading an older instruction would otherwise get a shrug from the wrong tool.
const CONNECTOR = new Set(["status", "findings", "dispute", "feedback", "field", "world", "reach", "wait", "connect", "tell", "setup"]);
const VERBS = new Set(["init", "plan", "run", "verify", "coverage", "replay", "evals", "packs"]);
if (CONNECTOR.has(verb)) {
  die(`${verb} belongs to the Cortad connector, which is a different command:

      npx @cortad/connector ${verb}

  This one runs a simulation from the simulations in this repository. cortad --help`);
}

// A command nobody has is named before anything is asked of the repository. Asking for a config
// first told someone their config was missing when the real answer was that they had a typo.
if (!VERBS.has(verb)) die(`no such command: ${verb}. Try: cortad init, cortad plan, cortad, cortad verify, or cortad --help`);

if (!existsSync(file)) die(`no ${SCHEMA_FILE} here. Run cortad init to write one.`);
let schema;
try { schema = readSchema(readFileSync(file, "utf8")); } catch (e) { die(e.message); }

if (verb === "coverage") {
  const reached = coverage(last());
  if (!reached.length) {
    say(`  Nothing is recorded yet, so which files your simulations reach is unknown.

  One line in your dev server, then run again:
      import { record } from "cortad/trace"; record();`);
    process.exit(0);
  }
  say([`  ${bold(`${reached.length === 1 ? "One file is" : `${reached.length} files are`} reached by a conversation`)}`, "",
    ...reached.map((r) => `  ${String(r.count).padStart(4)}  ${r.file}`)].join("\n"));
  process.exit(0);
}

if (verb === "plan") {
  const writer = flag("--writer");
  const ours = !writer || writer === "cortad";
  if (offline() && ours) {
    die(`CORTAD_OFFLINE is set, and the simulations are written by ${new URL(ORIGIN()).host} unless you name your own model: --writer ollama/<model>. Nothing was sent.`);
  }
  const want = Math.max(1, Math.min(MOST, Number(flag("-n", 20)) || 20));
  if (ours) {
    console.log(`\n  ${dim(`Your rules and this app's description go to ${new URL(ORIGIN()).host} so the simulations can be\n  written. Nothing else leaves this machine: not your code, not your keys, not your environment.`)}\n`);
  }
  let written;
  try { written = await plan({ schema, count: want, writer }); } catch (e) {
    if (e instanceof HostedError && e.status === 429) die(`${e.message}. A run on an unchanged ${SCHEMA_FILE} does not spend one.`);
    die(e.message);
  }
  say([`  ${bold(`Wrote ${written.length} simulations into cortad/simulations`)}`, "",
    ...written.map((w) => `  ${w.tier.padEnd(9)} ${w.id}  ${dim(`${w.questions} ${w.questions === 1 ? "question" : "questions"}`)}`),
    "", "  They are yours. Open one, change who shows up or what is asked, and commit it.",
    "  Then: cortad"].join("\n"));
  process.exit(0);
}

if (verb === "evals") {
  const found = findEvals();
  if (!found.length) {
    say(`  No eval files found here.

  A file is read when three or more of its rows name something someone asked and
  something the answer has to do. Nothing is guessed: a file that only has inputs
  is not read at all.`);
    process.exit(0);
  }
  const written = found.flatMap((one) => one.simulations.map((s) => ({ at: write(s), from: s.from })));
  say([
    `  ${bold(`Wrote ${written.length} ${written.length === 1 ? "simulation" : "simulations"} from your own eval files`)}`,
    "",
    ...found.map((one) => `  ${one.file}  ${dim(`${one.simulations.length} of ${one.rows} rows`)}`),
    "",
    "  Each one carries the file and row it came from, so a failure has an address in",
    "  your repository. Open one and change what is asked if the reading is wrong.",
  ].join("\n"));
  process.exit(0);
}

if (verb === "packs") {
  const what = argv[argv.indexOf("packs") + 1];
  if (what !== "add") {
    const { packs, problems } = readPacks();
    if (problems.length) die(`these packs cannot be read:\n\n  ${problems.join("\n\n  ")}`);
    if (!packs.length) { say("  No packs installed. cortad packs add <file or url>"); process.exit(0); }
    say(packs.map((p) => `  ${p.name} ${dim(p.version)}  ${dim(`${p.questions.length} questions`)}`).join("\n"));
    process.exit(0);
  }
  const from = argv[argv.indexOf("add") + 1];
  if (!from) die("name the pack to add: cortad packs add <file or url>");
  let added;
  try { added = await addPack(from); } catch (e) { die(e.message); }
  say(`  Added ${added.name} ${added.version}, ${added.questions} questions, to ${added.at}.\n\n  Every one of them is asked of every conversation. The ones that do not apply\n  answer "did not come up" and leave the count.`);
  process.exit(0);
}

if (verb === "replay") {
  const at = argv.find((a, i) => a.endsWith(".json") && !TAKES_VALUE.has(argv[i - 1]) && a !== verb);
  if (!at) die("name the run to replay: cortad replay cortad/runs/0003.json");
  if (!existsSync(at)) die(`no run at ${at}`);
  const again = await replay({ at, judgeName: flag("--judge") });
  console.log(report(again));
  console.log("");
  process.exit(again.counted.broke ? 1 : 0);
}

if (verb === "verify") {
  const want = whatToVerify();
  // Neither of these is a failure, so neither leaves a failing exit code: a gate that goes red
  // because there was nothing to check is a gate nobody keeps.
  if (want.kind === "nothing-kept") { say("  No run is kept here yet. Run cortad first."); process.exit(0); }
  if (want.kind === "nothing-failed") { say("  Nothing failed in the last run, so there is nothing to verify."); process.exit(0); }

  const again = await run({ schema, plays: "full", only: want.ids, judgeName: flag("--judge"), onDone: progress("played again") });
  clearLine();
  if (again.kind !== "ran") die("the simulations that failed are no longer in cortad/simulations.");

  const ruled = held(want.before, again.run);
  const gone = ruled.filter((r) => r.held);
  say([
    ...ruled.map((r) => `  ${r.held ? green("held") : red("still failing")}   ${r.ask}  ${dim(r.conversation)}`),
    "",
    `  ${bold(`${gone.length} of ${ruled.length} fixed`)}.`,
  ].join("\n"));
  process.exit(gone.length === ruled.length ? 0 : 1);
}

const judgeName = flag("--judge");
const changed = (flag("--changed") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const plays = has("--full") ? "full" : has("--all") ? "all" : "smoke";

const suite = read();
if (suite.problems.length) die(`these simulations cannot be read:\n\n  ${suite.problems.join("\n\n  ")}`);
if (!suite.simulations.length) die(`no simulations yet. Run cortad plan to write the first ones, or add a file to cortad/simulations.`);

const result = await run({ schema, plays, changed: changed.length ? changed : null, judgeName, onDone: progress("played") });
clearLine();

if (result.kind === "nothing" && changed.length) {
  const bare = result.scoped?.bare ?? changed;
  die(`nothing reaches ${bare.join(", ")}.

  Write a simulation for it in cortad/simulations and run again.
  The format is in cortad/simulations/README.md${result.scoped?.traced ? "" : "\n\n  Nothing is recorded yet either, so which files a conversation reaches is unknown.\n  One line in your dev server: import { record } from \"cortad/trace\"; record();"}`);
}
if (result.kind === "nothing") die(`nothing in the ${plays} set. Try cortad --all, or set "tier" in a simulation file.`);

const junitAt = flag("--junit");
if (junitAt) writeFileSync(resolve(junitAt), asJunit(result));
const sarifAt = flag("--sarif");
if (sarifAt) writeFileSync(resolve(sarifAt), asSarif(result));

if (has("--json")) {
  console.log(asJson(result));
} else {
  console.log(report(result));
  console.log("");
  if (junitAt) console.log(dim(`  JUnit written to ${junitAt}\n`));
  if (sarifAt) console.log(dim(`  SARIF written to ${sarifAt}\n`));
}
process.exit(result.counted.broke || result.run.conversations.length === result.errors.length ? 1 : 0);
