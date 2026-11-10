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

test("without a source named, the agent is pointed at the export, still held to the number asked", () => {
  const text = askedText({ messages: 500, source: null }, "cortad");
  assert.match(text, /history --stdin --messages 500/);
  assert.doesNotMatch(text, /conversation/i);
});
