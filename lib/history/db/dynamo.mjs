import { readFileSync } from "node:fs";
import { join } from "node:path";
import { first, httpBase } from "./env.mjs";
import { FEW, namesOf, probed, SAMPLE, sampleEach } from "./fields.mjs";
import { ask } from "./http.mjs";
import { Unordered } from "./newest.mjs";
import { signed } from "./sigv4.mjs";

export const DYNAMO = { kind: "dynamodb", label: "DynamoDB", find, open };
const USES = /dynamodb|dynamoose|electrodb|pynamodb|dynamorm/i;
const read = (file) => { try { return readFileSync(file, "utf8"); } catch { return ""; } };

function find(env, root) {
  const [, key] = first(env, ["AWS_ACCESS_KEY_ID"]);
  const [, secret] = first(env, ["AWS_SECRET_ACCESS_KEY"]);
  const named = Object.keys(env).some((n) => /DYNAMO/.test(n));
  const uses = USES.test(["package.json", "requirements.txt", "pyproject.toml"].map((f) => read(join(root ?? ".", f))).join("\n"));
  if (!key || !secret || !(named || uses)) return [];
  const region = first(env, ["AWS_REGION", "AWS_DEFAULT_REGION", "DYNAMODB_REGION"])[1] ?? "us-east-1";
  const [endpointName, endpoint] = first(env, ["DYNAMODB_ENDPOINT", "AWS_ENDPOINT_URL_DYNAMODB", "DYNAMO_ENDPOINT", "AWS_ENDPOINT_URL"]);
  const where = httpBase(endpoint ?? `https://dynamodb.${region}.amazonaws.com`);
  return [{ kind: "dynamodb", host: where.host, envNames: ["AWS_ACCESS_KEY_ID", endpointName].filter(Boolean), base: where.base, region, key, secret, token: first(env, ["AWS_SESSION_TOKEN"])[1] ?? "", table: first(env, ["DYNAMODB_TABLE", "DYNAMODB_TABLE_NAME", "DYNAMO_TABLE"])[1] }];
}

function decode(v) {
  if (!v || typeof v !== "object") return v;
  if ("S" in v) return v.S;
  if ("N" in v) return Number(v.N);
  if ("BOOL" in v) return v.BOOL;
  if ("NULL" in v) return null;
  if ("M" in v) return Object.fromEntries(Object.entries(v.M).map(([k, x]) => [k, decode(x)]));
  if ("L" in v) return v.L.map(decode);
  if ("SS" in v) return v.SS;
  if ("NS" in v) return v.NS.map(Number);
  return null;
}
const encode = (v) => (typeof v === "number" ? { N: String(v) } : { S: String(v) });

function open(conn) {
  const call = (target, body) => {
    const text = JSON.stringify(body);
    const headers = signed({ url: `${conn.base}/`, body: text, region: conn.region, service: "dynamodb", key: conn.key, secret: conn.secret, token: conn.token, headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": `DynamoDB_20120810.${target}` } });
    return ask(`${conn.base}/`, { method: "POST", body: text, headers, keys: "AWS keys" }).then((r) => r.data);
  };
  const keys = new Map();
  const item = (place) => (raw) => {
    const out = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, decode(v)]));
    return { ...out, __id: out[keys.get(place)] };
  };

  const projection = (fields) => {
    const names = [...new Set((fields ?? []).filter((f) => f !== "__id"))];
    return names.length ? { ProjectionExpression: names.map((_, i) => `#a${i}`).join(", "), ExpressionAttributeNames: Object.fromEntries(names.map((n, i) => [`#a${i}`, n])) } : {};
  };
  const scan = async (name, n) => (await call("Scan", { TableName: name, Limit: n })).Items.map(item(name));
  const all = async (target, body) => {
    const out = [];
    let start = null;
    do {
      const got = await call(target, { ...body, ...(start ? { ExclusiveStartKey: start } : {}) });
      out.push(...got.Items);
      start = got.LastEvaluatedKey ?? null;
    } while (start);
    return out;
  };
  return {
    kind: "dynamodb", label: "DynamoDB", host: conn.host,
    async places({ only } = {}) {
      const names = [];
      let start = null;
      do {
        const got = await call("ListTables", { ...(start ? { ExclusiveStartTableName: start } : {}) });
        names.push(...got.TableNames);
        start = got.LastEvaluatedTableName ?? null;
      } while (start && names.length < 1_000);
      return sampleEach(probed(names, only ?? (conn.table ? [conn.table] : null)), async (name) => {
        keys.set(name, (await call("DescribeTable", { TableName: name })).Table.KeySchema.find((k) => k.KeyType === "HASH").AttributeName);
        return { name, paths: namesOf(await scan(name, FEW)) };
      });
    },
    sample: (place) => scan(place, SAMPLE),
    async page({ place, fields, order, cursor, limit }) {
      if (order) throw new Unordered();
      const got = await call("Scan", { TableName: place, Limit: limit, ...projection(fields && [...fields, keys.get(place)]), ...(cursor ? { ExclusiveStartKey: cursor } : {}) });
      return { records: got.Items.map(item(place)), next: got.LastEvaluatedKey ?? null };
    },
    async where({ place, field, values, fields }) {
      const name = field === "__id" ? keys.get(place) : field;
      const p = projection(fields && [...fields, keys.get(place)]);
      const names = { ...p.ExpressionAttributeNames, "#k": name };
      if (name === keys.get(place)) {
        const out = [];
        for (let i = 0; i < values.length; i += 8) {
          const batch = await Promise.all(values.slice(i, i + 8).map((v) => all("Query", { TableName: place, KeyConditionExpression: "#k = :v", ExpressionAttributeValues: { ":v": encode(v) }, ...p, ExpressionAttributeNames: names })));
          out.push(...batch.flat());
        }
        return out.map(item(place));
      }

      const marks = values.map((v, i) => [`:v${i}`, encode(v)]);
      return (await all("Scan", { TableName: place, FilterExpression: `#k IN (${marks.map(([m]) => m).join(", ")})`, ExpressionAttributeValues: Object.fromEntries(marks), ...p, ExpressionAttributeNames: names })).map(item(place));
    },
    close: async () => {},
  };
}
