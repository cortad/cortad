import { byName, fieldsOf, joinOf, parentOf, placeScore } from "./fields.mjs";
import { newest } from "./newest.mjs";
import { isOwn, ownTexts } from "../contract.mjs";
import { ASTRA } from "./astra.mjs";
import { CASSANDRA } from "./cassandra.mjs";
import { CHROMA } from "./chroma.mjs";
import { COUCH } from "./couch.mjs";
import { MILVUS } from "./milvus.mjs";
import { MONGO } from "./mongo.mjs";
import { MSSQL } from "./mssql.mjs";
import { MYSQL } from "./mysql.mjs";
import { PINECONE } from "./pinecone.mjs";
import { POSTGRES } from "./postgres.mjs";
import { POSTGREST } from "./postgrest.mjs";
import { QDRANT } from "./qdrant.mjs";
import { REDIS } from "./redis.mjs";
import { SEARCH } from "./search.mjs";
import { DYNAMO } from "./dynamo.mjs";
import { FIRESTORE } from "./firestore.mjs";
import { LIBSQL, SQLITE } from "./sqlite.mjs";
import { WEAVIATE } from "./weaviate.mjs";

// The app's own database, found from its env and read on this machine, in two steps. Discovery opens
// it and reads only names: tables and columns, or the field names of a few records with every value
// dropped where a store keeps no schema. It proposes a store and the places in it, which the person
// confirms. Only then is a place read, and only the places named: which fields, then its newest
// conversations. Every store here is read and never written.
export const STORES = [POSTGRES, MYSQL, MSSQL, SQLITE, LIBSQL, MONGO, FIRESTORE, DYNAMO, POSTGREST, REDIS, CASSANDRA, ASTRA, COUCH, SEARCH, QDRANT, WEAVIATE, CHROMA, MILVUS, PINECONE];
export const KINDS = STORES.map((s) => s.kind);

// `hint`: where Cortad's read of this repository says the conversations are ({ kind, where, envNames }).
export function connectionsIn(env, { root, hint = null, only = null } = {}) {
  const all = STORES.flatMap((store) => {
    try { return store.find(env, root).map((conn) => ({ ...conn, store })); } catch (error) { return [{ kind: store.kind, host: "", envNames: [], store, refused: error.message }]; }
  });
  const hinted = (c) => (hint && c.kind === hint.kind ? (c.envNames.some((n) => hint.envNames?.includes(n)) ? 0 : 1) : 2);
  return all.filter((c) => !only || c.kind === only).sort((a, b) => hinted(a) - hinted(b));
}

// The store and places to propose, from names alone: { proposal } or { tried }. `flags.place`: a
// place the person already named, which goes first. Each choice is the places read together (one
// collection per country, kept under the same names) and the place that names each conversation's user.
const CHOICES = 3;
export async function proposeDatabase({ root, env, hint = null, flags = {} }) {
  const tried = [];
  for (const conn of connectionsIn(env, { root, hint, only: flags.store })) {
    if (conn.refused) { tried.push({ label: conn.store.label, host: conn.host, why: conn.refused }); continue; }
    let store;
    try {
      store = await conn.store.open(conn, { root, env });
      const places = await store.places();
      const choices = choicesIn(places, flags.place ?? (hint?.kind === conn.kind ? hint.where : null));
      if (!choices.length) { tried.push({ label: store.label, host: store.host, why: places.length ? "no table or collection in it is named like a chat's messages" : "it holds nothing Cortad can read" }); continue; }
      return { proposal: { kind: conn.kind, label: store.label, host: store.host, envNames: conn.envNames, choices } };
    } catch (error) {
      tried.push({ label: store?.label ?? conn.store.label, host: conn.host, why: error.message });
    } finally {
      await store?.close?.().catch(() => {});
    }
  }
  return { tried };
}

export function choicesIn(places, wanted) {
  const named = (p) => (wanted && (p.name === wanted || p.name.split(".").at(-1) === wanted) ? 1 : 0);
  const chats = places.map((p) => ({ ...p, m: byName(p.paths, Boolean(p.parent)) })).filter((p) => p.m.chat)
    .sort((a, b) => named(b) - named(a) || b.m.meanings - a.m.meanings || placeScore(b.name) - placeScore(a.name));
  // The same shape is the same fields for what a chat needs (its conversation, who wrote each message,
  // the text, the time), whatever else a place keeps: iraq_chat_history and chat_history are one
  // choice, read together, though one also keeps each message's tool.
  const groups = new Map();
  for (const p of chats) {
    const { conversation, role, text, at, list, pair } = p.m;
    const shape = JSON.stringify([conversation, role, text, at, list, pair]);
    if (!groups.has(shape)) groups.set(shape, { places: [], paths: p.paths, users: parentOf(p.m, p, places) });
    groups.get(shape).places.push(p.name);
  }
  return [...groups.values()].slice(0, CHOICES);
}

// What was read from the places the person confirmed, or why nothing was: { conversations, store,
// place } or { tried, unknown, missing }. Rows are read from those places and no other.
// `exclude`: texts Cortad itself sent the app; a conversation holding one is not the app's users'.
export async function readDatabase({ root, env, hint = null, flags, cap, since, exclude = [] }) {
  const names = String(flags.place).split(",").map((n) => n.trim()).filter(Boolean);
  const tried = [];
  let unknown = null;
  for (const conn of connectionsIn(env, { root, hint, only: flags.store })) {
    if (conn.refused) { tried.push({ label: conn.store.label, host: conn.host, why: conn.refused }); continue; }
    let store;
    try {
      store = await conn.store.open(conn, { root, env });
      const places = await store.places({ only: names });
      const absent = names.filter((n) => !places.some((p) => p.name === n));
      if (absent.length) { unknown ??= { unknown: absent, store: { label: store.label, host: store.host } }; continue; }
      const found = [];
      for (const p of places) {
        const sample = await store.sample(p.name);
        found.push({ ...p, sample, f: fieldsOf(sample, flags.hints ?? {}) });
      }
      const chats = found.filter((p) => p.f.shape);
      if (!chats.length) {
        const near = found.filter((p) => p.sample.length).sort((a, b) => a.f.missing.length - b.f.missing.length)[0] ?? found[0];
        return { missing: near.f.missing, name: near.name, paths: near.f.paths, store: { label: store.label, host: store.host, kind: conn.kind } };
      }
      const own = ownTexts(exclude);
      const conversations = [];
      for (const place of chats) conversations.push(...await readPlace(store, place.name, { ...place.f, join: joinOf(place.f, found, place) }, { cap, since, own }));
      return { conversations: conversations.sort((a, b) => b.last - a.last), store: { label: store.label, host: store.host, kind: store.kind }, place: chats.map((p) => p.name).join(", ") };
    } catch (error) {
      tried.push({ label: store?.label ?? conn.store.label, host: conn.host, why: error.message });
    } finally {
      await store?.close?.().catch(() => {});
    }
  }
  return unknown ?? { tried };
}

// One place's newest conversations. While Cortad's own conversations take part of the cap, the place
// is read again with that much more room, so the app's users still fill it.
async function readPlace(store, place, f, { cap, since, own }) {
  const asks = (list) => list.reduce((n, c) => n + c.messages.filter((m) => m.role === "user").length, 0);
  let ours = 0;
  for (;;) {
    const got = await newest(store, place, f, { cap: cap + ours, since });
    const now = asks(got.filter((c) => isOwn(c, own)));
    if (now === ours || asks(got) < cap + ours) return got;
    ours = now;
  }
}
