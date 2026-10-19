import { readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { parseEnv } from "./env-files.mjs";
import { SECRET_NAME } from "./keys.mjs";

// A model's or provider's name is how the app is configured, not a credential: status names it and
// prices the run by it. A value under such a name that looks like a key stays masked all the same.
const NAMES_A_MODEL = /(?:^|_)(?:MODEL|MODELS|MODEL_NAME|MODEL_ID|PROVIDER)$/i;
const KEY_LIKE = /[A-Za-z0-9]{24,}/;

// Values from your env files, read here and only here, so nothing a command prints can carry one.
// Each value as the line holds it and as the app's own loader reads it (lib/env-files.mjs parseEnv),
// and each line of one that spans lines: the app is handed the parsed value, so a value that differs
// from its line (a trailing comment, an escaped quote, a key across lines) must be masked as parsed.
// A secret your app is handed through the environment instead of a file: a provisioned machine has
// its keys applied to the shell that starts the app, which is how a repository with no env file in
// it still runs on real credentials. A value we never read is a value we cannot hide, and theirs
// were printed back by their own app. Name says credential, value is long and varied: a word, a
// path, a host or a port never is.
export function environmentSecrets(env) {
  const out = [];
  for (const [name, value] of Object.entries(env ?? {})) {
    if (!SECRET_NAME.test(name) || typeof value !== "string" || WHERE_A_KEY_LIVES.test(value)) continue;
    if (value.length >= 12 && !/\s/.test(value) && new Set(value).size >= 8) out.push(value);
  }
  return out;
}
// A credential-named variable that holds a path holds the place the key is kept, not the key:
// GOOGLE_APPLICATION_CREDENTIALS names a file. Masking it takes a line their own log needs. A key
// written in base64 carries characters no path has, so it is never read as one.
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

// Whether a value reads as a credential rather than configuration. A database or project name is a
// route word too: masking it inside the app's route table turns the path into one no request can
// replay, and every trial of that door fails. A plain word under 24 characters is configuration;
// anything key-like, mixed with digits or symbols, or long stays masked everywhere.
export const credentialShaped = (v) => KEY_LIKE.test(v) || !/^[A-Za-z ._-]+$/.test(v) || v.length >= 24;

// A process's output as it may be kept: masked with `values()`, read at each chunk since values are
// learned while the app runs, and never cut inside one. A line goes to `write` once it ends; a line
// longer than `max` goes on early, all but its last characters, as many as the longest value less
// one, so a value the chunk ended inside is masked whole with the next. Nothing is added to it.
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
