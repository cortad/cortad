import { at, clip, has, modelSaid, num, plural, upper } from "./words.mjs";

const CARRIER = {
  body: (k) => `the body field "${k}"`,
  cookie: (k) => `the cookie "${k}"`,
  header: (k) => `the header "${k}"`,
  path: (k) => `the path segment {${k}}`,
  history: (k) => `the earlier messages the client sends in "${k}"`,
};
const where = (x) => (x?.file || x?.path ? `${at(x.file ?? x.path, x.line)}: ` : "");
const TIED = { sent: "the first request sent", got: "the first request got back" };

function secondStepLine(s) {
  if (!s?.request) return null;
  const tie = s.tie?.key && TIED[s.tie.from] ? `, tied by the "${s.tie.key}" ${TIED[s.tie.from]}` : "";
  const before = s.before?.length ? `; each turn first sent ${s.before.join(", ")}` : "";
  return `The answer came on a second request, ${s.request}${tie}${before}.`;
}

function sessionLine(v) {
  const s = v.session;
  if (!s || !(v.requests > 1)) return null;
  if (!s.held) return "No later request's prompt carried an earlier one.";
  const by = CARRIER[s.carrier] && s.key ? CARRIER[s.carrier](s.key) : "nothing the request sent, so every caller shares what the app keeps";
  return `A later request's prompt carried an earlier one, tied by ${by}.`;
}

function rulesLine(r) {
  if (!r || !has(r.of) || r.of === 0) return null;
  if (!r.carried && r.at?.path && r.readThere === false) return `None of the ${plural(r.of, "rule")} Cortad found in your code are in the prompt this endpoint sent, and Cortad found no rule in ${r.at.path}, where the call is made; the prompt at ${at(r.at.path, r.at.line)} shows whether Cortad missed rules written there or your app sends this prompt without any.`;
  if (!r.carried && r.at?.path && r.readThere === true) return `The prompt this endpoint sent from ${at(r.at.path, r.at.line)} holds none of the ${has(r.inFile) ? `${plural(r.inFile, "rule")} ` : "rules "}Cortad found in that file.`;

  const reader = "at" in r || "readThere" in r ? "Cortad found" : "found";
  const head = `The prompts carried ${r.carried ? num(r.carried) : "none"} of the ${plural(r.of, "rule")} ${reader} in your code`;
  const example = (r.examples ?? [])[0];
  return `${head}${example ? `, for example ${at(example.path, example.line)} "${clip(example.text, 160)}"` : ""}.`;
}

const WHOSE = { theirs: "That is in your app." };

function standingLine(v) {
  if (v.left) return "Left out of the simulation by choice: test with features naming it puts it back.";
  if (v.standing === "excluded") return `Simulations leave this endpoint out: ${v.why}${WHOSE[v.side] ? ` ${WHOSE[v.side]}` : ""}`;
  if (v.standing === "fallback") return `Answered only Cortad's own requests: ${v.why}`;
  return null;
}

const accountsLine = (n) => (!has(n) ? null : n > 1 ? `Conversations are split across ${num(n)} accounts, one for each customer your requests signed in as.` : "All conversations act as one account.");

const appFieldLine = (f) => (f.from === "app" ? `"${f.field}" is set by your app${f.path ? ` at ${f.path}` : ""}.` : `"${f.field}" is only in your agent's request.`);

function sampleLine(s) {
  if (!s?.reply) return null;
  const cut = s.cut ? "; the reply stopped before it finished" : "";
  return s.ask ? `Last message: "${clip(s.ask, 160)}"${cut}.` : `Last reply: "${clip(s.reply, 80)}"${cut}.`;
}

function doorLines(v) {
  const reached = `${plural(v.requests, "request")} reached ${v.model ? modelSaid(v.model) : "the model"}`;
  const calls = has(v.modelCallsPerRequest) ? `, ${plural(v.modelCallsPerRequest, "model call")} each` : "";
  const seconds = has(v.replySeconds) ? `, ${v.replySeconds} seconds a reply` : "";
  const lines = [`  ${v.door}: ${reached}${calls}${seconds}.`];
  const inner = [
    standingLine(v),
    v.askField ? `The message goes in "${v.askField}".` : null,
    ...(v.appFields ?? []).map(appFieldLine),
    secondStepLine(v.secondStep),
    v.later ? "Your app takes the message at once and its model answers afterwards; Cortad grades the model's last answer to each message." : null,
    sessionLine(v),
    accountsLine(v.accounts),
    ...(v.checks ?? []).map((said) => `Cortad's test conversation here: ${said}`),
    rulesLine(v.rules),
    v.tools?.length ? `Tools that ran: ${v.tools.join(", ")}.` : null,
    v.passages ? `Passages handed to the model: ${num(v.passages)}.` : null,
    ...(v.problems ?? []).map((p) => `Problem${where(p) ? ` at ${where(p)}` : ": "}${p.said}`),
    sampleLine(v.sample),
  ];
  return [...lines, ...inner.filter(Boolean).map((l) => `    ${l}`)];
}

function readyLine(r) {
  if (!r || !r.trials) return null;
  const plays = `${plural(r.trials, "simulated user")}${r.reading ? " so far" : ""}`;
  const minutes = has(r.minutes) ? ` in about ${plural(r.minutes, "minute")}` : "";
  const key = `your ${r.provider ? `${r.provider} ` : ""}key`;
  const price = has(r.usd) ? `About $${(r.upTo && has(r.expected) ? r.expected : r.usd).toFixed(2)} on ${key}.` : `It runs on ${key}.`;
  return `A simulation plays ${r.most ? "up to " : ""}${plays}${minutes}. ${price}`;
}

const noRulesLine = (r) => (r?.trials && r.rules === 0 && !r.reading ? "No rules of your own were found in the code, so replies are checked against general standards only." : null);

export const unreached = (c, receipts = [], { retests = false } = {}) => {
  const answered = new Set(receipts.map((x) => x.door));

  return (c?.notCalled ?? []).filter((m) => !m.left && !answered.has(`${m.method} ${m.path}`) && (retests || !m.retest));
};

function unreachedLine(m) {
  const said = [m.excluded, m.signIn && `${m.signIn}.`, m.failed, !m.excluded && (m.unsure || m.byHand) ? "By hand." : "", m.byHand, m.why].filter(Boolean).join(" ");
  return `  ${m.method} ${m.path}${m.file ? `  ${at(m.file, m.line)}` : ""}${said ? `  ${said}` : ""}`;
}

function reachLine(missing) {
  const ours = missing.filter((m) => m.request && !m.unsure && !m.excluded && !m.signIn);
  const sending = ours.filter((m) => !m.failed).length;
  const yours = missing.filter((m) => !m.excluded && !m.signIn && !ours.includes(m)).length;
  const some = (n) => (n === missing.length ? "each one" : n === 1 ? "one of them" : `${num(n)} of them`);
  return [
    sending && `Cortad sends ${some(sending)} its test message from this machine; you have nothing to do for ${sending === 1 ? "it" : "them"}.`,
    ours.length > sending && "Once a failure above is fixed, call test with endpoints to send its test request again.",
    yours && (yours === missing.length ? "Send each one message as a user would, signed in where your app needs it."
      : `${upper(some(yours))} ${yours === 1 ? "is" : "are"} yours: send ${yours === 1 ? "it" : "each"} one message as a user would, signed in where your app needs it.`),
  ].filter(Boolean).join(" ") || null;
}

function signInLine(missing) {
  const n = missing.filter((m) => m.signIn).length;
  if (!n) return null;
  return `${n === 1 ? "One of them refused" : `${num(n)} of them refused`} a visitor: ask the person first, with your question tool and the yes option first, whether Cortad may make one test account on the app's own sign-up or sign a token with the JWT secret in its env, kept in ~/.cortad on this machine; on their yes, call test with account make. The other options: an existing account to sign in as, or leaving ${n === 1 ? "it" : "them"} out of the first simulation.`;
}

const doorOf = (m) => m.door ?? `${m.method} ${m.path}`;
const CHOOSE = "Which of these the first simulation tests is the person's choice: ask them now with your question tool (in Claude Code, AskUserQuestion with multiSelect), one option a feature, and record the answer with test and features; or they tick them on the card in the browser.";

export const ASK = "Your next step: ask the person which AI features the first simulation tests, in this same reply, with your question tool (in Claude Code, AskUserQuestion with multiSelect), one option a feature listed below, in plain words; with more than four, group related features, since that tool takes four options at most. Record the answer with test and features. Nothing is set up or started before the answer; the person can also tick them on the card in the browser.";
export const ASK_NEXT = "next: ask the person which AI features the first simulation tests with your question tool, then test with features";
function choiceLine(proven, notCalled, asked = false) {
  const doors = [...proven, ...notCalled].filter((m) => !m.excluded && !m.why);
  if (doors.length < 2) return null;
  const left = doors.filter((m) => m.left);
  return left.length ? `Left out of the first simulation by the person's choice: ${left.map(doorOf).join(", ")}. The rest are in.`
    : asked ? null : CHOOSE;
}

const LATER_WAIT = "An endpoint that hands back a turn and answers afterwards stays on this list until Cortad has seen the answer its model wrote: the first reply alone does not take it off.";

export const choosableOf = (c) => (c?.proven?.length ?? 0) + (c?.notCalled ?? []).filter((m) => !m.why && !m.excluded).length;

const SENDS = /\s*Send one message to each AI endpoint\b.*$/s;
export const choosing = (d) => d.features === null && choosableOf(d.contact) > 1;
const cortadSends = (c) => unreached(c).some((m) => m.request && !m.unsure && !m.excluded && !m.signIn && !m.failed);
export function sendAskedOnce(d) {
  const open = choosing(d) || cortadSends(d.contact);
  const next = open && SENDS.test(d.next ?? "") ? undefined : d.next;
  if (!d.app?.said || !(open || SENDS.test(next ?? ""))) return { ...d, next };
  return { ...d, next, app: { ...d.app, said: d.app.said.replace(SENDS, "") } };
}

export function contactLines(c, data = [], receipts = [], features = undefined) {
  const said = data.map((s) => `Data: ${s}`);
  if (!c) return said;
  const proven = c.proven ?? [];

  const alike = proven.length > 1 && proven.every((v) => v.standing === "fallback") && new Set(proven.map((v) => v.why)).size === 1;
  const head = alike ? `Endpoints that answered Cortad's own test request (${num(proven.length)}); no request of your own has reached them yet:` : `Endpoints that answered (${num(proven.length)}):`;
  const lines = proven.length ? [head, ...proven.flatMap((v) => doorLines(alike ? { ...v, standing: null } : v))] : [];
  const missing = unreached(c, receipts);

  const unchosen = features === null && choosableOf(c) > 1;
  if (missing.length) lines.push(`Endpoints found in your code that Cortad has seen no answer from yet (${num(missing.length)}):`, ...missing.map(unreachedLine), ...(unchosen
    ? ["Nothing is sent to these until the person chooses."]
    : [reachLine(missing), signInLine(missing), LATER_WAIT].filter(Boolean)));
  for (const line of [choiceLine(proven, c.notCalled ?? [], unchosen), readyLine(c.ready), noRulesLine(c.ready)]) if (line) lines.push(line);

  return [...lines, ...said];
}
