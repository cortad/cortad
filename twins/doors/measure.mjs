// WHICH DOOR DOES AN AGENT OPEN.
//
// Nineteen tools against six, measured rather than argued. A real coding agent is handed one arm's
// real tool definitions over MCP and one moment a person is in, and the tool it calls first is
// recorded. The tools come from the shipping code: the six from lib/doors.mjs, the nineteen from
// lib/mcp.mjs at origin/main. Nothing reaches Cortad's servers and no run is started: the server on
// the other end records the call and answers one neutral line.
//
//   node twins/doors/measure.mjs [--rounds 1] [--model haiku] [--only six|twenty]

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SITUATIONS, hit } from "./situations.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const flag = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : fallback; };
const ROUNDS = Number(flag("rounds", 1));
const MODEL = flag("model", "haiku");
const ONLY = flag("only", null);
const LIMIT = Number(flag("limit", SITUATIONS.length));
// Both arms' instructions script the opening of a session, and that opening is a status call, so a
// situation posed as the first message of one measures the script rather than which door matches the
// moment. With --framed the same one line puts every situation mid-session, on both arms alike.
const FRAMED = process.argv.includes("--framed");
const FRAME = "This repository is already connected to Cortad and a run has already finished on it.";
// Everything but the one server under test, so the agent answers with a Cortad call or with nothing.
const OFF = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "Task", "NotebookEdit"];
const EACH_MS = 120_000;

const dir = mkdtempSync(join(tmpdir(), "cortad-doors-"));

async function armsOf() {
  const six = await import(join(ROOT, "lib", "doors.mjs"));
  const face = await import(join(ROOT, "lib", "mcp.mjs"));
  const old = await import(join(dir, "old-mcp.mjs"));
  return {
    six: { tools: six.DOORS, instructions: face.INSTRUCTIONS },
    twenty: { tools: old.TOOLS, instructions: old.INSTRUCTIONS },
  };
}

// The nineteen as they shipped, read out of git so the comparison is against what customers have.
function keepOldFace() {
  for (const name of ["mcp.mjs", "read-text.mjs", "words.mjs"]) {
    const out = name === "mcp.mjs" ? "old-mcp.mjs" : name;
    writeFileSync(join(dir, out), run("git", ["-C", ROOT, "show", `origin/main:lib/${name}`]));
  }
}

const run = (cmd, args) => execFileSync(cmd, args, { maxBuffer: 64 << 20 });

// Every call the agent made in its one turn, in order, with what the turn cost.
const ask = (prompt, config, calls) => new Promise((resolve) => {
  execFile("claude", ["-p", prompt, "--model", MODEL, "--output-format", "json", "--strict-mcp-config",
    "--mcp-config", config, "--allowedTools", "mcp__cortad", "--disallowedTools", ...OFF],
  { cwd: dir, timeout: EACH_MS, maxBuffer: 16 << 20 }, (_err, out) => {
    let made = [];
    try {
      made = readFileSync(calls, "utf8").split("\n").filter(Boolean)
        .map((line) => JSON.parse(line)).map((one) => ({ name: String(one.name).replace(/^mcp__cortad__/, ""), arguments: one.arguments ?? {} }));
    } catch { /* no call */ }
    let cost = 0;
    try { cost = Number(JSON.parse(String(out)).total_cost_usd) || 0; } catch { /* unpriced */ }
    resolve({ made, cost });
  });
});

// One config and one record of calls an arm, truncated between situations, so every prompt in an arm
// is byte for byte the one before it: the agent's own preamble is then read from its cache instead of
// written again, which is most of what this costs.
async function measure(arm, tools) {
  const toolsPath = join(dir, `${arm}-tools.json`);
  writeFileSync(toolsPath, JSON.stringify(tools));
  const calls = join(dir, `${arm}-calls.jsonl`);
  const config = join(dir, `${arm}.json`);
  writeFileSync(config, JSON.stringify({ mcpServers: { cortad: { command: process.execPath, args: [join(HERE, "stub.mjs"), toolsPath, calls] } } }));
  const rows = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    for (const one of SITUATIONS.slice(0, LIMIT)) {
      writeFileSync(calls, "");
      const { made, cost } = await ask(FRAMED ? `${FRAME}\n\n${one.said}` : one.said, config, calls);
      const first = made[0] ?? null;
      const right = hit(arm, one, first);
      // The door it opened first, and whether it reached the answer at all in that turn.
      const reached = made.some((call) => hit(arm, one, call));
      rows.push({ said: one.said, called: first ? first.name : null, about: first?.arguments?.about ?? null, calls: made.length, right, reached, cost });
      process.stderr.write(right ? "." : reached ? "o" : "x");
    }
  }
  process.stderr.write("\n");
  return rows;
}

const pct = (k, n) => `${((k / n) * 100).toFixed(0)}%`;

keepOldFace();
const arms = await armsOf();
const out = {};
for (const [arm, tools] of Object.entries(arms)) {
  if (ONLY && ONLY !== arm) continue;
  process.stderr.write(`${arm}: `);
  out[arm] = await measure(arm, tools);
}

let spent = 0;
for (const [arm, rows] of Object.entries(out)) {
  const right = rows.filter((r) => r.right).length;
  const reached = rows.filter((r) => r.reached).length;
  const silent = rows.filter((r) => r.called === null).length;
  spent += rows.reduce((a, r) => a + r.cost, 0);
  console.log(`\n${arm}: first call right ${right} of ${rows.length}, ${pct(right, rows.length)}; reached it in the turn ${reached} of ${rows.length}, ${pct(reached, rows.length)}; ${silent} called nothing`);
  for (const r of rows.filter((r) => !r.reached)) console.log(`  miss  ${r.called ?? "nothing"}${r.about ? ` about ${r.about}` : ""}  <-  ${r.said}`);
}
console.log(`\nthe measuring itself cost $${spent.toFixed(2)} on ${MODEL}`);
writeFileSync(join(ROOT, "twins", "doors", `measured${FRAMED ? "-framed" : ""}.json`), `${JSON.stringify({ model: MODEL, rounds: ROUNDS, framed: FRAMED, out }, null, 2)}\n`);
console.log(`\nrecorded in twins/doors/measured${FRAMED ? "-framed" : ""}.json`);
if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true });
