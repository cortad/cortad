import assert from "node:assert/strict";
import { test } from "node:test";
import { pickJudge, rule } from "../lib/judge.mjs";

const transcript = [
  { role: "user", text: "can I get a refund, I bought these in January" },
  { role: "app", text: "Of course. I have approved your refund in full." },
];
const checks = [{ id: "no-late-refund", require: "Never promises a refund past 30 days" }];

const judgeAnswering = (rulings) => {
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ rulings }) } }] }), { headers: { "content-type": "application/json" } });
  return fetchImpl;
};

const withFetch = async (rulings, fn) => {
  const was = globalThis.fetch;
  globalThis.fetch = judgeAnswering(rulings);
  try { return await fn(); } finally { globalThis.fetch = was; }
};

const theirs = { kind: "openai", name: "m", base: "http://x/v1", model: "m", key: "k" };

test("a break whose quote is in the reply stands", async () => {
  const out = await withFetch([{ id: "no-late-refund", broke: true, turn: 2, evidence: "I have approved your refund in full." }], () => rule(theirs, transcript, checks));
  assert.equal(out.length, 1);
  assert.equal(out[0].broke, true);
  assert.equal(out[0].turn, 2);
});

test("a break whose quote is not in the reply is dropped", async () => {
  const out = await withFetch([{ id: "no-late-refund", broke: true, turn: 2, evidence: "Your refund is denied." }], () => rule(theirs, transcript, checks));
  assert.deepEqual(out, []);
});

test("a break pointed at the customer's own words is dropped", async () => {
  const out = await withFetch([{ id: "no-late-refund", broke: true, turn: 1, evidence: "can I get a refund, I bought these in January" }], () => rule(theirs, transcript, checks));
  assert.deepEqual(out, []);
});

test("a ruling for a check nobody asked about is dropped", async () => {
  const out = await withFetch([{ id: "invented", broke: true, turn: 2, evidence: "I have approved your refund in full." }], () => rule(theirs, transcript, checks));
  assert.deepEqual(out, []);
});

test("nothing broken comes back as a kept check, not as silence", async () => {
  const out = await withFetch([{ id: "no-late-refund", broke: false, turn: null, evidence: null }], () => rule(theirs, transcript, checks));
  assert.deepEqual(out, [{ id: "no-late-refund", require: checks[0].require, broke: false }]);
});

test("a named judge needs a key, and ollama does not", () => {
  const key = process.env.CORTAD_JUDGE_KEY;
  delete process.env.CORTAD_JUDGE_KEY;
  assert.throws(() => pickJudge("openai/gpt-5"), /CORTAD_JUDGE_KEY/);
  assert.equal(pickJudge("ollama/qwen3").base, "http://localhost:11434/v1");
  if (key) process.env.CORTAD_JUDGE_KEY = key;
});

test("offline with no judge named says so instead of calling home", () => {
  process.env.CORTAD_OFFLINE = "1";
  assert.throws(() => pickJudge(), /CORTAD_OFFLINE/);
  delete process.env.CORTAD_OFFLINE;
});
