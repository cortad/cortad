import { clock } from "./words.mjs";

export function askedText({ messages, source, askedAt }, spec, origin = null) {
  const n = Number(messages).toLocaleString("en-US");
  const npx = `${origin ? `CORTAD_ORIGIN=${origin} ` : ""}npx -y ${spec}`;
  const run = (rest) => `${npx} intelligence${rest ? ` ${rest}` : ""}`;
  const from = source
    ? run(`history --from ${source} --messages ${messages}`)
    : `${run(`history --messages ${messages}`)}: it reads only the names of the tables in this app's own database and prints the table it proposes, with one question. Ask the person that question once, as printed, with your question tool, and run the command of the option they choose: only that reads rows.`;
  return [
    `The person chose on the setup card${askedAt ? ` at ${clock(askedAt)}` : ""} to send their users' newest ${n} messages to Cortad. Those messages keep their simulated users true to their real ones.`,
    `1. ${run("")}: it puts Cortad's keys in this folder's env. The question it prints about history is the one the person just answered on the card.`,
    `2. ${from}`,
    `3. ${run("")} again: it prints the change that adds Cortad to this backend and the one question about it, with its options, yes first. Ask the person that question once, as printed, with your question tool, and follow the option they choose.`,
    `Then start ${npx} wait in the background again.`,
    `next: ${run("")}`,
  ].join("\n");
}
