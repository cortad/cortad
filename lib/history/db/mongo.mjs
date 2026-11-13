import { nodeDriver, pythonDriver, pythonSession } from "./drivers.mjs";
import { first, isLocal } from "./env.mjs";
import { probed } from "./fields.mjs";

// MongoDB (Atlas, a container, or anything that speaks its protocol): only its collection list and
// finds are asked for, from a secondary where the cluster has one.
export const MONGO = { kind: "mongo", label: "MongoDB", find, open };
const SAMPLE = 20;

// A replica set's address names several hosts, which no URL parser takes: read by its parts.
const ADDRESS = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/,:?]+)[^/?]*(?:\/([^?]*))?/i;

function find(env) {
  const [, named] = first(env, ["MONGODB_DB", "MONGODB_DATABASE", "MONGO_DB", "MONGO_DB_NAME", "MONGODB_DB_NAME", "MONGO_DATABASE", "DB_NAME"]);
  const out = [];
  for (const [name, value] of Object.entries(env)) {
    const m = typeof value === "string" ? ADDRESS.exec(value.trim()) : null;
    if (!m || /SHADOW|TEST/.test(name) || out.some((o) => o.url === value.trim())) continue;
    out.push({ kind: "mongo", host: m[1], envNames: [name], url: value.trim(), database: decodeURIComponent(m[2] ?? "") || named || "" });
  }
  return out;
}

// Off this computer, a connection is encrypted even when its address does not say so.
const encrypted = (conn) => /^mongodb\+srv:/i.test(conn.url) || /[?&](?:tls|ssl)=/i.test(conn.url) || isLocal(conn.host);

async function open(conn, { root }) {
  const node = nodeDriver(root, ["mongodb"]);
  const tls = !encrypted(conn);
  let db;
  if (node) {
    const client = new node.mod.MongoClient(conn.url, { readPreference: "secondaryPreferred", serverSelectionTimeoutMS: 15_000, ...(tls ? { tls: true } : {}) });
    await client.connect();
    let current = client.db(conn.database || undefined);
    db = {
      databases: async () => (await client.db("admin").admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name).filter((n) => !["admin", "local", "config"].includes(n)),
      use: async (name) => { current = client.db(name); },
      collections: async () => (await current.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
      find: ({ collection, filter, projection, sort, skip, limit }) => current.collection(collection).find(filter ?? {}, { projection: projection ?? undefined, sort: sort ?? undefined, skip, limit, allowDiskUse: true }).toArray(),
      close: () => client.close(),
    };
  } else {
    const py = pythonDriver(root, ["pymongo"]);
    if (!py) throw new Error("this app has no MongoDB driver installed (mongodb or mongoose; pymongo for Python)");
    const session = pythonSession(py.python, { kind: "mongo", url: tls ? `${conn.url}${conn.url.includes("?") ? "&" : "?"}tls=true` : conn.url, database: conn.database });
    await session.ready;
    db = {
      databases: () => session.call({ op: "databases" }),
      use: (database) => session.call({ op: "use", database }),
      collections: () => session.call({ op: "collections" }),
      find: (ask) => session.call({ op: "find", ...ask }),
      close: async () => session.close(),
    };
  }
  return mongoStore(db, conn);
}

const withId = (docs) => docs.map((d) => ({ ...d, __id: d._id }));
const projectionOf = (fields) => (fields ? Object.fromEntries([...fields, "_id"].map((f) => [f === "__id" ? "_id" : f, 1])) : null);

function mongoStore(db, conn) {
  // A database named in the env is the one read; with none, the app's databases one by one.
  const places = new Map();
  const reach = async (place) => {
    const { database, collection } = places.get(place) ?? {};
    if (!collection) throw new Error(`there is no collection named ${place}`);
    if (database) await db.use(database);
    return collection;
  };
  return {
    kind: "mongo", label: "MongoDB", host: conn.host,
    async places({ want } = {}) {
      const databases = conn.database ? [null] : (await db.databases()).slice(0, 6);
      const out = [];
      for (const database of databases) {
        if (database) await db.use(database);
        const names = (await db.collections()).filter((n) => !n.startsWith("system."));
        for (const collection of probed(names, want)) {
          const name = database && databases.length > 1 ? `${database}.${collection}` : collection;
          places.set(name, { database, collection });
          out.push({ name, sample: withId(await db.find({ collection, sort: { _id: -1 }, limit: SAMPLE })) });
        }
      }
      return out;
    },
    async page({ place, fields, order, cursor, limit }) {
      const collection = await reach(place);
      const skip = Number(cursor ?? 0);
      const records = withId(await db.find({ collection, projection: projectionOf(fields), sort: order ? { [order]: -1 } : { _id: 1 }, skip, limit }));
      return { records, next: records.length < limit ? null : skip + records.length };
    },
    async where({ place, field, values, fields }) {
      const collection = await reach(place);
      return withId(await db.find({ collection, filter: { [field === "__id" ? "_id" : field]: { $in: values } }, projection: projectionOf(fields), limit: 0 }));
    },
    close: () => db.close(),
  };
}
