import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative } from "node:path";
import { nodeDriver } from "./drivers.mjs";
import { httpBase, first } from "./env.mjs";
import { sqlStore } from "./sql.mjs";

export const SQLITE = { kind: "sqlite", label: "SQLite", find: findFile, open: openFile };
export const LIBSQL = { kind: "libsql", label: "libSQL", find: findRemote, open: openRemote };

const FILE = /\.(?:db|sqlite|sqlite3|db3)$/i;
const NAME = /DATABASE|_DB|^DB|SQLITE/;

function findFile(env, root) {
  const out = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || !NAME.test(name)) continue;
    const path = value.trim().replace(/^sqlite\+\w+:/i, "sqlite:").replace(/^sqlite:\/\/\//i, "").replace(/^sqlite:\/\//i, "").replace(/^file:(?:\/\/)?/i, "").replace(/\?.*$/, "");
    if (!FILE.test(path) || /^[a-z]+:\/\//i.test(path)) continue;
    const full = [isAbsolute(path) ? path : join(root, path), join(root, "prisma", path)].find((p) => existsSync(p));
    if (full && !out.some((o) => o.path === full)) out.push({ kind: "sqlite", host: relative(root, full) || full, envNames: [name], path: full });
  }
  return out;
}

function sqliteDriver(root) {
  try { return { name: "node:sqlite", mod: createRequire(import.meta.url)("node:sqlite") }; } catch { return nodeDriver(root, ["better-sqlite3"]); }
}

async function openFile(conn, { root }) {
  const driver = sqliteDriver(root);
  if (!driver) throw new Error("this Node has no SQLite built in and the app has no better-sqlite3 installed");
  const db = driver.name === "node:sqlite" ? new driver.mod.DatabaseSync(conn.path, { readOnly: true }) : new driver.mod(conn.path, { readonly: true, fileMustExist: true });
  db.exec("PRAGMA query_only = 1");
  const query = async (sql, params) => db.prepare(sql).all(...params);
  return sqlStore({ dialect: "sqlite", param: () => "?", query, close: async () => db.close() }, { label: "SQLite", host: conn.host });
}

function findRemote(env) {
  const out = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    const raw = value.trim();
    if (!/^libsql:\/\//i.test(raw) && !(/^https?:\/\//i.test(raw) && (/LIBSQL|TURSO/.test(name) || /\.turso\.io/i.test(raw)))) continue;
    const prefix = name.replace(/_?(?:DATABASE_)?URL$/, "");
    const [tokenName] = first(env, [`${prefix}_AUTH_TOKEN`, `${prefix}_TOKEN`, "TURSO_AUTH_TOKEN", "LIBSQL_AUTH_TOKEN", "DATABASE_AUTH_TOKEN", "TURSO_DATABASE_TOKEN"]);
    const address = httpBase(raw.replace(/^libsql:\/\//i, "https://"));
    out.push({ kind: "libsql", host: address.host, envNames: [name, tokenName].filter(Boolean), base: address.base, token: tokenName ? env[tokenName] : "" });
  }
  return out;
}

const ARG = (v) => (v === null ? { type: "null" } : typeof v === "number" ? (Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: v }) : { type: "text", value: String(v) });
const VALUE = (v) => (v.type === "null" ? null : v.type === "integer" ? Number(v.value) : v.type === "blob" ? null : v.value);

async function openRemote(conn) {
  const query = async (sql, params) => {
    const res = await fetch(`${conn.base}/v2/pipeline`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(conn.token ? { authorization: `Bearer ${conn.token}` } : {}) },
      body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql, args: params.map(ARG) } }, { type: "close" }] }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 401 || res.status === 403) throw new Error(`${conn.host} refused the token in your env`);
    if (!res.ok) throw new Error(`${conn.host} answered ${res.status}`);
    const [answer] = (await res.json()).results;
    if (answer.type !== "ok") throw new Error(answer.error?.message ?? `${conn.host} refused the read`);
    const { cols, rows } = answer.response.result;
    return rows.map((row) => Object.fromEntries(cols.map((c, i) => [c.name, VALUE(row[i])])));
  };
  return sqlStore({ dialect: "sqlite", param: () => "?", query, close: async () => {} }, { label: "libSQL", host: conn.host });
}
