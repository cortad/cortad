// Loaded into your app by the command that started it (node --require), and only then. It watches
// for two things. First, a request to your app during which your app called a model: an exchange,
// with the exact body it took, the sign-in it carried, what your app answered, the lines of your code
// that wrote it and the prompt it sent, so the door is proven by a message rather than guessed from
// code. The first few per route are kept, so two turns of one conversation are both seen. Second,
// every model call your app makes: the host, the model it asked for, the status, the seconds and the
// token counts the provider sent back, which tools it asked for (names and clipped arguments, never a
// secret) and the passages its prompt was handed; the model's words only for a call inside a kept
// exchange or a run's turn. Both go to a file only you can read, in the command's own folder on this
// machine. Nothing here talks to a network.
"use strict";
const FILE = process.env.CORTAD_TRACE_FILE;
if (FILE) {
  try {
    const { AsyncLocalStorage } = require("node:async_hooks");
    const fs = require("node:fs");
    const http = require("node:http");
    const https = require("node:https");
    const als = new AsyncLocalStorage();
    const { MAX, REPLY_MAX, EMBEDDING, TOOL_TEXT, toolText, scrubbed, list, clipped, argsText, turnOf, isModelCall, isRetrieval, passagesFrom, decoded, cookieNames, makeRecorder, asChat, GATEWAY_MODEL } = require("./wire.cjs");
    const row = (value) => { try { fs.appendFileSync(FILE, JSON.stringify(scrubbed(value)) + "\n", { mode: 0o600 }); } catch { /* the command is gone */ } };
    // What the app writes into its own folder while a run is on: each file copied once before its
    // first write, so the command puts every one back when the run ends (lib/writes.mjs). Trials
    // wrote carts and tickets into an app's data/*.json and the developer's own tests read them.
    const WRITES_DIR = process.env.CORTAD_WRITES_DIR;
    const APP_ROOT = process.env.CORTAD_APP_ROOT;
    if (WRITES_DIR && APP_ROOT) {
      const p = require("node:path");
      const crypto = require("node:crypto");
      const { fileURLToPath } = require("node:url");
      // Not the app's data: what a build, a package manager or a log writes.
      const NOT_DATA = /(?:^|\/)(?:node_modules|\.git|\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache|\.parcel-cache|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|dist|build|out|coverage|\.cortad|logs?)(?:\/|$)|\.log(?:\.[\w-]+)?$|\.(?:pyc|tmp|swp)$/;
      const raw = { copyFileSync: fs.copyFileSync, appendFileSync: fs.appendFileSync, existsSync: fs.existsSync, mkdirSync: fs.mkdirSync, statSync: fs.statSync, readFileSync: fs.readFileSync };
      const root = p.resolve(APP_ROOT);
      let run = null, runAt = -1;
      const seen = new Set();
      // The run marker names the run; a new one starts the record over, none stops it.
      const runNow = () => {
        try {
          const at = raw.statSync(p.join(WRITES_DIR, "run")).mtimeMs;
          if (at !== runAt) { runAt = at; run = raw.readFileSync(p.join(WRITES_DIR, "run"), "utf8").trim(); seen.clear(); }
          return run;
        } catch { run = null; runAt = -1; seen.clear(); return null; }
      };
      const note = (target) => {
        try {
          if (typeof target !== "string" && !Buffer.isBuffer(target) && !(target instanceof URL)) return;
          const abs = p.resolve(target instanceof URL ? fileURLToPath(target) : String(target));
          if (!abs.startsWith(root + p.sep)) return;
          const rel = p.relative(root, abs);
          if (NOT_DATA.test(rel)) return;
          const id = runNow();
          if (!id || seen.has(rel)) return;
          seen.add(rel);
          let before = null;
          if (raw.existsSync(abs) && raw.statSync(abs).isFile()) {
            before = p.join(WRITES_DIR, "before", crypto.createHash("sha1").update(rel).digest("hex"));
            raw.mkdirSync(p.dirname(before), { recursive: true, mode: 0o700 });
            raw.copyFileSync(abs, before);
          }
          raw.appendFileSync(p.join(WRITES_DIR, "written.jsonl"), JSON.stringify({ run: id, path: rel, before }) + "\n", { mode: 0o600 });
        } catch { /* the folder is gone or the path is not a file: the write goes on as it was */ }
      };
      const O = fs.constants;
      const opensForWrite = (flags) => typeof flags === "number" ? Boolean(flags & (O.O_WRONLY | O.O_RDWR | O.O_APPEND | O.O_TRUNC | O.O_CREAT))
        : typeof flags === "string" ? /[wax+]/.test(flags) : false;
      const wrap = (obj, name, at) => {
        const orig = obj?.[name];
        if (typeof orig !== "function") return;
        const wrapped = function (...args) { try { at(args); } catch { /* recorded or not, the write goes on */ } return orig.apply(this, args); };
        try { Object.defineProperty(wrapped, "name", { value: orig.name }); } catch { /* fine */ }
        obj[name] = wrapped;
      };
      const first = (args) => note(args[0]);
      const both = (args) => { note(args[0]); note(args[1]); };
      const opened = (args) => { if (opensForWrite(args[1] && typeof args[1] === "object" ? args[1].flags : args[1])) note(args[0]); };
      for (const name of ["writeFileSync", "writeFile", "appendFileSync", "appendFile", "createWriteStream", "unlinkSync", "unlink", "rmSync", "rm", "truncateSync", "truncate"]) wrap(fs, name, first);
      for (const name of ["renameSync", "rename", "copyFileSync", "copyFile"]) wrap(fs, name, both);
      for (const name of ["openSync", "open"]) wrap(fs, name, opened);
      for (const name of ["writeFile", "appendFile", "unlink", "rm", "truncate"]) wrap(fs.promises, name, first);
      for (const name of ["rename", "copyFile"]) wrap(fs.promises, name, both);
      wrap(fs.promises, "open", opened);
      // `import { writeFileSync } from "node:fs"` binds to the wrapped function too.
      try { require("node:module").syncBuiltinESMExports(); } catch { /* CommonJS only */ }
    }
    const isBun = typeof Bun !== "undefined" && typeof Bun.serve === "function";
    // Said once, so the command knows a message sent to this app can be seen arriving.
    row({ hello: isBun ? "bun" : "node", pid: process.pid });
    // Which port this process serves. Every process the start command spawns loads this file, turbo's
    // own launcher included, so "loaded" is not "watching your app": only a listener on the app's port is.
    const listening = (port) => { if (Number.isInteger(port) && port > 0) { row({ listen: port, pid: process.pid }); sayRoutes(port); } };

    // The app's own route table, so the run knows every door it has before a message is sent.
    // Express keeps no mount prefix once a router is built (Express 5 layers keep no path at all),
    // so its registrations are watched as they happen; the others are read off the app.
    const ROUTES_MAX = 400;
    const pathOf = (p) => String(p)
      .replace(/\{(\/?[:*][^{}]*)\}/g, "$1")
      .replace(/:(\w+)(?:\{[^{}]*\})?\??/g, "{$1}")
      .replace(/\*(\w+)/g, "{$1}");
    const joined = (a, b) => ("/" + [a, b].map((s) => String(s).replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/"));
    const nodePath = require("node:path");
    // The frames of the stack it is called from, nearest first, outside this hook and node_modules,
    // relative to the folder the app was started in. An awaited call keeps its awaiting frames in
    // the stack, and an SDK is deeper than the default ten frames.
    // A frame still inside a build folder is a bundle line no one edits: it is kept by its absolute
    // path and column, and the command places it through the chunk's source map (lib/replay.mjs), so
    // the app never reads a map on a request's path.
    const BUILT = /\/(?:\.next|\.nuxt|\.svelte-kit|\.output|\.turbo|\.vercel|dist|build|out)\//;
    // `typed`: each frame also carries the type of the object it was called on, read off the same
    // stack as it is formatted; none at all when a formatter of the app's own does not keep one line a
    // frame.
    const stackFrames = (typed) => {
      const limit = Error.stackTraceLimit, prepare = Error.prepareStackTrace;
      let types = null;
      Error.stackTraceLimit = 60;
      if (typed) Error.prepareStackTrace = (err, calls) => { types = calls.map((c) => c.getTypeName()); return typeof prepare === "function" ? prepare(err, calls) : [String(err), ...calls.map((c) => `    at ${c}`)].join("\n"); };
      let stack;
      try { stack = String(new Error().stack); } finally { Error.stackTraceLimit = limit; if (typed) Error.prepareStackTrace = prepare; }
      const lines = stack.split("\n").slice(1);
      if (typed && lines.length !== types?.length) return [];
      const out = [];
      lines.forEach((line, i) => {
        const m = /\(?(?:file:\/\/)?(\/[^()]+?):(\d+):(\d+)\)?$/.exec(line.trim());
        if (!m || m[1] === __filename || m[1].includes("/node_modules/")) return;
        const type = typed ? { type: types[i] } : {};
        if (BUILT.test(m[1])) out.push({ file: decodeURI(m[1]), line: Number(m[2]), column: Number(m[3]), built: true, ...type });
        else out.push({ file: nodePath.relative(process.cwd(), decodeURI(m[1])), line: Number(m[2]), ...type });
      });
      return out;
    };
    // The file that registered a route: the first frame outside this hook and outside node_modules.
    const callerFile = () => { const f = stackFrames().find((x) => !x.built); return f && !f.file.startsWith("..") ? f.file : ""; };
    // A built frame is written as its chunk's absolute path, line and column, which no app frame's
    // relative path can be mistaken for.
    const atOf = (f) => (f.built ? `${f.file}:${f.line}:${f.column}` : `${f.file}:${f.line}`);
    // Which of the app's own lines made a model call, nearest first: the run names the code path that
    // ran by it, where the read could only name the door. Five lines: a provider class's stream, post
    // and retry can be three lines of one file, and the line that says which path ran is past them.
    // Built frames are handed on past five, since the SDK bundled beside the app's code fills the
    // first of them; the command keeps five once its map has placed them.
    const CALLERS_MAX = 5, CALLERS_BUILT = 20;
    const callers = () => {
      const out = [];
      let own = 0;
      for (const f of stackFrames()) {
        const at = atOf(f);
        if (f.file.startsWith("..") || out.includes(at)) continue;
        out.push(at);
        if (!f.built) own++;
        if (own === CALLERS_MAX || out.length === CALLERS_BUILT) break;
      }
      return out.length ? out : undefined;
    };
    const seen = new Set();
    let nest = false;

    const expressRoutes = [];
    const expressMounts = [];
    const OWNER = Symbol("cortad.router");
    const isApp = (o) => typeof o === "function" && typeof o.set === "function" && typeof o.handle === "function";
    const isRouter = (o) => typeof o === "function" && Array.isArray(o.stack) && typeof o.handle === "function";
    const useArgs = (args) => {
      let first = args[0];
      while (Array.isArray(first) && first.length) first = first[0];
      const pathed = typeof first !== "function";
      return { paths: pathed ? [].concat(args[0]).filter((p) => typeof p === "string") : ["/"], fns: args.slice(pathed ? 1 : 0).flat(Infinity) };
    };
    const patchExpress = (express) => {
      seen.add("express");
      const routerProto = typeof express.Router.prototype.route === "function" ? express.Router.prototype : express.Router;
      const mounting = (proto, wanted) => {
        const use = proto.use;
        proto.use = function (...args) {
          try {
            const { paths, fns } = useArgs(args);
            for (const fn of fns) if (wanted(fn)) for (const path of paths) expressMounts.push({ parent: this, child: fn, path });
          } catch { /* not ours to fail */ }
          return use.apply(this, args);
        };
      };
      // Express 4 and 5 both pass a plain router through to the router's own use, and hide a
      // mounted sub-app behind a wrapper there, so each level records only what it can see.
      mounting(routerProto, isRouter);
      mounting(express.application, isApp);
      const route = routerProto.route;
      routerProto.route = function (...args) {
        const made = route.apply(this, args);
        try { made[OWNER] = this; } catch { /* frozen */ }
        return made;
      };
      for (const verb of ["get", "post", "put", "patch", "delete", "all"]) {
        const add = express.Route.prototype[verb];
        if (typeof add !== "function") continue;
        express.Route.prototype[verb] = function (...args) {
          try {
            if (expressRoutes.length < ROUTES_MAX * 4) {
              const fns = args.flat(Infinity);
              expressRoutes.push({ owner: this[OWNER], verb, paths: [].concat(this.path).filter((p) => typeof p === "string"), handler: fns[fns.length - 1], file: callerFile() });
            }
          } catch { /* not ours to fail */ }
          return add.apply(this, args);
        };
      }
    };
    const expressTable = (add) => {
      // An app is known by its router once it has one: routes are registered on the router.
      // Express 4's app.router getter throws; its router is _router, made on the first route.
      const own = (o) => {
        if (!isApp(o) || o._router) return (o && o._router) || o;
        try { return o.router || o; } catch { return o; }
      };
      const ups = new Map();
      for (const m of expressMounts) {
        const child = own(m.child);
        if (!ups.has(child)) ups.set(child, []);
        ups.get(child).push({ parent: own(m.parent), path: m.path });
      }
      const prefixes = (router, depth) => (!ups.has(router) || depth > 8 ? [""] : ups.get(router).flatMap((m) => prefixes(m.parent, depth + 1).map((p) => joined(p, m.path))));
      for (const r of expressRoutes) {
        for (const prefix of prefixes(own(r.owner), 0)) for (const path of r.paths) add(r.verb === "all" ? null : [r.verb], joined(prefix, path), r.handler, r.file);
      }
    };

    // Fastify says each instance it makes on a diagnostics channel, and a root onRoute hook sees
    // every route with its plugin prefix already applied.
    const fastifyRoutes = [];
    try {
      require("node:diagnostics_channel").subscribe("fastify.initialization", ({ fastify }) => {
        seen.add("fastify");
        try {
          fastify.addHook("onRoute", (o) => {
            if (fastifyRoutes.length < ROUTES_MAX * 2) fastifyRoutes.push({ methods: [].concat(o.method), path: o.url, handler: o.handler, file: callerFile() });
          });
        } catch { /* an instance that takes no hooks */ }
      });
    } catch { /* no diagnostics channel */ }

    // Hono and Koa keep their tables on the app, so their apps are held as they are made. Only
    // what is loaded through require is seen: Hono's ES module build never passes through here.
    const honoApps = new Set();
    const koaApps = new Set();
    const holding = new WeakMap();
    const heldHono = (exported) => {
      const d = Object.getOwnPropertyDescriptor(exported, "Hono");
      if (!d || ("value" in d && !d.writable && !d.configurable)) return exported;
      seen.add("hono");
      const Hono = new Proxy(exported.Hono, { construct(t, a, nt) { const app = Reflect.construct(t, a, nt); if (honoApps.size < 50) honoApps.add(app); return app; } });
      return new Proxy(exported, { get: (t, k, r) => (k === "Hono" ? Hono : Reflect.get(t, k, r)) });
    };
    const patchKoa = (Koa) => {
      seen.add("koa");
      const callback = Koa.prototype.callback;
      Koa.prototype.callback = function (...a) { if (koaApps.size < 50) koaApps.add(this); return callback.apply(this, a); };
    };
    // gRPC: every rpc the app serves is a door at "/pkg.Service/Rpc". The service's methods are
    // wrapped as the app binds them, so each call is an exchange like a request: the message as the
    // body, the metadata as headers, the model calls made inside it tied to it, the reply as written.
    const grpcRoutes = [];
    const grpcHeaders = (metadata) => { try { const map = metadata.getMap(); return Object.fromEntries(Object.entries(map).map(([k, v]) => [String(k).toLowerCase(), Buffer.isBuffer(v) ? v.toString("base64") : String(v)])); } catch { return {}; } };
    const grpcText = (value) => { try { return JSON.stringify(value === undefined ? null : value); } catch { return String(value); } };
    const patchGrpc = (grpc) => {
      if (!grpc.Server || typeof grpc.Server.prototype.addService !== "function") return;
      seen.add("grpc");
      // A gRPC server listens over http2, so the http listening the hook watches never fires: the
      // bound port is said when the bind completes, and the rpcs go on the route table with it.
      const bindAsync = grpc.Server.prototype.bindAsync;
      if (typeof bindAsync === "function") grpc.Server.prototype.bindAsync = function (address, credentials, callback) {
        return bindAsync.call(this, address, credentials, (err, port) => { try { if (!err && port) listening(port); } catch { /* the table is a courtesy */ } return typeof callback === "function" ? callback(err, port) : undefined; });
      };
      const addService = grpc.Server.prototype.addService;
      grpc.Server.prototype.addService = function (service, impl) {
        const wrapped = {};
        for (const [name, def] of Object.entries(service || {})) {
          const fn = impl && impl[name];
          const path = def && typeof def.path === "string" ? def.path : `/${name}`;
          if (grpcRoutes.length < ROUTES_MAX) grpcRoutes.push({ path, handler: fn, file: callerFile() });
          // A client stream carries no one body to record: it is served as it was.
          if (typeof fn !== "function" || (def && def.requestStream)) { wrapped[name] = fn; continue; }
          wrapped[name] = function (call, callback) {
            const headers = grpcHeaders(call && call.metadata);
            const { "x-cortad-turn": _turn, ...rest } = headers;
            const ctx = requestCtx("GRPC", path, rest, turnOf(headers));
            try { const b = Buffer.from(grpcText(call && call.request)); ctx.chunks.push(b); ctx.size += b.length; } catch { /* a message that will not serialise is recorded empty */ }
            if (def && def.responseStream) {
              const parts = [];
              const write = call.write, end = call.end;
              call.write = function (message, ...a) { if (parts.length < 1000) parts.push(grpcText(message)); return write.apply(this, [message, ...a]); };
              call.end = function (...a) { ended(ctx, { status: 200, type: "application/grpc+json-stream", text: parts.join("\n"), cookies: [] }); return end.apply(this, a); };
              return als.run(ctx, () => fn.call(this, call));
            }
            const done = (err, value, ...a) => { ended(ctx, { status: err ? 500 : 200, type: "application/grpc+json", text: err ? grpcText({ error: String((err && err.message) || err) }) : grpcText(value), cookies: [] }); return callback(err, value, ...a); };
            return als.run(ctx, () => fn.call(this, call, done));
          };
        }
        return addService.call(this, service, wrapped);
      };
    };
    const adopted = (request, exported) => {
      if (!exported || !/(?:^|node_modules\/)(?:express|koa|hono|@nestjs\/core|@grpc\/grpc-js)(?:\/index\.js|\/build\/src\/index\.js)?$|\/lib\/(?:express|application)(?:\.js)?$/.test(request)) return exported;
      if (holding.has(exported)) return holding.get(exported);
      let out = exported;
      if (/@grpc\/grpc-js/.test(request)) patchGrpc(exported);
      else if (typeof exported === "function" && exported.application && typeof exported.Router === "function" && typeof exported.Route === "function") patchExpress(exported);
      else if (typeof exported === "function" && exported.prototype && typeof exported.prototype.callback === "function" && typeof exported.prototype.createContext === "function") patchKoa(exported);
      else if (typeof exported.Hono === "function") out = heldHono(exported);
      else if (exported.NestFactory) nest = true;
      holding.set(exported, out);
      return out;
    };
    const Module = require("node:module");
    const load = Module._load;
    Module._load = function (request, ...rest) {
      const exported = load.call(this, request, ...rest);
      try { return adopted(String(request), exported); } catch { return exported; }
    };

    let bunRoutes = [];
    const table = () => {
      const out = new Map();
      const from = new Set();
      const add = (framework) => (methods, path, handler, file) => {
        if (typeof path !== "string") return;
        for (const m of methods || ["POST", "GET"]) {
          const method = String(m).toUpperCase();
          const at = pathOf(path.startsWith("/") ? path : "/" + path);
          if (method === "HEAD" || method === "OPTIONS" || out.size >= ROUTES_MAX || out.has(`${method} ${at}`)) continue;
          from.add(framework);
          out.set(`${method} ${at}`, { method, path: at.slice(0, 1024), file: String(file || "").slice(0, 512), handler: String((handler && handler.name) || "").slice(0, 200) });
        }
      };
      expressTable(add("express"));
      for (const r of fastifyRoutes) add("fastify")(r.methods, r.path, r.handler, r.file);
      for (const r of grpcRoutes) add("grpc")(["GRPC"], r.path, r.handler, r.file);
      // A sub-app's routes are copied into the app that mounts it, so the widest table is the app.
      const hono = [...honoApps].reduce((a, b) => (Array.isArray(b.routes) && b.routes.length > ((a && a.routes.length) || 0) ? b : a), null);
      for (const r of hono ? hono.routes : []) if (r.method !== "ALL" || !r.path.endsWith("*")) add("hono")(r.method === "ALL" ? null : [r.method], r.path, r.handler, "");
      for (const app of koaApps) for (const mw of app.middleware || []) for (const layer of (mw.router && mw.router.stack) || []) {
        if (layer.methods && layer.methods.length) add("koa")(layer.methods, layer.path, layer.stack && layer.stack[layer.stack.length - 1], "");
      }
      for (const r of bunRoutes) add(seen.has("elysia") ? "elysia" : "unknown")(r.methods, r.path, r.handler, "");
      const framework = nest ? "nest" : [...from][0] || [...seen][0] || "unknown";
      return { framework, routes: [...out.values()] };
    };
    let routesSaid = -1, lastPort = null;
    function sayRoutes(port) {
      try {
        lastPort = port;
        const { framework, routes } = table();
        routesSaid = routes.length;
        row({ routes: { framework, port, routes, openapi: null } });
      } catch { /* the table is a courtesy; the app is not */ }
    }
    // Routes an app adds after it starts listening are there by its first request.
    let recheck = true;
    const recheckRoutes = () => {
      if (!recheck || lastPort === null) return;
      recheck = false;
      setImmediate(() => { try { if (table().routes.length !== routesSaid) sayRoutes(lastPort); } catch { /* as above */ } });
    };
    const { tied, requestCtx, note, ended, meter } = makeRecorder({
      row,
      rulesFile: process.env.CORTAD_RULES_FILE,
      onTurn: () => {},
      onEnded: (ctx, steps) => writtenAt(ctx, steps),
    });
    // Where in the app's own code each part of a reply was written: the app's line on the stack of the
    // write, or, for a web stream the app hands back, where its code put the chunk into the stream,
    // kept when the reply carried it. One entry per line and event name, with the first bytes written
    // there, so a block in the reply is placed at the write that sent it (lib/pyhook/cortad_sites.py).
    // ponytail: a reply's first thousand writes are traced; a leak later in a longer stream goes unplaced.
    const SITES_MAX = 16, SITE_TEXT = 300, SITE_WRITES = 1000, BUILT_WALK = 12;
    const EVENT = /^event:[ \t]*([\w.:-]{1,40})/m, JSON_EVENT = /"(?:type|event)"\s*:\s*"([\w.:-]{1,40})"/;
    const siteText = (chunk) => {
      if (typeof chunk === "string") return chunk.slice(0, SITE_TEXT);
      if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, Math.min(chunk.byteLength, SITE_TEXT)).toString("utf8").replace(/\uFFFD+$/, "");
      try { return chunk && typeof chunk === "object" ? String(JSON.stringify(chunk)).slice(0, SITE_TEXT) : ""; } catch { return ""; }
    };
    const wrote = (ctx, chunk, streamed) => {
      if (!ctx || !ctx.sites || ++ctx.traced > SITE_WRITES || ctx.sites.length >= SITES_MAX) return;
      // A method the app put on the response, such as a res.end that logs and calls the one it replaced,
      // only hands the write on: the app's line that called it wrote it.
      const frames = stackFrames(true);
      const i = frames.findIndex((f) => !f.file.startsWith("..") && f.type !== ctx.responseType);
      const text = i >= 0 && siteText(chunk);
      if (!text) return;
      // In a bundle the first frames are the SDK compiled into the same chunk: the next few are
      // handed on, and the command keeps the first that its map places in the app's own source.
      const own = frames[i];
      const at = own.built ? frames.slice(i, i + BUILT_WALK).filter((f) => f.built).map(atOf) : atOf(own);
      const m = EVENT.exec(text) || JSON_EVENT.exec(text);
      const event = m ? m[1] : undefined;
      if (ctx.sites.some((s) => String(s.at) === String(at) && s.event === event)) return;
      ctx.sites.push({ at, ...(event ? { event } : {}), text, ...(streamed ? { streamed } : {}) });
    };
    for (const Controller of [globalThis.ReadableStreamDefaultController, globalThis.TransformStreamDefaultController]) {
      const enqueue = Controller && Controller.prototype.enqueue;
      if (typeof enqueue !== "function") continue;
      Controller.prototype.enqueue = function (chunk) { try { wrote(als.getStore(), chunk, true); } catch { /* the chunk goes on */ } return enqueue.apply(this, arguments); };
    }
    // Written under the id its exchange is written by.
    const writtenAt = (ctx, steps) => {
      const asker = (steps && steps.at(-1)) || ctx;
      const turn = ctx.turn || asker.turn;
      const list = ctx.sites.filter((s) => !s.streamed || ctx.reply.text.includes(s.text)).map(({ streamed, ...s }) => s);
      if (list.length && (asker.kept || turn)) row({ sites: { ex: asker.id, ...(turn ? { turn } : {}), list } });
    };
    // What the app sends back, as it writes it: its own listeners and pipes see exactly the same.
    const watchReply = (ctx, res) => {
      if (!res || typeof res.write !== "function" || typeof res.end !== "function") return;
      ctx.responseType = res.constructor && res.constructor.name;
      const got = [];
      let size = 0, writes = 0;
      const keep = (chunk, encoding) => {
        if (chunk == null || typeof chunk === "function") return;
        writes += 1;
        wrote(ctx, chunk);
        if (size >= MAX) return;
        const b = Buffer.isBuffer(chunk) ? chunk : typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" && Buffer.isEncoding(encoding) ? encoding : "utf8") : Buffer.from(chunk);
        got.push(b);
        size += b.length;
      };
      for (const name of ["write", "end"]) {
        const orig = res[name];
        res[name] = function (chunk, encoding) { try { keep(chunk, encoding); if (name === "end") tied.replied(ctx, res.statusCode, () => decoded(Buffer.concat(got), sentHeader("content-encoding"))); } catch { /* the reply goes on */ } return orig.apply(this, arguments); };
      }
      // writeHead(status, headers) sends its headers without keeping them where getHeader looks: the
      // header block as sent says them either way.
      const sentHeader = (name) => {
        const kept = res.getHeader(name);
        if (kept !== undefined) return kept;
        const block = typeof res._header === "string" ? res._header : "";
        const found = block.split("\r\n").filter((l) => l.toLowerCase().startsWith(`${name}:`)).map((l) => l.slice(name.length + 1).trim());
        return name === "set-cookie" ? found : found[0];
      };
      // `cut`: the app began its reply and the connection closed before it finished, so the row holds
      // part of it. Either side may have closed it (a client that stopped reading, an app that broke
      // off mid-stream), so nothing downstream says which.
      const done = () => {
        try { ended(ctx, { status: res.statusCode, type: sentHeader("content-type"), writes, text: decoded(Buffer.concat(got), sentHeader("content-encoding")), cookies: cookieNames(sentHeader("set-cookie")), cut: res.headersSent && !res.writableFinished }); } catch { /* the command is gone */ }
      };
      res.once("finish", done);
      res.once("close", done);
    };
    // Bun hands back a Response; its body is read from a clone, so the client's copy is untouched.
    const watchResponse = (ctx, res) => {
      // Nothing to read: the request is closed and never written.
      const gone = () => { ctx.ended = Date.now(); ctx.reply = { status: 0, type: "", text: "", cookies: [] }; tied.closed(ctx); };
      if (!(res instanceof Response) || Number(res.headers.get("content-length") || 0) > REPLY_MAX) return gone();
      let copy;
      try { copy = res.clone(); } catch { return gone(); }
      copy.arrayBuffer().then((b) => Buffer.from(b), () => Buffer.alloc(0)).then((buf) => {
        const set = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : res.headers.get("set-cookie");
        tied.replied(ctx, res.status, () => decoded(buf.subarray(0, MAX), res.headers.get("content-encoding")));
        ended(ctx, { status: res.status, type: res.headers.get("content-type"), text: decoded(buf.subarray(0, MAX), res.headers.get("content-encoding")), cookies: cookieNames(set) });
      }).catch(() => { /* the command is gone */ });
    };

    // Inbound: each request is handled inside its own context, and its body is seen as it arrives
    // without reading it, so your own body parser is untouched. A GET is watched but never made the
    // context a model call is pinned by: it can only be the step an answer comes on.
    const emit = http.Server.prototype.emit;
    http.Server.prototype.emit = function (type, req, ...rest) {
      if (type === "listening") { try { listening(this.address()?.port); } catch { /* not a TCP server */ } }
      if (type === "request") { recheckRoutes(); sweepTools(); }
      if (type !== "request" || !req || !req.method || /^(?:HEAD|OPTIONS)$/.test(req.method)) return emit.call(this, type, req, ...rest);
      const { "x-cortad-turn": _turn, ...headers } = req.headers;
      const ctx = requestCtx(req.method, req.url || "/", headers, turnOf(req.headers));
      try { watchReply(ctx, rest[0]); } catch { /* the reply goes on unwatched */ }
      if (req.method === "GET") return emit.call(this, type, req, ...rest);
      const push = req.push;
      req.push = function (chunk, encoding) {
        if (chunk && ctx.size < MAX) { const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding); ctx.chunks.push(b); ctx.size += b.length; }
        return push.call(this, chunk, encoding);
      };
      // A body parser carries on from the stream's own "end" event, and that event fires from the
      // socket's context, not the request's: every Express app lost its request there. Listeners put
      // on this request run inside it, the way OpenTelemetry binds a request's emitter.
      const bound = new WeakMap();
      for (const name of ["on", "addListener", "once", "prependListener", "prependOnceListener"]) {
        const add = req[name];
        req[name] = function (event, fn) {
          if (typeof fn !== "function") return add.call(this, event, fn);
          const inside = bound.get(fn) || function (...a) { return als.run(ctx, () => fn.apply(this, a)); };
          bound.set(fn, inside);
          return add.call(this, event, inside);
        };
      }
      for (const name of ["off", "removeListener"]) {
        const remove = req[name];
        req[name] = function (event, fn) { return remove.call(this, event, (typeof fn === "function" && bound.get(fn)) || fn); };
      }
      return als.run(ctx, () => emit.call(this, type, req, ...rest));
    };

    // Bun serves through Bun.serve, never node:http, so the patch above saw no request at all: an
    // Elysia API on Bun took the customer's messages and nothing was written. Bun.serve is wrapped
    // instead, both the fetch handler and the per-route handlers Bun can dispatch to directly. The body
    // is read from a clone, so the app's own reader is untouched.
    if (isBun) {
      const inside = (handler, self) => function (req, server) {
        recheckRoutes();
        sweepTools();
        if (!req || /^(?:HEAD|OPTIONS)$/.test(req.method)) return handler.call(self, req, server);
        let path = "/";
        try { const u = new URL(req.url); path = u.pathname + u.search; } catch { /* keep "/" */ }
        const ctx = requestCtx(req.method, path, Object.fromEntries([...req.headers].filter(([k]) => k !== "x-cortad-turn")), turnOf(req.headers));
        if (req.method === "GET") {
          const out = handler.call(self, req, server);
          Promise.resolve(out).then((res) => watchResponse(ctx, res), () => watchResponse(ctx, null));
          return out;
        }
        // ponytail: a body is copied only when it is small or says it is text; an upload is left alone.
        const size = Number(req.headers.get("content-length") || 0);
        if (size <= MAX || /json|text|form/i.test(req.headers.get("content-type") || "")) {
          // Read as it arrives, so a model call made while the request is open knows the person's words.
          try { ctx.body = req.clone().arrayBuffer().then((b) => { ctx.bodyText = Buffer.from(b).subarray(0, MAX).toString("utf8"); }, () => { ctx.bodyText = ""; }); } catch { /* unread */ }
        }
        return als.run(ctx, () => {
          const out = handler.call(self, req, server);
          Promise.resolve(out).then((res) => watchResponse(ctx, res), () => {});
          return out;
        });
      };
      const routes = (table) => {
        if (!table || typeof table !== "object") return table;
        const out = {};
        for (const [route, value] of Object.entries(table)) {
          if (typeof value === "function") out[route] = inside(value, table);
          else if (value && typeof value === "object" && !(value instanceof Response)) {
            out[route] = {};
            for (const [verb, fn] of Object.entries(value)) out[route][verb] = typeof fn === "function" ? inside(fn, value) : fn;
          } else out[route] = value;
        }
        return out;
      };
      // Bun's own route table: a handler per path, or a handler per method.
      const bunTable = (table) => Object.entries(table && typeof table === "object" ? table : {}).map(([path, value]) => (
        typeof value === "function" ? { methods: null, path, handler: value }
          : value instanceof Response ? { methods: ["GET"], path, handler: null }
            : { methods: Object.keys(value || {}), path, handler: null }));
      const serve = Bun.serve;
      Bun.serve = function (options, ...rest) {
        let wrapped = options;
        try {
          if (options && typeof options === "object") {
            wrapped = Object.assign(Object.create(Object.getPrototypeOf(options)), options);
            if (typeof options.fetch === "function") wrapped.fetch = inside(options.fetch, options);
            if (options.routes) wrapped.routes = routes(options.routes);
          }
        } catch { wrapped = options; }
        try {
          if (Object.keys(require.cache).some((k) => k.includes("/node_modules/elysia/"))) seen.add("elysia");
          bunRoutes = bunTable(options && options.routes);
        } catch { /* no table */ }
        const server = serve.call(this, wrapped, ...rest);
        try { listening(server && server.port); } catch { /* not ours to fail */ }
        return server;
      };
    }


    // Outbound to a service their own settings name (a vector store, a database API, a search
    // host): which setting, which host and whether it answered. No body, no headers, no query. A
    // run that tested a tutoring app while every lookup failed inside Node never knew; this is
    // the witness that lets the run say retrieval was not tested instead of grading without it.
    let depHosts = null, depSeen = -1;
    const depOf = (input) => {
      try {
        const keys = Object.keys(process.env);
        if (keys.length !== depSeen) {
          depSeen = keys.length; depHosts = new Map();
          for (const k of keys) {
            const v = process.env[k];
            if (!v || !/^https?:\/\//i.test(v) || /(^|_)(KEY|TOKEN|SECRET|PASSWORD)$/i.test(k)) continue;
            try { depHosts.set(new URL(v).host.replace(/:443$/, ""), k); } catch { /* not a URL */ }
          }
        }
        const u = new URL(typeof input === "string" ? input : input && input.url ? input.url : String(input));
        const name = depHosts.get(u.host.replace(/:443$/, "")) || depHosts.get(u.hostname);
        return name ? { env: name, host: u.hostname } : null;
      } catch { return null; }
    };
    // A retrieval says so, with the app's line that asked, so one that came back empty has an address.
    const depRow = (dep, status, { code, passages, ctx, retrieval, caller } = {}) => {
      const turn = ctx && ctx.turn;
      row({ dep: { at: Date.now(), ...(dep.env ? { env: dep.env } : {}), host: dep.host, status, code: code ? String(code).slice(0, 40) : undefined, ...(ctx ? { ex: ctx.id } : {}), ...(turn ? { turn } : {}), ...(retrieval ? { retrieval: true } : {}), ...(caller ? { caller } : {}), ...(passages ? { passages } : {}) } });
    };

    // The app's own functions the read names as its tools. An app whose code picks the tool itself
    // (a classifier answers {"intent":"order"} and the code calls queryOrder) never names one on the
    // wire, so the function is wrapped where it is defined: each call writes its name, its clipped
    // arguments and what it returned, on the turn it ran in. The run writes the list beside the rules
    // and the command keeps the last one, so an app started again has it before its code loads.
    const TOOLS_FILE = process.env.CORTAD_TOOLS_FILE;
    const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
    const IDENT = /^[A-Za-z_$][\w$]*$/;
    let targets = [], targetsAt = -1;
    const targetsNow = () => {
      if (!TOOLS_FILE) return targets;
      try {
        const at = fs.statSync(TOOLS_FILE).mtimeMs;
        if (at !== targetsAt) {
          targetsAt = at;
          const raw = JSON.parse(fs.readFileSync(TOOLS_FILE, "utf8"));
          targets = list(raw).filter((t) => typeof t.name === "string" && t.name && typeof t.file === "string" && CODE_FILE.test(t.file) && IDENT.test(String(t.function)) && !(t.function in globalThis))
            .map((t) => ({ name: t.name.slice(0, 80), file: t.file.replace(/^\.?\/+/, ""), fn: t.function }))
            // One function named twice (by its own name, and as "queryOrder (fallback)" where a
            // router imported it) is recorded under its own name.
            .sort((a, b) => (a.name !== a.fn) - (b.name !== b.fn));
        }
      } catch { /* not written yet */ }
      return targets;
    };
    const targetsIn = (path) => targetsNow().filter((t) => path === t.file || path.endsWith("/" + t.file));
    const unsaid = new Set();
    // Which tools this start of the app wrapped and which it could not, written as one row the
    // command hands the run (lib/replay.mjs): a tool whose function is not wrapped, and that no model
    // call named, is one whose calls were not seen, never one that did not run.
    const wrappedTools = new Set(), unwatchedTools = new Set();
    let toldTools = "[[],[]]";
    const tellTools = () => {
      const wrapped = [...wrappedTools].sort(), notWrapped = [...unwatchedTools].filter((n) => !wrappedTools.has(n)).sort();
      const said = JSON.stringify([wrapped, notWrapped]);
      if (said !== toldTools) { toldTools = said; row({ tools: { wrapped, unwatched: notWrapped } }); }
    };
    const unwatched = (t, why) => {
      unwatchedTools.add(t.name);
      const key = `${t.file}#${t.fn}`;
      if (unsaid.has(key)) return;
      unsaid.add(key);
      try { process.stderr.write(`cortad: calls to ${t.name} in ${t.file} are not recorded: ${why}.\n`); } catch { /* no stderr */ }
    };
    // What a value is, as JSON can say it: a class instance (a client, a model) by its name only.
    const plainOf = (v, depth = 0) => {
      if (v === null || ["string", "number", "boolean"].includes(typeof v)) return v;
      if (typeof v === "bigint") return String(v);
      if (typeof v !== "object" || depth > 4) return v === undefined ? null : `[${typeof v}]`;
      if (Array.isArray(v)) return v.slice(0, 20).map((x) => plainOf(x, depth + 1));
      if (typeof v.toJSON === "function") { try { return plainOf(v.toJSON(), depth + 1); } catch { return "[object]"; } }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return `[${(v.constructor && v.constructor.name) || "object"}]`;
      return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, plainOf(x, depth + 1)]));
    };
    // The returned value's shape and a clipped text: a string as it is, anything else named by kind.
    const returned = (v) => {
      if (v === undefined || v === null) return "returned nothing";
      if (typeof v === "string") return v;
      const p = clipped(plainOf(v), 0, TOOL_TEXT);
      const kind = Array.isArray(v) ? `list of ${v.length}` : typeof v === "object" ? "object" : "value";
      return `${kind}: ${JSON.stringify(p)}`;
    };
    const paramNames = (fn) => {
      let src = "";
      try { src = Function.prototype.toString.call(fn); } catch { return []; }
      const m = /^[^(=]*\(([^)]*)\)/.exec(src) || /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(src);
      if (!m || /[{[(]/.test(m[1])) return [];
      return m[1].split(",").map((p) => p.replace(/=[\s\S]*$/, "").replace(/^\s*\.\.\./, "").replace(/:[\s\S]*$/, "").trim());
    };
    const toolRow = (name, names, args, value, error, ctx) => {
      const turn = ctx && ctx.turn;
      const named = {};
      args.forEach((a, i) => { named[IDENT.test(names[i] || "") ? names[i] : String(i)] = plainOf(a); });
      let text;
      try { text = error ? `raised ${(error && error.name) || "an error"}: ${(error && error.message) || String(error)}` : returned(value); } catch { text = "returned a value this hook cannot read"; }
      row({ dep: { at: Date.now(), host: "in-app", status: 200, ...(ctx ? { ex: ctx.id } : {}), ...(turn ? { turn } : {}), called: [{ name, arguments: argsText(named) }], tools: [toolText(name, String(text))] } });
    };
    const TOOL = Symbol.for("cortad.wrapped");
    const wrappers = new WeakMap();
    const wrapTool = (fn, name) => {
      if (typeof fn !== "function" || fn[TOOL]) return fn;
      if (wrappers.has(fn)) return wrappers.get(fn);
      try { if (/^class\b/.test(Function.prototype.toString.call(fn))) return fn; } catch { return fn; }
      const names = paramNames(fn);
      const w = function (...args) {
        const ctx = als.getStore();
        let out;
        try { out = new.target ? Reflect.construct(fn, args, new.target) : fn.apply(this, args); }
        catch (e) { toolRow(name, names, args, undefined, e, ctx); throw e; }
        // A promise is followed, and the one handed back is a new one, so a rejection nobody
        // handles still reaches the app as unhandled.
        if (out instanceof Promise) return out.then((v) => { toolRow(name, names, args, v, undefined, ctx); return v; }, (e) => { toolRow(name, names, args, undefined, e, ctx); throw e; });
        toolRow(name, names, args, out, undefined, ctx);
        return out;
      };
      try {
        Object.defineProperty(w, "name", { value: fn.name });
        Object.defineProperty(w, "length", { value: fn.length });
        Object.setPrototypeOf(w, Object.getPrototypeOf(fn));
        if (fn.prototype) w.prototype = fn.prototype;
        for (const k of Object.keys(fn)) w[k] = fn[k];
      } catch { /* the wrapper still calls through */ }
      w[TOOL] = fn;
      wrappers.set(fn, w);
      return w;
    };
    // Called from the lines added to the end of a tool's file: the function by its own binding
    // (an ES module's importers follow that binding) and by its CommonJS export.
    const take = (fn, set, mod, t) => {
      let done = false;
      if (typeof fn === "function") { try { set(wrapTool(fn, t.name)); done = true; } catch { /* a binding that cannot change */ } }
      const ex = mod && mod.exports;
      if (ex && (typeof ex === "object" || typeof ex === "function") && typeof ex[t.fn] === "function") { try { ex[t.fn] = wrapTool(ex[t.fn], t.name); done = true; } catch { /* read-only */ } }
      if (done) wrappedTools.add(t.name);
      else unwatched(t, fn === undefined && !(ex && t.fn in ex) ? `the file has no function named ${t.fn}` : `${t.fn} there is not a function this hook can wrap`);
    };
    Object.defineProperty(globalThis, Symbol.for("cortad.tool"), { value: take, configurable: true });
    const HOOK = 'globalThis[Symbol.for("cortad.tool")]';
    // tsx compiles each CommonJS file into a function (`__filename="...";(()=>{` up to `})()`), so the
    // lines go inside it, where the file's own bindings are.
    const TSX_HEAD = /^__filename=[^\n]*?;\(\(\)=>\{/;
    const TSX_FOOT = /\n\}\)\(\)(?=\s*(?:\/\/# sourceMappingURL=\S*\s*)?$)/;
    const trailer = (text, mine) => {
      let src = text;
      // A const binding cannot be changed from inside the file; a let can, and nothing else differs.
      // A compiler's output can hold it mid-line, after another statement.
      for (const t of mine) src = src.replace(new RegExp(`(^|[\\n;{}])([ \\t]*(?:export[ \\t]+)?)const([ \\t]+${t.fn.replace(/\$/g, "\\$")}[ \\t]*[=:])`), "$1$2let$3");
      const lines = `\n;${mine.map((t) => `try{${HOOK}(typeof ${t.fn}==="undefined"?undefined:${t.fn},(f)=>{${t.fn}=f},typeof module==="object"&&module?module:undefined,${JSON.stringify(t)})}catch{}`).join("")}\n`;
      const end = TSX_HEAD.test(src) ? src.search(TSX_FOOT) : -1;
      return end < 0 ? src + lines : src.slice(0, end) + lines + src.slice(end);
    };
    // Loading: a tool's file gets the lines above before it runs. Every other file is untouched.
    // CommonJS gets them where Node compiles it, which is where tsx, ts-node and babel hand Node the
    // JavaScript they made of a file they read themselves, past any load hook; an ES module gets them
    // in the load hook. `loadedFiles`: every file that passed either place, so a file that passed
    // before the list named it is told from one a loader compiled out of this hook's sight.
    const seenFiles = new Set();
    const loadedFiles = new Set();
    const withTools = (path, source) => {
      loadedFiles.add(path);
      const mine = targetsIn(path);
      if (!mine.length) return null;
      const text = typeof source === "string" ? source : Buffer.from(source).toString("utf8");
      if (text.includes(HOOK)) return null;
      seenFiles.add(path);
      return trailer(text, mine);
    };
    const { fileURLToPath } = require("node:url");
    const compile = TOOLS_FILE && Module.prototype && Module.prototype._compile;
    if (typeof compile === "function") {
      Module.prototype._compile = function (content, filename, ...rest) {
        let source = content;
        try { if (typeof content === "string" && typeof filename === "string" && !filename.includes("/node_modules/")) source = withTools(filename, content) ?? content; } catch { source = content; }
        return compile.call(this, source, filename, ...rest);
      };
    }
    // Node 22 cannot run a sync load hook beside a loader's async one (tsx's `--import`): every ES
    // module load throws "loadSync is not a function" and the app dies at start. Node 26 can. There,
    // an ES module's tools go unwrapped and the sweep below says so in the app's log.
    // ponytail: measured on 22 (fails) and 26 (works) only; 23 to 25 are treated as 22.
    const asyncLoader = [...process.execArgv, ...(process.env.NODE_OPTIONS || "").split(/\s+/)].some((a) => /^--(?:import|(?:experimental-)?loader)\b/.test(a));
    const mixes = Number(process.versions.node.split(".")[0]) >= 26;
    if (TOOLS_FILE && typeof Module.registerHooks === "function" && (mixes || !asyncLoader)) {
      try {
        Module.registerHooks({
          load(url, context, nextLoad) {
            const out = nextLoad(url, context);
            try {
              if (typeof url !== "string" || !url.startsWith("file:") || url.includes("/node_modules/") || out.source == null) return out;
              if (out.format !== "module" && out.format !== "module-typescript") return out;
              const source = withTools(fileURLToPath(url), out.source);
              return source === null ? out : { ...out, source };
            } catch { return out; }
          },
        });
      } catch { /* this runtime has no module hooks */ }
    }
    // A list that arrives after the app loaded its tools: a CommonJS export is wrapped in place, which
    // reaches code that calls it through the module, but a function already taken by name cannot be
    // reached, so it is said once in the app's log, with what kept the lines out of its file.
    let sweptAt = -1;
    const sweepTools = () => {
      if (!TOOLS_FILE) return;
      const now = targetsNow();
      if (targetsAt !== sweptAt) {
        sweptAt = targetsAt;
        const cache = require.cache || {};
        for (const t of now) {
          const mine = (k) => (k === t.file || k.endsWith("/" + t.file)) && !k.includes("/node_modules/");
          const path = Object.keys(cache).find(mine) || [...loadedFiles].find(mine);
          if (!path || seenFiles.has(path)) continue;
          const ex = cache[path] && cache[path].exports;
          if (ex && typeof ex[t.fn] === "function") { try { ex[t.fn] = wrapTool(ex[t.fn], t.name); } catch { /* read-only */ } }
          unwatched(t, loadedFiles.has(path) ? "the file was loaded before Cortad's list of tools named it" : "the file was loaded by a loader this hook cannot add to");
        }
      }
      tellTools();
    };

    // A fetched body read to its end, or to where it broke off. Aborting the call (the client that
    // asked went away, or the framework ended the request once its own reply was sent) errors this
    // copy too, and what the model had said by then is still what it said.
    const readAll = async (res) => {
      const parts = [];
      let size = 0;
      try {
        const reader = res.body && res.body.getReader();
        for (let r = reader && await reader.read(); r && !r.done; r = await reader.read()) {
          if (size < REPLY_MAX) { parts.push(Buffer.from(r.value)); size += r.value.length; }
        }
      } catch { /* broken off: what arrived stands */ }
      return Buffer.concat(parts).toString("utf8");
    };

    // Every server the app opens a connection to, once each, by host and port only: a database named
    // in a config file rather than in the environment is seen the first time the app reaches it.
    // HTTP clients connect through here too; the command names only the ports stores listen on.
    const net = require("node:net");
    const connected = new Set();
    const socketConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...args) {
      try {
        const first = Array.isArray(args[0]) ? args[0][0] : args[0];
        const o = first && typeof first === "object" ? first : { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
        const port = Number(o.port);
        if (!o.path && Number.isInteger(port) && port > 0 && port !== heldPort && connected.size < 64) {
          const host = String(o.host || "localhost").toLowerCase().slice(0, 253);
          if (!connected.has(`${host}:${port}`)) { connected.add(`${host}:${port}`); row({ conn: { host, port } }); }
        }
      } catch { /* the connection goes on unrecorded */ }
      return socketConnect.apply(this, args);
    };

    // Outbound: the model call your app makes while it handles that request.
    const bodyText = (body) => (typeof body === "string" ? body : Buffer.isBuffer(body) ? body.toString("utf8") : body instanceof Uint8Array ? Buffer.from(body).toString("utf8") : "");
    if (typeof globalThis.fetch === "function") {
      const realFetch = globalThis.fetch;
      globalThis.fetch = function (input, init) {
        let url = null;
        try {
          const u = new URL(typeof input === "string" ? input : input && input.url ? input.url : String(input));
          if (isModelCall(u.host, u.pathname)) url = u;
        } catch { /* not a URL we can read */ }
        if (!url) {
          // Every outbound host, named by the setting that points at it when one does, and by the
          // host alone otherwise: the search provider behind TAVILY_API_KEY has no URL setting.
          let dep = depOf(input);
          let retrieval = false;
          try {
            const u = new URL(typeof input === "string" ? input : input && input.url ? input.url : String(input));
            // A store on this machine (a local Qdrant or Chroma) is still where the passages came from.
            retrieval = /^https?:$/.test(u.protocol) && isRetrieval(u);
            if (!dep && /^https?:$/.test(u.protocol) && (retrieval || !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))) dep = { host: u.hostname };
          } catch { /* not a URL */ }
          if (!dep) return realFetch.apply(this, arguments);
          const asked = { ctx: als.getStore(), retrieval, caller: retrieval ? callers() : undefined };
          return realFetch.apply(this, arguments).then(
            (res) => {
              if (!retrieval) { depRow(dep, res.status, asked); return res; }
              try { res.clone().text().then((t) => depRow(dep, res.status, { ...asked, passages: passagesFrom(t) }), () => depRow(dep, res.status, asked)); } catch { depRow(dep, res.status, asked); }
              return res;
            },
            (err) => { depRow(dep, 0, { ...asked, code: err && err.cause && err.cause.code }); throw err; },
          );
        }
        let named = null;
        try { const headers = new Headers((init && init.headers) || (input && input.headers) || undefined); named = GATEWAY_MODEL.map((h) => headers.get(h)).find(Boolean); } catch { /* headers we cannot read name no model */ }
        const sent = asChat(bodyText(init && init.body), named);
        const ctx = note(als.getStore(), sent);
        const call = { host: url.host, path: url.pathname, sent, ctx, t0: Date.now(), caller: EMBEDDING.test(url.pathname) ? undefined : callers() };
        return realFetch.apply(this, arguments).then((res) => {
          if (ctx) ctx.heard = true;
          try {
            // A clone is a tee: your app's branch gets every byte as fast as it reads, this one is read to the end.
            const type = res.headers.get("content-type");
            readAll(res.clone()).then((text) => meter({ ...call, status: res.status, type, body: text }));
          } catch { meter({ ...call, status: res.status, type: "", body: "" }); }
          return res;
        }, (err) => { meter({ ...call, status: 0, type: "", body: "" }); throw err; });
      };
    }
    for (const mod of [http, https]) {
      const request = mod.request;
      mod.request = function (...args) {
        const req = request.apply(this, args);
        try {
          const o = typeof args[0] === "string" || args[0] instanceof URL ? new URL(String(args[0])) : args[0] || {};
          const host = o.host || o.hostname;
          const path = o.pathname ? o.pathname : o.path;
          if (isModelCall(host, path)) {
            const ctx = als.getStore();
            const parts = [];
            let sent = "";
            const write = req.write;
            const end = req.end;
            req.write = function (chunk, ...r) { if (chunk && typeof chunk !== "function") parts.push(Buffer.from(chunk)); return write.call(this, chunk, ...r); };
            req.end = function (chunk, ...r) { if (chunk && typeof chunk !== "function") parts.push(Buffer.from(chunk)); sent = asChat(Buffer.concat(parts).toString("utf8"), GATEWAY_MODEL.map((h) => req.getHeader && req.getHeader(h)).find(Boolean)); call.ctx = note(ctx, sent); return end.call(this, chunk, ...r); };
            const bare = String(path || "").split("?")[0];
            const call = { host: String(host || ""), path: bare, ctx, t0: Date.now(), caller: EMBEDDING.test(bare) ? undefined : callers() };
            let done = false;
            const once = (row) => { if (!done) { done = true; meter({ ...call, sent, ...row }); } };
            req.once("error", () => once({ status: 0, type: "", body: "" }));
            req.once("response", (res) => {
              if (call.ctx) call.ctx.heard = true;
              // The reply's bytes as the parser hands them over, without reading the stream: your
              // app's own listeners and pipes see exactly what they would have.
              const got = [];
              let size = 0;
              const push = res.push;
              res.push = function (chunk, encoding) {
                if (chunk && size < REPLY_MAX) { const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding); got.push(b); size += b.length; }
                return push.call(this, chunk, encoding);
              };
              const finish = () => once({ status: res.statusCode || 0, type: res.headers["content-type"] || "", body: decoded(Buffer.concat(got), res.headers["content-encoding"]) });
              res.once("end", finish);
              res.once("close", finish);
            });
          }
        } catch { /* leave the request alone */ }
        return req;
      };
    }
  } catch { /* an app must never fail to start because of this file */ }
}
