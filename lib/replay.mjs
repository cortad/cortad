import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { SourceMap } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CODE, TEST } from "./files.mjs";
import { canaryOf, doorOf, doorsOf, exchangesOf, isCanary, proofOf, provingOf, sitesOf } from "./proof.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "trace.cjs");
const PYHOOK = join(HERE, "pyhook");
export const CAPTURED = "captured";

export const AS_HEADER = "x-cortad-as";

const SECRET_HEADER = /authorization|cookie|token|secret|session|csrf|api-?key/i;
const HOP = /^(?:host|content-length|connection|keep-alive|transfer-encoding|upgrade|expect|te|trailer|accept-encoding|x-cortad-as|x-cortad-turn)$/i;

export function makeCapture({ work, keepSecret, onProof = () => {}, writes = null, root = null, files = () => [], appFolder = () => "", printed = () => "", signIns = null }) {
  const file = join(work, "trace.jsonl");
  let read = 0;
  const accounts = makeAccounts(signIns);
  for (const headers of accounts.kept()) for (const [k, v] of Object.entries(headers)) if (SECRET_HEADER.test(k)) keepSecret(String(v).replace(/^Bearer\s+/i, ""));
  let alive = false;

  const ports = new Set();

  const hellos = new Set();

  const tables = new Map();
  let newestTable = null;

  const conns = new Map();

  const answers = new Map();

  const taken = new Map();

  let toolState = null;

  const bunHook = /\s/.test(HOOK) ? (() => {
    const dir = mkdtempSync(join(tmpdir(), "cortad-"));
    for (const name of ["trace.cjs", "wire.cjs", "tied.cjs"]) copyFileSync(join(HERE, name), join(dir, name));
    return join(dir, "trace.cjs");
  })() : HOOK;

  const env = (base) => ({
    CORTAD_TRACE_FILE: file,

    CORTAD_RULES_FILE: join(work, "rules.json"),

    CORTAD_TOOLS_FILE: join(work, "tools.json"),

    ...(writes && root ? { CORTAD_WRITES_DIR: writes, CORTAD_APP_ROOT: root } : {}),
    NODE_OPTIONS: `${base.NODE_OPTIONS ?? ""} --require ${JSON.stringify(HOOK)}`.trim(),
    BUN_OPTIONS: `${base.BUN_OPTIONS ?? ""} --preload=${bunHook}`.trim(),
    PYTHONPATH: [PYHOOK, base.PYTHONPATH].filter(Boolean).join(":"),
  });

  const carriers = new Map();
  const sent = (payload) => {
    const s = payload?.proof?.session;
    if (s?.held && (s.carrier === "cookie" || s.carrier === "header") && s.key) carriers.set(`${payload.door.method} ${payload.door.path}`, { carrier: s.carrier, key: String(s.key).toLowerCase() });
    onProof(payload);
  };
  const find = root ? sourceFinder(root, files) : null;
  const contact = makeContact({ onProof: sent, appFolder, printed, accounts: accounts.kept, find: find ?? (() => null), found: find && ((literal) => Boolean(find(literal, [], true))), routes: () => [...tables.values()].flatMap((t) => t.routes) });
  function poll() {
    let size = 0;
    try { size = statSync(file).size; } catch { return; }
    if (size <= read) return;

    const fresh = readFileSync(file).subarray(read, size).toString("utf8");
    read = size;
    for (const line of fresh.split("\n").filter(Boolean)) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row.hello) { alive = true; if (Number.isInteger(row.pid)) hellos.add(row.pid); continue; }
      if (Number.isInteger(row.listen)) { ports.add(row.listen); continue; }
      if (row.routes) { const t = routeTable(row.routes); if (t) { tables.set(t.port, t); newestTable = t; } continue; }
      if (row.conn) { const { host, port } = row.conn; if (typeof host === "string" && Number.isInteger(port)) conns.set(`${host}:${port}`, { host, port }); continue; }
      if (row.tools) { toolState = toolStateOf(row.tools) ?? toolState; continue; }
      if (row.answer) {
        const { turn, status, reply } = row.answer;
        if (TURN.test(turn ?? "")) answers.set(turn, { status: Number.isInteger(status) ? status : 0, reply: typeof reply === "string" ? reply : "" });
        if (answers.size > ANSWERS_KEPT) answers.delete(answers.keys().next().value);
        continue;
      }
      if (row.receipt) {
        const r = row.receipt;
        if (typeof r.ex === "string" && typeof r.method === "string" && typeof r.path === "string" && r.path.startsWith("/") && r.turn === undefined) {
          const door = doorOf({ method: r.method.toUpperCase(), path: r.path }, newestTable?.routes ?? []).key;
          taken.delete(door);
          taken.set(door, { ex: r.ex, at: Number(r.at) || 0, followed: false });
          if (taken.size > RECEIPTS_KEPT) taken.delete(taken.keys().next().value);
        }
        continue;
      }

      if (row.call) for (const [door, r] of taken) if (row.call.ex === r.ex) taken.delete(door); else if (typeof row.call.ex !== "string" && (Number(row.call.at) || 0) > r.at) r.followed = true;
      if (row.call) { row.call.caller = placed(row.call.caller); meter.add(row.call); contact.add(row); continue; }
      if (row.dep) { row.dep.caller = placed(row.dep.caller); meter.dep(row.dep); contact.add(row); continue; }
      if (row.sites) { row.sites.list = placedSites(row.sites.list); meter.sites(row.sites); contact.add(row); continue; }
      if (typeof row.ex !== "string" || typeof row.method !== "string" || typeof row.path !== "string" || !row.path.startsWith("/")) continue;
      for (const [door, r] of taken) if (r.ex === row.ex) taken.delete(door);
      const headers = Object.fromEntries(Object.entries(row.headers ?? {}).filter(([k, v]) => !HOP.test(k) && typeof v === "string"));
      for (const [k, v] of Object.entries(headers)) if (SECRET_HEADER.test(k)) keepSecret(String(v).replace(/^Bearer\s+/i, ""));

      if (typeof row.turn !== "string" || row.turn.startsWith("reach:")) accounts.keep(headers, `${row.method} ${row.path.split("?")[0]}`, row.body);
      contact.add(row);
    }
    contact.flush();
  }
  const timer = setInterval(poll, 700);
  timer.unref();
  return {
    env,

    file,
    rulesFile: join(work, "rules.json"),

    headers: (role = CAPTURED) => { const own = accounts.speak(role); return own ? withoutCarriers(own, [...carriers.values()]) : null; },

    bodyAs: (role, door, body) => accounts.bodyAs(role, door, body),

    watching: (port) => { poll(); return ports.has(port) || (alive && ports.size === 0); },
    alive: () => { poll(); return alive; },

    hookedAt: (port, pid) => { poll(); return ports.has(port) || hellos.has(pid); },

    usage: (turn, totalsOnly = false) => { poll(); return alive ? meter.report(TURN.test(turn ?? "") ? turn : undefined, totalsOnly) : null; },

    tools: () => { poll(); return toolState; },

    registry: (port) => { poll(); return tables.get(port) ?? newestTable ?? {}; },

    connections: () => { poll(); return [...conns.values()]; },

    answered: async (turn, until, signal) => {
      for (;;) {
        poll();
        if (answers.has(turn) || Date.now() >= until || signal?.aborted) return answers.get(turn) ?? null;
        await new Promise((r) => setTimeout(r, 200));
      }
    },
    forget: (turn) => { answers.delete(turn); },

    proveAgain: () => { contact.again(); contact.flush(); },

    receipts: () => { poll(); return [...taken].filter(([, r]) => Date.now() - r.at > RECEIPT_WAIT_MS).map(([door, r]) => ({ door, followed: r.followed })); },
  };
}

const EXCHANGES_KEPT = 200, LOOSE_KEPT = 500, PER_DOOR = 8, ANSWERS_KEPT = 500, RECEIPTS_KEPT = 50;

const RECEIPT_WAIT_MS = 3000;
function makeContact({ onProof, find, found, appFolder, routes, printed, accounts = () => [] }) {
  const kept = new Map();
  let counted = 0;
  const loose = new Map();
  const sent = new Map();
  const dirty = new Set();

  const firstErrors = new Map();
  const bound = (map, max) => { while (map.size > max) map.delete(map.keys().next().value); };

  const boundKept = () => {
    while (kept.size > EXCHANGES_KEPT) {
      const ours = [...kept].find(([, rows]) => typeof rows[0].turn === "string");
      kept.delete(ours ? ours[0] : kept.keys().next().value);
    }
  };
  return {
    add(row) {
      const id = row.ex ?? row.call?.ex ?? row.dep?.ex ?? row.sites?.ex;
      if (typeof id !== "string") return;

      if (typeof row.ex === "string") { kept.set(id, [row, ...(kept.get(id) ?? []).filter((r) => typeof r.ex !== "string"), ...(loose.get(id) ?? [])]); loose.delete(id); boundKept(); dirty.add(id); }
      else if (kept.has(id)) { kept.get(id).push(row); dirty.add(id); }
      else { loose.set(id, [...(loose.get(id) ?? []), row]); bound(loose, LOOSE_KEPT); }
    },
    again() { sent.clear(); counted = -1; },
    flush() {

      const signIns = accounts();
      const recount = signIns.length !== counted;
      counted = signIns.length;
      if (!dirty.size && !recount) return;
      const all = exchangesOf([...kept.values()].flat());
      const canaries = doorsOf(all.filter(isCanary), routes());
      for (const [key, { door, exchanges }] of doorsOf(all.filter((ex) => !isCanary(ex)), routes())) {
        const tried = canaries.get(key)?.exchanges ?? [];
        if (!recount && ![...exchanges, ...tried].some((ex) => dirty.has(ex.id))) continue;
        const payload = proofOf(provingOf(exchanges).slice(-PER_DOOR), door, { find, base: appFolder(), printed, firstErrors, others: all });
        const canary = canaryOf(tried, payload.proof, found, provingOf(exchanges));
        if (canary) payload.proof.canary = canary;
        if (signIns.length > 1) payload.proof.accounts = signIns.length;
        const json = JSON.stringify(payload);
        if (sent.get(key) === json) continue;
        sent.set(key, json);

        const signedIn = payload.template.headerNames.length ? exchanges.findLast((ex) => !ex.trial) : null;
        const identity = signedIn ? soonest(identityOf(signedIn.headers), signIns) : null;
        try { onProof(identity ? { ...payload, proof: { ...payload.proof, identity } } : payload); } catch {  }
      }
      bound(firstErrors, EXCHANGES_KEPT);
      dirty.clear();
    },
  };
}

const DOCS = /(?:^|\/)docs?\//;
export function sourceFinder(root, files) {
  const found = new Map();
  const lineIn = (rel, literal) => {
    let text;
    try { text = readFileSync(join(root, rel), "utf8"); } catch { return null; }
    const i = text.indexOf(literal);
    return i < 0 ? null : { file: rel, line: text.slice(0, i).split("\n").length };
  };
  const search = (literal, near, any) => {
    const all = files();
    const shared = new Set(all);
    for (const rel of near) {
      const at = shared.has(rel) ? lineIn(rel, literal) : null;
      if (at) return at;
    }
    let only = null;
    for (const rel of all) {
      if ((!any && (!CODE.test(rel) || DOCS.test(rel))) || TEST.test(rel) || near.includes(rel)) continue;
      const at = lineIn(rel, literal);
      if (!at) continue;
      if (any) return at;
      if (only) return null;
      only = at;
    }
    return only;
  };
  return (literal, near = [], any = false) => {
    if (typeof literal !== "string" || literal.trim().length < 3) return null;
    const key = `${any ? "any" : ""}\0${near.join("\n")}\0${literal}`;
    if (!found.has(key)) found.set(key, search(literal, near, any));
    return found.get(key);
  };
}

const FRAMEWORKS = new Set(["fastapi", "starlette", "flask", "django", "quart", "litestar", "aiohttp", "express", "fastify", "hono", "koa", "elysia", "nest", "unknown"]);
const OPENAPI_MAX = 8 * 1024 * 1024;
const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

const routeTable = (r) => {
  if (!r || typeof r !== "object" || !Array.isArray(r.routes)) return null;
  const openapi = r.openapi && typeof r.openapi === "object" && !Array.isArray(r.openapi) && JSON.stringify(r.openapi).length <= OPENAPI_MAX ? r.openapi : null;
  return {
    framework: FRAMEWORKS.has(r.framework) ? r.framework : "unknown",
    port: Number.isInteger(r.port) && r.port > 0 && r.port < 65536 ? r.port : null,
    routes: r.routes
      .filter((x) => x && /^[A-Za-z]{1,10}$/.test(x.method) && typeof x.path === "string" && x.path.startsWith("/"))
      .slice(0, 400)
      .map((x) => ({ method: x.method.toUpperCase(), path: x.path.slice(0, 1024), file: text(x.file, 512), handler: text(x.handler, 200) })),
    openapi,
  };
};

const toolNames = (v) => (Array.isArray(v) ? v.filter((n) => typeof n === "string" && n).slice(0, 200).map((n) => n.slice(0, 80)) : null);
const toolStateOf = (t) => { const wrapped = toolNames(t?.wrapped), unwatched = toolNames(t?.unwatched); return wrapped && unwatched ? { wrapped, unwatched } : null; };

const ROWS = 5000, REPORTED = 400;

const TURN = /^[A-Za-z0-9:_.-]{1,80}$/;
const RULE_ID = /^[\w:-]{1,64}$/;
const turnOf = (v) => (typeof v === "string" && TURN.test(v) ? { turn: v } : {});
const rulesOf = (v) => (Array.isArray(v) ? { rules: v.filter((id) => typeof id === "string" && RULE_ID.test(id)).slice(0, 300) } : {});

const texts = (v) => (Array.isArray(v) ? v.filter((t) => t && typeof t.text === "string" && t.text.trim()).slice(0, 12).map((t) => ({ name: String(t.name ?? "").slice(0, 80), text: t.text.slice(0, 3000), ...(t.kind === "data" ? { kind: "data" } : {}), ...(t.provider === true ? { provider: true } : {}) })) : []);
const toolsOf = (v) => (texts(v).length ? { tools: texts(v) } : {});

const calledOf = (v) => {
  const called = Array.isArray(v) ? v.filter((c) => c && typeof c.name === "string" && c.name && typeof c.arguments === "string").slice(0, 12).map((c) => ({ name: c.name.slice(0, 80), arguments: c.arguments.slice(0, 1200), ...(typeof c.refused === "string" && c.refused ? { refused: c.refused.slice(0, 300) } : {}) })) : [];
  return called.length ? { called } : {};
};
const passagesOf = (v) => (texts(v).length ? { passages: texts(v).slice(0, 6) } : {});

const AT = /^[^\n\r\t]{1,300}:\d{1,7}$/;
const CALLERS_MAX = 5;
const callerOf = (v) => { const caller = Array.isArray(v) ? v.filter((c) => typeof c === "string" && AT.test(c)).slice(0, CALLERS_MAX) : []; return caller.length ? { caller } : {}; };

const NAME = /^[\w.:-]{1,80}$/;
const names = (v, max) => (Array.isArray(v) ? v.filter((n) => typeof n === "string" && NAME.test(n)).slice(0, max) : []);
const toldOf = (call) => {
  const offered = names(call.offered, 60);
  const declared = (Array.isArray(call.declared) ? call.declared : []).filter((d) => d && typeof d.name === "string" && NAME.test(d.name)).slice(0, 60)
    .map((d) => ({ name: d.name, ...(typeof d.does === "string" && d.does.trim() ? { does: d.does.trim().slice(0, 300) } : {}), requires: names(d.requires, 12) }));
  return { ...(typeof call.instructions === "string" ? { instructions: call.instructions.slice(0, 12_000) } : {}), ...(offered.length ? { offered } : {}), ...(declared.length ? { declared } : {}) };
};

const MODEL_WORDS = 4000, SITES_KEPT = 500;
function tally(totals, call, count) {
  const host = call.host.slice(0, 253);
  const model = String(call.model ?? "").slice(0, 160);
  const answered = typeof call.answered === "string" && call.answered ? call.answered.slice(0, 160) : undefined;
  const key = `${host}|${model}`;
  const t = totals.get(key) ?? { host, model, calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, unmetered: 0, answered, mixed: false };
  t.calls += 1;

  if (t.answered !== answered) t.mixed = true;
  t.promptTokens += count(call.promptTokens);
  t.cachedTokens += count(call.cachedTokens);
  t.completionTokens += count(call.completionTokens);

  const status = count(call.status);

  if (call.estimated === true) t.estimated = (t.estimated ?? 0) + 1;
  else if (call.usage !== true && status > 0 && status < 400) t.unmetered += 1;
  totals.set(key, t);
}

const meter = (() => {
  const rows = [];
  const deps = [];

  const totals = new Map();
  const sitesOfEx = new Map();
  const count = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
  return {
    add(call) {
      if (!call || typeof call.host !== "string" || !call.host) return;
      tally(totals, call, count);
      rows.push({
        at: count(call.at), ms: count(call.ms), host: call.host.slice(0, 253), model: String(call.model ?? "").slice(0, 160), ...(typeof call.answered === "string" && call.answered ? { answered: call.answered.slice(0, 160) } : {}), status: count(call.status),
        promptTokens: count(call.promptTokens), cachedTokens: count(call.cachedTokens), completionTokens: count(call.completionTokens),
        usage: call.usage === true, ...turnOf(call.turn), ...rulesOf(call.rules), ...toolsOf(call.tools), ...calledOf(call.called), ...passagesOf(call.passages), ...callerOf(call.caller),
        ...(typeof call.ex === "string" ? { ex: call.ex } : {}), told: toldOf(call), ...(typeof call.reply === "string" ? { said: call.reply.slice(0, MODEL_WORDS) } : {}),
        ...(call.limit && typeof call.limit === "object" ? { limit: { cap: count(call.limit.cap) || null, reasoning: count(call.limit.reasoning) } } : {}),
      });
      if (rows.length > REPORTED) { const old = rows[rows.length - REPORTED - 1]; delete old.told; delete old.said; }
      if (rows.length > ROWS) rows.splice(0, rows.length - ROWS);
    },

    dep(d) {
      if (!d || typeof d.host !== "string" || !d.host) return;
      const env = typeof d.env === "string" && /^[A-Z_][A-Z0-9_]*$/.test(d.env) ? d.env : undefined;
      deps.push({ at: count(d.at), ...(env ? { env } : {}), host: d.host.slice(0, 253), status: count(d.status), ...(typeof d.code === "string" ? { code: d.code.slice(0, 40) } : {}), ...(d.held === true ? { held: true } : {}), ...turnOf(d.turn), ...passagesOf(d.passages), ...toolsOf(d.tools), ...calledOf(d.called) });
      if (deps.length > ROWS) deps.splice(0, deps.length - ROWS);
    },
    sites(s) {
      if (typeof s?.ex !== "string") return;
      sitesOfEx.set(s.ex, sitesOf(s.list));
      if (sitesOfEx.size > SITES_KEPT) sitesOfEx.delete(sitesOfEx.keys().next().value);
    },

    report(turn, totalsOnly = false) {
      const spent = [...totals.values()].sort((a, b) => b.calls - a.calls).map(({ answered, mixed, ...t }) => (answered && !mixed ? { ...t, answered } : t));
      if (totalsOnly) return { totals: spent };
      return {
        totals: spent,
        rows: rows.slice(-REPORTED).reverse().map(({ at, ms, host, model, status, turn: pinned, rules, tools, called, passages, caller, ex, told, said }) => ({ at, ms, host, model, status, ...(pinned ? { turn: pinned } : {}), ...(rules ? { rules } : {}), ...(tools ? { tools } : {}), ...(called ? { called } : {}), ...(passages && turn !== undefined && pinned === turn ? { passages } : {}), ...(caller ? { caller } : {}),
          ...(turn !== undefined && pinned === turn ? { ...told, ...(said !== undefined ? { said } : {}), ...(sitesOfEx.get(ex)?.length ? { sites: sitesOfEx.get(ex) } : {}) } : {}) })),
        deps: deps.slice(-REPORTED).reverse(),
      };
    },
  };
})();

export function withoutCarriers(headers, carriers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (carriers.some((c) => c.carrier === "header" && c.key === lower)) continue;
    if (lower === "cookie") {
      const kept = String(value).split(/;\s*/).filter((pair) => !carriers.some((c) => c.carrier === "cookie" && pair.split("=")[0].trim().toLowerCase() === c.key));
      if (kept.length) out[name] = kept.join("; ");
      continue;
    }
    out[name] = value;
  }
  return out;
}

const JWT = /^[\w-]{8,}\.([\w-]{8,})\.[\w-]{8,}$/;
const expOf = (token) => {
  const payload = JWT.exec(token)?.[1];
  if (!payload) return null;
  try { const exp = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))?.exp; return Number.isFinite(exp) ? exp : null; } catch { return null; }
};

function soonest(own, signIns) {
  if (own.kind === "none" || signIns.length < 2) return own;
  const ends = signIns.map((headers) => identityOf(headers).expiresInS);
  const i = ends.reduce((best, s, at) => (s !== null && (ends[best] === null || s < ends[best]) ? at : best), 0);
  if (ends[i] === null || (own.expiresInS !== null && own.expiresInS < ends[i])) return own;
  return { ...own, expiresInS: ends[i], ...(i > 0 ? { account: i + 1 } : {}) };
}

const ACCOUNTS_MAX = 4;
const ACCOUNT_ROLE = /^captured(?::account([2-4]))?$/;

const LEAVES_MAX = 60, LEAF_MAX = 200, LEAF_DEPTH = 4;
function leavesOf(body) {
  const out = new Map();
  const walk = (v, path, depth) => {
    if (out.size >= LEAVES_MAX || depth > LEAF_DEPTH) return;
    if (v && typeof v === "object" && !Array.isArray(v)) { for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, depth + 1); return; }
    if ((typeof v === "string" && v.length <= LEAF_MAX) || typeof v === "number" || typeof v === "boolean") out.set(path, v);
  };
  try { walk(typeof body === "string" ? JSON.parse(body) : body, "", 0); } catch {  }
  return out;
}

export function makeAccounts(file = null) {
  const kept = [];
  let bare = null;
  if (file) {
    try {
      const stored = JSON.parse(readFileSync(file, "utf8"));

      const visitor = Array.isArray(stored) ? null : stored?.visitor;
      if (visitor && typeof visitor === "object" && !signInKey(visitor)) bare = Object.fromEntries(Object.entries(visitor).filter(([k, v]) => typeof k === "string" && typeof v === "string"));
      for (const a of Array.isArray(stored) ? stored : stored?.accounts ?? []) {
        if (kept.length >= ACCOUNTS_MAX || typeof a?.key !== "string" || !a.headers || typeof a.headers !== "object") continue;
        const headers = Object.fromEntries(Object.entries(a.headers).filter(([k, v]) => typeof k === "string" && typeof v === "string"));
        if (signInKey(headers) !== a.key || (identityOf(headers).expiresInS ?? 1) <= 0) continue;
        kept.push({ key: a.key, headers, bodies: new Map(Object.entries(a.bodies ?? {}).map(([door, leaves]) => [door, new Map(Object.entries(leaves ?? {}))])) });
      }
    } catch {  }
  }
  const save = () => {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify({ visitor: bare, accounts: kept.map((a) => ({ key: a.key, headers: a.headers, bodies: Object.fromEntries([...a.bodies].map(([door, leaves]) => [door, Object.fromEntries(leaves)])) })) }), { mode: 0o600 });
    } catch {  }
  };
  const at = (role) => { const m = ACCOUNT_ROLE.exec(role); return m ? kept[Number(m[1] ?? 1) - 1] ?? kept[0] ?? null : null; };
  return {

    keep(headers, door, body) {
      const key = signInKey(headers);
      if (!key) { bare = headers; save(); return; }
      let account = kept.find((a) => a.key === key);
      if (account) account.headers = headers;
      else {
        account = { key, headers, bodies: new Map() };
        const ended = kept.findIndex((a) => (identityOf(a.headers).expiresInS ?? 1) <= 0);
        if (kept.length < ACCOUNTS_MAX) kept.push(account);
        else if (ended >= 0) kept[ended] = account;
        else return;
      }
      if (door) account.bodies.set(door, leavesOf(body));
      save();
    },
    kept: () => kept.map((a) => a.headers),
    speak(role) {
      const m = ACCOUNT_ROLE.exec(role);
      if (!m) return null;
      return at(role)?.headers ?? bare;
    },

    bodyAs(role, door, body) {
      const me = at(role);
      if (!me || kept.length < 2 || body === undefined || body === null) return body;
      let parsed;
      try { parsed = typeof body === "string" ? JSON.parse(body) : body; } catch { return body; }
      const mine = (path) => me.bodies.get(door)?.get(path) ?? [...me.bodies.values()].map((b) => b.get(path)).find((v) => v !== undefined);
      const others = kept.filter((a) => a !== me);
      let changed = false;
      const walk = (v, path, depth) => {
        if (v && typeof v === "object" && !Array.isArray(v) && depth <= LEAF_DEPTH) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, path ? `${path}.${k}` : k, depth + 1)]));
        const own = mine(path);
        if (own === undefined || own === v || !others.some((a) => a.bodies.get(door)?.get(path) === v)) return v;
        changed = true;
        return own;
      };
      const out = walk(parsed, "", 0);
      return !changed ? body : typeof body === "string" ? JSON.stringify(out) : out;
    },
  };
}

const SIGN_IN_HEADER = /^(?:authorization|proxy-authorization|cookie)$|api[-_]?key|token|secret|session|auth/i;
const NOT_WHO = /csrf|xsrf/i;
function signInKey(headers) {
  const signIns = [];
  for (const [name, value] of Object.entries(headers)) {
    if (!SIGN_IN_HEADER.test(name) || NOT_WHO.test(name)) continue;
    if (name.toLowerCase() !== "cookie") { signIns.push([name, String(value).replace(/^bearer\s+/i, "")]); continue; }
    const pairs = String(value).split(/;\s*/).map((pair) => pair.split("=")).filter(([k, ...v]) => k && v.length && !NOT_WHO.test(k)).map(([k, ...v]) => [k, v.join("=")]);
    const named = pairs.filter(([k]) => SIGN_IN_HEADER.test(k) || /sid|jwt|user|login/i.test(k));
    signIns.push(...(named.length ? named : pairs));
  }
  const subjects = signIns.map(([, v]) => subjectOf(v)).filter(Boolean);
  return (subjects.length ? subjects : signIns.map(([k, v]) => `${k}=${v}`)).sort().join("\n");
}
const subjectOf = (token) => {
  const payload = JWT.exec(token)?.[1];
  if (!payload) return null;
  try { const { iss = "", sub } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); return typeof sub === "string" && sub ? `${iss}|${sub}` : null; } catch { return null; }
};

export function identityOf(headers, now = Date.now()) {
  if (!headers) return null;
  const named = (name) => String(Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1] ?? "");
  const auth = named("authorization");

  const cookies = named("cookie").split(/;\s*/).map((pair) => pair.split("=")).filter(([name]) => !/csrf|xsrf/i.test(name)).map((kv) => kv.slice(1).join("=")).filter(Boolean);
  const kind = /^bearer\s/i.test(auth) ? "bearer" : auth ? "authorization" : cookies.length ? "cookie" : "none";
  const exps = [auth.replace(/^bearer\s+/i, ""), ...cookies].map(expOf).filter((e) => e !== null);
  return { kind, expiresInS: exps.length ? Math.round(Math.min(...exps) - now / 1000) : null };
}

const BUILT = /\/(?:\.next|\.nuxt|\.svelte-kit|\.output|\.turbo|\.vercel|dist|build|out)\//;
const BUILT_AT = /^(\/[^\n\r\t]{1,1000}):(\d{1,7}):(\d{1,7})$/;
const MAPS_KEPT = 64, MAP_BYTES = 64 * 1024 * 1024;
const maps = new Map();
function mapOf(chunk) {
  let mtime;
  try { mtime = statSync(chunk).mtimeMs; } catch { return null; }
  const had = maps.get(chunk);
  if (had?.mtime === mtime) return had.map;
  let map = null;
  try {
    const text = readFileSync(chunk, "utf8");
    const url = /\/\/[#@] sourceMappingURL=(\S+)\s*$/.exec(text)?.[1];
    const inline = url?.startsWith("data:") ? url.slice(url.indexOf(",") + 1) : null;
    const file = url && !inline ? join(dirname(chunk), decodeURIComponent(url)) : `${chunk}.map`;

    if (inline === null && relative(chunk.slice(0, chunk.search(BUILT)), file).startsWith("..")) throw new Error("outside the build");
    if (inline === null && statSync(file).size > MAP_BYTES) throw new Error("too large");
    const payload = inline === null ? readFileSync(file, "utf8") : url.includes(";base64,") ? Buffer.from(inline, "base64").toString("utf8") : decodeURIComponent(inline);
    map = new SourceMap(JSON.parse(payload));
  } catch {  }
  maps.set(chunk, { mtime, map });
  while (maps.size > MAPS_KEPT) maps.delete(maps.keys().next().value);
  return map;
}

function sourcePath(source, root) {
  let s = String(source).replace(/^webpack:\/\/[^/]*\//, "").replace(/^turbopack:\/\/\//, "").replace(/^\[project\]\//, "").replace(/^\.\//, "");
  if (s.startsWith("file://")) { try { s = fileURLToPath(s); } catch { return null; } }
  if (!s || /(?:^|\/)node_modules\//.test(s) || s.startsWith("[")) return null;
  if (isAbsolute(s)) { const rel = existsSync(s) ? relative(root, s) : null; return rel && !rel.startsWith("..") ? rel : null; }
  for (let dir = root, up = 0; up < 5; dir = dirname(dir), up++) {
    if (existsSync(join(dir, s))) { const rel = relative(root, join(dir, s)); return rel.startsWith("..") ? null : rel; }
    if (dirname(dir) === dir) break;
  }
  return null;
}
export function placeBuilt(at) {
  const m = BUILT_AT.exec(at);
  if (!m) return at;
  const chunk = m[1];
  const cut = chunk.search(BUILT);
  const map = cut > 0 ? mapOf(chunk) : null;
  if (!map) return null;
  const hit = map.findEntry(Number(m[2]) - 1, Number(m[3]) - 1);
  if (!hit?.originalSource) return null;
  const file = sourcePath(hit.originalSource, chunk.slice(0, cut));
  return file ? `${file}:${hit.originalLine + 1}` : null;
}

const placed = (list) => (Array.isArray(list) ? [...new Set(list.filter((c) => typeof c === "string").map(placeBuilt).filter(Boolean))].slice(0, 5) : list);

const placedSites = (list) => (Array.isArray(list)
  ? list.flatMap((site) => { const at = (Array.isArray(site?.at) ? site.at : [site?.at]).filter((a) => typeof a === "string").map(placeBuilt).find(Boolean); return at ? [{ ...site, at }] : []; })
  : list);
