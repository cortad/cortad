import { isIPv4 } from "node:net";
import { join } from "node:path";
import { grpcCall } from "./grpc.mjs";
import { unreached } from "./contact-text.mjs";
import { plural, upper } from "./words.mjs";

// One request to each endpoint status lists as not reached, from this machine to the app on its port,
// when the agent asks for it. Each body is the one Cortad read that endpoint's client sending (the
// server's `request`). The connect command sends them up to four at a time, each tagged x-cortad-turn:
// reach:agent:<n> (sendOurs), signed in as the person's own request was where one was seen. Headers
// are never the agent's: they go from here to the app on this machine and nowhere else, and only their
// names are printed. These are real requests with real effects.

// Under the 60 seconds Codex, Cursor CLI and Copilot CLI give an MCP call, with the status read first.
export const REACH_MS = 55_000;
const SAID_CHARS = 200;
const NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
const RUN_TURN = "x-cortad-turn";
const loopback = (host) => host === "::1" || (isIPv4(host) && host.startsWith("127."));
const keyOf = (m) => `${m.method} ${m.path}`;
const appUrl = (runner) => new URL(`http://${runner.host === "::1" ? "[::1]" : runner.host ?? "127.0.0.1"}:${runner.port}`);

// Why nothing can be sent to the app this record names, or null.
export function notUp(runner) {
  if (runner?.state !== "up") {
    return !runner ? "No connect command is running for this repository, so no app is up on this machine. Run npx cortad in this folder as a background command to connect it again."
      : runner.state === "failed" ? upper(runner.error) : "Your app is still starting.";
  }
  const host = runner.host ?? "127.0.0.1";
  return loopback(host) ? null : `${host} is not this machine; reach sends only to your app on this machine.`;
}

// The rows a call sends and the ones it leaves: the named paths, else every row with a ready request
// that is not marked by hand.
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

// `runner`: this machine's record of the app (lib/runner.mjs); `contact`: status's section of the same name.
export async function reach({ runner, contact, headers = {}, paths = [], fetchImpl = fetch }) {
  const down = notUp(runner);
  if (down) return refused(down);
  const sign = headersOf(headers);
  if (sign.error) return refused(sign.error);
  const pick = picked(contact, runner.receipts, paths);
  const app = appUrl(runner);
  const secrets = secretsIn(sign.headers);
  const names = Object.keys(sign.headers);
  // Without a test sign-in the request is Cortad's own, and tagged so.
  let n = 0;
  const headersFor = () => (names.length ? sign.headers : { [RUN_TURN]: `reach:agent:${++n}` });
  const answers = await Promise.all(pick.sent.map((m) => sendOne(m, app, headersFor(), fetchImpl, secrets)));
  return { text: reachText(pick, answers, `${runner.port} at once${names.length ? `, with the headers ${names.join(", ")}` : ""}`) };
}

// What a reach did, for the agent: each endpoint's status and time, and what was not sent.
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

// Cortad's own test requests, sent by the connect command, each with the app's own origin where one is known. An endpoint that answers
// 401 or 403 is asked once more as the test account this machine signed in, when there is one
// (`signIn(row)` gives { name, value } or null); the token never leaves this machine.
// `stop()`: true when the rest should wait, for the agent's ask; the answers so far come back.
// Four at a time: one each in turn left a 22-endpoint app waiting nearly two minutes behind its two
// slowest replies (one customer, 2026-10-06). Answers keep the rows' order; a row is not sent once stop() says so.
// `onAnswer(answer, i)`: called as each row's answer lands, so one slow endpoint holds back no other's.
const AT_ONCE = 4;
// What a browser sends with every request, so an app that answers only its own client answers
// Cortad's test request the same way: the client's origin (lib/origins.mjs), the Sec-Fetch headers
// JavaScript cannot set, and a user agent that says who this is. All of it goes to the app on this machine.
export const browserHeaders = (origin) => ({
  accept: "application/json, text/event-stream;q=0.9, */*;q=0.8",
  "user-agent": "Mozilla/5.0 (compatible; Cortad test request)",
  "sec-fetch-mode": "cors", "sec-fetch-site": "same-site", "sec-fetch-dest": "empty",
  ...(origin ? { origin, referer: `${origin}/` } : {}),
});
// Where an app hands out its CSRF token: the token comes back as a cookie (XSRF-TOKEN, csrftoken,
// _csrf) or as `csrfToken` in a JSON body, and goes back in the header each framework reads.
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
      try { const j = await res.json(); if (typeof j?.csrfToken === "string") token = j.csrfToken; } catch { /* not a token */ }
    }
    if (token) return { "x-xsrf-token": token, "x-csrf-token": token, "x-csrftoken": token, ...(cookies.length ? { cookie: cookies.join("; ") } : {}) };
  }
  return null;
}
const gated = (a) => refusedVisitor(a) || a.status === 419;
// `keys()`: the keys the app's env holds for callers that must carry one (lib/origins.mjs keysFromEnv).
// `mint()` and `account()`: the sign-ins Cortad can make on this machine (lib/sign-in.mjs), tried after the person's own.
// `browser()`: the request the app's own frontend makes, captured in a headless browser (lib/browser-rung.mjs), the last rung.
// `kept()`: the sign-in kept from the last connect; `onSignedIn(as)`: a sign-in that worked, to keep;
// `onKeptRefused()`: the kept one no longer works, to forget.
export async function sendOurs(rows, { runner, origin, signIn = async () => null, kept = async () => null, keys = () => [], mint = async () => null, account = async () => null, browser = async () => null, onSignedIn = () => {}, onKeptRefused = () => {}, next, stop = () => false, onAnswer = () => {}, fetchImpl = fetch, atOnce = AT_ONCE }) {
  const app = appUrl(runner);
  const base = () => ({ ...browserHeaders(origin), [RUN_TURN]: `reach:agent:${next()}` });
  const answers = [];
  let at = 0, stopped = false;
  // The app's own gates, climbed in the order the refusal names them: the CSRF token it hands out,
  // the key its env holds, then the test account this machine signed in. Each climb is one more
  // request to the app on this machine; a gate the words do not name is not guessed at.
  const one = async (m) => {
    let got = await sendOne(m, app, base(), fetchImpl);
    const words = () => String(got.said ?? "");
    if (gated(got) && /csrf|xsrf/i.test(words())) {
      const token = await csrfOf(app, fetchImpl).catch(() => null);
      if (token) { const again = await sendOne(m, app, { ...base(), ...token }, fetchImpl); got = { ...again, line: `${again.line} Sent with the CSRF token your app handed out.` }; }
    }
    if (refusedVisitor(got) && /api[ _-]?key|x-api-key|access code|token/i.test(words())) {
      for (const k of keys()) {
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
    // The sign-in kept from the last connect, before anything is made anew; refused, it is forgotten.
    if (refusedVisitor(got) && !got.signedIn) {
      const as = await kept(m).catch(() => null);
      if (as?.name && as.value) {
        const again = await sendOne(m, app, { ...base(), [as.name]: as.value }, fetchImpl, secretsIn({ [as.name]: as.value }));
        if (!refusedVisitor(again)) got = { ...again, signedIn: true, line: `${again.line} Sent with ${as.how}.` };
        else { onKeptRefused(); got = { ...got, line: `${got.line} ${upper(as.how)} was refused, so it is forgotten.` }; }
      }
    }
    // Then the sign-ins Cortad can make here: a token signed with the app's own secret, then one test
    // account on the app's own doors. One that is refused too is said and leaves the row a visitor's.
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
      try { onAnswer(answers[i], i); } catch { /* the answer stands whatever its listener did */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, rows.length) }, lane));
  // Rows never sent leave no hole: the answers stop where the first unsent row was.
  const end = answers.findIndex((a) => a === undefined);
  return end === -1 ? answers : answers.slice(0, end);
}
export const refusedVisitor = (a) => a.status === 401 || a.status === 403;
// Only a 401 says "sign in"; a 403 is whatever the app's own words say (one customer's was an origin guard
// read as a missing sign-in for a day, 2026-10-24), so it counts as refused, never as a sign-in.
export const needsSignIn = (a) => a.status === 401 && !a.signedIn;

// One line for the terminal per batch: "tested 6 endpoints: 5 answered, 1 needs a signed-in user",
// or null when none reached the app. A row never sent, or cut by a restart and sent again later, is
// no test; one refused as a test account too failed. A batch of one names its endpoint: thirteen
// rounds of "tested 1 endpoint" read as one endpoint tested thirteen times.
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

const whyNot = (m) => m.byHand ?? (m.request ? "Cortad is not sure it reaches your model; name its path to reach to send it." : "Cortad has no request ready for it.");

// The headers as the caller passed them, checked at this edge: never echoed back, a bad one named only
// when its name is a header name, and the run's own header dropped.
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

// What the sign-in is made of, long enough to be a secret, so it is never printed even where the app
// writes it into its answer.
// ponytail: a value the app re-encodes before writing it back (URL or JSON escaping) is not matched.
const secretsIn = (headers) => [...new Set(Object.values(headers).flatMap((v) => [v, ...v.split(/[\s;,=]+/)]))]
  .filter((s) => s.length >= 8).sort((a, b) => b.length - a.length);
const masked = (text, secrets) => secrets.reduce((t, s) => t.split(s).join("[sign-in]"), text);

// Sent only where the address, parsed, is still the app's own, and the listed endpoint's own: a path
// the server sent is never trusted to keep the host, nor to be the endpoint the line names. A request
// listed as POST /api/chat went to another address of the app with the person's sign-in while the
// line printed said /api/chat (the release review of 2026-10-05).
const sameRoute = (listed, sent) => {
  const [a, b] = [String(listed).split("?")[0].split("/"), sent.split("/")];
  return a.length === b.length && a.every((part, i) => (/^(?::|\{|\[|\*)/.test(part) ? b[i] !== "" : part === b[i]));
};
// What a message to a control route does is not a reply. The server never prepares one
// (src/local/unreached.ts sendFor, the same two patterns); the command does not take its word for it.
const ADMIN_CONTROL = /(?:^|\/)(?:admin|setup|settings?|configs?|configuration|billing|keys?|tokens?|users?|logout|import|export|uploads?|files?)(?:[-_/]|$|\?)/i;
const SETTINGS_WRITE = /(?:^|[/_-])(?:admin|setup|settings?|configs?|configuration|billing)(?:[-_/]|$|\?)/i;
export async function sendOne(m, app, headers, fetchImpl, secrets = []) {
  const { method, path } = m.request;
  const body = withImages(m.request.body);
  const label = `${m.method} ${m.path}`;
  // A gRPC door is dialled with the app's own libraries (lib/grpc.mjs), never over HTTP.
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
    // Refused, nothing reached the app, and a GET cut off changes nothing: both are sent again
    // (`down`). A POST whose connection was reset may have been taken by the app before it went, so
    // it is an answer nobody saw (`unknown`) and is never sent again by itself.
    const unknown = code === "ECONNRESET" && method !== "GET";
    return { line: `${label}: ${failedSaid(err, app.port || 80)}${unknown ? " It may have reached your app, so Cortad does not send it again by itself." : ""}`, ok: false, status: 0,
      down: !unknown && /^(?:ECONNREFUSED|ECONNRESET)$/.test(code), ...(unknown ? { unknown: true } : {}) };
  }
  let text;
  try { text = await res.text(); } catch { return { line: `${label}: ${res.status}, and the answer had not finished after ${REACH_MS / 1000} seconds.`, ok: false, status: res.status }; }
  const ok = res.status >= 200 && res.status < 300;
  const said = ok ? "" : masked(text || res.headers.get("location") || "", secrets).replace(/\s+/g, " ").trim().slice(0, SAID_CHARS);
  // `said` travels to the server with the status: a 403 is the app's own gate (an origin check, a
  // bot guard) as often as a sign-in, and only the app's words tell the agent which.
  return { line: `${label}: ${res.status} in ${seconds()}.${said ? ` Your app answered: "${said}"` : ""}`, ok, status: res.status, ...(said ? { said } : {}) };
}

// A real 64x64 PNG where the request carries an image and the server sent none: a made-up string in
// an image field is refused by the app before its model sees it. The same rule as the server's
// (src/local/unreached.ts withImages); a link, or an image already, stays.
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

// Why a request got no answer, from the error's name and code alone: its message can quote a header.
function failedSaid(err, port) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return `no answer within ${REACH_MS / 1000} seconds.`;
  const code = err?.cause?.code ?? err?.code;
  if (code === "ECONNREFUSED") return `nothing answers on port ${port}.`;
  return `the connection failed${/^[A-Z_]{2,40}$/.test(code ?? "") ? ` (${code})` : ""}.`;
}
