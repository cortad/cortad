import assert from "node:assert/strict";
import { test } from "node:test";
import { MESSAGE, problems, readSchema, replyAt, SKELETON, withMessage } from "../lib/schema.mjs";

const good = {
  app: "a support assistant for a shoe store",
  endpoint: { url: "http://localhost:3000/api/chat", body: { messages: [{ role: "user", content: MESSAGE }] }, reply: "choices.0.message.content" },
  rules: ["never promise a refund past 30 days"],
};

test("a schema with what a run needs has no problems", () => {
  assert.deepEqual(problems(good), []);
  assert.equal(readSchema(JSON.stringify(good)).endpoint.method, "POST");
});

test("the skeleton init writes is not runnable until it is filled in", () => {
  const found = problems(SKELETON);
  assert.ok(found.some((p) => p.startsWith("app:")));
  assert.ok(found.some((p) => p.startsWith("rules:")));
  assert.ok(!found.some((p) => p.startsWith("endpoint.body:")), "the skeleton's body already holds the placeholder");
});

test("a body with no placeholder is refused, because the run would send the same words every time", () => {
  const no = { ...good, endpoint: { ...good.endpoint, body: { messages: [{ role: "user", content: "hello" }] } } };
  assert.ok(problems(no).some((p) => p.startsWith("endpoint.body:")));
});

test("a url that is not http is refused", () => {
  assert.ok(problems({ ...good, endpoint: { ...good.endpoint, url: "localhost:3000" } }).some((p) => p.startsWith("endpoint.url:")));
});

test("the placeholder is replaced however deep it sits", () => {
  assert.deepEqual(withMessage({ a: [{ b: MESSAGE }], c: "x" }, "hi"), { a: [{ b: "hi" }], c: "x" });
  assert.equal(withMessage(`prefix ${MESSAGE}`, "hi"), "prefix hi");
});

test("the reply path walks objects and arrays, and nothing else is a reply", () => {
  assert.equal(replyAt({ choices: [{ message: { content: "yes" } }] }, "choices.0.message.content"), "yes");
  assert.equal(replyAt({ choices: [] }, "choices.0.message.content"), null);
  assert.equal(replyAt({ a: { b: 7 } }, "a.b"), null);
});

test("broken JSON says so by name", () => {
  assert.throws(() => readSchema("{"), /cortad\.json is not valid JSON/);
});
