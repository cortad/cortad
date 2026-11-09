import assert from "node:assert/strict";
import { test } from "node:test";
import { messagesIn, PHOENIX, readPhoenix, valueIn } from "./phoenix.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const since = new Date("2026-10-10T12:00:00.000Z");

// Root spans in the shape Phoenix 21 answers GET /v1/projects/{project_identifier}/spans with: attributes
// flattened into dotted keys, as OpenInference instrumentation wrote them.
const span = (n, kind, start, attributes) => ({
  id: `U3BhbjoxM${n}`, name: kind === "LLM" ? "ChatCompletion" : "handle_chat", context: { trace_id: `ae0bd446341be6c3dba94168d8ada2f${n}`, span_id: `59adbf900ea0a2f${n}` },
  span_kind: kind, parent_id: null, start_time: start, end_time: start.replace(".525408", ".525411"), status_code: "UNSET", status_message: "", attributes, events: [],
});
const text = (question, answer) => ({ "input.value": question, "input.mime_type": "text/plain", "output.value": answer, "output.mime_type": "text/plain" });
const PAGES = [
  { data: [
    span(1, "CHAIN", "2026-11-09T08:42:55.525408+00:00", text("What are your opening hours?", "We answer every day from 9 to 5.")),
    span(2, "LLM", "2026-11-09T08:37:55.525408+00:00", {
      "session.id": "sess-b", "user.id": "person-b", "llm.model_name": "gpt-4o-mini",
      "input.value": JSON.stringify({ messages: [{ role: "system", content: "You are the shop's assistant." }, { role: "user", content: "Do you ship to Canada?" }, { role: "assistant", content: "Yes, to every province." }, { role: "user", content: "Is there a free threshold?" }], model: "gpt-4o-mini" }),
      "input.mime_type": "application/json",
      "output.value": JSON.stringify({ choices: [{ message: { role: "assistant", content: "Orders over 80 dollars ship free." } }] }),
      "output.mime_type": "application/json",
      "llm.input_messages.0.message.role": "system", "llm.input_messages.0.message.content": "You are the shop's assistant.",
      "llm.input_messages.1.message.role": "user", "llm.input_messages.1.message.content": "Do you ship to Canada?",
      "llm.input_messages.2.message.role": "assistant", "llm.input_messages.2.message.content": "Yes, to every province.",
      "llm.input_messages.3.message.role": "user", "llm.input_messages.3.message.content": "Is there a free threshold?",
      "llm.output_messages.0.message.role": "assistant", "llm.output_messages.0.message.content": "Orders over 80 dollars ship free.",
    }),
    span(3, "CHAIN", "2026-11-09T08:36:55.525408+00:00", { "session.id": "sess-a", "user.id": "person-a", ...text("Can I change the address?", "Yes, until it is out for delivery.") }),
  ], next_cursor: "ODpEQVRFVElNRToyMDI2LTExLTA5VDA4OjM1OjU1LjUyNTQwOCswMDowMA==" },
  { data: [
    span(4, "CHAIN", "2026-11-09T08:32:55.525408+00:00", { "session.id": "sess-a", "user.id": "person-a", ...text("Where is my order 1042?", "Order 1042 left the warehouse yesterday.") }),
    span(5, "TOOL", "2026-11-09T08:30:55.525408+00:00", { "session.id": "sess-a", "tool.name": "lookup_order" }),
  ], next_cursor: null },
];

function phoenix({ status = 200 } = {}) {
  const asked = [];
  const fetchImpl = async (url, init = {}) => {
    asked.push({ url: new URL(url), headers: init.headers });
    return status === 200 ? json(PAGES[asked.length - 1]) : new Response("Invalid token", { status });
  };
  return { asked, fetchImpl };
}
const texts = (c) => [...c.messages].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map((m) => `${m.role}: ${m.text}`);

test("Phoenix root spans are read newest first by cursor from the project, and a session is one conversation", async () => {
  const { asked, fetchImpl } = phoenix();
  const env = { PHOENIX_COLLECTOR_ENDPOINT: "https://app.phoenix.arize.com/s/acme/v1/traces", PHOENIX_API_KEY: "px-key", PHOENIX_PROJECT_NAME: "shop agent" };
  const out = await readPhoenix({ env, since, fetchImpl });

  assert.deepEqual(asked.map((a) => a.url.origin + a.url.pathname), ["https://app.phoenix.arize.com/s/acme/v1/projects/shop%20agent/spans", "https://app.phoenix.arize.com/s/acme/v1/projects/shop%20agent/spans"]);
  assert.deepEqual(Object.fromEntries(asked[0].url.searchParams), { parent_id: "null", sort: "start_time", order: "desc", start_time: "2026-10-10T12:00:00.000Z", limit: "100" });
  assert.equal(asked[1].url.searchParams.get("cursor"), PAGES[0].next_cursor);
  assert.ok(asked.every((a) => a.headers.authorization === "Bearer px-key"));

  assert.equal(out.host, "app.phoenix.arize.com");
  assert.equal(out.read, 5);
  assert.equal(out.withoutText, 1, "a tool span with no text is counted, not kept");
  assert.deepEqual(out.conversations.map((c) => [c.id, c.user]), [["ae0bd446341be6c3dba94168d8ada2f1", undefined], ["sess-b", "person-b"], ["sess-a", "person-a"]]);
  assert.deepEqual(texts(out.conversations[1]), ["user: Is there a free threshold?", "assistant: Orders over 80 dollars ship free."], "the newest message, not the history the call carried");
  assert.deepEqual(texts(out.conversations[2]), ["user: Where is my order 1042?", "assistant: Order 1042 left the warehouse yesterday.", "user: Can I change the address?", "assistant: Yes, until it is out for delivery."]);
  assert.equal(out.conversations[2].messages[0].at, "2026-11-09T08:36:55.525Z");
});

test("Phoenix is found the way its own client finds it, and is asked with a key only when there is one", async () => {
  assert.equal(PHOENIX.hostOf({ PHOENIX_ENDPOINT: "https://phoenix.example.com", PHOENIX_COLLECTOR_ENDPOINT: "https://other.example.com" }), "https://phoenix.example.com");
  assert.equal(PHOENIX.hostOf({ PHOENIX_COLLECTOR_ENDPOINT: "http://localhost:6006/v1/traces/" }), "http://localhost:6006");
  assert.equal(PHOENIX.hostOf({}), "http://localhost:6006");
  const open = phoenix();
  await readPhoenix({ env: { PHOENIX_COLLECTOR_ENDPOINT: "http://127.0.0.1:6006", PHOENIX_PROJECT: "shop", PHOENIX_PROJECT_NAME: "ignored" }, since, fetchImpl: open.fetchImpl });
  assert.equal(open.asked[0].url.pathname, "/v1/projects/shop/spans");
  assert.deepEqual(open.asked[0].headers, {});
  await assert.rejects(readPhoenix({ env: { PHOENIX_COLLECTOR_ENDPOINT: "http://127.0.0.1:6006" }, since, fetchImpl: phoenix({ status: 401 }).fetchImpl }), /^Error: 127\.0\.0\.1:6006 refused the PHOENIX keys in your env$/);
  await assert.rejects(readPhoenix({ env: { PHOENIX_COLLECTOR_ENDPOINT: "http://phoenix:6006" }, since, fetchImpl: phoenix().fetchImpl }), /phoenix:6006 is not reached over https/);
});

test("OpenInference's flattened messages and JSON values read back as chat", () => {
  const attributes = { "llm.input_messages.10.message.role": "user", "llm.input_messages.10.message.content": "eleventh", "llm.input_messages.2.message.role": "user", "llm.input_messages.2.message.content": "third", "llm.input_messages_other": "x" };
  assert.deepEqual(messagesIn(attributes, "llm.input_messages"), [{ role: "user", content: "third" }, { role: "user", content: "eleventh" }]);
  const huge = { "llm.input_messages.4294967294.message.role": "user", "llm.input_messages.4294967294.message.content": "far" };
  assert.deepEqual(messagesIn(huge, "llm.input_messages"), [{ role: "user", content: "far" }], "an index in a key is never a length to walk");
  assert.deepEqual(valueIn({ "input.value": '{"question":"hi"}', "input.mime_type": "application/json" }, "input"), { question: "hi" });
  assert.equal(valueIn({ "input.value": '{"question":"hi"}' }, "input"), '{"question":"hi"}', "text stays text without a JSON mime type");
});
