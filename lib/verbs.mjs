import { realpathSync, statSync } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";
import { machineText, SHOW, showText } from "./read-text.mjs";
import { needsText } from "./picks.mjs";
import { numbersText } from "./numbers-text.mjs";
import { askReach } from "./auto-reach.mjs";
import { homeOf, projectOf } from "./home.mjs";
import { intelligence as setUp } from "./intelligence.mjs";
import { reach as reachApp } from "./reach.mjs";
import { recordSignInYes } from "./sign-in.mjs";
import { fieldText, findingsText, finished, linesOf, notStartedText, refusedText, restartedText, runText, startedText, startingText, statusText, testedLine, upWaitingText, waitingText } from "./text.mjs";
import { pressedLine } from "./words.mjs";
import { incidentsText, intelligenceText, outcomesText, queryText } from "./intel-text.mjs";
import { againstText, behaviorText, historyText, searchText } from "./behavior-text.mjs";
import { askedText, proposalOf } from "./setup-live-text.mjs";

// The ten things a coding agent may ask of Cortad, each a call to the API with this machine's key
// and a rendering from lib/text.mjs; `reach` also sends to the app on this machine. The MCP tools
// and the `npx cortad <verb>` commands are the same functions, so both faces say the same thing.
//
// Codex, Cursor CLI and Copilot CLI cut an MCP call at about 60 seconds. `run_status` holds for up
// to 45 seconds on the server and 58 in all. `run` and `verify` answer within a second, except while
// the run before them has its numbers in and its job is still ending: the server holds them until it
// has, up to the same 45 seconds.

const NOT_CONNECTED = "This folder is not connected to Cortad. Run npx cortad in this folder as a background command: it prints a link for the person to approve in a browser where they are signed in to Cortad.";
const HOLD_S = 45;
// `wait`: how often it asks whether a run has started, how long the connect command may be gone
// before no run can start, and how long it waits for one at all.
const WAIT_POLL_MS = 10_000;
const GONE_MS = 60_000;
const IDLE_MS = 6 * 3600_000;
// What the process that starts a run for an app that is still coming up allows it; lib/cli.mjs.
export const READY_MS = 240_000;
// The most changed files a run is scoped by; past it the run replays everything.
const MOST_CHANGED = 2000;
// The most conversations a run may play, as the person asked for it, on its way to the server: a
// whole number of at least one, or nothing at all. How many a run is allowed is the server's to
// decide and to refuse, so no ceiling is kept on this side to drift from the one it holds.
export const cappedAt = (n) => (Number.isSafeInteger(n) && n >= 1 ? { conversations: n } : {});

// `pending` keeps the run this machine asked for in ~/.cortad/<project>/pending.json: { kind,
// startedAt, after } while the app comes up, then its jobId, or the error that ended it. `after` is
// the latest run at the time, so a newer run on the server outranks a stale file. A run this machine
// posted also keeps `tested`, which code it played (lib/fresh.mjs), for its run_status and findings.
// `runner` is the record of the process holding the app up on this machine (lib/runner.mjs): the
// app's state is read there and nowhere else. `seen` is told each run the agent has now read to its
// end, so what was kept to tell it of that run is not said again. `wasRead` says whether the agent has read a run, and
// `spec` is the package the agent calls back, npx -y <spec>.
// `appLog` is the file the connect command keeps the app's output in; its path is said here, on this
// machine, beside a failure, and never sent.
export function makeVerbs({ api, token, runner = () => null, fetchImpl = fetch, startApp, pending, root, writes = null, appLog = null, code = null, seen = () => {}, wasRead = () => false, spec = "cortad", origin = null, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const call = async (method, path, body, timeoutMs = 30_000) => {
    const key = typeof token === "function" ? token() : token;
    if (!key) return { status: 0, ok: false, data: { error: NOT_CONNECTED } };
    let res;
    try {
      res = await fetchImpl(`${api}${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return { status: 0, ok: false, data: { error: `Could not reach Cortad: ${err?.name === "TimeoutError" ? "it did not answer in time" : "the connection failed"}.` } };
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
    return { status: res.status, ok: res.ok, data };
  };
  // `code` and `why` are what lib/calls.mjs counts a failure under. `why` is set only where the
  // sentence is Cortad's own: a failure that quotes the app's output carries a code and no words.
  const failed = (res) => {
    const text = res.data?.why ?? res.data?.error ?? `Cortad answered ${res.status}.`;
    const code = res.status ? `http_${res.status}` : text === NOT_CONNECTED ? "not_connected" : "unreachable";
    return { text, data: res.data, isError: true, code, why: text };
  };
  const iso = () => new Date(now()).toISOString();
  const heard = (id) => { try { seen(String(id)); } catch { /* said once more by the hook */ } };
  // Empty for an app the connect command found already running.
  const logSaid = (failing) => (failing && appLog && sizeOf(appLog) > 0 ? `Your app's whole output from this session is in ${appLog}.` : "");
  const withTested = (d, id) => {
    const kept = pending.read();
    return kept?.tested && kept.jobId === id ? { ...d, tested: kept.tested } : d;
  };
  // A simulation the waiter could not start once the app was up (lib/cli.mjs runWhenUp), while no
  // newer simulation has started since. Told once to whichever of wait and status hears of it
  // first; simulation_status answers with it every time.
  const failedLater = (latest) => {
    const p = pending.read();
    if (!p?.failedAt || p.jobId || (p.after ?? null) !== (latest ?? null)) return null;
    return { key: `failed:${p.failedAt}`, at: Date.parse(p.failedAt), error: p.error };
  };
  const unheard = (latest) => { const f = failedLater(latest); return f && !wasRead(f.key) ? f : null; };

  // With show, one section of the read in full, paged; a name that is not a section is the plain status.
  const status = async ({ show, page } = {}) => {
    // What the connect command does here is this machine's to say: nothing is sent.
    if (show === "machine") return { text: machineText(runner()?.machine ?? null).join("\n") };
    // With --agent-picks and nothing sent, what Cortad needs is all there is to say, and it is said here.
    const holder = runner();
    if (holder?.picks && !holder.picked) return { text: needsText(spec), data: { runner: holder } };
    const section = SHOW.includes(show) ? show : null;
    // The plain status is the one read that prints the server's news, and says so; a section prints
    // none, so it takes none.
    // The reviews are written when the read ends: asked for by name, the answer holds for that.
    const hold = section === "reviews" ? 45 : 0;
    const res = await call("GET", `/mcp/status${section ? `?show=${section}&quiet=1${hold ? `&wait=${hold}` : ""}` : "?news=1"}`, undefined, hold ? (hold + 13) * 1000 : undefined);
    if (!res.ok) return failed(res);
    // Status says a finished run itself, so the line kept to tell the agent of it is not said again.
    if (finished(res.data?.run) && res.data.run.jobId) heard(res.data.run.jobId);
    const here = runner();
    const data = here ? { ...res.data, runner: here } : res.data;
    const log = section ? "" : logSaid(appFailed(data.run) || (data.contact?.proven ?? []).some((v) => v.problems?.length));
    const text = section ? showText(data, section, page) : statusText(data, { spec });
    const missed = section ? null : unheard(data.run?.jobId);
    if (missed) heard(missed.key);
    const said = missed ? `${missed.error}\n${text}` : text;
    return { text: log ? withBack(said, log) : said, data };
  };

  // The files saved since the run the next one is compared with (status `baseline`), and the installed
  // packages that changed with the files importing them, which scope a run after a change on Cortad's
  // side. None when this machine cannot say: the run replays everything.
  const changeOf = async (seen) => {
    const base = (seen ?? (await call("GET", "/mcp/status?quiet=1")).data)?.baseline;
    const files = base?.jobId ? code?.saved?.(base.startedAt) : null;
    if (!files || files.length > MOST_CHANGED) return null;
    const packages = code?.packages?.(base.startedAt, files) ?? [];
    return { since: base.jobId, files, ...(packages.length ? { packages } : {}) };
  };

  // Asks the server for the run and keeps its id here, so run_status finds it without one.
  const post = async (args, kind, restarted = [], seen = null) => {
    const tested = code?.tested() ?? null;
    const change = kind === "run" ? await changeOf(seen) : null;
    const res = await call("POST", "/mcp/run", change ? { ...args, change } : args, (HOLD_S + 13) * 1000);
    if (res.status === 202 || (res.ok && res.data?.joined)) {
      const mine = res.status === 202 ? tested : null;
      pending.write({ jobId: res.data.jobId, kind: res.data.kind ?? kind, startedAt: iso(), ...(mine ? { tested: mine } : {}) });
      try { writes?.mark(res.data.jobId); } catch { /* the app's writes go unrecorded this simulation */ }
      const said = [restarted.length ? restartedText(restarted) : "", mine?.stale ? testedLine(mine) : ""];
      return { text: startedText(res.data, kind, args.findingId, said), data: res.data };
    }
    if (res.status === 402) return { text: refusedText(res.data), data: res.data, isError: true, code: "plan_spent" };
    if (res.status === 409) return { text: `${res.data?.why ?? "The simulation could not start."}\nNothing ran.`, data: res.data, isError: true, code: "run_refused" };
    return failed(res);
  };

  // An app the runner says is up, and the server is ready to play, gets the run now, started again
  // first when its code changed and nothing reloaded it; never under a run already playing, which is
  // joined. One that could not start says why and nothing is posted. Otherwise the runner is started
  // if none holds the app, and the run is posted in the background once it can be.
  const start = async (args, kind) => {
    const here = runner();
    if (here?.state === "failed") return { text: notStartedText(here), data: { app: here }, isError: true, code: "app_not_started" };
    const before = await call("GET", "/mcp/status?quiet=1");
    if (!before.ok) return failed(before);
    if (here?.state === "up" && before.data.app?.state === "ready-to-test") {
      const idle = !before.data.run || finished(before.data.run);
      const got = code && idle ? await code.fresh() : {};
      if (got.error) return { text: `${got.error}\nNothing ran.`, isError: true, code: "app_not_started" };
      return post(args, kind, got.restarted, before.data);
    }
    const spent = kind === "run" ? spentOf(args, before.data) : null;
    if (spent) return { text: refusedText(spent), data: spent, isError: true, code: "plan_spent" };
    pending.write({ kind, startedAt: iso(), after: before.data.run?.jobId ?? null });
    const began = await startApp(args, kind);
    if (!began.ok) {
      pending.write({ kind, startedAt: iso(), error: began.why });
      return { text: began.why, isError: true, code: "app_not_started" };
    }
    return { text: here?.state === "up" ? upWaitingText(here, before.data.app, spec) : startingText(spec), data: { pending: true } };
  };
  // `conversations`: the most this run may play, asked for by the person who is paying for the
  // replies. Whether a number is allowed is the server's to say (it holds the range), so only its
  // shape is read here and the server's refusal speaks for the rest.
  // `features`: the AI features this run tests, by endpoint ("POST /v1/chat"); the server keeps the
  // choice as the agent's and plans, prices and plays only those.
  // Features with nothing to test record the person's choice and start nothing: the server answers
  // `recorded` and the card in the browser shows it at once. With a sentence or a count, the run starts.
  const run = async ({ conversations, features, account, asked = false } = {}) => {
    const chosen = Array.isArray(features) && features.length ? features.map(String).slice(0, 100) : null;
    const make = account === "make";
    if (make && root) recordSignInYes(homeOf(projectOf(root)));
    if ((chosen || make) && !asked && conversations === undefined) {
      const res = await call("POST", "/mcp/run", { ...(chosen ? { features: chosen } : {}), ...(make ? { account: "make" } : {}), record: true });
      if (res.ok && res.data?.recorded) return { text: `${res.data.note}\nnext: status`, data: res.data };
      if (!res.ok) return failed(res);
    }
    return start({ ...cappedAt(conversations), ...(chosen ? { features: chosen } : {}) }, "run");
  };
  const verify = ({ findingId, jobId } = {}) => start({ findingId, ...(jobId ? { jobId } : {}) }, "verify");

  // With no id: the run this machine is still starting, held here until it has an id, or else the
  // latest run on the server.
  const resolve = async (until) => {
    const latest = await call("GET", "/mcp/status?quiet=1");
    if (!latest.ok) return failed(latest);
    const newest = latest.data.run?.jobId ?? null;
    let p = pending.read();
    if (!p || p.jobId || (p.after ?? null) !== newest) return newest ? { id: newest } : { text: "No simulation yet.\nnext: status" };
    const stale = () => now() - Date.parse(p.startedAt) > READY_MS + 30_000;
    while (!p.jobId && !p.error && !stale() && now() < until) {
      await sleep(1000);
      p = pending.read() ?? p;
    }
    if (p.jobId) return { id: p.jobId };
    if (p.error) {
      if (p.failedAt) heard(`failed:${p.failedAt}`);
      return { text: `${p.error}\nnext: status`, isError: true, code: "app_not_started" };
    }
    if (stale()) return { text: "The process starting your app for the simulation ended without a result.\nNothing ran.\nnext: status", isError: true, code: "app_not_started" };
    return { text: waitingText(p, now(), READY_MS, runner(), latest.data.app) };
  };

  const runStatus = async ({ jobId } = {}) => {
    const began = now();
    let id = jobId && jobId !== "pending" ? String(jobId) : null;
    if (!id) {
      const found = await resolve(began + HOLD_S * 1000);
      if (!found.id) return found;
      id = found.id;
    }
    const hold = Math.max(0, HOLD_S - Math.ceil((now() - began) / 1000));
    const res = await call("GET", `/mcp/run/${encodeURIComponent(id)}${hold ? `?wait=${hold}` : ""}`, undefined, (hold + 13) * 1000);
    if (!res.ok) {
      const out = failed(res);
      // Unreached is this terminal's side only: the run is on Cortad's servers and goes on without it.
      const said = res.status === 0 ? `${out.text} The simulation goes on without this call; nothing was lost or charged by it.` : out.text;
      return { ...out, text: `${said}\nnext: simulation_status ${id}` };
    }
    // A finished run's dissection is also handed over as data, for a client that reads structured results.
    return { text: shown(res.data, id), data: res.data, ...(res.data?.dissection ? { structured: res.data.dissection } : {}) };
  };

  const shown = (d, id) => {
    // The run is over: what the app wrote into its folder during it is put back, said before the next step.
    let back = "";
    if (writes && finished(d)) { try { back = writes.putBack(); } catch { back = ""; } }
    // The id asked for and the run the answer names: a verify that played another round names its latest.
    if (finished(d)) { heard(id); if (d?.jobId && d.jobId !== id) heard(d.jobId); }
    return [logSaid(appFailed(d)), back].filter(Boolean).reduce(withBack, runText(withTested(d, id)));
  };

  const sinceConnect = (r) => {
    const connected = Date.parse(runner()?.startedAt ?? "");
    return !Number.isFinite(connected) || Date.parse(r.startedAt ?? "") >= connected;
  };

  // `npx cortad wait`: returns when the next run or verify ends, started from the browser or by the
  // agent, with what it found. A coding agent starts it in the background and is woken when it exits; it is a shell
  // verb alone, since an MCP call is cut at about 60 seconds. A run playing when it starts is that run,
  // and so is a finished one the agent has not read: a first run can end before the agent starts this.
  // The history step with no store named proposes one and sends nothing (intelligence.mjs).
  const storesFor = async (messages) => {
    const ctx = { root, env: process.env, project: projectOf(root), spec, token: () => (typeof token === "function" ? token() : token), apiBase: api, readStdin: async () => "" };
    const out = await setUp(["history", "--messages", String(messages)], ctx);
    return proposalOf(out);
  };
  const wait = async () => {
    if (!(typeof token === "function" ? token() : token)) return { text: NOT_CONNECTED, isError: true, code: "not_connected", why: NOT_CONNECTED };
    const began = now();
    let id = null;
    let goneAt = null;
    for (;;) {
      if (runner()) goneAt = null;
      else if (now() - (goneAt ??= now()) >= GONE_MS) return { text: "The connect command stopped, so no simulation can start from the browser. Run npx cortad in this folder again as a background command: it reconnects with the key it kept.\nnext: status", isError: true };
      if (now() - began >= IDLE_MS) return { text: `No simulation ended in 6 hours.\nnext: npx -y ${spec} wait` };
      const res = id ? await call("GET", `/mcp/run/${encodeURIComponent(id)}?wait=${HOLD_S}`, undefined, (HOLD_S + 13) * 1000) : await call("GET", "/mcp/status?quiet=1");
      // A key that no longer opens this repository, or a run that is gone, does not come back by asking again.
      if ([401, 403, 404].includes(res.status)) return failed(res);
      // The person answered the setup card: taken once, here, and handed to the agent this wakes.
      if (res.ok && res.data?.setupAsk) {
        const took = await call("POST", "/mcp/setup/live/take");
        if (took.ok && took.data?.taken) {
          // Where the conversations are is found here, by names alone, before the person is asked.
          const found = took.data.source ? null : await storesFor(took.data.messages).catch(() => null);
          return { text: askedText(took.data, spec, origin, found), data: took.data };
        }
        if (!took.ok) await sleep(WAIT_POLL_MS);
        continue;
      }
      if (res.ok && id && finished(res.data)) {
        const text = shown(res.data, id).replace(/\nnext: [^\n]*$/, "");
        // A verify's verdict is read by simulation_status; how a run's users fared by behavior.
        return { text: `${text}\nnext: ${res.data.verify ? `simulation_status ${id}` : `behavior ${res.data.jobId ?? id}`}`, data: res.data };
      }
      const r = res.ok && !id ? res.data?.run : null;
      // The simulation the agent started this for could not start: said now, or it waits six hours for nothing.
      const missed = res.ok && !id ? failedLater(r?.jobId) : null;
      if (missed && (missed.at >= began || !wasRead(missed.key))) {
        heard(missed.key);
        return { text: `${missed.error}\nnext: status`, isError: true, code: "app_not_started" };
      }
      // A simulation the person pressed Start simulation for is news the moment it plays, told once:
      // the agent that heard nothing of it asked the person to hold off while it played.
      if (r?.jobId && r.pressedAt && !finished(r) && !wasRead(`pressed:${r.jobId}`)) {
        seen(`pressed:${r.jobId}`);
        return { text: `${pressedLine(r)}\nnext: npx -y ${spec} wait`, data: r };
      }
      // A verify is followed like a run: the agent that started it is woken at its end instead of
      // polling simulation_status twelve times a round. A finished one nobody read is news only if it began
      // under the connect command running now: one from before a restart is not the run the agent waits for.
      if (r?.jobId && (!finished(r) || (!wasRead(r.jobId) && sinceConnect(r)))) { id = r.jobId; continue; }
      // A run being followed holds on the server; a failed call, or no run yet, is asked again later.
      if (!id || !res.ok) await sleep(WAIT_POLL_MS);
    }
  };

  // Every server page of a run's findings, so the pages the agent reads are cut by size here.
  const gather = async (jobId) => {
    const path = (page, id) => {
      const q = new URLSearchParams({ ...(id ? { jobId: id } : {}), ...(page > 1 ? { page: String(page) } : {}) }).toString();
      return `/mcp/findings${q ? `?${q}` : ""}`;
    };
    const first = await call("GET", path(1, jobId));
    if (!first.ok) return first;
    const d = first.data;
    // The pages after the first, asked for at once: one after another, a run of 42 conversations ran
    // past the minute an agent's client gives a call (2026-10-24).
    const rest = await Promise.all(Array.from({ length: Math.max(0, Math.min(d.pages ?? 1, 20) - 1) }, (_, i) => call("GET", path(i + 2, d.runId ?? jobId))));
    for (const more of rest) {
      if (!more.ok) return more;
      d.findings = [...(d.findings ?? []), ...(more.data.findings ?? [])];
      // Every page carries the whole byLine; merged by line with the ids joined, or the first
      // page's groups print twice.
      for (const g of more.data.byLine ?? []) {
        const held = (d.byLine ?? []).find((h) => h.path === g.path && h.line === g.line);
        if (held) held.findingIds = [...new Set([...held.findingIds, ...g.findingIds])];
        else d.byLine = [...(d.byLine ?? []), g];
      }
    }
    return first;
  };

  // With show numbers: every number the run measured, whole, paged here.
  const findings = async ({ jobId, page, show } = {}) => {
    if (show === "numbers") {
      const q = new URLSearchParams({ show, ...(jobId ? { jobId } : {}) }).toString();
      const res = await call("GET", `/mcp/findings?${q}`);
      return res.ok ? { text: numbersText(res.data, page), data: res.data } : failed(res);
    }
    const res = await gather(jobId);
    if (res.ok && res.data.runId) heard(res.data.runId);
    return res.ok ? { text: findingsText(withTested(res.data, res.data.runId), page), data: res.data } : failed(res);
  };

  const dispute = async ({ findingId, why, question, jobId }) => {
    const res = await call("POST", "/mcp/dispute", { findingId, why, ...(question ? { question } : {}), ...(jobId ? { jobId } : {}) });
    return res.ok ? { text: res.data.said, data: res.data } : failed(res);
  };

  // A note about Cortad itself, filed where the browser's feedback box files, for the Cortad team to read.
  const feedback = async ({ about, kind, needed, got, tried }) => {
    const res = await call("POST", "/mcp/feedback", { about, kind, needed, ...(got ? { got } : {}), ...(tried ? { tried } : {}) });
    return res.ok ? { text: res.data.said, data: res.data } : failed(res);
  };

  // Cortad's test request to each endpoint not yet answered, from this machine (lib/reach.mjs). The
  // connect command sends it, signed in where it signed a test account in; the server is asked only
  // for the list.
  const reach = async ({ paths } = {}) => {
    const here = runner();
    if (here?.state === "up" && here.reach === "ask" && root) return askReach(homeOf(projectOf(root)), paths);
    const res = here?.state === "up" ? await call("GET", "/mcp/status?quiet=1") : null;
    if (res && !res.ok) return failed(res);
    return reachApp({ runner: here, contact: res?.data?.contact, paths, fetchImpl });
  };

  // Connecting the live app is the `intelligence` command, the same text from either face: the steps
  // are this version's, never a server's. `site`: the address people open the app at.
  const fieldConnect = async ({ site } = {}) => {
    const ctx = { root, env: process.env, project: projectOf(root), spec, token: () => (typeof token === "function" ? token() : token), apiBase: api, readStdin: async () => "" };
    const out = await setUp(site ? ["site", site] : [], ctx);
    return out.code ? { text: out.text, isError: true } : { text: out.text };
  };

  // The one door: the agent says what it built or wants tested, and simulated users test it.
  const TEST_USAGE = "Say what to test: test \"<what you built or want tested>\". To record which features the first simulation tests without starting anything: test --features \"POST /api/chat,POST /api/quiz\" (the endpoints as status names them). To let Cortad make one test account on the app's own sign-up: test --account make. To cap a simulation: test --conversations 10 \"<sentence>\".\nNothing ran.\nnext: status";
  const test = async ({ ask, conversations, features, account, help } = {}) => {
    // Nothing to test and nothing to record is a question, never a run.
    if (help || (!ask && !(Array.isArray(features) && features.length) && account !== "make")) return { text: TEST_USAGE, isError: true, code: "no_ask" };
    const why = "This is tested by simulated users talking to the app on this machine.";
    const ran = await run({ conversations, features, account, asked: Boolean(ask) });
    return { ...ran, text: ask ? `${why}\n${ran.text}` : ran.text };
  };

  const field = async ({ days } = {}) => {
    const res = await call("GET", `/mcp/field${days ? `?days=${Number(days)}` : ""}`);
    return res.ok ? { text: fieldText(res.data), data: res.data } : failed(res);
  };

  // The Intelligence Layer: the board in numbers, what is wrong, what counts as an outcome, a
  // subscription to incidents, and a question to the warehouse.
  const intelligence = async ({ days } = {}) => {
    const res = await call("GET", `/mcp/intelligence${days ? `?days=${Number(days)}` : ""}`);
    return res.ok ? { text: intelligenceText(res.data), data: res.data } : failed(res);
  };
  const incidents = async () => {
    const res = await call("GET", "/mcp/incidents");
    return res.ok ? { text: incidentsText(res.data), data: res.data } : failed(res);
  };
  const outcomes = async ({ proposals } = {}) => {
    const res = proposals ? await call("POST", "/mcp/outcomes", { proposals }) : await call("GET", "/mcp/outcomes");
    return res.ok ? { text: outcomesText(res.data), data: res.data } : failed(res);
  };
  const subscribe = async ({ url }) => {
    const res = await call("POST", "/mcp/subscribe", { url });
    return res.ok ? { text: `Subscribed. ${res.data.said}
Secret, shown once: ${res.data.secret}`, data: res.data } : failed(res);
  };
  // The people using the live app, for the agent: the map of tables, a ready answer, or its own ask.
  // The answer is the server's JSON as it came, which an agent reads better than any table drawn here.
  const users = async (body) => {
    const res = await call("POST", "/mcp/users", body);
    return res.ok ? { text: JSON.stringify(res.data), data: res.data } : failed(res);
  };
  // How the app behaved with its users at one point, one persona of it, two points against each
  // other, or the log of every point (the server's agent-behavior/read.ts).
  const behavior = async ({ at, persona, against, history } = {}) => {
    const q = new URLSearchParams({ ...(at ? { at: String(at) } : {}), ...(persona ? { persona: String(persona) } : {}), ...(against ? { against: String(against) } : {}), ...(history ? { history: "1" } : {}) }).toString();
    const res = await call("GET", `/mcp/behavior${q ? `?${q}` : ""}`);
    if (!res.ok) { const out = failed(res); return { ...out, text: `${out.text}\nnext: behavior with history: true lists every point there is` }; }
    const d = res.data;
    return { text: d.history ? historyText(d) : d.against ? againstText(d) : behaviorText(d), data: d };
  };
  // Conversations found by what they mean, across simulations and production.
  const search = async ({ query: asked, where, persona, limit } = {}) => {
    if (typeof asked !== "string" || !asked.trim()) return { text: "Say what to look for: search with query, in words, such as \"students asking for a past exam paper\".\nnext: search", isError: true, code: "no_query" };
    const body = { query: asked.trim().slice(0, 500), ...(where ? { where: String(where) } : {}), ...(persona ? { persona: String(persona).slice(0, 200) } : {}), ...(Number.isSafeInteger(limit) && limit >= 1 ? { limit: Math.min(limit, 50) } : {}) };
    const res = await call("POST", "/mcp/search", body);
    return res.ok ? { text: searchText(res.data, body.query), data: res.data } : failed(res);
  };
  const query = async (ask) => {
    const res = await call("POST", "/mcp/query", ask);
    return res.ok ? { text: queryText(res.data), data: res.data } : { text: queryText(res.data ?? { error: res.text }), data: res.data };
  };

  // `status --changed`: the files Cortad cites that changed since the latest run started, with the
  // findings at them. Empty when there is nothing to say, or nothing could be asked. The code review's
  // files are those of the review shown: the read's misses, or the lines Cortad's team's review cites.
  const changed = async () => {
    const [s, f] = await Promise.all([call("GET", "/mcp/status?quiet=1"), gather()]);
    const r = s.ok ? s.data?.run : null;
    if (!r) return { text: "" };
    const kept = pending.read();
    const since = r.startedAt ?? (kept?.jobId === r.jobId ? kept.startedAt : null);
    const lines = f.ok ? linesOf(f.data) : [];
    const read = s.data.read ?? {};
    const paths = [
      ...lines.map((l) => l.path),
      ...(read.rules?.examples ?? []).map((e) => e.path),
      ...(read.machine?.misses ?? read.machine?.cited ?? []).map((m) => m.path),
      ...(Array.isArray(read.rules?.files) ? read.rules.files : []),
    ].filter((p) => typeof p === "string" && p);
    return { text: changedLine({ root, since, runId: r.jobId, paths, lines }) };
  };

  // `post` and `changed` serve lib/cli.mjs; the MCP answers only the names in TOOLS.
  return { status, reach, run, simulation_status: runStatus, run_status: runStatus, wait, findings, verify, dispute, feedback, field_connect: fieldConnect, field, test, connect: fieldConnect, intelligence, incidents, outcomes, subscribe, query, users, behavior, search, post, changed };
}

// The server refuses a simulation with no cap once the month's are used (POST /mcp/run): said from
// the plan status carries, before an app is started for a simulation that cannot play. A capped one
// spends conversations, and a plan with no count of simulations is held to fair use; both are the
// server's to refuse.
const spentOf = (args, d) => {
  const runs = d.plan?.runs;
  if (args.conversations !== undefined || runs?.left !== 0) return null;
  return { unit: "sweeps", used: runs.used, allowed: runs.allowed, plan: d.plan, plans: d.plan.next ? [d.plan.next] : [], checkout: d.links?.checkout };
};

const sizeOf = (path) => { try { return statSync(path).size; } catch { return 0; } };

// A run whose replies failed, or with a fault on the app's side, is one whose app output is worth reading.
const appFailed = (run) => Boolean(run?.failedReplies?.rows?.length || run?.replies?.crashed > 0 || (run?.faults ?? []).some((f) => f.side === "theirs"));

// Only paths inside the repository are looked at; a path from the server never reaches outside it.
// A line said after a result sits above the next step, never after it.
const withBack = (text, back) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("next:"));
  return at < 0 ? `${text}\n${back}` : [...lines.slice(0, at), back, ...lines.slice(at)].join("\n");
};

export function changedLine({ root, since, runId, paths, lines }) {
  const t = Date.parse(since ?? "");
  if (!Number.isFinite(t)) return "";
  const base = realpathSync(root);
  const changedFiles = [...new Set(paths)].filter((rel) => {
    const abs = resolvePath(base, rel);
    if (!abs.startsWith(base + sep)) return false;
    try { return statSync(abs).mtimeMs > t; } catch { return false; }
  });
  if (!changedFiles.length) return "";
  const at = (rel) => lines.filter((l) => l.path === rel).flatMap((l) => l.findingIds);
  return `Changed since simulation ${runId}: ${changedFiles.map((rel) => (at(rel).length ? `${rel} (${at(rel).join(", ")})` : rel)).join(", ")}.`;
}
