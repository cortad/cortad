import { first, httpBase } from "./env.mjs";
import { probed, SAMPLE, sampleEach } from "./fields.mjs";
import { ask } from "./http.mjs";
import { Unordered } from "./newest.mjs";

export const MILVUS = { kind: "milvus", label: "Milvus", find, open };

const WINDOW = 16_384;
const VECTOR = /Vector$/;

function find(env) {
  const [urlName, address] = first(env, ["MILVUS_URI", "MILVUS_URL", "MILVUS_ENDPOINT", "MILVUS_HOST", "ZILLIZ_CLOUD_URI", "ZILLIZ_URI", "ZILLIZ_ENDPOINT"]);
  if (!address) return [];
  const port = first(env, ["MILVUS_PORT"])[1];
  const where = httpBase(port && !/:\d+$/.test(address.replace(/\/+$/, "")) ? `${address}:${port}` : address, 19530);
  const [keyName, key] = first(env, ["MILVUS_TOKEN", "ZILLIZ_CLOUD_API_KEY", "ZILLIZ_API_KEY", "ZILLIZ_TOKEN"]);
  const user = first(env, ["MILVUS_USER", "MILVUS_USERNAME"])[1];
  const token = key ?? (user ? `${user}:${first(env, ["MILVUS_PASSWORD"])[1] ?? ""}` : "");
  return [{ kind: "milvus", label: /zilliz/i.test(urlName) ? "Zilliz" : "Milvus", host: where.host, envNames: [urlName, keyName].filter(Boolean), base: where.base, token, db: first(env, ["MILVUS_DB_NAME", "MILVUS_DATABASE"])[1] ?? "default" }];
}

const literal = (v) => (typeof v === "number" || typeof v === "bigint" ? String(v) : JSON.stringify(String(v)));

function open(conn) {
  const call = async (path, body) => {
    const { data } = await ask(`${conn.base}/v2/vectordb${path}`, { method: "POST", body: { dbName: conn.db, ...body }, headers: conn.token ? { authorization: `Bearer ${conn.token}` } : {}, keys: `${conn.label} token` });
    if (data?.code !== 0 && data?.code !== 200) throw new Error(`${conn.host} refused the read: ${String(data?.message ?? "").slice(0, 200)}`);
    return data.data;
  };
  const schema = new Map();
  const query = (place, filter, fields, limit, offset = 0) => {
    const { pk, scalars } = schema.get(place);
    const outputFields = [...new Set([pk, ...(fields ?? scalars).filter((f) => f !== "__id" && scalars.includes(f))])];
    return call("/entities/query", { collectionName: place, filter, outputFields, limit, offset }).then((rows) => rows.map((r) => ({ ...r, __id: r[pk] })));
  };
  return {
    kind: "milvus", label: conn.label, host: conn.host,
    async places({ only } = {}) {
      return sampleEach(probed(await call("/collections/list", {}), only), async (name) => {
        const fields = (await call("/collections/describe", { collectionName: name })).fields ?? [];
        schema.set(name, { pk: fields.find((f) => f.primaryKey)?.name, scalars: fields.filter((f) => !VECTOR.test(f.type)).map((f) => f.name) });
        return { name, paths: schema.get(name).scalars };
      });
    },
    sample: (place) => query(place, "", null, SAMPLE),
    async page({ place, fields, order, cursor, limit }) {
      if (order) throw new Unordered();
      const offset = Number(cursor ?? 0);
      const n = Math.min(limit, WINDOW - offset);

      const records = n > 0 ? await query(place, "", fields, n, offset) : [];
      return { records, next: records.length < n || offset + n >= WINDOW ? null : offset + n };
    },
    async where({ place, field, values, fields }) {
      const name = field === "__id" ? schema.get(place).pk : field;
      return query(place, `${name} in [${values.map(literal).join(", ")}]`, fields, WINDOW);
    },
    close: async () => {},
  };
}
