import assert from "node:assert/strict";
import { test } from "node:test";
import { explainText } from "./explain-text.mjs";

test("--explain is a count with no claim, then each file under the reason it was picked", () => {
  const why = new Map([["src/chat.ts", "model-call"], ["src/prompt.md", "prompt"], ["src/auth/login.ts", "reach"], ["README.md", "readme"], ["src/new.ts", "something-new"]]);
  assert.equal(explainText({ files: [...why.keys()], why }, 2274), [
    "A connect sends these 5 of this folder's 2,274 files, picked because they hold prompts, call a model, or sit on the path to one:",
    "Hold prompts (1): src/prompt.md",
    "Call a model (1): src/chat.ts",
    "Sit on the path from a route to a model call (1): src/auth/login.ts",
    "Describe the app (1): README.md",
    "Picked for another reason (1): src/new.ts",
  ].join("\n"));
  assert.equal(explainText({ files: [], why: new Map() }, 12), "A connect sends none of this folder's 12 files: no model call was found here.");
});
