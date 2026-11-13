import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL = join(dirname(fileURLToPath(import.meta.url)), "..", "local.mjs");

const AGENT = `import OpenAI from "openai";
const client = new OpenAI();
export async function answer(question) {
  const res = await client.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "system", content: "You answer refund questions for the shop." }, { role: "user", content: question }] });
  return res.choices[0].message.content;
}
`;
const CASE = '{"input":"can I get a refund?","expected":"yes"}\n';

// A folder with an AI layer, a second one its .gitignore keeps out, an eval set git tracks, one it
// ignores, one it has not seen, a data file and a key. `git`: made a repository, with everything but the ignored files committed.
function folder({ git }) {
  const root = mkdtempSync(join(tmpdir(), "cortad-sent-"));
  const put = (path, text = "x\n") => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  put("package.json", '{ "name": "sent-files", "version": "1.0.0", "dependencies": { "openai": "^4.0.0" } }\n');
  put("src/agent.js", AGENT);
  put(".gitignore", "evals/ignored/\nprivate/\n*.gold.jsonl\n.env\n");
  put("evals/refunds.jsonl", CASE);
  put("evals/ignored/cases.jsonl", CASE);
  put("evals/orders.gold.jsonl", CASE);
  put("private/agent.js", AGENT);
  put("data/customers.csv", "id,name\n1,a\n");
  put(".env", "OPENAI_API_KEY=sk-test-0123456789abcdef\n");
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });
  }
  put("evals/new.jsonl", CASE);
  return root;
}

// What --explain says a connect sends, read off its lines, and whether it left anything behind.
function explained(root) {
  const home = mkdtempSync(join(tmpdir(), "cortad-sent-home-"));
  const temp = mkdtempSync(join(tmpdir(), "cortad-sent-tmp-"));
  try {
    const out = execFileSync(process.execPath, [LOCAL, "--explain"], { cwd: root, env: { ...process.env, HOME: home, TMPDIR: temp, CORTAD_NO_REGISTER: "1" } }).toString();
    const sent = [...out.matchAll(/^[A-Z][^(\n]*\(\d+\): (.*)$/gm)].flatMap((m) => m[1].split(", ")).sort();
    return { sent, left: [...readdirSync(temp), ...readdirSync(home)] };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
}

test("a connect sends the AI layer alone: never a file git ignores, never data git does not track as an eval, never a key; --explain creates nothing", () => {
  const root = folder({ git: true });
  try {
    const { sent, left } = explained(root);
    assert.deepEqual(sent, ["evals/refunds.jsonl", "package.json", "src/agent.js"]);
    assert.deepEqual(left, [], "--explain made a file or folder");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a folder that is not a repository still keeps out what its .gitignore names, and sends no data file, since git tracks none", () => {
  const root = folder({ git: false });
  try {
    assert.deepEqual(explained(root).sent, ["package.json", "src/agent.js"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
