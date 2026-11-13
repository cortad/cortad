// Your app's own request-rate and concurrency limits, raised for the session of the app this command
// started, and for nothing else: a run asks in twenty minutes what a person asks in a month, and a limiter that fires
// answers instead of your AI. Only a limit the code reads, by its name; the customer's files are never
// written, and every name is printed before the app starts. A sign-in switch, a lockout, an attempt
// counter and a password rule are never touched: who the app lets in is the app's own business. A
// spend, budget, token or cost limit is never touched either: what the app may spend is the person's.
import { readFileSync, statSync } from "node:fs";

const ENV_READ = /(?:process\.env(?:\.|\[\s*['"])|os\.(?:environ\.get|getenv)\(\s*['"]|os\.environ\[\s*['"]|\benv\(\s*['"]|Deno\.env\.get\(\s*['"])([A-Z][A-Z0-9_]*)/g;
const THROUGHPUT = /(RATE_?LIMIT|REQUESTS_PER|MAX_SSE|MAX_CONCURRENT|CONCURRENCY|THROTTLE|_RPM$|_RPS$|_QPS$)/;
const GUARDED = /(AUTH|LOGIN|PASSWORD|BREAKER|LOCKOUT|ATTEMPT|FAIL|BAN|BLOCK)/;
const SPEND = /(BUDGET|SPEND|COST|TOKEN|USD|DOLLAR|CENT|CREDIT|PRICE|BILL|MONEY|QUOTA)/;
const SWITCH = /_(?:ENABLED|DISABLED|ENABLE|DISABLE)$|^(?:ENABLE|DISABLE)_/;
const liftable = (name) => THROUGHPUT.test(name) && !GUARDED.test(name) && !SPEND.test(name) && !SWITCH.test(name);
export function liftedLimits(sources = []) {
  const out = {};
  for (const file of sources) {
    if (!/\.(?:[cm]?[jt]sx?|py|go|rb|php|rs)$/.test(file)) continue;
    let text = "";
    try { if (statSync(file).size > 512_000) continue; text = readFileSync(file, "utf8"); } catch { continue; }
    for (const m of text.matchAll(ENV_READ)) if (liftable(m[1])) out[m[1]] = "1000000";
  }
  return out;
}
