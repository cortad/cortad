import { at, keyOf, listOf, msOf, roleOf, textOf } from "./values.mjs";
import { needed } from "./fields.mjs";

const LIGHT_PAGE = 5_000;
const DOC_PAGE = 200;
const CHUNK = 100;

export class Unordered extends Error {}

async function* pages(store, ask, from = null) {
  let cursor = from;
  for (;;) {
    const got = await store.page({ ...ask, cursor });
    if (got.records.length) yield got.records;
    if (got.next == null) return;
    cursor = got.next;
  }
}

async function ordered(store, ask) {
  try {
    const first = await store.page({ ...ask, cursor: null });
    return (async function* rest() {
      if (first.records.length) yield first.records;
      if (first.next != null) yield* pages(store, ask, first.next);
    })();
  } catch (error) {
    if (error instanceof Unordered) return null;
    throw error;
  }
}

const asks = (c) => c.messages.filter((m) => m.role === "user").length;

export function conversationsOf(records, f) {
  const out = new Map();
  const held = (id, record) => {
    if (!out.has(id)) out.set(id, { id, messages: [] });
    const c = out.get(id);
    const user = f.user ? at(record, f.user) : null;
    if (!c.user && user != null && user !== "") c.user = keyOf(user);
    return c;
  };
  const push = (c, role, text, ms) => { if (role && text && ms !== null) c.messages.push({ role, text, at: ms }); };
  records.forEach((r, i) => {
    if (f.shape === "messages") {
      const id = keyOf(at(r, f.conversation));
      if (id) push(held(id, r), roleOf(at(r, f.role), f.role), textOf(at(r, f.text)), msOf(at(r, f.at)));
    } else if (f.shape === "turns") {
      const ms = msOf(at(r, f.at));
      const c = held(keyOf(f.conversation ? at(r, f.conversation) : r.__id ?? `row-${i}`), r);
      push(c, "user", textOf(at(r, f.question)), ms);
      push(c, "assistant", textOf(at(r, f.answer)), ms === null ? null : ms + 1);
    } else {
      const id = keyOf(at(r, f.conversation));
      if (!id) return;
      const c = held(id, r);
      const docMs = f.at ? msOf(at(r, f.at)) : null;
      (listOf(at(r, f.list.path)) ?? []).forEach((m, n) => {
        if (!m || typeof m !== "object") return;
        const ms = f.list.at ? msOf(at(m, f.list.at)) : null;
        push(c, roleOf(at(m, f.list.role), f.list.role), textOf(at(m, f.list.text)), ms ?? (docMs === null ? null : docMs + n));
      });
    }
  });
  const list = [...out.values()].filter((c) => c.messages.length);
  for (const c of list) {
    c.messages.sort((a, b) => a.at - b.at);
    c.last = c.messages.at(-1).at;
    c.messages = c.messages.map((m) => ({ ...m, at: new Date(m.at).toISOString() }));
  }
  return list.sort((a, b) => b.last - a.last);
}

export async function newest(store, place, f, { cap, since }) {
  const done = [];
  let total = 0;
  const take = (convs) => {
    for (const c of convs) {
      if (total >= cap || c.last < since) return false;
      done.push(c);
      total += asks(c);
    }
    return total < cap;
  };
  const fetchWhole = async (raws) => {
    for (let i = 0; i < raws.length; i += CHUNK) {
      const records = await store.where({ place, field: f.conversation, values: raws.slice(i, i + CHUNK), fields: needed(f, { light: false }) });
      if (!take(conversationsOf(records, f))) return;
    }
  };

  if (f.shape === "documents" || (f.shape === "turns" && !f.conversation)) {
    const whole = f.at && await ordered(store, { place, fields: needed(f, { light: false }), order: f.at, limit: DOC_PAGE });
    if (whole) {
      for await (const records of whole) if (!take(conversationsOf(records, f))) break;
    } else if (f.at && f.shape === "documents") {
      const index = [];
      for await (const records of pages(store, { place, fields: needed(f, { light: true }), order: null, limit: LIGHT_PAGE })) {
        for (const r of records) { const ms = msOf(at(r, f.at)); if (ms !== null && ms >= since) index.push({ raw: at(r, f.conversation), ms }); }
      }
      await fetchWhole(index.sort((a, b) => b.ms - a.ms).map((x) => x.raw));
    } else {

      const all = [];
      for await (const records of pages(store, { place, fields: null, order: null, limit: DOC_PAGE })) all.push(...conversationsOf(records, f));
      take(all.sort((a, b) => b.last - a.last));
    }
    return done;
  }

  const light = needed(f, { light: true });
  const seen = new Map();
  let counted = 0;
  const note = (r) => {
    const raw = at(r, f.conversation);
    const ms = msOf(at(r, f.at));
    if (raw == null || ms === null) return;
    const key = keyOf(raw);
    const one = seen.get(key) ?? { raw, last: ms, asks: 0 };
    one.last = Math.max(one.last, ms);
    const ask = f.shape === "turns" || roleOf(at(r, f.role), f.role) === "user";
    if (ask) { one.asks += 1; counted += 1; }
    seen.set(key, one);
  };
  const stream = await ordered(store, { place, fields: light, order: f.at, limit: LIGHT_PAGE });
  if (stream) {
    outer: for await (const records of stream) {
      for (const r of records) {
        const ms = msOf(at(r, f.at));
        if (ms !== null && ms < since) break outer;
        note(r);
        if (counted >= cap) break outer;
      }
    }
  } else {
    for await (const records of pages(store, { place, fields: light, order: null, limit: LIGHT_PAGE })) records.forEach(note);
  }
  const chosen = [];
  let room = cap;
  for (const one of [...seen.values()].filter((x) => x.last >= since).sort((a, b) => b.last - a.last)) {
    if (room <= 0) break;
    chosen.push(one.raw);
    room -= Math.max(one.asks, 1);
  }
  await fetchWhole(chosen);
  if (f.join && done.length) await joinUsers(store, f.join, done, chosen);
  return done.sort((a, b) => b.last - a.last);
}

async function joinUsers(store, join, conversations, raws) {
  const users = new Map();
  for (let i = 0; i < raws.length; i += CHUNK) {
    for (const r of await store.where({ place: join.place, field: join.id, values: raws.slice(i, i + CHUNK), fields: [join.id.split(".")[0], join.user.split(".")[0]] })) {
      const user = at(r, join.user);
      if (user != null && user !== "") users.set(keyOf(at(r, join.id)), keyOf(user));
    }
  }
  for (const c of conversations) if (!c.user && users.has(c.id)) c.user = users.get(c.id);
}
