import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleHere, spread } from "./sample.mjs";

test("a store whose address is not set is said so, not guessed at", async () => {
  const plan = { stores: [{ road: "retrieval.vector", kind: "qdrant", env: ["QDRANT_URL", "QDRANT_API_KEY"] }] };
  const { stores } = await sampleHere(plan, {}, tmpdir());
  assert.deepEqual(stores.map((s) => s.status), ["no-store"]);
});

// A plan is the server's word: a host it names is never contacted, and a key named in the plan goes
// only to the store of its own variable family, at the address the app's env holds.
test("a store is opened only at the address in the app's env, with only its own family's key; a host the plan names is never contacted", async () => {
  const listen = async (handler) => { const s = (await import("node:http")).createServer(handler).listen(0, "127.0.0.1"); await new Promise((r) => s.once("listening", r)); return s; };
  const evil = [];
  const evilHost = await listen((req, res) => { evil.push(req.url); res.end("{}"); });
  const keys = [];
  const store = await listen((req, res) => {
    keys.push(req.headers["api-key"] ?? "");
    res.setHeader("content-type", "application/json");
    if (req.url === "/collections") return res.end(JSON.stringify({ result: { collections: [{ name: "legislation_chunks" }] } }));
    res.end(JSON.stringify({ result: { points: [{ id: 1, payload: { cite: "law 170", text: "x".repeat(300) } }], next_page_offset: null } }));
  });
  const at = `127.0.0.1:${evilHost.address().port}`;
  const names = ["QDRANT_URL", "OPENAI_API_KEY", "QDRANT_API_KEY"];
  const env = { QDRANT_URL: `http://127.0.0.1:${store.address().port}`, OPENAI_API_KEY: "sk-not-for-the-store", QDRANT_API_KEY: "qd-key" };
  try {
    const set = await sampleHere({ stores: [{ road: "retrieval.vector", kind: "qdrant", env: names, at }] }, env, tmpdir());
    assert.equal(set.stores[0].status, "sampled");
    assert.deepEqual([...new Set(keys)], ["qd-key"], "the store's own key, and no other");
    const unset = await sampleHere({ stores: [{ road: "retrieval.vector", kind: "qdrant", env: ["QDRANT_HOST", "QDRANT_PORT"], at }] }, {}, tmpdir());
    assert.equal(unset.stores[0].status, "no-store", "an address only the plan names is not one");
    assert.deepEqual(evil, [], "the plan's host was never contacted");
  } finally { evilHost.close(); store.close(); }
});

// Node's fetch refuses a URL with a user in it and puts the whole URL in its message, password and all.
test("a plan naming a database's connection string sends back no part of its user, password or host", async () => {
  const env = {
    DATABASE_URL: "postgres://alice:hunter2pw@db-internal-77.example.com:5432/app",
    MONGODB_URI: "mongodb+srv://bobuser:s3cr3tpw@cluster9-zz.example.net/app",
    SEARCH_URL: "http://carol:pa55word@[not a host",
  };
  const plan = { stores: [
    { road: "a", kind: "search", env: ["DATABASE_URL"] },
    { road: "b", kind: "qdrant", env: ["MONGODB_URI"] },
    { road: "c", kind: "search", env: ["SEARCH_URL"] },
  ] };
  const said = JSON.stringify(await sampleHere(plan, env, tmpdir()));
  for (const part of ["alice", "hunter2pw", "db-internal-77", "bobuser", "s3cr3tpw", "cluster9-zz", "carol", "pa55word", "not a host"]) assert.ok(!said.includes(part), `${part} in ${said}`);
  assert.match(said, /ADDRESS_HAS_CREDENTIALS/);
});

test("a sampled record arrives with its emails and phone numbers taken out, cut to 700 characters, 60 records at most", async () => {
  const server = (await import("node:http")).createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/collections") return res.end(JSON.stringify({ result: { collections: [{ name: "notes" }] } }));
      const { limit, offset = 0 } = JSON.parse(body);
      const points = Array.from({ length: limit }, (_, i) => ({ id: offset + i, payload: { text: `Write to jane.doe@example.com or call +962 79 123 4567. ${"y".repeat(900)}`, subject: "math" } }));
      res.end(JSON.stringify({ result: { points, next_page_offset: offset + limit } }));
    });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const plan = { perStore: 500, stores: [{ road: "retrieval.vector", kind: "qdrant", env: ["QDRANT_URL"] }] };
  const { stores } = await sampleHere(plan, { QDRANT_URL: `http://127.0.0.1:${server.address().port}` }, tmpdir());
  server.close();
  assert.ok(stores[0].rows.length > 0 && stores[0].rows.length <= 60, `${stores[0].rows.length} records`);
  for (const { fields } of stores[0].rows) {
    assert.doesNotMatch(JSON.stringify(fields), /jane\.doe@example\.com|123 4567/);
    assert.match(fields.text, /\[redacted:email\].*\[redacted:phone\]/);
    assert.ok(Object.values(fields).join("").length <= 700);
  }
});

test("a document folder outside the project is not walked, whether named outright or through a link", async () => {
  const root = mkdtempSync(join(tmpdir(), "bl-sample-root-"));
  const outside = mkdtempSync(join(tmpdir(), "bl-sample-outside-"));
  writeFileSync(join(outside, "diary.md"), "# Private notes\n");
  symlinkSync(outside, join(root, "docs"));
  mkdirSync(join(root, "books"));
  symlinkSync(join(outside, "diary.md"), join(root, "books", "diary.md"));
  const plan = (name) => ({ stores: [{ road: "retrieval.files", kind: "files", env: [name] }] });
  for (const [name, value] of [["DOCS_PATH", outside], ["DOCS_PATH", "docs"], ["DOCS_PATH", "../"], ["HOME_DIR", tmpdir()]]) {
    const { stores } = await sampleHere(plan(name), { [name]: value }, root);
    assert.deepEqual(stores[0].rows, [], `${name}=${value} was walked`);
  }
  const { stores } = await sampleHere(plan("BOOKS"), { BOOKS: "books" }, root);
  assert.deepEqual(stores[0].rows, [], "a link inside the folder is not followed out of it");
});

test("a store this machine has no reader for says so, instead of going missing", async () => {
  const plan = { stores: [{ road: "retrieval.vector", kind: "chroma", env: ["CHROMA_HOST"] }] };
  const { stores } = await sampleHere(plan, { CHROMA_HOST: "localhost:8000" }, tmpdir());
  assert.equal(stores[0].status, "no-reader");
  assert.match(stores[0].note, /cannot sample this kind of store/);
});

test("a document folder comes back as its files, named by the variable that holds it", async () => {
  const root = mkdtempSync(join(tmpdir(), "bl-sample-"));
  mkdirSync(join(root, "books/unit-1"), { recursive: true });
  writeFileSync(join(root, "books/unit-1/derivatives.md"), "# The derivative is the slope\nmore\n");
  writeFileSync(join(root, "books/keys.pem"), "not a document");
  const plan = { stores: [{ road: "retrieval.files", kind: "files", env: ["DOCS_PATH"] }] };
  const { stores } = await sampleHere(plan, { DOCS_PATH: "books" }, root, (rel) => rel.endsWith(".md"));
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
