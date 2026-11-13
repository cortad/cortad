import { first, httpBase } from "./env.mjs";
import { FEW, namesOf, probed, SAMPLE, sampleEach } from "./fields.mjs";
import { ask } from "./http.mjs";
import { Unordered } from "./newest.mjs";

export const QDRANT = { kind: "qdrant", label: "Qdrant", find, open };
const ORDERABLE = new Set(["datetime", "integer", "float"]);

function find(env) {
  const [urlName, address] = first(env, ["QDRANT_URL", "QDRANT_HOST", "QDRANT_ENDPOINT", "QDRANT_CLUSTER_URL"]);
  if (!address) return [];
  const [keyName, key] = first(env, ["QDRANT_API_KEY", "QDRANT_KEY"]);
  const port = first(env, ["QDRANT_PORT"])[1];
  const where = httpBase(port && !/:\d+/.test(address.replace(/^\w+:\/\//, "")) ? `${address.replace(/\/+$/, "")}:${port}` : address, 6333);
  return [{ kind: "qdrant", host: where.host, envNames: [urlName, keyName].filter(Boolean), base: where.base, key }];
}

const recordOf = (point) => ({ ...(point.payload ?? {}), __id: point.id });

function open(conn) {
  const call = (path, body) => ask(`${conn.base}${path}`, { method: body ? "POST" : "GET", body, headers: conn.key ? { "api-key": conn.key } : {}, keys: "Qdrant key" }).then((r) => r.data.result);
  const schemas = new Map();
  const scroll = (place, body) => call(`/collections/${encodeURIComponent(place)}/points/scroll`, { with_vector: false, ...body });
  const head = async (place, n) => (await scroll(place, { limit: n, with_payload: true })).points.map(recordOf);
  const payload = (fields) => (fields ? fields.filter((f) => f !== "__id") : true);
  return {
    kind: "qdrant", label: "Qdrant", host: conn.host,
    async places({ only } = {}) {
      return sampleEach(probed((await call("/collections")).collections.map((c) => c.name), only), async (name) => {
        schemas.set(name, (await call(`/collections/${encodeURIComponent(name)}`)).payload_schema ?? {});
        return { name, paths: namesOf(await head(name, FEW)) };
      });
    },
    sample: (place) => head(place, SAMPLE),

    async page({ place, fields, order, cursor, limit }) {
      if (order) {
        if (!ORDERABLE.has(schemas.get(place)?.[order]?.data_type)) throw new Unordered();
        const seen = new Set(cursor?.seen ?? []);
        const got = await scroll(place, { limit: limit + seen.size, with_payload: fields ? [...new Set([...payload(fields), order])] : true, order_by: { key: order, direction: "desc", ...(cursor ? { start_from: cursor.from } : {}) } });
        const points = got.points.filter((p) => !seen.has(p.id));
        const last = points.at(-1)?.payload?.[order];
        const next = points.length < limit || last === undefined ? null : { from: last, seen: points.filter((p) => p.payload?.[order] === last).map((p) => p.id).concat(cursor?.from === last ? [...seen] : []) };
        return { records: points.map(recordOf), next };
      }
      const got = await scroll(place, { limit, with_payload: payload(fields), ...(cursor != null ? { offset: cursor } : {}) });
      return { records: got.points.map(recordOf), next: got.next_page_offset ?? null };
    },
    async where({ place, field, values, fields }) {
      if (field === "__id") return (await call(`/collections/${encodeURIComponent(place)}/points`, { ids: values, with_payload: payload(fields) })).map(recordOf);
      const out = [];
      let offset = null;
      do {
        const got = await scroll(place, { limit: 1_000, with_payload: payload(fields), filter: { must: [{ key: field, match: { any: values } }] }, ...(offset != null ? { offset } : {}) });
        out.push(...got.points.map(recordOf));
        offset = got.next_page_offset ?? null;
      } while (offset != null);
      return out;
    },
    close: async () => {},
  };
}
