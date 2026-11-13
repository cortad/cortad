import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hookOutput, stick, unstick } from "./stick.mjs";

const LINE = "After changing prompts, tools, models or retrieval, check with Cortad before committing: npx cortad status";
const HOOK = "npx cortad status --changed --hook";
const NEWS = "npx cortad news --hook";
const latest = { spec: "cortad@latest" };
const repo = () => mkdtempSync(join(tmpdir(), "cortad-stick-"));
const read = (root, rel) => readFileSync(join(root, rel), "utf8");

test("stick writes the line, the Cursor rule and both hooks, keeps what was there, and twice changes nothing", () => {
  const root = repo();
  writeFileSync(join(root, "CLAUDE.md"), "# House rules\n\nTabs, not spaces.");
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(npm test)"] }, hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] } }));

  assert.deepEqual(stick(root, latest), [
    `AGENTS.md: added "${LINE}"`,
    "CLAUDE.md: added the same line",
    ".github/copilot-instructions.md: added the same line",
    ".cursor/rules/cortad.mdc: written, with the same line, applied always",
    `.claude/settings.json: added a PostToolUse hook on Edit|Write that runs ${HOOK}, and a UserPromptSubmit hook that runs ${NEWS}`,
    `.codex/hooks.json: added a PostToolUse hook on Edit|Write that runs ${HOOK}, and a UserPromptSubmit hook that runs ${NEWS}`,
  ]);
  assert.equal(read(root, "AGENTS.md"), `${LINE}\n`);
  assert.equal(read(root, "CLAUDE.md"), `# House rules\n\nTabs, not spaces.\n\n${LINE}\n`);
  assert.equal(read(root, ".cursor/rules/cortad.mdc"), `---\ndescription: Checking AI behavior with Cortad\nalwaysApply: true\n---\n${LINE}\n`);
  const claude = JSON.parse(read(root, ".claude/settings.json"));
  assert.deepEqual(claude.permissions, { allow: ["Bash(npm test)"] });
  assert.deepEqual(claude.hooks.PostToolUse, [
    { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] },
    { matcher: "Edit|Write", hooks: [{ type: "command", command: HOOK }] },
  ]);
  assert.deepEqual(claude.hooks.UserPromptSubmit, [{ hooks: [{ type: "command", command: NEWS }] }]);
  assert.deepEqual(JSON.parse(read(root, ".codex/hooks.json")), { hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: HOOK }] }], UserPromptSubmit: [{ hooks: [{ type: "command", command: NEWS }] }] } });

  assert.ok(stick(root, latest).every((line) => line.endsWith(": nothing to change")));
});

test("unstick takes out exactly what stick put in, and removes a file that held nothing else", () => {
  const root = repo();
  writeFileSync(join(root, "CLAUDE.md"), "# House rules\n");
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: [] } }));
  stick(root, latest);
  const said = unstick(root);
  assert.deepEqual(said, [
    "AGENTS.md: removed, it had only what stick wrote",
    "CLAUDE.md: removed the line",
    ".github/copilot-instructions.md: removed, it had only what stick wrote",
    ".cursor/rules/cortad.mdc: removed, it had only what stick wrote",
    ".claude/settings.json: removed the hooks",
    ".codex/hooks.json: removed, it had only what stick wrote",
  ]);
  assert.equal(read(root, "CLAUDE.md"), "# House rules\n");
  assert.deepEqual(JSON.parse(read(root, ".claude/settings.json")), { permissions: { allow: [] } });
  for (const rel of ["AGENTS.md", ".github", ".cursor", ".codex"]) assert.ok(!existsSync(join(root, rel)), rel);
  assert.ok(existsSync(join(root, ".claude", "settings.json")));
  assert.ok(unstick(root).every((line) => line.endsWith(": nothing to change")));
});

test("a settings file that is not JSON, or a path that leads out of the repository, is left alone", () => {
  const root = repo();
  const elsewhere = repo();
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "settings.json"), "{ not json");
  symlinkSync(join(elsewhere, "target.md"), join(root, "AGENTS.md"));
  symlinkSync(elsewhere, join(root, ".codex"));
  const said = stick(root, latest);
  assert.equal(said[0], "AGENTS.md: left alone, it points outside this repository");
  assert.equal(said[4], ".claude/settings.json: left alone, it is not valid JSON");
  assert.equal(said[5], ".codex/hooks.json: left alone, it points outside this repository");
  assert.ok(!existsSync(join(elsewhere, "target.md")) && !existsSync(join(elsewhere, "hooks.json")));
  assert.equal(read(root, ".claude/settings.json"), "{ not json");
});

test("the lines name the spec the connect ran with, and unstick finds them under any spec", () => {
  const root = repo();
  stick(root, { spec: "cortad@next" });
  assert.match(read(root, "AGENTS.md"), /before committing: npx cortad@next status\n$/);
  assert.equal(JSON.parse(read(root, ".codex/hooks.json")).hooks.PostToolUse[0].hooks[0].command, "npx cortad@next status --changed --hook");
  assert.ok(stick(root, latest).every((line) => line.endsWith(": nothing to change")));
  unstick(root);
  assert.ok(!existsSync(join(root, "AGENTS.md")) && !existsSync(join(root, ".codex/hooks.json")));
});

test("the hook answer is the shape Claude Code and Codex read after an edit, and on the person's prompt", () => {
  assert.deepEqual(JSON.parse(hookOutput("Changed since simulation r: a.ts (finding:1).")), { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "Changed since simulation r: a.ts (finding:1)." } });
  assert.deepEqual(JSON.parse(hookOutput("Run r finished: 4 findings in 37 conversations. Call findings.", "UserPromptSubmit")), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "Run r finished: 4 findings in 37 conversations. Call findings." } });
});

test("a repository that already has the after-edit hook gets the prompt hook beside it, once", () => {
  const root = repo();
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: HOOK }] }] } }));
  assert.equal(stick(root, latest)[4], `.claude/settings.json: added a UserPromptSubmit hook that runs ${NEWS}`);
  const claude = JSON.parse(read(root, ".claude/settings.json"));
  assert.deepEqual(claude.hooks.PostToolUse, [{ matcher: "Edit|Write", hooks: [{ type: "command", command: HOOK }] }]);
  assert.deepEqual(claude.hooks.UserPromptSubmit, [{ hooks: [{ type: "command", command: NEWS }] }]);
  assert.ok(stick(root, latest).every((line) => line.endsWith(": nothing to change")));
});

test("unstick in a repository that held nothing else leaves the repository itself in place", () => {
  const root = repo();
  stick(root, latest);
  unstick(`${root}/`);
  assert.ok(existsSync(root));
});

test("another tool's hook of the same shape is not Cortad's: stick adds its own beside it and unstick leaves it", () => {
  const root = repo();
  const theirs = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "npx othertool news --hook" }] }] } };
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify(theirs));
  stick(root, latest);
  assert.deepEqual(JSON.parse(read(root, ".claude/settings.json")).hooks.UserPromptSubmit.map((e) => e.hooks[0].command), ["npx othertool news --hook", NEWS]);
  unstick(root);
  assert.deepEqual(JSON.parse(read(root, ".claude/settings.json")), theirs);
});

test("a tool started from a folder is never taken for ours, while the folder this command runs from is", () => {
  const root = repo();
  const theirs = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "npx /opt/acme/bin/notes news --hook" }] }] } };
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify(theirs));
  const local = { spec: "/Users/dev/cortad-build" };
  stick(root, local);
  assert.deepEqual(JSON.parse(read(root, ".claude/settings.json")).hooks.UserPromptSubmit.map((e) => e.hooks[0].command), ["npx /opt/acme/bin/notes news --hook", "npx /Users/dev/cortad-build news --hook"]);
  assert.ok(stick(root, local).every((line) => line.endsWith(": nothing to change")));
  unstick(root, local);
  assert.deepEqual(JSON.parse(read(root, ".claude/settings.json")), theirs);
});

test("a settings file whose hooks are not lists is left alone and said so, with the other files still written", () => {
  const root = repo();
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ hooks: { PostToolUse: { matcher: "Edit" } } }));
  const said = stick(root, latest);
  assert.equal(said[4], ".claude/settings.json: left alone, its hooks are not the lists a client writes");
  assert.equal(said[5].startsWith(".codex/hooks.json: added"), true);
  assert.equal(unstick(root)[4], ".claude/settings.json: left alone, its hooks are not the lists a client writes");
  assert.deepEqual(JSON.parse(read(root, ".claude/settings.json")), { hooks: { PostToolUse: { matcher: "Edit" } } });
});
