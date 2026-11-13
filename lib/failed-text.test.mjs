import assert from "node:assert/strict";
import { test } from "node:test";
import { heldBackLine } from "./failed-text.mjs";
import { findingsText, runText } from "./text.mjs";

// resumeforge's agent read "17 of 33 replies failed" and asked what was attempted, whose it was and
// how to reproduce each. The replies that did not count are said before the counts, their parts add
// up to the count, and each part with a request prints it to paste.

const failedReplies = {
  replies: 33, notCounted: 17,
  said: "17 of 33 replies did not count: 9 answered HTTP 502 at backend/app/api/resume_writing.py:91 (your side; request below), 6 answered HTTP 422 to the request Cortad built for POST /api/drill/{id}/answer (our side; request below), 2 got no answer from /api/chat before Cortad stopped waiting at 90 seconds (our side).",
  rows: [
    { kind: "failed", side: "yours", door: "/api/resume/writing", status: 502, count: 9, said: "9 answered HTTP 502 at backend/app/api/resume_writing.py:91", at: "backend/app/api/resume_writing.py:91",
      curl: "curl -X POST 'http://localhost:8004/api/resume/writing' -H 'authorization: <redacted>' -H 'content-type: application/json' --data-raw '{\"message\":\"rewrite my summary\"}'", response: "Bad Gateway", verify: "finding:1" },
    { kind: "refused", side: "ours", door: "/api/drill/{id}/answer", status: 422, count: 6, said: "6 answered HTTP 422 to the request Cortad built for POST /api/drill/{id}/answer",
      curl: "curl -X POST 'http://localhost:8004/api/drill/7/answer' -H 'content-type: application/json' --data-raw '{\"message\":\"hi\"}'", response: "{\"detail\":[{\"loc\":[\"body\",\"answer\"],\"msg\":\"field required\"}]}" },
    { kind: "waited", side: "ours", door: "/api/chat", status: 0, count: 2, said: "2 got no answer from /api/chat before Cortad stopped waiting at 90 seconds" },
  ],
  held: [{ door: "Drill stream", trials: 2, why: "no route to it was found in the read, so this simulation had nothing to send it" }],
};
const run = { jobId: "j", kind: "run", status: "succeeded", finished: true, played: 31, of: 31, score: 88, ci: { low: 70, high: 96 }, questionsAsked: 20, questionsOf: 40,
  replies: { total: 33, crashed: 9 }, heldBack: [{ surface: "Drill stream", trials: 2, why: "no route to it was found in the read, so this simulation had nothing to send it" }], failedReplies };

test("the replies that did not count lead the counts, each with the request to paste", () => {
  const text = runText(run);
  const lines = text.split("\n");
  const said = lines.indexOf(failedReplies.said);
  const score = lines.indexOf("Cortad could check 20 of its 40 questions.");
  assert.ok(said > 0 && said < score, "said before the counts");
  assert.doesNotMatch(text, /[Ss]core/);
  assert.equal(lines[said + 1], `  Request for the 9 at backend/app/api/resume_writing.py:91: ${failedReplies.rows[0].curl}`);
  assert.equal(lines[said + 2], "    Answered: Bad Gateway");
  assert.equal(lines[said + 3], "    verify finding:1 replays them.");
  assert.match(lines[said + 4], /^ {2}Request for the 6 from \/api\/drill\/\{id\}\/answer: curl -X POST /);
  assert.doesNotMatch(text, /Request for the 2 /, "a wait of ours has no request to paste");
  assert.equal(text.match(/Set aside: 2 conversations on Drill stream/g)?.length, 1, "the doors held back are said once, with the replies");
  assert.ok(lines.indexOf("Set aside: 2 conversations on Drill stream: no route to it was found in the read, so this simulation had nothing to send it.") < score);
  assert.doesNotMatch(text, /\u2014/);
});

test("findings say the replies that did not count before the counts too, apart from the code-audit gates", () => {
  const text = findingsText({ runId: "r", ...run, findings: [{ id: "access:1", kind: "access-open", says: "The admin route answers with no sign-in.", request: { method: "GET", path: "/admin" }, status: 200 }] });
  const lines = text.split("\n");
  assert.ok(lines.indexOf(failedReplies.said) > 0 && lines.indexOf(failedReplies.said) < lines.indexOf("Cortad could check 20 of its 40 questions."));
  assert.doesNotMatch(failedReplies.said, /admin/);
});

test("an older answer with no failed replies prints as before", () => {
  const { failedReplies: _none, ...older } = run;
  const text = runText(older);
  assert.match(text, /\n9 of 33 replies were failures and are not counted\.\n/);
  assert.match(text, /\nSet aside: 2 conversations on Drill stream: /);
  const clean = runText({ ...older, replies: { total: 33, crashed: 0 }, heldBack: [] });
  assert.doesNotMatch(clean, /did not count|not in it|Set aside/, "a simulation with nothing that failed prints nothing extra");
});

test("a failed row says the line the app printed while it failed", () => {
  const printed = 'ERROR: [RAG] request failed err: "dense embed: 4000ms deadline exceeded"';
  const lines = runText({ ...run, failedReplies: { ...failedReplies, rows: [{ ...failedReplies.rows[0], printed }] } }).split("\n");
  assert.equal(lines[lines.indexOf("    Answered: Bad Gateway") + 1], `    Your app printed: "${printed}"`);
});

// A run said "Set aside: 2 conversations on Vision ask, Not played: ... to send.." (2026-11-02).
test("a set-aside reason sits after a colon, with no second label and one full stop", () => {
  assert.equal(heldBackLine({ trials: 2, surface: "Vision ask", why: "Not played: this endpoint needs a real image, and Cortad has none from your app to send." }),
    "Set aside: 2 conversations on Vision ask: this endpoint needs a real image, and Cortad has none from your app to send.");
});
