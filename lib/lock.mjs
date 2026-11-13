import { execFile, execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const real = (p) => { try { return realpathSync(p); } catch { return null; } };
const q = (p) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const CACHES = [".cache", ".vite", ".vitest", ".bin/.cache"];

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
    hidden.push({ path: join(root, rel), dir });
  }
  return { writable, hidden };
}

const TOOLCHAINS = [".nvm", ".npm", ".node-gyp", ".pnpm-store", ".yarn", ".bun", ".deno", ".volta", ".asdf", ".cache", ".local",
  ".pyenv", ".rbenv", ".gem", ".cargo", ".rustup", "go", ".gradle", ".m2", "Library/pnpm", "Library/Caches", ".gitconfig", ".config/git"];

const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".config/gh", ".docker", ".kube"];
const SECRET_FILES = [".netrc", ".npmrc", ".pypirc"];

export async function makeLock({ root, work, envFiles = [] }) {
  const home = homedir();

  const home0 = real(root) ?? root;
  const holdsProject = (dir) => home0 === dir || home0.startsWith(`${dir}/`);
  const ignored = await ignoredPaths(root);
  ignored.hidden.push(...envFiles.map((path) => ({ path, dir: false })));
  const writable = [work, tmpdir(), "/tmp", ...ignored.writable].map((p) => real(p) ?? p).filter((dir) => !holdsProject(dir));
  const project = real(root) ?? root;
  const tools = TOOLCHAINS.map((t) => join(home, t)).filter(existsSync).map((p) => real(p) ?? p);
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {

    const hide = ignored.hidden.map(({ path, dir }) => `(${dir ? "subpath" : "literal"} ${q(real(path) ?? path)})`);
    const rules = [
      "(version 1)(allow default)",
      `(deny file-read-data (subpath ${q(real(home) ?? home)}))`,

      `(deny file-read-data (subpath ${q(real("/tmp") ?? "/tmp")}))`,

      '(allow file-read-data (regex #"^/private/tmp/sh-thd"))',
      `(allow file-read-data (subpath ${q(project)}) ${[work, ...tools].map((p) => `(subpath ${q(p)})`).join(" ")})`,
      ...(hide.length ? [`(deny file-read-data file-write* ${hide.join(" ")})`] : []),

      '(deny network*)(allow network-outbound (remote ip "localhost:*"))(allow network-inbound (local ip "localhost:*"))',
      "(deny file-write*)",
      `(allow file-write* ${writable.map((p) => `(subpath ${q(p)})`).join(" ")} (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (subpath "/dev/fd"))`,

      `(deny file-read* file-read-data ${SECRET_DIRS.map((d) => `(subpath ${q(join(home, d))})`).join(" ")} ${SECRET_FILES.map((f) => `(literal ${q(join(home, f))})`).join(" ")} (regex #"\\.env$") (regex #"/\\.env\\.(local|staging|stage|development|dev|test|production|prod)$"))`,
    ].join("");
    return whole({ name: "seatbelt", wrap: (cmd) => ({ file: "/usr/bin/sandbox-exec", args: ["-p", rules, "/bin/sh", "-c", cmd] }) }, ignored.hidden.length);
  }
  const bwrap = process.platform === "linux" ? ["/usr/bin/bwrap", "/bin/bwrap"].find(existsSync) : null;
  if (bwrap) {

    const back = [project, ...tools].filter(existsSync).flatMap((p) => ["--ro-bind", p, p]);
    const binds = writable.filter(existsSync).flatMap((p) => ["--bind", p, p]);
    const covered = ignored.hidden.filter(({ path }) => existsSync(path)).flatMap(({ path, dir }) => (dir ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path]));
    return whole({ name: "bubblewrap", wrap: (cmd) => ({ file: bwrap, args: ["--unshare-net", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", home, ...back, ...covered, ...binds, "/bin/sh", "-c", cmd] }) }, ignored.hidden.length);
  }
  return null;
}

async function whole(lock, hidden) {
  const { file, args } = lock.wrap("true");
  try {
    await run(file, args, { timeout: 120_000 });
    return lock;
  } catch (e) {
    const said = String(e.stderr ?? "").trim().split("\n")[0] || e.code || e.message;
    return { ...lock, refused: `running your tests is off for this project: the test command runs only with each of the ${hidden.toLocaleString("en-US")} files and folders git ignores and every env file hidden from it, and ${lock.name === "seatbelt" ? "sandbox-exec" : "bubblewrap"} would not start with that list (${said}).` };
  }
}

export function lockHolds(lock, root) {
  const probe = join(root, `.bl-lock-probe-${process.pid}`);
  const { file, args } = lock.wrap(`touch ${JSON.stringify(probe)}`);
  try { execFileSync(file, args, { stdio: "ignore" }); } catch {  }
  if (!existsSync(probe)) return true;
  try { execFileSync("rm", ["-f", probe]); } catch {  }
  return false;
}
