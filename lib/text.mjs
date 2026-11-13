import { ASK, ASK_NEXT, choosing, contactLines, sendAskedOnce } from "./contact-text.mjs";
import { costSaid, dissectionLines, neverRanOf, unseenOf, verifyOnceAPage } from "./dissection-text.mjs";
import { failedLines, heldLines } from "./failed-text.mjs";
import { readLines } from "./read-text.mjs";
import { at, clip, has, modelSaid, num, PAGE_CHARS, pageOf, plural, pressedLine, SIDE, upper } from "./words.mjs";

const DONE = new Set(["succeeded", "failed", "canceled"]);
const UNIT = { sweeps: ["simulation", "simulations"], runs: ["simulation", "simulations"], trials: ["verify conversation", "verify conversations"] };
export const STARTING = "Starting your app for the simulation. Call simulation_status; it answers as soon as the simulation has an id.";

export const notStartedText = (r) => [upper(r.error), r.said ? `Its last lines:\n${r.said}` : null, "Nothing ran."].filter(Boolean).join("\n");

const doorsSaid = (r, app) => (app && app.state !== "ready-to-test" && app.port === r.port && app.said) || null;
export const answeringText = (r, app) => doorsSaid(r, app) ?? `Your app answers on port ${r.port}.`;
export const upWaitingText = (r, app) => `${answeringText(r, app)}\nCall simulation_status; it answers as soon as the simulation has an id.`;

const units = (n, unit) => { const [one, many] = UNIT[unit] ?? [unit, unit]; return `${num(n)} ${n === 1 ? one : many}`; };
const kn = (x) => (has(x?.k) ? `${num(x.k)} of ${num(x.n)}` : num(x));

export const finished = (run) => Boolean(run) && (run.finished ?? DONE.has(run.status));

export const newsLines = (d) => (d.news?.length ? ["New since your last call:", ...d.news.map((n) => `  ${n}`)] : []);

export const waitNext = (spec) => `next: start \`npx -y ${spec} wait\` in the background now (in Claude Code, Bash with run_in_background); it returns when a simulation or verify ends, including one the person starts with Start simulation, or with the person's choice on the setup card`;

export function statusText(status, { spec = "cortad" } = {}) {
  const d = sendAskedOnce(status);
  const ask = choosing(d);
  const lines = ask ? [ASK] : [];
  if (d.repository?.name) lines.push(`Repository: ${d.repository.name}.`);
  lines.push(...newsLines(d));
  const plan = planLine(d.plan);
  if (plan) lines.push(plan);
  const receipts = receiptsSaid(d.runner?.receipts, d.contact);
  lines.push(...appLines(d, receipts));
  lines.push(...contactLines(d.contact, d.app?.data, receipts, d.features));

  if (d.read?.complete === false) lines.push("Cortad is still studying your AI.");
  else if (d.read) lines.push(...readLines(d.read));
  if (d.run) lines.push(...runLines(d.run, "latest "));

  const since = (d.read?.trials?.written ?? 0) - (d.run?.trials?.written ?? Infinity);
  if (since > 0 && d.run?.kind !== "verify") lines.push(`${plural(since, "more conversation")} written since this simulation; the next simulation chooses from them too.`);

  if (d.field && d.run) lines.push(`Production: ${d.field.connected ? "connected" : "not connected"}.`);
  if (d.next) lines.push(d.next);
  if (d.links?.lab && (d.read || d.run)) lines.push(`The person sees this at ${d.links.lab}`);
  if (d.run && !finished(d.run)) lines.push(`next: simulation_status ${d.run.jobId}`);
  else if (ask) lines.push(ASK_NEXT);
  else if (d.run?.jobId && !d.run.verify && d.run.findings > 0) lines.push(`next: behavior ${d.run.jobId}`);
  else lines.push(waitNext(spec));
  return lines.join("\n");
}

export const unseenText = (door) => `A request to ${door} was answered in words and no model call came through the proxy. If that endpoint uses a model, your app's model calls do not go through OPENAI_BASE_URL (or ANTHROPIC_BASE_URL or GOOGLE_GEMINI_BASE_URL): have it take its model's address from that setting, then save.`;

export const receiptText = (door, followed) => (followed
  ? `${door} answered your request at once, with no model call inside it; a model call came after it, but its prompt carried none of the words your request sent, so Cortad cannot tell it was this request's answer. A simulation leaves this endpoint out.`
  : `${door} answered your request at once with no model call inside it, and no model call followed in any process Cortad started. If a worker in another process writes its answer, Cortad does not see that worker, so a simulation leaves this endpoint out for now. If this endpoint has no AI behind it, nothing is missing.`);

const receiptsSaid = (receipts = [], c) => {
  const proven = new Set((c?.proven ?? []).map((v) => v.door));
  const unreached = new Set((c?.notCalled ?? []).map((m) => `${m.method} ${m.path}`));
  return receipts.filter((x) => unreached.has(x.door) && !proven.has(x.door));
};

const proxiedLine = (r) => `Model calls are seen through a local proxy, so the line of code that made each call is not known. Send requests to port ${r.port}; requests sent straight to your app on port ${r.proxied} are not seen.${r.unseen ? ` ${unseenText(r.unseen)}` : ""}`;

function appLines(d, receipts) {
  const r = d.runner;
  if (!r) return d.app?.said ? [`App: ${d.app.said}`] : [];
  if (r.state === "up") return [`App: ${doorsSaid(r, d.app) ?? `answering on port ${r.port}.`}`, ...(r.proxied ? [proxiedLine(r)] : []), ...receipts.map((x) => receiptText(x.door, x.followed))];
  return [r.state === "failed" ? `App: ${r.error}` : "App: starting."];
}

export function planLine(p) {
  if (!p?.name) return null;
  const parts = [];
  if (has(p.runsLeft) && has(p.runsAllowed)) parts.push(runsSaid(p.runsLeft, p.runsAllowed));
  if (has(p.verifyTrialsLeft)) parts.push(`${plural(p.verifyTrialsLeft, "verify conversation")} left`);
  const head = parts.length ? `${p.name}: ${parts.join("; ")}.` : `Plan: ${p.name}.`;
  const n = p.next;
  return n ? `${head} ${n.name} $${num(n.monthlyUsd)} a month: simulations and reruns included, ${num(n.productionReplies)} production replies analyzed.` : head;
}

const runsSaid = (left, allowed) => (left > 0 ? `${num(left)} of ${plural(allowed, "simulation")} left this month`
  : allowed === 1 ? "this month's 1 simulation is used" : `all ${plural(allowed, "simulation")} of this month are used`);

function evalLines(evals) {
  const t = evals?.total;
  if (!t || (!t.played && !t.open)) return [];
  const open = (x) => (x.open ? `${x.played ? ", and " : ""}${num(x.open)} more ${x.open === 1 ? "question it asks" : "questions it asks"} with no answer of its own, checked against your rules` : "");
  const said = (x) => (x.played
    ? `${num(x.passed)} of ${plural(x.played, "case")} passed${x.failed ? `, ${num(x.failed)} failed` : ""}${x.unclear ? `, ${num(x.unclear)} not settled` : ""}${x.cases > x.played ? `, ${num(x.cases - x.played)} not played` : ""}${open(x)}`
    : `${num(x.open)} ${x.open === 1 ? "question" : "questions"} played, checked against your rules, since the ${x.open === 1 ? "file expects no answer of its own" : "files expect no answers of their own"}`);
  const left = Object.entries(evals.left ?? {}).sort((a, b) => b[1] - a[1]);
  return [
    `Your own eval files: ${said(t)}.`,
    ...(evals.files ?? []).slice(0, 12).map((f) => `  ${f.file}: ${said(f)}.`),
    ...left.map(([why, n]) => `  ${num(n)} ${n === 1 ? "case" : "cases"} of yours was left out: ${why}.`.replace("cases of yours was", "cases of yours were")),
  ];
}

function measuredLines(d) {
  const lines = [...promiseLines(d.promises), ...evalLines(d.evals), ...failedLines(d.failedReplies)];

  const of = has(d.questionsAsked) && has(d.questionsOf) && d.questionsOf > 0;
  if (of) lines.push(`Cortad could check ${num(d.questionsAsked)} of its ${num(d.questionsOf)} questions.`);

  const groups = d.dissection ? [] : (d.notMeasured?.groups ?? []).filter((g) => g.count > 0 && g.said);
  if (groups.length) lines.push(`${plural(d.notMeasured.total, "question")} with no reply to check: ${groups.map((g) => clip(g.said, 240)).join("; ")}.`);

  if (!d.failedReplies && d.replies?.crashed > 0) lines.push(`${num(d.replies.crashed)} of ${plural(d.replies.total, "reply", "replies")} were failures and are not counted.`);

  if (d.promises && !d.promises.said && has(d.promises.decided)) lines.push(promiseLine(d));

  if (d.sensitivity?.said) lines.push(clip(d.sensitivity.said, 400));
  return lines;
}

function promiseLines(p) {
  if (!p?.said) return [];

  const told = (m) => (m.failed ? `failed in ${num(m.failed)} of ${plural(m.of, "conversation")}` : m.of === 1 ? "held in the one conversation that tested it" : `held in all ${num(m.of)} conversations that tested it`);
  return [p.said, ...(p.measured ?? []).map((m) => `  "${clip(m.words, 200)}"${m.at ? ` (${m.at})` : ""}: ${told(m)}.`)];
}

const promiseLine = (d) => `${upper(`${num(d.promises.held)} of the ${plural(d.promises.decided, "conversation")}`)} tested against your app's own rules broke none.`;

const haltLine = (h) => `${h.side === "ours" ? "Cortad stopped the simulation" : "Your app stopped answering"} after ${plural(h.after, "reply", "replies")}${h.why ? `: ${clip(h.why, 240)}` : ""}. The numbers cover the replies before that.`;

const waitLines = (d) => [d.pace?.said, d.kind === "verify" ? null : d.waited?.said].filter(Boolean);
const LAYER_WORDS = {
  retrieval: "what the store returned behind the reply, not how the reply was written",
  tools: "the tool call behind the reply",
  memory: "what the app kept between turns",
  application: "an error in the app around the model",
  instructions: "the model against its own instructions",
  upsell: "what the reply offered beyond the ask",
};

function runLines(d, prefix = "") {
  const done = finished(d);
  const played = d.of ? `${num(d.played ?? 0)} of ${plural(d.of, "conversation")} played` : "no conversation played yet";

  const state = d.status === "failed" || d.status === "canceled" ? d.status : done ? "finished" : d.status && d.status !== "succeeded" ? d.status : "running";
  const lines = [`${upper(`${prefix}${d.kind === "verify" ? "verify" : "simulation"}`)} ${d.jobId}: ${state}, ${played}.`];

  if (d.simulation?.said) lines.push(d.simulation.said);
  if (!done && pressedLine(d)) lines.push(pressedLine(d));
  if (d.tested) lines.push(testedLine(d.tested));

  if (d.scope && !d.dissection?.change) lines.push(d.scope);

  lines.push(...(d.first ?? []));

  if (!done && d.now?.doing) lines.push(d.now.doing);
  lines.push(...waitLines(d));

  lines.push(...(d.recordedValues ?? []));

  if (done && d.kind !== "verify" && d.dissection) {
    lines.push(...dissectionLines(d.dissection));
    if (has(d.findings)) lines.push(findingsCount(d.findings, false));
    lines.push(...measuredLines(d));
  } else if (done && d.kind !== "verify") {
    if (d.top) lines.push("Top finding:", findingBlock(d.top, unseenOf(d.tools)));
    if (has(d.findings)) lines.push(findingsCount(d.findings, Boolean(d.top)));
    if (d.model) lines.push(`Your app answered on ${modelSaid(d.model)}, as its own model calls show.`);
    const cost = costSaid(d);
    if (cost) lines.push(cost);
    lines.push(...measuredLines(d));
  }
  if (done && d.blocked) lines.push(d.blocked);
  if (done && d.notCounted) lines.push(d.notCounted);
  if (done && d.halted) lines.push(haltLine(d.halted));
  const trials = trialsLine(d);
  if (trials) lines.push(trials);

  if (!(done && (d.failedReplies || d.dissection))) lines.push(...heldLines(d.heldBack));
  if (d.stopped) lines.push(stoppedLine(d));

  for (const f of d.faults ?? []) lines.push(f.fix ? `Fault${SIDE[f.side] ? ` ${SIDE[f.side]}` : ""}: ${f.what} ${f.fix}` : f.what);
  for (const s of d.data ?? []) lines.push(`Data: ${s}`);

  if (d.error && !(d.stopped && d.error.startsWith(d.stopped.why))) lines.push(d.status === "failed" && !d.stopped ? `The simulation stopped before it finished: ${d.error}. Start another simulation.` : `Error: ${d.error}`);
  if (d.verify) lines.push(...verifyLines(d.verify));
  return lines;
}

const findingsCount = (n, shown) => `${shown ? `${plural(n, "finding")} in all` : plural(n, "finding")}.`;

function trialsLine(d) {
  const t = d.trials;

  if (!t || !has(t.written) || d.kind === "verify") return null;
  const parts = [`${num(t.chosen)} chosen for this simulation`, t.heldBack && `${num(t.heldBack)} set aside`, t.notPlanned && `${num(t.notPlanned)} not chosen this time`].filter(Boolean);
  const rest = t.notPlayed ? `; ${num(t.played)} played, ${num(t.notPlayed)} ${finished(d) ? "not played" : "still to play"}` : "";
  return `Conversations: ${num(t.written)} written: ${parts.join(", ")}${rest}.`;
}

function stoppedLine(d) {
  const s = d.stopped;

  const turn = s.after > 0 && !s.first ? ` after ${plural(s.after, "reply", "replies")}` : "";
  const why = String(s.why).replace(/\.$/, "");
  const fix = s.fix ? ` ${s.fix}` : "";
  if (d.of && d.played < d.of) return `Stopped at ${num(d.played)} of ${plural(d.of, "conversation")}${SIDE[s.side] ? `, ${SIDE[s.side]}` : ""}: ${why}${turn}.${fix}`;
  return `${upper(why)}${turn}${SIDE[s.side] ? `, ${SIDE[s.side]}` : ""}.${fix}`;
}

function verifyLines(v) {

  if (v.access) {
    const lines = [`Verify of ${v.findingId}.`];
    for (const r of v.routes ?? []) {

      const open = (status, when) => (status >= 200 && status < 300 ? `${when === "then" ? "answered" : "now answers"} ${status} with no sign-in` : `${when === "then" ? "reached its own checks" : "now reaches its own checks"} with no sign-in (HTTP ${status})`);
      const then = r.wasOpen ? open(r.before, "then") : `refused (${r.before})`;
      const now =
        r.state === "answered" ? (r.nowOpen ? open(r.after, "now") : `now refuses (${r.after})`)
        : r.state === "gone" ? "your app no longer has this route"
        : r.state === "no-answer" ? "your app did not answer this time"
        : "was not sent again";
      lines.push(`  ${r.method} ${r.route}: ${then}, ${now}.`);
    }
    if (v.said) lines.push(v.said);
    return lines;
  }
  return [`Verify of ${v.findingId}${v.file ? ` at ${at(v.file, v.line)}` : ""}.`, ...(v.said ? [v.said] : [])];
}

export function nextCall(d) {
  if (!finished(d)) return `simulation_status ${d.jobId}`;
  return d.kind === "verify" || d.status === "failed" || d.status === "canceled" ? "status" : `behavior ${d.jobId}`;
}

export function progressLine(d, now = Date.now()) {
  if (!d.of) return "The simulation has started. No conversation has played yet.";
  const parts = [`${num(d.played ?? 0)} of ${plural(d.of, "conversation")} done.`];
  const total = d.replies?.total ?? d.waited?.of;
  const crashed = d.replies?.crashed ?? 0;
  const ours = d.replies?.ours ?? d.waited?.replies ?? 0;
  const refused = d.replies?.refused ?? 0;
  if (total > 0 && !crashed && !ours && !refused) parts.push("No reply has failed so far.");
  if (total > 0 && crashed) parts.push(`${num(crashed)} of ${plural(total, "reply", "replies")} so far were errors from your app.`);
  if (total > 0 && refused) parts.push(`${num(refused)} of ${plural(total, "reply", "replies")} so far were refused by your app.`);
  if (total > 0 && ours) parts.push(`${num(ours)} of ${plural(total, "reply", "replies")} so far never came back to Cortad and are not counted.`);
  const left = Date.parse(d.pace?.endsAt ?? "") - now;
  if (left > 0) parts.push(`About ${plural(Math.ceil(left / 60_000), "minute")} left at the pace your app has answered so far.`);
  return parts.join(" ");
}

export function runText(d) {
  const lines = runLines(d);

  if (!finished(d) && d.kind !== "verify") lines.push(progressLine(d));
  const plan = finished(d) ? planLine(d.plan) : null;
  if (plan) lines.push(plan);
  const offer = productionOffer(d);
  if (offer) lines.push(offer);
  if (finished(d) && d.url) lines.push(`The report is at ${d.url}`);
  lines.push(`next: ${nextCall(d)}`);
  return verifyOnceAPage(lines.join("\n"));
}

function productionOffer(d) {
  const v = d.verify;
  if (d.kind !== "verify" || !finished(d) || v?.verdict !== "gone" || !["gone", "less often"].includes(v.heldOut?.moved) || d.field?.connected !== false) return null;
  return `The failure in ${v.findingId} is gone on its replays. Connecting production shows what real users are doing as it happens; connect has the steps.`;
}

export function startedText(d, kind, findingId, said = []) {
  const verify = (d.kind ?? kind) === "verify";
  const what = verify ? `Verify${findingId && !d.joined ? ` of ${findingId}` : ""}` : "Simulation";
  return [`${what} ${d.joined ? "already playing" : "started"}: ${d.jobId}.`, pressedLine(d), ...said, d.note, `next: simulation_status ${d.jobId}`].filter(Boolean).join("\n");
}

export const heldRunText = (version, conversations, from) =>
  `The cortad command holding your app up is ${version} and cannot hold a simulation to ${plural(conversations, "conversation")}; ${from} and newer can, so stop that command and run it again.\nNothing ran.`;

export const restartedText = (paths) =>
  `Your app was started again so this simulation plays your change (${plural(paths.length, "file")} changed since it started: ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ", ..." : ""}).`;

const clock = (iso) => new Date(iso).toTimeString().slice(0, 8);
export function testedLine(t) {
  const started = clock(t.startedAt);
  if (t.stale) return `Your app was already running when this command started and has been running since ${started}; ${t.change.path} changed at ${clock(t.change.at)}, so this simulation may have played the old code. Stop your app and run the command again.`;
  if (!t.change) return `App started ${started}.`;
  if (Date.parse(t.change.at) <= Date.parse(t.startedAt)) return `App started ${started}, after your last change at ${clock(t.change.at)}.`;
  return `App started ${started}${t.reloads ? " and reloads itself on save" : ""}; your last change was at ${clock(t.change.at)}.`;
}

export function waitingText(p, now, limitMs, runner, app) {
  const kind = p.kind === "verify" ? "verify" : "simulation";
  const waited = `${num((now - Date.parse(p.startedAt)) / 1000)} of up to ${num(limitMs / 1000)} seconds`;
  const head = runner?.state === "up" ? `${answeringText(runner, app)}\nThe ${kind} has waited ${waited}.` : `Your app is still starting for the ${kind}: ${waited}.`;
  return `${head}\nnext: simulation_status pending`;
}

export function refusedText(d) {
  const lines = [];
  if (has(d.used) && has(d.allowed) && d.unit) lines.push(`Refused: ${num(d.used)} of ${units(d.allowed, d.unit)} used${d.plan?.name ? ` on the ${d.plan.name} plan` : ""}.`);
  else if (d.why) lines.push(`Refused: ${d.why}`);
  if (d.ledger) lines.push(...ledgerLines(d.ledger));
  if (!d.ledger?.plan && d.plans?.length) lines.push(`Plans: ${d.plans.map((p) => `${p.name} $${p.monthlyUsd} a month`).join(", ")}.`);
  lines.push("Nothing ran.");
  if (d.checkout) lines.push(`Plans and checkout are at ${d.checkout}`);
  return lines.join("\n");
}

const KEPT_MOVE = { gone: "the failure is gone on", "less often": "the failure shows less often on", worse: "the fix made the failure worse on" };
function keptSaid(h) {
  if (!h?.before?.trials || !h?.after?.trials) return "";
  const counts = `${num(h.before.failed)} of ${num(h.before.trials)} failed before, ${num(h.after.failed)} of ${num(h.after.trials)} after`;
  return KEPT_MOVE[h.moved] ? `; ${KEPT_MOVE[h.moved]} the conversations saved to test the fix (${counts})` : `; on the conversations saved to test the fix, ${counts}, not beyond chance`;
}

function ledgerLines(l) {
  const lines = [];
  const r = l.lastRun;
  if (r) {
    const parts = [has(r.findings) && plural(r.findings, "finding"), r.of && `${num(r.played ?? 0)} of ${plural(r.of, "conversation")} played`].filter(Boolean);
    lines.push(`Last simulation ${r.jobId}: ${parts.join(", ")}.`);
  }
  if (l.fixed) {
    lines.push(`${plural(l.fixed.length, "fix", "fixes")} verified since that simulation${l.fixed.length ? ":" : "."}`);

    for (const f of l.fixed) lines.push(`  ${f.path ? `${at(f.path, f.line)} (${f.findingId})` : f.findingId}: ${f.verdict}; ${num(f.after.failed)} of ${plural(f.after.replays, "replay")} failed, against ${num(f.before.failed)} of ${num(f.before.trials)} before${keptSaid(f.heldOut)}.`);
  }
  const n = l.nextRun;
  if (n) lines.push(`The next simulation would play ${[plural(n.trials, "conversation"), has(n.heldOut) && `${num(n.heldOut)} saved to test fixes`, has(n.newFromChanges) && `${num(n.newFromChanges)} new from the changes`].filter(Boolean).join(", ")}.`);
  const p = l.plan;
  if (p) lines.push(`The ${p.name} plan, $${p.monthlyUsd} a month${has(p.allowed) ? `, includes ${units(p.allowed, p.unit)}` : ""}.`);
  if (l.field === null) lines.push("Production: not connected.");
  else if (l.field) lines.push(`Production, last ${plural(l.field.days, "day")}: ${plural(l.field.conversations, "conversation")}${has(l.field.brokenRate) ? `, ${Math.round(l.field.brokenRate * 100)}% of them broke a rule` : ""}.`);
  return lines;
}

export function linesOf(d) {
  const rows = (d.byLine ?? (d.findings ?? []).map((f) => ({ path: f.file, line: f.line, findingIds: [f.id] }))).filter((r) => r.path);
  const merged = new Map();
  for (const r of rows) {
    const key = at(r.path, r.line);
    if (merged.has(key)) merged.get(key).findingIds.push(...r.findingIds);
    else merged.set(key, { path: r.path, line: r.line, findingIds: [...r.findingIds] });
  }
  return [...merged.values()];
}

export const findingsText = (d, page = 1) => pageOf(findingsPages(d), page, (n) => `findings with page ${n}`);

function findingsHead(d) {
  if (!d.runId) return d.why ?? "No simulation has finished on this repository yet.";
  const lines = [`Simulation ${d.runId}: ${plural(d.findings?.length ?? 0, "finding")}.`];
  const cost = costSaid(d);
  if (cost) lines.push(cost);
  if (d.tested) lines.push(testedLine(d.tested));
  return lines.join("\n");
}

function findingsTail(d) {
  const lines = measuredLines(d);
  if (d.blocked) lines.push(d.blocked);
  if (d.halted) lines.push(haltLine(d.halted));
  lines.push(...waitLines(d));
  if (d.baseRunId) lines.push(`Compared with simulation ${d.baseRunId}.`);

  for (const s of [d.read, d.heldBack, d.findings?.length || !d.runId ? null : d.why]) if (s) lines.push(s);

  for (const k of d.keptBack ?? []) lines.push(`${k.id}, on conversations saved to test the fix: "${clip(k.asks, 160)}"${k.file ? ` at ${at(k.file, k.line)}` : ""}, ${k.trials ? `failed in ${num(k.trials.failed)} of ${plural(k.trials.of, "conversation")}` : `passed in ${kn(k.rate)}${has(k.reply) ? ` at reply ${num(k.reply)}` : ""}`}${k.quote ? `; the reply said "${clip(k.quote, 120)}"` : ""}. Its inputs are not shown; verify ${k.id} replays them.`);
  return lines.join("\n");
}

function findingsPages(d, budget = PAGE_CHARS - 60) {

  const unseen = unseenOf(d.tools ?? d.dissection?.tools);

  let headed = false;
  const blocks = [...(d.findings ?? []).map((f) => {
    const block = findingBlock(f, unseen);
    if (f.group !== "eval" || headed) return block;
    headed = true;
    return `From your own eval files:\n${block}`;
  }), findingsTail(d)].filter(Boolean);
  const pages = [];
  let page = findingsHead(d);
  let filled = false;
  for (const block of blocks) {
    if (filled && page.length + block.length + 2 > budget) {
      pages.push(page);
      page = `Simulation ${d.runId}, findings continued.`;
    }
    page += `\n\n${block}`;
    filled = true;
  }
  pages.push(page);
  return pages.map(verifyOnceAPage);
}

function findingBlock(f, unseen) {

  if (f.kind === "access-open") {
    const lines = [`${f.id}  ${f.says}`];
    if (f.path) lines.push(`  At ${at(f.path, f.line)}`);
    if (f.standard) lines.push(`  Standard: ${clip(f.standard, 200)}`);
    lines.push(`  Sent: ${f.request.method} ${f.request.path}${f.request.body ? ` ${clip(f.request.body, 200)}` : ""}${f.as === "another-user" ? " as another user" : " with no sign-in"}`);
    lines.push(`  Answered: ${f.status}${has(f.response) && f.response ? `, ${clip(f.response, 400)}` : ""}`);
    lines.push(`  Replay: verify ${f.id}`);
    return lines.join("\n");
  }

  const lines = [`${f.id}  ${f.asks}`, shareLine(f)].filter(Boolean);
  if (f.sentAway?.said) lines.push(`  Of them, ${f.sentAway.said}.`);
  if (f.baseline) lines.push(`  Played again: ${plural(f.baseline.trials, "new conversation")} with the same ask in other words; it failed again in ${num(f.baseline.failed)}.`);

  if (f.cameBack) {
    lines.push(f.cameBack.again === 0
      ? `  Played over again: ${plural(f.cameBack.played, "conversation")} of its own, word for word from nothing, and it did not fail again in any of them. Worth less of your time than one that came back.`
      : `  Played over again: ${plural(f.cameBack.played, "conversation")} of its own, word for word from nothing, and it failed again in ${num(f.cameBack.again)}.`);
  }

  if (f.production) lines.push(`  In production: ${plural(f.production, "conversation")} with real users broke this in the last 30 days.`);
  const logs = { shown: new Set(), room: 30 };
  const [first, ...more] = (f.quotes ?? []).slice(0, 3);
  if (first) lines.push(...quoteLines(first, f, logs));
  if (f.file) lines.push(`  At ${at(f.file, f.line)}${f.addressed ? `: ${f.addressed}` : ""}`);
  if (f.criteria) lines.push(`  Criteria: ${clip(f.criteria, 600)}`);

  if (f.door && !f.trials && !f.rate) lines.push(`  Endpoint: ${f.door}`);
  else if (!f.door && f.doors?.length) lines.push(`  Endpoints: ${f.doors.join(", ")}`);
  const where = besides(f.where, f.door);
  if (where) lines.push(`  Where: ${where}`);
  if (f.fix) lines.push(`  Fix: ${f.fix}`);
  const never = neverRanOf(f.sentAway?.neverRan, unseen);
  if (never.length) lines.push(`  Needed by these asks and never run: ${never.join(", ")}.`);
  lines.push(...alsoLines(f));
  if (f.layer && LAYER_WORDS[f.layer]) lines.push(`  Layer: ${f.layer}, ${LAYER_WORDS[f.layer]}.`);
  const read = f.decidedBy?.reader ?? f.decidedBy?.model;
  const by = [f.decidedBy?.code && `code on ${plural(f.decidedBy.code, "quoted reply", "quoted replies")}`, read && `a model on ${plural(read, "quoted reply", "quoted replies")}`].filter(Boolean);
  if (by.length) lines.push(`  Decided by ${by.join(", by ")}.`);
  for (const q of more) lines.push(...quoteLines(q, f, logs));
  if (f.sentAway?.note) lines.push(`  ${f.sentAway.note}`);
  for (const line of (f.log ?? []).slice(0, 8)) lines.push(`  Log: ${clip(line, 300)}`);

  if (f.replay?.trials) lines.push(`  Replay: ${plural(f.replay.trials, "conversation")}, verify ${f.id}`);

  if (f.replay?.plan) lines.push(`  ${f.replay.plan}`);
  return lines.join("\n");
}

const pct = (x) => `${Math.round(x * 100)}%`;

const besides = (where, door) => (door && where ? where.split(", ").filter((p) => p !== door).join(", ") : where);

function shareLine(f) {
  const atDoor = f.door ? ` at ${f.door}` : "";
  const t = f.trials;
  if (t) return `  Failed in ${num(t.failed)} of ${plural(t.of, "conversation")}${atDoor}: ${pct(t.failed / t.of)} (${pct(t.lo)} to ${pct(t.hi)}).`;
  const r = f.rate;
  if (!r) return "";
  const range = has(r.lo) ? ` (${pct(1 - r.hi)} to ${pct(1 - r.lo)})` : "";
  return `  Failed on ${num(r.n - r.k)} of ${plural(r.n, "reply", "replies")}${atDoor}${r.n ? `: ${pct((r.n - r.k) / r.n)}${range}` : ""}.`;
}

function quoteLines(q, f, logs) {
  const lines = [];
  const about = [q.trialId && `conversation ${String(q.trialId).slice(0, 8)}`, q.door && `at ${q.door}`].filter(Boolean).join(", ");
  if (q.asked) lines.push(`  Sent: "${clip(q.asked, 300)}"`);
  lines.push(`  Reply ${q.reply}: "${clip(q.answer ?? q.quote, 400)}"${about ? ` (${about})` : ""}`);
  if (q.answer && q.quote && q.quote !== q.answer) lines.push(`    It broke on: "${clip(q.quote, 300)}"`);

  if (q.after) lines.push(`    Then the customer: "${clip(q.after, 300)}"`);
  if (q.checked) lines.push(`    ${q.checked}`);
  for (const p of (q.passages ?? []).slice(0, 3)) lines.push(`    Passage${p.source ? ` (${clip(p.source, 60)})` : ""}: "${clip(p.text, 240)}"`);
  if (q.request) lines.push(`    Request: ${q.request.method} ${q.request.path}${q.request.body ? ` ${clip(q.request.body, 600)}` : ""}`);
  if (has(q.response)) lines.push(`    Response: ${q.response ? clip(q.response, 600) : "(empty body)"}`);
  const log = (q.log ?? []).join("\n");
  if (log && logs.shown.has(log)) lines.push("    Log: the same lines as the reply above.");
  else for (const line of (q.log ?? []).slice(0, logs.room)) { lines.push(`    Log: ${clip(line, 240)}`); logs.room -= 1; }
  if (log) logs.shown.add(log);
  if (q.at && q.at !== at(f.file, f.line)) lines.push(`    At ${q.at}`);
  return lines;
}

function alsoLines(f) {
  const failed = (a) => (a.trials ? a.trials.failed : a.rate.n - a.rate.k);
  const broke = (a) => (a.trials ? `failed in ${num(a.trials.failed)} of ${plural(a.trials.of, "conversation")}` : `failed on ${num(failed(a))} of ${plural(a.rate.n, "reply", "replies")}`);
  const own = (a) => Boolean(f.questionId) && a.questionId === f.questionId;

  const same = (f.alsoIn ?? []).filter((a) => own(a) && failed(a) > 0);
  const other = (f.alsoIn ?? []).filter((a) => !own(a));
  const lines = [];
  if (same.length) {
    lines.push("  Also failed:");
    for (const a of same.slice(0, 8)) lines.push(`    ${[a.door, besides(a.where, a.door)].filter(Boolean).join(", ")}: ${broke(a)}`);
    if (same.length > 8) lines.push(`    and ${num(same.length - 8)} more.`);
  }
  if (other.length) {
    lines.push(`  Same cause in ${plural(other.length, "more place")}, the same reply sentence in each:`);
    for (const a of other.slice(0, 8)) lines.push(`    ${a.where}: ${clip(a.asks, 160)}, ${broke(a)}`);
    if (other.length > 8) lines.push(`    and ${num(other.length - 8)} more.`);
  }
  return lines;
}

export function fieldText(d) {
  const t = d.totals;
  const pct = (k, n) => (n ? `${Math.round((100 * k) / n)}%` : "n/a");
  const link = d.url ? [`The person sees this at ${d.url}`] : [];
  if (!t || !t.n) return [`No production conversations analyzed in the last ${plural(d.days, "day")}.`, ...link].join("\n");
  const lines = [
    `Production, last ${plural(d.days, "day")}: ${plural(t.n, "conversation")}, ${num(t.read)} analyzed.`,
    `Rules kept: ${pct(t.rulingsHeld, t.rulings)} of ${num(t.rulings)}${t.rulingsUnsure ? ` (${num(t.rulingsUnsure)} too close to call)` : ""}. Resolved ${pct(t.resolved, t.read)}, frustrated ${pct(t.frustrated, t.read)}, asked for a human ${pct(t.wantsHuman, t.read)}, unanswered ${pct(t.unanswered, t.read)}.`,
  ];
  const broke = (d.rules ?? []).filter((r) => r.broke > 0).sort((a, b) => b.broke - a.broke).slice(0, 5);
  if (broke.length) lines.push(`Rules broken most: ${broke.map((r) => `${r.id} (${num(r.broke)})`).join(", ")}.`);
  if (d.journeys?.length) lines.push(`By journey: ${d.journeys.slice(0, 6).map((j) => `${j.value} ${plural(j.n, "conversation")}, ${pct(j.rulingsHeld, j.rulings)} passed`).join("; ")}.`);
  return [...lines, ...link].join("\n");
}

export const fieldConnectText = (d) => [d.connected ? "Production is connected." : "Production is not connected.", ...(d.steps ?? []).map((s, i) => `${i + 1}. ${s}`)].join("\n");
