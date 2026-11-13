import { at, clip, has, modelSaid, num, plural, upper } from "./words.mjs";

// What `status` says between connect and a run: each endpoint a real request proved, with what the
// hook saw inside those requests; each endpoint the read found that no request has reached; what a
// run on the proven ones would be, and what it would write into. Every figure is one the agent can
// check against its own request or a line of the code. A field the API leaves out prints nothing.

const CARRIER = {
  body: (k) => `the body field "${k}"`,
  cookie: (k) => `the cookie "${k}"`,
  header: (k) => `the header "${k}"`,
  path: (k) => `the path segment {${k}}`,
  history: (k) => `the earlier messages the client sends in "${k}"`,
};
const where = (x) => (x?.file || x?.path ? `${at(x.file ?? x.path, x.line)}: ` : "");
const TIED = { sent: "the first request sent", got: "the first request got back" };

// A door whose answer came on a second request: that request, what tied the two, and what the client
// sent first in each turn, each as the agent's own requests showed it.
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

// A prompt with none of the rules is said with the file its call is made from, and whether Cortad
// read any rule there: "carried none" could not tell a gap in Cortad's read from one in the app.
// `inFile`, the rules read from that file, is said when the server sends it.
function rulesLine(r) {
  if (!r || !has(r.of) || r.of === 0) return null;
  if (!r.carried && r.at?.path && r.readThere === false) return `None of the ${plural(r.of, "rule")} Cortad read from your code are in the prompt this endpoint sent, and Cortad read no rule from ${r.at.path}, where the call is made; the prompt at ${at(r.at.path, r.at.line)} shows whether Cortad's read missed rules written there or your app sends this prompt without any.`;
  if (!r.carried && r.at?.path && r.readThere === true) return `The prompt this endpoint sent from ${at(r.at.path, r.at.line)} holds none of the ${has(r.inFile) ? `${plural(r.inFile, "rule")} ` : "rules "}Cortad read from that file.`;
  // A server from before `at` and `readThere` keeps its own words.
  const reader = "at" in r || "readThere" in r ? "Cortad read" : "read";
  const head = `The prompts carried ${r.carried ? num(r.carried) : "none"} of the ${plural(r.of, "rule")} ${reader} from your code`;
  const example = (r.examples ?? [])[0];
  return `${head}${example ? `, for example ${at(example.path, example.line)} "${clip(example.text, 160)}"` : ""}.`;
}

// Whose it is, as a sentence of its own: "Run waits, on the app's side:" read as a fault of the app's.
const WHOSE = { ours: "That is on Cortad's side, not your app's.", theirs: "That is in your app." };
// A door runs do not use yet, or one only Cortad's requests reached, and why.
function standingLine(v) {
  if (v.left) return "Left out of the run by choice: test with features naming it puts it back.";
  if (v.standing === "excluded") return `Runs leave this endpoint out: ${v.why}${WHOSE[v.side] ? ` ${WHOSE[v.side]}` : ""}`;
  if (v.standing === "fallback") return `Answered only Cortad's own requests: ${v.why}`;
  return null;
}

// Who the conversations through a signed-in endpoint act as: the customers the agent's requests signed in as.
const accountsLine = (n) => (!has(n) ? null : n > 1 ? `Conversations are split across ${num(n)} accounts, one for each customer your requests signed in as.` : "All conversations act as one account.");

// Where a trial takes each value the app's own client sets for its model.
const appFieldLine = (f) => (f.from === "app" ? `"${f.field}" is set by your app${f.path ? ` at ${f.path}` : ""}.` : `"${f.field}" is only in your agent's request.`);

// The message Cortad took from the last request, so a wrong field shows; the reply is the agent's
// own, already read, and ten of them were the longest part of one customer's status. One with no message
// found keeps a short reply to know it by.
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

// What a run would play, take and cost, in one short line the agent hands the person: how many
// simulated users, about how long, and one price on their own key. A first run's price is what it is
// expected to cost (`expected`, from factors measured on recorded first runs); the most it could cost,
// the follow-ups and the pace at one request at a time were three more numbers nobody acted on.
function readyLine(r) {
  if (!r || !r.trials) return null;
  const plays = `${plural(r.trials, "simulated user")}${r.reading ? " so far" : ""}`;
  const minutes = has(r.minutes) ? ` in about ${plural(r.minutes, "minute")}` : "";
  const key = `your ${r.provider ? `${r.provider} ` : ""}key`;
  const price = has(r.usd) ? `About $${(r.upTo && has(r.expected) ? r.expected : r.usd).toFixed(2)} on ${key}.` : `It runs on ${key}.`;
  return `A run plays ${r.most ? "up to " : ""}${plays}${minutes}. ${price}`;
}
// No rules is a fact of a finished read, said before a run is spent on general standards alone: said
// while the code is still being read, it was false a minute later.
const noRulesLine = (r) => (r?.trials && r.rules === 0 && !r.reading ? "No rules of your own were read from the code, so replies are checked against general standards only." : null);

// The endpoints no request has reached, as status lists them and reach sends them. `receipts`: doors
// the App section says answered at once with their answer out of Cortad's sight, so not said here.
// `retests`: the doors whose test failed, listed again to be sent once more: reach takes them, the
// list of endpoints no request reached does not.
export const unreached = (c, receipts = [], { retests = false } = {}) => {
  const answered = new Set(receipts.map((x) => x.door));
  // A feature the person left out of the run is owed no message: not listed, not sent (2026-10-24, "why send to all if I choose only two").
  return (c?.notCalled ?? []).filter((m) => !m.left && !answered.has(`${m.method} ${m.path}`) && (retests || !m.retest));
};

// One the server has no request for, or one listed on a field's name alone, is the agent's to send.
// `signIn` and `failed`: what Cortad's own test request met there, said as the server words it.
function unreachedLine(m) {
  const said = [m.excluded, m.signIn && `${m.signIn}.`, m.failed, !m.excluded && (m.unsure || m.byHand) ? "By hand." : "", m.byHand, m.why].filter(Boolean).join(" ");
  return `  ${m.method} ${m.path}${m.file ? `  ${at(m.file, m.line)}` : ""}${said ? `  ${said}` : ""}`;
}

// The connect command sends Cortad's own test request to each endpoint it holds one for, and again
// once the endpoint's file changes (lib/auto-reach.mjs); test with endpoints sends one at once. One
// Cortad holds no request for is the agent's to send; one that refused a visitor waits on an account.
function reachLine(missing) {
  const ours = missing.filter((m) => m.request && !m.unsure && !m.excluded && !m.signIn);
  const sending = ours.filter((m) => !m.failed).length;
  const yours = missing.filter((m) => !m.excluded && !m.signIn && !ours.includes(m)).length;
  const some = (n) => (n === missing.length ? "each one" : n === 1 ? "one of them" : `${num(n)} of them`);
  return [
    sending && `Cortad is sending ${some(sending)} its test request from this machine: look again in a minute, or call test with endpoints to send ${sending === 1 ? "it" : "them"} now.`,
    ours.length > sending && "Once a failure above is fixed, call test with endpoints to send its test request again.",
    yours && (yours === missing.length ? "Send each one message as a user would, signed in where your app needs it."
      : `${upper(some(yours))} ${yours === 1 ? "is" : "are"} yours: send ${yours === 1 ? "it" : "each"} one message as a user would, signed in where your app needs it.`),
  ].filter(Boolean).join(" ") || null;
}
// Cortad's own test request was refused there as a visitor. The account to sign in as is the person's
// to name, and so is leaving the endpoint out: the agent asked neither, and the card and the agent
// waited on each other for an hour (one customer, 2026-10-23).
function signInLine(missing) {
  const n = missing.filter((m) => m.signIn).length;
  if (!n) return null;
  return `${n === 1 ? "One of them refused" : `${num(n)} of them refused`} a visitor: ask the person for a test account to sign in as (an existing one; Cortad makes none), or whether to leave ${n === 1 ? "it" : "them"} out of the first run.`;
}
// Which AI features the first run tests is the person's choice, asked once there is a choice to make.
// `asked`: status asks it at its top (ASK), so it is not asked twice in one status.
const doorOf = (m) => m.door ?? `${m.method} ${m.path}`;
const CHOOSE = "Which of these the first run tests is the person's choice: ask them now with your question tool (in Claude Code, AskUserQuestion with multiSelect), one option a feature, and record the answer with test and features; or they tick them on the card in the browser.";
// While the choice is open it is the agent's next step, so status says it first and last. Under the
// endpoint list it was read after a long reply had already been written, and the person had to ask
// for the question.
export const ASK = "Your next step: ask the person which AI features the first run tests, in this same reply, with your question tool (in Claude Code, AskUserQuestion with multiSelect), one option a feature listed below, in plain words; with more than four, group related features, since that tool takes four options at most. Record the answer with test and features. Nothing is set up or started before the answer; the person can also tick them on the card in the browser.";
export const ASK_NEXT = "next: ask the person which AI features the first run tests with your question tool, then test with features";
function choiceLine(proven, notCalled, asked = false) {
  const doors = [...proven, ...notCalled].filter((m) => !m.excluded && !m.why);
  if (doors.length < 2) return null;
  const left = doors.filter((m) => m.left);
  return left.length ? `Left out of the first run by the person's choice: ${left.map(doorOf).join(", ")}. The rest are in.`
    : asked ? null : CHOOSE;
}
// A customer sent his one message, his app handed back a running turn, and this list went on naming
// his endpoint: he read it as his endpoint being broken. What Cortad is waiting for is said here, so
// the wait is the model's answer and not his question again.
const LATER_WAIT = "An endpoint that hands back a turn and answers afterwards stays on this list until Cortad has seen the answer its model wrote: the first reply alone does not take it off.";

// `data`: what the command did with the app's stores and services, said right under the run it is
// about, so what a run writes into for real is read before Run is pressed.
// Every feature the read lists, proven or not, that a run could test: the count a choice is asked over.
export const choosableOf = (c) => (c?.proven?.length ?? 0) + (c?.notCalled ?? []).filter((m) => !m.why && !m.excluded).length;
// The server asks for one message to each AI endpoint in its App line and again as the next step: it
// is said once, as the next step. While the person has features to choose from nothing is sent before
// they choose, so neither line asks; an older server still asked then.
const SENDS = /\s*Send one message to each AI endpoint\b.*$/s;
export const choosing = (d) => d.features === null && choosableOf(d.contact) > 1;
export function sendAskedOnce(d) {
  const open = choosing(d);
  const next = open && SENDS.test(d.next ?? "") ? undefined : d.next;
  if (!d.app?.said || !(open || SENDS.test(next ?? ""))) return { ...d, next };
  return { ...d, next, app: { ...d.app, said: d.app.said.replace(SENDS, "") } };
}
// `features`: the recorded choice, or null while nobody has chosen (undefined from an older server).
export function contactLines(c, data = [], receipts = [], features = undefined) {
  const said = data.map((s) => `Data: ${s}`);
  if (!c) return said;
  const proven = c.proven ?? [];
  // No request yet is said by the App line and by the next step, not a third time here. Endpoints
  // that all answered only Cortad's own test request say so once, over the list: sixteen of them
  // each said it under their own line, and the agent asked for a status it could read.
  const alike = proven.length > 1 && proven.every((v) => v.standing === "fallback") && new Set(proven.map((v) => v.why)).size === 1;
  const head = alike ? `Endpoints that answered Cortad's own test request (${num(proven.length)}); no request of your own has reached them yet:` : `Endpoints that answered (${num(proven.length)}):`;
  const lines = proven.length ? [head, ...proven.flatMap((v) => doorLines(alike ? { ...v, standing: null } : v))] : [];
  const missing = unreached(c, receipts);
  // Not "have not answered yet", which a customer read as his endpoint being broken: what is missing
  // is an answer Cortad has seen.
  const unchosen = features === null && choosableOf(c) > 1;
  if (missing.length) lines.push(`Endpoints found in your code that Cortad has seen no answer from yet (${num(missing.length)}):`, ...missing.map(unreachedLine), ...(unchosen
    ? ["Nothing is sent to these until the person chooses."]
    : [reachLine(missing), signInLine(missing), LATER_WAIT].filter(Boolean)));
  for (const line of [choiceLine(proven, c.notCalled ?? [], unchosen), readyLine(c.ready), noRulesLine(c.ready)]) if (line) lines.push(line);
  // What holds Run is the server's next line (src/local/contact.ts heldLine), said once: printed here
  // as well, one customer's hold on its Qdrant was read twice in one status.
  return [...lines, ...said];
}
