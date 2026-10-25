// What a person reads when the run ends. One card per rule that broke, the conversation that broke
// it, and the sentence it broke on.
const colour = () => !process.env.NO_COLOR && process.stdout.isTTY;
const paint = (code, s) => (colour() ? `\u001b[${code}m${s}\u001b[0m` : s);
export const bold = (s) => paint("1", s);
export const dim = (s) => paint("2", s);
export const red = (s) => paint("31", s);
export const green = (s) => paint("32", s);

const RULE = "─".repeat(64);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const wrap = (s, width, indent) =>
  s.split("\n").flatMap((line) => {
    const out = [];
    let at = "";
    for (const word of line.split(/\s+/)) {
      if (at && at.length + word.length + 1 > width) { out.push(at); at = word; } else { at = at ? `${at} ${word}` : word; }
    }
    out.push(at);
    return out;
  }).map((l) => indent + l).join("\n");

// One card per conversation, however many checks it failed. Printing the same exchange once per
// check buried the conversation under repeats of itself.
//
// The evidence is often the whole reply, and showing it twice buries the one sentence the card
// exists to show, so a reply that is its own evidence is shown once, in red.
export function card({ title, said, reply, failed }) {
  const whole = failed.every((f) => reply.trim() === f.evidence.trim());
  return [
    "",
    red(`  ${bold(title)}`),
    "",
    dim("  they said"),
    wrap(said, 70, "    "),
    "",
    dim(whole ? "  your app answered, and that is the break" : "  your app answered"),
    whole ? red(wrap(reply, 70, "    ")) : wrap(reply, 70, "    "),
    "",
    dim(failed.length === 1 ? "  it broke" : `  it broke ${failed.length} checks`),
    ...failed.map((f) => red(`    ${clip(f.require, 72)}`)),
    ...(whole ? [] : failed.filter((f) => f.evidence !== reply.trim()).flatMap((f) => ["", dim("  broke on"), red(wrap(f.evidence, 70, "    "))])),
  ].join("\n");
}

export function report({ broke, played, conversations, errors, judgeName }) {
  const out = [];
  for (const b of broke) out.push(card(b));
  out.push("", dim(RULE));
  if (errors.length) {
    out.push("", bold(`  ${errors.length} of ${count(conversations, "conversation")} never got an answer`));
    for (const e of errors.slice(0, 3)) out.push(dim(`    ${e.error}`));
  }
  const checks = broke.reduce((n, b) => n + b.failed.length, 0);
  const kept = played - broke.length;
  out.push(
    "",
    broke.length
      ? `  ${bold(`${broke.length} of ${count(played, "conversation")} went wrong`)}, on ${count(checks, "check")}, judged by ${judgeName}.`
      : `  ${green("Nothing broke")} across ${count(played, "conversation")}, judged by ${judgeName}.`,
  );
  if (broke.length && kept > 0) out.push(dim(`  ${count(kept, "conversation")} held everything asked of them.`));
  return out.join("\n");
}

// The one line a run ends on. The free run plays people who were invented here; the thing it cannot
// do is read the conversations the app actually had.
export const CLOSING = (conversations) =>
  dim(`  That was ${count(conversations, "conversation")} written for this app and played on this machine.\n  To run the same rules against the conversations your real users had, see cortad.com.`);
