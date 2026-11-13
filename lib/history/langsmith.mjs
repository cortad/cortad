import { said } from "./langfuse.mjs";
import { answered, grouped, rootOf, threadIn, userIn } from "./vendor.mjs";

const PAGE = 100;
const MAX_RUNS = 3_000;
const SELECTS = ["ID", "START_TIME", "INPUTS", "OUTPUTS", "METADATA", "THREAD_ID"];

export const LANGSMITH = {
  id: "langsmith",
  name: "LangSmith",
  needs: ["LANGSMITH_API_KEY"],
  hostOf: (env) => env.LANGSMITH_ENDPOINT || env.LANGCHAIN_ENDPOINT || "https://api.smith.langchain.com",
  read: readLangSmith,
};

const ROLE_OF_TYPE = { human: "user", HumanMessage: "user", ai: "assistant", AIMessage: "assistant", AIMessageChunk: "assistant" };

export function asChat(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.messages)) return value;
  return {
    ...value,
    messages: value.messages.map((m) => {
      if (!m || typeof m !== "object" || m.role) return m;
      const role = ROLE_OF_TYPE[m.type === "constructor" ? m.id?.at(-1) : m.type];
      return role ? { role, content: m.kwargs?.content ?? m.content } : m;
    }),
  };
}

export async function readLangSmith({ env, since, fetchImpl = fetch }) {

  const root = rootOf(LANGSMITH.hostOf(env)).replace(/\/api(?:\/v1)?$/, "");
  const host = new URL(root).host;
  const headers = { "x-api-key": env.LANGSMITH_API_KEY, ...(env.LANGSMITH_WORKSPACE_ID ? { "x-tenant-id": env.LANGSMITH_WORKSPACE_ID } : {}) };
  const ask = (path, init = {}) => answered(fetchImpl, `${root}${path}`, { ...init, headers: { ...headers, ...init.headers } }, "LANGSMITH");

  const name = env.LANGSMITH_PROJECT || env.LANGCHAIN_PROJECT || "default";
  const project = (await ask(`/api/v1/sessions?name=${encodeURIComponent(name)}`)).find((p) => p.name === name);
  if (!project) throw new Error(`${host} has no project named ${name}`);

  const runs = [];
  for (let cursor = null; runs.length < MAX_RUNS;) {
    const body = { project_ids: [project.id], is_root: true, min_start_time: since.toISOString(), page_size: PAGE, selects: SELECTS, ...(cursor ? { cursor } : {}) };
    const page = await ask("/api/v2/runs/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    runs.push(...(page.items ?? []));
    cursor = page.next_cursor;
    if (!cursor) break;
  }
  const { conversations, withoutText } = grouped(runs.map((run) => ({
    conversation: run.thread_id || threadIn(run.metadata) || run.id,
    user: userIn(run.metadata),
    at: run.start_time,
    question: said(asChat(run.inputs), "user"),
    answer: said(asChat(run.outputs), "assistant"),
  })));
  return { conversations, host, read: runs.length, withoutText };
}
