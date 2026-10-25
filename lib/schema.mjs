// What a run needs to know about an app: where to send a message, where the reply is in the answer,
// and the rules the app is supposed to keep. Everything else a run does is derived from this.

export const SCHEMA_FILE = "cortad.json";

const str = (v) => typeof v === "string" && v.trim().length > 0;
const list = (v) => Array.isArray(v) && v.every(str);

// A reply path is dotted keys and array indexes over the parsed answer: choices.0.message.content.
export function replyAt(answer, path) {
  let at = answer;
  for (const key of path.split(".")) {
    if (at == null) return null;
    at = at[Array.isArray(at) ? Number(key) : key];
  }
  return typeof at === "string" ? at : null;
}

// Where the message goes in the request body. The placeholder is replaced wherever it appears,
// however deep, so any body shape works without the schema describing the shape itself.
export const MESSAGE = "{{message}}";

export function withMessage(body, message) {
  if (typeof body === "string") return body === MESSAGE ? message : body.replaceAll(MESSAGE, message);
  if (Array.isArray(body)) return body.map((v) => withMessage(v, message));
  if (body && typeof body === "object") return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, withMessage(v, message)]));
  return body;
}

const holdsMessage = (body) => JSON.stringify(body ?? null).includes(MESSAGE);

export function problems(schema) {
  const found = [];
  if (!str(schema?.app)) found.push("app: one sentence saying what this app does for the people who use it");
  const door = schema?.endpoint;
  if (!str(door?.url)) found.push("endpoint.url: where a message is sent, for example http://localhost:3000/api/chat");
  else if (!/^https?:\/\//.test(door.url)) found.push("endpoint.url: must start with http:// or https://");
  if (door?.method && !/^(?:POST|PUT|PATCH|GET)$/.test(door.method)) found.push("endpoint.method: POST, PUT, PATCH or GET");
  if (!holdsMessage(door?.body)) found.push(`endpoint.body: the request your app takes, with ${MESSAGE} where the user's words go`);
  if (!str(door?.reply)) found.push("endpoint.reply: where the reply sits in the answer, for example choices.0.message.content");
  if (!list(schema?.rules) || schema.rules.length === 0) found.push("rules: at least one rule this app is supposed to keep, in your own words");
  if (schema?.users !== undefined && !list(schema.users)) found.push("users: each one a sentence describing someone who uses this app");
  if (schema?.tools !== undefined && !(Array.isArray(schema.tools) && schema.tools.every((t) => str(t?.name) && str(t?.does)))) {
    found.push("tools: each one { name, does }");
  }
  return found;
}

export function readSchema(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw new Error(`${SCHEMA_FILE} is not valid JSON: ${e.message}`); }
  const found = problems(parsed);
  if (found.length) throw new Error(`${SCHEMA_FILE} is missing what a run needs:\n  ${found.join("\n  ")}`);
  return {
    app: parsed.app.trim(),
    endpoint: {
      url: parsed.endpoint.url,
      method: parsed.endpoint.method ?? "POST",
      headers: parsed.endpoint.headers ?? {},
      body: parsed.endpoint.body,
      reply: parsed.endpoint.reply,
    },
    rules: parsed.rules.map((r) => r.trim()),
    tools: parsed.tools ?? [],
    users: parsed.users ?? [],
  };
}

export const SKELETON = {
  $schema: "https://cortad.com/cortad.schema.json",
  app: "",
  endpoint: {
    url: "http://localhost:3000/api/chat",
    method: "POST",
    headers: {},
    body: { messages: [{ role: "user", content: MESSAGE }] },
    reply: "choices.0.message.content",
  },
  rules: [],
  tools: [],
  users: [],
};
