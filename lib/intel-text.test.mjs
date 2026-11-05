import assert from "node:assert/strict";
import { test } from "node:test";
import { incidentsText, intelligenceText } from "./intel-text.mjs";

// What a coding agent reads about the live app. It can act on a problem only when the answer names
// the question, its place in the code, its reach and the call that follows a fix.

const problem = {
  id: "rule:1/exceeds-three-sentences", title: "Exceeds three sentences", words: "Does the reply contain more than three sentences?", from: "prompts/support.mjs:8",
  broke: 3, of: 18, low: 0.058, high: 0.392, since: "2026-11-05T02:42:10.000Z",
  version: { name: "5220e03343e8b8be2113adde3f5b0947d04e71c1", broke: 3, of: 3, before: { broke: 0, of: 15 } },
  most: { useCase: "Track an order", broke: 2, of: 12 }, url: "https://cortad.com/live/rule%3A1", finding: null,
};
const day = (over = {}) => ({
  days: 7, connection: { keys: true, here: null, started: { at: "2026-11-05T02:00:00Z", release: "5220e03" }, conversation: { at: "2026-11-05T02:10:00Z" }, page: null, connected: true },
  problems: { n: 1, worst: [problem] }, wrong: [{ problem: true, kind: "rule", key: "Exceeds three sentences", since: problem.since, now: { broke: 3, of: 3 }, before: { broke: 0, of: 15 }, cause: null }],
  conversations: { n: 22, read: 19, heldEvery: 16, got: 17, frustrated: 1, wantsHuman: 1 }, url: "https://cortad.com/live", ...over,
});

test("a problem is said once, with its place in the code, its reach, the version it started on and what to call next", () => {
  assert.equal(intelligenceText(day()), [
    "The live app, last 7 days: 22 conversations, 19 read. 1 problem.",
    "",
    "1. Exceeds three sentences, prompts/support.mjs:8",
    "   The question: Does the reply contain more than three sentences?",
    "   Failed in 3 of 18 conversations it applied to, between 6% and 39%.",
    "   First failed 2026-11-05 02:42Z on version 5220e03: 3 of 3 since, 0 of 15 before it.",
    '   Most in "Track an order": 2 of 12.',
    "   The conversations, for the person to open: https://cortad.com/live/rule%3A1",
    "   No simulation has reproduced it: call test and say this problem in a sentence, fix what it finds, then verify.",
    "",
    "Of 19 read: 16 passed every question, 17 had their task done, 1 ended frustrated, 1 asked for a person.",
    "The page: https://cortad.com/live",
  ].join("\n"));
  const found = intelligenceText(day({ problems: { n: 5, worst: [{ ...problem, finding: "f-3", version: null, most: null }] } }));
  assert.match(found, /5 problems, the worst 1 here\./);
  assert.match(found, /First failed 2026-11-05 02:42Z\.\n {3}The conversations/);
  assert.match(found, /The last simulation found it too: fix it, then verify with findingId "f-3"\./);
});

test("an app that is not connected is told what has arrived and what has not, never numbers", () => {
  const text = intelligenceText(day({ connection: { keys: true, here: { at: "2026-11-05T01:00:00Z" }, started: null, conversation: null, page: null, connected: false } }));
  assert.match(text, /^The live app is not connected yet\.\n- Keys: made\.\n- This machine: a copy of the app started with the key at 2026-11-05 01:00Z\.\n- Deployed app: has not started with Cortad\./);
  assert.match(text, /next: connect$/);
  assert.doesNotMatch(text, /conversations, /);
});

test("a server from before problems were named still gets its counts, and no incident open says only that nothing got worse", () => {
  const { problems, connection, ...older } = day({ wrong: [], checks: [{ id: "rule-1", held: 15, broke: 3 }] });
  assert.match(intelligenceText(older), /Questions failed most: rule-1 3 of 18\./);
  assert.equal(incidentsText({ open: [], url: "https://cortad.com/live" }), "Nothing has got worse against the fourteen days before.");
});
