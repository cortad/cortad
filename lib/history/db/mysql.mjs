import { nodeDriver, pythonDriver, pythonSession } from "./drivers.mjs";
import { first, isLocal, urlsIn } from "./env.mjs";
import { sqlStore } from "./sql.mjs";

// MySQL and MariaDB wherever they are hosted (PlanetScale, RDS, a container), in a read-only
// transaction on a session set to UTC, so a DATETIME reads as the UTC its app wrote.
export const MYSQL = { kind: "mysql", label: "MySQL", find, open };

function find(env) {
  const found = urlsIn(env, ["mysql", "mysql2", "mariadb"]).map(({ name, url }) => ({ kind: "mysql", host: url.hostname, envNames: [name], parts: partsOf(url) }));
  for (const prefix of ["MYSQL", "DATABASE", "MARIADB"]) {
    const [hostName, host] = first(env, [`${prefix}_HOST`]);
    const user = first(env, [`${prefix}_USER`, `${prefix}_USERNAME`])[1];
    if (found.length || !host || !user || (prefix === "DATABASE" && !/psdb\.cloud$|mysql/i.test(`${host} ${env.DATABASE_TYPE ?? ""}`))) continue;
    found.push({ kind: "mysql", host, envNames: [hostName], parts: { host, port: Number(first(env, [`${prefix}_PORT`])[1] ?? 3306), user, password: first(env, [`${prefix}_PASSWORD`])[1] ?? "", database: first(env, [`${prefix}_DATABASE`, `${prefix}_DB`, `${prefix}_NAME`])[1] ?? "" } });
  }
  return found;
}

const partsOf = (url) => ({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: decodeURIComponent(url.pathname.slice(1)) });

async function open(conn, { root }) {
  const { parts } = conn;
  const tls = !isLocal(parts.host);
  const node = nodeDriver(root, ["mysql2/promise", "@planetscale/database"]);
  if (node?.name === "mysql2/promise") {
    const db = await node.mod.createConnection({ ...parts, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, ...(tls ? { ssl: { rejectUnauthorized: true, minVersion: "TLSv1.2" } } : {}) });
    await db.query("SET SESSION time_zone = '+00:00'");
    await db.query("START TRANSACTION READ ONLY");
    return sqlStore({ dialect: "mysql", param: () => "?", query: async (sql, params) => (await db.query(sql, params))[0], close: async () => { await db.query("ROLLBACK").catch(() => {}); await db.end(); } }, { label: "MySQL", host: parts.host });
  }
  if (node) {
    // PlanetScale over HTTP: no session, so each statement is a SELECT built here and nothing else.
    const db = node.mod.connect({ host: parts.host, username: parts.user, password: parts.password });
    return sqlStore({ dialect: "mysql", param: () => "?", query: async (sql, params) => (await db.execute(sql, params)).rows, close: async () => {} }, { label: "MySQL", host: parts.host });
  }
  const py = pythonDriver(root, ["pymysql", "MySQLdb"]);
  if (!py) throw new Error("this app has no MySQL driver installed (mysql2 or @planetscale/database; pymysql for Python)");
  const session = pythonSession(py.python, { kind: "sql", driver: py.module, parts: { ...parts, ...(tls ? { ssl: { check_hostname: true }, ssl_verify_cert: true, ssl_verify_identity: true } : {}) } });
  await session.ready;
  return sqlStore({ dialect: "mysql", param: () => "%s", query: (sql, params) => session.call({ sql, params }), close: async () => session.close() }, { label: "MySQL", host: parts.host });
}
