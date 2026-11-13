import assert from "node:assert/strict";
import { test } from "node:test";
import { relativePaths } from "./paths.mjs";

test("a path in the project goes as its path from the project, the project as '.', anything else in home under '~'", () => {
  const at = { root: "/Users/sam/code/shop", home: "/Users/sam" };
  assert.equal(relativePaths('  File "/Users/sam/code/shop/app/main.py", line 4', at), '  File "app/main.py", line 4');
  assert.equal(relativePaths("cwd /Users/sam/code/shop; cache /Users/sam/.npm/_cacache", at), "cwd .; cache ~/.npm/_cacache");
  assert.equal(relativePaths("/Users/sam/code/shop-old/x.js and /Users/samantha/y", at), "~/code/shop-old/x.js and /Users/samantha/y", "a neighbour is not the project, and another user is not this one");
  assert.equal(relativePaths(JSON.stringify({ text: "at /Users/sam/code/shop/src/a.ts:3" }), at), '{"text":"at src/a.ts:3"}');
});
