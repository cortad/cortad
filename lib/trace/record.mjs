// One line in their dev server, and a question about what the app DID can be answered by code
// instead of guessed by a model. It records outbound calls, anything they mark as a tool, and error
// lines, with the file that made the call, and nothing else. No proxy, no sandbox, no agent.
//
//   import { record } from "cortad/trace";
//   record();
//
// It appends JSON lines to cortad/trace.jsonl. The file is theirs to read, and deleting it loses
// nothing.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const TRACE_FILE = "cortad/trace.jsonl";

// Which of their files made the call. Frame zero is this function and frame one is the wrapper, so
// frame two is theirs.
function from(depth = 2) {
  const held = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (_e, frames) => frames;
    const frames = new Error().stack;
    const at = Array.isArray(frames) ? frames[depth] : null;
    const named = at?.getFileName?.();
    if (!named) return null;
    // A module loaded as ESM names itself with a file:// url, not a path.
    const file = named.startsWith("file://") ? fileURLToPath(named) : named;
    if (!file.startsWith("/") || file.includes("node_modules")) return null;
    return `${relative(process.cwd(), file)}:${at.getLineNumber?.() ?? 0}`;
  } catch {
    return null;
  } finally {
    Error.prepareStackTrace = held;
  }
}

let writing = null;

function put(event) {
  if (!writing) return;
  try {
    appendFileSync(writing, `${JSON.stringify(event)}\n`);
  } catch { /* a trace that cannot be written costs the run its trace questions, never the run */ }
}

// Marked by hand, for the things no wrapper can see: their own tool functions.
export const tool = (name, args) => put({ at: Date.now(), kind: "tool", name, args, from: from() });
export const read = (name) => put({ at: Date.now(), kind: "read", name, from: from() });
export const wrote = (name) => put({ at: Date.now(), kind: "write", name, from: from() });
export const failed = (message) => put({ at: Date.now(), kind: "error", name: String(message).slice(0, 500), from: from() });

// An outbound call is a tool whether or not they called it one: a model, a store, a payment, a
// search. The host is the name, because that is what a question is written about.
function wrapFetch() {
  const held = globalThis.fetch;
  if (!held || held.__cortad) return;
  const wrapped = async (input, init) => {
    const url = typeof input === "string" ? input : input?.url ?? "";
    let host = "";
    try { host = new URL(url).host; } catch { host = ""; }
    const where = from(2);
    const at = Date.now();
    try {
      const res = await held(input, init);
      put({ at, kind: res.ok ? "tool" : "error", name: host || url.slice(0, 200), args: { status: res.status }, from: where });
      return res;
    } catch (e) {
      put({ at, kind: "error", name: host || url.slice(0, 200), args: { message: e.message }, from: where });
      throw e;
    }
  };
  wrapped.__cortad = true;
  globalThis.fetch = wrapped;
}

export function record({ file = TRACE_FILE } = {}) {
  writing = file;
  try {
    mkdirSync(dirname(file), { recursive: true });
    // The file is made now, empty, not on the first event. Its presence is how a run knows this app
    // is recording: waiting for an event means the first run of a new app is told nothing was
    // watching when something was.
    appendFileSync(file, "");
  } catch { /* same as above */ }
  wrapFetch();
  return { tool, read, wrote, failed };
}
