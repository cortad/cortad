import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homeOf, projectOf } from "./home.mjs";
import { forgetSignIn, keptSignIn, mintAfterYes, recordSignInYes, rememberSignIn } from "./sign-in.mjs";

const LOCAL = join(dirname(fileURLToPath(import.meta.url)), "..", "local.mjs");

test("the one sign-in is kept between connects, readable by the owner alone, until forgotten", () => {
  const home = join(mkdtempSync(join(tmpdir(), "cortad-signin-")), "project");
  assert.equal(keptSignIn(home), null);
  rememberSignIn(home, { name: "cookie", value: "session=abc", how: "signed in as the test account Cortad made on your app (t@example.com)" });
  assert.equal(statSync(join(home, "sign-in.json")).mode & 0o777, 0o600);
  const kept = keptSignIn(home);
  assert.deepEqual({ name: kept.name, value: kept.value }, { name: "cookie", value: "session=abc" });
  assert.match(kept.how, /kept from your last connect/);
  rememberSignIn(home, { name: "", value: "" });
  assert.equal(keptSignIn(home).value, "session=abc");
  forgetSignIn(home);
  assert.equal(keptSignIn(home), null);
  assert.equal(existsSync(join(home, "sign-in.json")), false);
});

test("a token signed with the app's JWT secret is made only once the yes is recorded on this machine", () => {
  const home = join(mkdtempSync(join(tmpdir(), "cortad-yes-")), "project");
  const env = { JWT_SECRET: "a-secret-of-the-app" };
  assert.equal(mintAfterYes(home, env), null, "with no yes here, whatever the server says, no token");
  recordSignInYes(home);
  assert.equal(statSync(join(home, "sign-in-yes.json")).mode & 0o777, 0o600);
  assert.match(mintAfterYes(home, env).value, /^Bearer eyJ/);
});

// The real MCP server, as a coding agent starts it: the yes is on disk before the server hears of it.
test("the agent's test with account make records the yes in ~/.cortad, readable by the owner alone, before it is sent on", { timeout: 30_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cortad-yes-root-")));
  const home = realpathSync(mkdtempSync(join(tmpdir(), "cortad-yes-home-")));
  const cortad = homeOf(projectOf(root), join(home, ".cortad"));
  mkdirSync(cortad, { recursive: true });
  writeFileSync(join(cortad, "token"), "machine-key");
  const atRun = [];
  const api = createServer(async (req, res) => {
    for await (const _ of req) { /* drained */ }
    if (req.url === "/api/mcp/run") {
      const file = join(cortad, "sign-in-yes.json");
      atRun.push(existsSync(file) ? statSync(file).mode & 0o777 : null);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/api/mcp/run" ? { recorded: true, note: "Recorded." } : {}));
  }).listen(0, "127.0.0.1");
  await once(api, "listening");
  const child = spawn(process.execPath, [LOCAL, "mcp"], { cwd: root, env: { PATH: process.env.PATH, HOME: home, CORTAD_ORIGIN: `http://127.0.0.1:${api.address().port}` }, stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "test", arguments: { account: "make" } } })}\n`);
    for (let i = 0; i < 200 && !out.includes("\n"); i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.match(JSON.parse(out).result.content[0].text, /Recorded\./);
    assert.deepEqual(atRun, [0o600], "the yes was not on this machine when the server heard of it");
  } finally { child.kill(); api.close(); }
});
