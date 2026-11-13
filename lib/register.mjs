import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cliSpec, npxArgs } from "./spec.mjs";

const exec = promisify(execFile);
const SKILL_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "skill");

const PLACEHOLDER = "{{cortad}}";
export const AGENTS = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", copilot: "Copilot" };

const PROJECT = {
  claude: { mcp: "~/.claude.json", skill: join(".claude", "skills", "cortad") },
  codex: { mcp: join(".codex", "config.toml"), skill: join(".agents", "skills", "cortad") },
  cursor: { mcp: join(".cursor", "mcp.json"), skill: join(".cursor", "skills", "cortad") },
  copilot: { mcp: ".mcp.json", skill: join(".github", "skills", "cortad") },
};
export const PROJECT_SKILLS = [...new Set(Object.values(PROJECT).map((p) => p.skill))];

const HOME_SKILLS = [join(".claude", "skills", "cortad"), join(".agents", "skills", "cortad"), join(".copilot", "skills", "cortad")];

export const serverFor = (spec) => ({ command: "npx", args: [...npxArgs(spec), "mcp"] });
const same = (entry, server) => entry?.command === server.command && JSON.stringify(entry?.args) === JSON.stringify(server.args);

export const onPath = (bin, env = process.env) =>
  (env.PATH ?? "").split(delimiter).some((dir) => dir && existsSync(join(dir, bin)));

const AGENT_ENV = [
  ["claude", ["CLAUDECODE"]],
  ["codex", ["CODEX_THREAD_ID", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_MANAGED_BY_NPM", "CODEX_MANAGED_BY_BUN", "CODEX_MANAGED_BY_PNPM"]],
  ["copilot", ["COPILOT_CLI_BINARY_VERSION", "COPILOT_CLI_RESOLVED_DIST_DIR"]],
  ["cursor", ["CURSOR_AGENT"]],
];
export const agentOf = (env = process.env) => AGENT_ENV.find(([, names]) => names.some((name) => env[name]))?.[0] ?? null;

export async function askAgent({ input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY) return null;
  const keys = Object.keys(AGENTS);
  const rl = createInterface({ input, output });
  try {
    const said = await rl.question(`cortad  add Cortad's tools for this project to which coding agent? ${keys.map((k, i) => `${i + 1} ${AGENTS[k]}`).join(", ")}. Enter skips: `);
    return keys[Number(said.trim()) - 1] ?? null;
  } finally { rl.close(); }
}

export async function register(agent, { root, home = homedir(), env = process.env, run = exec, skillSrc = SKILL_SRC, spec = cliSpec({ env }) }) {
  const server = serverFor(spec);
  const changed = [];
  const wrote = (shown, did) => { if (did) changed.push(shown); };
  const { mcp, skill } = PROJECT[agent];
  if (agent === "claude") {
    wrote(mcp, await registerClaude({ root, home, env, run, server }));
    if (dropClaudeProjectEntry(join(root, ".mcp.json"))) changed.push("removed Cortad from .mcp.json");
  }
  if (agent === "codex") wrote(mcp, registerCodex(join(root, mcp), server));
  if (agent === "cursor") wrote(mcp, registerJson(join(root, mcp), { type: "stdio", ...server }));

  if (agent === "copilot") wrote(mcp, registerJson(join(root, mcp), { type: "local", ...server, tools: ["*"] }));
  wrote(skill, installSkill(join(root, skill), { src: skillSrc, spec }));
  for (const rel of HOME_SKILLS) if (removeSkill(home, rel)) changed.push(`removed ~/${rel}`);
  return { agent: AGENTS[agent], changed };
}

async function registerClaude({ root, home, env, run, server }) {
  const file = join(home, ".claude.json");
  const current = () => readJson(file)?.projects?.[root]?.mcpServers?.cortad;
  if (onPath("claude", env)) {
    const add = () => run("claude", ["mcp", "add", "--scope", "local", "cortad", "--", server.command, ...server.args], { env, cwd: root });
    try { await add(); return true; } catch (err) {
      if (/already exists/i.test(String(err?.stderr ?? err?.message))) {
        if (same(current(), server)) return false;
        try { await run("claude", ["mcp", "remove", "--scope", "local", "cortad"], { env, cwd: root }); await add(); return true; } catch {  }
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

function dropClaudeProjectEntry(file) {
  const config = readJson(file);
  const entry = config?.mcpServers?.cortad;
  const ours = entry && Object.keys(entry).join() === "type,command,args" && entry.type === "stdio" && entry.command === "npx"
    && Array.isArray(entry.args) && entry.args.at(-1) === "mcp" && JSON.stringify(serverFor(entry.args.at(-2)).args) === JSON.stringify(entry.args);
  if (!ours) return false;
  delete config.mcpServers.cortad;
  if (!Object.keys(config.mcpServers).length) delete config.mcpServers;
  if (Object.keys(config).length) writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  else rmSync(file);
  return true;
}

export function isOurSkill(dir) {
  try {
    if (lstatSync(dir).isSymbolicLink()) return false;
    if (!/^---\nname: cortad\n/.test(readFileSync(join(dir, "SKILL.md"), "utf8"))) return false;
    const entries = readdirSync(dir, { recursive: true }).map(String).sort();
    return entries.every((e) => ["SKILL.md", "references", join("references", "results.md")].includes(e));
  } catch { return false; }
}

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

  const replaced = () => text.replace(CODEX_BLOCK, (old) => `${entry}${(old.match(/\n+$/)?.[0] ?? "\n").slice(1)}`);
  writeFileSync(file, block ? replaced() : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${entry}`);
  return true;
}

function registerJson(file, entry) {
  const config = readJson(file) ?? {};

  if (JSON.stringify(config.mcpServers?.cortad) === JSON.stringify(entry)) return false;
  config.mcpServers = { ...(config.mcpServers ?? {}), cortad: entry };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return true;
}

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
