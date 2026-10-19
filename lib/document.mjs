// A reply that is a document, not a sentence: flashcards, a quiz, a mindmap, notes with sections.
// What the person sees is every item with its fields, so that is the reply. One rule with the
// backend's src/customer/document.ts: one customer's five flashcards were read as one card's back.

const PROSE = /\S\s+\S/;
// Fields the app keeps for itself: ids, flags, times. Never part of what the person reads.
const META = /^(?:id|ID|uuid|_id|\w+_id|[a-z]\w*Id|success|ok|timestamp|createdAt|updatedAt|created_at|updated_at)$/;
const REPLY_WORD = /^(?:reply|message|response|text|content|answer|output|result|chunk|token|delta|value)$/;
const FENCED = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/i;
// A turn of a conversation names its side under one of these, or as its own type ({"type":"ai"}).
const ROLE_KEY = /^(?:role|sender|from|author|speaker|who|side|type)$/i;
// The backend's turns.ts sides: the person's, the app's, and neither.
const SIDE = /^(?:user|human|learner|student|customer|client|person|visitor|guest|player|candidate|patient|member|caller|me|you|question|assistant|ai|bot|model|agent|npc|coach|tutor|teacher|mentor|advisor|expert|character|answer|gpt|llm|robot|system|developer|tool|function|event|log|meta|hint|error)$/i;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isScalar = (v) => typeof v === "string" || typeof v === "number";
const kept = (v) => v !== null && v !== undefined && typeof v !== "boolean" && v !== "" && !(Array.isArray(v) && !v.length) && !(isObject(v) && !Object.keys(v).length);
const fields = (row) => Object.entries(row).filter(([k, v]) => !META.test(k) && kept(v));
const isThread = (list) => list.length > 0 && list.every((t) => isObject(t) && Object.entries(t).some(([k, v]) => ROLE_KEY.test(k) && typeof v === "string" && SIDE.test(v)));
const readAt = (v, keys) => keys.reduce((o, k) => (Array.isArray(o) ? o[Number(k) < 0 ? o.length + Number(k) : Number(k)] : isObject(o) ? o[k] : undefined), v);

function proseLeaves(value) {
  if (typeof value === "string") return PROSE.test(value) ? 1 : 0;
  // A conversation is not a document: its reply is its newest turn.
  if (Array.isArray(value)) return isThread(value) ? 0 : value.reduce((n, v) => n + proseLeaves(v), 0);
  if (isObject(value)) return fields(value).reduce((n, [, v]) => n + proseLeaves(v), 0);
  return 0;
}

export const isDocument = (value) => (Array.isArray(value) || isObject(value)) && proseLeaves(value) >= 2;

const hang = (label, lines) => lines.map((line, i) => (i === 0 ? `${label} ${line}` : `${" ".repeat(label.length + 1)}${line}`));
function lines(value) {
  if (Array.isArray(value)) {
    const items = value.filter(kept);
    return items.every(isScalar) ? items.map((v) => `- ${v}`) : items.flatMap((v, i) => hang(`${i + 1}.`, lines(v)));
  }
  if (isObject(value)) return fields(value).flatMap(([k, v]) => (isScalar(v) ? [`${k}: ${v}`] : [`${k}:`, ...lines(v).map((l) => `  ${l}`)]));
  return [String(value)];
}

// Every item on its own lines with its field names, in order.
export const documentText = (value) => lines(value).join("\n");

// A text that is a JSON document, bare or fenced as a model writes it, read whole; any other as it is.
export function readable(text) {
  const body = FENCED.exec(text)?.[1] ?? text;
  if (!/^\s*[[{]/.test(body)) return text;
  try {
    const value = JSON.parse(body);
    return isDocument(value) ? documentText(value) : text;
  } catch {
    return text;
  }
}

// The document a path (a list of keys) into `value` lands in, read whole, or null when the path names
// a reply of its own: a path through an entry of a list of records, a field beside other things said
// that is not a chat envelope's answer field, or a list or object itself.
export function documentAt(value, keys) {
  if (!keys.length) return null;
  const at = readAt(value, keys);
  if ((Array.isArray(at) || isObject(at)) && isDocument(at)) return documentText(at);
  for (let i = 0; i < keys.length; i++) {
    const list = readAt(value, keys.slice(0, i));
    if (!Array.isArray(list) || !/^-?\d+$/.test(String(keys[i]))) continue;
    if (Number(keys[i]) < 0 || !list.some(isObject) || isThread(list)) return null;
    const holder = i > 0 ? readAt(value, keys.slice(0, i - 1)) : list;
    const whole = isObject(holder) && isDocument(holder) ? holder : list;
    return isDocument(whole) ? documentText(whole) : null;
  }
  if (REPLY_WORD.test(String(keys.at(-1)))) return null;
  const parent = readAt(value, keys.slice(0, -1));
  return isObject(parent) && isDocument(parent) ? documentText(parent) : null;
}
