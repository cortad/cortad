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

export const fedLine = (fed, spec = "cortad") => `Not sent: read into a model call; send it with \`npx -y ${spec} send <file>\` if it is a prompt (${n(fed.length)}): ${fed.join(", ")}`;

const HELD = { secret: "a line in it sets a password, key or code", personal: "it holds a personal detail: a contact, an id, or a person's health or family note", access: "it guards sign-in, admin or paid access, which a simulation does not need" };

export function explainText({ files, why, data = [], fed = [], held: screened = [] }, total) {
  const kinds = Object.entries(HELD).map(([kind, said]) => [said, screened.filter((h) => h.why === kind).map((h) => h.path)]).filter(([, list]) => list.length);
  const held = [
    ...(fed.length ? [fedLine(fed)] : []),
    ...kinds.map(([said, list]) => `Not sent, since ${said} (${n(list.length)}): ${list.join(", ")}`),
    ...(data.length ? [`Not sent, since data files never leave (${n(data.length)}): ${data.join(", ")}`] : []),
  ];
  if (!files.length) return [`A connect sends none of this folder's ${n(total)} files: no model call was found here.`, ...held].join("\n");
  const groups = new Map([...Object.values(WHY), OTHER].map((said) => [said, []]));
  for (const file of files) groups.get(WHY[why.get(file)] ?? OTHER).push(file);
  return [
    `A connect sends these ${n(files.length)} of this folder's ${n(total)} files, picked because they hold prompts, call a model, or sit on the path to one:`,
    ...[...groups].filter(([, list]) => list.length).map(([said, list]) => `${said} (${n(list.length)}): ${list.join(", ")}`),
    ...held,
  ].join("\n");
}
