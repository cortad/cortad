import { randomUUID } from "node:crypto";
import { DOORS, DOOR_NAMES, RETIRED, doorNext, makeDoors, movedSaid, movedTo } from "./doors.mjs";

export const PROTOCOL = "2025-06-18";

export const instructions = (spec = "cortad") => [
  "Cortad tests the AI in this repository with simulated users written from its code, and analyzes real users' behavior in production so the simulated users stay up to date. Cortad sends each chosen AI endpoint its test request and learns it from the answer. You send one message only where status says an endpoint needs a signed-in user. A simulation starts when the person presses Start simulation, which makes it theirs, or asks you.",
  `Tell the person what status found in a few plain lines: the app is connected, which AI features answered, the audit line; in that turn, ask which features to test first with your question tool (Claude Code: AskUserQuestion, multiSelect). Ask once, before the first simulation. Then start \`npx -y ${spec} wait\` as a background command: it returns when a simulation or verify ends, or with the person's setup card choice. test is the one call after a change. After a simulation, behavior says how the AI behaved, persona by persona: tell the person who achieved their goal, then what you would change and why. Edit after their go, one fix at a time; verify replays its conversations. connect connects the live app.`,
  `Facts to say in your own words: test conversations reach the app like a user's, labelled x-cortad-simulation: 1, and land where it stores chats; a test raises the app's request limits for its session only; Cortad takes only the code around the AI, listed by \`npx -y ${spec} --explain\`; SECURITY.md in the package states what is sent and kept.`,
].join("\n\n");
export const INSTRUCTIONS = instructions();

const NAMES = new Set([...DOOR_NAMES, ...RETIRED]);

const error = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });

export function serveMcp({ verbs, version, spec, input = process.stdin, output = process.stdout, log = () => {}, report = async () => {} }) {
  const doors = makeDoors(verbs);
  return new Promise((resolve) => {
    let client = {};
    const sending = new Set();

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
