import { at, FLAG, isFlag, listOf, msOf, pathsOf, roleOf, squash, textOf } from "./values.mjs";

const NAMES = {
  conversation: [/^(?:conversation|convo|thread|chat|session|dialog|dialogue|chatsession|chatthread)(?:id|uuid|key)?$/, /(?:conversation|thread|chat|session)(?:id|uuid)$/, /^(?:room|channel)id$/],
  user: [/^(?:user|uid|owner|customer|account|member|visitor|client|person|profile|sender|author)(?:id|uuid|key)$/, /^(?:user|uid|owner|userid|useremail|email)$/, /(?:user|customer|owner)(?:id|uuid)$/],
  role: [/^(?:role|sender|author|from|speaker|messagetype|sendertype|authortype|authorrole|senderrole|actor|who)$/, FLAG, /^(?:type|kind|source|by|origin)$/, /(?:role|sender|author)$/],
  text: [/^(?:content|text|message|body|msg|parts|messagetext|messagecontent|contenttext|textcontent|value)$/, /^(?:document|pagecontent)$/, /(?:content|text|message|body)$/],
  at: [/^(?:createdat|created|createdon|createdtime|createddate|creationdate|creationtime|timestamp|ts|time|at|sentat|insertedat|date|datetime|messagetime|messagedate|addedat)$/, /^(?:updatedat|updated|lastmessageat|lastupdated|modifiedat|lastactivityat|lastmodified)$/, /(?:time|date|at|timestamp)$/],
  list: [/^(?:messages|history|chathistory|turns|transcript|conversation|dialog|dialogue|chat|entries|msgs|log|thread|exchanges|interactions|items|content)$/],
};

const DOC_AT = [NAMES.at[1], NAMES.at[0], NAMES.at[2]];
const PAIRS = [["question", "answer"], ["prompt", "response"], ["prompt", "completion"], ["query", "response"], ["query", "answer"], ["input", "output"],
  ["usermessage", "botmessage"], ["usermessage", "assistantmessage"], ["usermessage", "airesponse"], ["usermessage", "response"], ["usermessage", "reply"],
  ["userinput", "airesponse"], ["userinput", "botresponse"], ["userinput", "response"], ["userinput", "output"], ["request", "response"], ["human", "ai"], ["usermsg", "botmsg"]];
const HINTS = ["conversation", "user", "role", "text", "at"];
const PLACE = /(?:^|[_.\-/:])(?:chats?|chat_?history|messages?|conversations?|threads?|turns?|history|transcripts?|dialogs?|sessions?)(?:[_.\-/:]|$)|message|conversation|chat/i;

const leaf = (path) => squash(path.split(".").at(-1));
const share = (records, path, test) => {
  let seen = 0;
  let ok = 0;
  for (const r of records) {
    const v = at(r, path);
    if (v == null || v === "") continue;
    seen += 1;
    if (test(v, path)) ok += 1;
  }
  return seen ? ok / seen : 0;
};
const isTime = (v) => msOf(v) !== null;
const isText = (v) => typeof v !== "boolean" && typeof v !== "number" && textOf(v).length > 0;
const isRole = (v, path) => roleOf(v, path) !== null;
const isId = (v) => (typeof v === "string" && v.length > 0 && v.length <= 200) || typeof v === "number" || typeof v === "bigint" || (v && typeof v === "object" && (typeof v.toHexString === "function" || typeof v.$oid === "string"));

function best(paths, records, patterns, test, { min = 0.8, taken = [] } = {}) {
  for (const pattern of patterns) {
    const named = paths.filter((p) => !taken.includes(p) && pattern.test(leaf(p))).sort((a, b) => a.split(".").length - b.split(".").length);
    const good = named.find((p) => share(records, p, test) >= min);
    if (good) return good;
  }
  return null;
}

const ROLE_TEST = (v, path) => (typeof v === "boolean" ? isFlag(path) : isRole(v, path));

const spoken = (paths, records) => paths.find((p) => share(records, p, isRole) >= 0.6 && new Set(records.map((r) => roleOf(at(r, p), p)).filter(Boolean)).size === 2) ?? null;

function messageList(paths, records, hint) {
  const lists = (hint ? [hint] : paths).filter((p) => records.some((r) => (listOf(at(r, p)) ?? []).some((m) => m && typeof m === "object")));
  const ranked = hint ? lists : NAMES.list.flatMap((pattern) => lists.filter((p) => pattern.test(leaf(p)))).concat(lists);
  for (const path of [...new Set(ranked)]) {
    const items = records.flatMap((r) => (listOf(at(r, path)) ?? []).filter((m) => m && typeof m === "object")).slice(0, 200);
    const inner = [...new Set(items.flatMap((m) => [...pathsOf(m, 3).keys()]))];
    const role = best(inner, items, NAMES.role, ROLE_TEST, { min: 0.6 });
    const text = best(inner, items, NAMES.text, isText, { min: 0.6 });
    if (role && text) return { path, role, text, at: best(inner, items, NAMES.at, isTime) };
  }
  return null;
}

export function fieldsOf(records, hints = {}) {
  const paths = [...new Set(records.flatMap((r) => [...pathsOf(r).keys()]))].filter((p) => p !== "__id" || hints.conversation === "__id");
  const pick = (meaning, patterns, test, opts) => (hints[meaning] ? hints[meaning] : best(paths, records, patterns, test, opts));

  const conversation = pick("conversation", NAMES.conversation, isId) ?? (records.length && records.every((r) => r.__parent != null) ? "__parent" : null);
  const user = pick("user", NAMES.user, isId, { taken: [conversation] });

  const role = pick("role", NAMES.role, ROLE_TEST, { min: 0.6 }) ?? (hints.role ? null : spoken(paths, records));
  const text = pick("text", NAMES.text, isText, { taken: [role] });
  const time = pick("at", NAMES.at, isTime);
  if (role && text && time && conversation) return { shape: "messages", conversation, user, role, text, at: time };

  const list = messageList(paths, records, hints.text && records.some((r) => listOf(at(r, hints.text))) ? hints.text : null);
  if (list) {
    const docAt = hints.at ?? best(paths, records, DOC_AT, isTime);
    const id = records.every((r) => r.__id != null) ? "__id" : paths.find((p) => ["id", "_id", "uuid", "key"].includes(leaf(p)));
    if ((list.at || docAt) && (conversation || id)) return { shape: "documents", conversation: hints.conversation ?? conversation ?? id, user, list, at: docAt };
  }

  const leafs = new Map(paths.map((p) => [leaf(p), p]));
  for (const [q, a] of PAIRS) {
    const question = leafs.get(q);
    const answer = leafs.get(a);
    if (question && answer && share(records, question, isText) >= 0.6 && time) return { shape: "turns", conversation, user, question, answer, at: time };
  }
  return { missing: missingOf({ conversation, role, text, at: time, list }), paths };
}

function missingOf({ conversation, role, text, at: time, list }) {
  if (list) return ["at"];
  return [!conversation && "conversation", !role && "role", !text && "text", !time && "at"].filter(Boolean);
}

export const hintsFrom = (value) => Object.fromEntries(HINTS.map((h) => [h, value(`--${h}`)]).filter(([, v]) => v));
export const placeScore = (name) => (PLACE.test(name) ? (/message/i.test(name) ? 2 : 1) : 0);

export const PROBE = 200;
export const probed = (items, want, nameOf = (x) => x) => [...items].sort((a, b) => Number(nameOf(b) === want) - Number(nameOf(a) === want) || placeScore(nameOf(b)) - placeScore(nameOf(a))).slice(0, PROBE);

export async function sampleEach(items, fn, width = 8) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

export const namesScore = (names) => ["conversation", "role", "text", "at", "list"].filter((m) => names.some((n) => NAMES[m].some((p) => p.test(leaf(n))))).length;

export function needed(f, { light }) {
  const tops = (paths) => [...new Set(paths.filter(Boolean).map((p) => p.split(".")[0]))];
  if (f.shape === "documents") return light && f.at ? tops([f.conversation, f.at]) : null;
  if (f.shape === "turns") return tops([f.conversation, f.at, ...(light ? [] : [f.user, f.question, f.answer])]);
  return tops([f.conversation, f.at, f.role, ...(light ? [] : [f.user, f.text])]);
}

export function joinOf(f, places, place = null) {
  if (f.user || !f.conversation || f.shape === "documents") return null;
  const stem = leaf(f.conversation).replace(/(?:id|uuid|key)$/, "");
  const nameOf = (p) => squash(p.name.split(".").at(-1)).replace(/s$/, "");
  const parents = f.conversation === "__parent" ? places.filter((p) => p.name === place?.parent && p.sample.length)
    : places.filter((p) => p.sample.length && stem && nameOf(p).endsWith(stem)).sort((a, b) => nameOf(a).length - nameOf(b).length);
  for (const p of parents) {
    const paths = [...new Set(p.sample.flatMap((r) => [...pathsOf(r, 1).keys()]))];
    const id = paths.find((x) => ["id", "_id", "uuid"].includes(squash(x))) ?? (p.sample.every((r) => r.__id != null) ? "__id" : null);
    const user = best(paths, p.sample, NAMES.user, isId, { taken: [id] });
    if (id && user) return { place: p.name, id, user };
  }
  return null;
}
