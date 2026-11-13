import { clip, closeToCall, has, modelSaid, num, plural, upper } from "./words.mjs";

const WHOLE_CHARS = 4500;

const flat = (s, n) => clip(String(s).replace(/\s+/g, " ").trim(), n);

const pct = (x) => `${Math.round(x * 100)}%`;

const LAYER_NAMES = { prompt: "prompt", flow: "flow around the model", tool: "tool", routing: "routing", limit: "model's output cap", service: "service your app depends on" };

export const durationSaid = (s) => (s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`);

export function costSaid(d) {
  const parts = [has(d.durationS) && `took ${durationSaid(d.durationS)}`, d.spent && spentSaid(d.spent)].filter(Boolean);
  return parts.length ? `The simulation ${parts.join(" and ")}.` : "";
}

const spentSaid = (s) => (has(s.usd)
  ? `spent $${s.usd.toFixed(2)} on your key over ${plural(s.calls, "model call")}`
  : `made ${plural(s.calls, "model call")} on your key, not all of them priced`);

export const unseenOf = (t) => ({ all: t?.recorded === false, names: new Set(t?.unwatched ?? []) });
export const neverRanOf = (names, unseen) => (unseen.all ? [] : (names ?? []).filter((n) => !unseen.names.has(n)));

function headLines(d) {
  const r = d.run;

  const head = [r.model && `Your app answered on ${modelSaid(r.model)}.`, costSaid(r)].filter(Boolean).join(" ");
  const lines = head ? [head] : [];
  if (r.replies?.n && has(r.replies.medianS)) lines.push(`Replies took ${r.replies.medianS} s at the median and ${r.replies.slowestS} s at the slowest, over ${plural(r.replies.n, "reply", "replies")}.`);
  const t = d.tools;
  if (t?.recorded === false) lines.push(`Calls to the ${plural(t.offered, "tool")} your app offers its model were not recorded in this simulation.`);
  else if (t) {
    const never = neverRanOf(t.neverRan, unseenOf(t));
    lines.push(`${num(t.ran)} of ${plural(t.offered, "tool")} your app offers its model ran${never.length ? `; never ran: ${never.join(", ")}` : ""}.`);
    if (t.unwatched?.length) lines.push(`Calls to ${plural(t.unwatched.length, "tool")} were not recorded in this simulation: ${t.unwatched.join(", ")}.`);
  }
  return lines;
}

function partLines(p, unseen) {
  const lines = [`${p.id}  ${p.asks}`, `  ${upper(p.reach)}.`];
  if (p.harm) lines.push(`  Harm: ${p.harm}.`);
  if (p.at) lines.push(`  At ${p.at}`);
  if (p.step) lines.push(`  Written by: ${p.step.replace(/^written by /, "")}.`);
  if (p.tools?.length) lines.push(`  Tools that ran behind these replies: ${p.tools.join(", ")}.`);
  else if (p.tools && !unseen.all && !unseen.names.size) lines.push("  Tools that ran behind these replies: none.");
  const never = neverRanOf(p.neverRan, unseen);
  if (never.length) lines.push(`  Needed by these asks and never run: ${never.join(", ")}.`);
  if (p.sameCause) lines.push(`  Same cause as ${p.sameCause}: one fix covers both. Verify ${p.sameCause} after the fix; the next simulation rechecks this one.`);
  else if (p.layer) lines.push(`  Fix in the ${LAYER_NAMES[p.layer.name] ?? p.layer.name}: ${p.layer.said}.`);
  const e = p.exchange;
  if (e?.sent) lines.push(`  Sent: "${flat(e.sent, 200)}"`);
  if (e?.broke) lines.push(`  Broke on: "${flat(e.broke, 240)}"`);
  if (e?.after) lines.push(`  Then: "${flat(e.after, 200)}"`);
  if (e?.note) lines.push(`    ${e.note}`);

  if (p.note) lines.push(`  ${p.note}`);
  if (p.verify && !p.sameCause) lines.push(`  ${p.verify}`);
  return lines;
}

function changeLines(c, parts) {
  const lines = [c.lead, ...(c.scope ? [c.scope] : [])];
  for (const m of c.moved ?? []) {
    lines.push(`${m.worse ? "Worse" : "Better"}: "${flat(m.asks, 160)}" ${m.said}.`);
    if (m.at) lines.push(`  At ${m.at}`);
    const p = m.proof;
    if (p) {
      lines.push(`  Conversation ${p.trial}${p.sent ? `, sent: "${flat(p.sent, 160)}"` : ""}`);
      if (p.before) lines.push(`    Before: "${flat(p.before, 200)}"`);
      if (p.now) lines.push(`    Now: "${flat(p.now, 200)}"`);
    }
  }
  if (c.steady) lines.push(c.steady);
  if (c.fresh?.length) lines.push("New findings on the conversations written for this change:", ...parts(c.fresh));
  return lines;
}

export function dissectionLines(d) {
  if (!d?.run) return [];
  if (d.baseline && !d.unmeasured && !d.change) return firstRunLines(d);
  const room = { left: WHOLE_CHARS, short: 0, unseen: unseenOf(d.tools) };
  const parts = (ps) => ps.flatMap((p) => partOrLine(p, room));
  const lines = [...(d.change ? changeLines(d.change, parts) : []), ...headLines(d)];
  if (d.unmeasured) lines.push(`This simulation measured nothing. ${d.unmeasured} It is not counted against your plan; start one again once that is fixed.`);
  else lines.push(...brokeLines(d, room, "Found only by running your app:"));
  lines.push(...inCodeLines(d, room), ...gateLines(d, room), ...shortLines(room));
  for (const s of [d.held, d.notMeasured, d.next]) if (s) lines.push(s);
  return lines;
}

function brokeLines(d, room, head) {
  const lines = d.runOnly?.length ? [head, ...d.runOnly.flatMap((p) => partOrLine(p, room))] : ["Nothing broke that only running your app could show."];
  return [...lines, ...(d.also ?? [])];
}

const section = (head, parts, room) => {
  const lines = (parts ?? []).flatMap((p) => partOrLine(p, room));
  return lines.length ? [head, ...lines] : [];
};
const inCodeLines = (d, room) => section("Also in the code; a code review would also find these:", d.inCode, room);
const gateLines = (d, room) => section("Open gates, found by sending requests to your app's routes:", d.gates, room);
const shortLines = (room) => [
  ...(room.leaders?.length ? [`Also to act on, each shown in full by findings: ${room.leaders.join(", ")}.`] : []),
  ...(room.short ? [`behavior shows the last ${plural(room.short, "finding")} in full${room.unlisted ? `; ${num(room.unlisted)} of them are not listed here` : ""}.`] : []),
];

const FIRST_CHARS = 6000;
const FIRST_LINES = 1600;
const PEOPLE_SHOWN = 6;
const JOURNEYS_SHOWN = 6;

const WHOLE = { who: 90, wants: 120, name: 100, asks: 160, unplayed: 400 };
const CUT = { who: 60, wants: 80, name: 40, asks: 90 };
const LEAST_ROOM = 1200;
const PICTURE_CHARS = FIRST_CHARS - LEAST_ROOM;
function firstRunLines(d) {
  const b = d.baseline;
  const draw = (cut) => { const said = { interval: false }; return [baselineHead(b), ...peopleLines(b, said, cut), ...journeyLines(b, said, cut), ...heldEverywhereLines(b, cut)]; };
  let picture = draw(WHOLE);
  if (picture.join("\n").length > PICTURE_CHARS) picture = draw(CUT);
  const room = { left: Math.max(LEAST_ROOM, FIRST_CHARS - picture.join("\n").length), short: 0, lines: FIRST_LINES, unseen: unseenOf(d.tools) };
  return [
    ...picture,
    ...brokeLines(d, room, "What broke, found only by running your app:"),
    ...gateLines(d, room),
    ...inCodeLines(d, room),
    ...shortLines(room),
    ...notMeasuredLines(d, b),
    ...headLines(d),
    b.production
      ? "Production is connected: status about production shows what your real users are doing and where your AI lets them down."
      : "Connect production to see what your real users are doing as it happens and where your AI lets them down; connect has the steps.",
  ];
}

function baselineHead(b) {
  const head = `This was the first simulation, the baseline: ${plural(b.conversations, "conversation")} written from your code.`;
  if (!b.writtenFor) return head;
  const users = `${plural(b.users, "simulated user")} below`;
  return b.writtenFor === b.conversations ? `${head} All of them came from the ${users}.`
    : `${head} The ${users} had ${num(b.writtenFor)} of them; the other ${num(b.conversations - b.writtenFor)} were not written for any one user.`;
}

function gotSaid(g, said) {
  const done = g.full < g.k ? `completed fully or partly (${num(g.full)} fully)` : "completed fully";
  const clause = said.interval ? "" : ", the likely range";
  said.interval = true;
  return `${num(g.k)} of ${num(g.of)} ${done}: ${pct(g.of ? g.k / g.of : 0)} (${pct(g.lo)} to ${pct(g.hi)}${clause})`;
}

function peopleLines(b, said, cut) {
  if (!b.people?.length) return [];
  const line = (p) => {
    const played = has(p.conversations) ? ` ${plural(p.conversations, "conversation")}${p.got ? `; ${gotSaid(p.got, said)}` : ""}.` : "";
    return `  ${flat(p.who, cut.who)}: ${flat(p.wants, cut.wants)}. Writes ${flat(p.writes, 50)}.${played}`;
  };
  const more = b.people.length - PEOPLE_SHOWN;
  return ["The simulated users, as Cortad found them in your code:", ...b.people.slice(0, PEOPLE_SHOWN).map(line), ...(more > 0 ? [`  and ${plural(more, "more user")}.`] : [])];
}

function journeyLines(b, said, cut) {
  const j = b.journeys ?? { read: 0, rows: [], unplayed: [] };
  const on = j.rows.reduce((n, r) => n + r.conversations, 0);
  const head = j.read
    ? `Cortad found ${plural(j.read, "journey")} in your code${on < b.conversations ? `; ${num(on)} of the ${plural(b.conversations, "conversation")} followed one of them` : ""}.`
    : "Cortad found no journeys in your code, so the conversations are counted together.";
  const lines = [head, "How the conversations ended, judged on each one's last reply:"];
  const a = b.all;
  if (a?.got || a?.frustrated || a?.askedForPerson) {
    const parts = [a.got && gotSaid(a.got, said), a.unsure && closeToCall(a.unsure, said), a.frustrated && `${num(a.frustrated.k)} grew frustrated`, a.askedForPerson && `${num(a.askedForPerson.k)} asked for a person midway`].filter(Boolean);

    lines.push(`  All ${plural(a.got?.of ?? b.conversations, "conversation")}: ${parts.join("; ")}.`);
  }
  for (const r of j.rows.slice(0, JOURNEYS_SHOWN)) {
    const went = r.got ? `${gotSaid(r.got, said)}.` : `${plural(r.conversations, "conversation")}; where they ended is not known.`;
    const most = r.failedMost.map((f) => `"${flat(f.asks, 100)}" in ${num(f.failed)} of ${num(f.of)}`).join("; ");
    lines.push(`  ${flat(r.name, cut.name)}: ${went}${most ? ` Failed most: ${most}.` : ""}`);
  }
  const more = j.rows.length - JOURNEYS_SHOWN;
  if (more > 0) lines.push(`  and ${plural(more, "more journey")}; findings numbers has each one.`);
  return lines;
}

function heldEverywhereLines(b, cut) {
  if (!b.heldEverywhere?.length) return [];
  return [
    "Questions that passed in every conversation, each asked often enough to show it fails less than one time in five:",
    ...b.heldEverywhere.map((h) => `  Passed in all ${plural(h.of, "conversation")} it was tested in, so at most ${pct(h.hi)} would fail: "${flat(h.asks, cut.asks)}"`),
    ...(b.heldEverywhereMore ? [`  and ${plural(b.heldEverywhereMore, "more question")}; findings numbers lists every question.`] : []),
  ];
}

function notMeasuredLines(d, b) {
  const unplayed = b.journeys?.unplayed ?? [];
  const leftOut = b.journeys?.leftOut ?? [];
  const lines = [d.held, d.notMeasured,
    unplayed.length && `No conversation reached ${unplayed.length === 1 ? "this journey" : `these ${num(unplayed.length)} journeys`}: ${flat(unplayed.join(", "), WHOLE.unplayed)}.`,
    leftOut.length && `${leftOut.length === 1 ? "One journey is on a feature" : `${num(leftOut.length)} journeys are on features`} left out of this simulation: ${flat(leftOut.join(", "), WHOLE.unplayed)}.`,
  ].filter(Boolean);
  return lines.length ? ["What the numbers leave out, and why:", ...lines.map((l) => `  ${l}`)] : [];
}

function partOrLine(p, room) {
  const whole = partLines(p, room.unseen);
  const size = whole.join("\n").length;
  if (!room.short && size <= room.left) {
    room.left -= size;
    return whole;
  }
  room.short += 1;
  const line = `${p.id}  ${flat(p.asks, 140)} ${upper(p.reach)}.`;
  if (line.length > (room.lines ?? Infinity)) {
    if (p.leads) (room.leaders ??= []).push(p.id);
    else room.unlisted = (room.unlisted ?? 0) + 1;
    return [];
  }
  if (has(room.lines)) room.lines -= line.length;
  return [line];
}

const BOILER = [/ until it can decide, up to [\d,]+ replays/g, / Only replays it can score count toward this month's verify conversations, at least one a round\./g];
export function verifyOnceAPage(page) {
  return BOILER.reduce((text, clause) => {
    let first = true;
    return text.replace(clause, (all) => (first ? ((first = false), all) : ""));
  }, page);
}
