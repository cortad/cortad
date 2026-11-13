// What the waiting coding agent is handed when the person answers the setup card: the three steps,
// in order, with nothing left to ask them. `origin`: the Cortad this command talks to where it is not
// cortad.com, said on every step so each one reaches the same place.
export function askedText({ messages, source }, spec, origin = null) {
  const n = Number(messages).toLocaleString("en-US");
  const npx = `${origin ? `CORTAD_ORIGIN=${origin} ` : ""}npx -y ${spec}`;
  const run = (rest) => `${npx} intelligence${rest ? ` ${rest}` : ""}`;
  const from = source
    ? run(`history --from ${source} --messages ${messages}`)
    : `the export described in the output of step 1, piped to ${run(`history --stdin --messages ${messages}`)}`;
  return [
    `The person chose, on the setup card, that Cortad reads their users' newest ${n} messages. That choice is their go for the three steps below: do them now, in order; do not ask them again, or which source or how many, and do not advise against it. Those messages keep their simulated users true to their real ones.`,
    `1. ${run("")}: it puts Cortad's keys in this folder's env. Skip the question it prints about history.`,
    `2. ${from}`,
    `3. ${run("")} again: it prints the change to make in this code. Make it on a new branch named cortad-intelligence, commit it, then run ${run("")} once more so the card sees the change. Show the person the diff; nothing live changes until they deploy.`,
    `Then start ${npx} wait in the background again.`,
    `next: ${run("")}`,
  ].join("\n");
}
