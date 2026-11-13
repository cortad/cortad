import { isIPv4 } from "node:net";
import { join } from "node:path";
import { grpcCall } from "./grpc.mjs";
import { unreached } from "./contact-text.mjs";
import { plural, upper } from "./words.mjs";

export const REACH_MS = 55_000;
const SAID_CHARS = 200;
const NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
const RUN_TURN = "x-cortad-turn";
const loopback = (host) => host === "::1" || (isIPv4(host) && host.startsWith("127."));
const keyOf = (m) => `${m.method} ${m.path}`;
const appUrl = (runner) => new URL(`http://${runner.host === "::1" ? "[::1]" : runner.host ?? "127.0.0.1"}:${runner.port}`);

export function notUp(runner) {
  if (runner?.state !== "up") {
    return !runner ? "No connect command is running for this repository, so no app is up on this machine. Run npx cortad in this folder as a background command to connect it again."
      : runner.state === "failed" ? upper(runner.error) : "Your app is still starting.";
  }
  const host = runner.host ?? "127.0.0.1";
  return loopback(host) ? null : `${host} is not this machine; reach sends only to your app on this machine.`;
}

export function picked(contact, receipts, paths = []) {
  const rows = unreached(contact, receipts, { retests: true });
  const named = new Set(Array.isArray(paths) ? paths : []);
  const chosen = named.size ? rows.filter((m) => named.has(m.path) || named.has(keyOf(m))) : rows.filter((m) => !m.unsure);
  const sent = chosen.filter((m) => m.request);
  return {
    rows, sent,
    left: (named.size ? chosen : rows).filter((m) => !m.excluded && !sent.includes(m)),
    unknown: [...named].filter((p) => !rows.some((m) => p === m.path || p === keyOf(m))),
  };
}

export async function reach({ runner, contact, headers = {}, paths = [], fetchImpl = fetch }) {
  const down = notUp(runner);
  if (down) return refused(down);
  const sign = headersOf(headers);
  if (sign.error) return refused(sign.error);
  const pick = picked(contact, runner.receipts, paths);
  const app = appUrl(runner);
  const secrets = secretsIn(sign.headers);
  const names = Object.keys(sign.headers);

  let n = 0;
  const headersFor = () => (names.length ? sign.headers : { [RUN_TURN]: `reach:agent:${++n}` });
  const answers = await Promise.all(pick.sent.map((m) => sendOne(m, app, headersFor(), fetchImpl, secrets)));
  return { text: reachText(pick, answers, `${runner.port} at once${names.length ? `, with the headers ${names.join(", ")}` : ""}`) };
}

export function reachText({ rows, sent, left, unknown }, answers, how) {
  return [
    sent.length ? `Sent ${plural(sent.length, "request")} to your app on port ${how}:`
      : rows.length ? "Nothing was sent." : "Nothing was sent: status lists no endpoint that no request has reached.",
    ...answers.map((a) => `  ${a.line}`),
    ...(left.length ? ["Not sent:", ...left.map((m) => `  ${m.method} ${m.path}: ${whyNot(m)}`)] : []),
    unknown.length ? `Not among the endpoints no request has reached: ${unknown.join(", ")}.` : "",
    sent.length ? "status shows which of them reached your model." : "",
    "next: status",
  ].filter(Boolean).join("\n");
}

const AT_ONCE = 4;

export const SIMULATION_HEADER = "x-cortad-simulation";

export const browserHeaders = (origin) => ({
  accept: "application/json, text/event-stream;q=0.9, */*;q=0.8",
  "user-agent": "Mozilla/5.0 (compatible; Cortad test request)",
  [SIMULATION_HEADER]: "1",
  "sec-fetch-mode": "cors", "sec-fetch-site": "same-site", "sec-fetch-dest": "empty",
  ...(origin ? { origin, referer: `${origin}/` } : {}),
});

const CSRF_DOORS = ["/api/auth/csrf", "/sanctum/csrf-cookie", "/api/csrf", "/csrf", "/"];
export async function csrfOf(app, fetchImpl = fetch) {
  for (const path of CSRF_DOORS) {
    let res;
    try { res = await fetchImpl(new URL(path, app.origin), { headers: browserHeaders(null), redirect: "manual", signal: AbortSignal.timeout(5_000) }); } catch { continue; }
    const cookies = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).filter(Boolean);
    let token = null;
    for (const c of cookies) {
      const [name, ...rest] = c.split("=");
      const value = decodeURIComponent(rest.join("="));
      if (/xsrf|csrf/i.test(name) && value) token = value.split("|")[0];
    }
    if (!token && /json/i.test(res.headers.get("content-type") ?? "")) {
      try { const j = await res.json(); if (typeof j?.csrfToken === "string") token = j.csrfToken; } catch {  }
    }
    if (token) return { "x-xsrf-token": token, "x-csrf-token": token, "x-csrftoken": token, ...(cookies.length ? { cookie: cookies.join("; ") } : {}) };
  }
  return null;
}
const gated = (a) => refusedVisitor(a) || a.status === 419;

export async function sendOurs(rows, { runner, origin, signIn = async () => null, kept = async () => null, keys = () => [], mint = async () => null, account = async () => null, browser = async () => null, onSignedIn = () => {}, onKeptRefused = () => {}, next, stop = () => false, onAnswer = () => {}, fetchImpl = fetch, atOnce = AT_ONCE }) {
  const app = appUrl(runner);
  const base = () => ({ ...browserHeaders(origin), [RUN_TURN]: `reach:agent:${next()}` });
  const answers = [];
  let at = 0, stopped = false;

  const one = async (m) => {
    let got = await sendOne(m, app, base(), fetchImpl);
    const words = () => String(got.said ?? "");
    if (gated(got) && /csrf|xsrf/i.test(words())) {
      const token = await csrfOf(app, fetchImpl).catch(() => null);
      if (token) { const again = await sendOne(m, app, { ...base(), ...token }, fetchImpl); got = { ...again, line: `${again.line} Sent with the CSRF token your app handed out.` }; }
    }
    if (refusedVisitor(got) && /api[ _-]?key|x-api-key|access code|token/i.test(words())) {
      for (const k of keys(m)) {
        const again = await sendOne(m, app, { ...base(), [k.header]: k.value }, fetchImpl, secretsIn({ [k.header]: k.value }));
        if (!refusedVisitor(again)) { got = { ...again, line: `${again.line} Sent with ${k.name} from your env.` }; break; }
      }
    }
    if (refusedVisitor(got)) {
      const as = await signIn(m).catch(() => null);
      if (as?.name && as.value) {
        const again = await sendOne(m, app, { ...base(), [as.name]: as.value }, fetchImpl, secretsIn({ [as.name]: as.value }));
        got = { ...again, signedIn: true, line: `${again.line} Sent as a test account.` };
        if (!refusedVisitor(again)) onSignedIn({ ...as, how: "the test account your own request signed in as" });
      }
    }

    if (refusedVisitor(got) && !got.signedIn) {
      const as = await kept(m).catch(() => null);
      if (as?.name && as.value) {
        const again = await sendOne(m, app, { ...base(), [as.name]: as.value }, fetchImpl, secretsIn({ [as.name]: as.value }));
        if (!refusedVisitor(again)) got = { ...again, signedIn: true, line: `${again.line} Sent with ${as.how}.` };
        else { onKeptRefused(); got = { ...got, line: `${got.line} ${upper(as.how)} was refused, so it is forgotten.` }; }
      }
    }

    for (const climb of [mint, account, browser]) {
      if (!refusedVisitor(got) || got.signedIn) break;
      const as = await climb(m).catch(() => null);
      const extra = as?.headers ?? (as?.name && as.value ? { [as.name]: as.value } : null);
      if (!extra || !Object.keys(extra).length) continue;
      const again = await sendOne(m, app, { ...base(), ...extra }, fetchImpl, secretsIn(extra));
      if (!refusedVisitor(again)) { got = { ...again, signedIn: true, line: `${again.line} Sent with ${as.how}.` }; if (!as.headers) onSignedIn(as); break; }
      got = { ...got, line: `${got.line} ${upper(as.how)} was refused too.` };
    }
    return got;
  };
  const lane = async () => {
    while (at < rows.length) {
      if (stopped || stop()) { stopped = true; return; }
      const i = at++;
      answers[i] = await one(rows[i]);
      try { onAnswer(answers[i], i); } catch {  }
    }
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, rows.length) }, lane));

  const end = answers.findIndex((a) => a === undefined);
  return end === -1 ? answers : answers.slice(0, end);
}
export const refusedVisitor = (a) => a.status === 401 || a.status === 403;

export const needsSignIn = (a) => a.status === 401 && !a.signedIn;

export function testedLine(answers, rows = []) {
  const tested = answers.map((a, i) => ({ a, row: rows[i] })).filter(({ a }) => !a.unsent && !a.down);
  if (!tested.length) return null;
  if (tested.length === 1 && tested[0].row) {
    const { a, row } = tested[0];
    return `tested ${keyOf(row)}: ${a.ok ? "answered" : needsSignIn(a) ? "needs a signed-in user" : a.status === 403 && !a.signedIn ? `refused by your app${a.said ? ` ("${a.said.slice(0, 80)}")` : ""}` : "failed"}`;
  }
  const answered = tested.filter(({ a }) => a.ok).length;
  const signIn = tested.filter(({ a }) => needsSignIn(a)).length;
  const refused = tested.filter(({ a }) => a.status === 403 && !a.signedIn).length;
  const failed = tested.length - answered - signIn - refused;
  return `tested ${plural(tested.length, "endpoint")}: ${[
    `${answered} answered`,
    failed && `${failed} failed`,
    refused && `${refused} refused by your app`,
    signIn && `${signIn} ${signIn === 1 ? "needs" : "need"} a signed-in user`,
  ].filter(Boolean).join(", ")}`;
}

const refused = (why) => ({ text: `${why} Nothing was sent.\nnext: status`, isError: true });

const whyNot = (m) => m.byHand ?? (m.request ? "Cortad is not sure it reaches your model; name its path in test with endpoints to send it." : "Cortad has no request ready for it.");

export function headersOf(given) {
  if (!given || typeof given !== "object" || Array.isArray(given)) return { error: "Headers are passed as names with their values." };
  const headers = {};
  for (const [name, value] of Object.entries(given)) {
    if (!NAME.test(name) || typeof value !== "string") return { error: "Each header is passed as a name and a value." };
    if (/[\r\n\0]/.test(value)) return { error: `The value of the header ${name} holds a line break.` };
    if (name.toLowerCase() !== RUN_TURN) headers[name] = value;
  }
  return { headers };
}

const secretsIn = (headers) => [...new Set(Object.values(headers).flatMap((v) => [v, ...v.split(/[\s;,=]+/)]))]
  .filter((s) => s.length >= 8).sort((a, b) => b.length - a.length);
const masked = (text, secrets) => secrets.reduce((t, s) => t.split(s).join("[sign-in]"), text);

const sameRoute = (listed, sent) => {
  const [a, b] = [String(listed).split("?")[0].split("/"), sent.split("/")];
  return a.length === b.length && a.every((part, i) => (/^(?::|\{|\[|\*)/.test(part) ? b[i] !== "" : part === b[i]));
};

export const ADMIN_CONTROL = /(?:^|\/)(?:admin|setup|settings?|configs?|configuration|billing|keys?|tokens?|users?|logout|import|export|uploads?|files?)(?:[-_/]|$|\?)/i;
const SETTINGS_WRITE = /(?:^|[/_-])(?:admin|setup|settings?|configs?|configuration|billing)(?:[-_/]|$|\?)/i;
export async function sendOne(m, app, headers, fetchImpl, secrets = []) {
  const { method, path } = m.request;
  const body = withImages(m.request.body);
  const label = `${m.method} ${m.path}`;

  if (method === "GRPC" && m.method === "GRPC") {
    const started = performance.now();
    const root = app.root ?? process.cwd();
    const out = await grpcCall({ path, body, headers, port: app.port, appDir: app.dir ? join(root, app.dir) : root, root });
    const seconds = `${((performance.now() - started) / 1000).toFixed(1)} seconds`;
    const ok = out.status >= 200 && out.status < 300;
    return { line: `${label}: ${ok ? `answered in ${seconds}` : `${out.status} in ${seconds}: ${out.text.slice(0, 160)}`}`, ok, status: out.status, signedIn: Object.keys(headers).some((k) => /^(?:authorization|cookie)$/i.test(k)) };
  }
  const url = /^\/(?!\/)/.test(String(path)) ? new URL(`${app.origin}${path}`) : null;
  if (url?.origin !== app.origin || !/^(?:GET|POST)$/.test(method)) return { line: `${label}: not sent, its request is not one to this app.`, ok: false, status: 0, unsent: true };
  if (method !== m.method || !sameRoute(m.path, url.pathname)) return { line: `${label}: not sent, the request prepared for it goes to another address.`, ok: false, status: 0, unsent: true };
  if (ADMIN_CONTROL.test(url.pathname) || (method !== "GET" && SETTINGS_WRITE.test(url.pathname))) return { line: `${label}: not sent, its address says it administers your app.`, ok: false, status: 0, unsent: true };
  const json = body !== undefined && method === "POST";
  const typed = Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
  const started = performance.now();
  const seconds = () => `${((performance.now() - started) / 1000).toFixed(1)} seconds`;
  let res;
  try {
    res = await fetchImpl(url, { method, headers: json && !typed ? { "content-type": "application/json", ...headers } : headers,
      ...(json ? { body: JSON.stringify(body) } : {}), redirect: "manual", signal: AbortSignal.timeout(REACH_MS) });
  } catch (err) {
    const code = err?.cause?.code ?? err?.code ?? "";

    const unknown = code === "ECONNRESET" && method !== "GET";
    return { line: `${label}: ${failedSaid(err, app.port || 80)}${unknown ? " It may have reached your app, so Cortad does not send it again by itself." : ""}`, ok: false, status: 0,
      down: !unknown && /^(?:ECONNREFUSED|ECONNRESET)$/.test(code), ...(unknown ? { unknown: true } : {}) };
  }
  let text;
  try { text = await res.text(); } catch { return { line: `${label}: ${res.status}, and the answer had not finished after ${REACH_MS / 1000} seconds.`, ok: false, status: res.status }; }
  const ok = res.status >= 200 && res.status < 300;
  const said = ok ? "" : masked(text || res.headers.get("location") || "", secrets).replace(/\s+/g, " ").trim().slice(0, SAID_CHARS);

  return { line: `${label}: ${res.status} in ${seconds()}.${said ? ` Your app answered: "${said}"` : ""}`, ok, status: res.status, ...(said ? { said } : {}) };
}

const PNG_64 = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAS0lEQVR42u3PMQ0AAAwDoPo33UrYvQQckD4XAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAYHLAMpT0sIcNbcEAAAAAElFTkSuQmCC";
const IMAGE_FIELD = /(?:image|img|photo|picture|screenshot)s?(?:[_-]?(?:base64|b64|data|url|uri|src|file|content))?$/i;
const MIME_FIELD = /^(?:mime|mime_?type|content_?type|media_?type|image_?type)$/i;
const IMAGE_BYTES = [[0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], [0x47, 0x49, 0x46], [0x52, 0x49, 0x46, 0x46]];
const isImage = (v) => {
  const bytes = Buffer.from(v.replace(/^data:image\/[\w.+-]+;base64,/, ""), "base64");
  return IMAGE_BYTES.some((sig) => sig.every((b, i) => bytes[i] === b));
};
export function withImages(value) {
  if (Array.isArray(value)) return value.map(withImages);
  if (!value || typeof value !== "object") return value;
  const out = {};
  let placed = false;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" && IMAGE_FIELD.test(k) && !/^https?:\/\//i.test(v.trim()) && !isImage(v)) {
      out[k] = /url|uri|src/i.test(k) || v.startsWith("data:") ? `data:image/png;base64,${PNG_64}` : PNG_64;
      placed = true;
    } else out[k] = withImages(v);
  }
  if (placed) for (const k of Object.keys(out)) if (MIME_FIELD.test(k) && typeof out[k] === "string") out[k] = "image/png";
  return out;
}

function failedSaid(err, port) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return `no answer within ${REACH_MS / 1000} seconds.`;
  const code = err?.cause?.code ?? err?.code;
  if (code === "ECONNREFUSED") return `nothing answers on port ${port}.`;
  return `the connection failed${/^[A-Z_]{2,40}$/.test(code ?? "") ? ` (${code})` : ""}.`;
}
