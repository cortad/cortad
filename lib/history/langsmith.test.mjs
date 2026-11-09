import assert from "node:assert/strict";
import { test } from "node:test";
import { asChat, LANGSMITH, readLangSmith } from "./langsmith.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const since = new Date("2026-10-10T12:00:00.000Z");
const PROJECT = { id: "018e4c7e-a9fb-7ef0-a5b6-6ea3a82e9327", tenant_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479", name: "shop-agent", start_time: "2026-09-01T10:30:00.000Z" };
const THREAD = "d4e5f6a7-b8c9-4d5e-1f2a-3b4c5d6e7f8a";

// Root runs as POST /api/v2/runs/query returns them: items newest first, then a next_cursor or null.
const PAGES = [
  { items: [
    { id: "0190a1b2-c3d4-7ef0-a5b6-6ea3a82e9330", start_time: "2026-11-08T09:02:00.000Z", thread_id: THREAD, metadata: { user_id: "u-17" },
      inputs: { messages: [{ type: "human", content: "Where is order 1042?", id: "m3" }] },
      outputs: { messages: [{ type: "human", content: "Where is order 1042?" }, { type: "ai", content: "Order 1042 ships tomorrow." }] } },
    { id: "0190a1b2-c3d4-7ef0-a5b6-6ea3a82e9329", start_time: "2026-11-08T08:00:00.000Z", metadata: { session_id: "chat-2", user_id: "u-40" },
      inputs: { question: "Do you ship to Canada?" }, outputs: { answer: "Yes, to every province." } },
    { id: "0190a1b2-c3d4-7ef0-a5b6-6ea3a82e9328", start_time: "2026-11-08T09:00:00.000Z", thread_id: THREAD, metadata: {},
      inputs: { messages: [{ lc: 1, type: "constructor", id: ["langchain", "schema", "messages", "HumanMessage"], kwargs: { content: "Hi" } }] },
      outputs: { output: "Hello, how can I help?" } },
  ], next_cursor: "eyJ2IjoxLCJhIjoicnVucy5xdWVyeSJ9" },
  { items: [
    { id: "0190a1b2-c3d4-7ef0-a5b6-6ea3a82e9327", start_time: "2026-11-07T15:00:00.000Z", inputs: { input: "What are your hours?" }, outputs: { output: "9 to 5, every day." } },
    { id: "0190a1b2-c3d4-7ef0-a5b6-6ea3a82e9326", start_time: "2026-11-07T14:00:00.000Z", inputs: {}, outputs: null },
  ], next_cursor: null },
];

function langsmith({ project = PROJECT, status = 200 } = {}) {
  const asked = [];
  const fetchImpl = async (url, init = {}) => {
    asked.push({ url: new URL(url), method: init.method ?? "GET", headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    if (status !== 200) return json({ detail: "Invalid token" }, status);
    if (url.includes("/api/v1/sessions")) return json(project ? [project] : []);
    return json(PAGES[asked.filter((a) => a.body).length - 1]);
  };
  return { asked, fetchImpl };
}
const texts = (c) => [...c.messages].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map((m) => `${m.role}: ${m.text}`);

test("LangSmith root runs are read by project, newest first by cursor, and grouped by thread", async () => {
  const { asked, fetchImpl } = langsmith();
  const out = await readLangSmith({ env: { LANGSMITH_API_KEY: "lsv2_pt_x", LANGSMITH_PROJECT: "shop-agent" }, since, fetchImpl });

  assert.equal(asked[0].url.href, "https://api.smith.langchain.com/api/v1/sessions?name=shop-agent");
  assert.deepEqual(asked.map((a) => [a.method, a.url.pathname, a.headers["x-api-key"]]), [
    ["GET", "/api/v1/sessions", "lsv2_pt_x"], ["POST", "/api/v2/runs/query", "lsv2_pt_x"], ["POST", "/api/v2/runs/query", "lsv2_pt_x"],
  ]);
  assert.deepEqual(asked[1].body, {
    project_ids: [PROJECT.id], is_root: true, min_start_time: "2026-10-10T12:00:00.000Z", page_size: 100,
    selects: ["ID", "START_TIME", "INPUTS", "OUTPUTS", "METADATA", "THREAD_ID"],
  });
  assert.equal(asked[2].body.cursor, PAGES[0].next_cursor, "the next page is asked with the cursor the last one gave");

  assert.equal(out.host, "api.smith.langchain.com");
  assert.equal(out.read, 5);
  assert.equal(out.withoutText, 1);
  assert.deepEqual(out.conversations.map((c) => [c.id, c.user]), [[THREAD, "u-17"], ["chat-2", "u-40"], ["0190a1b2-c3d4-7ef0-a5b6-6ea3a82e9327", undefined]]);
  assert.deepEqual(texts(out.conversations[0]), ["user: Hi", "assistant: Hello, how can I help?", "user: Where is order 1042?", "assistant: Order 1042 ships tomorrow."]);
  assert.deepEqual(texts(out.conversations[1]), ["user: Do you ship to Canada?", "assistant: Yes, to every province."]);
});

test("a self-hosted LangSmith is read at its own root, with the workspace header when one is set", async () => {
  const { asked, fetchImpl } = langsmith();
  const env = { LANGSMITH_API_KEY: "k", LANGCHAIN_ENDPOINT: "https://smith.example.com/api/v1/", LANGCHAIN_PROJECT: "shop-agent", LANGSMITH_WORKSPACE_ID: "ws-1" };
  const out = await readLangSmith({ env, since, fetchImpl });
  assert.deepEqual(asked.map((a) => a.url.origin + a.url.pathname), ["https://smith.example.com/api/v1/sessions", "https://smith.example.com/api/v2/runs/query", "https://smith.example.com/api/v2/runs/query"]);
  assert.ok(asked.every((a) => a.headers["x-tenant-id"] === "ws-1"));
  assert.equal(out.host, "smith.example.com");
  assert.equal(LANGSMITH.hostOf({}), "https://api.smith.langchain.com");
});

test("a missing project, refused keys and an address off https stop the read with what went wrong", async () => {
  const env = { LANGSMITH_API_KEY: "k" };
  await assert.rejects(readLangSmith({ env, since, fetchImpl: langsmith({ project: null }).fetchImpl }), /^Error: api\.smith\.langchain\.com has no project named default$/);
  await assert.rejects(readLangSmith({ env, since, fetchImpl: langsmith({ status: 401 }).fetchImpl }), /^Error: api\.smith\.langchain\.com refused the LANGSMITH keys in your env$/);
  await assert.rejects(readLangSmith({ env, since, fetchImpl: langsmith({ status: 502 }).fetchImpl }), /^Error: api\.smith\.langchain\.com answered 502$/);
  const off = langsmith();
  await assert.rejects(readLangSmith({ env: { ...env, LANGSMITH_ENDPOINT: "http://smith.example.com" }, since, fetchImpl: off.fetchImpl }), /not reached over https/);
  assert.equal(off.asked.length, 0, "the key never left");
});

test("LangChain's message types read as the person's and the app's roles", () => {
  assert.deepEqual(asChat({ messages: [{ type: "human", content: "a" }, { type: "ai", content: "b" }, { role: "user", content: "c" }, { type: "tool", content: "d" }] }).messages,
    [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }, { type: "tool", content: "d" }]);
  assert.equal(asChat("plain"), "plain");
});
