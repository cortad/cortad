// What the change did. The only comparison worth printing is the same questions put to the same
// people: anything else is two different measurements with an arrow drawn between them.
import { broke, held, settled } from "./answer/verdict.mjs";

const byQuestion = (run) => new Map((run?.conversations ?? []).flatMap((c) => (c.ruled ?? []).map((r) => [r.id, { ...r, who: c.who, conversation: c.id }])));

// Two runs are comparable when they asked the same thing and the same judge answered. Our own judge
// changes; a trend drawn across that change would be ours, printed as theirs.
export function comparable(now, before) {
  if (!before) return { ok: false, why: "this is the first run kept here, so there is nothing to compare it to" };
  if (before.suite !== now.suite) return { ok: false, why: "the simulations changed since the last run, so the two are not a before and an after" };
  if (before.judge !== now.judge) return { ok: false, why: `the last run was answered by ${before.judge} and this one by ${now.judge}, so the two are not a before and an after` };
  return { ok: true, why: "" };
}

export function delta(now, before) {
  const fit = comparable(now, before);
  if (!fit.ok) return { ...fit, moved: [], better: 0, worse: 0 };
  const was = byQuestion(before);
  const moved = [];
  for (const [id, after] of byQuestion(now)) {
    const first = was.get(id);
    if (!first || first.got === after.got) continue;
    const question = { answer: after.wanted };
    moved.push({
      ...after,
      was: first.got,
      better: broke(question, first.got) && held(question, after.got),
      worse: held(question, first.got) && broke(question, after.got),
      // A question that stopped being settled is not an improvement, however it reads in a count.
      lost: settled(first.got) && !settled(after.got),
    });
  }
  return {
    ok: true,
    why: "",
    moved,
    better: moved.filter((m) => m.better).length,
    worse: moved.filter((m) => m.worse).length,
    lost: moved.filter((m) => m.lost).length,
  };
}
