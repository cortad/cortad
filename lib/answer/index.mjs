// Which of the four deciders answers a question. Code first, then the app's own trace, then their
// own function, and a model only for what none of those can settle.
import * as code from "./code.mjs";
import * as trace from "./trace.mjs";
import * as theirs from "./theirs.mjs";
import * as judge from "./judge.mjs";
import { ABSENT } from "./verdict.mjs";

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
  const of = questions.map((q) => ({ question: q, by: byOf(q) }));
  const out = new Map();

  for (const { question, by } of of) {
    if (by === "code") out.set(question.id, { ...code.decide(question, transcript), by });
    else if (by === "trace") out.set(question.id, { ...trace.decide(question, events), by });
    else if (by === "mine") out.set(question.id, { ...(await theirs.decide(question, mine, { transcript, events })), by });
  }

  // One call for every question left, and only if any are. A judge that is never asked cannot fail,
  // which is why the questions above are answered before it is reached.
  const forJudge = of.filter(({ by }) => by === "judge").map(({ question }) => question);
  if (forJudge.length) {
    let ruled;
    try {
      ruled = await judge.decide(whom, transcript, forJudge);
    } catch (e) {
      for (const q of forJudge) out.set(q.id, { answer: ABSENT, quote: "", why: `the judge could not be reached: ${e.message}`, by: "judge" });
      ruled = new Map();
    }
    for (const q of forJudge) {
      const found = ruled.get(q.id);
      if (found) out.set(q.id, { ...found, by: "judge" });
    }
  }

  return questions.map((q) => ({ question: q, ...out.get(q.id) }));
}
