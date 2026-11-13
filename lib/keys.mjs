import { parseEnv } from "./env-files.mjs";

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\\n|\s)*[A-Za-z0-9+/=]{40,}/;
const PROVIDER_TOKEN = /\b((?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|[rs]k_live_[0-9A-Za-z]{24,}|glpat-[0-9A-Za-z_-]{20,}))\b/g;

const NAMED_LITERAL = /["']?[\w-]*(?:key|secret|token|passw(?:or)?d|aes|iv|salt)["']?\s*[:=]\s*["']([A-Fa-f0-9]{32,}|[A-Za-z0-9+/_-]{32,}={0,2})["']/gi;

const random = (s) => /\d/.test(s) && /[A-Za-z]/.test(s) && new Set(s).size >= 10;
const any = (re, text) => [...text.matchAll(re)].some((m) => random(m[1]));

export function holdsKeys(text, values = []) {
  return PRIVATE_KEY.test(text) || any(PROVIDER_TOKEN, text) || any(NAMED_LITERAL, text) || values.some((v) => text.includes(v));
}

export const SECRET_NAME = /KEY|SECRET|TOKEN|PASSW|PRIVATE|CREDENTIAL/i;
const EXAMPLE = /\.(example|sample|template|dist)$/i;
export function secretEnvValues(envFiles, read) {
  const values = new Set();

  const add = (v) => { if (v.length >= 12 && !/\s/.test(v) && new Set(v).size >= 8) values.add(v); };
  for (const file of envFiles) {
    if (EXAMPLE.test(file)) continue;
    let text = "";
    try { text = read(file); } catch { continue; }
    for (const line of text.split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m && SECRET_NAME.test(m[1])) add(m[2].trim().replace(/^(['"])(.*)\1$/, "$2"));
    }

    for (const [name, v] of Object.entries(parseEnv(text))) {
      if (SECRET_NAME.test(name)) for (const one of v.split("\n")) add(one.trim());
    }
  }
  return [...values];
}
