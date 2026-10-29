// One run, from the simulations on disk to what moved since the last one.
import { answerAll } from "../answer/index.mjs";
import { tally } from "../answer/verdict.mjs";
import { pickJudge } from "../answer/judge.mjs";
import { coverage, reaching } from "../changed.mjs";
import { delta } from "../delta.mjs";
import { playAll } from "../play.mjs";
import { rate } from "../stats.mjs";
import { read, suiteKey } from "../suite/files.mjs";
import { inRun } from "../suite/tiers.mjs";
import { loadTheirs, QUESTIONS_FILE } from "../answer/theirs.mjs";
import { between, clear, events as traceEvents, tracing } from "../trace/read.mjs";
import * as runs from "../run.mjs";
import { join } from "node:path";

export const JUDGE_VERSION = "cortad/2026-10";

const asPlay = (one) => ({ id: one.id, title: one.who, turns: one.says });

export function chooseSuite({ simulations, plays, changed, only, lastRun }) {
  // Named outright, which is what verify does: the ones that failed, whatever tier they sit in.
  if (only?.length) {
    const want = new Set(only);
    return { playing: simulations.filter((s) => want.has(s.id)), scoped: null };
  }
  if (changed?.length) {
    const found = reaching(lastRun, changed);
    const want = new Set(found.ids);
    return { playing: simulations.filter((s) => want.has(s.id)), scoped: found };
  }
  return { playing: simulations.filter((s) => inRun(s, plays)), scoped: null };
}

export async function run({ root = ".", schema, plays = "smoke", changed = null, only = null, judgeName, onDone = () => {} }) {
  const suite = read(root);
  if (suite.problems.length) return { kind: "problems", problems: suite.problems };
  if (!suite.simulations.length) return { kind: "empty" };

  const judge = pickJudge(judgeName);
  const lastRun = runs.last(root);
  const { playing, scoped } = chooseSuite({ simulations: suite.simulations, plays, changed, only, lastRun });
  if (!playing.length) return { kind: "nothing", scoped, plays };

  const traced = tracing(join(root, "cortad", "trace.jsonl"));
  if (traced) clear(join(root, "cortad", "trace.jsonl"));

  const played = await playAll(schema.endpoint, playing.map(asPlay), { at: traced ? 1 : 4, onDone });
  const all = traced ? traceEvents(join(root, "cortad", "trace.jsonl")) : null;
  const theirs = await loadTheirs(join(root, QUESTIONS_FILE));
  const bySim = new Map(playing.map((s) => [s.id, s]));

  const conversations = [];
  for (const one of played) {
    const simulation = bySim.get(one.id);
    const mine = all && one.at ? between(all, one.at.from, one.at.to) : null;
    const ruled = one.error
      ? []
      : (await answerAll(simulation.questions, { transcript: one.transcript, events: mine, theirs, judge })).map((r) => ({
          id: r.question.id,
          ask: r.question.ask,
          wanted: r.question.answer,
          got: r.answer,
          quote: r.quote,
          why: r.why,
          by: r.by,
        }));
    conversations.push({ id: one.id, who: simulation.who, transcript: one.transcript, events: mine, error: one.error ?? null, ruled });
  }

  const counted = tally(conversations.flatMap((c) => c.ruled.map((r) => ({ question: { answer: r.wanted }, answer: r.got }))));
  const run = {
    judge: judge.kind === "cortad" ? JUDGE_VERSION : judge.name,
    suite: suiteKey(suite.simulations),
    plays: changed?.length ? "changed" : plays,
    conversations,
  };
  return {
    kind: "ran",
    run,
    at: runs.write(run, root),
    counted,
    rate: rate(counted.held, counted.settled),
    moved: delta(run, lastRun),
    scoped,
    traced,
    reached: coverage(run),
    errors: conversations.filter((c) => c.error),
    judge,
  };
}
