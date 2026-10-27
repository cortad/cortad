// Reading their own eval files. Nothing here is guessed: a file that only has inputs is not read.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findEvals, looksLikeEvals, simulationsFrom } from "../lib/evals/read.mjs";

const repoWith = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "cortad-evals-"));
  for (const [at, body] of Object.entries(files)) {
    mkdirSync(join(dir, at, ".."), { recursive: true });
    writeFileSync(join(dir, at), body);
  }
  return dir;
};

const rows = [
  { question: "can i get a refund on january shoes", must: "30 day", must_not: "approved" },
  { question: "do you price match", expected: "we do not price match" },
  { input: "is there a student discount", mustNot: ["20% off"] },
];

test("three rows naming what was asked and what the answer must do are evals", () => {
  assert.equal(looksLikeEvals(rows).length, 3);
  assert.equal(looksLikeEvals(rows.slice(0, 2)), null, "two is a coincidence");
  assert.equal(looksLikeEvals([{ title: "a" }, { title: "b" }, { title: "c" }]), null, "rows with no expectation are not evals");
  assert.equal(looksLikeEvals([{ question: "a" }, { question: "b" }, { question: "c" }]), null, "inputs with nothing required are not evals");
});

test("a short expectation is asked by code and a long one by a model, against the reference", () => {
  const made = simulationsFrom("evals/refunds.json", rows);
  assert.equal(made[0].questions[0].contains[0], "30 day");
  assert.equal(made[0].questions[0].answer, "yes");
  assert.equal(made[0].questions[1].answer, "no", "must_not is a question the answer has to be no to");
  assert.equal(made[0].from, "evals/refunds.json:1");

  const prose = "The trail runners carry a twelve month warranty against manufacturing defects, which does not cover wear from normal use or damage from misuse at all.";
  const long = simulationsFrom("evals/g.jsonl", [{ prompt: "what is the warranty", reference: prose }]);
  assert.equal(long[0].questions[0].contains, undefined, "prose is compared, not looked for");
  assert.match(long[0].questions[0].ask, /answer the same thing as this/);
  assert.match(long[0].questions[0].ask, /twelve month warranty/);
});

test("the files that are read are the ones that are evals, and nothing else is", () => {
  const dir = repoWith({
    "evals/refunds.json": JSON.stringify(rows),
    "evals/lines.jsonl": rows.map((r) => JSON.stringify(r)).join("\n"),
    "evals/wrapped.json": JSON.stringify({ version: 2, cases: rows }),
    "src/notes.json": JSON.stringify([{ title: "a" }, { title: "b" }, { title: "c" }]),
    "package.json": JSON.stringify({ name: "theirs" }),
    "node_modules/pkg/evals.json": JSON.stringify(rows),
  });
  const found = findEvals(dir).map((f) => f.file).sort();
  assert.deepEqual(found, ["evals/lines.jsonl", "evals/refunds.json", "evals/wrapped.json"]);
});

test("every simulation written from a row has an address in their repository", () => {
  const dir = repoWith({ "evals/refunds.json": JSON.stringify(rows) });
  const [file] = findEvals(dir);
  assert.equal(file.simulations.length, 3);
  assert.ok(file.simulations.every((s) => /^evals\/refunds\.json:\d+$/.test(s.from)));
  assert.equal(new Set(file.simulations.map((s) => s.id)).size, 3, "one name per row");
});
