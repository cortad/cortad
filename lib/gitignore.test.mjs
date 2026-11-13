import assert from "node:assert/strict";
import { test } from "node:test";
import { ignoredBy, rulesOf } from "./gitignore.mjs";

test("a .gitignore is read the way git reads it: anywhere-names, anchored paths, folders only, globs, and a file taken back", () => {
  const rules = [...rulesOf("# notes\nevals/\n*.csv\n!keep.csv\n/top.txt\ndocs/**/draft.md\nlog?.txt\n", ""), ...rulesOf("secret.json\n/local.yaml\n", "app")];
  const is = (rel, dir = false) => ignoredBy(rules, rel, dir);
  assert.ok(is("evals", true) && is("src/evals", true) && !is("evals"));
  assert.ok(is("data/x.csv") && !is("data/keep.csv"));
  assert.ok(is("top.txt") && !is("src/top.txt"));
  assert.ok(is("docs/a/b/draft.md") && is("docs/draft.md") && !is("draft.md"));
  assert.ok(is("log1.txt") && !is("log12.txt"));
  assert.ok(is("app/secret.json") && is("app/deep/secret.json") && !is("secret.json"));
  assert.ok(is("app/local.yaml") && !is("app/deep/local.yaml"));
  assert.ok(!is("src/app.js"));
});
