// Why an app's start failed, read off the last lines it printed: one line a person acts on, beside
// the app's own output. Each rule needs the app's own words; nothing is read into a filename. A
// start that failed on a missing setting or an unresolvable host gave only the traceback (a
// customer, 2026-10-19).
const name = (m) => m.slice(1).find(Boolean);
const RULES = [
  [/ECONNREFUSED\s+(?:[\w.-]+:)?(\d{2,5})\b|port (\d{2,5}) failed: Connection refused|connect(?:ion)? refused[^\n]*?:(\d{2,5})\b|could not connect to server[^\n]*?port (\d{2,5})\b/i,
    (m) => `your app could not reach a service on port ${name(m)}: a database, a cache or a queue it needs is not running there`],
  [/ENOTFOUND\s+([\w.-]+)|could not translate host name "([^"]+)"|([\w-]+(?:\.[\w-]+)+):\d{2,5}:?[^\n]*?(?:nodename nor servname provided|Name or service not known|Temporary failure in name resolution)|(?:nodename nor servname provided|Name or service not known)[^\n]*?([\w-]+\.[\w.-]+)/i,
    (m) => `your app could not resolve the host ${name(m) ?? "it was given"}: that address is a setting in its env file`],
  [/KeyError: '([A-Z][A-Z0-9_]{2,})'|(?:environment variable|env(?:ironment)? var(?:iable)?|setting)\s+['"`]?([A-Z][A-Z0-9_]{2,})['"`]?\s+(?:is )?(?:not set|missing|required|undefined|not defined)|Missing (?:required )?(?:environment variable|env var|setting)[: ]+['"`]?([A-Z][A-Z0-9_]{2,})|\b([A-Z][A-Z0-9_]{2,}) (?:is|was) not set\b|process\.env\.([A-Z][A-Z0-9_]{2,}) is undefined/,
    (m) => `your app is missing the setting ${name(m)}: it belongs in the env file your start command reads`],
  [/ModuleNotFoundError: No module named '([^']+)'|Cannot find module '([^'./][^']*)'|Cannot find package '([^']+)'/i,
    (m) => `your app is missing the package ${name(m)}: its dependencies are not installed here`],
  [/password authentication failed|authentication failed for user|Access denied for user|invalid (?:credentials|api[- ]?key)|Incorrect API key|401 Unauthorized/i,
    () => "a service your app uses refused its credentials: that key or password is a setting in its env file"],
];
export function startCause(tail) {
  const text = String(tail ?? "").slice(-8000);
  for (const [re, say] of RULES) { const m = re.exec(text); if (m) return say(m); }
  return null;
}
