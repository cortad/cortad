import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addNews, dropNews, homeOf, projectOf, readPending, readToken, takeNews, writePending, writeToken } from "./home.mjs";

test("the key is kept per project, readable by this user only", () => {
  const base = mkdtempSync(join(tmpdir(), "cortad-base-"));
  const project = projectOf(base);
  assert.match(project, /^[a-f0-9]{16}$/);
  assert.equal(readToken(project, base), null);
  writeToken(project, "ct_mcp_secret", base);
  assert.equal(readToken(project, base), "ct_mcp_secret");
  assert.equal(statSync(join(homeOf(project, base), "token")).mode & 0o777, 0o600);
  assert.equal(statSync(homeOf(project, base)).mode & 0o777, 0o700);
});

test("the simulation this machine asked for is kept readable by this user only, and a torn file reads as none", () => {
  const base = mkdtempSync(join(tmpdir(), "cortad-base-"));
  const project = projectOf(base);
  assert.equal(readPending(project, base), null);
  writePending(project, { jobId: "j1", kind: "run", startedAt: "2026-09-26T12:00:00.000Z" }, base);
  assert.deepEqual(readPending(project, base), { jobId: "j1", kind: "run", startedAt: "2026-09-26T12:00:00.000Z" });
  assert.equal(statSync(join(homeOf(project, base), "pending.json")).mode & 0o777, 0o600);
  writeFileSync(join(homeOf(project, base), "pending.json"), "{\"jobId\":");
  assert.equal(readPending(project, base), null);
});

test("news the server said while no agent listened is kept per project and said once", () => {
  const base = mkdtempSync(join(tmpdir(), "cortad-base-"));
  const project = projectOf(base);
  assert.deepEqual(takeNews(project, base), []);
  addNews(project, "Run 55ee432b finished: 4 findings in 37 conversations. Call findings.", base);
  addNews(project, "Verify of finding:1 finished. Call run_status j2 for whether the failure is gone.", base);
  assert.equal(statSync(join(homeOf(project, base), "news.txt")).mode & 0o777, 0o600);
  assert.deepEqual(takeNews(project, base), [
    "Run 55ee432b finished: 4 findings in 37 conversations. Call findings.",
    "Verify of finding:1 finished. Call run_status j2 for whether the failure is gone.",
  ]);
  assert.deepEqual(takeNews(project, base), []);
});

test("news nobody takes keeps its latest twenty lines, and a simulation the agent read itself is not said again", () => {
  const base = mkdtempSync(join(tmpdir(), "cortad-home-"));
  const project = "p";
  for (let i = 1; i <= 25; i += 1) addNews(project, `Run r${i} finished after 3 conversations. Call findings with jobId job-${i}-end.`, base);
  dropNews(project, "job-25-end", base);
  dropNews(project, "job-none", base);
  const lines = takeNews(project, base);
  assert.equal(lines.length, 19);
  assert.match(lines[0], /^Run r6 /);
  assert.match(lines.at(-1), /^Run r24 /);
  assert.deepEqual(readdirSync(homeOf(project, base)), ["heard.txt"]);

  addNews(project, "Run r1 finished after 3 conversations. Call findings with jobId job-1-end.", base);
  dropNews(project, "job-1-end", base);
  assert.deepEqual(readdirSync(homeOf(project, base)), ["heard.txt"]);
  // The server marks a run finished a moment before it says the line: one that arrives after the
  // agent has read the run is not kept for it. An id too short to be one drops nothing.
  addNews(project, "Run r1 finished after 3 conversations. Call findings with jobId job-1-end.", base);
  addNews(project, "Run r2 finished after 3 conversations. Call findings with jobId job-2-end.", base);
  dropNews(project, "", base);
  assert.deepEqual(takeNews(project, base), ["Run r2 finished after 3 conversations. Call findings with jobId job-2-end."]);
});

test("a line taken while another process trims or drops is said once, and a link planted at the file's name is never written through", () => {
  const base = mkdtempSync(join(tmpdir(), "cortad-home-"));
  const project = "p";
  const file = join(homeOf(project, base), "news.txt");
  for (let i = 1; i <= 3; i += 1) addNews(project, `Run r${i} finished. Call findings with jobId job-${i}-end.`, base);
  // A hook takes the file; a drop that runs after it finds nothing to rewrite and brings nothing back.
  const said = takeNews(project, base);
  dropNews(project, "job-2-end", base);
  assert.equal(said.length, 3);
  assert.deepEqual(takeNews(project, base), []);
  // Lines that land while a drop holds the file are kept beside what the drop puts back.
  addNews(project, "Run r4 finished. Call findings with jobId job-4-end.", base);
  addNews(project, "Run r5 finished. Call findings with jobId job-5-end.", base);
  dropNews(project, "job-4-end", base);
  addNews(project, "Run r6 finished. Call findings with jobId job-6-end.", base);
  assert.deepEqual(takeNews(project, base).map((l) => l.slice(0, 6)), ["Run r5", "Run r6"]);
  const elsewhere = join(base, "other.txt");
  writeFileSync(elsewhere, "not news\n");
  symlinkSync(elsewhere, file);
  assert.throws(() => addNews(project, "Run r7 finished. Call findings with jobId job-7-end.", base));
  assert.deepEqual(takeNews(project, base), [], "a link is removed unread");
  assert.equal(readFileSync(elsewhere, "utf8"), "not news\n");
});
