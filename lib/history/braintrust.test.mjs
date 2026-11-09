import assert from "node:assert/strict";
import { test } from "node:test";
import { projectIn, readBraintrust } from "./braintrust.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const since = new Date("2026-10-10T12:00:00.000Z");
const PROJECT = { id: "p-0c1f", org_id: "o-77", name: "shop-agent", created: "2026-09-01T10:00:00.000Z", user_id: "u-admin" };

// Every field ProjectLogsEvent marks required, as POST /v1/project_logs/{project_id}/fetch returns it.
const event = (fields) => ({ _xact_id: "1000192656880881099", org_id: "o-77", project_id: "p-0c1f", log_id: "g", span_parents: [], is_root: true, metadata: {}, ...fields });
const messages = (question) => [{ role: "system", content: "You are the shop's assistant." }, { role: "user", content: question }];
// What Braintrust's OpenAI wrapper logs as a reply: the completion's choices.
const choices = (text) => [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }];

const PAGES = [
  { events: [
    event({ id: "e-3", span_id: "sp-3", root_span_id: "sp-3", created: "2026-11-08T09:05:00.000Z", metadata: { thread_id: "th-1", user_id: "u-7" }, input: messages("When will it arrive?"), output: choices("On Thursday.") }),
    event({ id: "e-3c", span_id: "sp-3c", root_span_id: "sp-3", span_parents: ["sp-3"], is_root: false, created: "2026-11-08T09:05:00.100Z", input: messages("When will it arrive?"), output: choices("On Thursday.") }),
    event({ id: "e-2", span_id: "sp-2", root_span_id: "sp-2", is_root: null, created: "2026-11-08T08:00:00.000Z", input: { question: "Do you ship to Canada?" }, output: { answer: "Yes." } }),
    event({ id: "e-1", span_id: "sp-1", root_span_id: "sp-1", created: "2026-11-08T09:00:00.000Z", metadata: { thread_id: "th-1" }, input: messages("Where is order 1042?"), output: choices("It left the warehouse.") }),
  ], cursor: "aW5kZXg6MTAw" },
  { events: [
    event({ id: "e-3", _xact_id: "1000192656880881000", span_id: "sp-3", root_span_id: "sp-3", created: "2026-11-08T09:05:00.000Z", metadata: { thread_id: "th-1" }, input: messages("an older version"), output: null }),
    event({ id: "e-0", span_id: "sp-0", root_span_id: "sp-0", created: "2026-11-01T07:00:00.000Z", input: "", output: "" }),
    event({ id: "e-old", span_id: "sp-old", root_span_id: "sp-old", created: "2026-09-20T07:00:00.000Z", input: "Too old", output: "Left out" }),
  ], cursor: "aW5kZXg6MjAw" },
  { events: [event({ id: "e-older", span_id: "sp-older", root_span_id: "sp-older", created: "2026-09-01T07:00:00.000Z", input: "Older", output: "Older" })], cursor: "aW5kZXg6MzAw" },
];

function braintrust({ projects = [PROJECT], status = 200 } = {}) {
  const asked = [];
  const fetchImpl = async (url, init = {}) => {
    asked.push({ url: new URL(url), method: init.method ?? "GET", headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    if (status !== 200) return json({ error: "Invalid API key" }, status);
    if (url.includes("/v1/project?")) return json({ objects: projects });
    return json(PAGES[asked.filter((a) => a.body).length - 1]);
  };
  return { asked, fetchImpl };
}
const texts = (c) => [...c.messages].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map((m) => `${m.role}: ${m.text}`);

test("Braintrust root spans are read newest first by cursor, each row once, until a page is older than 30 days", async () => {
  const { asked, fetchImpl } = braintrust();
  const out = await readBraintrust({ env: { BRAINTRUST_API_KEY: "sk-bt-abc", BRAINTRUST_PROJECT: "shop-agent", BRAINTRUST_ORG_NAME: "Acme Shop" }, since, fetchImpl });

  assert.deepEqual(asked.map((a) => [a.method, a.url.origin + a.url.pathname, a.headers.authorization]), [
    ["GET", "https://api.braintrust.dev/v1/project", "Bearer sk-bt-abc"],
    ["POST", "https://api.braintrust.dev/v1/project_logs/p-0c1f/fetch", "Bearer sk-bt-abc"],
    ["POST", "https://api.braintrust.dev/v1/project_logs/p-0c1f/fetch", "Bearer sk-bt-abc"],
    ["POST", "https://api.braintrust.dev/v1/project_logs/p-0c1f/fetch", "Bearer sk-bt-abc"],
  ], "the third page holds nothing from the window, so there is no fourth");
  assert.deepEqual(Object.fromEntries(asked[0].url.searchParams), { project_name: "shop-agent", org_name: "Acme Shop" });
  assert.deepEqual(asked.slice(1).map((a) => a.body), [{ limit: 100 }, { limit: 100, cursor: "aW5kZXg6MTAw" }, { limit: 100, cursor: "aW5kZXg6MjAw" }]);

  assert.equal(out.host, "api.braintrust.dev");
  assert.equal(out.read, 4, "root spans from the window, each once; the child span and the older ones are not read");
  assert.equal(out.withoutText, 1);
  assert.deepEqual(out.conversations.map((c) => [c.id, c.user]), [["th-1", "u-7"], ["sp-2", undefined]]);
  assert.deepEqual(texts(out.conversations[0]), ["user: Where is order 1042?", "assistant: It left the warehouse.", "user: When will it arrive?", "assistant: On Thursday."]);
  assert.deepEqual(texts(out.conversations[1]), ["user: Do you ship to Canada?", "assistant: Yes."]);
});

test("the project comes from BRAINTRUST_PARENT, BRAINTRUST_PROJECT, or the one project the key sees", async () => {
  assert.deepEqual(projectIn({ BRAINTRUST_PARENT: "project_id:p-9", BRAINTRUST_PROJECT: "other" }), { id: "p-9" });
  assert.deepEqual(projectIn({ BRAINTRUST_PARENT: "project_name:shop:eu" }), { name: "shop:eu" });
  assert.deepEqual(projectIn({ BRAINTRUST_PARENT: "experiment_id:x", BRAINTRUST_PROJECT: "shop-agent" }), { name: "shop-agent" });

  const byId = braintrust();
  await readBraintrust({ env: { BRAINTRUST_API_KEY: "k", BRAINTRUST_PARENT: "project_id:p-9" }, since, fetchImpl: byId.fetchImpl });
  assert.equal(byId.asked[0].url.pathname, "/v1/project_logs/p-9/fetch", "an id needs no lookup");

  const only = braintrust();
  await readBraintrust({ env: { BRAINTRUST_API_KEY: "k" }, since, fetchImpl: only.fetchImpl });
  assert.equal(only.asked[0].url.search, "?limit=2");
  assert.equal(only.asked[1].url.pathname, "/v1/project_logs/p-0c1f/fetch");

  await assert.rejects(readBraintrust({ env: { BRAINTRUST_API_KEY: "k" }, since, fetchImpl: braintrust({ projects: [PROJECT, { ...PROJECT, id: "p-2", name: "evals" }] }).fetchImpl }), /set BRAINTRUST_PROJECT/);
  await assert.rejects(readBraintrust({ env: { BRAINTRUST_API_KEY: "k", BRAINTRUST_PROJECT: "nope" }, since, fetchImpl: braintrust().fetchImpl }), /^Error: api\.braintrust\.dev has no project named nope$/);
  await assert.rejects(readBraintrust({ env: { BRAINTRUST_API_KEY: "k", BRAINTRUST_PARENT: "project_id:p" }, since, fetchImpl: braintrust({ status: 401 }).fetchImpl }), /^Error: api\.braintrust\.dev refused the BRAINTRUST keys in your env$/);
});
