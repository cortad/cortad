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
  assert.equal(explainText({ files: ["src/chat.ts"], why: new Map([["src/chat.ts", "model-call"]]), fed: ["data/students.txt", "src/welcome.md"] }, 3).split("\n").at(-1),
    "Not sent: read into a model call; send it with `npx -y cortad send <file>` if it is a prompt (2): data/students.txt, src/welcome.md");
  assert.deepEqual(explainText({ files: ["src/chat.ts"], why: new Map([["src/chat.ts", "model-call"]]), held: [{ path: "prompts/system.md", why: "personal" }, { path: "src/prompt.ts", why: "secret" }, { path: "rules.txt", why: "secret" }] }, 4).split("\n").slice(-2), [
    "Not sent, since a line in it sets a password, key or code (2): src/prompt.ts, rules.txt",
    "Not sent, since it holds a personal detail: a contact, an id, or a person's health or family note (1): prompts/system.md",
  ]);
});
