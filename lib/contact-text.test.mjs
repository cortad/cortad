import assert from "node:assert/strict";
import { test } from "node:test";
import { contactLines, unreached } from "./contact-text.mjs";
import { statusText } from "./text.mjs";

// What status is waiting for on an endpoint that takes a message and answers afterwards: a customer
// read the list these sit on as his endpoint being broken, and sent his question a second time.
const LATER = "An endpoint that hands back a turn and answers afterwards stays on this list until Cortad has seen the answer its model wrote: the first reply alone does not take it off.";

// The status the backend builds from the proofs lib/proof.test.mjs derives from the fixture app's two
// turns on /api/chat, and one endpoint the read named that no request reached.
const contact = {
  proven: [{
    door: "POST /api/chat", surface: "chat", requests: 2, model: "fixture-model", modelCallsPerRequest: 1,
    askField: "message", session: { held: true, carrier: "body", key: "sessionId" },
    rules: { carried: 1, of: 3, examples: [{ text: "Keep answers short.", path: "proof-app.cjs", line: 6 }] },
    tools: [], passages: 0, replySeconds: 1.2,
    problems: [{ kind: "leaked-markup", said: 'The reply carried "</system-reminder>", markup from the prompt your app sent the model.', file: "proof-app.cjs", line: 6 }],
    sample: { ask: "the leak season in Porto", reply: "About the leak season in Porto: pack light. Earlier you asked about a weekend in Lisbon. </system-reminder>" },
  }],
  notCalled: [{ name: "summaries", method: "POST", path: "/api/summarize", file: "src/summarize.ts", line: 12 }],
  ready: { trials: 36, replies: 72, minutes: 3, usd: 0.41, provider: "OpenAI", model: "gpt-4o-mini" },
};

test("each proven endpoint says what its requests did inside the app, then what no request reached, then the run", () => {
  assert.deepEqual(contactLines(contact), [
    "Endpoints that answered (1):",
    "  POST /api/chat: 2 requests reached fixture-model, 1 model call each, 1.2 seconds a reply.",
    '    The message goes in "message".',
    '    A later request\'s prompt carried an earlier one, tied by the body field "sessionId".',
    '    The prompts carried 1 of the 3 rules read from your code, for example proof-app.cjs:6 "Keep answers short.".',
    '    Problem at proof-app.cjs:6: The reply carried "</system-reminder>", markup from the prompt your app sent the model.',
    '    Last message: "the leak season in Porto".',
    "Endpoints found in your code that Cortad has seen no answer from yet (1):",
    "  POST /api/summarize  src/summarize.ts:12",
    "Send each one message as a user would, signed in where your app needs it.",
    LATER,
    "Which of these the first run tests is the person's choice: ask them now and record the answer with test and features, or they tick them on the card in the browser.",
    "A run plays 36 simulated users in about 3 minutes. About $0.41 on your OpenAI key.",
  ]);
});

test("a session not held, a problem with no line, and figures nothing measured are said plainly or left out", () => {
  const door = { door: "POST /api/once", requests: 2, model: null, modelCallsPerRequest: 1, replySeconds: null, session: { held: false, carrier: "none", key: null }, rules: { carried: 0, of: 3, examples: [] }, problems: [{ kind: "error-status", said: "Your app answered 500 after it called the model.", file: null, line: null }] };
  assert.deepEqual(contactLines({ proven: [door], notCalled: [], ready: { trials: 10, replies: 10, minutes: null, usd: null, provider: null, model: null } }), [
    "Endpoints that answered (1):",
    "  POST /api/once: 2 requests reached the model, 1 model call each.",
    "    No later request's prompt carried an earlier one.",
    "    The prompts carried none of the 3 rules read from your code.",
    "    Problem: Your app answered 500 after it called the model.",
    "A run plays 10 simulated users. It runs on your key.",
  ]);
  const cut = { ...door, problems: [], sample: { ask: "a day trip to Sintra", reply: "Take the train from Rossio", cut: true } };
  assert.equal(contactLines({ proven: [cut], notCalled: [], ready: null }).at(-1), '    Last message: "a day trip to Sintra"; the reply stopped before it finished.');
  const unfound = { ...door, problems: [], sample: { ask: "", reply: "We are open until eleven on Saturdays." } };
  assert.equal(contactLines({ proven: [unfound], notCalled: [], ready: null }).at(-1), '    Last reply: "We are open until eleven on Saturdays.".', "an ask the proof could not find is left out, never shown as empty quotes");
  const long = { ...unfound, sample: { ask: "", reply: "We are open until eleven on Saturdays, and on Sundays we open at noon and close at nine." } };
  assert.equal(contactLines({ proven: [long], notCalled: [], ready: null }).at(-1), '    Last reply: "We are open until eleven on Saturdays, and on Sundays we open at noon and clo...".');
});

// The door the proof tests derive from a queue app's two turns: the message joins a queue, and the
// answer comes on the session's stream of events.
test("a door whose answer came on a second request says which request carried it and what tied the two", () => {
  const door = {
    door: "POST /queue/join", requests: 2, model: "fixture-model", modelCallsPerRequest: 1, replySeconds: 0.4, askField: "data",
    secondStep: { request: "GET /queue/data?session={session}", tie: { key: "session", from: "sent" }, before: ["POST /queue/join"] },
    session: { held: true, carrier: "history", key: "data" },
  };
  assert.deepEqual(contactLines({ proven: [door], notCalled: [], ready: null }).slice(1, 4), [
    "  POST /queue/join: 2 requests reached fixture-model, 1 model call each, 0.4 seconds a reply.",
    '    The message goes in "data".',
    '    The answer came on a second request, GET /queue/data?session={session}, tied by the "session" the first request sent; each turn first sent POST /queue/join.',
  ]);
});

// gemnex-whatsapp-agent: the webhook answers {"ok":true} at once and its worker's model answers later.
test("a door the app answers later says so, and that the model's last answer is what is graded", () => {
  const door = { door: "POST /api/simulate", requests: 1, model: "fake-model", modelCallsPerRequest: 3, replySeconds: 5.2, askField: "text", later: true, session: { held: false, carrier: "none", key: null } };
  assert.deepEqual(contactLines({ proven: [door], notCalled: [], ready: null }).slice(1), [
    "  POST /api/simulate: 1 request reached fake-model, 3 model calls each, 5.2 seconds a reply.",
    '    The message goes in "text".',
    "    Your app takes the message at once and its model answers afterwards; Cortad grades the model's last answer to each message.",
  ]);
});

test("status carries the section where the API sends one, and the API's next step", () => {
  const text = statusText({ repository: { name: "app" }, contact: { proven: [], notCalled: [], ready: null }, next: "Send one real request to each endpoint of the app that reaches its model.", run: null });
  assert.equal(text, "Repository: app.\nSend one real request to each endpoint of the app that reaches its model.");
  assert.equal(statusText({ repository: { name: "app" }, run: null }), "Repository: app.", "an API without the section prints nothing for it");
});

// A status asked for one message to each AI endpoint in its App line and again at its end, and
// asked it while saying nothing is sent until the person chooses (2026-11-02).
test("one message to each AI endpoint is asked once, and not while the person has features to choose", () => {
  const app = { state: "waiting", port: 3100, said: "Your app is up on port 3100. Send one message to each AI endpoint as a user would, signed in where your app needs it; Cortad learns the endpoint from that request." };
  const next = "Send one message to each AI endpoint of the app on this machine as a user would, signed in where your app needs it; on a chat, two messages in one conversation. Each shows here once it answers.";
  const contact = { proven: [], notCalled: [{ method: "POST", path: "/api/chat" }, { method: "POST", path: "/api/quiz" }], ready: null };
  const status = (d) => statusText({ app, contact, next, run: null, ...d });
  const asks = (d) => status(d).match(/Send one message to each AI endpoint/g)?.length ?? 0;
  assert.match(status({}), /^App: Your app is up on port 3100\.\n[^]*\nSend one message to each AI endpoint of the app on this machine /);
  assert.equal(asks({}), 1);
  assert.equal(asks({ next: undefined }), 1, "with no next step the App line asks");
  assert.equal(asks({ features: null }), 0, "nothing is sent before the person chooses");
  assert.match(status({ features: null }), /\nNothing is sent to these until the person chooses\. /);
  assert.equal(status({ features: null }), status({ app: { ...app, said: "Your app is up on port 3100." }, next: undefined, features: null }), "an older server reads as the newer one");
});

test("what a run would write into for real is said right under the run, and without a run it is still said", () => {
  const data = ["What test conversations create in the Redis database 0 that REDIS_URL names stays there: we copy Postgres and Redis for a run, not that one."];
  const text = statusText({ repository: { name: "app" }, app: { data }, contact, run: null }).split("\n");
  const ready = text.findIndex((l) => l.startsWith("A run plays "));
  assert.equal(text[ready + 1], `Data: ${data[0]}`);
  assert.deepEqual(contactLines(null, data), [`Data: ${data[0]}`]);
});

// chatgpt-lite2 as the backend now says it (src/local/canary.ts): the canary found the model's
// instructions in no file of the app, so the door is held out of runs and Run with it, with the app's
// own persona offered; the field its client sets says where a trial takes it from. The hold on Run is
// the server's next line, so `blocked` prints nothing here.
test("each value the app's client sets says where a trial takes it, and a door runs will not use says why and whose it is", () => {
  const why = 'The instructions the model was given are not written in your code: "You are a helpful assistant.". They came from the request this endpoint answered.';
  const door = {
    door: "POST /api/chat", requests: 2, model: "glm-5p3-flash", modelCallsPerRequest: 1, replySeconds: 4.8, askField: "messages",
    standing: "excluded", side: "ours", why, appFields: [{ field: "prompt", from: "request", path: null }],
  };
  const ready = { trials: 30, replies: 60, minutes: 11, usd: null, provider: null, model: null,
    blocked: [{ door: "POST /api/chat", side: "ours", why, question: 'Which of these does your app send as "prompt"? ChatGPT in src/lib/chat-utils.ts: "You are a professional, friendly, and helpful AI assistant.".' }] };
  assert.deepEqual(contactLines({ proven: [door], notCalled: [], ready }), [
    "Endpoints that answered (1):",
    "  POST /api/chat: 2 requests reached glm-5p3-flash, 1 model call each, 4.8 seconds a reply.",
    `    Runs leave this endpoint out: ${why} That is on Cortad's side, not your app's.`,
    '    The message goes in "messages".',
    '    "prompt" is only in your agent\'s request.',
    "A run plays 30 simulated users in about 11 minutes. It runs on your key.",
  ]);
  const theirs = { ...door, side: "theirs", why: "Your app answered 500 to every message." };
  assert.equal(contactLines({ proven: [theirs], notCalled: [], ready: null })[2], "    Runs leave this endpoint out: Your app answered 500 to every message. That is in your app.");
  const fixed = { ...door, standing: "proven", why: null, side: null, appFields: [{ field: "prompt", from: "app", path: "src/lib/chat-utils.ts" }] };
  assert.deepEqual(contactLines({ proven: [fixed], notCalled: [], ready: null }).slice(2), ['    The message goes in "messages".', '    "prompt" is set by your app at src/lib/chat-utils.ts.']);
  const reading = contactLines({ proven: [fixed], notCalled: [], ready: { trials: 36, replies: 108, minutes: 4, usd: 0.06, provider: "Fireworks", model: null, reading: true } });
  assert.equal(reading.at(-1), "A run plays 36 simulated users so far in about 4 minutes. About $0.06 on your Fireworks key.");
  const bare = contactLines({ proven: [fixed], notCalled: [], ready: { trials: 24, replies: 48, minutes: 3, usd: null, provider: null, model: null, rules: 0 } });
  assert.deepEqual(bare.slice(-2), ["A run plays 24 simulated users in about 3 minutes. It runs on your key.", "No rules of your own were read from the code, so replies are checked against general standards only."]);
  const ruled = contactLines({ proven: [fixed], notCalled: [], ready: { trials: 24, replies: 48, minutes: 3, usd: null, provider: null, model: null, rules: 9 } });
  assert.equal(ruled.at(-1), "A run plays 24 simulated users in about 3 minutes. It runs on your key.");
  const noted = { ...fixed, appFields: null, checks: ["The second message of one conversation did not carry the first, though your own requests showed this endpoint holds a conversation."] };
  assert.deepEqual(contactLines({ proven: [noted], notCalled: [], ready: null }).slice(2), ['    The message goes in "messages".', "    Cortad's test conversation here: The second message of one conversation did not carry the first, though your own requests showed this endpoint holds a conversation."]);
  const slow = contactLines({ proven: [fixed], notCalled: [], ready: { trials: 44, planned: 72, replies: 88, minutes: 12, usd: null, provider: null, model: null } });
  assert.equal(slow.at(-1), "A run plays 44 simulated users in about 12 minutes. It runs on your key.", "the count is what plays, never what was planned");
  const captured = { ...fixed, appFields: null, accounts: 1 };
  assert.deepEqual(contactLines({ proven: [captured], notCalled: [], ready: null }).slice(2), ['    The message goes in "messages".', "    All conversations act as one account."]);
  assert.equal(contactLines({ proven: [{ ...captured, accounts: 3 }], notCalled: [], ready: null })[3], "    Conversations are split across 3 accounts, one for each customer your requests signed in as.");
  assert.equal(contactLines({ proven: [{ ...captured, accounts: null }], notCalled: [], ready: null }).length, 3, "an endpoint that needs no sign-in says nothing of accounts");
  const ours = { ...fixed, standing: "fallback", side: "ours", why: "Send one request the way your app's own client does, and it is proven by yours.", appFields: null };
  assert.equal(contactLines({ proven: [ours], notCalled: [], ready: null })[2], "    Answered only Cortad's own requests: Send one request the way your app's own client does, and it is proven by yours.");
});

// One price: a first run at what it is expected to cost, a later one at what the last run measured.
// One customer's agent was handed "$0.36, and the most it costs is $4.23, on the 7 of 8 endpoints Cortad could
// price", and its owner asked what a price of 0.3 to 5 dollars meant.
test("the run is one short line with one price: a first run at what it is expected to cost, a later one at what the last run measured", async () => {
  const { contactLines } = await import("./contact-text.mjs");
  const said = (ready) => contactLines({ proven: [], ready: { trials: 40, planned: 47, replies: 120, minutes: 9, provider: "Fireworks", model: "glm-5p3-flash", followUps: 12, atOne: { trials: 20, minutes: 12 }, ...ready } }).at(-1);
  assert.equal(said({ usd: 0.48, upTo: true, expected: 0.33 }), "A run plays 40 simulated users in about 9 minutes. About $0.33 on your Fireworks key.");
  assert.equal(said({ usd: 3.27, upTo: true, expected: 1.2, pricedOn: { endpoints: 13, of: 15 } }), "A run plays 40 simulated users in about 9 minutes. About $1.20 on your Fireworks key.");
  assert.equal(said({ usd: 3.27, upTo: true }), "A run plays 40 simulated users in about 9 minutes. About $3.27 on your Fireworks key.", "a server from before the expected price sends one figure, and it is the one said");
  assert.equal(said({ usd: 0.45, expected: 0.2 }), "A run plays 40 simulated users in about 9 minutes. About $0.45 on your Fireworks key.", "the app's own run is what a later quote says");
  assert.equal(said({ usd: null }), "A run plays 40 simulated users in about 9 minutes. It runs on your Fireworks key.");
});

// One customer's hold on its Qdrant was read twice in one status: here and in the server's next line.
test("a store decision the server sends as the next step is said once, after the quote", () => {
  const held = "DATABASE_URL points at the Postgres database shop that is not on this machine, and no migrations were found to build a copy on this machine from, so test conversations would save into it. Point DATABASE_URL at a database on this machine, then run the connect command again.";
  const next = `${held} Or the person allows it on the card in the browser: one press lets test conversations save into it.`;
  const ready = { ...contact.ready, blocked: [{ door: "DATABASE_URL", side: "theirs", why: held }] };
  const lines = statusText({ repository: { name: "app" }, contact: { ...contact, ready }, next, run: null }).split("\n");
  assert.equal(lines.filter((l) => l.includes("DATABASE_URL points at")).length, 1);
  assert.equal(lines.at(-1), next);
  assert.equal(lines.at(-2), "A run plays 36 simulated users in about 3 minutes. About $0.41 on your OpenAI key.");
});

test("while the code is still being read status says so once and claims no rules are missing", () => {
  const lines = contactLines({ proven: [], ready: { trials: 24, planned: 24, replies: 72, minutes: 3, usd: null, provider: null, model: null, rules: 0, reading: true } });
  assert.deepEqual(lines, ["A run plays 24 simulated users so far in about 3 minutes. It runs on your key."]);
  const status = statusText({ repository: { name: "app" }, read: { complete: false }, contact: { proven: [], ready: { trials: 24, planned: 24, reading: true } }, run: null });
  assert.equal(status.split("still being read").length - 1, 1);
});

// "Carried none of the 87 rules" could not tell a gap in Cortad's read from a prompt with no rules,
// and a contact form was listed as reaching the model because its client sends a "topic" field.
test("a prompt with no rules names the file its call is made from and whether Cortad read rules there, and a guessed endpoint says why it is listed", () => {
  const door = (rules) => contactLines({ proven: [{ door: "POST /v1/chat", requests: 1, rules }], notCalled: [], ready: null })[2];
  assert.equal(door({ carried: 0, of: 11, examples: [], at: { path: "src/ai/context.ts", line: 226 }, readThere: false }), "    None of the 11 rules Cortad read from your code are in the prompt this endpoint sent, and Cortad read no rule from src/ai/context.ts, where the call is made; the prompt at src/ai/context.ts:226 shows whether Cortad's read missed rules written there or your app sends this prompt without any.");
  assert.equal(door({ carried: 0, of: 11, examples: [], at: { path: "src/ai/query.ts", line: 40 }, readThere: true, inFile: 4 }), "    The prompt this endpoint sent from src/ai/query.ts:40 holds none of the 4 rules Cortad read from that file.");
  assert.equal(door({ carried: 2, of: 11, examples: [{ text: "Keep answers short.", path: "src/ai/query.ts", line: 9 }], at: null, readThere: null }), '    The prompts carried 2 of the 11 rules Cortad read from your code, for example src/ai/query.ts:9 "Keep answers short.".');
  const why = "Listed only because the request its client sends has a \"topic\" field; Cortad found no model call behind it, and one request shows whether it reaches your model.";
  assert.deepEqual(contactLines({ proven: [], notCalled: [{ method: "POST", path: "/api/contact/submit", file: null, line: null, why }], ready: null }), [
    "Endpoints found in your code that Cortad has seen no answer from yet (1):",
    `  POST /api/contact/submit  ${why}`,
    "Send each one message as a user would, signed in where your app needs it.",
    LATER,
  ]);
});

// The founder's ask, 2026-10-05: the agent read each handler and sent its requests one by one, minutes
// on a ten-endpoint app, for requests Cortad already knew. Since then the connect command sends them,
// and status still asked the agent to send each one, naming a call that is retired (2026-11-02).
test("the endpoints no request has reached say which Cortad is sending its test request and which are the agent's, with test and endpoints named", () => {
  const request = (path) => ({ method: "POST", path, body: { message: "Hi. What can you help me with?" } });
  const why = "Listed only because the request its client sends has a \"topic\" field; Cortad found no model call behind it, and one request shows whether it reaches your model.";
  const notCalled = [
    { method: "POST", path: "/api/chat", file: "src/chat.ts", line: 12, request: request("/api/chat") },
    { method: "POST", path: "/api/summarize", file: null, line: null, request: request("/api/summarize") },
    { method: "POST", path: "/api/threads/:id/runs", file: null, line: null, byHand: "Its address takes a value from your app's own data." },
    { method: "POST", path: "/api/contact/submit", file: null, line: null, why, unsure: true, request: request("/api/contact/submit") },
  ];
  assert.deepEqual(contactLines({ proven: [], notCalled, ready: null }), [
    "Endpoints found in your code that Cortad has seen no answer from yet (4):",
    "  POST /api/chat  src/chat.ts:12",
    "  POST /api/summarize",
    "  POST /api/threads/:id/runs  By hand. Its address takes a value from your app's own data.",
    `  POST /api/contact/submit  By hand. ${why}`,
    "Cortad is sending 2 of them its test request from this machine: look again in a minute, or call test with endpoints to send them now. 2 of them are yours: send each one message as a user would, signed in where your app needs it.",
    LATER,
    "Which of these the first run tests is the person's choice: ask them now and record the answer with test and features, or they tick them on the card in the browser.",
  ]);
  assert.equal(contactLines({ proven: [], notCalled: notCalled.slice(0, 2), ready: null }).at(-3), "Cortad is sending each one its test request from this machine: look again in a minute, or call test with endpoints to send them now.");
  assert.equal(contactLines({ proven: [], notCalled: notCalled.slice(2), ready: null }).at(-2), "Send each one message as a user would, signed in where your app needs it.", "with nothing Cortad can send, nothing of Cortad's is said");
  // One Cortad's request failed at and one that refused a visitor: Cortad sends neither again by itself.
  const tried = [{ ...notCalled[0], failed: "Cortad's test request was answered with HTTP 500." }, { ...notCalled[1], signIn: "Needs a signed-in user" }];
  assert.deepEqual(contactLines({ proven: [], notCalled: tried, ready: null }).slice(3, 5), [
    "Once a failure above is fixed, call test with endpoints to send its test request again.",
    "One of them refused a visitor: ask the person for a test account to sign in as (an existing one; Cortad makes none), or whether to leave it out of the first run.",
  ]);
  assert.ok(!contactLines({ proven: [], notCalled: [...notCalled, ...tried], ready: null }).some((l) => /\breach\b|Cortad is sending each one/.test(l)), "the retired call is never named, and a tried endpoint is not said to be sent");
});

test("what Cortad's own test request met at an endpoint is said beside it, in the server's words", () => {
  const request = { method: "POST", path: "/api/chat", body: { message: "Hi" } };
  const lines = contactLines({ proven: [], ready: null, notCalled: [
    { method: "POST", path: "/api/chat", file: "src/chat.ts", line: 12, request, signIn: "Needs a signed-in user" },
    { method: "POST", path: "/api/quiz", file: null, line: null, request: { ...request, path: "/api/quiz" }, failed: "Cortad's test request was answered with HTTP 500." },
  ] });
  assert.deepEqual(lines.slice(1, 3), [
    "  POST /api/chat  src/chat.ts:12  Needs a signed-in user.",
    "  POST /api/quiz  Cortad's test request was answered with HTTP 500.",
  ]);
});

test("a door listed again after its test failed is sent by reach and left out of the endpoints no request reached", async () => {
  const { picked } = await import("./reach.mjs");
  const retest = { names: [], method: "POST", path: "/v1/docs", file: "src/docs.ts", line: 9, failed: "Your app answered 500.", retest: true, request: { method: "POST", path: "/v1/docs", body: { messages: [] } } };
  const fresh = { names: [], method: "POST", path: "/v1/quiz", file: null, line: null, request: { method: "POST", path: "/v1/quiz", body: { content: "hi" } } };
  const contact = { proven: [], notCalled: [retest, fresh], ready: null };
  assert.deepEqual(unreached(contact).map((m) => m.path), ["/v1/quiz"]);
  assert.deepEqual(picked(contact, []).sent.map((m) => m.path).sort(), ["/v1/docs", "/v1/quiz"]);
  assert.deepEqual(picked(contact, [], ["/v1/docs"]).sent.map((m) => m.path), ["/v1/docs"], "the agent names the failed one and it is sent");
  assert.deepEqual(contactLines(contact).filter((l) => /docs/.test(l)), [], "status does not list it among the unanswered");
});
