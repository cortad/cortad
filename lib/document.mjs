const PROSE = /\S\s+\S/;

const META = /^(?:id|ID|uuid|_id|\w+_id|[a-z]\w*Id|success|ok|timestamp|createdAt|updatedAt|created_at|updated_at)$/;
const REPLY_WORD = /^(?:reply|message|response|text|content|answer|output|result|chunk|token|delta|value)$/;
const FENCED = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/i;

const ROLE_KEY = /^(?:role|sender|from|author|speaker|who|side|type)$/i;

const SIDE = /^(?:user|human|learner|student|customer|client|person|visitor|guest|player|candidate|patient|member|caller|me|you|question|assistant|ai|bot|model|agent|npc|coach|tutor|teacher|mentor|advisor|expert|character|answer|gpt|llm|robot|system|developer|tool|function|event|log|meta|hint|error)$/i;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isScalar = (v) => typeof v === "string" || typeof v === "number";
const kept = (v) => v !== null && v !== undefined && typeof v !== "boolean" && v !== "" && !(Array.isArray(v) && !v.length) && !(isObject(v) && !Object.keys(v).length);
const fields = (row) => Object.entries(row).filter(([k, v]) => !META.test(k) && kept(v));
const isThread = (list) => list.length > 0 && list.every((t) => isObject(t) && Object.entries(t).some(([k, v]) => ROLE_KEY.test(k) && typeof v === "string" && SIDE.test(v)));
const readAt = (v, keys) => keys.reduce((o, k) => (Array.isArray(o) ? o[Number(k) < 0 ? o.length + Number(k) : Number(k)] : isObject(o) ? o[k] : undefined), v);

function proseLeaves(value) {
  if (typeof value === "string") return PROSE.test(value) ? 1 : 0;

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

export const documentText = (value) => lines(value).join("\n");

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
