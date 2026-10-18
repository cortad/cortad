// The app's processes: started tied to the runner, found by descent, stopped for certain, and the
// holder of a port named.
import { execFile, spawn } from "node:child_process";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const TETHER = fileURLToPath(new URL("./tether.mjs", import.meta.url));

// ps's etime, [[dd-]hh:]mm:ss, in milliseconds.
export function elapsedMs(etime) {
  const [days, clock] = String(etime).includes("-") ? String(etime).split("-") : [0, String(etime)];
  const [s = 0, m = 0, h = 0] = clock.split(":").map(Number).reverse();
  return (((Number(days) * 24 + h) * 60 + m) * 60 + s) * 1000;
}

// Every process descended from pid. By descent, not by process group: nodemon, pm2 and concurrently
// put the real server in a group of its own, and an app started through one of them was never seen
// to open its port.
export async function familyOf(pid) {
  const table = (await exec("ps", ["-axo", "pid=,ppid="])).stdout.trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
  const family = new Set([pid]);
  for (let grew = true; grew;) { grew = false; for (const [p, parent] of table) if (family.has(parent) && !family.has(p)) { family.add(p); grew = true; } }
  return [...family];
}

// TCP ports pid and its descendants listen on.
export async function listening(pid) {
  try {
    const { stdout } = await exec("lsof", ["-nP", "-a", "-p", (await familyOf(pid)).join(","), "-iTCP", "-sTCP:LISTEN", "-Fn"]);
    return [...new Set([...stdout.matchAll(/^n.*:(\d+)$/gm)].map((m) => Number(m[1])).filter((p) => p > 0))];
  } catch { return []; }
}

// The top of the chain that runs the app: nodemon, npm, the sh -c under it. Climbs from the listener
// while the parent is a runner, never into the person's own shell or terminal.
const RUNNER = /^(?:\S*\/)?(?:node|npm|npx|pnpm|yarn|bun|deno|python[\d.]*|uvicorn|gunicorn|flask|tsx|ts-node|nodemon|concurrently|pm2)(?:\s|$)|^(?:\/bin\/)?sh -c\b/;
export async function chainOf(pid) {
  const rows = (await exec("ps", ["-axo", "pid=,ppid=,etime=,args="])).stdout.trim().split("\n").map((l) => l.trim());
  const table = new Map(rows.map((l) => { const m = /^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l); return m ? [Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), etime: m[3], args: m[4] }] : [0, null]; }));
  const chain = table.get(pid) ? [table.get(pid)] : [];
  for (let i = 0; i < 8 && chain.length; i++) {
    const parent = table.get(chain.at(-1).ppid);
    if (!parent || !RUNNER.test(parent.args)) break;
    chain.push(parent);
  }
  return chain;
}
export const supervisorOf = async (pid) => (await chainOf(pid)).at(-1)?.pid ?? pid;

// The process listening on a port.
export async function listenerOn(port) {
  try { return Number((await exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])).stdout.trim().split("\n")[0]) || null; } catch { return null; }
}

// The port a bind failure names, in the app's own words: uvicorn's "('127.0.0.1', 8105): address
// already in use", Go's "0.0.0.0:8080: bind: address already in use", Node's "EADDRINUSE: address
// already in use :::3000" or "... 127.0.0.1:3000", Rails' "... for "127.0.0.1" port 3000". 0 when
// it names none.
// The port in the app's own words for a taken one, however its runtime spells the address: Node's
// "EADDRINUSE: address already in use :::3100", uvicorn's "('127.0.0.1', 58889): [errno 48] address already in use".
export const portInError = (said) => Number(/[:\s(,](\d{4,5})\)?:?[^\n]{0,40}?address already in use/i.exec(said)?.[1] ?? /(?:EADDRINUSE|address already in use)[^\n]{0,60}?[:\s](\d{4,5})\b/i.exec(said)?.[1] ?? 0);

// Whoever holds a port: its pid, the program and its first argument (never the rest of its command
// line, which can carry a key), and the folder it runs in.
export async function holderOf(port) {
  const pid = await listenerOn(port);
  if (!pid) return null;
  const [args, cwd] = await Promise.all([
    exec("ps", ["-o", "args=", "-p", String(pid)]).then((r) => r.stdout.trim(), () => ""),
    exec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).then((r) => /^n(.+)$/m.exec(r.stdout)?.[1] ?? null, () => null),
  ]);
  return { port, pid, command: args.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => basename(w)).join(" "), cwd };
}

// pid and everything it started, stopped: asked first, then made to. The group is signalled too, for
// what its leader started before it exited.
export async function stopTree(pid) {
  const family = await familyOf(pid).catch(() => [pid]);
  const signal = (sig) => { for (const p of family) { try { process.kill(p, sig); } catch { /* already gone */ } } try { process.kill(-pid, sig); } catch { /* no group left */ } };
  // The group counts as alive as well: once its leader has exited, a server the leader started is in
  // the group and in no family read from the leader's pid, and asking alone never stopped it.
  const alive = () => [...family, -pid].some((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
  signal("SIGTERM");
  for (let i = 0; i < 15 && alive(); i++) await new Promise((r) => setTimeout(r, 200));
  if (alive()) signal("SIGKILL");
}

// A shell command in a process group of its own, stopped with this process however this process
// ends. A watchdog (lib/tether.mjs) holds the read end of a pipe from here and stops the command's
// tree when the pipe closes, which the kernel does for a process killed outright. The watchdog runs
// with a bare environment, so the hooks handed to the app never load into it.
export function spawnTied(cmd, { cwd, env }) {
  const app = spawn("/bin/sh", ["-c", cmd], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  if (!app.pid) return app;
  const dog = spawn(process.execPath, [TETHER, String(app.pid)], { stdio: ["pipe", "ignore", "ignore"], detached: true, env: { PATH: process.env.PATH ?? "" } });
  dog.unref();
  dog.stdin.unref?.();
  dog.stdin.on("error", () => { /* the watchdog is gone; the runner stops the app itself */ });
  // An app that ended while this process lives is this process's to clean up, not the watchdog's.
  // Its group can hold more than it: a start command that hands the port to a child and exits leaves
  // that child serving, which is a second copy of the app as soon as the next start comes up. It is
  // stopped here, while the group still names it, and the watchdog goes once there is nothing left.
  app.once("exit", () => { void stopTree(app.pid).finally(() => { try { dog.kill("SIGKILL"); } catch { /* gone */ } }); });
  return app;
}
