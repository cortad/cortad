import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { numbersText } from "./numbers-text.mjs";
import { PAGE_CHARS } from "./words.mjs";

// What the server handed the agent for a recorded run of 40 trials on a chat app, its outcomes re-read
// on the Field's classes: every number `findings numbers` pages.
const fixture = JSON.parse(readFileSync(new URL("./numbers-fixture.json", import.meta.url), "utf8"));

test("every number comes in pages under what a client keeps, each table once, and the last page names no next call", () => {
  const first = numbersText(fixture, 1);
  const pages = Number(first.match(/page 1 of (\d+), call findings numbers with page 2$/)?.[1]);
  assert.ok(pages >= 2);
  const all = Array.from({ length: pages }, (_, i) => numbersText(fixture, i + 1));
  for (const page of all) assert.ok(page.length < PAGE_CHARS, `a page is ${page.length} characters`);
  assert.match(all.at(-1), new RegExp(`page ${pages} of ${pages}$`));
  const text = all.join("\n");
  for (const t of [...fixture.numbers.measures, ...fixture.numbers.questions]) assert.equal(text.split(`\n${t.kind === "question" ? `${t.id}  ` : ""}${t.title}`).length - 1, 1, t.id);
  assert.match(first, /^Run c44c7d43-3e29-49ef-9772-e6d8d9439c4c: every number it measured, 6 measurements and 7 questions over 40 conversations, 108 replies and 1,249 checks\./);
});

test("each table says how its rows read, one row per group, and the exchange behind its worst group", () => {
  const text = Array.from({ length: 3 }, (_, i) => numbersText(fixture, i + 1)).join("\n");
  assert.match(text, /\n  Counted as: resolved, partial, deflected, unresolved of conversations; then how many ended deflected or unresolved, with the 95% interval\.\n  All: 13, 21, 4, 2 of 40 conversations; 6, 7% to 29%\n/);
  assert.match(text, /\n  By reply:\n    reply 1: [\d, ]+ of 40 conversations; /);
  assert.match(text, /\nholds-the-thread  .+\n  Counted as: the conversations it broke in, of the conversations that asked it, with the 95% interval\.\n  All: \d+ of \d+ conversations, \d+% to \d+%/);
  assert.match(text, /\n  Worst: place where a tool ran \(src\/app\/api\/parse-pdf\/route\.ts\)\. Conversation [\w-]+, reply \d\.\n    Sent: "/);
  assert.equal(numbersText({ why: "No run has finished on this repository yet." }), "No run has finished on this repository yet.");
});
