#!/usr/bin/env node
// Cortad on your own machine. Run from your repository's root with the code the connect screen
// showed:
//   npx cortad ABCD2345 -- <how you start your app>      your command, run here with Cortad's hook inside it
//   npx cortad ABCD2345 --port 3000                      an app already running: its replies are seen, its model calls are not
//
// What it does: signs in with the code, uploads the AI layer of your code once (never .env, never a
// file git ignores; `--explain` lists it), runs your start command as you typed it with nothing added
// but the hook, then holds one outbound connection open and does what a run asks: a request to your
// app, a read of a file it was sent, one of the few operations written here (OPS). A command the
// server writes is never run. It guesses nothing about your environment: your command decides the
// settings, the databases and the services, and nothing is copied or started beside it. Operations
// are locked by the operating system (lib/lock.mjs) and cannot write your code or reach the network;
// nothing here writes your files at all. With your yes it makes Cortad known to one coding agent for
// this project (lib/register.mjs): an MCP entry and a skill, so `npx cortad mcp` answers it from then
// on with the key this connect leaves in ~/.cortad. Nothing here touches git. Your environment never
// leaves this machine. Ctrl-C ends everything.

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
import { changesOf, commandText, RELOADER, sourceOf } from "./lib/fresh.mjs";
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
import { SIMULATION_HEADER } from "./lib/reach.mjs";
import { clientOriginOf, envOf, keysFromEnv } from "./lib/origins.mjs";
import { forgetSignIn, keptSignIn, mintAfterYes, rememberSignIn, signUpAndIn, testAccount } from "./lib/sign-in.mjs";
import { clientRequestOf } from "./lib/browser-rung.mjs";
import { layerOf, layerSaid } from "./lib/layer.mjs";
import { ignoredBy, rulesOf } from "./lib/gitignore.mjs";
import { explainText } from "./lib/explain-text.mjs";
import { sourcesIn } from "./lib/history/sources.mjs";
import { report as reportLive } from "./lib/setup-live.mjs";
import { previewText, SEND, sentText } from "./lib/picks.mjs";
import { grpcCall } from "./lib/grpc.mjs";
import { relativePaths } from "./lib/paths.mjs";

// A count with its noun agreeing: 1 prompt, 3 prompts.

const argv = process.argv.slice(2);
const USAGE = `usage: npx cortad <code from the connect screen> -- <how you start your app>   |   npx cortad <code> --port <port of your running app>   |   npx cortad <code> --agent-picks -- <how you start your app>   |   npx cortad --explain   |   npx cortad ${[...VERBS, "send", "wait"].join(" | ")}`;
// Asking for help, or a flag this version does not know, prints the usage and nothing else: read as
// a connect, `--help` signed the folder in with its saved key and ended the session running in it.
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
// The two faces a coding agent uses after the first connect (lib/cli.mjs): the MCP server the
// client starts on every session, and the same verbs as shell commands. Neither runs the connect
// below, and `npx cortad findings` is a verb, never a code.
if (COMMANDS.has(argv[0] ?? "")) process.exit(await face(argv));
// A command word this version does not know is never taken for a connect code: `feedback`, read as
// the code FEEDBACK, signed the folder in again and ended the session it was typed in.
if (unknownVerb(argv[0])) {
  console.error(`cortad  ${argv[0]} is not a command of cortad ${VERSION}. Its commands are ${VERBS.slice(0, -1).join(", ")} and ${VERBS.at(-1)}; npx cortad@latest <command> runs the newest. A connect code is typed in capitals, as the connect screen shows it.`);
  process.exit(1);
}
// Everything after `--` is the start command, as typed; `--start "cmd"` says the same for an older skill.
const dash = argv.indexOf("--");
const own = dash >= 0 ? argv.slice(0, dash) : argv;
const flag = (name) => { const i = own.indexOf(name); return i >= 0 ? own[i + 1] : undefined; };
const verbose = own.includes("--verbose");
// A code is eight characters from the connect screen's alphabet, which has no I, O, 0 or 1.
let code = (own.find((a) => /^[A-HJ-NP-Za-hj-np-z2-9-]{8,9}$/.test(a) && !a.startsWith("-")) ?? "").toUpperCase().replace(/-/g, "");
const say = (line) => console.log(`cortad  ${line}`);
const fail = (line) => { console.error(`cortad  ${line}`); process.exit(1); };

const explain = own.includes("--explain");
// The app is seen through a local proxy (lib/proxy.mjs) even where the hook could load into it.
const proxyAsked = own.includes("--proxy");
// Started by lib/cli.mjs for a run on a later day: no code, the key the first connect left behind.
const viaToken = own.includes("--token");
// What is happening right now, on one line that rewrites itself. npx spends its own seconds fetching
// this package before anything here runs, and the first thing we printed used to be after the whole
// upload: a minute or more of a cursor sitting still, which reads as nothing happening.
// Without a terminal (a coding agent's shell) each new step is its own line, so the agent reading
// the output sees the folder being looked at and the upload counting up, not a two-minute blank.
let lastStep = "";
const step = (line) => {
  if (process.stdout.isTTY) { process.stdout.write(`\rcortad  ${line}\x1b[K`); return; }
  if (line !== lastStep) { lastStep = line; say(line); }
};
const clearStep = () => { if (process.stdout.isTTY) process.stdout.write("\r\x1b[K"); };
const stepDone = (line) => { clearStep(); say(line); };
// `npx cortad` alone connects too: with the key this folder kept from its last connect, or, with none,
// by one approval in the browser (pairing below). A word that is neither a code nor a flag is refused.
const words = own.filter((a, i) => !a.startsWith("-") && !["--port", "--start"].includes(own[i - 1] ?? ""));
if (!explain && !viaToken && words.length && !/^[A-Z0-9]{8}$/.test(code)) fail(USAGE);
// Where Cortad is. The host is not on the command line: a code cannot point at an impostor.
const origin = new URL(process.env.CORTAD_ORIGIN || "https://cortad.com");
// Ours, and only ours. The service's earlier name was dropped with its domain, and a domain we no
// longer hold is a host somebody else can register and be trusted as us, so it is not on this list.
// The second is our own Pages project: its subdomains are our branch deploys, staging among them.
const OURS = ["cortad.com"];
const trusted = (origin.protocol === "https:" && OURS.some((host) => origin.hostname === host || origin.hostname.endsWith(`.${host}`)))
  || origin.hostname === "localhost" || origin.hostname === "127.0.0.1";
if (!trusted) fail(`refusing: ${origin.host} is not Cortad.`);
const api = `${origin.origin}/api`;

const root = process.cwd();
const MANIFEST = ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "docker-compose.yml", "docker-compose.yaml", "Gemfile", "mix.exs", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json", "Dockerfile"];
// A .NET project is named for itself: Support.csproj, Shop.sln.
const dotnetHere = () => { try { return readdirSync(root).some((f) => /\.(?:csproj|fsproj|sln)$/.test(f)); } catch { return false; } };
// A repository whose root carries no manifest of its own is still a repository: crewai-examples
// keeps one project per folder under crews/, and the whole of it was refused at the door. The root
// is accepted when a project lives below it, and whenever the person says how the app starts or
// where it answers: a single file with no manifest is an app too, and nothing here needs the manifest.
const startSaid = argv.includes("--") || argv.includes("--start") || argv.includes("--port") || argv.includes("--token");
if (!startSaid && !MANIFEST.some((f) => existsSync(join(root, f))) && !dotnetHere() && !workspaces(root).length) {
  fail(`no project here: this folder has no project file (package.json, pyproject.toml, go.mod, pom.xml, Gemfile, composer.json, Cargo.toml, a .csproj), and neither does any folder in it. Run it from your repository's root, or say how your app starts: npx cortad <code> -- <your start command>`);
}
// Which project this is, as a hash of where it lives: the same folder coming back resumes the same
// connection, and the path itself never leaves this machine.
const project = projectOf(root);
// How this app starts, kept on this machine for the sessions a run starts by itself (--token) and
// for the next connect: the command typed after `--`, or the port of an app already running.
const startFile = join(homeOf(project), "start.json");
const keptStart = (() => { try { return JSON.parse(readFileSync(startFile, "utf8")); } catch { return {}; } })();
// Typed after --, or with --start, or saved from the last connect of this folder: a person who
// reconnects types the code alone, and the runner a run starts is given nothing at all.
const typedNow = dash >= 0 ? own.length === argv.length ? "" : argv.slice(dash + 1).join(" ").trim() : flag("--start") ?? "";
const typed = typedNow || (flag("--port") ? "" : keptStart.cmd ?? "");
const fromSaved = !typedNow && Boolean(typed);
// The person's agent picks the files Cortad gets (lib/picks.mjs), and the connect sends none of its
// own. Kept for this folder: a reconnect by its kept key, which agents are told to run, must never
// fall back to sending the connect's own choice. A code from the connect screen says afresh.
const picks = own.includes("--agent-picks") || (!code && keptStart.picks === true);
// No store of the app's is opened for samples (lib/sample.mjs). Kept like picks, and implied by it:
// an agent that chooses every file sent also chooses that no store is opened.
const noSamples = picks || own.includes("--no-samples") || (!code && keptStart.noSamples === true);
// A port saved beside the command (a container's) is watched again on a reconnect with the code alone.
const wantedPort = Number(flag("--port")) || (!typedNow ? Number(keptStart.port) || 0 : 0);
const onPath = (bin) => (process.env.PATH ?? "").split(":").some((dir) => dir && existsSync(join(dir, bin)));
// Nothing was said about how the app starts: the one suggestion the repository makes obvious is
// printed, never run. A guess shown to a person is fine; a guess acted on at runtime is what put an
// app on a placeholder key and its library in an empty copy.
if (!explain && !viaToken && !typed && !wantedPort) {
  const plan = startPlan({ root, onPath });
  const shown = code || "<code>";
  console.error(`cortad  how does your app start? Run this again with your command after --:`);
  console.error(`cortad    npx cortad ${shown} -- ${plan?.cmd ?? "<your start command>"}${plan?.cmd ? `   (from this folder that looks like it${plan.within ? `, in ${plan.within}` : ""}; change it if not)` : ""}`);
  console.error(`cortad  or, if your app is already running:   npx cortad ${shown} --port ${plan?.cmd ? "<its port>" : "3000"}`);
  process.exit(2);
}
if (viaToken && !typed && !wantedPort) fail("this project has no saved start command. Run npx cortad <code> -- <how you start your app> in this folder once.");

// One process holds a project's app up (lib/runner.mjs), and its state is what every reader reports.
// `reach: "ask"`: an agent's reach is sent by this process (lib/auto-reach.mjs), signed in where it can.
// `picked`: how many files the agent has sent, which status reads to say what Cortad still needs.
const me = { pid: process.pid, startedAt: startedAtOf(), by: viaToken ? "token" : "connect", reach: "ask", version: VERSION, ...(picks ? { picks: true, picked: readPicked(project).length } : {}) };
// The last record written, so a fact learned while the app is up is added to it.
let became = null;
// What this command did on this machine, once the app answers: said at connect, and kept in the
// record for `status` with show machine (lib/read-text.mjs machineText).
let machineOf = () => null;
const become = (state, fields = {}) => { became = { state, fields }; const machine = machineOf(); writeRunner(project, { ...me, ...(machine ? { machine } : {}), state, at: new Date().toISOString(), ...fields }); };
process.on("exit", () => releaseRunner(project));
// Started for a run while another process already holds this project's app up: that one serves it.
// A second connect is refused, before it signs in: signing in again ended the running one's session
// on the server, which stopped the person's app.
const heldLine = (held) => `another cortad is already connected in this folder: pid ${held.pid}, started ${new Date(held.startedAt).toTimeString().slice(0, 5)}${held.state === "up" && held.port ? `, with your app answering on port ${held.port}` : ""}. Nothing was changed. To connect again, stop it first (Ctrl-C where it runs, or kill ${held.pid}), then run this command again.`;
function holdProject() {
  const held = claimRunner(project, { ...me, state: "starting", at: new Date().toISOString() });
  if (!held) return;
  if (viaToken) { say(`pid ${held.pid} already holds this project's app up and serves the simulation`); process.exit(0); }
  fail(heldLine(held));
}
// A verb waits on this record from the moment it starts this process, so it is taken first.
if (viaToken) holdProject();
else if (!explain) { const held = readRunner(project); if (held) fail(heldLine(held)); }

// ---- what leaves the machine
const SKIP_DIR = /^(node_modules|\.git|dist|build|out|coverage|vendor|venv|\.venv|env|target|tmp|\.next|\.nuxt|\.turbo|\.cache|__pycache__|\.terraform|\.wrangler|\.svelte-kit|\.output|\.parcel-cache|\.idea|\.vscode|secrets?|\.secrets?|\.ssh|\.gnupg|\.aws)$/i;
// Env files by any name (scripts/books.env is one), keys, credentials, media and compiled output.
// The key folders and files SECRET_PATH refuses are here too, so the walk never offers one.
const SKIP_FILE = /^\.env(\..*)?$|^\.envrc$|\.env$|^\.(?:npmrc|netrc)$|^id_(?:rsa|ed25519|ecdsa)|\.(pem|key|p12|pfx|jks|keystore|sqlite|sqlite3|db|log|lock|map|zip|tar|gz|tgz|7z|rar|png|jpe?g|gif|webp|ico|svg|mp3|mp4|wav|mov|pdf|woff2?|ttf|otf|eot|bin|exe|dll|so|dylib|wasm|onnx|pt|pth|safetensors|numbers|DS_Store)$/i;
// Data, not code: never sent, whatever git tracks and whatever the AI layer would choose it for.
const DATA = /\.(?:csv|tsv|jsonl|ndjson|parquet|xlsx?|arrow|feather|avro)$/i;
const DATA_JSON = 64_000;
const MAX_FILE = 25_000_000;
const MAX_TOTAL = 256_000_000;
// Any file dotenv and its kind read: .env and its suffixes, .envrc, and the api.env shape a folder
// of per-service files uses. Read here only, to hide its values in what leaves; never sent.
const ENV_FILE = /^\.env(\..+)?$|^[\w-]+\.env$|^\.envrc$/;

// `rules`: the .gitignore rules above this folder, read here only when git is not (lib/gitignore.mjs).
function walk(dir, depth, out, envs, total, rules = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return total; }
  if (listed === null) { try { rules = [...rules, ...rulesOf(readFileSync(join(dir, ".gitignore"), "utf8"), relative(root, dir).split(sep).join("/"))]; } catch { /* none here */ } }
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

// Nothing inside a skipped folder is ever sent, but a folder called secrets, env or vendor is
// exactly where a provisioned machine keeps its env file, and one we never read is one whose values
// we cannot hide. Its own level only: this is a look for their settings, not a second walk.
function envsIn(dir, envs) {
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isFile() && ENV_FILE.test(e.name)) envs.push(join(dir, e.name));
  } catch { /* a folder we may not read holds nothing for us */ }
}

// What git lists here: tracked files and new ones it would pick up, never an ignored one. A folder
// that is not a git repository has no such list and is read by the rules above and its own
// .gitignore files.
function gitListed() {
  if (!existsSync(join(root, ".git")) && !onPath("git")) return null;
  let inside = false;
  try { inside = execFileSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() === "true"; } catch { /* not a repository */ }
  if (!inside) return null;
  // A repository whose list cannot be read is not read by guesswork: it stops here.
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z", "-t", "--cached", "--others", "--exclude-standard"], { maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return new Set(out.toString().split("\0").filter(Boolean).map((e) => e.slice(2)));
  } catch (e) { fail(`could not list this repository's files with git: ${e.message}`); }
}
// One rule for every file that could leave: the upload, and a read the engine asks for later.
function shareable(rel, askGit = true) {
  const parts = rel.split(sep);
  if (parts.slice(0, -1).some((d) => SKIP_DIR.test(d)) || SKIP_FILE.test(parts.at(-1))) return false;
  if (listed === null || listed.has(rel)) return true;
  // Off the list git gave a moment ago: ignored, or inside a nested checkout. The walk takes git's
  // word for it; asking per file was one process each, two minutes on a repository with a worktree
  // inside it. A read asked later, of a file made after the list was taken (an agent edit), asks.
  if (!askGit) return false;
  try { execFileSync("git", ["-C", root, "check-ignore", "-q", rel], { stdio: "ignore" }); return false; } catch (e) { return e.status === 1; }
}
let listed = null;
// Read the same way for the upload and for any read the engine asks for later.
let envKeys = [];
function carriesKey(rel) {
  try { return holdsKeys(readFileSync(join(root, rel), "utf8"), envKeys); } catch { return false; }
}

let secrets = [];
// The person's yes, on the setup card or to their agent (`test` with `account: "make"`), to Cortad
// signing its own test requests in: an account made on the app's sign-up door, a token signed with the
// JWT secret the app's env holds, and the sign-ins kept in ~/.cortad for the next connect. Until the
// server says it was given, none of the three happens, and the token also waits for the yes the
// agent recorded on this machine (lib/sign-in.mjs mintAfterYes).
let signInYes = false;
// The AI layer this folder sends in place of its tree (lib/layer.mjs), once chosen: what it held and
// the set of files, which is also every file a read may ask this machine for afterwards.
let layer = null;
// A run's request to an endpoint your app answers later carries the first (src/customer/endpoint.ts),
// with how long the run waits for this reply; a reply with no answer says in the second why none came.
// The wait here ends a few seconds before the run's own and the wire's hold, so the reason reaches it.
const LATER_HEADER = "x-cortad-answer", LATER_MISSED = "x-cortad-later", LATER_MARGIN_MS = 5_000;
// The app's own reply to a message it answers later, when it is a small JSON object: a receipt.
const RECEIPT_MAX = 16_384;
const receiptOf = (got) => {
  if (got.truncated || !got.body || got.body.length > RECEIPT_MAX) return null;
  try { const v = JSON.parse(got.body); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
};
// The cookies each trial's own turns were handed, newest trials kept.
const trialJars = new Map();
// Endpoints that refused a new visitor: their trials carry the person's own session.
const ownSession = new Set();
const TRIAL_JARS = 500;
let capture = null;
// The local proxy an app is seen through when the hook cannot load into it (lib/proxy.mjs).
let proxy = null;
// The port the run and the agent send to: the proxy's front when there is one, else the app's own.
const doorPort = () => proxy?.port ?? app?.port;
// The request the app answered in words while no model call came through the proxy, as "POST /chat".
let unseen = "";
// The runner's record of where to send: the front, with the app's own port beside it, and the
// endpoints that took a message and answered at once with no model call tied to it (lib/replay.mjs).
// The front listens on 127.0.0.1; the app on whichever loopback address it answered on.
const upAt = (port = app?.port) => {
  const receipts = capture?.receipts() ?? [];
  return { ...(proxy ? { port: proxy.port, host: "127.0.0.1", proxied: port, ...(unseen && !proxy.seen() ? { unseen } : {}) } : { port, host: appHost }), ...(receipts.length ? { receipts } : {}) };
};
// The app's life, shared by the code that starts it, watches it and restarts it.
let closing = false;
let restarting = false;
let appGone = false;
let lastSaid = "";
let lastOutputAt = Date.now();
let forgetTold = null;
// The run's requests your app has not answered yet: a slow health probe while any are open is our
// load on it, not a hang.
let answering = 0;
const held = makeHeld({ rows: () => capture?.usage()?.rows ?? [], say: (line) => say(line) });
// Closed while the app is started again: the run's requests wait at it and are sent once it answers.
let gate = null;
const hold = () => { if (!gate) { let open; gate = new Promise((r) => { open = r; }); gate.open = () => { gate = null; open(); }; } };
const release = () => gate?.open();
const mask = (text) => maskWith(String(text ?? ""), secrets);
// The route table is replayed, so a configuration word that is also a route word stays readable;
// anything credential-shaped is masked here the same as everywhere.
const maskRoutes = (text) => maskWith(String(text ?? ""), secrets.filter(credentialShaped));

// ---- the wire
let box = "";
let key = "";
// The folder's name is all this machine says of itself, for the account's list of connected apps:
// never its hostname, never a path.
const folderName = basename(root).replace(/[^\w.-]/g, "-").slice(0, 80);
// The browser approves this computer: a link to open where the person is signed in, and four
// characters the page shows too. The terminal waits, and is handed a code once it is approved.
async function paired() {
  const opened = await call("POST", "/local/pair", { name: folderName }).catch(unreachable);
  if (!opened.ok) fail(opened.data?.error ?? `could not start connecting (${opened.status})`);
  const link = `${origin.origin}/approve/${opened.data.id}`;
  say(`approve this computer in your browser, where you are signed in to Cortad: ${link}`);
  say(`the page shows ${opened.data.words}; approve only if it matches`);
  if (process.stdout.isTTY) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    try { spawn(opener, [link], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch { /* the link is printed */ }
  }
  for (const until = Date.now() + 10 * 60_000; Date.now() < until; await new Promise((r) => setTimeout(r, 2_000))) {
    const got = await call("POST", `/local/pair/${opened.data.id}/collect`, { secret: opened.data.secret }).catch(() => null);
    if (got?.ok && typeof got.data?.code === "string") { say("approved"); return got.data.code; }
    if (got && got.status === 410) break;
  }
  fail("the link was not approved within ten minutes. Run npx cortad again for a new one.");
}

// Every body this machine sends goes through here, so every path in it, a traceback's or an
// error's, leaves relative to the project (lib/paths.mjs).
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

// ---- the box on this machine: your folder, read where it stands
// Made once --explain has left: it creates nothing.
const work = join(tmpdir(), `cortad-${process.pid}`);
// What the app printed this session, beside the project's other records rather than in a temp folder
// the agent is never told of. Emptied once this process holds the project (holdProject), so a second
// command in the same folder never empties a live session's output. Masked once more at the end of
// the session, up to a size read whole, with the values learned while it ran.
const bootLog = join(homeOf(project), "app.log");
const MASKED_AT_END_MAX = 64 * 1024 * 1024;
// The same output in memory with when each piece came, so the lines printed during one request are
// its own (lib/proof.mjs). Masked before either keeps it, and never cut inside a value.
const printed = [];
const PRINTED = 2000;
// The most of your app's output a run may read back at once.
const LOG_MAX = 2000;
const logTo = () => maskedLines(() => secrets, (text) => {
  try { appendFileSync(bootLog, text, { mode: 0o600 }); } catch { /* still kept in memory */ }
  printed.push({ at: Date.now(), text });
  if (printed.length > PRINTED) printed.splice(0, printed.length - PRINTED);
});
const printedBetween = (from, to) => printed.filter((p) => p.at >= from && p.at <= to).map((p) => p.text).join("");
// Files nobody may read through this program: keys, and git's own internals.
const SECRET_PATH = /(?:^|\/)(?:\.git|\.ssh|\.gnupg|\.aws|\.npmrc|\.netrc|id_(?:rsa|ed25519|ecdsa)[^/]*|[^/]*\.(?:pem|key|p12|pfx|jks|keystore))(?:\/|$)/;
// The engine's paths, as this machine has them. Its scratch files live in this program's own
// temp folder, never beside your code.
const translate = (s) => String(s ?? "").split("/workspace/repo").join(root).split("/tmp/bl-boot.log").join(bootLog).split("/tmp/boot.log").join(bootLog);
const scratch = (p) => { const r = resolve(translate(p)); return r.startsWith("/tmp/") ? join(work, r.slice(5)) : r.startsWith(work + sep) ? r : null; };
const readable = (p) => {
  const r = resolve(translate(p));
  if (r === bootLog || r.startsWith(work + sep)) return r;
  let landed; try { landed = realpathSync(r); } catch { return null; }
  const home = realpathSync(root);
  if (!landed.startsWith(home + sep) || ENV_FILE.test(basename(landed)) || SECRET_PATH.test(landed)) return null;
  const rel = relative(home, landed);
  if (!layer?.set.has(rel)) return null;
  return shareable(rel) && !isData(rel, statSync(landed).size) && !carriesKey(rel) ? landed : null;
};
// An operation runs with a plain environment: the app's own process reads its .env itself, and no
// operation inherits this terminal's keys.
const plainEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG ?? "C.UTF-8", TMPDIR: work, TERM: "dumb" };
let lock = null;

// What Cortad's server may ask this machine to run: these operations, written here, and nothing else.
// A command the server writes is never run, from whatever source; it is refused and noted on this
// machine. Each runs locked (lib/lock.mjs): no network, no env file, the plain environment above.
const OPS = {
  // Your app, started again with your own start command.
  start: async () => { const r = await restartApp(); return { success: !r.error, exitCode: r.error ? 1 : 0, stdout: "", stderr: r.error ?? "" }; },
  // Your project's own test command, as its package.json declares it.
  test: () => (testDeclared() ? runLocked("npm test") : { success: false, exitCode: 127, stdout: "", stderr: "this project declares no test command in its package.json" }),
};
const testDeclared = () => { try { const t = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts?.test; return typeof t === "string" && !/no test specified/.test(t); } catch { return false; } };
function runOp(b) {
  const run = Object.hasOwn(OPS, b.op) ? OPS[b.op] : null;
  if (!run) return refused(b);
  if (verbose) say(`running ${b.op}`);
  return run();
}
function refused(b) {
  const asked = mask(String(b.op ?? b.cmd ?? "")).replace(/\s+/g, " ").slice(0, 300);
  say(`refused a command Cortad's server sent, since this machine runs only Cortad's own operations (${Object.keys(OPS).join(", ")}): ${asked}`);
  try { mkdirSync(homeOf(project), { recursive: true, mode: 0o700 }); appendFileSync(join(homeOf(project), "refused.log"), `${new Date().toISOString()} ${asked}\n`, { mode: 0o600 }); } catch { /* said in this terminal */ }
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
    // Kept a little past what is sent, so a value cut at the edge is still whole when it is masked.
    const tail = (s, chunk) => (s + chunk).slice(-(OUTPUT_SENT + 4096));
    child.stdout.on("data", (d) => { out = tail(out, d.toString()); });
    child.stderr.on("data", (d) => { err = tail(err, d.toString()); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 280_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      // The last OUTPUT_SENT characters of the two together, the error stream's first.
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
      // Only the app's own port: this machine's other services are not the world.
      const port = Number(b.port) || doorPort();
      if (!app || (port !== app.port && port !== doorPort())) return { error: `refused: port ${port} is not your app` };
      const path = typeof b.path === "string" && b.path.startsWith("/") ? b.path : "/";
      const headers = {};
      for (const [k, v] of Object.entries(b.headers ?? {})) if (!/^(host|content-length|connection)$/i.test(k)) headers[k] = String(v);
      // Held from here, before anything is awaited, so a cancel from the run never arrives first.
      const turn = String(Object.entries(headers).find(([k]) => k.toLowerCase() === "x-cortad-turn")?.[1] ?? "");
      // Every request of ours is tagged, a knock or a revisit as much as a trial, so the hook never
      // takes one for the person's: it would become the request trials copy and the sign-in they carry.
      if (!turn) headers["x-cortad-turn"] = `cortad-${String(job.id).replace(/[^\w.-]/g, "").slice(0, 64)}`;
      if (verbose) say(`$ ${String(b.method ?? "GET").toUpperCase()} ${path.split("?")[0]} as ${headers[AS_HEADER] ?? headers[AS_HEADER.toLowerCase()] ?? "nobody"}, turn ${headers["x-cortad-turn"]}`);
      const letGo = held.hold(job.id, turn || headers["x-cortad-turn"]);
      // An endpoint your app answers later: it takes the message and its model answers afterwards,
      // outside the request (a queue's worker). Its own reply only says it took the message.
      const laterAt = Object.keys(headers).find((k) => k.toLowerCase() === LATER_HEADER);
      const laterMs = laterAt === undefined ? NaN : Number(headers[laterAt]);
      const later = laterAt !== undefined && (headers[laterAt] === "later" || laterMs > 0);
      if (laterAt !== undefined) delete headers[laterAt];
      if (later) capture?.forget(turn || headers["x-cortad-turn"]);
      // A request that speaks as one of your app's own callers carries the role, not the sign-in: the
      // sign-in was seen on this machine, on the request the person or their agent sent, and is put in
      // here, so it never travels. There is no other caller: Cortad makes no accounts.
      const marker = Object.keys(headers).find((k) => k.toLowerCase() === AS_HEADER);
      let spokenAs = null;
      if (marker) {
        const role = headers[marker];
        delete headers[marker];
        if (role === CAPTURED || role.startsWith(`${CAPTURED}:`)) {
          spokenAs = role;
          const theirs = capture?.headers(role);
          for (const [name, value] of Object.entries(theirs ?? {})) { for (const k of Object.keys(headers)) if (k.toLowerCase() === name) delete headers[k]; headers[name] = value; }
        }
      }
      headers[SIMULATION_HEADER] = "1";
      const method = String(b.method ?? "GET").toUpperCase();
      // A gRPC door: dialled with the app's own @grpc/grpc-js and its .proto files (lib/grpc.mjs); the
      // reply comes back as JSON text the way an HTTP door's body does.
      if (method === "GRPC") {
        try {
          const out = await grpcCall({ path, body: b.body, headers, port: app.port, appDir, root });
          return { status: out.status, headers: { "content-type": out.type }, body: mask(out.text), truncated: false };
        } finally { held.done(job.id); }
      }
      const init = { method, headers, redirect: "manual" };
      // Speaking as one of several customers, the ids in the body are that customer's own.
      const body = spokenAs ? capture?.bodyAs(spokenAs, `${method} ${path.split("?")[0]}`, b.body) ?? b.body : b.body;
      if (body !== undefined && method !== "GET" && method !== "HEAD") init.body = typeof body === "string" ? body : JSON.stringify(body);
      // A dev server restarts when a file is saved, and during a run files are saved: by the agent
      // working its plan, and by you. For those seconds nothing is listening. A turn that meets a
      // closed door is held until your app answers again and sent then, once, instead of being
      // counted against your app as a failure it never had.
      // A door behind a guest session answers the first request with a redirect that mints the
      // session and sends the browser back. A browser reaches it by loading a page first; the same
      // request pushed down that chain arrives at a page route as a POST and reads as "wrong
      // method", which is what your chat looked like from the outside. So the chain is walked the
      // way a browser walks it, one GET with redirects followed, and the request is sent again with
      // the session your app just handed out. The cookie is kept here and never leaves this machine.
      // Through the proxy's front when there is one, which is where the request is seen.
      const url = proxy ? `http://127.0.0.1:${proxy.port}${path}` : hostUrl(port, path);
      // An address the app wrote from its own port, as an app that keeps its address in its settings
      // does, is followed through the front as well.
      const yours = (to) => { try { const u = new URL(to, url); return ["127.0.0.1", "::1", "[::1]", "localhost"].includes(u.hostname) && [new URL(url).port, String(app.port)].includes(u.port) ? new URL(u.pathname + u.search, url).href : null; } catch { return null; } };
      // Each trial keeps the cookies your app set on its own earlier turns, so a conversation your app
      // holds in a cookie carries from one turn to the next and never into another trial.
      const trial = turn.replace(/:\d+$/, "");
      let jar = trial ? trialJars.get(trial) ?? "" : "";
      // Held as long as the run waits for this reply: a course generator that takes ninety seconds
      // a reply is waited on for three of them. A run that says nothing gets the old 170 seconds.
      const holdMs = Math.min(Math.max(Number(b.waitMs) || 170_000, 1_000), 630_000);
      const began = Date.now();
      // The trial's own cookies take the place of the captured ones of the same name: a session your
      // app keys its conversation on is this trial's, never the one every trial was handed at capture.
      const cookieAt = Object.keys(headers).find((k) => k.toLowerCase() === "cookie");
      const { [cookieAt ?? ""]: given = "", ...cookieless } = headers;
      const cookie = () => [...new Map([...given.split(/;\s*/), ...jar.split(/;\s*/)].filter(Boolean).map((pair) => [pair.split("=")[0].trim(), pair])).values()].join("; ");
      // A cookie your app hands any new visitor is that visitor's session: each trial asks for its own,
      // so one trial's answer in progress never holds another's (AI Answers answers one at a time per
      // visitor, and every trial carried the agent's one session). An endpoint that refuses a new
      // visitor keeps the person's session for this trial and every later one.
      const door = `${method} ${path.split("?")[0]}`;
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
        // An OpenAPI document can run to megabytes; the caller asks for it whole.
        const LIMIT = Number.isInteger(b.limit) && b.limit > 0 ? Math.min(b.limit, 8 * 1024 * 1024) : 262_144;
        // A session cookie your app sets is its business: it is dropped here, and every other header masked.
        const said = Object.fromEntries([...res.headers].filter(([k]) => !/^set-cookie2?$/i.test(k)).map(([k, v]) => [k, mask(v)]));
        return { status: res.status, headers: said, body: mask(buf.subarray(0, LIMIT).toString("utf8")), truncated: buf.length > LIMIT };
      };
      const counted = async () => { await gate; letGo.throwIfAborted(); answering += 1; try { return await ask(); } finally { answering -= 1; } };
      // The turn's answer on an endpoint your app answers later: the model's last words, once the hook
      // has seen its calls go quiet, within the time the run waits for this reply. None came: the
      // reply says the status of the model call that gave no words, or the seconds waited.
      const answered = async (got) => {
        if (!later || got.status < 200 || got.status >= 300) return got;
        const until = began + Math.min(holdMs, laterMs > 0 ? laterMs : Infinity) - LATER_MARGIN_MS;
        const said = capture ? await capture.answered(turn || headers["x-cortad-turn"], until, letGo) : null;
        if (letGo.aborted) return { error: "cancelled by the simulation" };
        if (!said?.reply.trim()) return { ...got, headers: { ...got.headers, [LATER_MISSED]: JSON.stringify(said ? { model: said.status } : { waited: Math.round((Date.now() - began) / 1000) }) } };
        // The app's own reply rides beside the answer: the thread it opened is named there and nowhere
        // else, and a run's next message on that conversation sends it back.
        const own = receiptOf(got);
        return { ...got, headers: { "content-type": "application/json" }, body: mask(JSON.stringify({ reply: said.reply, ...(own ? { receipt: own } : {}) })), truncated: false };
      };
      try { return await answered(await counted()); }
      catch (e) {
        if (letGo.aborted) return { error: "cancelled by the simulation" };
        const code = String(e.cause?.code ?? e.code ?? "");
        if (!/ECONNREFUSED|ECONNRESET|EPIPE|UND_ERR_SOCKET/.test(code)) return { error: `nothing answered at port ${port}: ${code || e.message}` };
        // Held through a restart of ours however long it takes: a request it cut is sent again after it.
        for (let i = 0; (i < 45 || restarting) && !letGo.aborted && !(await answers(app.port)); i++) await new Promise((r) => setTimeout(r, 1000));
        try { return { ...(await answered(await counted())), heldForRestart: true }; }
        catch (again) { return { error: letGo.aborted ? "cancelled by the simulation" : `nothing answered at port ${port}: ${String(again.cause?.code ?? again.message)}` }; }
      } finally { held.done(job.id); }
    }
    // The run gave up on a request it asked for: its wait ran out, or the run ended.
    case "cancel": return { cancelled: held.letGo([String(b.id ?? "")]) };
    case "read": {
      const p = readable(b.path);
      if (!p) return { error: "bad path" };
      try { return { content: mask(readFileSync(p, "utf8")) }; } catch (e) { return { error: String(e.code ?? e.message) }; }
    }
    case "write": {
      const bytes = Buffer.from(String(b.b64 ?? ""), "base64");
      // The engine's own scratch file: this program's temp folder, never your code. Nothing on this
      // machine writes your files; the agent that edits them is your own.
      const mine = scratch(b.path);
      if (!mine) return { success: false, stderr: "this program does not write your files" };
      try {
        mkdirSync(dirname(mine), { recursive: true });
        if (b.append) appendFileSync(mine, bytes); else writeFileSync(mine, bytes);
        // The read's tools, kept for this project too: the next start hands them to the hook before
        // the app loads its code, which a Node app needs to have its tool functions wrapped.
        if (mine === join(work, "tools.json")) {
          try { mkdirSync(homeOf(project), { recursive: true, mode: 0o700 }); writeFileSync(join(homeOf(project), "tools.json"), bytes, { mode: 0o600 }); } catch { /* kept for this session only */ }
          void recordTools();
        }
        return { success: true, stderr: "" };
      }
      catch (e) { return { success: false, stderr: String(e.message) }; }
    }
    // Cortad makes no accounts in your sign-in system: the request your agent sent carries the one it uses.
    case "mint": return { identities: [] };
    // The last of what your app printed, for a reply it failed: the traceback a developer reads.
    // Masked like everything else, at most LOG_MAX bytes, its paths relative to the project like every body sent (call).
    case "log": {
      const want = Math.min(Math.max(Number(b.bytes) || LOG_MAX, 1), LOG_MAX);
      try {
        const all = readFileSync(bootLog);
        // Masked before it is cut, so a value is never cut in two where the mask could no longer see it.
        const wide = mask(all.subarray(Math.max(0, all.length - want - 4096)).toString("utf8").replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
        const text = wide.slice(-want);
        // The files already sent, which the server matches a traceback's relative paths against. A JVM
        // stack names a class, not a path: only the JVM sources are the files it could be.
        const jvm = /\bat\s+[\w$.]+\([\w$]+\.(?:java|kt|scala|groovy):\d+\)/.test(text);
        const sent = [...(layer?.set ?? [])].filter((f) => !jvm || /\.(?:java|kt|scala|groovy)$/.test(f));
        return { text, size: all.length, files: sent.slice(0, 20_000) };
      } catch { return { text: "", size: 0 }; }
    }
    // The person changed what they said yes to while this command runs.
    // Said in the terminal: an agent that read "one question for the person" here told them the run
    // was still waiting two minutes after they had answered.
    case "consent": say("the person's answer on the card in the browser arrived"); return { ok: true };
    // A line for the agent reading this terminal: the read of the code landing, said the moment it does.
    // One marked news (a run ending) is also kept for the hook, so an agent that was not listening
    // hears it on its next prompt or edit.
    case "say": {
      // Printed in a terminal and handed to a coding agent: no control characters, no direction overrides.
      const line = String(b.line ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
      if (line) say(line);
      if (line && b.news) { try { addNews(project, line); } catch { /* said in this terminal only */ } }
      return { ok: true };
    }
    case "restart": return restartApp();
    // Your own pages, read here rather than in a world's shell, at the addresses your app's own env
    // files hold. Never the terminal's: the server names the variables, and PWD or INIT_CWD there
    // would hand it the whole project. A file is opened only if the upload could send it. Values
    // stay here; only rows of short fields go back.
    case "sample": return { report: noSamples ? { stores: [], off: true } : JSON.parse(mask(JSON.stringify(await sampleHere(b, appEnv(), root, mayOpen)))) };
    case "lock": return { locked: Array.isArray(b.hosts) ? b.hosts.length : 0 };
    // What your app spent on its providers, from the hook inside it. An app this command did not
    // start has no hook, and the empty answer says the meter is absent rather than that nothing was spent.
    // Masked like every other reply: a tool's answer can carry a value from their env files. The
    // calls of the `turn` asked about also say what their model was told.
    // `tools`: which of the tools the run listed the hook in the app wrapped, and which it could not.
    // A call to a tool not wrapped is seen only where a model asks for it by name, so a run says its
    // calls were not recorded, never that it did not run. An app without the hook has none wrapped.
    case "usage": return capture ? JSON.parse(mask(JSON.stringify({ ...capture.usage(b.turn, b.totals === true), tools: capture.tools() ?? { wrapped: [], unwatched: [] } }))) : {};
    // Every route your app holds, read by the hook off the app itself, masked like the meter.
    case "routes": return capture ? JSON.parse(maskRoutes(JSON.stringify(capture.registry(app?.port)))) : {};
    // A world is ended from this terminal, never from the cloud.
    case "destroy": return { ok: true };
    default: return { ok: true };
  }
}

const exec = promisify(execFile);

// ---- start or attach to the app
// The address the app answers on: 127.0.0.1, or [::1] when it bound IPv6 localhost alone, which a
// Vite dev server does and which a probe of 127.0.0.1 waited three minutes on.
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
    } catch { /* the other family next */ }
  }
  return false;
};
// Where the app's model settings point, for the proxy that stands in for a hook the app cannot load:
// this terminal's values, else the ones the repository's env files hold. Read here and handed to no
// process: the proxy forwards each call to the address the app's own settings name, and the app is
// handed only the proxy's address in their place (lib/proxy.mjs env).
const appEnv = () => Object.assign({}, ...envFiles.filter((f) => !/\.(example|sample)$/.test(f)).map((f) => { try { return parseEnv(readFileSync(f, "utf8"), process.env); } catch { return {}; } }));
const modelHints = () => ({ ...appEnv(), ...process.env });
// Where their app runs inside this repository: where the person's command runs it.
const appDir = root;

let child = null;
// An app this command did not start carries nothing that counts its model calls: its replies are seen
// through the proxy, and the person is told so, as what they chose.
const UNSEEN = "your app was already running, so Cortad sees its replies and not the calls it makes to its model.";
const keepStart = (record) => { Object.assign(keptStart, record); try { mkdirSync(homeOf(project), { recursive: true, mode: 0o700 }); writeFileSync(startFile, JSON.stringify(keptStart), { mode: 0o600 }); } catch { /* kept for this session only */ } };
async function startApp() {
  // "--port 8106 -- ..." is "start it, it will answer on 8106", not "it is already on 8106".
  if (wantedPort && !typed) {
    if (!(await answers(wantedPort))) return { port: null, said: "", why: `nothing is answering on port ${wantedPort}, so there is nothing to ask. Start your app, then run this again.`, noStart: true };
    await useProxy();
    say(`${UNSEEN} To see them, start it through Cortad instead: npx cortad ${code || "<code>"} -- <how you start your app>`);
    keepStart({ port: wantedPort });
    return { port: wantedPort, cmd: null };
  }
  const sourceFiles = files.map((f) => join(root, f));
  // Only its own request-rate and concurrency limits: who the app lets in and what it may spend are never touched.
  const lifted = liftedLimits(sourceFiles);
  const raised = Object.keys(lifted);
  if (raised.length) say(`raising your app's request-rate and concurrency limits while Cortad tests it, so its simulated users are not blocked: ${raised.join(", ")}. Spend and budget limits are left as they are`);
  launched = { cmd: typed, lifted };
  if (proxyAsked || !hookable(appDir, typed)) await useProxy();
  step(`starting your app with: ${shownCommand(typed, mask)}${fromSaved ? " (saved from your last connect)" : ""}`);
  const up = await launch(180_000);
  if (up.port) {
    keepStart({ cmd: typed, ...(wantedPort ? { port: wantedPort } : {}) });
    // A container never saw the proxy's settings: the one line that makes its model calls visible is said here.
    if (proxy && inContainer(typed)) sayIf(containerLine());
    return { port: up.port, cmd: launched.cmd, lifted: raised };
  }
  if (up.tail) console.error(up.tail);
  return { port: null, said: up.tail, why: whyNot(up) };
}
// Why a start did not come up, in a sentence that stands without the terminal: the runner's state
// carries it to the verbs, and the screen gets the app's own words beside it.
function whyNot(up) {
  const h = up.held;
  if (h) return `port ${h.port} is in use by another program (pid ${h.pid}${h.command ? `, ${h.command}` : ""}), so your app cannot listen there. Stop that program and save a file here, and your app is started again by itself; or run this command with --port ${h.port} to use the one running as it is.`;
  const cause = startCause(up.tail);
  return `${up.exited !== null ? "your app stopped before it answered" : "your app did not answer within three minutes"}. ${cause ? `${cause}. ` : ""}What it printed is above, and it is your app's own output. Fix it and save a file here: your app is started again by itself with the same command.`;
}

// What the running app was started from, noted in app.json for the verbs, which run in another
// process (lib/fresh.mjs): when it started, whether this command started it, whether it reloads on
// save, and what each source file said then. An app found already running is noted by its own
// process's age and command line, with the file names alone.
let loaded = null;
const noteApp = () => writeApp(project, loaded?.at
  ? { runner: process.pid, own: loaded.own, startedAt: new Date(loaded.at).toISOString(), reloads: loaded.reloads, files: loaded.files }
  : { runner: process.pid });
async function noteAttached(port) {
  const pid = await listenerOn(port);
  const chain = pid ? await chainOf(pid).catch(() => []) : [];
  loaded = { own: false, at: chain.length ? Date.now() - elapsedMs(chain[0].etime) : null, reloads: RELOADER.test(chain.map((p) => p.args).join("\n")), files: sourceOf(root, files, false) };
  noteApp();
}

// Your app, started the way you start it, and watched until one of its own ports answers.
let launched = null;

// Every way the app is started comes through here. An app the hook could not load into (another
// runtime, a container) is started again with its model settings pointed at the proxy, so its calls
// are still seen. Nothing else is fixed for the app: a dependency it misses, a service it reaches for
// and finds down, a port it cannot bind, are its own to report, and they are reported in its own words.
async function launch(waitMs) {
  const up = await start(waitMs);
  if (up.port && !proxy && !(await hookedAt(up.port))) return startProxied(up, waitMs);
  return up;
}
// Whether the hook loaded into the process answering on `port`. A machine that cannot name that
// process leaves the app as it is.
const hookedAt = async (port) => { const pid = await listenerOn(port); return !pid || capture.hookedAt(port, pid); };
// The proxy, opened once: the app's model calls are seen there from the next start on.
async function useProxy() {
  if (proxy) return;
  const noted = () => { if (became?.state === "up") become("up", { ...became.fields, ...upAt(became.fields.proxied) }); };
  // A first model call seen through it is said to the run, for an app this command did not start.
  proxy = await openProxy({
    // The same model port on every connect of this folder: a container's settings name it once.
    modelPort: Number(keptStart.modelPort) || 0,
    file: capture.file, rulesFile: capture.rulesFile, target: () => ({ host: appHost, port: app?.port }),
    onSeen: () => { forgetTold?.(); noted(); },
    onUnseen: (door) => { unseen = door; noted(); say(unseenText(door)); },
  });
  keepStart({ modelPort: proxy.modelPort });
  say("your app's model calls are seen through a local proxy on this machine, so the line of code that made each call is not known. During a simulation, its calls to other services go out as they would for a real customer: a conversation that books, charges or emails does it for real");
}
const sayIf = (line) => { if (line) say(line); };
// An app run in a container: the proxy's settings never reach it, and 127.0.0.1 inside it is not this machine.
const containerLine = () => {
  // Only the settings the app's own environment names, else the OpenAI one: every SDK's would be a list nobody reads.
  const hints = modelHints();
  const handed = proxy.env(hints);
  const named = Object.keys(handed).filter((name) => name in hints);
  const passed = passedThrough(launched?.cmd);
  // A setting the command already hands the container from this terminal arrives on the proxy as it is.
  const missing = (named.length ? named : ["OPENAI_BASE_URL"]).filter((name) => !passed.has(name));
  if (!missing.length) return "";
  const settings = missing.map((name) => `${name}=${forContainer(handed)[name]}`);
  return `your app runs in a container, where Cortad's hook cannot load: its replies are seen through the proxy, its model calls are not. To see them, give the container ${settings.length === 1 ? "this setting" : "these settings"} and start it again with this command (the same port on every connect of this folder): ${settings.join(", ")}`;
};
// The app answered, and the hook is not in it: it is started again with its model settings on the
// proxy. One in a container would come back the same, so it is left up, seen at the front alone.
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
  // The record of what the app writes opens with the app: the first run starts itself on the
  // server's side, with no verb here to mark it, and a restart mid-run keeps the record open.
  try { markRun(writesDirOf(homeOf(projectOf(root))), "session", { keep: true }); } catch { /* the app's writes go unrecorded */ }
  toolsAtStart = toolsNow();
  // Taken before the app reads a file: a save after this moment is a change it has not loaded.
  const note = { own: true, at: Date.now(), reloads: RELOADER.test(cmdText), answered: false };
  note.files = sourceOf(root, files);
  loaded = note;
  // The app gets this terminal's environment, as a start by hand would, its own request limits raised
  // for the session, and the hook. No env file is read into it: its own loader reads its own files, in
  // its own order, which is the only way a test file's placeholder key never outranks the real one.
  const base = { ...process.env, ...lifted };
  child = spawnTied(cmd, { cwd: appDir, env: { ...base, ...(proxy ? (inContainer(cmd) ? forContainer(proxy.env(modelHints())) : proxy.env(modelHints())) : capture.env(base)), FORCE_COLOR: "0" } });
  const mine = child;
  become("starting", { app: mine.pid ?? null });
  let seen = "";
  const onData = (log) => (d) => {
    const s = d.toString(); log(d); seen = (seen + s).slice(-20_000); lastSaid = seen; lastOutputAt = Date.now(); if (verbose) process.stdout.write(s);
    if (!note.reloads && RELOADER.test(s)) { note.reloads = true; if (note.answered && loaded === note) noteApp(); }
  };
  mine.stdout.on("data", onData(logTo()));
  mine.stderr.on("data", onData(logTo()));
  let exited = null;
  appGone = false;
  mine.on("exit", (code) => { exited = code ?? 1; if (child === mine) appGone = true; });
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    const tail = () => seen.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter(Boolean).slice(-25).join("\n");
    // The port was taken: the app says so and exits at once, so this is read before the exit code,
    // or a bed whose .env named a port another round still held printed "your app stopped" three times.
    const taken = /EADDRINUSE|address already in use/i.test(seen);
    if (exited !== null && !taken) return { port: null, exited, tail: tail() };
    // nodemon and its kind outlive the app they watch: the app is gone, the process is not, and
    // the wait ran its whole three minutes on one app with the reason sitting in the output.
    // Also: the port is taken, under a watcher that does not exit when its app cannot listen. The
    // holder is named, and startApp attaches to it only when it runs from this repository.
    if (taken || /app crashed - waiting for file changes|waiting for (?:file )?changes before restart|Failed running/i.test(seen)) {
      await stopTree(mine.pid);
      if (!taken) return { port: null, exited: 1, tail: tail() };
      // The port your command names is held by another program: it is named, and your command is
      // never rewritten to another port.
      const port = portInError(seen);
      return { port: null, exited: 1, tail: tail(), held: port ? await holderOf(port) : null };
    }
    // The port is what the app's own process group listens on. Never a guess: a developer's
    // machine has other things on 3000 and 8080, and one of them answered for the app once.
    const ports = await listening(mine.pid);
    // The socket can open before the server answers; the log line is the tiebreak among several.
    const plain = withoutStores(seen.replace(/\x1b\[[0-9;]*m/g, ""));
    const said = [...plain.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b|\bport\s*[:=]?\s*(\d{4,5})\b/gi)].map((m) => Number(m[1] || m[2])).reverse();
    // A container publishes its port through the daemon, so nothing in this command's own process
    // family listens on it and `ports` stays empty however long the wait runs. What the container
    // said is then the only evidence there is, and `answers` still has to agree before it is used.
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
  // A start given up on is stopped: the next one never runs beside it.
  await stopTree(mine.pid);
  return { port: null, exited: null, tail: seen.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter(Boolean).slice(-12).join("\n") };
}

// A restart waits this long for the run's requests already at your app, then goes ahead: one it
// cuts is sent again once your app answers.
const DRAIN_MS = 20_000;
// One start of your app at a time, whoever asks for it: a save, a verb, the copies made for this
// session, or the health loop bringing back an app that stopped. One asked for while another is under
// way is that one, so a second file saved while a crashed app comes back never kills its start.
let restartDone = null;
// The read's list of tools as the app was started with it: the hook wraps a tool's function only when
// the list is there before the file holding it loads (lib/trace.cjs).
const toolsNow = () => { try { return readFileSync(join(work, "tools.json"), "utf8"); } catch { return ""; } };
let toolsAtStart = "";
const listCameLate = () => { const now = toolsNow(); return now !== "" && now !== "[]" && now !== toolsAtStart; };
// A list that arrives after the app started: the app is started again at once, behind the gate. The
// server writes it as a run starts, before its first conversation, and before Cortad's first test
// requests; any request already at the app is waited for, and one cut is sent again.
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
const SAVED_CODE = "starting your app again so it runs the code you saved, since it does not reload by itself";
// Your app read its env files when it started and nothing reloads them, so a value saved into one is
// a value it is not running on. A customer changed one and had to stop this command and run it again
// for every change; one of his apps was left running each time.
const SAVED_ENV = "starting your app again so it reads the value you saved in your env file, which your app reads only when it starts";
// The same command again, for an app that does not reload on save. Only an app this program
// started: one you started yourself is yours to restart. New requests wait at the gate meanwhile.
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
// Saved since your app started, in a file it runs: bytes written back as they were are not a change,
// and neither is a file the app wrote itself.
const savedSinceStart = () => Boolean(loaded?.files) && changesOf({
  root, app: { startedAt: new Date(loaded.at).toISOString(), files: loaded.files }, skip: writtenPaths(writesDirOf(homeOf(project))),
}).changed.length > 0;
// An env file of the app's own, saved since it started: compared by the time on the file, since what
// it holds is never read into this command's own record. An example file is nobody's settings.
const envSavedSinceStart = () => Boolean(loaded?.own && loaded.at) && envFiles.some((f) => {
  try { return !/\.(example|sample)$/.test(f) && statSync(f).mtimeMs > loaded.at; } catch { return false; }
});
// Why the app has to start again now, or nothing when it is running what is on disk.
const whyRestart = () => (savedSinceStart() ? SAVED_CODE : envSavedSinceStart() ? SAVED_ENV : null);
// Every save that changes what your app runs starts it again, when it does not reload by itself: an
// agent that saved a fix and asked the app eight seconds later was answered by the old code. Looked
// at again after each restart, for a save made while it was under way, and before the first wait too:
// the app starts while the code is uploaded, and a save made before this watch began was otherwise never seen.
async function restartOnSave() {
  while (!closing) {
    for (let why = whyRestart(); !closing && launched && child && !appGone && !loaded?.reloads && why; why = whyRestart()) await restartApp(why);
    await sourceChanged();
  }
}
async function restartNow() {
  const port = app.port;
  await stopTree(child.pid);
  // Until the port is free, not merely silent: a listener still closing does not answer and still
  // holds the bind, and the restarted app was moved to the next port while the run kept knocking on
  // this one (resumeforge's verify played seven trials against nothing).
  for (let i = 0; i < 75 && (await listenerOn(port)); i++) await new Promise((r) => setTimeout(r, 200));
  const up = await launch(90_000);
  if (!up.port) {
    const error = up.held ? sentence(whyNot(up)) : up.exited !== null ? `Your app exited ${up.exited} on restart.\n${up.tail}` : "Your app was restarted but did not answer within 90 seconds.";
    become("failed", { error: mask(error).slice(-600) });
    return { error };
  }
  become("up", { ...upAt(up.port), app: child?.pid ?? null });
  // Said to the server every time, on the same port too: what its endpoints' test messages met before
  // the restart is not what they meet now, and a key fixed in the env file left Run held on the old
  // refusal. On another port the world follows the app, never the other way round.
  const moved = up.port !== port;
  if (moved) app = up;
  const told = await announce().catch(() => null);
  if (moved && !told?.ok) return { error: `Your app came back on port ${up.port}, not ${port}. Run the command again to reconnect.` };
  if (moved) say(`your app came back on port ${up.port}; the simulation follows it there`);
  return { restarted: true, port: up.port };
}
const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// The last lines the app printed, masked: what the runner's state carries of its own words.
const lastLines = (said) => mask(String(said ?? "").split("\n").filter(Boolean).slice(-12).join("\n")).slice(-1500);
const failedWith = (why, said) => become("failed", { error: mask(why), ...(said ? { said: lastLines(said) } : {}) });
// ---- leaving: every way out stops the app this command started. This orderly path stops it and
// tells the server; a death no handler sees (SIGKILL) is covered by the watchdog lib/proc.mjs ties
// to the app, and the exit hook above releases the project either way.
async function close(code = 0) {
  if (closing) return;
  closing = true;
  try {
    if (child?.pid) await stopTree(child.pid);
    proxy?.close();
    // A sign-in the app printed before its request reached this command is masked now. Only by the
    // process that writes the file: another may still be appending to it.
    if (readRunner(project)?.pid === process.pid) {
      try { if (statSync(bootLog).size <= MASKED_AT_END_MAX) writeFileSync(bootLog, mask(readFileSync(bootLog, "utf8"))); } catch { /* left as it was written */ }
    }
    if (box) await call("DELETE", `/local/${box}`, undefined, { timeoutMs: 5000 }).catch(() => {});
    await exec("rm", ["-rf", work]).catch(() => {});
  } finally { process.exit(code); }
}
const quit = (line) => { try { console.error(`cortad  ${line}`); } catch { /* the terminal is gone */ } return close(1); };
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => close(0));
process.on("uncaughtException", (e) => { void quit(e?.stack ?? String(e)); });

// ---- go
say("getting ready");
step("looking at this folder");
const envFiles = [];
const files = [];
listed = gitListed();
walk(root, 0, files, envFiles, 0);
// Their own command says where the rest of their settings are, and the shell it runs in holds the
// ones a provisioned machine applies there: both are read here, to hide their values and to know
// where the app's model settings point. Neither is sent.
for (const named of envFilesNamedIn(typed, appDir)) if (!envFiles.includes(named)) envFiles.push(named);
const shellSecrets = environmentSecrets(process.env);
secrets = secretValues(envFiles, shellSecrets);
envKeys = [...secretEnvValues(envFiles, (f) => readFileSync(f, "utf8")), ...shellSecrets];
const kept = [];
for (let i = files.length - 1; i >= 0; i -= 1) if (carriesKey(files[i])) kept.unshift(...files.splice(i, 1));
// What a connect sends, and all --explain prints, from this one function: the AI layer the read's own
// parsers choose (lib/layer.mjs), less every data file, which --explain names as held back. The rest
// of the folder is never sent, and a read may not ask for it later (readable).
const candidatesOf = (rels) => rels.flatMap((rel) => { let full; try { full = readFileSync(join(root, rel), "utf8"); } catch { return []; } return [{ path: rel, head: full.slice(0, 4000), size: Buffer.byteLength(full), full }]; });
const isData = (rel, size) => DATA.test(rel) || (/\.json$/i.test(rel) && size > DATA_JSON);
// What `sample` may open of the project: a file the upload's own walk kept, never data, never one with a key in it.
let walked = null;
const mayOpen = (rel) => {
  if (!(walked ??= new Set(files)).has(rel) || !shareable(rel)) return false;
  try { return !isData(rel, statSync(join(root, rel)).size) && !carriesKey(rel); } catch { return false; }
};
const toSend = () => {
  const candidates = candidatesOf(files);
  const chosen = layerOf(candidates);
  const size = new Map(candidates.map((c) => [c.path, c.size]));
  const kept = chosen.files.filter((rel) => !isData(rel, size.get(rel)));
  return { ...chosen, files: kept, why: new Map(kept.map((rel) => [rel, chosen.why.get(rel)])), data: chosen.files.filter((rel) => !kept.includes(rel)) };
};
// The files the agent picked, with the reason the AI layer's parsers give each, read across the
// whole set so a route is seen reaching a model call in another file.
const pickedLayer = (rels) => {
  const candidates = candidatesOf(rels);
  const chosen = layerOf(candidates);
  return { ...chosen, files: candidates.map((c) => c.path) };
};
// Why a file the agent named may not leave this machine, or null: the automatic path's rules, said
// per file.
const refusalOf = (rel) => {
  const name = basename(rel);
  if (ENV_FILE.test(name) || /\.env$/i.test(name)) return "an env file";
  if (SECRET_PATH.test(rel)) return "a key or credential file";
  if (rel.split(sep).slice(0, -1).some((d) => SKIP_DIR.test(d)) || SKIP_FILE.test(name)) return "not source code: dependencies, build output, media, archives and keys never leave";
  if (!shareable(rel)) return "git ignores it";
  const { size } = statSync(join(root, rel));
  if (isData(rel, size)) return "a data file (CSV, JSON Lines, Parquet, a spreadsheet or JSON over 64 KB), and data files never leave";
  if (size > MAX_FILE) return "too large";
  if (carriesKey(rel)) return "it holds a value from your env";
  return null;
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
// The set the agent has sent, with what one more send adds. `files`: this send's files that may go.
// `all`: the whole set Cortad holds after it.
const pickedSet = (args) => {
  const asked = args.map(judged);
  const refused = asked.filter((j) => j.why).map(({ arg, why }) => ({ arg, why }));
  const before = readPicked(project).filter((rel) => !judged(rel).why);
  const all = [...new Set([...before, ...asked.filter((j) => j.rel).map((j) => j.rel)])];
  const chosen = pickedLayer(all);
  return { files: [...new Set(asked.filter((j) => j.rel).map((j) => j.rel))], all, why: chosen.why, prompts: chosen.pack.prompts, chosen, refused };
};
// No network, no app started, nothing written.
if (explain) {
  console.log(explainText(toSend(), files.length));
  process.exit(0);
}
mkdirSync(work, { recursive: true });
const keepSecret = (v) => { if (v && v.length >= 12 && !secrets.includes(v)) secrets.push(v); };
// A real request that reached their model proves its door (lib/proof.mjs). What it proved goes up,
// masked like everything else, and nothing goes up that the mask could not read; the sign-in each
// request carried stays here.
capture = makeCapture({ work, keepSecret, signIns: join(homeOf(projectOf(root)), "sign-ins.json"), signInsKept: () => signInYes, writes: join(homeOf(projectOf(root)), "writes"), root, files: () => [...(layer?.set ?? [])], appFolder: () => relative(root, appDir), printed: printedBetween, onProof: (proof) => {
  let masked;
  try { masked = JSON.parse(mask(JSON.stringify(proof))); } catch { return; }
  call("POST", `/local/${box}/proof`, masked).catch(() => {});
} });
if (!files.length) fail("no source files here to read.");

try { copyFileSync(join(homeOf(project), "tools.json"), join(work, "tools.json")); } catch { /* no run has read this project's tools yet */ }
// The key the last connect left for this project, if any: the token face signs in with it. A connect
// from the screen always asks for a fresh one, since the code may belong to another account or site.
let stored = readToken(project);
if (viaToken && !stored) fail("this project has no stored key. Run npx cortad in this folder once.");
// A network that drops while connecting ends here in a sentence, never a stack trace: running the
// command again starts a clean connection.
const unreachable = (err) => fail(`could not reach ${origin.host}: ${err?.name === "TimeoutError" ? "it did not answer in time" : "the connection failed"}. Check your connection and run the command again.`);
// The key goes up beside a code too: a code that has lapsed while this project's key still holds is
// the same person coming back, and the server signs them in by the key instead of refusing.
let attach = !code && !viaToken && !stored ? null : await call("POST", "/local/attach", { ...(viaToken ? {} : { code }), name: folderName, project },
  stored ? { headers: { authorization: `Bearer ${stored}` } } : {}).catch(unreachable);
// No code and no key that still signs in: the person approves this computer in their browser.
if (!viaToken && !code && !attach?.ok) {
  if (attach && stored) { say("the key this folder kept no longer signs in, so this computer is connected again"); stored = null; }
  code = await paired();
  attach = await call("POST", "/local/attach", { code, name: folderName, project }).catch(unreachable);
}
if (!attach.ok) fail(attach.data?.error ?? `could not sign in (${attach.status})`);
box = attach.data.box;
key = attach.data.key;
// What this folder sends: its AI layer (toSend), whatever the server answers and whatever it sent
// before. None of this is narrated: the person agreed to it before connecting, and a count of files
// sent read to them as alarm.
{
  const chosen = picks ? pickedSet([]).chosen : toSend();
  layer = { ...layerSaid(chosen), set: new Set(chosen.files) };
}
if (!viaToken && (picks || keptStart.picks)) keepStart({ picks });
if (!viaToken && (noSamples || keptStart.noSamples)) keepStart({ noSamples });
// Taken once the code is accepted: a mistyped one never ends a runner that was working.
if (!viaToken) holdProject();
writeFileSync(bootLog, "", { mode: 0o600 });

const list = join(work, "files.txt");
const archive = join(work, "tree.tgz");
// `rels` packed, and which code that is, from what the files say rather than from the archive: gzip
// stamps the time into every archive, so the same folder packed twice never matched and every
// reconnect bought a whole new read of code that had not changed, emptying the page's counts and its
// price while it ran.
async function packed(rels) {
  writeFileSync(list, rels.join("\n") + "\n");
  const h = createHash("sha256");
  for (const rel of [...rels].sort()) {
    let body = Buffer.alloc(0);
    try { body = readFileSync(join(root, rel)); } catch { continue; }
    h.update(rel).update("\0").update(createHash("sha256").update(body).digest("hex")).update("\n");
  }
  // COPYFILE_DISABLE: a Mac's tar adds no "._name" entries.
  await exec("tar", ["-czf", archive, "-C", root, "-T", list], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return { bytes: readFileSync(archive), digest: h.digest("hex") };
}
// The commit this tree is, sent as forty characters with the code so a simulation is tied to the code
// it tested. Your .git and its history never leave this machine. A folder that is not a checkout
// sends nothing, and the report says so rather than inventing one.
const head = (() => {
  try {
    const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return /^[a-f0-9]{40}$/.test(sha) ? sha : "";
  } catch { return ""; }
})();
// Started now, so it comes up while the code is packed and sent; told to the server once it has the code.
const firstStart = startApp();
firstStart.catch(() => { /* appLife reads the failure */ });
step("connecting to your Cortad account");
const PART = 1_500_000;
let resumed = false;
let moved = false;
// The whole upload, part by part. A part that did not land is the upload's to send again, from its
// first part, once, a few seconds later: a part numbered 0 begins the archive afresh on the server, so
// a second pass never lands on what the first left. A refusal of this machine's key is not retried.
async function sendTree({ bytes, digest }) {
  const parts = Math.max(1, Math.ceil(bytes.length / PART));
  for (let off = 0; off < bytes.length; off += PART) {
    const last = off + PART >= bytes.length;
    step(parts > 1 ? `connecting to your Cortad account, ${Math.floor(off / PART) + 1} of ${parts}` : "connecting to your Cortad account");
    // The last part asks for this machine's key when none is stored yet: minted once the repository
    // row exists, kept in ~/.cortad for the runs a coding agent asks for on later days. A connect by a
    // code asks too, since the code may be another account's: the key kept from the account before
    // signed the coding agent's tools into that one, its runs and its counts.
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
// With --agent-picks and nothing sent yet, nothing goes up until the agent's first send.
if (layer.set.size || !picks) {
  // `files` stays the whole folder: it is also what a save is judged against (savedSinceStart).
  const sent = await upload(picks ? [...layer.set] : files.filter((rel) => layer.set.has(rel)));
  if (!sent.ok) sent.err ? unreachable(sent.err) : fail(sent.data?.error ?? `upload failed (${sent.status})`);
}
// Which history tool this folder's env names, by name only, so the setup card can say where its users'
// messages will come from before the person is asked how many.
{
  const found = sourcesIn({ ...envOf(root), ...process.env }).map((s) => s.id);
  if (found.length) void reportLive({ apiBase: api, token: readToken(project) }, { found });
}
// Unchanged code has already been read: coming back says so instead of claiming a second read.
// Said of the account, never of the app: a bare "connected" here, above an app that could not take its
// port, was read as the app being up (2026-11-12).
stepDone(picks && !layer.set.size ? "connected to your Cortad account: it has none of your files yet, and your coding agent picks them" : moved ? "connected to your Cortad account: your change is in, and what Cortad read before still stands" : resumed ? "connected to your Cortad account: your code has not changed since last time" : "connected to your Cortad account");
// One coding agent learns about Cortad for this project: the one running this command, whose setup
// prompt asked the person first, or the one the person names here. A run started by an agent later
// comes back through lib/cli.mjs.
// CORTAD_NO_REGISTER=1 leaves the coding agents alone: a stack under test on this machine must never
// repoint the person's own agents at an unpublished build.
if (!viaToken && process.env.CORTAD_NO_REGISTER !== "1") {
  const agent = agentOf() ?? await askAgent();
  const got = agent ? await register(agent, { root }).catch((err) => { if (verbose) say(`could not register with ${AGENTS[agent]}: ${err?.message ?? err}`); return null; }) : null;
  if (got?.changed.length) say(`Cortad's tools and skill were added to ${got.agent} for this project: ${got.changed.join(", ")}.`);
}

lock = await makeLock({ root, work, envFiles });
if (lock && !lockHolds(lock, root)) lock = null;
if (!lock) say("running your tests is off on this machine (no sandbox-exec or bubblewrap). Everything else works.");
else if (lock.refused) say(`${lock.refused} Everything else works.`);

// A change to their own files, settled: what "I fixed it" looks like from here. Folders an app
// writes to by itself are not a fix.
const NOT_A_FIX = /(?:^|[\\/])(?:node_modules|\.git|\.next|\.nuxt|\.turbo|\.cache|dist|build|coverage|logs?|tmp|__pycache__|\.venv|venv)(?:[\\/]|$)|\.log$/;
function sourceChanged() {
  return new Promise((resolve) => {
    let timer = null;
    let watcher = null;
    const done = () => { try { watcher?.close(); } catch { /* closed */ } resolve(); };
    try {
      watcher = watch(root, { recursive: true }, (_event, file) => {
        if (!file || NOT_A_FIX.test(String(file))) return;
        clearTimeout(timer);
        timer = setTimeout(done, 1200);
      });
    } catch { setTimeout(done, 15_000); }
  });
}
// `proves`: each request seen reaching the model is posted as its door's proof, so the run waits for
// those; false for an app seen through the proxy alone. `reached`: the servers the app has connected
// to so far, by address, so the card can say where test conversations write before the person's yes.
// `watching` and `metered` say the same as `proves` to a server from before this version.
const announce = async () => {
  // The server takes the app once it has code to tie it to: with --agent-picks, the first send.
  if (picks && !layer.set.size) return { ok: true };
  const hooked = Boolean(proxy ? launched || proxy.seen() : launched && capture?.watching(app.port));
  return call("POST", `/local/${box}/app`, { port: doorPort(), cmd: shownCommand(app.cmd, mask), lifted: app.lifted ?? [], watching: hooked, metered: hooked, proves: hooked, reached: reachedNow() });
};
const reachedNow = () => (capture?.connections() ?? []).map((c) => `${c.host}:${c.port}`).slice(0, 40);

// Your app's life beside this connection. It is started; if it stops, or never comes up, this stays
// and starts it again the moment you save a fix, and the browser is told each time it answers, so a
// world still looking for your chat asks again by itself. Nothing is ever rerun by hand.
async function appLife(firstStart) {
  for (let first = true; ; first = false) {
    const got = await (first ? firstStart : startApp());
    if (got.port) { app = got; if (!launched) await noteAttached(app.port); break; }
    failedWith(got.why, got.said);
    await call("POST", `/local/${box}/stopped`, { said: mask(got.said || got.why).slice(-2000) }).catch(() => {});
    say(got.why);
    // An agent holding this terminal watches for one of these two lines (skill/SKILL.md), so the
    // failure carries a line of its own: it reports the failure instead of waiting for a line that
    // never comes, and no reader takes it for the connected one.
    if (first) say(NOT_RUNNING);
    await sourceChanged();
    become("starting");
    say("saw your change, starting your app again");
  }
  const told = await announce();
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
      // Said until it is heard. Said once, it was lost when their app came back while the network
      // was down, and the screen went on showing an app that had stopped while it answered turns.
      if (!up) become("up", { ...upAt(), app: launched ? child?.pid ?? null : null });
      else if (became?.state === "up") {
        const now = upAt();
        if (JSON.stringify(now.receipts) !== JSON.stringify(became.fields.receipts)) { const { receipts: _was, ...fields } = became.fields; become("up", { ...fields, ...now }); }
      }
      // A server the app reached for the first time is said on the card, where the person's yes is asked.
      const seen = reachedNow().join(",");
      if (seen !== reachedTold) { reachedTold = seen; appTold = false; }
      if (!up || !appTold) { up = true; appTold = Boolean((await announce().catch(() => null))?.ok); }
      continue;
    }
    // Running, holding its port, and slow because it is answering the run's own requests: working,
    // not dead. Nothing is said and nothing restarts, and a silence after it is timed from here.
    if (state === "busy") { if (!up) downSince = Date.now(); continue; }
    if (up) { up = false; downSince = Date.now(); }
    appTold = false;
    const downFor = Date.now() - downSince;
    // Not answering. A dev server restarting on a save says so in its output: it is left alone,
    // however long its own startup takes.
    // A watcher that has said its app crashed is not reloading, it is waiting, and says so.
    const crashed = /app crashed - waiting|Failed running|waiting for (?:file )?changes before restart/i.test(lastSaid.slice(-600));
    const reloading = launched && !appGone && !crashed && Date.now() - lastOutputAt < 15_000;
    if (reloading || downFor < (crashed ? 4_000 : 10_000)) continue;
    // Down for real. The screen is told, so it never shows an app that is not there.
    // `exited`: the process this command started is gone or its watcher said it crashed, not a process
    // running and not answering. The run tells the two apart: one is their crash, the other may be our
    // load. An app it only attached to is not its to watch, so nothing is said either way.
    if (!toldDown) {
      // Started again below, except an app given by --port, which is picked up when it answers again.
      if (!launched && wantedPort) failedWith(`your app stopped answering on port ${app.port}; it is picked up again when it answers`, lastSaid);
      else become("starting");
      toldDown = Boolean((await call("POST", `/local/${box}/stopped`, { said: mask(lastSaid || "your app stopped answering").slice(-2000), ...(launched ? { exited: Boolean(appGone || crashed) } : {}) }).catch(() => null))?.ok);
    }
    // An app that went quiet or exited did not stop because of a save (it was killed, it ran out
    // of memory, it crashed on a request), so waiting for a save would wait forever. It is started
    // here, whoever started it first: an app this command only attached to (yours, from another
    // terminal, or one left behind by a terminal that was killed) is gone now, and this command
    // knows how it starts. Only an app given by --port is left to you, and picked up when it returns.
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

// Counted with the run's own requests, so a restart drains them, and sent only through the open gate.
async function countedFetch(url, init) {
  while (gate) await gate;
  answering += 1;
  try {
    const res = await fetch(url, init);
    const body = await res.arrayBuffer();
    return new Response(body.byteLength ? body : null, { status: res.status, statusText: res.statusText, headers: res.headers });
  } finally { answering -= 1; }
}
// The test request that proves an endpoint: built by Cortad from what it read, sent from here to the
// app on its port (lib/auto-reach.mjs). Sent by this command as soon as the app is up and the read
// names the endpoint, once per endpoint and again when its file changes; the agent's `reach` sends
// one again on demand. Until 2026-10-23 nothing was sent without the agent asking, and the agent sent
// each endpoint a message by hand: a step on every connect, and the one an agent could not finish
// when an endpoint's own model refused (Run waited on it for a day).
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
  // Sent as the app's own client sends it: the client origin the code names (read once per app
  // port, from this folder, never sent on), else the app's own origin.
  origin: () => { const port = app?.port ?? null; if (clientOrigin.port !== port) clientOrigin = { port, value: clientOriginOf(root, { port }) ?? (port ? `http://localhost:${port}` : null) }; return clientOrigin.value; },
  keys: () => keysFromEnv(root),
  // The sign-ins Cortad can make on this machine: a token signed with the app's own secret from its
  // env, only after the yes recorded here, then one test account on the app's own sign-up and sign-in
  // doors, only after the person's yes the server holds.
  mint: async () => (signInYes ? mintAfterYes(homeOf(project), envOf(root)) : null),
  // The sign-in that worked last time, kept in this folder's ~/.cortad so a restart costs no endpoint a request again.
  keptSignIn: async () => (signInYes ? keptSignIn(homeOf(project)) : null),
  onSignedIn: (as) => { if (signInYes) rememberSignIn(homeOf(project), as); },
  onKeptRefused: () => forgetSignIn(homeOf(project)),
  // The last rung: the request the app's own frontend makes, captured once per connection in a
  // headless browser on this machine, when that frontend answers at the client origin.
  browser: async () => {
    if (!app?.port) return null;
    const appOrigin = `http://${appHost === "::1" ? "[::1]" : appHost ?? "127.0.0.1"}:${app.port}`;
    if (!browserSeen || Date.now() - browserSeen.at > 600_000) browserSeen = { at: Date.now(), got: await clientRequestOf({ clientOrigin: clientOrigin.value, appOrigin }).catch(() => null) };
    return browserSeen.got;
  },
  account: async (auth) => (app?.port ? signUpAndIn({ origin: `http://${appHost === "::1" ? "[::1]" : appHost ?? "127.0.0.1"}:${app.port}` }, auth, testAccount(homeOf(project)), countedFetch, { origin: clientOrigin.value }) : null),
  // Sent as the person's own request was, when one was seen: the sign-in it carried, kept here.
  signIn: async () => { const theirs = capture?.headers(CAPTURED); const name = theirs && Object.keys(theirs).find((k) => /^(?:authorization|cookie)$/i.test(k)); return name ? { name: name.toLowerCase(), value: theirs[name] } : null; },
  stampOf: (m) => { try { return m.file ? String(statSync(join(root, m.file)).mtimeMs) : ""; } catch { return ""; } },
  // A round of this command's own stops between two sends for an agent's ask, and for a run: its
  // requests are the app's to answer first, and on an app that serves one request at a time a test
  // request of ours in the queue is a reply the run waits for.
  asked: () => existsSync(join(homeOf(project), ASK)),
  busy: () => answering > 0,
  report: async (answers) => {
    if (!answers.length && reachedBox === box) return true;
    const to = box;
    // False where the server did not take it: the answers are kept and said again (lib/auto-reach.mjs).
    const ok = Boolean((await call("POST", `/local/${to}/reached`, { answers }, { timeoutMs: 15_000 }).catch(() => null))?.ok);
    if (ok) reachedBox = to;
    return ok;
  },
  say,
  fetchImpl: countedFetch,
});
// The agent's `send` (lib/picks.mjs), taken whether or not the app is up: a preview of what would
// leave, or on its yes the whole set packed and sent, which the read studies.
async function sendPicked(args, go, spec) {
  const set = pickedSet(args);
  if (!go || !set.files.length) return previewText({ ...set, go, spec });
  const before = layer;
  layer = { ...layerSaid(set.chosen), set: new Set(set.all) };
  const sent = await upload(set.all);
  if (!sent.ok) { layer = before; return `Nothing was sent: ${sent.err ? `could not reach ${origin.host}` : sent.data?.error ?? `the upload failed (${sent.status})`}.\nnext: npx -y ${spec} send --yes ${args.join(" ")}`; }
  writePicked(project, set.all);
  me.picked = set.all.length;
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
    try { SEND.answer(homeOf(project), ask.id, text); } catch { /* the agent's wait runs out */ }
  }
}
if (picks) void sendLoop();
// The connection the server last heard what the agent's requests met; a reattach is a new one.
let reachedBox = "";
async function reachLoop() {
  // A round of this command's own runs when the last one said to look again; an agent's ask is taken
  // the second it is left and never waits for one.
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
    try { answerAsk(homeOf(project), ask.id, out?.text ?? "Nothing was sent.\nnext: status"); } catch { /* the agent's wait runs out */ }
  }
}

// Keep the laptop awake while a world stands on it.
if (process.platform === "darwin") spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore", detached: true }).unref();

// Started by a shell verb rather than a person, this process leaves once no run has needed it for
// a while, so an app is not held up all night for a verify that finished at noon.
const IDLE_MS = 10 * 60_000;
if (argv.includes("--until-idle") && stored) {
  let idleSince = Date.now();
  setInterval(async () => {
    const res = await call("GET", "/mcp/status?quiet=1", undefined, { headers: { authorization: `Bearer ${stored}` } }).catch(() => null);
    if (res?.ok && res.data?.run && !finished(res.data.run)) idleSince = Date.now();
    else if (Date.now() - idleSince > IDLE_MS) { say("no simulation for ten minutes, leaving"); await close(0); }
  }, 60_000).unref();
}

// A verb in another process asks for the app to be started again before a run, because its code
// changed and nothing reloaded it (lib/fresh.mjs). The new start is noted as the app answers; one
// that fails is the runner's failed state, with its reason. A restart already under way answers the
// same way.
process.on("SIGUSR2", () => {
  if (restarting || !app) return;
  void restartApp();
});

// A job's result is work already done on this machine: sent until the server has it, through a dropped
// network, for as long as the server can still be waiting on it (the bus's five-minute call). Sent once
// and dropped on a failure, a reply the app gave during a thirty-second outage was lost and the run
// waited out its turn. Any answer below 500 ends it: 404 is a server that no longer holds the job.
async function deliver(id, out) {
  for (let wait = 1000, until = Date.now() + 300_000; Date.now() < until && !closing; wait = Math.min(wait * 2, 15_000)) {
    const res = await call("POST", `/local/${box}/jobs/${id}`, out).catch(() => null);
    if (res && res.status < 500) return;
    await new Promise((r) => setTimeout(r, wait / 2 + Math.random() * (wait / 2)));
  }
}

// Asked again through a server that is still starting, a network that dropped or a rate limit every
// terminal meets at once after a deploy, for as long as a restart can take: only the server saying it
// does not know this terminal (404) ends the session. Ended on the first slow answer, a deploy that
// restarted the server ended every session it held.
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
// Each poll names the jobs the last one brought. A poll's answer can die on the way (the network
// drops, the lid closes): the server sends again whatever is not named, and a job seen twice is
// done once.
let got = [];
const seenJobs = new Set();
for (;;) {
  let res;
  try { res = await call("GET", `/local/${box}/jobs${got.length ? `?ack=${got.join(",")}` : ""}`, undefined, { timeoutMs: 40_000 }); }
  catch { quiet += 1; if (quiet === 3) say("reconnecting..."); await new Promise((r) => setTimeout(r, Math.min(quiet, 10) * 1000)); continue; }
  if (closing) break;
  if (res.status === 404) {
    // The server restarted and forgot this terminal. It is the same terminal: it proves so with the
    // key it was given, its box is opened again, and the app it is holding is announced again.
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
