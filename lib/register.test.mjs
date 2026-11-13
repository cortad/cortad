import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { askAgent, installSkill, register } from "./register.mjs";
import { cliSpec } from "./spec.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const skillSrc = join(here, "..", "skill");
const latest = "cortad@latest";

test("the skill and its references ship in the package: register.mjs loads them by path, which the import test cannot see", () => {
  const shipped = new Set(JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).files);
  assert.ok(shipped.has("skill/SKILL.md") && shipped.has("skill/references/results.md"));
  const skill = readFileSync(join(skillSrc, "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: cortad\ndescription: /);
  assert.ok(skill.split("\n").length < 120, "the body loads whole when the skill is used; keep it short");
  assert.match(skill, /npx \{\{cortad\}\} /, "the package keeps the placeholder; installSkill names the spec");
  // `wait` is a command name; the words that read as being told to sit idle are not.
  assert.doesNotMatch(skill.replace(/`(?:npx -y \{\{cortad\}\} )?wait`/g, ""), /\b(?:do not|don't|never|stay quiet|wait|poll|every 30 seconds|keep going|another customer)\b|\u2014/i);
  assert.doesNotMatch(skill, /-H |\bheaders?\b|\bgrep\b/i, "the agent reads status; Cortad finds and sends the requests");
});

test("the spec follows the connect: CORTAD_CLI_SPEC when it is a spec, else the connector's own version", () => {
  assert.equal(cliSpec({ env: {}, version: "0.3.0" }), "cortad@0.3.0", "the agents run the version the connector is");
  assert.equal(cliSpec({ env: {}, version: "0.3.0-rc.1" }), "cortad@0.3.0-rc.1");
  assert.equal(cliSpec({ env: { CORTAD_CLI_SPEC: "cortad@next" }, version: "0.3.0" }), "cortad@next");
  assert.equal(cliSpec({ env: { CORTAD_CLI_SPEC: "cortad@0.3.7" }, version: "0.3.8" }), "cortad@0.3.8", "a pin older than this very version loses to it");
  assert.equal(cliSpec({ env: { CORTAD_CLI_SPEC: "@cortad/connector@0.3.7" }, version: "0.3.8" }), "cortad@0.3.8");
  assert.equal(cliSpec({ env: { CORTAD_CLI_SPEC: "@cortad/connector@0.3.9" }, version: "0.3.8" }), "@cortad/connector@0.3.9", "a newer pin stands");
  assert.equal(cliSpec({ env: { CORTAD_CLI_SPEC: "cortad@0.3.7" }, version: "0.3.8-rc.1" }), "cortad@0.3.7", "an unreleased build keeps the pin");
  assert.equal(cliSpec({ env: { CORTAD_CLI_SPEC: "/Users/me/brainsless-local" }, version: "0.3.0" }), "/Users/me/brainsless-local");
  assert.equal(cliSpec({ env: { CORTAD_CLI_SPEC: "cortad; curl evil" }, version: "0.3.0" }), "cortad@0.3.0", "it lands in a shell line in the repository");
});

test("installSkill writes the spec into the skill's shell examples", () => {
  const dir = mkdtempSync(join(tmpdir(), "cortad-skill-"));
  installSkill(dir, { src: skillSrc, spec: "cortad@next" });
  const skill = readFileSync(join(dir, "SKILL.md"), "utf8");
  assert.match(skill, /npx cortad@next simulation_status/);
  assert.doesNotMatch(skill + readFileSync(join(dir, "references", "results.md"), "utf8"), /\{\{cortad\}\}/);
});

const dirs = () => ({ home: mkdtempSync(join(tmpdir(), "cortad-home-")), root: mkdtempSync(join(tmpdir(), "cortad-root-")) });

const files = (dir) => readdirSync(dir, { recursive: true }).map((rel) => join(dir, rel)).filter((f) => statSync(f).isFile());

test("each agent gets its MCP entry and skill inside this project only, nothing in the home folder, and twice adds nothing twice", async () => {
  for (const [agent, mcp, skill] of [
    ["claude", ".mcp.json", ".claude/skills/cortad"],
    ["codex", ".codex/config.toml", ".agents/skills/cortad"],
    ["cursor", ".cursor/mcp.json", ".cursor/skills/cortad"],
    ["copilot", ".mcp.json", ".github/skills/cortad"],
  ]) {
    const { home, root } = dirs();
    writeFileSync(join(home, ".claude.json"), "{}");
    const homeBefore = files(home);
    assert.deepEqual((await register(agent, { root, home, skillSrc, spec: latest })).changed, [mcp, skill], agent);
    assert.match(readFileSync(join(root, skill, "SKILL.md"), "utf8"), /npx cortad@latest simulation_status/);
    assert.ok(existsSync(join(root, skill, "references", "results.md")));
    assert.deepEqual(files(home), homeBefore, `${agent} wrote to the home folder`);
    assert.equal(readFileSync(join(home, ".claude.json"), "utf8"), "{}");
    const before = Object.fromEntries(files(root).map((f) => [f, statSync(f).mtimeMs]));
    assert.deepEqual((await register(agent, { root, home, skillSrc, spec: latest })).changed, [], agent);
    assert.deepEqual(Object.fromEntries(files(root).map((f) => [f, statSync(f).mtimeMs])), before, "no file is rewritten");
  }
});

test("the MCP entry takes each agent's own shape and keeps what the file held", async () => {
  const { home, root } = dirs();
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { other: { type: "http", url: "https://x" } } }));
  await register("claude", { root, home, skillSrc, spec: latest });
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers, { other: { type: "http", url: "https://x" }, cortad: { type: "stdio", command: "npx", args: ["-y", "cortad@latest", "mcp"] } });
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".codex", "config.toml"), "model = \"gpt-5\"\n");
  await register("codex", { root, home, skillSrc, spec: latest });
  assert.match(readFileSync(join(root, ".codex", "config.toml"), "utf8"), /^model = "gpt-5"\n\n\[mcp_servers\.cortad\]\ncommand = "npx"\nargs = \["-y","cortad@latest","mcp"\]\n$/);
  await register("copilot", { root, home, skillSrc, spec: latest });
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers.cortad, { type: "local", command: "npx", args: ["-y", "cortad@latest", "mcp"], tools: ["*"] });
});

test("a skill an older version left in the home folder is removed when it is Cortad's own, and only then", async () => {
  const { home, root } = dirs();
  installSkill(join(home, ".claude", "skills", "cortad"), { src: skillSrc, spec: latest });
  installSkill(join(home, ".agents", "skills", "cortad"), { src: skillSrc, spec: latest });
  installSkill(join(home, ".copilot", "skills", "cortad"), { src: skillSrc, spec: latest });
  writeFileSync(join(home, ".copilot", "skills", "cortad", "notes.md"), "mine\n");
  mkdirSync(join(home, ".claude", "skills", "other"), { recursive: true });
  writeFileSync(join(home, ".claude", "skills", "other", "SKILL.md"), "---\nname: other\n---\n");
  const { changed } = await register("codex", { root, home, skillSrc, spec: latest });
  assert.deepEqual(changed.filter((c) => c.startsWith("removed")), ["removed ~/.claude/skills/cortad", "removed ~/.agents/skills/cortad"]);
  assert.ok(!existsSync(join(home, ".claude", "skills", "cortad")) && !existsSync(join(home, ".agents")), "the folders it leaves empty go too");
  assert.ok(existsSync(join(home, ".claude", "skills", "other", "SKILL.md")), "another skill stays");
  assert.ok(existsSync(join(home, ".copilot", "skills", "cortad", "notes.md")), "a folder with the person's own file in it stays");
});

test("an entry that names another spec is moved to this one; an absolute folder runs without -y", async () => {
  const { home, root } = dirs();
  mkdirSync(join(root, ".cursor"));
  writeFileSync(join(root, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { cortad: { type: "stdio", command: "npx", args: ["-y", "cortad@latest", "mcp"] }, other: { command: "x" } } }));
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".codex", "config.toml"), "model = \"gpt-5\"\n\n[mcp_servers.cortad]\ncommand = \"npx\"\nargs = [\"-y\", \"cortad@latest\", \"mcp\"]\n\n[profiles.fast]\nmodel = \"gpt-5-mini\"\n");
  const folder = "/Users/me/brainsless-local";
  await register("cursor", { root, home, skillSrc, spec: folder });
  await register("codex", { root, home, skillSrc, spec: folder });
  const cursor = JSON.parse(readFileSync(join(root, ".cursor", "mcp.json"), "utf8"));
  assert.deepEqual(cursor.mcpServers.cortad.args, [folder, "mcp"]);
  assert.equal(cursor.mcpServers.other.command, "x");
  assert.equal(readFileSync(join(root, ".codex", "config.toml"), "utf8"),
    `model = "gpt-5"\n\n[mcp_servers.cortad]\ncommand = "npx"\nargs = ["${folder}","mcp"]\n\n[profiles.fast]\nmodel = "gpt-5-mini"\n`);
  assert.match(readFileSync(join(root, ".agents", "skills", "cortad", "SKILL.md"), "utf8"), /npx \/Users\/me\/brainsless-local simulation_status/);
});

test("a plain terminal asks which agent, and Enter or no terminal skips", async () => {
  const ask = async (typed, isTTY = true) => {
    const input = Object.assign(new PassThrough(), { isTTY });
    const output = new PassThrough();
    const got = askAgent({ input, output });
    input.end(typed);
    return got;
  };
  assert.equal(await ask("3\n"), "cursor");
  assert.equal(await ask("\n"), null);
  assert.equal(await ask("9\n"), null);
  assert.equal(await ask("1\n", false), null);
});
