// The two calls this tool makes to Cortad. Both are anonymous, both are optional, and both are off
// under CORTAD_OFFLINE. What each one sends is printed before it is sent.
import { installId } from "./install.mjs";

export const ORIGIN = () => process.env.CORTAD_ORIGIN ?? "https://open.cortad.com";
export const offline = () => process.env.CORTAD_OFFLINE === "1";

const TIMEOUT_MS = 120_000;

class HostedError extends Error {
  constructor(message, { status, retryAfter } = {}) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function post(path, body, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(`${ORIGIN()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cortad-install": installId() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new HostedError(`could not reach ${ORIGIN()}: ${e.message}`);
  }
  const text = await res.text();
  if (res.status === 429) {
    const seconds = Number(res.headers.get("retry-after")) || 0;
    throw new HostedError("today's free runs on this machine are used up", { status: 429, retryAfter: seconds });
  }
  if (!res.ok) throw new HostedError(`${path} answered ${res.status}: ${text.slice(0, 200)}`, { status: res.status });
  try { return JSON.parse(text); } catch { throw new HostedError(`${path} did not answer with JSON`); }
}

// Conversations written for this app from its own rules. Nothing of their code is sent: the schema
// is all this takes, whoever wrote it.
export async function writeUsers(schema, count, fetchImpl) {
  const answer = await post("/users", { schema, count }, fetchImpl);
  if (!Array.isArray(answer?.cases) || answer.cases.length === 0) throw new HostedError("no conversations came back");
  // A conversation with no questions on it is the older shape, from before a question had an answer.
  // Saying so beats reading as a crash in this command.
  if (!answer.cases.every((one) => Array.isArray(one?.questions))) {
    throw new HostedError(`${ORIGIN()} answered in an older shape than this command reads. Update it: npm i -g cortad@latest`);
  }
  return answer.cases;
}

// One answer per question, each with the sentence of the reply it was answered from.
export async function judgeQuestions(transcript, questions, fetchImpl) {
  const answer = await post("/judge", { transcript, questions: questions.map((q) => ({ id: q.id, ask: q.ask })) }, fetchImpl);
  if (!Array.isArray(answer?.answers)) throw new HostedError("no answers came back");
  return answer.answers;
}

// One verdict per check, each with the sentence of the reply it rests on.
export async function judge(transcript, checks, fetchImpl) {
  const answer = await post("/judge", { transcript, checks }, fetchImpl);
  if (!Array.isArray(answer?.rulings)) throw new HostedError("no rulings came back");
  return answer.rulings;
}

export { HostedError };
