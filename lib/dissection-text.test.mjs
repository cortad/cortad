import assert from "node:assert/strict";
import { test } from "node:test";
import { dissectionLines } from "./dissection-text.mjs";

// The app was started before the read's list of tools reached it: a tool that ran was not seen, and
// "0 of 8 ran" told the person their tools went untested.
test("tools that were not recorded are said so, never counted as never run", () => {
  const run = { id: "r1", played: 3, planned: 3 };
  const said = (tools) => dissectionLines({ run, tools }).join("\n");
  assert.match(said({ offered: 8, ran: 0, neverRan: ["a"], recorded: false }), /Calls to the 8 tools your app offers its model were not recorded in this run\./);
  assert.doesNotMatch(said({ offered: 8, ran: 0, neverRan: ["a"], recorded: false }), /ran/);
  const part = { id: "F1", asks: "Book a lesson", reach: "3 of 10", neverRan: ["book_lesson"] };
  const parts = (tools) => dissectionLines({ run, tools, runOnly: [part] }).join("\n");
  assert.doesNotMatch(parts({ offered: 8, ran: 0, neverRan: [], recorded: false }), /never run/, "no finding says a tool never ran either");
  assert.match(parts({ offered: 8, ran: 2, neverRan: [] }), /Needed by these asks and never run: book_lesson\./);
  assert.match(said({ offered: 4, ran: 3, neverRan: ["open_ticket"] }), /3 of 4 tools your app offers its model ran; never ran: open_ticket\./);
});

// A tool whose function the hook did not wrap, and that no model call named, was said never to have
// run, and no tool to have run behind a reply that confirmed what that tool made (2026-11-02).
test("tools whose calls were not seen are named apart, and no finding says a tool never ran or that none ran while one of them could have", () => {
  const run = { id: "r1", played: 3, planned: 3 };
  const part = { id: "finding:3", asks: "Does the reply give the person what they asked for?", reach: "failed in 4 of 9 conversations", tools: [], neverRan: ["make_cards", "draw_graph"] };
  const lines = (tools) => dissectionLines({ run, tools, runOnly: [part] });
  const partly = lines({ offered: 8, ran: 1, neverRan: ["draw_graph", "make_cards"], unwatched: ["make_cards", "search_pages"] });
  assert.deepEqual(partly.slice(0, 2), ["1 of 8 tools your app offers its model ran; never ran: draw_graph.", "Calls to 2 tools were not recorded in this run: make_cards, search_pages."]);
  assert.ok(!partly.some((l) => /Tools that ran behind these replies/.test(l)), "none is not said while a tool whose calls were not seen could have run");
  assert.ok(partly.includes("  Needed by these asks and never run: draw_graph."));
  const seen = lines({ offered: 8, ran: 1, neverRan: ["draw_graph", "make_cards"] });
  assert.ok(seen.includes("  Tools that ran behind these replies: none."), "with every tool's calls seen, none is said");
  assert.ok(seen.includes("  Needed by these asks and never run: make_cards, draw_graph."));
  assert.ok(!seen.some((l) => /not recorded/.test(l)));
  assert.ok(lines({ offered: 8, ran: 0, neverRan: [], recorded: false }).every((l) => !/Tools that ran behind/.test(l)), "nor when no tool's calls were recorded");
});
