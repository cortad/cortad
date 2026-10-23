import assert from "node:assert/strict";
import { test } from "node:test";
import { makeAutoReach } from "./auto-reach.mjs";

// One round of the connect command's own test requests, against a stand-in for the app: what the
// server hears and when, and where a round stops.
const row = (path) => ({ names: [], method: "POST", path, file: "app.js", line: 4, request: { method: "POST", path, body: { message: "Hi" } } });
const answer = () => new Response(JSON.stringify({ reply: "Hello" }), { status: 200 });
const setup = (paths, extra) => {
  const reported = [];
  const round = makeAutoReach({
    status: async () => ({ read: { complete: true }, contact: { proven: [], notCalled: paths.map(row) } }),
    runner: () => ({ state: "up", port: 3100, receipts: [] }),
    waiting: async () => null, origin: () => null, signIn: async () => null, stampOf: () => "1",
    report: async (answers) => { reported.push(answers); }, say: () => {},
    ...extra,
  });
  return { round, reported };
};

// Reported when the round ended, an endpoint that answered in a second waited on one that took 55.
test("an endpoint's answer reaches the server as it lands, never held behind a slower endpoint", async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const { round, reported } = setup(["/api/fast", "/api/slow"], {
    fetchImpl: async (url) => { if (String(url).endsWith("/api/slow")) await slow; return answer(); },
  });
  const going = round();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(reported, [[], [{ door: "POST /api/fast", status: 200, signedIn: false }]], "the fast endpoint is said while the slow one is still out");
  release();
  await going;
  assert.deepEqual(reported.at(-1), [{ door: "POST /api/slow", status: 200, signedIn: false }]);
  assert.equal(reported.length, 3, "each answer is said once");
});

test("a round starts no request past its time, and the rows left are sent in the next round, soon", async () => {
  let clock = 0;
  const asked = [];
  const paths = ["/a", "/b", "/c", "/d", "/e", "/f"];
  const { round, reported } = setup(paths, {
    roundMs: 1_000, now: () => clock,
    // The first four go out together; the round's time is spent while they are out.
    fetchImpl: async (url) => { asked.push(new URL(url).pathname); await new Promise((r) => setTimeout(r, 10)); clock += 2_000; return answer(); },
  });
  const first = await round();
  assert.deepEqual(asked, ["/a", "/b", "/c", "/d"]);
  assert.equal(first.wait, 5_000, "what was left is due in seconds though the code is read");
  const second = await round();
  assert.deepEqual(asked.slice(4), ["/e", "/f"], "an endpoint already tested is not sent again");
  assert.equal(second.wait, 60_000);
  assert.deepEqual(reported.flat().map((a) => a.door).sort(), paths.map((p) => `POST ${p}`));
  await round();
  assert.equal(asked.length, 6, "a third round sends nothing");
});

// The first row listed is the slow one: the second's answer is said under its own name while the
// first is still out, and the first's under its own when it lands.
test("answers that land out of order are each reported as the endpoint they came from", async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const { round, reported } = setup(["/api/slow", "/api/fast"], {
    fetchImpl: async (url) => { if (String(url).endsWith("/api/slow")) { await slow; return new Response("no", { status: 500 }); } return answer(); },
  });
  const going = round();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(reported, [[], [{ door: "POST /api/fast", status: 200, signedIn: false }]]);
  release();
  const out = await going;
  assert.deepEqual(reported.at(-1), [{ door: "POST /api/slow", status: 500, signedIn: false, said: "no" }]);
  assert.ok(out.text.indexOf("POST /api/slow: 500") < out.text.indexOf("POST /api/fast: 200"), "the agent reads them in the order they are listed");
});

const failing = (code) => Object.assign(new Error("failed"), { cause: { code } });

// Nothing answered on the port: the request reached nothing, so sending it again repeats nothing.
test("a request refused before it reached the app is not reported and is sent again", async () => {
  let n = 0;
  const { round, reported } = setup(["/api/chat"], { fetchImpl: async () => { if (n++ === 0) throw failing("ECONNREFUSED"); return answer(); } });
  await round();
  assert.deepEqual(reported, [[]]);
  await round();
  assert.deepEqual(reported.at(-1), [{ door: "POST /api/chat", status: 200, signedIn: false }]);
});

// A reset can come after the app took the request. Sent again, a POST that books or charges does it twice.
test("a POST whose connection was reset is reported as unanswered and never sent again by itself", async () => {
  let n = 0;
  const { round, reported } = setup(["/api/order"], { fetchImpl: async () => { n += 1; throw failing("ECONNRESET"); } });
  const out = await round();
  assert.match(out.text, /POST \/api\/order: the connection failed \(ECONNRESET\)\. It may have reached your app, so Cortad does not send it again by itself\./);
  assert.deepEqual(reported.at(-1), [{ door: "POST /api/order", status: 0, signedIn: false }]);
  await round();
  await round();
  assert.equal(n, 1, "one request, whatever became of it");
  await round({ paths: ["/api/order"] });
  assert.equal(n, 2, "the agent's own ask sends it again");
});

test("a request that timed out is not sent again by itself", async () => {
  let n = 0;
  const { round } = setup(["/api/chat"], { fetchImpl: async () => { n += 1; throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); } });
  await round();
  await round();
  assert.equal(n, 1);
});

// The server missed a report: it hears the answer once the wait is over, and the app is not asked again.
test("an answer the server did not take is kept and said again after a wait, without another request to the app", async () => {
  let asked = 0, up = false, clock = 0;
  const heard = [], said = [];
  const { round } = setup(["/api/chat"], {
    now: () => clock, say: (line) => said.push(line),
    fetchImpl: async () => { asked += 1; return answer(); },
    report: async (answers) => { if (!answers.length) return true; if (!up) return false; heard.push(answers); return true; },
  });
  const first = await round();
  assert.deepEqual(heard, []);
  assert.equal(first.wait, 5_000, "looked at again soon while an answer is still owed to the server");
  assert.deepEqual(said.filter((l) => /did not take/.test(l)), ["Cortad did not take what 1 test request met. They are kept here and sent again; your app is not asked again."]);
  up = true;
  await round();
  assert.deepEqual(heard, [], "not before the wait is over");
  clock += 5_000;
  await round();
  assert.deepEqual(heard, [[{ door: "POST /api/chat", status: 200, signedIn: false }]]);
  await round();
  assert.equal(heard.length, 1, "said once it is taken, not again");
  assert.equal(asked, 1);
});

// 250 endpoints answered while the server took no report: fifty answers were thrown away with their
// endpoints already marked as tested, and each of the 250 answers tried a report of its own.
test("through an outage every answer is kept, one report is tried per wait, and all are heard once it ends", async () => {
  const paths = Array.from({ length: 250 }, (_, i) => `/api/e${i}`);
  let up = false, clock = 0, tried = 0, appAsked = 0;
  const heard = [];
  const { round } = setup(paths, {
    now: () => clock, say: () => {},
    fetchImpl: async () => { appAsked += 1; return answer(); },
    report: async (answers) => { if (!answers.length) return true; tried += 1; if (!up) return false; heard.push(...answers); return true; },
  });
  await round();
  assert.equal(appAsked, 250);
  assert.equal(tried, 1, "the first report that failed stops the rest until the wait is over");
  clock += 5_000;
  await round();
  assert.equal(tried, 2);
  clock += 5_000;
  await round();
  assert.equal(tried, 2, "the wait doubles after each failure");
  up = true;
  clock += 5_000;
  await round();
  assert.deepEqual(heard.map((a) => a.door).sort(), paths.map((p) => `POST ${p}`).sort(), "every answer is heard");
  assert.equal(heard.length, 250, "each once");
  assert.equal(tried, 5, "in batches of a hundred");
  assert.equal(appAsked, 250, "and the app was asked once for each");
});
