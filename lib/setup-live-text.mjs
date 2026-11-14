import { clock } from "./words.mjs";
import { SOURCES } from "./history/sources.mjs";

export const proposalOf = (out) => {
  const text = String(out?.text ?? "").replace(/^cortad {2}/gm, "");
  return out?.code || out?.sent || !/^To confirm with the person: /m.test(text) ? null : text;
};

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
