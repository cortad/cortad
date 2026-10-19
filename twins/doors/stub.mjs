// An MCP server that serves one arm's real tool definitions and does nothing else: every call is
// appended to a file and answered with one neutral line. What is being measured is which door an
// agent opens, so the tools must be the exact ones customers are served and the answers must carry
// no hint of what to call next.
//
//   node stub.mjs <tools.json> <calls.jsonl>

import { appendFileSync, readFileSync } from "node:fs";

const [, , toolsPath, callsPath] = process.argv;
const tools = JSON.parse(readFileSync(toolsPath, "utf8"));

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line) handle(JSON.parse(line));
  }
});

function handle({ id, method, params }) {
  if (method === "initialize") {
    return result(id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cortad", version: "0.0.0-twin" }, instructions: tools.instructions });
  }
  if (method === "tools/list") return result(id, { tools: tools.tools });
  if (method === "tools/call") {
    appendFileSync(callsPath, `${JSON.stringify({ name: params?.name, arguments: params?.arguments ?? {} })}\n`);
    return result(id, { content: [{ type: "text", text: "Noted." }] });
  }
  if (method === "ping") return result(id, {});
  if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
}
