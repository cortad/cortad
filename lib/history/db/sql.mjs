import { namesScore, placeScore } from "./fields.mjs";
import { Unordered } from "./newest.mjs";

const SAMPLE = 20;
const TABLES = 12;
const SYSTEM = ["pg_catalog", "information_schema", "auth", "storage", "realtime", "extensions", "graphql", "graphql_public", "vault", "pgsodium", "pgsodium_masks",
  "supabase_functions", "supabase_migrations", "net", "cron", "pgbouncer", "_realtime", "_analytics", "pg_toast", "topology", "tiger", "drizzle", "sys", "INFORMATION_SCHEMA", "mysql", "performance_schema"];
const CATALOG = {
  postgres: `SELECT table_schema AS s, table_name AS t, column_name AS c, data_type AS d FROM information_schema.columns WHERE table_schema NOT IN (${SYSTEM.map((s) => `'${s}'`).join(", ")}) ORDER BY table_schema, table_name, ordinal_position`,
  mysql: "SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS d FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION",
  mssql: "SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS d FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA <> 'sys' ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION",
  sqlite: "SELECT '' AS s, m.name AS t, p.name AS c, p.type AS d FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type IN ('table', 'view') AND substr(m.name, 1, 7) <> 'sqlite_' ORDER BY m.name, p.cid",
};
const DEFAULT_SCHEMA = { postgres: "public", mssql: "dbo", mysql: null, sqlite: "" };

const SKIP_TYPE = /^(?:bytea|vector|halfvec|sparsevec|user-defined|blob|longblob|mediumblob|binary|varbinary|image|geometry|geography|tsvector)$/i;
const TIME_TYPE = /^(?:timestamp|timestamp with time zone|timestamp without time zone|timestamptz|date)$/i;

const quote = (dialect, name) => (dialect === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : dialect === "mssql" ? `[${name.replace(/]/g, "]]")}]` : `"${name.replace(/"/g, '""')}"`);

export function sqlStore(exec, { label, host }) {
  const { dialect } = exec;
  const q = (name) => quote(dialect, name);
  const tables = new Map();

  const expr = (table, column) => {
    const type = table.types.get(column) ?? "";
    if (dialect === "postgres" && TIME_TYPE.test(type)) return `(EXTRACT(EPOCH FROM ${q(column)}) * 1000)::float8 AS ${q(column)}`;
    return q(column);
  };
  const select = (table, fields) => (fields ?? table.columns).filter((c) => table.types.has(c)).map((c) => expr(table, c)).join(", ") || "*";
  const limit = (sql, n, offset, order) => (dialect === "mssql"
    ? `${sql} ORDER BY ${order ?? "(SELECT NULL)"} OFFSET ${offset} ROWS FETCH NEXT ${n} ROWS ONLY`
    : `${sql}${order ? ` ORDER BY ${order}` : ""} LIMIT ${n} OFFSET ${offset}`);
  const desc = (column) => `${q(column)} DESC${dialect === "postgres" ? " NULLS LAST" : ""}`;
  const named = (place) => {
    const table = tables.get(place);
    if (!table) throw new Error(`there is no table named ${place}`);
    return table;
  };

  return {
    kind: dialect, label, host,
    async places({ want } = {}) {
      for (const row of await exec.query(CATALOG[dialect], [])) {
        const name = !row.s || row.s === (DEFAULT_SCHEMA[dialect] ?? row.s) ? row.t : `${row.s}.${row.t}`;
        const table = tables.get(name) ?? { name, ref: [row.s && dialect !== "sqlite" && dialect !== "mysql" ? q(row.s) : null, q(row.t)].filter(Boolean).join("."), columns: [], types: new Map() };
        if (!SKIP_TYPE.test(String(row.d))) { table.columns.push(row.c); table.types.set(row.c, String(row.d).toLowerCase()); }
        tables.set(name, table);
      }
      const wanted = (t) => (want && (t.name === want || t.name.split(".").at(-1) === want) ? 100 : 0);
      const ranked = [...tables.values()].map((t) => ({ t, score: wanted(t) + placeScore(t.name) + namesScore(t.columns) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, TABLES);
      const out = [];
      for (const { t } of ranked) {
        try { out.push({ name: t.name, sample: await exec.query(limit(`SELECT ${select(t, null)} FROM ${t.ref}`, SAMPLE, 0, null), []) }); } catch {  }
      }
      return out;
    },
    async page({ place, fields, order, cursor, limit: n }) {
      const table = named(place);
      if (order && !table.types.has(order)) throw new Unordered();
      const offset = Number(cursor ?? 0);
      const records = await exec.query(limit(`SELECT ${select(table, fields)} FROM ${table.ref}`, n, offset, order ? desc(order) : null), []);
      return { records, next: records.length < n ? null : offset + records.length };
    },
    async where({ place, field, values, fields }) {
      const table = named(place);
      if (!table.types.has(field)) throw new Error(`${place} has no column ${field}`);
      if (!values.length) return [];
      const marks = values.map((_, i) => exec.param(i + 1)).join(", ");
      return exec.query(`SELECT ${select(table, fields)} FROM ${table.ref} WHERE ${q(field)} IN (${marks})`, values);
    },
    close: () => exec.close(),
  };
}
