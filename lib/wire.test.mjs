import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const { isModelCall } = createRequire(import.meta.url)("./wire.cjs");

// Ask A Question calls its model through LiteLLM's proxy at http://127.0.0.1:4115/chat/completions:
// five calls a request, none seen, and the run measured nothing.
const CASES = [
  ["127.0.0.1:4115", "/chat/completions", true],
  ["localhost:4000", "/completions", true],
  ["127.0.0.1:4115", "/embeddings", true],
  ["localhost:11434", "/v1/chat/completions", true],
  ["localhost:11434", "/api/chat", true],
  ["api.openai.com", "/v1/responses", true],
  ["slack.com", "/api/chat.postMessage", false],
  ["hooks.example.com", "/messages", false],
  ["crm.example.com", "/responses", false],
  ["api.example.com", "/chat", false],
  ["proxy.example.com", "/v1/messages", true],
  ["proxy.example.com", "/anthropic/v1/messages", true],
  ["proxy.example.com", "/v1/ai/language-model", true],
  ["proxy.example.com", "/v1/ai/embedding-model", true],
  ["api.mailgun.net", "/v3/mg.example.com/messages", false],
  ["graph.facebook.com", "/v19.0/1055512345/messages", false],
  ["discord.com", "/api/v10/channels/42/messages", false],
  ["conversations.twilio.com", "/v1/Conversations/CH1/Messages", false],
  ["api.telnyx.com", "/v2/messages", false],
  ["api.nexmo.com", "/v1/messages", false],
];

test("an OpenAI-shaped path is a model call on any host; other model paths need a version or /api/", () => {
  for (const [host, path, want] of CASES) assert.equal(isModelCall(host, path), want, `${host}${path}`);
});

// The Python hook's own function, lifted out of sitecustomize.py with the patterns it reads, run on
// the same cases: the two hooks never disagree on what a model call is.
test("the Python hook draws the same line", () => {
  const out = execFileSync("python3", ["-c", `
import json, re, sys
from urllib.parse import urlsplit
text = open("lib/pyhook/sitecustomize.py").read()
ns = {"re": re, "urlsplit": urlsplit}
for name in ("model_host", "model_path", "messaging_host"):
    m = re.search(r"^\\s*" + name + r" = (re\\.compile\\(.*\\))$", text, re.M)
    ns[name] = eval(m.group(1), {"re": re})
start = text.index("    def is_model_call(url):")
body = text[start:text.index("\\n\\n", start)]
exec("\\n".join(l[4:] for l in body.splitlines()), ns)
cases = json.loads(sys.argv[1])
print(json.dumps([ns["is_model_call"]("http://" + c[0] + c[1]) for c in cases]))
`, JSON.stringify(CASES)], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(out), CASES.map((c) => c[2]));
});

// MIT Learn AI's search results ran to 8,000 characters and were kept at 3,000; a podcast episode in the
// part cut off was graded as made up.
test("a tool answer is kept to 12,000 characters, and one longer says it was cut", () => {
  const { toolText } = createRequire(import.meta.url)("./wire.cjs");
  const eight = "episode ".repeat(1000);
  assert.deepEqual(toolText("search_courses", eight), { name: "search_courses", text: eight });
  const long = toolText("search_courses", "x".repeat(12_500), { provider: true });
  assert.equal(long.text.length, 12_000);
  assert.equal(long.cut, true);
  assert.equal(long.provider, true);
});

// One customer's main chat sends its model a 25,000-token prompt, the system message first and the person's
// message last. Cut at 64 KB the record held the system message alone, and a word of it ("arabic")
// was taken for the person's message.
const LONG = JSON.stringify({ model: "m", messages: [{ role: "system", content: "Answer in Arabic. ".repeat(6000) }, { role: "user", content: "اشرح لي قانون نيوتن الثاني" }] });

test("a model request longer than the record keeps its shape and its newest turn whole", () => {
  const { fitted, MAX } = createRequire(import.meta.url)("./wire.cjs");
  assert.ok(LONG.length > MAX);
  const kept = fitted(LONG);
  assert.ok(kept.length <= MAX, `${kept.length}`);
  const body = JSON.parse(kept);
  assert.deepEqual(body.messages.map((m) => m.role), ["system", "user"]);
  assert.equal(body.messages[1].content, "اشرح لي قانون نيوتن الثاني");
  assert.ok(body.messages[0].content.startsWith("Answer in Arabic.") && body.messages[0].content.endsWith("Answer in Arabic. "));
  assert.equal(fitted(JSON.stringify({ a: "short" })), JSON.stringify({ a: "short" }), "a request that fits is kept as it is");
  assert.equal(fitted("x".repeat(MAX + 1)), "x".repeat(MAX), "one that is not JSON keeps its head");
});

test("the Python hook fits a long request the same way", () => {
  const { fitted } = createRequire(import.meta.url)("./wire.cjs");
  const out = execFileSync("python3", ["-c", `
import json, sys
text = open("lib/pyhook/sitecustomize.py").read()
ns = {"json": json, "limit": 65536, "reply_max": 8 * 1024 * 1024}
for name in ("text", "fitted"):
    start = text.index("    def " + name + "(")
    exec("\\n".join(l[4:] for l in text[start:text.index("\\n\\n", start)].splitlines()), ns)
print(ns["fitted"](sys.argv[1]))
`, LONG], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(out), JSON.parse(fitted(LONG)));
});
