import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { first, httpBase } from "./env.mjs";
import { placeScore } from "./fields.mjs";
import { ask } from "./http.mjs";
import { Unordered } from "./newest.mjs";

export const FIRESTORE = { kind: "firestore", label: "Firestore", find, open };
const SCOPE = "https://www.googleapis.com/auth/datastore";
const USES = /firebase-admin|@google-cloud\/firestore|google-cloud-firestore|"firebase"/;
const read = (file) => { try { return readFileSync(file, "utf8"); } catch { return ""; } };
const json = (text) => {
  for (const candidate of [text, Buffer.from(String(text ?? ""), "base64").toString("utf8")]) {
    try { const v = JSON.parse(candidate); if (v?.private_key && v?.client_email) return v; } catch {  }
  }
  return null;
};

function find(env, root) {
  const project = first(env, ["FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT", "FIRESTORE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID"])[1];
  const database = first(env, ["FIRESTORE_DATABASE_ID", "FIRESTORE_DATABASE"])[1] ?? "(default)";
  const [emulatorName, emulator] = first(env, ["FIRESTORE_EMULATOR_HOST"]);
  if (emulator && project) return [{ kind: "firestore", host: httpBase(emulator).host, envNames: [emulatorName], base: httpBase(emulator).base, project, database, emulator: true }];
  const [accountName, account] = first(env, ["FIREBASE_SERVICE_ACCOUNT", "FIREBASE_SERVICE_ACCOUNT_KEY", "GOOGLE_SERVICE_ACCOUNT", "FIREBASE_ADMIN_CREDENTIALS", "GOOGLE_CREDENTIALS"]);
  let key = account ? json(account) : null;
  let names = [accountName];
  if (!key && env.FIREBASE_PRIVATE_KEY && env.FIREBASE_CLIENT_EMAIL) {
    key = { private_key: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"), client_email: env.FIREBASE_CLIENT_EMAIL, project_id: project };
    names = ["FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL"];
  }

  const file = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!key && file && USES.test(["package.json", "requirements.txt", "pyproject.toml"].map((f) => read(join(root ?? ".", f))).join("\n"))) {
    key = json(read(isAbsolute(file) ? file : join(root ?? ".", file)));
    names = ["GOOGLE_APPLICATION_CREDENTIALS"];
  }
  if (!key) return [];
  return [{ kind: "firestore", host: "firestore.googleapis.com", envNames: names, base: "https://firestore.googleapis.com", project: project ?? key.project_id, database, key }];
}

export function assertionOf(key, now = Date.now()) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const iat = Math.floor(now / 1000);
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iss: key.client_email, scope: SCOPE, aud: key.token_uri ?? "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key.private_key).toString("base64url")}`;
}

async function tokenOf(conn) {
  if (conn.emulator) return "owner";
  const uri = conn.key.token_uri ?? "https://oauth2.googleapis.com/token";
  const { data } = await ask(uri, { method: "POST", body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: assertionOf(conn.key) }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" }, keys: "Google service account" });
  return data.access_token;
}

function decode(v) {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("referenceValue" in v) return v.referenceValue.split("/").at(-1);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, decode(x)]));
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(decode);
  return null;
}
const encode = (v) => (typeof v === "number" ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === "boolean" ? { booleanValue: v } : { stringValue: String(v) });
const path = (field) => field.split(".").map((p) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(p) ? p : `\`${p.replace(/[`\\]/g, "\\$&")}\``)).join(".");

async function open(conn) {
  const token = await tokenOf(conn);
  const docs = `projects/${conn.project}/databases/${conn.database}/documents`;
  const call = (suffix, body) => ask(`${conn.base}/v1/${suffix}`, { method: "POST", body, headers: { authorization: `Bearer ${token}` }, keys: "Firestore credentials", ok: [400] });
  const places = new Map();
  const names = new Map();
  const parents = new Map();
  const recordOf = (doc) => {
    const segments = doc.name.split("/");
    const id = segments.at(-1);
    names.set(id, doc.name);
    const parentName = segments.length > 7 ? segments.slice(0, -2).join("/") : null;
    if (parentName) parents.set(parentName.split("/").at(-1), parentName);
    return { ...Object.fromEntries(Object.entries(doc.fields ?? {}).map(([k, v]) => [k, decode(v)])), __id: id, ...(parentName ? { __parent: parentName.split("/").at(-1) } : {}), __raw: doc };
  };
  const run = async (parent, query) => {
    const { status, data } = await call(`${parent}:runQuery`, { structuredQuery: query });
    if (status === 400) throw new Unordered(`Firestore refused the query: ${String((Array.isArray(data) ? data[0] : data)?.error?.message ?? "").slice(0, 200)}`);
    return data.filter((r) => r.document).map((r) => recordOf(r.document));
  };
  const from = (place) => { const p = places.get(place); return [{ collectionId: p.collection, allDescendants: p.group }]; };
  const select = (fields) => (fields ? { select: { fields: [...new Set(fields.filter((f) => !f.startsWith("__")))].map((f) => ({ fieldPath: path(f) })).concat([{ fieldPath: "__name__" }]) } } : {});
  const clean = (records) => records.map(({ __raw, ...r }) => r);
  const ids = async (parent) => (await call(`${parent}:listCollectionIds`, { pageSize: 100 })).data.collectionIds ?? [];

  return {
    kind: "firestore", label: "Firestore", host: conn.host,
    async places({ want } = {}) {
      const out = [];
      const roots = (await ids(docs)).sort((a, b) => Number(b === want) - Number(a === want) || placeScore(b) - placeScore(a)).slice(0, 8);
      for (const root of roots) {
        places.set(root, { collection: root, group: false });
        const sample = await run(docs, { from: [{ collectionId: root }], limit: 20 });
        out.push({ name: root, sample: clean(sample) });
        const subs = new Set();
        for (const doc of sample.slice(0, 3)) for (const sub of await ids(doc.__raw.name)) subs.add(sub);
        for (const sub of subs) {
          const name = `${root}/*/${sub}`;
          places.set(name, { collection: sub, group: true, parent: root });
          out.push({ name, parent: root, sample: clean(await run(docs, { from: [{ collectionId: sub, allDescendants: true }], limit: 20 })) });
        }
      }
      return out;
    },
    async page({ place, fields, order, cursor, limit }) {
      const orderBy = order ? [{ field: { fieldPath: path(order) }, direction: "DESCENDING" }, { field: { fieldPath: "__name__" }, direction: "DESCENDING" }] : [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }];
      const startAt = cursor ? { startAt: { values: [...(order ? [cursor.value] : []), { referenceValue: cursor.name }], before: false } } : {};
      const got = await run(docs, { from: from(place), ...select(fields && [...fields, ...(order ? [order] : [])]), orderBy, ...startAt, limit });
      const last = got.at(-1)?.__raw;
      return { records: clean(got), next: got.length < limit ? null : { name: last.name, value: order ? last.fields?.[order] ?? { nullValue: null } : null } };
    },
    async where({ place, field, values, fields }) {
      const p = places.get(place);
      if (field === "__id") {
        const { data } = await call(`${docs}:batchGet`, { documents: values.map((v) => names.get(String(v)) ?? (p.group ? null : `${docs}/${p.collection}/${v}`)).filter(Boolean) });
        return clean(data.filter((r) => r.found).map((r) => recordOf(r.found)));
      }
      const out = [];
      if (field === "__parent") {
        for (let i = 0; i < values.length; i += 8) {
          const batch = await Promise.all(values.slice(i, i + 8).map((v) => run(parents.get(String(v)) ?? `${docs}/${p.parent}/${v}`, { from: [{ collectionId: p.collection }], ...select(fields) })));
          out.push(...batch.flat());
        }
        return clean(out);
      }

      for (let i = 0; i < values.length; i += 30) {
        out.push(...await run(docs, { from: from(place), ...select(fields), where: { fieldFilter: { field: { fieldPath: path(field) }, op: "IN", value: { arrayValue: { values: values.slice(i, i + 30).map(encode) } } } } }));
      }
      return clean(out);
    },
    close: async () => {},
  };
}
