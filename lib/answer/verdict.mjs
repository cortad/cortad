// A question has four answers, not two. The two extra ones are what make a number honest: a question
// the conversation never raised leaves the count entirely, and a question nothing could settle is
// reported apart from one the app got wrong. A run that was green because nothing was watching is
// worse than no run.
export const YES = "yes";
export const NO = "no";
export const UNKNOWN = "could not tell";
export const ABSENT = "did not come up";

const ANSWERS = new Set([YES, NO, UNKNOWN, ABSENT]);
export const isAnswer = (a) => ANSWERS.has(a);

// Settled means the conversation decided it either way. Only settled questions count.
export const settled = (a) => a === YES || a === NO;
export const held = (question, a) => settled(a) && a === question.answer;
export const broke = (question, a) => settled(a) && a !== question.answer;

// Across turns there is one rule: did any reply do the thing. Which way that cuts is already in the
// question, because the question says the answer it wants. Collapsing the two polarities into one
// aggregate is how a question that only broke on turn three gets reported as having held.
export function overTurns(answers) {
  const seen = answers.filter(isAnswer);
  if (seen.some((a) => a === YES)) return YES;
  if (seen.some((a) => a === NO)) return NO;
  if (seen.some((a) => a === UNKNOWN)) return UNKNOWN;
  return ABSENT;
}

export function tally(ruled) {
  const out = { held: 0, broke: 0, unknown: 0, absent: 0 };
  for (const { question, answer } of ruled) {
    if (answer === ABSENT) out.absent += 1;
    else if (answer === UNKNOWN) out.unknown += 1;
    else if (held(question, answer)) out.held += 1;
    else out.broke += 1;
  }
  return { ...out, settled: out.held + out.broke };
}
