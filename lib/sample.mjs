// Reading your own material from your own stores, here on this machine.
//
// A world's shell cannot do this and must not: it runs inside the OS sandbox, which denies every
// env file and every host but this one. A reader written into that shell read nothing on a real
// laptop: no address, no key, no network. The address and the key are in your environment file,
// which this program already opened to mask what your commands print, so the read happens here and
// only rows of short fields go back.
//
// Nothing runnable arrives from the outside: the plan names store kinds and variable NAMES, and
// this file decides what is asked and what is kept. Values are never sent; the rows are.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROAD = /^[\w.:/-]+$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KINDS = new Set(["qdrant", "search", "postgres", "files"]);
const STORES_MAX = 12;
const PER_STORE = 6;
const PER_STORE_MAX = 60;
// A few rows from MANY collections, never many rows from few: a store whose collection names are
// the product's own grid (jordan_grade-10_sem-2_math) is only read when every cell is read. Forty
// eight of them, twenty two rows apiece, filled the whole answer with seven of one app's cells and
// left grade 10 semester 2 maths unread, so the depth follows the breadth: how many rows a
// collection gets is the answer's room divided by how many collections there are.
const COLLECTIONS = 200;
// One row of theirs as this store gave it: a page and its short fields, measured on a real store.
const ROW_BYTES = 800;
const PER_MIN = 2;
const ROWS = 200;
const FIELDS = 12;
const STRING_MAX = 120;
// The one long prose field a row carries is the page itself, kept to what the control plane keeps.
const PAGE_MAX = 700;
const BUDGET = 540_000;
const READ_MS = 50_000;
const ASK_MS = 10_000;

const PII = /(^|_)(e?mail|phone|mobile|tel|fax|password|passwd|pwd|secret|token|otp|ssn|iban|card|address|street|zip|postal|birth|dob|salt|hash|ip)(_|$)|(mail|phone|password|token|secret|hash)$/i;
const CORPUS = /grade|sem|subject|book|lesson|chunk|doc|page|content|unit|chapter|curricul|textbook|knowledge|embed|vector|material|note|article/i;
const RECORDS = /histor|attempt|session|log|event|message|user|profile|audit|analytic|trace|queue|cache|token|auth|billing|payment|invoice/i;
// The narrow security floor: names that are credentials, never a corpus in any product.
const SENSITIVE = /(?:^|[_\-/.])(?:password|passwd|pwd|credential|secret|apikey|api[_-]?key|access[_-]?token|refresh[_-]?token|jwt|session|oauth)s?(?:$|[_\-/.])|^(?:passwords|credentials|api_keys|secrets)$/i;
const DOC = /\.(?:md|mdx|txt|rst|html?|pdf|docx?|csv|json)$/i;
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", ".venv", "venv", "__pycache__", ".next"]);

const store = (plan, status, rows, note = "") => ({ road: plan.road, kind: plan.kind, status, rows, ...(note ? { note } : {}) });
const reason = (err) => String(err?.cause?.code ?? err?.code ?? err?.message ?? err).slice(0, 120);
const valueFor = (names, env, pattern) => names.map((n) => (pattern.test(n) ? env[n] : "")).find(Boolean) ?? "";

// The short fields of one row: numbers, short strings, and at most one page of prose. The page is
// looked for in every column, never in the first twelve alone: a row of theirs carries a dozen ids,
// dates and flags before its text, so a cap that stopped early kept the bookkeeping and dropped the
// page, and the cell had nothing of theirs to ask about.
function short(fields) {
  const out = {};
  let page = null;
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (typeof key !== "string" || PII.test(key) || typeof value === "boolean") continue;
    if (typeof value === "string" && value.trim().length > STRING_MAX) {
      const text = value.trim();
      if (!page || text.length > page[1].length) page = [key, text];
      continue;
    }
    if (Object.keys(out).length >= FIELDS) continue;
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  if (page) out[page[0]] = page[1].slice(0, PAGE_MAX);
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
  if (!res.ok) throw new Error(`answered ${res.status}`);
  return res.json();
}

// The address a store's own variable holds, as a URL this machine can call.
const addressOf = (names, env) => {
  const url = valueFor(names, env, /URL|HOST|ENDPOINT|NODE|ADDRESS/);
  return url && !/^https?:\/\//.test(url) ? `http://${url}` : url;
};

// A keyword index, over the wire Elasticsearch and OpenSearch share. In a product whose answers
// must quote law, regulation or policy, the texts live here and in no vector store: their hundred
// gigabytes were read as nothing at all, and every simulated question was written from nothing of
// theirs. A key rides in the Authorization header, where both engines read one.
async function search(plan, names, env, per, until) {
  const base = addressOf(names, env)?.replace(/\/+$/, "");
  const key = valueFor(names, env, /KEY|TOKEN|PASSWORD/);
  if (!base) return store(plan, "no-store", []);
  const auth = key ? `ApiKey ${key}` : "";
  let every;
  try {
    every = (await ask(`${base}/_cat/indices?format=json&h=index`, auth, null, "authorization"))
      .map((row) => String(row?.index ?? "")).filter((name) => name && !name.startsWith("."));
  } catch (err) {
    return store(plan, "unreachable", [], reason(err));
  }
  const corpus = every.filter((n) => CORPUS.test(n) && !SENSITIVE.test(n));
  const named = (corpus.length ? corpus : every.filter((n) => !SENSITIVE.test(n))).sort((a, b) => rank(a).localeCompare(rank(b)));
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
        if (Object.keys(fields).length) rows.push({ where: `${name}#${hit?._id}`, fields });
      }
      read += 1;
    } catch { continue; }
  }
  return store(plan, rows.length ? "sampled" : "empty", rows, `${read} of ${named.length} indexes`);
}

async function qdrant(plan, names, env, per, until) {
  const base = addressOf(names, env)?.replace(/\/+$/, "");
  const key = valueFor(names, env, /KEY|TOKEN/);
  if (!base) return store(plan, "no-store", []);
  let every;
  try {
    every = ((await ask(`${base}/collections`, key)).result?.collections ?? []).map((c) => String(c?.name ?? "")).filter(Boolean);
  } catch (err) {
    return store(plan, "unreachable", [], reason(err));
  }
  const corpus = every.filter((n) => CORPUS.test(n) && !SENSITIVE.test(n));
  const named = (corpus.length ? corpus : every.filter((n) => !SENSITIVE.test(n))).sort((a, b) => rank(a).localeCompare(rank(b)));
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
      if (Object.keys(fields).length) { rows.push({ where: `${name}#${point?.id}`, fields }); kept += 1; }
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

// A document folder their own code ingests from, named by its variable and walked from your root.
function files(plan, names, env, root) {
  const name = names.find((n) => env[n]);
  const set = name ? env[name] : "";
  const dir = set && !set.startsWith("/") ? join(root, set) : set;
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) return store(plan, "no-store", []);
  const rows = [];
  const walk = (at, depth) => {
    if (rows.length >= ROWS || depth > 8) return;
    let entries;
    try { entries = readdirSync(at, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (rows.length >= ROWS) return;
      if (entry.isDirectory()) { if (!SKIP_DIR.has(entry.name) && !entry.name.startsWith(".")) walk(join(at, entry.name), depth + 1); continue; }
      if (!DOC.test(entry.name)) continue;
      rows.push({ where: `${name}#${relative(dir, join(at, entry.name))}`, fields: { file: entry.name, heading: heading(join(at, entry.name)) } });
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
const NO_DATABASE = "we do not read a database from your own machine yet, so nothing here is written from its rows";

export async function sampleHere(plan, env, root) {
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
      else if (asked.kind === "files") stores.push(files(named, names, env, root));
      else stores.push(store(named, "no-reader", [], NO_DATABASE));
    } catch (err) {
      stores.push(store(named, "unreachable", [], reason(err)));
    }
  }
  return fitted({ stores });
}
