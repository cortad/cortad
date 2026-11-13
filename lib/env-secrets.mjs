import { readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { parseEnv } from "./env-files.mjs";
import { SECRET_NAME } from "./keys.mjs";

const NAMES_A_MODEL = /(?:^|_)(?:MODEL|MODELS|MODEL_NAME|MODEL_ID|PROVIDER)$/i;
const KEY_LIKE = /[A-Za-z0-9]{24,}/;

export function environmentSecrets(env) {
  const out = [];
  for (const [name, value] of Object.entries(env ?? {})) {
    if (!SECRET_NAME.test(name) || typeof value !== "string" || WHERE_A_KEY_LIVES.test(value)) continue;
    if (value.length >= 12 && !/\s/.test(value) && new Set(value).size >= 8) out.push(value);
  }
  return out;
}

const WHERE_A_KEY_LIVES = /^[~.]?\/[\w.\-/]+$/;

export function secretValues(envFiles, alsoFromEnvironment = []) {
  const values = new Set();
  const add = (name, v) => {
    if (NAMES_A_MODEL.test(name) && !KEY_LIKE.test(v)) return;
    for (const one of v.includes("\n") ? [v, ...v.split("\n").map((l) => l.trim()).filter((l) => l.length >= 12)] : [v]) {
      if (one.length >= 8 && !/^(true|false|localhost|development|production|\d+)$/i.test(one)) values.add(one);
    }
  };
  for (const file of envFiles) {
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m) add(m[1], m[2].trim().replace(/^(['"])(.*)\1$/, "$2"));
    }
    for (const [name, v] of Object.entries(parseEnv(text))) add(name, v);
  }
  for (const value of alsoFromEnvironment) values.add(value);
  return [...values].sort((a, b) => b.length - a.length);
}

export const maskWith = (text, values) => { let s = text; for (const v of values) s = s.split(v).join("[masked]"); return s; };

export const credentialShaped = (v) => KEY_LIKE.test(v) || !/^[A-Za-z ._-]+$/.test(v) || v.length >= 24;

export function maskedLines(values, write, max = 16_000) {
  const decoder = new StringDecoder("utf8");
  let carry = "";
  return (chunk) => {
    const text = carry + decoder.write(chunk);
    const end = text.lastIndexOf("\n") + 1;
    let out = maskWith(text.slice(0, end), values());
    carry = text.slice(end);
    if (carry.length > max) {
      const masked = maskWith(carry, values());
      const cut = Math.max(0, masked.length - Math.max(0, ...values().map((v) => v.length - 1)));
      out += masked.slice(0, cut);
      carry = masked.slice(cut);
    }
    if (out) write(out);
  };
}
