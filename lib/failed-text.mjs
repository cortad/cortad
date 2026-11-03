import { at, clip, plural } from "./words.mjs";

// The replies that did not count and the doors that were not sent to, said before the score: one
// sentence whose parts add up to the count, then the request behind each part that has one. A count
// on its own ("17 of 33 replies failed") left resumeforge's agent asking what was attempted, whose it
// was, and how to reproduce it.

// A row the run held back names a door and why, or, when no door could take it, only the reason.
const reason = (why) => clip(String(why).replace(/^Not played:\s*/i, "").replace(/\.$/, ""), 200);
export const heldBackLine = (h) => h.why === "not testable here"
  ? `Set aside: ${plural(h.trials, "conversation")} cannot be played here: ${clip(h.surface, 200).replace(/\.$/, "")}.`
  : `Set aside: ${plural(h.trials, "conversation")} on ${h.surface}${h.why ? `: ${reason(h.why)}` : ""}.`;

const HELD_SHOWN = 6;

export function heldLines(held) {
  const rows = (held ?? []).filter((h) => h.trials > 0);
  const lines = rows.slice(0, HELD_SHOWN).map(heldBackLine);
  if (rows.length > HELD_SHOWN) lines.push(`Set aside: ${plural(rows.slice(HELD_SHOWN).reduce((n, h) => n + h.trials, 0), "more conversation")} for ${plural(rows.length - HELD_SHOWN, "other reason")}.`);
  return lines;
}

export function failedLines(f) {
  if (!f) return [];
  const lines = f.said ? [f.said] : [];
  for (const row of f.rows ?? []) {
    const sent = row.curl ?? row.request;
    if (!sent && !row.verify) continue;
    const [path, line] = (row.at ?? "").split(/:(?=\d+$)/);
    const where = row.at ? `at ${at(path, Number(line))}` : `from ${row.door}`;
    if (sent) lines.push(`  Request for the ${row.count} ${where}: ${clip(sent, 900)}`);
    if (sent && row.response) lines.push(`    Answered: ${clip(row.response.replace(/\s+/g, " "), 300)}`);
    if (row.printed) lines.push(`    Your app printed: "${clip(row.printed, 300)}"`);
    if (row.verify) lines.push(sent ? `    verify ${row.verify} replays them.` : `  verify ${row.verify} replays the ${row.count} ${where}.`);
  }
  return [...lines, ...heldLines((f.held ?? []).map((h) => ({ surface: h.door, trials: h.trials, why: h.why })))];
}
