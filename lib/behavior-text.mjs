import { at, clip, num, plural, upper } from "./words.mjs";

const PROBLEMS_SHOWN = 3;

const PERSONAS_SHOWN = 6;
const PLACES_SHOWN = 8;
const IDS_SHOWN = 5;
const QUOTE_CHARS = 240;

const short = (id) => String(id).slice(0, 8);
const pct = (s) => (s.of ? Math.round((100 * s.n) / s.of) : 0);
export const rateSaid = (s) => `${num(s.n)} of ${plural(s.of, "conversation")}, ${pct(s)}% (${s.low}% to ${s.high}%)`;
const day = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const time = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
const ended = (t) => (/[.?!]$/.test(t) ? t : `${t}.`);
const quoted = (s) => `"${clip(String(s).replace(/"/g, "'"), QUOTE_CHARS)}"`;

export function pointSaid(p) {
  if (p.kind === "production") return p.from === p.to ? `production on ${day(p.from)}` : `production from ${day(p.from)} to ${day(p.to)}`;
  const commit = p.commit ? ` on commit ${p.commit.slice(0, 7)}${p.message ? ` (${quoted(p.message)})` : ""}` : "";
  return `the simulation of ${day(p.at)} at ${time(p.at)} UTC${commit}`;
}

const who = (p) => (p.kind === "production" ? "real users" : "simulated users");

function behaves(m) {
  if (!m) return null;
  const parts = [`${plural(m.messages, "message")} a conversation`];
  if (m.words) parts.push(`a first message of about ${plural(m.words, "word")}`);
  const share = (v, what) => (v > 0 ? `${Math.round(v * 100)}% of them ${what}` : null);
  const more = [share(m.pushesBack, "push back"), share(m.asksForPerson, "ask for a person"), share(m.leftUnanswered, "leave a question unanswered"), share(m.comesBack, "come back on another day")].filter(Boolean);
  return `They send ${parts.join(", with ")}${more.length ? `; ${more.join(", ")}` : ""}.`;
}

const insightLine = (i) => {
  const ids = (i.evidence?.conversations ?? []).slice(0, IDS_SHOWN).map(short).join(", ");
  return `   - ${i.text}${ids ? ` Shown in ${ids}.` : ""}`;
};
const wellLine = (w) => `   - ${w.text.replace(/\.$/, "")}: in ${rateSaid(w.share)}${w.apart && w.others ? `, against ${pct(w.others)}% (${w.others.low}% to ${w.others.high}%) for the other users` : ""}.`;
const insightsOf = (p, kind) => (p.insights ?? []).filter((i) => i.kind === kind);

function problemLines(p, real, quote) {
  const lines = [`   - ${p.said ?? `${p.text.replace(/\.$/, "")}: in ${rateSaid(p.share)}.`}${p.findingId ? ` (${p.findingId})` : ""}`];
  const ids = p.conversations.slice(0, IDS_SHOWN).map(short);
  if (ids.length) lines.push(`     Shown in ${ids.join(", ")}${p.conversations.length > ids.length ? ` and ${num(p.conversations.length - ids.length)} more` : ""}.`);
  if (quote && p.quote && !real) {
    lines.push(`     In ${short(p.quote.conversation)}:`);
    if (p.quote.asked) lines.push(`       The user: ${quoted(p.quote.asked)}`);
    lines.push(`       Reply ${p.quote.reply}: ${quoted(p.quote.quote || p.quote.said)}`);
  }
  return lines;
}

function personaLines(p, i, point, whole) {
  const real = point.kind === "production";
  const head = `${i + 1}. ${p.name}${p.flagged ? " [flagged: these users misuse the app]" : ""}: ${plural(p.users, real ? "user" : "simulated user")}, ${plural(p.conversations, "conversation")}.`;
  const lines = [head];
  if (p.flagged && p.why) lines.push(`   Why flagged: ${p.why}`);
  if (p.facts?.length) lines.push(`   Who they are: ${p.facts.map((f) => `${f.key} ${f.values.map((v) => `${v.value} ${Math.round(v.share * 100)}%`).join(", ")}`).join("; ")}.`);
  const b = behaves(p.measures);
  if (b) lines.push(`   ${b}`);
  lines.push(p.servedSaid ? `   ${p.servedSaid}` : p.served ? `   They achieved their goal in ${rateSaid(p.served)}.` : "   Whether they achieved their goal is not known for these conversations.");
  lines.push(...insightsOf(p, "served").map(insightLine));
  if (insightsOf(p, "trait").length) lines.push("   How they behave, from their conversations:", ...insightsOf(p, "trait").map(insightLine));
  const well = (p.well ?? []).map(wellLine);
  if (well.length) lines.push("   What the app did well with them:", ...well);
  const shown = whole ? p.problems : p.problems.slice(0, PROBLEMS_SHOWN);
  const read = insightsOf(p, "problem");
  if (shown.length || read.length) {
    lines.push("   Where it gave way:", ...read.map(insightLine));
    shown.forEach((x, k) => lines.push(...problemLines(x, real, whole || k === 0)));
  } else lines.push("   No problem was seen in more than one of their conversations.");
  const more = p.problems.length - shown.length;
  if (more > 0) lines.push(`   ${plural(more, "more problem")} in more than one conversation: behavior with persona: "${p.name}" lists them.`);
  if (p.seenOnce) lines.push(`   ${plural(p.seenOnce, "problem was", "problems were")} seen in one conversation alone, which is not yet a pattern.`);
  if (whole && p.list?.length) {
    lines.push(`   Their conversations${p.list.length < p.conversations ? `, the first ${num(p.list.length)} of ${num(p.conversations)}` : ""}:`);
    for (const c of p.list) {
      const got = c.served === true ? "achieved their goal" : c.served === false ? "did not achieve their goal" : "not known whether they achieved it";
      const what = real ? got : `${quoted(c.asked)}; ${got}`;
      lines.push(`   - ${short(c.id)}: ${what}${c.problems.length ? `; went wrong: ${c.problems.map((t) => t.replace(/\.$/, "")).join("; ")}` : ""}.${real && c.open ? ` Open: ${c.open}` : ""}`);
    }
  }
  return lines;
}

function codeLines(code) {
  if (!code.length) return [];
  const lines = ["Where each problem comes from in the code:"];
  for (const place of code.slice(0, PLACES_SHOWN)) {
    lines.push(`- ${at(place.path, place.line)}`);
    for (const p of place.problems) lines.push(`  ${p.text.replace(/\.$/, "")}: ${plural(p.conversations, "conversation")} of ${p.personas.length === 1 ? `"${p.personas[0]}"` : plural(p.personas.length, "persona")}.${p.findingId ? ` Verify with findingId "${p.findingId}" replays them after a fix.` : ""}`);
  }
  if (code.length > PLACES_SHOWN) lines.push(`${plural(code.length - PLACES_SHOWN, "more place")} in the code, each behind fewer conversations.`);
  return lines;
}

export function behaviorText({ review: r }) {
  const real = r.point.kind === "production";
  const one = r.personas.length === 1 && r.personas[0].list;

  const lines = [...(r.point.which?.said ? [r.point.which.said] : []), `How your app behaved with its users: ${pointSaid(r.point)}.`];
  const served = r.served ? ` Of the ${plural(r.served.of, "conversation")} where it could be told, ${num(r.served.n)} achieved their goal: ${pct(r.served)}% (${r.served.low}% to ${r.served.high}%).` : "";
  lines.push(one
    ? `One persona in full, of ${plural(r.users, real ? "real user" : "simulated user")} and ${plural(r.conversations, "conversation")} in all.`
    : `${usersSaid(r.users, r.personas.length, real)}, in ${plural(r.conversations, "conversation")}.${served}`);
  if (real && r.point.open) lines.push(`Real users' words are not shown here. The owner reads any conversation below at ${r.point.open}<id>.`);
  lines.push("");
  const full = r.personas.filter((p, i) => i < PERSONAS_SHOWN || p.flagged);
  r.personas.forEach((p, i) => { if (full.includes(p)) lines.push(...personaLines(p, i, r.point, Boolean(one)), ""); });
  const rest = r.personas.filter((p) => !full.includes(p));
  if (rest.length) {
    lines.push(`${plural(rest.length, "more persona")}, smaller; behavior with persona opens any of them:`);
    for (const p of rest) lines.push(`- ${p.name}: ${plural(p.users, real ? "user" : "simulated user")}, ${plural(p.conversations, "conversation")}${p.served ? `, achieved their goal in ${rateSaid(p.served)}` : ""}${p.problems[0] ? `; most often: ${p.problems[0].text.replace(/\.$/, "")}, in ${num(p.problems[0].share.n)} of ${num(p.problems[0].share.of)}` : ""}.`);
    lines.push("");
  }
  if (r.habits && !one) {
    lines.push(`The app's habits across personas, across ${plural(r.habits.conversations, "conversation")}:`);
    if (r.habits.doesWell) lines.push(`- Does well: ${r.habits.doesWell}`);
    if (r.habits.givesWay) lines.push(`- Gives way: ${r.habits.givesWay}`);
    if (r.habits.pattern) lines.push(`- The habit behind it: ${r.habits.pattern}`);
    lines.push("");
  }
  lines.push(...codeLines(r.code));
  const top = r.personas[0]?.name;
  lines.push(one
    ? `next: tell the person how their AI behaved with "${top}", in plain words, then what you would change and why it follows${real ? "" : `; behavior with against: "production" says how these simulated users compare with real ones`}`
    : `next: tell the person how their AI behaved with their users, persona by persona, then what you would change and why it follows${top ? `; behavior with persona: "${top}" opens the largest in full` : ""}`);
  return lines.join("\n");
}

const usersSaid = (users, personas, real) => {
  const who = plural(users, real ? "real user" : "simulated user");
  return personas >= users ? `${upper(who)}, each with a goal of their own` : `${upper(who)} of ${plural(personas, "persona")}`;
};

function simulatedAgainstReal(served) {
  const [sim, real] = [served.now, served.before];
  const said = `Simulated users achieved their goal in ${pct(sim)}% of conversations (${sim.low}% to ${sim.high}%), real users in ${pct(real)}% (${real.low}% to ${real.high}%)`;
  return served.move.moved === "up" ? `${said}: the simulation is easier on your app than your real users are.`
    : served.move.moved === "down" ? `${said}: the simulation is harder on your app than your real users are.`
    : `${said}: no clear difference.`;
}

const changeWord = { better: "Better", worse: "Worse", new: "New", gone: "Gone", same: "Same" };

const unlikeWord = { better: "Less often with simulated users", worse: "More often with simulated users", new: "Only simulated users met this", gone: "Only real users met this", same: "Same" };
const moveSaid = (m) => `${m.points > 0 ? "up" : m.points < 0 ? "down" : "no change,"} ${Math.abs(m.points)} points (${m.low} to ${m.high})`;

export function againstText({ against: d }) {
  const vsReal = d.before.kind !== d.now.kind;
  const lines = ["What changed for each persona.", `Now: ${pointSaid(d.now)}${vsReal ? `, its ${who(d.now)}` : ""}.`, `Before: ${pointSaid(d.before)}${vsReal ? `, its ${who(d.before)}` : ""}.`];
  if (vsReal) lines.push("Where the two behave differently, the simulation is not playing your users as they are.");
  lines.push("A rate counts as moved only where its range on the difference leaves out zero.");
  lines.push("");
  const words = vsReal ? unlikeWord : changeWord;
  for (const p of d.personas.filter((x) => !x.only)) {
    lines.push(`- ${p.name}: ${plural(p.users.now, "user")} now, ${num(p.users.before)} before.`);
    if (vsReal && p.measures.now && p.measures.before) {
      const m = (x) => `${plural(x.messages, "message")} a conversation${x.words ? `, first message about ${plural(x.words, "word")}` : ""}`;
      lines.push(`  ${upper(who(d.now))}: ${m(p.measures.now)}. ${upper(who(d.before))}: ${m(p.measures.before)}.`);
    }
    if (vsReal && p.served.now && p.served.before) lines.push(`  ${simulatedAgainstReal(p.served)}`);
    else if (p.served.now && p.served.before) lines.push(`  Achieved their goal: ${pct(p.served.now)}% now (${p.served.now.low}% to ${p.served.now.high}%), ${pct(p.served.before)}% before (${p.served.before.low}% to ${p.served.before.high}%): ${p.served.change === "same" ? "no clear change" : p.served.change}, ${moveSaid(p.served.move)}.`);
    for (const x of p.problems) lines.push(`  ${words[x.change]}: ${ended(x.text)} ${num(x.now.n)} of ${num(x.now.of)} now, ${num(x.before.n)} of ${num(x.before.of)} before: ${moveSaid(x.move)}.${x.findingId ? ` (${x.findingId})` : ""}`);
    if (p.unchanged) lines.push(`  ${plural(p.unchanged, "other problem")} did not clearly move.`);
    if (p.oneSided) lines.push(`  ${plural(p.oneSided, "problem was", "problems were")} checked on one side only, so not compared.`);
  }
  for (const side of ["now", "before"]) {
    const only = d.personas.filter((x) => x.only === side);
    const label = vsReal ? (side === "now" ? "Only in the simulation" : "Only in production, never played by this simulation") : `Only ${side}`;
    if (only.length) lines.push(`- ${label}: ${only.map((x) => `${x.name} (${plural(side === "now" ? x.users.now : x.users.before, "user")})`).join("; ")}.`);
  }
  lines.push(vsReal
    ? `next: tell the person where the simulation plays their users unlike real ones, in plain words; behavior with persona: "<name>" opens one`
    : `next: tell the person which personas got better or worse and why, in plain words; behavior with persona: "<name>" opens one`);
  return lines.join("\n");
}

function entryLine(e) {
  const served = e.served ? `, achieved their goal in ${rateSaid(e.served)}` : "";
  const head = `- ${upper(pointSaid(e.point))}${e.point.kind === "simulation" ? ` (id ${e.point.id})` : ""}: ${usersSaid(e.users, e.personas, e.point.kind === "production")}${served}.`;
  if (!e.change) return head;
  const c = e.change;
  const moved = [c.worse && `${num(c.worse)} worse`, c.new && `${num(c.new)} new`, c.better && `${num(c.better)} better`, c.gone && `${num(c.gone)} gone`].filter(Boolean);
  const servedMove = c.served && c.served.moved !== "same" ? `achieving their goal went ${moveSaid(c.served)}` : "achieving their goal did not clearly move";
  return `${head}\n  Since the one below: ${servedMove}; problems: ${moved.length ? moved.join(", ") : "none clearly moved"}.`;
}

export function historyText({ history: h }) {
  const lines = ["The history of how your app behaved, newest first.", "", "Simulations:"];
  lines.push(...(h.simulations.length ? h.simulations.map(entryLine) : ["- None has finished yet."]));
  lines.push("", "Production, by day:");
  lines.push(...(h.days.length ? h.days.map(entryLine) : ["- No production conversations in the last 30 days."]));
  lines.push(`next: behavior with at: "<id>" reads one of these; with against: "previous" it says what changed persona by persona`);
  return lines.join("\n");
}

const reachSaid = (d) => (d.unindexed > 0
  ? `${plural(d.unindexed, "conversation")} in scope ${d.unindexed === 1 ? "is" : "are"} not searchable yet and ${d.unindexed === 1 ? "is" : "are"} being indexed now.`
  : "Every conversation in scope is searchable.");

export function searchText(d, query) {
  const hits = d.hits ?? [];
  if (!hits.length) return `No conversation matches ${quoted(query)}. ${reachSaid(d)}\nnext: search with other words, or behavior for the whole review`;
  const worded = hits.every((h) => h.match === "words");
  const lines = [worded
    ? `No conversation is about ${quoted(query)} as asked; ${plural(hits.length, "conversation")} ${hits.length === 1 ? "holds" : "hold"} its words, in the order closest to it.`
    : `${plural(hits.length, "conversation")} ${hits.length === 1 ? "matches" : "match"} ${quoted(query)}, closest first.`];

  if (d.share && !worded) lines.push(`About ${num(d.share.n)} of ${plural(d.share.of, "conversation")} searched are about this, ${pct(d.share)}%; between ${num(d.share.low)} and ${num(d.share.high)}.`);
  lines.push(reachSaid(d));
  if (hits.some((h) => h.source === "production")) lines.push("Real users' words are not shown here; each one's address opens it for the owner.");
  hits.forEach((h, i) => {
    if (h.source === "production") {
      lines.push(`${i + 1}. ${short(h.conversationId)}, a real user${h.persona ? ` of "${h.persona}"` : ""}.`);
      if (h.outcome) lines.push(`   How it ended: ${h.outcome}`);
      if (h.open) lines.push(`   Open: ${h.open}`);
      return;
    }
    lines.push(`${i + 1}. ${short(h.conversationId)}, a simulated user${h.persona ? ` of "${h.persona}"` : ""}: asked ${quoted(h.asked)}`);
    if (h.outcome) lines.push(`   How it ended: ${h.outcome}`);
    if (h.quote) lines.push(`   The app said: ${quoted(h.quote)}`);
  });
  const personas = [...new Set(hits.map((h) => h.persona).filter(Boolean))];
  lines.push(personas.length ? `next: behavior with persona: "${personas[0]}" shows how that persona fared as a whole` : "next: behavior for the whole review");
  return lines.join("\n");
}
