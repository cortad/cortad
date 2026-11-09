import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "./env-files.mjs";

// Where this app reads its settings on this machine, and Cortad's lines in it. Cortad writes its two
// keys there and nothing else of the file changes. A file git does not ignore is never written: a
// key in a tracked file is one commit away from a public repository.
const has = (root, ...names) => names.some((name) => existsSync(join(root, name)));
const read = (file) => { try { return readFileSync(file, "utf8"); } catch { return ""; } };

// A secrets manager hands the app its settings when it starts; there is no file to write.
const MANAGERS = [["doppler run", "Doppler"], ["op run", "1Password"], ["infisical run", "Infisical"], ["dotenvx run", "dotenvx"], ["aws-vault exec", "aws-vault"]];

export function settingsOf(root) {
  const scripts = Object.values(JSON.parse(read(join(root, "package.json")) || "{}").scripts ?? {}).join("\n");
  const manager = MANAGERS.find(([command]) => scripts.includes(command))?.[1] ?? (has(root, ".envrc") ? "direnv" : null);
  if (manager) return { manager };
  const named = /--env-file(?:-if-exists)?[= ]([^\s"']+)/.exec(scripts)?.[1];
  if (named) return { file: named };
  if (has(root, "wrangler.toml", "wrangler.jsonc", "wrangler.json")) return { file: ".dev.vars" };
  if (readdirSafe(root).some((name) => /^(next|vite|astro|svelte|nuxt)\.config\./.test(name))) return { file: ".env.local" };
  if (has(root, ".env.local")) return { file: ".env.local" };
  return { file: ".env" };
}
const readdirSafe = (root) => { try { return readdirSync(root); } catch { return []; } };

// Whether git keeps this file out of commits. A folder that is not a repository has no commits.
export function ignored(root, file) {
  try { execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, stdio: "ignore" }); } catch { return true; }
  try { execFileSync("git", ["check-ignore", "-q", file], { cwd: root, stdio: "ignore" }); return true; } catch { return false; }
}

// The ids of the keys already in the file: the first 15 characters, which name a key and are sent
// with every request it signs. Never the keys.
export function keyIdsIn(root, file) {
  const env = parseEnv(read(join(root, file)));
  return ["CORTAD_INGEST_KEY", "CORTAD_PUBLIC_KEY"].map((name) => env[name]).filter((v) => /^ct_(ing|pub)_[A-Za-z0-9_-]{8}/.test(v ?? "")).map((v) => v.slice(0, 15));
}
export const publicKeyIn = (root, file) => parseEnv(read(join(root, file)))["CORTAD_PUBLIC_KEY"] ?? null;

// Writes Cortad's lines, replacing any Cortad wrote before, and answers the line number of each.
// CORTAD_ENV=development marks this copy of the app as the developer's, so its test chats are never
// counted as production's; the deployed copy does not read this file.
export function writeKeys(root, file, keys) {
  const path = join(root, file);
  const before = read(path);
  const lines = before.split("\n").filter((line) => !/^\s*(?:export\s+)?CORTAD_(INGEST_KEY|PUBLIC_KEY)\s*=/.test(line));
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const hasEnv = lines.some((line) => /^\s*(?:export\s+)?CORTAD_ENV\s*=/.test(line));
  const added = [`CORTAD_INGEST_KEY=${keys.ingest}`, `CORTAD_PUBLIC_KEY=${keys.page}`, ...(hasEnv ? [] : ["CORTAD_ENV=development"])];
  const at = lines.length + 1;
  writeFileSync(path, `${[...lines, ...added].join("\n")}\n`, { mode: existsSync(path) ? statSync(path).mode & 0o777 : 0o600 });
  return { ingest: at, page: at + 1, env: hasEnv ? null : at + 2 };
}

export function lineOf(root, file, name) {
  const index = read(join(root, file)).split("\n").findIndex((line) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line));
  return index === -1 ? null : index + 1;
}

// An image built from this folder carries the file unless .dockerignore leaves it out, and with it
// CORTAD_ENV=development into production, where the SDK would then send nothing.
export function imageCarries(root, file) {
  if (!has(root, "Dockerfile", "dockerfile")) return false;
  const rules = read(join(root, ".dockerignore")).split("\n").map((line) => line.trim());
  return !rules.some((rule) => rule === file || rule === ".env*" || rule === "*.env*" || (file.startsWith(".env") && rule === ".env*"));
}
