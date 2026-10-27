// After a fix: play the conversations that failed, and say whether the failure is gone. Only the
// ones that failed, because the question being asked is about the fix and not about the suite.
import { read } from "../suite/files.mjs";
import { last } from "../run.mjs";
import { UNKNOWN, ABSENT } from "../answer/verdict.mjs";

export const failedIn = (run) =>
  (run?.conversations ?? [])
    .filter((c) => c.error || c.ruled.some((r) => r.got !== r.wanted && r.got !== UNKNOWN && r.got !== ABSENT))
    .map((c) => c.id);

export function whatToVerify(root = ".") {
  const before = last(root);
  if (!before) return { kind: "nothing-kept" };
  const ids = failedIn(before);
  if (!ids.length) return { kind: "nothing-failed", before };
  const suite = read(root);
  const want = new Set(ids);
  return { kind: "ready", before, ids, simulations: suite.simulations.filter((s) => want.has(s.id)) };
}

// Whether each failure is gone, question by question, against the run it failed in.
export function held(before, now) {
  const was = new Map((before.conversations ?? []).flatMap((c) => (c.ruled ?? []).map((r) => [r.id, r])));
  const out = [];
  for (const one of now.conversations ?? []) {
    for (const r of one.ruled ?? []) {
      const first = was.get(r.id);
      if (!first) continue;
      const failedBefore = first.got !== first.wanted && first.got !== UNKNOWN && first.got !== ABSENT;
      if (!failedBefore) continue;
      out.push({ conversation: one.id, ask: r.ask, was: first.got, got: r.got, held: r.got === r.wanted });
    }
  }
  return out;
}
