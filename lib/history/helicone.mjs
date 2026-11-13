import { said } from "./langfuse.mjs";
import { addressOf, answered, grouped, rootOf } from "./vendor.mjs";

const PAGE = 100;
const MAX_REQUESTS = 3_000;
const NOT_A_CHAT = /\/(?:embeddings|moderations)(?:$|[/?])/;

export const HELICONE = {
  id: "helicone",
  name: "Helicone",
  needs: ["HELICONE_API_KEY"],

  hostOf: (env) => (env.HELICONE_API_KEY?.startsWith("sk-helicone-eu-") ? "https://eu.api.helicone.ai" : "https://api.helicone.ai"),
  read: readHelicone,
};

export function inline(body) {
  let value = body;
  if (typeof body === "string") {
    try { value = JSON.parse(body); } catch { return body; }
  }
  return value && typeof value === "object" && "helicone_message" in value ? undefined : value;
}

async function bodiesOf(row, fetchImpl) {
  if (!row.signed_body_url) return { request: inline(row.request_body), response: inline(row.response_body) };
  const stored = await answered(fetchImpl, addressOf(row.signed_body_url).href, {}, null);
  return { request: stored?.request, response: stored?.response };
}

export async function readHelicone({ env, since, fetchImpl = fetch }) {
  const root = rootOf(HELICONE.hostOf(env));
  const headers = { authorization: `Bearer ${env.HELICONE_API_KEY}`, "content-type": "application/json" };
  const filter = { request_response_rmt: { request_created_at: { gte: since.toISOString() } } };
  const turns = [];
  let read = 0;
  for (let offset = 0; offset < MAX_REQUESTS; offset += PAGE) {
    const body = JSON.stringify({ filter, offset, limit: PAGE, sort: { created_at: "desc" } });
    const page = await answered(fetchImpl, `${root}/v1/request/query-clickhouse`, { method: "POST", headers, body }, "HELICONE");
    const rows = page.data ?? [];
    read += rows.length;
    const chats = rows.filter((row) => !NOT_A_CHAT.test(row.request_path ?? ""));
    const bodies = await Promise.all(chats.map((row) => bodiesOf(row, fetchImpl)));
    chats.forEach((row, i) => turns.push({
      conversation: row.request_properties?.["Helicone-Session-Id"] || row.request_id,
      user: row.request_user_id,
      at: row.request_created_at,
      question: said(bodies[i].request, "user"),
      answer: said(bodies[i].response, "assistant"),
    }));
    if (rows.length < PAGE) break;
  }
  return { ...grouped(turns), host: new URL(root).host, read };
}
