// THE SIX DOORS.
//
// Twenty tools asked a coding agent to match a description to the moment it was in, and twenty
// descriptions with close cousins among them is a choice nobody gets right: it opened the wrong one
// or never reached the last nine at all. These six are the questions an agent actually has.
//
//   status    what do I need to know about this app right now
//   test      test what I just built
//   verify    did my fix hold
//   connect   connect the live app
//   tell      tell the Cortad team something, or say what this app counts as a good ending
//   dispute   this check reads my app wrong
//
// The questions did not shrink. Each door answers more, and `status` with nothing said answers
// whichever of them matters at this moment, so the common case is no choice at all.
//
// Nothing here talks to the server: every door routes to lib/verbs.mjs, which is still the twenty
// functions the shell face and the older-runner forwarding both use (lib/cli.mjs asRunner). A door
// is routing and words, so a run started through `test` is the same run, priced and refused the same
// way, whichever face asked for it.

import { SHOW } from "./read-text.mjs";
import { finished, newsLines } from "./text.mjs";

const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const readOnly = { readOnlyHint: true };

// What a note to the Cortad team may be about: a door, the connect command, or the skill text.
const ABOUT = ["status", "test", "verify", "connect", "tell", "dispute", "skill"];

// The lanes `status` opens when it is asked for one by name. Left out, it opens the one that matters.
export const LANES = ["repository", "run", "findings", "production", "outcomes", "warehouse"];

// The warehouse question, unchanged: the one door parameter that is a shape rather than a word.
const ASK = { type: "object", properties: {
  table: { type: "string", enum: ["events", "readings", "reactions"] },
  from: str("Start, ISO 8601."), to: str("End, ISO 8601, at most 90 days after from."),
  filters: { type: "array", maxItems: 20, items: { type: "object", properties: { column: { type: "string" }, op: { type: "string", enum: ["eq", "ne", "in", "gt", "gte", "lt", "lte", "null", "not_null"] }, value: {} }, required: ["column", "op"], additionalProperties: false } },
  group: { type: "array", maxItems: 4, items: { type: "string" }, description: "Columns, or hour or day." },
  measures: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", properties: { fn: { type: "string", enum: ["count", "count_distinct", "sum", "avg", "min", "max", "share"] }, column: { type: "string" }, equals: {}, as: { type: "string" } }, required: ["fn"], additionalProperties: false } },
  order: { type: "object", properties: { by: { type: "string" }, dir: { type: "string", enum: ["asc", "desc"] } }, required: ["by"], additionalProperties: false },
  limit: { type: "integer", minimum: 1, maximum: 1000 },
}, required: ["table", "from", "to", "measures"], additionalProperties: false,
  description: "A question over the live app's events, readings or reactions, for about warehouse. Compiled by Cortad and pinned to this app; no SQL is taken." };

const OUTCOME_RULE = { type: "object", properties: { kind: { type: "string", enum: ["path", "click", "event", "backend"] }, match: { type: "string", enum: ["exact", "starts", "contains"] }, value: { type: "string" }, text: { type: "string" }, selector: { type: "string" }, name: { type: "string" } }, required: ["kind"], additionalProperties: false };

export const DOORS = [
  { name: "status", title: "What to know about this app right now", annotations: readOnly,
    description: "Everything worth knowing about the AI in this repository, in one call. Said plainly with nothing asked for: a run still playing, or what failed in the one that just finished, or something going wrong in the live app, whichever is the thing to act on now. Applies at the start of a session, right after a connect, before a commit that changes prompts, tools, models or retrieval, and any time you need to know where things stand. With about, one lane in full instead.",
    inputSchema: { type: "object", properties: {
      about: { type: "string", enum: LANES, description: "repository: what Cortad found in this code, each endpoint's answer, the plan. run: where a run or verify stands, and what a finished one found. findings: every failure of the last run, whole, worst first. production: the live app in numbers, what is wrong in it now and what the data says caused it. outcomes: what this app counts as a good ending and how often it is reached. warehouse: a question over the live app's own events, with ask." },
      id: str("A run's id, or a world's. Omit for the one this machine started last."),
      show: { type: "string", enum: [...SHOW, "numbers"], description: "One list in full, in pages: for about repository, rules, standards, journeys, endpoints, trials, records or reviews, or machine, what Cortad does on this machine; for about findings, numbers, every number the run measured." },
      page: { type: "integer", minimum: 1, description: "The page of that list. Default 1." },
      days: { type: "integer", minimum: 1, maximum: 180, description: "The window for about production. Default 7." },
      ask: ASK,
    }, additionalProperties: false } },

  { name: "test", title: "Test what you built",
    description: "The one call after a change. Say what you built or want tested, in a sentence, and Cortad tests it: simulated users written from this app's own code talk to it on this machine and every reply is checked; or, where the AI here is not a chat and the sentence names something that can be planted, a copy of the product's data is built from the app's own seed, planted with problems whose answers are known, and the app's own detection is scored against the answer key. Answers within a second with what started; status about run follows it. Uses one run from the plan. With endpoints, no conversations are played at all: Cortad sends its own test request to those endpoints from this machine, which is how an endpoint that failed or has not answered yet is checked again.",
    inputSchema: { type: "object", properties: {
      ask: str("What was built or what to test, in a sentence.", { maxLength: 2000 }),
      conversations: { type: "integer", minimum: 1, description: "The most conversations a run may play, for example 10, so a first look spends less on the person's own model key. Default: as many as the run would choose, which status prices before it starts." },
      endpoints: { type: "array", items: { type: "string" }, description: "Send Cortad's test request to these endpoints, by path, instead of playing conversations. Empty array: every endpoint that failed or has not answered yet." },
      features: { type: "array", items: { type: "string" }, description: "The AI features this run tests, as status lists the endpoints (\"POST /v1/chat\"). Only these are written, priced and played; the choice is kept until the next test names another. Default: every endpoint the run would play. Ask the person which features matter before the first run where an app has more than one." },
      account: { type: "string", enum: ["make"], description: "The person's yes to Cortad making one test account on the app's own sign-up door, for endpoints that need a signed-in user. Recorded; it starts nothing. Only with their word, said in this conversation." },
    }, additionalProperties: false } },

  { name: "verify", title: "Did your fix hold",
    description: "Replays the conversations a failure happened in, word for word, after a change, and again by itself until an exact test says the failure is gone, shows less often, stayed, or cannot be told yet with how many clean replays would decide. Conversations saved to test the fix are played once and said apart, so a fix is graded on conversations nobody read while writing it. It also says what happened the last time this same failure was made to pass, and how long that lasted. Answers within a second; status about run follows every round. Uses verify conversations from the plan, not a run.",
    inputSchema: { type: "object", properties: {
      findingId: str("The failure's id, from status about findings."),
      id: str("The run the failure came from. Omit for the latest."),
    }, required: ["findingId"], additionalProperties: false } },

  { name: "connect", title: "Connect the live app", inputSchema: { type: "object", properties: {}, additionalProperties: false },
    description: "The steps to connect the live app, so Cortad sees what real users are doing as it happens and where the AI lets them down: a one-time code writes both keys into the env file, the SDK lines for this framework, the page tag, and where each conversation then appears. The owner approves it in a browser where they are signed in." },

  { name: "tell", title: "Tell the team",
    description: "Say one of three things, one of them per call: a note to the Cortad team about Cortad itself, what this app counts as a good ending, or an address of yours that should receive each incident in the live app. The note is for a result that read wrong, something you needed that no door gave, a question an answer left open, or what worked; the team reads each one, and filing one is part of using Cortad. An outcome is read from the app's own code and the person approves it in the browser before any of it counts. An address is sent each incident as signed JSON, and the secret comes back once. Nothing about a run or its checks changes.",
    inputSchema: { type: "object", properties: {
      about: { type: "string", enum: ABOUT, description: "For a note: the door it is about, connect for the connect command, or skill for the instructions you were handed." },
      kind: { type: "string", enum: ["problem", "idea", "question", "praise"], description: "For a note. problem: wrong or failed; idea: something you needed; question: something an answer left open; praise: what worked." },
      needed: str("For a note: what you were trying to do or find out.", { maxLength: 500 }),
      got: str("For a note: what came back instead, in your own words; leave out your users' text and any key.", { maxLength: 1000 }),
      tried: str("For a note: what you did about it, another call, a guess, or asked the person.", { maxLength: 500 }),
      outcomes: { type: "array", maxItems: 10, description: "What this app counts as a good ending, read from its code: a signup route, a checkout, a done button.",
        items: { type: "object", properties: {
          name: str("A short name, as the person would say it.", { maxLength: 64 }),
          why: str("What in the code makes this an outcome.", { maxLength: 500 }),
          rules: { type: "array", minItems: 1, maxItems: 10, items: OUTCOME_RULE },
        }, required: ["name", "rules", "why"], additionalProperties: false } },
      incidentsTo: str("A public https address of yours that takes a POST and should receive each incident.", { maxLength: 500 }),
    }, additionalProperties: false } },

  { name: "dispute", title: "This check reads your app wrong",
    description: "Records that a failure's check reads this app wrong, with the reason and an optional better wording. The failure and its rate stay as they are; the note goes to the owner. The honest exit when a check is measuring something this app was not built to do.",
    inputSchema: { type: "object", properties: {
      findingId: str("The failure's id, from status about findings."),
      why: str("One or two sentences: what the check gets wrong about this app.", { maxLength: 500 }),
      question: str("The wording that fits this app.", { maxLength: 300 }),
    }, required: ["findingId", "why"], additionalProperties: false } },
];

export const DOOR_NAMES = new Set(DOORS.map((d) => d.name));

// Which door each retired name is now part of, and how to say so in one line. Named here rather
// than guessed, so an agent handed an older skill is told where to go instead of getting nothing.
const MOVED = {
  reach: 'test with endpoints: ["/your/path"]',
  run: "test",
  run_status: 'status about: "run"',
  findings: 'status about: "findings"',
  feedback: "tell",
  field_connect: "connect",
  field: 'status about: "production"',
  world: "test",
  world_status: 'status about: "run"',
  intelligence: 'status about: "production"',
  incidents: 'status about: "production"',
  outcomes: 'status about: "outcomes" to read them, tell with outcomes to propose them',
  subscribe: "tell with incidentsTo",
  query: 'status about: "warehouse" with ask',
};

// Every verb a door or a retired name can reach, which is the set an older connect command is asked
// to run the call in (lib/cli.mjs asRunner).
export const RETIRED = Object.keys(MOVED);
export const VERB_NAMES = ["status", "reach", "run", "run_status", "findings", "verify", "dispute", "feedback",
  "field_connect", "field", "world", "world_status", "test", "connect", "intelligence", "incidents", "outcomes", "subscribe", "query"];

export const movedTo = (name) => MOVED[name] ?? null;
export const movedSaid = (name) => `${name} is now ${MOVED[name]}. This is that answer; call it that way next time.`;

// The last line of an answer is the next call. Said by the server and by the renderings here in the
// names the shell face uses, which are the names the doors replaced, so it is put into the door's
// words once, at the one place every answer passes through. The shell face keeps its own names,
// because there `npx cortad findings` is what a person types.
const NEXT = {
  run_status: (id) => lane("run", id),
  world_status: (id) => lane("run", id),
  findings: () => lane("findings"),
  run: () => "test",
  field: () => lane("production"),
  intelligence: () => lane("production"),
  incidents: () => lane("production"),
  outcomes: () => lane("outcomes"),
  query: () => lane("warehouse"),
  reach: () => "test with the endpoints to send to",
  feedback: () => "tell",
  field_connect: () => "connect",
};

const lane = (about, id) => `status about: "${about}"${id && id !== "pending" ? `, id: "${id}"` : ""}`;

export function doorNext(text) {
  if (typeof text !== "string") return text;
  return text.replace(/\nnext: ([a-z_]+)(?: ([^\n ]+))?$/, (whole, name, id) => (NEXT[name] ? `\nnext: ${NEXT[name](id)}` : whole));
}

// A run or verify's id, as the doors name it and as the retired tools named it.
const idOf = (args) => args.id ?? args.jobId;

// The lane a call is for. A parameter that belongs to one lane names it on its own, so an agent that
// asks for a section or hands over a question lands there rather than on whatever matters now.
const laneOf = (args) => args.about
  ?? (args.ask ? "warehouse"
    : args.show === "numbers" ? "findings"
    : args.show ? "repository"
    : idOf(args) ? "run"
    : args.days ? "production"
    : null);

// `verbs` is lib/verbs.mjs's object, already wrapped for an older connect command (cli.mjs asRunner).
export function makeDoors(verbs) {
  // With no lane asked for: the one to act on. A run playing or just finished outranks the live app,
  // because the agent is standing in front of it; a finished run with failures is read as its
  // failures, which is the call every agent made next anyway.
  const now = async (page) => {
    const read = await verbs.status({});
    const run = read.data?.run;
    if (!run?.jobId) return read;
    // The read is the only call that takes what the server kept to say, and it is taken once, so it
    // rides along when the answer handed over is another lane's.
    const news = newsLines(read.data ?? {});
    const carried = async (work) => {
      const out = await work;
      return news.length ? { ...out, text: [...news, out.text].join("\n") } : out;
    };
    // Still playing, or a verify: the run's own answer. Over, with failures: the failures.
    if (!finished(run) || run.verify) return carried(verbs.run_status({ jobId: run.jobId }));
    return (run.findings ?? 0) > 0 ? carried(verbs.findings({ jobId: run.jobId, ...(page ? { page } : {}) })) : read;
  };

  // A world's id and a run's are both ids; the run is asked for first and a world is what is left.
  const runOrWorld = async (id) => {
    const out = await verbs.run_status({ jobId: id });
    return out.isError && out.code === "http_404" ? verbs.world_status({ jobId: id }) : out;
  };

  const status = async (args = {}) => {
    const id = idOf(args);
    switch (laneOf(args)) {
      case "repository": return verbs.status({ ...(args.show ? { show: args.show } : {}), ...(args.page ? { page: args.page } : {}) });
      case "run": return id ? runOrWorld(id) : verbs.run_status({});
      case "findings": return verbs.findings({ ...(id ? { jobId: id } : {}), ...(args.show === "numbers" ? { show: "numbers" } : {}), ...(args.page ? { page: args.page } : {}) });
      // What is happening and what is wrong, as one answer: the numbers alone left the agent to ask
      // again for the thing it was looking for.
      case "production": return both(verbs.intelligence({ ...(args.days ? { days: args.days } : {}) }), verbs.incidents({}));
      case "outcomes": return verbs.outcomes({});
      case "warehouse": return args.ask
        ? verbs.query(args.ask)
        : { text: "A warehouse question names its table (events, readings or reactions), its from and to, and at least one measure. Send it as ask.", isError: true, code: "no_ask" };
      default: return now(args.page);
    }
  };

  // `endpoints` comes from a model, so it is a list of paths or it is not there at all.
  const test = async (args = {}) => (Array.isArray(args.endpoints)
    ? verbs.reach(args.endpoints.length ? { paths: args.endpoints.map(String) } : {})
    : verbs.test({ ...(args.ask ? { ask: args.ask } : {}), ...(args.conversations ? { conversations: args.conversations } : {}), ...(Array.isArray(args.features) ? { features: args.features.map(String) } : {}) }));

  const tell = async (args = {}) => {
    if (args.outcomes) return verbs.outcomes({ proposals: args.outcomes });
    if (args.incidentsTo) return verbs.subscribe({ url: args.incidentsTo });
    if (!args.about || !args.kind || !args.needed) {
      return { text: `A note names what it is about (${ABOUT.join(", ")}), its kind (problem, idea, question or praise), and what you needed. To say what counts as a good ending send outcomes instead, and to hear of incidents send incidentsTo.`, isError: true, code: "no_note" };
    }
    return verbs.feedback({ about: args.about, kind: args.kind, needed: args.needed, ...(args.got ? { got: args.got } : {}), ...(args.tried ? { tried: args.tried } : {}) });
  };

  return {
    status,
    test,
    verify: (args = {}) => verbs.verify({ findingId: args.findingId, ...(idOf(args) ? { jobId: idOf(args) } : {}) }),
    connect: () => verbs.connect({}),
    tell,
    dispute: (args = {}) => verbs.dispute(args),
  };
}

// Two answers under one door, the first's own next step dropped so the pair ends on one: one thing to
// read, not two. A second answer that failed leaves the first whole, with its own next step back,
// rather than putting a line about Cortad's own trouble above the numbers the agent asked for.
async function both(first, second) {
  const [a, b] = await Promise.all([first, second]);
  if (a.isError || b.isError) return a;
  const text = [a.text.replace(/\nnext: [^\n]*$/, ""), b.text].filter(Boolean).join("\n");
  return { text, data: { ...a.data, ...b.data } };
}
