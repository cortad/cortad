import { nodeDriver, pythonDriver, pythonSession } from "./drivers.mjs";
import { first, httpBase, isLocal, urlsIn } from "./env.mjs";
import { probed } from "./fields.mjs";
import { Unordered } from "./newest.mjs";

// Redis, through the app's own client or Upstash's REST API. Keys are found by SCAN and grouped by
// their shape (chat:123 and chat:456 are one place, chat:*); a place is read through the commands
// below and no other, every one of them a read.
export const REDIS = { kind: "redis", label: "Redis", find, open };
const READ = new Set(["SCAN", "TYPE", "GET", "HGETALL", "HMGET", "LRANGE", "XRANGE", "JSON.GET"]);
const SCAN_MAX = 500_000;
const SAMPLE = 10;
const BATCH = 200;
const LIST_MAX = 1_000;

function find(env) {
  const out = urlsIn(env, ["redis", "rediss"]).map(({ name, raw, url }) => ({ kind: "redis", host: url.hostname, envNames: [name], url: raw }));
  for (const prefix of ["UPSTASH_REDIS_REST", "KV_REST_API"]) {
    const [urlName, address] = first(env, [`${prefix}_URL`]);
    // A read-only token where the app has one: Upstash and Vercel KV both hand one out.
    const [tokenName, token] = first(env, [`${prefix}_READ_ONLY_TOKEN`, `${prefix}_READONLY_TOKEN`, `${prefix}_TOKEN`]);
    if (address && token) out.push({ kind: "redis", host: httpBase(address).host, envNames: [urlName, tokenName], rest: httpBase(address).base, token });
  }
  return out;
}

// One function for every client: commands in, one { result } or { error } out per command.
async function clientOf(conn, root) {
  if (conn.rest) {
    return {
      run: async (cmds) => {
        const res = await fetch(`${conn.rest}/pipeline`, { method: "POST", headers: { authorization: `Bearer ${conn.token}`, "content-type": "application/json" }, body: JSON.stringify(cmds), signal: AbortSignal.timeout(60_000) });
        if (res.status === 401 || res.status === 403) throw new Error(`${conn.host} refused the token in your env`);
        if (!res.ok) throw new Error(`${conn.host} answered ${res.status}`);
        return res.json();
      },
      close: async () => {},
    };
  }
  const tls = !/^rediss:/i.test(conn.url) && !isLocal(conn.host);
  const node = nodeDriver(root, ["ioredis", "redis"]);
  if (node?.name === "ioredis") {
    const Redis = node.mod.default ?? node.mod;
    const r = new Redis(conn.url, { lazyConnect: true, maxRetriesPerRequest: 1, ...(tls ? { tls: {} } : {}) });
    await r.connect();
    return {
      run: async (cmds) => (await r.pipeline(cmds.map((c) => ["call", ...c])).exec()).map(([error, result]) => (error ? { error: error.message } : { result: plain(result) })),
      close: async () => { r.disconnect(); },
    };
  }
  if (node) {
    const r = node.mod.createClient({ url: conn.url, ...(tls ? { socket: { tls: true } } : {}) });
    r.on("error", () => {});
    await r.connect();
    return {
      run: (cmds) => Promise.all(cmds.map((c) => r.sendCommand(c.map(String)).then((result) => ({ result: plain(result) }), (error) => ({ error: error.message })))),
      close: async () => { await r.quit().catch(() => {}); },
    };
  }
  const py = pythonDriver(root, ["redis"]);
  if (!py) throw new Error("this app has no Redis client installed (ioredis or redis; redis for Python)");
  const session = pythonSession(py.python, { kind: "redis", url: tls ? conn.url.replace(/^redis:/i, "rediss:") : conn.url });
  await session.ready;
  return { run: (cmds) => session.call({ cmds }), close: async () => session.close() };
}
const plain = (v) => (Buffer.isBuffer(v) ? v.toString("utf8") : Array.isArray(v) ? v.map(plain) : v);

// chat:9f2c..., user:42:chat:abc, message_store:session-1: segments that look like ids become *.
const ID = /^(?:[0-9a-f]{8}-[0-9a-f-]{27}|\d+|[0-9a-f]{12,}|[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*|[A-Za-z0-9_-]{16,})$/i;
const patternOf = (key) => key.split(":").map((part) => (ID.test(part) ? "*" : part)).join(":");
const idOf = (key) => key.split(":").filter((part) => ID.test(part)).join(":") || key;

const parse = (text) => { try { return JSON.parse(text); } catch { return text; } };
const pairs = (list) => Object.fromEntries(Array.from({ length: list.length / 2 }, (_, i) => [list[2 * i], parse(list[2 * i + 1])]));

async function open(conn, { root }) {
  const client = await clientOf(conn, root);
  const run = async (cmds) => {
    if (cmds.some((c) => !READ.has(String(c[0]).toUpperCase()))) throw new Error("only reads are sent to Redis");
    return run.client(cmds);
  };
  run.client = client.run;
  const places = new Map();
  const keyOfId = new Map();

  // A key's record: a hash's fields, a JSON value's own fields, a list's or a stream's entries as messages.
  const records = async (keys, type, fields) => {
    const cmds = keys.map((k) => (type === "hash" ? (fields ? ["HMGET", k, ...fields] : ["HGETALL", k]) : type === "string" ? ["GET", k] : type === "ReJSON-RL" ? ["JSON.GET", k] : type === "list" ? ["LRANGE", k, "0", String(LIST_MAX - 1)] : ["XRANGE", k, "-", "+", "COUNT", String(LIST_MAX)]));
    const answers = await run(cmds);
    return keys.map((key, i) => {
      const value = answers[i]?.result;
      const base = { __id: idOf(key) };
      if (value == null) return null;
      if (type === "hash") return { ...base, ...(fields ? Object.fromEntries(fields.map((f, n) => [f, parse(value[n])])) : Array.isArray(value) ? pairs(value) : value) };
      if (type === "list") return { ...base, messages: value.map(parse) };
      if (type === "stream") return { ...base, messages: value.map(([id, list]) => ({ ...(Array.isArray(list) ? pairs(list) : list), at: Number(id.split("-")[0]) })) };
      const doc = parse(value);
      return Array.isArray(doc) && type === "ReJSON-RL" && doc.length === 1 && typeof doc[0] === "object" ? { ...base, ...doc[0] } : Array.isArray(doc) ? { ...base, messages: doc } : doc && typeof doc === "object" ? { ...base, ...doc } : null;
    }).filter(Boolean);
  };

  return {
    kind: "redis", label: conn.rest ? "Upstash Redis" : "Redis", host: conn.host,
    async places({ want } = {}) {
      const groups = new Map();
      let cursor = "0";
      let seen = 0;
      do {
        const [{ result }] = await run([["SCAN", cursor, "COUNT", "1000"]]);
        cursor = String(result[0]);
        for (const key of result[1]) {
          seen += 1;
          const pattern = patternOf(key);
          if (!groups.has(pattern)) groups.set(pattern, []);
          groups.get(pattern).push(key);
        }
      } while (cursor !== "0" && seen < SCAN_MAX);
      const out = [];
      for (const [pattern, keys] of probed([...groups].sort((a, b) => b[1].length - a[1].length), want, ([p]) => p)) {
        const types = await run(keys.slice(0, SAMPLE).map((k) => ["TYPE", k]));
        const type = types.map((t) => t.result).find((t) => ["hash", "string", "list", "stream", "ReJSON-RL"].includes(t));
        if (!type) continue;
        places.set(pattern, { keys, type });
        for (const key of keys) keyOfId.set(idOf(key), key);
        out.push({ name: pattern, sample: await records(keys.slice(0, SAMPLE), type, null) });
      }
      return out;
    },
    async page({ place, fields, order, cursor, limit }) {
      if (order) throw new Unordered();
      const { keys, type } = places.get(place);
      const from = Number(cursor ?? 0);
      const out = [];
      // ponytail: a value that is not a hash is read whole; a field list is only a hash's to give.
      const own = type === "hash" && fields ? fields.filter((f) => f !== "__id") : null;
      for (let i = from; i < Math.min(keys.length, from + limit); i += BATCH) out.push(...await records(keys.slice(i, Math.min(i + BATCH, from + limit)), type, own));
      return { records: out, next: from + limit >= keys.length ? null : from + limit };
    },
    async where({ place, field, values }) {
      const { keys, type } = places.get(place);
      if (field === "__id") return records(values.map((v) => keyOfId.get(String(v))).filter(Boolean), type, null);
      const wanted = new Set(values.map(String));
      const out = [];
      for (let i = 0; i < keys.length; i += BATCH) out.push(...(await records(keys.slice(i, i + BATCH), type, null)).filter((r) => wanted.has(String(r[field]))));
      return out;
    },
    close: () => client.close(),
  };
}
