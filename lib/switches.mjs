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
