import { clock } from "./words.mjs";
import { SOURCES } from "./history/sources.mjs";

// What the waiting coding agent is handed when the person answers the setup card: who chose what,
// where and when, as a fact it can check; the one question that confirms it with the person; and the
// command a yes runs. Which command follows which is the skill's (skill/SKILL.md), never this text's.
// `origin`: the Cortad this command talks to where it is not cortad.com.
// `found`: where the app's own database keeps its conversations, as the history step proposes it
// (intelligence-text.mjs historyProposal): the question that confirms the choice then names them,
// so the person is asked once. Handed the choice alone, an agent asked whether to send, then which
// collections, each with "Not now" (2026-11-14).
export function askedText({ messages, source, askedAt, askedBy }, spec, origin = null, found = null) {
  const n = Number(messages).toLocaleString("en-US");
  const from = SOURCES.find((s) => s.id === source)?.name;
  const when = [askedAt && `at ${clock(askedAt)}`, askedBy && `signed in as ${askedBy}`].filter(Boolean).join(", ");
  const npx = `${origin ? `CORTAD_ORIGIN=${origin} ` : ""}npx -y ${spec}`;
  if (found) return [`The person chose on the setup card${when ? ` ${when}` : ""}: send your users' newest ${n} messages to Cortad.`, found.replaceAll(`npx -y ${spec}`, npx)].join("\n");
  return [
    `The person chose on the setup card${when ? ` ${when}` : ""}: send your users' newest ${n} messages to Cortad${from ? `, from ${from}` : ""}.`,
    `To confirm with the person: "Send your users' newest ${n} messages to Cortad now?" Yes, send them / Not now`,
    `next: ${npx} intelligence history${source ? ` --from ${source}` : ""} --messages ${messages}`,
  ].join("\n");
}
