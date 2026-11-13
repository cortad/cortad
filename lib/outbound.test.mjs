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
