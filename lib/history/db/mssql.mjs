import { nodeDriver, pythonDriver, pythonSession } from "./drivers.mjs";
import { first, isLocal, urlsIn } from "./env.mjs";
import { sqlStore } from "./sql.mjs";

// SQL Server and Azure SQL, with a read-only intent, in a transaction that is rolled back at the end.
// SQL Server has no read-only transaction, so only the SELECTs built in lib/history/db/sql.mjs go in.
export const MSSQL = { kind: "mssql", label: "SQL Server", find, open };

// "Server=tcp:x,1433;Database=y;User Id=u;Password=p" and Prisma's "sqlserver://x:1433;database=y;user=u;password=p".
function fromPairs(text, server) {
  const pairs = Object.fromEntries(text.split(";").map((p) => p.split(/=(.*)/s)).filter(([k]) => k?.trim()).map(([k, v = ""]) => [k.trim().toLowerCase().replace(/\s+/g, " "), v.trim().replace(/^\{(.*)\}$/, "$1")]));
  const [host, port] = String(server ?? pairs.server ?? pairs["data source"] ?? pairs.address ?? "").replace(/^tcp:/i, "").split(/[,:]/);
  const user = pairs["user id"] ?? pairs.uid ?? pairs.user ?? pairs.username;
  if (!host || !user) return null;
  return { server: host, port: Number(port || pairs.port || 1433), database: pairs.database ?? pairs["initial catalog"] ?? "", user, password: pairs.password ?? pairs.pwd ?? "" };
}

function find(env) {
  const found = [];
  for (const [name, value] of Object.entries(env)) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!/^(?:sqlserver|mssql):\/\//i.test(raw) || !raw.includes(";")) continue;
    const rest = raw.replace(/^[a-z]+:\/\//i, "");
    const parts = fromPairs(rest.slice(rest.indexOf(";") + 1), rest.split(";")[0]);
    if (parts) found.push({ kind: "mssql", host: parts.server, envNames: [name], parts });
  }
  for (const { name, url } of urlsIn(env, ["sqlserver", "mssql"])) {
    found.push({ kind: "mssql", host: url.hostname, envNames: [name], parts: { server: url.hostname, port: Number(url.port || 1433), database: decodeURIComponent(url.pathname.slice(1)), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) } });
  }
  for (const [name, value] of Object.entries(env)) {
    if (found.length || typeof value !== "string" || !/(?:^|;)\s*(?:server|data source)\s*=/i.test(value) || !/(?:database|initial catalog)\s*=/i.test(value)) continue;
    const parts = fromPairs(value);
    if (parts) found.push({ kind: "mssql", host: parts.server, envNames: [name], parts });
  }
  const [hostName, host] = first(env, ["MSSQL_HOST", "MSSQL_SERVER", "SQLSERVER_HOST"]);
  const user = first(env, ["MSSQL_USER", "MSSQL_USERNAME", "SQLSERVER_USER"])[1];
  if (!found.length && host && user) {
    found.push({ kind: "mssql", host, envNames: [hostName], parts: { server: host, port: Number(first(env, ["MSSQL_PORT", "SQLSERVER_PORT"])[1] ?? 1433), database: first(env, ["MSSQL_DATABASE", "MSSQL_DB", "SQLSERVER_DATABASE"])[1] ?? "", user, password: first(env, ["MSSQL_PASSWORD", "SQLSERVER_PASSWORD"])[1] ?? "" } });
  }
  return found;
}

async function open(conn, { root }) {
  const { parts } = conn;
  const node = nodeDriver(root, ["mssql"]);
  if (node) {
    const mssql = node.mod.default ?? node.mod;
    // A certificate is checked everywhere but this computer, where a container's own is self-signed.
    const pool = await new mssql.ConnectionPool({ ...parts, pool: { max: 1 }, options: { encrypt: true, trustServerCertificate: isLocal(parts.server), readOnlyIntent: true } }).connect();
    const tx = new mssql.Transaction(pool);
    await tx.begin();
    const query = async (sql, params) => {
      const request = new mssql.Request(tx);
      params.forEach((value, i) => request.input(`p${i + 1}`, value));
      return (await request.query(sql)).recordset;
    };
    return sqlStore({ dialect: "mssql", param: (i) => `@p${i}`, query, close: async () => { await tx.rollback().catch(() => {}); await pool.close(); } }, { label: "SQL Server", host: parts.server });
  }
  const py = pythonDriver(root, ["pymssql"]);
  if (!py) throw new Error("this app has no SQL Server driver installed (mssql; pymssql for Python)");
  const session = pythonSession(py.python, { kind: "sql", driver: "pymssql", parts });
  await session.ready;
  return sqlStore({ dialect: "mssql", param: () => "%s", query: (sql, params) => session.call({ sql, params }), close: async () => session.close() }, { label: "SQL Server", host: parts.server });
}
