import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { selected } from "../contract.mjs";
import { chats } from "./chats.fixture.mjs";
import { proposeDatabase, readDatabase } from "./index.mjs";

// Each store read for real: a container or emulator seeded with a chat app's history, then read the
// way `intelligence history` reads it, and checked against what --stdin would send for the same
// history. Each store's address comes from its CORTAD_DB_* variable, one container at a time; a
// test whose store is not set says so and skips. CORTAD_DB_FIXTURE: a folder with the drivers an app would install.
const FIXTURE = process.env.CORTAD_DB_FIXTURE;
const DAY = 86_400_000;
export const NOW = Date.now();
const SINCE = NOW - 30 * DAY;
const need = FIXTURE ? createRequire(join(FIXTURE, "package.json")) : null;

// The newest conversations whole until `cap` of their users' messages, stopping at the first that does not fit.
export function expected(all, cap) {
  const recent = all.map((c) => ({ ...c, messages: c.messages.filter((m) => m.role === "user" || m.role === "assistant") }))
    .map((c) => ({ ...c, last: Math.max(...c.messages.map((m) => m.at)) })).filter((c) => c.last >= SINCE).sort((a, b) => b.last - a.last);
  const out = [];
  let room = cap;
  for (const c of recent) {
    const asks = c.messages.filter((m) => m.role === "user").length;
    if (asks > room) break;
    room -= asks;
    out.push(c);
  }
  return out;
}

const sent = (conversations, cap, exclude = []) => selected(conversations.map((c) => ({ ...c, messages: c.messages.map((m) => ({ ...m, at: typeof m.at === "number" ? new Date(m.at).toISOString() : m.at })) })), { salt: "5".repeat(64), cap, now: NOW, exclude }).conversations;

// The way the command reads: discovery proposes a store and places from their names, then only the
// places of its first choice are read, as the person's yes runs them.
export async function proposedRead({ root, env, flags = {}, cap, exclude = [] }) {
  const found = await proposeDatabase({ root, env, flags });
  assert.ok(found.proposal, `nothing was proposed: ${JSON.stringify(found)}`);
  const [top] = found.proposal.choices;
  const place = [...top.places, ...(top.users ? [top.users] : [])].join(",");
  return readDatabase({ root, env, flags: { ...flags, store: found.proposal.kind, place }, cap, since: SINCE, exclude });
}

// Read from each fixture app in turn: Node drivers, then the app's Python where the store has a path there.
// `exclude`: texts Cortad sent; `all` holds only the users' conversations, the store Cortad's too.
export async function readAndCheck({ env, all, cap, flags = {}, users = true, python = false, exclude = [] }) {
  let read;
  for (const root of [FIXTURE, ...(python ? [process.env.CORTAD_DB_PYFIXTURE, process.env.CORTAD_DB_ALTFIXTURE] : [])].filter(Boolean)) read = await readOnce({ root, env, all, cap, flags, users, exclude });
  return read;
}

async function readOnce({ root, env, all, cap, flags, users, exclude }) {
  const read = await proposedRead({ root, env, flags, cap, exclude });
  assert.ok(read.conversations, `nothing was read: ${JSON.stringify(read)}`);
  const want = sent(expected(all, cap), cap);
  const got = sent(read.conversations, cap, exclude);
  const places = read.place.split(", ").length;
  // Places read side by side reach past the cut, so the room left after it may take an older short one.
  assert.ok(got.length === want.length || (places > 1 && got.length > want.length), `${got.length} sent for ${want.length}`);
  assert.deepEqual(got.slice(0, want.length).map((c) => c.id), want.map((c) => c.id), "the newest whole conversations, in order");
  const strip = (list) => list.slice(0, want.length).map((c) => (users ? c : { ...c, user: undefined }));
  assert.deepEqual(strip(got), strip(want), "every message with its role, text and time");
  const ours = read.conversations.length - sent(read.conversations, 1e9, exclude).length;
  assert.ok(places > 1 || read.conversations.length - ours <= want.length + 1, `${root}: read ${read.conversations.length} conversations for ${want.length}`);
  return read;
}

export const skipUnless = (name) => (!FIXTURE || !process.env[name] ? `set ${name} and CORTAD_DB_FIXTURE (lib/history/db/live.sh)` : false);
export { FIXTURE, need, chats, SINCE };

const ts = (ms) => new Date(ms).toISOString();

test("Postgres: messages beside their chats, users from the chat table, parts in JSON, times with no zone", { skip: skipUnless("CORTAD_DB_POSTGRES") }, async () => {
  const { Client } = need("pg");
  const admin = new Client({ connectionString: process.env.CORTAD_DB_POSTGRES });
  await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS shop WITH (FORCE)");
  await admin.query("CREATE DATABASE shop");
  await admin.end();
  const url = process.env.CORTAD_DB_POSTGRES.replace(/\/[^/]*$/, "/shop");
  const db = new Client({ connectionString: url });
  await db.connect();
  await db.query(`CREATE TABLE "User" (id text PRIMARY KEY, email text);
    CREATE TABLE "Chat" (id text PRIMARY KEY, "userId" text REFERENCES "User"(id), title text, "createdAt" timestamp NOT NULL);
    CREATE TABLE "Message_v2" (id serial PRIMARY KEY, "chatId" text REFERENCES "Chat"(id), role text NOT NULL, parts json NOT NULL, attachments json, "createdAt" timestamp NOT NULL);
    CREATE TABLE "Product" (id serial PRIMARY KEY, name text, description text, "createdAt" timestamptz)`);
  const all = chats({ now: NOW });
  for (const u of new Set(all.map((c) => c.user))) await db.query(`INSERT INTO "User" VALUES ($1, $2)`, [u, `${u}@example.com`]);
  for (const c of all) {
    await db.query(`INSERT INTO "Chat" VALUES ($1, $2, 'A chat', $3::timestamptz AT TIME ZONE 'UTC')`, [c.id, c.user, ts(c.messages[0].at)]);
    for (const m of c.messages) {
      await db.query(`INSERT INTO "Message_v2" ("chatId", role, parts, attachments, "createdAt") VALUES ($1, $2, $3, '[]', $4::timestamptz AT TIME ZONE 'UTC')`, [c.id, m.role, JSON.stringify([{ type: "text", text: m.text }]), ts(m.at)]);
    }
  }
  const snapshot = async () => (await db.query(`SELECT md5(string_agg(m::text, ',' ORDER BY m.id)) AS h, (SELECT count(*) FROM "Chat") AS c FROM "Message_v2" m`)).rows[0];
  const before = await snapshot();
  for (const cap of [40, 2_500]) {
    const read = await readAndCheck({ env: { DATABASE_URL: url }, all, cap, python: true });
    assert.equal(read.place, "Message_v2");
    assert.equal(read.store.host, "127.0.0.1");
  }
  assert.deepEqual(await snapshot(), before, "nothing was written");
  await db.end();
});

const waitFor = async (try_, ms = 90_000) => {
  const until = Date.now() + ms;
  for (;;) {
    try { return await try_(); } catch (error) { if (Date.now() > until) throw error; await new Promise((r) => { setTimeout(r, 1_000); }); }
  }
};
const numbered = (all) => all.map((c, i) => ({ ...c, id: String(i + 1) }));
const mysqlTime = (ms) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");

test("MySQL and MariaDB: numbered conversations, a sender column with bot and user, DATETIME in UTC", { skip: skipUnless("CORTAD_DB_MYSQL") }, async () => {
  const mysql = need("mysql2/promise");
  const url = new URL(process.env.CORTAD_DB_MYSQL);
  const db = await waitFor(() => mysql.createConnection({ host: url.hostname, port: Number(url.port), user: "root", password: decodeURIComponent(url.password), multipleStatements: true, timezone: "Z" }));
  await db.query("DROP DATABASE IF EXISTS shop; CREATE DATABASE shop CHARACTER SET utf8mb4; USE shop");
  await db.query(`CREATE TABLE conversations (id BIGINT PRIMARY KEY, user_id VARCHAR(64), title VARCHAR(200), created_at DATETIME(3));
    CREATE TABLE messages (id BIGINT AUTO_INCREMENT PRIMARY KEY, conversation_id BIGINT, sender VARCHAR(16), body TEXT, created_at DATETIME(3), INDEX (created_at));
    CREATE TABLE orders (id BIGINT PRIMARY KEY, total DECIMAL(10,2), created_at DATETIME)`);
  const all = numbered(chats({ now: NOW, seed: 11 }));
  for (const c of all) {
    await db.query("INSERT INTO conversations VALUES (?, ?, 'Chat', ?)", [Number(c.id), c.user, mysqlTime(c.messages[0].at)]);
    for (const m of c.messages) await db.query("INSERT INTO messages (conversation_id, sender, body, created_at) VALUES (?, ?, ?, ?)", [Number(c.id), m.role === "assistant" ? "bot" : m.role, m.text, mysqlTime(m.at)]);
  }
  const snapshot = async () => (await db.query("CHECKSUM TABLE messages, conversations"))[0];
  const before = await snapshot();
  url.pathname = "/shop";
  for (const cap of [40, 2_500]) {
    const read = await readAndCheck({ env: { DATABASE_URL: url.toString() }, all, cap, python: true });
    assert.equal(read.place, "messages");
  }
  assert.deepEqual(await snapshot(), before, "nothing was written");
  await db.end();
});

test("SQL Server: sessions keyed by GUID, a Role and a Content column, datetimeoffset times", { skip: skipUnless("CORTAD_DB_MSSQL") }, async () => {
  const mssql = need("mssql");
  const { randomUUID } = await import("node:crypto");
  const url = new URL(process.env.CORTAD_DB_MSSQL);
  const config = { server: url.hostname, port: Number(url.port), user: "sa", password: decodeURIComponent(url.password), options: { encrypt: true, trustServerCertificate: true } };
  const admin = await waitFor(() => new mssql.ConnectionPool({ ...config, database: "master" }).connect());
  await admin.request().batch("IF DB_ID('shop') IS NOT NULL BEGIN ALTER DATABASE shop SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE shop; END; CREATE DATABASE shop;");
  await admin.close();
  const db = await new mssql.ConnectionPool({ ...config, database: "shop" }).connect();
  await db.request().batch(`CREATE TABLE ChatSessions (Id UNIQUEIDENTIFIER PRIMARY KEY, UserId NVARCHAR(64), CreatedAt DATETIME2);
    CREATE TABLE ChatMessages (Id INT IDENTITY PRIMARY KEY, SessionId UNIQUEIDENTIFIER, Role NVARCHAR(16), Content NVARCHAR(MAX), CreatedAt DATETIMEOFFSET);
    CREATE TABLE Invoices (Id INT PRIMARY KEY, Amount MONEY, CreatedAt DATETIME2);`);
  const all = chats({ now: NOW, seed: 13 }).map((c) => ({ ...c, id: randomUUID() }));
  for (const c of all) {
    await db.request().input("id", mssql.UniqueIdentifier, c.id).input("u", c.user).input("at", mssql.DateTime2, new Date(c.messages[0].at)).query("INSERT INTO ChatSessions VALUES (@id, @u, @at)");
    for (const m of c.messages) {
      await db.request().input("s", mssql.UniqueIdentifier, c.id).input("r", m.role).input("c", m.text).input("at", mssql.DateTimeOffset, new Date(m.at)).query("INSERT INTO ChatMessages (SessionId, Role, Content, CreatedAt) VALUES (@s, @r, @c, @at)");
    }
  }
  const snapshot = async () => (await db.request().query("SELECT CHECKSUM_AGG(CHECKSUM(*)) AS h, COUNT(*) AS n FROM ChatMessages")).recordset[0];
  const before = await snapshot();
  const env = { SQLSERVER_URL: `sqlserver://${url.host};database=shop;user=sa;password=${decodeURIComponent(url.password)};encrypt=true` };
  for (const cap of [40, 2_500]) {
    const read = await readAndCheck({ env, all, cap, python: true });
    assert.equal(read.place, "ChatMessages");
  }
  assert.deepEqual(await snapshot(), before, "nothing was written");
  await db.close();
});

test("SQLite: a Prisma file next to its schema, turns of question and answer, times as epoch seconds", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync, mkdirSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "cortad-sqlite-"));
  mkdirSync(join(root, "prisma"));
  const file = join(root, "prisma", "dev.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE chat_logs (id INTEGER PRIMARY KEY, session_id TEXT, user_id TEXT, question TEXT, answer TEXT, created_at INTEGER); CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
  const all = chats({ now: NOW, seed: 17 });
  const insert = db.prepare("INSERT INTO chat_logs (session_id, user_id, question, answer, created_at) VALUES (?, ?, ?, ?, ?)");
  // A turn keeps the second of the question: its answer is read one millisecond after it.
  const turns = all.map((c) => {
    const pairs = [];
    const said = c.messages.filter((m) => m.role === "user" || m.role === "assistant");
    for (let i = 0; i + 1 < said.length; i += 2) {
      const at = Math.floor(said[i].at / 1000) * 1000;
      pairs.push({ question: said[i].text, answer: said[i + 1].text, at });
      insert.run(c.id, c.user, said[i].text, said[i + 1].text, at / 1000);
    }
    return { ...c, messages: pairs.flatMap((p) => [{ role: "user", text: p.question, at: p.at }, { role: "assistant", text: p.answer, at: p.at + 1 }]) };
  });
  db.close();
  const before = readFileSync(file);
  for (const cap of [40, 2_500]) {
    const got = await proposedRead({ root, env: { DATABASE_URL: "file:./dev.db" }, cap });
    assert.equal(got.place, "chat_logs");
    assert.equal(got.store.host, join("prisma", "dev.db"));
    assert.deepEqual(sent(got.conversations, cap), sent(expected(turns, cap), cap));
  }
  assert.ok(readFileSync(file).equals(before), "nothing was written");
});

// A message's time as an app writes it in its own zone: the same instant, written +03:00.
const riyadh = (ms) => new Date(ms + 3 * 3_600_000).toISOString().replace("Z", "+03:00");

test("libSQL (Turso): threads holding their messages as JSON text, times in +03:00, read with the auth token", { skip: skipUnless("CORTAD_DB_LIBSQL") }, async () => {
  const base = process.env.CORTAD_DB_LIBSQL;
  const token = process.env.CORTAD_DB_LIBSQL_TOKEN;
  const run = async (statements) => {
    const res = await fetch(`${base}/v2/pipeline`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ requests: [...statements.map(([sql, args = []]) => ({ type: "execute", stmt: { sql, args: args.map((v) => ({ type: "text", value: String(v) })) } })), { type: "close" }] }) });
    const body = await res.json();
    for (const r of body.results) if (r.type !== "ok") throw new Error(JSON.stringify(r));
    return body.results;
  };
  await run([["DROP TABLE IF EXISTS threads"], ["DROP TABLE IF EXISTS settings"], ["CREATE TABLE threads (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, messages TEXT, updated_at TEXT)"], ["CREATE TABLE settings (key TEXT, value TEXT)"]]);
  const all = chats({ now: NOW, seed: 19 });
  await run(all.map((c) => ["INSERT INTO threads VALUES (?, ?, 'Chat', ?, ?)", [c.id, c.user, JSON.stringify(c.messages.map((m) => ({ role: m.role, content: m.text, createdAt: riyadh(m.at) }))), riyadh(c.messages.at(-1).at)]]));
  const snapshot = async () => JSON.stringify((await run([["SELECT group_concat(id || messages || updated_at) FROM threads"]]))[0].response.result.rows);
  const before = await snapshot();
  for (const cap of [40, 2_500]) {
    const read = await readAndCheck({ env: { TURSO_DATABASE_URL: base, TURSO_AUTH_TOKEN: token }, all, cap });
    assert.equal(read.place, "threads");
    assert.equal(read.store.label, "libSQL");
  }
  assert.equal(await snapshot(), before, "nothing was written");
  await assert.rejects(proposeDatabase({ root: FIXTURE, env: { TURSO_DATABASE_URL: base } }).then((r) => { throw new Error(r.tried[0].why); }), /refused the token/);
});

test("MongoDB: conversation documents holding their messages, ObjectId ids, the database found with none named", { skip: skipUnless("CORTAD_DB_MONGO") }, async () => {
  const { MongoClient, ObjectId } = need("mongodb");
  const client = await new MongoClient(process.env.CORTAD_DB_MONGO).connect();
  const db = client.db("tutor");
  await db.dropDatabase();
  await client.db("chat").dropDatabase();
  const all = chats({ now: NOW, seed: 23 }).map((c) => ({ ...c, id: new ObjectId().toHexString() }));
  await db.collection("conversations").insertMany(all.map((c) => ({
    _id: new ObjectId(c.id), userId: c.user, title: "Chat", createdAt: new Date(c.messages[0].at), updatedAt: new Date(c.messages.at(-1).at),
    messages: c.messages.map((m) => ({ role: m.role, content: m.role === "assistant" ? [{ type: "text", text: m.text }] : m.text, createdAt: new Date(m.at) })),
  })));
  await db.collection("users").insertMany([...new Set(all.map((c) => c.user))].map((u) => ({ _id: u, email: `${u}@example.com` })));
  const snapshot = async () => JSON.stringify(await db.collection("conversations").find().sort({ _id: 1 }).toArray());
  const before = await snapshot();
  for (const cap of [40, 2_500]) {
    const read = await readAndCheck({ env: { MONGODB_URI: process.env.CORTAD_DB_MONGO }, all, cap, python: true });
    assert.equal(read.place, "conversations");
  }
  assert.equal(await snapshot(), before, "nothing was written");
  await client.close();
});

test("MongoDB: one message per document, a flag for who wrote it, the database named in the address", { skip: skipUnless("CORTAD_DB_MONGO") }, async () => {
  const { MongoClient } = need("mongodb");
  const client = await new MongoClient(process.env.CORTAD_DB_MONGO).connect();
  const db = client.db("chat");
  await db.dropDatabase();
  const all = chats({ now: NOW, seed: 29 });
  await db.collection("messages").insertMany(all.flatMap((c) => c.messages.filter((m) => m.role !== "tool").map((m) => ({
    conversationId: c.id, user: c.user, sender: m.role === "user" ? "User" : m.role === "system" ? "system" : "GPT-4o", isCreatedByUser: m.role === "user", text: m.text, createdAt: new Date(m.at),
    ...(m.role === "system" ? { isCreatedByUser: undefined } : {}),
  }))));
  await db.collection("messages").createIndex({ createdAt: -1 });
  await db.collection("presets").insertOne({ title: "Default", createdAt: new Date() });
  const count = await db.collection("messages").countDocuments();
  for (const cap of [40, 2_500]) {
    const read = await readAndCheck({ env: { MONGO_URL: `${process.env.CORTAD_DB_MONGO.replace(/\/$/, "")}/chat` }, all, cap, python: true });
    assert.equal(read.place, "messages");
  }
  assert.equal(await db.collection("messages").countDocuments(), count);
  await db.dropDatabase();
  await client.close();
});

test("Redis: a hash per chat with its messages as JSON, beside cache keys; and lists of messages read through Upstash's REST API", { skip: skipUnless("CORTAD_DB_REDIS") }, async () => {
  const Redis = need("ioredis");
  const r = new Redis(process.env.CORTAD_DB_REDIS);
  await r.flushall();
  const all = chats({ now: NOW, seed: 31 });
  for (const c of all) {
    await r.hset(`chat:${c.id}`, { id: c.id, title: "Chat", userId: c.user, createdAt: String(c.messages[0].at), path: `/chat/${c.id}`,
      messages: JSON.stringify(c.messages.map((m) => ({ role: m.role, content: m.text, createdAt: new Date(m.at).toISOString() }))) });
    await r.zadd(`user:chat:${c.user}`, c.messages[0].at, `chat:${c.id}`);
  }
  for (let i = 0; i < 300; i += 1) await r.set(`ratelimit:${i}`, "3");
  const snapshot = async () => JSON.stringify(await Promise.all((await r.keys("*")).sort().map(async (k) => [k, await r.type(k) === "hash" ? Object.entries(await r.hgetall(k)).sort() : null])));
  const before = await snapshot();
  for (const cap of [40, 2_500]) {
    const read = await readAndCheck({ env: { REDIS_URL: process.env.CORTAD_DB_REDIS }, all, cap, python: true });
    assert.equal(read.place, "chat:*");
  }
  assert.equal(await snapshot(), before, "nothing was written");

  if (process.env.CORTAD_DB_UPSTASH) {
    await r.flushall();
    const lists = chats({ now: NOW, seed: 37 }).map((c) => ({ ...c, id: `${c.id}-${c.user}` }));
    for (const c of lists) await r.rpush(`history:${c.id}`, ...c.messages.map((m) => JSON.stringify({ role: m.role, content: m.text, timestamp: m.at })));
    const [address, token] = process.env.CORTAD_DB_UPSTASH.split("#");
    for (const cap of [40, 2_500]) {
      const read = await readAndCheck({ env: { UPSTASH_REDIS_REST_URL: address, UPSTASH_REDIS_REST_TOKEN: token }, all: lists.map((c) => ({ ...c, user: undefined })), cap, users: false });
      assert.equal(read.store.label, "Upstash Redis");
    }
  }
  await r.flushall();
  r.disconnect();
});

test("Qdrant: a message per point beside a document corpus, scrolled with a keyword time, then newest first once the time has a datetime index", { skip: skipUnless("CORTAD_DB_QDRANT") }, async () => {
  const [base, key] = process.env.CORTAD_DB_QDRANT.split("#");
  const q = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { "api-key": key, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok && res.status !== 404) throw new Error(`${path} ${res.status} ${await res.text()}`);
    return res.json();
  };
  for (const { name } of (await q("GET", "/collections")).result.collections) await q("DELETE", `/collections/${name}`);
  for (const c of ["chat_history", "docs"]) await q("PUT", `/collections/${c}`, { vectors: { size: 4, distance: "Cosine" } });
  const all = chats({ now: NOW, seed: 41 });
  const points = all.flatMap((c) => c.messages.map((m) => ({ session_id: c.id, user_id: c.user, role: m.role, content: m.text, timestamp: new Date(m.at).toISOString() }))).map((payload, id) => ({ id, vector: [0.1, 0.2, 0.3, 0.4], payload }));
  await q("PUT", "/collections/chat_history/points?wait=true", { points });
  await q("PUT", "/collections/docs/points?wait=true", { points: [{ id: 1, vector: [1, 0, 0, 0], payload: { text: "Returns are accepted within 30 days.", source: "policy.md" } }] });
  const env = { QDRANT_URL: base, QDRANT_API_KEY: key };
  const count = async () => (await q("POST", "/collections/chat_history/points/count", { exact: true })).result.count;
  for (const cap of [40, 2_500]) assert.equal((await readAndCheck({ env, all, cap })).place, "chat_history");
  await q("PUT", "/collections/chat_history/index?wait=true", { field_name: "timestamp", field_schema: "datetime" });
  for (const cap of [40, 2_500]) assert.equal((await readAndCheck({ env, all, cap })).place, "chat_history");
  assert.equal(await count(), points.length, "nothing was written");
  await assert.rejects(proposeDatabase({ root: FIXTURE, env: { QDRANT_URL: base } }).then((r) => { throw new Error(r.tried[0].why); }), /refused the Qdrant key/);
});

// A school app's Qdrant: each country's chats in its own collection, beside 139 textbook collections
// whose names say "history", and the developer's own long sessions with Cortad's test message. The
// textbooks were chosen, then one country's chats were left out, then the developer's sessions sent.
test("Qdrant: every collection shaped as a chat is read, a textbook never wins, and Cortad's own sessions stay out", { skip: skipUnless("CORTAD_DB_QDRANT") }, async () => {
  const [base, key] = process.env.CORTAD_DB_QDRANT.split("#");
  const q = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { "api-key": key, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok && res.status !== 404) throw new Error(`${path} ${res.status} ${await res.text()}`);
    return res.json();
  };
  for (const { name } of (await q("GET", "/collections")).result.collections) await q("DELETE", `/collections/${name}`);
  const vector = [0.1, 0.2, 0.3, 0.4];
  const books = Array.from({ length: 139 }, (_, i) => `${["jordan", "iraq", "egypt"][i % 3]}_grade-${1 + (i % 12)}_sem-${1 + (i % 2)}_${["history", "chat_skills", "messages_and_letters", "conversation_arabic"][i % 4]}_${["academic", "vocational"][i % 2]}_${i}`);
  for (const name of [...books, "chat_history", "iraq_chat_history"]) await q("PUT", `/collections/${name}`, { vectors: { size: 4, distance: "Cosine" } });
  for (const [n, name] of books.entries()) {
    const chunks = Array.from({ length: 30 }, (_, i) => ({ id: i, vector, payload: { text: `Lesson ${i}: the Abbasid caliphate and its trade routes.`, docId: `book-${n}`, page: i, chunkType: i % 5 ? "paragraph" : "heading", source: "textbook.pdf", createdAt: new Date(NOW - i * 60_000).toISOString() } }));
    await q("PUT", `/collections/${name}/points?wait=true`, { points: chunks });
  }
  const jordan = chats({ now: NOW, seed: 51 });
  const iraq = chats({ now: NOW, seed: 52 }).map((c) => ({ ...c, id: `iq-${c.id}`, user: `iq-${c.user}` }));
  const session = (id, first, replies, ago) => ({ id, user: "dev", messages: Array.from({ length: replies * 2 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: i ? `step ${i}` : first, at: NOW - ago + i * 1_000 })) });
  const mine = [session("dev-1", "Hi. What can you help me with?", 260, 3_600_000), session("dev-2", "Hi. What can you help me with?", 180, 7_200_000)];
  const simulated = session("sim-1", "My son failed the grade 12 history exam, what now?", 6, 1_800_000);
  const pointsOf = (list) => list.flatMap((c) => c.messages.map((m) => ({ userId: c.user, sessionId: c.id, role: m.role, content: m.text, timestamp: new Date(m.at).toISOString() }))).map((payload, id) => ({ id, vector, payload }));
  await q("PUT", "/collections/chat_history/points?wait=true", { points: pointsOf([...jordan, ...mine, simulated]) });
  await q("PUT", "/collections/iraq_chat_history/points?wait=true", { points: pointsOf(iraq) });
  for (const name of ["chat_history", "iraq_chat_history"]) await q("PUT", `/collections/${name}/index?wait=true`, { field_name: "timestamp", field_schema: "keyword" });
  const env = { QDRANT_URL: base, QDRANT_API_KEY: key };
  const exclude = [simulated.messages[0].text];
  for (const cap of [100, 500, 2_500]) {
    const read = await readAndCheck({ env, all: [...jordan, ...iraq], cap, exclude });
    assert.deepEqual(read.place.split(", ").sort(), ["chat_history", "iraq_chat_history"], `cap ${cap}`);
    const taken = sent(read.conversations, cap, exclude);
    assert.ok(taken.some((c) => c.messages.some((m) => /[؀-ۿ]/.test(m.text))) && taken.length > 0);
  }
  const proposed = await proposeDatabase({ root: FIXTURE, env });
  assert.deepEqual(proposed.proposal.choices[0].places.sort(), ["chat_history", "iraq_chat_history"], "proposed from names alone");
  const textbook = await readDatabase({ root: FIXTURE, env, flags: { store: "qdrant", place: books[0] }, cap: 10, since: SINCE });
  assert.deepEqual(textbook.missing, ["conversation", "role"], "a textbook named outright is said to hold no chat");
});

// Elasticsearch and OpenSearch share a test: CORTAD_DB_SEARCH is "<address>#<user>:<password>#<ELASTICSEARCH|OPENSEARCH>".
test("Elasticsearch and OpenSearch: a message per document with a dynamic mapping, read newest first by its date", { skip: skipUnless("CORTAD_DB_SEARCH") }, async () => {
  const [base, login, prefix] = process.env.CORTAD_DB_SEARCH.split("#");
  const [user, password] = login.split(":");
  const auth = `Basic ${Buffer.from(login).toString("base64")}`;
  const es = async (method, path, body, type = "application/json") => {
    const res = await fetch(`${base}${path}`, { method, headers: { authorization: auth, "content-type": type }, ...(body ? { body } : {}) });
    if (!res.ok && res.status !== 404) throw new Error(`${path} ${res.status} ${await res.text()}`);
    return res.json();
  };
  for (const index of ["chat-messages", "products"]) await es("DELETE", `/${index}`);
  const all = chats({ now: NOW, seed: 43 });
  const lines = all.flatMap((c) => c.messages.flatMap((m) => [JSON.stringify({ index: { _index: "chat-messages" } }), JSON.stringify({ conversation_id: c.id, user_id: c.user, role: m.role, message: m.text, created_at: new Date(m.at).toISOString() })]));
  lines.push(JSON.stringify({ index: { _index: "products" } }), JSON.stringify({ name: "Blue mug", description: "A mug.", created_at: new Date(NOW).toISOString() }));
  const bulk = await es("POST", "/_bulk?refresh=true", `${lines.join("\n")}\n`, "application/x-ndjson");
  assert.equal(bulk.errors, false);
  const count = async () => (await es("GET", "/chat-messages/_count")).count;
  const before = await count();
  for (const cap of [40, 2_500]) {
    const read = await readAndCheck({ env: { [`${prefix}_URL`]: base, [`${prefix}_USERNAME`]: user, [`${prefix}_PASSWORD`]: password }, all, cap });
    assert.equal(read.place, "chat-messages");
  }
  assert.equal(await count(), before, "nothing was written");
});

test("Supabase REST (PostgREST): messages with a thread uuid and a sender of user or ai, read with the service key", { skip: skipUnless("CORTAD_DB_POSTGREST") }, async () => {
  const [base, secret, databaseUrl] = process.env.CORTAD_DB_POSTGREST.split("#");
  const { createHmac, randomUUID } = await import("node:crypto");
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${part({ alg: "HS256", typ: "JWT" })}.${part({ role: "service_role" })}`;
  const token = `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
  const { Client } = need("pg");
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  await db.query("TRUNCATE chat_messages");
  const all = chats({ now: NOW, seed: 47 }).map((c) => ({ ...c, id: randomUUID() }));
  for (const c of all) for (const m of c.messages) await db.query("INSERT INTO chat_messages (thread_id, user_id, sender, content, inserted_at) VALUES ($1, $2, $3, $4, $5)", [c.id, c.user, m.role === "assistant" ? "ai" : m.role, m.text, new Date(m.at)]);
  const snapshot = async () => (await db.query("SELECT md5(string_agg(m::text, ',' ORDER BY id)) AS h FROM chat_messages m")).rows[0].h;
  const before = await snapshot();
  for (const cap of [40, 2_500]) {
    const read = await readAndCheck({ env: { POSTGREST_URL: base, POSTGREST_TOKEN: token }, all, cap });
    assert.equal(read.place, "chat_messages");
    assert.equal(read.store.label, "Supabase");
  }
  assert.equal(await snapshot(), before, "nothing was written");
  await db.end();
});

test("CouchDB: conversation documents scanned by bookmark, then newest first once updatedAt has an index", { skip: skipUnless("CORTAD_DB_COUCH") }, async () => {
  const base = process.env.CORTAD_DB_COUCH;
  const url = new URL(base);
  const auth = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`;
  const couch = async (method, path, body) => (await fetch(`${url.origin}${path}`, { method, headers: { authorization: auth, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
  await couch("DELETE", "/chats");
  await couch("PUT", "/chats");
  const all = chats({ now: NOW, seed: 53 });
  await couch("POST", "/chats/_bulk_docs", { docs: all.map((c) => ({ _id: c.id, userId: c.user, updatedAt: new Date(c.messages.at(-1).at).toISOString(), messages: c.messages.map((m) => ({ role: m.role, text: m.text, ts: m.at })) })) });
  const snapshot = async () => JSON.stringify((await couch("GET", "/chats")).update_seq);
  const before = await snapshot();
  const env = { COUCHDB_URL: `${url.origin}/chats`, COUCHDB_USER: decodeURIComponent(url.username), COUCHDB_PASSWORD: decodeURIComponent(url.password) };
  for (const cap of [40, 2_500]) assert.equal((await readAndCheck({ env, all, cap })).place, "chats");
  assert.equal(await snapshot(), before, "nothing was written");
  await couch("POST", "/chats/_index", { index: { fields: ["updatedAt"] } });
  for (const cap of [40, 2_500]) assert.equal((await readAndCheck({ env, all, cap })).place, "chats");
});

test("Chroma: each message a record with its text as the document and the rest in metadata, times as epoch seconds", { skip: skipUnless("CORTAD_DB_CHROMA") }, async () => {
  const root = `${process.env.CORTAD_DB_CHROMA}/api/v2/tenants/default_tenant/databases/default_database/collections`;
  const chroma = async (method, path, body) => { const res = await fetch(`${root}${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); return res.status === 200 ? res.json() : null; };
  for (const name of ["chat_history", "handbook"]) await chroma("DELETE", `/${name}`);
  const history = await chroma("POST", "", { name: "chat_history" });
  const handbook = await chroma("POST", "", { name: "handbook" });
  // Whole seconds: a time kept in seconds is read to the second.
  const all = chats({ now: NOW, seed: 59 }).map((c) => ({ ...c, messages: c.messages.map((m) => ({ ...m, at: Math.floor(m.at / 1000) * 1000 })) }));
  const records = all.flatMap((c) => c.messages.map((m, n) => ({ id: `${c.id}-${n}`, document: m.text, metadata: { session_id: c.id, user_id: c.user, role: m.role, created_at: m.at / 1000 } })));
  await chroma("POST", `/${history.id}/add`, { ids: records.map((r) => r.id), documents: records.map((r) => r.document), metadatas: records.map((r) => r.metadata), embeddings: records.map(() => [0.1, 0.2, 0.3]) });
  await chroma("POST", `/${handbook.id}/add`, { ids: ["p1"], documents: ["Returns are accepted within 30 days."], metadatas: [{ source: "policy.md" }], embeddings: [[1, 0, 0]] });
  const count = async () => chroma("GET", `/${history.id}/count`);
  const before = await count();
  for (const cap of [40, 2_500]) {
    const read = await readAndCheck({ env: { CHROMA_URL: process.env.CORTAD_DB_CHROMA }, all, cap });
    assert.equal(read.place, "chat_history");
  }
  assert.equal(await count(), before, "nothing was written");
});

test("Weaviate: a ChatMessage class sorted newest first by its date, matched to conversations through GraphQL", { skip: skipUnless("CORTAD_DB_WEAVIATE") }, async () => {
  const [base, key] = process.env.CORTAD_DB_WEAVIATE.split("#");
  const wv = async (method, path, body) => { const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); const text = await res.text(); return res.ok && text ? JSON.parse(text) : null; };
  for (const c of ["ChatMessage", "Article"]) await wv("DELETE", `/v1/schema/${c}`);
  await wv("POST", "/v1/schema", { class: "ChatMessage", vectorizer: "none", properties: [["conversationId", "text"], ["userId", "text"], ["role", "text"], ["content", "text"], ["createdAt", "date"]].map(([name, t]) => ({ name, dataType: [t] })) });
  await wv("POST", "/v1/schema", { class: "Article", vectorizer: "none", properties: [{ name: "body", dataType: ["text"] }] });
  const all = chats({ now: NOW, seed: 61 });
  const objects = all.flatMap((c) => c.messages.map((m) => ({ class: "ChatMessage", vector: [0.1, 0.2], properties: { conversationId: c.id, userId: c.user, role: m.role, content: m.text, createdAt: new Date(m.at).toISOString() } })));
  for (let i = 0; i < objects.length; i += 200) await wv("POST", "/v1/batch/objects", { objects: objects.slice(i, i + 200) });
  const count = async () => (await wv("POST", "/v1/graphql", { query: "{ Aggregate { ChatMessage { meta { count } } } }" })).data.Aggregate.ChatMessage[0].meta.count;
  const before = await count();
  for (const cap of [40, 2_500]) assert.equal((await readAndCheck({ env: { WEAVIATE_URL: base, WEAVIATE_API_KEY: key }, all, cap })).place, "ChatMessage");
  assert.equal(await count(), before, "nothing was written");
});

// The command as the agent runs it, with no flag: the app's Qdrant found from its .env, read, and
// uploaded. Cortad's side is a local server that takes the upload the way /mcp/history does.
test("intelligence history with no flag proposes the place from names and reads nothing; the yes it prints reads and uploads only that place", { skip: skipUnless("CORTAD_DB_QDRANT") }, async () => {
  const { createServer } = await import("node:http");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { intelligence } = await import("../../intelligence.mjs");
  const [base, key] = process.env.CORTAD_DB_QDRANT.split("#");
  const sends = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/mcp/intelligence/start") return res.end(JSON.stringify({ app: "shop", stores: [{ kind: "qdrant", where: "", envNames: ["QDRANT_URL"] }], history: { state: "none" }, connection: {} }));
      if (req.url === "/api/mcp/history" && req.method === "POST") { const b = JSON.parse(body); sends.push(b); return res.end(JSON.stringify({ taken: b.conversations.length, messages: b.conversations.reduce((n, c) => n + c.messages.filter((m) => m.role === "user").length, 0), left: 100 })); }
      return res.end("{}");
    });
  });
  await new Promise((r) => { server.listen(0, "127.0.0.1", r); });
  const root = mkdtempSync(join(tmpdir(), "cortad-app-"));
  writeFileSync(join(root, ".env"), `QDRANT_URL=${base}\nQDRANT_API_KEY=${key}\n`);
  const home = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "cortad-home-"));
  const ctx = { root, env: {}, project: "app", spec: "@cortad/connector@0.0.0", token: () => "ct_mcp_test", apiBase: `http://127.0.0.1:${server.address().port}/api`, readStdin: async () => "" };
  try {
    const asked = await intelligence(["history", "--messages", "40", "--anyway"], ctx);
    assert.equal(asked.code, undefined, asked.text);
    assert.equal(sends.length, 0, "discovery sends nothing");
    const yes = /1\. Yes, read [^:]+: npx -y \S+ intelligence (history .*)/.exec(asked.text);
    assert.ok(yes, asked.text);
    assert.match(yes[1], /--store qdrant --table chat_history,iraq_chat_history --messages 40/);
    const out = await intelligence([...yes[1].split(" "), "--anyway"], ctx);
    assert.equal(out.code, undefined, out.text);
    assert.match(out.text, /Cortad took your users' newest \d+ conversations from your Qdrant database at 127\.0\.0\.1, /);
    assert.doesNotMatch(out.text, new RegExp(key));
    const taken = sends.flatMap((s) => s.conversations);
    assert.ok(taken.length > 0);
    assert.ok(taken.reduce((n, c) => n + c.messages.filter((m) => m.role === "user").length, 0) <= 40);
  } finally {
    process.env.HOME = home;
    server.close();
  }
});

test("Milvus: a message per entity with its vector beside it, times as Int64 milliseconds, paged and matched by session", { skip: skipUnless("CORTAD_DB_MILVUS") }, async () => {
  const base = process.env.CORTAD_DB_MILVUS;
  const mv = async (path, body) => {
    const data = await (await fetch(`${base}/v2/vectordb${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer root:Milvus" }, body: JSON.stringify(body) })).json();
    if (data.code !== 0) throw new Error(`${path} ${JSON.stringify(data)}`);
    return data.data;
  };
  for (const name of ["chat_messages", "kb_chunks"]) await mv("/collections/drop", { collectionName: name }).catch(() => {});
  const varchar = (fieldName, n = 512) => ({ fieldName, dataType: "VarChar", elementTypeParams: { max_length: n } });
  const vector = { fieldName: "embedding", dataType: "FloatVector", elementTypeParams: { dim: 4 } };
  const index = [{ fieldName: "embedding", metricType: "COSINE", indexName: "embedding", indexType: "AUTOINDEX" }];
  await mv("/collections/create", { collectionName: "chat_messages", schema: { autoId: true, fields: [{ fieldName: "id", dataType: "Int64", isPrimary: true }, vector, varchar("session_id"), varchar("user_id"), varchar("role"), varchar("content", 4000), { fieldName: "created_at", dataType: "Int64" }] }, indexParams: index });
  await mv("/collections/create", { collectionName: "kb_chunks", schema: { autoId: true, fields: [{ fieldName: "id", dataType: "Int64", isPrimary: true }, vector, varchar("text", 4000)] }, indexParams: index });
  const all = chats({ now: NOW, seed: 67 });
  const rows = all.flatMap((c) => c.messages.map((m) => ({ embedding: [0.1, 0.2, 0.3, 0.4], session_id: c.id, user_id: c.user, role: m.role, content: m.text, created_at: m.at })));
  await mv("/entities/insert", { collectionName: "chat_messages", data: rows });
  await mv("/entities/insert", { collectionName: "kb_chunks", data: [{ embedding: [1, 0, 0, 0], text: "Returns are accepted within 30 days." }] });
  const count = async () => (await mv("/entities/query", { collectionName: "chat_messages", filter: "", outputFields: ["count(*)"], consistencyLevel: "Strong" }))[0]["count(*)"];
  assert.equal(await count(), rows.length);
  for (const cap of [40, 2_500]) assert.equal((await readAndCheck({ env: { MILVUS_URI: base, MILVUS_TOKEN: "root:Milvus" }, all, cap })).place, "chat_messages");
  assert.equal(await count(), rows.length, "nothing was written");
});

test("DynamoDB: a table keyed by session and timestamp, signed with the app's AWS keys, messages queried by partition key", { skip: skipUnless("CORTAD_DB_DYNAMO") }, async () => {
  const { signed } = await import("./sigv4.mjs");
  const base = process.env.CORTAD_DB_DYNAMO;
  const creds = { region: "eu-central-1", key: "AKIDLOCALTEST", secret: "local-test-secret" };
  const db = async (target, body) => {
    const text = JSON.stringify(body);
    const res = await fetch(`${base}/`, { method: "POST", body: text, headers: signed({ url: `${base}/`, body: text, service: "dynamodb", ...creds, headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": `DynamoDB_20120810.${target}` } }) });
    const data = await res.json();
    if (!res.ok && !/ResourceNotFound/.test(data.__type)) throw new Error(`${target} ${JSON.stringify(data)}`);
    return data;
  };
  for (const t of ["ChatHistory", "Users"]) await db("DeleteTable", { TableName: t });
  await db("CreateTable", { TableName: "ChatHistory", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "SessionId", AttributeType: "S" }, { AttributeName: "Timestamp", AttributeType: "N" }], KeySchema: [{ AttributeName: "SessionId", KeyType: "HASH" }, { AttributeName: "Timestamp", KeyType: "RANGE" }] });
  await db("CreateTable", { TableName: "Users", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "UserId", AttributeType: "S" }], KeySchema: [{ AttributeName: "UserId", KeyType: "HASH" }] });
  const all = chats({ now: NOW, seed: 71 });
  const items = all.flatMap((c) => c.messages.map((m) => ({ PutRequest: { Item: { SessionId: { S: c.id }, Timestamp: { N: String(m.at) }, Role: { S: m.role }, Content: { S: m.text }, UserId: { S: c.user } } } })));
  for (let i = 0; i < items.length; i += 25) await db("BatchWriteItem", { RequestItems: { ChatHistory: items.slice(i, i + 25) } });
  const count = async () => (await db("Scan", { TableName: "ChatHistory", Select: "COUNT" })).Count;
  assert.equal(await count(), items.length);
  const env = { AWS_ACCESS_KEY_ID: creds.key, AWS_SECRET_ACCESS_KEY: creds.secret, AWS_REGION: creds.region, DYNAMODB_ENDPOINT: base };
  for (const cap of [40, 2_500]) assert.equal((await readAndCheck({ env, all, cap })).place, "ChatHistory");
  assert.equal(await count(), items.length, "nothing was written");
});

test("Firestore: chats with their messages in a subcollection, the user on the chat, timestamps, through the emulator", { skip: skipUnless("CORTAD_DB_FIRESTORE") }, async () => {
  const host = process.env.CORTAD_DB_FIRESTORE;
  const project = "demo-cortad";
  const docs = `projects/${project}/databases/(default)/documents`;
  await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" });
  const all = chats({ now: NOW, seed: 73 });
  const ts = (ms) => ({ timestampValue: new Date(ms).toISOString() });
  const writes = all.flatMap((c) => [
    { update: { name: `${docs}/chats/${c.id}`, fields: { userId: { stringValue: c.user }, title: { stringValue: "Chat" }, createdAt: ts(c.messages[0].at) } } },
    ...c.messages.map((m, n) => ({ update: { name: `${docs}/chats/${c.id}/messages/m${n}`, fields: { role: { stringValue: m.role }, content: { stringValue: m.text }, createdAt: ts(m.at) } } })),
  ]);
  writes.push({ update: { name: `${docs}/products/p1`, fields: { name: { stringValue: "Blue mug" } } } });
  for (let i = 0; i < writes.length; i += 400) {
    const res = await fetch(`http://${host}/v1/${docs}:commit`, { method: "POST", headers: { authorization: "Bearer owner", "content-type": "application/json" }, body: JSON.stringify({ writes: writes.slice(i, i + 400) }) });
    assert.ok(res.ok, await res.text());
  }
  const count = async () => (await (await fetch(`http://${host}/v1/${docs}:runAggregationQuery`, { method: "POST", headers: { authorization: "Bearer owner" }, body: JSON.stringify({ structuredAggregationQuery: { structuredQuery: { from: [{ collectionId: "messages", allDescendants: true }] }, aggregations: [{ count: {}, alias: "n" }] } }) })).json())[0].result.aggregateFields.n.integerValue;
  const before = await count();
  for (const cap of [40, 2_500]) assert.equal((await readAndCheck({ env: { FIRESTORE_EMULATOR_HOST: host, GCLOUD_PROJECT: project }, all, cap })).place, "chats/*/messages");
  assert.equal(await count(), before, "nothing was written");
});

test("Pinecone: a namespace of messages with their words in metadata, listed and fetched, matched by session through a filter", { skip: skipUnless("CORTAD_DB_PINECONE") }, async () => {
  const control = process.env.CORTAD_DB_PINECONE;
  const headers = { "api-key": "pclocal", "content-type": "application/json", "x-pinecone-api-version": "2025-01" };
  await fetch(`${control}/indexes/chat-memory`, { method: "DELETE", headers });
  const index = await (await fetch(`${control}/indexes`, { method: "POST", headers, body: JSON.stringify({ name: "chat-memory", dimension: 4, metric: "cosine", spec: { serverless: { cloud: "aws", region: "us-east-1" } } }) })).json();
  const host = /^http/.test(index.host) ? index.host : `http://${index.host}`;
  const all = chats({ now: NOW, seed: 79 });
  const vectors = all.flatMap((c) => c.messages.map((m, n) => ({ id: `${c.id}#${n}`, values: [0.1, 0.2, 0.3, 0.4], metadata: { session_id: c.id, user_id: c.user, role: m.role, content: m.text, created_at: m.at } })));
  for (let i = 0; i < vectors.length; i += 100) {
    const res = await fetch(`${host}/vectors/upsert`, { method: "POST", headers, body: JSON.stringify({ vectors: vectors.slice(i, i + 100), namespace: "conversations" }) });
    assert.ok(res.ok, await res.text());
  }
  const count = async () => (await (await fetch(`${host}/describe_index_stats`, { method: "POST", headers, body: "{}" })).json()).namespaces.conversations.vectorCount;
  assert.equal(await count(), vectors.length);
  for (const cap of [40, 2_500]) assert.equal((await readAndCheck({ env: { PINECONE_API_KEY: "pclocal", PINECONE_CONTROLLER_HOST: control }, all, cap })).place, "chat-memory/conversations");
  assert.equal(await count(), vectors.length, "nothing was written");
});

test("Cassandra: messages partitioned by conversation and clustered by time, paged, then selected by partition key", { skip: skipUnless("CORTAD_DB_CASSANDRA") }, async () => {
  const { Client } = need("cassandra-driver");
  const [host, port] = process.env.CORTAD_DB_CASSANDRA.split(":");
  const client = await waitFor(async () => { const c = new Client({ contactPoints: [host], localDataCenter: "datacenter1", protocolOptions: { port: Number(port) } }); await c.connect(); return c; }, 180_000);
  await client.execute("DROP KEYSPACE IF EXISTS chat");
  await client.execute("CREATE KEYSPACE chat WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}");
  await client.execute("CREATE TABLE chat.messages_by_conversation (conversation_id text, created_at timestamp, role text, content text, user_id text, PRIMARY KEY ((conversation_id), created_at))");
  await client.execute("CREATE TABLE chat.users (id text PRIMARY KEY, email text)");
  const all = chats({ now: NOW, seed: 83 });
  for (const c of all) for (const m of c.messages) await client.execute("INSERT INTO chat.messages_by_conversation (conversation_id, created_at, role, content, user_id) VALUES (?, ?, ?, ?, ?)", [c.id, new Date(m.at), m.role, m.text, c.user], { prepare: true });
  const count = async () => Number((await client.execute("SELECT count(*) FROM chat.messages_by_conversation")).rows[0].count);
  const before = await count();
  const env = { CASSANDRA_CONTACT_POINTS: host, CASSANDRA_PORT: port, CASSANDRA_KEYSPACE: "chat" };
  for (const cap of [40, 2_500]) assert.equal((await readAndCheck({ env, all, cap, python: true })).place, "chat.messages_by_conversation");
  assert.equal(await count(), before, "nothing was written");
  await client.shutdown();
});

test("Astra DB's Data API: a collection of conversation documents with their messages, sorted newest first, read with the application token", { skip: skipUnless("CORTAD_DB_ASTRA") }, async () => {
  const [endpoint, token] = process.env.CORTAD_DB_ASTRA.split("#");
  const api = async (path, body) => {
    const data = await (await fetch(`${endpoint}/v1${path}`, { method: "POST", headers: { token, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    if (data.errors?.length) throw new Error(`${path} ${JSON.stringify(data.errors[0])}`);
    return data;
  };
  await api("", { createKeyspace: { name: "default_keyspace" } });
  for (const name of ["chat_sessions", "faq"]) await api("/default_keyspace", { deleteCollection: { name } });
  for (const name of ["chat_sessions", "faq"]) await api("/default_keyspace", { createCollection: { name } });
  const all = chats({ now: NOW, seed: 89 });
  const docs = all.map((c) => ({ _id: c.id, user_id: c.user, updated_at: { $date: c.messages.at(-1).at }, messages: c.messages.map((m) => ({ role: m.role, content: m.text, created_at: new Date(m.at).toISOString() })) }));
  for (let i = 0; i < docs.length; i += 20) await api("/default_keyspace/chat_sessions", { insertMany: { documents: docs.slice(i, i + 20) } });
  await api("/default_keyspace/faq", { insertOne: { document: { question: "Returns?", answer: "Within 30 days." } } });
  const count = async () => (await api("/default_keyspace/chat_sessions", { countDocuments: {} })).status.count;
  assert.equal(await count(), docs.length);
  for (const cap of [40, 2_500]) assert.equal((await readAndCheck({ env: { ASTRA_DB_API_ENDPOINT: endpoint, ASTRA_DB_APPLICATION_TOKEN: token }, all, cap })).place, "chat_sessions");
  assert.equal(await count(), docs.length, "nothing was written");
});
