import { fieldsOf, joinOf, placeScore } from "./fields.mjs";
import { conversationsOf, newest } from "./newest.mjs";
import { isOwn, ownTexts } from "../contract.mjs";
import { at, listOf, msOf } from "./values.mjs";
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

export const STORES = [POSTGRES, MYSQL, MSSQL, SQLITE, LIBSQL, MONGO, FIRESTORE, DYNAMO, POSTGREST, REDIS, CASSANDRA, ASTRA, COUCH, SEARCH, QDRANT, WEAVIATE, CHROMA, MILVUS, PINECONE];
export const KINDS = STORES.map((s) => s.kind);

const newestIn = (sample, f) => Math.max(0, ...sample.flatMap((r) => [msOf(at(r, f.at)), ...(f.list?.at ? (listOf(at(r, f.list.path)) ?? []).map((m) => msOf(at(m, f.list.at))) : [])]).filter((ms) => ms !== null));

export function connectionsIn(env, { root, hint = null, only = null } = {}) {
  const all = STORES.flatMap((store) => {
    try { return store.find(env, root).map((conn) => ({ ...conn, store })); } catch (error) { return [{ kind: store.kind, host: "", envNames: [], store, refused: error.message }]; }
  });
  const hinted = (c) => (hint && c.kind === hint.kind ? (c.envNames.some((n) => hint.envNames?.includes(n)) ? 0 : 1) : 2);
  return all.filter((c) => !only || c.kind === only).sort((a, b) => hinted(a) - hinted(b));
}

export async function readDatabase({ root, env, hint = null, flags = {}, cap, since, exclude = [] }) {
  const connections = connectionsIn(env, { root, hint, only: flags.store });
  const tried = [];
  let near = null;
  for (const conn of connections) {
    if (conn.refused) { tried.push({ label: conn.store.label, host: conn.host, why: conn.refused }); continue; }
    let store;
    try {
      store = await conn.store.open(conn, { root, env });
      const places = await store.places({ want: flags.place });
      const found = places.map((p) => ({ ...p, f: fieldsOf(p.sample, flags.hints ?? {}) }));
      const chosen = choose(found, { place: flags.place, where: hint?.kind === conn.kind ? hint.where : null });
      if (chosen.ambiguous) return { ...chosen, store: { label: store.label, host: store.host } };
      if (chosen.missing || chosen.unknown) { near ??= { ...chosen, store: { label: store.label, host: store.host } }; continue; }
      if (!chosen.places) { tried.push({ label: store.label, host: store.host, why: places.length ? "no table or collection in it holds conversations" : "it holds nothing Cortad can read" }); continue; }
      const own = ownTexts(exclude);
      const conversations = [];
      for (const place of chosen.places) conversations.push(...await readPlace(store, place.name, { ...place.f, join: joinOf(place.f, found, place) }, { cap, since, own }));
      return { conversations: conversations.sort((a, b) => b.last - a.last), store: { label: store.label, host: store.host, kind: store.kind }, place: chosen.places.map((p) => p.name).join(", ") };
    } catch (error) {
      tried.push({ label: store?.label ?? conn.store.label, host: conn.host, why: error.message });
    } finally {
      await store?.close?.().catch(() => {});
    }
  }
  return near ?? { tried };
}

async function readPlace(store, place, f, { cap, since, own }) {
  const replies = (list) => list.reduce((n, c) => n + c.messages.filter((m) => m.role === "assistant").length, 0);
  let ours = 0;
  for (;;) {
    const got = await newest(store, place, f, { cap: cap + ours, since });
    const now = replies(got.filter((c) => isOwn(c, own)));
    if (now === ours || replies(got) < cap + ours) return got;
    ours = now;
  }
}

const fitOf = (sample, f) => (sample.length ? sample.filter((r) => conversationsOf([r], f).length).length / sample.length : 0);
const shapeOf = (f) => JSON.stringify([f.shape, f.conversation, f.role, f.text, f.at, f.question, f.answer, f.list]);

function choose(found, { place, where }) {
  if (place) {
    const named = found.find((p) => p.name === place || p.name.split(".").at(-1) === place);
    if (!named) return { unknown: place, names: found.map((p) => p.name) };
    return named.f.shape ? { places: [named] } : { missing: named.f.missing, name: named.name, paths: named.f.paths };
  }
  const usable = found.filter((p) => p.f.shape).map((p) => ({ ...p, hinted: where && p.name.split(".").at(-1) === where ? 1 : 0, fit: Math.round(fitOf(p.sample, p.f) * 10), score: placeScore(p.name), last: newestIn(p.sample, p.f) }));
  usable.sort((a, b) => b.hinted - a.hinted || b.fit - a.fit || b.score - a.score || b.last - a.last);
  const [top] = usable;
  if (!top) {

    const near = found.filter((p) => p.sample.length && !p.f.missing.includes("role")).sort((a, b) => a.f.missing.length - b.f.missing.length || placeScore(b.name) - placeScore(a.name))[0];
    return near ? { missing: near.f.missing, name: near.name, paths: near.f.paths } : {};
  }
  const same = usable.filter((p) => shapeOf(p.f) === shapeOf(top.f));
  const other = usable.find((p) => shapeOf(p.f) !== shapeOf(top.f));
  if (other && !top.hinted && other.fit === top.fit && other.score === top.score && Math.abs(top.last - other.last) < 86_400_000) return { ambiguous: usable.slice(0, 5).map((p) => ({ name: p.name, f: p.f })) };
  return { places: same };
}
