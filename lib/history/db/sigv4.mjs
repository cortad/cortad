import { createHash, createHmac } from "node:crypto";

const sha = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

export function signed({ method = "POST", url, body = "", headers = {}, region, service, key, secret, token, at = new Date() }) {
  const u = new URL(url);
  const stamp = at.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = stamp.slice(0, 8);
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])), host: u.host, "x-amz-date": stamp, ...(token ? { "x-amz-security-token": token } : {}) };
  const names = Object.keys(all).sort();
  const query = [...u.searchParams].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const canonical = [method, u.pathname || "/", query, names.map((n) => `${n}:${all[n].trim()}\n`).join(""), names.join(";"), sha(body)].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const signing = ["aws4_request", service, region, day].reduceRight((k, part) => hmac(k, part), `AWS4${secret}`);
  const signature = createHmac("sha256", signing).update(["AWS4-HMAC-SHA256", stamp, scope, sha(canonical)].join("\n")).digest("hex");
  const { host: _host, ...sent } = all;
  return { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${key}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}
