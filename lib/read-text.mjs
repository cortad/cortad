import { at, clip, has, num, pack, pageOf, plural, SIDE } from "./words.mjs";

export const SHOW = ["rules", "standards", "journeys", "endpoints", "trials", "records", "reviews", "machine"];

const rulesHead = (rules) => {
  const files = Array.isArray(rules.files) ? rules.files.length : rules.files;
  return `Rules in the code: ${num(rules.count)}${has(files) ? `, in ${plural(files, "file")}` : ""}.`;
};

const measuredOf = (m) => (m === null ? "; asked of no reply yet" : m ? `; asked of ${plural(m.asked, "reply", "replies")}, passed in ${num(m.held)}${m.asked > m.held ? `, broke in ${num(m.asked - m.held)}` : ""}` : "");
const ruleLine = (e) => `  ${e.path ? `${at(e.path, e.line)}  ` : ""}"${clip(e.text, 300)}"${"measured" in e ? measuredOf(e.measured) : ""}`;
const headOf = (label, parts) => (parts.some(Boolean) ? `${label}: ${parts.filter(Boolean).join(", ")}.` : `${label}:`);

const standardsHead = (m) => (!has(m.met) || !(m.met + (m.missed ?? 0)) ? "Engineering standards:"
  : m.missed ? `Engineering standards: your code misses ${num(m.missed)} of the ${num(m.decided ?? m.met + m.missed)} Cortad standards${has(m.problems) ? `, through ${plural(m.problems, "problem")}` : ""}.`
    : `Engineering standards: your code meets all ${num(m.met)} Cortad standards.`);
const REVIEWED_CODE = "The Cortad team reviewed the code around your model by hand instead of grading it against these standards, and status with show reviews lists what it found.";
const decided = (x) => (x.decidedBy ? ` (decided by ${x.decidedBy === "code" ? "code" : "a model"})` : "");

const designed = (x) => (x.byDesign ? `\n    By design here, per ${x.byDesign.at}: "${clip(x.byDesign.said, 200)}"` : "");
const standardLine = (x) => Array.isArray(x.standards)
  ? `  ${x.path ? `${at(x.path, x.line)}  ` : ""}${clip(x.problem, 240)}${decided(x)}${x.fix ? `\n    ${clip(x.fix, 300)}` : ""}\n    ${x.standards.length === 1 ? "Fails" : `Fails ${num(x.standards.length)}`}: ${x.standards.join("; ")}${designed(x)}`
  : `  ${x.path ? `${at(x.path, x.line)}  ` : ""}${x.standard}${x.detail ? `: ${clip(x.detail, 240)}` : ""}${decided(x)}`;

const trialsHead = (t) => headOf("Conversations", [has(t.written) && `${num(t.written)} written`]);
const heldWhy = (h) => `${SIDE[h.side] ? `, ${SIDE[h.side]}` : ""}${h.why ? `: ${clip(h.why, 300)}` : ""}`;
const named = (label, group, max = 12) => {
  if (!group) return null;
  const names = group.names ?? [];
  const more = (group.count ?? names.length) - Math.min(names.length, max);

  const list = names.slice(0, max).join("; ");
  return `${label} (${num(group.count ?? names.length)})${list ? `: ${list}${more > 0 ? `; and ${more} more` : ""}` : ""}.`;
};

const counted = (label, count, n) => `${label} (${num(count ?? n)})${has(count) && n < count ? `, ${num(n)} listed` : ""}:`;

const recordLines = (records) => (records?.collections ?? []).filter((c) => c?.name && c.examples?.length)
  .map((c) => `  ${c.name}: ${c.examples.slice(0, 3).map((e) => clip(e, 40)).join(", ")}`);

export function readLines(r) {
  const lines = ["What Cortad found in your code:"];
  if (r.rules) {
    const examples = (r.rules.examples ?? []).slice(0, 3);

    const ran = has(r.rules.measured);
    lines.push(`${rulesHead(r.rules)}${examples.length ? ` ${examples.length} of them:` : ""}`, ...examples.map((e) => ruleLine(ran ? e : { text: e.text, path: e.path, line: e.line })));
  }
  for (const line of [named("Journeys", r.journeys), named("Simulated users", r.profiles)]) if (line) lines.push(line);
  const m = r.machine;
  if (m && (m.met || m.missed || (m.misses ?? []).length)) {

    lines.push(`${standardsHead(m)}${m.missed || (m.misses ?? []).length ? " Each problem is listed by status with show standards." : ""}`);
  }
  if (r.reviews?.lines.length) lines.push("The reviews of your prompts and of the code around your model are listed whole by status with show reviews.");

  const held = r.trials?.held ?? [];
  if (held.length) lines.push("Conversations set aside:", ...held.map((h) => `  ${h.surface}: ${plural(h.n, "conversation")}${heldWhy(h)}`));
  return lines.length > 1 ? lines : [];
}

export function machineText(f) {
  if (!f) return ["No connect command is running for this repository now, so nothing Cortad started is running here."];
  const lines = [
    f.started
      ? `Cortad started your app in ${f.dir === "." ? "this folder" : f.dir} and stops it when this command stops.`
      : `Cortad uses your app already running on port ${f.port} and leaves it running.`,
  ];
  lines.push(f.hooked ? "Cortad sees each request that reaches your model and the model calls it makes."
    : f.proxy ? `A local proxy on port ${f.proxy} sees each request sent to it and the model calls your app makes through it.`
      : "Cortad did not start your app, so it does not see the calls your app makes to its model.");

  if (!f.hooked) lines.push("During a simulation, what your app sends to an outside service, such as a payment or an email, is sent for real.");
  return lines;
}

export const connectedText = (f) => machineText(f).slice(0, 1);

export const CONNECTED = "connected: Cortad is watching your app. Next, your coding agent calls Cortad's status: it says what to tell you and what it needs. Ctrl-C disconnects and stops what your start command started.";
export const NOT_RUNNING = "your app is not running, so Cortad has nothing to test. The line above is your app's own error.";

export function showText(d, show, page = 1) {
  if (!d.read) return d.next || "Cortad has not studied your AI yet.";
  if (d.read.complete === false && show !== "reviews") return "Cortad is still studying your AI.";
  const { head, lines, continued } = sectionOf(d.read, show);

  const said = lines.length || !head.endsWith(":") ? head : `${head.replace(/ \(0\):$|:$/, "")}: none yet.`;
  return pageOf(pack(said, lines, continued), page, (n) => `status with show ${show} and page ${n}`);
}

function sectionOf(r, show) {
  switch (show) {
    case "rules": {
      const rules = r.rules ?? { count: 0 };
      const all = rules.all ?? rules.examples ?? [];
      return { head: `${rulesHead(rules)}${all.length < rules.count ? ` ${num(all.length)} of ${num(rules.count)} listed.` : ""}`, lines: all.map(ruleLine), continued: "Rules in the code, continued." };
    }
    case "standards": {
      const m = r.machine ?? {};
      if (m.reviewed) return { head: REVIEWED_CODE, lines: [], continued: "" };
      const misses = m.misses ?? [];
      const mets = m.mets ?? [];
      return {
        head: standardsHead(m),
        lines: [misses.length && (has(m.problems) ? counted("Problems", m.problems, misses.length) : counted("Missed", m.missed, misses.length)), ...misses.map(standardLine), mets.length && counted("Met", m.met, mets.length), ...mets.map(standardLine)].filter(Boolean),
        continued: "Engineering standards, continued.",
      };
    }
    case "journeys": {
      const all = r.journeys?.all ?? (r.journeys?.names ?? []).map((name) => ({ name }));
      return { head: counted("Journeys", r.journeys?.count, all.length), lines: all.map((j) => `  ${j.name}${j.steps?.length ? `: ${clip(j.steps.join("; "), 600)}` : ""}`), continued: "Journeys, continued." };
    }
    case "endpoints": {
      const all = r.doors?.all ?? (r.doors?.names ?? []).map((name) => ({ name }));
      return { head: counted("Endpoints", r.doors?.count, all.length), lines: all.map((e) => `  ${e.name}${e.path ? `: ${[e.method, e.path].filter(Boolean).join(" ")}` : ""}`), continued: "Endpoints, continued." };
    }
    case "records":
      return recordLines(r.records).length
        ? { head: "Records a conversation can name, three of each:", lines: recordLines(r.records), continued: "Records, continued." }
        : { head: "Cortad found no records in your code that a conversation can name.", lines: [], continued: "" };
    case "reviews":
      return { head: "The reviews of your prompts and of the code around your model:", lines: r.reviews?.lines.length ? r.reviews.lines : [r.complete === false ? "Cortad is still studying your AI; the reviews come when that is done." : r.reviews ? "Cortad's study of your AI left no review of this app's prompts or code." : "This status carries no reviews."], continued: "The reviews, continued." };
    case "trials":
    default: {
      const t = r.trials ?? {};
      const all = t.all ?? (t.held ?? []).map((h) => ({ surface: h.surface, held: h.n, why: h.why, side: h.side }));
      const line = (x) => `  ${x.surface}: ${[has(x.written) && `${num(x.written)} written`, has(x.playable) && `${num(x.playable)} playable`, x.held && `${num(x.held)} set aside`].filter(Boolean).join(", ")}${x.held ? heldWhy(x) : ""}`;
      return { head: trialsHead(t), lines: all.map(line), continued: "Conversations, continued." };
    }
  }
}
