// After a fix: play the conversations that failed, and say whether the failure is gone. Only the
// ones that failed, because the question being asked is about the fix and not about the suite.
import { last } from "../run.mjs";
import { failed } from "../answer/verdict.mjs";

export const failedIn = (run) =>
  (run?.conversations ?? [])
    .filter((c) => c.error || c.ruled.some(failed))
    .map((c) => c.id);

export function whatToVerify(root = ".") {
  const before = last(root);
  if (!before) return { kind: "nothing-kept" };
  const ids = failedIn(before);
  if (!ids.length) return { kind: "nothing-failed", before };
  return { kind: "ready", before, ids };
}

// Whether each failure is gone, question by question, against the run it failed in.
export function held(before, now) {
  const was = new Map((before.conversations ?? []).flatMap((c) => (c.ruled ?? []).map((r) => [r.id, r])));
  const out = [];
  for (const one of now.conversations ?? []) {
    for (const r of one.ruled ?? []) {
      const first = was.get(r.id);
      if (!first || !failed(first)) continue;
      out.push({ conversation: one.id, ask: r.ask, was: first.got, got: r.got, held: r.got === r.wanted });
    }
  }
  return out;
}
