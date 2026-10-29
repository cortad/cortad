// What a person reads when a run ends. One card per conversation that failed, the reply it failed
// on, and what each question wanted against what it got.
import { failed } from "./answer/verdict.mjs";

const colour = () => !process.env.NO_COLOR && process.stdout.isTTY;
const paint = (code, s) => (colour() ? `\u001b[${code}m${s}\u001b[0m` : s);
export const bold = (s) => paint("1", s);
export const dim = (s) => paint("2", s);
export const red = (s) => paint("31", s);
export const green = (s) => paint("32", s);

const RULE = "─".repeat(64);
const count = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
const wrap = (s, width, indent) =>
  String(s).split("\n").flatMap((line) => {
    const out = [];
    let at = "";
    for (const word of line.split(/\s+/)) {
      if (at && at.length + word.length + 1 > width) { out.push(at); at = word; } else { at = at ? `${at} ${word}` : word; }
    }
    out.push(at);
    return out;
  }).map((l) => indent + l).join("\n");

const lastReply = (transcript) => [...transcript].reverse().find((t) => t.role === "app")?.text ?? "";

// The reply a question was answered from, when the answer carries a quote. Otherwise the last one,
// because that is where a conversation ended up.
const replyFor = (conversation, ruled) => {
  const quoted = ruled.find((r) => r.quote);
  if (!quoted) return lastReply(conversation.transcript);
  return conversation.transcript.find((t) => t.role === "app" && t.text.includes(quoted.quote))?.text ?? lastReply(conversation.transcript);
};

function card(conversation) {
  const wrong = conversation.ruled.filter(failed);
  if (!wrong.length) return null;
  const reply = replyFor(conversation, wrong);
  return [
    "",
    `  ${red(bold(conversation.id))}`,
    "",
    dim("  who"),
    wrap(conversation.who, 70, "    "),
    "",
    dim("  your app"),
    wrap(`"${reply}"`, 70, "    "),
    "",
    ...wrong.flatMap((f) => [
      `  ${f.ask}`,
      `  ${dim("wanted")} ${f.wanted}   ${dim("got")} ${red(f.got)}`,
      ...(f.why ? [dim(`  ${f.why}`)] : []),
    ]),
  ].join("\n");
}

const movedLines = (moved) => {
  if (!moved.ok) return [dim(`  ${moved.why}`)];
  if (!moved.moved.length) return [dim("  Nothing moved since your last run.")];
  const out = [`  ${bold(`${count(moved.moved.length, "answer")} moved`)}   ${moved.better} better, ${moved.worse} worse`];
  for (const m of moved.moved.filter((x) => x.worse)) {
    out.push("", `  ${red("now worse")}   ${m.ask}`, dim(`              ${m.conversation}: ${m.was} became ${m.got}`));
  }
  // Moving in neither direction still has to be said, or a line reading "1 moved, 0 better, 0
  // worse" leaves a reader hunting for what it was.
  for (const m of moved.moved.filter((x) => !x.worse && !x.better)) {
    out.push("", `  ${bold(m.lost ? "no longer settled" : "now settled")}   ${m.ask}`, dim(`                    ${m.conversation}: ${m.was} became ${m.got}`));
  }
  if (moved.lost) out.push("", dim(`  ${count(moved.lost, "answer")} stopped being settled, which is not an improvement.`));
  return out;
};

export function report(result) {
  const { run, counted, rate: measured, moved, errors, scoped, traced, judge } = result;
  const out = [];
  for (const one of run.conversations) {
    const drawn = card(one);
    if (drawn) out.push(drawn);
  }
  out.push("", dim(RULE), "");

  if (errors.length) {
    out.push(`  ${bold(`${errors.length} of ${count(run.conversations.length, "conversation")} never got an answer`)}`);
    for (const e of errors.slice(0, 3)) out.push(dim(`    ${e.error}`));
    out.push("");
  }

  const answered = run.conversations.length - errors.length;
  const broken = run.conversations.filter((c) => c.ruled.some(failed)).length;
  if (answered === 0) {
    out.push(`  ${bold("Your app answered none of them, so nothing was tested.")}`);
  } else if (broken) {
    out.push(`  ${bold(`${broken} of ${count(answered, "conversation")} failed`)}, on ${count(counted.broke, "question")}.`);
  } else {
    out.push(`  ${green("Nothing failed")} across ${count(answered, "conversation")}.`);
  }

  if (measured.settled) {
    out.push(dim(`  ${measured.percent}% of questions held, give or take ${measured.plusMinus}, over ${count(measured.settled, "settled question")}.`));
  }
  if (counted.unknown || counted.absent) {
    const said = [];
    if (counted.unknown) said.push(`${count(counted.unknown, "question")} could not be settled`);
    if (counted.absent) said.push(`${count(counted.absent, "question")} did not come up`);
    out.push(dim(`  ${said.join(", ")}. Neither counts either way.`));
  }
  out.push(dim(`  Answered by ${judge.kind === "cortad" ? "Cortad" : judge.name}.`));

  out.push("", ...movedLines(moved));

  if (scoped) {
    out.push("", dim(`  Scoped to ${scoped.covered.map((c) => c.file).join(", ")}, so this covered ${count(run.conversations.length, "conversation")} and what moved is only about those.`));
  }
  if (!traced) {
    out.push("", dim("  Questions about what your app did read \"could not tell\" until it records what it"),
      dim("  does. One line in your dev server: import { record } from \"cortad/trace\"; record();"));
  }
  return out.join("\n");
}
