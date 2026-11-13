import { execFile, spawn } from "node:child_process";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const TETHER = fileURLToPath(new URL("./tether.mjs", import.meta.url));

export function elapsedMs(etime) {
  const [days, clock] = String(etime).includes("-") ? String(etime).split("-") : [0, String(etime)];
  const [s = 0, m = 0, h = 0] = clock.split(":").map(Number).reverse();
  return (((Number(days) * 24 + h) * 60 + m) * 60 + s) * 1000;
}

export async function familyOf(pid) {
  const table = (await exec("ps", ["-axo", "pid=,ppid="])).stdout.trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
  const family = new Set([pid]);
  for (let grew = true; grew;) { grew = false; for (const [p, parent] of table) if (family.has(parent) && !family.has(p)) { family.add(p); grew = true; } }
  return [...family];
}

export async function listening(pid) {
  try {
    const { stdout } = await exec("lsof", ["-nP", "-a", "-p", (await familyOf(pid)).join(","), "-iTCP", "-sTCP:LISTEN", "-Fn"]);
    return [...new Set([...stdout.matchAll(/^n.*:(\d+)$/gm)].map((m) => Number(m[1])).filter((p) => p > 0))];
  } catch { return []; }
}

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

export async function listenerOn(port) {
  try { return Number((await exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])).stdout.trim().split("\n")[0]) || null; } catch { return null; }
}

export const portInError = (said) => Number(/[:\s(,](\d{4,5})\)?:?[^\n]{0,40}?address already in use/i.exec(said)?.[1] ?? /(?:EADDRINUSE|address already in use)[^\n]{0,60}?[:\s](\d{4,5})\b/i.exec(said)?.[1] ?? 0);

export async function holderOf(port) {
  const pid = await listenerOn(port);
  if (!pid) return null;
  const [args, cwd] = await Promise.all([
    exec("ps", ["-o", "args=", "-p", String(pid)]).then((r) => r.stdout.trim(), () => ""),
    exec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).then((r) => /^n(.+)$/m.exec(r.stdout)?.[1] ?? null, () => null),
  ]);
  return { port, pid, command: args.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => basename(w)).join(" "), cwd };
}

export async function stopTree(pid) {
  const family = await familyOf(pid).catch(() => [pid]);
  const signal = (sig) => { for (const p of family) { try { process.kill(p, sig); } catch {  } } try { process.kill(-pid, sig); } catch {  } };

  const alive = () => [...family, -pid].some((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
  signal("SIGTERM");
  for (let i = 0; i < 15 && alive(); i++) await new Promise((r) => setTimeout(r, 200));
  if (alive()) signal("SIGKILL");
}

export function spawnTied(cmd, { cwd, env }) {
  const app = spawn("/bin/sh", ["-c", cmd], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  if (!app.pid) return app;
  const dog = spawn(process.execPath, [TETHER, String(app.pid)], { stdio: ["pipe", "ignore", "ignore"], detached: true, env: { PATH: process.env.PATH ?? "" } });
  dog.unref();
  dog.stdin.unref?.();
  dog.stdin.on("error", () => {  });

  app.once("exit", () => { void stopTree(app.pid).finally(() => { try { dog.kill("SIGKILL"); } catch {  } }); });
  return app;
}
