import assert from "node:assert/strict";
import { test } from "node:test";
import { DOORS, RETIRED, VERB_NAMES, doorNext, makeDoors, movedTo } from "./doors.mjs";

// Which verb each door opens, and with what. A door is routing and words: a run started through
// `test` has to be the same run the shell face starts, priced and refused the same way, so what is
// checked here is that every door reaches the function it always reached, with the arguments it
// always took.

// Records every verb a door calls. A verb a test does not list answers with its own name.
function verbsOf(answers = {}) {
  const asked = [];
  const verbs = Object.fromEntries(VERB_NAMES.map((name) => [name, async (args) => {
    asked.push([name, args]);
    return answers[name] ?? { text: name, data: {} };
  }]));
  return { verbs, asked };
}

// What the read says of the latest run, as the server answers it.
const read = (run, news) => ({ status: { text: "read", data: { ...(run ? { run: { jobId: "r-1", ...run } } : {}), ...(news ? { news } : {}) } } });
const playing = { finished: false, status: "running" };
const over = { finished: true, status: "succeeded" };

test("status with nothing asked for opens the thing to act on: a playing run, a finished run's failures, or the repository", async () => {
  for (const [why, answers, want] of [
    ["a run still playing is the run", read(playing), "run_status"],
    ["a finished run with failures is its failures", read({ ...over, findings: 3 }), "findings"],
    ["a verify is read as a verify, whatever it found", read({ ...over, verify: { verdict: "gone" } }), "run_status"],
  ]) {
    const { verbs, asked } = verbsOf(answers);
    await makeDoors(verbs).status({});
    assert.deepEqual(asked.map(([name]) => name), ["status", want], why);
  }
  // A clean run, and a repository with no run at all, are both the read itself and nothing more.
  for (const answers of [read({ ...over, findings: 0 }), read(null)]) {
    const { verbs, asked } = verbsOf(answers);
    const out = await makeDoors(verbs).status({});
    assert.deepEqual(asked.map(([name]) => name), ["status"]);
    assert.equal(out.text, "read");
  }
});

// The read is the one call that takes what the server kept to say while no agent was listening. It
// is taken once, so an answer that comes from another lane has to carry it.
test("with no run to act on, a live app that is failing its people is what status opens", async () => {
  const failing = (run) => { const r = read(run, ["Your read is ready."]); r.status.data.field = { connected: true, problems: 2 }; return r; };
  for (const run of [null, { ...over, findings: 0 }]) {
    const { verbs, asked } = verbsOf({ ...failing(run), intelligence: { text: "1. Exceeds three sentences", data: {} }, incidents: { text: "Nothing has got worse.", data: {} } });
    const out = await makeDoors(verbs).status({});
    assert.deepEqual(asked.map(([name]) => name), ["status", "intelligence", "incidents"]);
    assert.equal(out.text, "New since your last call:\n  Your read is ready.\n1. Exceeds three sentences\nNothing has got worse.");
  }
  // A run still playing, or one with failures, is still what the agent is standing in front of.
  for (const [run, want] of [[playing, "run_status"], [{ ...over, findings: 3 }, "findings"]]) {
    const { verbs, asked } = verbsOf(failing(run));
    await makeDoors(verbs).status({});
    assert.deepEqual(asked.map(([name]) => name), ["status", want]);
  }
});

test("what the server kept to say rides along when status hands over another lane's answer", async () => {
  const { verbs } = verbsOf({ ...read({ finished: true, status: "succeeded", findings: 2 }, ["Run 55ee432b finished after 10 conversations."]), findings: { text: "finding:1 broke in 3 of 10.", data: {} } });
  const out = await makeDoors(verbs).status({});
  assert.equal(out.text, "New since your last call:\n  Run 55ee432b finished after 10 conversations.\nfinding:1 broke in 3 of 10.");
});

test("each lane of status opens the one verb it is, and a lane-only parameter names its lane on its own", async () => {
  const ask = { table: "events", from: "2026-10-01T00:00:00Z", to: "2026-10-18T00:00:00Z", measures: [{ fn: "count" }] };
  for (const [args, want] of [
    [{ about: "repository", show: "rules", page: 2 }, ["status", { show: "rules", page: 2 }]],
    [{ about: "run", id: "r-9" }, ["run_status", { jobId: "r-9" }]],
    [{ about: "run" }, ["run_status", {}]],
    [{ about: "findings", id: "r-9", show: "numbers", page: 3 }, ["findings", { jobId: "r-9", show: "numbers", page: 3 }]],
    [{ about: "outcomes" }, ["outcomes", {}]],
    [{ about: "warehouse", ask }, ["query", ask]],
    // No lane named, but a parameter that belongs to one.
    [{ show: "endpoints" }, ["status", { show: "endpoints" }]],
    [{ id: "r-9" }, ["run_status", { jobId: "r-9" }]],
    [{ jobId: "r-9" }, ["run_status", { jobId: "r-9" }], "the name the retired tools used still works"],
    [{ ask }, ["query", ask]],
  ]) {
    const { verbs, asked } = verbsOf();
    await makeDoors(verbs).status(args);
    assert.deepEqual(asked, [want], JSON.stringify(args));
  }
});

test("a world's id reads as a world once the run it is not says there is no such run", async () => {
  const { verbs, asked } = verbsOf({ run_status: { text: "no run", isError: true, code: "http_404" }, world_status: { text: "World w-1: 4 of 5 planted problems found", data: {} } });
  const out = await makeDoors(verbs).status({ about: "run", id: "w-1" });
  assert.deepEqual(asked.map(([name]) => name), ["run_status", "world_status"]);
  assert.match(out.text, /^World w-1:/);
});

test("status about production says what is happening and what is wrong as one answer, with one next step", async () => {
  const { verbs, asked } = verbsOf({
    intelligence: { text: "1,204 conversations, 98% of checks passed.\nnext: incidents", data: { days: 7 } },
    incidents: { text: "Refunds: 12 of 90 since Tuesday.\nnext: verify", data: { open: 1 } },
  });
  const out = await makeDoors(verbs).status({ about: "production", days: 14 });
  assert.deepEqual(asked, [["intelligence", { days: 14 }], ["incidents", {}]]);
  assert.equal(out.text, "1,204 conversations, 98% of checks passed.\nRefunds: 12 of 90 since Tuesday.\nnext: verify");
  assert.deepEqual(out.data, { days: 7, open: 1 });
});

test("a warehouse lane with no question says what a question needs instead of asking for nothing", async () => {
  const { verbs, asked } = verbsOf();
  const out = await makeDoors(verbs).status({ about: "warehouse" });
  assert.deepEqual(asked, []);
  assert.equal(out.isError, true);
  assert.match(out.text, /names its table/);
});

test("test plays conversations, caps them where the person asked for a cap, and sends requests instead where endpoints are named", async () => {
  for (const [args, want] of [
    [{ ask: "I rewrote the refund prompt" }, ["test", { ask: "I rewrote the refund prompt" }]],
    [{ ask: "I rewrote the refund prompt", conversations: 10 }, ["test", { ask: "I rewrote the refund prompt", conversations: 10 }]],
    [{ conversations: 10 }, ["test", { conversations: 10 }]],
    [{}, ["test", {}]],
    [{ endpoints: ["/api/chat"] }, ["reach", { paths: ["/api/chat"] }]],
    [{ endpoints: [] }, ["reach", {}], "an empty list is every endpoint that has not answered"],
  ]) {
    const { verbs, asked } = verbsOf();
    await makeDoors(verbs).test(args);
    assert.deepEqual(asked, [want], JSON.stringify(args));
  }
});

test("tell carries one of the three things an agent is the only one who can say", async () => {
  const outcomes = [{ name: "Signed up", why: "the signup route", rules: [{ kind: "path", match: "exact", value: "/welcome" }] }];
  for (const [args, want] of [
    [{ about: "status", kind: "idea", needed: "a smaller run", got: "forty-eight", tried: "asked the person" },
      ["feedback", { about: "status", kind: "idea", needed: "a smaller run", got: "forty-eight", tried: "asked the person" }]],
    [{ about: "status", kind: "problem", needed: "the price" }, ["feedback", { about: "status", kind: "problem", needed: "the price" }]],
    [{ outcomes }, ["outcomes", { proposals: outcomes }]],
    [{ incidentsTo: "https://example.com/hooks/cortad" }, ["subscribe", { url: "https://example.com/hooks/cortad" }]],
  ]) {
    const { verbs, asked } = verbsOf();
    await makeDoors(verbs).tell(args);
    assert.deepEqual(asked, [want], JSON.stringify(args));
  }
  const { verbs, asked } = verbsOf();
  const out = await makeDoors(verbs).tell({ kind: "idea" });
  assert.deepEqual(asked, []);
  assert.equal(out.isError, true);
  assert.match(out.text, /names what it is about/);
});

test("verify and dispute and connect reach what they always reached", async () => {
  const { verbs, asked } = verbsOf();
  const doors = makeDoors(verbs);
  await doors.verify({ findingId: "finding:1", id: "r-9" });
  await doors.verify({ findingId: "finding:1" });
  await doors.dispute({ findingId: "finding:1", why: "this app has no refunds", question: "does it answer about orders" });
  await doors.connect({});
  // The site the page key answers goes on as given; anything that is not a word of it does not.
  await doors.connect({ site: "https://app.example.com" });
  await doors.connect({ site: 7 });
  assert.deepEqual(asked, [
    ["verify", { findingId: "finding:1", jobId: "r-9" }],
    ["verify", { findingId: "finding:1" }],
    ["dispute", { findingId: "finding:1", why: "this app has no refunds", question: "does it answer about orders" }],
    ["connect", {}],
    ["connect", { site: "https://app.example.com" }],
    ["connect", {}],
  ]);
});

// The names the doors replaced are in the skill every customer on 0.4.x was handed, and the shell
// face still answers all of them: nothing is reachable through a door that is not reachable by name.
test("every retired name has a door to point at, and every name any face serves is a verb", () => {
  for (const name of RETIRED) {
    assert.ok(movedTo(name), `${name} says where to go instead`);
    assert.ok(VERB_NAMES.includes(name), `${name} is still a verb`);
  }
  for (const door of DOORS) {
    assert.equal(movedTo(door.name), null, `${door.name} is a door, not a retired name`);
  }
  assert.deepEqual(VERB_NAMES.filter((name) => !RETIRED.includes(name)), ["status", "verify", "dispute", "test", "connect", "users"],
    "the five doors that kept their old name, tell, which is the one new word, and users, which only status about users reaches");
  assert.equal(DOORS.length, 6);
});

// The last line of an answer is the next call, and the shell names are what the server and the
// renderings say. An agent handed `next: findings` learns the name the doors replaced.
test("the next call is said in the door's words, and a step that is already one is left alone", () => {
  for (const [said, want] of [
    ["Run r-1: 4 of 10 played.\nnext: run_status 55ee432b", 'Run r-1: 4 of 10 played.\nnext: status about: "run", id: "55ee432b"'],
    ["Run r-1 finished.\nnext: findings", 'Run r-1 finished.\nnext: status about: "findings"'],
    ["World started.\nnext: world_status w-1", 'World started.\nnext: status about: "run", id: "w-1"'],
    ["Starting your app.\nnext: run_status pending", 'Starting your app.\nnext: status about: "run"'],
    ["Your app is up.\nnext: status", "Your app is up.\nnext: status"],
    ["finding:3 is worth a fix.\nnext: verify finding:3", "finding:3 is worth a fix.\nnext: verify finding:3"],
    ["No run yet.\nnext: npx -y cortad wait", "No run yet.\nnext: npx -y cortad wait"],
    ["Nothing to say at all", "Nothing to say at all"],
  ]) {
    assert.equal(doorNext(said), want, said);
  }
});
