import { first, httpBase } from "./env.mjs";
import { placeScore } from "./fields.mjs";
import { ask } from "./http.mjs";
import { Unordered } from "./newest.mjs";

export const SEARCH = { kind: "elasticsearch", label: "Elasticsearch", find, open };
const SORTABLE = new Set(["date", "date_nanos", "long", "integer", "double", "float", "keyword", "unsigned_long", "scaled_float"]);
const PREFIXES = ["ELASTICSEARCH", "ELASTIC", "ES", "OPENSEARCH"];

function cloudAddress(id) {
  const [, encoded = ""] = String(id).split(":");
  const [domain, es] = Buffer.from(encoded, "base64").toString("utf8").split("$");
  return domain && es ? `https://${es}.${domain.replace(/:443$/, "")}` : null;
}

function find(env) {
  for (const prefix of PREFIXES) {
    const [urlName, address] = first(env, ["URL", "NODE", "HOST", "ENDPOINT", "NODES"].map((s) => `${prefix}_${s}`));
    const [cloudName, cloud] = first(env, [`${prefix}_CLOUD_ID`]);
    const raw = address?.split(",")[0] ?? (cloud ? cloudAddress(cloud) : null);
    if (!raw) continue;
    const where = httpBase(raw, 9200);
    const [keyName, key] = first(env, [`${prefix}_API_KEY`, `${prefix}_APIKEY`]);
    const [userName, user] = first(env, [`${prefix}_USERNAME`, `${prefix}_USER`]);
    const password = first(env, [`${prefix}_PASSWORD`])[1] ?? "";
    const auth = key ? `ApiKey ${key}` : user || where.user ? `Basic ${Buffer.from(`${user ?? where.user}:${user ? password : where.password}`).toString("base64")}` : "";
    return [{ kind: "elasticsearch", label: prefix === "OPENSEARCH" ? "OpenSearch" : "Elasticsearch", host: where.host, envNames: [urlName ?? cloudName, keyName ?? userName].filter(Boolean), base: where.base, auth }];
  }
  return [];
}

const recordOf = (hit) => ({ ...(hit._source ?? {}), __id: hit._id });

function typesOf(properties, prefix = "", out = new Map()) {
  for (const [name, spec] of Object.entries(properties ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (spec.properties) typesOf(spec.properties, path, out);
    else out.set(path, { type: spec.type, keyword: Object.entries(spec.fields ?? {}).find(([, f]) => f.type === "keyword")?.[0] ?? null });
  }
  return out;
}

function open(conn) {
  const call = (path, body, method = body ? "POST" : "GET") => ask(`${conn.base}${path}`, { method, body, headers: conn.auth ? { authorization: conn.auth } : {}, keys: `${conn.label} credentials` }).then((r) => r.data);
  const mappings = new Map();

  const exact = (place, field) => {
    const t = mappings.get(place)?.get(field);
    if (!t) return null;
    if (SORTABLE.has(t.type)) return field;
    return t.keyword ? `${field}.${t.keyword}` : null;
  };
  const scrolled = async (place, body, cursor, size) => {
    const got = cursor ? await call("/_search/scroll", { scroll: "2m", scroll_id: cursor }) : await call(`/${encodeURIComponent(place)}/_search?scroll=2m`, { ...body, size });
    const hits = got.hits?.hits ?? [];
    return { records: hits.map(recordOf), next: hits.length < size ? null : got._scroll_id };
  };
  return {
    kind: "elasticsearch", label: conn.label, host: conn.host,
    async places({ want } = {}) {
      const names = (await call("/_cat/indices?format=json&h=index")).map((r) => r.index).filter((n) => !n.startsWith("."))
        .sort((a, b) => Number(b === want) - Number(a === want) || placeScore(b) - placeScore(a)).slice(0, 12);
      const out = [];
      for (const name of names) {
        const mapping = Object.values(await call(`/${encodeURIComponent(name)}/_mapping`))[0]?.mappings ?? {};
        mappings.set(name, typesOf(mapping.properties));
        out.push({ name, sample: ((await call(`/${encodeURIComponent(name)}/_search`, { size: 20 })).hits?.hits ?? []).map(recordOf) });
      }
      return out;
    },
    async page({ place, fields, order, cursor, limit }) {
      const sortBy = order ? exact(place, order) : null;
      if (order && !sortBy) throw new Unordered();
      return scrolled(place, { _source: fields ? fields.filter((f) => f !== "__id") : true, sort: sortBy ? [{ [sortBy]: { order: "desc", missing: "_last" } }] : ["_doc"] }, cursor, limit);
    },
    async where({ place, field, values, fields }) {
      const by = field === "__id" ? null : exact(place, field);
      if (field !== "__id" && !by) throw new Error(`${place}.${field} is not a field ${conn.label} can match on`);
      const query = field === "__id" ? { ids: { values: values.map(String) } } : { terms: { [by]: values } };
      const out = [];
      let page = await scrolled(place, { _source: fields ? fields.filter((f) => f !== "__id") : true, query, sort: ["_doc"] }, null, 1_000);
      for (;;) {
        out.push(...page.records);
        if (!page.next) return out;
        page = await scrolled(place, null, page.next, 1_000);
      }
    },
    close: async () => {},
  };
}
