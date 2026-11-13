import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL = join(dirname(fileURLToPath(import.meta.url)), "..", "local.mjs");

test("eval and gold files are sent whether or not git ignores them; other ignored files and secrets are not", () => {
  const root = mkdtempSync(join(tmpdir(), "cortad-sent-"));
  const home = mkdtempSync(join(tmpdir(), "cortad-sent-home-"));
  try {
    const put = (path, text = "x\n") => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
    put("package.json", '{ "name": "sent-files", "version": "1.0.0" }\n');
    put("src/app.js", "console.log(1)\n");
    put(".gitignore", "evals/\ndata/\nprivate/\n.env\n");
    put("evals/refunds.jsonl");
    put("evals/nested/cases.yaml");
    put("data/orders.gold.csv");
    put("data/eval_set.jsonl");
    put("data/customers.csv");
    put("private/retrieval.py");
    put("evals/signing.pem");
    put(".env", "OPENAI_API_KEY=sk-test-0123456789abcdef\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    const out = execFileSync(process.execPath, [LOCAL, "--explain"], { cwd: root, env: { ...process.env, HOME: home, CORTAD_NO_REGISTER: "1" } }).toString();
    const sent = /^looked at\s+(.*)$/m.exec(out)[1].split(", ").sort();
    assert.deepEqual(sent, [".gitignore", "data/eval_set.jsonl", "data/orders.gold.csv", "evals/nested/cases.yaml", "evals/refunds.jsonl", "package.json", "src/app.js"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
