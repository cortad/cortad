// What the agent reads back from the Intelligence Layer's tools, as plain lines: numbers, ids and
// the cause, never a user's words.

const n = (v) => (typeof v === "number" ? v.toLocaleString("en-US") : String(v ?? 0));
const when = (iso) => (iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 16) + "Z" : "");

export function incidentLine(i) {
  const where = i.segment ? (i.segment.kind === "country" ? ` from ${i.segment.value}` : ` on release ${i.segment.value}`) : "";
  const cause = i.cause ? `; the change was ${i.cause.kind} ${i.cause.value ?? ""}`.trimEnd() + (i.cause.at ? ` at ${when(i.cause.at)}` : "") : "";
  return `Since ${when(i.since)}, ${i.kind === "reaction" ? `people${where} reacted "${i.key}" after` : `replies${where} broke "${i.key}" in`} ${n(i.now.broke)} of ${n(i.now.of)}; before, ${n(i.before.broke)} of ${n(i.before.of)}${cause}.`;
}

// A commit is named by its first seven characters, as git prints it.
const short = (v) => (/^[0-9a-f]{40}$/.test(v) ? v.slice(0, 7) : v);
const pct = (v) => `${Math.round((v ?? 0) * 100)}%`;
const many = (count, word) => `${n(count)} ${word}${count === 1 ? "" : "s"}`;

// How far connecting the live app has got, as the page's card says it: one line for each thing that
// has to arrive, so a key in a file is never read as a connected app.
export function connectionLines(c) {
  if (!c) return [];
  return [
    c.keys ? "- Keys: made." : "- Keys: none yet. connect makes them.",
    c.here ? `- This machine: a copy of the app started with the key at ${when(c.here.at)}.` : "- This machine: no copy of the app has started with the key.",
    c.started ? `- Deployed app: started with Cortad at ${when(c.started.at)}${c.started.release ? ` on version ${short(c.started.release)}` : ""}.` : "- Deployed app: has not started with Cortad. Deploy the change, with the key in the production environment.",
    c.conversation ? `- First conversation: read at ${when(c.conversation.at)}.` : "- First conversation: none yet. It shows within a minute of a person's first reply.",
    c.page ? `- Pages: sending since ${when(c.page.at)}.` : "- Pages: none has sent yet. An app with no page of its own skips this.",
  ];
}

// One problem as the agent can act on it: the question and its place in the code, how far it
// reached, the version it started on, the use case it hits most, and the call that follows a fix.
function problemLines(p, i) {
  const v = p.version;
  // A version that answered after the one the problem started on is where a fix shows.
  const later = p.newest && v && p.newest.name !== v.name ? p.newest : null;
  return [
    `${i + 1}. ${p.title}${p.from ? `, ${p.from}` : ""}`,
    p.words && p.words !== p.title ? `   The question: ${p.words}` : "",
    `   Failed in ${n(p.broke)} of ${many(p.of, "conversation")} it applied to, between ${pct(p.low)} and ${pct(p.high)}.`,
    v ? `   First failed ${when(p.since)} on version ${short(v.name)}: ${n(v.broke)} of ${n(v.of)} since${v.before.of ? `, ${n(v.before.broke)} of ${n(v.before.of)} before it` : ", the oldest version in this window"}.` : `   First failed ${when(p.since)}.`,
    p.most ? `   Most in "${p.most.useCase}": ${n(p.most.broke)} of ${n(p.most.of)}.` : "",
    later ? `   On the newest version, ${short(later.name)}: ${n(later.broke)} of ${n(later.of)}.${later.broke ? "" : p.stopped ? " It has stopped; nothing to fix unless it returns." : " Too few yet to say it has stopped."}` : "",
    `   The conversations, for the person to open: ${p.url}`,
    p.stopped ? "" : p.finding ? `   The last simulation found it too: fix it, then verify with findingId "${p.finding}".` : "   No simulation has reproduced it: call test and say this problem in a sentence, fix what it finds, then verify.",
  ].filter(Boolean);
}

// How many problems there are to fix, and how many of the window's failures have already stopped.
function said({ n, open = n, worst }) {
  if (!n) return "No question failed.";
  const ended = n - open;
  const stopped = ended ? `; ${many(ended, "question")} that failed ${ended === 1 ? "has" : "have"} stopped on the newest version` : "";
  const shown = worst.filter((p) => !p.stopped).length;
  return `${open ? `${many(open, "problem")} to fix${open > shown ? `, the worst ${shown} here` : ""}` : "Nothing to fix"}${stopped}.`;
}

export function intelligenceText(d) {
  const c = d.connection;
  if (c && !c.connected) return ["The live app is not connected yet.", ...connectionLines(c), "next: connect"].join("\n");
  const t = d.conversations ?? {};
  const problems = d.problems;
  const lines = [`The live app, last ${d.days} days: ${many(t.n ?? 0, "conversation")}, ${n(t.read)} read. ${problems ? said(problems) : ""}`.trim()];
  for (const [i, p] of (problems?.worst ?? []).entries()) lines.push("", ...problemLines(p, i));
  if (problems?.worst.length) lines.push("");
  // A problem is also sent as an incident, for a connector from before problems were named.
  const worse = (d.wrong ?? []).filter((i) => !i.problem);
  if (worse.length) lines.push(`Got worse lately: ${worse.length}.`, ...worse.map((i) => `- ${incidentLine(i)}`));
  if (t.read) lines.push(`Of ${n(t.read)} read: ${n(t.heldEvery)} passed every question, ${n(t.got)} had their task done, ${n(t.frustrated)} ended frustrated, ${n(t.wantsHuman)} asked for a person.`);
  if (d.visits?.n) {
    const r = d.visits.reactions ?? {};
    lines.push(`Visits: ${n(d.visits.n)}; after answers people ${Object.entries(r).filter(([k]) => k !== "waited").map(([k, v]) => `${k} ${n(v)}`).join(", ") || "reacted to nothing yet"} (of ${n(r.waited)} answers seen).`);
  }
  // A server from before problems were named sends the counts alone.
  if (!problems && d.checks?.length) lines.push(`Questions failed most: ${d.checks.filter((k) => k.broke).sort((a, b) => b.broke - a.broke).slice(0, 5).map((k) => `${k.id} ${n(k.broke)} of ${n(k.held + k.broke)}`).join("; ") || "none"}.`);
  lines.push(`The page: ${d.url}`);
  return lines.join("\n");
}

export function incidentsText(d) {
  // With none open there is nothing to add to what the production answer said.
  if (!d.open?.length) return d.said ?? "";
  return [...d.open.map((i) => `${incidentLine(i)} Conversations: ${(i.conversations ?? []).join(", ")}`), d.said, d.url].filter(Boolean).join("\n");
}

const ruleWords = (r) => r.kind === "path" ? `a page ${r.match} ${r.value}` : r.kind === "click" ? `a click on ${r.text ? `"${r.text}"` : r.selector}` : r.kind === "event" ? `the page's event "${r.name}"` : `the backend's outcome "${r.name}"`;

export function outcomesText(d) {
  if (d.proposed !== undefined) return `${n(d.proposed)} proposed. ${d.awaiting}`;
  if (!d.outcomes?.length) return `No outcome is defined yet. Propose what the code treats as a good ending (a signup route, a checkout, a "done" button) with outcomes {proposals: [{name, rules, why}]}; ${d.shape}`;
  return [...d.outcomes.map((o) => `${o.approved ? "Counted" : "Proposed, awaiting the person"}: ${o.name}: ${o.rules.map(ruleWords).join(", or ")}${o.why ? ` (${o.why})` : ""}`), d.url].join("\n");
}

export function queryText(d) {
  if (d.error) return `${d.error}${d.sql ? `\n${d.sql}` : ""}`;
  const rows = d.rows ?? [];
  if (rows.length === 0) return `No rows.\n${d.sql}`;
  const keys = Object.keys(rows[0]);
  return [keys.join("\t"), ...rows.slice(0, 200).map((r) => keys.map((k) => String(r[k] ?? "")).join("\t")), rows.length > 200 ? `${rows.length - 200} more rows` : "", d.scannedBytes != null ? `Scanned ${n(d.scannedBytes)} bytes.` : ""].filter(Boolean).join("\n");
}
