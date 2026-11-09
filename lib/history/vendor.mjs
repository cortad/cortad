// What the history readers share: the vendor's address checked before a key goes to it, its JSON
// answer with a busy answer waited out, and its records made into conversations.
const LOCAL = new Set(["localhost", "127.0.0.1"]);
const TRIES = 4;
const MAX_WAIT_MS = 30_000;
const THREAD_KEYS = ["thread_id", "session_id", "conversation_id"];

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// An address a vendor's key may go to: https, or http to this computer only.
export function addressOf(raw) {
  const url = URL.canParse(raw) ? new URL(raw) : null;
  if (!url || url.username || url.password) throw new Error("an address in your env is not a plain URL");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL.has(url.hostname))) throw new Error(`${url.host} is not reached over https`);
  return url;
}

// The API's root with no trailing slash, query or fragment, for paths to join onto.
export function rootOf(raw) {
  const url = addressOf(raw);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

// The vendor's JSON. A 429 is tried again a few times, after as long as the vendor asks (up to 30
// seconds) or longer each time. `keys` names whose keys went with the request; a signed URL carries none.
export async function answered(fetchImpl, url, init, keys) {
  const { host } = new URL(url);
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(30_000) });
    if (res.status === 429 && attempt < TRIES) { await sleep(waitOf(res, attempt)); continue; }
    if (keys && (res.status === 401 || res.status === 403)) throw new Error(`${host} refused the ${keys} keys in your env`);
    if (!res.ok) throw new Error(`${host} answered ${res.status}`);
    return res.json();
  }
}

function waitOf(res, attempt) {
  const seconds = Number(res.headers.get("retry-after") || Number.NaN);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_WAIT_MS) : 1000 * 2 ** (attempt - 1);
}

// The conversation and the person an app named in a record's metadata, if it named them.
export const threadIn = (metadata) => THREAD_KEYS.map((k) => metadata?.[k]).find((v) => typeof v === "string" && v) ?? null;
export const userIn = (metadata) => (typeof metadata?.user_id === "string" && metadata.user_id) || null;

// A vendor's time in milliseconds. Every vendor here keeps UTC, and Helicone writes it with no zone.
export const msOf = (time) => Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(time) ? time : `${String(time).replace(" ", "T")}Z`);

const isoOf = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// Turns as conversations. A turn is one record: the person's newest message and the app's reply, the
// reply a millisecond later so the two keep their order. A turn with neither is counted, not kept.
export function grouped(turns) {
  const byConversation = new Map();
  let withoutText = 0;
  for (const turn of turns) {
    const question = turn.question.trim();
    const answer = turn.answer.trim();
    if (!question && !answer) { withoutText += 1; continue; }
    const held = byConversation.get(turn.conversation) ?? { id: turn.conversation, messages: [] };
    if (!held.user && turn.user) held.user = turn.user;
    const at = msOf(turn.at);
    if (question) held.messages.push({ role: "user", text: question, at: isoOf(at) });
    if (answer) held.messages.push({ role: "assistant", text: answer, at: isoOf(at + 1) });
    byConversation.set(turn.conversation, held);
  }
  return { conversations: [...byConversation.values()], withoutText };
}
