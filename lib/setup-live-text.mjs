import { clock } from "./words.mjs";
import { SOURCES } from "./history/sources.mjs";

export function askedText({ messages, source, askedAt, askedBy }, spec, origin = null) {
  const n = Number(messages).toLocaleString("en-US");
  const from = SOURCES.find((s) => s.id === source)?.name;
  const when = [askedAt && `at ${clock(askedAt)}`, askedBy && `signed in as ${askedBy}`].filter(Boolean).join(", ");
  const npx = `${origin ? `CORTAD_ORIGIN=${origin} ` : ""}npx -y ${spec}`;
  return [
    `The person chose on the setup card${when ? ` ${when}` : ""}: send your users' newest ${n} messages to Cortad${from ? `, from ${from}` : ""}.`,
    `To confirm with the person: "Send your users' newest ${n} messages to Cortad now?" Yes, send them / Not now`,
    `next: ${npx} intelligence history${source ? ` --from ${source}` : ""} --messages ${messages}`,
  ].join("\n");
}
