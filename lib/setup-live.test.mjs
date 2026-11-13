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
import { clock } from "./words.mjs";

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

test("history is held to the users' messages asked for, newest whole conversations first", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  const conv = (id, asks, agoHours) => ({ id, messages: Array.from({ length: asks * 2 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `m${i}`, at: new Date(now - agoHours * 3_600_000 + i * 1000).toISOString() })) });
  const picked = selected([conv("a", 40, 1), conv("b", 40, 2), conv("c", 10, 3)], { now, salt: "5".repeat(64), cap: 50 });
  assert.equal(picked.messages, 50, "40 then 10: the second 40 would pass 50");
  assert.equal(picked.left["past the 50 asked for"], 1);
});

// The agent could not tell whether the person had pressed anything, and read "ask once, as printed"
// as a tool steering it (2026-11-13): the choice is a fact it can check, then one question to confirm.
test("the card's choice is handed over as who chose what, where and when, then one question to confirm and the command a yes runs", () => {
  const at = "2026-11-13T16:34:00Z";
  const text = askedText({ messages: 500, source: null, askedAt: at, askedBy: "owner@shop.example" }, "cortad@2.0.5");
  assert.deepEqual(text.split("\n"), [
    `You chose on the setup card at ${clock(at)}, signed in as owner@shop.example: send your users' newest 500 messages to Cortad.`,
    `To confirm with the person: "Send your users' newest 500 messages to Cortad now?" Yes, send them / Not now`,
    "next: npx -y cortad@2.0.5 intelligence history --messages 500",
  ]);
  const langfuse = askedText({ messages: 1000, source: "langfuse", askedAt: at, askedBy: "owner@shop.example" }, "cortad");
  assert.match(langfuse, /: send your users' newest 1,000 messages to Cortad, from Langfuse\.\n/);
  assert.equal(langfuse.split("\n").at(-1), "next: npx -y cortad intelligence history --from langfuse --messages 1000");
  assert.ok(askedText({ messages: 500, source: null }, "cortad").startsWith("You chose on the setup card: send"));
});

test("the relay orders nothing: no steps, no telling the agent the person already answered, no telling it how to ask", () => {
  const text = askedText({ messages: 2500, source: "langfuse", askedAt: "2026-11-13T08:46:00Z", askedBy: "owner@shop.example" }, "cortad");
  assert.doesNotMatch(text, /\b(?:do not|don't|ask (?:the person )?once|as printed|already answered|just answered|then start|run the command)\b|^\d\. /im);
  assert.equal(text.match(/^next: /gm).length, 1);
  assert.doesNotMatch(text, /\u2014|\breads?\b|\brun\b/);
});

// On a local stack the steps the card hands over went to cortad.com: every one says where Cortad is.
test("the steps handed through wait carry the Cortad this command talks to, and none where it is cortad.com", () => {
  const local = askedText({ messages: 500, source: "langfuse" }, "@cortad/connector@0.6.2", "http://localhost:8914");
  const commands = local.match(/npx -y [^\s:]+/g);
  assert.equal(commands.length, local.match(/CORTAD_ORIGIN=http:\/\/localhost:8914 npx -y /g).length, local);
  assert.ok(commands.length >= 1);
  assert.doesNotMatch(askedText({ messages: 500, source: "langfuse" }, "cortad"), /CORTAD_ORIGIN/);
});
