// The lock on the operations this machine runs for Cortad (local.mjs OPS). Enforced by the operating
// system, not by reading the command: on a Mac the same Seatbelt sandbox Codex and Claude Code use,
// on Linux bubblewrap. Inside it a command can read your project and run your tests, and it can write
// only where your own .gitignore already says files are disposable (caches, build output, coverage)
// and in temp. It cannot write a tracked file, cannot read your keys or any env file, and cannot reach
// the network beyond this machine. With neither tool present nothing runs.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const real = (p) => { try { return realpathSync(p); } catch { return null; } };
const q = (p) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
// Dependencies are not disposable even though git ignores them; their caches are.
const CACHES = [".cache", ".vite", ".vitest", ".bin/.cache"];
// What git ignores splits in two: build output and dependency caches a test may rewrite, and
// everything else, which is where a project keeps what it never commits (keys, exports, notes).
const BUILT = /(^|\/)(dist|build|out|coverage|target|tmp|\.next|\.nuxt|\.turbo|\.cache|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.venv|venv|\.parcel-cache|\.svelte-kit|\.output|\.wrangler|\.terraform|\.vite|\.vitest)$/;

async function ignoredPaths(root) {
  const out = await run("git", ["-C", root, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], { maxBuffer: 16 * 1024 * 1024 })
    .then((r) => r.stdout.split("\n").filter(Boolean), () => []);
  const writable = [];
  const hidden = [];
  for (const line of out) {
    const dir = line.endsWith("/");
    const rel = dir ? line.slice(0, -1) : line;
    if (/(^|\/)\.git($|\/)/.test(rel)) continue;
    if (/(^|\/)node_modules$/.test(rel)) { for (const c of CACHES) writable.push(join(root, rel, c)); continue; }
    if (dir && BUILT.test(rel)) { if (writable.length < 200) writable.push(join(root, rel)); continue; }
    if (hidden.length < 400) hidden.push({ path: join(root, rel), dir });
  }
  return { writable, hidden };
}

// Where a shell line looks for its tools inside your home folder. The rest of home is not read.
const TOOLCHAINS = [".nvm", ".npm", ".node-gyp", ".pnpm-store", ".yarn", ".bun", ".deno", ".volta", ".asdf", ".cache", ".local",
  ".pyenv", ".rbenv", ".gem", ".cargo", ".rustup", "go", ".gradle", ".m2", "Library/pnpm", "Library/Caches", ".gitconfig", ".config/git"];

const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".config/gh", ".docker", ".kube"];
const SECRET_FILES = [".netrc", ".npmrc", ".pypirc"];

// `envFiles`: every env file the walk found, tracked or not, hidden on both platforms.
export async function makeLock({ root, work, envFiles = [] }) {
  const home = homedir();
  // Temp is writable, unless the project itself lives under it: a folder that contains your code is
  // never opened whole, whatever it is called.
  const home0 = real(root) ?? root;
  const holdsProject = (dir) => home0 === dir || home0.startsWith(`${dir}/`);
  const ignored = await ignoredPaths(root);
  ignored.hidden.push(...envFiles.map((path) => ({ path, dir: false })));
  const writable = [work, tmpdir(), "/tmp", ...ignored.writable].map((p) => real(p) ?? p).filter((dir) => !holdsProject(dir));
  const project = real(root) ?? root;
  const tools = TOOLCHAINS.map((t) => join(home, t)).filter(existsSync).map((p) => real(p) ?? p);
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    // Later rules win: home is shut, the project and the toolchains are opened again inside it, and
    // what the project ignores and your keys are shut last.
    const hide = ignored.hidden.map(({ path, dir }) => `(${dir ? "subpath" : "literal"} ${q(real(path) ?? path)})`);
    const rules = [
      "(version 1)(allow default)",
      `(deny file-read-data (subpath ${q(real(home) ?? home)}))`,
      // /tmp holds what other programs on this machine logged; a shell line may write there, never read it.
      `(deny file-read-data (subpath ${q(real("/tmp") ?? "/tmp")}))`,
      // Except the shell's own heredoc files: /bin/sh writes each one under /tmp and reads it back.
      '(allow file-read-data (regex #"^/private/tmp/sh-thd"))',
      `(allow file-read-data (subpath ${q(project)}) ${[work, ...tools].map((p) => `(subpath ${q(p)})`).join(" ")})`,
      ...(hide.length ? [`(deny file-read-data file-write* ${hide.join(" ")})`] : []),
      // This machine only. Unix sockets stay shut: through one, a request rides out to the internet
      // by name on a system network helper even with every direct connection refused.
      '(deny network*)(allow network-outbound (remote ip "localhost:*"))(allow network-inbound (local ip "localhost:*"))',
      "(deny file-write*)",
      `(allow file-write* ${writable.map((p) => `(subpath ${q(p)})`).join(" ")} (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (subpath "/dev/fd"))`,
      // The same operation the project is opened with: a rule naming file-read-data outranks one naming
      // file-read*, so a wildcard deny here let every .env be read again.
      `(deny file-read* file-read-data ${SECRET_DIRS.map((d) => `(subpath ${q(join(home, d))})`).join(" ")} ${SECRET_FILES.map((f) => `(literal ${q(join(home, f))})`).join(" ")} (regex #"\\.env$") (regex #"/\\.env\\.(local|staging|stage|development|dev|test|production|prod)$"))`,
    ].join("");
    return { name: "seatbelt", wrap: (cmd) => ({ file: "/usr/bin/sandbox-exec", args: ["-p", rules, "/bin/sh", "-c", cmd] }) };
  }
  const bwrap = process.platform === "linux" ? ["/usr/bin/bwrap", "/bin/bwrap"].find(existsSync) : null;
  if (bwrap) {
    // A network namespace of its own: the command sees only its own loopback. Home is an empty
    // tmpfs; the project and the toolchains are bound back into it, then the project's ignored files
    // and every env file are covered and the writable folders opened.
    const back = [project, ...tools].filter(existsSync).flatMap((p) => ["--ro-bind", p, p]);
    const binds = writable.filter(existsSync).flatMap((p) => ["--bind", p, p]);
    const covered = ignored.hidden.filter(({ path }) => existsSync(path)).flatMap(({ path, dir }) => (dir ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path]));
    return { name: "bubblewrap", wrap: (cmd) => ({ file: bwrap, args: ["--unshare-net", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", home, ...back, ...covered, ...binds, "/bin/sh", "-c", cmd] }) };
  }
  return null;
}

// One line proving the lock holds here, before any world is allowed a shell.
export function lockHolds(lock, root) {
  const probe = join(root, `.bl-lock-probe-${process.pid}`);
  const { file, args } = lock.wrap(`touch ${JSON.stringify(probe)}`);
  try { execFileSync(file, args, { stdio: "ignore" }); } catch { /* refused, as it must be */ }
  if (!existsSync(probe)) return true;
  try { execFileSync("rm", ["-f", probe]); } catch { /* best effort */ }
  return false;
}
