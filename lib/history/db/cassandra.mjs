import { nodeDriver, pythonDriver, pythonSession } from "./drivers.mjs";
import { first, isLocal } from "./env.mjs";
import { namesScore, placeScore } from "./fields.mjs";
import { Unordered } from "./newest.mjs";

export const CASSANDRA = { kind: "cassandra", label: "Cassandra", find, open };
const SYSTEM = /^(?:system|system_auth|system_schema|system_distributed|system_traces|system_virtual_schema|system_views|dse_.*|solr_admin)$/;

function find(env) {
  const [bundleName, bundle] = first(env, ["ASTRA_DB_SECURE_BUNDLE_PATH", "ASTRA_SECURE_BUNDLE_PATH"]);
  const [hostName, hosts] = first(env, ["CASSANDRA_CONTACT_POINTS", "CASSANDRA_HOSTS", "CASSANDRA_HOST", "SCYLLA_HOSTS", "SCYLLA_HOST"]);
  if (!bundle && !hosts) return [];
  const token = first(env, ["ASTRA_DB_APPLICATION_TOKEN", "ASTRA_TOKEN"])[1];
  const points = String(hosts ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return [{
    kind: "cassandra", label: bundle ? "Astra" : "Cassandra", host: bundle ? "Astra" : points[0].split(":")[0], envNames: [bundleName ?? hostName], bundle, points,
    port: Number(first(env, ["CASSANDRA_PORT", "SCYLLA_PORT"])[1] ?? 9042), keyspace: first(env, ["CASSANDRA_KEYSPACE", "ASTRA_DB_KEYSPACE", "SCYLLA_KEYSPACE"])[1] ?? null,
    dc: first(env, ["CASSANDRA_LOCAL_DATACENTER", "CASSANDRA_DATACENTER", "CASSANDRA_DC"])[1] ?? "datacenter1",
    username: token ? "token" : first(env, ["CASSANDRA_USERNAME", "CASSANDRA_USER"])[1] ?? null, password: token ?? first(env, ["CASSANDRA_PASSWORD"])[1] ?? null,
  }];
}

const plain = (v) => (v == null || typeof v !== "object" || v instanceof Date ? v : typeof v.toNumber === "function" && "low" in v ? Number(v.toString()) : v.constructor?.name?.endsWith("Uuid") ? v.toString() : Array.isArray(v) ? v.map(plain) : v);

async function executorOf(conn, root) {
  const tls = !conn.bundle && !conn.points.every((p) => isLocal(p.split(":")[0]));
  const node = nodeDriver(root, ["cassandra-driver"]);
  if (node) {
    const client = new node.mod.Client({
      ...(conn.bundle ? { cloud: { secureConnectBundle: conn.bundle } } : { contactPoints: conn.points, localDataCenter: conn.dc, protocolOptions: { port: conn.port } }),
      ...(conn.username ? { credentials: { username: conn.username, password: conn.password ?? "" } } : {}),
      ...(tls ? { sslOptions: { rejectUnauthorized: true } } : {}),
    });
    await client.connect();
    return {
      mark: () => "?",
      query: async (cql, params, page, size) => {
        const r = await client.execute(cql, params, { prepare: true, fetchSize: size, ...(page ? { pageState: page } : {}) });
        return { rows: r.rows.map((row) => Object.fromEntries(row.keys().map((k) => [k, plain(row.get(k))]))), next: r.pageState ?? null };
      },
      close: () => client.shutdown(),
    };
  }
  const py = pythonDriver(root, ["cassandra"]);
  if (!py) throw new Error("this app has no Cassandra driver installed (cassandra-driver for Node or Python)");
  const session = pythonSession(py.python, { kind: "cql", tls, hosts: conn.points.map((p) => p.split(":")[0]), port: conn.port, bundle: conn.bundle, username: conn.username, password: conn.password });
  await session.ready;
  return { mark: () => "%s", query: (cql, params, page, size) => session.call({ cql, params, page, size }), close: async () => session.close() };
}

async function open(conn, { root }) {
  const exec = await executorOf(conn, root);
  const tables = new Map();
  const q = (name) => `"${name.replace(/"/g, '""')}"`;
  const ref = (place) => { const t = tables.get(place); if (!t) throw new Error(`there is no table named ${place}`); return t; };
  const cols = (t, fields) => (fields ?? t.columns).filter((c) => t.columns.includes(c)).map(q).join(", ") || "*";
  return {
    kind: "cassandra", label: conn.label, host: conn.host,
    async places({ want } = {}) {
      const { rows } = await exec.query("SELECT keyspace_name, table_name, column_name, kind FROM system_schema.columns", [], null, 5_000);
      for (const r of rows) {
        if (SYSTEM.test(r.keyspace_name) || (conn.keyspace && r.keyspace_name !== conn.keyspace)) continue;
        const name = `${r.keyspace_name}.${r.table_name}`;
        const t = tables.get(name) ?? { name, ref: `${q(r.keyspace_name)}.${q(r.table_name)}`, columns: [], partition: [] };
        t.columns.push(r.column_name);
        if (r.kind === "partition_key") t.partition.push(r.column_name);
        tables.set(name, t);
      }
      const wanted = (t) => (want && (t.name === want || t.name.endsWith(`.${want}`)) ? 100 : 0);
      const ranked = [...tables.values()].map((t) => ({ t, score: wanted(t) + placeScore(t.name) + namesScore(t.columns) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 12);
      const out = [];
      for (const { t } of ranked) out.push({ name: t.name, sample: (await exec.query(`SELECT * FROM ${t.ref} LIMIT 20`, [], null, 20)).rows });
      return out;
    },
    async page({ place, fields, order, cursor, limit }) {
      if (order) throw new Unordered();
      const t = ref(place);
      const got = await exec.query(`SELECT ${cols(t, fields)} FROM ${t.ref}`, [], cursor, limit);
      return { records: got.rows, next: got.rows.length ? got.next : null };
    },
    async where({ place, field, values, fields }) {
      const t = ref(place);
      if (t.partition.length === 1 && t.partition[0] === field) {
        return (await exec.query(`SELECT ${cols(t, fields)} FROM ${t.ref} WHERE ${q(field)} IN (${values.map(exec.mark).join(", ")})`, values, null, 10_000)).rows;
      }

      const wanted = new Set(values.map(String));
      const out = [];
      let page = null;
      do {
        const got = await exec.query(`SELECT ${cols(t, fields)} FROM ${t.ref}`, [], page, 5_000);
        out.push(...got.rows.filter((r) => wanted.has(String(r[field]))));
        page = got.rows.length ? got.next : null;
      } while (page);
      return out;
    },
    close: () => exec.close(),
  };
}
