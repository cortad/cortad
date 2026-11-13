// Where the app's own env says a database is, by the shape of each value and the name it sits under.
// A value is parsed here and goes only to its own host; nothing of it is printed but the host.
export const LOCAL = /^(?:localhost|127\.\d+\.\d+\.\d+|::1|\[::1\]|0\.0\.0\.0|host\.docker\.internal)$/i;
const NOT_THE_APP = /SHADOW|TEST|_CI_|EXAMPLE|SAMPLE/;

// Every variable whose value is a URL with one of `schemes`, the app's main ones first.
export function urlsIn(env, schemes) {
  const out = [];
  const seen = new Set();
  const names = Object.keys(env).filter((n) => !NOT_THE_APP.test(n)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const name of names) {
    const raw = String(env[name] ?? "").trim();
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
    if (!scheme || !schemes.includes(scheme) || !URL.canParse(raw)) continue;
    const url = new URL(raw);
    const key = `${url.host}${url.pathname}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, raw, url });
  }
  return out;
}
const rank = (name) => (/^(?:DATABASE_URL|DB_URL)$/.test(name) ? 0 : /DATABASE|_DB_|^DB_|POSTGRES|MYSQL|MONGO|REDIS|SQL/.test(name) ? 1 : 2);

// The first variable set among `names`.
export const first = (env, names) => names.map((n) => [n, env[n]]).find(([, v]) => typeof v === "string" && v.trim()) ?? [null, null];

export const isLocal = (host) => LOCAL.test(String(host).replace(/:\d+$/, ""));

// An HTTP store's address: https, or http to this computer or to a container name beside it. A local
// address with no port gets the store's own, as its client library gives it.
export function httpBase(raw, port = null) {
  const value = String(raw).trim();
  const withScheme = /^[a-z]+:\/\//i.test(value) ? value : `${isLocal(value.split(/[:/]/)[0]) || !value.split(/[:/]/)[0].includes(".") ? "http" : "https"}://${value}`;
  if (!URL.canParse(withScheme)) throw new Error("an address in your env is not a URL");
  const url = new URL(withScheme);
  if (port && !url.port && (isLocal(url.hostname) || !url.hostname.includes("."))) url.port = String(port);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (isLocal(url.hostname) || !url.hostname.includes(".")))) throw new Error(`${url.host} is not reached over https`);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  url.username = "";
  url.password = "";
  return { base: `${url.origin}${url.pathname.replace(/\/+$/, "")}`, host: url.hostname, user, password, url };
}
