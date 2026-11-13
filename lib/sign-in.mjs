import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserHeaders } from "./reach.mjs";

const SECRETS = /^(?:JWT_SECRET|JWT_SECRET_KEY|JWT_KEY|JWT_SIGNING_KEY|ACCESS_TOKEN_SECRET|AUTH_SECRET|TOKEN_SECRET|SUPABASE_JWT_SECRET|APP_JWT_SECRET)$/;
const b64 = (s) => Buffer.from(s).toString("base64url");

export function mintJwt(env, { now = Date.now } = {}) {
  const name = Object.keys(env).find((k) => SECRETS.test(k) && String(env[k] ?? "").length >= 8);
  if (!name) return null;
  const supabase = /SUPABASE/.test(name) || Boolean(env.SUPABASE_URL);
  const iat = Math.floor(now() / 1000);
  const claims = {
    sub: "cortad-test", id: "cortad-test", userId: "cortad-test", user_id: "cortad-test",
    email: "cortad-test@example.com", name: "Cortad Test", role: supabase ? "authenticated" : "user",
    ...(supabase ? { aud: "authenticated" } : {}), iat, exp: iat + 3600,
  };
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify(claims));
  const sig = createHmac("sha256", String(env[name])).update(`${head}.${body}`).digest("base64url");
  return { name: "authorization", value: `Bearer ${head}.${body}.${sig}`, how: `a token signed with ${name} from your env` };
}

const YES = "sign-in-yes.json";
export function recordSignInYes(home) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, YES), JSON.stringify({ at: new Date().toISOString() }), { mode: 0o600 });
}
export const mintAfterYes = (home, env) => (existsSync(join(home, YES)) ? mintJwt(env) : null);

export function testAccount(home) {
  const file = join(home, "test-account.json");
  if (existsSync(file)) { try { return JSON.parse(readFileSync(file, "utf8")); } catch {  } }
  const tag = randomBytes(4).toString("hex");
  const creds = { email: `cortad-test-${tag}@example.com`, username: `cortad-test-${tag}`, password: `Ct-${randomBytes(12).toString("base64url")}!9`, name: "Cortad Test" };
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(creds), { mode: 0o600 });
  return creds;
}

const FIELD = [
  [/^(?:e-?mail|email_?address|user_?email)$/i, (c) => c.email],
  [/^(?:user_?name|login|handle|nick(?:name)?)$/i, (c) => c.username],
  [/^(?:pass(?:word)?|pwd)$/i, (c) => c.password],
  [/^(?:confirm_?password|password_?confirm(?:ation)?|confirm|repeat_?password|password2)$/i, (c) => c.password],
  [/^(?:name|full_?name|display_?name)$/i, (c) => c.name],
  [/^(?:first_?name|given_?name)$/i, () => "Cortad"],
  [/^(?:last_?name|family_?name|surname)$/i, () => "Test"],
  [/^(?:terms|accept_?terms|agree(?:d)?|tos|consent)$/i, () => true],
];
export function bodyFor(fields, creds) {
  const body = {};
  for (const f of fields ?? []) { const m = FIELD.find(([re]) => re.test(f)); if (m) body[f] = m[1](creds); }
  return Object.keys(body).some((k) => /pass/i.test(k)) ? body : null;
}

export function tokenIn(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 3) return null;
  for (const [k, v] of Object.entries(value)) if (typeof v === "string" && v.length > 10 && /^(?:access_?token|token|jwt|id_?token|session_?token|bearer)$/i.test(k)) return v;
  for (const v of Object.values(value)) { const t = tokenIn(v, depth + 1); if (t) return t; }
  return null;
}

export async function signUpAndIn(app, auth, creds, fetchImpl = fetch, { origin = null } = {}) {
  if (!auth?.login && !auth?.signup) return null;
  const post = async (door, body, cookie) => {
    const res = await fetchImpl(new URL(door.path, app.origin), { method: "POST", headers: { "content-type": "application/json", ...browserHeaders(origin), ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(15_000) });
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(text); } catch {  }
    const cookies = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).filter(Boolean);
    return { status: res.status, json, text, cookies };
  };
  const shapes = (door, kind) => {
    const known = bodyFor(door.fields, creds);
    if (known) return [known];
    const extra = kind === "signup" ? { name: creds.name } : {};
    return [{ email: creds.email, password: creds.password, ...extra }, { username: creds.username, password: creds.password, ...extra }];
  };
  const headerOf = (got) => {
    const token = tokenIn(got.json);
    if (token) return { name: "authorization", value: `Bearer ${token}` };
    if (got.cookies.length) return { name: "cookie", value: got.cookies.join("; ") };
    return null;
  };
  const how = `signed in as the test account Cortad made on your app (${creds.email})`;
  let fromSignup = null;
  if (auth.signup) {
    for (const body of shapes(auth.signup, "signup")) {
      const got = await post(auth.signup, body).catch(() => null);
      if (!got) continue;
      if (got.status < 300) { fromSignup = headerOf(got); break; }
      if (got.status === 409 || /exist|taken|already/i.test(got.text)) break;
    }
  }
  if (auth.login) {
    for (const body of shapes(auth.login, "login")) {
      const got = await post(auth.login, body).catch(() => null);
      if (!got || got.status >= 300) continue;
      const h = headerOf(got);
      if (h) return { ...h, how };
    }
  }
  return fromSignup ? { ...fromSignup, how } : null;
}

const SIGN_IN_FILE = "sign-in.json";
export function keptSignIn(home) {
  try { const kept = JSON.parse(readFileSync(join(home, SIGN_IN_FILE), "utf8")); return kept?.name && kept.value ? { name: kept.name, value: kept.value, how: `the sign-in kept from your last connect (${kept.how ?? "a test account"})` } : null; } catch { return null; }
}
export function rememberSignIn(home, as) {
  if (!as?.name || !as.value) return;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, SIGN_IN_FILE), JSON.stringify({ name: as.name, value: as.value, how: as.how ?? "a test account", at: new Date().toISOString() }), { mode: 0o600 });
}
export function forgetSignIn(home) {
  try { rmSync(join(home, SIGN_IN_FILE), { force: true }); } catch {  }
}
