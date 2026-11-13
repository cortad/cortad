#!/usr/bin/env node

import { notAnApp, withoutStores } from "./lib/app-port.mjs";
import { holdsKeys, secretEnvValues } from "./lib/keys.mjs";
import { envFilesNamedIn, parseEnv } from "./lib/env-files.mjs";
import { startCause } from "./lib/start-cause.mjs";
import { spawn, execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, watch, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { COMMANDS, main as face, unknownVerb, VERBS } from "./lib/cli.mjs";
import { addNews, homeOf, projectOf, readPicked, readToken, writeApp, writeDigest, writePicked, writeToken } from "./lib/home.mjs";
import { changesOf, commandText, RELOADED, RELOADER, sourceOf } from "./lib/fresh.mjs";
import { chainOf, elapsedMs, holderOf, listening, listenerOn, portInError, spawnTied, stopTree } from "./lib/proc.mjs";
import { claimRunner, readRunner, releaseRunner, startedAtOf, writeRunner } from "./lib/runner.mjs";
import { agentOf, AGENTS, askAgent, register } from "./lib/register.mjs";
import { CONNECTED, connectedText, NOT_RUNNING } from "./lib/read-text.mjs";
import { VERSION } from "./lib/spec.mjs";
import { credentialShaped, environmentSecrets, maskedLines, maskWith, secretValues } from "./lib/env-secrets.mjs";
import { finished, unseenText } from "./lib/text.mjs";
import { lockHolds, makeLock } from "./lib/lock.mjs";
import { AS_HEADER, CAPTURED, makeCapture } from "./lib/replay.mjs";
import { sampleHere } from "./lib/sample.mjs";
import { composePorts, forContainer, hookable, inContainer, passedThrough, publishedPorts, shownCommand, startPlan, workspaces } from "./lib/start.mjs";
import { openProxy } from "./lib/proxy.mjs";
import { liftedLimits } from "./lib/switches.mjs";
import { downLine, makeHealth } from "./lib/health.mjs";
import { markRun, writesDirOf, writtenPaths } from "./lib/writes.mjs";
import { makeHeld } from "./lib/held.mjs";
import { answerAsk, ASK, makeAutoReach, takeAsk } from "./lib/auto-reach.mjs";
import { ADMIN_CONTROL, SIMULATION_HEADER } from "./lib/reach.mjs";
import { clientOriginOf, envOf, keysFromEnv } from "./lib/origins.mjs";
import { forgetSignIn, keptSignIn, mintAfterYes, rememberSignIn, signUpAndIn, testAccount } from "./lib/sign-in.mjs";
import { clientRequestOf } from "./lib/browser-rung.mjs";
import { layerOf, layerSaid, setsSecret } from "./lib/layer.mjs";
import { ignoredBy, rulesOf } from "./lib/gitignore.mjs";
import { explainText } from "./lib/explain-text.mjs";
import { sourcesIn } from "./lib/history/sources.mjs";
import { report as reportLive } from "./lib/setup-live.mjs";
import { previewText, SEND, sentText } from "./lib/picks.mjs";
import { grpcCall } from "./lib/grpc.mjs";
import { relativePaths } from "./lib/paths.mjs";

const argv = process.argv.slice(2);
const USAGE = `usage: npx cortad <code from the connect screen> -- <how you start your app>   |   npx cortad <code> --port <port of your running app>   |   npx cortad <code> --agent-picks -- <how you start your app>   |   npx cortad --explain   |   npx cortad ${[...VERBS, "send", "wait"].join(" | ")}`;

{
  const dash = argv.indexOf("--");
  const own = dash >= 0 ? argv.slice(0, dash) : argv;
  const FLAGS = new Set(["--port", "--start", "--explain", "--proxy", "--token", "--until-idle", "--verbose", "--agent-picks", "--no-samples"]);
  const unknownFlag = own.some((a, i) => a.startsWith("-") && !FLAGS.has(a) && !["--port", "--start"].includes(own[i - 1] ?? ""));
  if (["help", "-h", "--help"].includes(argv[0]) || (!COMMANDS.has(argv[0] ?? "") && unknownFlag)) {
    console.log(USAGE);
    process.exit(0);
  }
}

if (COMMANDS.has(argv[0] ?? "")) process.exit(await face(argv));

if (unknownVerb(argv[0])) {
  console.error(`cortad  ${argv[0]} is not a command of cortad ${VERSION}. Its commands are ${VERBS.slice(0, -1).join(", ")} and ${VERBS.at(-1)}; npx cortad@latest <command> runs the newest. A connect code is typed in capitals, as the connect screen shows it.`);
  process.exit(1);
}

const dash = argv.indexOf("--");
const own = dash >= 0 ? argv.slice(0, dash) : argv;
const flag = (name) => { const i = own.indexOf(name); return i >= 0 ? own[i + 1] : undefined; };
const verbose = own.includes("--verbose");

let code = (own.find((a) => /^[A-HJ-NP-Za-hj-np-z2-9-]{8,9}$/.test(a) && !a.startsWith("-")) ?? "").toUpperCase().replace(/-/g, "");
const say = (line) => console.log(`cortad  ${line}`);
const fail = (line) => { console.error(`cortad  ${line}`); process.exit(1); };

const explain = own.includes("--explain");

const proxyAsked = own.includes("--proxy");

const viaToken = own.includes("--token");

let lastStep = "";
const step = (line) => {
  if (process.stdout.isTTY) { process.stdout.write(`\rcortad  ${line}\x1b[K`); return; }
  if (line !== lastStep) { lastStep = line; say(line); }
};
const clearStep = () => { if (process.stdout.isTTY) process.stdout.write("\r\x1b[K"); };
const stepDone = (line) => { clearStep(); say(line); };

const words = own.filter((a, i) => !a.startsWith("-") && !["--port", "--start"].includes(own[i - 1] ?? ""));
if (!explain && !viaToken && words.length && !/^[A-Z0-9]{8}$/.test(code)) fail(USAGE);

const origin = new URL(process.env.CORTAD_ORIGIN || "https://cortad.com");

const OURS = ["cortad.com"];
const trusted = (origin.protocol === "https:" && OURS.some((host) => origin.hostname === host || origin.hostname.endsWith(`.${host}`)))
  || origin.hostname === "localhost" || origin.hostname === "127.0.0.1";
if (!trusted) fail(`refusing: ${origin.host} is not Cortad.`);
const api = `${origin.origin}/api`;

const root = process.cwd();
const MANIFEST = ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "docker-compose.yml", "docker-compose.yaml", "Gemfile", "mix.exs", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json", "Dockerfile"];

const dotnetHere = () => { try { return readdirSync(root).some((f) => /\.(?:csproj|fsproj|sln)$/.test(f)); } catch { return false; } };

const startSaid = argv.includes("--") || argv.includes("--start") || argv.includes("--port") || argv.includes("--token");
if (!startSaid && !MANIFEST.some((f) => existsSync(join(root, f))) && !dotnetHere() && !workspaces(root).length) {
  fail(`no project here: this folder has no project file (package.json, pyproject.toml, go.mod, pom.xml, Gemfile, composer.json, Cargo.toml, a .csproj), and neither does any folder in it. Run it from your repository's root, or say how your app starts: npx cortad <code> -- <your start command>`);
}

const project = projectOf(root);

const startFile = join(homeOf(project), "start.json");
const keptStart = (() => { try { return JSON.parse(readFileSync(startFile, "utf8")); } catch { return {}; } })();

const typedNow = dash >= 0 ? own.length === argv.length ? "" : argv.slice(dash + 1).join(" ").trim() : flag("--start") ?? "";
const typed = typedNow || (flag("--port") ? "" : keptStart.cmd ?? "");
const fromSaved = !typedNow && Boolean(typed);

const picks = own.includes("--agent-picks") || (!code && keptStart.picks === true);

const noSamples = picks || own.includes("--no-samples") || (!code && keptStart.noSamples === true);

const wantedPort = Number(flag("--port")) || (!typedNow ? Number(keptStart.port) || 0 : 0);
const onPath = (bin) => (process.env.PATH ?? "").split(":").some((dir) => dir && existsSync(join(dir, bin)));

if (!explain && !viaToken && !typed && !wantedPort) {
  const plan = startPlan({ root, onPath });
  const shown = code || "<code>";
  console.error(`cortad  how does your app start? Run this again with your command after --:`);
  console.error(`cortad    npx cortad ${shown} -- ${plan?.cmd ?? "<your start command>"}${plan?.cmd ? `   (from this folder that looks like it${plan.within ? `, in ${plan.within}` : ""}; change it if not)` : ""}`);
  console.error(`cortad  or, if your app is already running:   npx cortad ${shown} --port ${plan?.cmd ? "<its port>" : "3000"}`);
  process.exit(2);
}
if (viaToken && !typed && !wantedPort) fail("this project has no saved start command. Run npx cortad <code> -- <how you start your app> in this folder once.");

const me = { pid: process.pid, startedAt: startedAtOf(), by: viaToken ? "token" : "connect", reach: "ask", version: VERSION, ...(picks ? { picks: true, picked: readPicked(project).length } : {}) };

let became = null;

let machineOf = () => null;
const become = (state, fields = {}) => { became = { state, fields }; const machine = machineOf(); writeRunner(project, { ...me, ...(machine ? { machine } : {}), state, at: new Date().toISOString(), ...fields }); };
process.on("exit", () => releaseRunner(project));

const heldLine = (held) => `another cortad is already connected in this folder: pid ${held.pid}, started ${new Date(held.startedAt).toTimeString().slice(0, 5)}${held.state === "up" && held.port ? `, with your app answering on port ${held.port}` : ""}. Nothing was changed. To connect again, stop it first (Ctrl-C where it runs, or kill ${held.pid}), then run this command again.`;
function holdProject() {
  const held = claimRunner(project, { ...me, state: "starting", at: new Date().toISOString() });
  if (!held) return;
  if (viaToken) { say(`pid ${held.pid} already holds this project's app up and serves the simulation`); process.exit(0); }
  fail(heldLine(held));
}

if (viaToken) holdProject();
else if (!explain) { const held = readRunner(project); if (held) fail(heldLine(held)); }

const SKIP_DIR = /^(node_modules|\.git|dist|build|out|coverage|vendor|venv|\.venv|env|target|tmp|\.next|\.nuxt|\.turbo|\.cache|__pycache__|\.terraform|\.wrangler|\.svelte-kit|\.output|\.parcel-cache|\.idea|\.vscode|secrets?|\.secrets?|\.ssh|\.gnupg|\.aws|\.?(?:[\w-]*[._-])?logs?)$/i;

const SKIP_FILE = /^\.env(\..*)?$|^\.envrc$|\.env$|^\.(?:npmrc|netrc)$|^id_(?:rsa|ed25519|ecdsa)|\.(pem|key|p12|pfx|jks|keystore|sqlite|sqlite3|db|log|lock|map|zip|tar|gz|tgz|7z|rar|png|jpe?g|gif|webp|ico|svg|mp3|mp4|wav|mov|pdf|woff2?|ttf|otf|eot|bin|exe|dll|so|dylib|wasm|onnx|pt|pth|safetensors|numbers|DS_Store)$/i;

const DATA = /\.(?:csv|tsv|jsonl|ndjson|parquet|xlsx?|arrow|feather|avro)$/i;
const DATA_JSON = 64_000;
const MAX_FILE = 25_000_000;
const MAX_TOTAL = 256_000_000;

const ENV_FILE = /^\.env(\..+)?$|^[\w-]+\.env$|^\.envrc$/;

function walk(dir, depth, out, envs, total, rules = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return total; }
  if (listed === null) { try { rules = [...rules, ...rulesOf(readFileSync(join(dir, ".gitignore"), "utf8"), relative(root, dir).split(sep).join("/"))]; } catch {  } }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (listed === null && ignoredBy(rules, relative(root, full).split(sep).join("/"), e.isDirectory())) continue;
    if (e.isDirectory()) {
      if (depth < 12 && !SKIP_DIR.test(e.name)) total = walk(full, depth + 1, out, envs, total, rules);
      else envsIn(full, envs);
      continue;
    }
    if (ENV_FILE.test(e.name)) { envs.push(full); continue; }
    if (SKIP_FILE.test(e.name)) continue;
    let size;
    try { size = statSync(full).size; } catch { continue; }
    if (size > MAX_FILE || total + size > MAX_TOTAL) continue;
    if (!shareable(relative(root, full), false)) continue;
    out.push(relative(root, full));
    total += size;
  }
  return total;
}

function envsIn(dir, envs) {
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isFile() && ENV_FILE.test(e.name)) envs.push(join(dir, e.name));
  } catch {  }
}

function gitListed() {
  if (!existsSync(join(root, ".git")) && !onPath("git")) return null;
  let inside = false;
  try { inside = execFileSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() === "true"; } catch {  }
  if (!inside) return null;

  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z", "-t", "--cached", "--others", "--exclude-standard"], { maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return new Set(out.toString().split("\0").filter(Boolean).map((e) => e.slice(2)));
  } catch (e) { fail(`could not list this repository's files with git: ${e.message}`); }
}

function shareable(rel, askGit = true) {
  const parts = rel.split(sep);
  if (parts.slice(0, -1).some((d) => SKIP_DIR.test(d)) || SKIP_FILE.test(parts.at(-1))) return false;
  if (listed === null || listed.has(rel)) return true;

  if (!askGit) return false;
  try { execFileSync("git", ["-C", root, "check-ignore", "-q", rel], { stdio: "ignore" }); return false; } catch (e) { return e.status === 1; }
}
let listed = null;

let envKeys = [];

const TEXT_FILE = /\.(?:md|txt|ya?ml|json|ini|toml|cfg|conf|properties)$/i;

function carriesKey(rel) {
  let text; try { text = readFileSync(join(root, rel), "utf8"); } catch { return null; }
  if (holdsKeys(text, envKeys)) return "it holds a value from your env";
  return TEXT_FILE.test(rel) && setsSecret(text) ? "a line in it sets a password, key or token" : null;
}

let secrets = [];

let signInYes = false;

let layer = null;

const LATER_HEADER = "x-cortad-answer", LATER_MISSED = "x-cortad-later", LATER_MARGIN_MS = 5_000;

const RECEIPT_MAX = 16_384;
const receiptOf = (got) => {
  if (got.truncated || !got.body || got.body.length > RECEIPT_MAX) return null;
  try { const v = JSON.parse(got.body); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
};

const trialJars = new Map();

const ownSession = new Set();
const TRIAL_JARS = 500;
let capture = null;

let proxy = null;

const doorPort = () => proxy?.port ?? app?.port;

let unseen = "";

const upAt = (port = app?.port) => {
  const receipts = capture?.receipts() ?? [];
  return { ...(proxy ? { port: proxy.port, host: "127.0.0.1", proxied: port, ...(unseen && !proxy.seen() ? { unseen } : {}) } : { port, host: appHost }), ...(receipts.length ? { receipts } : {}) };
};

let closing = false;
let restarting = false;
let appGone = false;
let lastSaid = "";
let lastOutputAt = Date.now();
let forgetTold = null;

let answering = 0;
const held = makeHeld({ rows: () => capture?.usage()?.rows ?? [], say: (line) => say(line) });

let gate = null;
const hold = () => { if (!gate) { let open; gate = new Promise((r) => { open = r; }); gate.open = () => { gate = null; open(); }; } };
const release = () => gate?.open();
const mask = (text) => maskWith(String(text ?? ""), secrets);

const maskRoutes = (text) => maskWith(String(text ?? ""), secrets.filter(credentialShaped));

let box = "";
let key = "";

const folderName = basename(root).replace(/[^\w.-]/g, "-").slice(0, 80);

async function paired() {
  const opened = await call("POST", "/local/pair", { name: folderName }).catch(unreachable);
  if (!opened.ok) fail(opened.data?.error ?? `could not start connecting (${opened.status})`);
  const link = `${origin.origin}/approve/${opened.data.id}`;
  say(`approve this computer in your browser, where you are signed in to Cortad: ${link}`);
  say(`the page shows ${opened.data.words}; approve only if it matches`);
  if (process.stdout.isTTY) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    try { spawn(opener, [link], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch {  }
  }
  for (const until = Date.now() + 10 * 60_000; Date.now() < until; await new Promise((r) => setTimeout(r, 2_000))) {
    const got = await call("POST", `/local/pair/${opened.data.id}/collect`, { secret: opened.data.secret }).catch(() => null);
    if (got?.ok && typeof got.data?.code === "string") { say("approved"); return got.data.code; }
    if (got && got.status === 410) break;
  }
  fail("the link was not approved within ten minutes. Run npx cortad again for a new one.");
}

async function call(method, path, body, { raw = false, timeoutMs = 60_000, headers = {} } = {}) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { ...(key ? { "x-local-key": key } : {}), "content-type": raw ? "application/octet-stream" : "application/json", ...headers },
    body: body === undefined ? undefined : raw ? body : relativePaths(JSON.stringify(body), { root, home: homedir() }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
  return { status: res.status, ok: res.ok, data };
}

const work = join(tmpdir(), `cortad-${process.pid}`);

const bootLog = join(homeOf(project), "app.log");
const MASKED_AT_END_MAX = 64 * 1024 * 1024;

const printed = [];
const PRINTED = 2000;

const LOG_MAX = 2000;
const logTo = () => maskedLines(() => secrets, (text) => {
  try { appendFileSync(bootLog, text, { mode: 0o600 }); } catch {  }
  printed.push({ at: Date.now(), text });
  if (printed.length > PRINTED) printed.splice(0, printed.length - PRINTED);
});
const printedBetween = (from, to) => printed.filter((p) => p.at >= from && p.at <= to).map((p) => p.text).join("");

const SECRET_PATH = /(?:^|\/)(?:\.git|\.ssh|\.gnupg|\.aws|\.npmrc|\.netrc|id_(?:rsa|ed25519|ecdsa)[^/]*|[^/]*\.(?:pem|key|p12|pfx|jks|keystore))(?:\/|$)/;

const translate = (s) => String(s ?? "").split("/workspace/repo").join(root).split("/tmp/bl-boot.log").join(bootLog).split("/tmp/boot.log").join(bootLog);
const scratch = (p) => { const r = resolve(translate(p)); return r.startsWith("/tmp/") ? join(work, r.slice(5)) : r.startsWith(work + sep) ? r : null; };

const readable = (p) => {
  const r = resolve(translate(p));
  let landed; try { landed = realpathSync(r); } catch { return null; }
  const home = realpathSync(root);
  if (!landed.startsWith(home + sep) || ENV_FILE.test(basename(landed)) || SECRET_PATH.test(landed)) return null;
  const rel = relative(home, landed);
  if (!layer?.set.has(rel)) return null;
  return shareable(rel) && !isData(rel, statSync(landed).size) && !carriesKey(rel) ? landed : null;
};

const plainEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG ?? "C.UTF-8", TMPDIR: work, TERM: "dumb" };
let lock = null;

const OPS = {

  start: async () => { const r = await restartApp(); return { success: !r.error, exitCode: r.error ? 1 : 0, stdout: "", stderr: r.error ?? "" }; },

  test: () => (testDeclared() ? runLocked("npm test") : { success: false, exitCode: 127, stdout: "", stderr: "this project declares no test command in its package.json" }),
};
const testDeclared = () => { try { const t = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts?.test; return typeof t === "string" && !/no test specified/.test(t); } catch { return false; } };
function runOp(b) {
  const run = Object.hasOwn(OPS, b.op) ? OPS[b.op] : null;
  if (!run) return refused(b);
  if (verbose) say(`running ${b.op}`);
  return run();
}

function noteRefused(what, why) {
  const asked = mask(String(what)).replace(/\s+/g, " ").slice(0, 300);
  say(`${why}: ${asked}`);
  try { mkdirSync(homeOf(project), { recursive: true, mode: 0o700 }); appendFileSync(join(homeOf(project), "refused.log"), `${new Date().toISOString()} ${asked}\n`, { mode: 0o600 }); } catch {  }
  return asked;
}
function refused(b) {
  noteRefused(b.op ?? b.cmd ?? "", `refused a command Cortad's server sent, since this machine runs only Cortad's own operations (${Object.keys(OPS).join(", ")})`);
  return { success: false, exitCode: 126, stdout: "", stderr: `refused: this machine runs only Cortad's own operations (${Object.keys(OPS).join(", ")}), never a command it is sent` };
}
const OUTPUT_SENT = 20_000;
function runLocked(cmd) {
  if (!lock) return { success: false, exitCode: 126, stdout: "", stderr: "refused: this machine has no sandbox tool (sandbox-exec or bubblewrap), so nothing is run here" };
  if (lock.refused) return { success: false, exitCode: 126, stdout: "", stderr: `refused: ${lock.refused}` };
  const { file, args } = lock.wrap(cmd);
  return new Promise((done) => {
    const child = spawn(file, args, { cwd: root, env: plainEnv, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";

    const tail = (s, chunk) => (s + chunk).slice(-(OUTPUT_SENT + 4096));
    child.stdout.on("data", (d) => { out = tail(out, d.toString()); });
    child.stderr.on("data", (d) => { err = tail(err, d.toString()); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 280_000);
    child.on("close", (code) => {
      clearTimeout(timer);

      const stderr = mask(err).slice(-OUTPUT_SENT);
      const room = OUTPUT_SENT - stderr.length;
      done({ success: code === 0, exitCode: code ?? 1, stdout: room > 0 ? mask(out).slice(-room) : "", stderr });
    });
    child.on("error", (e) => { clearTimeout(timer); done({ success: false, exitCode: 127, stdout: "", stderr: String(e.message) }); });
  });
}

let app = null;
async function verb(job) {
  const b = job.body ?? {};
  switch (job.verb) {
    case "exec": return runOp(b);
    case "fetch": {

      const port = Number(b.port) || doorPort();
      if (!app || (port !== app.port && port !== doorPort())) return { error: `refused: port ${port} is not your app` };
      const path = typeof b.path === "string" && b.path.startsWith("/") ? b.path : "/";
      const method = String(b.method ?? "GET").toUpperCase();
      const door = `${method} ${path.split("?")[0]}`;

      if (!/^(?:GET|POST|GRPC)$/.test(method)) return { error: `refused: this machine sends your app GET and POST requests only, not ${method.slice(0, 20)}` };

      let pathname = null;
      try { pathname = decodeURIComponent(new URL(path, "http://app").pathname); } catch {  }
      if (pathname === null || ADMIN_CONTROL.test(pathname)) return { error: "refused: its address says it administers your app" };
      const headers = {};
      for (const [k, v] of Object.entries(b.headers ?? {})) if (!/^(host|content-length|connection)$/i.test(k)) headers[k] = String(v);

      const turn = String(Object.entries(headers).find(([k]) => k.toLowerCase() === "x-cortad-turn")?.[1] ?? "");

      if (!turn) headers["x-cortad-turn"] = `cortad-${String(job.id).replace(/[^\w.-]/g, "").slice(0, 64)}`;
      if (verbose) say(`$ ${String(b.method ?? "GET").toUpperCase()} ${path.split("?")[0]} as ${headers[AS_HEADER] ?? headers[AS_HEADER.toLowerCase()] ?? "nobody"}, turn ${headers["x-cortad-turn"]}`);
      const letGo = held.hold(job.id, turn || headers["x-cortad-turn"]);

      const laterAt = Object.keys(headers).find((k) => k.toLowerCase() === LATER_HEADER);
      const laterMs = laterAt === undefined ? NaN : Number(headers[laterAt]);
      const later = laterAt !== undefined && (headers[laterAt] === "later" || laterMs > 0);
      if (laterAt !== undefined) delete headers[laterAt];
      if (later) capture?.forget(turn || headers["x-cortad-turn"]);

      const marker = Object.keys(headers).find((k) => k.toLowerCase() === AS_HEADER);
      let spokenAs = null;
      if (marker) {
        const role = headers[marker];
        delete headers[marker];
        if (role === CAPTURED || role.startsWith(`${CAPTURED}:`)) {
          spokenAs = role;
          const theirs = capture?.headers(role, door);
          for (const [name, value] of Object.entries(theirs ?? {})) { for (const k of Object.keys(headers)) if (k.toLowerCase() === name) delete headers[k]; headers[name] = value; }
        }
      }
      headers[SIMULATION_HEADER] = "1";

      if (method === "GRPC") {
        try {
          const out = await grpcCall({ path, body: b.body, headers, port: app.port, appDir, root });
          return { status: out.status, headers: { "content-type": out.type }, body: mask(out.text), truncated: false };
        } finally { held.done(job.id); }
      }
      const init = { method, headers, redirect: "manual" };

      const body = spokenAs ? capture?.bodyAs(spokenAs, `${method} ${path.split("?")[0]}`, b.body) ?? b.body : b.body;
      if (body !== undefined && method !== "GET" && method !== "HEAD") init.body = typeof body === "string" ? body : JSON.stringify(body);

      const url = proxy ? `http://127.0.0.1:${proxy.port}${path}` : hostUrl(port, path);

      const yours = (to) => { try { const u = new URL(to, url); return ["127.0.0.1", "::1", "[::1]", "localhost"].includes(u.hostname) && [new URL(url).port, String(app.port)].includes(u.port) ? new URL(u.pathname + u.search, url).href : null; } catch { return null; } };

      const trial = turn.replace(/:\d+$/, "");
      let jar = trial ? trialJars.get(trial) ?? "" : "";

      const holdMs = Math.min(Math.max(Number(b.waitMs) || 170_000, 1_000), 630_000);
      const began = Date.now();

      const cookieAt = Object.keys(headers).find((k) => k.toLowerCase() === "cookie");
      const { [cookieAt ?? ""]: given = "", ...cookieless } = headers;
      const cookie = () => [...new Map([...given.split(/;\s*/), ...jar.split(/;\s*/)].filter(Boolean).map((pair) => [pair.split("=")[0].trim(), pair])).values()].join("; ");

      const fresh = Boolean(trial && given && !trialJars.has(trial) && !ownSession.has(door));
      const visitor = async () => {
        const res = await fetch(url, { method: "GET", headers: cookieless, redirect: "manual", signal: AbortSignal.any([letGo, AbortSignal.timeout(15_000)]) }).catch(() => null);
        await res?.arrayBuffer().catch(() => null);
        return (res?.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).filter(Boolean).join("; ");
      };
      const sent = (at, over = {}) => fetch(at, {
        ...init, ...over,
        headers: { ...(jar ? cookieless : headers), ...(over.headers ?? {}), ...(jar ? { cookie: cookie() } : {}) },
        signal: AbortSignal.any([letGo, AbortSignal.timeout(holdMs)]),
      });
      const keep = (res) => {
        const set = res.headers.getSetCookie?.() ?? [];
        if (!set.length) return;
        const pairs = new Map([...jar.split(/;\s*/), ...set.map((c) => c.split(";")[0])].filter(Boolean).map((pair) => [pair.split("=")[0].trim(), pair]));
        jar = [...pairs.values()].join("; ");
        if (trial) { trialJars.delete(trial); trialJars.set(trial, jar); if (trialJars.size > TRIAL_JARS) trialJars.delete(trialJars.keys().next().value); }
      };
      const sentBack = (res) => (res.status >= 300 && res.status < 400 ? yours(res.headers.get("location") ?? "") : null);
      const warm = async () => {
        let at = url;
        for (let hop = 0; hop < 4 && at; hop++) {
          const res = await sent(at, { method: "GET", body: undefined });
          keep(res);
          at = sentBack(res);
        }
      };
      const ask = async () => {
        if (fresh) { jar = await visitor(); if (jar) trialJars.set(trial, jar); }
        let res = await sent(url);
        keep(res);
        if (fresh && jar && (res.status === 401 || res.status === 403)) {
          ownSession.add(door);
          jar = "";
          trialJars.delete(trial);
          await res.arrayBuffer().catch(() => null);
          res = await sent(url);
          keep(res);
        }
        if (method !== "GET" && sentBack(res)) { await warm(); if (jar) res = await sent(url); }
        const buf = Buffer.from(await res.arrayBuffer());

        const LIMIT = Number.isInteger(b.limit) && b.limit > 0 ? Math.min(b.limit, 8 * 1024 * 1024) : 262_144;

        const said = Object.fromEntries([...res.headers].filter(([k]) => !/^set-cookie2?$/i.test(k)).map(([k, v]) => [k, mask(v)]));
        return { status: res.status, headers: said, body: mask(buf.subarray(0, LIMIT).toString("utf8")), truncated: buf.length > LIMIT };
      };
      const counted = async () => { await gate; letGo.throwIfAborted(); answering += 1; try { return await ask(); } finally { answering -= 1; } };

      const answered = async (got) => {
        if (!later || got.status < 200 || got.status >= 300) return got;
        const until = began + Math.min(holdMs, laterMs > 0 ? laterMs : Infinity) - LATER_MARGIN_MS;
        const said = capture ? await capture.answered(turn || headers["x-cortad-turn"], until, letGo) : null;
        if (letGo.aborted) return { error: "cancelled by the simulation" };
        if (!said?.reply.trim()) return { ...got, headers: { ...got.headers, [LATER_MISSED]: JSON.stringify(said ? { model: said.status } : { waited: Math.round((Date.now() - began) / 1000) }) } };

        const own = receiptOf(got);
        return { ...got, headers: { "content-type": "application/json" }, body: mask(JSON.stringify({ reply: said.reply, ...(own ? { receipt: own } : {}) })), truncated: false };
      };
      try { return await answered(await counted()); }
      catch (e) {
        if (letGo.aborted) return { error: "cancelled by the simulation" };
        const code = String(e.cause?.code ?? e.code ?? "");
        if (!/ECONNREFUSED|ECONNRESET|EPIPE|UND_ERR_SOCKET/.test(code)) return { error: `nothing answered at port ${port}: ${code || e.message}` };

        for (let i = 0; (i < 45 || restarting) && !letGo.aborted && !(await answers(app.port)); i++) await new Promise((r) => setTimeout(r, 1000));
        try { return { ...(await answered(await counted())), heldForRestart: true }; }
        catch (again) { return { error: letGo.aborted ? "cancelled by the simulation" : `nothing answered at port ${port}: ${String(again.cause?.code ?? again.message)}` }; }
      } finally { held.done(job.id); }
    }

    case "cancel": return { cancelled: held.letGo([String(b.id ?? "")]) };
    case "read": {
      const p = readable(b.path);
      if (!p) return { error: "bad path" };
      try { return { content: mask(readFileSync(p, "utf8")) }; } catch (e) { return { error: String(e.code ?? e.message) }; }
    }
    case "write": {
      const bytes = Buffer.from(String(b.b64 ?? ""), "base64");

      const mine = scratch(b.path);
      if (!mine) return { success: false, stderr: "this program does not write your files" };
      try {
        mkdirSync(dirname(mine), { recursive: true });
        if (b.append) appendFileSync(mine, bytes); else writeFileSync(mine, bytes);

        if (mine === join(work, "tools.json")) {
          try { mkdirSync(homeOf(project), { recursive: true, mode: 0o700 }); writeFileSync(join(homeOf(project), "tools.json"), bytes, { mode: 0o600 }); } catch {  }
          void recordTools();
        }
        return { success: true, stderr: "" };
      }
      catch (e) { return { success: false, stderr: String(e.message) }; }
    }

    case "mint": return { identities: [] };

    case "log": {
      const want = Math.min(Math.max(Number(b.bytes) || LOG_MAX, 1), LOG_MAX);
      try {
        const all = readFileSync(bootLog);

        const wide = mask(all.subarray(Math.max(0, all.length - want - 4096)).toString("utf8").replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
        const text = wide.slice(-want);

        const jvm = /\bat\s+[\w$.]+\([\w$]+\.(?:java|kt|scala|groovy):\d+\)/.test(text);
        const sent = [...(layer?.set ?? [])].filter((f) => !jvm || /\.(?:java|kt|scala|groovy)$/.test(f));
        return { text, size: all.length, files: sent.slice(0, 20_000) };
      } catch { return { text: "", size: 0 }; }
    }

    case "consent": say("the person's answer on the card in the browser arrived"); return { ok: true };

    case "say": {

      const line = String(b.line ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
      if (line) say(line);
      if (line && b.news) { try { addNews(project, line); } catch {  } }
      return { ok: true };
    }
    case "restart": return restartApp();

    case "sample": return { report: noSamples ? { stores: [], off: true } : JSON.parse(mask(JSON.stringify(await sampleHere(b, appEnv(), root, mayOpen)))) };
    case "lock": return { locked: Array.isArray(b.hosts) ? b.hosts.length : 0 };

    case "usage": return capture ? JSON.parse(mask(JSON.stringify({ ...capture.usage(b.turn, b.totals === true), tools: capture.tools() ?? { wrapped: [], unwatched: [] } }))) : {};

    case "routes": return capture ? JSON.parse(maskRoutes(JSON.stringify(capture.registry(app?.port)))) : {};

    case "destroy": return { ok: true };
    default: return { error: `refused: this machine does not know the request ${noteRefused(`verb ${job.verb}`, "refused a request Cortad's server sent, since this machine does not know it")}` };
  }
}

const exec = promisify(execFile);

let appHost = "127.0.0.1";
const hostUrl = (port, path = "/") => `http://${appHost === "::1" ? "[::1]" : appHost}:${port}${path}`;
const answers = async (port) => {
  for (const host of [appHost, appHost === "::1" ? "127.0.0.1" : "::1"]) {
    try {
      const res = await fetch(`http://${host === "::1" ? "[::1]" : host}:${port}/`, { method: "GET", signal: AbortSignal.timeout(2500), redirect: "manual" });
      const head = await res.text().then((t) => t.slice(0, 300), () => "");
      if (notAnApp(head)) return false;
      appHost = host;
      return true;
    } catch {  }
  }
  return false;
};

const appEnv = () => Object.assign({}, ...envFiles.filter((f) => !/\.(example|sample)$/.test(f)).map((f) => { try { return parseEnv(readFileSync(f, "utf8"), process.env); } catch { return {}; } }));
const modelHints = () => ({ ...appEnv(), ...process.env });

const appDir = root;

let child = null;

const UNSEEN = "your app was already running, so Cortad sees its replies and not the calls it makes to its model.";
const keepStart = (record) => { Object.assign(keptStart, record); try { mkdirSync(homeOf(project), { recursive: true, mode: 0o700 }); writeFileSync(startFile, JSON.stringify(keptStart), { mode: 0o600 }); } catch {  } };
async function startApp() {

  if (wantedPort && !typed) {
    if (!(await answers(wantedPort))) return { port: null, said: "", why: `nothing is answering on port ${wantedPort}, so there is nothing to ask. Start your app, then run this again.`, noStart: true };
    await useProxy();
    say(`${UNSEEN} To see them, start it through Cortad instead: npx cortad ${code || "<code>"} -- <how you start your app>`);
    keepStart({ port: wantedPort });
    return { port: wantedPort, cmd: null };
  }
  const sourceFiles = files.map((f) => join(root, f));

  const lifted = liftedLimits(sourceFiles);
  const raised = Object.keys(lifted);
  if (raised.length) say(`raising your app's request-rate and concurrency limits while Cortad tests it, so its simulated users are not blocked: ${raised.join(", ")}. Spend and budget limits are left as they are`);
  launched = { cmd: typed, lifted };
  if (proxyAsked || !hookable(appDir, typed)) await useProxy();
  step(`starting your app with: ${shownCommand(typed, mask)}${fromSaved ? " (saved from your last connect)" : ""}`);
  const up = await launch(180_000);
  if (up.port) {
    keepStart({ cmd: typed, ...(wantedPort ? { port: wantedPort } : {}) });

    if (proxy && inContainer(typed)) sayIf(containerLine());
    return { port: up.port, cmd: launched.cmd, lifted: raised };
  }
  if (up.tail) console.error(up.tail);
  return { port: null, said: up.tail, why: whyNot(up) };
}

function whyNot(up) {
  const h = up.held;
  if (h) return `port ${h.port} is in use by another program (pid ${h.pid}${h.command ? `, ${h.command}` : ""}), so your app cannot listen there. Stop that program and save a file here, and your app is started again by itself; or run this command with --port ${h.port} to use the one running as it is.`;
  const cause = startCause(up.tail);
  return `${up.exited !== null ? "your app stopped before it answered" : "your app did not answer within three minutes"}. ${cause ? `${cause}. ` : ""}What it printed is above, and it is your app's own output. Fix it and save a file here: your app is started again by itself with the same command.`;
}

let loaded = null;
const loadedSince = () => loaded.reloadedAt ?? loaded.at;
const noteApp = () => writeApp(project, loaded?.at
  ? { runner: process.pid, own: loaded.own, startedAt: new Date(loaded.at).toISOString(), ...(loaded.reloadedAt ? { reloadedAt: new Date(loaded.reloadedAt).toISOString() } : {}), files: loaded.files }
  : { runner: process.pid });
async function noteAttached(port) {
  const pid = await listenerOn(port);
  const chain = pid ? await chainOf(pid).catch(() => []) : [];
  loaded = { own: false, at: chain.length ? Date.now() - elapsedMs(chain[0].etime) : null, files: sourceOf(root, files, false) };
  noteApp();
}

let launched = null;

async function launch(waitMs) {
  const up = await start(waitMs);
  if (up.port && !proxy && !(await hookedAt(up.port))) return startProxied(up, waitMs);
  return up;
}

const hookedAt = async (port) => { const pid = await listenerOn(port); return !pid || capture.hookedAt(port, pid); };

async function useProxy() {
  if (proxy) return;
  const noted = () => { if (became?.state === "up") become("up", { ...became.fields, ...upAt(became.fields.proxied) }); };

  proxy = await openProxy({

    modelPort: Number(keptStart.modelPort) || 0,
    file: capture.file, rulesFile: capture.rulesFile, target: () => ({ host: appHost, port: app?.port }),
    onSeen: () => { forgetTold?.(); noted(); },
    onUnseen: (door) => { unseen = door; noted(); say(unseenText(door)); },
  });
  keepStart({ modelPort: proxy.modelPort });
  say("your app's model calls are seen through a local proxy on this machine, so the line of code that made each call is not known. During a simulation, its calls to other services go out as they would for a real customer: a conversation that books, charges or emails does it for real");
}
const sayIf = (line) => { if (line) say(line); };

const containerLine = () => {

  const hints = modelHints();
  const handed = proxy.env(hints);
  const named = Object.keys(handed).filter((name) => name in hints);
  const passed = passedThrough(launched?.cmd);

  const missing = (named.length ? named : ["OPENAI_BASE_URL"]).filter((name) => !passed.has(name));
  if (!missing.length) return "";
  const settings = missing.map((name) => `${name}=${forContainer(handed)[name]}`);
  return `your app runs in a container, where Cortad's hook cannot load: its replies are seen through the proxy, its model calls are not. To see them, give the container ${settings.length === 1 ? "this setting" : "these settings"} and start it again with this command (the same port on every connect of this folder): ${settings.join(", ")}`;
};

async function startProxied(up, waitMs) {
  await useProxy();
  if (inContainer(launched?.cmd)) {
    sayIf(containerLine());
    return up;
  }
  await stopTree(child.pid);
  for (let i = 0; i < 75 && (await listenerOn(up.port)); i++) await new Promise((r) => setTimeout(r, 200));
  return start(waitMs);
}

async function start(waitMs) {
  const { cmd, lifted } = launched;
  const cmdText = commandText(cmd, appDir);

  try { markRun(writesDirOf(homeOf(projectOf(root))), "session", { keep: true }); } catch {  }
  toolsAtStart = toolsNow();

  const note = { own: true, at: Date.now(), reloads: RELOADER.test(cmdText), answered: false };
  note.files = sourceOf(root, files);
  loaded = note;

  const base = { ...process.env, ...lifted };
  child = spawnTied(cmd, { cwd: appDir, env: { ...base, ...(proxy ? (inContainer(cmd) ? forContainer(proxy.env(modelHints())) : proxy.env(modelHints())) : capture.env(base)), FORCE_COLOR: "0" } });
  const mine = child;
  become("starting", { app: mine.pid ?? null });
  let seen = "";
  const onData = (log) => (d) => {
    const s = d.toString(); log(d); seen = (seen + s).slice(-20_000); lastSaid = seen; lastOutputAt = Date.now(); if (verbose) process.stdout.write(s);
    if (!note.reloads && RELOADER.test(s)) note.reloads = true;

    if (RELOADED.test(s)) { note.reloadedAt = Date.now(); note.files = sourceOf(root, files); if (note.answered && loaded === note) noteApp(); }
  };
  mine.stdout.on("data", onData(logTo()));
  mine.stderr.on("data", onData(logTo()));
  let exited = null;
  appGone = false;
  mine.on("exit", (code) => { exited = code ?? 1; if (child === mine) appGone = true; });
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    const tail = () => seen.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter(Boolean).slice(-25).join("\n");

    const taken = /EADDRINUSE|address already in use/i.test(seen);
    if (exited !== null && !taken) return { port: null, exited, tail: tail() };

    if (taken || /app crashed - waiting for file changes|waiting for (?:file )?changes before restart|Failed running/i.test(seen)) {
      await stopTree(mine.pid);
      if (!taken) return { port: null, exited: 1, tail: tail() };

      const port = portInError(seen);
      return { port: null, exited: 1, tail: tail(), held: port ? await holderOf(port) : null };
    }

    const ports = await listening(mine.pid);

    const plain = withoutStores(seen.replace(/\x1b\[[0-9;]*m/g, ""));
    const said = [...plain.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b|\bport\s*[:=]?\s*(\d{4,5})\b/gi)].map((m) => Number(m[1] || m[2])).reverse();

    const alsoSaid = inContainer(cmdText) ? [...publishedPorts(cmdText), ...composePorts(cmdText, appDir), ...said] : [];
    for (const port of [...new Set([...(wantedPort ? [wantedPort] : []), ...said.filter((p) => ports.includes(p)), ...ports, ...alsoSaid])]) {
      if (await answers(port)) {
        note.answered = true;
        if (loaded === note) noteApp();
        return { port, exited: null, tail: "" };
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  await stopTree(mine.pid);
  return { port: null, exited: null, tail: seen.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter(Boolean).slice(-12).join("\n") };
}

const DRAIN_MS = 20_000;

let restartDone = null;

const toolsNow = () => { try { return readFileSync(join(work, "tools.json"), "utf8"); } catch { return ""; } };
let toolsAtStart = "";
const listCameLate = () => { const now = toolsNow(); return now !== "" && now !== "[]" && now !== toolsAtStart; };

async function recordTools() {
  if (restartDone) await restartDone;
  if (!launched || !child || closing || !listCameLate()) return;
  await restartApp("starting your app again so the tools your code gives its model are recorded");
}
function restartOnce(work) {
  restartDone ??= (async () => {
    restarting = true;
    try { return await work(); } finally { restarting = false; restartDone = null; }
  })();
  return restartDone;
}
const SAVED_CODE = "starting your app again so it runs the code you saved since it last started or reloaded";

const SAVED_ENV = "starting your app again so it reads the value you saved in your env file, which your app reads only when it starts";

function restartApp(why = SAVED_CODE) {
  if (!launched || !child) return Promise.resolve({ error: "You started this app yourself, so restart it in your own terminal. Most dev servers reload on save." });
  return restartOnce(async () => {
    hold();
    say(why);
    try {
      for (const end = Date.now() + DRAIN_MS; answering > 0 && Date.now() < end;) await new Promise((r) => setTimeout(r, 250));
      return await restartNow();
    } finally { release(); }
  });
}

const savedSinceStart = () => Boolean(loaded?.files) && changesOf({
  root, app: { startedAt: new Date(loadedSince()).toISOString(), files: loaded.files }, skip: writtenPaths(writesDirOf(homeOf(project))),
}).changed.length > 0;

const envSavedSinceStart = () => Boolean(loaded?.own && loaded.at) && envFiles.some((f) => {
  try { return !/\.(example|sample)$/.test(f) && statSync(f).mtimeMs > loadedSince(); } catch { return false; }
});

const whyRestart = () => (savedSinceStart() ? SAVED_CODE : envSavedSinceStart() ? SAVED_ENV : null);

async function restartOnSave() {
  while (!closing) {
    for (let why = whyRestart(); !closing && launched && child && !appGone && !loaded?.reloads && why; why = whyRestart()) await restartApp(why);
    await sourceChanged();
  }
}
async function restartNow() {
  const port = app.port;
  await stopTree(child.pid);

  for (let i = 0; i < 75 && (await listenerOn(port)); i++) await new Promise((r) => setTimeout(r, 200));
  const up = await launch(90_000);
  if (!up.port) {
    const error = up.held ? sentence(whyNot(up)) : up.exited !== null ? `Your app exited ${up.exited} on restart.\n${up.tail}` : "Your app was restarted but did not answer within 90 seconds.";
    become("failed", { error: mask(error).slice(-600) });
    return { error };
  }
  become("up", { ...upAt(up.port), app: child?.pid ?? null });

  const moved = up.port !== port;
  if (moved) app = up;
  const told = await announce().catch(() => null);
  if (moved && !told?.ok) return { error: `Your app came back on port ${up.port}, not ${port}. Run the command again to reconnect.` };
  if (moved) say(`your app came back on port ${up.port}; the simulation follows it there`);
  return { restarted: true, port: up.port };
}
const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const lastLines = (said) => mask(String(said ?? "").split("\n").filter(Boolean).slice(-12).join("\n")).slice(-1500);
const failedWith = (why, said) => become("failed", { error: mask(why), ...(said ? { said: lastLines(said) } : {}) });

async function close(code = 0) {
  if (closing) return;
  closing = true;
  try {
    if (child?.pid) await stopTree(child.pid);
    proxy?.close();

    if (readRunner(project)?.pid === process.pid) {
      try { if (statSync(bootLog).size <= MASKED_AT_END_MAX) writeFileSync(bootLog, mask(readFileSync(bootLog, "utf8"))); } catch {  }
    }
    if (box) await call("DELETE", `/local/${box}`, undefined, { timeoutMs: 5000 }).catch(() => {});
    await exec("rm", ["-rf", work]).catch(() => {});
  } finally { process.exit(code); }
}
const quit = (line) => { try { console.error(`cortad  ${line}`); } catch {  } return close(1); };
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => close(0));
process.on("uncaughtException", (e) => { void quit(e?.stack ?? String(e)); });

say("getting ready");
step("looking at this folder");
const envFiles = [];
const files = [];
listed = gitListed();
walk(root, 0, files, envFiles, 0);

for (const named of envFilesNamedIn(typed, appDir)) if (!envFiles.includes(named)) envFiles.push(named);
const shellSecrets = environmentSecrets(process.env);
secrets = secretValues(envFiles, shellSecrets);
envKeys = [...secretEnvValues(envFiles, (f) => readFileSync(f, "utf8")), ...shellSecrets];
const keyed = [];
for (let i = files.length - 1; i >= 0; i -= 1) if (carriesKey(files[i])) keyed.unshift(...files.splice(i, 1));

const candidatesOf = (rels) => rels.flatMap((rel) => { let full; try { full = readFileSync(join(root, rel), "utf8"); } catch { return []; } return [{ path: rel, head: full.slice(0, 4000), size: Buffer.byteLength(full), full }]; });
const isData = (rel, size) => DATA.test(rel) || (/\.json$/i.test(rel) && size > DATA_JSON);

let walked = null;
const mayOpen = (rel) => {
  if (!(walked ??= new Set(files)).has(rel) || !shareable(rel)) return false;
  try { return !isData(rel, statSync(join(root, rel)).size) && !carriesKey(rel); } catch { return false; }
};

const toSend = () => {
  const candidates = candidatesOf([...files, ...keyed]);
  const chosen = layerOf(candidates);
  const size = new Map(candidates.map((c) => [c.path, c.size]));
  const key = (rel) => keyed.includes(rel);
  const kept = chosen.files.filter((rel) => !isData(rel, size.get(rel)) && !key(rel));

  const sentBefore = readPicked(project).filter((rel) => !kept.includes(rel) && !judged(rel).why);
  const all = [...kept, ...sentBefore];
  const why = new Map([...kept.map((rel) => [rel, chosen.why.get(rel)]), ...sentBefore.map((rel) => [rel, "sent"])]);
  const held = [...chosen.held, ...[...chosen.files, ...chosen.fed].filter(key).map((path) => ({ path, why: "secret" }))].sort((a, b) => a.path.localeCompare(b.path));
  return { ...chosen, files: all, why, data: chosen.files.filter((rel) => !kept.includes(rel) && !key(rel)), fed: chosen.fed.filter((rel) => !all.includes(rel) && !key(rel)), held };
};

const pickedLayer = (rels) => {
  const candidates = candidatesOf(rels);
  const chosen = layerOf(candidates);
  return { ...chosen, files: candidates.map((c) => c.path) };
};

const refusalOf = (rel) => {
  const name = basename(rel);
  if (ENV_FILE.test(name) || /\.env$/i.test(name)) return "an env file";
  if (SECRET_PATH.test(rel)) return "a key or credential file";
  if (rel.split(sep).slice(0, -1).some((d) => SKIP_DIR.test(d)) || SKIP_FILE.test(name)) return "not source code: dependencies, build output, media, archives and keys never leave";
  if (!shareable(rel)) return "git ignores it";
  const { size } = statSync(join(root, rel));
  if (isData(rel, size)) return "a data file (CSV, JSON Lines, Parquet, a spreadsheet or JSON over 64 KB), and data files never leave";
  if (size > MAX_FILE) return "too large";
  return carriesKey(rel);
};
const judged = (arg) => {
  let landed; try { landed = realpathSync(resolve(root, String(arg))); } catch { return { arg, why: "no such file in this folder" }; }
  const home = realpathSync(root);
  if (!landed.startsWith(home + sep)) return { arg, why: "outside this folder" };
  if (!statSync(landed).isFile()) return { arg, why: "not a file" };
  const rel = relative(home, landed);
  const why = refusalOf(rel);
  return why ? { arg, why } : { arg, rel };
};

const pickedSet = (args) => {
  const asked = args.map(judged);
  const refused = asked.filter((j) => j.why).map(({ arg, why }) => ({ arg, why }));
  const files = [...new Set(asked.filter((j) => j.rel).map((j) => j.rel))];
  const picked = [...new Set([...readPicked(project).filter((rel) => !judged(rel).why), ...files])];
  const all = [...new Set([...(picks ? [] : layer?.set ?? []), ...picked])];
  const chosen = pickedLayer(all);
  return { files, picked, all, why: chosen.why, prompts: chosen.pack.prompts, chosen, refused };
};

if (explain) {
  console.log(explainText(toSend(), files.length + keyed.length));
  process.exit(0);
}
mkdirSync(work, { recursive: true });
const keepSecret = (v) => { if (v && v.length >= 12 && !secrets.includes(v)) secrets.push(v); };

capture = makeCapture({ work, keepSecret, signIns: join(homeOf(projectOf(root)), "sign-ins.json"), signInsKept: () => signInYes, writes: join(homeOf(projectOf(root)), "writes"), root, files: () => [...(layer?.set ?? [])], appFolder: () => relative(root, appDir), printed: printedBetween, onProof: (proof) => {
  let masked;
  try { masked = JSON.parse(mask(JSON.stringify(proof))); } catch { return; }
  call("POST", `/local/${box}/proof`, masked).catch(() => {});
} });
if (!files.length) fail("no source files here to read.");

try { copyFileSync(join(homeOf(project), "tools.json"), join(work, "tools.json")); } catch {  }

let stored = readToken(project);
if (viaToken && !stored) fail("this project has no stored key. Run npx cortad in this folder once.");

const unreachable = (err) => fail(`could not reach ${origin.host}: ${err?.name === "TimeoutError" ? "it did not answer in time" : "the connection failed"}. Check your connection and run the command again.`);

let attach = !code && !viaToken && !stored ? null : await call("POST", "/local/attach", { ...(viaToken ? {} : { code }), name: folderName, project },
  stored ? { headers: { authorization: `Bearer ${stored}` } } : {}).catch(unreachable);

if (!viaToken && !code && !attach?.ok) {
  if (attach && stored) { say("the key this folder kept no longer signs in, so this computer is connected again"); stored = null; }
  code = await paired();
  attach = await call("POST", "/local/attach", { code, name: folderName, project }).catch(unreachable);
}
if (!attach.ok) fail(attach.data?.error ?? `could not sign in (${attach.status})`);
box = attach.data.box;
key = attach.data.key;

{
  const chosen = picks ? pickedSet([]).chosen : toSend();
  layer = { ...layerSaid(chosen), set: new Set(chosen.files) };

  if (!picks) me.fed = chosen.fed;
}
if (!viaToken && (picks || keptStart.picks)) keepStart({ picks });
if (!viaToken && (noSamples || keptStart.noSamples)) keepStart({ noSamples });

if (!viaToken) holdProject();
writeFileSync(bootLog, "", { mode: 0o600 });

const list = join(work, "files.txt");
const archive = join(work, "tree.tgz");

async function packed(rels) {
  writeFileSync(list, rels.join("\n") + "\n");
  const h = createHash("sha256");
  for (const rel of [...rels].sort()) {
    let body = Buffer.alloc(0);
    try { body = readFileSync(join(root, rel)); } catch { continue; }
    h.update(rel).update("\0").update(createHash("sha256").update(body).digest("hex")).update("\n");
  }

  await exec("tar", ["-czf", archive, "-C", root, "-T", list], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return { bytes: readFileSync(archive), digest: h.digest("hex") };
}

const head = (() => {
  try {
    const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return /^[a-f0-9]{40}$/.test(sha) ? sha : "";
  } catch { return ""; }
})();

const firstStart = startApp();
firstStart.catch(() => {  });
step("connecting to your Cortad account");
const PART = 1_500_000;
let resumed = false;
let moved = false;

async function sendTree({ bytes, digest }) {
  const parts = Math.max(1, Math.ceil(bytes.length / PART));
  for (let off = 0; off < bytes.length; off += PART) {
    const last = off + PART >= bytes.length;
    step(parts > 1 ? `connecting to your Cortad account, ${Math.floor(off / PART) + 1} of ${parts}` : "connecting to your Cortad account");

    const put = await call("PUT", `/local/${box}/tree?part=${Math.floor(off / PART)}&last=${last ? 1 : 0}${last ? `&digest=${digest}${head ? `&head=${head}` : ""}&layer=1&files=${layer.files}&prompts=${layer.prompts}&calls=${layer.modelCalls}&evals=${layer.evals}` : ""}`, bytes.subarray(off, off + PART),
      { raw: true, timeoutMs: 120_000, ...(last && !viaToken && (!stored || code) ? { headers: { "x-cortad-machine": folderName } } : {}) }).catch((err) => ({ ok: false, status: 0, err }));
    if (!put.ok) return put;
    if (last) {
      resumed = put.data?.resumed === true;
      moved = put.data?.moved === true;
      if (typeof put.data?.machineKey === "string" && put.data.machineKey) writeToken(project, put.data.machineKey);
      writeDigest(project, digest);
    }
  }
  return { ok: true };
}
async function upload(rels) {
  const tree = await packed(rels);
  let sent = await sendTree(tree);
  if (!sent.ok && sent.status !== 401 && sent.status !== 404) {
    await new Promise((r) => setTimeout(r, 2000 + Math.random() * 3000));
    sent = await sendTree(tree);
  }
  return sent;
}

if (layer.set.size || !picks) {

  const sent = await upload(picks ? [...layer.set] : files.filter((rel) => layer.set.has(rel)));
  if (!sent.ok) sent.err ? unreachable(sent.err) : fail(sent.data?.error ?? `upload failed (${sent.status})`);
}

{
  const found = sourcesIn({ ...envOf(root), ...process.env }).map((s) => s.id);
  if (found.length) void reportLive({ apiBase: api, token: readToken(project) }, { found });
}

stepDone(picks && !layer.set.size ? "connected to your Cortad account: it has none of your files yet, and your coding agent picks them" : moved ? "connected to your Cortad account: your change is in, and what Cortad studied before still stands" : resumed ? "connected to your Cortad account: your code has not changed since last time" : "connected to your Cortad account");

if (!viaToken && process.env.CORTAD_NO_REGISTER !== "1") {
  const agent = agentOf() ?? await askAgent();
  const got = agent ? await register(agent, { root }).catch((err) => { if (verbose) say(`could not register with ${AGENTS[agent]}: ${err?.message ?? err}`); return null; }) : null;
  if (got?.changed.length) say(`Cortad's tools and skill were added to ${got.agent} for this project: ${got.changed.join(", ")}.`);
}

lock = await makeLock({ root, work, envFiles });
if (lock && !lockHolds(lock, root)) lock = null;
if (!lock) say("running your tests is off on this machine (no sandbox-exec or bubblewrap). Everything else works.");
else if (lock.refused) say(`${lock.refused} Everything else works.`);

const NOT_A_FIX = /(?:^|[\\/])(?:node_modules|\.git|\.next|\.nuxt|\.turbo|\.cache|dist|build|coverage|logs?|tmp|__pycache__|\.venv|venv)(?:[\\/]|$)|\.log$/;
function sourceChanged() {
  return new Promise((resolve) => {
    let timer = null;
    let watcher = null;
    const done = () => { try { watcher?.close(); } catch {  } resolve(); };
    try {
      watcher = watch(root, { recursive: true }, (_event, file) => {
        if (!file || NOT_A_FIX.test(String(file))) return;
        clearTimeout(timer);
        timer = setTimeout(done, 1200);
      });
    } catch { setTimeout(done, 15_000); }
  });
}

const announce = async () => {

  if (picks && !layer.set.size) return { ok: true };
  const hooked = Boolean(proxy ? launched || proxy.seen() : launched && capture?.watching(app.port));
  return call("POST", `/local/${box}/app`, { port: doorPort(), cmd: shownCommand(app.cmd, mask), lifted: app.lifted ?? [], watching: hooked, metered: hooked, proves: hooked, reached: reachedNow() });
};

async function announceSteady() {
  for (let wait = 1000; ; wait *= 2) {
    const told = await announce().catch((err) => ({ ok: false, status: 0, data: { error: String(err?.message ?? err) } }));
    if (told.ok || (told.status !== 503 && told.status !== 0) || wait > 32_000) return told;
    await new Promise((r) => setTimeout(r, wait));
  }
}
const reachedNow = () => (capture?.connections() ?? []).map((c) => `${c.host}:${c.port}`).slice(0, 40);

async function appLife(firstStart) {
  for (let first = true; ; first = false) {
    const got = await (first ? firstStart : startApp());
    if (got.port) { app = got; if (!launched) await noteAttached(app.port); break; }
    failedWith(got.why, got.said);
    await call("POST", `/local/${box}/stopped`, { said: mask(got.said || got.why).slice(-2000) }).catch(() => {});
    say(got.why);

    if (first) say(NOT_RUNNING);
    await sourceChanged();
    become("starting");
    say("saw your change, starting your app again");
  }
  const told = await announceSteady();
  clearStep();
  if (!told.ok) return quit(told.data?.error ?? `could not register your app (${told.status})`);
  machineOf = () => (app ? {
    cmd: shownCommand(app.cmd, mask) ?? "", dir: relative(root, appDir) || ".", port: app.port, started: Boolean(launched),
    hooked: Boolean(launched && !proxy && capture?.watching(app.port)), proxy: proxy?.port ?? null,
    changed: [...(app.lifted ?? [])],
  } : null);
  become("up", { ...upAt(), app: launched ? child?.pid ?? null : null });
  say(`your app is answering on port ${app.port}${app.cmd ? `, started with: ${shownCommand(app.cmd, mask)}` : ""}`);
  if (launched) say(`your app's output is in ${bootLog}`);
  if (proxy) say(`send requests to port ${proxy.port}: it passes them to your app and Cortad sees each one. Requests sent straight to port ${app.port} are not seen`);
  for (const line of connectedText(machineOf())) say(line);
  say(CONNECTED);
  let downSince = 0;
  let toldDown = false;
  let appTold = true;
  let reachedTold = reachedNow().join(",");
  void reachLoop();
  forgetTold = () => { appTold = false; };
  void restartOnSave().catch((e) => say(`could not watch your files for a save: ${e?.message ?? e}`));
  const health = makeHealth({ host: () => appHost, gone: () => Boolean(launched && appGone), inFlight: () => answering });
  for (let up = true; !closing;) {
    await new Promise((r) => setTimeout(r, 2000));
    if (closing || restarting) continue;
    const state = await health.check(app.port);
    if (state === "up") {
      downSince = 0; toldDown = false;

      if (!up) become("up", { ...upAt(), app: launched ? child?.pid ?? null : null });
      else if (became?.state === "up") {
        const now = upAt();
        if (JSON.stringify(now.receipts) !== JSON.stringify(became.fields.receipts)) { const { receipts: _was, ...fields } = became.fields; become("up", { ...fields, ...now }); }
      }

      const seen = reachedNow().join(",");
      if (seen !== reachedTold) { reachedTold = seen; appTold = false; }
      if (!up || !appTold) { up = true; appTold = Boolean((await announce().catch(() => null))?.ok); }
      continue;
    }

    if (state === "busy") { if (!up) downSince = Date.now(); continue; }
    if (up) { up = false; downSince = Date.now(); }
    appTold = false;
    const downFor = Date.now() - downSince;

    const crashed = /app crashed - waiting|Failed running|waiting for (?:file )?changes before restart/i.test(lastSaid.slice(-600));
    const reloading = launched && !appGone && !crashed && Date.now() - lastOutputAt < 15_000;
    if (reloading || downFor < (crashed ? 4_000 : 10_000)) continue;

    if (!toldDown) {

      if (!launched && wantedPort) failedWith(`your app stopped answering on port ${app.port}; it is picked up again when it answers`, lastSaid);
      else become("starting");
      toldDown = Boolean((await call("POST", `/local/${box}/stopped`, { said: mask(lastSaid || "your app stopped answering").slice(-2000), ...(launched ? { exited: Boolean(appGone || crashed) } : {}) }).catch(() => null))?.ok);
    }

    if (launched && !appGone && !crashed && downFor < 25_000) continue;
    if (!launched && wantedPort) continue;
    await restartOnce(async () => {
      if (child?.pid) await stopTree(child.pid);
      say(downLine(state, { port: app.port, downMs: downFor, crashed }));
      let back = launched ? await launch(180_000) : await startApp();
      while (!back.port && !closing) {
        const why = back.why ?? whyNot(back);
        failedWith(why, back.tail || back.said);
        await call("POST", `/local/${box}/stopped`, { said: mask(back.tail || back.said || lastSaid).slice(-2000) }).catch(() => {});
        say(`your app did not come back: ${why}`);
        await sourceChanged();
        become("starting");
        say("saw your change, starting your app again");
        back = launched ? await launch(180_000) : await startApp();
      }
      if (!back.port) return { error: "This command is closing." };
      if (!launched) await noteAttached(back.port);
      app = { ...app, ...(back.cmd !== undefined ? back : {}), port: back.port };
      become("up", { ...upAt(), app: launched ? child?.pid ?? null : null });
      up = true; downSince = 0; toldDown = false;
      appTold = Boolean((await announce().catch(() => null))?.ok);
      say(`your app is answering again on port ${app.port}`);
      return { restarted: true, port: app.port };
    });
  }
}
void appLife(firstStart).catch((e) => quit(String(e?.message ?? e)));

async function countedFetch(url, init) {
  while (gate) await gate;
  answering += 1;
  try {
    const res = await fetch(url, init);
    const body = await res.arrayBuffer();
    return new Response(body.byteLength ? body : null, { status: res.status, statusText: res.statusText, headers: res.headers });
  } finally { answering -= 1; }
}

let clientOrigin = { port: undefined, value: null };
let browserSeen = null;
const autoReach = makeAutoReach({
  status: async () => {
    const token = readToken(project);
    const res = token ? await call("GET", "/mcp/status?quiet=1", undefined, { headers: { authorization: `Bearer ${token}` } }).catch(() => null) : null;
    if (res?.ok) signInYes = res.data?.account?.make === true;
    return res?.ok ? res.data : null;
  },
  runner: () => (became?.state === "up" && !restarting ? { state: "up", ...became.fields } : null),
  waiting: async () => (gate ? "Your app is being started again." : null),

  origin: () => { const port = app?.port ?? null; if (clientOrigin.port !== port) clientOrigin = { port, value: clientOriginOf(root, { port }) ?? (port ? `http://localhost:${port}` : null) }; return clientOrigin.value; },
  keys: (m) => keysFromEnv(root, m?.file),

  mint: async () => (signInYes ? mintAfterYes(homeOf(project), envOf(root)) : null),

  keptSignIn: async () => (signInYes ? keptSignIn(homeOf(project)) : null),
  onSignedIn: (as) => { if (signInYes) rememberSignIn(homeOf(project), as); },
  onKeptRefused: () => forgetSignIn(homeOf(project)),

  browser: async () => {
    if (!app?.port) return null;
    const appOrigin = `http://${appHost === "::1" ? "[::1]" : appHost ?? "127.0.0.1"}:${app.port}`;
    if (!browserSeen || Date.now() - browserSeen.at > 600_000) browserSeen = { at: Date.now(), got: await clientRequestOf({ clientOrigin: clientOrigin.value, appOrigin }).catch(() => null) };
    return browserSeen.got;
  },
  account: async (auth) => (app?.port ? signUpAndIn({ origin: `http://${appHost === "::1" ? "[::1]" : appHost ?? "127.0.0.1"}:${app.port}` }, auth, testAccount(homeOf(project)), countedFetch, { origin: clientOrigin.value }) : null),

  signIn: async (m) => { const theirs = m?.request && capture?.headers(CAPTURED, `${String(m.request.method).toUpperCase()} ${String(m.request.path).split("?")[0]}`); const name = theirs && Object.keys(theirs).find((k) => /^(?:authorization|cookie)$/i.test(k)); return name ? { name: name.toLowerCase(), value: theirs[name] } : null; },
  stampOf: (m) => { try { return m.file ? String(statSync(join(root, m.file)).mtimeMs) : ""; } catch { return ""; } },

  asked: () => existsSync(join(homeOf(project), ASK)),
  busy: () => answering > 0,
  report: async (answers) => {
    if (!answers.length && reachedBox === box) return true;
    const to = box;

    const ok = Boolean((await call("POST", `/local/${to}/reached`, { answers }, { timeoutMs: 15_000 }).catch(() => null))?.ok);
    if (ok) reachedBox = to;
    return ok;
  },
  say,
  fetchImpl: countedFetch,
});

async function sendPicked(args, go, spec) {
  const set = pickedSet(args);
  if (!go || !set.files.length) return previewText({ ...set, go, spec });
  const before = layer;
  layer = { ...layerSaid(set.chosen), set: new Set(set.all) };
  const sent = await upload(set.all);
  if (!sent.ok) { layer = before; return `Nothing was sent: ${sent.err ? `could not reach ${origin.host}` : sent.data?.error ?? `the upload failed (${sent.status})`}.\nnext: npx -y ${spec} send --yes ${args.join(" ")}`; }
  writePicked(project, set.picked);
  me.picked = set.all.length;
  if (me.fed) me.fed = me.fed.filter((rel) => !layer.set.has(rel));
  if (became) become(became.state, became.fields);
  if (app?.port) await announce().catch(() => {});
  clearStep();
  return sentText({ ...set, studied: !resumed, spec });
}
async function sendLoop() {
  for (; !closing; await new Promise((r) => setTimeout(r, 500))) {
    const ask = SEND.take(homeOf(project));
    if (!ask) continue;
    const spec = typeof ask.spec === "string" && /^[\w@./:-]{1,100}$/.test(ask.spec) ? ask.spec : "cortad";
    const args = Array.isArray(ask.files) ? ask.files.filter((f) => typeof f === "string").slice(0, 500) : [];
    let text;
    try { text = await sendPicked(args, ask.go === true, spec); } catch (e) { text = `Nothing was sent: ${e?.message ?? e}.`; }
    try { SEND.answer(homeOf(project), ask.id, text); } catch {  }
  }
}
void sendLoop();

let reachedBox = "";
async function reachLoop() {

  let roundAt = 0;
  for (; !closing; await new Promise((r) => setTimeout(r, 1000))) {
    const ask = takeAsk(homeOf(project));
    if (!ask) {
      if (Date.now() < roundAt || !app?.port || answering > 0 || gate) continue;
      const out = await autoReach(null).catch(() => null);
      roundAt = Date.now() + (out?.wait ?? 30_000);
      continue;
    }
    const out = await autoReach(ask).catch(() => null);
    try { answerAsk(homeOf(project), ask.id, out?.text ?? "Nothing was sent.\nnext: status"); } catch {  }
  }
}

if (process.platform === "darwin") spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore", detached: true }).unref();

const IDLE_MS = 10 * 60_000;
if (argv.includes("--until-idle") && stored) {
  let idleSince = Date.now();
  setInterval(async () => {
    const res = await call("GET", "/mcp/status?quiet=1", undefined, { headers: { authorization: `Bearer ${stored}` } }).catch(() => null);
    if (res?.ok && res.data?.run && !finished(res.data.run)) idleSince = Date.now();
    else if (Date.now() - idleSince > IDLE_MS) { say("no simulation for ten minutes, leaving"); await close(0); }
  }, 60_000).unref();
}

process.on("SIGUSR2", () => {
  if (restarting || !app) return;
  void restartApp();
});

async function deliver(id, out) {
  for (let wait = 1000, until = Date.now() + 300_000; Date.now() < until && !closing; wait = Math.min(wait * 2, 15_000)) {
    const res = await call("POST", `/local/${box}/jobs/${id}`, out).catch(() => null);
    if (res && res.status < 500) return;
    await new Promise((r) => setTimeout(r, wait / 2 + Math.random() * (wait / 2)));
  }
}

async function reattach() {
  for (let wait = 2000, until = Date.now() + 300_000; ; wait = Math.min(wait * 2, 30_000)) {
    const timeoutMs = Math.max(5_000, Math.min(120_000, until - Date.now()));
    const back = await call("POST", "/local/reattach", { box, name: folderName, project }, { timeoutMs }).catch(() => null);
    if (back && (back.ok || back.status === 404)) return back;
    if (Date.now() >= until || closing) return back;
    await new Promise((r) => setTimeout(r, wait / 2 + Math.random() * (wait / 2)));
  }
}

let quiet = 0;

let got = [];
const seenJobs = new Set();
for (;;) {
  let res;
  try { res = await call("GET", `/local/${box}/jobs${got.length ? `?ack=${got.join(",")}` : ""}`, undefined, { timeoutMs: 40_000 }); }
  catch { quiet += 1; if (quiet === 3) say("reconnecting..."); await new Promise((r) => setTimeout(r, Math.min(quiet, 10) * 1000)); continue; }
  if (closing) break;
  if (res.status === 404) {

    const back = await reattach();
    if (closing) break;
    if (!back?.ok) { say("this session ended on the server. Run the command again for a new one."); await close(1); }
    if (app?.port) await announce().catch(() => {});
    forgetTold?.();
    capture?.proveAgain();
    continue;
  }
  if (!res.ok) { quiet += 1; await new Promise((r) => setTimeout(r, 2000)); continue; }
  if (quiet >= 3) say("connected again");
  quiet = 0;
  got = (res.data?.jobs ?? []).map((job) => job.id);
  for (const job of res.data?.jobs ?? []) {
    if (seenJobs.has(job.id)) continue;
    seenJobs.add(job.id);
    if (seenJobs.size > 2000) seenJobs.delete(seenJobs.values().next().value);
    verb(job).catch((e) => ({ error: String(e.message) })).then((out) => deliver(job.id, out));
  }
}
