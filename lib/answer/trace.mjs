// Questions about what the app DID, settled from what the app itself recorded. A component can
// report success while the conversation still fails the person asking, and the only way to tell is
// to read the machine rather than the prose.
//
// With no trace the answer is "could not tell". Never a yes, never a no. A gate that passes because
// nothing was watching is the one failure a reader cannot catch by reading.
import { ABSENT, NO, UNKNOWN, YES } from "./verdict.mjs";

// What the recorder writes, one JSON object per line.
//   { at, kind: "tool" | "read" | "write" | "error", name, args }
export const KINDS = ["tool", "arg", "read", "wrote", "logged"];
export const kindOf = (question) => KINDS.find((k) => question[k] !== undefined) ?? null;

const named = (events, kind, name) =>
  events.filter((e) => e?.kind === kind && (name === true || name === undefined || e?.name === name));

const same = (held, want) => (typeof held === "object" ? JSON.stringify(held) === JSON.stringify(want) : held === want);

const ANSWERS = {
  tool: (q, events) => named(events, "tool", q.tool).length > 0,
  read: (q, events) => named(events, "read", q.read).length > 0,
  wrote: (_q, events) => named(events, "write", true).length > 0,
  logged: (_q, events) => named(events, "error", true).length > 0,
  arg: (q, events) => {
    const { tool, field, is } = q.arg ?? {};
    if (typeof tool !== "string" || typeof field !== "string") return null;
    return named(events, "tool", tool).some((e) => same(e?.args?.[field], is));
  },
};

const said = (kind, question, yes) => {
  const of = { tool: question.tool, read: question.read, arg: question.arg?.tool };
  const what = of[kind] ?? (kind === "wrote" ? "anything" : "an error");
  return yes ? `your app's own trace shows ${what}` : `nothing in your app's trace shows ${what}`;
};

export function decide(question, events) {
  const kind = kindOf(question);
  if (!kind) return { answer: ABSENT, quote: "", why: "this question names nothing in the trace" };
  if (!Array.isArray(events)) {
    return { answer: UNKNOWN, quote: "", why: "nothing was recorded, so what your app did is unknown. Add the one line from cortad/trace to your dev server" };
  }
  const found = ANSWERS[kind](question, events);
  if (found === null) return { answer: ABSENT, quote: "", why: `${kind} is not written in a way the trace can answer` };
  return { answer: found ? YES : NO, quote: "", why: said(kind, question, found) };
}
