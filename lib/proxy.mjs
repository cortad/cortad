import { appendFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import wire from "./wire.cjs";
import tied from "./tied.cjs";

const { MAX, REPLY_MAX, MODEL_HOST, scrubbed, turnOf, decoded, cookieNames, makeRecorder } = wire;

const DEFAULTS = { OPENAI_BASE_URL: "https://api.openai.com/v1", ANTHROPIC_BASE_URL: "https://api.anthropic.com", GOOGLE_GEMINI_BASE_URL: "https://generativelanguage.googleapis.com" };

const MODEL_SETTING = /OPENAI|ANTHROPIC|GEMINI|LLM|OLLAMA|LITELLM|VLLM|MODEL/i;
const ADDRESS_SETTING = /BASE|URL|ENDPOINT|HOST/i;
const SECRET_SETTING = /KEY|TOKEN|SECRET|PASSWORD/i;

const HOP = /^(?:host|connection|keep-alive|transfer-encoding|upgrade|te|trailer|proxy-.*|content-length|accept-encoding)$/i;
const REPLY_HOP = /^(?:connection|keep-alive|transfer-encoding|content-length|content-encoding)$/i;

const modelHost = (h) => (/amazonaws\.com$/i.test(h) ? /^bedrock/i.test(h) : /googleapis\.com$/i.test(h) ? /generativelanguage|aiplatform/i.test(h) : MODEL_HOST.test(h));

const asked = (raw) => (/^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(raw) ? [...new URLSearchParams(raw).values()].flatMap(tied.sentencesIn) : tied.sentencesIn(raw));

const UNSEEN_MS = 3000;

const listen = async (server, port = 0) => {
  const at = await new Promise((resolve) => {
    server.once("error", () => resolve(null));
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
  if (at !== null) return at;
  server.removeAllListeners("error");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
};

export async function openProxy({ file, rulesFile, target, modelPort: wantedModelPort = 0, onSeen = () => {}, onUnseen = () => {} }) {
  const row = (value) => { try { appendFileSync(file, JSON.stringify(scrubbed(value)) + "\n", { mode: 0o600 }); } catch {  } };
  const rec = makeRecorder({ row, rulesFile });

  const open = new Set();

  let calls = 0, unseen = false;
  const unseenIf = (method, path, sent, reply) => {
    if (calls || unseen || !(reply.status >= 200 && reply.status < 300)) return;
    const words = asked(sent);
    if (!words.length || !tied.sentencesIn(reply.text).some((w) => !words.includes(w))) return;
    setTimeout(() => { if (!calls && !unseen) { unseen = true; onUnseen(`${method} ${path.split("?")[0]}`); } }, UNSEEN_MS).unref();
  };

  const front = createServer((req, res) => {
    const { "x-cortad-turn": _turn, ...headers } = req.headers;
    const ctx = /^(?:HEAD|OPTIONS)$/.test(req.method) ? null : rec.requestCtx(req.method, req.url || "/", headers, turnOf(req.headers));
    if (ctx && req.method !== "GET") open.add(ctx);
    const finish = (reply) => {
      if (!ctx || ctx.ended) return;
      open.delete(ctx);
      rec.ended(ctx, reply);
      if (req.method !== "GET") unseenIf(req.method, ctx.path, Buffer.concat(ctx.chunks).toString("utf8"), reply);
    };
    const { host, port } = target();

    const up = request({ host, port, method: req.method, path: req.url, headers });
    if (ctx && req.method !== "GET") req.on("data", (c) => { if (ctx.size < MAX) { ctx.chunks.push(c); ctx.size += c.length; } });
    req.pipe(up);
    res.on("close", () => up.destroy());

    up.on("error", () => { finish({ status: 0, type: "", text: "", cookies: [], cut: true }); res.destroy(); });
    up.on("response", (r) => {
      const got = [];
      let size = 0, writes = 0;
      r.on("data", (c) => { writes += 1; if (size < MAX) { got.push(c); size += c.length; } });
      const text = () => decoded(Buffer.concat(got), r.headers["content-encoding"]);
      r.on("end", () => { if (ctx) rec.tied.replied(ctx, r.statusCode, text); });
      r.on("error", () => res.destroy());
      const done = () => finish({ status: r.statusCode, type: String(r.headers["content-type"] || ""), writes: r.headers["content-length"] ? 1 : writes, text: text(), cookies: cookieNames(r.headers["set-cookie"]), cut: !res.writableFinished });
      res.once("finish", done);
      res.once("close", done);
      res.writeHead(r.statusCode, r.statusMessage, r.rawHeaders);
      r.pipe(res);
    });
  });

  front.on("upgrade", (req, socket, head) => {
    const { host, port } = target();
    const up = connect({ host, port }, () => {
      const lines = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    const end = () => { socket.destroy(); up.destroy(); };
    up.on("error", end);
    socket.on("error", end);
  });

  const slots = [];
  const relay = async (req, res) => {
    const m = /^\/u\/(\d+)([/?][^]*)?$/.exec(req.url || "");
    const base = m && slots[Number(m[1])];
    if (!base) { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":{"message":"cortad: no model setting points here"}}'); return; }

    const metered = !/^(?:GET|HEAD)$/.test(req.method);
    if (metered && ++calls === 1) onSeen();
    const parts = [];
    for await (const c of req) parts.push(c);
    const body = Buffer.concat(parts);

    const sent = wire.asChat(body.toString("utf8"), wire.GATEWAY_MODEL.map((h) => req.headers[h]).find(Boolean));
    const url = new URL(base.replace(/\/+$/, "") + (m[2] ?? ""));

    const ctx = metered ? rec.note(undefined, sent, open.size === 1 ? [...open][0] : undefined) : undefined;
    const t0 = Date.now();
    const meter = (status, type, text) => { if (metered) rec.meter({ host: url.host, path: url.pathname, sent, status, type, body: text, ctx, t0 }); };

    const gone = new AbortController();
    res.on("close", () => { if (!res.writableFinished) gone.abort(); });
    let got;
    try {
      got = await fetch(url, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.test(k))), body: metered && body.length ? body : undefined, redirect: "manual", signal: gone.signal });
    } catch (e) {
      meter(0, "", "");
      if (gone.signal.aborted) return;
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `cortad could not reach ${url.host}: ${e.cause?.code ?? e.message}` } }));
      return;
    }
    if (ctx) ctx.heard = true;
    const headers = {};
    for (const [k, v] of got.headers) if (!REPLY_HOP.test(k) && k !== "set-cookie") headers[k] = v;
    const cookies = got.headers.getSetCookie();
    res.writeHead(got.status, cookies.length ? { ...headers, "set-cookie": cookies } : headers);
    const kept = [];
    let size = 0;
    try {
      for await (const c of got.body ?? []) {
        res.write(c);
        if (size < REPLY_MAX) { kept.push(Buffer.from(c)); size += c.length; }
      }
    } catch {  }
    res.end();
    meter(got.status, got.headers.get("content-type") ?? "", Buffer.concat(kept).toString("utf8"));
  };

  const model = createServer((req, res) => { relay(req, res).catch(() => res.destroy()); });

  model.on("connect", (req, socket, head) => {
    const at = /^([^\s:]+|\[[^\]]+\]):(\d{1,5})$/.exec(req.url || "");
    if (!at) { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
    const host = at[1].replace(/^\[|\]$/g, "");
    if (modelHost(host) && ++calls === 1) onSeen();
    const up = connect({ host, port: Number(at[2]) }, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    const end = () => { socket.destroy(); up.destroy(); };
    up.on("error", () => { if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); end(); });
    socket.on("error", end);
  });

  const frontPort = await listen(front);
  const modelPort = await listen(model, wantedModelPort);
  row({ hello: "proxy", pid: process.pid });
  const via = (upstream) => {
    if (!slots.includes(upstream)) slots.push(upstream);
    return `http://127.0.0.1:${modelPort}/u/${slots.indexOf(upstream)}`;
  };
  return {
    port: frontPort,
    modelPort,

    env(base) {
      const out = {};

      if (!base.HTTPS_PROXY && !base.https_proxy) {
        out.HTTPS_PROXY = out.https_proxy = `http://127.0.0.1:${modelPort}`;
        out.NO_PROXY = out.no_proxy = [base.NO_PROXY || base.no_proxy, "localhost,127.0.0.1,::1,host.docker.internal"].filter(Boolean).join(",");
      }
      for (const [name, fallback] of Object.entries(DEFAULTS)) out[name] = via(base[name] || fallback);
      for (const [name, value] of Object.entries(base)) {
        if (name in out || SECRET_SETTING.test(name) || typeof value !== "string") continue;
        let u;
        try { u = new URL(value); } catch { continue; }
        if (/^https?:$/.test(u.protocol) && (MODEL_HOST.test(u.hostname) || (MODEL_SETTING.test(name) && ADDRESS_SETTING.test(name)))) out[name] = via(value);
      }
      return out;
    },

    seen: () => calls > 0,
    close: () => { for (const s of [front, model]) { s.closeAllConnections(); s.close(); } },
  };
}
