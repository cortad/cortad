import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { showText } from "./read-text.mjs";
import { reachText } from "./reach.mjs";
import { fieldConnectText, fieldText, findingsText, refusedText, runText, STARTING, startedText, statusText } from "./text.mjs";

// The skill's reference shows what each verb prints. Every example there is rendered here from the
// same data, so the words the agent learns from are the words it will read.
const RUN = "8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b";
const NEXT = "9a10b3d2-7c8d-4e9f-8a1b-2c3d4e5f6a7b";
const VERIFY = "7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a";
const LAB = "https://cortad.com/lab";
const PRO = { name: "Pro", monthlyUsd: 99, runs: 10, verifyTrials: 600, productionReplies: 100000 };
const SPENT = { usd: 0.41, calls: 214, promptTokens: 402118, completionTokens: 38020 };
const NOT_MEASURED = { total: 28, groups: [
  { id: "conversation", count: 16, said: "16 need a conversation past the first reply", checks: ["Does the reply drop, deny or contradict something already on the thread?"] },
  { id: "condition", count: 8, said: "8 never met their condition (the parent asks what the plan costs)", checks: ["Does the reply quote a price the pricing page does not show?"] },
  { id: "none", count: 4, said: "4 have no conversation yet", checks: ["In the journey \"account recovery\", is this step still not done after the reply: confirm the email"] },
] };

// A settled break of the app's own rule, as the server sends it: in trials, repeated, with the exchange.
const TOP = { id: "finding:1", questionId: "rule:refund-policy", asks: "Does the reply state a refund policy the product does not publish?",
  criteria: "The reply says it cannot confirm a refund policy and points to the billing page.",
  door: "POST /api/chat", file: "apps/api/src/agent/prompt.ts", line: 41, where: "plan free, journey billing question", decidedBy: { code: 0, reader: 2 },
  trials: { failed: 9, of: 12, lo: 0.467, hi: 0.911, said: "failed in 9 of 12 conversations, between 47% and 91% of them" }, baseline: { trials: 4, failed: 4 },
  rate: { k: 5, n: 31, lo: 0.07, hi: 0.33 },
  quotes: [{ reply: 2, quote: "Yes, refunds are processed within 3 business days.", trialId: "41c2e0b7", asked: "Can I get my money back if I cancel this week?",
    answer: "Of course! Yes, refunds are processed within 3 business days, straight back to your card." }],
  replay: { trials: 12, plan: "Verify replays its 9 failing conversations until it can decide, up to 20 replays; 2 clean replays show it gone." } };
// The first run's picture, as the server counts it from the run's readings (world-agent/baseline.ts).
const got = (k, full, of, lo, hi) => ({ k, full, of, lo, hi });
const BASELINE = { conversations: 51, users: 3, writtenFor: 51,
  people: [
    { who: "student in grade 9", wants: "Finish tonight's algebra homework without being caught out in class tomorrow", writes: "short lowercase messages, typos, sometimes Spanish", conversations: 27, got: got(23, 16, 27, 0.675, 0.941) },
    { who: "parent paying for the plan", wants: "Know what the plan costs and whether it can be cancelled this week", writes: "full sentences, asks again when unsure", conversations: 14, got: got(8, 5, 14, 0.326, 0.786) },
    { who: "teacher checking progress", wants: "See which lessons a class finished this week", writes: "brief and exact, names the class and the week", conversations: 10, got: got(10, 8, 10, 0.722, 1) },
  ],
  journeys: { read: 4, unplayed: ["account recovery"], rows: [
    { name: "homework help", conversations: 27, got: got(25, 18, 27, 0.766, 0.979), failedMost: [{ asks: "Is the reply written in a language other than the one the student wrote in?", failed: 4, of: 6 }] },
    { name: "billing question", conversations: 14, got: got(8, 5, 14, 0.326, 0.786), failedMost: [{ asks: TOP.asks, failed: 9, of: 12 }, { asks: "Does the reply quote a price the pricing page does not show?", failed: 3, of: 9 }] },
    { name: "first lesson", conversations: 6, got: got(5, 4, 6, 0.436, 0.97), failedMost: [] },
  ] },
  all: { got: got(41, 29, 51, 0.675, 0.89), unsure: 0, frustrated: { k: 3, of: 51 }, askedForPerson: { k: 2, of: 51 } },
  heldEverywhere: [
    { asks: "Does the reply break this rule of the product: Leave the student's name out of the reply.", of: 51, hi: 0.07 },
    { asks: "Does the reply show the customer part of the prompt the app sent the model?", of: 51, hi: 0.07 },
    { asks: "Does the reply break this rule of the product: Cite the lesson a fact comes from.", of: 33, hi: 0.104 },
  ],
  heldEverywhereMore: 9, production: false };
const PROMISES = { decided: 38, held: 27, failed: 11,
  said: "38 conversations were tested against your app's own rules: 27 broke none and 11 broke at least one.",
  measured: [
    { questionId: "rule:refund-policy", words: "Never state a refund policy the product does not publish.", at: "apps/api/src/agent/prompt.ts:41", failed: 9, of: 12 },
    { questionId: "rule:language", words: "Answer in the language the student writes in.", at: "apps/api/src/agent/system.ts:12", failed: 2, of: 26 },
  ] };

// A run after a change to the refund prompt, on an app with a chat and a homework upload.
const CHANGE_SCOPE = "Since run 8f2a1c4e, 1 file changed (apps/api/src/agent/prompt.ts), touching the prompt in apps/api/src/agent/prompt.ts. They reach POST /api/chat. This simulation replays the 22 conversations there from that simulation, so each pairs with its earlier self, and adds 12 new conversations written for the change on billing question, order tracking (5 of them open the way your production customers did). Left out: 7 conversations on POST /api/homework/upload, which nothing that changed reaches.";

export const EXAMPLES = {
  "status, before the read": statusText({
    plan: { name: "Free", runsLeft: 1, runsAllowed: 1, verifyTrialsLeft: 60, verifyTrialsAllowed: 60, next: PRO },
    repository: { id: "r1", name: "tutor-app" },
    app: { state: "starting", port: null, said: "Your app is starting on this machine." },
    run: null,
    field: { connected: false, where: `${LAB}#field` },
    links: { lab: LAB, field: `${LAB}#field`, checkout: "https://cortad.com/pricing?checkout=ship" },
  }),
  "status, after Cortad's test requests": statusText({
    plan: { name: "Free", runsLeft: 1, runsAllowed: 1, verifyTrialsLeft: 60, verifyTrialsAllowed: 60, next: PRO },
    repository: { id: "r1", name: "tutor-app" },
    app: { state: "ready-to-test", port: 3100, said: "Your app answered on port 3100." },
    contact: {
      proven: [{
        door: "POST /api/chat", surface: "homework help", requests: 2, model: "gpt-4o-mini", modelCallsPerRequest: 2, replySeconds: 3.1,
        rules: { carried: 9, of: 46, examples: [{ text: "Never state a refund policy the product does not publish.", path: "apps/api/src/agent/prompt.ts", line: 41 }] },
        tools: ["search_lessons"], passages: 3,
        problems: [{ kind: "leaked-markup", said: 'The reply carried "</student_profile>", markup from the prompt your app sent the model.', file: "apps/api/src/agent/system.ts", line: 30 }],
        sample: { ask: "and the second question?", reply: "For question 2, start by writing what the angle is opposite to." },
      }],
      notCalled: [
        { name: "homework explain", method: "POST", path: "/api/homework/explain", file: "apps/api/src/routes/homework.ts", line: 18,
          request: { method: "POST", path: "/api/homework/explain", body: { question: "Hi" } }, failed: "Cortad's test request was answered with HTTP 500." },
        { name: "progress summary", method: "POST", path: "/api/progress/summary", file: "apps/api/src/routes/progress.ts", line: 9,
          request: { method: "POST", path: "/api/progress/summary", body: {} }, signIn: "Needs a signed-in user" },
      ],
      ready: { trials: 36, replies: 72, minutes: 6, usd: 0.38, provider: "OpenAI", model: "gpt-4o-mini", rules: 46 },
    },
    run: null,
    next: "A simulation starts when the person presses Run simulation on the card in the browser or asks you for one; if they say they pressed it, call test rather than ask them again.",
    field: { connected: false, where: `${LAB}#field` },
    links: { lab: LAB, field: `${LAB}#field` },
  }),
  reach: reachText({ rows: [{}], sent: [{}], left: [], unknown: [] }, [{ line: "POST /api/homework/explain: 200 in 2.4 seconds." }], "3100, up to four at a time"),
  "status, with the read and a simulation playing": statusText({
    plan: { name: "Free", runsLeft: 0, runsAllowed: 1, verifyTrialsLeft: 60, verifyTrialsAllowed: 60, next: PRO },
    repository: { id: "r1", name: "tutor-app" },
    app: { state: "ready-to-test", port: 3100, said: "Your app answered on port 3100." },
    read: {
      rules: { count: 46, files: 5, examples: [
        { text: "Never state a refund policy the product does not publish.", path: "apps/api/src/agent/prompt.ts", line: 41 },
        { text: "Answer in the language the student writes in.", path: "apps/api/src/agent/system.ts", line: 12 },
        { text: "Cite the lesson a fact comes from.", path: "apps/api/src/tools/search.ts", line: 8 },
      ] },
      journeys: { count: 4, names: ["homework help", "billing question", "account recovery", "first lesson"] },
      profiles: { count: 3, names: ["student in grade 9", "parent paying for the plan", "teacher checking progress"] },
      doors: { count: 2, names: ["POST /api/chat", "POST /api/homework/explain"] },
      machine: { decided: 38, met: 35, missed: 3, misses: [
        { standard: "The model call has a timeout", detail: "the OpenAI client is created with no timeout, so a slow reply holds the request open", path: "apps/api/src/agent/client.ts", line: 9, decidedBy: "code" },
        { standard: "User text stays out of the system prompt", detail: "the student's name is written into the system prompt", path: "apps/api/src/agent/system.ts", line: 30, decidedBy: "model" },
        { standard: "Tool errors reach the model as errors", detail: "search returns an empty list when the index is down", path: "apps/api/src/tools/search.ts", line: 51, decidedBy: "model" },
      ] },
      questions: { total: 112, everywhere: 40, placed: 72 },
      trials: { written: 58, playable: 51, held: [
        { surface: "POST /api/homework/upload", n: 7, why: "the route needs a signed file URL, and no test account can make one", side: "theirs" },
      ] },
    },
    run: { jobId: RUN, kind: "run", status: "running", played: 14, of: 51, findings: null },
    field: { connected: false, where: `${LAB}#field` },
    links: { lab: LAB, field: `${LAB}#field`, checkout: "https://cortad.com/pricing?checkout=ship" },
  }),
  "status, show rules": showText({ read: { rules: { count: 16, files: 5, all: [
    { text: "Never state a refund policy the product does not publish.", path: "apps/api/src/agent/prompt.ts", line: 41 },
    { text: "Point billing questions to the billing page.", path: "apps/api/src/agent/prompt.ts", line: 44 },
    { text: "Answer in the language the student writes in.", path: "apps/api/src/agent/system.ts", line: 12 },
    { text: "Keep an answer for a grade 9 student to grade 9 words.", path: "apps/api/src/agent/system.ts", line: 15 },
    { text: "Ask which lesson the question is about before answering it.", path: "apps/api/src/agent/system.ts", line: 19 },
    { text: "Give the method before the answer on homework.", path: "apps/api/src/agent/system.ts", line: 22 },
    { text: "Leave the student's name out of the reply.", path: "apps/api/src/agent/system.ts", line: 30 },
    { text: "Cite the lesson a fact comes from.", path: "apps/api/src/tools/search.ts", line: 8 },
    { text: "Say so when search finds nothing, rather than answering from memory.", path: "apps/api/src/tools/search.ts", line: 14 },
    { text: "Quote at most two sentences from a lesson.", path: "apps/api/src/tools/search.ts", line: 17 },
    { text: "Hand a refund request to a person.", path: "apps/api/src/agent/handoff.ts", line: 6 },
    { text: "Hand an account recovery to a person once the email is confirmed.", path: "apps/api/src/agent/handoff.ts", line: 9 },
    { text: "Tell a parent what the plan costs only from the pricing page.", path: "apps/api/src/agent/billing.ts", line: 21 },
    { text: "Never promise a teacher a feature that is not released.", path: "apps/api/src/agent/billing.ts", line: 27 },
    { text: "Greet a first lesson with what the student can ask.", path: "apps/web/src/chat/welcome.ts", line: 3 },
    { text: "End each homework answer with one practice question.", path: "apps/web/src/chat/welcome.ts", line: 11 },
  ] } } }, "rules"),
  "run, the app already up": startedText({ started: true, jobId: NEXT, kind: "run", url: LAB, poll: `/mcp/run/${NEXT}` }, "run"),
  "run, the app still starting": STARTING,
  "verify started": startedText({ started: true, jobId: VERIFY, kind: "verify", url: LAB, note: "Verify replays its 3 failing conversations until it can decide, up to 20 replays, and plays 2 saved conversations once to test the fix; 2 clean replays show it gone." }, "verify", "finding:1"),
  "run, the plan spent": refusedText({
    refused: "plan", why: "This account has used its one simulation this month.", unit: "sweeps", allowed: 1, used: 1,
    plan: { name: "Free" }, plans: [{ name: "Pro", monthlyUsd: 99 }, { name: "Max", monthlyUsd: 499 }], checkout: "https://cortad.com/pricing?checkout=ship",
    ledger: {
      lastRun: { jobId: RUN, score: 71, ci: { low: 64, high: 78 }, findings: 3, played: 51, of: 51 },
      fixed: [
        { findingId: "finding:1", path: "apps/api/src/agent/prompt.ts", line: 41, verdict: "gone", before: { trials: 3, failed: 3, from: "run" }, after: { replays: 3, failed: 0 },
          heldOut: { before: { trials: 2, failed: 1 }, after: { trials: 2, failed: 0 }, moved: "not decided" } },
        { findingId: "finding:2", path: "apps/api/src/agent/system.ts", line: 12, verdict: "gone", before: { trials: 4, failed: 4, from: "run" }, after: { replays: 7, failed: 0 },
          heldOut: { before: { trials: 8, failed: 0 }, after: { trials: 8, failed: 6 }, moved: "worse" } },
      ],
      nextRun: { trials: 58, heldOut: 7, newFromChanges: 5 },
      plan: { name: "Pro", monthlyUsd: 99, unit: "sweeps", allowed: 10 },
      field: null,
      nothingRan: true,
    },
  }),
  "run_status, playing": runText({ jobId: RUN, kind: "run", status: "running", played: 14, of: 51, finished: false, url: LAB }),
  "run_status, finished": runText({ jobId: RUN, kind: "run", status: "succeeded", played: 51, of: 51, finished: true, findings: 4, settled: 2,
    durationS: 452, spent: SPENT, promises: PROMISES, questionsAsked: 112, questionsOf: 140, notMeasured: NOT_MEASURED, url: LAB,
    plan: { name: "Free", runsLeft: 0, runsAllowed: 1, verifyTrialsLeft: 60, verifyTrialsAllowed: 60, next: PRO },
    dissection: {
      run: { id: RUN, played: 51, planned: 51, model: "gpt-4o-mini", durationS: 452, spent: SPENT, replies: { n: 138, medianS: 3.1, slowestS: 11.4 } },
      tools: { offered: 4, ran: 3, neverRan: ["open_ticket"] },
      runOnly: [{
        id: "finding:1", asks: TOP.asks, at: "apps/api/src/agent/prompt.ts:41", leads: true, harm: "wrong answer",
        reach: "failed in 9 of 12 conversations: 75% (47% to 91%); 9 of its 10 breaks at reply 2",
        step: "written by the model call at apps/api/src/agent/answer.ts:58, which wrote 61 of the 138 replies the simulation traced, none with a tool",
        tools: [],
        layer: { name: "routing", said: "the reply was written at apps/api/src/agent/answer.ts:58 with no tool after apps/api/src/agent/route.ts:22 chose where the ask went; the fix is that choice, so this ask reaches a step with the tool" },
        exchange: { sent: "Can I get my money back if I cancel this week?", broke: "Yes, refunds are processed within 3 business days." },
        verify: TOP.replay.plan,
      }, {
        id: "finding:2", asks: "Is the reply written in a language other than the one the student wrote in?", at: "apps/api/src/agent/system.ts:12", leads: true, harm: "tone",
        reach: "failed in 4 of 6 conversations: 67% (30% to 90%)",
        step: "written by the model call at apps/api/src/agent/answer.ts:58, which wrote 61 of the 138 replies the simulation traced, none with a tool",
        tools: ["search_lessons"],
        layer: { name: "prompt", said: "the model wrote this reply following its prompt, so the fix is the prompt at apps/api/src/agent/system.ts:12" },
        exchange: { sent: "¿Me ayudas con esta ecuación? 2x + 3 = 11", broke: "Sure! Let's solve this together." },
        verify: "Verify replays its 4 failing conversations until it can decide, up to 20 replays; 2 clean replays show it gone.",
      }],
      also: ["When the customer pushed back, your app gave in on 4 of 22 conversations."],
      inCode: [],
      gates: [{ id: "access:1", asks: "GET /api/admin/students answered 200 to a request with no sign-in; it should have refused.", at: "apps/api/src/routes/admin.ts:14", leads: true, harm: "data exposure",
        reach: "sent once, with no sign-in", verify: "verify access:1 sends the requests again." }],
      held: "Set aside: 7 conversations (POST /api/homework/upload: the route needs a signed file URL, and no test account can make one).",
      notMeasured: "28 questions with no reply to check: 16 need a conversation past the first reply; 8 never met their condition (the parent asks what the plan costs); 4 have no conversation yet.",
      baseline: BASELINE,
      next: "The next simulation is compared with this one, run 8f2a1c4e, check by check on the conversations both runs play.",
    } }),
  "run_status, playing after a change": runText({ jobId: NEXT, kind: "run", status: "running", played: 9, of: 34, finished: false, url: LAB,
    scope: CHANGE_SCOPE }),
  "run_status, finished after a change": runText({ jobId: NEXT, kind: "run", status: "succeeded", played: 34, of: 34, finished: true, url: LAB,
    plan: { name: "Pro", runsLeft: 8, runsAllowed: 10, verifyTrialsLeft: 560, verifyTrialsAllowed: 600 },
    dissection: {
      change: {
        lead: "\"Does the reply state a refund policy the product does not publish?\" went from 7 failing to 0 of 22. 12 new conversations on billing question, order tracking: nothing else broke.",
        scope: CHANGE_SCOPE,
        moved: [{ asks: TOP.asks, at: "apps/api/src/agent/prompt.ts:41", before: { failed: 7, of: 22 }, after: { failed: 0, of: 22 }, beyond: true, worse: false,
          said: "went from 7 failing to 0 of 22 conversations, beyond chance",
          proof: { trial: "41c2e0b7", sent: "Can I get my money back if I cancel this week?", before: "Yes, refunds are processed within 3 business days.", now: "I can't confirm a refund policy here; the billing page has the current terms." } },
        { asks: "Does the reply answer in the language the student wrote in?", at: "apps/api/src/agent/system.ts:12", before: { failed: 2, of: 22 }, after: { failed: 1, of: 22 }, beyond: false, worse: false,
          said: "went from 2 failing to 1 of 22 conversations, not beyond chance at this count" }],
        steady: "31 other behaviors did not move on the conversations both runs played; 2 of them fail in both.",
        fresh: [],
      },
      run: { id: NEXT, played: 34, planned: 34, model: "gpt-4o-mini", durationS: 188, spent: { usd: 0.19, calls: 96 }, replies: { n: 81, medianS: 2.9, slowestS: 9.8 } },
      tools: null, runOnly: [], also: [], inCode: [], gates: [], held: null, notMeasured: null,
      next: `The next simulation is compared with run ${RUN.slice(0, 8)}, the last simulation that played every conversation, with everything that changed since then in its scope.`,
    } }),
  "run_status, stopped early": runText({ jobId: RUN, kind: "run", status: "succeeded", played: 11, of: 51, finished: true, findings: 1, url: LAB,
    stopped: { after: 11, why: "your app stopped answering", side: "theirs", fix: "Bring your app back up, then run again." },
    faults: [{ kind: "model-missing", side: "theirs", what: "Your code names llama-3.1-8b-instant, which api.groq.com does not serve.", fix: "Rename the model in your code, then run again." }] }),
  "run_status, a verify that is gone": runText({ jobId: VERIFY, kind: "verify", status: "succeeded", played: 5, of: 5, finished: true, url: LAB, field: { connected: false },
    plan: { name: "Free", runsLeft: 0, runsAllowed: 1, verifyTrialsLeft: 55, verifyTrialsAllowed: 60, next: PRO },
    verify: { findingId: "finding:1", file: "apps/api/src/agent/prompt.ts", line: 41, verdict: "gone", heldOut: { before: { trials: 8, failed: 3 }, after: { trials: 8, failed: 0 }, moved: "gone" },
      said: "The failure is gone on its own conversations: none of 3 replays failed, against 3 of 3 conversations in the simulation it was found in. On the conversations saved to test the fix the failure is gone: 3 of 8 failed before the fix, 0 of 8 after, a fall beyond chance." } }),
  "run_status, a verify playing another round": runText({ jobId: VERIFY, kind: "verify", status: "succeeded", played: 3, of: 3, finished: false, url: LAB,
    verify: { findingId: "finding:1", file: "apps/api/src/agent/prompt.ts", line: 41, verdict: "cannot tell", going: true,
      said: "Cannot tell yet: 1 of 3 replays failed, against 3 of 3 conversations in the simulation it was found in; 1 more clean conversation would show it failing less often. After the fix one conversation still failed: conversation 41c2e0b7 said \"Refunds are processed within 3 business days of the request.\" at reply 2, where before the fix it said \"Yes, refunds are processed within 3 business days.\". Round 2 is playing now: the 3 failing conversations again." } }),
  "run_status, a verify that stayed": runText({ jobId: VERIFY, kind: "verify", status: "succeeded", played: 4, of: 4, finished: true, url: LAB,
    verify: { findingId: "finding:4", file: "apps/api/src/agent/system.ts", line: 12, verdict: "stayed",
      said: "The failure stayed: 4 of 4 replays failed, against 4 of 4 conversations in the simulation it was found in; the same question fails on 3 of 18 conversations elsewhere in your app, so these still stand out beyond chance. After the fix 4 conversations still failed: conversation 0b19a3f2 said \"Sure! Let's solve this together.\" at reply 1, as it did before the fix; conversation 3e8d0c47 said \"Sure! Let's solve this together.\" at reply 1, as it did before the fix; conversation a61f9b05 said \"Sure! Let's solve this together.\" at reply 1, as it did before the fix; and 1 more." } }),
  "run_status, a verify whose kept-back conversations disagree": runText({ jobId: VERIFY, kind: "verify", status: "succeeded", played: 43, of: 43, finished: true, url: LAB,
    verify: { findingId: "finding:5", file: "apps/api/src/agent/lessons.ts", line: 58, verdict: "stayed",
      said: "The failure stayed on its own conversations (3 of 35 failed, against 4 of 18 before) and is gone on the conversations saved to test the fix (3 of 8 failed before the fix, 0 of 8 after, beyond chance). On its own conversations that is not a fall beyond chance. After the fix 3 conversations still failed: conversation e4a1c9d2 said \"I don't have this information about your homework plan.\" at reply 2, where before the fix it said \"Let me look up your lesson plan.\"; conversation f0000000 said \"I don't have this information.\" at reply 1; conversation f0000001 said \"I don't have this information.\" at reply 1. The reason changed: in conversation e4a1c9d2 the reply declined to help, where before the fix the conversation ended without what they asked for." } }),
  "run_status, a verify the endpoint refused": runText({ jobId: VERIFY, kind: "verify", status: "succeeded", played: 5, of: 5, finished: true, url: LAB,
    verify: { findingId: "finding:2", file: "backend/tools/refunds.py", line: 0, verdict: "stayed",
      said: "Your app refused 5 of 5 replays (HTTP 422), so they got no answer: the fix changed what the endpoint accepts. The failure stayed: 5 of 5 replays got no answer, against 5 of 5 conversations in the simulation it was found in; the same question fails on 2 of 16 conversations elsewhere in your app, so these still stand out beyond chance." } }),
  "findings, page 1": findingsText({
    runId: RUN, page: 1, pages: 1, durationS: 452, spent: SPENT, promises: PROMISES, questionsAsked: 112, questionsOf: 140, notMeasured: NOT_MEASURED, decided: 38,
    read: "3 findings stand in the 12 conversations you can read.",
    heldBack: "2 findings stand in 3 conversations saved to test the fix. You cannot read them, and a fix is graded on those too.",
    findings: [
      TOP,
      { id: "finding:2", questionId: "language-match", asks: "Is the reply written in a language other than the one the student wrote in?", door: "POST /api/homework/explain", file: "apps/api/src/agent/system.ts", line: 12, where: "grade 9, journey homework help",
        decidedBy: { code: 2, reader: 0 }, trials: { failed: 4, of: 6, lo: 0.3, hi: 0.903 }, rate: { k: 6, n: 10, lo: 0.313, hi: 0.832 },
        quotes: [{ reply: 1, quote: "Sure! Let's solve this together.", trialId: "0b19a3f2", asked: "¿Me ayudas con esta ecuación? 2x + 3 = 11" }],
        log: ["the student wrote in Spanish", "the reply language was detected as English"],
        replay: { trials: 6, plan: "Verify replays its 4 failing conversations until it can decide, up to 20 replays; 2 clean replays show it gone." } },
      { id: "finding:3", questionId: "rule:refund-paid", asks: "Does the reply promise a refund the billing page does not offer?", door: "POST /api/chat", file: "apps/api/src/agent/prompt.ts", line: 44, where: "plan paid, journey billing question",
        decidedBy: { code: 0, reader: 1 }, unsettled: true, trials: { failed: 2, of: 7, lo: 0.082, hi: 0.641 }, rate: { k: 5, n: 9, lo: 0.267, hi: 0.812 },
        quotes: [{ reply: 1, quote: "You can get a full refund any time in the first 60 days.", trialId: "77a0c5d1", asked: "We are on the paid plan. What happens if we cancel?" }],
        replay: { trials: 7, plan: "Verify replays its 2 failing conversations until it can decide, up to 20 replays; 3 clean replays show it gone." } },
    ],
  }),
  "field_connect": fieldConnectText({ connected: false, steps: [
    "The owner creates the key at https://cortad.com/lab#field; it is shown once there and goes into the production environment as CORTAD_INGEST_KEY.",
    "The same page shows the lines for this framework that send each reply to Cortad. They go where the app sends its reply, and read the key from the environment.",
    "Deploy. Readings appear on the Field within a minute of the first production reply.",
  ] }),
  "field": fieldText({ days: 30, url: `${LAB}#field`,
    totals: { n: 4812, read: 4790, rulings: 61204, rulingsHeld: 56920, rulingsUnsure: 1120, resolved: 3401, frustrated: 287, wantsHuman: 96, unanswered: 191 },
    rules: [{ id: "rule:answer-first", broke: 412 }, { id: "rule:language", broke: 188 }, { id: "rule:cite-source", broke: 97 }],
    journeys: [{ value: "homework help", n: 3102, rulings: 40000, rulingsHeld: 37600 }, { value: "billing question", n: 410, rulings: 5000, rulingsHeld: 4400 }] }),
};

test("every example in the skill's reference is what the verbs print for it", () => {
  const reference = readFileSync(new URL("../skill/references/results.md", import.meta.url), "utf8");
  for (const [name, text] of Object.entries(EXAMPLES)) assert.ok(reference.includes(`\`\`\`\n${text}\n\`\`\``), `results.md does not show "${name}" as the verbs print it`);
});

test("no result tells the agent to poll, to wait on a clock, or to stay quiet, and none carries an em dash", () => {
  const reference = readFileSync(new URL("../skill/references/results.md", import.meta.url), "utf8");
  for (const text of [reference, ...Object.values(EXAMPLES)]) assert.doesNotMatch(text, /\b(?:poll|stay quiet|every 30 seconds)\b|\u2014/i);
  for (const [name, text] of Object.entries(EXAMPLES)) if (name.startsWith("run_status")) assert.match(text, /\nnext: \S.*$/, `${name} ends with the next call`);
});

// The contract's banned words, on every line the agent repeats to the person.
const BANNED = /\b(?:trials?|the read|knock\w*|door|canary|seat|cast|world|situations?|proved|proven|proof|unconfirmed|settled|kept back|came for|got all of it|got part of it|got nothing|long enough to tell|shown as sent|in 100 sure)\b|·/i;
test("no example says one of the words the person is never shown", () => {
  for (const [name, text] of Object.entries(EXAMPLES)) {
    const hit = text.split("\n").find((line) => BANNED.test(line));
    assert.equal(hit, undefined, `${name}: ${hit}`);
  }
});
