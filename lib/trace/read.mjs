// Reading the trace back, and deciding which events belong to which turn.
//
// ponytail: events are matched to a turn by the clock, between the moment the request went out and
// the moment the reply came back. Both processes are on the same machine, so the clock is the same
// clock. It also means conversations cannot overlap while tracing, which is why a traced run plays
// one at a time. A correlation id would lift that, and it would have to be threaded through their
// own code, which is more than one line.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { TRACE_FILE } from "./record.mjs";

export const tracing = (file = TRACE_FILE) => existsSync(file);

export function clear(file = TRACE_FILE) {
  if (existsSync(file)) writeFileSync(file, "");
}

export function events(file = TRACE_FILE) {
  if (!existsSync(file)) return null;
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a half-written line at the tail of a live file */ }
  }
  return out;
}

export const between = (all, from, to) =>
  Array.isArray(all) ? all.filter((e) => Number(e?.at) >= from && Number(e?.at) <= to) : null;

// Which of their files a run reached, read off what the app recorded rather than off the suite. A
// conversation that names a tool it never calls does not cover the file that tool lives in.
export function filesReached(conversations) {
  const out = new Map();
  for (const one of conversations) {
    for (const e of one.events ?? []) {
      const at = typeof e?.from === "string" ? e.from.split(":")[0] : null;
      if (!at) continue;
      if (!out.has(at)) out.set(at, new Set());
      out.get(at).add(one.id);
    }
  }
  return out;
}
