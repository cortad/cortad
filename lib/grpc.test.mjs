import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { grpcCall, protoFiles } from "./grpc.mjs";

// A gRPC app under the hook: one rpc asks a model, one does not. The hook writes the asking call as
// an exchange with the message as its body and the reply as written, lists the rpcs as routes, and
// the sender (grpc.mjs) calls the door the way the app's own clients would.
const PROTO = `syntax = "proto3";
package proof;
service Chat {
  rpc Ask (AskRequest) returns (AskReply);
  rpc Ping (AskRequest) returns (AskReply);
  rpc Tail (AskRequest) returns (stream AskReply);
}
message AskRequest { string question = 1; }
message AskReply { string answer = 1; }
`;
const APP = (modelPort) => `
const grpc = require("@grpc/grpc-js");
const loader = require("@grpc/proto-loader");
const path = require("node:path");
const def = loader.loadSync(path.join(__dirname, "chat.proto"), { keepCase: true });
const pkg = grpc.loadPackageDefinition(def).proof;
const server = new grpc.Server();
server.addService(pkg.Chat.service, {
  Ask: async (call, callback) => {
    const res = await fetch("http://127.0.0.1:${modelPort}/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: call.request.question }] }) });
    const out = await res.json();
    callback(null, { answer: out.choices[0].message.content });
  },
  Ping: (call, callback) => callback(null, { answer: "pong" }),
  Tail: (call) => { call.write({ answer: "one" }); call.write({ answer: "two" }); call.end(); },
});
server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, port) => { if (err) throw err; console.log("PORT " + port); });
`;

test("a gRPC rpc that asks a model is an exchange with its message, its reply and its model call; the sender calls it through the app's own libraries", async () => {
  // The app's folder resolves @grpc/grpc-js from this repository's own node_modules.
  const dir = mkdtempSync(join(process.cwd(), "lib", ".grpc-app-"));
  const model = createServer((req, res) => { let raw = ""; req.on("data", (c) => { raw += c; }); req.on("end", () => { const asked = JSON.parse(raw).messages.at(-1).content; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `About ${asked}: pack light.` } }], usage: { prompt_tokens: 5, completion_tokens: 4 } })); }); }).listen(0, "127.0.0.1");
  await once(model, "listening");
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "chat.proto"), PROTO);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "grpc-proof", version: "1.0.0" }));
  writeFileSync(join(dir, "app.cjs"), APP(model.address().port));
  const child = spawn(process.execPath, ["--require", new URL("./trace.cjs", import.meta.url).pathname, join(dir, "app.cjs")], { cwd: dir, env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
  try {
    const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
    assert.deepEqual(protoFiles(dir).map((f) => f.endsWith("chat.proto")), [true]);
    const asked = await grpcCall({ path: "/proof.Chat/Ask", body: { question: "Rome in May" }, headers: { "x-cortad-turn": "cortad-t1" }, port, appDir: dir, root: dir });
    assert.equal(asked.status, 200, asked.text);
    assert.deepEqual(JSON.parse(asked.text), { answer: "About Rome in May: pack light." });
    const pinged = await grpcCall({ path: "/proof.Chat/Ping", body: { question: "x" }, port, appDir: dir, root: dir });
    assert.deepEqual([pinged.status, JSON.parse(pinged.text)], [200, { answer: "pong" }]);
    const tailed = await grpcCall({ path: "/proof.Chat/Tail", body: { question: "x" }, port, appDir: dir, root: dir });
    assert.deepEqual([tailed.status, tailed.text.split("\n").map((l) => JSON.parse(l))], [200, [{ answer: "one" }, { answer: "two" }]]);
    const missing = await grpcCall({ path: "/proof.Chat/Nope", body: {}, port, appDir: dir, root: dir });
    assert.equal(missing.status, 500);
    await new Promise((r) => setTimeout(r, 400));
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const rows = lines.filter((l) => l.method === "GRPC");
    assert.deepEqual(rows.map((r) => [r.path, r.status]), [["/proof.Chat/Ask", 200]], "only the rpc that asked a model is an exchange");
    assert.deepEqual(JSON.parse(rows[0].body), { question: "Rome in May" });
    assert.deepEqual(JSON.parse(rows[0].reply), { answer: "About Rome in May: pack light." });
    assert.equal(rows[0].turn, "cortad-t1", "the turn travelled as metadata");
    assert.match(rows[0].sent[0], /Rome in May/, "the model call is tied to the exchange");
    const routes = lines.find((l) => l.routes)?.routes.routes ?? [];
    assert.ok(routes.some((r) => r.method === "GRPC" && r.path === "/proof.Chat/Ask"), `the rpc is on the route table: ${JSON.stringify(routes).slice(0, 200)}`);
  } finally {
    child.kill("SIGTERM");
    model.close();
  }
});
