import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { homeOf, projectOf } from "./home.mjs";

// The whole command against a small app and a stand-in for our API that hands it jobs and keeps
// every body the command sends, to check what leaves this machine.
const LOCAL = join(dirname(fileURLToPath(import.meta.url)), "..", "local.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (done, ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await done()) return true; return done(); };

async function listening(handler) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

const APP = (port) => `
  console.log("serving " + require("node:path").join(__dirname, "app.js") + " for " + require("node:os").homedir());
  require("node:http").createServer((req, res) => res.end("{}")).listen(${port}, "127.0.0.1");
`;

// `flags`: added to the command line. `files`: written into the project. `env`: the app's terminal.
async function connected({ flags = [], files = {}, env = {}, status = {} } = {}) {
  const queued = [];
  const results = new Map();
  const bodies = [];
  const api = await listening(async (req, res) => {
    let body = "";
    for await (const d of req) body += d;
    if (!req.url.includes("/tree")) bodies.push(body);
    const reply = (data) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/local/attach") return reply({ box: "lo_000000000000000000000007", key: "k" });
    if (req.url.includes("/tree")) return reply({ id: "c", resumed: true });
    if (req.url.startsWith("/api/mcp/status")) return reply(status);
    const done = /\/jobs\/([\w-]+)$/.exec(req.url);
    if (done) { results.set(done[1], JSON.parse(body || "{}")); return reply({ ok: true }); }
    if (req.url.includes("/jobs")) { await until(() => queued.length > 0, 500); return reply({ jobs: queued.splice(0) }); }
    reply({ ok: true });
  });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cortad-out-")));
  const probe = await listening(() => {});
  const port = probe.address().port;
  probe.close();
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "out", version: "1.0.0" }));
  writeFileSync(join(root, "app.js"), APP(port));
  for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); }
  const home = realpathSync(mkdtempSync(join(tmpdir(), "cortad-out-home-")));
  const cortad = homeOf(projectOf(root), join(home, ".cortad"));
  mkdirSync(cortad, { recursive: true });
  writeFileSync(join(cortad, "token"), "machine-key");
  const child = spawn(process.execPath, [LOCAL, "--token", ...flags, "--start", `"${process.execPath}" app.js`], {
    cwd: root, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, TMPDIR: tmpdir(), CORTAD_ORIGIN: `http://127.0.0.1:${api.address().port}`, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  let n = 0;
  const job = async (verb, body = {}, ms = 20_000) => {
    const id = `j${++n}`;
    queued.push({ id, verb, body });
    assert.ok(await until(() => results.has(id), ms), out);
    return results.get(id);
  };
  assert.ok(await until(() => /your app is answering on port/.test(out), 30_000), out);
  return {
    root, home, cortad, port, job, bodies, output: () => out,
    stop: async () => { child.kill("SIGTERM"); await once(child, "exit"); api.closeAllConnections(); api.close(); },
  };
}

test("--no-samples answers the sample verb with nothing opened, and --agent-picks implies it", { timeout: 90_000 }, async () => {
  for (const flag of ["--no-samples", "--agent-picks"]) {
    const asked = [];
    const store = await listening((req, res) => { asked.push(req.url); res.end("{}"); });
    const env = { QDRANT_URL: `http://127.0.0.1:${store.address().port}` };
    const app = await connected({ flags: [flag], env, files: { "src/agent.js": "export const x = 1;\n" } });
    try {
      const got = await app.job("sample", { stores: [{ road: "retrieval.vector", kind: "qdrant", env: ["QDRANT_URL"] }] });
      assert.deepEqual(got, { report: { stores: [], off: true } }, flag);
      assert.deepEqual(asked, [], `${flag}: the store was opened`);
    } finally { await app.stop(); store.close(); }
  }
});

const AGENT = `import OpenAI from "openai";
const client = new OpenAI();
export const answer = (q) => client.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "system", content: "You answer refund questions for the shop." }, { role: "user", content: q }] });
`;

test("a read the server asks for never reaches a data file, an eval set among them", { timeout: 60_000 }, async () => {
  const app = await connected({ files: { "src/agent.js": AGENT, "evals/refunds.jsonl": '{"input":"can I get a refund?","expected":"yes"}\n', "evals/big.json": JSON.stringify({ cases: "x".repeat(70_000) }) } });
  try {
    assert.match((await app.job("read", { path: "/workspace/repo/src/agent.js" })).content, /refund questions/);
    assert.deepEqual(await app.job("read", { path: "/workspace/repo/evals/refunds.jsonl" }), { error: "bad path" });
    assert.deepEqual(await app.job("read", { path: "/workspace/repo/evals/big.json" }), { error: "bad path" });
  } finally { await app.stop(); }
});

// The server names the variables a sample reads. One from the shell (PWD is the project itself) or a
// file the upload would never send is not its to open.
test("sample opens no folder a shell variable names, and in a folder the app's env names only files the upload could send", { timeout: 60_000 }, async () => {
  const app = await connected({
    env: { PWD: ".", INIT_CWD: ".", DOCS_DIR: "docs" },
    files: {
      "src/agent.js": AGENT, ".env": "BOOKS_DIR=docs\n", ".gitignore": "docs/private.md\n",
      "docs/guide.md": "# Refund guide\n", "docs/private.md": "# PRIVATE-NOTES\n", "docs/orders.csv": "id,name\n1,ORDER-ROW\n",
    },
  });
  try {
    const shell = await app.job("sample", { stores: [{ road: "retrieval.files", kind: "files", env: ["PWD", "INIT_CWD", "DOCS_DIR"] }] });
    assert.deepEqual(shell.report.stores.map((s) => [s.status, s.rows]), [["no-store", []]]);
    const named = await app.job("sample", { stores: [{ road: "retrieval.files", kind: "files", env: ["BOOKS_DIR"] }] });
    assert.deepEqual(named.report.stores[0].rows, [{ where: "BOOKS_DIR#guide.md", fields: { file: "guide.md", heading: "Refund guide" } }]);
    assert.doesNotMatch(JSON.stringify(named), /PRIVATE-NOTES|private\.md|ORDER-ROW|orders\.csv/);
  } finally { await app.stop(); }
});

test("a read reaches only a file already sent: the app's output and this program's temp folder answer bad path, and log stays capped", { timeout: 60_000 }, async () => {
  const app = await connected({ files: { "src/agent.js": AGENT } });
  try {
    assert.equal((await app.job("write", { path: "/tmp/notes.txt", b64: Buffer.from("scratch").toString("base64") })).success, true);
    for (const path of ["/tmp/bl-boot.log", "/tmp/boot.log", join(app.cortad, "app.log"), "/tmp/notes.txt"]) {
      assert.deepEqual(await app.job("read", { path }), { error: "bad path" }, path);
    }
    const log = await app.job("log", { bytes: 1_000_000 });
    assert.match(log.text, /serving app\.js/);
    assert.ok(log.text.length <= 2000, `${log.text.length} characters`);
  } finally { await app.stop(); }
});

test("no absolute path or home folder leaves the machine: the log reply names no folder, and its paths are the project's", { timeout: 60_000 }, async () => {
  const app = await connected({ files: { "src/agent.js": AGENT } });
  try {
    const log = await app.job("log", { bytes: 2000 });
    assert.equal(log.root, undefined);
    assert.ok(log.files.includes("src/agent.js"), "the sent files come with it, for the server to place a relative traceback path");
    assert.match(log.text, /serving app\.js for ~/);
    const sent = app.bodies.join("\n");
    assert.ok(!sent.includes(app.root) && !sent.includes(app.home), `a body carried ${app.root} or ${app.home}`);
  } finally { await app.stop(); }
});

test("the test command's output is sent as its last 20,000 characters, masked", { timeout: 120_000, skip: process.platform !== "darwin" }, async () => {
  const secret = "s3cret-value-of-the-app-0123456789";
  const app = await connected({
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` },
    files: {
      ".env": `APP_PASSWORD=${secret}\n`,
      "package.json": JSON.stringify({ name: "out", version: "1.0.0", scripts: { test: `node -e "process.stdout.write('x'.repeat(2e6) + ' ${secret} END')"` } }),
    },
  });
  try {
    const got = await app.job("exec", { op: "test" }, 100_000);
    assert.ok(got.stdout.length + got.stderr.length <= 20_000, `${got.stdout.length + got.stderr.length} characters`);
    assert.match(got.stdout, /END$/, JSON.stringify(got).slice(0, 400));
    assert.ok(!JSON.stringify(got).includes(secret), "the value was sent unmasked");
  } finally { await app.stop(); }
});

test("a project whose hidden list is too long for the sandbox gets its test command refused, with why", { timeout: 120_000, skip: process.platform !== "darwin" }, async () => {
  const files = Object.fromEntries(Array.from({ length: 9000 }, (_, i) => [`services/s${i}.env`, `S${i}=1\n`]));
  files["package.json"] = JSON.stringify({ name: "out", version: "1.0.0", scripts: { test: "node -e 1" } });
  const app = await connected({ files });
  try {
    const got = await app.job("exec", { op: "test" });
    assert.equal(got.exitCode, 126);
    assert.match(got.stderr, /^refused: running your tests is off for this project: .* 9,000 files and folders .* sandbox-exec would not start with that list/);
    assert.match(app.output(), /running your tests is off for this project/);
  } finally { await app.stop(); }
});
