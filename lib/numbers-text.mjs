import { clip, closeToCall, has, num, pack, pageOf, plural } from "./words.mjs";

// Every number the run measured, whole, one call away (`findings numbers`): each group with its count
// by class, of how many, the interval on the share that matters, and one exchange from the worst
// group of each.

const pct = (x) => `${Math.round(x * 100)}%`;
const interval = (b) => `${pct(b.lo)} to ${pct(b.hi)}`;
const isScale = (t) => t.classes.every((c) => /^\d+$/.test(c));

const units = (n, unit) => (unit === "replies" ? plural(n, "reply", "replies") : plural(n, "conversation"));

const SPLIT_WORDS = { journey: "By journey", segment: "By user segment", situation: "By place in your app", reply: "By reply" };
const SPLIT_WORD = { journey: "journey", segment: "user segment", situation: "place", reply: "reply" };
// The server counts in "trials"; the person reads conversations.
const unitSaid = (unit) => (unit === "replies" ? "replies" : "conversations");

// One group as a row under its header: the counts in the header's order, of how many, the average
// on a scale, then the share named with its interval.
function row(t, d, said) {
  const of = units(d.of, t.unit);
  const unsure = d.unsure ? `; ${closeToCall(d.unsure, said)}` : "";
  const share = d.bad && d.of ? `, ${interval(d.bad)}` : "";
  if (t.kind === "question") return `${num(d.counts?.broke ?? 0)} of ${of}${share}${unsure}`;
  const counts = t.classes.map((c) => num(d.counts?.[c] ?? 0)).join(", ");
  const mean = has(d.mean) ? `, average ${d.mean.toFixed(2)}` : "";
  return `${counts} of ${of}${mean}${d.bad && t.badSaid ? `; ${num(d.bad.k)}${share}` : ""}${unsure}`;
}

// How the rows are read: a question's conversations broken, or a measurement's classes and its share.
const headerOf = (t) => (t.kind === "question"
  ? `  Counted as: the ${unitSaid(t.unit)} it broke in, of the ${unitSaid(t.unit)} that asked it, with the 95% interval.`
  : `  Counted as: ${isScale(t) ? `levels ${t.classes.join(", ")}` : t.classes.join(", ")} of ${unitSaid(t.unit)}${t.badSaid ? `; then how many ${t.badSaid}, with the 95% interval` : ""}.`);

function tableBlock(t) {
  const said = {};
  const lines = [`${t.kind === "question" ? `${t.id}  ` : ""}${clip(t.title, 400)}${t.from ? ` (${t.from})` : ""}`];
  if (t.legend) lines.push(`  ${clip(t.legend, 500)}`);
  lines.push(headerOf(t), `  All: ${row(t, t.all, said)}`);
  for (const split of ["journey", "segment", "situation", "reply"]) {
    const groups = t.by?.[split] ?? [];
    if (!groups.length || (split !== "reply" && groups.length === 1 && groups[0].of === t.all.of)) continue;
    lines.push(`  ${SPLIT_WORDS[split]}:`, ...groups.map((d) => `    ${clip(d.value, 90)}${d.kept ? " (saved to test fixes)" : ""}: ${row(t, d, said)}`));
  }
  const w = t.worst;
  if (w) {
    const e = w.exchange;
    lines.push(`  Worst: ${SPLIT_WORD[w.split] ?? w.split} ${clip(w.value, 90)}.${e ? ` Conversation ${String(e.trialId).slice(0, 8)}, reply ${e.reply}.` : " Its conversations are saved to test fixes."}`);
    if (e?.sent) lines.push(`    Sent: "${clip(e.sent, 300)}"`);
    if (e?.answer) lines.push(`    Reply ${e.reply}: "${clip(e.answer, 300)}"`);
    if (e?.after) lines.push(`    Then the customer: "${clip(e.after, 300)}"`);
    if (e?.quote && e.quote !== e.answer) lines.push(`    It broke on: "${clip(e.quote, 240)}"`);
  }
  return lines.join("\n");
}

// Every number, whole, in pages under what every client shows at once.
export function numbersText(d, page = 1) {
  const n = d?.numbers;
  if (!n) return d?.why ?? "No run has finished on this repository yet.";
  const head = [
    `Run ${n.runId}: every number it measured, ${plural(n.measures.length, "measurement")} and ${plural(n.questions.length, "question")} over ${plural(n.trials, "conversation")}, ${plural(n.replies, "reply", "replies")} and ${plural(n.readings, "check")}.`,
    "A conversation counts once in each group it played in; a reply split counts each conversation at that reply.",
  ].join("\n");
  const blocks = [...n.measures, ...n.questions].map(tableBlock);
  const pages = pack(head, blocks.map((b) => `\n${b}`), `Run ${n.runId}, numbers continued.`);
  return pageOf(pages, page, (k) => `findings numbers with page ${k}`);
}
