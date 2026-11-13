import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { changesOf, commandText, makeCode, RELOADER, sourceOf } from "./fresh.mjs";
import { elapsedMs } from "./proc.mjs";
import { homeOf, readApp, writeApp } from "./home.mjs";
import { claimRunner, readRunner, startedAtOf, writeRunner } from "./runner.mjs";
import { makeVerbs } from "./verbs.mjs";
import { writesDirOf } from "./writes.mjs";

process.env.TZ = "UTC";
const T = Date.parse("2026-09-27T12:00:00.000Z");
const at = (ms) => new Date(ms);

// A repository whose every file was saved a minute before the app started.
function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "cortad-fresh-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
    utimesSync(join(root, rel), at(T - 60_000), at(T - 60_000));
  }
  return root;
}
const save = (root, rel, text, ms) => { writeFileSync(join(root, rel), text); utimesSync(join(root, rel), at(ms), at(ms)); };

const FILES = {
  "backend/server.py": "app = FastAPI()\n",
  "backend/prompts.py": "SYSTEM = 'be kind'\n",
  "data/orders.json": "[]",
  "AGENTS.md": "rules\n",
  ".claude/settings.json": "{}",
  "tests/test_flow.py": "def test(): pass\n",
};

test("a change since the app started is found by its content: the app's own writes, bytes put back, tests and this command's files are not changes", () => {
  const root = repo(FILES);
  const files = sourceOf(root, Object.keys(FILES));
  assert.deepEqual(Object.keys(files).sort(), ["backend/prompts.py", "backend/server.py", "data/orders.json"]);
  const app = { startedAt: at(T).toISOString(), own: true, files };
  assert.deepEqual(changesOf({ root, app }).changed, []);

  save(root, "backend/server.py", "app = FastAPI(dependencies=[gate])\n", T + 30_000);
  save(root, "backend/prompts.py", "SYSTEM = 'be kind'\n", T + 40_000);
  save(root, "data/orders.json", "[{\"id\":1}]", T + 50_000);
  save(root, "AGENTS.md", "rules, edited\n", T + 50_000);
  save(root, "tests/test_flow.py", "def test(): assert 1\n", T + 50_000);
  const { changed, last } = changesOf({ root, app, skip: new Set(["data/orders.json"]) });
  assert.deepEqual(changed, [{ path: "backend/server.py", at: T + 30_000 }]);
  assert.deepEqual(last, { path: "backend/server.py", at: T + 30_000 });

  // An app this command did not start is compared by time alone.
  assert.deepEqual(changesOf({ root, app: { ...app, own: false, files: sourceOf(root, Object.keys(FILES), false) }, skip: new Set(["data/orders.json"]) }).changed.map((c) => c.path), ["backend/prompts.py", "backend/server.py"]);
});

test("a reloader is read from the command, the script it names, or the app's own output; a plain start is not one", () => {
  const root = repo({ "package.json": JSON.stringify({ scripts: { dev: "npm run serve", serve: "nodemon server.js", start: "node server.js" } }) });
  for (const said of [
    "uvicorn backend.server:app --reload", commandText("npm run dev", root), "python manage.py runserver", "node --watch server.js", "tsx watch src/index.ts", "next dev",
    "INFO:     Will watch for changes in these directories: ['/app']", "Watching for file changes with StatReloader", "[nodemon] restarting due to changes...", "WARNING:  WatchFiles detected changes in 'backend/server.py'. Reloading...",
  ]) assert.ok(RELOADER.test(said), said);
  for (const said of [
    "\"/beds/yunqiao/.venv/bin/python\" run.py", commandText("npm start", root), "go run .", "python manage.py runserver --noreload", "concurrently \"tsc --watch\" \"node dist/server.js\"", "vite",
    "INFO:     Uvicorn running on http://127.0.0.1:8105 (Press CTRL+C to quit)", "uvicorn backend.server:app --port 8105", "Loaded the airline policies",
  ]) assert.ok(!RELOADER.test(said), said);
  assert.equal(elapsedMs("03:07"), 187_000);
  assert.equal(elapsedMs("1-02:00:05"), 93_605_000);
});

// The verbs against a real app.json in a scratch home: the runner is this process, and the signal
// that would reach it notes a new start the way local.mjs does once the app answers.
function machine({ own = true, reloads = false, restart = "ok" } = {}) {
  const root = repo(FILES);
  const base = mkdtempSync(join(tmpdir(), "cortad-home-"));
  const project = "p1";
  const held = { pid: process.pid, startedAt: startedAtOf(), by: "test", state: "up", port: 8105, at: at(T).toISOString() };
  claimRunner(project, held, base);
  writeApp(project, { runner: process.pid, own, reloads, startedAt: at(T).toISOString(), files: sourceOf(root, Object.keys(FILES), own) }, base);
  let t = T + 120_000;
  const signals = [];
  const signal = (pid) => {
    signals.push(pid);
    if (restart === "ok") writeApp(project, { ...readApp(project, base), startedAt: at(t + 2_000).toISOString(), files: sourceOf(root, Object.keys(FILES)) }, base);
    // The command was already starting it again for the save, from just before the ask, and the
    // signal is that restart.
    else if (restart === "saving") writeApp(project, { ...readApp(project, base), startedAt: at(t - 1_000).toISOString(), files: sourceOf(root, Object.keys(FILES)) }, base);
    else writeRunner(project, { ...held, state: "failed", at: at(t + 2_000).toISOString(), error: "Your app exited 1 on restart.\nSyntaxError: invalid syntax" }, base);
  };
  const code = makeCode({ project, root, base, waitMs: 45_000, signal, now: () => t, sleep: async (ms) => { t += ms; } });
  const posted = [];
  const pending = { value: null, read() { return this.value; }, write(p) { this.value = p; } };
  const state = { run: { jobId: "old", finished: true } };
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/mcp/status?quiet=1")) return { status: 200, ok: true, text: async () => JSON.stringify({ app: { state: "ready-to-test" }, run: state.run }) };
    if (url.endsWith("/mcp/run") && init.method === "POST") { posted.push(JSON.parse(init.body)); return { status: 202, ok: true, text: async () => JSON.stringify({ started: true, jobId: "j1", kind: "verify" }) }; }
    return { status: 200, ok: true, text: async () => JSON.stringify({ jobId: "j1", kind: "verify", status: "running", played: 0, of: 4, finished: false, runId: "j1", findings: [] }) };
  };
  const verbs = makeVerbs({ api: "https://cortad.test/api", token: "k", runner: () => readRunner(project, base), fetchImpl, pending, code, now: () => t, sleep: async (ms) => { t += ms; } });
  return { root, base, verbs, signals, posted, pending, state };
}

test("an app this command started, whose code changed since, is started again before the verify, which says so and then which code it played", async () => {
  const m = machine();
  save(m.root, "backend/server.py", "app = FastAPI(dependencies=[gate])\n", T + 90_000);
  const out = await m.verbs.verify({ findingId: "access:4" });
  assert.deepEqual(m.signals, [process.pid]);
  assert.equal(m.posted.length, 1);
  assert.equal(out.text, [
    "Verify of access:4 started: j1.",
    "Your app was started again so this simulation plays your change (1 file changed since it started: backend/server.py).",
    "next: run_status j1",
  ].join("\n"));
  const status = await m.verbs.run_status({ jobId: "j1" });
  assert.equal(status.text.split("\n")[1], "App started 12:02:02, after your last change at 12:01:30.");
  assert.equal((await m.verbs.findings({})).text.split("\n")[1], "App started 12:02:02, after your last change at 12:01:30.");
});

test("an unchanged app, a reloader, or a simulation already playing is never started again", async () => {
  const same = machine();
  await same.verbs.run();
  assert.deepEqual(same.signals, []);
  assert.equal(same.pending.read().tested.change.path, "backend/server.py");

  const hot = machine({ reloads: true });
  save(hot.root, "backend/server.py", "changed\n", T + 90_000);
  await hot.verbs.run();
  assert.deepEqual(hot.signals, []);
  assert.equal((await hot.verbs.run_status({ jobId: "j1" })).text.split("\n")[1], "App started 12:00:00 and reloads itself on save; your last change was at 12:01:30.");

  const busy = machine();
  busy.state.run = { jobId: "j0", finished: false };
  save(busy.root, "backend/server.py", "changed\n", T + 90_000);
  await busy.verbs.run();
  assert.deepEqual(busy.signals, []);
});

test("a verify asked while the command is starting the app again for the save plays the saved code once it answers", async () => {
  const m = machine({ restart: "saving" });
  save(m.root, "backend/server.py", "app = FastAPI(dependencies=[gate])\n", T + 90_000);
  const out = await m.verbs.verify({ findingId: "access:4" });
  assert.equal(out.isError, undefined, out.text);
  assert.equal(m.posted.length, 1);
  assert.match(out.text, /^Verify of access:4 started: j1\.\nYour app was started again so this simulation plays your change/);
});

test("an app that does not come back after being started again stops the verify with its reason, and nothing is posted", async () => {
  const m = machine({ restart: "fails" });
  save(m.root, "backend/server.py", "app = FastAPI(\n", T + 90_000);
  const out = await m.verbs.verify({ findingId: "access:4" });
  assert.equal(out.isError, true);
  assert.equal(out.text, "Your app was started again to play your change and did not come back. Your app exited 1 on restart.\nSyntaxError: invalid syntax\nNothing ran.");
  assert.equal(m.posted.length, 0);
});

test("an app that was already running when the command started is not restarted; the simulation says it may have played the old code", async () => {
  const m = machine({ own: false });
  save(m.root, "backend/server.py", "app = FastAPI(dependencies=[gate])\n", T + 90_000);
  const out = await m.verbs.verify({ findingId: "access:4" });
  assert.deepEqual(m.signals, []);
  const warning = "Your app was already running when this command started and has been running since 12:00:00; backend/server.py changed at 12:01:30, so this simulation may have played the old code. Stop your app and run the command again.";
  assert.equal(out.text, `Verify of access:4 started: j1.\n${warning}\nnext: run_status j1`);
  assert.equal((await m.verbs.run_status({ jobId: "j1" })).text.split("\n")[1], warning);
});

test("a file the app itself wrote during a simulation is its data, not a change to its code", async () => {
  const m = machine();
  const dir = writesDirOf(homeOf("p1", m.base));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "written.jsonl"), `${JSON.stringify({ run: "session", path: "data/orders.json", before: null })}\n`);
  save(m.root, "data/orders.json", "[{\"id\":1}]", T + 90_000);
  await m.verbs.run();
  assert.deepEqual(m.signals, []);
});

test("a simulation sends the source files saved since the simulation it will be compared with; the app's data put back, tests and an unknown baseline send nothing", async () => {
  const root = repo(FILES);
  const base = mkdtempSync(join(tmpdir(), "cortad-home-"));
  const project = "p-scope";
  writeApp(project, { runner: process.pid, own: true, startedAt: at(T - 30_000).toISOString(), files: sourceOf(root, Object.keys(FILES)) }, base);
  const since = at(T).toISOString();
  save(root, "backend/prompts.py", "SYSTEM = 'be brief'\n", T + 30_000);
  save(root, "data/orders.json", "[]", T + 40_000);
  save(root, "tests/test_flow.py", "def test(): assert 1\n", T + 40_000);
  const code = makeCode({ project, root, base, waitMs: 1_000 });
  assert.deepEqual(code.saved(since), ["backend/prompts.py"], "the data file holds the bytes it had: put back, not changed");
  // Hashes taken after `since` are of the changed code: only the time can say.
  writeApp(project, { ...readApp(project, base), startedAt: at(T + 50_000).toISOString(), files: sourceOf(root, Object.keys(FILES)) }, base);
  assert.deepEqual(code.saved(since), ["backend/prompts.py", "data/orders.json"]);

  // The baseline's start is Cortad's clock; a save is this machine's, here running 20 seconds behind.
  save(root, "backend/server.py", "app = FastAPI(debug=True)\n", T - 20_000);
  assert.deepEqual(code.saved(since), ["backend/prompts.py", "backend/server.py", "data/orders.json"]);
  save(root, "backend/server.py", "app = FastAPI()\n", T - 60_000);

  const posted = [];
  let status = { app: { state: "ready-to-test" }, run: { jobId: "old", status: "succeeded" }, baseline: { jobId: "base-run", startedAt: since } };
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/mcp/status?quiet=1")) return { status: 200, ok: true, text: async () => JSON.stringify(status) };
    posted.push(JSON.parse(init.body));
    return { status: 202, ok: true, text: async () => JSON.stringify({ started: true, jobId: `j${posted.length}`, kind: "run" }) };
  };
  const verbs = makeVerbs({ api: "https://cortad.test/api", token: "k", runner: () => ({ state: "up", port: 8105 }), fetchImpl, pending: { read: () => null, write: () => {} }, code: { ...code, fresh: async () => ({}) } });
  await verbs.run();
  assert.deepEqual(posted[0], { change: { since: "base-run", files: ["backend/prompts.py", "data/orders.json"] } });
  await verbs.verify({ findingId: "finding:1" });
  assert.deepEqual(posted[1], { findingId: "finding:1" }, "a verify replays a finding and is never scoped");
  status = { ...status, baseline: undefined };
  await verbs.run();
  assert.deepEqual(posted[2], {}, "no simulation to compare with: the server replays everything");
});
