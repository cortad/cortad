import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FOLDERS = ["", "server", "backend", "api", "app", "web", "src"];
const GROUPS = ["apps", "packages", "services"];

const UNDER = ["mongoose", "drizzle-orm", "typeorm", "sequelize", "knex", "kysely", "@mikro-orm/core", "@prisma/adapter-pg", "@prisma/adapter-neon", "@prisma/adapter-mssql",
  "@prisma/adapter-planetscale", "@prisma/adapter-libsql", "@prisma/adapter-better-sqlite3", "@langchain/community", "connect-redis", "bullmq"];

function folders(root) {
  const out = FOLDERS.map((f) => join(root, f));
  for (const group of GROUPS) {
    try { for (const d of readdirSync(join(root, group), { withFileTypes: true })) if (d.isDirectory()) out.push(join(root, group, d.name)); } catch {  }
  }
  return out.filter((dir) => existsSync(join(dir, "package.json")) || existsSync(join(dir, "node_modules")));
}

export function nodeDriver(root, names) {
  for (const dir of folders(root)) {
    const need = createRequire(join(dir, "package.json"));
    for (const name of names) {
      try { return { name, mod: need(name) }; } catch {  }
      for (const parent of UNDER) {
        try { return { name, mod: createRequire(need.resolve(parent))(name) }; } catch {  }
      }
    }
  }
  return null;
}

const PYTHONS = [".venv/bin/python", "venv/bin/python", "env/bin/python", ".venv/Scripts/python.exe", "venv/Scripts/python.exe"];

export function pythonDriver(root, modules) {
  const found = [];
  for (const dir of [root, ...["backend", "server", "api", "app"].map((f) => join(root, f))]) {
    for (const p of PYTHONS) if (existsSync(join(dir, p))) found.push(join(dir, p));
  }
  for (const python of [...found, "python3", "python"]) {
    try {
      const has = execFileSync(python, ["-I", "-c", "import importlib.util,sys; print(next((m for m in sys.argv[1:] if importlib.util.find_spec(m)), ''))", ...modules], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (has) return { python, module: has };
    } catch {  }
  }
  return null;
}

const SCRIPT = fileURLToPath(new URL("../../py/dbread.py", import.meta.url));

export function pythonSession(python, open) {
  const child = spawn(python, ["-I", SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let stderr = "";
  const waiting = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const next = waiting.shift();
      if (!next) continue;
      let answer;
      try { answer = JSON.parse(line); } catch { answer = { error: "the Python reader answered something that is not JSON" }; }
      if (answer.error) next.reject(new Error(answer.error)); else next.resolve(answer.result);
    }
  });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2_000); });
  child.on("close", () => {
    for (const w of waiting.splice(0)) w.reject(new Error(lastLine(stderr) || "the Python reader stopped"));
  });
  const ask = (request) => new Promise((resolve, reject) => {
    waiting.push({ resolve, reject });
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
  const ready = ask({ open });
  ready.catch(() => child.stdin.end());
  return {
    call: async (request) => { await ready; return ask(request); },
    ready,
    close: () => { child.stdin.end(); },
  };
}
const lastLine = (text) => text.trim().split("\n").at(-1) ?? "";
