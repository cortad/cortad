import assert from "node:assert/strict";
import { test } from "node:test";
import { OPIK, readOpik } from "./opik.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const since = new Date("2026-10-10T12:00:00.000Z");

// Traces as GET /v1/private/traces returns them: TracePage_Public, newest first.
const trace = (n, fields) => ({
  id: `0196f7c2-6c1a-7b3e-9a10-${String(n).padStart(12, "0")}`, project_id: "0196f7c2-0000-7000-8000-000000000001", name: "chat",
  start_time: "2026-11-09T08:00:00.000Z", end_time: "2026-11-09T08:00:01.000Z", input: { question: `Question ${n}` }, output: { output: `Answer ${n}` },
  metadata: {}, tags: [], created_at: "2026-11-09T08:00:01.100Z", last_updated_at: "2026-11-09T08:00:01.100Z", created_by: "admin", source: "sdk", ...fields,
});
const FULL_PAGE = Array.from({ length: 100 }, (_, n) => trace(n + 10));
const LAST_PAGE = [
  trace(3, { start_time: "2026-11-08T09:05:00.000Z", thread_id: "th-1", metadata: { user_id: "u-7" },
    input: { messages: [{ role: "user", content: "Where is order 1042?" }, { role: "assistant", content: "It left." }, { role: "user", content: "When will it arrive?" }] },
    output: { choices: [{ index: 0, message: { role: "assistant", content: "On Thursday." } }] } }),
  trace(2, { start_time: "2026-11-08T09:00:00.000Z", thread_id: "th-1", input: { messages: [{ role: "user", content: "Where is order 1042?" }] }, output: { output: "It left." } }),
  trace(1, { source: "experiment", input: { question: "A dataset item" }, output: { output: "Scored" } }),
  trace(0, { input: {}, output: {} }),
];

function opik({ status = 200 } = {}) {
  const asked = [];
  const fetchImpl = async (url, init = {}) => {
    asked.push({ url: new URL(url), headers: init.headers });
    if (status !== 200) return json({ errors: ["User not allowed to access workspace"] }, status);
    const page = Number(asked.at(-1).url.searchParams.get("page"));
    const content = page === 1 ? FULL_PAGE : LAST_PAGE;
    return json({ page, size: content.length, total: FULL_PAGE.length + LAST_PAGE.length, content, sortableBy: ["id", "start_time"] });
  };
  return { asked, fetchImpl };
}
const texts = (c) => [...c.messages].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map((m) => `${m.role}: ${m.text}`);

test("Opik traces are read by page from the project, grouped by thread, with only the app's own traces kept", async () => {
  const { asked, fetchImpl } = opik();
  const out = await readOpik({ env: { OPIK_API_KEY: "opik-key", OPIK_WORKSPACE: "acme", OPIK_PROJECT_NAME: "shop-agent" }, since, fetchImpl });

  assert.deepEqual(asked.map((a) => a.url.origin + a.url.pathname), ["https://www.comet.com/opik/api/v1/private/traces", "https://www.comet.com/opik/api/v1/private/traces"]);
  assert.deepEqual(Object.fromEntries(asked[0].url.searchParams), { project_name: "shop-agent", page: "1", size: "100", from_time: "2026-10-10T12:00:00.000Z", strip_attachments: "true" });
  assert.equal(asked[1].url.searchParams.get("page"), "2");
  assert.deepEqual(asked[0].headers, { authorization: "opik-key", "Comet-Workspace": "acme" }, "the key as Opik takes it, with no Bearer");

  assert.equal(out.host, "www.comet.com");
  assert.equal(out.read, 104);
  assert.equal(out.withoutText, 1);
  assert.equal(out.conversations.length, 101, "100 traces of their own, one thread, and no experiment");
  const thread = out.conversations.find((c) => c.id === "th-1");
  assert.equal(thread.user, "u-7");
  assert.deepEqual(texts(thread), ["user: Where is order 1042?", "assistant: It left.", "user: When will it arrive?", "assistant: On Thursday."]);
  assert.ok(!out.conversations.some((c) => c.messages.some((m) => m.text === "A dataset item")));
});

test("a self-hosted Opik is read at its own address, and refused keys say so", async () => {
  assert.equal(OPIK.hostOf({ OPIK_URL_OVERRIDE: "http://localhost:5173/api" }), "http://localhost:5173/api");
  const local = opik();
  await readOpik({ env: { OPIK_API_KEY: "k", OPIK_WORKSPACE: "default", OPIK_URL_OVERRIDE: "http://localhost:5173/api/" }, since, fetchImpl: local.fetchImpl });
  assert.equal(local.asked[0].url.origin + local.asked[0].url.pathname, "http://localhost:5173/api/v1/private/traces");
  assert.equal(local.asked[0].url.searchParams.get("project_name"), "Default Project");
  await assert.rejects(readOpik({ env: { OPIK_API_KEY: "k", OPIK_WORKSPACE: "acme" }, since, fetchImpl: opik({ status: 403 }).fetchImpl }), /^Error: www\.comet\.com refused the OPIK keys in your env$/);
});
