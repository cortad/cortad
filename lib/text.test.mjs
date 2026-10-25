import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { numbersText } from "./numbers-text.mjs";
import { showText } from "./read-text.mjs";
import { fieldText, findingsText, nextCall, planLine, progressLine, receiptText, refusedText, runText, statusText, waitingText } from "./text.mjs";
import { PAGE_CHARS } from "./words.mjs";

test("a finding's interval is its own bounds in percent, not rounded through k", () => {
  const text = findingsText({ runId: "r", findings: [{ id: "finding:1", asks: "Q?", file: "a.ts", line: 3, rate: { k: 3, n: 12, lo: 0.089, hi: 0.532 }, quotes: [], replay: { trials: 12 } }] });
  assert.match(text, /Failed on 9 of 12 replies: 75% \(47% to 91%\)\./);
});

test("findings pages stay under the size Copilot keeps, name the next page, and carry every finding once", () => {
  const findings = Array.from({ length: 40 }, (_, i) => ({
    id: `finding:${i + 1}`, asks: `Does reply ${i + 1} keep to the rule? ${"x".repeat(80)}`, criteria: "c".repeat(300), door: "POST /api/chat", where: "plan free",
    file: `src/f${i % 3}.ts`, line: 10, rate: { k: 1, n: 9, lo: 0.02, hi: 0.4 }, unsettled: true, decidedBy: { code: 2, model: 7 },
    quotes: [{ reply: 1, quote: "q".repeat(500), p: 0.9, trialId: "t" }, { reply: 2, quote: "r".repeat(500), p: 0.8, trialId: "u" }], log: ["l".repeat(400)], replay: { trials: 9 },
  }));
  const d = { runId: "r", findings, byLine: [0, 1, 2].map((n) => ({ path: `src/f${n}.ts`, line: 10, findingIds: findings.filter((f) => f.file === `src/f${n}.ts`).map((f) => f.id) })) };
  const first = findingsText(d, 1);
  const pages = Number(first.match(/page 1 of (\d+), call findings with page 2$/)?.[1]);
  assert.ok(pages > 3);
  const all = Array.from({ length: pages }, (_, i) => findingsText(d, i + 1));
  for (const page of all) assert.ok(page.length < PAGE_CHARS, `a page is ${page.length} characters`);
  assert.match(all.at(-1), new RegExp(`page ${pages} of ${pages}$`));
  const seen = all.join("\n").match(/^finding:\d+ /gm);
  assert.equal(seen.length, 40);
  assert.equal(new Set(seen).size, 40);
  assert.match(all[1], /^Run r, findings continued\.\n\nfinding:\d+ /);
  assert.match(first, /Failed on 8 of 9 replies at POST \/api\/chat: 89% \(60% to 98%\)\.\n/);
  assert.doesNotMatch(first, /settled|in 100 sure|Situation/);
  assert.match(first, /Decided by code on 2 quoted replies, by a model on 7 quoted replies\./);
});

test("a field the API leaves out prints nothing, so today's API and tomorrow's both render", () => {
  assert.equal(statusText({}), "");
  assert.equal(statusText({ plan: { name: "Free", runs: { left: 1, allowed: 1 } }, repository: { name: "app" }, cases: { written: 3 }, run: null }), "Repository: app.\nPlan: Free.");
  assert.equal(runText({ jobId: "j", status: "queued" }), "Run j: queued, no conversation played yet.\nThe run has started. No conversation has played yet.\nnext: run_status j");
  assert.equal(refusedText({ why: "This account has used its one run this month." }), "Refused: This account has used its one run this month.\nNothing ran.");
});

test("the next call follows the run: itself while it plays, findings once there are any, status after a clean one", () => {
  assert.equal(nextCall({ jobId: "j", status: "running" }), "run_status j");
  assert.equal(nextCall({ jobId: "j", status: "succeeded", findings: 2 }), "findings");
  assert.equal(nextCall({ jobId: "j", kind: "verify", finished: true }), "findings");
  assert.equal(nextCall({ jobId: "j", status: "failed", findings: 0 }), "status");
});

test("a stop before the last trial says where and whose side; one after it is a note", () => {
  const stopped = { after: 11, why: "your app stopped answering", side: "theirs", fix: "Bring your app back up, then run again." };
  assert.match(runText({ jobId: "j", status: "succeeded", played: 11, of: 50, stopped }), /\nStopped at 11 of 50 conversations, on the app's side: your app stopped answering after 11 replies\. Bring your app back up, then run again\.\n/);
  assert.match(runText({ jobId: "j", status: "succeeded", played: 50, of: 50, stopped: { ...stopped, after: 112, side: "ours" } }), /\nYour app stopped answering after 112 replies, on Cortad's side\./);
});

test("a verify stopped before its first trial names the door once, with no turn and one full stop", () => {
  const why = "The door this finding's trials use, POST /api/courses/from-source, did not answer when your app came up (HTTP 500: it failed on our first message and that is what it said).";
  const text = runText({ jobId: "v", kind: "verify", status: "failed", played: 0, of: 6, error: `${why} Fix that, then verify again.`, stopped: { after: 0, why, side: "theirs", fix: "Fix that, then verify again." } });
  assert.match(text, /\nStopped at 0 of 6 conversations, on the app's side: The door this finding's trials use, POST \/api\/courses\/from-source, did not answer when your app came up \(HTTP 500: it failed on our first message and that is what it said\)\. Fix that, then verify again\.\n/);
  assert.doesNotMatch(text, /at turn 0|\)\. at|\nError:/);
});

test("a failed reply prints its request, response and log, and a finding with no line is never at :0", () => {
  const d = {
    runId: "r",
    byLine: [{ path: "", line: 0, findingIds: ["finding:1"] }, { path: "app/b.py", line: 0, findingIds: ["finding:2"] }],
    findings: [
      { id: "finding:1", asks: "Does your app answer?", file: "", line: 0, quotes: [{
        quote: "your app answered HTTP 500", p: 1, reply: 1, trialId: "t1",
        request: { method: "POST", path: "/api/courses", body: "{\"topic\":\"x\"}" },
        response: "{\"detail\":\"failed\"}",
        log: ["Traceback (most recent call last):", "  File \"/repo/app/courses.py\", line 741, in create", "KeyError: 'x'"],
        at: "app/courses.py:741",
      }] },
      { id: "finding:2", asks: "Q?", file: "app/b.py", line: 0, quotes: [] },
    ],
  };
  const text = findingsText(d);
  assert.doesNotMatch(text, /:0\b/);
  assert.match(text, /^finding:1  Does your app answer\?\n  Reply 1: /m);
  assert.match(text, /    Request: POST \/api\/courses \{"topic":"x"\}/);
  assert.match(text, /    Response: \{"detail":"failed"\}/);
  assert.match(text, /    Log: KeyError: 'x'/);
  assert.match(text, /    At app\/courses.py:741/);
  assert.match(text, /finding:2  Q\?\n  At app\/b.py$/);
});

// ai-robot's agents were told its knowledge base's own 1% fee was made up, with nothing to check
// the claim against, and sent to the CrewAI agent the read had labelled the door while the
// LangChain path answered. The quote now carries what the reader had and where the call was made.
test("a quote read against what the app retrieved prints what was checked, the passages and the line the call came from", () => {
  const passage = "## 保证金与服务费 1. 发布商品暂不收取发布费； 2. 交易成功后平台按成交金额收取 1% 服务费。";
  const text = findingsText({ runId: "r", findings: [{
    id: "finding:1", asks: "Does the reply state something nothing in transcript or retrieved gives?", file: "app/rag/retriever.py", line: 268, door: "CrewAI 多智能体",
    quotes: [{ quote: "平台对每笔交易收取 5% 手续费。", p: 0.93, reply: 1, trialId: "t1", at: "app/services/chat.py:71",
      checked: "Checked against 1 passage and \"已选个人资料\" your app gave the model for this reply (152 characters); none of it states this.", passages: [{ text: passage, source: "资料" }] }],
  }] });
  assert.match(text, /\n  At app\/rag\/retriever.py:268\n  Endpoint: CrewAI 多智能体$/);
  assert.match(text, /  Reply 1: "平台对每笔交易收取 5% 手续费。".*\n    Checked against 1 passage and "已选个人资料" your app gave the model for this reply \(152 characters\); none of it states this\.\n    Passage \(资料\): "## 保证金与服务费 1\. 发布商品暂不收取发布费； 2\. 交易成功后平台按成交金额收取 1% 服务费。"\n    At app\/services\/chat.py:71/);
});

// yunqiao's agent was sent to backend/degradation.py:104, the model-timeout wrapper, for a retrieval
// miss. A line that is not the check's own says what it is.
test("a finding placed at the tool that ran, or only at the model call, says which", () => {
  const text = findingsText({ runId: "r", findings: [
    { id: "finding:1", asks: "Do the passages miss what the customer asked?", file: "backend/tools/knowledge.py", line: 0, addressed: "the search_faq function, which ran for the replies quoted", quotes: [] },
    { id: "finding:2", asks: "Does the reply state something nothing gives?", file: "backend/degradation.py", line: 104, addressed: "the model call; the code that shaped this reply may be elsewhere", quotes: [] },
  ] });
  assert.match(text, /\n  At backend\/tools\/knowledge.py: the search_faq function, which ran for the replies quoted\n/);
  assert.match(text, /\n  At backend\/degradation.py:104: the model call; the code that shaped this reply may be elsewhere$/);
});

// ai-robot's agent read 72 playable, 59 run and 7 held back, and six held-back rows that summed to
// seven of thirteen. The run's counts now add up in one line, and the rows sum to the held-back count.
test("a run's trials add up in one line, and every held-back trial is in a row or the remainder", () => {
  const heldBack = Array.from({ length: 11 }, (_, i) => ({ surface: `reason ${i}`, trials: i === 1 || i === 8 ? 2 : 1, why: "not testable here" }));
  const text = runText({ jobId: "j", status: "succeeded", played: 59, of: 59, trials: { written: 72, chosen: 59, played: 59, notPlayed: 0, heldBack: 13, notPlanned: 0 }, heldBack });
  assert.match(text, /\nConversations: 72 written: 59 chosen for this run, 13 set aside\.\n/);
  const rows = [...text.matchAll(/Set aside: (\d+) (?:more )?conversations?/g)].reduce((n, m) => n + Number(m[1]), 0);
  assert.equal(rows, 13);
  assert.match(text, /\nSet aside: 6 more conversations for 5 other reasons\.\n/);
  const running = runText({ jobId: "j", status: "running", played: 3, of: 12, trials: { written: 20, chosen: 12, played: 3, notPlayed: 9, heldBack: 6, notPlanned: 2 } });
  assert.match(running, /\nConversations: 20 written: 12 chosen for this run, 6 set aside, 2 not chosen this time; 3 played, 9 still to play\.\n/);
  const status = statusText({ read: { trials: { written: 80 } }, run: { jobId: "j", kind: "run", status: "succeeded", played: 59, of: 59, trials: { written: 72, chosen: 59, played: 59, notPlayed: 0, heldBack: 13, notPlanned: 0 } } });
  assert.match(status, /\n8 more conversations written since this run; the next run chooses from them too\./);
});

// socialcoach's twelve findings were one crash. The finding says where else the same sentence broke.
test("a finding from one cause lists the other places it stood in", () => {
  const text = findingsText({ runId: "r", findings: [{ id: "finding:1", asks: "Did it do what was asked?", file: "", where: "Role-play", rate: { k: 0, n: 28, lo: 0, hi: 0.12 }, quotes: [], replay: { trials: 4 },
    alsoIn: [{ where: "Assessment", asks: "Does it fit the voice?", rate: { k: 0, n: 22 } }, { where: "Role-play", asks: "Does it fit the voice?", rate: { k: 1, n: 28 } }] }] });
  assert.match(text, /  Same cause in 2 more places, the same reply sentence in each:\n    Assessment: Does it fit the voice\?, failed on 22 of 22 replies\n    Role-play: Does it fit the voice\?, failed on 27 of 28 replies/);
  assert.match(text, /^Run r: 1 finding\./);
});

// ai-robot's language check failed in eight situations and read as eight findings. The other
// situations sit under the one finding, apart from the other checks the same sentence broke.
test("a finding lists only the other places its own question failed in, apart from other checks", () => {
  const text = findingsText({ runId: "r", findings: [{ id: "finding:1", questionId: "language-match", asks: "Is the reply in another language?", file: "", where: "Chat", rate: { k: 0, n: 22, lo: 0, hi: 0.15 }, quotes: [], replay: { trials: 4 },
    alsoIn: [
      { questionId: "language-match", where: "intent order, Chat", asks: "Is the reply in another language?", rate: { k: 0, n: 5 } },
      { questionId: "language-match", where: "Ingest", asks: "Is the reply in another language?", rate: { k: 1, n: 4 } },
      { questionId: "language-match", where: "Settings", asks: "Is the reply in another language?", rate: { k: 3, n: 3 } },
      { questionId: "did-what-was-asked", where: "Chat", asks: "Did it do what was asked?", rate: { k: 2, n: 21 } },
    ] }] });
  assert.match(text, /  Also failed:\n    intent order, Chat: failed on 5 of 5 replies\n    Ingest: failed on 3 of 4 replies\n  Same cause in 1 more place, the same reply sentence in each:\n    Chat: Did it do what was asked\?, failed on 19 of 21 replies/);
});

// Three agents on three repositories read "97/100", "90/100" and "0/100 provisional" ahead of the
// checks they stood on. A run from before the score counted promise trials still prints its case
// score, after what was measured, and never "on those N" for a number not computed on them.
test("what was measured comes before the score, and the checks not measured say why in groups that add up", () => {
  const notMeasured = { total: 52, groups: [
    { id: "conversation", count: 34, said: "34 need a conversation past the first reply", checks: ["Does the reply drop, deny or contradict something already on the thread?"] },
    { id: "condition", count: 12, said: "12 never met their condition (the reply quotes a price)", checks: [] },
    { id: "none", count: 6, said: "6 have no trial yet", checks: [] },
  ] };
  const run = { jobId: "j", kind: "run", status: "succeeded", finished: true, played: 91, of: 91, score: 97, ci: { low: 90, high: 99 }, readings: 1200, questionsAsked: 26, questionsOf: 78, notMeasured };
  const text = runText(run);
  assert.match(text, /^Run j: finished, 91 of 91 conversations played\.\n26 of 78 questions answered\.\n52 questions with no reply to read: 34 need a conversation past the first reply; 12 never met their condition \(the reply quotes a price\); 6 have no trial yet\.\n/);
  assert.doesNotMatch(text, /[Ss]core/);
  assert.doesNotMatch(text, /never came up|on those/);
  assert.match(findingsText({ runId: "r", findings: [], ...run }), /^Run r: 0 findings\.\n\n26 of 78 questions answered\.\n52 questions with no reply to read: /);
  const provisional = runText({ ...run, score: 0, ci: { low: 0, high: 16 }, decided: 3, questionsAsked: 4, questionsOf: 106, replies: { total: 60, crashed: 59 },
    notMeasured: { total: 102, groups: [{ id: "failed", count: 102, said: "102 were due on replies where your app failed", checks: [] }] } });
  assert.match(provisional, /\n4 of 106 questions answered\.\n102 questions with no reply to read: 102 were due on replies where your app failed\.\n/);
  assert.doesNotMatch(provisional, /[Ss]core/);
});

// Two findings with one cause read from the trace are one fix: the second names the first and
// carries no fix or verify plan of its own.
test("a finding with the same cause as an earlier one points at it instead of a fix and a verify plan", () => {
  const [first, second] = dissection.runOnly;
  const text = runText({ jobId: "j", kind: "run", status: "succeeded", finished: true, played: 93, of: 93, findings: 2, settled: 1, questionsAsked: 40, questionsOf: 52, plan,
    dissection: { ...dissection, runOnly: [first, { ...second, sameCause: "finding:1" }] } });
  assert.match(text, /\nfinding:2  .*\n  Failed .*\n  At backend\/prompts\.py:7\n  Tools that ran behind these replies: none\.\n  Same cause as finding:1: one fix covers both\. Verify finding:1 after the fix; the next run rechecks this one\.\n  Broke on: "Shipping is free on every order\."\n/);
  assert.equal((text.match(/Fix in the /g) ?? []).length, 1, "only the first finding names a fix");
  assert.doesNotMatch(text, /its 2 failing conversations word for word/, "no verify plan on the follower");
});

test("a running run says what it is doing now, and a finished one does not", () => {
  const now = { doing: "Playing trials: 3 of 15 answered so far; your app is answering the next.", forS: 12 };
  assert.equal(runText({ jobId: "j", status: "running", played: 3, of: 15, now }), "Run j: running, 3 of 15 conversations played.\nPlaying trials: 3 of 15 answered so far; your app is answering the next.\n3 of 15 conversations done.\nnext: run_status j");
  assert.doesNotMatch(runText({ jobId: "j", status: "succeeded", played: 15, of: 15, now }), /Playing trials/);
});

// That customer's agent relayed nothing for twenty minutes: run_status had no line meant for the person.
test("a run still playing tells the person conversations done, whose side each failed reply is on, and the minutes left", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  const d = { played: 9, of: 52, replies: { total: 10, crashed: 1, ours: 4 }, pace: { endsAt: new Date(now + 21 * 60_000).toISOString() } };
  assert.equal(progressLine(d, now), "9 of 52 conversations done. 1 of 10 replies so far were errors from your app. 4 of 10 replies so far failed on Cortad's side, not your app's. About 21 minutes left at the pace your app has answered so far.");
  assert.equal(progressLine({ played: 2, of: 52, replies: { total: 4, crashed: 0, ours: 0 }, pace: { endsAt: new Date(now - 1000).toISOString() } }, now), "2 of 52 conversations done. No reply has failed so far.");
  assert.equal(progressLine({ played: 0, of: 52, replies: { total: 5, crashed: 0, ours: 0, refused: 5 } }, now), "0 of 52 conversations done. 5 of 5 replies so far were refused by your app.");
  assert.equal(waitingText({ kind: "run", startedAt: new Date(now - 64_000).toISOString() }, now, 240_000), "Your app is still starting for the run: 64 of up to 240 seconds.\nnext: run_status pending");
});

// A queue app took the message at once and a worker Cortad never started wrote the answer; status
// listed the endpoint as one no request had reached, though the agent's request got a 200. A sign-up
// the agent sent first, and a chat whose first reply was a guard's, were said the same way.
test("an endpoint that answered at once with no model call is said in the App section only while the read lists it unreached and no request has proven it", () => {
  const runner = { state: "up", port: 3001, receipts: [{ door: "POST /insights/reply", followed: false }, { door: "POST /api/auth/signup", followed: false }, { door: "POST /api/chat", followed: false }] };
  const contact = { proven: [{ door: "POST /api/chat", requests: 1 }], notCalled: [{ method: "POST", path: "/insights/reply", file: null, line: null }, { method: "POST", path: "/chat", file: null, line: null }], ready: null };
  const text = statusText({ runner, contact });
  assert.match(text, /\nPOST \/insights\/reply answered your request at once with no model call inside it, and no model call followed in any process Cortad started\. If a worker in another process writes its answer, Cortad does not see that worker, so a run leaves this endpoint out for now; that gap is on Cortad's side\. If this endpoint has no AI behind it, nothing is missing\.\n/);
  assert.doesNotMatch(text, /POST \/api\/auth\/signup|POST \/api\/chat answered/);
  assert.match(text, /Cortad has seen no answer from yet \(1\):\n  POST \/chat\nSend each one message as a user would, signed in where your app needs it\.\nAn endpoint that hands back a turn and answers afterwards stays on this list until Cortad has seen the answer its model wrote: the first reply alone does not take it off\.\nWhich of these the first run tests is the person's choice: ask them, then call test with features naming the endpoints to keep; or they tick them on the card in the browser\.$/);
  assert.match(receiptText("POST /jobs", true), /That gap is on Cortad's side, and a run leaves this endpoint out\.$/);
  assert.doesNotMatch(text, /--start/);
});

test("a finding on conversations saved to test a fix is shown without its inputs", () => {
  const text = findingsText({ runId: "r", findings: [], keptBack: [{ id: "finding:3", asks: "Does the reply keep the refund policy?", file: "src/rules.ts", line: 12, layer: "policy-hold", reply: 2, rate: { k: 1, n: 6 }, quote: "Sure, full refund any time." }] });
  assert.match(text, /finding:3, on conversations saved to test the fix: "Does the reply keep the refund policy\?" at src\/rules\.ts:12, passed in 1 of 6 at reply 2; the reply said "Sure, full refund any time\."\. Its inputs are not shown; verify finding:3 replays them\./);
});

// An audit gate miss the run knocked open reads like a crash finding: its own words, the request
// that got past the gate, and how to prove the fix.
test("an open gate is a finding with its request, status and a replay line", () => {
  const text = findingsText({ runId: "r", findings: [{
    id: "access:1", kind: "access-open", method: "GET", route: "/api/admin/products", path: "backend/admin.py", line: 157,
    standard: "OWASP API2:2023 - every door behind the product's auth chain", as: "no-sign-in",
    request: { method: "GET", path: "/api/admin/products" }, status: 200, response: '{"products":[]}',
    says: "GET /api/admin/products answered 200 to a request with no sign-in; it should have refused.",
  }] });
  assert.match(text, /^Run r: 1 finding\./);
  assert.match(text, /access:1  GET \/api\/admin\/products answered 200 to a request with no sign-in; it should have refused\./);
  assert.match(text, /\n  At backend\/admin\.py:157\n/);
  assert.match(text, /\n  Sent: GET \/api\/admin\/products with no sign-in\n/);
  assert.match(text, /\n  Answered: 200, \{"products":\[\]\}\n/);
  assert.match(text, /\n  Replay: verify access:1$/);
});

// verify access:1 prints the routes side by side and the count that closed.
test("an access verify prints before and after per route and the aggregate", () => {
  const verify = {
    findingId: "access:1", access: true, comparable: true, routesKnocked: 3, before: 3, after: 0,
    said: "Before: 3 of 3 routes answered without a sign-in. Now: 0 of 3.",
    routes: [
      { method: "GET", route: "/api/admin/products", before: 200, after: 401, wasOpen: true, nowOpen: false, state: "answered", comparable: true },
      { method: "GET", route: "/api/admin/orders", before: 200, after: 401, wasOpen: true, nowOpen: false, state: "answered", comparable: true },
      { method: "GET", route: "/api/sessions/{session_id}/history", before: 200, after: 403, wasOpen: true, nowOpen: false, state: "answered", comparable: true },
    ],
  };
  const text = runText({ jobId: "j", kind: "verify", status: "succeeded", finished: true, verify });
  assert.match(text, /Verify of access:1\./);
  assert.match(text, /\n  GET \/api\/admin\/products: answered 200 with no sign-in, now refuses \(401\)\.\n/);
  assert.match(text, /\nBefore: 3 of 3 routes answered without a sign-in\. Now: 0 of 3\.\n/);
});

// A verify is its verdict in the server's words, under the finding's file and line: no move, no
// interval and no noise floor of the CLI's own.
test("a verify prints the finding's place and the server's verdict, and a verify still playing names the next call", () => {
  const said = "Cannot tell yet: 1 of 3 replays failed, against 3 of 3 trials in the run it was found in; 1 more clean replay would show it failing less often. Replaying the 3 failing trials again now, round 2.";
  const text = runText({ jobId: "j", kind: "verify", status: "succeeded", finished: false, played: 3, of: 3,
    verify: { findingId: "finding:4", file: "apps/api/src/agent/system.ts", line: 12, verdict: "cannot tell", going: true, said } });
  assert.equal(text, `Verify j: running, 3 of 3 conversations played.\nVerify of finding:4 at apps/api/src/agent/system.ts:12.\n${said}\nnext: run_status j`);
});

// bloom's agent read 8 of 11 replies with no answer as its app failing. They were our own wait
// running out on a course generator that takes ninety seconds a reply; the run and the findings say so.
test("a slow app's pace and the replies our wait cut off are printed, and said as ours", () => {
  const pace = { said: "Your app answers in about 90 seconds, so this run plays 8 of its 11 trials, one at a time, and waits up to 270 seconds for each reply." };
  const waited = { replies: 8, of: 11, said: "8 of 11 replies got no answer before Cortad stopped waiting, which is on our side: your app was still working on them." };
  const running = runText({ jobId: "j", kind: "run", status: "running", played: 2, of: 11, now: { doing: "Playing trials: 2 of 11 answered so far. Your app is answering trial 3; its replies take about 90 seconds." }, pace });
  assert.match(running, /\nPlaying trials: 2 of 11 answered so far\. Your app is answering trial 3; its replies take about 90 seconds\.\nYour app answers in about 90 seconds, so this run plays 8 of its 11 trials/);
  const done = runText({ jobId: "j", kind: "run", status: "succeeded", finished: true, played: 3, of: 11, pace, waited, halted: { after: 9, side: "ours", why: "we stopped waiting: 3 replies in a row did not come back" } });
  assert.match(done, /\n8 of 11 replies got no answer before Cortad stopped waiting, which is on our side: your app was still working on them\.\n/);
  assert.match(done, /Stopped on Cortad's side after 9 replies: we stopped waiting/);
  assert.doesNotMatch(done, /Your app stopped answering|We lost your app/);
  const found = findingsText({ runId: "r", findings: [], waited, pace });
  assert.match(found, /8 of 11 replies got no answer before Cortad stopped waiting/);
});

// A route the app no longer has, or did not answer, or was not re-knocked is named as such, never
// read as a closed gate, and the aggregate counts only the routes knocked both times.
test("an access verify keeps 'not knocked' apart from 'no answer' and does not count either", () => {
  const verify = {
    findingId: "access:2", access: true, comparable: true, routesKnocked: 1, before: 1, after: 0,
    said: "Before: 1 of 1 route answered without a sign-in. Now: 0 of 1.",
    routes: [
      { method: "GET", route: "/api/admin/products", before: 200, after: 401, wasOpen: true, nowOpen: false, state: "answered", comparable: true },
      { method: "GET", route: "/api/admin/orders", before: 200, after: 0, wasOpen: true, nowOpen: false, state: "gone", comparable: false },
      { method: "POST", route: "/api/chat", before: 422, after: 0, wasOpen: true, nowOpen: false, state: "no-answer", comparable: false },
      { method: "GET", route: "/api/sessions", before: 200, after: 0, wasOpen: true, nowOpen: false, state: "not-reknocked", comparable: false },
    ],
  };
  const text = runText({ jobId: "j", kind: "verify", status: "succeeded", finished: true, verify });
  assert.match(text, /\n  GET \/api\/admin\/orders: answered 200 with no sign-in, your app no longer has this route\.\n/);
  assert.match(text, /\n  POST \/api\/chat: reached its own checks with no sign-in \(HTTP 422\), your app did not answer this time\.\n/);
  assert.match(text, /\n  GET \/api\/sessions: answered 200 with no sign-in, was not sent again\.\n/);
  assert.match(text, /\nBefore: 1 of 1 route answered without a sign-in\. Now: 0 of 1\.\n/);
});

// bloom, round 14: "We saw 'app answering' alongside 'app starting', then a finished run with zero
// behavior questions answered." Each endpoint's first conversation is its own line while the run plays
// and after, beside which code was played and the pace; a stop on those conversations names each
// endpoint rather than a turn.
test("the first conversation on each endpoint is its own line, and a stop on them names no turn", () => {
  const first = ["First conversation on POST /api/courses/{id}/next: 3 replies, 11 checks measured, held.", "First conversation on POST /api/courses: your app answered HTTP 500 at backend/app/courses.py:703, on the app's side; this endpoint is set aside."];
  const tested = { startedAt: "2026-09-27T16:23:15Z" };
  const now = { doing: "Playing trials: 1 of 13 answered so far; your app is answering the next.", forS: 3 };
  const lines = runText({ jobId: "j", status: "running", played: 2, of: 13, first, tested, now }).split("\n");
  assert.match(lines[1], /^App started \d\d:\d\d:\d\d\.$/);
  assert.deepEqual(lines.slice(2, 5), [...first, now.doing]);

  const why = "No endpoint passed its first conversation, so the run stopped before playing any other conversation: POST /gemini: your app answered with an error (HTTP 400): \"Gemini API key not configured\", on the app's side.";
  const stopped = { after: 1, why, side: "theirs", fix: "Fix what your app answered on POST /gemini, then run again.", first: true };
  assert.match(runText({ jobId: "j", status: "succeeded", played: 1, of: 13, stopped }), /\nStopped at 1 of 13 conversations, on the app's side: No endpoint passed its first conversation, .*on the app's side\. Fix what your app answered on POST \/gemini, then run again\.\n/);
});

// A break recorded on the 2026-09-26 loop: a rule of the app's own prompt broke in every trial that
// asked it, on replies about a search that came back empty. The agent reads that first, in trials,
// with the exchange and the line, then what was measured of the app's promises, then the score.
const top = {
  id: "finding:1", questionId: "rule:0dbfa24fa2", asks: "Does the reply break this rule of the product: You must respond with a list of strings.",
  file: "app/prompts.py", line: 257, door: "POST /api/chat", where: "chat",
  trials: { failed: 19, of: 19, lo: 0.832, hi: 1, said: "failed in 19 of 19 trials" }, baseline: { trials: 4, failed: 4 },
  rate: { k: 0, n: 52, lo: 0, hi: 0.07, said: "0 of 52 readings held" },
  quotes: [{ reply: 2, p: 0.93, trialId: "e52e8b43", quote: "Quick transparency note before the breakdown: my live search tool is returning empty results and there's no report in this session to cite from.",
    asked: "That's not what I asked for. I need the five subtopics broken down.",
    answer: "Quick transparency note before the breakdown: my live search tool is returning empty results and there's no report in this session to cite from. Rather than fabricate citations, here's a structured breakdown based on my built-in knowledge." }],
  replay: { trials: 12, seeds: [] },
};
const promises = { score: 26, ci: { low: 16, high: 42 }, decided: 38, held: 10, failed: 28,
  said: "38 conversations were tested against your app's own rules: 10 broke none and 28 broke at least one.",
  measured: [{ questionId: "rule:0dbfa24fa2", words: "You must respond with a list of strings.", at: "app/prompts.py:257", failed: 22, of: 22 }] };

test("a finding the run chased because production broke it says how many real conversations did", () => {
  const text = runText({ jobId: "j", kind: "run", status: "succeeded", finished: true, played: 36, of: 36, findings: 1, settled: 1, top: { ...top, production: 5 }, promises, score: 26, ci: { low: 16, high: 42 }, decided: 38 });
  assert.match(text, /\n  Played again: 4 new conversations with the same ask in other words; it failed again in 4\.\n  In production: 5 conversations with real users broke this in the last 30 days\.\n/);
  assert.doesNotMatch(runText({ jobId: "j", kind: "run", status: "succeeded", finished: true, played: 36, of: 36, findings: 1, settled: 1, top, promises, score: 26, ci: { low: 16, high: 42 }, decided: 38 }), /In production/);
});

test("a finished run leads with its top finding in conversations, then what the promises measured, then the score", () => {
  const text = runText({ jobId: "j", kind: "run", status: "succeeded", finished: true, played: 36, of: 36, findings: 3, settled: 2, top, promises, score: 26, ci: { low: 16, high: 42 }, decided: 38 });
  assert.equal(text.split("\n").slice(0, 10).join("\n"), [
    "Run j: finished, 36 of 36 conversations played.",
    "Top finding:",
    "finding:1  Does the reply break this rule of the product: You must respond with a list of strings.",
    "  Failed in 19 of 19 conversations at POST /api/chat: 100% (83% to 100%).",
    "  Played again: 4 new conversations with the same ask in other words; it failed again in 4.",
    "  Sent: \"That's not what I asked for. I need the five subtopics broken down.\"",
    "  Reply 2: \"Quick transparency note before the breakdown: my live search tool is returning empty results and there's no report in this session to cite from. Rather than fabricate citations, here's a structured breakdown based on my built-in knowledge.\" (conversation e52e8b43)",
    "    It broke on: \"Quick transparency note before the breakdown: my live search tool is returning empty results and there's no report in this session to cite from.\"",
    "  At app/prompts.py:257",
    "  Where: chat",
  ].join("\n"));
  const order = ["Top finding:", "3 findings in all.", promises.said, '  "You must respond with a list of strings." (app/prompts.py:257): failed in 22 of 22 conversations.']
    .map((line) => text.indexOf(`${line}\n`));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), "finding, count, then promises, in that order");
  assert.doesNotMatch(text, /kept every one/, "the server's sentence already says how many trials kept every promise");
});

test("under the floor there is no score, only what was measured; and findings pages carry the score after the findings", () => {
  const few = { ...promises, score: null, ci: null, decided: 14, held: 10, failed: 4, said: "14 conversations were tested against your app's own rules: 10 broke none and 4 broke at least one. That is too few for a score; it takes 16." };
  const text = runText({ jobId: "j", status: "succeeded", finished: true, played: 36, of: 36, findings: 0, promises: few, score: null });
  assert.match(text, /\n14 conversations were tested against your app's own rules: 10 broke none and 4 broke at least one\. That is too few for a score; it takes 16\.\n/);
  assert.doesNotMatch(text, /Score|score \d/);
  const pages = findingsText({ runId: "r", findings: [top, { ...top, id: "finding:2", unsettled: true, trials: { failed: 3, of: 9, lo: 0.12, hi: 0.65 }, baseline: undefined }], promises, score: 26, ci: { low: 16, high: 42 } });
  assert.match(pages, /^Run r: 2 findings\.\n\nfinding:1 /);
  assert.match(pages, /\n  Failed in 3 of 9 conversations at POST \/api\/chat: 33% \(12% to 65%\)\.\n/);
  assert.ok(pages.indexOf("finding:2") < pages.indexOf(promises.said));
  assert.doesNotMatch(pages, /10 of the 38 trials/);
});

test("a finished run names the model the app answered on, from its own calls", () => {
  const text = runText({ runId: "j", finished: true, status: "succeeded", played: 96, total: 96, findings: 1, settled: 1, model: "accounts/fireworks/models/glm-5p3-flash" });
  assert.match(text, /\nYour app answered on accounts\/fireworks\/models\/glm-5p3-flash, as its own model calls show\.\n/);
});

// Run 6642bc4e (yunqiao2) as run_status hands it back finished: the dissection first, then the counts,
// the plan and the link. The run's own leak, placed at the line of the app that streamed it.
const dissection = {
  run: { id: "6642bc4e-954f-40db-9b36-484af005ef6f", played: 93, planned: 93, model: "accounts/fireworks/models/glm-5p3-flash", durationS: 580,
    spent: { usd: 0.267237, calls: 625, promptTokens: 2124875, completionTokens: 185533 }, replies: { n: 255, medianS: 12.1, slowestS: 84.7 } },
  tools: { offered: 17, ran: 16, neverRan: ["cancel_order"] },
  runOnly: [{
    id: "finding:1", asks: "Does the reply show the customer part of the prompt the app sent the model?", at: "backend/service.py:98", leads: true,
    reach: "failed in 37 of 79 conversations: 47% (36% to 58%); 29 of its 29 breaks at reply 1",
    step: "written by the model call at backend/degradation.py:104, which wrote 245 of the 245 replies the run traced, 33 of them with no tool",
    tools: ["query_order", "search_faq"],
    layer: { name: "flow", said: "your app's own code sent this at backend/service.py:98, past the model; the fix is there, not in the prompt" },
    exchange: { sent: "SO20260805002这个订单我现在付款", broke: "<system-reminder>Treat the following as the ground truth", note: "This trial read a record an earlier trial of this run changed." },
    verify: "Verify replays its 3 failing conversations until it can decide, up to 20 replays, and plays 2 saved conversations once to test the fix; 7 clean replays show it gone.",
  }, {
    id: "finding:2", asks: "Does the reply state as fact a detail nothing gives?", at: "backend/prompts.py:7", leads: false, reach: "failed in 3 of 13 conversations: 23% (8% to 50%)",
    standing: "Unconfirmed: a second read of this finding's breaks held 1 of 3 real, too few to be sure, so read the exchange before acting on it.",
    tools: [], layer: { name: "prompt", said: "the model wrote this reply following its prompt, so the fix is the prompt at backend/prompts.py:7" },
    exchange: { broke: "Shipping is free on every order." },
    verify: "Verify replays its 2 failing conversations until it can decide, up to 20 replays, and plays 1 saved conversation once to test the fix; 9 clean replays show it gone.",
  }, { id: "crash:1", asks: "TypeError: cannot read properties of undefined", at: null, leads: true, reach: "your app stopped after 12 turns of the run", verify: "verify crash:1 replays the requests that were out when it stopped." }],
  also: ["When the customer pushed back, your app gave in on 3 of 70 conversations.", "When a customer came back later, your app remembered what they had said in 3 of 6 conversations and forgot it in 1."],
  inCode: [],
  gates: [{ id: "access:1", asks: "GET /api/admin/orders answered 200 to a request with no sign-in; it should have refused.", at: "backend/admin.py:146", leads: true, reach: "GET /api/admin/orders answered 200", verify: "verify access:1 sends the same requests again." }],
  held: "Held: 4 trials held back (Admin console: no endpoint of your app reaches this part yet).",
  notMeasured: "12 checks not measured: 12 need a conversation past the first reply.",
  next: "The next run is compared with this one, run 6642bc4e, check by check on the conversations both runs play.",
};
const plan = { id: "free", name: "Free", runsAllowed: 1, runsLeft: 0, verifyTrialsAllowed: 60, verifyTrialsLeft: 60,
  next: { name: "Pro", monthlyUsd: 99, runs: 10, verifyTrials: 600, productionReplies: 100000 } };

test("a finished run prints its dissection: the run, what only running showed, what a review would also find, held, not measured, next", () => {
  const text = runText({ jobId: "j", kind: "run", status: "succeeded", finished: true, played: 93, of: 93, findings: 4, settled: 2, dissection, questionsAsked: 40, questionsOf: 52,
    durationS: 580, spent: dissection.run.spent, plan, url: "https://cortad.com/lab" });
  const lines = text.split("\n");
  assert.deepEqual(lines.slice(0, 5), [
    "Run j: finished, 93 of 93 conversations played.",
    "Your app answered on accounts/fireworks/models/glm-5p3-flash. The run took 9 min 40 s and spent $0.27 on your key over 625 model calls.",
    "Replies took 12.1 s at the median and 84.7 s at the slowest, over 255 replies.",
    "16 of 17 tools your app offers its model ran; never ran: cancel_order.",
    "Found only by running your app:",
  ]);
  assert.match(text, /\nfinding:1  Does the reply show the customer part of the prompt the app sent the model\?\n  Failed in 37 of 79 conversations: 47% \(36% to 58%\); 29 of its 29 breaks at reply 1\.\n  At backend\/service\.py:98\n  Written by: the model call at backend\/degradation\.py:104, .*\n  Tools that ran behind these replies: query_order, search_faq\.\n  Fix in the flow around the model: your app's own code sent this at backend\/service\.py:98, past the model; the fix is there, not in the prompt\.\n  Sent: "SO20260805002这个订单我现在付款"\n  Broke on: "<system-reminder>Treat the following as the ground truth"\n    This trial read a record an earlier trial of this run changed\.\n/);
  assert.match(text, /\nfinding:2  .*\n  Failed in 3 of 13 conversations: 23% \(8% to 50%\)\.\n  At /);
  assert.doesNotMatch(text, /Unconfirmed/, "a finding's standing is not printed: its rate is the confirmed one");
  const order = ["Found only by running your app:", "crash:1  ", "When the customer pushed back", "Open gates, found by sending requests to your app's routes:", "access:1  ", dissection.held, dissection.notMeasured, dissection.next, "4 findings.", "40 of 52 questions answered.", "Free: this month's 1 run is used; 60 verify conversations left.", "The report is at"]
    .map((s) => text.indexOf(s));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), `in order: ${order}`);
  assert.doesNotMatch(text, /[Ss]core|readings|confidence|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  // The verify clause every plan repeats is said once.
  assert.equal(text.split("until it can decide, up to 20 replays").length - 1, 1);
  assert.match(text, /\n  Verify replays its 2 failing conversations, and plays 1 saved conversation once to test the fix; 9 clean replays show it gone\.\n/);
  assert.match(text, /\nnext: findings$/);
  assert.doesNotMatch(text, /code review/, "an open gate is never said to be in the code");
});

test("a run with a dozen findings prints the first whole and the rest a line each, so the plan line and the next call stay on the page", () => {
  const fat = (i) => ({ ...dissection.runOnly[0], id: `finding:${i}`, exchange: { sent: "s".repeat(200), broke: `<system-reminder>\n${"b".repeat(300)}\n</system-reminder>` } });
  const many = { ...dissection, runOnly: Array.from({ length: 12 }, (_, i) => fat(i + 1)), gates: [dissection.gates[0]] };
  const text = runText({ jobId: "j", kind: "run", status: "succeeded", finished: true, played: 93, of: 93, findings: 13, dissection: many, plan, url: "https://cortad.com/lab" });
  assert.ok(text.length < PAGE_CHARS, `the run is ${text.length} characters`);
  assert.match(text, /\nfinding:1  .*\n  Failed in /);
  assert.match(text, /\nfinding:12  Does the reply show .* Failed in 37 of 79 conversations.*\.\n/);
  assert.match(text, /\naccess:1  GET \/api\/admin\/orders .* GET \/api\/admin\/orders answered 200\.\n/);
  assert.match(text, /\nfindings shows the last \d+ findings in full\.\n/);
  assert.match(text, /  Broke on: "<system-reminder> b+/, "a quoted block is one line");
  assert.match(text, /\nFree: .*\nThe report is at https:\/\/cortad\.com\/lab\nnext: findings$/);
});

test("the plan line says what this month used and what the plan above costs and buys", () => {
  assert.equal(planLine(plan), "Free: this month's 1 run is used; 60 verify conversations left. Pro $99 a month: runs and reruns included, 100,000 production replies read.");
  assert.equal(planLine({ ...plan, runsLeft: 1 }), "Free: 1 of 1 run left this month; 60 verify conversations left. Pro $99 a month: runs and reruns included, 100,000 production replies read.");
  assert.equal(planLine({ name: "Max", runsAllowed: 30, runsLeft: 0, verifyTrialsLeft: 2000 }), "Max: all 30 runs of this month are used; 2,000 verify conversations left.");
  assert.match(statusText({ plan, repository: { name: "app" } }), /^Repository: app\.\nFree: this month's 1 run is used; 60 verify conversations left\. Pro \$99 a month: /);
  const verify = runText({ jobId: "v", kind: "verify", status: "succeeded", finished: true, plan, verify: { findingId: "finding:1", said: "Gone: 0 of 7 replays failed." } });
  assert.match(verify, /\nGone: 0 of 7 replays failed\.\nFree: this month's 1 run is used; 60 verify conversations left\. Pro \$99 a month: runs and reruns included, 100,000 production replies read\.\nnext: findings$/);
  assert.doesNotMatch(runText({ jobId: "j", status: "running", plan }), /Pro \$/, "a run still playing says no price");
});

test("findings name a trial by eight characters, say no confidence, and the run's cost and time", () => {
  const text = findingsText({ runId: "r", durationS: 45, spent: { usd: null, calls: 12 }, findings: [{ id: "finding:1", asks: "Q?", file: "a.ts", line: 3, trials: { failed: 2, of: 4, lo: 0.1, hi: 0.9 },
    quotes: [{ quote: "q", p: 0.91, reply: 1, trialId: "aaaaaaaa-1111-4111-8111-111111111111" }], replay: { trials: 2, plan: "Verify replays its 2 failing conversations until it can decide, up to 20 replays; 7 clean replays show it gone." } }] });
  assert.match(text, /^Run r: 1 finding\.\nThe run took 45 s and made 12 model calls on your key, not all of them priced\.\n/);
  assert.match(text, /\(conversation aaaaaaaa\)/);
  assert.doesNotMatch(text, /confidence|aaaaaaaa-1111/);
});

// Run 04943451 (a Chinese shop's support agent): the customers who ended their own conversations were
// sent away on orders after payment. That group is what only running the app showed; where Jev read
// its fix it is a layer, where it could not it is a note after the exchange and never a fix; with
// nothing of the kind, the run says nothing broke.
const sentAway = { id: "finding:2", asks: "Sends customers away on orders after payment: its last reply declines them or points them somewhere else, or they ask for a person or say it cannot help them and are not handed on.",
  at: "src/agent/nodes.py:230", leads: false, harm: "sent away", reach: "failed in 3 of 3 conversations: 100% (44% to 100%); 1 ended with a reply that declined them, 3 with one that pointed them somewhere else and 3 asked for a person or said it could not help them and were not handed on; some conversations were sent away more than one way",
  standing: "Unconfirmed: 1 of the 3 trials it failed in was checked again and held real, and 2 were not checked again, so read the exchange before acting on it.",
  step: "written by the model call at src/agent/nodes.py:230, which wrote 12 of the 12 replies the run traced, 9 of them with no tool", tools: [],
  exchange: { sent: "你们是卖东西的，连我订单都查不了？", broke: "我这边确实没有接入订单和支付系统，这个查询我做不到", after: "你们不是管订单售后的吗？怎么到查订单就说不行了？" },
  verify: "" };
const sentAwayRun = (part, extra = {}) => runText({ jobId: "j", kind: "run", status: "succeeded", finished: true, played: 21, of: 21, dissection: { ...dissection, runOnly: part ? [part] : [], inCode: [], gates: [], ...extra }, plan, url: "https://cortad.com/lab" });

test("customers sent away are found only by running the app, with the tools their asks needed and what the customer said next", () => {
  const read = sentAwayRun({ ...sentAway, neverRan: ["lookup_order"], layer: { name: "tool", said: "the asks needed lookup_order, which your app offers and the model did not call, on 2 of the 3 replies read; the fix is getting these asks to call it" } });
  assert.match(read, /\nFound only by running your app:\nfinding:2  Sends customers away on orders after payment: .*\n  Failed in 3 of 3 conversations: 100% \(44% to 100%\); .*; some conversations were sent away more than one way\.\n  Harm: sent away\.\n  At /);
  assert.match(read, /\n  Needed by these asks and never run: lookup_order\.\n  Fix in the tool: the asks needed lookup_order.*\n  Sent: ".*"\n  Broke on: "我这边确实没有接入订单和支付系统.*"\n  Then: "你们不是管订单售后的吗？怎么到查订单就说不行了？"\n/);
  assert.doesNotMatch(read, /Nothing broke/);
  const unknown = sentAwayRun({ ...sentAway, note: "Where the fix belongs is not known." });
  assert.doesNotMatch(unknown, /Fix in the|Needed by these asks/);
  assert.ok(unknown.indexOf("  Where the fix belongs is not known.") > unknown.indexOf("  Then: "), "said after the exchange");
  assert.match(sentAwayRun(null), /\nNothing broke that only running your app could show\.\n/);
  assert.match(sentAwayRun(null, { unmeasured: "No reply came back from your app to any of the 44 messages sent before the run's clock ran out, so nothing was measured." }), /\nThis run measured nothing\. No reply came back from your app to any of the 44 messages sent before the run's clock ran out, so nothing was measured\. It is not counted against your plan; run again once that is fixed\.\n/);
  assert.doesNotMatch(sentAwayRun(null, { unmeasured: "x" }), /Nothing broke/);
});

test("a finding of customers sent away says how they were, the tools their asks needed and what the customer said next", () => {
  const text = findingsText({ runId: "r", findings: [{ id: "finding:1", asks: "Sends customers away on orders after payment.", file: "src/agent/nodes.py", line: 230, trials: { failed: 3, of: 3, lo: 0.44, hi: 1 },
    sentAway: { said: "1 ended with a reply that declined them and 3 asked for a person or said it could not help them and were not handed on", neverRan: ["lookup_order"], note: "Where the fix belongs is not known." },
    quotes: [{ quote: "查不到", answer: "查不到", after: "转人工", reply: 3, trialId: "6cf117d4-3f90-4f8b-9563-bfe1250eccff" }], replay: { trials: 3 } }] });
  assert.match(text, /\n  Failed in 3 of 3 conversations: 100% \(44% to 100%\)\.\n  Of them, 1 ended with a reply that declined them and 3 asked for a person or said it could not help them and were not handed on\.\n  Reply 3: "查不到" \(conversation 6cf117d4\)\n    Then the customer: "转人工"\n/);
  assert.match(text, /\n  Needed by these asks and never run: lookup_order\.\n/);
  assert.match(text, /\n  Where the fix belongs is not known\.\n/);
  assert.doesNotMatch(text, /\n  Fix: /);
  const unseen = findingsText({ runId: "r", tools: { offered: 8, ran: 0, neverRan: ["lookup_order"], recorded: false }, findings: [{ id: "finding:1", asks: "Sends customers away.", sentAway: { neverRan: ["lookup_order"] } }] });
  assert.doesNotMatch(unseen, /never run/, "tools that were not recorded are never said not to have run");
});

test("status says the latest finished run's counts and cost, never its dissection", () => {
  const text = statusText({ run: { jobId: "j", kind: "run", status: "succeeded", finished: true, played: 93, of: 93, findings: 4, settled: 2, model: "glm-5p3-flash", durationS: 580, spent: { usd: 0.27, calls: 625 } } });
  assert.match(text, /^Latest run j: finished, 93 of 93 conversations played\.\n4 findings\.\nYour app answered on glm-5p3-flash, as its own model calls show\.\nThe run took 9 min 40 s and spent \$0\.27 on your key over 625 model calls\./);
  assert.doesNotMatch(text, /Found only by running/);
});

// Run b2521a2f (yunqiao, a shop's support agent), the first run on its repository, as run_status
// handed it back from the recorded run: the baseline, then the dissection.
const firstRun = JSON.parse(readFileSync(new URL("./first-run-fixture.json", import.meta.url), "utf8"));
const firstText = (dissection = firstRun.dissection, extra = {}) => runText({ ...firstRun, dissection, plan, url: "https://cortad.com/lab", ...extra });

test("a first run prints the baseline in order: the run, the users, the journeys and how each went, what held, what broke, the code, what was not measured, production", () => {
  const inCode = [{ ...firstRun.dissection.runOnly[0], id: "finding:9" }];
  const text = firstText({ ...firstRun.dissection, inCode });
  const order = [
    "This was the first run, the baseline: 96 conversations written from your code. The 5 simulated users below had 45 of them; the other 51 were not written for any one user.\nThe simulated users",
    "The simulated users, as Cortad found them in your code:",
    "Cortad found 7 journeys in your code; 22 of the 96 conversations followed one of them.",
    "How the conversations ended, judged on each one's last reply:",
    "  All 96 conversations: 87 of 96 completed fully or partly (73 fully): 91% (83% to 95%); 0 grew frustrated; 0 asked for a person midway.",
    "Questions that passed in every conversation, each asked often enough to show it fails less than one time in five:",
    "What broke, found only by running your app:",
    "finding:1  ",
    "Open gates, found by sending requests to your app's routes:",
    "Also in the code; a code review would also find these:",
    "finding:9  ",
    "What the numbers leave out, and why:",
    "  No conversation reached these 2 journeys: 运营监控会话与工单, 调试推理链路.",
    "Your app answered on accounts/fireworks/models/glm-5p3-flash.",
    "Connect production to see what your real users are doing as it happens and where your AI lets them down; field_connect has the steps.\n",
    "4 findings.",
    "The report is at https://cortad.com/lab",
  ].map((line) => text.indexOf(line));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), `in order: ${order}`);
  assert.match(text, /\n  网购消费者 \(role C端消费者\): 遇到小云解决不了的问题时尽快转接人工客服，让真人处理\. Writes .+\. 26 conversations; 25 of 26 completed fully or partly \(19 fully\): 96% \(81% to 99%, the likely range\)\.\n/);
  assert.match(text, /\n  申请退款或取消订单: 0 of 2 completed fully: 0% \(0% to 66%\)\. Failed most: "Does the reply show the customer part of the prompt .*" in 1 of 1\.\n/);
  assert.match(text, /\n  Passed in all 96 conversations it was tested in, so at most 4% would fail: "Does the reply break this rule of the product: /);
  assert.doesNotMatch(text, /place_order 生成/, "a rule about a tool that never ran is not said to hold");
  assert.equal(text.split("the likely range").length - 1, 1, "the interval is explained once");
  assert.doesNotMatch(text, /The next run is compared/);
  const page = text.slice(text.indexOf("This was the first run"), text.indexOf("4 findings."));
  assert.doesNotMatch(page, /(?<!verify )\btrials?\b/, "the page says conversations; verify conversations are the plan's unit");
  assert.deepEqual(page.split("\n").filter((l) => /production/i.test(l)), ["Connect production to see what your real users are doing as it happens and where your AI lets them down; field_connect has the steps."], "production is said once, at the end");
  assert.match(text, /\nnext: findings$/);
});

test("the first-run page stays under a page, the findings giving way to the picture, and a later run reads as before", () => {
  assert.ok(firstText().length < PAGE_CHARS, `the first run is ${firstText().length} characters`);
  const fat = (i) => ({ ...firstRun.dissection.runOnly[0], id: `finding:${i}`, asks: "q".repeat(300), exchange: { sent: "s".repeat(200), broke: "b".repeat(400) } });
  const long = (s, n) => `${s}${"字".repeat(n)}`;
  const b = firstRun.dissection.baseline;
  const crowded = { ...b,
    people: Array.from({ length: 30 }, (_, i) => ({ ...b.people[0], who: long(`user ${i}`, 80), wants: long("wants", 200), writes: long("writes", 120) })),
    journeys: { ...b.journeys, rows: Array.from({ length: 20 }, (_, i) => ({ ...b.journeys.rows[2], name: long(`journey ${i}`, 100), failedMost: [{ asks: long("a", 200), failed: 3, of: 4 }, { asks: long("b", 200), failed: 2, of: 4 }] })), unplayed: Array.from({ length: 12 }, (_, i) => long(`j${i}`, 60)) },
    heldEverywhere: Array.from({ length: 5 }, () => ({ asks: long("h", 300), of: 96, hi: 0.04 })) };
  const text = firstText({ ...firstRun.dissection, baseline: crowded, runOnly: Array.from({ length: 12 }, (_, i) => fat(i + 1)), inCode: [fat(20)] });
  assert.ok(text.length < PAGE_CHARS, `the crowded first run is ${text.length} characters`);
  assert.match(text, /\n  and 24 more users\.\n/);
  assert.match(text, /\n  and 14 more journeys; findings numbers has each one\.\n/);
  assert.match(text, /\nfindings shows the last \d+ findings in full; \d+ of them are not listed here\.\n/);
  for (const id of ["access:1", "access:2", "access:3"]) assert.match(text, new RegExp(`\\b${id}\\b`), "an open gate is always named");
  assert.match(text, /\nnext: findings$/);
  const leading = firstText({ ...firstRun.dissection, baseline: crowded, runOnly: Array.from({ length: 12 }, (_, i) => ({ ...fat(i + 1), leads: true })), inCode: [{ ...fat(20), leads: true }] });
  assert.ok(leading.length < PAGE_CHARS, `the crowded first run with leading findings is ${leading.length} characters`);
  for (const id of ["finding:1", "finding:12", "finding:20", "access:3"]) assert.match(leading, new RegExp(`\\b${id}\\b`), `${id} is named`);
  assert.ok(leading.includes(`\n${planLine(plan)}\n`), "the plan line stays on the page");
  assert.match(leading, /\nnext: findings$/);
  const later = firstText({ ...firstRun.dissection, baseline: undefined });
  assert.match(later, /^Run b2521a2f-[\w-]+: finished, 96 of 96 conversations played\.\nYour app answered on /);
  assert.doesNotMatch(later, /first run|The simulated users/);
});

test("past the room on the page, findings sure enough to act on are named by id, so twenty of them leave the plan and the next call on the page", () => {
  const runOnly = Array.from({ length: 20 }, (_, i) => ({ ...firstRun.dissection.runOnly[0], id: `finding:${i + 1}`, leads: true }));
  const text = firstText({ ...firstRun.dissection, runOnly });
  assert.ok(text.length < PAGE_CHARS, `the first run with 20 leading findings is ${text.length} characters`);
  assert.match(text, /\nAlso to act on, each shown in full by findings: (finding:\d+, )+finding:20, access:1, access:2, access:3\.\n/);
  for (let i = 1; i <= 20; i++) assert.match(text, new RegExp(`\\bfinding:${i}\\b`), `finding:${i} is named`);
  assert.ok(text.includes(`\n${planLine(plan)}\n`), "the plan line stays on the page");
  assert.match(text, /\nnext: findings$/);
});

test("a first run on an app whose production is connected says so, and one that measured nothing says only that", () => {
  const connected = firstText({ ...firstRun.dissection, baseline: { ...firstRun.dissection.baseline, production: true } });
  assert.match(connected, /\nProduction is connected: field shows what your real users are doing and where your AI lets them down\.\n/);
  const nothing = firstText({ ...firstRun.dissection, unmeasured: "No reply came back from your app to any of the 44 messages sent before the run's clock ran out, so nothing was measured." });
  assert.match(nothing, /\nThis run measured nothing\. /);
  assert.doesNotMatch(nothing, /baseline|The simulated users/);
});

test("a verify whose failure is gone, and gone or less often on the conversations kept back, offers production to the person while it is not connected", () => {
  const verify = (v, field = { connected: false }) => runText({ jobId: "v", kind: "verify", status: "succeeded", finished: true, plan, field, url: "https://cortad.com/lab",
    verify: { findingId: "finding:1", file: "backend/degradation.py", line: 104, said: "The failure is gone on its own conversations: none of 12 replays failed.", verdict: "gone", heldOut: { moved: "gone" }, ...v } });
  for (const moved of ["gone", "less often"]) {
    assert.match(verify({ heldOut: { moved } }), /\nThe failure in finding:1 is gone on its replays\. Connecting production shows what real users are doing as it happens; field_connect has the steps\.\nThe report is at https:\/\/cortad\.com\/lab\nnext: findings$/);
  }
  // Still failing on the conversations kept back, or never tried on them, a fix may only fit its own replays.
  const unproven = [{ moved: "not decided" }, { moved: "worse" }, null].map((heldOut) => verify({ heldOut }));
  for (const text of [verify({ verdict: "stayed" }), verify({ verdict: "less often" }), ...unproven, verify({}, { connected: true }), verify({}, null)]) {
    assert.doesNotMatch(text, /Connect production/);
  }
  assert.doesNotMatch(runText({ jobId: "j", kind: "run", status: "succeeded", finished: true, played: 3, of: 3, field: { connected: false }, verify: { verdict: "gone" } }), /Connect production/, "a run is no verify");
});

// The founder's ruling of 2026-10-01: a word that hides its number is never printed. The API's fields
// keep their names (heldBack, heldOut, held, unsettled, moved); every verb says the count instead.
test("no verb prints a word that hides its number, whatever the fields are called", () => {
  const heldBack = [{ surface: "POST /api/upload", trials: 7, why: "the route needs a signed file URL" }, { surface: "Admin console", trials: 2, why: "not testable here" }];
  const run = { jobId: "j", kind: "run", status: "succeeded", finished: true, played: 51, of: 51, findings: 2, settled: 1, heldBack,
    trials: { written: 60, chosen: 51, played: 51, notPlayed: 0, heldBack: 9, notPlanned: 0 }, questionsAsked: 112, questionsOf: 140,
    notMeasured: { total: 28, groups: [{ id: "conversation", count: 28, said: "28 need a conversation past the first reply", checks: [] }] },
    promises: { decided: 38, held: 27, failed: 11 },
    top: { id: "finding:1", asks: "Does the reply state a refund policy?", unsettled: true, trials: { failed: 2, of: 7, lo: 0.08, hi: 0.64 }, quotes: [] } };
  const baseline = { conversations: 51, users: 1, people: [], journeys: { read: 1, rows: [], unplayed: ["account recovery"] },
    all: { got: { k: 41, full: 29, of: 51, lo: 0.68, hi: 0.89 }, unsure: 3, unclear: 3 }, heldEverywhere: [{ asks: "Does the reply keep the name out?", of: 51, hi: 0.07 }] };
  const read = { rules: { count: 2, examples: [{ text: "Cite the lesson.", measured: { asked: 30, held: 21 } }, { text: "Copy each excerpt.", measured: null }] },
    trials: { written: 58, held: [{ surface: "POST /api/upload", n: 7, why: "the route needs a signed file URL", side: "theirs" }] } };
  const contact = { proven: [{ door: "POST /api/chat", requests: 2, session: { held: true, carrier: "body", key: "sessionId" }, standing: "excluded", side: "ours", why: "The instructions the model was given are not written in your code." }], notCalled: [],
    ready: { trials: 36, blocked: [{ door: "POST /api/chat", side: "ours", why: "The instructions the model was given are not written in your code." }] } };
  const regressed = { before: { k: 8, n: 8 }, after: { k: 2, n: 8 }, moved: "regressed", point: -75 };
  const measure = { id: "outcome", title: "Where each trial ended", kind: "measure", unit: "trials", classes: ["resolved", "unresolved"], badSaid: "ended unresolved",
    all: { value: "all", of: 40, counts: { resolved: 30, unresolved: 6 }, unsure: 4, unclear: 4, bad: { k: 6, lo: 0.07, hi: 0.3 } },
    by: { journey: [{ value: "billing", of: 9, counts: { resolved: 5, unresolved: 2 }, unsure: 2, bad: { k: 2, lo: 0.06, hi: 0.55 } }, { value: "homework", of: 31, counts: { resolved: 25, unresolved: 4 }, unsure: 2, bad: { k: 4, lo: 0.05, hi: 0.3 } }] } };
  const printed = [
    statusText({ repository: { name: "app" }, read, contact, run }),
    runText({ ...run, dissection: { run: { id: "j", played: 51, planned: 51 }, runOnly: [], held: null, notMeasured: null, baseline } }),
    runText({ jobId: "v", kind: "verify", status: "succeeded", finished: true, played: 5, of: 5, field: { connected: false },
      verify: { findingId: "finding:1", verdict: "gone", visible: regressed, heldOut: regressed, said: "The failure is gone on its own conversations: none of 3 replays failed." } }),
    findingsText({ runId: "r", ...run, heldBack: "2 findings stand in 3 situations kept back from you.", findings: [
      { ...run.top, file: "a.ts", line: 3 },
      { id: "finding:2", asks: "Does the reply quote a price?", unsettled: true, rate: { k: 1, n: 9, lo: 0.02, hi: 0.4 }, quotes: [] },
    ], keptBack: [{ id: "finding:3", asks: "Does the reply keep the refund policy?", reply: 2, rate: { k: 1, n: 6 } }] }),
    refusedText({ why: "This account has used its one run this month.", ledger: { fixed: [{ findingId: "finding:1", verdict: "gone", before: { trials: 3, failed: 3 }, after: { replays: 3, failed: 0 }, heldOut: regressed }], nextRun: { trials: 58, heldOut: 7, newFromChanges: 5 } } }),
    fieldText({ days: 30, totals: { n: 4812, read: 4790, rulings: 61204, rulingsHeld: 56920, rulingsUnsure: 1120, resolved: 3401, frustrated: 287, wantsHuman: 96, unanswered: 191 },
      journeys: [{ value: "homework help", n: 3102, rulings: 40000, rulingsHeld: 37600 }] }),
    numbersText({ numbers: { runId: "r", trials: 40, replies: 108, readings: 1249, measures: [measure], questions: [] } }),
    showText({ read }, "trials"),
    showText({ read }, "rules"),
  ].join("\n");
  assert.doesNotMatch(printed, /\b(?:held|regressed|improved|unsettled|unclear|unsure|partially|not measured|not checked|did(?:n't| not) check|never came up|could not (?:be told|decide|settle|tell)|too few)\b/i);
  for (const said of ["9 set aside", "Set aside: 7 conversations", "7 conversations, on the app's side", "7 saved to test fixes", "passed in 21", "asked of no reply yet", "28 questions with no reply to read",
    "too close to call (between 35 and 85 in 100)", "Rules kept: 93% of 61,204 (1,120 too close to call)", "94% passed", "That is on Cortad's side, not your app's.", "tied by the body field", "What the numbers leave out"]) {
    assert.ok(printed.includes(said), `"${said}" is printed`);
  }
});

// A read still running sent its lists as zeros ("Journeys (0)", "Questions: 0; 0 asked in every conversation").
test("while the read runs, status says so once and lists none of its sections", () => {
  const read = { complete: false, rules: { count: 0, examples: [] }, journeys: { count: 0, names: [] }, profiles: { count: 0, names: [] }, questions: { total: 0, everywhere: 0, placed: 0 }, trials: { written: 0 } };
  assert.equal(statusText({ repository: { name: "app" }, read, run: null, links: { lab: "https://cortad.com/lab" } }), "Repository: app.\nYour code is still being read.\nThe person sees this at https://cortad.com/lab");
});

test("findings before any run says so once", () => {
  assert.equal(findingsText({ runId: null, findings: [], why: "No run has finished on this repository yet." }), "No run has finished on this repository yet.");
});

test("status opens with what changed since the last call", () => {
  const text = statusText({ repository: { name: "sample" }, news: ["Reading your code finished: 34 rules, 8 journeys, 5 endpoints."], run: null });
  const lines = text.split("\n");
  assert.deepEqual(lines.slice(0, 3), ["Repository: sample.", "New since your last call:", "  Reading your code finished: 34 rules, 8 journeys, 5 endpoints."]);
  assert.doesNotMatch(statusText({ repository: { name: "sample" }, run: null }), /New since/);
});

// Run 55bf05f4 (2026-10-02): 89 conversations counted as played and 90 with a reply read at their
// end, and the baseline said "All 89 conversations: 67 of 90".
test("the baseline's line on all conversations counts the conversations its own fraction is of", () => {
  const data = structuredClone(firstRun);
  const b = data.dissection?.baseline ?? data.baseline;
  b.all.got = { ...b.all.got, of: b.conversations + 1 };
  const text = runText(data);
  assert.match(text, new RegExp(`\\n  All ${b.conversations + 1} conversations: \\d+ of ${b.conversations + 1} completed fully or partly`));
});

test("findings with no run to read says the server's own reason when it sent one", () => {
  const why = "Run 1a2b was scored before its replies were read question by question, so it carries no findings. Start a run to get them.";
  assert.equal(findingsText({ findings: [], why }), why);
  assert.equal(findingsText({ findings: [] }), "No run has finished on this repository yet.");
});

test("a finding names its endpoint once: the server's where is said without it, and so is each place it also failed", () => {
  const f = { id: "finding:1", questionId: "q1", asks: "Does the reply quote a price?", door: "Student chat", where: "plan free, Student chat",
    trials: { failed: 3, of: 9, lo: 0.12, hi: 0.65 },
    alsoIn: [{ questionId: "q1", where: "plan pro, Student chat", door: "Student chat", rate: { k: 2, n: 5 }, trials: { failed: 2, of: 5 } }] };
  const text = findingsText({ runId: "r", findings: [f] });
  assert.match(text, /\n  Failed in 3 of 9 conversations at Student chat: 33% \(12% to 65%\)\.\n/);
  assert.match(text, /\n  Where: plan free\n/);
  assert.match(text, /\n    Student chat, plan pro: failed in 2 of 5 conversations\n?/);
});

test("a run that played cases from their own eval files says how each file came out, and heads their findings as theirs", () => {
  const evals = { files: [{ file: "scripts/fidelity-cases.json", cases: 9, played: 9, passed: 7, failed: 2, unclear: 0 }, { file: "scripts/eval-kb-live.ts", cases: 40, played: 30, passed: 25, failed: 3, unclear: 2 }], total: { cases: 49, played: 39, passed: 32, failed: 5, unclear: 2 } };
  const finding = { id: "finding:1", group: "eval", questionId: "eval:scripts/fidelity-cases.json:avoids", asks: "Never says what your eval forbids (fidelity-cases.json)", file: "scripts/fidelity-cases.json", line: 14, rate: { k: 2, n: 9, lo: 0.04, hi: 0.6, said: "2 of 9" }, decidedBy: { code: 2, reader: 0 }, quotes: [] };
  const text = runText({ jobId: "j", kind: "run", status: "succeeded", finished: true, played: 39, of: 39, findings: 1, settled: 1, questionsAsked: 10, questionsOf: 12, evals });
  assert.match(text, /Your own eval files: 32 of 39 cases passed, 5 failed, 2 not settled, 10 not played\./);
  assert.match(text, /  scripts\/fidelity-cases\.json: 7 of 9 cases passed, 2 failed\./);
  const pages = findingsText({ runId: "j", findings: [finding, { ...finding, id: "finding:2" }] });
  const all = Array.isArray(pages) ? pages.join("\n") : String(pages);
  assert.equal(all.split("From your own eval files:").length - 1, 1, "headed once");
  assert.match(all, /From your own eval files:\nfinding:1  Never says what your eval forbids \(fidelity-cases\.json\)/);
});

test("a failure that did not come back when it was played again says so, and says it is worth less", () => {
  const base = { id: "finding:1", questionId: "rule:x", asks: "Gives a refund past the window", file: "src/prompt.ts", line: 9,
    rate: { k: 3, n: 20, lo: 0.04, hi: 0.4, said: "3 of 20" }, decidedBy: { code: 0, reader: 3 }, quotes: [] };
  const shown = (f) => { const p = findingsText({ runId: "j", findings: [f] }); return Array.isArray(p) ? p.join("\n") : String(p); };
  assert.match(shown({ ...base, cameBack: { played: 3, again: 0 } }),
    /Played over again: 3 conversations of its own, word for word from nothing, and it did not fail again in any of them\. Worth less of your time than one that came back\./);
  assert.match(shown({ ...base, cameBack: { played: 3, again: 2 } }), /3 conversations of its own.*failed again in 2\./);
  assert.match(shown({ ...base, cameBack: { played: 1, again: 1 } }), /1 conversation of its own/, "one is not one conversations");
  // The run only replays failures, up to twelve, so most findings carry none of this and say nothing.
  assert.doesNotMatch(shown(base), /Played over again/);
});

test("a finished run says what it decided and what nothing breaking is worth on that many", () => {
  const clean = runText({ jobId: "j", kind: "run", status: "succeeded", finished: true, played: 48, of: 48, findings: 0, settled: 48,
    sensitivity: { settled: 48, rate: 1, detectable: null, forTenPoints: null, ceiling: 7.4, short: null,
      said: "This run decided 48 conversations on your app's own promises and none of them broke a check. On this many, that puts the share of replies breaking these checks under about 7.4%." } });
  assert.match(clean, /none of them broke a check\. On this many, that puts the share of replies breaking these checks under about 7\.4%\./);
  // The case it used to answer with silence: a run that cannot say is the one that most has to say so.
  const thin = runText({ jobId: "j", kind: "run", status: "succeeded", finished: true, played: 9, of: 9, findings: 0, settled: 9,
    sensitivity: { settled: 9, rate: 1, detectable: null, forTenPoints: null, ceiling: null, short: 13,
      said: "This run decided 9 conversations on your app's own promises and none of them broke a check. That is too few to say how often it holds: about 13 more decided would be." } });
  assert.match(thin, /too few to say how often it holds: about 13 more decided would be/);
  // Nothing invented where the server sent no sentence.
  assert.doesNotMatch(runText({ jobId: "j", kind: "run", status: "succeeded", finished: true, played: 4, of: 4, findings: 0, settled: 4 }), /decided 4 conversations/);
});

test("questions their file asks with no answer of its own are said apart, and what was left out is said with the reason", () => {
  const evals = {
    files: [{ file: "evals/quick_answer/traps.json", cases: 34, played: 34, passed: 31, failed: 3, unclear: 0, open: 0 },
      { file: "evals/kw_agent/dataset.json", cases: 0, played: 0, passed: 0, failed: 0, unclear: 0, open: 32 }],
    total: { cases: 34, played: 34, passed: 31, failed: 3, unclear: 0, open: 32 },
    left: { "the message our reader listed is not in the file": 4 },
  };
  const text = runText({ jobId: "j", kind: "run", status: "succeeded", finished: true, played: 66, of: 66, findings: 3, settled: 3, evals });
  assert.match(text, /Your own eval files: 31 of 34 cases passed, 3 failed, and 32 more questions it asks with no answer of its own, read against your rules\./);
  assert.match(text, /  evals\/kw_agent\/dataset\.json: 32 questions played, read against your rules, since the files expect no answers of their own\./);
  assert.match(text, /  4 cases of yours were left out: the message our reader listed is not in the file\./);
});

test("a file whose questions all come with no answer of its own still says what it played", () => {
  const evals = { files: [{ file: "evals/kw_agent/dataset.json", cases: 0, played: 0, passed: 0, failed: 0, unclear: 0, open: 1 }], total: { cases: 0, played: 0, passed: 0, failed: 0, unclear: 0, open: 1 } };
  const text = runText({ jobId: "j", kind: "run", status: "succeeded", finished: true, played: 1, of: 1, findings: 0, settled: 0, evals });
  assert.match(text, /Your own eval files: 1 question played, read against your rules, since the file expects no answer of its own\./);
});
