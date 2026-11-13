import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// What this machine keeps between sessions, per project, under ~/.cortad/<project>/: the key the
// first connect left behind, the digest of the tree last uploaded, the app as last started, and the
// run this machine asked for last. The process holding the app up keeps its own file there
// (lib/runner.mjs). The folder's path never leaves the machine; the project is a hash of it.
export const projectOf = (root) => createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 16);
export const homeOf = (project, base = join(homedir(), ".cortad")) => join(base, project);

const read = (file) => { try { return readFileSync(file, "utf8").trim() || null; } catch { return null; } };
const readJson = (file) => { const raw = read(file); try { return raw ? JSON.parse(raw) : null; } catch { return null; } };
const write = (dir, name, text) => { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(join(dir, name), text, { mode: 0o600 }); };

export const readToken = (project, base) => read(join(homeOf(project, base), "token"));
export const writeToken = (project, token, base) => write(homeOf(project, base), "token", token);

export const writeDigest = (project, digest, base) => write(homeOf(project, base), "digest", digest);

// The files the person's agent has sent Cortad (lib/picks.mjs), as paths in this folder: the set a
// later send adds to.
export const readPicked = (project, base) => { const v = readJson(join(homeOf(project, base), "picked.json")); return Array.isArray(v) ? v.filter((f) => typeof f === "string") : []; };
export const writePicked = (project, files, base) => write(homeOf(project, base), "picked.json", JSON.stringify(files));

// The app that runner holds up, as it noted it last (lib/fresh.mjs): when it started or last reloaded, whether that
// runner started it, and what its source files said then.
export const readApp = (project, base) => readJson(join(homeOf(project, base), "app.json"));
export const writeApp = (project, app, base) => write(homeOf(project, base), "app.json", JSON.stringify(app));

export const readPending = (project, base) => readJson(join(homeOf(project, base), "pending.json"));
export const writePending = (project, pending, base) => write(homeOf(project, base), "pending.json", JSON.stringify(pending));


// What the server told this machine while no agent was listening (a run ending), kept until the
// hook hands it to the agent on its next prompt or edit, or the agent reads that run itself. Each
// line is said once. Where no hook ever takes it, only the latest lines stay.
//
// Three processes touch the file: the connector appends, a hook takes, a verb drops a run's line.
// Nobody reads it in place. It is taken by rename first, so no two of them ever hold the same
// lines, and what is kept goes back by append, after whatever landed in between.
const NEWS_KEPT = 20;
const HEARD_KEPT = 50;
const newsFile = (project, base) => join(homeOf(project, base), "news.txt");
const linesOf = (file) => (read(file) ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
// Appended through a handle that refuses a symbolic link: the lines are the server's, and a link
// planted at this name must not point them at another file.
function appendNews(project, base, lines) {
  mkdirSync(homeOf(project, base), { recursive: true, mode: 0o700 });
  const fd = openSync(newsFile(project, base), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, `${lines.join("\n")}\n`); } finally { closeSync(fd); }
}
export function takeNews(project, base) {
  const taken = `${newsFile(project, base)}.${process.pid}`;
  try { renameSync(newsFile(project, base), taken); } catch { return []; }
  // A link moved here is removed unread: its target is not news.
  const lines = lstatSync(taken).isSymbolicLink() ? [] : linesOf(taken);
  rmSync(taken, { force: true });
  return lines;
}
const rewriteNews = (project, base, keep) => {
  const kept = keep(takeNews(project, base));
  if (kept.length) appendNews(project, base, kept);
};
// The runs the agent has read to their end, so a line that names one is not kept for it: the
// server marks a run finished a moment before it says the line.
const heardFile = (project, base) => join(homeOf(project, base), "heard.txt");
export function addNews(project, line, base) {
  if (linesOf(heardFile(project, base)).some((id) => line.includes(id))) return;
  appendNews(project, base, [line]);
  if (linesOf(newsFile(project, base)).length > NEWS_KEPT) rewriteNews(project, base, (lines) => lines.slice(-NEWS_KEPT));
}
/** Whether the agent has read this run to its end on this machine. */
export const wasHeard = (project, runId, base) => linesOf(heardFile(project, base)).includes(runId);
/** The agent has read this run itself: the line kept to tell it of that run is dropped, and one that arrives later is not kept. */
export function dropNews(project, runId, base) {
  if (typeof runId !== "string" || runId.length < 8) return;
  rewriteNews(project, base, (lines) => lines.filter((l) => !l.includes(runId)));
  const heard = [...linesOf(heardFile(project, base)).filter((id) => id !== runId), runId].slice(-HEARD_KEPT);
  const next = `${heardFile(project, base)}.${process.pid}`;
  mkdirSync(homeOf(project, base), { recursive: true, mode: 0o700 });
  writeFileSync(next, `${heard.join("\n")}\n`, { mode: 0o600 });
  renameSync(next, heardFile(project, base));
}
