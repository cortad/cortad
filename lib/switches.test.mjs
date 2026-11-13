import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { liftedLimits } from "./switches.mjs";

const file = (name, text) => { const p = join(mkdtempSync(join(tmpdir(), "switches-")), name); writeFileSync(p, text); return p; };

test("a request-rate or concurrency limit the code reads is raised by name; a sign-in switch, a lockout, a spend limit and a value the code never reads are left alone", () => {
  const src = file("server.js", "const a = process.env.RATE_LIMIT_PER_MINUTE; const b = process.env.MAX_CONCURRENT_RUNS; const c = process.env.LOGIN_ATTEMPT_LIMIT; const d = process.env.ENABLE_AUTH; const e = process.env.RATE_LIMIT_ENABLED;");
  assert.deepEqual(liftedLimits([src]), { RATE_LIMIT_PER_MINUTE: "1000000", MAX_CONCURRENT_RUNS: "1000000" });
  assert.deepEqual(liftedLimits([file("a.py", "os.getenv('TOKEN_BUDGET'); os.getenv('DAILY_COST_LIMIT'); os.getenv('RATE_LIMIT_TOKENS_PER_DAY'); os.getenv('SPEND_RATE_LIMIT_USD'); os.getenv('OPENAI_RPM')")]), { OPENAI_RPM: "1000000" });
  assert.deepEqual(liftedLimits([file("notes.md", "RATE_LIMIT_PER_MINUTE")]), {}, "only code counts");
  assert.deepEqual(liftedLimits([]), {});
});
