import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cliSpec, npxArgs } from "./spec.mjs";

// Making Cortad known to one coding agent, for this project alone: the agent running the connect,
// whose setup prompt asked the person first, or the one the person names on a plain terminal. The
// MCP entry goes where that agent keeps a project's servers: Claude Code's per-project entry in its
// own ~/.claude.json, else the project's own config file (Codex .codex/config.toml, Cursor
// .cursor/mcp.json, Copilot .mcp.json). The skill lands in the agent's home folder.
// Idempotent: run twice, it adds nothing twice. An entry naming another spec (lib/spec.mjs) is
// replaced, so a connect with a newer package moves the agent to it.
const exec = promisify(execFile);
const SKILL_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "skill");
// The skill's shell examples name the spec in place of this.
const PLACEHOLDER = "{{cortad}}";
export const AGENTS = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", copilot: "Copilot" };

export const serverFor = (spec) => ({ command: "npx", args: [...npxArgs(spec), "mcp"] });
const same = (entry, server) => entry?.command === server.command && JSON.stringify(entry?.args) === JSON.stringify(server.args);

export const onPath = (bin, env = process.env) =>
  (env.PATH ?? "").split(delimiter).some((dir) => dir && existsSync(join(dir, bin)));

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

// The files this call wrote: under the home folder as ~/..., in the project relative to it.
export async function register(agent, { root, home = homedir(), env = process.env, run = exec, skillSrc = SKILL_SRC, spec = cliSpec({ env }) }) {
  const server = serverFor(spec);
  const changed = [];
  const wrote = (shown, did) => { if (did) changed.push(shown); };
  const skill = (rel) => wrote(`~/${rel}`, installSkill(join(home, rel), { src: skillSrc, spec }));
  if (agent === "claude") {
    wrote("~/.claude.json", await registerClaude({ root, home, env, run, server }));
    skill(join(".claude", "skills", "cortad"));
  }
  if (agent === "codex") wrote(join(".codex", "config.toml"), registerCodex(join(root, ".codex", "config.toml"), server));
  if (agent === "cursor") wrote(join(".cursor", "mcp.json"), registerJson(join(root, ".cursor", "mcp.json"), { type: "stdio", ...server }));
  // Copilot CLI reads a project's servers from .mcp.json, in its own shape: a "local" server with every tool.
  if (agent === "copilot") {
    wrote(".mcp.json", registerJson(join(root, ".mcp.json"), { type: "local", ...server, tools: ["*"] }));
    skill(join(".copilot", "skills", "cortad"));
  }
  // The one skills folder Codex, Cursor and Copilot all read.
  if (agent === "codex" || agent === "cursor" || agent === "copilot") skill(join(".agents", "skills", "cortad"));
  return { agent: AGENTS[agent], changed };
}

// The client's own command when it is here, so its config is written the way it writes it; the file
// itself only when the binary is not on this PATH, or the command failed. `--scope local` is Claude
// Code's entry for this project alone, kept in ~/.claude.json under the project's path.
async function registerClaude({ root, home, env, run, server }) {
  const file = join(home, ".claude.json");
  const current = () => readJson(file)?.projects?.[root]?.mcpServers?.cortad;
  if (onPath("claude", env)) {
    const add = () => run("claude", ["mcp", "add", "--scope", "local", "cortad", "--", server.command, ...server.args], { env, cwd: root });
    try { await add(); return true; } catch (err) {
      if (/already exists/i.test(String(err?.stderr ?? err?.message))) {
        if (same(current(), server)) return false;
        try { await run("claude", ["mcp", "remove", "--scope", "local", "cortad"], { env, cwd: root }); await add(); return true; } catch { /* the file below */ }
      }
    }
  }
  const config = readJson(file) ?? {};
  if (same(current(), server)) return false;
  const project = config.projects?.[root] ?? {};
  config.projects = { ...(config.projects ?? {}), [root]: { ...project, mcpServers: { ...(project.mcpServers ?? {}), cortad: { type: "stdio", ...server } } } };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
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
  if (same(config.mcpServers?.cortad, entry)) return false;
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
