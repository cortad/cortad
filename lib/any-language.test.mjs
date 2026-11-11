import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { conversationOf } from "./history/contract.mjs";
import * as say from "./intelligence-text.mjs";
import messages from "./message-text.cjs";
import { composePorts, forContainer, inContainer, passedThrough, publishedPorts } from "./start.mjs";

const { messageText } = messages;

// A Go, Java or Rust app run with `docker run` answers on the host port it publishes, and nothing in
// the command's own process family listens there: the daemon's forwarder does.
test("a container command says where it answers and which settings it hands through", () => {
  const cmd = "docker run --rm -p 3204:8080 --publish=127.0.0.1:3300:80 -e OPENAI_BASE_URL --env MODEL -e FIXED=1 -v .:/app golang:1.23-alpine go run .";
  assert.equal(inContainer(cmd), true);
  assert.equal(inContainer("go run ."), false);
  assert.deepEqual(publishedPorts(cmd), [3204, 3300]);
  assert.deepEqual([...passedThrough(cmd)], ["OPENAI_BASE_URL", "MODEL"]);
});

test("docker compose's published ports are read from its file, short syntax and long", () => {
  const dir = mkdtempSync(join(tmpdir(), "cortad-compose-"));
  writeFileSync(join(dir, "docker-compose.yml"), 'services:\n  api:\n    ports:\n      - "3204:8080"\n      - 127.0.0.1:3300:80/tcp\n    volumes:\n      - ./data:/data\n  web:\n    ports:\n      - target: 80\n        published: "3400"\n');
  writeFileSync(join(dir, "other.yml"), "services:\n  api:\n    ports:\n      - 5100:5000\n");
  assert.deepEqual(composePorts("docker compose up", dir), [3204, 3300, 3400]);
  assert.deepEqual(composePorts("docker compose -f other.yml up", dir), [5100]);
  assert.deepEqual(composePorts("docker run -p 1:2 x", dir), []);
});

test("inside a container the proxy is reached at host.docker.internal, not the container's own loopback", () => {
  assert.deepEqual(forContainer({ OPENAI_BASE_URL: "http://127.0.0.1:5123/u/0" }), { OPENAI_BASE_URL: "http://host.docker.internal:5123/u/0" });
});

const KINDS = [
  ["OpenAI chat image", [{ type: "text", text: "Is this mine?" }, { type: "image_url", image_url: { url: "data:," } }], "Is this mine?\n[image]"],
  ["OpenAI chat audio", [{ type: "input_audio", input_audio: { data: "" } }], "[audio]"],
  ["OpenAI Responses", [{ type: "input_text", text: "Where is it?" }, { type: "input_file", filename: "receipt.pdf" }], "Where is it?\n[file receipt.pdf]"],
  ["Anthropic tool use and thinking", [{ type: "thinking", thinking: "..." }, { type: "tool_use", name: "lookup_order", input: { order_id: "PP-1" } }], '[tool call lookup_order {"order_id":"PP-1"}]'],
  ["Anthropic tool result", [{ type: "tool_result", content: [{ type: "text", text: "in transit" }] }], "in transit"],
  ["Gemini", [{ text: "Is this mine?" }, { inlineData: { mimeType: "image/png" } }, { functionCall: { name: "lookup_order", args: {} } }], "Is this mine?\n[image]\n[tool call lookup_order {}]"],
  ["Bedrock", [{ image: { format: "png" } }, { toolResult: { content: [{ text: "in transit" }] } }], "[image]\nin transit"],
  ["a provider's own tool", [{ type: "web_search_tool_result", content: [] }, { type: "text", text: "Found it." }], "Found it."],
  ["a kind not named yet", [{ type: "video" }], "[video]"],
];

test("every provider's message reads as its text, with a marker for what is not text", () => {
  for (const [kind, content, want] of KINDS) assert.equal(messageText(content), want, kind);
});

test("a brought-in message made of blocks keeps its words and marks the rest", () => {
  const at = "2026-11-01T10:00:00Z";
  const got = conversationOf({ id: "c1", messages: [
    { role: "user", at, content: [{ type: "input_text", text: "Where is PP-1001?" }, { type: "input_image", image_url: "x" }] },
    { role: "assistant", at, content: [{ type: "output_text", text: "In transit." }] },
  ] }, () => null);
  assert.deepEqual(got.messages.map((m) => m.text), ["Where is PP-1001?\n[image]", "In transit."]);
});

test("an app in a language with no SDK is handed the signed request to send, not a package", () => {
  const text = say.codeStep({ spec: "cortad@0", stack: { kind: "other", add: "" }, page: null, file: ".env", site: null, consent: null, host: "other", settable: false, address: "http://localhost:8283/api/v1/conversations" }).join("\n");
  assert.match(text, /POST http:\/\/localhost:8283\/api\/v1\/conversations/);
  assert.match(text, /x-cortad-signature: "v1=" \+ hex\(HMAC-SHA256/);
  assert.doesNotMatch(text, /npm|pip install|@cortad\/sdk/);
});
