import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeCapture } from "./replay.mjs";

// One customer's run made more model calls than the rows the meter keeps, and the total it reported was
// summed from the kept rows alone: the spend of every call before them was lost.
test("what the app spent counts every call since it started, past the rows the report keeps", () => {
  const dir = mkdtempSync(join(tmpdir(), "meter-"));
  const call = (i) => ({ call: { at: i, host: "api.fireworks.ai", model: "glm-5p3", status: 200, usage: true, promptTokens: 25_000, cachedTokens: 24_800, completionTokens: 90 } });
  const lines = [{ hello: true, pid: 1 }, ...Array.from({ length: 7_000 }, (_, i) => call(i + 1)), { call: { at: 9e6, host: "api.fireworks.ai", model: "glm-5p3", status: 200 } }];
  writeFileSync(join(dir, "trace.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const [total] = makeCapture({ work: dir, keepSecret: () => {} }).usage().totals;
  assert.deepEqual(total, { host: "api.fireworks.ai", model: "glm-5p3", calls: 7_001, promptTokens: 175_000_000, cachedTokens: 173_600_000, completionTokens: 630_000, unmetered: 1 });
});

// Anthropic's OpenAI compatible stream sends no counts: every call of ulaim's run went unpriced and the
// run cap counted nothing. Such a call is counted from its words and said as estimated.
test("a reply with no counts is counted from the request and reply text, as an estimate", async () => {
  const { makeRecorder } = await import("./wire.cjs");
  const rows = [];
  const rec = makeRecorder({ row: (r) => rows.push(r) });
  const sent = JSON.stringify({ model: "claude-haiku-5-5", stream: true, messages: [{ role: "user", content: "x".repeat(400) }] });
  const body = ["data: " + JSON.stringify({ model: "claude-haiku-5-5", choices: [{ delta: { content: "y".repeat(80) } }] }), "data: [DONE]", ""].join("\n");
  rec.meter({ host: "api.anthropic.com", path: "/v1/chat/completions", sent, status: 200, type: "text/event-stream", body, t0: Date.now() });
  const call = rows.find((r) => r.call)?.call;
  assert.deepEqual([call.promptTokens, call.completionTokens, call.estimated, call.usage], [Math.ceil(sent.length / 4), 20, true, false]);
  const dir = mkdtempSync(join(tmpdir(), "meter-"));
  writeFileSync(join(dir, "trace.jsonl"), [{ hello: true, pid: 1 }, { call }].map((l) => JSON.stringify(l)).join("\n") + "\n");
  const total = makeCapture({ work: dir, keepSecret: () => {} }).usage().totals.find((t) => t.host === "api.anthropic.com");
  assert.equal(total.unmetered, 0, "an estimated call is priced, not left unmetered");
  assert.equal(total.estimated, 1);
});

// "env PORT=3101 npm run dev" was judged a program called env, and the app was watched from outside.
test("a start command is judged by the program it runs, past env, exec and settings in front of it", async () => {
  const { hookable } = await import("./start.mjs");
  for (const cmd of ["npm run dev", "PORT=3101 npm run dev", "env PORT=3101 npm run dev", "env -i PATH=/bin node app.js", "exec python app.py", "'/usr/bin/python3' app.py"]) assert.equal(hookable("/nowhere", cmd), true, cmd);
  for (const cmd of ["docker compose up", "env PORT=1 ./server", "go run ."]) assert.equal(hookable("/nowhere", cmd), false, cmd);
});

// One customer's report was 2.9 MB, past the 2 MiB a command's answer may be: every row carried the
// passages its call was handed. The spend alone is a few hundred bytes, and a turn's passages ride on
// that turn's rows only.
test("the meter's spend read is small however much the app read, and passages ride on their own turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "meter-"));
  const passages = Array.from({ length: 6 }, (_, i) => ({ text: `passage ${i} `.repeat(400) }));
  const call = (i) => ({ call: { at: i, host: "api.fireworks.ai", model: "glm-5p3", status: 200, usage: true, promptTokens: 30_000, completionTokens: 90, turn: `case_${i}:1`, passages } });
  writeFileSync(join(dir, "trace.jsonl"), [{ hello: true, pid: 1 }, ...Array.from({ length: 500 }, (_, i) => call(i))].map((l) => JSON.stringify(l)).join("\n") + "\n");
  const capture = makeCapture({ work: dir, keepSecret: () => {} });
  const spend = capture.usage(undefined, true);
  assert.deepEqual(Object.keys(spend), ["totals"]);
  assert.ok(JSON.stringify(spend).length < 1_000);
  assert.ok(JSON.stringify(capture.usage()).length < 1_000_000, "a report for no turn carries no passages");
  const turn = capture.usage("case_499:1");
  assert.equal(turn.rows.filter((r) => r.passages).length, 1, "only the asked turn's call carries what it was handed");
});
