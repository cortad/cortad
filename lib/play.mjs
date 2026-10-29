// Sending a conversation to the app and keeping what came back. Nothing here knows what a check is.
import { randomUUID } from "node:crypto";
import { MESSAGE, MESSAGES, replyAt } from "./schema.mjs";
import { net } from "./net.mjs";

export const THREAD = "{{thread}}";

// A url as it may be written down: no user, no password, no query.
export function said(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

const holds = (endpoint, mark) => JSON.stringify(endpoint.body ?? null).includes(mark) || String(endpoint.url).includes(mark);

// Two shapes keep a conversation going: an endpoint that takes the whole turn list, and one that
// takes a single message and holds the history itself against a thread id. The second is the common
// production shape, and treating it as one turn put every probe in the frontal ask a current model
// bats away, which is not where support assistants break.
export const multiTurn = (endpoint) => holds(endpoint, MESSAGES) || holds(endpoint, THREAD);

export function fill(body, { message, messages, thread }) {
  if (typeof body === "string") {
    if (body === MESSAGES) return messages;
    return body.replaceAll(MESSAGE, message).replaceAll(THREAD, thread);
  }
  if (Array.isArray(body)) return body.map((v) => fill(v, { message, messages, thread }));
  if (body && typeof body === "object") return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, fill(v, { message, messages, thread })]));
  return body;
}

async function ask(endpoint, { message, messages, thread }, timeoutMs) {
  const filled = fill(endpoint.body, { message, messages, thread });
  const url = endpoint.url.replaceAll(THREAD, thread);
  const init = {
    method: endpoint.method,
    headers: { "content-type": "application/json", ...endpoint.headers },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (endpoint.method !== "GET") init.body = JSON.stringify(filled);
  let res;
  try {
    res = await net(url, init);
  } catch (e) {
    // Node's own message here is "fetch failed", which names neither the address nor the cause.
    // The address is printed without its userinfo or query, because an error goes to the console,
    // into the kept run, into JUnit and into SARIF, and the documented CI recipe uploads that SARIF
    // to GitHub as a code-scanning alert. A key in the url would be published by following the
    // README.
    const at = `${endpoint.method} ${said(url)}`;
    if (e.name === "TimeoutError") return { error: `${at} did not answer within ${Math.round(timeoutMs / 1000)}s.` };
    const code = e.cause?.code;
    return { error: `${at} is not answering${code ? ` (${code})` : ""}. Is your app up?` };
  }
  const text = await res.text();
  if (!res.ok) return { error: `your app answered ${res.status}: ${text.slice(0, 300)}` };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { reply: text.trim() || null, raw: text } ; }
  const reply = replyAt(parsed, endpoint.reply);
  if (reply === null) return { error: `no reply at ${endpoint.reply} in your app's answer: ${text.slice(0, 300)}` };
  return { reply, raw: text };
}

// One conversation played to its end. A turn that errors ends it: the error is the finding, and
// judging the turns before it would read as if the app had answered.
export async function playCase(endpoint, one, { timeoutMs = 60_000 } = {}) {
  const thread = randomUUID();
  const turns = multiTurn(endpoint) ? one.turns : one.turns.slice(0, 1);
  const sendsHistory = JSON.stringify(endpoint.body ?? null).includes(MESSAGES);
  const transcript = [];
  const history = [];
  // When the conversation started and ended, so what the app recorded while it answered can be
  // told apart from what it recorded for somebody else.
  const from = Date.now();
  for (const turn of turns) {
    transcript.push({ role: "user", text: turn });
    history.push({ role: "user", content: turn });
    const answer = await ask(endpoint, { message: turn, messages: sendsHistory ? history : [], thread }, timeoutMs).catch((e) => ({ error: e.message }));
    if (answer.error) return { id: one.id, title: one.title, transcript, error: answer.error, at: { from, to: Date.now() } };
    transcript.push({ role: "app", text: answer.reply });
    history.push({ role: "assistant", content: answer.reply });
  }
  return { id: one.id, title: one.title, transcript, at: { from, to: Date.now() } };
}

// `at` is how many conversations are in flight, so an app with one worker is not the thing being
// measured. One, while a trace is being recorded: events are matched to a conversation by the
// clock, and overlapping conversations cannot be told apart.
export async function playAll(endpoint, cases, { at = 4, onDone = () => {}, timeoutMs } = {}) {
  const left = [...cases];
  const played = [];
  const worker = async () => {
    for (let one = left.shift(); one; one = left.shift()) {
      const result = await playCase(endpoint, one, { timeoutMs });
      played.push(result);
      onDone(result, played.length, cases.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(at, cases.length) }, worker));
  return cases.map((c) => played.find((p) => p.id === c.id)).filter(Boolean);
}
