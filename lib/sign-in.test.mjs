import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetSignIn, keptSignIn, rememberSignIn } from "./sign-in.mjs";

test("the one sign-in is kept between connects, readable by the owner alone, until forgotten", () => {
  const home = join(mkdtempSync(join(tmpdir(), "cortad-signin-")), "project");
  assert.equal(keptSignIn(home), null);
  rememberSignIn(home, { name: "cookie", value: "session=abc", how: "signed in as the test account Cortad made on your app (t@example.com)" });
  assert.equal(statSync(join(home, "sign-in.json")).mode & 0o777, 0o600);
  const kept = keptSignIn(home);
  assert.deepEqual({ name: kept.name, value: kept.value }, { name: "cookie", value: "session=abc" });
  assert.match(kept.how, /kept from your last connect/);
  rememberSignIn(home, { name: "", value: "" });
  assert.equal(keptSignIn(home).value, "session=abc");
  forgetSignIn(home);
  assert.equal(keptSignIn(home), null);
  assert.equal(existsSync(join(home, "sign-in.json")), false);
});
