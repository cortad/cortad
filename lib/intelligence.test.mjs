import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { HISTORY_MESSAGES, looksLikeDevelopment, pseudonym, saltIn, selected, spanOf, timeOf } from "./history/contract.mjs";
import { said } from "./history/langfuse.mjs";
import { packed, writeSends } from "./history/send.mjs";
import { ignored, keyIdsIn, settingsOf, writeKeys } from "./envfile.mjs";
import { jsonLines } from "./intelligence.mjs";
import * as say from "./intelligence-text.mjs";
import { scrub } from "./redact.mjs";

const SPEC = "@cortad/connector@0.6.0";
const DAY = 86_400_000;
const SALT = "5".repeat(64);
const quoted = (t) => (/^[\w.,:@%+=-]+$/.test(t) ? t : `'${t}'`);

// Every word the command can print, rendered in each of its states.
function everything() {
  const store = { kind: "postgres", where: "chat_messages", envNames: ["DATABASE_URL"] };
  const source = { id: "langfuse", name: "Langfuse", names: ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"], host: "cloud.langfuse.com" };
  const picked = { conversations: [], messages: 12, total: 25, scrubbed: 2, left: { "older than 30 days": 3 }, users: 4 };
  const span = { from: "2026-10-10T10:00:00.000Z", to: "2026-11-08T10:00:00.000Z" };
  const problem = { title: "Does what was asked", broke: 3, of: 40, most: { useCase: "refunds" }, url: "https://cortad.com/live/x" };
  const out = [
    say.lines(say.header("shop-agent"), say.keyRefused), say.approveFirst({ spec: SPEC, link: "https://cortad.com/approve/abc", words: "K7QX", name: "shop-agent" }), say.pairExpired(SPEC), say.paired("shop-agent"), say.gone(),
    say.lines(say.keysWritten(".env.local", { ingest: 4, page: 5, env: 6 }, { host: "other", spec: SPEC })), say.lines(say.keysWritten(".env", { ingest: 1, page: 2 }, { host: "render", spec: SPEC })), say.lines(say.keysWritten(".env", { ingest: 1, page: 2 }, { host: "vercel", spec: SPEC })), say.lines(say.keysKept(".env.local")),
    say.lines(say.keysManaged("Doppler", "/home/me/.cortad/x/keys.env")), say.notIgnored(".env", SPEC), say.imageWarning(".env.local"),
    say.lines(say.historyQuestion({ spec: SPEC, sources: [source], stores: [store] })),
    say.lines(say.historySent({ result: { taken: 9, messages: 12, already: 1 }, picked, span, source: "Langfuse" })),
    say.lines(say.historyDry({ picked, span, cap: 12, file: "/home/me/.cortad/x/history-dry-run.jsonl", why: "there are only 3 conversations" })),
    say.lines(say.historyProposal({ spec: SPEC, kind: "postgres", label: "Postgres", host: "db.example.com", envNames: ["DATABASE_URL"], cap: 2_500, quoted, rest: "",
      choices: [{ places: ["Message_v2"], paths: ["chatId", "role", "parts", "createdAt"], users: "Chat" }, { places: ["chats/*/messages"], paths: ["role", "text"], users: null }] })),
    say.lines(say.exclusionsUnread(SPEC, "Cortad answered 401")), say.lines(say.redactFailed("python3 scrub.py ended with code 1")),
    say.lines(say.historyLooksLikeDevelopment({ why: "there are only 3 conversations", spec: SPEC, rest: "--stdin" })),
    say.lines(say.historyNothing("Langfuse")), say.lines(say.historySkipped()),
    say.lines(say.historyNotRead({ spec: SPEC, mask: String, tried: [{ label: "Postgres", host: "db.example.com", why: "this app has no Postgres driver installed" }] })),
    say.lines(say.historyNotRead({ spec: SPEC, mask: String, unknown: ["messages"], store: { label: "Postgres", host: "db.example.com" } })),
    say.lines(say.historyNotRead({ spec: SPEC, mask: String, missing: ["at"], name: "chat_logs", paths: ["id", "body"], store: { label: "MySQL", host: "db.example.com", kind: "mysql" } })),
    ...["node", "python", "other"].flatMap((kind) => [true, false].map((settable) => say.lines(say.codeStep({
      spec: SPEC, stack: { kind, add: { node: "npm i", python: "pip install", other: "" }[kind] }, page: { file: "app/layout.tsx", key: "ct_pub_x" },
      file: ".env.local", site: settable ? "https://shop.example.com" : null, consent: settable ? "CookieYes" : null, host: settable ? "vercel" : "render", settable,
    })))),
    say.lines(say.keySet("vercel", ".env.local")), say.lines(say.keyNotSet("render", "it is not signed in", ".env.local")),
    say.lines(say.siteLocked("https://shop.example.com")), say.workingHere(Date.now()), say.live({ started: { release: "5cb85c1bce" } }),
    say.lines(say.findings({ history: { conversations: 40, read: 40 }, problems: [problem], where: "https://cortad.com/live", done: true })),
    say.lines(say.findings({ history: { conversations: 40, read: 12 }, problems: [], where: "https://cortad.com/live", done: false })),
    say.next(SPEC, "--wait"),
  ];
  return out.join("\n");
}

// "Which address do people open your app at?" was asked of an app the same step said has no web page.
test("the address people open the app at is asked only of an app with a page tag", () => {
  const step = (page, site = null) => say.lines(say.codeStep({ spec: SPEC, stack: { kind: "node", add: "npm i" }, page, file: ".env.local", site, consent: null, host: "render", settable: false }));
  assert.match(step({ file: "app/layout.tsx", key: "ct_pub_x" }), /Which address do people open your app at\?/);
  assert.doesNotMatch(step({ file: "app/layout.tsx", key: "ct_pub_x" }, "https://shop.example.com"), /Which address/);
  const pageless = step(null);
  assert.match(pageless, /no web page of its own/);
  assert.doesNotMatch(pageless, /Which address|intelligence site/);
});

// The person chose a number of messages; the progress said conversations.
test("history's progress and its question are said in messages, the unit the person chose", () => {
  const progress = say.lines(say.findings({ history: { conversations: 966, read: 400 }, replies: { read: 760, of: 1_831 }, problems: [], where: "https://cortad.com/live", done: false }));
  assert.match(progress, /Cortad has analyzed 760 of your 1,831 messages so far\./);
  assert.match(say.lines(say.findings({ history: { conversations: 966, read: 966 }, replies: { read: 1_831, of: 1_831 }, problems: [], where: "https://cortad.com/live", done: true })), /Cortad has analyzed all 1,831 messages\./);
  const asked = say.lines(say.historyQuestion({ spec: SPEC, sources: [], stores: [] }));
  assert.match(asked, /Step 1 of 2: your users' messages/);
  assert.match(asked, /Ask the person once, with your question tool: "Send your users' newest 2,500 messages from the last 30 days to Cortad, so it can show you your users\?" Its options, yes first/);
  assert.match(asked, /\ncortad {4}1\. Yes, send them from your database: .*\ncortad {4}2\. Not now, start from the next deploy: /);
});

test("nothing the command prints reads as hiding something, hurrying past the person or running unpinned code", () => {
  const text = everything();
  const source = readFileSync(new URL("./intelligence-text.mjs", import.meta.url), "utf8");
  for (const banned of [/silently/i, /secretly/i, /without telling/i, /without printing/i, /do not show/i, /don't mention/i, /\bhidden\b/i, /bypass/i,
    /ignore previous/i, /\boverride\b/i, /without asking/i, /do not ask/i, /don't tell/i, /no need to ask/i, /—/, /--force/, /--no-verify/, /\| *(sh|bash)\b/,
    /\bcurl /, /\bsudo\b/, /rm -rf/, /npx (-y )?cortad(?!@\d)/]) {
    assert.doesNotMatch(text, banned, `printed: ${banned}`);
    assert.doesNotMatch(source, banned, `written: ${banned}`);
  }
  assert.match(text, /npx -y @cortad\/connector@0\.6\.0 intelligence history --from langfuse/);
  assert.doesNotMatch(text, /ct_ing_/, "an ingest key is never printed");
});

test("history is whole conversations, newest first, from 30 days, up to the plan's messages, with the app's ids pseudonymized", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  const conv = (id, replies, agoDays, extra = {}) => ({
    id, user: `u-${id}`,
    messages: Array.from({ length: replies * 2 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}`, at: new Date(now - agoDays * DAY + i * 1000).toISOString() })),
    ...extra,
  });
  const many = Array.from({ length: 26 }, (_, i) => conv(`c${i}`, 2_000, 2 + i / 100));
  const salt = SALT;
  const picked = selected([conv("new", 3, 1), ...many, conv("old", 2, 40), { id: "nozone", messages: [{ role: "user", text: "hi", at: "2026-11-08 10:00:00" }] }], { now, salt });
  assert.equal(picked.conversations[0].id, pseudonym(salt, "session", "new"), "newest first, pseudonymized with this machine's salt");
  assert.equal(picked.conversations[1].messages.length, 200, "a long conversation keeps its latest 200 messages");
  assert.equal(picked.messages, 3 + 24 * 100, "whole conversations until the next would pass 2,500 messages");
  assert.ok(picked.messages <= HISTORY_MESSAGES);
  assert.equal(picked.left["past 2,500 messages"], 2);
  assert.equal(picked.left["older than 30 days"], 1);
  assert.equal(picked.left["a time with no zone"], 1);
  assert.equal(picked.conversations[0].user, pseudonym(salt, "user", "u-new"));
  assert.notEqual(picked.conversations[0].user, createHash("sha256").update("ct_ing_TESTKEY1secret:user:u-new").digest("hex"), "never the hash a key Cortad issued could reverse");
  assert.throws(() => selected([], { now }), /no pseudonym salt/, "nothing is selected without a salt");
  assert.deepEqual(picked.conversations[0].messages.map((m) => m.role), ["user", "assistant", "user", "assistant", "user", "assistant"]);

  const roles = selected([{ id: "r", messages: [{ role: "system", text: "You are a bot", at: new Date(now).toISOString() }, { role: "human", text: "hi", at: new Date(now).toISOString() }] }], { now, salt });
  assert.deepEqual(roles.conversations[0].messages.map((m) => [m.role, m.text]), [["user", "hi"]], "a system prompt is never sent");
  assert.equal(timeOf(1_762_600_000).getTime(), 1_762_600_000_000, "epoch seconds read as seconds");
});

// A Qdrant run asked for 500 and printed 292 replies with no word on why, two of its sessions the
// developer's own: Cortad's test conversations are left out, and a short window says it was all.
test("Cortad's own test conversations stay out, and fewer replies than asked are said to be all there were", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  const at = (min) => new Date(now - min * 60_000).toISOString();
  const chat = (id, first, replies) => ({ id, messages: [{ role: "user", text: first, at: at(90) }, ...Array.from({ length: replies }, (_, i) => ({ role: "assistant", text: `r${i}`, at: at(80 - i / 10) }))] });
  const picked = selected([chat("mine", "Hi.  What can you help me with? ", 300), chat("sim", "I need a refund for order 7", 4), chat("real", "How do I reset my password?", 6)], { now, salt: SALT, cap: 500, exclude: ["I need a refund for order 7"] });
  assert.equal(picked.conversations.length, 1);
  assert.equal(picked.left["test conversations Cortad had with your app"], 2);
  assert.equal(picked.found, 6);
  const span = spanOf(picked.conversations);
  assert.match(say.lines(say.historyDry({ picked, span, cap: 500, file: "f" })), /You asked for 500 replies; only 6 were found in the last 30 days, so Cortad took all of them\./);
  assert.doesNotMatch(say.lines(say.historyDry({ picked, span, cap: 6, file: "f" })), /You asked/);
});

test("what a person pasted into a chat is replaced before it is written down or sent", () => {
  const { text, hits } = scrub("my card 4242 4242 4242 4242, mail ada@example.com, key sk_live_abcdefghijklmnop1234, order 12345", ["hunter2-password"]);
  assert.equal(hits, 3);
  assert.match(text, /\[redacted:card\].*\[redacted:email\].*\[redacted:apikey\].*order 12345/);
  assert.equal(scrub("the password is hunter2-password", ["hunter2-password"]).text, "the password is [redacted:env]");
});

test("sends stay under 1 MiB, and one conversation too large on its own keeps its newest messages", () => {
  const long = "x".repeat(8_000);
  const big = { id: "a", messages: Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: long, at: new Date(i * 1000).toISOString() })) };
  const sends = packed("export", [big, { ...big, id: "b" }]);
  for (const body of sends) assert.ok(Buffer.byteLength(JSON.stringify(body)) < 1_048_576);
  assert.equal(sends.length, 2);
  assert.equal(sends[0].conversations[0].messages.at(-1).at, big.messages.at(-1).at, "the newest message is kept");
});

test("a development copy is caught before it is sent", () => {
  const now = Date.now();
  const conversations = Array.from({ length: 30 }, (_, i) => ({ messages: [{ at: new Date(now - i * 60_000).toISOString() }] }));
  assert.match(looksLikeDevelopment({ host: "localhost:5432", conversations, users: 9 }), /on this computer/);
  assert.match(looksLikeDevelopment({ host: "db", conversations, users: 9 }), /on this computer/);
  assert.match(looksLikeDevelopment({ host: "db.example.com", conversations: conversations.slice(0, 3), users: 3 }), /only 3/);
  assert.equal(looksLikeDevelopment({ host: "db.example.com", conversations, users: 9 }), null);
});

test("the key goes only into a git-ignored env file, a second write replaces Cortad's lines alone, and only key ids are read back", () => {
  const root = mkdtempSync(join(tmpdir(), "cortad-intel-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "next.config.mjs"), "export default {};\n");
  writeFileSync(join(root, ".env.local"), "OPENAI_API_KEY=sk-test\nCORTAD_ENV=development\n");
  assert.deepEqual(settingsOf(root), { file: ".env.local" });
  assert.equal(ignored(root, ".env.local"), false, "a file git would commit");
  writeFileSync(join(root, ".gitignore"), ".env.local\n");
  assert.equal(ignored(root, ".env.local"), true);

  const at = writeKeys(root, ".env.local", { ingest: "ct_ing_AAAAAAAAsecretsecret", page: "ct_pub_BBBBBBBBpublicpublic" });
  assert.deepEqual(at, { ingest: 3, page: 4, env: null }, "CORTAD_ENV already there is left as it is");
  writeKeys(root, ".env.local", { ingest: "ct_ing_CCCCCCCCsecretsecret", page: "ct_pub_DDDDDDDDpublicpublic" });
  assert.equal(readFileSync(join(root, ".env.local"), "utf8"), "OPENAI_API_KEY=sk-test\nCORTAD_ENV=development\nCORTAD_INGEST_KEY=ct_ing_CCCCCCCCsecretsecret\nCORTAD_PUBLIC_KEY=ct_pub_DDDDDDDDpublicpublic\n");
  assert.deepEqual(keyIdsIn(root, ".env.local"), ["ct_ing_CCCCCCCC", "ct_pub_DDDDDDDD"]);

  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { dev: "doppler run -- next dev" } }));
  assert.deepEqual(settingsOf(root), { manager: "Doppler" }, "settings from a manager are never written to a file");
});

test("an export is read line by line, a first line may name where it was read, and a broken line is counted, not fatal", () => {
  const { conversations, host } = jsonLines('{"source":{"kind":"postgres","host":"db.example.com"}}\n{"id":"1","messages":[]}\nnot json\n\n');
  assert.equal(host, "db.example.com");
  assert.equal(conversations.length, 2);
  assert.equal(conversations[1], null);
});

test("Langfuse's shapes give the person's newest message and the app's reply", () => {
  assert.equal(said([{ role: "system", content: "x" }, { role: "user", content: "first" }, { role: "assistant", content: "a" }, { role: "user", content: "where is it" }], "user"), "where is it");
  assert.equal(said({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }, "user"), "hi");
  assert.equal(said({ choices: [{ message: { content: "It ships tomorrow." } }] }, "assistant"), "It ships tomorrow.");
  assert.equal(said({ role: "assistant", content: "ok" }, "assistant"), "ok");
  assert.equal(said("plain", "user"), "plain");
});

test("the SDK the agent is told to install is the one that loads in a CommonJS app, and Python its own", async () => {
  const { SDK } = await import("./intelligence-text.mjs");
  assert.deepEqual(SDK, { node: "0.3.5", python: "0.3.4" });
});

test("an export's attributes, what the app knew about each conversation's user, are sent with it", () => {
  const at = new Date().toISOString();
  const line = (id, attributes) => JSON.stringify({ id, attributes, messages: [{ role: "user", text: "derivative of x^2?", at }, { role: "assistant", text: "2x", at }] });
  const { conversations } = jsonLines([line("1", { "math level": "Calculus", grade: 11, "<bad>": "x", empty: " " }), line("2", undefined)].join("\n"));
  const picked = selected(conversations, { salt: SALT, secrets: ["sk-live-123"] });
  const [sent] = packed("export", picked.conversations);
  const byFacts = sent.conversations.map((c) => c.attributes ?? null).sort();
  assert.deepEqual(byFacts, [{ "math level": "Calculus", grade: "11" }, null], "string values, bad names and empty ones left out");
  const withKey = selected(jsonLines(line("3", { note: "token sk-live-123" })).conversations, { salt: SALT, secrets: ["sk-live-123"] });
  assert.ok(!withKey.conversations[0].attributes.note.includes("sk-live-123"), "a value is scrubbed like a message");
});

// Each id and user was hashed with CORTAD_INGEST_KEY, which Cortad issued, so Cortad could hash every
// small id (a seat number) and read it back. The salt is made here and never leaves this computer.
test("the pseudonym salt is made on this computer once, readable only by its user, and a link at its name is refused", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "cortad-salt-")), "project");
  const salt = saltIn(dir);
  assert.match(salt, /^[0-9a-f]{64}$/);
  assert.equal(saltIn(dir), salt, "the same salt every run, so a person is the same pseudonym every time");
  assert.equal(statSync(join(dir, "pseudonym.salt")).mode & 0o777, 0o600);
  const other = join(mkdtempSync(join(tmpdir(), "cortad-salt-")), "project");
  saltIn(other);
  assert.notEqual(saltIn(other), salt, "each project its own");
  const linked = mkdtempSync(join(tmpdir(), "cortad-salt-"));
  symlinkSync(join(dir, "pseudonym.salt"), join(linked, "pseudonym.salt"));
  assert.throws(() => saltIn(linked), /is a link/);
});

// The README said --dry-run wrote what would be sent; it printed counts and wrote nothing.
test("a dry run writes the sends exactly as they would go, readable only by this user, and prints a few redacted lines", () => {
  const at = new Date().toISOString();
  const { conversations } = jsonLines(JSON.stringify({ id: "s1", user: "9861234567", messages: [{ role: "user", text: "my seat number is 22013456, call 0791234567", at }, { role: "assistant", text: "Let me check.", at }] }));
  const picked = selected(conversations, { salt: SALT });
  const sends = packed("export", picked.conversations);
  const file = join(mkdtempSync(join(tmpdir(), "cortad-dry-")), "x", "history-dry-run.jsonl");
  writeFileSync(join(mkdtempSync(join(tmpdir(), "cortad-dry-")), "old"), "");
  writeSends(file, sends);
  writeSends(file, sends);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines, JSON.parse(JSON.stringify(sends)), "the file is the payload, one send per line");
  const text = readFileSync(file, "utf8");
  for (const raw of ["s1", "9861234567", "22013456", "0791234567"]) assert.ok(!text.includes(raw), `${raw} never written`);
  const printed = say.lines(say.historyDry({ picked, span: spanOf(picked.conversations), cap: 2_500, file }));
  assert.match(printed, new RegExp(`What would be sent is in ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(printed, /user: "my seat number is \[redacted:id\], call \[redacted:phone\]"/);
  assert.match(printed, /Names written in a message are not removed by Cortad's rules/);
});

test("discovery's proposal is one question, yes first, naming what will be read, whose yes runs a command that reads only those tables", () => {
  const text = say.lines(say.historyProposal({ spec: SPEC, kind: "firestore", label: "Firestore", host: "firestore.googleapis.com", envNames: ["FIREBASE_SERVICE_ACCOUNT"], cap: 500, quoted, rest: "--messages 500 --redact-with 'python3 scrub.py'",
    choices: [{ places: ["chats/*/messages"], paths: ["role", "text", "createdAt", "__parent"], users: "chats" }, { places: ["history"], paths: ["role", "content"], users: null }] }));
  assert.match(text, /Cortad read only the names of the tables and fields in your Firestore database at firestore\.googleapis\.com, opened by FIREBASE_SERVICE_ACCOUNT, never a row\./);
  assert.match(text, /Its fields: role, text, createdAt\./);
  assert.match(text, /"Read chats\/\*\/messages, with each conversation's user from chats, in your Firestore database, and send your users' newest 500 messages from the last 30 days to Cortad\?"/);
  assert.match(text, /1\. Yes, read chats\/\*\/messages: npx -y @cortad\/connector@0\.6\.0 intelligence history --store firestore --table 'chats\/\*\/messages,chats' --messages 500 --redact-with 'python3 scrub\.py'\n/);
  assert.match(text, /2\. No, read history instead: .*--store firestore --table history --messages 500/);
  assert.match(text, /3\. Not now, start from the next deploy: .*--skip/);
  assert.match(text, /Names written in a message are not removed by Cortad's rules/);
});

// The agent wrote its own export script for ten minutes, and the send itself took seconds.
test("step 1 hands the agent one command for the app's database, and only an app whose env names no database gets the export", () => {
  const asked = say.lines(say.historyQuestion({ spec: SPEC, sources: [], stores: [{ kind: "qdrant", where: "", envNames: ["QDRANT_URL"] }] }));
  assert.match(asked, /1\. Yes, send them from your database \(Qdrant, opened by QDRANT_URL\): npx -y @cortad\/connector@0\.6\.0 intelligence history\n/);
  assert.doesNotMatch(asked, /--stdin|script|JSON line|write nothing/);
  assert.match(asked, /reads only the names of its tables and fields, never a row/);
  assert.match(asked, /Names written in a message are not removed by Cortad's rules/);
  const sent = say.lines(say.historySent({ result: { taken: 294, messages: 500 }, picked: { total: 1_020, left: {} }, span: { from: "2026-10-20T10:00:00Z", to: "2026-11-12T10:00:00Z" }, source: "your Qdrant database at q.example.com" }));
  assert.match(sent, /Cortad took your users' newest 294 conversations from your Qdrant database at q\.example\.com, /);
  assert.match(sent, /Cortad is analyzing them now\./);
  const none = say.lines(say.historyNotRead({ spec: SPEC, mask: String, tried: [] }));
  assert.match(none, /names no database Cortad can take conversations from/);
  assert.match(none, /intelligence history --stdin/);
});

// The key in .env was read as the live app's: it is this computer's, and the live app takes the same
// value from its host, which Cortad sets only where the host's own command can.
test("the env key line says the key works only here and where the live app's copy goes", () => {
  const render = say.lines(say.keysWritten(".env", { ingest: 1, page: 2 }, { host: "render", spec: SPEC }));
  assert.match(render, /CORTAD_INGEST_KEY in \.env works only on this computer\. For the live app, the same value goes into your service on Render: Environment: add CORTAD_INGEST_KEY there\./);
  assert.doesNotMatch(render, /key --to/, "Render has no command Cortad runs");
  assert.match(say.lines(say.keysWritten(".env", { ingest: 1, page: 2 }, { host: "vercel", spec: SPEC })), /npx -y @cortad\/connector@0\.6\.0 intelligence key --to vercel sets it there when the Vercel command is installed, signed in and linked to this folder\./);
  assert.match(say.lines(say.keysWritten(".env", { ingest: 1, page: 2 }, { host: "other", spec: SPEC })), /intelligence key --to <host> sets it on Vercel, Cloudflare, Fly\.io, GitHub Actions when/);
});

// The relay asked about the code change and `intelligence` asked again: one question, yes first.
test("each question is asked once, yes first", () => {
  const text = everything();
  const asks = text.split("\n").filter((l) => /Ask the person/.test(l));
  for (const ask of asks) assert.match(ask, /Ask the person once, with your question tool: /, ask);
  for (const [, first] of text.matchAll(/Its options, yes first[^\n]*\ncortad {4}1\. ([^:\n]*)/g)) assert.match(first, /^Yes\b/);
  assert.doesNotMatch(text, /Change something first/);
});

// Pairing sent this computer's hostname, which names the person more often than the machine.
test("pairing says only the folder's name, cleaned as the connect cleans it, and never the hostname", async () => {
  const { hostname } = await import("node:os");
  const { pair } = await import("./intelligence-pair.mjs");
  const root = join(mkdtempSync(join(tmpdir(), "cortad-pair-")), "my app (copy)");
  const home = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "cortad-home-"));
  const posted = [];
  const post = async (path, body) => {
    posted.push(body);
    if (path === "/local/pair") return { ok: true, status: 200, data: { id: "p1", secret: "s", words: "K7QX" } };
    if (path.endsWith("/collect")) return { ok: true, status: 200, data: { code: "c" } };
    return { ok: true, status: 201, data: { machineKey: "ct_mk_x", app: "shop" } };
  };
  try {
    assert.deepEqual(await pair({ root, project: "p", apiBase: "https://cortad.com/api" }, post), { paired: true, app: "shop" });
  } finally {
    process.env.HOME = home;
  }
  assert.deepEqual(posted[0], { name: "my-app--copy-" });
  assert.deepEqual(posted[2], { code: "c", project: "p", name: "my-app--copy-" });
  const short = hostname().split(".")[0];
  if (short.length > 3) assert.ok(!JSON.stringify(posted).includes(short), "no hostname in any request");
});
