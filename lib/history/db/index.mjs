import { fieldsOf, joinOf, placeScore } from "./fields.mjs";
import { newest } from "./newest.mjs";
import { at, listOf, msOf } from "./values.mjs";
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
import { PENDING } from "./pending.mjs";
import { WEAVIATE } from "./weaviate.mjs";

// The app's own database, found from its env and read on this machine: which store, which place in
// it, which fields, then its newest conversations. Every store here is read and never written.
export const STORES = [POSTGRES, MYSQL, MSSQL, SQLITE, LIBSQL, MONGO, FIRESTORE, DYNAMO, POSTGREST, REDIS, CASSANDRA, COUCH, SEARCH, QDRANT, WEAVIATE, CHROMA, MILVUS, PINECONE];
export const KINDS = [...STORES, ...PENDING].map((s) => s.kind);

const newestIn = (sample, f) => Math.max(0, ...sample.flatMap((r) => [msOf(at(r, f.at)), ...(f.list?.at ? (listOf(at(r, f.list.path)) ?? []).map((m) => msOf(at(m, f.list.at))) : [])]).filter((ms) => ms !== null));

// `hint`: where Cortad's read of this repository says the conversations are ({ kind, where, envNames }).
export function connectionsIn(env, { root, hint = null, only = null } = {}) {
  const all = [...STORES, ...PENDING].flatMap((store) => {
    try { return store.find(env, root).map((conn) => ({ ...conn, store })); } catch (error) { return [{ kind: store.kind, host: "", envNames: [], store, refused: error.message }]; }
  });
  const hinted = (c) => (hint && c.kind === hint.kind ? (c.envNames.some((n) => hint.envNames?.includes(n)) ? 0 : 1) : 2);
  return all.filter((c) => !only || c.kind === only).sort((a, b) => hinted(a) - hinted(b));
}

// What was read, or why nothing was: { conversations, store, place } or { tried, ambiguous, missing }.
export async function readDatabase({ root, env, hint = null, flags = {}, cap, since }) {
  const connections = connectionsIn(env, { root, hint, only: flags.store });
  const tried = [];
  const pending = [];
  let near = null;
  for (const conn of connections) {
    if (conn.store.pending) { pending.push({ label: conn.store.label, envNames: conn.envNames }); continue; }
    if (conn.refused) { tried.push({ label: conn.store.label, host: conn.host, why: conn.refused }); continue; }
    let store;
    try {
      store = await conn.store.open(conn, { root, env });
      const places = await store.places({ want: flags.place });
      const found = places.map((p) => ({ ...p, f: fieldsOf(p.sample, flags.hints ?? {}) }));
      const chosen = choose(found, { place: flags.place, where: hint?.kind === conn.kind ? hint.where : null });
      if (chosen.ambiguous) return { ...chosen, store: { label: store.label, host: store.host } };
      if (chosen.missing || chosen.unknown) { near ??= { ...chosen, store: { label: store.label, host: store.host } }; continue; }
      if (!chosen.place) { tried.push({ label: store.label, host: store.host, why: places.length ? "no table or collection in it holds conversations" : "it holds nothing Cortad can read" }); continue; }
      const f = { ...chosen.place.f, join: joinOf(chosen.place.f, found, chosen.place) };
      const conversations = await newest(store, chosen.place.name, f, { cap, since });
      return { conversations, store: { label: store.label, host: store.host, kind: store.kind }, place: chosen.place.name };
    } catch (error) {
      tried.push({ label: store?.label ?? conn.store.label, host: conn.host, why: error.message });
    } finally {
      await store?.close?.().catch(() => {});
    }
  }
  return near ?? { tried, pending };
}

// The place to read: the one named, else the one Cortad's read of the code named, else the most
// conversation-like name, then the most recent. Two equally likely and both in use are asked about.
function choose(found, { place, where }) {
  if (place) {
    const named = found.find((p) => p.name === place || p.name.split(".").at(-1) === place);
    if (!named) return { unknown: place, names: found.map((p) => p.name) };
    return named.f.shape ? { place: named } : { missing: named.f.missing, name: named.name, paths: named.f.paths };
  }
  const usable = found.filter((p) => p.f.shape).map((p) => ({ ...p, hinted: where && p.name.split(".").at(-1) === where ? 1 : 0, score: placeScore(p.name), last: newestIn(p.sample, p.f) }));
  usable.sort((a, b) => b.hinted - a.hinted || b.score - a.score || b.last - a.last);
  const [top, second] = usable;
  if (top && second && !top.hinted && top.score === second.score && Math.abs(top.last - second.last) < 86_400_000) return { ambiguous: usable.slice(0, 5).map((p) => ({ name: p.name, f: p.f })) };
  if (top) return { place: top };
  const near = found.filter((p) => placeScore(p.name) > 0 && p.sample.length).sort((a, b) => placeScore(b.name) - placeScore(a.name))[0];
  return near ? { missing: near.f.missing, name: near.name, paths: near.f.paths } : {};
}
