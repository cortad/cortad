import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consentOf, pageFileOf, siteOf, stackOf } from "./app-facts.mjs";
import { credentialShaped, maskWith, secretValues } from "./env-secrets.mjs";
import { imageCarries, ignored, keyIdsIn, lineOf, publicKeyIn, settingsOf, writeKeys } from "./envfile.mjs";
import { parseEnv } from "./env-files.mjs";
import { homeOf } from "./home.mjs";
import { pair } from "./intelligence-pair.mjs";
import { canSet, hostOf, HOSTS, setKey } from "./hosts.mjs";
import { HISTORY_MESSAGES, looksLikeDevelopment, saltIn, selected, spanOf, withTexts } from "./history/contract.mjs";
import { packed, sendAll, writeSends } from "./history/send.mjs";
import { redactWith } from "./redact.mjs";
import { SOURCES, sourcesIn } from "./history/sources.mjs";
import { hintsFrom } from "./history/db/fields.mjs";
import { KINDS, proposeDatabase, readDatabase } from "./history/db/index.mjs";
import { changesIn, report } from "./setup-live.mjs";
import * as say from "./intelligence-text.mjs";

export { SOURCES };
const ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local", ".dev.vars"];
const WAIT_MS = 9 * 60_000;
const POLL_MS = 5_000;

export async function intelligence(args, ctx) {
  const { root, spec, token } = ctx;
  const api = (path, init = {}) => request(ctx, path, init);
  const opening = [];
  const [sub, ...rest] = args;
  const flag = (name) => rest.includes(name);
  const value = (name) => { const i = rest.indexOf(name); return i === -1 ? null : rest[i + 1] ?? null; };

  const dry = sub === "history" && flag("--dry-run");

  const refusedKey = token() && !dry ? (await api("/mcp/intelligence/start")).status === 401 : false;
  if (refusedKey) opening.push(say.keyRefused);
  if (!dry && (!token() || refusedKey)) {
    const result = await pair(ctx, (path, body) => request({ ...ctx, token: () => "" }, path, { method: "POST", body }));
    if (result.waiting) return { text: [say.lines(opening), say.approveFirst({ spec, ...result })].filter(Boolean).join("\n") };
    if (result.expired) return { text: say.pairExpired(spec) };
    if (result.failed) return { text: say.lines(result.failed), code: 1 };
    opening.push(say.paired(result.app));
  }

  if (sub === "history") {
    const cap = value("--messages");
    if (cap !== null && !capOk(cap)) return { text: say.lines(`--messages is a whole number from 1 to ${HISTORY_MESSAGES.toLocaleString("en-US")}: how many of your users' newest messages to send, each with its whole conversation.`), code: 1 };
    const store = value("--store");
    if (store !== null && !KINDS.includes(store)) return { text: say.lines(`--store is one of ${KINDS.join(", ")}.`), code: 1 };
    const redact = value("--redact-with");
    if (flag("--redact-with") && !redact?.trim()) return { text: say.lines('--redact-with is your own redaction command, in quotes: --redact-with "python3 scrub.py".'), code: 1 };
    const flags = { store, place: value("--table") ?? value("--collection"), hints: hintsFrom(value) };
    return history(ctx, api, { from: value("--from"), stdin: flag("--stdin"), skip: flag("--skip"), dry, anyway: flag("--anyway"), redact, cap: cap === null ? null : Number(cap), flags });
  }
  if (sub === "key") return key(ctx, value("--to"));
  if (sub === "site") return site(ctx, api, rest[0]);
  return start(ctx, api, { wait: sub === "--wait" || flag("--wait") });

  async function start(ctx_, call, { wait }) {
    const facts = await call("/mcp/intelligence/start");
    if (facts.status === 404) return { text: say.gone(), code: 1 };
    if (!facts.ok) return refused(facts);
    const out = [...say.header(facts.data.app), ...opening];
    const keys = await ensureKeys(call);
    if (keys.stop) return { text: keys.stop, code: 1 };
    out.push(...keys.lines);

    const { connection, history: past, stores } = facts.data;
    if (past.state === "none") {
      const env = envHere();
      const sources = sourcesIn(env).map((s) => ({ ...s, names: s.needs, host: hostName(s.hostOf(env)) }));
      out.push(...say.historyQuestion({ spec, sources, stores: stores ?? [], asked: facts.data.asked ?? null }));
      return { text: say.lines(out) };
    }
    if (connection.started) out.push(say.live(connection));
    else if (connection.here) out.push(say.workingHere(connection.here.at));
    if (!connection.started) {

      const found = changesIn(root);
      const tagged = !pageFileOf(root) || found.tag;
      out.push(...(found.sdk && tagged ? say.codeSeen(Boolean(connection.here)) : codeStepFor({ ...keys, site: keys.site ?? connection.site?.origin ?? null })));
      await reportCode(found);
    }
    const progress = await (wait ? waited(call) : call("/mcp/history"));
    if (progress.ok) out.push("", ...say.findings({ ...progress.data, done: progress.data.history.read >= progress.data.history.conversations }));
    if (progress.ok && progress.data.history.read < progress.data.history.conversations && !wait) out.push(say.next(spec, "--wait"));
    return { text: say.lines(out) };
  }

  async function ensureKeys(call) {
    const settings = settingsOf(root);
    const file = settings.file;
    if (file && !ignored(root, file)) return { stop: say.notIgnored(file, spec) };
    const have = file ? keyIdsIn(root, file) : [];
    const detected = siteOf(root);
    const answer = await call("/mcp/intelligence/keys", { method: "POST", body: { have, ...(detected ? { site: detected } : {}) } });
    if (!answer.ok) return { stop: refused(answer).text };
    const lines = [];
    if (answer.data.live) lines.push(...say.keysKept(file));
    else if (settings.manager) {
      const dir = homeOf(ctx.project);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, "keys.env");
      writeFileSync(path, `CORTAD_INGEST_KEY=${answer.data.ingest}\nCORTAD_PUBLIC_KEY=${answer.data.page}\n`, { mode: 0o600 });
      lines.push(...say.keysManaged(settings.manager, path));
    } else lines.push(...say.keysWritten(file, writeKeys(root, file, { ingest: answer.data.ingest, page: answer.data.page }), { host: hostOf(root), spec }));
    if (file && imageCarries(root, file)) lines.push(say.imageWarning(file));
    return { lines, file: file ?? join(homeOf(ctx.project), "keys.env"), site: answer.data.site ?? detected, page: answer.data.page ?? (file ? publicKeyIn(root, file) : null) };
  }

  async function reportCode(found) {
    await live({ sdk: found.sdk ? "branch" : "busy", ...(pageFileOf(root) ? { tag: found.tag ? "branch" : "busy" } : { tag: "none" }) });
  }

  function live(body) {
    return report({ apiBase: ctx.apiBase, token: token(), ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}) }, body);
  }

  function codeStepFor(keys) {
    const pageFile = pageFileOf(root);
    const host = hostOf(root);
    const page = keys.page ? { file: pageFile, key: keys.page } : null;
    return say.codeStep({ spec, stack: stackOf(root), page: pageFile ? page : null, file: keys.file, site: keys.site, consent: consentOf(root, pageFile), host, settable: canSet(root, host), address: `${ctx.apiBase}/v1/conversations` });
  }

  async function history(ctx_, call, opts) {
    if (opts.skip || opts.dry) return send(ctx_, call, opts);
    await live({ history: "busy" });
    const out = await send(ctx_, call, opts);
    await live({ history: out.code ? "next" : out.sent ? "done" : "busy" });
    return out;
  }

  async function send(ctx_, call, opts) {
    if (opts.skip) {
      const skipped = await call("/mcp/history/skip", { method: "POST" });
      if (!skipped.ok) return refused(skipped);
      return { text: say.lines(say.historySkipped(), say.next(spec)) };
    }

    const facts = await call("/mcp/intelligence/start");
    if (!facts.ok) return { text: say.lines(say.exclusionsUnread(spec, typeof facts.data?.error === "string" ? facts.data.error : `Cortad answered ${facts.status}`)), code: 1 };
    const exclude = Array.isArray(facts.data.excludeMessages) ? facts.data.excludeMessages.slice(0, 10_000) : [];

    if (opts.cap === null) opts = { ...opts, cap: capOk(String(facts.data.asked ?? "")) ? Number(facts.data.asked) : HISTORY_MESSAGES };
    let raws;
    let host = null;
    let source;
    if (opts.from) {
      const reader = SOURCES.find((s) => s.id === opts.from);
      if (!reader) return { text: say.lines(`Cortad takes history from ${SOURCES.map((s) => s.name).join(", ")}, from your app's own database with no flag, or from your own export through --stdin.`), code: 1 };
      const env = envHere();
      const missing = reader.needs.filter((n) => !env[n]);
      if (missing.length) return { text: say.lines(`${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not in this folder's env, so ${reader.name} cannot be read from here.`), code: 1 };
      try {
        const read = await reader.read({ env, since: new Date(Date.now() - 30 * 86_400_000) });
        raws = read.conversations;
        host = read.host;
      } catch (error) {
        return { text: say.lines(`${reader.name} was not read: ${error.message}. Nothing was sent.`), code: 1 };
      }
      source = reader.id;
    } else if (opts.stdin) {
      const parsed = jsonLines(await ctx.readStdin());
      raws = parsed.conversations;
      host = parsed.host;
      source = "export";
    } else {
      const hint = facts.data.stores?.[0] ?? null;
      const secrets = secretValues(ENV_FILES.map((f) => join(root, f)).filter(existsSync));
      const mask = (text) => maskWith(String(text), secrets);
      if (!opts.flags.store || !opts.flags.place) {
        const found = await proposeDatabase({ root, env: envHere(), hint, flags: opts.flags });
        if (!found.proposal) return { text: say.lines(say.historyNotRead({ ...found, spec, mask })), code: 1 };
        return { text: say.lines(say.historyProposal({ spec, ...found.proposal, cap: opts.cap, quoted, rest: carried(opts) })) };
      }
      const read = await readDatabase({ root, env: envHere(), hint, flags: opts.flags, cap: opts.cap, since: Date.now() - 30 * 86_400_000, exclude });
      if (!read.conversations) return { text: say.lines(say.historyNotRead({ ...read, spec, mask })), code: 1 };
      raws = read.conversations;
      host = read.store.host;
      source = "export";
      opts.label = `your ${read.store.label} database at ${read.store.host}`;
    }
    const label = opts.label ?? SOURCES.find((s) => s.id === source)?.name ?? "your export";
    const picked = selected(raws, { salt: saltIn(homeOf(ctx.project)), cap: opts.cap, exclude, secrets: secretValues(ENV_FILES.map((f) => join(root, f)).filter(existsSync)).filter(credentialShaped) });
    if (picked.conversations.length === 0) return { text: say.lines(say.historyNothing(label)), code: 1 };
    if (opts.redact) {
      try {
        picked.conversations = withTexts(picked.conversations, (texts) => redactWith(opts.redact, texts));
      } catch (error) {
        return { text: say.lines(say.redactFailed(error.message)), code: 1 };
      }
    }
    const sends = packed(source, picked.conversations);
    const span = spanOf(picked.conversations);
    const why = looksLikeDevelopment({ host, conversations: picked.conversations, users: picked.users });
    if (opts.dry) {
      const file = writeSends(join(homeOf(ctx.project), "history-dry-run.jsonl"), sends);
      return { text: say.lines(say.historyDry({ picked, span, cap: opts.cap, file, why, redacted: Boolean(opts.redact) })) };
    }
    if (why && !opts.anyway) return { text: say.lines(say.historyLooksLikeDevelopment({ why, spec, rest: carried(opts) })) };
    const result = await sendAll(sends, { api: ctx.apiBase, token: token() });
    if (result.refused) return { text: say.lines(`Cortad did not take the rest: ${result.refused}`, `${result.taken} conversations were taken before that.`), code: 1 };
    return { text: say.lines(say.historySent({ result, picked, span, source: label, cap: opts.cap }), say.afterHistory(spec)), sent: true };
  }

  function ingestKeyHere() {
    const file = settingsOf(root).file ?? join(homeOf(ctx.project), "keys.env");
    const path = file.startsWith("/") ? file : join(root, file);
    return parseEnv(existsSync(path) ? readFileSync(path, "utf8") : "")["CORTAD_INGEST_KEY"] ?? null;
  }

  function key(ctx_, host) {
    const file = settingsOf(root).file ?? join(homeOf(ctx.project), "keys.env");
    const value = ingestKeyHere();
    if (!value) return { text: say.lines(`There is no CORTAD_INGEST_KEY in ${file} yet. Run npx -y ${spec} intelligence first.`), code: 1 };
    if (!host || !HOSTS[host]) return { text: say.lines(`Name the host: --to ${Object.keys(HOSTS).filter((h) => h !== "other").join(", ")}.`), code: 1 };
    if (!canSet(root, host)) return { text: say.lines(say.keyNotSet(host, `its command is not installed, signed in or linked to this folder`, `${file} (line ${lineOf(root, file, "CORTAD_INGEST_KEY")})`)), code: 1 };
    const done = setKey(root, host, value);
    return done.ok ? { text: say.lines(say.keySet(host, file)) } : { text: say.lines(say.keyNotSet(host, done.why, file)), code: 1 };
  }

  async function site(ctx_, call, address) {
    const settings = settingsOf(root);
    const have = settings.file ? keyIdsIn(root, settings.file) : [];
    const answer = await call("/mcp/intelligence/keys", { method: "POST", body: { have, site: address ?? "" } });
    if (!answer.ok) return refused(answer);
    if (!answer.data.live) return { text: say.lines("Cortad's keys were not found in this folder's env. Run the intelligence command first."), code: 1 };
    return { text: say.lines(say.siteLocked(answer.data.site)) };
  }

  async function waited(call) {
    const until = Date.now() + WAIT_MS;
    for (;;) {
      const progress = await call("/mcp/history");
      if (!progress.ok || Date.now() >= until) return progress;
      const { history: h } = progress.data;
      if (h.conversations === 0 || h.read >= h.conversations) return progress;
      await new Promise((resolve) => { setTimeout(resolve, POLL_MS); });
    }
  }

  function envHere() {
    let env = {};
    for (const f of ENV_FILES) {
      try { env = { ...env, ...parseEnv(readFileSync(join(root, f), "utf8"), env) }; } catch {  }
    }
    return { ...ctx.env, ...env };
  }
}

const quoted = (text) => (/^[\w.,:@%+=-]+$/.test(text) ? text : `'${String(text).replace(/'/g, "'\\''")}'`);
function carried(opts) {
  const { store, place, hints = {} } = opts.flags ?? {};
  return [
    opts.from ? `--from ${opts.from}` : opts.stdin ? "--stdin" : "",
    store && place ? `--store ${store} --table ${quoted(place)}` : "",
    ...Object.entries(hints).map(([k, v]) => `--${k} ${quoted(v)}`),
    opts.cap === HISTORY_MESSAGES ? "" : `--messages ${opts.cap}`,
    opts.redact ? `--redact-with ${quoted(opts.redact)}` : "",
    opts.dry ? "--dry-run" : "",
  ].filter(Boolean).join(" ");
}

const capOk = (raw) => /^[1-9]\d{0,4}$/.test(raw) && Number(raw) <= HISTORY_MESSAGES;
const hostName = (address) => { try { return new URL(address).host; } catch { return address; } };

export function jsonLines(text) {
  const conversations = [];
  let host = null;
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); } catch { conversations.push(null); continue; }
    if (value && typeof value === "object" && value.source && !value.messages) { host = typeof value.source.host === "string" ? value.source.host : null; continue; }
    conversations.push(value);
  }
  return { conversations, host };
}

async function request(ctx, path, { method = "GET", body } = {}) {
  try {
    const res = await (ctx.fetchImpl ?? fetch)(`${ctx.apiBase}${path}`, {
      method,
      headers: { ...(ctx.token() ? { authorization: `Bearer ${ctx.token()}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    return { ok: false, status: 0, data: { error: `cortad.com did not answer (${error.name}). If this agent runs in a sandbox, allow it network access to cortad.com.` } };
  }
}

const refused = (answer) => ({ text: say.lines(typeof answer.data?.error === "string" ? answer.data.error : `Cortad answered ${answer.status}.`), code: 1 });
