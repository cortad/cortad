// THE SEVEN DOORS.
//
// Twenty tools asked a coding agent to match a description to the moment it was in, and twenty
// descriptions with close cousins among them is a choice nobody gets right: it opened the wrong one
// or never reached the last nine at all. These seven are the questions an agent actually has.
//
//   status    where do things stand: the connection, the endpoints, a run playing, what waits on the person
//   test      test what I just built
//   behavior  how did the app behave with its users, at one point in time, and what changed
//   search    find the conversations about something, by what they mean
//   verify    did the behavior move after my fix
//   connect   connect the live app
//   tell      tell the Cortad team something, propose what counts, or say a check reads my app wrong
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
const ABOUT = ["status", "test", "behavior", "search", "verify", "connect", "tell", "skill"];

// The lanes `status` opens when it is asked for one by name. Left out, it opens the one that matters.
export const LANES = ["repository", "run", "production", "outcomes", "warehouse", "users"];

// The one door parameter that is a shape rather than a word: a question Cortad compiles and pins to
// this app. The tables are the users lane's, and the warehouse's events and readings.
const USER_TABLES = ["conversations", "answers", "questions", "people", "profiles", "visits", "moments", "reactions"];
const WAREHOUSE_TABLES = ["events", "readings"];
const ASK = { type: "object", properties: {
  table: { type: "string", enum: [...USER_TABLES, ...WAREHOUSE_TABLES] },
  from: str("Start, ISO 8601. Default 30 days before to."), to: str("End, ISO 8601, at most 90 days after from. Default now."),
  filters: { type: "array", maxItems: 20, items: { type: "object", properties: { column: { type: "string" }, op: { type: "string", enum: ["eq", "ne", "in", "gt", "gte", "lt", "lte", "contains", "null", "not_null"] }, value: {} }, required: ["column", "op"], additionalProperties: false } },
  group: { type: "array", maxItems: 4, items: { type: "string" }, description: "Columns, or hour, day or week." },
  measures: { type: "array", maxItems: 8, items: { type: "object", properties: { fn: { type: "string", enum: ["count", "count_distinct", "sum", "avg", "min", "max", "share", "p50", "p90"] }, column: { type: "string" }, equals: {}, as: { type: "string" } }, required: ["fn"], additionalProperties: false } },
  columns: { type: "array", maxItems: 20, items: { type: "string" }, description: "Single rows with these columns instead of measures." },
  order: { type: "object", properties: { by: { type: "string" }, dir: { type: "string", enum: ["asc", "desc"] } }, required: ["by"], additionalProperties: false },
  limit: { type: "integer", minimum: 1, maximum: 1000 },
}, required: ["table"], additionalProperties: false,
  description: "Your own question over one table that status about users lists, compiled by Cortad and pinned to this app; no SQL is taken. events and readings are the warehouse's." };

const ANSWER = { type: "string", enum: ["users", "feature", "stuck", "change"], description: "A ready answer about the people using the live app. users: who they are, by user profile. feature: how people use what subject names, before you edit it. stuck: where people get stuck across every visit and conversation, with the replays to watch. change: how the same people fared after the release or time in subject." };

const OUTCOME_RULE = { type: "object", properties: { kind: { type: "string", enum: ["path", "click", "event", "backend"] }, match: { type: "string", enum: ["exact", "starts", "contains"] }, value: { type: "string" }, text: { type: "string" }, selector: { type: "string" }, name: { type: "string" } }, required: ["kind"], additionalProperties: false };

export const DOORS = [
  { name: "status", title: "What to know about this app right now", annotations: readOnly,
    description: "Where things stand, in one call: the connection, which endpoints answer, a simulation playing or just finished, the live app going wrong, and what waits on the person. Applies at the start of a session, after a connect, and whenever you need it. With about, one lane in full.",
    inputSchema: { type: "object", properties: {
      about: { type: "string", enum: LANES, description: "repository: what Cortad found in this code, each endpoint's answer, the plan. run: where a simulation or verify stands. production: the live app in numbers, what is wrong in it now and what the data says caused it. outcomes: what this app counts as a good ending and how often it is reached. warehouse: a question over the live app's own events, with ask. users: the people using the live app, their profiles, conversations, the behavioral questions and their answers, visits, what people did after each answer and reactions; with nothing else, the tables and what each column means." },
      id: str("A simulation's id. Omit for the one this machine started last."),
      show: { type: "string", enum: SHOW, description: "One list in full, in pages, for about repository: rules, standards, journeys, endpoints, trials, records or reviews, or machine, what Cortad does on this machine." },
      page: { type: "integer", minimum: 1, description: "The page of that list. Default 1." },
      days: { type: "integer", minimum: 1, maximum: 180, description: "The window for about production, default 7, or for an answer about users, default 30 and at most 90." },
      ask: ASK,
      answer: ANSWER,
      subject: str("For answer feature: a page path, an app route, the part of the app that answers, or a topic. For answer change: a release, or the ISO time a change went out.", { maxLength: 200 }),
    }, additionalProperties: false } },

  { name: "test", title: "Test what you built",
    description: "The one call after a change. Say what you built or want tested, in a sentence, and Cortad tests it: simulated users written from this app's own code talk to it on this machine and every reply is checked; or, where the AI here is not a chat and the sentence names something that can be planted, a copy of the product's data is built from the app's own seed, planted with problems whose answers are known, and the app's own detection is scored against the answer key. Answers within a second with what started; status about run follows it. Uses one simulation from the plan. With endpoints, no conversations are played at all: Cortad sends its own test request to those endpoints from this machine, which is how an endpoint that failed or has not answered yet is checked again.",
    inputSchema: { type: "object", properties: {
      ask: str("What was built or what to test, in a sentence.", { maxLength: 2000 }),
      conversations: { type: "integer", minimum: 1, description: "The most conversations a simulation may play, for example 10, so a first look spends less on the person's own model key. Default: as many as the simulation would choose, which status prices before it starts." },
      endpoints: { type: "array", items: { type: "string" }, description: "Send Cortad's test request to these endpoints, by path, instead of playing conversations. Empty array: every endpoint that failed or has not answered yet." },
      features: { type: "array", items: { type: "string" }, description: "The AI features this simulation tests, as status lists the endpoints (\"POST /v1/chat\"). Only these are written, priced and played; the choice is kept until the next test names another. Default: every endpoint the simulation would play. Ask the person which features matter before the first simulation where an app has more than one." },
      account: { type: "string", enum: ["make"], description: "The person's yes to Cortad signing test requests in: a test account made on the app's sign-up door, or a token signed with the JWT secret in its env, kept in ~/.cortad here. Ask the person first, yes option first, saying so. Recorded; starts nothing." },
    }, additionalProperties: false } },

  { name: "behavior", title: "How the app behaved with its users", annotations: readOnly,
    description: "How the AI behaved with its users at one point in time, top down: how many users of how many personas achieved their goal; each persona, largest first, with who they are, how they behave, what the app did well and where it gave way, each problem with how often and the conversations that show it; the app's habits; last, where each problem comes from in the code. Default: the latest finished simulation. Applies after every simulation, before changing prompts, tools, models or retrieval, and when the person asks how their AI behaves.",
    inputSchema: { type: "object", properties: {
      at: str("A simulation's id, a commit the simulation played on, or production. Default: the latest finished simulation.", { maxLength: 64 }),
      persona: str("One persona by name, in full, with its conversations.", { maxLength: 200 }),
      against: str("Another point: previous, production, a simulation's id or a commit. What got better, worse, new or gone per persona, with ranges; against production, where simulated users behave unlike real ones.", { maxLength: 64 }),
      history: { type: "boolean", description: "The log, newest first: each simulation with its commit and each production day, one line each with what changed since the one before." },
    }, additionalProperties: false } },

  { name: "search", title: "Find conversations by meaning", annotations: readOnly,
    description: "Finds conversations about something by what they mean, across simulations and production: who asked, what, how it ended and what the app said, with how many of all conversations are about it. Applies when the person names a kind of user or a moment, or before you change how the app handles one.",
    inputSchema: { type: "object", properties: {
      query: str("What to look for, in words.", { maxLength: 500 }),
      where: str("simulation, production, or one simulation's id. Default: everywhere.", { maxLength: 64 }),
      persona: str("Only this persona's conversations, by name.", { maxLength: 200 }),
      limit: { type: "integer", minimum: 1, maximum: 50, description: "The most conversations to return. Default 10." },
    }, required: ["query"], additionalProperties: false } },

  { name: "verify", title: "Did the behavior move",
    description: "After a fix, replays the conversations a problem happened in, word for word, until an exact test says whether the behavior moved: gone, less often, stayed, or not yet decided with how many clean replays would decide. Saved conversations nobody read while writing the fix are played once and said apart. Answers within a second; status about run follows every round. Uses verify conversations from the plan, not a simulation.",
    inputSchema: { type: "object", properties: {
      findingId: str("The problem's id as behavior names it, such as finding:1."),
      id: str("The simulation the problem came from. Omit for the latest."),
    }, required: ["findingId"], additionalProperties: false } },

  { name: "connect", title: "Connect the live app",
    inputSchema: { type: "object", properties: {
      site: str("The address people open the live app at, with https, such as https://app.example.com. The key in the page then answers that site and no other; until it is told one it sends nothing.", { maxLength: 300 }),
    }, additionalProperties: false },
    description: "The steps to connect the live app, so Cortad sees what real users are doing as it happens and where the AI lets them down: a one-time code writes both keys into the env file, the SDK lines for this framework, the page tag, and where each conversation then appears. The owner approves it in a browser where they are signed in." },

  { name: "tell", title: "Tell the team",
    description: "Say one of five things, one of them per call: a note to the Cortad team about Cortad itself; that a problem's question gets this app wrong (findingId and why); what this app counts as a good ending; behavioral questions the live app's answers should be asked; or an address of yours that should receive each incident in the live app. The note is for a result that read wrong, something you needed that no door gave, a question an answer left open, or what worked; the team reads each one. A question that reads the app wrong keeps its problem and rate as they are, and the note goes to the owner. An outcome is read from the app's own code, and a behavioral question from what behavior or status about users shows no question catches yet; the person approves each in the browser before any of it counts. An address is sent each incident as signed JSON, and the secret comes back once.",
    inputSchema: { type: "object", properties: {
      about: { type: "string", enum: ABOUT, description: "For a note: the door it is about, connect for the connect command, or skill for the instructions you were handed." },
      kind: { type: "string", enum: ["problem", "idea", "question", "praise"], description: "For a note. problem: wrong or failed; idea: something you needed; question: something an answer left open; praise: what worked." },
      needed: str("For a note: what you were trying to do or find out.", { maxLength: 500 }),
      got: str("For a note: what came back instead, in your own words; leave out your users' text and any key.", { maxLength: 1000 }),
      tried: str("For a note: what you did about it, another call, a guess, or asked the person.", { maxLength: 500 }),
      outcomes: { type: "array", maxItems: 10, description: "What this app counts as a good ending, found in its code: a signup route, a checkout, a done button.",
        items: { type: "object", properties: {
          name: str("A short name, as the person would say it.", { maxLength: 64 }),
          why: str("What in the code makes this an outcome.", { maxLength: 500 }),
          rules: { type: "array", minItems: 1, maxItems: 10, items: OUTCOME_RULE },
        }, required: ["name", "rules", "why"], additionalProperties: false } },
      questions: { type: "array", maxItems: 5, description: "Behavioral questions to ask of every answer the live app gives, for the person's yes.",
        items: { type: "object", properties: {
          question: str("A yes-or-no question about one answer, ending in ?, where yes is what the app should do.", { maxLength: 240 }),
          why: str("What in status about users or the code makes the case.", { maxLength: 500 }),
          conversations: { type: "array", maxItems: 10, items: { type: "string" }, description: "Conversation ids from status about users that show it." },
        }, required: ["question", "why"], additionalProperties: false } },
      incidentsTo: str("A public https address of yours that takes a POST and should receive each incident.", { maxLength: 500 }),
      findingId: str("For a question that gets the app wrong: the problem's id, as behavior names it."),
      why: str("With findingId: one or two sentences on what the question gets wrong about this app.", { maxLength: 500 }),
      question: str("With findingId: the wording that fits this app.", { maxLength: 300 }),
    }, additionalProperties: false } },
];

export const DOOR_NAMES = new Set(DOORS.map((d) => d.name));

// Which door each retired name is now part of, and how to say so in one line. Named here rather
// than guessed, so an agent handed an older skill is told where to go instead of getting nothing.
const MOVED = {
  reach: 'test with endpoints: ["/your/path"]',
  run: "test",
  run_status: 'status about: "run"',
  findings: "behavior",
  dispute: "tell with findingId and why",
  feedback: "tell",
  field_connect: "connect",
  field: 'status about: "production"',
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
  "field_connect", "field", "test", "connect", "intelligence", "incidents", "outcomes", "subscribe", "query", "users", "behavior", "search"];

export const movedTo = (name) => MOVED[name] ?? null;
export const movedSaid = (name) => `${name} is now ${MOVED[name]}. This is that answer; call it that way next time.`;

// The last line of an answer is the next call. Said by the server and by the renderings here in the
// names the shell face uses, which are the names the doors replaced, so it is put into the door's
// words once, at the one place every answer passes through. The shell face keeps its own names,
// because there `npx cortad findings` is what a person types.
const NEXT = {
  simulation_status: (id) => lane("run", id),
  run_status: (id) => lane("run", id),
  findings: () => "behavior",
  behavior: (id) => (id ? `behavior with at: "${id}"` : "behavior"),
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
  ?? (args.answer || args.subject ? "users"
    : args.ask ? (WAREHOUSE_TABLES.includes(args.ask.table) ? "warehouse" : "users")
    : args.show ? "repository"
    : idOf(args) ? "run"
    : args.days ? "production"
    : null);

// `verbs` is lib/verbs.mjs's object, already wrapped for an older connect command (cli.mjs asRunner).
export function makeDoors(verbs) {
  // With no lane asked for: the one to act on. A run playing outranks the live app, because the agent
  // is standing in front of it; a simulation that finished is said as where things stand, with
  // behavior as the next call, since how its users fared is that door's whole answer.
  const now = async () => {
    const read = await verbs.status({});
    const run = read.data?.run;
    // The read is the only call that takes what the server kept to say, and it is taken once, so it
    // rides along when the answer handed over is another lane's.
    const news = newsLines(read.data ?? {});
    const carried = async (work) => {
      const out = await work;
      return news.length ? { ...out, text: [...news, out.text].join("\n") } : out;
    };
    // With no run to act on, a live app that is failing its people is the thing to act on.
    const idle = () => (read.data?.field?.problems ? carried(production({})) : read);
    if (!run?.jobId) return idle();
    // Still playing, or a verify: the run's own answer. Over: where things stand, then behavior.
    if (!finished(run) || run.verify) return carried(verbs.run_status({ jobId: run.jobId }));
    if (!((run.findings ?? 0) > 0)) return idle();
    // An older connect command renders a status that ends with no next call.
    return /\nnext: [^\n]*$/.test(read.text) ? read : { ...read, text: `${read.text}\nnext: behavior ${run.jobId}` };
  };

  // What is happening in the live app and what is wrong in it, as one answer: the numbers alone left
  // the agent to ask again for the thing it was looking for.
  const production = (args) => both(verbs.intelligence({ ...(args.days ? { days: args.days } : {}) }), verbs.incidents({}));

  const status = async (args = {}) => {
    const id = idOf(args);
    switch (laneOf(args)) {
      case "repository": return verbs.status({ ...(args.show ? { show: args.show } : {}), ...(args.page ? { page: args.page } : {}) });
      case "run": return verbs.run_status(id ? { jobId: id } : {});
      case "production": return production(args);
      case "outcomes": return verbs.outcomes({});
      case "users": return verbs.users({ ...(args.answer ? { answer: args.answer } : {}), ...(args.subject ? { subject: args.subject } : {}), ...(args.days ? { days: args.days } : {}), ...(args.ask ? { ask: args.ask } : {}) });
      case "warehouse": return args.ask
        ? verbs.query(args.ask)
        : { text: "A warehouse question names its table (events or readings), its from and to, and at least one measure. Send it as ask.", isError: true, code: "no_ask" };
      default: return now();
    }
  };

  // `endpoints` comes from a model, so it is a list of paths or it is not there at all.
  const test = async (args = {}) => (Array.isArray(args.endpoints)
    ? verbs.reach(args.endpoints.length ? { paths: args.endpoints.map(String) } : {})
    : verbs.test({ ...(args.ask ? { ask: args.ask } : {}), ...(args.conversations ? { conversations: args.conversations } : {}), ...(Array.isArray(args.features) ? { features: args.features.map(String) } : {}), ...(args.account === "make" ? { account: "make" } : {}) }));

  const tell = async (args = {}) => {
    if (args.findingId) {
      if (!args.why) return { text: "A question that gets the app wrong is said with findingId and why: what the question gets wrong about this app.", isError: true, code: "no_why" };
      return verbs.dispute({ findingId: String(args.findingId), why: String(args.why), ...(args.question ? { question: String(args.question) } : {}), ...(idOf(args) ? { jobId: idOf(args) } : {}) });
    }
    if (args.outcomes) return verbs.outcomes({ proposals: args.outcomes });
    if (args.questions) return verbs.users({ propose: args.questions });
    if (args.incidentsTo) return verbs.subscribe({ url: args.incidentsTo });
    if (!args.about || !args.kind || !args.needed) {
      return { text: `A note names what it is about (${ABOUT.join(", ")}), its kind (problem, idea, question or praise), and what you needed. To say a question gets the app wrong send findingId and why, to say what counts as a good ending send outcomes, to propose behavioral questions send questions, and to hear of incidents send incidentsTo.`, isError: true, code: "no_note" };
    }
    return verbs.feedback({ about: args.about, kind: args.kind, needed: args.needed, ...(args.got ? { got: args.got } : {}), ...(args.tried ? { tried: args.tried } : {}) });
  };

  const behavior = (args = {}) => verbs.behavior({ ...(args.at ? { at: args.at } : {}), ...(args.persona ? { persona: args.persona } : {}), ...(args.against ? { against: args.against } : {}), ...(args.history === true ? { history: true } : {}) });
  const search = (args = {}) => verbs.search({ query: args.query, ...(args.where ? { where: args.where } : {}), ...(args.persona ? { persona: args.persona } : {}), ...(Number.isSafeInteger(args.limit) ? { limit: args.limit } : {}) });

  return {
    status,
    test,
    behavior,
    search,
    verify: (args = {}) => verbs.verify({ findingId: args.findingId, ...(idOf(args) ? { jobId: idOf(args) } : {}) }),
    connect: (args = {}) => verbs.connect(typeof args.site === "string" && args.site ? { site: args.site } : {}),
    tell,
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
