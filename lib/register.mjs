import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cliSpec, npxArgs } from "./spec.mjs";

// Making Cortad known to the coding agents on this machine: an MCP entry in each client that is
// here, and the skill that teaches the loop. Nothing is written into the repository; everything
// lands in the client's own home folders, the way the client's own `add` command would put it.
// Idempotent: run twice, it adds nothing twice. An entry naming another spec (lib/spec.mjs) is
// replaced, so a connect with a newer package moves every client to it.
const exec = promisify(execFile);
const SKILL_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "skill");
// The skill's shell examples name the spec in place of this.
const PLACEHOLDER = "{{cortad}}";

export const serverFor = (spec) => ({ command: "npx", args: [...npxArgs(spec), "mcp"] });
const same = (entry, server) => entry?.command === server.command && JSON.stringify(entry?.args) === JSON.stringify(server.args);

export const onPath = (bin, env = process.env) =>
  (env.PATH ?? "").split(delimiter).some((dir) => dir && existsSync(join(dir, bin)));

export function detectClients({ home = homedir(), env = process.env } = {}) {
  return {
    claude: onPath("claude", env) || existsSync(join(home, ".claude")),
    codex: onPath("codex", env) || existsSync(join(home, ".codex")),
    cursor: existsSync(join(home, ".cursor")),
    copilot: onPath("copilot", env) || existsSync(join(home, ".copilot")),
  };
}

// The clients that now know Cortad, and the files under the home folder this call wrote, relative to
// it: a connect says what it changed only when it changed something.
export async function registerAll({ home = homedir(), env = process.env, run = exec, skillSrc = SKILL_SRC, spec = cliSpec({ env }) } = {}) {
  const found = detectClients({ home, env });
  const server = serverFor(spec);
  const clients = [];
  const changed = [];
  const wrote = (rel, did) => { if (did) changed.push(rel); };
  const skill = (rel) => wrote(rel, installSkill(join(home, rel), { src: skillSrc, spec }));
  if (found.claude) {
    wrote(".claude.json", await registerClaude({ home, env, run, server }));
    skill(join(".claude", "skills", "cortad"));
    clients.push("Claude Code");
  }
  if (found.codex) {
    wrote(join(".codex", "config.toml"), await registerCodex({ home, env, run, server }));
    clients.push("Codex");
  }
  if (found.cursor) {
    wrote(join(".cursor", "mcp.json"), registerJson(join(home, ".cursor", "mcp.json"), { type: "stdio", ...server }));
    clients.push("Cursor");
  }
  if (found.copilot) {
    // Copilot CLI keeps its servers in its own home, in its own shape: a "local" server with every tool.
    wrote(join(".copilot", "mcp-config.json"), registerJson(join(home, ".copilot", "mcp-config.json"), { type: "local", ...server, tools: ["*"] }));
    skill(join(".copilot", "skills", "cortad"));
    clients.push("Copilot");
  }
  // The one skills folder Codex, Cursor and Copilot all read.
  if (found.codex || found.cursor || found.copilot) skill(join(".agents", "skills", "cortad"));
  return { clients, changed };
}

// The client's own command when it is here, so its config is written the way it writes it; the file
// itself only when the folder exists without the binary on this PATH, or the command failed. Each
// register step says whether it wrote.
async function registerClaude({ home, env, run, server }) {
  const file = join(home, ".claude.json");
  if (onPath("claude", env)) {
    const add = () => run("claude", ["mcp", "add", "--scope", "user", "cortad", "--", server.command, ...server.args], { env });
    try { await add(); return true; } catch (err) {
      if (/already exists/i.test(String(err?.stderr ?? err?.message))) {
        if (same(readJson(file)?.mcpServers?.cortad, server)) return false;
        try { await run("claude", ["mcp", "remove", "--scope", "user", "cortad"], { env }); await add(); return true; } catch { /* the file below */ }
      }
    }
  }
  return registerJson(file, { type: "stdio", ...server });
}

const CODEX_BLOCK = /^\[mcp_servers\.cortad\]\n(?:(?!\[).*(?:\n|$))*/m;

async function registerCodex({ home, env, run, server }) {
  const file = join(home, ".codex", "config.toml");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const block = text.match(CODEX_BLOCK)?.[0] ?? "";
  const args = block.match(/^args\s*=\s*(\[.*\])\s*$/m)?.[1];
  const current = (() => { try { return args ? { command: block.match(/^command\s*=\s*"(.*)"\s*$/m)?.[1], args: JSON.parse(args) } : null; } catch { return null; } })();
  if (same(current, server)) return false;
  if (onPath("codex", env)) {
    try {
      if (block) await run("codex", ["mcp", "remove", "cortad"], { env });
      await run("codex", ["mcp", "add", "cortad", "--", server.command, ...server.args], { env });
      return true;
    } catch { /* the file below */ }
  }
  const entry = `[mcp_servers.cortad]\ncommand = "${server.command}"\nargs = ${JSON.stringify(server.args)}\n`;
  mkdirSync(dirname(file), { recursive: true });
  // The blank lines after the old block stay, so the rest of the file keeps its layout.
  const replaced = () => text.replace(CODEX_BLOCK, (old) => `${entry}${(old.match(/\n+$/)?.[0] ?? "\n").slice(1)}`);
  writeFileSync(file, block ? replaced() : `${text}${text && !text.endsWith("\n") ? "\n" : ""}\n${entry}`);
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
