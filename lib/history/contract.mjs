import { createHash } from "node:crypto";
import messages from "../message-text.cjs";
import { scrub } from "../redact.mjs";

const { messageText } = messages;

// Conversations from before, as any source hands them over, made into exactly what Cortad is sent:
// the person's and the app's messages, oldest first, with the app's own ids hashed on this machine.
// Newest conversations first and whole, from the last 30 days, until 2,500 messages as a plan counts
// them (the app's replies); the server holds the same line (backend src/field/history.ts).
export const HISTORY_MESSAGES = 2_500;
export const HISTORY_DAYS = 30;
const DAY_MS = 86_400_000;
const MAX_MESSAGES = 200;
const MAX_TEXT = 8_000;
const ROLES = { user: "user", human: "user", assistant: "assistant", ai: "assistant", bot: "assistant" };
// What the app itself knew about the user for a conversation (a grade, a subject), as the export
// carries it: the server takes 16 at most, each name a word or two and each value a short string.
const MAX_ATTRIBUTES = 16;
const MAX_VALUE = 200;
const ATTRIBUTE_NAME = /^[\p{L}\p{N} _.-]{1,64}$/u;

export function attributesOf(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const kept = Object.entries(raw)
    .filter(([name, value]) => ATTRIBUTE_NAME.test(name) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean") && String(value).trim())
    .slice(0, MAX_ATTRIBUTES)
    .map(([name, value]) => [name, cut(String(value).trim(), MAX_VALUE)]);
  return kept.length ? Object.fromEntries(kept) : null;
}

export const sha256 = (text) => createHash("sha256").update(String(text)).digest("hex");

// A time with its zone (ISO with Z or an offset) or epoch milliseconds; epoch seconds are read as
// such. A time with no zone is refused: read as this machine's local time it moves every message.
export function timeOf(value) {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value < 1e10 ? value * 1000 : value);
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) return null;
  const at = new Date(value.trim());
  return Number.isNaN(at.getTime()) ? null : at;
}

// Cut at a code point: a surrogate pair split in two is not text the wire takes.
const cut = (text, max) => {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max;
  return text.slice(0, end);
};


// One conversation as the contract has it, or the reason it is left out.
export function conversationOf(raw, count) {
  if (!raw || typeof raw !== "object") return count("unreadable");
  const id = typeof raw.id === "string" || typeof raw.id === "number" ? String(raw.id) : "";
  if (!id) return count("no id");
  const messages = [];
  for (const m of Array.isArray(raw.messages) ? raw.messages : []) {
    const role = ROLES[String(m?.role ?? "").toLowerCase()];
    if (!role) { count("not a person's or the app's message"); continue; }
    const at = timeOf(m.at ?? m.createdAt ?? m.created_at);
    if (!at) { count("a time with no zone"); continue; }
    const text = messageText(m.text ?? m.content).trim();
    if (!text) continue;
    if (text.length > MAX_TEXT) count("message cut at 8,000 characters");
    messages.push({ role, text: cut(text, MAX_TEXT), at });
  }
  if (messages.length === 0) return count("no messages");
  messages.sort((a, b) => a.at - b.at);
  if (messages.length > MAX_MESSAGES) count("conversation kept to its latest 200 messages");
  const kept = messages.slice(-MAX_MESSAGES);
  const attributes = attributesOf(raw.attributes);
  return { id, ...(raw.user ? { user: String(raw.user) } : {}), ...(attributes ? { attributes } : {}), messages: kept, last: kept.at(-1).at };
}

// The conversations to send, newest first, whole, from the window, until the messages asked for
// (`cap`, never past the plan's); and why each one left out was left out.
// `key`: the app's ingest key. Ids and users are hashed with it exactly as the SDK hashes them, so a
// person brought in from history is the same person when they write to the live app, and a guessable
// id (a first name, an email) cannot be read back from its hash without the key.
export function selected(raws, { now = Date.now(), secrets = [], key, cap = HISTORY_MESSAGES }) {
  const most = Math.min(cap, HISTORY_MESSAGES);
  const subject = (kind, value) => sha256(`${key}:${kind}:${value}`);
  const left = new Map();
  const count = (why) => { left.set(why, (left.get(why) ?? 0) + 1); return null; };
  const all = raws.map((raw) => conversationOf(raw, count)).filter(Boolean);
  const byId = new Map();
  for (const c of all) if (!byId.has(c.id) || byId.get(c.id).last < c.last) byId.set(c.id, c);
  const recent = [...byId.values()].filter((c) => c.last.getTime() >= now - HISTORY_DAYS * DAY_MS || count("older than 30 days"));
  recent.sort((a, b) => b.last - a.last);
  const out = [];
  let room = most;
  let scrubbed = 0;
  for (const c of recent) {
    const replies = c.messages.filter((m) => m.role === "assistant").length;
    if (replies > room) { count(`past ${most.toLocaleString("en-US")} messages`); continue; }
    room -= replies;
    out.push({
      id: subject("session", c.id),
      ...(c.user ? { user: subject("user", c.user) } : {}),
      // Scrubbed like the messages: a value is the app's own text and could hold a key.
      ...(c.attributes ? { attributes: Object.fromEntries(Object.entries(c.attributes).map(([k, v]) => { const clean = scrub(v, secrets); scrubbed += clean.hits; return [k, clean.text]; })) } : {}),
      messages: c.messages.map((m) => {
        const clean = scrub(m.text, secrets);
        scrubbed += clean.hits;
        return { role: m.role, text: clean.text, at: m.at.toISOString() };
      }),
    });
  }
  return { conversations: out, messages: most - room, total: out.reduce((n, c) => n + c.messages.length, 0), scrubbed, left: Object.fromEntries(left), users: new Set(recent.map((c) => c.user).filter(Boolean)).size };
}

// The span of what will be sent, oldest message to newest.
export function spanOf(conversations) {
  let from = null;
  let to = null;
  for (const c of conversations) for (const m of c.messages) {
    if (!from || m.at < from) from = m.at;
    if (!to || m.at > to) to = m.at;
  }
  return { from, to };
}

// Whether what was read looks like a developer's copy rather than the live app's: a database on this
// computer or in a container beside it, a handful of conversations, nothing recent, or one person
// writing nearly all of them. Sending that would show the owner their own tests as their users.
export function looksLikeDevelopment({ host, conversations, users, now = Date.now() }) {
  if (host && (/^(localhost|127\.|0\.0\.0\.0|::1|\[::1\]|host\.docker\.internal)/i.test(host) || !host.includes("."))) return `it was read from ${host}, which is on this computer`;
  if (conversations.length < 20) return `there are only ${conversations.length} conversations`;
  const newest = Math.max(...conversations.map((c) => Date.parse(c.messages.at(-1).at)));
  if (now - newest > 7 * DAY_MS) return "none of them is from the last 7 days";
  if (users === 1 && conversations.length >= 20) return "one person wrote all of them";
  return null;
}
