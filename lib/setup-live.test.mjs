import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { selected } from "./history/contract.mjs";
import { sourcesIn } from "./history/sources.mjs";
import { changesIn, report } from "./setup-live.mjs";
import { askedText } from "./setup-live-text.mjs";

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "cortad-live-"));
  execFileSync("git", ["init", "-q", root]);
  return root;
};

test("a code change counts once it is in the app's own code, committed or not, and never by its manifest", () => {
  const root = repo();
  assert.deepEqual(changesIn(root), { sdk: false, tag: false });
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { "@cortad/sdk": "0.3.3" } }));
  mkdirSync(join(root, "web"));
  writeFileSync(join(root, "web", "package.json"), '{"dependencies":{"@cortad/sdk":"0.3.3"}}');
  assert.deepEqual(changesIn(root), { sdk: false, tag: false }, "installed is not the change");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "app.ts"), 'import { cortad } from "@cortad/sdk";\n');
  assert.deepEqual(changesIn(root), { sdk: true, tag: false });
  writeFileSync(join(root, "web", "index.html"), '<script src="https://b.cortad.com/i/cortad.js" data-key="ct_pub_x" async></script>\n');
  assert.deepEqual(changesIn(root), { sdk: true, tag: true });

  const py = repo();
  writeFileSync(join(py, "main.py"), "import os\nfrom cortad import cortad\n");
  assert.equal(changesIn(py).sdk, true);
  writeFileSync(join(py, "main.py"), "import cortadx\n");
  assert.equal(changesIn(py).sdk, false);
  assert.deepEqual(changesIn(mkdtempSync(join(tmpdir(), "cortad-nogit-"))), { sdk: false, tag: false });
});

test("the history tool is named by which keys the env has, never by their values", () => {
  assert.deepEqual(sourcesIn({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", HELICONE_API_KEY: "" }).map((s) => s.id), ["langfuse"]);
  assert.deepEqual(sourcesIn({ LANGFUSE_PUBLIC_KEY: "pk" }), [], "half a pair is not a source");
});

test("a report goes with the machine key, carries what it is given, and never throws", async () => {
  const sent = [];
  const ok = await report({ apiBase: "https://cortad.test/api", token: "ct_mcp_k", fetchImpl: async (url, init) => { sent.push({ url, init }); return { ok: true }; } }, { found: ["langfuse"] });
  assert.equal(ok, true);
  assert.equal(sent[0].url, "https://cortad.test/api/mcp/setup/live");
  assert.equal(sent[0].init.headers.authorization, "Bearer ct_mcp_k");
  assert.deepEqual(JSON.parse(sent[0].init.body), { found: ["langfuse"] });
  assert.equal(await report({ apiBase: "x", token: null, fetchImpl: async () => { throw new Error("must not be called"); } }, {}), false);
  assert.equal(await report({ apiBase: "x", token: "k", fetchImpl: async () => { throw new Error("down"); } }, {}), false);
});

test("history is held to the messages asked for, newest whole conversations first", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  const conv = (id, replies, agoHours) => ({ id, messages: Array.from({ length: replies * 2 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `m${i}`, at: new Date(now - agoHours * 3_600_000 + i * 1000).toISOString() })) });
  const picked = selected([conv("a", 40, 1), conv("b", 40, 2), conv("c", 10, 3)], { now, key: "ct_ing_k", cap: 50 });
  assert.equal(picked.messages, 50, "40 then 10: the second 40 would pass 50");
  assert.equal(picked.left["past 50 messages"], 1);
});

test("without a source named, the agent runs the one command that takes the app's own database, still held to the number asked", () => {
  const text = askedText({ messages: 500, source: null }, "cortad");
  assert.match(text, /intelligence history --messages 500: /);
  assert.doesNotMatch(text, /--stdin|script/);
  assert.doesNotMatch(text, /conversation/i);
});

// The agent took the card's choice as Cortad's own message and asked the person again (2026-11-13).
test("the card's choice is handed over as the person's, with when they made it", () => {
  const at = "2026-11-13T08:46:00Z";
  const clock = new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  assert.ok(askedText({ messages: 500, source: null, askedAt: at }, "cortad").startsWith(`The person chose on the setup card at ${clock} to send their users' newest 500 messages to Cortad.`));
  assert.ok(askedText({ messages: 500, source: null }, "cortad").startsWith("The person chose on the setup card to send"));
});

// Orders against checking with the person read as a tool talking the agent out of it (2026-11-13).
// The relay asked about the code change and then `intelligence` printed its own ask (2026-11-13): the
// one question is the one printed with the change.
test("the relayed choice says facts and leaves the one question about the code change to the change itself", () => {
  const text = askedText({ messages: 500, source: "langfuse", askedAt: "2026-11-13T08:46:00Z" }, "cortad");
  assert.doesNotMatch(text, /do not|don't|advise against/i);
  assert.match(text, /Those messages keep their simulated users true to their real ones\./);
  assert.match(text, /\n3\. npx -y cortad intelligence again: it prints the change that adds Cortad to this backend and the one question about it, with its options, yes first\. Ask the person that question once, as printed, /);
  assert.doesNotMatch(text, /"[^"]*\?"/, "the relay quotes no question of its own");
  assert.ok(text.indexOf("1. ") < text.indexOf("2. ") && text.indexOf("2. ") < text.indexOf("3. "));
});

// On a local stack the steps the card hands over went to cortad.com: every one says where Cortad is.
test("the steps handed through wait carry the Cortad this command talks to, and none where it is cortad.com", () => {
  const local = askedText({ messages: 500, source: "langfuse" }, "@cortad/connector@0.6.2", "http://localhost:8914");
  const commands = local.match(/npx -y [^\s:]+/g);
  assert.equal(commands.length, local.match(/CORTAD_ORIGIN=http:\/\/localhost:8914 npx -y /g).length, local);
  assert.ok(commands.length >= 4);
  assert.doesNotMatch(askedText({ messages: 500, source: "langfuse" }, "cortad"), /CORTAD_ORIGIN/);
});
