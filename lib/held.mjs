const TOGETHER_MS = 10_000;

export function makeHeld({ rows = () => [], say = () => {}, now = Date.now, everyMs = 2000 } = {}) {
  const open = new Map();
  const dropped = new Map();
  let settled = false;
  let timer = null;

  const startOf = (r) => r.at - (r.ms ?? 0);

  const sideBySide = (calls) => calls.some((a) => calls.some((b) => a.turn !== b.turn && startOf(a) <= startOf(b) && startOf(b) < a.at));
  const settle = () => { settled = true; clearInterval(timer); };
  const check = () => {
    if (settled) return;
    const tagged = rows().filter((r) => typeof r?.turn === "string");
    if (sideBySide(tagged)) return settle();
    const calls = tagged.filter((r) => dropped.has(r.turn));

    const working = new Set(calls.filter((r) => startOf(r) < dropped.get(r.turn)).map((r) => r.turn));
    const taken = calls.find((r) => !working.has(r.turn) && startOf(r) >= dropped.get(r.turn));
    if (!taken) return;
    settle();

    const at = dropped.get(taken.turn);
    const n = [...dropped].filter(([turn, t]) => Math.abs(t - at) <= TOGETHER_MS && !working.has(turn)).length;
    say(n > 1
      ? `your app took up a request after the simulation cancelled it: its own queue keeps requests after the caller leaves, so up to ${n} the simulation cancelled may be ahead of anything sent to your app until they are done or your app restarts`
      : "your app took up a request after the simulation cancelled it: its own queue keeps requests after the caller leaves, so anything sent to your app waits behind it until it is done or your app restarts");
  };

  return {

    hold(id, turn) {
      const stop = new AbortController();
      open.set(id, { stop, turn });
      return stop.signal;
    },
    done(id) { open.delete(id); },

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
