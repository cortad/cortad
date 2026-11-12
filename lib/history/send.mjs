// What was selected, sent to Cortad in sends under 1 MiB each. A send Cortad already has is taken once: running this again sends only what is missing.
const MAX_BYTES = 900_000;
const MAX_CONVERSATIONS = 500;
const TRIES = 5;

// The sends, each one conversations that fit together. A conversation too large on its own keeps its
// newest messages that fit.
export function packed(source, conversations) {
  const sends = [];
  let held = [];
  let bytes = 0;
  const sizeOf = (c) => Buffer.byteLength(JSON.stringify(c)) + 1;
  for (const one of conversations) {
    let c = one;
    while (sizeOf(c) > MAX_BYTES - 200 && c.messages.length > 1) c = { ...c, messages: c.messages.slice(1) };
    const size = sizeOf(c);
    if (held.length > 0 && (bytes + size > MAX_BYTES - 200 || held.length >= MAX_CONVERSATIONS)) {
      sends.push({ source, conversations: held });
      held = [];
      bytes = 0;
    }
    held.push(c);
    bytes += size;
  }
  if (held.length > 0) sends.push({ source, conversations: held });
  return sends;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Each send in turn. A busy or failing Cortad is tried again a few times, longer each time; a refusal
// is said as Cortad said it, and what was already taken stays taken.
export async function sendAll(sends, { api, token, fetchImpl = fetch, wait = sleep }) {
  const total = { taken: 0, messages: 0, already: 0, old: 0, over: 0, left: null };
  for (const body of sends) {
    let answer = null;
    for (let attempt = 0; attempt < TRIES && !answer; attempt += 1) {
      let res;
      try {
        res = await fetchImpl(`${api}/mcp/history`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
      } catch {
        await wait(1_000 * 2 ** attempt);
        continue;
      }
      if (res.status === 429 || res.status >= 500) { await wait(1_000 * 2 ** attempt); continue; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ...total, refused: typeof data.error === "string" ? data.error : `Cortad answered ${res.status}` };
      answer = data;
    }
    if (!answer) return { ...total, refused: "Cortad did not answer after five tries. Run the same command again; what was taken stays taken." };
    for (const k of ["taken", "messages", "already", "old", "over"]) total[k] += Number(answer[k]) || 0;
    total.left = Number(answer.left);
  }
  return total;
}
