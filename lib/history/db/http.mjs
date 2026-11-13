// One JSON request to a store's HTTP API, a busy answer waited out a few times. A refusal of the
// app's own key is said as one, naming the variables it came from; any other failure by its status
// and the store's own words, which never carry the key.
const TRIES = 4;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export async function ask(url, { method = "GET", headers = {}, body, keys = "", ok = [] } = {}) {
  const { host } = new URL(url);
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(url, {
      method,
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    if ((res.status === 429 || res.status === 503) && attempt < TRIES) { await sleep(1_000 * 2 ** (attempt - 1)); continue; }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (res.ok || ok.includes(res.status)) return { status: res.status, data };
    if (res.status === 401 || res.status === 403) throw new Error(`${host} refused ${keys ? `the ${keys} in your env` : "the read"}`);
    throw new Error(`${host} answered ${res.status}${said(data) ? `: ${said(data)}` : ""}`);
  }
}

const said = (data) => {
  const words = typeof data === "string" ? data : data?.error?.reason ?? data?.error?.message ?? data?.message ?? data?.Message ?? data?.reason ?? (typeof data?.error === "string" ? data.error : "") ?? "";
  return String(words).split("\n")[0].slice(0, 200);
};
