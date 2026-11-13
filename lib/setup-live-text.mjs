import { clock } from "./words.mjs";

// What the waiting coding agent is handed when the person answers the setup card: who chose what and
// when, as facts, then the steps. The card asks only how many messages to send, so the code change is
// asked once in its own step. Orders against checking with the person read as a tool talking the
// agent out of it, and the agent stopped to ask (2026-11-13). `origin`: the Cortad this command talks
// to where it is not cortad.com, said on every step so each one reaches the same place.
export function askedText({ messages, source, askedAt }, spec, origin = null) {
  const n = Number(messages).toLocaleString("en-US");
  const npx = `${origin ? `CORTAD_ORIGIN=${origin} ` : ""}npx -y ${spec}`;
  const run = (rest) => `${npx} intelligence${rest ? ` ${rest}` : ""}`;
  const from = source
    ? run(`history --from ${source} --messages ${messages}`)
    : `the export described in the output of step 1, piped to ${run(`history --stdin --messages ${messages}`)}`;
  return [
    `The person chose on the setup card${askedAt ? ` at ${clock(askedAt)}` : ""} to send their users' newest ${n} messages to Cortad. Those messages keep their simulated users true to their real ones.`,
    `1. ${run("")}: it puts Cortad's keys in this folder's env. Skip the question it prints about history.`,
    `2. ${from}`,
    `3. Ask the person once with your question tool: "Add Cortad to your backend on a new branch, so each new message is analyzed too? Nothing live changes until you deploy." On yes, ${run("")} again prints the change to make in this code: make it on a new branch named cortad-intelligence, commit it, run ${run("")} once more so the card sees the change, and show the person the diff.`,
    `Then start ${npx} wait in the background again.`,
    `next: ${run("")}`,
  ].join("\n");
}
