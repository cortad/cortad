import { randomUUID } from "node:crypto";

const text = (v, max) => (typeof v === "string" && v ? v.slice(0, max) : undefined);

const RETRIES = 3;
const RETRY_MS = 400;

export function makeReport({ api, token, version, fetchImpl = fetch, sessionId = randomUUID(), wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  return async ({ tool, callId, durationMs, outputChars, errorCode, error, clientName, clientVersion }) => {
    const key = token();
    if (!key) return;
    const call = { tool, ...(callId ? { callId } : {}), durationMs, outputChars, errorCode, error: text(error?.split("\n")[0], 512), clientName: text(clientName, 80), clientVersion: text(clientVersion, 40), serverVersion: version, sessionId };
    const tries = tool === "reach" && callId ? RETRIES : 1;
    for (let n = 1; n <= tries; n++) {
      try {
        const res = await fetchImpl(`${api}/mcp/calls`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify([call]),
          signal: AbortSignal.timeout(3000),
        });

        if (!res || res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return;
      } catch {  }
      if (n < tries) await wait(n * RETRY_MS);
    }
  };
}
