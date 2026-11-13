// Reading your own material from your own stores, here on this machine.
//
// A world's shell cannot do this and must not: it runs inside the OS sandbox, which denies every
// env file and every host but this one. A reader written into that shell read nothing on a real
// laptop: no address, no key, no network. The address and the key are in your environment file,
// which this program already opened to mask what your commands print, so the read happens here and
// only rows of short fields go back.
//
// Nothing runnable arrives from the outside: the plan names store kinds and variable NAMES, and
// this file decides what is asked and what is kept. A store is opened only at the address the app's
// own env holds, and a key goes only to the store its own variable family names (QDRANT_API_KEY to
// QDRANT_URL's host); an address the plan carries is never used. Values are never sent; the rows
// are, each cleared by the same rules as production history (lib/redact.mjs).

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { scrub, scrubValue } from "./redact.mjs";

const ROAD = /^[\w.:/-]+$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Every kind the control plane may ask about. The ones this file opens are below; the rest answer
// with a row that says so, because a store missing from the answer reads as an outage.
const KINDS = new Set(["qdrant", "chroma", "weaviate", "search", "postgres", "files"]);
// The port each client library uses when the address names none. Their own code falls back to the
// same number, so a host with no port is still the place their app is talking to.
const PORTS = { qdrant: 6333, chroma: 8000, weaviate: 8080, search: 9200 };
// A host with no dot is the loopback or a container beside their app, never something on the public
// internet, so it is reached over plain http and given the client's own port.
const PRIVATE = /^(?:localhost|\[?::1\]?|\d+\.\d+\.\d+\.\d+|[A-Za-z0-9_-]+)$/;
const STORES_MAX = 12;
const PER_STORE = 6;
const PER_STORE_MAX = 60;
const RECORD_MAX = 700;
// A few rows from MANY collections, never many rows from few: a store whose collection names are
// the product's own grid (jordan_grade-10_sem-2_math) is only read when every cell is read. Forty
// eight of them, twenty two rows apiece, filled the whole answer with seven of one app's cells and
// left grade 10 semester 2 maths unread, so the depth follows the breadth: how many rows a
// collection gets is the answer's room divided by how many collections there are.
const COLLECTIONS = 200;
// One row of theirs as this store gave it: a page and its short fields, measured on a real store.
const ROW_BYTES = 800;
const PER_MIN = 2;
const ROWS = PER_STORE_MAX;
const FIELDS = 12;
const STRING_MAX = 120;
const BUDGET = 540_000;
const READ_MS = 50_000;
const ASK_MS = 10_000;

const PII = /(^|_)(e?mail|phone|mobile|tel|fax|password|passwd|pwd|secret|token|otp|ssn|iban|card|address|street|zip|postal|birth|dob|salt|hash|ip)(_|$)|(mail|phone|password|token|secret|hash)$/i;
const CORPUS = /legislat|regulat|statute|corpus|grade|sem|subject|book|lesson|chunk|doc|page|content|unit|chapter|curricul|textbook|knowledge|embed|vector|material|note|article/i;
const RECORDS = /histor|attempt|session|log|event|message|user|profile|audit|analytic|trace|queue|cache|token|auth|billing|payment|invoice/i;
// The narrow security floor: names that are credentials, never a corpus in any product.
const SENSITIVE = /(?:^|[_\-/.])(?:password|passwd|pwd|credential|secret|apikey|api[_-]?key|access[_-]?token|refresh[_-]?token|jwt|session|oauth)s?(?:$|[_\-/.])|^(?:passwords|credentials|api_keys|secrets)$/i;
const DOC = /\.(?:md|mdx|txt|rst|html?|pdf|docx?|csv|json)$/i;
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", ".venv", "venv", "__pycache__", ".next"]);

// A name that does not say it holds content is never read, whatever else the store holds: messages,
// users and sessions are people's, not the product's material.
const contentOnly = (names) => names.filter((n) => CORPUS.test(n) && !SENSITIVE.test(n)).sort((a, b) => rank(a).localeCompare(rank(b)));
const NO_CONTENT = "NO_CONTENT_NAME";
const store = (plan, status, rows, note = "") => ({ road: plan.road, kind: plan.kind, status, rows, ...(note ? { note } : {}) });
// A code, or our own sentence; never the error's message, which names the full address it failed on.
const reason = (err) => {
  const code = err?.cause?.code ?? err?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(code)) return code;
  return err?.name === "TimeoutError" ? "TIMEOUT" : "the store did not answer";
};
const ADDRESS = /URL|URI|HOST|ENDPOINT|NODE|ADDRESS/;
// QDRANT_URL, QDRANT_PORT and QDRANT_API_KEY are one family, QDRANT; OPENAI_API_KEY is another, so
// a plan that names it beside QDRANT_URL never sends it to the vector store.
const familyOf = (name) => name.replace(/_?(?:URLS?|URIS?|HOSTS?|ENDPOINTS?|NODES?|ADDRESS|PORT|API_?KEY|KEY|TOKEN|PASSWORD|SECRET)$/i, "").toUpperCase();
const valueFor = (names, env, pattern, family) => names.map((n) => (pattern.test(n) && (family === undefined || familyOf(n) === family) ? env[n] : "")).find(Boolean) ?? "";

// Where a store answers, from the app's own env alone, and its family, which alone may lend it a key.
// Nothing is opened at an address the env does not hold.
function address(kind, names, env) {
  const name = names.find((n) => ADDRESS.test(n) && env[n]);
  if (!name) return { base: "", family: null };
  const named = String(env[name]);
  const family = familyOf(name);
  const url = new URL(named.includes("://") ? named : `${PRIVATE.test(named.split(":")[0]) ? "http" : "https"}://${named}`);
  const port = valueFor(names, env, /PORT/, family);
  // An address with a user or password in it is a database's connection string, never a store this reads.
  if (url.username || url.password) throw Object.assign(new Error("address carries credentials"), { code: "ADDRESS_HAS_CREDENTIALS" });
  if (!url.port) url.port = /^\d{1,5}$/.test(port) ? port : PRIVATE.test(url.hostname) ? String(PORTS[kind]) : "";
  return { base: url.toString().replace(/\/+$/, ""), family };
}

// The short fields of one row: numbers, short strings, and at most one page of prose. The page is
// looked for in every column, never in the first twelve alone: a row of theirs carries a dozen ids,
// dates and flags before its text, so a cap that stopped early kept the bookkeeping and dropped the
// page, and the cell had nothing of theirs to ask about.
// Cleared before it is cut, so the rules see a whole email or phone number, and the record as a
// whole holds RECORD_MAX characters at most, the page first.
function short(fields) {
  const kept = [];
  let page = null;
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (typeof key !== "string" || PII.test(key) || typeof value === "boolean") continue;
    if (typeof value === "string" && value.trim().length > STRING_MAX) {
      const text = value.trim();
      if (!page || text.length > page[1].length) page = [key, text];
      continue;
    }
    if (kept.length >= FIELDS) continue;
    if (typeof value === "number" && Number.isFinite(value)) kept.push([key, value]);
    else if (typeof value === "string" && value.trim()) kept.push([key, value.trim()]);
  }
  const out = {};
  let room = RECORD_MAX;
  for (const [key, value] of [...(page ? [page] : []), ...kept]) {
    const said = typeof value === "string" ? scrubValue({ [key]: value })[key].slice(0, room) : value;
    if (room <= 0 || String(said).length > room) break;
    room -= String(said).length;
    out[key] = said;
  }
  return out;
}

const rank = (name) => `${RECORDS.test(name) ? 1 : 0}${CORPUS.test(name) ? 0 : 1}${name}`;

// Round robin over the cell a name addresses, which is every segment but the last:
// jordan_grade-10_sem-2 holds math, physics and the rest. Keyed on the first two segments instead,
// the semester was never part of the key, the names sorted with every sem-1 collection first, and a
// cap of forty-eight read semester 1 of everything and semester 2 of nothing.
export function spread(names) {
  const groups = new Map();
  for (const name of names) {
    const parts = name.split(/[_/.]/);
    const key = parts.length > 1 ? parts.slice(0, -1).join("_") : parts[0];
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }
  const out = [];
  for (let i = 0; out.length < names.length; i += 1) {
    for (const key of [...groups.keys()].sort()) {
      const list = groups.get(key);
      if (list.length > i) out.push(list[i]);
    }
  }
  return out;
}

async function ask(url, key, body, header = "api-key") {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(key ? { [header]: key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(ASK_MS),
  });
  if (!res.ok) throw Object.assign(new Error(`answered ${res.status}`), { code: `HTTP_${res.status}` });
  return res.json();
}

// A keyword index, over the wire Elasticsearch and OpenSearch share. In a product whose answers
// must quote law, regulation or policy, the texts live here and in no vector store: their hundred
// gigabytes were read as nothing at all, and every simulated question was written from nothing of
// theirs. A key rides in the Authorization header, where both engines read one.
async function search(plan, names, env, per, until) {
  const { base, family } = address(plan.kind, names, env);
  if (!base) return store(plan, "no-store", []);
  const key = valueFor(names, env, /KEY|TOKEN|PASSWORD/, family);
  const auth = key ? `ApiKey ${key}` : "";
  let every;
  try {
    every = (await ask(`${base}/_cat/indices?format=json&h=index`, auth, null, "authorization"))
      .map((row) => String(row?.index ?? "")).filter((name) => name && !name.startsWith("."));
  } catch (err) {
    return store(plan, "unreachable", [], reason(err));
  }
  const named = contentOnly(every);
  if (!named.length) return store(plan, "no-content", [], NO_CONTENT);
  const asking = spread(named).slice(0, COLLECTIONS);
  const each = Math.max(PER_MIN, Math.min(per, Math.floor(BUDGET / ROW_BYTES / Math.max(1, asking.length))));
  const rows = [];
  let read = 0;
  for (const name of asking) {
    if (Date.now() > until) break;
    try {
      const got = await ask(`${base}/${encodeURIComponent(name)}/_search`, auth, { size: each, query: { match_all: {} } }, "authorization");
      for (const hit of got?.hits?.hits ?? []) {
        const fields = short(hit?._source ?? {});
        if (Object.keys(fields).length) rows.push({ where: where(name, hit?._id), fields });
      }
      read += 1;
    } catch { continue; }
  }
  return store(plan, rows.length ? "sampled" : "empty", rows, `${read} of ${named.length} indexes`);
}

async function qdrant(plan, names, env, per, until) {
  const { base, family } = address(plan.kind, names, env);
  if (!base) return store(plan, "no-store", []);
  const key = valueFor(names, env, /KEY|TOKEN/, family);
  let every;
  try {
    every = ((await ask(`${base}/collections`, key)).result?.collections ?? []).map((c) => String(c?.name ?? "")).filter(Boolean);
  } catch (err) {
    return store(plan, "unreachable", [], reason(err));
  }
  const named = contentOnly(every);
  if (!named.length) return store(plan, "no-content", [], NO_CONTENT);
  const asking = spread(named).slice(0, COLLECTIONS);
  const each = Math.max(PER_MIN, Math.min(per, Math.floor(BUDGET / ROW_BYTES / Math.max(1, asking.length))));
  const rows = [];
  let read = 0;
  // Where each collection that had rows left off. On one app a third of the 177 collections are
  // empty, so the even split left half the answer unspent at three pages a cell.
  const more = new Map();
  const scroll = async (name, limit, offset) => {
    const got = await ask(`${base}/collections/${encodeURIComponent(name)}/points/scroll`, key, { limit, with_payload: true, with_vector: false, ...(offset != null ? { offset } : {}) });
    let kept = 0;
    for (const point of got.result?.points ?? []) {
      const fields = short(point?.payload ?? {});
      if (Object.keys(fields).length) { rows.push({ where: where(name, point?.id), fields }); kept += 1; }
    }
    if (kept && got.result?.next_page_offset != null) more.set(name, got.result.next_page_offset);
  };
  for (const name of asking) {
    if (Date.now() > until) break;
    try { await scroll(name, each); } catch { continue; }
    read += 1;
  }
  // The second sweep spends what the first left, evenly over the collections that had more.
  const rowBytes = rows.length ? JSON.stringify(rows).length / rows.length : ROW_BYTES;
  const extra = Math.min(PER_STORE_MAX - each, Math.floor((BUDGET - JSON.stringify(rows).length) / rowBytes / Math.max(1, more.size)));
  if (extra > 0) {
    for (const [name, offset] of more) {
      if (Date.now() > until) break;
      try { await scroll(name, extra, offset); } catch { /* the first sweep's rows stand */ }
    }
  }
  return store(plan, rows.length ? "sampled" : "empty", rows, `${read} of ${named.length} collections`);
}

const where = (collection, id) => scrub(`${collection}#${id}`).text;

// The real path when it is the project folder or inside it, else null: a variable naming HOME, /etc
// or a link out of the project opens nothing.
const within = (root, path) => {
  try {
    const base = realpathSync(root);
    const real = realpathSync(path);
    return real === base || real.startsWith(base + sep) ? real : null;
  } catch { return null; }
};

// A document folder their own code ingests from, named by its variable, inside the project only.
// Links are not followed: a file in the folder may point anywhere. `may` is the upload's own rule,
// asked of each file before it is opened.
function files(plan, names, env, root, may) {
  const name = names.find((n) => env[n]);
  const set = name ? env[name] : "";
  const dir = set ? within(root, set.startsWith("/") ? set : join(root, set)) : null;
  if (!dir || !statSync(dir).isDirectory()) return store(plan, "no-store", []);
  const home = realpathSync(root);
  const rows = [];
  const walk = (at, depth) => {
    if (rows.length >= ROWS || depth > 8) return;
    let entries;
    try { entries = readdirSync(at, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (rows.length >= ROWS) return;
      if (entry.isDirectory()) { if (!SKIP_DIR.has(entry.name) && !entry.name.startsWith(".")) walk(join(at, entry.name), depth + 1); continue; }
      if (!entry.isFile() || !DOC.test(entry.name) || !may(relative(home, join(at, entry.name)))) continue;
      rows.push({ where: where(name, relative(dir, join(at, entry.name))), fields: short({ file: entry.name, heading: heading(join(at, entry.name)) }) });
    }
  };
  walk(dir, 0);
  return store(plan, rows.length ? "sampled" : "empty", rows);
}

// What the file calls itself: its first line that says something.
function heading(path) {
  try {
    for (const line of readFileSync(path, "utf8").slice(0, 4000).split("\n").slice(0, 60)) {
      const said = line.trim().replace(/^#+/, "").trim();
      if (said) return said.slice(0, STRING_MAX);
    }
  } catch { /* unreadable is no heading */ }
  return "";
}

// Halved until the report fits what one answer carries, pages first and every store together, so a
// store read late is not the only one cut.
function fitted(report) {
  while (JSON.stringify(report).length > BUDGET && report.stores.some((s) => s.rows.length > 1)) {
    for (const s of report.stores) s.rows = s.rows.slice(0, Math.max(1, Math.floor(s.rows.length / 2)));
  }
  return report;
}

// ponytail: a database on this machine is not read yet; the table choice needs the read's own list
// of the tables their AI code names, which the control plane holds and this program does not.
const NO_DATABASE = "Cortad does not sample a database on your own machine yet, so nothing here is written from its rows";
// ponytail: the sandbox reader opens these from inside the box; the same readers on this machine
// are the next ones to write, and until then the row says so rather than going missing.
const NO_READER = "Cortad cannot sample this kind of store on your own machine yet";

export async function sampleHere(plan, env, root, may = () => false) {
  const until = Date.now() + READ_MS;
  const wanted = Number(plan?.perStore);
  const per = Number.isInteger(wanted) && wanted > 0 ? Math.min(wanted, PER_STORE_MAX) : PER_STORE;
  const stores = [];
  for (const asked of (plan?.stores ?? []).slice(0, STORES_MAX)) {
    if (!ROAD.test(String(asked?.road ?? "")) || !KINDS.has(asked?.kind)) continue;
    const named = { road: asked.road, kind: asked.kind };
    const names = (asked.env ?? []).filter((n) => typeof n === "string" && NAME.test(n));
    try {
      if (asked.kind === "qdrant") stores.push(await qdrant(named, names, env, per, until));
      else if (asked.kind === "search") stores.push(await search(named, names, env, per, until));
      else if (asked.kind === "files") stores.push(files(named, names, env, root, may));
      else stores.push(store(named, "no-reader", [], asked.kind === "postgres" ? NO_DATABASE : NO_READER));
    } catch (err) {
      stores.push(store(named, "unreachable", [], reason(err)));
    }
  }
  return fitted({ stores });
}
