// The fence around an agent's shell line, tried for real on this machine: a throwaway repository in
// the home folder, and every line below run inside the lock. macOS only (Seatbelt).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { lockHolds, makeLock } from "./lock.mjs";

test("the shell reaches the project and its tools, and nothing it should not", { skip: process.platform !== "darwin" }, async () => {
  const root = mkdtempSync(join(homedir(), ".cortad-lock-test-"));
  const work = mkdtempSync(join(tmpdir(), "cortad-lock-work-"));
  const log = join("/tmp", `cortad-lock-test-${process.pid}.log`);
  writeFileSync(log, "SECRET\n");
  try {
    for (const d of ["src", "runs/secrets", "dist", "scripts"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "runs/\nAUDIT.md\ndist/\n.env\n");
    writeFileSync(join(root, "src/app.js"), "console.log(1)\n");
    writeFileSync(join(root, "runs/secrets/k.json"), '{"k":"SECRET"}\n');
    writeFileSync(join(root, "AUDIT.md"), "SECRET\n");
    writeFileSync(join(root, ".env"), "X=SECRET\n");
    writeFileSync(join(root, "scripts/books.env"), "B=SECRET\n");
    writeFileSync(join(root, ".env.custom"), "C=SECRET\n");
    const git = (...a) => execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { stdio: "ignore" });
    git("init", "-q"); git("add", "-A"); git("commit", "-qm", "init");
    const lock = await makeLock({ root, work, envFiles: [join(root, ".env.custom")] });
    assert.ok(lock && lockHolds(lock, root));
    const runs = (cmd) => { const { file, args } = lock.wrap(cmd); try { return execFileSync(file, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString(); } catch { return null; } };
    for (const cmd of ["node -e 'console.log(1)'", "git status --short", "cat src/app.js", "echo x > dist/o.txt"]) assert.notEqual(runs(cmd), null, cmd);
    assert.equal(runs("cat <<EOF\nok\nEOF"), "ok\n", "a heredoc was refused");
    for (const cmd of ["cat ~/.zsh_history", "ls ~/Library/Keychains", "cat runs/secrets/k.json", "cat AUDIT.md", "echo x > runs/secrets/k.json",
      "cat .env", "cat scripts/books.env", "cat .env.custom", "echo x >> src/app.js", "curl -s -m 5 https://example.com", `cat ${log}`, "cat /tmp/*.log"]) {
      const out = runs(cmd);
      assert.ok(out === null || (out.trim() === "" && !/SECRET/.test(out)), `${cmd} was allowed`);
    }
    // No operation has the network: the lock takes no option that opens it.
    assert.match(lock.wrap("x", { network: true }).args[1], /deny network/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
    rmSync(log, { force: true });
  }
});
