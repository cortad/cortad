// The MCP face: newline-delimited JSON-RPC 2.0 on stdin and stdout, protocol 2025-06-18, no
// dependency. stdout carries protocol messages and nothing else; everything a person might read
// goes to stderr. The tools are the seven doors of lib/doors.mjs; the names they replaced still
// answer, so an agent handed an older skill is told where to go instead of getting nothing.

import { randomUUID } from "node:crypto";
import { DOORS, DOOR_NAMES, RETIRED, doorNext, makeDoors, movedSaid, movedTo } from "./doors.mjs";

export const PROTOCOL = "2025-06-18";

// Codex keeps only the first 512 characters self-contained and Claude Code shares about 4 KB across
// every server, so the first paragraph stands alone and the whole stays under 1,500 characters.
export const instructions = (spec = "cortad") => [
  "Cortad tests the AI in this repository with simulated users written from its code, and analyzes real users' behavior in production so the simulated users stay up to date, with no evals to write. Connect the app with its start command after `--`; Cortad sends each chosen AI endpoint its test request and learns it from the answer. You send one message only where status says an endpoint needs a signed-in user. A run starts when the person presses Run simulation, which makes it theirs, or asks you.",
  `Tell the person what status found in three or four plain lines: the app is connected, which AI features answered, the audit in its one line; in that turn, ask which features the first run tests with your question tool (in Claude Code, AskUserQuestion with multiSelect). Say file paths, where conversations are stored, raised request limits or where Cortad put its tools only if asked. Ask once before the first simulation, then start runs as needed. Before you stop, start \`npx -y ${spec} wait\` as a background command: it returns when a run or verify ends or with the person's setup card choice, which is their go. test is the one call after a change. After a run, behavior says how the AI behaved with their users: tell the person persona by persona who achieved their goal, then what you would change and why. Nothing is edited before their go; then one fix at a time; verify replays its conversations. search finds conversations by meaning. connect connects the live app; tell sends a note.`,
].join("\n\n");
export const INSTRUCTIONS = instructions();

// Every name tools/call answers: the seven doors and the names they replaced.
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
