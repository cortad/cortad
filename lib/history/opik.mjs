import { said } from "./langfuse.mjs";
import { answered, grouped, rootOf, userIn } from "./vendor.mjs";

// The app's recent conversations as Opik traced them, read with the key the app already has, sent to
// Opik's own API and nowhere else. Traces, one reply each and newest first, come from GET
// /v1/private/traces by page (Opik REST API, "Get traces by project_name or project_id").
const PAGE = 100;
const MAX_TRACES = 3_000;

export const OPIK = {
  id: "opik",
  name: "Opik",
  needs: ["OPIK_API_KEY", "OPIK_WORKSPACE"],
  hostOf: (env) => env.OPIK_URL_OVERRIDE || "https://www.comet.com/opik/api",
  read: readOpik,
};

// Experiments, the playground, optimizers and evaluators write traces too; the app's own say "sdk".
const fromTheApp = (trace) => !trace.source || trace.source === "sdk";

export async function readOpik({ env, since, fetchImpl = fetch }) {
  const root = rootOf(OPIK.hostOf(env));
  const headers = { authorization: env.OPIK_API_KEY, "Comet-Workspace": env.OPIK_WORKSPACE };
  const project = env.OPIK_PROJECT_NAME || "Default Project";
  const traces = [];
  for (let page = 1; traces.length < MAX_TRACES; page += 1) {
    // Attachments stay references; only the text is read.
    const query = new URLSearchParams({ project_name: project, page: String(page), size: String(PAGE), from_time: since.toISOString(), strip_attachments: "true" });
    const body = await answered(fetchImpl, `${root}/v1/private/traces?${query}`, { headers }, "OPIK");
    const content = body.content ?? [];
    traces.push(...content);
    if (content.length < PAGE) break;
  }
  const { conversations, withoutText } = grouped(traces.filter(fromTheApp).map((trace) => ({
    conversation: trace.thread_id || trace.id,
    user: userIn(trace.metadata),
    at: trace.start_time,
    question: said(trace.input, "user"),
    answer: said(trace.output, "assistant"),
  })));
  return { conversations, host: new URL(root).host, read: traces.length, withoutText };
}
