import { said } from "./langfuse.mjs";
import { answered, grouped, rootOf } from "./vendor.mjs";

const PAGE = 100;
const MAX_SPANS = 3_000;
const OTLP_PATH = /\/+v1\/traces\/?$/;

export const PHOENIX = {
  id: "phoenix",
  name: "Phoenix",
  needs: ["PHOENIX_COLLECTOR_ENDPOINT"],

  hostOf: (env) => env.PHOENIX_ENDPOINT || env.PHOENIX_COLLECTOR_ENDPOINT?.replace(OTLP_PATH, "") || "http://localhost:6006",
  read: readPhoenix,
};

export function messagesIn(attributes, prefix) {
  const byIndex = new Map();
  for (const [key, value] of Object.entries(attributes ?? {})) {
    const part = key.startsWith(`${prefix}.`) && /^(\d+)\.message\.(role|content)$/.exec(key.slice(prefix.length + 1));
    if (part) byIndex.set(Number(part[1]), { ...byIndex.get(Number(part[1])), [part[2]]: value });
  }
  return [...byIndex].sort(([a], [b]) => a - b).map(([, message]) => message);
}

export function valueIn(attributes, kind) {
  const value = attributes?.[`${kind}.value`];
  if (attributes?.[`${kind}.mime_type`] !== "application/json" || typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

export async function readPhoenix({ env, since, fetchImpl = fetch }) {
  const root = rootOf(PHOENIX.hostOf(env));
  const project = encodeURIComponent(env.PHOENIX_PROJECT || env.PHOENIX_PROJECT_NAME || "default");
  const headers = env.PHOENIX_API_KEY ? { authorization: `Bearer ${env.PHOENIX_API_KEY}` } : {};
  const spans = [];
  for (let cursor = null; spans.length < MAX_SPANS;) {
    const query = new URLSearchParams({ parent_id: "null", sort: "start_time", order: "desc", start_time: since.toISOString(), limit: String(PAGE), ...(cursor ? { cursor } : {}) });
    const page = await answered(fetchImpl, `${root}/v1/projects/${project}/spans?${query}`, { headers }, "PHOENIX");
    spans.push(...(page.data ?? []));
    cursor = page.next_cursor;
    if (!cursor) break;
  }
  const { conversations, withoutText } = grouped(spans.map(({ attributes: a = {}, context, start_time: at }) => ({
    conversation: a["session.id"] || context?.trace_id,
    user: a["user.id"],
    at,
    question: said(messagesIn(a, "llm.input_messages"), "user") || said(valueIn(a, "input"), "user"),
    answer: said(messagesIn(a, "llm.output_messages"), "assistant") || said(valueIn(a, "output"), "assistant"),
  })));
  return { conversations, host: new URL(root).host, read: spans.length, withoutText };
}
