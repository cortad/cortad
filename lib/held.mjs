// The run's requests this command is holding open at your app, by the bus job that asked for each.
// A request the run gives up on (its wait ran out, or the run ended) is let go here as well, so
// your app is not left working for nobody. music-store-support (2026-09-29, job 1c7500f0) is a
// Gradio app, whose queue serves one event at a time: the run's requests stayed open after it had
// stopped waiting, and the agent's own test chat waited five minutes behind them.
//
// An app's own queue can keep a request after its caller leaves. The hook in the app sees it: a
// model call that started after its request was let go, for a request the app was not already at
// work on, in an app never seen working on two requests at once. That is said once, with how many
// were let go with it and had not reached the model yet, the most that can still be ahead of
// anything sent.
const TOGETHER_MS = 10_000;

export function makeHeld({ rows = () => [], say = () => {}, now = Date.now, everyMs = 2000 } = {}) {
  const open = new Map();
  const dropped = new Map();
  let settled = false;
  let timer = null;

  const startOf = (r) => r.at - (r.ms ?? 0);
  // Two requests' model calls under way at once: your app serves requests side by side, so what it
  // goes on with after a cancel is its own work, never a queue ahead of the next request.
  const sideBySide = (calls) => calls.some((a) => calls.some((b) => a.turn !== b.turn && startOf(a) <= startOf(b) && startOf(b) < a.at));
  const settle = () => { settled = true; clearInterval(timer); };
  const check = () => {
    if (settled) return;
    const tagged = rows().filter((r) => typeof r?.turn === "string");
    if (sideBySide(tagged)) return settle();
    const calls = tagged.filter((r) => dropped.has(r.turn));
    // A request your app was already at work on goes on to its next model call with or without a queue.
    const working = new Set(calls.filter((r) => startOf(r) < dropped.get(r.turn)).map((r) => r.turn));
    const taken = calls.find((r) => !working.has(r.turn) && startOf(r) >= dropped.get(r.turn));
    if (!taken) return;
    settle();
    // Let go together with the one taken up, and not already at work when they were.
    const at = dropped.get(taken.turn);
    const n = [...dropped].filter(([turn, t]) => Math.abs(t - at) <= TOGETHER_MS && !working.has(turn)).length;
    say(n > 1
      ? `your app took up a request after the simulation cancelled it: its own queue keeps requests after the caller leaves, so up to ${n} the simulation cancelled may be ahead of anything sent to your app until they are done or your app restarts`
      : "your app took up a request after the simulation cancelled it: its own queue keeps requests after the caller leaves, so anything sent to your app waits behind it until it is done or your app restarts");
  };

  return {
    // A request going out for bus job `id`, tagged with the run's `turn`: the signal that lets it go.
    hold(id, turn) {
      const stop = new AbortController();
      open.set(id, { stop, turn });
      return stop.signal;
    },
    done(id) { open.delete(id); },
    // Lets go of the requests of these jobs that are still open; how many were.
    letGo(ids) {
      let n = 0;
      for (const id of ids) {
        const held = open.get(id);
        if (!held) continue;
        open.delete(id);
        held.stop.abort(new Error("cancelled by the simulation"));
        if (held.turn) dropped.set(held.turn, now());
        n += 1;
      }
      if (n && !settled && !timer) { timer = setInterval(check, everyMs); timer.unref?.(); }
      return n;
    },
    check,
  };
}
