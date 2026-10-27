// A kept run, answered again, without touching the app. The transcripts and what the app recorded
// are already in the file, so this is how a finding gets argued with: change the question, or name a
// different judge, and see what the same conversation says then.
import { readFileSync } from "node:fs";
import { answerAll } from "../answer/index.mjs";
import { tally } from "../answer/verdict.mjs";
import { pickJudge } from "../answer/judge.mjs";
import { loadTheirs, QUESTIONS_FILE } from "../answer/theirs.mjs";
import { rate } from "../stats.mjs";
import { read } from "../suite/files.mjs";
import { join } from "node:path";
import { JUDGE_VERSION } from "./run.mjs";

export async function replay({ root = ".", at, judgeName }) {
  const kept = JSON.parse(readFileSync(at, "utf8"));
  const judge = pickJudge(judgeName);
  const theirs = await loadTheirs(join(root, QUESTIONS_FILE));
  const bySim = new Map(read(root).simulations.map((s) => [s.id, s]));

  const conversations = [];
  for (const one of kept.conversations ?? []) {
    const simulation = bySim.get(one.id);
    // A conversation whose simulation is gone keeps the answers it was given: there is nothing left
    // to ask of it, and dropping it would quietly shrink the run.
    if (!simulation || one.error) { conversations.push(one); continue; }
    const ruled = (await answerAll(simulation.questions, { transcript: one.transcript, events: one.events, theirs, judge })).map((r) => ({
      id: r.question.id, ask: r.question.ask, wanted: r.question.answer, got: r.answer, quote: r.quote, why: r.why, by: r.by,
    }));
    conversations.push({ ...one, ruled });
  }

  const counted = tally(conversations.flatMap((c) => c.ruled.map((r) => ({ question: { answer: r.wanted }, answer: r.got }))));
  const run = { ...kept, judge: judge.kind === "cortad" ? JUDGE_VERSION : judge.name, conversations };
  return {
    kind: "ran",
    run,
    counted,
    rate: rate(counted.held, counted.settled),
    moved: { ok: true, why: "", moved: [], better: 0, worse: 0, lost: 0 },
    scoped: null,
    traced: conversations.some((c) => Array.isArray(c.events)),
    errors: conversations.filter((c) => c.error),
    judge,
  };
}
