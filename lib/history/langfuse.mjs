// The app's recent conversations as Langfuse holds them, read from this machine with the keys the app
// already has. The keys go to Langfuse's own address and nowhere else. A trace is one reply: the
// person's newest message and what the app answered; a Langfuse session is one conversation.
const PAGE = 100;
const MAX_TRACES = 3_000;

export const LANGFUSE = {
  id: "langfuse",
  name: "Langfuse",
  needs: ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"],
  hostOf: (env) => env.LANGFUSE_BASE_URL || env.LANGFUSE_HOST || env.LANGFUSE_BASEURL || "https://cloud.langfuse.com",
  read: readLangfuse,
};

// The text a person or the app wrote, from the shapes an app hands Langfuse: a string, a list of chat
// messages, an object holding one, or a provider's reply.
export function said(value, role) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const last = [...value].reverse().find((m) => m && typeof m === "object" && m.role === role);
    return last ? contentOf(last.content) : "";
  }
  if (value && typeof value === "object") {
    if (Array.isArray(value.messages)) return said(value.messages, role);
    if (role === "assistant" && Array.isArray(value.choices)) return contentOf(value.choices[0]?.message?.content);
    if (role === "assistant" && value.role === "assistant") return contentOf(value.content);
    for (const k of role === "user" ? ["input", "query", "question", "prompt", "message"] : ["output", "answer", "text", "content", "response"]) {
      if (typeof value[k] === "string") return value[k];
    }
  }
  return "";
}
const contentOf = (content) => (typeof content === "string" ? content
  : Array.isArray(content) ? content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("\n") : "");

export async function readLangfuse({ env, since, fetchImpl = fetch }) {
  const host = LANGFUSE.hostOf(env).replace(/\/+$/, "");
  const auth = `Basic ${Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString("base64")}`;
  const traces = [];
  for (let page = 1; traces.length < MAX_TRACES; page += 1) {
    const url = `${host}/api/public/traces?limit=${PAGE}&page=${page}&orderBy=timestamp.desc&fromTimestamp=${encodeURIComponent(since.toISOString())}`;
    const res = await fetchImpl(url, { headers: { authorization: auth }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 401 || res.status === 403) throw new Error(`${new URL(host).host} refused the LANGFUSE keys in your env`);
    if (!res.ok) throw new Error(`${new URL(host).host} answered ${res.status}`);
    const body = await res.json();
    traces.push(...(body.data ?? []));
    if ((body.data ?? []).length < PAGE || page >= (body.meta?.totalPages ?? page)) break;
  }
  const byConversation = new Map();
  let withoutText = 0;
  for (const t of traces) {
    const question = said(t.input, "user").trim();
    const answer = said(t.output, "assistant").trim();
    if (!question && !answer) { withoutText += 1; continue; }
    const id = t.sessionId || t.id;
    const held = byConversation.get(id) ?? { id, ...(t.userId ? { user: t.userId } : {}), messages: [] };
    const at = Date.parse(t.timestamp);
    if (question) held.messages.push({ role: "user", text: question, at: new Date(at).toISOString() });
    if (answer) held.messages.push({ role: "assistant", text: answer, at: new Date(at + 1).toISOString() });
    byConversation.set(id, held);
  }
  return { conversations: [...byConversation.values()], host: new URL(host).host, read: traces.length, withoutText };
}
