import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { DOORS } from "./doors.mjs";
import { INSTRUCTIONS, PROTOCOL, serveMcp } from "./mcp.mjs";

// A client on the other end of stdin and stdout: sends one line, reads one line back.
function client(verbs, report) {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = serveMcp({ verbs, version: "0.0.0-test", input, output, report });
  const lines = [];
  let buffer = "";
  output.on("data", (chunk) => { buffer += chunk; let at; while ((at = buffer.indexOf("\n")) >= 0) { lines.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1); } });
  const ask = async (msg) => {
    const before = lines.length;
    input.write(`${typeof msg === "string" ? msg : JSON.stringify(msg)}\n`);
    for (let i = 0; i < 50 && lines.length === before; i += 1) await new Promise((r) => setImmediate(r));
    return lines[before];
  };
  return { ask, end: () => { input.end(); return done; }, lines };
}

test("initialize answers the protocol, the server name and the instructions; initialized is silent", async () => {
  const c = client({});
  const init = await c.ask({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.equal(init.result.protocolVersion, PROTOCOL);
  assert.equal(init.result.serverInfo.name, "cortad");
  assert.equal(init.result.instructions, INSTRUCTIONS);
  assert.equal(await c.ask({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
  assert.equal((await c.ask({ jsonrpc: "2.0", id: 2, method: "ping" })).result !== undefined, true);
  assert.equal(await c.end(), 0);
});

test("tools/list names the seven doors with their schemas, and tools/call runs one and renders its text", async () => {
  const calls = [];
  const c = client({ post: async () => ({ text: "posted" }), status: async () => ({ text: "Repository: app. Plan: Free.", data: {} }), verify: async (args) => { calls.push(args); return { text: "Verify started", data: {} }; }, test: async () => ({ text: "refused", isError: true }) });
  const list = await c.ask({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((t) => t.name), ["status", "test", "behavior", "search", "verify", "connect", "tell"]);
  assert.equal(DOORS.every((t) => t.inputSchema.type === "object"), true);
  const status = await c.ask({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "status", arguments: {} } });
  assert.deepEqual(status.result.content, [{ type: "text", text: "Repository: app. Plan: Free." }]);
  await c.ask({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "verify", arguments: { findingId: "finding:1" } } });
  assert.deepEqual(calls, [{ findingId: "finding:1" }]);
  const refused = await c.ask({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "test", arguments: {} } });
  assert.equal(refused.result.isError, true);
  const unknown = await c.ask({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "toString", arguments: {} } });
  assert.match(unknown.result.content[0].text, /No tool/);
  const internal = await c.ask({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "post", arguments: {} } });
  assert.match(internal.result.content[0].text, /No tool post/, "an inside function is not a door and is not callable");
  await c.end();
});

// Every customer on 0.4.x has these names in the skill they were handed. A retired name answers as
// it always did, with one line above it naming the door to call next time.
test("a name the doors replaced still answers, and says what to call instead", async () => {
  const asked = [];
  const c = client({
    findings: async (args) => { asked.push(["findings", args]); return { text: "finding:1 broke in 3 of 10 conversations.", data: {} }; },
    feedback: async () => ({ text: "The Cortad team has the note.", data: {} }),
  });
  const old = await c.ask({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "findings", arguments: { jobId: "r-1", page: 2 } } });
  assert.deepEqual(asked, [["findings", { jobId: "r-1", page: 2 }]], "the retired name runs the thing it always ran, with its own arguments");
  assert.equal(old.result.content[0].text, 'findings is now behavior. This is that answer; call it that way next time.\nfinding:1 broke in 3 of 10 conversations.');
  const note = await c.ask({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "feedback", arguments: { about: "status", kind: "idea", needed: "a smaller run" } } });
  assert.match(note.result.content[0].text, /^feedback is now tell\./);
  const gone = await c.ask({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "propose_question", arguments: {} } });
  assert.match(gone.result.content[0].text, /No tool propose_question/, "a name that was never served is still no tool");
  await c.end();
});

test("an unknown method with an id is a JSON-RPC error, a bad line is a parse error, and nothing else reaches stdout", async () => {
  const c = client({});
  const missing = await c.ask({ jsonrpc: "2.0", id: 8, method: "resources/list" });
  assert.equal(missing.error.code, -32601);
  const bad = await c.ask("not json");
  assert.equal(bad.error.code, -32700);
  const notAnObject = await c.ask('"a string"');
  assert.equal(notAnObject.error.code, -32600);
  await c.end();
  assert.equal(c.lines.every((line) => line.jsonrpc === "2.0"), true);
});

// Codex keeps the first 512 characters of server instructions self-contained; Claude Code shares
// about 4 KB across every server. Tool text says what a tool does, never how the agent should act.
test("the instructions stand alone in their first 512 characters and the door text carries no orders", () => {
  const [first] = INSTRUCTIONS.split("\n\n");
  assert.ok(first.length <= 512, `the first paragraph is ${first.length} characters`);
  assert.match(first, /^Cortad tests the AI in this repository with simulated users written from its code, and analyzes real users' behavior in production/);
  // Cortad sends each endpoint its own test request: the agent was told to send them, and the skill said the opposite.
  assert.match(first, /Cortad sends each chosen AI endpoint its test request and learns it from the answer\. You send one message only where status says an endpoint needs a signed-in user\. A simulation starts when the person presses Start simulation, which makes it theirs, or asks you\.$/);
  assert.ok(!/For the person|header|sign-in|cookie/i.test(INSTRUCTIONS), "nothing is scripted for the person, and nothing asks the agent for a sign-in");
  assert.ok(INSTRUCTIONS.length < 1500, `the instructions are ${INSTRUCTIONS.length} characters`);
  // The session in order: tell the person, start the wait, test a change, read what failed, fix, production.
  // After a run: how the AI behaved with their users, persona by persona, before any fix.
  const at = ["Tell the person what status found", "start `npx -y cortad wait` as a background command", "test is the one call after a change", "After a simulation, behavior says", "persona by persona", "what you would change", "verify replays", "connect connects the live app"].map((s) => INSTRUCTIONS.indexOf(s));
  assert.ok(at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1])), `in order: ${at}`);
  const words = [INSTRUCTIONS.replace(/`npx -y cortad wait`/, ""), ...DOORS.flatMap((t) => [t.title, t.description, ...Object.values(t.inputSchema.properties).map((p) => p.description)])].join("\n");
  assert.doesNotMatch(words, /\b(?:do not|don't|never|stay quiet|poll|every 30 seconds|what good looks like|about 100)\b|\u2014/i);
  for (const t of DOORS) assert.ok(t.title && t.description, `${t.name} has a title and says what it does`);
  const readOnly = DOORS.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
  assert.deepEqual(readOnly, ["status", "behavior", "search"], "three doors read and the other four do something");
  const byName = Object.fromEntries(DOORS.map((t) => [t.name, t]));
  assert.equal(byName.status.inputSchema.required, undefined, "the door an agent opens most takes nothing at all");
  assert.deepEqual(byName.status.inputSchema.properties.about.enum, ["repository", "run", "production", "outcomes", "warehouse", "users"], "what failed is behavior's, not a lane of status");
  assert.deepEqual(byName.status.inputSchema.properties.show.enum, ["rules", "standards", "journeys", "endpoints", "trials", "records", "reviews", "machine"]);
  assert.deepEqual(Object.keys(byName.behavior.inputSchema.properties), ["at", "persona", "against", "history"]);
  assert.deepEqual(byName.search.inputSchema.required, ["query"]);
  assert.equal(byName.status.inputSchema.properties.page.type, "integer");
  assert.deepEqual(Object.keys(byName.test.inputSchema.properties), ["ask", "conversations", "endpoints", "features", "account"], "a test takes no headers: the sign-in is never the agent's to hand over; account is the person's yes to one being made");
  // A note names a door by its own name, the connect command, or the skill; a door renamed here is caught.
  assert.deepEqual(byName.tell.inputSchema.properties.about.enum, [...DOORS.map((t) => t.name), "skill"]);
  // A customer skipped the run: it played 48 conversations for about $40 on his own key and the tool
  // took no parameters at all, so neither he nor his agent could ask for a smaller one. An agent
  // reaches for what the description names, so the description names it.
  assert.match(byName.test.inputSchema.properties.conversations.description, /^The most conversations a simulation may play, for example 10,/);
  assert.equal(byName.test.inputSchema.properties.conversations.maximum, undefined, "how many a simulation may play is the server's range, kept in one place");
  assert.equal(byName.verify.inputSchema.required.join(), "findingId");
});

// Twenty descriptions with close cousins among them is what the doors replaced, and the whole point
// is that six carry less, not more: every client pays for this on every turn.
test("the seven doors carry less than the nineteen tools they replaced", () => {
  const bytes = JSON.stringify(DOORS).length + INSTRUCTIONS.length;
  assert.ok(bytes < 15570, `the doors and the instructions are ${bytes} bytes against the 15,570 of the nineteen`);
});

test("a result that carries structured data hands it over as structuredContent beside the text, and one without has none", async () => {
  const dissection = { run: { id: "r", played: 3, planned: 3 }, runOnly: [{ id: "finding:1", reach: "failed in 3 of 3 trials" }], inCode: [] };
  const c = client({ run_status: async () => ({ text: "Simulation r: finished", data: { dissection }, structured: dissection }), status: async () => ({ text: "Cortad", data: {} }) });
  const done = await c.ask({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status", arguments: { about: "run" } } });
  assert.deepEqual(done.result.content, [{ type: "text", text: "Simulation r: finished" }]);
  assert.deepEqual(done.result.structuredContent, dissection);
  const plain = await c.ask({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status", arguments: {} } });
  assert.equal("structuredContent" in plain.result, false);
  await c.end();
});

test("each tool call is counted once with its client, time, length and failure code, never its arguments or answer, and the exit waits for the count", async () => {
  const counted = [];
  let landed = 0;
  const report = async (call) => { counted.push(call); await new Promise((r) => setTimeout(r, 20)); landed += 1; };
  const c = client({
    status: async () => ({ text: "all good" }),
    test: async () => ({ text: "No simulations left. secret words", isError: true, code: "plan_spent" }),
    behavior: async () => { throw new Error("boom"); },
  }, report);
  await c.ask({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "claude-code", version: "2.1" } } });
  await c.ask({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status", arguments: { show: "rules" } } });
  await c.ask({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "test", arguments: {} } });
  await c.ask({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "behavior", arguments: {} } });
  await c.ask({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "toString", arguments: {} } });
  await c.ask({ jsonrpc: "2.0", id: 6, method: "tools/list" });
  assert.equal(await c.end(), 0);
  assert.equal(landed, 4);
  assert.deepEqual(counted.map((k) => [k.tool, k.errorCode, k.error, k.outputChars, k.clientName, k.clientVersion]), [
    ["status", undefined, undefined, 8, "claude-code", "2.1"],
    ["test", "plan_spent", undefined, 33, "claude-code", "2.1"],
    ["behavior", "internal", undefined, 0, "claude-code", "2.1"],
    ["unknown", "unknown_tool", undefined, 0, "claude-code", "2.1"],
  ]);
  assert.ok(counted.every((k) => Number.isInteger(k.durationMs) && k.durationMs >= 0));
  assert.ok(!JSON.stringify(counted).includes("rules") && !JSON.stringify(counted).includes("all good"));
});
