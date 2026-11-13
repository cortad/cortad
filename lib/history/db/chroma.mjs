import { first, httpBase } from "./env.mjs";
import { FEW, namesOf, probed, SAMPLE, sampleEach } from "./fields.mjs";
import { ask } from "./http.mjs";
import { Unordered } from "./newest.mjs";

// Chroma (a server, or Chroma Cloud) over its v2 API. A record is its metadata with its document as
// `document`; the light pass asks for metadata alone. Chroma cannot order, so it is paged.
export const CHROMA = { kind: "chroma", label: "Chroma", find, open };

function find(env) {
  const [urlName, address] = first(env, ["CHROMA_URL", "CHROMA_HOST", "CHROMA_SERVER_HOST", "CHROMADB_URL", "CHROMA_ENDPOINT"]);
  if (!address) return [];
  const port = first(env, ["CHROMA_PORT", "CHROMA_SERVER_HTTP_PORT"])[1];
  const ssl = /^(?:true|1)$/i.test(first(env, ["CHROMA_SSL"])[1] ?? "");
  const raw = /^\w+:\/\//.test(address) ? address : `${ssl ? "https" : ""}${ssl ? "://" : ""}${address}${port ? `:${port}` : ""}`;
  const where = httpBase(raw, 8000);
  const [keyName, key] = first(env, ["CHROMA_API_KEY", "CHROMA_TOKEN", "CHROMA_SERVER_AUTHN_CREDENTIALS", "CHROMA_CLIENT_AUTH_CREDENTIALS"]);
  return [{
    kind: "chroma", host: where.host, envNames: [urlName, keyName].filter(Boolean), base: where.base, key,
    tenant: first(env, ["CHROMA_TENANT"])[1] ?? "default_tenant", database: first(env, ["CHROMA_DATABASE", "CHROMA_DB"])[1] ?? "default_database",
  }];
}

const recordsOf = (got) => (got.ids ?? []).map((id, i) => ({ ...(got.metadatas?.[i] ?? {}), ...(got.documents?.[i] != null ? { document: got.documents[i] } : {}), __id: id }));

function open(conn) {
  const root = `${conn.base}/api/v2/tenants/${encodeURIComponent(conn.tenant)}/databases/${encodeURIComponent(conn.database)}/collections`;
  const call = (path, body) => ask(`${root}${path}`, { method: body ? "POST" : "GET", body, headers: conn.key ? { "x-chroma-token": conn.key } : {}, keys: "Chroma key" }).then((r) => r.data);
  const ids = new Map();
  const get = (place, body) => call(`/${ids.get(place)}/get`, body).then(recordsOf);
  const include = (fields) => (!fields || fields.includes("document") ? ["metadatas", "documents"] : ["metadatas"]);
  return {
    kind: "chroma", label: "Chroma", host: conn.host,
    async places({ only } = {}) {
      const collections = probed(await call(""), only, (c) => c.name);
      for (const c of collections) ids.set(c.name, c.id);
      return sampleEach(collections, async (c) => ({ name: c.name, paths: namesOf(await get(c.name, { limit: FEW, include: ["metadatas", "documents"] })) }));
    },
    sample: (place) => get(place, { limit: SAMPLE, include: ["metadatas", "documents"] }),
    async page({ place, fields, order, cursor, limit }) {
      if (order) throw new Unordered();
      const offset = Number(cursor ?? 0);
      const records = await get(place, { limit, offset, include: include(fields) });
      return { records, next: records.length < limit ? null : offset + records.length };
    },
    async where({ place, field, values, fields }) {
      if (field === "__id") return get(place, { ids: values.map(String), include: include(fields) });
      return get(place, { where: { [field]: { $in: values } }, include: include(fields) });
    },
    close: async () => {},
  };
}
