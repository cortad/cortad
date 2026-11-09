import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consentOf, pageFileOf, siteOf, stackOf } from "./app-facts.mjs";
import { credentialShaped, secretValues } from "./env-secrets.mjs";
import { imageCarries, ignored, keyIdsIn, lineOf, publicKeyIn, settingsOf, writeKeys } from "./envfile.mjs";
import { parseEnv } from "./env-files.mjs";
import { homeOf } from "./home.mjs";
import { pair } from "./intelligence-pair.mjs";
import { canSet, hostOf, HOSTS, setKey } from "./hosts.mjs";
import { looksLikeDevelopment, selected, spanOf } from "./history/contract.mjs";
import { BRAINTRUST } from "./history/braintrust.mjs";
import { HELICONE } from "./history/helicone.mjs";
import { LANGFUSE } from "./history/langfuse.mjs";
import { LANGSMITH } from "./history/langsmith.mjs";
import { OPIK } from "./history/opik.mjs";
import { PHOENIX } from "./history/phoenix.mjs";
import { packed, sendAll } from "./history/send.mjs";
import * as say from "./intelligence-text.mjs";

// `npx cortad intelligence`: Cortad Intelligence set up from this folder, one step per run. Each run
// reads where things stand (Cortad's facts about this app, and this folder) and prints what is done
// and the one next step, with the question for the person where one is theirs. It edits no code.
export const SOURCES = [LANGFUSE, LANGSMITH, HELICONE, BRAINTRUST, PHOENIX, OPIK];
const ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local", ".dev.vars"];
const WAIT_MS = 9 * 60_000;
const POLL_MS = 5_000;

export async function intelligence(args, ctx) {
  const { root, spec, token } = ctx;
  const api = (path, init = {}) => request(ctx, path, init);
  const opening = [];
  if (!token()) {
    const result = await pair(ctx, (path, body) => request({ ...ctx, token: () => "" }, path, { method: "POST", body }));
    if (result.waiting) return { text: say.approveFirst({ spec, ...result }) };
    if (result.expired) return { text: say.pairExpired(spec) };
    if (result.failed) return { text: say.lines(result.failed), code: 1 };
    opening.push(say.paired(result.app));
  }
  const [sub, ...rest] = args;
  const flag = (name) => rest.includes(name);
  const value = (name) => { const i = rest.indexOf(name); return i === -1 ? null : rest[i + 1] ?? null; };

  if (sub === "history") return history(ctx, api, { from: value("--from"), stdin: flag("--stdin"), skip: flag("--skip"), dry: flag("--dry-run"), anyway: flag("--anyway") });
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
      const sources = SOURCES.filter((s) => s.needs.every((n) => env[n])).map((s) => ({ ...s, names: s.needs, host: hostName(s.hostOf(env)) }));
      out.push(...say.historyQuestion({ spec, sources, stores: stores ?? [] }));
      return { text: say.lines(out) };
    }
    if (connection.started) out.push(say.live(connection));
    else if (connection.here) out.push(say.workingHere(connection.here.at));
    if (!connection.started) out.push(...codeStepFor(keys));
    const progress = await (wait ? waited(call) : call("/mcp/history"));
    if (progress.ok) out.push("", ...say.findings({ ...progress.data, done: progress.data.history.read >= progress.data.history.conversations }));
    if (progress.ok && progress.data.history.read < progress.data.history.conversations && !wait) out.push(say.next(spec, "--wait"));
    return { text: say.lines(out) };
  }

  // The env file holds Cortad's two keys before anything else happens; a second run keeps them.
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
    } else lines.push(...say.keysWritten(file, writeKeys(root, file, { ingest: answer.data.ingest, page: answer.data.page })));
    if (file && imageCarries(root, file)) lines.push(say.imageWarning(file));
    return { lines, file: file ?? join(homeOf(ctx.project), "keys.env"), site: answer.data.site ?? detected, page: answer.data.page ?? (file ? publicKeyIn(root, file) : null) };
  }

  function codeStepFor(keys) {
    const pageFile = pageFileOf(root);
    const host = hostOf(root);
    const page = keys.page ? { file: pageFile, key: keys.page } : null;
    return say.codeStep({ spec, stack: stackOf(root), page: pageFile ? page : null, file: keys.file, site: keys.site, consent: consentOf(root, pageFile), host, settable: canSet(root, host) });
  }

  async function history(ctx_, call, opts) {
    if (opts.skip) {
      const skipped = await call("/mcp/history/skip", { method: "POST" });
      if (!skipped.ok) return refused(skipped);
      return { text: say.lines(say.historySkipped(), say.next(spec)) };
    }
    let raws;
    let host = null;
    let source;
    if (opts.from) {
      const reader = SOURCES.find((s) => s.id === opts.from);
      if (!reader) return { text: say.lines(`Cortad reads history from ${SOURCES.map((s) => s.name).join(", ")}, or from your own export through --stdin.`), code: 1 };
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
      return { text: say.lines("Name where the conversations come from: --from <tool>, --stdin for your own export, or --skip."), code: 1 };
    }
    const label = SOURCES.find((s) => s.id === source)?.name ?? "your export";
    const picked = selected(raws, { secrets: secretValues(ENV_FILES.map((f) => join(root, f)).filter(existsSync)).filter(credentialShaped) });
    if (picked.conversations.length === 0) return { text: say.lines(say.historyNothing(label)), code: 1 };
    const sends = packed(source, picked.conversations);
    const file = join(homeOf(ctx.project), "history.json");
    mkdirSync(homeOf(ctx.project), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(sends, null, 1)}\n`, { mode: 0o600 });
    const span = spanOf(picked.conversations);
    const why = looksLikeDevelopment({ host, conversations: picked.conversations, users: picked.users });
    if (why && !opts.anyway) return { text: say.lines(say.historyLooksLikeDevelopment({ why, spec, rest: opts.from ? `--from ${opts.from}` : "--stdin" })) };
    if (opts.dry) return { text: say.lines(say.historyDry({ picked, span, file })) };
    const result = await sendAll(sends, { api: ctx.apiBase, token: token() });
    if (result.refused) return { text: say.lines(`Cortad did not take the rest: ${result.refused}`, `${result.taken} conversations were taken before that.`), code: 1 };
    return { text: say.lines(say.historySent({ result, picked, span, source: label, file }), say.next(spec)) };
  }

  function key(ctx_, host) {
    const file = settingsOf(root).file ?? join(homeOf(ctx.project), "keys.env");
    const path = file.startsWith("/") ? file : join(root, file);
    const value = parseEnv(existsSync(path) ? readFileSync(path, "utf8") : "")["CORTAD_INGEST_KEY"];
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
      try { env = { ...env, ...parseEnv(readFileSync(join(root, f), "utf8"), env) }; } catch { /* not there */ }
    }
    return { ...ctx.env, ...env };
  }
}

const hostName = (address) => { try { return new URL(address).host; } catch { return address; } };

// Lines of JSON, one conversation each; a first line naming the source is optional. A line that is
// not JSON is left out and counted by the contract as unreadable.
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
