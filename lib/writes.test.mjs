import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { markRun, putBack, saidOf } from "./writes.mjs";

const HOOK = new URL("./trace.cjs", import.meta.url).pathname;
const PYHOOK = new URL("./pyhook/", import.meta.url).pathname;
// Logs an app writes under any name; a run never records them, so a put-back never removes them.
const LOGS = ["logs/app.log", "logs/app.jsonl", ".evlog/logs/d.jsonl", "server.log.1"];
const PY = ["python3", "python"].find((bin) => spawnSync(bin, ["--version"]).status === 0) ?? null;

function bed() {
  const dir = mkdtempSync(join(tmpdir(), "cortad-writes-"));
  const root = join(dir, "app");
  for (const d of ["data", "logs", "node_modules"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "data", "a.json"), "old");
  writeFileSync(join(root, "data", "keep.json"), "kept");
  const writes = join(dir, "home", "writes");
  const env = { ...process.env, CORTAD_TRACE_FILE: join(dir, "trace.jsonl"), CORTAD_WRITES_DIR: writes, CORTAD_APP_ROOT: root };
  const rows = () => { try { return readFileSync(join(writes, "written.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; } };
  return { dir, root, writes, env, rows };
}

test("a Node app's writes during a simulation are recorded with a copy from before, and put back when it ends", () => {
  const { dir, root, writes, env, rows } = bed();
  writeFileSync(join(dir, "app.cjs"), `
    const fs = require("node:fs"); const path = require("node:path"); const root = process.argv[2];
    fs.writeFileSync(path.join(root, "data/a.json"), "new");
    fs.writeFileSync(path.join(root, "data/a.json"), "newer");
    fs.appendFileSync(path.join(root, "data/new.json"), "made");
    fs.writeFileSync(path.join(root, "logs/app.log"), "noise");
    fs.writeFileSync(path.join(root, "logs/app.jsonl"), "noise");
    fs.mkdirSync(path.join(root, ".evlog/logs"), { recursive: true });
    fs.appendFileSync(path.join(root, ".evlog/logs/d.jsonl"), "noise");
    fs.writeFileSync(path.join(root, "server.log.1"), "noise");
    fs.writeFileSync(path.join(root, "node_modules/m.json"), "noise");
    fs.writeFileSync(path.join(__dirname, "outside.json"), "elsewhere");
    fs.promises.writeFile(path.join(root, "data/p.json"), "promised").then(() => fs.renameSync(path.join(root, "data/keep.json"), path.join(root, "data/moved.json")));
  `);
  const run = (at = root) => spawnSync(process.execPath, ["--require", HOOK, join(dir, "app.cjs"), at], { env, stdio: ["ignore", "pipe", "pipe"] });
  // No run marked: nothing recorded, the app runs as it always did.
  const quiet = bed();
  const before = spawnSync(process.execPath, ["--require", HOOK, join(dir, "app.cjs"), quiet.root], { env: quiet.env, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(before.status, 0, String(before.stderr));
  assert.deepEqual(quiet.rows(), []);
  markRun(writes, "job-1");
  const out = run();
  assert.equal(out.status, 0, String(out.stderr));
  const seen = rows();
  assert.deepEqual(seen.map((r) => r.path).sort(), ["data/a.json", "data/keep.json", "data/moved.json", "data/new.json", "data/p.json"]);
  assert.ok(seen.every((r) => r.run === "job-1"));
  assert.equal(readFileSync(seen.find((r) => r.path === "data/a.json").before, "utf8"), "old");
  assert.equal(seen.find((r) => r.path === "data/new.json").before, null);
  assert.equal(readFileSync(join(root, "data/a.json"), "utf8"), "newer");
  const said = putBack(writes, root);
  assert.match(said, /^Your app wrote to data\/a\.json, data\/new\.json, data\/p\.json and 2 more during this simulation; Cortad restored them afterwards\.$/);
  assert.equal(readFileSync(join(root, "data/a.json"), "utf8"), "old");
  assert.equal(readFileSync(join(root, "data/keep.json"), "utf8"), "kept");
  for (const gone of ["data/new.json", "data/p.json", "data/moved.json"]) assert.equal(existsSync(join(root, gone)), false, gone);
  for (const log of LOGS) assert.equal(readFileSync(join(root, log), "utf8"), "noise", log);
  assert.equal(existsSync(writes), false, "the record is cleared with the simulation");
  assert.equal(putBack(writes, root), "");
  markRun(writes, "job-2");
  markRun(writes, "job-3", { keep: true });
  assert.equal(readFileSync(join(writes, "run"), "utf8"), "job-2", "an open record is kept when asked");
});

test("a Python app's writes are recorded the same way", { skip: PY ? false : "no python" }, () => {
  const { dir, root, writes, env, rows } = bed();
  writeFileSync(join(dir, "app.py"), `
import json, os, pathlib, sys
root = sys.argv[1]
with open(os.path.join(root, "data/a.json"), "w") as f: json.dump({"n": 1}, f)
pathlib.Path(root, "data/new.json").write_text("made")
os.replace(os.path.join(root, "data/keep.json"), os.path.join(root, "data/moved.json"))
for log in ("logs/app.log", "logs/app.jsonl", ".evlog/logs/d.jsonl", "server.log.1"):
    os.makedirs(os.path.dirname(os.path.join(root, log)), exist_ok=True)
    with open(os.path.join(root, log), "a") as f: f.write("noise")
with open(os.path.join(root, "data/a.json")) as f: f.read()
`);
  markRun(writes, "job-2");
  const out = spawnSync(PY, [join(dir, "app.py"), root], { env: { ...env, PYTHONPATH: PYHOOK }, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(out.status, 0, String(out.stderr));
  assert.deepEqual(rows().map((r) => r.path).sort(), ["data/a.json", "data/keep.json", "data/moved.json", "data/new.json"]);
  assert.equal(readFileSync(join(root, "data/a.json"), "utf8"), '{"n": 1}');
  assert.match(putBack(writes, root), /^Your app wrote to data\/a\.json, data\/new\.json, data\/keep\.json and 1 more during this simulation; Cortad restored them afterwards/);
  assert.equal(readFileSync(join(root, "data/a.json"), "utf8"), "old");
  assert.equal(readFileSync(join(root, "data/keep.json"), "utf8"), "kept");
  assert.equal(existsSync(join(root, "data/new.json")), false);
  for (const log of LOGS) assert.equal(readFileSync(join(root, log), "utf8"), "noise", log);
});

test("the put-back line names one file or counts many", () => {
  assert.equal(saidOf(["backend/data/cart.json"]), "Your app wrote to backend/data/cart.json during this simulation; Cortad restored it afterwards.");
  assert.equal(saidOf([]), "");
});
