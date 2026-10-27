// The bodies real chat routes take, in the order they are worth trying. The AI SDK's turn-of-parts
// is first because it is the most common thing a new app is built on, and OpenAI's shape is next
// because everything that proxies a model speaks it.
import { MESSAGE } from "../schema.mjs";

export const SHAPES = [
  { name: "the AI SDK's turn of parts", body: { messages: [{ id: "1", role: "user", parts: [{ type: "text", text: MESSAGE }] }] } },
  { name: "a turn list", body: { messages: [{ role: "user", content: MESSAGE }] } },
  { name: "one message", body: { message: MESSAGE } },
  { name: "a prompt", body: { prompt: MESSAGE } },
  { name: "text", body: { text: MESSAGE } },
  { name: "input", body: { input: MESSAGE } },
  { name: "a query", body: { query: MESSAGE } },
  { name: "a question", body: { question: MESSAGE } },
  { name: "content", body: { content: MESSAGE } },
];

// Where a reply sits in an answer: the longest string in it, by dotted keys and array indexes. A
// chat route's reply is the longest string it returns, and asking the person for the path was asking
// them to read their own code back to us.
export function replyPathOf(answer, at = []) {
  if (typeof answer === "string") return answer.trim().length > 0 ? { path: at.join("."), length: answer.length } : null;
  if (Array.isArray(answer)) {
    return answer.map((v, i) => replyPathOf(v, [...at, i])).filter(Boolean).sort((a, b) => b.length - a.length)[0] ?? null;
  }
  if (answer && typeof answer === "object") {
    return Object.entries(answer).map(([k, v]) => replyPathOf(v, [...at, k])).filter(Boolean).sort((a, b) => b.length - a.length)[0] ?? null;
  }
  return null;
}
