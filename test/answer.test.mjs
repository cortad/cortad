import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as code from "../lib/answer/code.mjs";
import * as trace from "../lib/answer/trace.mjs";
import * as theirs from "../lib/answer/theirs.mjs";
import { answerAll, byOf } from "../lib/answer/index.mjs";
import { ABSENT, broke, held, NO, overTurns, settled, tally, UNKNOWN, YES } from "../lib/answer/verdict.mjs";

const talk = (...replies) => replies.flatMap((text) => [{ role: "user", text: "and?" }, { role: "app", text }]);

// A judge at an address nothing is listening on, so asking it always throws.
const noJudge = { kind: "openai", name: "broken", base: "http://127.0.0.1:1/v1", model: "x", key: "x" };

test("a question held when the app answered what the question asked for", () => {
  const forbidden = { ask: "did it promise a refund", answer: NO };
  assert.equal(held(forbidden, NO), true);
  assert.equal(broke(forbidden, YES), true);
  const required = { ask: "did it offer an exchange", answer: YES };
  assert.equal(held(required, YES), true);
  assert.equal(broke(required, NO), true);
});

test("could not tell and did not come up are neither held nor broken", () => {
  const q = { ask: "x", answer: NO };
  for (const a of [UNKNOWN, ABSENT]) {
    assert.equal(held(q, a), false);
    assert.equal(broke(q, a), false);
    assert.equal(settled(a), false);
  }
});

test("one turn doing the thing answers for the whole conversation", () => {
  assert.equal(overTurns([NO, NO, YES]), YES);
  assert.equal(overTurns([NO, NO]), NO);
  assert.equal(overTurns([UNKNOWN, ABSENT]), UNKNOWN);
  assert.equal(overTurns([ABSENT]), ABSENT);
});

test("the count leaves out what was never settled", () => {
  const q = { ask: "x", answer: NO };
  const counted = tally([
    { question: q, answer: NO },
    { question: q, answer: YES },
    { question: q, answer: UNKNOWN },
    { question: q, answer: ABSENT },
  ]);
  assert.deepEqual(counted, { held: 1, broke: 1, unknown: 1, absent: 1, settled: 2 });
});

test("code reads the reply and no model is asked", () => {
  const said = talk("Absolutely, I have approved a full refund.");
  assert.equal(code.decide({ contains: ["approved a full refund"] }, said).answer, YES);
  assert.equal(code.decide({ contains: ["15% off"] }, said).answer, NO);
  assert.equal(code.decide({ matches: "refund.*\\bdays?\\b" }, talk("your refund lands in 3 days")).answer, YES);
  assert.equal(code.decide({ json: true }, talk('{"ok":true}')).answer, YES);
});

test("code names the words it found, so the answer can be argued with", () => {
  const found = code.decide({ contains: ["full refund"] }, talk("I have approved a full refund."));
  assert.equal(found.quote, "full refund");
});

test("an app that never answered did not come up, and is not a failure", () => {
  const nothing = [{ role: "user", text: "hello" }];
  assert.equal(code.decide({ contains: ["x"] }, nothing).answer, ABSENT);
});

test("a trace question with no trace could not be told, never a yes", () => {
  for (const q of [{ tool: "issueRefund" }, { read: "catalogue" }, { wrote: true }, { logged: true }, { arg: { tool: "t", field: "f", is: 1 } }]) {
    const ruled = trace.decide(q, null);
    assert.equal(ruled.answer, UNKNOWN, `${JSON.stringify(q)} must not be settled without a trace`);
    assert.match(ruled.why, /nothing was recorded/);
  }
});

test("a trace settles what the app did, and what it did not", () => {
  const events = [{ at: 1, kind: "tool", name: "issueRefund", args: { amount: 89 } }, { at: 2, kind: "read", name: "catalogue" }];
  assert.equal(trace.decide({ tool: "issueRefund" }, events).answer, YES);
  assert.equal(trace.decide({ tool: "cancelOrder" }, events).answer, NO);
  assert.equal(trace.decide({ read: "catalogue" }, events).answer, YES);
  assert.equal(trace.decide({ arg: { tool: "issueRefund", field: "amount", is: 89 } }, events).answer, YES);
  assert.equal(trace.decide({ arg: { tool: "issueRefund", field: "amount", is: 1 } }, events).answer, NO);
  assert.equal(trace.decide({ wrote: true }, events).answer, NO);
  assert.equal(trace.decide({ logged: true }, events).answer, NO);
});

test("their own function answers, and a function that answers nonsense does not count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cortad-theirs-"));
  const at = join(dir, theirs.QUESTIONS_FILE);
  writeFileSync(at, `
    export const priceListed = ({ transcript }) => (transcript.some((t) => t.text.includes("89")) ? "yes" : "no");
    export const withQuote = () => ({ answer: "no", quote: "nothing like it", why: "checked the price list" });
    export const nonsense = () => "probably";
    export const angry = () => { throw new Error("no price list configured"); };
  `);
  const loaded = await theirs.loadTheirs(at);
  const said = talk("that comes to 89 dollars");
  assert.equal((await theirs.decide({ fn: "priceListed" }, loaded, { transcript: said })).answer, YES);
  const quoted = await theirs.decide({ fn: "withQuote" }, loaded, { transcript: said });
  assert.equal(quoted.quote, "nothing like it");
  assert.equal(quoted.why, "checked the price list");
  assert.equal((await theirs.decide({ fn: "nonsense" }, loaded, { transcript: said })).answer, ABSENT);
  const threw = await theirs.decide({ fn: "angry" }, loaded, { transcript: said });
  assert.equal(threw.answer, ABSENT);
  assert.match(threw.why, /no price list configured/);
  assert.match((await theirs.decide({ fn: "missing" }, loaded, { transcript: said })).why, /exports no missing/);
});

test("a question code or the trace can settle is settled without the judge, even when the judge is broken", async () => {
  const said = talk("Absolutely, I have approved a full refund.");
  const events = [{ at: 1, kind: "tool", name: "issueRefund", args: {} }];
  const ruled = await answerAll([
    { id: "a", ask: "did it promise a refund", answer: NO, contains: ["approved a full refund"] },
    { id: "b", ask: "did it call issueRefund", answer: NO, tool: "issueRefund" },
  ], { transcript: said, events, judge: noJudge });
  assert.deepEqual(ruled.map((r) => r.answer), [YES, YES]);
  assert.deepEqual(ruled.map((r) => r.by), ["code", "trace"]);
  assert.deepEqual(ruled.map((r) => broke(r.question, r.answer)), [true, true]);
});

test("a judge that cannot be reached takes only its own questions down with it", async () => {
  const said = talk("Absolutely, I have approved a full refund.");
  const ruled = await answerAll([
    { id: "a", ask: "did it promise a refund", answer: NO, contains: ["full refund"] },
    { id: "b", ask: "was it rude", answer: NO, by: "judge" },
  ], { transcript: said, events: null, judge: noJudge });
  assert.equal(ruled[0].answer, YES);
  assert.equal(ruled[1].answer, ABSENT);
  assert.match(ruled[1].why, /could not be reached/);
});

test("a question that does not name its decider is read from what it names", () => {
  assert.equal(byOf({ tool: "x" }), "trace");
  assert.equal(byOf({ contains: ["x"] }), "code");
  assert.equal(byOf({ fn: "x" }), "mine");
  assert.equal(byOf({ ask: "was it rude" }), "judge");
  assert.equal(byOf({ by: "judge", tool: "x" }), "judge");
});

test("a pack's questions are asked of every conversation, and a pack cannot name your code", async () => {
  const { problems, questionsOf } = await import("../lib/suite/packs.mjs");
  assert.deepEqual(problems({ name: "refunds", version: "1", questions: [{ ask: "did it promise a refund", answer: "no" }] }), []);
  assert.match(problems({ name: "Refunds!", version: "1", questions: [] }).join(" "), /name:/);
  assert.match(problems({ name: "refunds", version: "1", questions: [{ ask: "x", answer: "no", fn: "sneaky" }] }).join(" "), /cannot name a function/);

  const asked = questionsOf([{ name: "refunds", version: "1", questions: [{ ask: "did it promise a refund", answer: "no" }] }], "some-sim");
  assert.equal(asked[0].pack, "refunds");
  assert.match(asked[0].id, /^refunds#/);
  assert.notEqual(questionsOf([{ name: "refunds", version: "1", questions: [{ ask: "x", answer: "no" }] }], "a")[0].id,
    questionsOf([{ name: "refunds", version: "1", questions: [{ ask: "x", answer: "no" }] }], "b")[0].id);
});
