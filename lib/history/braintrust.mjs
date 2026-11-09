import { said } from "./langfuse.mjs";
import { answered, grouped, msOf, rootOf, threadIn, userIn } from "./vendor.mjs";

// The app's recent conversations as Braintrust logged them, read with the key the app already has,
// sent to Braintrust's own API and nowhere else. The project comes from GET /v1/project, its logs
// from POST /v1/project_logs/{project_id}/fetch with the cursor each page hands back (Braintrust API
// reference, "Fetch project logs"). A trace's root span is one reply.
const PAGE = 100;
const MAX_TRACES = 3_000;

export const BRAINTRUST = {
  id: "braintrust",
  name: "Braintrust",
  needs: ["BRAINTRUST_API_KEY"],
  hostOf: (env) => env.BRAINTRUST_API_URL || "https://api.braintrust.dev",
  read: readBraintrust,
};

// The project to read: BRAINTRUST_PARENT as Braintrust's OpenTelemetry exporter takes it, else
// BRAINTRUST_PROJECT. An app that names its project in code has neither.
export function projectIn(env) {
  const [kind, ...rest] = (env.BRAINTRUST_PARENT ?? "").split(":");
  const value = rest.join(":");
  if (kind === "project_id" && value) return { id: value };
  if (kind === "project_name" && value) return { name: value };
  return env.BRAINTRUST_PROJECT ? { name: env.BRAINTRUST_PROJECT } : {};
}

const isRoot = (event) => event.is_root ?? !event.span_parents?.length;

// Braintrust's OpenAI wrapper logs a reply as the completion's choices.
const replyOf = (output) => (Array.isArray(output) ? output.map((choice) => choice?.message ?? choice) : output);

export async function readBraintrust({ env, since, fetchImpl = fetch }) {
  const root = rootOf(BRAINTRUST.hostOf(env));
  const host = new URL(root).host;
  const headers = { authorization: `Bearer ${env.BRAINTRUST_API_KEY}`, "content-type": "application/json" };
  const ask = (path, init = {}) => answered(fetchImpl, `${root}${path}`, { ...init, headers }, "BRAINTRUST");
  const id = await projectId(ask, env, host);

  const roots = [];
  const seen = new Set();
  const from = since.getTime();
  for (let cursor = null; roots.length < MAX_TRACES;) {
    const body = JSON.stringify({ limit: PAGE, ...(cursor ? { cursor } : {}) });
    const page = await ask(`/v1/project_logs/${encodeURIComponent(id)}/fetch`, { method: "POST", body });
    const events = page.events ?? [];
    // A later page can give a row again at an older version; the first seen is the newest.
    for (const event of events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      if (isRoot(event) && msOf(event.created) >= from) roots.push(event);
    }
    cursor = page.cursor;
    // ponytail: pages run newest change first, so a page of only older rows ends the read and a bulk
    // edit of old logs would end it early. POST /btql with a created filter is exact if that matters.
    if (!cursor || events.every((event) => msOf(event.created) < from)) break;
  }
  const { conversations, withoutText } = grouped(roots.map((event) => ({
    conversation: threadIn(event.metadata) || event.root_span_id,
    user: userIn(event.metadata),
    at: event.created,
    question: said(event.input, "user"),
    answer: said(replyOf(event.output), "assistant"),
  })));
  return { conversations, host, read: roots.length, withoutText };
}

async function projectId(ask, env, host) {
  const wanted = projectIn(env);
  if (wanted.id) return wanted.id;
  const org = env.BRAINTRUST_ORG_NAME ? `&org_name=${encodeURIComponent(env.BRAINTRUST_ORG_NAME)}` : "";
  if (wanted.name) {
    const { objects } = await ask(`/v1/project?project_name=${encodeURIComponent(wanted.name)}${org}`);
    const project = objects?.find((p) => p.name === wanted.name);
    if (!project) throw new Error(`${host} has no project named ${wanted.name}`);
    return project.id;
  }
  // With no project named, the one project the key sees is the app's.
  const { objects = [] } = await ask(`/v1/project?limit=2${org}`);
  if (objects.length === 1) return objects[0].id;
  throw new Error(objects.length ? "the key in your env sees more than one Braintrust project; set BRAINTRUST_PROJECT to the one to read" : `${host} has no project for the key in your env`);
}
