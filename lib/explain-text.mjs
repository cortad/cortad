// What --explain prints: the files a connect sends, grouped by the reason the AI layer (lib/layer.mjs)
// picked each one, so the list says why every file is in it. A count with no claim beside it: "only
// the code around your AI" above a login file read as a broken promise.
const WHY = {
  prompt: "Hold prompts",
  "model-call": "Call a model",
  "model-id": "Name the model the app calls",
  tool: "Define tools the model can call",
  rule: "Hold rules and limits the AI follows",
  route: "Are routes that reach the AI",
  reach: "Sit on the path from a route to a model call",
  mount: "Start the server those routes run on",
  shape: "Define what the AI code reads and returns",
  values: "Hold the values those routes accept",
  client: "Send requests to those routes",
  eval: "Are the app's evals",
  test: "Test the AI code",
  manifest: "List the app's packages",
  schema: "Define the data the app stores",
  readme: "Describe the app",
  i18n: "Hold the app's translated text",
  pricing: "Describe plans and pricing",
  sent: "Were sent with send",
};
const OTHER = "Picked for another reason";
const n = (x) => x.toLocaleString("en-US");

// Files the code reads into a model call whose path does not name them a prompt: a class list reads
// the same as one, so only the person sends them.
export const fedLine = (fed, spec = "cortad") => `Not sent: read into a model call; send it with \`npx -y ${spec} send <file>\` if it is a prompt (${n(fed.length)}): ${fed.join(", ")}`;

// `data`: files the parsers picked that are data (lib/layer.mjs evals among them), which never leave.
// `fed`: lib/layer.mjs's files read into a model call and not sent.
export function explainText({ files, why, data = [], fed = [] }, total) {
  const held = [...(fed.length ? [fedLine(fed)] : []), ...(data.length ? [`Not sent, since data files never leave (${n(data.length)}): ${data.join(", ")}`] : [])];
  if (!files.length) return [`A connect sends none of this folder's ${n(total)} files: no model call was found here.`, ...held].join("\n");
  const groups = new Map([...Object.values(WHY), OTHER].map((said) => [said, []]));
  for (const file of files) groups.get(WHY[why.get(file)] ?? OTHER).push(file);
  return [
    `A connect sends these ${n(files.length)} of this folder's ${n(total)} files, picked because they hold prompts, call a model, or sit on the path to one:`,
    ...[...groups].filter(([, list]) => list.length).map(([said, list]) => `${said} (${n(list.length)}): ${list.join(", ")}`),
    ...held,
  ].join("\n");
}
