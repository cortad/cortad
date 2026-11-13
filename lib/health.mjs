import { connect } from "node:net";

const FLOOR_MS = 10_000;
const CAP_MS = 120_000;
const ASK_EVERY_MS = 60_000;
const url = (host, port) => `http://${host === "::1" ? "[::1]" : host}:${port}/`;

export const portHeld = (host, port, ms = 3000) => new Promise((done) => {
  const socket = connect({ host, port });
  const end = (held) => { socket.destroy(); done(held); };
  socket.once("connect", () => end(true));
  socket.once("error", (e) => end(e.code !== "ECONNREFUSED"));
  socket.setTimeout(ms, () => end(true));
});

export function makeHealth({ host, gone, inFlight, askEveryMs = ASK_EVERY_MS, now = Date.now }) {
  let took = 0;
  let askedAt = -Infinity;
  let last = "up";
  const timeout = () => Math.min(CAP_MS, Math.max(FLOOR_MS, took * 3));
  const state = (s) => (last = s);
  return {
    timeout,

    async check(port) {
      if (gone()) return state("exited");
      if (!(await portHeld(host(), port))) return state("released");
      if (last === "up" && now() - askedAt < askEveryMs) return "up";
      const started = now();
      askedAt = started;
      try {
        const res = await fetch(url(host(), port), { method: "HEAD", signal: AbortSignal.timeout(timeout()), redirect: "manual" });
        await res.body?.cancel();
        took = now() - started;
        return state("up");
      } catch {
        return state(inFlight() > 0 ? "busy" : "quiet");
      }
    },
  };
}

export function downLine(state, { port, downMs, crashed = false }) {
  if (crashed) return "your app crashed, starting it again";
  if (state === "exited") return "your app exited, starting it again";
  if (state === "released") return `nothing is listening on port ${port} any more, starting your app again`;
  return `your app has not answered for ${Math.round(downMs / 1000)} seconds while no test conversation was waiting on it, starting it again`;
}
