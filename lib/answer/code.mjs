// Questions the reply settles on its own. No model is asked, so no model can be wrong about them,
// and a judge that goes down does not take them with it.
import { ABSENT, NO, overTurns, YES } from "./verdict.mjs";

const replies = (transcript) => transcript.filter((t) => t.role === "app" && typeof t.text === "string");

const KINDS = {
  // Any of these words appearing in a reply is a yes. Case is ignored: an app that shouts a forbidden
  // discount is not obeying a rule about mentioning it.
  contains: (question, reply) => {
    const want = [question.contains].flat().filter((s) => typeof s === "string" && s);
    if (!want.length) return null;
    const said = reply.toLowerCase();
    const hit = want.find((w) => said.includes(w.toLowerCase()));
    return hit ? { answer: YES, quote: hit } : { answer: NO, quote: "" };
  },
  matches: (question, reply) => {
    let re;
    try { re = new RegExp(question.matches, "i"); } catch { return null; }
    const found = re.exec(reply);
    return found ? { answer: YES, quote: found[0] } : { answer: NO, quote: "" };
  },
  json: (_question, reply) => {
    try { JSON.parse(reply); return { answer: YES, quote: "" }; } catch { return { answer: NO, quote: "" }; }
  },
};

export const kindOf = (question) => Object.keys(KINDS).find((k) => question[k] !== undefined) ?? null;

// A question nobody could ask, because the app never answered, did not come up. It is not a failure.
export function decide(question, transcript) {
  const kind = kindOf(question);
  if (!kind) return { answer: ABSENT, quote: "", why: "this question names nothing code can read" };
  const said = replies(transcript);
  if (!said.length) return { answer: ABSENT, quote: "", why: "your app never answered" };
  const each = said.map((t) => KINDS[kind](question, t.text));
  if (each.some((r) => r === null)) return { answer: ABSENT, quote: "", why: `${kind} is not written in a way code can read` };
  const answer = overTurns(each.map((r) => r.answer));
  const at = each.findIndex((r) => r.answer === answer);
  return { answer, quote: each[at]?.quote ?? "", why: `read from the reply by ${kind}` };
}
