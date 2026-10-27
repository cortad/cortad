// Reading a validator's refusal to learn what the route wanted. An app that says "messages must be
// an array" has told us its shape, and asking the person to write it out was asking them to read
// their own code back to us.
const FIELD = String.raw`[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`;
const q = `["'\`]?`;

const PATTERNS = [
  new RegExp(String.raw`${q}(${FIELD})${q}\s*(?:is\s+)?required`, "gi"),
  new RegExp(String.raw`missing\s+(?:required\s+)?(?:field|property|parameter|key)?\s*:?\s*${q}(${FIELD})${q}`, "gi"),
  new RegExp(String.raw`(?:expected|must be|invalid)[^."'\n]*\s(?:at|in|for)\s+(?:field|property|parameter|key)?\s*:?\s*${q}(${FIELD})${q}`, "gi"),
  new RegExp(String.raw`body\.(${FIELD})\s+(?:must|should|is|has)`, "gi"),
  new RegExp(String.raw`${q}(${FIELD})${q}\s*[:\-]\s*(?:invalid|expected|required|missing)`, "gi"),
  new RegExp(String.raw`body\.(${FIELD})`, "gi"),
];

// Words a refusal uses about itself rather than about a field. Taking one of these as a field name
// sent a body with a key called "request", which every route refused the same way.
const NOT_A_FIELD = /^(?:request|requests|value|values|field|fields|body|data|this|it|that|payload|json|params?|parameters?|arguments?|property|properties|key|keys|type|string|number|integer|array|list|object|boolean|required|missing|invalid|error|errors|detail|details)$/i;

export function fieldsWanted(text) {
  const found = new Set();
  for (const re of PATTERNS) {
    for (const hit of String(text).matchAll(re)) {
      const name = hit[1];
      if (name && !NOT_A_FIELD.test(name.split(".").pop())) found.add(name);
    }
  }
  return [...found].slice(0, 6);
}

// A field whose name says it holds the conversation. Filled with the placeholder instead of a
// value, so each conversation gets its own and the turns after the first one land on it. A fixed id
// here put every conversation on one thread, which is the same app answering itself.
const THREADS = /^(?:thread|conversation|session|chat|dialog|dialogue)(?:_?id)?$|_?(?:thread|conversation|session)_?id$/i;

// A field the refusal named, filled with something a validator will take. The point is to get past
// the door, not to be right about their domain.
export const fill = (name) =>
  THREADS.test(name) ? "{{thread}}"
    : /id$/i.test(name) ? "1"
    : /count|number|amount|limit/i.test(name) ? 1
    : /^is|^has|enabled$/i.test(name) ? true
    : "cortad";

export function withFields(body, fields) {
  const out = structuredClone(body);
  for (const name of fields) {
    const keys = name.split(".");
    let at = out;
    for (const key of keys.slice(0, -1)) {
      if (typeof at[key] !== "object" || at[key] === null) at[key] = {};
      at = at[key];
    }
    const leaf = keys.at(-1);
    if (at[leaf] === undefined) at[leaf] = fill(leaf);
  }
  return out;
}
