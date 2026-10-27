import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { MESSAGE } from "../lib/schema.mjs";
import { fill, MESSAGES, multiTurn, playAll, playCase } from "../lib/play.mjs";

const appOn = (handler) => new Promise((done) => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const answer = handler(body ? JSON.parse(body) : null, req);
      res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  }).listen(0, "127.0.0.1", () => done({ server, port: server.address().port }));
});

const endpointAt = (port, body) => ({
  url: `http://127.0.0.1:${port}/chat`,
  method: "POST",
  headers: {},
  body,
  reply: "reply",
});

test("one turn goes out and the reply comes back on the transcript", async () => {
  const { server, port } = await appOn((sent) => ({ body: { reply: `you said ${sent.messages[0].content}` } }));
  const played = await playCase(endpointAt(port, { messages: [{ role: "user", content: MESSAGE }] }), { id: "a", title: "t", turns: ["hello"] });
  server.close();
  assert.deepEqual(played.transcript, [{ role: "user", text: "hello" }, { role: "app", text: "you said hello" }]);
});

test("a body that takes the turn list plays every turn with the history behind it", async () => {
  const seen = [];
  const { server, port } = await appOn((sent) => { seen.push(sent.messages.length); return { body: { reply: "ok" } }; });
  const endpoint = endpointAt(port, { messages: MESSAGES });
  assert.equal(multiTurn(endpoint), true);
  const played = await playCase(endpoint, { id: "a", title: "t", turns: ["one", "two", "three"] });
  server.close();
  assert.deepEqual(seen, [1, 3, 5]);
  assert.equal(played.transcript.length, 6);
});

test("a body that takes one message plays the first turn only", async () => {
  let calls = 0;
  const { server, port } = await appOn(() => { calls += 1; return { body: { reply: "ok" } }; });
  await playCase(endpointAt(port, { text: MESSAGE }), { id: "a", title: "t", turns: ["one", "two"] });
  server.close();
  assert.equal(calls, 1);
});

test("an app that errors ends the conversation there and the error is the finding", async () => {
  const { server, port } = await appOn(() => ({ status: 500, body: { error: "boom" } }));
  const played = await playCase(endpointAt(port, { text: MESSAGE }), { id: "a", title: "t", turns: ["one"] });
  server.close();
  assert.match(played.error, /answered 500/);
  assert.equal(played.transcript.length, 1);
});

test("an answer with no reply at the stated path says where it looked", async () => {
  const { server, port } = await appOn(() => ({ body: { other: "x" } }));
  const played = await playCase(endpointAt(port, { text: MESSAGE }), { id: "a", title: "t", turns: ["one"] });
  server.close();
  assert.match(played.error, /no reply at reply/);
});

test("every conversation comes back, in the order they were asked for", async () => {
  const { server, port } = await appOn((sent) => ({ body: { reply: sent.text } }));
  const cases = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, title: `t${i}`, turns: [`m${i}`] }));
  const played = await playAll(endpointAt(port, { text: MESSAGE }), cases, { at: 4 });
  server.close();
  assert.deepEqual(played.map((p) => p.id), cases.map((c) => c.id));
  assert.deepEqual(played.map((p) => p.transcript[1].text), cases.map((_, i) => `m${i}`));
});

test("the placeholder is replaced however deep it sits", () => {
  assert.deepEqual(fill({ a: [{ b: MESSAGE }], c: "x" }, { message: "hi" }), { a: [{ b: "hi" }], c: "x" });
  assert.equal(fill(`prefix ${MESSAGE}`, { message: "hi" }), "prefix hi");
});
