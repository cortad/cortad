import { readFileSync, statSync } from "node:fs";

const ENV_READ = /(?:process\.env(?:\.|\[\s*['"])|os\.(?:environ\.get|getenv)\(\s*['"]|os\.environ\[\s*['"]|\benv\(\s*['"]|Deno\.env\.get\(\s*['"])([A-Z][A-Z0-9_]*)/g;
const THROUGHPUT = /(RATE_?LIMIT|DAILY_LIMIT|HOURLY_LIMIT|MINUTE_LIMIT|REQUESTS_PER|TOKEN_BUDGET|MAX_SSE|MAX_CONCURRENT|THROTTLE|_RPM$|_RPS$|_QPS$)/;
const GUARDED = /(AUTH|LOGIN|PASSWORD|BREAKER|LOCKOUT|ATTEMPT|FAIL|BAN|BLOCK)/;
const SWITCH = /_(?:ENABLED|DISABLED|ENABLE|DISABLE)$|^(?:ENABLE|DISABLE)_/;
const lifted = (name) => (/(TOKEN_BUDGET|TOKENS)/.test(name) ? "1000000000" : "1000000");
const liftable = (name) => THROUGHPUT.test(name) && !GUARDED.test(name) && !SWITCH.test(name);
export function liftedLimits(sources = []) {
  const out = {};
  for (const file of sources) {
    if (!/\.(?:[cm]?[jt]sx?|py|go|rb|php|rs)$/.test(file)) continue;
    let text = "";
    try { if (statSync(file).size > 512_000) continue; text = readFileSync(file, "utf8"); } catch { continue; }
    for (const m of text.matchAll(ENV_READ)) if (liftable(m[1])) out[m[1]] = lifted(m[1]);
  }
  return out;
}
