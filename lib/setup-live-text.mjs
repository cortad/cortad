import { clock } from "./words.mjs";

// What the waiting coding agent is handed when the person answers the setup card: who chose what and
// when, as facts, then the steps. The card asks only how many messages to send; the one question about
// the code change is the one `intelligence` prints with that change, so it is asked once in all.
// `origin`: the Cortad this command talks to where it is not cortad.com, said on every step so each
// one reaches the same place.
export function askedText({ messages, source, askedAt }, spec, origin = null) {
  const n = Number(messages).toLocaleString("en-US");
  const npx = `${origin ? `CORTAD_ORIGIN=${origin} ` : ""}npx -y ${spec}`;
  const run = (rest) => `${npx} intelligence${rest ? ` ${rest}` : ""}`;
  const from = source
    ? run(`history --from ${source} --messages ${messages}`)
    : `${run(`history --messages ${messages}`)}: it takes them from this app's own database, read-only, and prints which one. Write nothing for it.`;
  return [
    `The person chose on the setup card${askedAt ? ` at ${clock(askedAt)}` : ""} to send their users' newest ${n} messages to Cortad. Those messages keep their simulated users true to their real ones.`,
    `1. ${run("")}: it puts Cortad's keys in this folder's env. The question it prints about history is the one the person just answered on the card.`,
    `2. ${from}`,
    `3. ${run("")} again: it prints the change that adds Cortad to this backend and the one question about it, with its options, yes first. Ask the person that question once, as printed, with your question tool, and follow the option they choose.`,
    `Then start ${npx} wait in the background again.`,
    `next: ${run("")}`,
  ].join("\n");
}
