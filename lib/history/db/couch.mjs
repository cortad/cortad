import { first, httpBase } from "./env.mjs";
import { probed, sampleEach } from "./fields.mjs";
import { ask } from "./http.mjs";
import { Unordered } from "./newest.mjs";

export const COUCH = { kind: "couchdb", label: "CouchDB", find, open };

function find(env) {
  const [urlName, address] = first(env, ["COUCHDB_URL", "COUCH_URL", "COUCHDB_HOST", "COUCHDB_URI"]);
  if (!address) return [];
  const where = httpBase(address, 5984);
  const user = first(env, ["COUCHDB_USER", "COUCHDB_USERNAME", "COUCH_USER"])[1] ?? where.user;
  const password = first(env, ["COUCHDB_PASSWORD", "COUCH_PASSWORD"])[1] ?? where.password;
  const [dbName, db] = first(env, ["COUCHDB_DATABASE", "COUCHDB_DB", "COUCH_DB", "COUCH_DATABASE"]);
  const path = where.url.pathname.replace(/^\/+|\/+$/g, "");
  return [{ kind: "couchdb", host: where.host, envNames: [urlName, dbName].filter(Boolean), base: where.url.origin, database: db ?? (path || null), auth: user ? `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` : "" }];
}

const recordOf = (doc) => ({ ...doc, __id: doc._id });
const own = (rows) => rows.filter((d) => d && !String(d._id).startsWith("_design/"));

function open(conn) {
  const call = (path, body, ok) => ask(`${conn.base}${path}`, { method: body ? "POST" : "GET", body, ok, headers: conn.auth ? { authorization: conn.auth } : {}, keys: "CouchDB login" });
  const db = (place) => `/${encodeURIComponent(place)}`;
  const findAll = async (place, query, limit, bookmark) => {
    const { status, data } = await call(`${db(place)}/_find`, { ...query, limit, ...(bookmark ? { bookmark } : {}) }, [400]);
    if (status === 400) throw new Unordered();
    const docs = own(data.docs ?? []);
    return { records: docs.map(recordOf), next: (data.docs ?? []).length < limit ? null : data.bookmark };
  };
  const projection = (fields) => (fields ? { fields: [...new Set(["_id", ...fields.filter((f) => f !== "__id")])] } : {});
  return {
    kind: "couchdb", label: "CouchDB", host: conn.host,
    async places({ want } = {}) {
      const names = conn.database ? [conn.database] : (await call("/_all_dbs")).data.filter((n) => !n.startsWith("_"));
      return sampleEach(probed(names, want), async (name) => {
        const rows = (await call(`${db(name)}/_all_docs?include_docs=true&limit=40`)).data.rows.map((r) => r.doc);
        return { name, sample: own(rows).slice(0, 20).map(recordOf) };
      });
    },
    async page({ place, fields, order, cursor, limit }) {
      if (order) return findAll(place, { selector: { [order]: { $gt: null } }, sort: [{ [order]: "desc" }], ...projection(fields) }, limit, cursor);
      return findAll(place, { selector: { _id: { $gt: null } }, ...projection(fields) }, limit, cursor);
    },
    async where({ place, field, values, fields }) {
      if (field === "__id") return own((await call(`${db(place)}/_all_docs?include_docs=true`, { keys: values.map(String) })).data.rows.map((r) => r.doc)).map(recordOf);
      const out = [];
      let bookmark = null;
      do {
        const got = await findAll(place, { selector: { [field]: { $in: values } }, ...projection(fields) }, 1_000, bookmark).catch((e) => { if (e instanceof Unordered) throw new Error(`CouchDB could not match ${field} in ${place}`); throw e; });
        out.push(...got.records);
        bookmark = got.next;
      } while (bookmark);
      return out;
    },
    close: async () => {},
  };
}
