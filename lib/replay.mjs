// The other half of lib/trace.cjs: the command's side. It hands the hook to the app it starts,
// reads what the hook wrote, keeps the sign-in each request carried on this machine, and tells the
// cloud what each door is proven to do (lib/proof.mjs): the route, the method, the body, the header
// names and what the requests did inside the app. Header values never leave.
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
// The header a run's request carries to speak as one of the app's own callers: the role, never the
// token, which this machine holds and puts in (local.mjs).
export const AS_HEADER = "x-cortad-as";
// Never replayed: they describe one connection, not the caller.
const SECRET_HEADER = /authorization|cookie|token|secret|session|csrf|api-?key/i;
const HOP = /^(?:host|content-length|connection|keep-alive|transfer-encoding|upgrade|expect|te|trailer|accept-encoding|x-cortad-as|x-cortad-turn)$/i;

// `files` lists the repository's source, relative to `root`, for placing a problem at its line;
// `appFolder` is the folder the app runs in, relative to `root`. `onProof` gets one payload per door,
// again whenever what it proves changes. `printed(from, to)` is what the app printed between two times.
export function makeCapture({ work, keepSecret, onProof = () => {}, writes = null, root = null, files = () => [], appFolder = () => "", printed = () => "", signIns = null }) {
  const file = join(work, "trace.jsonl");
  let read = 0;
  const accounts = makeAccounts(signIns);
  for (const headers of accounts.kept()) for (const [k, v] of Object.entries(headers)) if (SECRET_HEADER.test(k)) keepSecret(String(v).replace(/^Bearer\s+/i, ""));
  let alive = false;
  // The ports a hooked process listens on. Loading is not listening: turbo's own Node launcher loads
  // the hook, and one app was told we would see its messages while its API on Bun carried none.
  const ports = new Set();
  // The processes the hook said hello from.
  const hellos = new Set();
  // The route table each listening process read off its own app, newest per port.
  const tables = new Map();
  let newestTable = null;
  // Each server a hooked process opened a connection to, by host and port.
  const conns = new Map();
  // The model's last words and status for each of a run's turns on an endpoint the app answers
  // later, by turn (lib/wire.cjs answeredLater).
  const answers = new Map();
  // The person's messages the app took and answered at once with no model call inside them, by door,
  // newest kept: { ex, at, followed }, `followed` once a model call tied to no request came after.
  const taken = new Map();
  // The tools the app's newest start wrapped and those it could not (lib/trace.cjs tellTools).
  // ponytail: the newest row stands; tools loaded in two processes that both answer are read as the one that wrote last.
  let toolState = null;
  // Bun reads BUN_OPTIONS and splits it on spaces, quotes included, and only the `--preload=` form
  // leaves `bun run <script>` working. A hook path with a space in it is copied, with the file it
  // requires, to one without.
  const bunHook = /\s/.test(HOOK) ? (() => {
    const dir = mkdtempSync(join(tmpdir(), "cortad-"));
    for (const name of ["trace.cjs", "wire.cjs", "tied.cjs"]) copyFileSync(join(HERE, name), join(dir, name));
    return join(dir, "trace.cjs");
  })() : HOOK;
  // The hooks are handed to whatever is started: a Node app loads the first, a Bun app the same file
  // through its own variable, a Python app the second, and each ignores the others' variables.
  // Node, Bun and Python. Any other app is seen through lib/proxy.mjs instead.
  const env = (base) => ({
    CORTAD_TRACE_FILE: file,
    // The run writes the customer's rule sentences here (the engine's /tmp/rules.json lands in this
    // folder), and the hook reads which of them each model call's prompt carried.
    CORTAD_RULES_FILE: join(work, "rules.json"),
    // The read's tools by name, file and function, written by the run the same way: the hook wraps
    // those functions so a tool your own code runs is seen even when no model named it.
    CORTAD_TOOLS_FILE: join(work, "tools.json"),
    // While a run is on, the hook records each file the app writes under its own folder, with a
    // copy from before the first write, and the run's end puts them back (lib/writes.mjs).
    ...(writes && root ? { CORTAD_WRITES_DIR: writes, CORTAD_APP_ROOT: root } : {}),
    NODE_OPTIONS: `${base.NODE_OPTIONS ?? ""} --require ${JSON.stringify(HOOK)}`.trim(),
    BUN_OPTIONS: `${base.BUN_OPTIONS ?? ""} --preload=${bunHook}`.trim(),
    PYTHONPATH: [PYHOOK, base.PYTHONPATH].filter(Boolean).join(":"),
  });

  // The cookies and headers that carry a proven door's conversation. Speaking as the person never
  // sends them: a trial that did would join the agent's own conversation instead of opening its own.
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
    // Bytes, not characters: a reply in Arabic put the next read in the middle of a line.
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
      // A call tied to a taken message proves it the usual way; one tied to none may be its worker's.
      if (row.call) for (const [door, r] of taken) if (row.call.ex === r.ex) taken.delete(door); else if (typeof row.call.ex !== "string" && (Number(row.call.at) || 0) > r.at) r.followed = true;
      if (row.call) { row.call.caller = placed(row.call.caller); meter.add(row.call); contact.add(row); continue; }
      if (row.dep) { row.dep.caller = placed(row.dep.caller); meter.dep(row.dep); contact.add(row); continue; }
      if (row.sites) { row.sites.list = placedSites(row.sites.list); meter.sites(row.sites); contact.add(row); continue; }
      if (typeof row.ex !== "string" || typeof row.method !== "string" || typeof row.path !== "string" || !row.path.startsWith("/")) continue;
      for (const [door, r] of taken) if (r.ex === row.ex) taken.delete(door);
      const headers = Object.fromEntries(Object.entries(row.headers ?? {}).filter(([k, v]) => !HOP.test(k) && typeof v === "string"));
      for (const [k, v] of Object.entries(headers)) if (SECRET_HEADER.test(k)) keepSecret(String(v).replace(/^Bearer\s+/i, ""));
      // Speaking as the person means their own client's headers, never a trial's. Cortad's own test
      // request (reach:*) carries the page and sign-in this machine found for the app, so a run speaks
      // with them where no request of the person's came: without it every run request lost the Origin
      // an origin guard asks for, and each endpoint was refused 403 (one customer, 2026-10-06).
      if (typeof row.turn !== "string" || row.turn.startsWith("reach:")) accounts.keep(headers, `${row.method} ${row.path.split("?")[0]}`, row.body);
      contact.add(row);
    }
    contact.flush();
  }
  const timer = setInterval(poll, 700);
  timer.unref();
  return {
    env,
    // Where the hook writes, and where the run writes the rules it reads: lib/proxy.mjs writes and reads the same.
    file,
    rulesFile: join(work, "rules.json"),
    // The headers a captured account speaks with ("captured", "captured:account2"), or null for any
    // other caller.
    headers: (role = CAPTURED) => { const own = accounts.speak(role); return own ? withoutCarriers(own, [...carriers.values()]) : null; },
    // The body a run sends when it speaks as one of several customers: see makeAccounts.
    bodyAs: (role, door, body) => accounts.bodyAs(role, door, body),
    // A message sent to the app on `port` can be seen arriving. A hook that has not said where it
    // listens (Django under runserver) is taken at its hello, as before.
    watching: (port) => { poll(); return ports.has(port) || (alive && ports.size === 0); },
    alive: () => { poll(); return alive; },
    // The hook is in the process that answers on `port`, listening there as `pid`: it said it
    // listens there, or that process said hello (a server the hook cannot see bind, Django's).
    hookedAt: (port, pid) => { poll(); return ports.has(port) || hellos.has(pid); },
    // What your app spent on its model providers since it started, as the hook saw each call. Null
    // when no hook is in your app (an app this command did not start): absent, never zero. With a
    // `turn`, the calls pinned to that turn also say what their model was told.
    usage: (turn, totalsOnly = false) => { poll(); return alive ? meter.report(TURN.test(turn ?? "") ? turn : undefined, totalsOnly) : null; },
    // Which of the tools the run listed the hook wrapped in the app's newest start, and which it could
    // not; null before the hook has said. A call to a tool not wrapped is seen only on the wire.
    tools: () => { poll(); return toolState; },
    // The app's routes as its framework holds them: the table of the process on `port`, else the
    // newest any hooked process wrote. Empty when no hook read one.
    registry: (port) => { poll(); return tables.get(port) ?? newestTable ?? {}; },
    // The servers the app has connected to so far: where test conversations write, said on the card.
    connections: () => { poll(); return [...conns.values()]; },
    // The model's last words for a run's turn on an endpoint the app answers later, once the hook
    // has written them; null at `until`, or once `signal` aborts. `forget` drops a turn sent again.
    answered: async (turn, until, signal) => {
      for (;;) {
        poll();
        if (answers.has(turn) || Date.now() >= until || signal?.aborted) return answers.get(turn) ?? null;
        await new Promise((r) => setTimeout(r, 200));
      }
    },
    forget: (turn) => { answers.delete(turn); },
    // The server restarted and forgot what this terminal proved: every door's proof goes up again,
    // from this process, which still holds the sign-in each request carried.
    proveAgain: () => { contact.again(); contact.flush(); },
    // The doors that took a message and answered at once, whose request no model call has been tied
    // to after a worker's wait: never proven from this, only named.
    receipts: () => { poll(); return [...taken].filter(([, r]) => Date.now() - r.at > RECEIPT_WAIT_MS).map(([door, r]) => ({ door, followed: r.followed })); },
  };
}

// The exchanges seen so far, joined with the model calls and tool rows made inside them, and the
// payload last sent for each door. A door is sent again only when what it proves changed. Call rows
// usually land before their exchange's own row, which is written once the app has answered.
const EXCHANGES_KEPT = 200, LOOSE_KEPT = 500, PER_DOOR = 8, ANSWERS_KEPT = 500, RECEIPTS_KEPT = 50;
// How long a worker gets to make its model call after the message was taken (lib/proxy.mjs UNSEEN_MS).
const RECEIPT_WAIT_MS = 3000;
function makeContact({ onProof, find, found, appFolder, routes, printed, accounts = () => [] }) {
  const kept = new Map();
  let counted = 0;
  const loose = new Map();
  const sent = new Map();
  const dirty = new Set();
  // The first error each of the person's requests printed, kept past the output it was read from.
  const firstErrors = new Map();
  const bound = (map, max) => { while (map.size > max) map.delete(map.keys().next().value); };
  // A run sends hundreds of requests of its own: they go first, so the person's few are still here
  // to prove their doors when it ends.
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
      // An exchange written again (answered later, then fetched on a second request) keeps its calls.
      if (typeof row.ex === "string") { kept.set(id, [row, ...(kept.get(id) ?? []).filter((r) => typeof r.ex !== "string"), ...(loose.get(id) ?? [])]); loose.delete(id); boundKept(); dirty.add(id); }
      else if (kept.has(id)) { kept.get(id).push(row); dirty.add(id); }
      else { loose.set(id, [...(loose.get(id) ?? []), row]); bound(loose, LOOSE_KEPT); }
    },
    again() { sent.clear(); counted = -1; },
    flush() {
      // A customer signed in as for the first time changes what every door's run is played as.
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
        // What the sign-in on the person's newest request to this door is and when it runs out, never
        // the sign-in itself: a run that outlasts it would be refused halfway. Counted at the post.
        // With several accounts a run plays them all, so the one that ends first is the one said.
        const signedIn = payload.template.headerNames.length ? exchanges.findLast((ex) => !ex.trial) : null;
        const identity = signedIn ? soonest(identityOf(signedIn.headers), signIns) : null;
        try { onProof(identity ? { ...payload, proof: { ...payload.proof, identity } } : payload); } catch { /* sent again with the next change */ }
      }
      bound(firstErrors, EXCHANGES_KEPT);
      dirty.clear();
    },
  };
}

// Where the repository's own code holds a literal, as its file and line. The files the model call's
// own frames name are searched first; then every other code file, and a literal more than one of them
// holds names none (the caller falls back to the frame). Docs and tests never answer, and a frame
// file is read only when it is one of the repository's shareable files. `any`: whether the repository
// holds it at all, in the first file of any kind but a test, since a prompt is often kept in a text,
// Markdown, YAML or template file its code reads.
// ponytail: reads every file per new literal; an index when problems per run grow past a few.
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
// The row comes from inside a process this command does not control: every field is checked.
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

// Every model call the hook wrote down, kept here: totals per host and model, and the newest rows.
// What a call's model was told is kept only while its row is among those a report hands on.
const ROWS = 5000, REPORTED = 400;
// The turn a row was pinned to by the run's own tag, and the rule ids the call's prompt carried.
const TURN = /^[A-Za-z0-9:_.-]{1,80}$/;
const RULE_ID = /^[\w:-]{1,64}$/;
const turnOf = (v) => (typeof v === "string" && TURN.test(v) ? { turn: v } : {});
const rulesOf = (v) => (Array.isArray(v) ? { rules: v.filter((id) => typeof id === "string" && RULE_ID.test(id)).slice(0, 300) } : {});
// What the app's tools answered behind a call, as the hook read them off the next prompt, and what
// the tools the model's provider ran answered (`provider`), off the model's reply.
// `kind: "data"`: the app's own record of the person (a profile, an account), not a retrieval.
const texts = (v) => (Array.isArray(v) ? v.filter((t) => t && typeof t.text === "string" && t.text.trim()).slice(0, 12).map((t) => ({ name: String(t.name ?? "").slice(0, 80), text: t.text.slice(0, 3000), ...(t.kind === "data" ? { kind: "data" } : {}), ...(t.provider === true ? { provider: true } : {}) })) : []);
const toolsOf = (v) => (texts(v).length ? { tools: texts(v) } : {});
// The tools the model asked for behind a call, names and clipped arguments, what the tool's declared
// schema refused in them (`refused`), and the passages its prompt was handed as retrieved context, or
// a retrieval call answered with.
const calledOf = (v) => {
  const called = Array.isArray(v) ? v.filter((c) => c && typeof c.name === "string" && c.name && typeof c.arguments === "string").slice(0, 12).map((c) => ({ name: c.name.slice(0, 80), arguments: c.arguments.slice(0, 1200), ...(typeof c.refused === "string" && c.refused ? { refused: c.refused.slice(0, 300) } : {}) })) : [];
  return called.length ? { called } : {};
};
const passagesOf = (v) => (texts(v).length ? { passages: texts(v).slice(0, 6) } : {});
// Which of the app's own lines made the call, nearest first, as "path:line".
const AT = /^[^\n\r\t]{1,300}:\d{1,7}$/;
const CALLERS_MAX = 5;
const callerOf = (v) => { const caller = Array.isArray(v) ? v.filter((c) => typeof c === "string" && AT.test(c)).slice(0, CALLERS_MAX) : []; return caller.length ? { caller } : {}; };
// What the call's model was told, as the hook read it off the prompt: the app's instructions ("" when
// it carried none), the tools offered by name, and the declared ones as their schemas say.
const NAME = /^[\w.:-]{1,80}$/;
const names = (v, max) => (Array.isArray(v) ? v.filter((n) => typeof n === "string" && NAME.test(n)).slice(0, max) : []);
const toldOf = (call) => {
  const offered = names(call.offered, 60);
  const declared = (Array.isArray(call.declared) ? call.declared : []).filter((d) => d && typeof d.name === "string" && NAME.test(d.name)).slice(0, 60)
    .map((d) => ({ name: d.name, ...(typeof d.does === "string" && d.does.trim() ? { does: d.does.trim().slice(0, 300) } : {}), requires: names(d.requires, 12) }));
  return { ...(typeof call.instructions === "string" ? { instructions: call.instructions.slice(0, 12_000) } : {}), ...(offered.length ? { offered } : {}), ...(declared.length ? { declared } : {}) };
};
// The model's words behind a call, and the lines of the app that wrote the reply of the request it
// was made in, go out with the rows pinned to the turn asked about, as what the model was told does.
const MODEL_WORDS = 4000, SITES_KEPT = 500;
function tally(totals, call, count) {
  const host = call.host.slice(0, 253);
  const model = String(call.model ?? "").slice(0, 160);
  const answered = typeof call.answered === "string" && call.answered ? call.answered.slice(0, 160) : undefined;
  const key = `${host}|${model}`;
  const t = totals.get(key) ?? { host, model, calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, unmetered: 0, answered, mixed: false };
  t.calls += 1;
  // The model that answered for this one, when every call of it was answered by one other model.
  if (t.answered !== answered) t.mixed = true;
  t.promptTokens += count(call.promptTokens);
  t.cachedTokens += count(call.cachedTokens);
  t.completionTokens += count(call.completionTokens);
  // An answered call the provider sent no counts for: it was spent, and what it cost is not known.
  const status = count(call.status);
  // Counted from its words (lib/wire.cjs estimateOf): priced, and said as an estimate.
  if (call.estimated === true) t.estimated = (t.estimated ?? 0) + 1;
  else if (call.usage !== true && status > 0 && status < 400) t.unmetered += 1;
  totals.set(key, t);
}

const meter = (() => {
  const rows = [];
  const deps = [];
  // What the app has spent since it started, per host and model, kept as it goes: the rows are
  // trimmed to the newest ROWS, and totals summed from them lost every call before those.
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
    // A service their settings name: only its setting, host and status travel, never a byte of it.
    // A write a trial made that the hook held carries `held` and its clipped call. A tool function of the app's own ("in-app") carries its call and what it returned, as a
    // model call's row does.
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
    // `turn`: the rows pinned to it carry what their model was told. The instructions go out with the
    // reply they are read with, never with every call of the run at every turn.
    // `totalsOnly`: the spend alone, for the meter read while a run plays and at its end. The rows
    // carry what each call was handed, and on one customer's run the whole report was 2.9 MB, past what the
    // server takes, so the bill never arrived.
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

// The person's headers minus what carries a conversation: the header itself, or the one cookie inside
// the Cookie header.
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

// What the person's sign-in is and how many seconds it has left, read on this machine: a bearer
// token or a cookie that is a JWT carries its own expiry. Null seconds when none says.
// ponytail: JWT `exp` only; a session a server keeps (an opaque cookie) has no expiry we can read.
const JWT = /^[\w-]{8,}\.([\w-]{8,})\.[\w-]{8,}$/;
const expOf = (token) => {
  const payload = JWT.exec(token)?.[1];
  if (!payload) return null;
  try { const exp = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))?.exp; return Number.isFinite(exp) ? exp : null; } catch { return null; }
};
// The door's own sign-in, or the account of several whose sign-in ends first, numbered from one.
function soonest(own, signIns) {
  if (own.kind === "none" || signIns.length < 2) return own;
  const ends = signIns.map((headers) => identityOf(headers).expiresInS);
  const i = ends.reduce((best, s, at) => (s !== null && (ends[best] === null || s < ends[best]) ? at : best), 0);
  if (ends[i] === null || (own.expiresInS !== null && own.expiresInS < ends[i])) return own;
  return { ...own, expiresInS: ends[i], ...(i > 0 ? { account: i + 1 } : {}) };
}

// Each customer the person's own requests signed in as, up to four, in the order first seen, with the
// headers of that customer's newest request. The same customer signed in again (a JWT renewed, the
// same subject) is the same account. A request with no sign-in is no account; its headers are spoken
// only while no account is held. An account whose sign-in has ended gives its place to a new one.
// ponytail: an opaque token renewed reads as a new customer; the app's own word on who is signed in if that shows up.
const ACCOUNTS_MAX = 4;
const ACCOUNT_ROLE = /^captured(?::account([2-4]))?$/;
// What of a request's body may belong to who sent it: the plain values at fixed places (the id of
// their workspace, their site). Never a list, which is where a conversation lives.
const LEAVES_MAX = 60, LEAF_MAX = 200, LEAF_DEPTH = 4;
function leavesOf(body) {
  const out = new Map();
  const walk = (v, path, depth) => {
    if (out.size >= LEAVES_MAX || depth > LEAF_DEPTH) return;
    if (v && typeof v === "object" && !Array.isArray(v)) { for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, depth + 1); return; }
    if ((typeof v === "string" && v.length <= LEAF_MAX) || typeof v === "number" || typeof v === "boolean") out.set(path, v);
  };
  try { walk(typeof body === "string" ? JSON.parse(body) : body, "", 0); } catch { /* not JSON: nothing of theirs to read */ }
  return out;
}
// `file`: where the accounts are kept between connects, on this machine and readable by this user
// alone. One customer's agent signed in once per connect, and every reconnect asked for it again.
// A sign-in that has ended is not read back.
export function makeAccounts(file = null) {
  const kept = [];
  let bare = null;
  if (file) {
    try {
      const stored = JSON.parse(readFileSync(file, "utf8"));
      // A visitor who is not signed in still sends what the app lets them in by (its Origin): one customer
      // refused every test request of a reconnect with 403, having been sent none of it.
      const visitor = Array.isArray(stored) ? null : stored?.visitor;
      if (visitor && typeof visitor === "object" && !signInKey(visitor)) bare = Object.fromEntries(Object.entries(visitor).filter(([k, v]) => typeof k === "string" && typeof v === "string"));
      for (const a of Array.isArray(stored) ? stored : stored?.accounts ?? []) {
        if (kept.length >= ACCOUNTS_MAX || typeof a?.key !== "string" || !a.headers || typeof a.headers !== "object") continue;
        const headers = Object.fromEntries(Object.entries(a.headers).filter(([k, v]) => typeof k === "string" && typeof v === "string"));
        if (signInKey(headers) !== a.key || (identityOf(headers).expiresInS ?? 1) <= 0) continue;
        kept.push({ key: a.key, headers, bodies: new Map(Object.entries(a.bodies ?? {}).map(([door, leaves]) => [door, new Map(Object.entries(leaves ?? {}))])) });
      }
    } catch { /* none kept, or not ours to read: the next signed-in request is taken */ }
  }
  const save = () => {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify({ visitor: bare, accounts: kept.map((a) => ({ key: a.key, headers: a.headers, bodies: Object.fromEntries([...a.bodies].map(([door, leaves]) => [door, Object.fromEntries(leaves)])) })) }), { mode: 0o600 });
    } catch { /* kept for this connect only */ }
  };
  const at = (role) => { const m = ACCOUNT_ROLE.exec(role); return m ? kept[Number(m[1] ?? 1) - 1] ?? kept[0] ?? null : null; };
  return {
    // `door` and `body`: the request as that customer sent it, for the values in it that are theirs.
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
    // A run's request is built from one customer's own request, so it carries that customer's ids.
    // Sent as another customer, each value that is one customer's own becomes this customer's own:
    // One customer's chat takes the id of the site asked about, and another customer's site is refused.
    // A value the run itself wrote (the message, a new conversation's id) matches nobody's and stays.
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

// Who a request is signed in as, read on this machine: the subject of every JWT it carries, else the
// sign-in values themselves. "" when it carries none. A CSRF token says nothing about who.
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
  // A CSRF token can be a JWT too, and says nothing about when the sign-in ends.
  const cookies = named("cookie").split(/;\s*/).map((pair) => pair.split("=")).filter(([name]) => !/csrf|xsrf/i.test(name)).map((kv) => kv.slice(1).join("=")).filter(Boolean);
  const kind = /^bearer\s/i.test(auth) ? "bearer" : auth ? "authorization" : cookies.length ? "cookie" : "none";
  const exps = [auth.replace(/^bearer\s+/i, ""), ...cookies].map(expOf).filter((e) => e !== null);
  return { kind, expiresInS: exps.length ? Math.round(Math.min(...exps) - now / 1000) : null };
}

// A frame the hook found in a build folder comes as "chunk:line:column" under the chunk's absolute
// path (lib/trace.cjs). It is placed here, in the command, through the chunk's source map, at the
// app's own source line; a frame the map puts in a dependency, or cannot place, is dropped, and the
// next frame of the stack is the one kept. Any other frame passes as it came.
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
    // The map named by the chunk is read only from inside the build folder the chunk sits in: a
    // sourceMappingURL is the bundler's word, never a path out to the rest of the machine.
    if (inline === null && relative(chunk.slice(0, chunk.search(BUILT)), file).startsWith("..")) throw new Error("outside the build");
    if (inline === null && statSync(file).size > MAP_BYTES) throw new Error("too large");
    const payload = inline === null ? readFileSync(file, "utf8") : url.includes(";base64,") ? Buffer.from(inline, "base64").toString("utf8") : decodeURIComponent(inline);
    map = new SourceMap(JSON.parse(payload));
  } catch { /* no map: the frame is not placed */ }
  maps.set(chunk, { mtime, map });
  while (maps.size > MAPS_KEPT) maps.delete(maps.keys().next().value);
  return map;
}
// A map's source as a path relative to the folder the build folder sits in: "[project]/src/a.ts"
// (Turbopack), "webpack://_N_E/./src/a.ts" (webpack) or a file URL. In a workspace Turbopack's
// project is the workspace root, so the folders above are tried until the file is there.
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
// Five placed frames are kept, the count a stack of the app's own frames already carries.
const placed = (list) => (Array.isArray(list) ? [...new Set(list.filter((c) => typeof c === "string").map(placeBuilt).filter(Boolean))].slice(0, 5) : list);
// A site written in a bundle carries the frames after its write, nearest first: the first placed in
// the app's own source is where the app put the chunk into the stream.
const placedSites = (list) => (Array.isArray(list)
  ? list.flatMap((site) => { const at = (Array.isArray(site?.at) ? site.at : [site?.at]).filter((a) => typeof a === "string").map(placeBuilt).find(Boolean); return at ? [{ ...site, at }] : []; })
  : list);
