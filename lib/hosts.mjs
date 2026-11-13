import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const has = (root, name) => existsSync(join(root, name));
const workflows = (root) => {
  try { return readdirSync(join(root, ".github", "workflows")).map((name) => readFileSync(join(root, ".github", "workflows", name), "utf8")).join("\n"); } catch { return ""; }
};

export const HOSTS = {
  vercel: { name: "Vercel", place: "your Vercel project: Settings, Environment Variables, Production" },
  cloudflare: { name: "Cloudflare", place: "your Worker in Cloudflare: Settings, Variables and Secrets" },
  fly: { name: "Fly.io", place: "your app on Fly.io: Secrets" },
  github: { name: "GitHub Actions", place: "the repository on GitHub: Settings, Secrets and variables, Actions" },
  railway: { name: "Railway", place: "your service on Railway: Variables" },
  render: { name: "Render", place: "your service on Render: Environment" },
  netlify: { name: "Netlify", place: "your site on Netlify: Site configuration, Environment variables" },
  heroku: { name: "Heroku", place: "your app on Heroku: Settings, Config Vars" },
  other: { name: "your host", place: "the settings where your live app's environment variables are kept" },
};

export function hostOf(root) {
  if (has(root, ".vercel/project.json") || has(root, "vercel.json")) return "vercel";
  if (has(root, "wrangler.toml") || has(root, "wrangler.jsonc") || has(root, "wrangler.json")) return "cloudflare";
  if (has(root, "fly.toml")) return "fly";
  if (has(root, "railway.json") || has(root, "railway.toml")) return "railway";
  if (has(root, "render.yaml")) return "render";
  if (has(root, "netlify.toml")) return "netlify";
  if (has(root, "Procfile") && has(root, "app.json")) return "heroku";
  if (/\$\{\{\s*secrets\./.test(workflows(root))) return "github";
  return "other";
}

const SETTERS = {
  vercel: { check: ["vercel", ["whoami"]], linked: ".vercel/project.json", run: ["vercel", ["env", "add", "CORTAD_INGEST_KEY", "production"]], input: (key) => key },
  cloudflare: { check: ["npx", ["wrangler", "whoami"]], run: ["npx", ["wrangler", "secret", "put", "CORTAD_INGEST_KEY"]], input: (key) => key },
  fly: { check: ["fly", ["auth", "whoami"]], run: ["fly", ["secrets", "import", "--stage"]], input: (key) => `CORTAD_INGEST_KEY=${key}\n` },
  github: { check: ["gh", ["auth", "status"]], run: ["gh", ["secret", "set", "CORTAD_INGEST_KEY"]], input: (key) => key },
};

export const commandLine = (host) => { const s = SETTERS[host]; return s ? [s.run[0], ...s.run[1]].join(" ") : null; };

export function canSet(root, host) {
  const setter = SETTERS[host];
  if (!setter || (setter.linked && !has(root, setter.linked))) return false;
  try {
    execFileSync(setter.check[0], setter.check[1], { cwd: root, stdio: "ignore", timeout: 10_000, shell: process.platform === "win32" });
    return true;
  } catch { return false; }
}

export function setKey(root, host, key) {
  const setter = SETTERS[host];
  if (!setter) return { ok: false, why: `${HOSTS[host]?.name ?? "This host"} has no command Cortad runs` };
  const done = spawnSync(setter.run[0], setter.run[1], { cwd: root, input: setter.input(key), encoding: "utf8", timeout: 60_000, shell: process.platform === "win32" });
  if (done.status === 0) return { ok: true };

  const said = `${done.stderr ?? ""}${done.stdout ?? ""}`.split(key).join("[the key]").trim().split("\n").slice(-3).join(" ");
  return { ok: false, why: said || `${commandLine(host)} stopped with code ${done.status}` };
}
