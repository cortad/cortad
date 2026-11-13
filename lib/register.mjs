import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { cliSpec, npxArgs } from "./spec.mjs";

// Making Cortad known to one coding agent, inside this project alone: the agent running the connect,
// whose setup prompt asked the person first, or the one the person names on a plain terminal. The
// MCP entry and the skill go where that agent reads a project's own (PROJECT below), and nothing is
// written to the home folder for any agent: a skill there loads in every project the person opens.
// Idempotent: run twice, it adds nothing twice. An entry naming another spec (lib/spec.mjs) is
// replaced, so a connect with a newer package moves the agent to it.
const SKILL_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "skill");
// The skill's shell examples name the spec in place of this.
const PLACEHOLDER = "{{cortad}}";
export const AGENTS = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", copilot: "Copilot" };
// Each agent's project-scoped MCP file and skills folder.
const PROJECT = {
  claude: { mcp: ".mcp.json", skill: join(".claude", "skills", "cortad") },
  codex: { mcp: join(".codex", "config.toml"), skill: join(".agents", "skills", "cortad") },
  cursor: { mcp: join(".cursor", "mcp.json"), skill: join(".cursor", "skills", "cortad") },
  copilot: { mcp: ".mcp.json", skill: join(".github", "skills", "cortad") },
};
export const PROJECT_SKILLS = [...new Set(Object.values(PROJECT).map((p) => p.skill))];
// Where versions before this one put the skill, in the home folder.
const HOME_SKILLS = [join(".claude", "skills", "cortad"), join(".agents", "skills", "cortad"), join(".copilot", "skills", "cortad")];

export const serverFor = (spec) => ({ command: "npx", args: [...npxArgs(spec), "mcp"] });
const same = (entry, server) => entry?.command === server.command && JSON.stringify(entry?.args) === JSON.stringify(server.args);

// The coding agent whose shell runs this command, from what each one sets in the environment of the
// commands it runs.
const AGENT_ENV = [
  ["claude", ["CLAUDECODE"]],
  ["codex", ["CODEX_THREAD_ID", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_MANAGED_BY_NPM", "CODEX_MANAGED_BY_BUN", "CODEX_MANAGED_BY_PNPM"]],
  ["copilot", ["COPILOT_CLI_BINARY_VERSION", "COPILOT_CLI_RESOLVED_DIST_DIR"]],
  ["cursor", ["CURSOR_AGENT"]],
];
export const agentOf = (env = process.env) => AGENT_ENV.find(([, names]) => names.some((name) => env[name]))?.[0] ?? null;

// A plain terminal names no agent: the person picks one, or none. Without a terminal to ask on, none.
export async function askAgent({ input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY) return null;
  const keys = Object.keys(AGENTS);
  const rl = createInterface({ input, output });
  try {
    const said = await rl.question(`cortad  add Cortad's tools for this project to which coding agent? ${keys.map((k, i) => `${i + 1} ${AGENTS[k]}`).join(", ")}. Enter skips: `);
    return keys[Number(said.trim()) - 1] ?? null;
  } finally { rl.close(); }
}

// The files this call changed: in the project relative to it, and a skill an older version left in
// the home folder, removed, as ~/...
export async function register(agent, { root, home = homedir(), skillSrc = SKILL_SRC, spec = cliSpec() }) {
  const server = serverFor(spec);
  const changed = [];
  const wrote = (shown, did) => { if (did) changed.push(shown); };
  const { mcp, skill } = PROJECT[agent];
  if (agent === "claude") wrote(mcp, registerJson(join(root, mcp), { type: "stdio", ...server }));
  if (agent === "codex") wrote(mcp, registerCodex(join(root, mcp), server));
  if (agent === "cursor") wrote(mcp, registerJson(join(root, mcp), { type: "stdio", ...server }));
  // Copilot CLI's own shape: a "local" server with every tool.
  if (agent === "copilot") wrote(mcp, registerJson(join(root, mcp), { type: "local", ...server, tools: ["*"] }));
  wrote(skill, installSkill(join(root, skill), { src: skillSrc, spec }));
  for (const rel of HOME_SKILLS) if (removeSkill(home, rel)) changed.push(`removed ~/${rel}`);
  return { agent: AGENTS[agent], changed };
}

// Cortad's own skill folder: SKILL.md named cortad, with nothing beside it but what installSkill
// writes. Anything else in it is the person's, and the folder is left alone.
export function isOurSkill(dir) {
  try {
    if (lstatSync(dir).isSymbolicLink()) return false;
    if (!/^---\nname: cortad\n/.test(readFileSync(join(dir, "SKILL.md"), "utf8"))) return false;
    const entries = readdirSync(dir, { recursive: true }).map(String).sort();
    return entries.every((e) => ["SKILL.md", "references", join("references", "results.md")].includes(e));
  } catch { return false; }
}

// Removes `base`/`rel` when it is Cortad's skill, and the folders it leaves empty up to `base`.
export function removeSkill(base, rel) {
  const dir = join(base, rel);
  if (!isOurSkill(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  for (let up = dirname(dir); relative(base, up) && !relative(base, up).startsWith("..") && !up.endsWith(sep); up = dirname(up)) {
    try { if (readdirSync(up).length) break; rmdirSync(up); } catch { break; }
  }
  return true;
}

const CODEX_BLOCK = /^\[mcp_servers\.cortad\]\n(?:(?!\[).*(?:\n|$))*/m;

function registerCodex(file, server) {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const block = text.match(CODEX_BLOCK)?.[0] ?? "";
  const args = block.match(/^args\s*=\s*(\[.*\])\s*$/m)?.[1];
  const current = (() => { try { return args ? { command: block.match(/^command\s*=\s*"(.*)"\s*$/m)?.[1], args: JSON.parse(args) } : null; } catch { return null; } })();
  if (same(current, server)) return false;
  const entry = `[mcp_servers.cortad]\ncommand = "${server.command}"\nargs = ${JSON.stringify(server.args)}\n`;
  mkdirSync(dirname(file), { recursive: true });
  // The blank lines after the old block stay, so the rest of the file keeps its layout.
  const replaced = () => text.replace(CODEX_BLOCK, (old) => `${entry}${(old.match(/\n+$/)?.[0] ?? "\n").slice(1)}`);
  writeFileSync(file, block ? replaced() : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${entry}`);
  return true;
}

function registerJson(file, entry) {
  const config = readJson(file) ?? {};
  // Whole, not by command alone: Claude Code and Copilot share .mcp.json in different shapes.
  if (JSON.stringify(config.mcpServers?.cortad) === JSON.stringify(entry)) return false;
  config.mcpServers = { ...(config.mcpServers ?? {}), cortad: entry };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return true;
}

// SKILL.md and its references, copied whole so a newer package refreshes the words, with the
// shell examples naming the spec this machine runs. Says whether a file changed.
export function installSkill(dir, { src = SKILL_SRC, spec = cliSpec() } = {}) {
  mkdirSync(join(dir, "references"), { recursive: true });
  let wrote = false;
  for (const rel of ["SKILL.md", join("references", "results.md")]) {
    const text = readFileSync(join(src, rel), "utf8").replaceAll(PLACEHOLDER, spec);
    if (existsSync(join(dir, rel)) && readFileSync(join(dir, rel), "utf8") === text) continue;
    writeFileSync(join(dir, rel), text);
    wrote = true;
  }
  return wrote;
}

function readJson(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}
