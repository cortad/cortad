// Finding an app's AI with nothing typed. Each app here is one that was read wrong once.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { multiTurn } from "../lib/play.mjs";
import { asEndpoint, knock } from "../lib/reach/knock.mjs";
import { configFrom } from "../lib/cli/init.mjs";
import { fieldsWanted, fill } from "../lib/reach/repair.mjs";
import { replyPathOf } from "../lib/reach/shapes.mjs";

const appOn = (routes) => new Promise((done) => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const sent = (() => { try { return JSON.parse(body || "{}"); } catch { return {}; } })();
      const answer = routes[req.url]?.(sent) ?? { status: 404, body: { error: "Not found" } };
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  }).listen(0, "127.0.0.1", () => done({ server, base: `http://127.0.0.1:${server.address().port}` }));
});

const prose = "Of course, happy to help with that order. What is the order number?";

test("a refusal names the field it wanted, and a thread field becomes the placeholder", () => {
  assert.deepEqual(fieldsWanted("Missing required field: threadId"), ["threadId"]);
  assert.deepEqual(fieldsWanted("body.messages must be an array of turns"), ["messages"]);
  assert.deepEqual(fieldsWanted("something went wrong"), []);
  assert.equal(fill("conversationId"), "{{thread}}");
  assert.equal(fill("userId"), "1");
});

test("the reply is the longest string in the answer, found by its own path", () => {
  assert.equal(replyPathOf({ choices: [{ message: { content: prose } }] }).path, "choices.0.message.content");
  assert.equal(replyPathOf({ id: "abc", data: { reply: prose } }).path, "data.reply");
  assert.equal(replyPathOf({ ok: true }), null);
});

test("the chat is found behind a route that is not mounted and one that only looks like a chat", async () => {
  const app = await appOn({
    "/api/autocomplete": () => ({ status: 200, body: { suggestions: ["refund policy and how to use it properly"] } }),
    "/api/chat": (sent) => {
      if (!sent.threadId) return { status: 400, body: { error: "Missing required field: threadId" } };
      const text = sent.messages?.[0]?.parts?.[0]?.text ?? sent.messages?.[0]?.content;
      if (!text) return { status: 422, body: { error: "body.messages must be an array of turns" } };
      return { status: 200, body: { choices: [{ message: { content: prose } }] } };
    },
  });
  const out = await knock(app.base);
  app.server.close();

  assert.equal(out.found.length, 1, "the autocomplete is machinery, not a chat");
  assert.equal(out.found[0].path, "/api/chat");
  assert.equal(out.found[0].reply, "choices.0.message.content");
  const endpoint = asEndpoint(out.found[0]);
  assert.equal(endpoint.body.threadId, "{{thread}}", "a thread field is per conversation, not one id for all of them");
  assert.equal(multiTurn(endpoint), true, "a thread the app keeps means the conversation can continue");
});

test("a route that answers with a label is not a chat", async () => {
  const app = await appOn({ "/api/chat": () => ({ status: 200, body: { status: "ok" } }) });
  const out = await knock(app.base);
  app.server.close();
  assert.deepEqual(out.found, []);
});

test("an app with nothing running leaves an endpoint to fill in, and says nothing was found", async () => {
  const written = configFrom(undefined);
  assert.equal(written.endpoint.url, "http://localhost:3000/api/chat");
  assert.equal(written.app, "");
});
