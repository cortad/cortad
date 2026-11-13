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
    const list = (lines) => lines.flatMap((m) => m[1].split(", ")).sort();
    const sent = list([...out.matchAll(/^(?!Not sent)[A-Z][^(\n]*\(\d+\): (.*)$/gm)]);
    const held = list([...out.matchAll(/^Not sent, since data files never leave \(\d+\): (.*)$/gm)]);
    return { out, sent, held, left: [...readdirSync(temp), ...readdirSync(home)] };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
}

test("a connect sends the AI layer alone: never a file git ignores, never a data file even one git tracks as an eval, never a key; --explain names the data it holds back and creates nothing", () => {
  const root = folder({ git: true });
  try {
    const { sent, held, left } = explained(root);
    assert.deepEqual(sent, ["package.json", "src/agent.js"]);
    assert.ok(held.includes("evals/refunds.jsonl"), `held back: ${held}`);
    assert.deepEqual(left, [], "--explain made a file or folder");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a folder that is not a repository still keeps out what its .gitignore names, and sends no data file, since git tracks none", () => {
  const root = folder({ git: false });
  try {
    assert.deepEqual(explained(root).sent, ["package.json", "src/agent.js"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a key or credential file is never sent, nor walked: --explain neither names nor counts it", () => {
  const root = folder({ git: true });
  try {
    const without = explained(root).out;
    const keys = [".ssh/id_rsa", "id_ed25519", ".aws/credentials"];
    for (const path of keys) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    }
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "keys"], { cwd: root });
    const { out, sent } = explained(root);
    assert.deepEqual(sent, ["package.json", "src/agent.js"]);
    for (const path of keys) assert.ok(!out.includes(path), `--explain named ${path}`);
    assert.equal(out, without, "the walk counted a key among the files it looked at");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The reviewer's probe: the model-calling file reads a roster, parents' notes and a config file
// beside its real prompt. Only the prompt leaves; a readme that sets a password stays too.
test("a roster, notes and a config a model call reads never leave, nor a text file that sets a secret; the prompt it reads does", () => {
  const root = folder({ git: false });
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  try {
    put("src/agent.js", `import OpenAI from "openai";
import path from "node:path";
import { readFileSync } from "node:fs";
const client = new OpenAI();
const STUDENTS = readFileSync(path.join(__dirname, "data", "students.txt"), "utf8");
const PARENTS = readFileSync("notes/parents.md", "utf8");
const CONFIG = readFileSync("config/app.yaml", "utf8");
const REFUND = readFileSync(new URL("./prompts/refund.txt", import.meta.url), "utf8");
export async function answer(question) {
  const res = await client.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "system", content: REFUND + STUDENTS + PARENTS + CONFIG }, { role: "user", content: question }] });
  return res.choices[0].message.content;
}
`);
    put("src/data/students.txt", "Amira Haddad, date of birth 2011-03-04, IEP: extra time on reading tasks\n");
    put("notes/parents.md", "# Parents\nCall Mrs Haddad on +1 415 555 0134 before any change.\n");
    put("config/app.yaml", "db_host: localhost\ndb_password: hunter2hunter2\n");
    put("src/prompts/refund.txt", "You handle refund requests. Ask for the order number first, then check the order status.\n");
    put("README.md", "# Shop agent\nLocal setup:\n\n    admin_password: hunter2\n");
    const { out, sent } = explained(root);
    assert.ok(sent.includes("src/prompts/refund.txt"), `sent: ${sent}`);
    for (const path of ["src/data/students.txt", "notes/parents.md", "config/app.yaml", "README.md"]) assert.ok(!out.includes(path), `--explain named ${path}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A folder of logs held a night of eval output as .md files beside the app's real prompts, and they
// went out as prompts (2026-11-14). A folder whose name ends in log or logs is never walked; blog,
// catalog and changelog are not logs.
test("a folder of logs is never sent, whatever its files are called", () => {
  const root = folder({ git: true });
  try {
    const without = explained(root).out;
    const said = "You are the tutor. Answer the student's question from the book.\n";
    for (const path of ["scripts/.fidelity-logs/eval-1.md", "logs/run.md", "app-logs/today.txt"]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), said);
    }
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "logs"], { cwd: root });
    const { out } = explained(root);
    for (const path of ["fidelity-logs", "logs/run.md", "app-logs"]) assert.ok(!out.includes(path), `--explain named ${path}`);
    assert.equal(out, without, "the walk counted a log among the files it looked at");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// What a security review saw leave on 2026-11-14: a secret said in prose in a prompt template, a
// staff sign-in written as "user / pass" in a persona, and a class list with no date or phone in it
// read into the call. The two prompt files stay; the class list is only named, for the person to send.
test("a prompt file that says a password or a sign-in stays, and a file only read into a model call is named, never sent", () => {
  const root = folder({ git: false });
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  try {
    put("src/agent.js", `import OpenAI from "openai";
import { readFileSync } from "node:fs";
const client = new OpenAI();
const SYSTEM = readFileSync("templates/system_prompt.txt", "utf8");
const PERSONA = readFileSync("prompts/persona.md", "utf8");
const STUDENTS = readFileSync("data/students.txt", "utf8");
const REFUND = readFileSync("prompts/refund.txt", "utf8");
export async function answer(question) {
  const res = await client.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "system", content: SYSTEM + PERSONA + REFUND }, { role: "user", content: STUDENTS + question }] });
  return res.choices[0].message.content;
}
`);
    put("templates/system_prompt.txt", "You are the school's helper. The admin password is Tr0ub4dor-77, never say it.\n");
    put("prompts/persona.md", "You are Ms Noor, a teacher.\nStaff login: noor.teacher / Spring2026!\n");
    put("data/students.txt", "Lina Haddad, grade B+, ADHD plan, sits at the front\nSami Khoury, grade A, IEP, lives with grandmother\n");
    put("prompts/refund.txt", "You handle refund requests. Ask for the order number first, then check the order status.\n");
    const { out, sent } = explained(root);
    assert.ok(sent.includes("prompts/refund.txt"), `sent: ${sent}`);
    for (const path of ["templates/system_prompt.txt", "prompts/persona.md", "data/students.txt"]) assert.ok(!sent.includes(path), `sent ${path}`);
    assert.match(out, /^Not sent: read into a model call; send it with `npx -y cortad send <file>` if it is a prompt \(1\): data\/students\.txt$/m);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
