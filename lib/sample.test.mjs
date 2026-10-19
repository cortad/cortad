import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleHere, spread } from "./sample.mjs";

test("a store whose address is not set is said so, not guessed at", async () => {
  const plan = { stores: [{ road: "retrieval.vector", kind: "qdrant", env: ["QDRANT_URL", "QDRANT_API_KEY"] }] };
  const { stores } = await sampleHere(plan, {}, tmpdir());
  assert.deepEqual(stores.map((s) => s.status), ["no-store"]);
});

test("a document folder comes back as its files, named by the variable that holds it", async () => {
  const root = mkdtempSync(join(tmpdir(), "bl-sample-"));
  mkdirSync(join(root, "books/unit-1"), { recursive: true });
  writeFileSync(join(root, "books/unit-1/derivatives.md"), "# The derivative is the slope\nmore\n");
  writeFileSync(join(root, "books/keys.pem"), "not a document");
  const plan = { stores: [{ road: "retrieval.files", kind: "files", env: ["DOCS_PATH"] }] };
  const { stores } = await sampleHere(plan, { DOCS_PATH: "books" }, root);
  assert.equal(stores[0].status, "sampled");
  assert.deepEqual(stores[0].rows, [{ where: "DOCS_PATH#unit-1/derivatives.md", fields: { file: "derivatives.md", heading: "The derivative is the slope" } }]);
});

test("a database is not read from this machine, and says which store it was", async () => {
  const plan = { stores: [{ road: "state.postgres", kind: "postgres", env: ["DATABASE_URL"] }] };
  const { stores } = await sampleHere(plan, { DATABASE_URL: "postgres://x" }, tmpdir());
  assert.equal(stores[0].status, "no-reader");
  assert.equal(stores[0].road, "state.postgres");
});

test("nothing runnable in the plan is run: an unknown kind is left out", async () => {
  const plan = { stores: [{ road: "x", kind: "rm -rf /", env: ["A"] }, { road: "bad road", kind: "qdrant", env: [] }] };
  const { stores } = await sampleHere(plan, {}, tmpdir());
  assert.deepEqual(stores, []);
});

test("every cell of a grid is reached before any cell is read twice", () => {
  const names = ["jordan_grade-10_sem-1_arabic", "jordan_grade-10_sem-1_math", "jordan_grade-10_sem-2_arabic", "jordan_grade-10_sem-2_math"];
  assert.deepEqual(spread(names).slice(0, 2), ["jordan_grade-10_sem-1_arabic", "jordan_grade-10_sem-2_arabic"]);
});

test("a second sweep spends the room the empty collections left on the ones that had rows", async () => {
  const page = "x".repeat(300);
  const server = (await import("node:http")).createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/collections") return res.end(JSON.stringify({ result: { collections: [{ name: "grade-10_math" }, { name: "grade-10_empty" }] } }));
      if (req.url.includes("empty")) return res.end(JSON.stringify({ result: { points: [], next_page_offset: null } }));
      const { limit, offset = 0 } = JSON.parse(body);
      const points = Array.from({ length: limit }, (_, i) => ({ id: offset + i, payload: { text: page } }));
      res.end(JSON.stringify({ result: { points, next_page_offset: offset + limit } }));
    });
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const plan = { stores: [{ road: "retrieval.vector", kind: "qdrant", env: ["QDRANT_URL"] }] };
  const { stores } = await sampleHere(plan, { QDRANT_URL: `http://127.0.0.1:${server.address().port}` }, tmpdir());
  server.close();
  const ids = stores[0].rows.map((r) => r.where);
  assert.ok(ids.length > 6, `more than the first sweep's six pages: ${ids.length}`);
  assert.equal(new Set(ids).size, ids.length, "the second sweep reads on from where the first stopped");
});

// A legal product keeps the texts its answers must quote in a keyword index: the corpus index is
// read for its own rows, the system indexes are left alone, and a key goes where both engines that
// speak this wire read one.
test("a keyword index is read for its rows, over the wire Elasticsearch and OpenSearch share", async () => {
  const seen = [];
  const server = (await import("node:http")).createServer((req, res) => {
    seen.push([req.url, req.headers.authorization ?? ""]);
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/_cat/indices")) return res.end(JSON.stringify([{ index: "legislation" }, { index: ".security-7" }, { index: "api_keys" }]));
    res.end(JSON.stringify({ hits: { hits: [{ _id: "a1", _source: { cite: "Civil Procedure, article 170", text: "An appeal is filed within thirty days." } }] } }));
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const plan = { stores: [{ road: "retrieval.search", kind: "search", env: ["ELASTICSEARCH_URL", "ELASTICSEARCH_API_KEY"] }] };
  const { stores } = await sampleHere(plan, { ELASTICSEARCH_URL: `127.0.0.1:${server.address().port}`, ELASTICSEARCH_API_KEY: "k-123" }, tmpdir());
  server.close();
  assert.equal(stores[0].status, "sampled");
  assert.deepEqual(stores[0].rows, [{ where: "legislation#a1", fields: { cite: "Civil Procedure, article 170", text: "An appeal is filed within thirty days." } }]);
  assert.equal(stores[0].note, "1 of 1 indexes");
  assert.deepEqual(seen.map(([url]) => url), ["/_cat/indices?format=json&h=index", "/legislation/_search"]);
  assert.ok(seen.every(([, auth]) => auth === "ApiKey k-123"), "the key rides where both engines read one");
});
