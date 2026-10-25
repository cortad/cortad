// Sending a conversation to the app and keeping what came back. Nothing here knows what a check is.
import { randomUUID } from "node:crypto";
import { MESSAGE, replyAt, withMessage } from "./schema.mjs";

export const MESSAGES = "{{messages}}";
export const THREAD = "{{thread}}";

const holds = (body, mark) => JSON.stringify(body ?? null).includes(mark);
export const multiTurn = (endpoint) => holds(endpoint.body, MESSAGES);

function fill(body, { message, messages, thread }) {
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
  const res = await fetch(url, init);
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
  const transcript = [];
  const history = [];
  for (const turn of turns) {
    transcript.push({ role: "user", text: turn });
    history.push({ role: "user", content: turn });
    const answer = await ask(endpoint, { message: turn, messages: history, thread }, timeoutMs).catch((e) => ({ error: e.message }));
    if (answer.error) return { id: one.id, title: one.title, transcript, error: answer.error };
    transcript.push({ role: "app", text: answer.reply });
    history.push({ role: "assistant", content: answer.reply });
  }
  return { id: one.id, title: one.title, transcript };
}

// Conversations run a few at a time so a run does not read as a queue, and so an app with one
// worker is not the thing being measured.
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
