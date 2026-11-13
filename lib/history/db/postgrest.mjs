import { first, httpBase } from "./env.mjs";
import { SAMPLE } from "./fields.mjs";
import { ask } from "./http.mjs";

// Supabase's REST API (PostgREST), for an app that holds its project's URL and key but no database
// address. PostgREST runs every GET in a read-only transaction. The service key reads past row
// security, as the app's own server does; a public key reads only what row security lets anyone read.
export const POSTGREST = { kind: "supabase", label: "Supabase", find, open };

function find(env) {
  const [urlName, address] = first(env, ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "VITE_SUPABASE_URL", "EXPO_PUBLIC_SUPABASE_URL", "PUBLIC_SUPABASE_URL", "NUXT_PUBLIC_SUPABASE_URL", "POSTGREST_URL"]);
  const [keyName, key] = first(env, ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY", "SUPABASE_SECRET_KEY", "POSTGREST_TOKEN", "SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]);
  if (!address || !key) return [];
  const where = httpBase(address, 54321);
  // A Supabase project serves PostgREST under /rest/v1; a PostgREST of the app's own serves it at its root.
  const base = urlName === "POSTGREST_URL" || /\/rest\/v1$/.test(where.base) ? where.base : `${where.base}/rest/v1`;
  return [{ kind: "supabase", host: where.host, envNames: [urlName, keyName], base, key }];
}

// A value inside in.(...): quoted, with its quotes and backslashes escaped.
const listed = (values) => `(${values.map((v) => `"${String(v).replace(/[\\"]/g, (c) => `\\${c}`)}"`).join(",")})`;

function open(conn) {
  const headers = { apikey: conn.key, ...(conn.key.startsWith("eyJ") ? { authorization: `Bearer ${conn.key}` } : {}) };
  const get = (path) => ask(`${conn.base}${path}`, { headers, keys: "Supabase key" }).then((r) => r.data);
  const columns = new Map();
  const select = (place, fields) => (fields ?? columns.get(place)).map(encodeURIComponent).join(",");
  return {
    kind: "supabase", label: "Supabase", host: conn.host,
    async places({ only } = {}) {
      const spec = await ask(`${conn.base}/`, { headers: { ...headers, accept: "application/openapi+json" }, keys: "Supabase key" }).then((r) => r.data);
      for (const [table, def] of Object.entries(spec?.definitions ?? {})) {
        columns.set(table, Object.entries(def.properties ?? {}).filter(([, p]) => !/vector|bytea|tsvector/i.test(p.format ?? "")).map(([name]) => name));
      }
      return [...columns].filter(([t]) => !only || only.includes(t)).map(([name, paths]) => ({ name, paths }));
    },
    sample: (place) => get(`/${encodeURIComponent(place)}?select=${select(place, null)}&limit=${SAMPLE}`),
    async page({ place, fields, order, cursor, limit }) {
      const offset = Number(cursor ?? 0);
      const records = await get(`/${encodeURIComponent(place)}?select=${select(place, fields)}${order ? `&order=${encodeURIComponent(order)}.desc.nullslast` : ""}&limit=${limit}&offset=${offset}`);
      return { records, next: records.length < limit ? null : offset + records.length };
    },
    async where({ place, field, values, fields }) {
      return get(`/${encodeURIComponent(place)}?select=${select(place, fields)}&${encodeURIComponent(field)}=in.${encodeURIComponent(listed(values))}`);
    },
    close: async () => {},
  };
}
