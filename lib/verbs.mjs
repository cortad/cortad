import { realpathSync, statSync } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";
import { machineText, SHOW, showText } from "./read-text.mjs";
import { numbersText } from "./numbers-text.mjs";
import { askReach } from "./auto-reach.mjs";
import { homeOf, projectOf } from "./home.mjs";
import { intelligence as setUp } from "./intelligence.mjs";
import { reach as reachApp } from "./reach.mjs";
import { fieldText, findingsText, finished, linesOf, notStartedText, refusedText, restartedText, runText, STARTING, startedText, statusText, testedLine, upWaitingText, waitingText } from "./text.mjs";
import { incidentsText, intelligenceText, outcomesText, queryText } from "./intel-text.mjs";
import { againstText, behaviorText, historyText, searchText } from "./behavior-text.mjs";
import { askedText } from "./setup-live-text.mjs";

const NOT_CONNECTED = "This folder is not connected to Cortad. Run npx cortad in this folder as a background command: it prints a link for the person to approve in a browser where they are signed in to Cortad.";
const HOLD_S = 45;

const WAIT_POLL_MS = 10_000;
const GONE_MS = 60_000;
const IDLE_MS = 6 * 3600_000;

export const READY_MS = 240_000;

const MOST_CHANGED = 2000;

export const cappedAt = (n) => (Number.isSafeInteger(n) && n >= 1 ? { conversations: n } : {});

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

  const failed = (res) => {
    const text = res.data?.why ?? res.data?.error ?? `Cortad answered ${res.status}.`;
    const code = res.status ? `http_${res.status}` : text === NOT_CONNECTED ? "not_connected" : "unreachable";
    return { text, data: res.data, isError: true, code, why: text };
  };
  const iso = () => new Date(now()).toISOString();
  const heard = (id) => { try { seen(String(id)); } catch {  } };

  const logSaid = (failing) => (failing && appLog && sizeOf(appLog) > 0 ? `Your app's whole output from this session is in ${appLog}.` : "");
  const withTested = (d, id) => {
    const kept = pending.read();
    return kept?.tested && kept.jobId === id ? { ...d, tested: kept.tested } : d;
  };

  const status = async ({ show, page } = {}) => {

    if (show === "machine") return { text: machineText(runner()?.machine ?? null).join("\n") };
    const section = SHOW.includes(show) ? show : null;

    const hold = section === "reviews" ? 45 : 0;
    const res = await call("GET", `/mcp/status${section ? `?show=${section}&quiet=1${hold ? `&wait=${hold}` : ""}` : "?news=1"}`, undefined, hold ? (hold + 13) * 1000 : undefined);
    if (!res.ok) return failed(res);

    if (finished(res.data?.run) && res.data.run.jobId) heard(res.data.run.jobId);
    const here = runner();
    const data = here ? { ...res.data, runner: here } : res.data;
    const log = section ? "" : logSaid(appFailed(data.run) || (data.contact?.proven ?? []).some((v) => v.problems?.length));
    const text = section ? showText(data, section, page) : statusText(data);
    return { text: log ? withBack(text, log) : text, data };
  };

  const changeOf = async (seen) => {
    const base = (seen ?? (await call("GET", "/mcp/status?quiet=1")).data)?.baseline;
    const files = base?.jobId ? code?.saved?.(base.startedAt) : null;
    return files && files.length <= MOST_CHANGED ? { since: base.jobId, files } : null;
  };

  const post = async (args, kind, restarted = [], seen = null) => {
    const tested = code?.tested() ?? null;
    const change = kind === "run" ? await changeOf(seen) : null;
    const res = await call("POST", "/mcp/run", change ? { ...args, change } : args, (HOLD_S + 13) * 1000);
    if (res.status === 202 || (res.ok && res.data?.joined)) {
      const mine = res.status === 202 ? tested : null;
      pending.write({ jobId: res.data.jobId, kind: res.data.kind ?? kind, startedAt: iso(), ...(mine ? { tested: mine } : {}) });
      try { writes?.mark(res.data.jobId); } catch {  }
      const said = [restarted.length ? restartedText(restarted) : "", mine?.stale ? testedLine(mine) : ""];
      return { text: startedText(res.data, kind, args.findingId, said), data: res.data };
    }
    if (res.status === 402) return { text: refusedText(res.data), data: res.data, isError: true, code: "plan_spent" };
    if (res.status === 409) return { text: `${res.data?.why ?? "The simulation could not start."}\nNothing ran.`, data: res.data, isError: true, code: "run_refused" };
    return failed(res);
  };

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
    pending.write({ kind, startedAt: iso(), after: before.data.run?.jobId ?? null });
    const began = await startApp(args, kind);
    if (!began.ok) {
      pending.write({ kind, startedAt: iso(), error: began.why });
      return { text: began.why, isError: true, code: "app_not_started" };
    }
    return { text: here?.state === "up" ? upWaitingText(here, before.data.app) : STARTING, data: { pending: true } };
  };

  const run = async ({ conversations, features, account, asked = false } = {}) => {
    const chosen = Array.isArray(features) && features.length ? features.map(String).slice(0, 100) : null;
    const make = account === "make";
    if ((chosen || make) && !asked && conversations === undefined) {
      const res = await call("POST", "/mcp/run", { ...(chosen ? { features: chosen } : {}), ...(make ? { account: "make" } : {}), record: true });
      if (res.ok && res.data?.recorded) return { text: `${res.data.note}\nnext: status`, data: res.data };
      if (!res.ok) return failed(res);
    }
    return start({ ...cappedAt(conversations), ...(chosen ? { features: chosen } : {}) }, "run");
  };
  const verify = ({ findingId, jobId } = {}) => start({ findingId, ...(jobId ? { jobId } : {}) }, "verify");

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
    if (p.error) return { text: `${p.error}\nnext: status`, isError: true, code: "app_not_started" };
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

      const said = res.status === 0 ? `${out.text} The simulation goes on without this call; nothing was lost or charged by it.` : out.text;
      return { ...out, text: `${said}\nnext: run_status ${id}` };
    }

    return { text: shown(res.data, id), data: res.data, ...(res.data?.dissection ? { structured: res.data.dissection } : {}) };
  };

  const shown = (d, id) => {

    let back = "";
    if (writes && finished(d)) { try { back = writes.putBack(); } catch { back = ""; } }

    if (finished(d)) { heard(id); if (d?.jobId && d.jobId !== id) heard(d.jobId); }
    return [logSaid(appFailed(d)), back].filter(Boolean).reduce(withBack, runText(withTested(d, id)));
  };

  const sinceConnect = (r) => {
    const connected = Date.parse(runner()?.startedAt ?? "");
    return !Number.isFinite(connected) || Date.parse(r.startedAt ?? "") >= connected;
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

      if ([401, 403, 404].includes(res.status)) return failed(res);

      if (res.ok && res.data?.setupAsk) {
        const took = await call("POST", "/mcp/setup/live/take");
        if (took.ok && took.data?.taken) return { text: askedText(took.data, spec, origin), data: took.data };
        if (!took.ok) await sleep(WAIT_POLL_MS);
        continue;
      }
      if (res.ok && id && finished(res.data)) {
        const text = shown(res.data, id).replace(/\nnext: [^\n]*$/, "");

        return { text: `${text}\nnext: ${res.data.verify ? `run_status ${id}` : `behavior ${res.data.jobId ?? id}`}`, data: res.data };
      }
      const r = res.ok && !id ? res.data?.run : null;

      if (r?.jobId && (!finished(r) || (!wasRead(r.jobId) && sinceConnect(r)))) { id = r.jobId; continue; }

      if (!id || !res.ok) await sleep(WAIT_POLL_MS);
    }
  };

  const gather = async (jobId) => {
    const path = (page, id) => {
      const q = new URLSearchParams({ ...(id ? { jobId: id } : {}), ...(page > 1 ? { page: String(page) } : {}) }).toString();
      return `/mcp/findings${q ? `?${q}` : ""}`;
    };
    const first = await call("GET", path(1, jobId));
    if (!first.ok) return first;
    const d = first.data;

    const rest = await Promise.all(Array.from({ length: Math.max(0, Math.min(d.pages ?? 1, 20) - 1) }, (_, i) => call("GET", path(i + 2, d.runId ?? jobId))));
    for (const more of rest) {
      if (!more.ok) return more;
      d.findings = [...(d.findings ?? []), ...(more.data.findings ?? [])];

      for (const g of more.data.byLine ?? []) {
        const held = (d.byLine ?? []).find((h) => h.path === g.path && h.line === g.line);
        if (held) held.findingIds = [...new Set([...held.findingIds, ...g.findingIds])];
        else d.byLine = [...(d.byLine ?? []), g];
      }
    }
    return first;
  };

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

  const feedback = async ({ about, kind, needed, got, tried }) => {
    const res = await call("POST", "/mcp/feedback", { about, kind, needed, ...(got ? { got } : {}), ...(tried ? { tried } : {}) });
    return res.ok ? { text: res.data.said, data: res.data } : failed(res);
  };

  const reach = async ({ paths } = {}) => {
    const here = runner();
    if (here?.state === "up" && here.reach === "ask" && root) return askReach(homeOf(projectOf(root)), paths);
    const res = here?.state === "up" ? await call("GET", "/mcp/status?quiet=1") : null;
    if (res && !res.ok) return failed(res);
    return reachApp({ runner: here, contact: res?.data?.contact, paths, fetchImpl });
  };

  const fieldConnect = async ({ site } = {}) => {
    const ctx = { root, env: process.env, project: projectOf(root), spec, token: () => (typeof token === "function" ? token() : token), apiBase: api, readStdin: async () => "" };
    const out = await setUp(site ? ["site", site] : [], ctx);
    return out.code ? { text: out.text, isError: true } : { text: out.text };
  };

  const world = async ({ ask } = {}) => {
    const res = await call("POST", "/mcp/world", ask ? { ask: String(ask) } : {});
    if (!res.ok) return failed(res);
    if (res.data?.joined) return { text: `A world is already being tested: ${res.data.jobId}.\nnext: world_status ${res.data.jobId}`, data: res.data };
    if (!res.data?.started) return { text: `${res.data?.why ?? "No world started."}\nNothing ran.`, data: res.data, isError: true, code: "world_refused" };
    const planted = Array.isArray(res.data.situations) && res.data.situations.length ? `Planted: ${res.data.situations.join("; ")}.` : `${res.data.worlds ?? ""} worlds.`;
    return { text: `World started: ${res.data.jobId}. ${planted} Each is tested ${res.data.repeats} times. The person sees it at ${res.data.url}\nnext: world_status ${res.data.jobId}`, data: res.data };
  };

  const TEST_USAGE = "Say what to test: test \"<what you built or want tested>\". To record which features the first simulation tests without starting anything: test --features \"POST /api/chat,POST /api/quiz\" (the endpoints as status names them). To let Cortad make one test account on the app's own sign-up: test --account make. To cap a simulation: test --conversations 10 \"<sentence>\".\nNothing ran.\nnext: status";
  const test = async ({ ask, conversations, features, account, help } = {}) => {

    if (help || (!ask && !(Array.isArray(features) && features.length) && account !== "make")) return { text: TEST_USAGE, isError: true, code: "no_ask" };
    const res = await call("POST", "/mcp/world", { ...(ask ? { ask: String(ask) } : {}), only: "matched" });
    if (res.ok && res.data?.started) return { text: `This is tested in a world. World started: ${res.data.jobId}. Planted: ${(res.data.situations ?? []).join("; ")}. Each is tested ${res.data.repeats} times. The person sees it at ${res.data.url}\nnext: world_status ${res.data.jobId}`, data: res.data };
    if (res.ok && res.data?.joined) return { text: `A world is already being tested: ${res.data.jobId}.\nnext: world_status ${res.data.jobId}`, data: res.data };

    const why = "This is tested by simulated users talking to the app on this machine.";
    const ran = await run({ conversations, features, account, asked: Boolean(ask) });
    return { ...ran, text: ask ? `${why}\n${ran.text}` : ran.text };
  };
  const worldStatus = async ({ jobId } = {}) => {
    if (!jobId) return { text: "Name the world: world_status <id>.", isError: true, code: "no_id" };
    const res = await call("GET", `/mcp/world/${encodeURIComponent(String(jobId))}`);
    if (!res.ok) return failed(res);
    const running = res.data.status === "queued" || res.data.status === "running";
    return { text: `${res.data.text}\nThe person sees this at ${res.data.url}\nnext: ${running ? `world_status ${jobId}` : "status"}`, data: res.data };
  };

  const field = async ({ days } = {}) => {
    const res = await call("GET", `/mcp/field${days ? `?days=${Number(days)}` : ""}`);
    return res.ok ? { text: fieldText(res.data), data: res.data } : failed(res);
  };

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

  const users = async (body) => {
    const res = await call("POST", "/mcp/users", body);
    return res.ok ? { text: JSON.stringify(res.data), data: res.data } : failed(res);
  };

  const behavior = async ({ at, persona, against, history } = {}) => {
    const q = new URLSearchParams({ ...(at ? { at: String(at) } : {}), ...(persona ? { persona: String(persona) } : {}), ...(against ? { against: String(against) } : {}), ...(history ? { history: "1" } : {}) }).toString();
    const res = await call("GET", `/mcp/behavior${q ? `?${q}` : ""}`);
    if (!res.ok) { const out = failed(res); return { ...out, text: `${out.text}\nnext: behavior with history: true lists every point there is` }; }
    const d = res.data;
    return { text: d.history ? historyText(d) : d.against ? againstText(d) : behaviorText(d), data: d };
  };

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

  return { status, reach, run, run_status: runStatus, wait, findings, verify, dispute, feedback, field_connect: fieldConnect, field, world, world_status: worldStatus, test, connect: fieldConnect, intelligence, incidents, outcomes, subscribe, query, users, behavior, search, post, changed };
}

const sizeOf = (path) => { try { return statSync(path).size; } catch { return 0; } };

const appFailed = (run) => Boolean(run?.failedReplies?.rows?.length || run?.replies?.crashed > 0 || (run?.faults ?? []).some((f) => f.side === "theirs"));

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
