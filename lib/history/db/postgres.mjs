import { nodeDriver, pythonDriver, pythonSession } from "./drivers.mjs";
import { first, isLocal, urlsIn } from "./env.mjs";
import { sqlStore } from "./sql.mjs";

export const POSTGRES = { kind: "postgres", label: "Postgres", find, open };

function find(env) {
  const found = urlsIn(env, ["postgres", "postgresql"]).map(({ name, raw, url }) => ({ kind: "postgres", host: url.hostname, envNames: [name], url: raw }));
  const [hostName, host] = first(env, ["PGHOST", "POSTGRES_HOST"]);
  if (!found.length && host) {
    const user = first(env, ["PGUSER", "POSTGRES_USER"])[1] ?? "postgres";
    const password = first(env, ["PGPASSWORD", "POSTGRES_PASSWORD"])[1] ?? "";
    const db = first(env, ["PGDATABASE", "POSTGRES_DB", "POSTGRES_DATABASE"])[1] ?? user;
    const port = first(env, ["PGPORT", "POSTGRES_PORT"])[1] ?? "5432";
    const url = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(db)}`;
    found.push({ kind: "postgres", host, envNames: [hostName], url });
  }
  return found;
}

const named = (url) => /[?&]sslmode=/.test(url);
const verified = (url) => (named(url) || isLocal(new URL(url).hostname) ? null : { rejectUnauthorized: true });

async function open(conn, { root }) {
  const node = nodeDriver(root, ["pg", "postgres", "@neondatabase/serverless"]);
  if (node) return sqlStore(await nodeExec(node, conn.url), { label: "Postgres", host: conn.host });
  const py = pythonDriver(root, ["psycopg", "psycopg2"]);
  if (!py) throw new Error("this app has no Postgres driver installed (pg, postgres or @neondatabase/serverless; psycopg for Python)");
  const url = named(conn.url) || isLocal(new URL(conn.url).hostname) ? conn.url : `${conn.url}${conn.url.includes("?") ? "&" : "?"}sslmode=verify-full&sslrootcert=system`;
  const session = pythonSession(py.python, { kind: "sql", driver: py.module, url });
  await session.ready;
  return sqlStore({ dialect: "postgres", param: () => "%s", query: (sql, params) => session.call({ sql, params }), close: async () => session.close() }, { label: "Postgres", host: conn.host });
}

async function nodeExec({ name, mod }, url) {
  const ssl = verified(url);
  if (name === "pg") {
    const client = new (mod.Client ?? mod.default.Client)({ connectionString: url, ...(ssl ? { ssl } : {}), statement_timeout: 120_000 });
    await client.connect();
    await client.query("BEGIN READ ONLY");
    return { dialect: "postgres", param: (i) => `$${i}`, query: async (sql, params) => (await client.query(sql, params)).rows, close: async () => { await client.query("ROLLBACK").catch(() => {}); await client.end(); } };
  }
  if (name === "postgres") {
    const sql = (mod.default ?? mod)(url, { max: 1, onnotice: () => {}, ...(ssl ? { ssl } : {}) });
    await sql.unsafe("BEGIN READ ONLY");
    return { dialect: "postgres", param: (i) => `$${i}`, query: async (text, params) => [...await sql.unsafe(text, params)], close: async () => { await sql.unsafe("ROLLBACK").catch(() => {}); await sql.end(); } };
  }

  const neon = mod.neon(url);
  return {
    dialect: "postgres", param: (i) => `$${i}`,
    query: async (text, params) => (await neon.transaction([neon.query ? neon.query(text, params) : neon(text, params)], { readOnly: true }))[0],
    close: async () => {},
  };
}
