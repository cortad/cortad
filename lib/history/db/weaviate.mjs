import { first, httpBase } from "./env.mjs";
import { probed, sampleEach } from "./fields.mjs";
import { ask } from "./http.mjs";
import { Unordered } from "./newest.mjs";

// Weaviate: objects listed newest first by their time property where Weaviate can sort it, by
// cursor otherwise, and matched to their conversations through GraphQL.
export const WEAVIATE = { kind: "weaviate", label: "Weaviate", find, open };
const SORTABLE = new Set(["date", "int", "number", "text", "uuid"]);
const SCALAR = /^(?:text|int|number|boolean|date|uuid|string)(?:\[\])?$/;
const MAX = 10_000;

function find(env) {
  const [urlName, address] = first(env, ["WEAVIATE_URL", "WEAVIATE_HOST", "WEAVIATE_ENDPOINT", "WEAVIATE_REST_URL", "WEAVIATE_CLUSTER_URL"]);
  if (!address) return [];
  const where = httpBase(address, 8080);
  const [keyName, key] = first(env, ["WEAVIATE_API_KEY", "WEAVIATE_KEY"]);
  return [{ kind: "weaviate", host: where.host, envNames: [urlName, keyName].filter(Boolean), base: where.base, key }];
}

const recordOf = (o) => ({ ...(o.properties ?? {}), __id: o.id });

function open(conn) {
  const call = (path, body) => ask(`${conn.base}${path}`, { method: body ? "POST" : "GET", body, headers: conn.key ? { authorization: `Bearer ${conn.key}` } : {}, keys: "Weaviate key" }).then((r) => r.data);
  const classes = new Map();
  const list = (query) => call(`/v1/objects?${new URLSearchParams(query)}`).then((d) => (d.objects ?? []).map(recordOf));
  return {
    kind: "weaviate", label: "Weaviate", host: conn.host,
    async places({ want } = {}) {
      const all = probed((await call("/v1/schema")).classes ?? [], want, (c) => c.class);
      for (const c of all) classes.set(c.class, new Map((c.properties ?? []).map((p) => [p.name, p.dataType?.[0] ?? ""])));
      return sampleEach(all, async (c) => ({ name: c.class, sample: await list({ class: c.class, limit: "20" }) }));
    },
    async page({ place, order, cursor, limit }) {
      if (order) {
        if (!SORTABLE.has(classes.get(place)?.get(order))) throw new Unordered();
        const offset = Number(cursor ?? 0);
        const n = Math.min(limit, MAX - offset);
        const records = n > 0 ? await list({ class: place, limit: String(n), offset: String(offset), sort: order, order: "desc" }) : [];
        // ponytail: Weaviate serves offset and limit up to 10,000 objects; past that the newest are already read.
        return { records, next: records.length < n || offset + n >= MAX ? null : offset + n };
      }
      const records = await list({ class: place, limit: String(limit), ...(cursor ? { after: cursor } : {}) });
      return { records, next: records.length < limit ? null : records.at(-1).__id };
    },
    async where({ place, field, values, fields }) {
      if (field === "__id") return Promise.all(values.map((id) => call(`/v1/objects/${encodeURIComponent(place)}/${encodeURIComponent(id)}`).then(recordOf)));
      const props = [...classes.get(place)].filter(([name, type]) => SCALAR.test(type) && (!fields || fields.includes(name))).map(([name]) => name);
      const type = classes.get(place).get(field);
      const operand = type === "int" ? `valueInt: ${JSON.stringify(values.map(Number))}` : type === "number" ? `valueNumber: ${JSON.stringify(values.map(Number))}` : `valueText: ${JSON.stringify(values.map(String))}`;
      const query = `{ Get { ${place}(where: { path: [${JSON.stringify(field)}], operator: ContainsAny, ${operand} }, limit: ${MAX}) { ${props.join(" ")} _additional { id } } } }`;
      const got = await call("/v1/graphql", { query });
      if (got.errors?.length) throw new Error(`Weaviate refused the read: ${String(got.errors[0].message).slice(0, 200)}`);
      return (got.data?.Get?.[place] ?? []).map(({ _additional, ...rest }) => ({ ...rest, __id: _additional?.id }));
    },
    close: async () => {},
  };
}
