// The MCP face: newline-delimited JSON-RPC 2.0 on stdin and stdout, protocol 2025-06-18, no
// dependency. stdout carries protocol messages and nothing else; everything a person might read
// goes to stderr. The tools are the six doors of lib/doors.mjs; the names they replaced still
// answer, so an agent handed an older skill is told where to go instead of getting nothing.

import { randomUUID } from "node:crypto";
import { DOORS, DOOR_NAMES, RETIRED, doorNext, makeDoors, movedSaid, movedTo } from "./doors.mjs";

export const PROTOCOL = "2025-06-18";

// Codex keeps only the first 512 characters self-contained and Claude Code shares about 4 KB across
// every server, so the first paragraph stands alone and the whole stays under 1,500 characters.
export const instructions = (spec = "cortad") => [
  "Cortad tests the AI in this repository: simulated users written from the app's code talk to the app running on this machine, and every reply is checked. You connect the app with its own start command after `--`, then send each AI endpoint one message as a user would; Cortad learns the endpoint from that request. status says what to know right now: whether the app is up, what Cortad's audit of the AI code found, and what a run would cost. A run starts when the person presses Run in the browser or asks you.",
  `Tell the person what status found in three or four short, plain lines, leaving out file paths, endpoints, status codes and setting names unless they ask. Before you stop, start \`npx -y ${spec} wait\` as a background command: it returns when the next run or verify ends, with what it found. test is the one call after a change: say what you built and Cortad decides what kind of test that is. After a run, status gives you what their users ran into; tell the person what you would change, worst first, three problems at most, and nothing is edited before their go. On their go, one fix at a time: verify replays the failing conversations, says whether the failure is gone, and says how long the last fix for it held. status about production is the live app and what is wrong in it; connect connects it. dispute records a check that reads this app wrong, and tell sends the Cortad team a note.`,
].join("\n\n");
export const INSTRUCTIONS = instructions();

// Every name tools/call answers: the six doors and the names they replaced.
const NAMES = new Set([...DOOR_NAMES, ...RETIRED]);

const error = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });

// Serves until stdin closes. `verbs` is lib/verbs.mjs's object; `version` is the package's.
// `report` is lib/calls.mjs: handed each tool call once it has answered, and awaited before the exit.
export function serveMcp({ verbs, version, spec, input = process.stdin, output = process.stdout, log = () => {}, report = async () => {} }) {
  const doors = makeDoors(verbs);
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
            return send(result(id, { tools: DOORS }));
          case "tools/call": {
            const name = params?.name;
            // A door, or one of the names the doors replaced: an agent handed an older skill still
            // gets its answer, with the line that says what to call instead.
            const verb = DOOR_NAMES.has(name) ? doors[name] : movedTo(name) && Object.hasOwn(verbs, name) ? verbs[name] : null;
            if (!verb) {
              count("unknown", began, "", { errorCode: "unknown_tool" }, callId);
              return send(result(id, { content: [{ type: "text", text: `No tool ${String(name)}.` }], isError: true }));
            }
            const answered = await verb(params?.arguments ?? {});
            const said = doorNext(answered.text);
            const out = DOOR_NAMES.has(name) ? { ...answered, text: said } : { ...answered, text: `${movedSaid(name)}\n${said}` };
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
