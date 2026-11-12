import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "./env-files.mjs";

// What the app's own client looks like from the app's side, read from this folder and never sent
// anywhere: the local origin its CORS allowlist or its settings name, and the key its env holds for
// callers that must carry one. An app that answers only its own client (an origin guard, a bot guard
// on Sec-Fetch headers, an x-api-key check) answers Cortad's test request the same way once the
// request looks like that client. One customer's guest guard turned every test request away for a
// day and the refusal was read as a missing sign-in (2026-10-24).

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "out", "target", "vendor", ".venv", "venv", "__pycache__", ".cache", "logs", "data", "runs", "artifacts", "reports"]);
const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rb|php|rs|java|kt|cs|json|ya?ml|toml)$/;
const LOCAL = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d{2,5}))?/g;
const NEAR = /origin|cors|allow|client|frontend|web_?url|site_?url|app_?url|public_?url|referer/i;
const ENV_ORIGIN = /ORIGIN|CORS|FRONTEND|CLIENT_URL|DOMAIN_CLIENT|WEB_URL|SITE_URL|APP_URL|PUBLIC_URL/;
const ENV_KEY = /^(?:X_)?API_KEY$|^APP_API_KEY$|^INTERNAL_API_KEY$|^(?:X_)?ADMIN_KEY$|^API_TOKEN$|^AUTH_TOKEN$|^SERVICE_KEY$|^SERVER_KEY$|^ACCESS_CODE$/;
const ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local"];
// The port the server's own code listens on when nothing overrides it (`PORT ?? '3100'`,
// `.listen(3100`): its own address is never its client, even when this session moved it elsewhere.
const OWN_PORT = /\bPORT\b['"\]]*\s*(?:\?\?|\|\|)\s*['"]?(\d{2,5})|\.listen\(\s*(\d{2,5})\b/g;
const FILE_CAP = 512_000;

export const envOf = (root) => {
  let env = {};
  for (const name of ENV_FILES) {
    try { env = { ...env, ...parseEnv(readFileSync(join(root, name), "utf8"), env) }; } catch { /* not there */ }
  }
  return env;
};

// The origin the app's own client is served from, by the code's own word: every local origin named
// in the source or the env, scored up where it stands beside a CORS, origin or client word, the app's
// own port left out. Null when the code names none; the caller then uses the app's own origin.
export function clientOriginOf(root, { port = null, limit = 4000 } = {}) {
  const scores = new Map();
  const count = (url, by) => scores.set(url, (scores.get(url) ?? 0) + by);
  let seen = 0;
  const own = new Set(port ? [Number(port)] : []);
  const walk = (dir, depth) => {
    if (depth > 6 || seen > limit) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith(".")) walk(join(dir, e.name), depth + 1); continue; }
      if (!e.isFile() || !SOURCE.test(e.name)) continue;
      seen += 1;
      const file = join(dir, e.name);
      let text;
      try { if (statSync(file).size > FILE_CAP) continue; text = readFileSync(file, "utf8"); } catch { continue; }
      for (const m of text.matchAll(OWN_PORT)) own.add(Number(m[1] ?? m[2]));
      for (const m of text.matchAll(LOCAL)) {
        const around = text.slice(Math.max(0, m.index - 100), m.index);
        count(m[0], NEAR.test(around) ? 3 : 1);
      }
    }
  };
  walk(root, 0);
  const env = envOf(root);
  if (/^\d{2,5}$/.test(String(env["PORT"] ?? ""))) own.add(Number(env["PORT"]));
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_ORIGIN.test(name)) continue;
    for (const m of String(value).matchAll(LOCAL)) count(m[0], 4);
  }
  const best = [...scores].filter(([url]) => !own.has(Number(new URL(url).port || (url.startsWith("https") ? 443 : 80)))).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

// The keys the app's env holds for a caller that must carry one, each as the two headers an app
// reads such a key from. Only names that are plainly the app's own gate, never a provider's key.
export function keysFromEnv(root) {
  const out = [];
  for (const [name, value] of Object.entries(envOf(root))) {
    if (!ENV_KEY.test(name) || !value) continue;
    out.push({ name, header: "x-api-key", value: String(value) }, { name, header: "authorization", value: `Bearer ${value}` });
  }
  return out;
}
