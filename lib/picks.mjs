import { homeOf, projectOf } from "./home.mjs";
import { mailbox } from "./mailbox.mjs";
import { readRunner } from "./runner.mjs";

export const SEND = mailbox("send");

const SEND_MS = 180_000;

const NEEDS = [
  { name: "prompts", why: ["prompt", "rule"], line: "Every prompt and prompt template the AI uses, so simulated users test the app's real instructions." },
  { name: "model calls", why: ["model-call", "model-id"], line: "Every place the code calls a model, so Cortad knows which AI features exist." },
  { name: "routes", why: ["route", "reach", "mount", "shape", "values", "client", "schema"], line: "The routes that reach those calls, with their request and reply shapes, so simulated users can talk to the app." },
  { name: "tools", why: ["tool"], line: "Tool definitions, so tool use is tested." },
  { name: "evals", why: ["eval", "test"], line: "Eval cases, so simulated users cover what the team already checks." },
];
const REFUSED = "Env files, keys, files git ignores and data files are refused.";
const needOf = (why) => NEEDS.find((n) => n.why.includes(why))?.name ?? null;

const SPEC_PATH = /(?:^|\/)(?:cortad\/[^/]+|[^/]*spec[^/]*)\.(?:md|mdx|txt)$/i;
export const isSpec = (f) => SPEC_PATH.test(f);
const SPEC_LINE = "Or, to keep the code on this machine, write cortad/spec.md: each AI route with its request and reply shapes, the tools the model can call, and how the AI should behave. Cortad reads it in place of the code, and sees the prompts as the app sends them to its model during a simulation.";

export const needsText = (spec = "cortad") => [
  "You pick the files Cortad gets, and none has been sent yet. Cortad needs:",
  ...NEEDS.map((n, i) => `${i + 1}. ${n.line}`),
  SPEC_LINE,
  `Show the person your list, then send only those files. ${REFUSED}`,
  `next: npx -y ${spec} send <file> <file> ...`,
].join("\n");

const fileLines = (files, why) => files.map((f) => `- ${f}: ${isSpec(f) ? "describes your AI in words: its routes, request shapes, tools and rules" : needOf(why.get(f)) ? `covers ${needOf(why.get(f))}` : "covers none of the five"}`);
const refusedLines = (refused) => (refused.length ? ["Refused, and never sent:", ...refused.map((r) => `- ${r.arg}: ${r.why}`)] : []);
const quoted = (f) => (/^[\w./@+-]+$/.test(f) ? f : `'${f.replace(/'/g, "'\\''")}'`);

export function previewText({ files, all, why, prompts = 0, refused, go = false, spec = "cortad" }) {
  if (!files.length) return [...refusedLines(refused), go ? "Nothing was sent." : "Nothing would be sent.", `next: npx -y ${spec} status`].join("\n");
  const covered = new Set([...all.map((f) => needOf(why.get(f))), ...(prompts ? ["prompts"] : [])]);
  const missing = all.some(isSpec) ? [] : NEEDS.filter((n) => !covered.has(n.name)).map((n) => n.name);
  return [
    `Cortad would get ${files.length === 1 ? "this file" : `these ${files.length} files`}:`,
    ...fileLines(files, why),
    ...refusedLines(refused),
    ...(missing.length ? [`Nothing in the set covers ${missing.length > 1 ? `${missing.slice(0, -1).join(", ")} or ${missing.at(-1)}` : missing[0]}. Send those too if the app has them.`] : []),
    "Show the person this list. On their yes:",
    `next: npx -y ${spec} send --yes ${files.map(quoted).join(" ")}`,
  ].join("\n");
}

export function sentText({ files, all, why, refused, studied, spec = "cortad" }) {
  return [
    `Sent ${files.length === 1 ? "1 file" : `${files.length} files`}. Cortad now has ${all.length === 1 ? "1 file" : `${all.length} files`} from this folder${studied ? ", and is studying your AI from them" : ", and has studied them already"}.`,
    ...fileLines(files, why),
    ...refusedLines(refused),
    `next: npx -y ${spec} status`,
  ].join("\n");
}

export async function send(args, { root, spec = "cortad", waitMs = SEND_MS }) {
  const go = args.includes("--yes");
  const files = args.filter((a) => a !== "--yes");
  if (!files.length) return { text: `Name the files: npx -y ${spec} send <file> <file> ...\nNothing was sent.`, code: 1 };
  const project = projectOf(root);
  const runner = readRunner(project);
  if (!runner) return { text: `Nothing was sent: no Cortad connect is running in this folder. Start it as a background command: npx -y ${spec} --agent-picks -- <how you start your app>`, code: 1 };
  const got = await SEND.ask(homeOf(project), { files, go, spec }, { waitMs });
  return got ?? { text: `The connect command has not answered in ${waitMs / 1000} seconds; its own output says what happened.\nnext: npx -y ${spec} status`, code: 1 };
}
