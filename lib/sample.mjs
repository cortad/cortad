import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { scrub, scrubValue } from "./redact.mjs";

const ROAD = /^[\w.:/-]+$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const KINDS = new Set(["qdrant", "chroma", "weaviate", "search", "postgres", "files"]);

const PORTS = { qdrant: 6333, chroma: 8000, weaviate: 8080, search: 9200 };

const PRIVATE = /^(?:localhost|\[?::1\]?|\d+\.\d+\.\d+\.\d+|[A-Za-z0-9_-]+)$/;
const STORES_MAX = 12;
const PER_STORE = 6;
const PER_STORE_MAX = 60;
const RECORD_MAX = 700;

const COLLECTIONS = 200;

const ROW_BYTES = 800;
const PER_MIN = 2;
const ROWS = PER_STORE_MAX;
const FIELDS = 12;
const STRING_MAX = 120;
const BUDGET = 540_000;
const READ_MS = 50_000;
const ASK_MS = 10_000;

const PII = /(^|_)(e?mail|phone|mobile|tel|fax|password|passwd|pwd|secret|token|otp|ssn|iban|card|address|street|zip|postal|birth|dob|salt|hash|ip)(_|$)|(mail|phone|password|token|secret|hash)$/i;
const CORPUS = /grade|sem|subject|book|lesson|chunk|doc|page|content|unit|chapter|curricul|textbook|knowledge|embed|vector|material|note|article/i;
const RECORDS = /histor|attempt|session|log|event|message|user|profile|audit|analytic|trace|queue|cache|token|auth|billing|payment|invoice/i;

const SENSITIVE = /(?:^|[_\-/.])(?:password|passwd|pwd|credential|secret|apikey|api[_-]?key|access[_-]?token|refresh[_-]?token|jwt|session|oauth)s?(?:$|[_\-/.])|^(?:passwords|credentials|api_keys|secrets)$/i;
const DOC = /\.(?:md|mdx|txt|rst|html?|pdf|docx?|csv|json)$/i;
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", ".venv", "venv", "__pycache__", ".next"]);

const store = (plan, status, rows, note = "") => ({ road: plan.road, kind: plan.kind, status, rows, ...(note ? { note } : {}) });

const reason = (err) => {
  const code = err?.cause?.code ?? err?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(code)) return code;
  return err?.name === "TimeoutError" ? "TIMEOUT" : "the store did not answer";
};
const ADDRESS = /URL|URI|HOST|ENDPOINT|NODE|ADDRESS/;

const familyOf = (name) => name.replace(/_?(?:URLS?|URIS?|HOSTS?|ENDPOINTS?|NODES?|ADDRESS|PORT|API_?KEY|KEY|TOKEN|PASSWORD|SECRET)$/i, "").toUpperCase();
const valueFor = (names, env, pattern, family) => names.map((n) => (pattern.test(n) && (family === undefined || familyOf(n) === family) ? env[n] : "")).find(Boolean) ?? "";

function address(kind, names, env) {
  const name = names.find((n) => ADDRESS.test(n) && env[n]);
  if (!name) return { base: "", family: null };
  const named = String(env[name]);
  const family = familyOf(name);
  const url = new URL(named.includes("://") ? named : `${PRIVATE.test(named.split(":")[0]) ? "http" : "https"}://${named}`);
  const port = valueFor(names, env, /PORT/, family);

  if (url.username || url.password) throw Object.assign(new Error("address carries credentials"), { code: "ADDRESS_HAS_CREDENTIALS" });
  if (!url.port) url.port = /^\d{1,5}$/.test(port) ? port : PRIVATE.test(url.hostname) ? String(PORTS[kind]) : "";
  return { base: url.toString().replace(/\/+$/, ""), family };
}

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
  const corpus = every.filter((n) => CORPUS.test(n) && !SENSITIVE.test(n));
  const named = (corpus.length ? corpus : every.filter((n) => !SENSITIVE.test(n))).sort((a, b) => rank(a).localeCompare(rank(b)));
  const asking = spread(named).slice(0, COLLECTIONS);
  const each = Math.max(PER_MIN, Math.min(per, Math.floor(BUDGET / ROW_BYTES / Math.max(1, asking.length))));
  const rows = [];
  let read = 0;

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

  const rowBytes = rows.length ? JSON.stringify(rows).length / rows.length : ROW_BYTES;
  const extra = Math.min(PER_STORE_MAX - each, Math.floor((BUDGET - JSON.stringify(rows).length) / rowBytes / Math.max(1, more.size)));
  if (extra > 0) {
    for (const [name, offset] of more) {
      if (Date.now() > until) break;
      try { await scroll(name, extra, offset); } catch {  }
    }
  }
  return store(plan, rows.length ? "sampled" : "empty", rows, `${read} of ${named.length} collections`);
}

const where = (collection, id) => scrub(`${collection}#${id}`).text;

const within = (root, path) => {
  try {
    const base = realpathSync(root);
    const real = realpathSync(path);
    return real === base || real.startsWith(base + sep) ? real : null;
  } catch { return null; }
};

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

function heading(path) {
  try {
    for (const line of readFileSync(path, "utf8").slice(0, 4000).split("\n").slice(0, 60)) {
      const said = line.trim().replace(/^#+/, "").trim();
      if (said) return said.slice(0, STRING_MAX);
    }
  } catch {  }
  return "";
}

function fitted(report) {
  while (JSON.stringify(report).length > BUDGET && report.stores.some((s) => s.rows.length > 1)) {
    for (const s of report.stores) s.rows = s.rows.slice(0, Math.max(1, Math.floor(s.rows.length / 2)));
  }
  return report;
}

const NO_DATABASE = "Cortad does not sample a database on your own machine yet, so nothing here is written from its rows";

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
