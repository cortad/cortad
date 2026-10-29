// Every request this tool makes goes through here, so CORTAD_OFFLINE is one rule in one place
// rather than a check each call site has to remember. It has been forgotten twice: once on the run
// path, once on `packs add` and `init --at`.
//
// Offline means nothing leaves this machine, so a request to this machine is allowed and everything
// else is refused. That is what makes the promise checkable: an app on localhost, a model in ollama
// and a pack on disk all still work, while our service, a hosted model and a pack URL do not.

export const offline = () => process.env.CORTAD_OFFLINE === "1";

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

export function isLocal(url) {
  try {
    const { hostname } = new URL(url);
    return LOCAL.has(hostname) || hostname.endsWith(".localhost") || /^127\./.test(hostname);
  } catch {
    return false;
  }
}

export function refusedOffline(url) {
  if (!offline() || isLocal(url)) return null;
  let host = url;
  try { host = new URL(url).host; } catch { /* print what we were given */ }
  return `CORTAD_OFFLINE is set and ${host} is not this machine, so nothing was sent.`;
}

// The only fetch in lib/. Async so it rejects rather than throwing where fetch would have returned
// a promise: a caller wrapping it in try/catch should not have to care which.
export async function net(url, init) {
  const refused = refusedOffline(url);
  if (refused) throw new Error(refused);
  return fetch(url, init);
}
