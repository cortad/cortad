import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendOurs } from "./reach.mjs";
import { clientOriginOf, keysFromEnv } from "./origins.mjs";

// The gates an app puts in front of its own endpoints, each as a small app of its own, so the way
// Cortad's test request climbs them is a test here and not a lesson learned from a customer.

const serve = async (handle) => {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    handle(req, res, body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: server.address().port };
};
const json = (res, status, obj, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
const row = (port) => ({ method: "POST", path: "/api/chat", file: null, line: null, request: { method: "POST", path: "/api/chat", body: { message: "hi" } } });
const send = (port, extra = {}) => { let n = 0; return sendOurs([row(port)], { runner: { host: "127.0.0.1", port }, origin: "http://localhost:5173", next: () => ++n, ...extra }); };

test("an app that answers only its own client answers a test request sent the way that client sends it", async () => {
  const seen = [];
  const { server, port } = await serve((req, res) => {
    seen.push(req.headers);
    const origin = req.headers.origin;
    if (origin !== "http://localhost:5173" || req.headers["sec-fetch-mode"] !== "cors") return json(res, 403, { success: false, message: "Direct API access is not permitted." });
    json(res, 200, { reply: "hello" });
  });
  try {
    const [a] = await send(port);
    assert.equal(a.status, 200, a.line);
    assert.equal(seen.length, 1, "passed at the first request: no second try was needed");
    assert.equal(seen[0].referer, "http://localhost:5173/");
    assert.match(seen[0]["user-agent"], /^Mozilla\/5\.0 .*Cortad/);
  } finally { server.close(); }
});

test("a CSRF gate is climbed with the token the app hands out, as a cookie or as csrfToken", async () => {
  const hits = [];
  const { server, port } = await serve((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.method === "GET" && req.url === "/sanctum/csrf-cookie") { res.writeHead(204, { "set-cookie": ["XSRF-TOKEN=t0k3n; Path=/", "session=abc; Path=/; HttpOnly"] }); res.end(); return; }
    if (req.method === "GET") return json(res, 404, { error: "no" });
    if (req.headers["x-xsrf-token"] !== "t0k3n" || !/session=abc/.test(req.headers.cookie ?? "")) return json(res, 419, { message: "CSRF token mismatch." });
    json(res, 200, { reply: "ok" });
  });
  try {
    const [a] = await send(port);
    assert.equal(a.status, 200, a.line);
    assert.match(a.line, /Sent with the CSRF token your app handed out\./);
    assert.deepEqual(hits, ["POST /api/chat", "GET /api/auth/csrf", "GET /sanctum/csrf-cookie", "POST /api/chat"], "the token doors are tried in order and the request is sent again once");
  } finally { server.close(); }
});

test("an app that wants its own key gets the one its env holds, and a key the words do not ask for is never sent", async () => {
  const { server, port } = await serve((req, res) => {
    if (req.headers["x-api-key"] === "k-1") return json(res, 200, { reply: "ok" });
    json(res, 401, { error: "missing api key" });
  });
  const keys = () => [{ name: "API_KEY", header: "x-api-key", value: "k-1" }, { name: "API_KEY", header: "authorization", value: "Bearer k-1" }];
  try {
    const [a] = await send(port, { keys });
    assert.equal(a.status, 200, a.line);
    assert.match(a.line, /Sent with API_KEY from your env\./);
    assert.doesNotMatch(a.line, /k-1/, "the key's value is never printed");
    const { server: quiet, port: p2 } = await serve((req, res) => json(res, 403, { error: "Direct API access is not permitted." }));
    try {
      const [b] = await send(p2, { keys });
      assert.equal(b.status, 403);
      assert.doesNotMatch(b.line, /from your env/, "a refusal that names no key is not answered with one");
    } finally { quiet.close(); }
  } finally { server.close(); }
});

test("the client origin is read from the code beside its CORS words, the app's own port left out, and the env's keys are named", () => {
  const root = mkdtempSync(join(tmpdir(), "cortad-origins-"));
  mkdirSync(join(root, "src", "middleware"), { recursive: true });
  mkdirSync(join(root, "node_modules", "x"), { recursive: true });
  writeFileSync(join(root, "src", "middleware", "cors.ts"), "const DEV_ORIGINS = ['http://localhost:5174', 'http://localhost:4174'];\nexport const ALLOWED_ORIGINS = [...DEV_ORIGINS];\n");
  writeFileSync(join(root, "src", "index.ts"), "app.listen(3100); // http://localhost:3100\nconst docs = 'http://localhost:3000/docs';\n");
  writeFileSync(join(root, "node_modules", "x", "index.js"), "fetch('http://localhost:9999')");
  writeFileSync(join(root, ".env"), "API_KEY=abc123\nOPENAI_API_KEY=sk-live-never\nPORT=3100\n");
  assert.equal(clientOriginOf(root, { port: 3100 }), "http://localhost:5174");
  assert.deepEqual(keysFromEnv(root).map((k) => `${k.name} ${k.header}`), ["API_KEY x-api-key", "API_KEY authorization"], "a provider's key is never offered as the app's own");
  writeFileSync(join(root, ".env.local"), "FRONTEND_URL=http://localhost:8721\n");
  assert.equal(clientOriginOf(root, { port: 3100 }), "http://localhost:8721", "the env's own word wins");
});

test("an endpoint that wants a bearer token gets one signed with the app's own secret from its env, and nothing is signed without one", async () => {
  const { mintJwt } = await import("./sign-in.mjs");
  const { createHmac } = await import("node:crypto");
  const secret = "s3cret-s3cret-s3cret";
  const { server, port } = await serve((req, res) => {
    const m = /^Bearer (.+)\.(.+)\.(.+)$/.exec(req.headers.authorization ?? "");
    const ok = m && createHmac("sha256", secret).update(`${m[1]}.${m[2]}`).digest("base64url") === m[3] && JSON.parse(Buffer.from(m[2], "base64url")).sub === "cortad-test";
    if (!ok) return json(res, 401, { error: "unauthorized: missing or invalid token" }, { "www-authenticate": "Bearer" });
    json(res, 200, { reply: "ok" });
  });
  try {
    const [a] = await send(port, { mint: async () => mintJwt({ JWT_SECRET: secret }) });
    assert.equal(a.status, 200, a.line);
    assert.match(a.line, /Sent with a token signed with JWT_SECRET from your env\./);
    assert.ok(a.signedIn);
    assert.equal(mintJwt({ OPENAI_API_KEY: "sk-x" }), null, "no secret named for signing, no token");
    const [b] = await send(port, { mint: async () => mintJwt({ JWT_SECRET: "wrong-wrong-wrong" }) });
    assert.equal(b.status, 401);
    assert.match(b.line, /A token signed with JWT_SECRET from your env was refused too\./);
    assert.ok(!b.signedIn, "a token the app refused leaves the row a visitor's, so the agent is still asked for an account");
  } finally { server.close(); }
});

test("one test account is made on the app's own sign-up door, signed in on its sign-in door, and kept for the next connect", async () => {
  const { signUpAndIn, testAccount } = await import("./sign-in.mjs");
  const users = new Map();
  const { server, port } = await serve((req, res, body) => {
    const data = body ? JSON.parse(body) : {};
    if (req.url === "/api/auth/register") { if (users.has(data.email)) return json(res, 409, { error: "exists" }); if (!data.password || !data.name) return json(res, 400, { error: "fields" }); users.set(data.email, data.password); return json(res, 201, { ok: true }); }
    if (req.url === "/api/auth/login") { if (users.get(data.email) !== data.password) return json(res, 401, { error: "bad credentials" }); return json(res, 200, { user: { id: 1 }, session: { access_token: `tok-${data.email}` } }); }
    if (req.headers.authorization?.startsWith("Bearer tok-cortad-test-")) return json(res, 200, { reply: "ok" });
    json(res, 401, { error: "sign in first" });
  });
  const home = mkdtempSync(join(tmpdir(), "cortad-account-"));
  const auth = { signup: { method: "POST", path: "/api/auth/register", fields: ["email", "password", "name", "acceptTerms"] }, login: { method: "POST", path: "/api/auth/login", fields: ["email", "password"] } };
  try {
    const account = () => signUpAndIn({ origin: `http://127.0.0.1:${port}` }, auth, testAccount(home));
    const [a] = await send(port, { account });
    assert.equal(a.status, 200, a.line);
    assert.match(a.line, /Sent with signed in as the test account Cortad made on your app \(cortad-test-[0-9a-f]{8}@example\.com\)\./);
    assert.equal(users.size, 1);
    const [b] = await send(port, { account });
    assert.equal(b.status, 200, b.line);
    assert.equal(users.size, 1, "the second connect signs the same account in; it makes no second one");
    assert.equal(testAccount(home).email, [...users.keys()][0]);
    assert.equal(await signUpAndIn({ origin: `http://127.0.0.1:${port}` }, {}, testAccount(home)), null, "no doors, no account");
  } finally { server.close(); }
});
