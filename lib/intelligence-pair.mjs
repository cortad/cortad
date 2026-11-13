import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { homeOf, writeToken } from "./home.mjs";

const WAIT_MS = 90_000;
const POLL_MS = 2_000;
const KEEP_MS = 9 * 60_000;

const nameOf = (text, fallback) => (/^[\w.-]{1,80}$/.test(text) ? text : fallback);
export const machineName = () => nameOf(hostname().split(".")[0] ?? "", "this-computer");

export async function pair(ctx, post, { wait = WAIT_MS, sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }) } = {}) {
  const dir = homeOf(ctx.project);
  const file = join(dir, "pairing.json");
  let held = null;
  try { held = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null; } catch { held = null; }
  const machine = machineName();

  let fresh = false;
  if (!held || Date.now() - held.at > KEEP_MS) {
    const opened = await post("/local/pair", { name: nameOf(basename(ctx.root), "your-app"), machine });
    if (!opened.ok) return { failed: opened.data?.error ?? "Cortad did not open a link" };
    held = { id: opened.data.id, secret: opened.data.secret, words: opened.data.words, at: Date.now() };
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(held), { mode: 0o600 });
    fresh = true;
  }
  const link = `${ctx.apiBase.replace(/\/api$/, "")}/approve/${held.id}`;
  const until = fresh ? 0 : Date.now() + wait;
  for (;;) {
    const got = await post(`/local/pair/${held.id}/collect`, { secret: held.secret });
    if (got.status === 410) { rmSync(file, { force: true }); return { expired: true }; }
    if (got.ok && got.data.code) {
      const issued = await post("/local/intelligence/key", { code: got.data.code, machine, project: ctx.project, name: nameOf(basename(ctx.root), "your-app") });
      rmSync(file, { force: true });
      if (!issued.ok) return { failed: issued.data?.error ?? "Cortad did not issue this folder's key" };
      writeToken(ctx.project, issued.data.machineKey);
      return { paired: true, app: issued.data.app };
    }
    if (Date.now() >= until) return { waiting: true, link, words: held.words, machine };
    await sleep(POLL_MS);
  }
}
