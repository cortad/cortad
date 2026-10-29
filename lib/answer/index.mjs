// Which decider answers a question. The order is cheapest and surest first, and a model is asked
// only for what none of the others can settle.
import * as code from "./code.mjs";
import * as trace from "./trace.mjs";
import * as theirs from "./theirs.mjs";
import * as judge from "./judge.mjs";
import { UNKNOWN } from "./verdict.mjs";

export const BY = ["code", "trace", "mine", "judge"];

// A question that does not say who answers it is read from what it names, so a file can stay short.
export function byOf(question) {
  if (BY.includes(question?.by)) return question.by;
  if (trace.kindOf(question)) return "trace";
  if (code.kindOf(question)) return "code";
  if (typeof question?.fn === "string") return "mine";
  return "judge";
}

export async function answerAll(questions, { transcript, events, theirs: mine = {}, judge: whom }) {
  const routed = questions.map((q) => ({ question: q, by: byOf(q) }));
  const out = new Map();

  for (const { question, by } of routed) {
    if (by === "code") out.set(question.id, { ...code.decide(question, transcript), by });
    else if (by === "trace") out.set(question.id, { ...trace.decide(question, events), by });
    else if (by === "mine") out.set(question.id, { ...(await theirs.decide(question, mine, { transcript, events })), by });
  }

  // One call for every question left, and only if any are. A judge that is never asked cannot fail,
  // which is why the questions above are answered before it is reached.
  const forJudge = routed.filter(({ by }) => by === "judge").map(({ question }) => question);
  if (forJudge.length) {
    let ruled;
    try {
      ruled = await judge.decide(whom, transcript, forJudge);
    } catch (e) {
      // Not ABSENT. ABSENT means the conversation never raised the question, and it leaves the
      // count, so a judge that was down for the whole run used to report "Nothing failed" and exit
      // zero on an app that plainly broke its rules. Nothing decided this, which is UNKNOWN, and
      // `undecided` carries the reason up so the run can fail on it.
      for (const q of forJudge) out.set(q.id, { answer: UNKNOWN, quote: "", why: `the judge could not be reached: ${e.message}`, by: "judge", undecided: true });
      ruled = new Map();
    }
    for (const q of forJudge) {
      const found = ruled.get(q.id);
      if (found) out.set(q.id, { ...found, by: "judge" });
    }
  }

  return questions.map((q) => ({ question: q, ...out.get(q.id) }));
}

// The row a run keeps: the question flattened against the answer it got. Both run and replay write
// it, and a field added to one and not the other is a field replay silently drops.
export const asRuled = (answered) => answered.map((r) => ({
  id: r.question.id,
  ask: r.question.ask,
  wanted: r.question.answer,
  got: r.answer,
  quote: r.quote,
  why: r.why,
  by: r.by,
  // Set only when the decider itself failed, so a run can tell "nothing broke" from "nothing was
  // watching". Kept on the row so a replay of this run can tell them apart too.
  ...(r.undecided ? { undecided: true } : {}),
}));
