import assert from "node:assert/strict";
import { test } from "node:test";
import { byName, namesOf, parentOf } from "./fields.mjs";
import { sqlStore } from "./sql.mjs";

// Discovery sampled 20 rows of up to 12 tables with SELECT *, which could be a table of students.
test("discovery in a SQL database asks the catalog and nothing else; rows come only from a place it is told to read", async () => {
  const sent = [];
  const catalog = [
    { s: "public", t: "Message_v2", c: "chatId", d: "text" }, { s: "public", t: "Message_v2", c: "role", d: "text" },
    { s: "public", t: "Message_v2", c: "parts", d: "json" }, { s: "public", t: "Message_v2", c: "createdAt", d: "timestamp" },
    { s: "public", t: "Chat", c: "id", d: "text" }, { s: "public", t: "Chat", c: "userId", d: "text" },
    { s: "public", t: "Student", c: "national_id", d: "text" }, { s: "public", t: "Student", c: "phone", d: "text" },
  ];
  const store = sqlStore({ dialect: "postgres", param: (i) => `$${i}`, query: async (sql) => { sent.push(sql); return /information_schema/.test(sql) ? catalog : []; }, close: async () => {} }, { label: "Postgres", host: "db" });
  const places = await store.places();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^SELECT table_schema AS s, table_name AS t, column_name AS c, data_type AS d FROM information_schema\.columns/);
  assert.deepEqual(places.map((p) => p.name), ["Message_v2", "Chat", "Student"]);
  await store.sample("Message_v2");
  assert.equal(sent.length, 2);
  assert.match(sent[1], /FROM "public"."Message_v2" LIMIT 20 OFFSET 0$/);
  assert.ok(!sent.some((sql) => /"Student"/.test(sql)), "a table nobody chose is never selected from");
});

test("names alone say which place is a chat and which holds its users; a textbook's names lose to a chat's", () => {
  const messages = byName(["chatId", "role", "parts", "createdAt"]);
  assert.equal(messages.chat, true);
  assert.equal(parentOf(messages, { name: "Message_v2" }, [{ name: "Chat", paths: ["id", "userId", "title"] }, { name: "Student", paths: ["id", "userId"] }]), "Chat");
  const book = byName(["text", "docId", "page", "chunkType", "source", "createdAt"]);
  const chat = byName(["userId", "sessionId", "role", "content", "timestamp"]);
  assert.ok(chat.meanings > book.meanings);
  assert.equal(byName(["name", "national_id", "phone", "grade"]).chat, false, "a table of students is no chat");
  assert.equal(parentOf(byName(["role", "text", "createdAt"], true), { name: "chats/*/messages", parent: "chats" }, [{ name: "chats", paths: ["__id", "userId", "title"] }]), "chats");
});

test("a store without a schema is known by the names of a few records, every value dropped", () => {
  assert.deepEqual(namesOf([{ role: "user", text: "my number is 0791234567", meta: { school: "x" } }, { role: "assistant", at: 1 }]), ["role", "text", "meta", "meta.school", "at"]);
});
