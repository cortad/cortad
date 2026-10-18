import assert from "node:assert/strict";
import { test } from "node:test";
import { CONNECTED, connectedText, machineText, NOT_RUNNING, readLines, SHOW, showText } from "./read-text.mjs";
import { PAGE_CHARS } from "./words.mjs";

test("a full list pages under the size Copilot keeps, names the next page, and carries every item once", () => {
  const all = Array.from({ length: 120 }, (_, i) => ({ text: `Rule ${i + 1}: ${"keep the reply to what the product states ".repeat(3)}`, path: `src/prompts/p${i % 7}.ts`, line: i + 1 }));
  const d = { read: { rules: { count: 120, files: 7, all } } };
  const first = showText(d, "rules");
  const pages = Number(first.match(/\npage 1 of (\d+), call status with show rules and page 2$/)?.[1]);
  assert.ok(pages > 1);
  const every = Array.from({ length: pages }, (_, i) => showText(d, "rules", i + 1));
  for (const page of every) assert.ok(page.length < PAGE_CHARS, `a page is ${page.length} characters`);
  assert.match(first, /^Rules in the code: 120, in 7 files\.\n  src\/prompts\/p0\.ts:1  "Rule 1: /);
  assert.match(every[1], /^Rules in the code, continued\.\n  /);
  assert.match(every.at(-1), new RegExp(`\\npage ${pages} of ${pages}$`));
  const seen = every.join("\n").match(/"Rule \d+:/g);
  assert.equal(new Set(seen).size, 120);
  assert.equal(seen.length, 120);
});

test("from an API that sent only part of a section, the part is listed and says so", () => {
  const d = { read: { rules: { count: 16, files: 5, examples: [{ text: "Cite the lesson.", path: "a.ts", line: 8 }] }, machine: { decided: 38, met: 2, missed: 36, misses: [{ standard: "The model call has a timeout", detail: "no timeout", path: "c.ts", line: 9, decidedBy: "code" }], mets: [{ standard: "Keys stay out of the code", path: "k.ts", line: 1, decidedBy: "reader" }, { standard: "Retries back off" }] } } };
  assert.equal(showText(d, "rules"), "Rules in the code: 16, in 5 files. 1 of 16 listed.\n  a.ts:8  \"Cite the lesson.\"");
  assert.equal(showText(d, "standards"), [
    "Engineering standards: your code misses 36 of the 38 Cortad checks.",
    "Missed (36), 1 listed:",
    "  c.ts:9  The model call has a timeout: no timeout (decided by code)",
    "Met (2):",
    "  k.ts:1  Keys stay out of the code (decided by a model)",
    "  Retries back off",
  ].join("\n"));
  assert.equal(showText({ read: { machine: { decided: 28, met: 28, missed: 0, problems: 0, misses: [], mets: [] } } }, "standards"), "Engineering standards: your code meets all 28 that Cortad checks.");
});

test("journeys, endpoints and trials read one line each, in the walkthrough's words", () => {
  const read = {
    journeys: { count: 2, all: [{ name: "billing question", steps: ["asks about a refund", "asks for a person"] }, { name: "first lesson", steps: [] }] },
    doors: { count: 1, all: [{ name: "Chat", method: "POST", path: "/api/chat" }] },
    trials: { written: 58, playable: 51, all: [{ surface: "Chat", written: 51, playable: 51, held: 0 }, { surface: "Upload", written: 7, playable: 0, held: 7, why: "the route needs a signed file URL", side: "theirs" }] },
  };
  assert.equal(showText({ read }, "journeys"), "Journeys (2):\n  billing question: asks about a refund; asks for a person\n  first lesson");
  assert.equal(showText({ read }, "endpoints"), "Endpoints (1):\n  Chat: POST /api/chat");
  assert.equal(showText({ read }, "trials"), "Conversations: 58 written.\n  Chat: 51 written, 51 playable\n  Upload: 7 written, 0 playable, 7 set aside, on the app's side: the route needs a signed file URL");
  assert.equal(showText({}, "rules"), "Cortad is still reading this repository.");
  // ulaim's agent got a bare "Endpoints (0):" while the code was still being read.
  assert.equal(showText({ read: { complete: false, doors: { count: 0, names: [], all: [] } } }, "endpoints"), "Cortad is still reading this repository.");
  assert.equal(showText({ read: { doors: { count: 0, names: [], all: [] } } }, "endpoints"), "Endpoints: none yet.");
  assert.deepEqual(SHOW, ["rules", "standards", "journeys", "endpoints", "trials", "records", "reviews", "machine"]);
  // A name may hold commas, so names end at a semicolon.
  assert.ok(readLines({ journeys: { count: 5, names: ["billing question", "a student, grade 10"] } }).includes("Journeys (5): billing question; a student, grade 10; and 3 more."));
});

// bloom's agent read thirty misses as thirty problems, flowviz's was told eight and shown fourteen,
// and two agents read a rule list that said nothing about the rules.
test("a miss is one problem with the standards it fails, and a rule says what the run found", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const read = {
    rules: { count: 3, all: [
      { text: "Cite the lesson.", path: "p.js", line: 2, measured: { asked: 30, held: 21 } },
      { text: "Copy each excerpt.", path: "p.js", line: 204, measured: null },
      { text: "Stay kind.", path: "", line: 0, measured: { asked: 4, held: 4 } },
    ] },
    machine: { decided: 12, met: 2, missed: 10, problems: 2, misses: [
      { problem: "Every route is public", path: "app/routes.py", line: 697, decidedBy: "code", standards: ["Every door behind auth", "Per-user rate limit"] },
      { problem: "shipping layer: No CI test job exists.", path: "", line: 0, decidedBy: "reader", standards: ["CI runs tests"] },
    ] },
  };
  const dir = mkdtempSync(join(tmpdir(), "cortad-at-"));
  writeFileSync(join(dir, "p.js"), "a\nb\nc\n");
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, "app", "routes.py"), "x\n".repeat(800));
  const was = process.cwd();
  process.chdir(dir);
  try {
    assert.equal(showText({ read }, "rules"), [
      "Rules in the code: 3.",
      "  p.js:2  \"Cite the lesson.\"; asked of 30 replies, passed in 21, broke in 9",
      "  p.js  \"Copy each excerpt.\"; asked of no reply yet",
      "  \"Stay kind.\"; asked of 4 replies, passed in 4",
    ].join("\n"));
    assert.equal(showText({ read }, "standards"), [
      "Engineering standards: your code misses 10 of the 12 Cortad checks, through 2 problems.",
      "Problems (2):",
      "  app/routes.py:697  Every route is public (decided by code)",
      "    Fails 2: Every door behind auth; Per-user rate limit",
      "  shipping layer: No CI test job exists. (decided by a model)",
      "    Fails: CI runs tests",
    ].join("\n"));
  } finally {
    process.chdir(was);
  }
});

// resumeforge's SECURITY.md says it is a local single-user tool: the problem it waives says so, with
// the line, and the server lists it last.
test("a problem their own document waives says so beneath it, with the line", () => {
  const read = { machine: { decided: 3, met: 1, missed: 2, problems: 2, misses: [
    { problem: "Length-truncated replies saved as complete", path: "", line: 0, decidedBy: "code", standards: ["Finish-reason honesty"] },
    { problem: "Model-spending routes have no access check", path: "", line: 0, decidedBy: "reader", standards: ["Every door behind auth"], byDesign: { at: "SECURITY.md:3", said: "ResumeForge 是面向个人、本地运行的单用户工具。" } },
  ] } };
  assert.equal(showText({ read }, "standards"), [
    "Engineering standards: your code misses 2 of the 3 Cortad checks, through 2 problems.",
    "Problems (2):",
    "  Length-truncated replies saved as complete (decided by code)",
    "    Fails: Finish-reason honesty",
    "  Model-spending routes have no access check (decided by a model)",
    "    Fails: Every door behind auth",
    "    By design here, per SECURITY.md:3: \"ResumeForge 是面向个人、本地运行的单用户工具。\"",
  ].join("\n"));
});

// ulaim's walkthrough carried 45 ids in one line: the records are listed with show records alone.
test("show records lists the records the trials can name, three of each, and the walkthrough names none", () => {
  const records = { collections: [{ name: "orders", from: "backend/data/orders.json", examples: ["SO20260810001", "SO20260805002", "SO20260812003", "SO20260801004"] }, { name: "tickets", examples: ["TK4A3C1342E0"] }] };
  assert.equal(showText({ read: { records } }, "records"), "Records a conversation can name, three of each:\n  orders: SO20260810001, SO20260805002, SO20260812003\n  tickets: TK4A3C1342E0");
  assert.ok(!readLines({ records }).some((l) => l.startsWith("Records")));
});

test("show reviews lists the two reviews whole, and before the read is done says when they come", () => {
  const reviews = { lines: ["Your prompts: 1 problem.", "  src/prompt.ts:12  Two instructions disagree on how long a reply is.", "The code around your model: 1 problem.", "  src/chat.ts:40  The model call has no timeout."] };
  assert.equal(showText({ read: { reviews } }, "reviews"), ["The reviews of your prompts and of the code around your model:", ...reviews.lines].join("\n"));
  assert.equal(showText({ read: { complete: false } }, "reviews"), "The reviews of your prompts and of the code around your model:\nYour code is still being read; the reviews come when that is done.");
  assert.ok(readLines({ reviews }).includes("The reviews of your prompts and of the code around your model are listed whole by status with show reviews."));
  assert.ok(!readLines({}).some((l) => l.includes("reviews")));
});

test("a problem with a fix says it on its own line, above the standards it fails", () => {
  const read = { machine: { decided: 4, met: 3, missed: 1, problems: 1, misses: [
    { problem: "The OpenAI client is created with no timeout", path: "", line: 0, decidedBy: "code", fix: "Pass a timeout of 30 seconds to the OpenAI client.", standards: ["The model call has a timeout"] },
  ] } };
  assert.equal(showText({ read }, "standards"), [
    "Engineering standards: your code misses 1 of the 4 Cortad checks, through 1 problem.",
    "Problems (1):",
    "  The OpenAI client is created with no timeout (decided by code)",
    "    Pass a timeout of 30 seconds to the OpenAI client.",
    "    Fails: The model call has a timeout",
  ].join("\n"));
});

// "Asked of no reply yet" beside each rule before any run said nothing about the rule.
test("before a run, the walkthrough lists a rule without what no run has found", () => {
  const rules = { count: 1, examples: [{ text: "Copy each excerpt.", path: "", line: 0, measured: null }] };
  assert.deepEqual(readLines({ rules }), ["What Cortad read:", "Rules in the code: 1. 1 of them:", '  "Copy each excerpt."']);
});

test("a review that decided nothing makes no claim about the standards, and no reviews are told apart from none sent", () => {
  const none = readLines({ complete: true, rules: { count: 4, files: 1, examples: [] }, machine: { decided: 0, met: 0, missed: 0, problems: 0, misses: [] } });
  assert.ok(!none.some((l) => /Engineering standards/.test(l)), none.join("\n"));
  assert.equal(showText({ read: { machine: { decided: 0, met: 0, missed: 0, misses: [] } } }, "standards").split("\n")[0], "Engineering standards: none yet.");
  assert.match(showText({ read: { complete: true, reviews: { lines: [] } } }, "reviews"), /Reading your code left no review of this app's prompts or code\.$/);
  assert.match(showText({ read: { complete: true } }, "reviews"), /This status carries no reviews\.$/);
  assert.equal(showText({ read: { records: { collections: [] } } }, "records"), "Reading your code found no records a conversation can name.");
});

// Where Cortad's team reviewed the code by hand, status sends no grade against the standards: only
// that the code review is the team's, and the lines it cites.
test("where the code review shown is the Cortad team's, the standards say so in one sentence and the walkthrough grades nothing", () => {
  const read = { complete: true, machine: { reviewed: true, cited: [{ path: "apps/api/src/routes/agent.ts", line: 216 }] },
    reviews: { lines: ["The Cortad team reviewed the code around your model by hand. 1 problem from that review is in your code as it is now:", "  apps/api/src/routes/agent.ts:216  The dashboard chat takes message text of any length."] } };
  assert.equal(showText({ read }, "standards"), "The Cortad team reviewed the code around your model by hand instead of grading it against these standards, and status with show reviews lists what it found.");
  const walk = readLines(read);
  assert.ok(!walk.some((l) => /Engineering standards|Cortad checks|none yet/.test(l)), walk.join("\n"));
  assert.ok(walk.includes("The reviews of your prompts and of the code around your model are listed whole by status with show reviews."));
});

// Databuddy's agent could not say what the connect command started, held, copied or wrote outside
// the repository: the command said three of a dozen things.
test("what Cortad does on this machine is at most seven short lines, and the terminal says only the first", () => {
  const facts = { cmd: "npm run dev", dir: "apps/api", port: 3001, started: true, hooked: true, proxy: null, changed: ["DATABASE_URL", "REDIS_URL"], copies: "made", clients: ["Claude Code", "Codex", "Cursor", "Copilot"] };
  const started = machineText(facts);
  const attached = machineText({ cmd: null, dir: ".", port: 3000, started: false, hooked: false, proxy: null, changed: [], copies: "none", clients: [] });
  for (const lines of [started, attached]) {
    assert.ok(lines.length <= 7, `${lines.length} lines`);
    assert.equal(lines.some((l) => /For the person|upload|\u2014| \u00b7 /.test(l)), false);
  }
  assert.equal(started[0], "Cortad started your app in apps/api and stops it when this command stops. Your code and settings files are never edited.");
  assert.deepEqual(connectedText(facts), [started[0]], "the terminal says the one line the person needs; the rest is read on request");
  assert.equal(started[1], "Your env values stay on this machine, with DATABASE_URL and REDIS_URL set for this session only. None is sent to Cortad.");
  assert.equal(started.some((l) => /copy of your database/.test(l)), false, "nothing is copied, so nothing says so");
  assert.match(started.join("\n"), /a host you allowed on the card\. A call that only reads goes out\.\nFiles your app writes in its own folder during a run are put back when the run ends\./);
  assert.equal(started.some((l) => l.includes("~/.claude.json")), false, "the connect command says once where the agents learned of Cortad");
  assert.match(started.at(-1), /^Kept in ~\/\.cortad on this machine between connects: /);
  assert.equal(attached[0], "Cortad uses your app already running on port 3000 and leaves it running. Your code and settings files are never edited.");
  assert.equal(attached.some((l) => /copy of your database/.test(l)), false, "no copy made is not a sentence: each store says its own in status");
  assert.ok(attached.includes("During a run, what your app sends to an outside service, such as a payment or an email, is sent for real."));
  assert.deepEqual(machineText(null), ["No connect command is running for this repository now, so nothing Cortad started is running here."]);
});

// A trial customer read the failure as the ready signal and waited on an app that was not there:
// both lines sent him back to the browser and ended on Ctrl-C, and he worked through a coding agent
// and never had a browser open at all.
test("the last line of a connect and the last line of a failed start cannot be read for each other, and send nobody to a browser", () => {
  assert.match(CONNECTED, /^connected: /);
  assert.match(NOT_RUNNING, /^your app is not running, /);
  for (const line of [CONNECTED, NOT_RUNNING]) {
    assert.doesNotMatch(line, /browser/, "a terminal and a coding agent are the whole session");
    assert.doesNotMatch(line, /\u2014|soon|usually|please/);
    assert.ok(line.length < 200, `${line.length} characters`);
  }
  const clauses = (line) => line.split(/[.;]/).map((c) => c.trim().toLowerCase()).filter(Boolean);
  assert.equal(clauses(CONNECTED).filter((c) => clauses(NOT_RUNNING).includes(c)).join(" | "), "", "no clause stands in both lines");
  // What each one leaves the reader knowing: connected and what to do next, or stopped and whose it is.
  assert.match(CONNECTED, /coding agent/);
  assert.match(CONNECTED, /Ctrl-C disconnects/);
  assert.match(NOT_RUNNING, /nothing to test/);
  assert.match(NOT_RUNNING, /not from Cortad/);
});
