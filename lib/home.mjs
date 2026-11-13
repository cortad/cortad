import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const projectOf = (root) => createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 16);
export const homeOf = (project, base = join(homedir(), ".cortad")) => join(base, project);

const read = (file) => { try { return readFileSync(file, "utf8").trim() || null; } catch { return null; } };
const readJson = (file) => { const raw = read(file); try { return raw ? JSON.parse(raw) : null; } catch { return null; } };
const write = (dir, name, text) => { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(join(dir, name), text, { mode: 0o600 }); };

export const readToken = (project, base) => read(join(homeOf(project, base), "token"));
export const writeToken = (project, token, base) => write(homeOf(project, base), "token", token);

export const writeDigest = (project, digest, base) => write(homeOf(project, base), "digest", digest);

export const readApp = (project, base) => readJson(join(homeOf(project, base), "app.json"));
export const writeApp = (project, app, base) => write(homeOf(project, base), "app.json", JSON.stringify(app));

export const readPending = (project, base) => readJson(join(homeOf(project, base), "pending.json"));
export const writePending = (project, pending, base) => write(homeOf(project, base), "pending.json", JSON.stringify(pending));

const NEWS_KEPT = 20;
const HEARD_KEPT = 50;
const newsFile = (project, base) => join(homeOf(project, base), "news.txt");
const linesOf = (file) => (read(file) ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

function appendNews(project, base, lines) {
  mkdirSync(homeOf(project, base), { recursive: true, mode: 0o700 });
  const fd = openSync(newsFile(project, base), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, `${lines.join("\n")}\n`); } finally { closeSync(fd); }
}
export function takeNews(project, base) {
  const taken = `${newsFile(project, base)}.${process.pid}`;
  try { renameSync(newsFile(project, base), taken); } catch { return []; }

  const lines = lstatSync(taken).isSymbolicLink() ? [] : linesOf(taken);
  rmSync(taken, { force: true });
  return lines;
}
const rewriteNews = (project, base, keep) => {
  const kept = keep(takeNews(project, base));
  if (kept.length) appendNews(project, base, kept);
};

const heardFile = (project, base) => join(homeOf(project, base), "heard.txt");
export function addNews(project, line, base) {
  if (linesOf(heardFile(project, base)).some((id) => line.includes(id))) return;
  appendNews(project, base, [line]);
  if (linesOf(newsFile(project, base)).length > NEWS_KEPT) rewriteNews(project, base, (lines) => lines.slice(-NEWS_KEPT));
}

export const wasHeard = (project, runId, base) => linesOf(heardFile(project, base)).includes(runId);

export function dropNews(project, runId, base) {
  if (typeof runId !== "string" || runId.length < 8) return;
  rewriteNews(project, base, (lines) => lines.filter((l) => !l.includes(runId)));
  const heard = [...linesOf(heardFile(project, base)).filter((id) => id !== runId), runId].slice(-HEARD_KEPT);
  const next = `${heardFile(project, base)}.${process.pid}`;
  mkdirSync(homeOf(project, base), { recursive: true, mode: 0o700 });
  writeFileSync(next, `${heard.join("\n")}\n`, { mode: 0o600 });
  renameSync(next, heardFile(project, base));
}
