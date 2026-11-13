// --agent-picks: the connect sends no file, and the person's agent sends the ones it picked.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const LOCAL = join(dirname(fileURLToPath(import.meta.url)), "..", "local.mjs");
const KEY = "sk-test-0123456789abcdefghij";

function folder() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cortad-picks-")));
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  put("package.json", JSON.stringify({ name: "picks", scripts: { start: "node server.js" } }));
  put("server.js", 'require("node:http").createServer((q, s) => s.end("{}")).listen(process.env.PORT, "127.0.0.1");\n');
  put("src/agent.js", 'import OpenAI from "openai";\nconst client = new OpenAI();\nexport const answer = (q) => client.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "system", content: "You answer refund questions for the shop." }, { role: "user", content: q }] });\n');
  put("src/other.js", "export const unrelated = 1;\n");
  put(".gitignore", ".env\nprivate/\n");
  put("private/agent.js", "export const hidden = 1;\n");
  put("data/users.csv", "id,name\n1,a\n");
  put("src/config.js", `export const key = "${KEY}";\n`);
  put(".env", `OPENAI_API_KEY=${KEY}\n`);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });
  return root;
}

// A stand-in for the server: each tree it was sent, as the list of files in the archive, and the
// answers to the reads it asked for once it had one.
async function api(work) {
  const seen = { trees: [], apps: 0, reads: new Map() };
  const asks = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const d of req) chunks.push(d);
    const body = Buffer.concat(chunks);
    const reply = (data, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/local/attach") return reply({ box: "lo_0123456789abcdef01234567", key: "k" });
    if (req.url.includes("/tree")) {
      const archive = join(work, `tree-${seen.trees.length}.tgz`);
      writeFileSync(archive, body);
      seen.trees.push(execFileSync("tar", ["-tzf", archive]).toString().split("\n").filter(Boolean).sort());
      if (seen.trees.length === 1) asks.push(...["src/agent.js", "src/other.js"].map((p, i) => ({ id: `j${i}`, verb: "read", body: { path: `/workspace/repo/${p}` } })));
      return reply({ id: "c", machineKey: "cm_test" });
    }
    if (req.url.endsWith("/app")) { seen.apps += 1; return reply({ ok: true }); }
    const job = req.url.match(/\/jobs\/(j\d)$/);
    if (job) { seen.reads.set(job[1], JSON.parse(body.toString())); return reply({ ok: true }); }
    if (req.url.includes("/jobs")) return setTimeout(() => reply({ jobs: asks.splice(0) }), 300);
    reply({ ok: true });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, seen, origin: `http://127.0.0.1:${server.address().port}` };
}

const until = async (check, ms = 20_000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (check()) return; throw new Error("timed out"); };

test("--agent-picks connects and starts the app with nothing sent; send refuses what may not leave, previews, sends on --yes and adds; a read reaches only the sent files", { timeout: 90_000 }, async () => {
  const root = folder();
  const home = mkdtempSync(join(tmpdir(), "cortad-picks-home-"));
  const work = mkdtempSync(join(tmpdir(), "cortad-picks-work-"));
  const { server, seen, origin } = await api(work);
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(), CORTAD_NO_REGISTER: "1", CORTAD_ORIGIN: origin };
  // Not execFileSync: the stand-in server answers the send's upload from this same process.
  const cortad = (...args) => new Promise((r) => execFile(process.execPath, [LOCAL, ...args], { cwd: root, env }, (_e, stdout, stderr) => r(`${stdout}${stderr}`.trim())));
  const child = spawn(process.execPath, [LOCAL, "ABCD2345", "--agent-picks", "--", "node", "server.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  try {
    await until(() => /connected: Cortad is watching your app/.test(out));
    assert.match(out, /it has none of your files yet, and your coding agent picks them/);
    assert.deepEqual(seen.trees, [], "the connect sent a file");
    assert.equal(seen.apps, 0, "the app was announced before there was code to tie it to");

    const status = await cortad("status");
    assert.match(status, /^You pick the files Cortad gets, and none has been sent yet\. Cortad needs:\n1\. Every prompt/);
    assert.match(status, /\nnext: npx -y \S+ send <file> <file> \.\.\.$/m);

    const preview = await cortad("send", "src/agent.js", ".env", "private/agent.js", "data/users.csv", "src/config.js", "../outside.js");
    assert.match(preview, /^Cortad would get this file:\n- src\/agent\.js: covers model calls\n/);
    assert.match(preview, /- \.env: an env file\n/);
    assert.match(preview, /- private\/agent\.js: git ignores it\n/);
    assert.match(preview, /- data\/users\.csv: a data file; one leaves only as an eval file git tracks\n/);
    assert.match(preview, /- src\/config\.js: it holds a value from your env\n/);
    assert.match(preview, /- \.\.\/outside\.js: no such file in this folder\n/);
    assert.match(preview, /next: npx -y \S+ send --yes src\/agent\.js$/);
    assert.deepEqual(seen.trees, [], "a preview sent a file");

    assert.match(await cortad("send", "--yes", ".env"), /- \.env: an env file\nNothing was sent\./);
    assert.match(await cortad("send", "--yes", "src/agent.js", ".env"), /^Sent 1 file\. Cortad now has 1 file from this folder, and is studying your AI from them\./);
    assert.deepEqual(seen.trees, [["src/agent.js"]]);
    await until(() => seen.apps > 0);

    await until(() => seen.reads.size === 2);
    assert.match(seen.reads.get("j0").content, /refund questions/);
    assert.deepEqual(seen.reads.get("j1"), { error: "bad path" }, "a file never sent was read");

    assert.match(await cortad("send", "--yes", "package.json"), /^Sent 1 file\. Cortad now has 2 files from this folder/);
    assert.deepEqual(seen.trees[1], ["package.json", "src/agent.js"]);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
    server.close();
    for (const dir of [root, home, work]) rmSync(dir, { recursive: true, force: true });
  }
});

test("send without a connect in --agent-picks says so and sends nothing", () => {
  const root = folder();
  const home = mkdtempSync(join(tmpdir(), "cortad-picks-home-"));
  try {
    let said = "";
    try { execFileSync(process.execPath, [LOCAL, "send", "src/agent.js"], { cwd: root, env: { PATH: process.env.PATH, HOME: home }, stdio: "pipe" }); } catch (e) { said = String(e.stdout); }
    assert.match(said, /^Nothing was sent: no Cortad connect is running in this folder\./);
  } finally { for (const dir of [root, home]) rmSync(dir, { recursive: true, force: true }); }
});
