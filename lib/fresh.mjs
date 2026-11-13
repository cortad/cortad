// Which code a run plays. The command holding the app up (local.mjs) notes in app.json, each time
// the app starts or its output shows it reloading, when that was, whether it started it, and what
// each source file said then. Before a run is asked for, the verbs compare the files as they stand
// with that note: an app whose code changed since is started again first, and the run's text says
// which code it played. yunqiao's `python run.py` served the old routes through a verify its agent
// had just fixed them for, and a `tsx watch` app served old prompts through a simulation: tsx on a
// CommonJS app reloads for its entry file alone, so a watcher in the command proves nothing.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { TEST } from "./files.mjs";
import { homeOf, readApp } from "./home.mjs";
import { readRunner } from "./runner.mjs";
import { writesDirOf, writtenPaths } from "./writes.mjs";

// A command, or an app's own output, that says it picks a saved file up by itself. Not a compiler
// in watch mode (tsc --watch rebuilds, the server it feeds keeps running), and not vite, which
// reloads the page and never the server behind it.
export const RELOADER = new RegExp([
  String.raw`--reload\b`, String.raw`\bnodemon\b`, String.raw`\bts-node-dev\b`, String.raw`\btsx\s+watch\b`,
  String.raw`\b(?:node|tsx|bun|deno|nest)\b[^&|;\n]*\s--(?:watch|hot)\b`,
  String.raw`\b(?:next|nuxt|astro|remix|fastapi)\s+dev\b`, String.raw`\brails\s+s(?:erver)?\b`,
  String.raw`\bmanage\.py\s+runserver\b(?![^&|;\n]*--noreload)`, String.raw`\bflask\b[^&|;\n]*\s--(?:debug|reload)\b`,
  String.raw`(?:^|[;&|\n]\s*)air\b`, String.raw`\bwatchexec\b`, String.raw`\bcargo[- ]watch\b`,
  "Will watch for changes", "Started reloader process", "watching for file changes", String.raw`Restarting with (?:stat|watchdog|inotify|fsevents)`,
  String.raw`\[nodemon\]`, "Restarting '", "WatchFiles detected changes", String.raw`Reloading\.\.\.`, "changed, reloading",
].join("|"), "i");

// What an app prints as it reloads for a save, the only evidence that it did. A watcher's banner at
// start is not one: tsx, node --watch, nodemon, uvicorn, django, werkzeug, deno, nest, ts-node-dev.
export const RELOADED = new RegExp([
  String.raw`\[tsx\][^\n]*(?:Restarting|rerunning)`, String.raw`\[nodemon\] restarting`, "Restarting '",
  "WatchFiles detected changes", "StatReload detected changes", String.raw`Detected (?:file )?change in`, "changed, reloading",
  "File change detected", String.raw`Restarting: [^\n]* has been modified`,
].join("|"), "i");

// `npm run dev` says nothing by itself; the script it names does, and the one that names.
export function commandText(cmd, dir) {
  let scripts = {};
  try { scripts = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts ?? {}; } catch { /* not a Node app */ }
  let text = String(cmd ?? "");
  for (let i = 0, at = text; i < 3; i++) {
    const name = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/.exec(at)?.[1];
    if (!name || typeof scripts[name] !== "string") break;
    at = scripts[name];
    text += `\n${at}`;
  }
  return text;
}

// Not the app's code: this command's own line and hooks, the coding agents' folders, and tests.
const NOT_APP = /^(?:AGENTS|CLAUDE)\.md$|^\.github\/copilot-instructions\.md$|^\.(?:claude|codex|cursor|agents)\//;
const digestOf = (file) => { try { return createHash("sha1").update(readFileSync(file)).digest("hex"); } catch { return ""; } };

// What each source file says now. Names alone for an app this command did not start: what it
// loaded is unknown, so only a file's time can be compared.
export const sourceOf = (root, files, hash = true) =>
  Object.fromEntries(files.filter((rel) => !NOT_APP.test(rel) && !TEST.test(rel)).map((rel) => [rel, hash ? digestOf(join(root, rel)) : ""]));

// When the app last loaded its code: its start, or the last reload its output showed.
export const loadedAt = (app) => app.reloadedAt ?? app.startedAt;

// The files that differ from what the app last loaded, newest first, and the newest change of all.
// A file rewritten with the bytes it had (a run's writes put back) has not changed.
export function changesOf({ root, app, skip = new Set() }) {
  const since = Date.parse(loadedAt(app));
  const changed = [];
  let last = null;
  for (const [rel, was] of Object.entries(app.files ?? {})) {
    if (skip.has(rel)) continue;
    let at;
    try { at = statSync(join(root, rel)).mtimeMs; } catch { continue; }
    if (at > since && was && digestOf(join(root, rel)) === was) continue;
    if (at > since) changed.push({ path: rel, at });
    if (!last || at > last.at) last = { path: rel, at };
  }
  return { changed: changed.sort((a, b) => b.at - a.at), last };
}

// The app's source files saved after `since`, the start of the run the next one is compared with, or
// gone since: what a run after a change is scoped by on Cortad's side. A file the app is writing now
// is not a change, nor one holding the bytes it had when the app started before `since` (the app's
// own writes, put back after a run). Null when `since` is not a time.
// `since` is Cortad's clock and a file's time is this machine's: a minute of slack, so a clock running
// behind still counts a save. A save just before the run that is counted again only widens the run.
const SKEW_MS = 60_000;

export function savedSince({ root, files, since, startedAt, skip = new Set() }) {
  const t = Date.parse(since ?? "");
  if (!Number.isFinite(t)) return null;
  const hashedBefore = Date.parse(startedAt ?? "") <= t;
  return Object.entries(files).filter(([rel, was]) => {
    if (skip.has(rel)) return false;
    let at;
    try { at = statSync(join(root, rel)).mtimeMs; } catch { return true; }
    return at > t - SKEW_MS && !(hashedBefore && was && digestOf(join(root, rel)) === was);
  }).map(([rel]) => rel).sort();
}

// The installed Node packages that changed since `since`, among those the app's package.json files
// name, each with the app's files that import it: what a change to a dependency list reaches, since
// the list itself reaches nothing (API simulate/change-scope.ts). Asked only when a list or lock
// file is among the saved files. npm keeps a package's own file times, so its install shows on the
// ctime of its package.json, which no archive can set.
// ponytail: Node packages only; a Python or Go list that changed names no package.
const NODE_LIST = /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/;
const IMPORTS_FROM = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/;
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const MOST_PACKAGES = 200;
const MOST_IMPORTERS = 500;

export function packagesSince({ root, files, saved, since }) {
  const t = Date.parse(since ?? "");
  if (!Number.isFinite(t) || !saved.some((f) => NODE_LIST.test(f))) return [];
  const lists = files.filter((f) => /(?:^|\/)package\.json$/.test(f));
  const dirs = [...new Set([...lists.map(dirname), "."])];
  const installedSince = (name) => dirs.some((d) => { try { return statSync(join(root, d, "node_modules", name, "package.json")).ctimeMs > t - SKEW_MS; } catch { return false; } });
  const names = new Set();
  for (const rel of lists) {
    try { const pkg = JSON.parse(readFileSync(join(root, rel), "utf8")); for (const k of DEP_FIELDS) for (const n of Object.keys(pkg[k] ?? {})) names.add(n); } catch { /* not a list */ }
  }
  const changed = [...names].filter(installedSince).slice(0, MOST_PACKAGES);
  if (!changed.length) return [];
  const sources = files.filter((f) => IMPORTS_FROM.test(f)).map((rel) => { try { return [rel, readFileSync(join(root, rel), "utf8")]; } catch { return [rel, ""]; } });
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return changed.map((name) => {
    const named = new RegExp(String.raw`(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']${escape(name)}(?:/[^"']*)?["']`);
    return { name, files: sources.filter(([, text]) => named.test(text)).map(([rel]) => rel).slice(0, MOST_IMPORTERS) };
  }).filter((p) => p.files.length);
}

// What the run's text says about the code it played (lib/text.mjs testedLine).
export const testedOf = (app, { changed, last }) => ({
  startedAt: app.startedAt,
  ...(last ? { change: { path: last.path, at: new Date(last.at).toISOString() } } : {}),
  ...(app.reloadedAt ? { reloadedAt: app.reloadedAt } : {}),
  ...(changed.length && !app.own ? { stale: true } : {}),
});

// The verbs' side. `fresh` starts the app again through the process holding it up when its code
// changed since it last loaded it, whatever its command says about watching, and waits until it answers on the new code; `tested` is what
// the run is about to play.
export function makeCode({ project, root, waitMs, base, signal = (pid) => process.kill(pid, "SIGUSR2"), now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const current = () => {
    const app = readApp(project, base);
    return app?.startedAt && app.runner === readRunner(project, base)?.pid ? app : null;
  };
  const changes = (app) => changesOf({ root, app, skip: writtenPaths(writesDirOf(homeOf(project, base))) });
  const tested = () => { const app = current(); return app ? testedOf(app, changes(app)) : null; };
  // Every source file the app was started with, whoever holds it up now.
  const saved = (since) => {
    const app = readApp(project, base);
    return Object.keys(app?.files ?? {}).length ? savedSince({ root, files: app.files, since, startedAt: loadedAt(app), skip: writtenPaths(writesDirOf(homeOf(project, base))) }) : null;
  };

  const packages = (since, saved) => packagesSince({ root, files: Object.keys(readApp(project, base)?.files ?? {}), saved, since });

  const fresh = async () => {
    const app = current();
    const { changed } = app ? changes(app) : { changed: [] };
    if (!changed.length || !app.own) return {};
    const asked = now();
    try { signal(app.runner); } catch { return { error: "The process holding your app up could not be asked to start it again for your change." }; }
    while (now() - asked < waitMs) {
      await sleep(500);
      const held = readRunner(project, base);
      if (!held) return { error: "The process holding your app up ended while starting it again for your change." };
      if (held.state === "failed" && Date.parse(held.at) >= asked) return { error: `Your app was started again to play your change and did not come back. ${held.error ?? ""}`.trim() };
      // Started after the ask, or by the command's own restart for the save, which the ask can land in.
      const next = readApp(project, base);
      if (next?.startedAt && (Date.parse(next.startedAt) >= asked || (next.startedAt !== app.startedAt && !changes(next).changed.length))) return { restarted: changed.map((c) => c.path) };
    }
    return { error: `Your app was started again to play your change and has not answered after ${Math.round(waitMs / 1000)} seconds.` };
  };
  return { fresh, tested, saved, packages };
}
