// The MCP face: newline-delimited JSON-RPC 2.0 on stdin and stdout, protocol 2025-06-18, no
// dependency. stdout carries protocol messages and nothing else; everything a person might read
// goes to stderr. The tools are lib/verbs.mjs, one to one.

import { randomUUID } from "node:crypto";
import { SHOW } from "./read-text.mjs";

export const PROTOCOL = "2025-06-18";

// Codex keeps only the first 512 characters self-contained and Claude Code shares about 4 KB across
// every server, so the first paragraph stands alone and the whole stays under 1,500 characters.
export const instructions = (spec = "cortad") => [
  "Cortad tests the AI in this repository: simulated users written from the app's code talk to the app running on this machine, and every reply is checked. You connect the app with its own start command after `--`, then send each AI endpoint one message as a user would; Cortad learns the endpoint from that request. status says whether the app is up, what Cortad's audit of the AI code found, and what a run would play and cost. A run starts when the person presses Run in the browser or asks you.",
  `Tell the person what status found in three or four short, plain lines, leaving out file paths, endpoints, status codes and setting names unless they ask. Before you stop, start \`npx -y ${spec} wait\` as a background command: it returns when the next run or verify ends, with what it found. After a run, call findings and tell the person what their users ran into and what you would change, worst first, three problems at most; the person then says which fix to make, and nothing is edited before their go. On their go, one fix at a time: verify replays the failing conversations and says whether the failure is gone, and a further round plays only when verify is called again. findings has each failure whole and findings numbers every rate. connect gives the steps to connect the live app. intelligence says what is happening to it and incidents what went wrong and why; outcomes, subscribe and query are the layer's other tools. dispute records a check that reads this app wrong.`,
].join("\n\n");
export const INSTRUCTIONS = instructions();

const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const none = { type: "object", properties: {}, additionalProperties: false };
const readOnly = { readOnlyHint: true };
// What a note to the Cortad team may be about: a tool, the connect command, or the skill text.
const ABOUT = ["status", "reach", "run", "run_status", "findings", "verify", "dispute", "field_connect", "field", "world", "world_status", "test", "connect", "intelligence", "incidents", "outcomes", "subscribe", "query", "skill"];

export const TOOLS = [
  { name: "status", title: "Cortad status", annotations: readOnly,
    description: "What Cortad found in this repository: whether the app is up and on which port, its audit of the prompts and of the code around the model, each endpoint's answer to Cortad's test request or the file and line it failed at, the plan with runs left, and the latest run. Applies at the start of a session, right after a connect, and before a commit that changes prompts, tools, models or retrieval. With show, one section in full, in pages.",
    inputSchema: { type: "object", properties: { show: { type: "string", enum: SHOW, description: "A section to list in full: rules, standards, journeys, endpoints, trials, records or reviews; or machine, what Cortad does on this machine." }, page: { type: "integer", minimum: 1, description: "The page of that list. Default 1." } }, additionalProperties: false } },
  { name: "reach", title: "Send a request Cortad read to an endpoint",
    description: "Sends the request Cortad read for an endpoint, to the ones status lists as failed or not yet answered, or to the paths named, from this machine to the app on its port, signed in as your own request was where one was seen. Each endpoint comes back with its HTTP status, its time and, when it is not 2xx, the start of what the app answered. A message you send the app yourself does the same.",
    inputSchema: { type: "object", properties: {
      paths: { type: "array", items: { type: "string" }, description: "Only these endpoints, by path. Default: every endpoint status lists as failed or not yet answered." },
    }, additionalProperties: false } },
  { name: "run", title: "Start a run",
    description: "Starts a run of conversations against the app on this machine and answers within a second with the run id; with conversations it plays no more than that many, so a first look spends less on the person's own model key than a whole run does. After the first run it plays what the files saved since the last full run reach, plus new conversations written for the change, and its result leads with what moved; when the app is down it is started first, and run_status gives the id once the run has one. Uses one run from the plan, capped or not; a spent plan answers with the numbers and a checkout link for the person.",
    inputSchema: { type: "object", properties: {
      conversations: { type: "integer", minimum: 1, description: "The most conversations this run may play, for example 10. Default: as many as the run would choose, which status prices before it starts." },
    }, additionalProperties: false } },
  { name: "run_status", title: "Run progress", annotations: readOnly,
    description: "Where a run or verify stands: conversations played of the total, the findings, what the app's rules and users measured, and for a verify whether the failure is gone, shows less often, stayed or cannot be told yet. The call holds up to 45 seconds until the count moves, and ends with the next call. With no jobId it follows the run this machine started last, or the latest run.",
    inputSchema: { type: "object", properties: { jobId: str("A run or verify id, or the word pending. Omit for the run this machine started last.") }, additionalProperties: false } },
  { name: "findings", title: "Findings", annotations: readOnly,
    description: "The failures of a run, worst first and grouped by file and line: the question, the conversations it failed in with the range, the exchange, what a verify replays and how many clean replays would show it gone, then where the conversations ended and how their simulated users fared. With show numbers, every number the run measured: each question and measurement by journey, simulated user and reply, with ranges and the exchange behind the worst group. Once a run has finished, a long list comes in pages.",
    inputSchema: { type: "object", properties: { jobId: str("A run id. Omit for the latest."), show: { type: "string", enum: ["numbers"], description: "numbers: every number the run measured, in pages." }, page: { type: "integer", minimum: 1, description: "The page to read. Default 1." } }, additionalProperties: false } },
  { name: "verify", title: "Verify a fix",
    description: "Replays the conversations a finding failed on, word for word, after a change, and again by itself until an exact test says the failure is gone, shows less often, stayed, or cannot tell yet with how many clean replays would decide. Replies refused or failed on the replay are said first; conversations of the same question saved to test the fix are replayed once, and where they disagree with the replays beyond chance the first sentence says so; a crash:N finding replays the requests out when the app stopped. Answers within a second, run_status follows every round, and it uses verify conversations from the plan, not a run.",
    inputSchema: { type: "object", properties: { findingId: str("The finding id from findings."), jobId: str("The run the finding came from. Omit for the latest.") }, required: ["findingId"], additionalProperties: false } },
  { name: "dispute", title: "Dispute a check",
    description: "Records that a finding's check reads this app wrong, with the reason and an optional better wording. The finding and its rate stay as they are; the note goes to the owner.",
    inputSchema: { type: "object", properties: { findingId: str("The finding id."), why: str("One or two sentences: what the check gets wrong about this app.", { maxLength: 500 }), question: str("The wording that fits this app.", { maxLength: 300 }) }, required: ["findingId", "why"], additionalProperties: false } },
  { name: "feedback", title: "A note to the Cortad team",
    description: "Sends the Cortad team a note about Cortad itself: a result that read wrong, something you needed that no tool gave, a question a result left open, or what worked. Filing one is part of using Cortad, and the team reads each note. Nothing about the run or its checks changes.",
    inputSchema: { type: "object", properties: {
      about: { type: "string", enum: ABOUT, description: "The tool the note is about, connect for the connect command, or skill for the instructions you were handed." },
      kind: { type: "string", enum: ["problem", "idea", "question", "praise"], description: "problem: wrong or failed; idea: something you needed; question: something a result left open; praise: what worked." },
      needed: str("What you were trying to do or find out.", { maxLength: 500 }),
      got: str("What came back instead, in your own words; leave out your users' text and any key.", { maxLength: 1000 }),
      tried: str("What you did about it: another call, a guess, or asked the person.", { maxLength: 500 }),
    }, required: ["about", "kind", "needed"], additionalProperties: false } },
  { name: "field_connect", title: "Connect production", inputSchema: none,
    description: "The steps to connect production, to see what real users are doing as it happens and where the AI lets them down. The owner creates the key in the browser." },
  { name: "field", title: "Production numbers", annotations: readOnly,
    description: "Production in numbers: conversations read, checks passed, resolved, frustrated, asks for a human, and the rules broken most. Message text stays out of the answer.",
    inputSchema: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 180, description: "Window in days. Default 30." } }, additionalProperties: false } },
  { name: "world", title: "Test the AI in a world",
    description: "For an AI in this app that is not a chat, such as a worker that reads data and writes a verdict: Cortad builds a copy of the product's data on this machine from the app's own seed, plants problems whose answers are known, runs the app's own detection on each, and scores what it raised against the answer key, repeated for a flip rate. Answers within a second with the world's id; world_status follows it. Say what was built or what to test, and the report keeps it.",
    inputSchema: { type: "object", properties: { ask: str("What was built or what to test, in a sentence.", { maxLength: 2000 }) }, additionalProperties: false } },
  { name: "world_status", title: "Where a world stands", annotations: readOnly,
    description: "Where a world stands: planted problems found, missed, false alarms where nothing was planted, and flips between repeats, with what the app raised for each.",
    inputSchema: { type: "object", properties: { jobId: str("The world's id, from world.") }, required: ["jobId"], additionalProperties: false } },
  { name: "test", title: "Test what you built",
    description: "The one call after a change: say what you built or want tested, in a sentence, and Cortad decides what kind of test that is. A world, where this app has one and the sentence names something it can plant; a run of the app's chat surfaces otherwise. Answers within a second with which kind started and the call that follows it.",
    inputSchema: { type: "object", properties: { ask: str("What was built or what to test, in a sentence.", { maxLength: 2000 }) }, additionalProperties: false } },
  { name: "connect", title: "Connect the live app", inputSchema: none,
    description: "The steps to connect the live app, backend and page: a one-time code writes both keys into the env file, the SDK lines for the framework, the page tag, and where each conversation then appears. The same as field_connect." },
  { name: "intelligence", title: "The live app in numbers", annotations: readOnly,
    description: "What is happening to the live app: what is wrong now (since when, in how many of how many, the change before it), the window's conversations and checks, the visits and what people did after answers. No user's words.",
    inputSchema: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 90, description: "Window in days. Default 7." } }, additionalProperties: false } },
  { name: "incidents", title: "What went wrong", annotations: readOnly, inputSchema: none,
    description: "Each open incident: the check or reaction, since when, now against before, the cause the data points at (a release, a changed prompt or model, tool errors, page errors), and the conversations to open on the page. Fix the cause named first, then verify." },
  { name: "outcomes", title: "What counts as a good ending",
    description: "What the app counts as an outcome and how often it is reached; or, with proposals, new ones read from the code (a signup route, a checkout, a done button), which the person approves on the page before they count.",
    inputSchema: { type: "object", properties: { proposals: { type: "array", maxItems: 10, items: { type: "object", properties: { name: str("A short name, as the person would say it.", { maxLength: 64 }), why: str("What in the code makes this an outcome.", { maxLength: 500 }), rules: { type: "array", minItems: 1, maxItems: 10, items: { type: "object", properties: { kind: { type: "string", enum: ["path", "click", "event", "backend"] }, match: { type: "string", enum: ["exact", "starts", "contains"] }, value: { type: "string" }, text: { type: "string" }, selector: { type: "string" }, name: { type: "string" } }, required: ["kind"], additionalProperties: false } } }, required: ["name", "rules", "why"], additionalProperties: false } } }, additionalProperties: false } },
  { name: "subscribe", title: "Hear of incidents",
    description: "Registers a public https address that receives each incident as signed JSON (x-cortad-event, x-cortad-signature: sha256=HMAC of the body). Answers with the secret once; keep it where the app keeps its secrets.",
    inputSchema: { type: "object", properties: { url: str("A public https address that takes a POST.", { maxLength: 500 }) }, required: ["url"], additionalProperties: false } },
  { name: "query", title: "Ask the warehouse", annotations: readOnly,
    description: "A structured question over the live app's events, readings or reactions: a table, a time range of at most 90 days, filters, a grouping by columns or by hour or day, measures (count, count_distinct, sum, avg, min, max, share), a limit. Compiled by Cortad, pinned to this app; no SQL is taken. Rows come back as a table.",
    inputSchema: { type: "object", properties: {
      table: { type: "string", enum: ["events", "readings", "reactions"] },
      from: str("Start, ISO 8601."), to: str("End, ISO 8601, at most 90 days after from."),
      filters: { type: "array", maxItems: 20, items: { type: "object", properties: { column: { type: "string" }, op: { type: "string", enum: ["eq", "ne", "in", "gt", "gte", "lt", "lte", "null", "not_null"] }, value: {} }, required: ["column", "op"], additionalProperties: false } },
      group: { type: "array", maxItems: 4, items: { type: "string" }, description: "Columns, or hour or day." },
      measures: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", properties: { fn: { type: "string", enum: ["count", "count_distinct", "sum", "avg", "min", "max", "share"] }, column: { type: "string" }, equals: {}, as: { type: "string" } }, required: ["fn"], additionalProperties: false } },
      order: { type: "object", properties: { by: { type: "string" }, dir: { type: "string", enum: ["asc", "desc"] } }, required: ["by"], additionalProperties: false },
      limit: { type: "integer", minimum: 1, maximum: 1000 },
    }, required: ["table", "from", "to", "measures"], additionalProperties: false } },
];
const NAMES = new Set(TOOLS.map((t) => t.name));

const error = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });

// Serves until stdin closes. `verbs` is lib/verbs.mjs's object; `version` is the package's.
// `report` is lib/calls.mjs: handed each tool call once it has answered, and awaited before the exit.
export function serveMcp({ verbs, version, spec, input = process.stdin, output = process.stdout, log = () => {}, report = async () => {} }) {
  return new Promise((resolve) => {
    let client = {};
    const sending = new Set();
    // `callId`: this call's own name, made when it arrives and sent with every report of it (lib/calls.mjs).
    const count = (tool, began, text, failure, callId) => {
      const sent = Promise.resolve(report({ tool, callId, durationMs: Date.now() - began, outputChars: text.length, ...failure, ...client })).catch(() => {}).finally(() => sending.delete(sent));
      sending.add(sent);
    };
    let closed = false;
    const close = () => { if (!closed) { closed = true; void Promise.all(sending).then(() => resolve(0)); } };
    const send = (msg) => output.write(`${JSON.stringify(msg)}\n`);
    let buffer = "";
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line) void handle(line);
      }
    });
    input.on("end", close);
    input.on("close", close);

    async function handle(line) {
      let msg;
      try { msg = JSON.parse(line); } catch { send(error(null, -32700, "parse error")); return; }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) { send(error(null, -32600, "invalid request")); return; }
      const { id, method, params } = msg;
      const notification = id === undefined || id === null;
      const began = Date.now();
      const callId = randomUUID();
      try {
        switch (method) {
          case "initialize":
            client = { clientName: params?.clientInfo?.name, clientVersion: params?.clientInfo?.version };
            return send(result(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "cortad", version }, instructions: instructions(spec) }));
          case "notifications/initialized":
          case "notifications/cancelled":
            return;
          case "ping":
            return send(result(id, {}));
          case "tools/list":
            return send(result(id, { tools: TOOLS }));
          case "tools/call": {
            const name = params?.name;
            const verb = NAMES.has(name) && Object.hasOwn(verbs, name) ? verbs[name] : null;
            if (!verb) {
              count("unknown", began, "", { errorCode: "unknown_tool" }, callId);
              return send(result(id, { content: [{ type: "text", text: `No tool ${String(name)}.` }], isError: true }));
            }
            const out = await verb(params?.arguments ?? {});
            count(name, began, out.text, out.isError ? { errorCode: out.code ?? "refused", error: out.why } : {}, callId);
            const structured = out.structured && typeof out.structured === "object" && !Array.isArray(out.structured) ? { structuredContent: out.structured } : {};
            return send(result(id, { content: [{ type: "text", text: out.text }], ...structured, ...(out.isError ? { isError: true } : {}) }));
          }
          default:
            if (!notification) send(error(id, -32601, `method not found: ${String(method)}`));
        }
      } catch (err) {
        log(`mcp ${method}: ${err?.stack ?? err}`);
        if (method === "tools/call") count(NAMES.has(params?.name) ? params.name : "unknown", began, "", { errorCode: "internal" }, callId);
        if (!notification) send(result(id, { content: [{ type: "text", text: `Cortad could not answer: ${String(err?.message ?? err)}` }], isError: true }));
      }
    }
  });
}
