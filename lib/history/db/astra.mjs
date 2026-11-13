import { first, httpBase } from "./env.mjs";
import { placeScore } from "./fields.mjs";
import { ask } from "./http.mjs";
import { Unordered } from "./newest.mjs";

// Astra DB's Data API (and the Stargate Data API it runs on): a keyspace's collections read with
// find and nothing else, newest first where the Data API can sort the collection, by page state
// otherwise.
export const ASTRA = { kind: "astra", label: "Astra DB", find, open };
const MATCH = 100;

function find(env) {
  const [urlName, endpoint] = first(env, ["ASTRA_DB_API_ENDPOINT", "ASTRA_DB_ENDPOINT", "ASTRA_API_ENDPOINT"]);
  const [tokenName, token] = first(env, ["ASTRA_DB_APPLICATION_TOKEN", "ASTRA_DB_TOKEN", "ASTRA_TOKEN"]);
  if (!endpoint || !token) return [];
  const where = httpBase(endpoint);
  return [{ kind: "astra", host: where.host, envNames: [urlName, tokenName], base: where.base, token, keyspace: first(env, ["ASTRA_DB_KEYSPACE", "ASTRA_DB_NAMESPACE"])[1] ?? "default_keyspace" }];
}

const recordOf = (doc) => ({ ...doc, __id: doc._id });

function open(conn) {
  // Astra serves the Data API under /api/json; the Data API on its own (over DSE or HCD) at its root.
  const prefix = new URL(conn.base).pathname.length > 1 || !/\.astra(?:-dev|-test)?\.datastax\.com$/.test(conn.host) ? "" : "/api/json";
  const root = `${conn.base}${prefix}/v1/${encodeURIComponent(conn.keyspace)}`;
  // The Data API answers a refusal with 200 and its errors in the body.
  const command = async (place, body) => {
    const { data } = await ask(place ? `${root}/${encodeURIComponent(place)}` : root, { method: "POST", body, headers: { token: conn.token }, keys: "Astra token" });
    if (data?.errors?.length) {
      const [error] = data.errors;
      throw Object.assign(new Error(`${conn.host} refused the read: ${String(error.message ?? error.errorCode ?? "").slice(0, 200)}`), { code: error.errorCode });
    }
    return data;
  };
  const findAll = (place, filter, projection, options) => command(place, { find: { filter, ...(projection ? { projection } : {}), options } });
  const projectionOf = (fields) => (fields ? Object.fromEntries(fields.filter((f) => f !== "__id").map((f) => [f, 1])) : null);
  return {
    kind: "astra", label: "Astra DB", host: conn.host,
    async places({ want } = {}) {
      const names = ((await command(null, { findCollections: {} })).status?.collections ?? []).sort((a, b) => Number(b === want) - Number(a === want) || placeScore(b) - placeScore(a)).slice(0, 12);
      const out = [];
      for (const name of names) out.push({ name, sample: ((await findAll(name, {}, null, {})).data?.documents ?? []).slice(0, 20).map(recordOf) });
      return out;
    },
    async page({ place, fields, order, cursor, limit }) {
      if (order) {
        const skip = Number(cursor ?? 0);
        // A sort the Data API cannot run in memory (an unindexed field, too many documents) is read unordered.
        const got = await command(place, { find: { filter: {}, sort: { [order]: -1 }, ...(fields ? { projection: projectionOf([...fields, order]) } : {}), options: { skip, limit } } }).catch((error) => { if (error.code) throw new Unordered(error.message); throw error; });
        const documents = got.data?.documents ?? [];
        return { records: documents.map(recordOf), next: documents.length ? skip + documents.length : null };
      }
      const got = await findAll(place, {}, projectionOf(fields), cursor ? { pageState: cursor } : {});
      return { records: (got.data?.documents ?? []).map(recordOf), next: got.data?.nextPageState ?? null };
    },
    async where({ place, field, values, fields }) {
      const out = [];
      for (let i = 0; i < values.length; i += MATCH) {
        let state = null;
        do {
          const got = await findAll(place, { [field === "__id" ? "_id" : field]: { $in: values.slice(i, i + MATCH) } }, projectionOf(fields), state ? { pageState: state } : {});
          out.push(...(got.data?.documents ?? []).map(recordOf));
          state = got.data?.nextPageState ?? null;
        } while (state);
      }
      return out;
    },
    close: async () => {},
  };
}
