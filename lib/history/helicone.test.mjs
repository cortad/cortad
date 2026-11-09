import assert from "node:assert/strict";
import { test } from "node:test";
import { HELICONE, inline, readHelicone } from "./helicone.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const since = new Date("2026-10-10T12:00:00.000Z");
const ELSEWHERE = '{"helicone_message": "fetching body from signed_url... contact engineering@helicone.ai for more information"}';
const SIGNED = "https://request-response-storage.s3.us-west-2.amazonaws.com/organizations/o1/requests/r-signed/raw_request_response_body?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc";

// Every field HeliconeRequest marks required, as POST /v1/request/query-clickhouse returns it. Times
// come from ClickHouse with no zone, as Helicone's own fixtures write them.
const row = (fields) => ({
  response_id: "res-1", response_created_at: "2026-11-08 09:00:01.200", response_status: 200, response_model: "gpt-4o-mini",
  request_id: "r-1", request_created_at: "2026-11-08 09:00:00.500", request_body: ELSEWHERE, request_path: "https://api.openai.com/v1/chat/completions",
  request_user_id: null, request_properties: {}, request_model: "gpt-4o-mini", model_override: null, helicone_user: null, provider: "OPENAI",
  delay_ms: 700, time_to_first_token: 300, total_tokens: 40, prompt_tokens: 30, prompt_cache_write_tokens: 0, prompt_cache_read_tokens: 0,
  completion_tokens: 10, reasoning_tokens: 0, prompt_audio_tokens: 0, completion_audio_tokens: 0, cost: 0.0001, prompt_id: null, prompt_version: null,
  llmSchema: null, country_code: "CA", asset_ids: null, asset_urls: null, scores: null, properties: {}, assets: [],
  target_url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini", cache_reference_id: null, cache_enabled: false,
  ai_gateway_body_mapping: null, response_body: ELSEWHERE, storage_location: "s3", ...fields,
});
const chat = (question) => ({ model: "gpt-4o-mini", messages: [{ role: "system", content: "You are the shop's assistant." }, { role: "user", content: question }] });
const reply = (text) => ({ id: "chatcmpl-1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] });

const FULL_PAGE = Array.from({ length: 100 }, (_, i) => row({
  request_id: `bulk-${i}`, request_created_at: "2026-11-09 08:00:00.000", storage_location: "clickhouse",
  request_body: JSON.stringify(chat(`Question ${i}`)), response_body: JSON.stringify(reply(`Answer ${i}`)),
}));
const LAST_PAGE = [
  row({ request_id: "r-signed", request_created_at: "2026-11-08 09:05:00.000", request_user_id: "u-7", request_properties: { "Helicone-Session-Id": "s-1" }, signed_body_url: SIGNED }),
  row({ request_id: "r-embed", request_path: "https://api.openai.com/v1/embeddings", storage_location: "clickhouse", request_body: { input: "Where is order 1042?", model: "text-embedding-3-small" } }),
  row({ request_id: "r-inline", request_created_at: "2026-11-08 09:00:00.500", request_user_id: "u-7", request_properties: { "Helicone-Session-Id": "s-1" },
    storage_location: "clickhouse", request_body: chat("Where is order 1042?"), response_body: { ...reply("It left the warehouse.") } }),
  row({ request_id: "r-unstored", storage_location: "not_stored_exceeded_free" }),
];

function helicone({ status = 200 } = {}) {
  const asked = [];
  const fetchImpl = async (url, init = {}) => {
    asked.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
    if (url === SIGNED) return json({ request: chat("When will it arrive?"), response: reply("On Thursday.") });
    if (status !== 200) return json({ data: null, error: "Unauthorized" }, status);
    const { offset } = asked.at(-1).body;
    return json({ data: offset === 0 ? FULL_PAGE : LAST_PAGE, error: null });
  };
  return { asked, fetchImpl };
}

test("Helicone requests are read newest first by offset, bodies kept apart come from their signed URL, and a session is one conversation", async () => {
  const { asked, fetchImpl } = helicone();
  const out = await readHelicone({ env: { HELICONE_API_KEY: "sk-helicone-abc" }, since, fetchImpl });

  const queries = asked.filter((a) => a.url.startsWith("https://api.helicone.ai/"));
  assert.deepEqual(queries.map((a) => [a.method, a.url, a.headers.authorization]), [
    ["POST", "https://api.helicone.ai/v1/request/query-clickhouse", "Bearer sk-helicone-abc"],
    ["POST", "https://api.helicone.ai/v1/request/query-clickhouse", "Bearer sk-helicone-abc"],
  ]);
  assert.deepEqual(queries[0].body, { filter: { request_response_rmt: { request_created_at: { gte: "2026-10-10T12:00:00.000Z" } } }, offset: 0, limit: 100, sort: { created_at: "desc" } });
  assert.equal(queries[1].body.offset, 100);
  const signed = asked.filter((a) => a.url === SIGNED);
  assert.equal(signed.length, 1);
  assert.equal(signed[0].headers.authorization, undefined, "the key never goes to the storage URL");

  assert.equal(out.host, "api.helicone.ai");
  assert.equal(out.read, 104);
  assert.equal(out.withoutText, 1, "a body Helicone did not store has no text");
  const session = out.conversations.find((c) => c.id === "s-1");
  assert.equal(session.user, "u-7");
  assert.deepEqual([...session.messages].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), [
    { role: "user", text: "Where is order 1042?", at: "2026-11-08T09:00:00.500Z" },
    { role: "assistant", text: "It left the warehouse.", at: "2026-11-08T09:00:00.501Z" },
    { role: "user", text: "When will it arrive?", at: "2026-11-08T09:05:00.000Z" },
    { role: "assistant", text: "On Thursday.", at: "2026-11-08T09:05:00.001Z" },
  ]);
  assert.equal(out.conversations.length, 101, "each request with no session is its own conversation");
  assert.ok(!out.conversations.some((c) => c.id === "r-embed"), "an embedding is not a conversation");
});

test("a key made in the EU is read from the EU API, and refused keys say so", async () => {
  assert.equal(HELICONE.hostOf({ HELICONE_API_KEY: "sk-helicone-eu-abc" }), "https://eu.api.helicone.ai");
  assert.equal(HELICONE.hostOf({ HELICONE_API_KEY: "sk-helicone-abc" }), "https://api.helicone.ai");
  await assert.rejects(readHelicone({ env: { HELICONE_API_KEY: "sk-helicone-eu-abc" }, since, fetchImpl: helicone({ status: 401 }).fetchImpl }),
    /^Error: eu\.api\.helicone\.ai refused the HELICONE keys in your env$/);
});

test("an inline body is parsed, and Helicone's note that the body is elsewhere is no body", () => {
  assert.deepEqual(inline('{"messages":[]}'), { messages: [] });
  assert.equal(inline(ELSEWHERE), undefined);
  assert.equal(inline("plain text"), "plain text");
});
