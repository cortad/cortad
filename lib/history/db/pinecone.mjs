import { first, httpBase } from "./env.mjs";
import { placeScore } from "./fields.mjs";
import { ask } from "./http.mjs";
import { Unordered } from "./newest.mjs";

export const PINECONE = { kind: "pinecone", label: "Pinecone", find, open };
const VERSION = "2025-01";
const LIST = 100;

const MATCH = 1_000;
const PER_MATCH = 10;

function find(env) {
  const [keyName, key] = first(env, ["PINECONE_API_KEY"]);
  if (!key) return [];
  const [hostName, host] = first(env, ["PINECONE_HOST", "PINECONE_INDEX_HOST"]);
  const control = first(env, ["PINECONE_CONTROLLER_HOST"])[1] ?? "https://api.pinecone.io";
  return [{
    kind: "pinecone", host: host ? httpBase(host).host : httpBase(control).host, envNames: [keyName, hostName].filter(Boolean), key,
    index: host ? httpBase(host).base : null, control: httpBase(control).base, name: first(env, ["PINECONE_INDEX", "PINECONE_INDEX_NAME"])[1] ?? null, namespace: first(env, ["PINECONE_NAMESPACE"])[1] ?? null,
  }];
}

const recordOf = (v) => ({ ...(v.metadata ?? {}), __id: v.id });

function open(conn) {
  const headers = { "api-key": conn.key, "x-pinecone-api-version": VERSION };
  const call = (url, body) => ask(url, { method: body ? "POST" : "GET", body, headers, keys: "Pinecone key" }).then((r) => r.data);
  const places = new Map();
  const fetchIds = async (place, ids) => {
    const { base, namespace } = places.get(place);
    const out = [];
    for (let i = 0; i < ids.length; i += LIST) {
      const query = new URLSearchParams([...ids.slice(i, i + LIST).map((id) => ["ids", String(id)]), ["namespace", namespace]]);
      out.push(...Object.values((await call(`${base}/vectors/fetch?${query}`)).vectors ?? {}).map(recordOf));
    }
    return out;
  };
  const list = async (place, limit, token) => {
    const { base, namespace } = places.get(place);
    const got = await call(`${base}/vectors/list?${new URLSearchParams({ namespace, limit: String(Math.min(limit, LIST)), ...(token ? { paginationToken: token } : {}) })}`);
    return { ids: (got.vectors ?? []).map((v) => v.id), next: got.pagination?.next ?? null };
  };
  return {
    kind: "pinecone", label: "Pinecone", host: conn.host,
    async places({ want } = {}) {
      const indexes = conn.index ? [{ name: conn.name ?? conn.host, host: conn.index }]
        : ((await call(`${conn.control}/indexes`)).indexes ?? []).filter((i) => !conn.name || i.name === conn.name).map((i) => ({ name: i.name, host: httpBase(i.host).base }));
      const out = [];
      for (const index of indexes.slice(0, 6)) {
        const stats = await call(`${index.host}/describe_index_stats`, {});
        const namespaces = conn.namespace ? [conn.namespace] : Object.keys(stats.namespaces ?? { "": {} });
        for (const ns of namespaces.sort((a, b) => Number(b === want) - Number(a === want) || placeScore(b) - placeScore(a)).slice(0, 12)) {
          const name = ns && ns !== "__default__" ? `${index.name}/${ns}` : index.name;
          places.set(name, { base: index.host, namespace: ns, dimension: stats.dimension });
          out.push({ name, sample: await fetchIds(name, (await list(name, 20)).ids) });
        }
      }
      return out;
    },

    async page({ place, order, cursor, limit }) {
      if (order) throw new Unordered();
      const ids = [];
      let token = cursor;
      do {
        const got = await list(place, limit - ids.length, token);
        ids.push(...got.ids);
        token = got.next;
      } while (token && ids.length < limit);
      return { records: await fetchIds(place, ids), next: token };
    },
    async where({ place, field, values }) {
      if (field === "__id") return fetchIds(place, values);
      const { base, namespace, dimension } = places.get(place);
      const vector = Array.from({ length: dimension }, (_, i) => (i === 0 ? 1 : 0));
      const out = [];
      for (let i = 0; i < values.length; i += PER_MATCH) {
        const got = await call(`${base}/query`, { namespace, vector, topK: MATCH, includeMetadata: true, includeValues: false, filter: { [field]: { $in: values.slice(i, i + PER_MATCH) } } });
        out.push(...(got.matches ?? []).map(recordOf));
      }
      return out;
    },
    close: async () => {},
  };
}
