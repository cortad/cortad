import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changedLine, makeVerbs } from "./verbs.mjs";

const json = (status, body) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) });
const API = "https://cortad.test/api";
const memory = (initial = null) => { let value = initial; return { read: () => value, write: (p) => { value = p; } }; };

// A clock the verbs read and a sleep that moves it, so a 45-second hold runs in no time.
function clock(start = Date.parse("2026-09-26T12:00:00Z")) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; }, tick: (ms) => { t += ms; } };
}

test("every call carries the machine key; without one, every verb says how to connect and calls nothing", async () => {
  const seen = [];
  const verbs = makeVerbs({ api: API, token: "ct_mcp_x", pending: memory(), fetchImpl: async (url, init) => { seen.push({ url, init }); return json(200, { plan: { name: "Free", runsLeft: 1, runsAllowed: 1 }, run: null }); } });
  const out = await verbs.status();
  assert.equal(seen[0].url, `${API}/mcp/status?news=1`);
  assert.equal(seen[0].init.headers.authorization, "Bearer ct_mcp_x");
  assert.match(out.text, /Free: 1 of 1 run left this month\./);

  const none = makeVerbs({ api: API, token: null, pending: memory(), fetchImpl: async () => { throw new Error("must not be called"); } });
  const refused = await none.findings({});
  assert.equal(refused.isError, true);
  assert.match(refused.text, /not connected to Cortad\. Run npx cortad in this folder as a background command: it prints a link for the person to approve in a browser where they are signed in to Cortad\.$/);
});

test("status with show machine is said from the runner's record and asks nothing of the server", async () => {
  const machine = { cmd: "npm run dev", dir: ".", port: 3000, started: true, hooked: true, proxy: null, changed: [], copies: "none", clients: [] };
  const fetchImpl = async (url) => { throw new Error(`asked ${url}`); };
  const out = await makeVerbs({ api: API, token: "k", runner: () => ({ state: "up", port: 3000, machine }), pending: memory(), fetchImpl }).status({ show: "machine" });
  assert.match(out.text, /^Cortad started your app in this folder and stops it when this command stops\./);
  const gone = await makeVerbs({ api: API, token: "k", pending: memory(), fetchImpl }).status({ show: "machine" });
  assert.equal(gone.text, "No connect command is running for this repository now, so nothing Cortad started is running here.");
});

// One customer's agent spent many calls guessing at an error its app had printed into a file nobody named.
test("a failure on the app's side names the file with the app's whole output, here and only when it holds some", async () => {
  const appLog = join(mkdtempSync(join(tmpdir(), "cortad-log-")), "app.log");
  const said = `Your app's whole output from this session is in ${appLog}.`;
  const problem = { contact: { proven: [{ door: "POST /v1/chat", requests: 1, problems: [{ kind: "error-status", said: "Your app answered 500.", file: null, line: null }] }], notCalled: [] }, run: null };
  const failedRun = { jobId: "r1", status: "succeeded", finished: true, played: 3, of: 3, faults: [{ side: "theirs", what: "Your app answered 500 on 3 of 3 turns." }] };
  const fetchImpl = async (url) => json(200, url.includes("/mcp/run/") ? failedRun : problem);
  const verbs = makeVerbs({ api: API, token: "k", pending: memory(), fetchImpl, appLog });
  assert.doesNotMatch((await verbs.status()).text, /whole output/, "no file yet, no path");
  writeFileSync(appLog, "");
  assert.doesNotMatch((await verbs.status()).text, /whole output/, "an empty file, no path");
  writeFileSync(appLog, "ERROR: request failed\n");
  assert.equal((await verbs.status()).text.split("\n").at(-1), said);
  const lines = (await verbs.run_status({ jobId: "r1" })).text.split("\n");
  assert.deepEqual(lines.slice(-2), [said, "next: status"]);
  const clean = makeVerbs({ api: API, token: "k", pending: memory(), fetchImpl: async () => json(200, { contact: { proven: [{ door: "POST /v1/chat", requests: 1, problems: [] }], notCalled: [] }, run: null }), appLog });
  assert.doesNotMatch((await clean.status()).text, /whole output/);
});

test("run with the app up posts at once and keeps the id; with the app down it starts the app and answers without waiting for it", async () => {
  const posted = [];
  const c = clock();
  let app = { state: "ready-to-test" };
  let here = { state: "up", port: 8000 };
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/mcp/status?quiet=1")) return json(200, { app, run: { jobId: "old", status: "succeeded" } });
    if (url.endsWith("/mcp/run") && init.method === "POST") { posted.push(JSON.parse(init.body)); return json(202, { started: true, jobId: "j1", kind: "run" }); }
    throw new Error(url);
  };
  const pending = memory();
  const started = [];
  const verbs = makeVerbs({ api: API, token: "k", runner: () => here, fetchImpl, pending, now: c.now, startApp: async (args, kind) => { started.push([args, kind]); return { ok: true }; } });

  const up = await verbs.run();
  assert.equal(up.text, "Run started: j1.\nnext: run_status j1");
  assert.deepEqual(pending.read(), { jobId: "j1", kind: "run", startedAt: "2026-09-26T12:00:00.000Z" });
  assert.deepEqual(started, []);
  assert.deepEqual(posted, [{}], "a run with no cap asks for nothing of the sort");

  app = { state: "starting", port: null, said: "Your app is starting." };
  here = { state: "starting" };
  const down = await verbs.verify({ findingId: "finding:1" });
  assert.equal(down.text, "Starting your app for the run. Call run_status; it answers as soon as the run has an id.");
  assert.deepEqual(started, [[{ findingId: "finding:1" }, "verify"]]);
  assert.equal(posted.length, 1, "the verify is posted by the waiter, not here");
  assert.deepEqual(pending.read(), { kind: "verify", startedAt: "2026-09-26T12:00:00.000Z", after: "old" });

  // Up on this machine while the server cannot play it yet: the waiter posts the run. The words are
  // the runner's, never the server's guess that the app is starting, and the server's reason when it
  // has one about the app's endpoints on that port.
  here = { state: "up", port: 8000 };
  assert.equal((await verbs.run()).text, "Your app answers on port 8000.\nCall run_status; it answers as soon as the run has an id.");
  app = { state: "starting", port: 8000, said: "Your app answers on port 8000; Cortad is finding which of its endpoints answers as an AI before the run." };
  assert.equal((await verbs.run()).text, `${app.said}\nCall run_status; it answers as soon as the run has an id.`);
  app = { ...app, port: 8001 };
  assert.equal((await verbs.run()).text, "Your app answers on port 8000.\nCall run_status; it answers as soon as the run has an id.", "a reason about another port is not this app's");
  assert.equal(started.length, 4);
  assert.equal(posted.length, 1);
});

// A customer skipped the run altogether: it played 48 conversations for about $40 on his own key,
// and the tool took no parameters, so there was no way to ask for a first look at ten.
test("a run capped at a number of conversations sends that number, on the app that is up and on the one that has to start first", async () => {
  const posted = [];
  const started = [];
  let app = { state: "ready-to-test" };
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/mcp/status?quiet=1")) return json(200, { app, run: null });
    if (url.endsWith("/mcp/run") && init.method === "POST") { posted.push(JSON.parse(init.body)); return json(202, { started: true, jobId: "j1", kind: "run", note: "Playing 10 of 48 conversations. About $8.40 of $40.30 on your OpenAI key." }); }
    throw new Error(url);
  };
  const verbs = makeVerbs({ api: API, token: "k", runner: () => ({ state: "up", port: 8000 }), fetchImpl, pending: memory(), startApp: async (args, kind) => { started.push([args, kind]); return { ok: true }; } });

  const ten = await verbs.run({ conversations: 10 });
  assert.deepEqual(posted.at(-1), { conversations: 10 }, "the server reads it as conversations, and decides what it plays");
  // What the run will play and what it costs are the server's own words, counted against the whole.
  assert.equal(ten.text, "Run started: j1.\nPlaying 10 of 48 conversations. About $8.40 of $40.30 on your OpenAI key.\nnext: run_status j1");
  assert.deepEqual((await verbs.run({ conversations: 1 })).data.jobId, "j1");
  assert.deepEqual(posted.at(-1), { conversations: 1 }, "one conversation is a run");
  await verbs.run();
  assert.deepEqual(posted.at(-1), {}, "a run with no cap asks for nothing of the sort");
  // Nothing but a count of conversations is passed on; the range itself is the server's to refuse.
  for (const asked of [0, -3, 2.5, "10", null, Number.MAX_VALUE]) {
    await verbs.run({ conversations: asked });
    assert.deepEqual(posted.at(-1), {}, `${String(asked)} is not a number of conversations`);
  }
  // The ordinary first run: the app is not up yet, so the cap travels to the process that posts it.
  app = { state: "starting", port: null, said: "Your app is starting." };
  await verbs.run({ conversations: 10 });
  assert.deepEqual(started.at(-1), [{ conversations: 10 }, "run"]);
});

test("run on an app the runner could not start says why at once: nothing is asked of the server, nothing is started, nothing ran", async () => {
  const here = { state: "failed", error: "port 8000 is in use by another program (pid 4242, python main.py), so your app cannot listen there; your app sets that port in its own code, so it cannot be moved. Stop that program, then save a file here: your app is started again by itself." };
  const started = [];
  const verbs = makeVerbs({ api: API, token: "k", runner: () => here, pending: memory(), fetchImpl: async (url) => { throw new Error(`asked ${url}`); }, startApp: async () => { started.push(1); return { ok: true }; } });
  const out = await verbs.run();
  assert.equal(out.isError, true);
  assert.equal(out.text, `P${here.error.slice(1)}\nNothing ran.`);
  assert.deepEqual(started, []);
});

test("a spent plan comes back as the ledger with the checkout for the person, and 'Nothing ran.'", async () => {
  const verbs = makeVerbs({ api: API, token: "k", runner: () => ({ state: "up", port: 8000 }), pending: memory(), fetchImpl: async (url) =>
    url.endsWith("/mcp/status?quiet=1") ? json(200, { app: { state: "ready-to-test" } })
      : json(402, { refused: "plan", why: "used", unit: "sweeps", allowed: 1, used: 1, plan: { name: "Free" }, plans: [{ name: "Pro", monthlyUsd: 99 }, { name: "Max", monthlyUsd: 499 }], checkout: "https://cortad.test/pricing?checkout=ship" }) });
  const out = await verbs.run();
  assert.equal(out.isError, true);
  assert.equal(out.text, "Refused: 1 of 1 run used on the Free plan.\nPlans: Pro $99 a month, Max $499 a month.\nNothing ran.\nPlans and checkout are at https://cortad.test/pricing?checkout=ship");
});

test("run_status with an id holds on the server for 45 seconds and ends with the next call", async () => {
  const urls = [];
  const verbs = makeVerbs({ api: API, token: "k", pending: memory(), fetchImpl: async (url) => { urls.push(url); return json(200, { jobId: "j1", kind: "run", status: "running", played: 3, of: 51, finished: false }); } });
  const out = await verbs.run_status({ jobId: "j1" });
  assert.deepEqual(urls, [`${API}/mcp/run/j1?wait=45`]);
  assert.equal(out.text, "Run j1: running, 3 of 51 conversations played.\n3 of 51 conversations done.\nnext: run_status j1");
});

test("run_status without an id holds while the app starts, takes the id the waiter leaves, and spends only what is left of the 45 seconds", async () => {
  const c = clock();
  const pending = memory({ kind: "run", startedAt: new Date(c.now()).toISOString(), after: "old" });
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.endsWith("/mcp/status?quiet=1")) return json(200, { run: { jobId: "old" } });
    return json(200, { jobId: "j2", kind: "run", status: "queued", played: 0, of: 51 });
  };
  let slept = 0;
  const verbs = makeVerbs({ api: API, token: "k", fetchImpl, pending, now: c.now, sleep: async (ms) => { c.tick(ms); slept += 1; if (slept === 20) pending.write({ ...pending.read(), jobId: "j2" }); } });
  const out = await verbs.run_status({});
  assert.deepEqual(urls, [`${API}/mcp/status?quiet=1`, `${API}/mcp/run/j2?wait=25`]);
  assert.match(out.text, /next: run_status j2$/);
});

test("run_status without an id: still starting says how long and names itself next; a failure says why; a newer run outranks the file", async () => {
  const c = clock();
  const status = (jobId, app) => async (url) => (url.endsWith("/mcp/status?quiet=1") ? json(200, { app, run: jobId ? { jobId } : null }) : json(200, { jobId, kind: "run", status: "running", played: 1, of: 5 }));

  const waiting = makeVerbs({ api: API, token: "k", fetchImpl: status(null), pending: memory({ kind: "run", startedAt: new Date(c.now()).toISOString(), after: null }), now: c.now, sleep: c.sleep });
  assert.equal((await waiting.run_status({ jobId: "pending" })).text, "Your app is still starting for the run: 45 of up to 240 seconds.\nnext: run_status pending");

  // The runner already has the app answering; the wait says so, with the server's request when it asks for one.
  const up = (app) => makeVerbs({ api: API, token: "k", runner: () => ({ state: "up", port: 8001 }), fetchImpl: status(null, app), pending: memory({ kind: "run", startedAt: new Date(c.now()).toISOString(), after: null }), now: c.now, sleep: c.sleep });
  assert.equal((await up({ state: "starting", port: null, said: "Your app is starting." }).run_status({ jobId: "pending" })).text, "Your app answers on port 8001.\nThe run has waited 45 of up to 240 seconds.\nnext: run_status pending");
  const asking = { state: "asking", port: 8001, said: "Your app answers on port 8001, but none of the routes asked answered as an AI. Send one request to it the way its own client does (from a shell is fine); Cortad reads the route and the body from the request it sees, then start the run again.\nThe routes asked, as one request each:\ncurl -X POST http://127.0.0.1:8001/chat -H 'content-type: application/json' -d '{\"message\":\"hello\"}'" };
  assert.equal((await up(asking).run_status({ jobId: "pending" })).text, `${asking.said}\nThe run has waited 45 of up to 240 seconds.\nnext: run_status pending`);

  const failed = makeVerbs({ api: API, token: "k", fetchImpl: status(null), pending: memory({ kind: "run", startedAt: new Date(c.now()).toISOString(), after: null, error: "Your app did not answer within 4 minutes.\nNothing ran." }), now: c.now, sleep: c.sleep });
  const told = await failed.run_status({});
  assert.equal(told.isError, true);
  assert.equal(told.text, "Your app did not answer within 4 minutes.\nNothing ran.\nnext: status");

  const newer = makeVerbs({ api: API, token: "k", fetchImpl: status("fresh"), pending: memory({ kind: "run", startedAt: "2026-09-25T00:00:00Z", after: "older", error: "stale" }), now: c.now, sleep: c.sleep });
  assert.match((await newer.run_status({})).text, /^Run fresh: running/);

  const nothing = makeVerbs({ api: API, token: "k", fetchImpl: status(null), pending: memory(), now: c.now, sleep: c.sleep });
  assert.equal((await nothing.run_status({})).text, "No run yet.\nnext: status");
});

test("findings reads every server page before cutting its own, and a page past the end is the last one", async () => {
  const urls = [];
  const finding = (id) => ({ id, asks: `Question ${id}?`, file: "a.ts", line: 1, rate: { k: 1, n: 4, lo: 0.05, hi: 0.7 }, quotes: [], replay: { trials: 4 } });
  const fetchImpl = async (url) => {
    urls.push(url);
    const page = Number(new URL(url).searchParams.get("page") ?? 1);
    return json(200, { runId: "r1", page, pages: 2, findings: [finding(`finding:${page}`)], byLine: [{ path: "a.ts", line: 1, findingIds: [`finding:${page}`] }] });
  };
  const verbs = makeVerbs({ api: API, token: "k", pending: memory(), fetchImpl });
  const out = await verbs.findings({ page: 9 });
  assert.deepEqual(urls, [`${API}/mcp/findings`, `${API}/mcp/findings?jobId=r1&page=2`]);
  assert.match(out.text, /^Run r1: 2 findings\./);
  assert.match(out.text, /\n\nfinding:1 .*\n[\s\S]*\n  At a\.ts:1\n[\s\S]*\n\nfinding:2 /, "both server pages, each finding at its own line");
});

test("findings numbers asks for the whole table once and pages it here", async () => {
  const urls = [];
  const numbers = JSON.parse(readFileSync(new URL("./numbers-fixture.json", import.meta.url), "utf8")).numbers;
  const verbs = makeVerbs({ api: API, token: "k", pending: memory(), fetchImpl: async (url) => { urls.push(url); return json(200, { runId: numbers.runId, numbers }); } });
  const out = await verbs.findings({ show: "numbers", jobId: "r1", page: 2 });
  assert.deepEqual(urls, [`${API}/mcp/findings?show=numbers&jobId=r1`]);
  assert.match(out.text, /^Run c44c7d43-3e29-49ef-9772-e6d8d9439c4c, numbers continued\./);
  assert.match(out.text, /\npage 2 of \d+/);
});

test("status --changed names the cited files touched since the run started, with their findings, and nothing outside the repository", () => {
  const root = mkdtempSync(join(tmpdir(), "cortad-changed-"));
  mkdirSync(join(root, "src"));
  for (const f of ["src/prompt.ts", "src/tools.ts", "src/old.ts"]) writeFileSync(join(root, f), "x");
  const since = "2026-09-26T12:00:00.000Z";
  const before = new Date(Date.parse(since) - 60_000);
  utimesSync(join(root, "src/old.ts"), before, before);
  const lines = [{ path: "src/prompt.ts", line: 4, findingIds: ["finding:1", "finding:3"] }, { path: "src/old.ts", line: 2, findingIds: ["finding:2"] }];
  const paths = ["src/prompt.ts", "src/old.ts", "src/tools.ts", "../outside.ts", "/etc/hosts", "src/missing.ts"];
  assert.equal(changedLine({ root, since, runId: "r1", paths, lines }), "Changed since run r1: src/prompt.ts (finding:1, finding:3), src/tools.ts.");
  assert.equal(changedLine({ root, since: null, runId: "r1", paths, lines }), "");
  assert.equal(changedLine({ root, since: "2099-01-01T00:00:00Z", runId: "r1", paths, lines }), "");
});

test("status --changed takes the code review's files from the review shown: the read's misses, or the lines Cortad's team's review cites", async () => {
  const root = mkdtempSync(join(tmpdir(), "cortad-changed-"));
  mkdirSync(join(root, "src"));
  for (const f of ["src/agent.ts", "src/routes.ts"]) writeFileSync(join(root, f), "x");
  const since = new Date(Date.now() - 60_000).toISOString();
  const changed = (machine) => makeVerbs({ api: API, token: "k", root, pending: memory(), fetchImpl: async (url) =>
    json(200, url.includes("/mcp/status") ? { run: { jobId: "r1", startedAt: since }, read: { machine } } : { findings: [] }) }).changed();
  assert.equal((await changed({ reviewed: true, cited: [{ path: "src/agent.ts", line: 216 }] })).text, "Changed since run r1: src/agent.ts.");
  assert.equal((await changed({ decided: 2, met: 1, missed: 1, misses: [{ path: "src/routes.ts", line: 9, standards: ["Every door behind auth"] }] })).text, "Changed since run r1: src/routes.ts.");
});

// Status leads with what is new since the agent's last call; the connector's own reads of it ask quietly.
test("only the status verb reads status as the agent's call; run_status, run and the hook's changed read it quietly", async () => {
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(url);
    if (url.includes("/mcp/status")) return json(200, { app: { state: "ready-to-test" }, run: { jobId: "old", status: "succeeded" } });
    if (url.endsWith("/mcp/run") && init.method === "POST") return json(202, { started: true, jobId: "j1", kind: "run" });
    if (url.includes("/mcp/run/old")) return json(200, { jobId: "old", kind: "run", status: "succeeded", finished: true, played: 3, of: 3 });
    return json(200, { runId: "old", findings: [], pages: 1 });
  };
  const c = clock();
  const verbs = makeVerbs({ api: API, token: "k", runner: () => ({ state: "up", port: 8000 }), fetchImpl, pending: memory(), now: c.now, sleep: c.sleep });
  await verbs.status();
  await verbs.run_status({});
  await verbs.run();
  await verbs.changed();
  assert.deepEqual(urls, [
    `${API}/mcp/status?news=1`,
    `${API}/mcp/status?quiet=1`, `${API}/mcp/run/old?wait=45`,
    `${API}/mcp/status?quiet=1`, `${API}/mcp/run`,
    `${API}/mcp/status?quiet=1`, `${API}/mcp/findings`,
  ]);
});

test("status with show asks for that section in full and pages it; any other name is the plain status", async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return json(200, { repository: { name: "app" }, read: { rules: { count: 1, files: 1, all: [{ text: "Cite the lesson.", path: "a.ts", line: 8 }] } }, run: null }); };
  const verbs = makeVerbs({ api: API, token: "k", pending: memory(), fetchImpl });
  assert.equal((await verbs.status({ show: "rules", page: 1 })).text, "Rules in the code: 1, in 1 file.\n  a.ts:8  \"Cite the lesson.\"");
  await verbs.status({ show: "secrets" });
  assert.deepEqual(urls, [`${API}/mcp/status?show=rules&quiet=1`, `${API}/mcp/status?news=1`]);
});

test("status says the app as the runner on this machine holds it, and the server's word only where no runner is here or where it says what it found at the app's port", async () => {
  const server = { repository: { name: "app" }, app: { state: "not-created", said: "Your app has not been started for Cortad yet." }, run: null };
  const fetchImpl = async () => json(200, server);
  const at = (runner) => makeVerbs({ api: API, token: "k", runner: () => runner, pending: memory(), fetchImpl }).status();
  assert.deepEqual((await at({ state: "up", port: 8000 })).text.split("\n").slice(0, 2), ["Repository: app.", "App: answering on port 8000."]);
  assert.equal((await at({ state: "failed", error: "your app stopped before it answered." })).text.split("\n")[1], "App: your app stopped before it answered.");
  assert.equal((await at({ state: "starting" })).text.split("\n")[1], "App: starting.");
  assert.equal((await at(null)).text.split("\n")[1], "App: Your app has not been started for Cortad yet.");
  server.app = { state: "starting", port: 8000, said: "Your app answers on port 8000; Cortad is finding which of its endpoints answers as an AI before the run." };
  assert.equal((await at({ state: "up", port: 8000 })).text.split("\n")[1], `App: ${server.app.said}`);
});

test("a run_status that cannot reach Cortad says the run goes on and exits as an error", async () => {
  const verbs = makeVerbs({ api: "http://127.0.0.1:1", token: "k", fetchImpl: async () => { throw new TypeError("fetch failed"); }, pending: { read: () => null }, sleep: async () => {} });
  const out = await verbs.run_status({ jobId: "run-1" });
  assert.equal(out.isError, true);
  assert.equal(out.text, "Could not reach Cortad: the connection failed. The run is on Cortad's side and goes on without this call; nothing was lost or charged by it.\nnext: run_status run-1");
});

test("a run the agent read to its end, through run_status or findings, is told to seen; one still playing is not", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    if (url.includes("/mcp/run/live")) return json(200, { jobId: "live", status: "running", played: 3, planned: 51 });
    if (url.includes("/mcp/run/done")) return json(200, { jobId: "done", status: "succeeded", finished: true });
    if (url.includes("/mcp/findings")) return json(200, { runId: "done", findings: [], pages: 1 });
    throw new Error(url);
  };
  const verbs = makeVerbs({ api: API, token: "k", pending: memory(), fetchImpl, seen: (id) => seen.push(id) });
  await verbs.run_status({ jobId: "live" });
  assert.deepEqual(seen, []);
  await verbs.run_status({ jobId: "done" });
  await verbs.findings({});
  assert.deepEqual(seen, ["done", "done"]);
});

test("a note about Cortad posts its slots and answers with the server's sentence; a refusal is an error", async () => {
  const seen = [];
  const verbs = makeVerbs({ api: API, token: "k", pending: memory(), fetchImpl: async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); return json(201, { id: "n1", said: "The Cortad team has the note and reads each one; an answer comes back under Send feedback on cortad.com. Nothing about the run or its questions changed." }); } });
  const out = await verbs.feedback({ about: "findings", kind: "problem", needed: "the line a finding names", got: "a line past the end of the file", tried: "" });
  assert.equal(seen[0].url, `${API}/mcp/feedback`);
  assert.deepEqual(seen[0].body, { about: "findings", kind: "problem", needed: "the line a finding names", got: "a line past the end of the file" });
  assert.equal(out.text, "The Cortad team has the note and reads each one; an answer comes back under Send feedback on cortad.com. Nothing about the run or its questions changed.");
  const capped = makeVerbs({ api: API, token: "k", pending: memory(), fetchImpl: async () => json(429, { error: "12 notes in an hour is the most this account can send." }) });
  const refused = await capped.feedback({ about: "status", kind: "idea", needed: "x" });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /12 notes in an hour/);
});

// The run the person presses in the browser after the agent stopped: wait wakes the agent with it.
test("wait follows the next run to its end and prints it with findings next; a run the agent already read is not that run", async () => {
  const c = clock();
  const asked = [];
  const old = { jobId: "old-run", kind: "run", status: "succeeded", finished: true, findings: 2 };
  const fresh = { jobId: "new-run", kind: "run", status: "running", of: 10, played: 4 };
  let polls = 0;
  const fetchImpl = async (url) => {
    asked.push(url.replace(API, ""));
    if (url.includes("/mcp/status")) return json(200, { run: ++polls < 3 ? old : fresh });
    return json(200, asked.filter((u) => u.startsWith("/mcp/run/")).length < 2 ? fresh : { ...fresh, status: "succeeded", finished: true, played: 10, findings: 3 });
  };
  const seen = [];
  const verbs = makeVerbs({ api: API, token: "k", pending: memory(), runner: () => ({ state: "up", port: 3000 }), fetchImpl, seen: (id) => seen.push(id), wasRead: (id) => id === "old-run", now: c.now, sleep: c.sleep });
  const out = await verbs.wait();
  assert.deepEqual(asked, ["/mcp/status?quiet=1", "/mcp/status?quiet=1", "/mcp/status?quiet=1", "/mcp/run/new-run?wait=45", "/mcp/run/new-run?wait=45"]);
  assert.match(out.text, /^Run new-run: finished, 10 of 10 conversations played\./);
  assert.equal(out.text.split("\n").at(-1), "next: findings new-run");
  assert.equal(out.text.match(/^next:/gm).length, 1);
  assert.equal(out.isError, undefined);
  assert.deepEqual(seen, ["new-run"]);
});

test("wait ends as an error once the connect command has been gone a minute, and after six hours with no run", async () => {
  const quiet = async () => json(200, { run: { jobId: "old-run", kind: "run", finished: true } });
  const c = clock();
  const gone = await makeVerbs({ api: API, token: "k", pending: memory(), runner: () => null, fetchImpl: quiet, wasRead: () => true, now: c.now, sleep: c.sleep }).wait();
  assert.equal(gone.isError, true);
  assert.equal(gone.text, "The connect command stopped, so no run can start from the browser. Run npx cortad in this folder again as a background command: it reconnects with the key it kept.\nnext: status");
  const c2 = clock();
  const idle = await makeVerbs({ api: API, token: "k", pending: memory(), runner: () => ({ state: "up" }), fetchImpl: quiet, wasRead: () => true, spec: "cortad@0.3.1", now: c2.now, sleep: c2.sleep }).wait();
  assert.equal(idle.text, "No run ended in 6 hours.\nnext: npx -y cortad@0.3.1 wait");
  assert.equal(idle.isError, undefined);
});

test("wait reports a finished run the agent has not read at once, and ends on a key that no longer opens the run", async () => {
  const done = { jobId: "first-run", kind: "run", status: "succeeded", finished: true, played: 8, of: 8, findings: 1 };
  const c = clock();
  const fetchImpl = async (url) => json(200, url.includes("/mcp/status") ? { run: done } : done);
  const out = await makeVerbs({ api: API, token: "k", pending: memory(), runner: () => ({ state: "up" }), fetchImpl, now: c.now, sleep: c.sleep }).wait();
  assert.equal(out.text.split("\n").at(-1), "next: findings first-run");
  const revoked = async (url) => (url.includes("/mcp/status") ? json(200, { run: { ...done, status: "running", finished: false } }) : json(401, { error: "This key no longer opens this repository." }));
  const c2 = clock();
  const ended = await makeVerbs({ api: API, token: "k", pending: memory(), runner: () => ({ state: "up" }), fetchImpl: revoked, now: c2.now, sleep: c2.sleep }).wait();
  assert.equal(ended.isError, true);
  assert.equal(ended.text, "This key no longer opens this repository.");
});
