import messages from "../../message-text.cjs";
import { scrubValue } from "../../redact.mjs";

const { messageText } = messages;

const YEAR_2000 = 946_684_800_000;
const YEAR_2100 = 4_102_444_800_000;
const NO_ZONE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;

const plausible = (ms) => (Number.isFinite(ms) && ms >= YEAR_2000 && ms < YEAR_2100 ? ms : null);

export function msOf(value) {
  if (value == null) return null;
  if (value instanceof Date) return plausible(value.getTime());
  if (typeof value === "bigint") return msOf(Number(value));
  if (typeof value === "number") {
    for (const scale of [1000, 1, 1e-3, 1e-6]) {
      const ms = plausible(value * scale);
      if (ms !== null) return ms;
    }
    return null;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(s)) return msOf(Number(s));
    return plausible(Date.parse(NO_ZONE.test(s) ? `${s.replace(" ", "T")}Z` : s));
  }
  if (typeof value === "object") {
    if ("$date" in value) return msOf(typeof value.$date === "object" ? value.$date.$numberLong : value.$date);
    const seconds = value.seconds ?? value._seconds;
    if (seconds != null) return plausible(Number(seconds) * 1000 + Math.floor(Number(value.nanos ?? value.nanoseconds ?? value._nanoseconds ?? 0) / 1e6));
  }
  return null;
}

const USER = new Set(["user", "human", "customer", "person", "client", "visitor", "me", "student", "patient", "guest", "member", "usermessage", "humanmessage"]);
const ASSISTANT = new Set(["assistant", "ai", "bot", "model", "agent", "chatbot", "gpt", "llm", "aimessage", "assistantmessage", "botmessage", "copilot"]);

const FLAG_USER = /^(?:is|from|by|iscreatedby|createdby|sentby|isfrom)(?:user|human|customer)$|^userwrote$/;
const FLAG_APP = /^(?:is|from|by)(?:bot|ai|assistant|model|agent)$|^bot$|^ai$/;

export const squash = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
const leaf = (path) => squash(String(path).split(".").at(-1));

export function roleOf(value, field = "") {
  if (typeof value === "boolean") {
    if (FLAG_USER.test(leaf(field))) return value ? "user" : "assistant";
    if (FLAG_APP.test(leaf(field))) return value ? "assistant" : "user";
    return null;
  }
  if (typeof value !== "string") return null;
  const word = squash(value);
  return USER.has(word) ? "user" : ASSISTANT.has(word) ? "assistant" : null;
}
export const isFlag = (field) => FLAG_USER.test(leaf(field)) || FLAG_APP.test(leaf(field));
export const FLAG = new RegExp(`${FLAG_USER.source}|${FLAG_APP.source}`);

export function textOf(value) {
  if (value == null) return "";
  if (typeof value === "string") {
    const s = value.trim();
    if (/^[[{]/.test(s)) {
      try {
        const parsed = JSON.parse(s);
        if (parsed && typeof parsed === "object") return messageText(parsed, scrubValue).trim();
      } catch {  }
    }
    return s;
  }
  if (typeof value === "object" && !Array.isArray(value) && typeof value.content !== "undefined" && !value.type) return textOf(value.content);
  return messageText(value, scrubValue).trim();
}

export function listOf(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : null; } catch { return null; }
  }
  return null;
}

export function at(record, path) {
  let value = record;
  for (const part of String(path).split(".")) {
    if (typeof value === "string" && /^\s*\{/.test(value)) { try { value = JSON.parse(value); } catch { return undefined; } }
    if (value == null || typeof value !== "object") return undefined;
    value = value[part];
  }
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function keyOf(value) {
  if (typeof value === "string" && UUID.test(value)) return value.toLowerCase();
  if (value == null) return "";
  if (typeof value === "object") {
    if (typeof value.$oid === "string") return value.$oid;
    if (typeof value.toHexString === "function") return value.toHexString();
    if (Buffer.isBuffer(value)) return value.toString("hex");
  }
  return String(value);
}

export function pathsOf(record, depth = 3) {
  const out = new Map();
  const walk = (value, prefix, left) => {
    for (const [key, v] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      out.set(path, v);
      let inner = v;
      if (typeof v === "string" && /^\s*\{/.test(v) && v.length < 100_000) { try { inner = JSON.parse(v); } catch { inner = null; } }
      if (left > 1 && inner && typeof inner === "object" && !Array.isArray(inner) && !(inner instanceof Date) && !Buffer.isBuffer(inner) && !inner._bsontype && !("$oid" in inner) && !("$date" in inner)) walk(inner, path, left - 1);
    }
  };
  if (record && typeof record === "object") walk(record, "", depth);
  return out;
}
