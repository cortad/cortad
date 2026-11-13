// A request to a gRPC door, sent the way the app's own clients send one: with the app's own
// @grpc/grpc-js and @grpc/proto-loader (never a copy of ours), the service and its messages read from
// the .proto files in the folder, and the JSON body of a run's turn as the request message. The reply
// comes back as JSON text, a stream as one JSON line per message, so the command, the hook and the
// judges read it like any other door's. Metadata carries what headers would: the turn, a sign-in.
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";

const SKIP = /^(node_modules|\.git|dist|build|out|coverage|vendor|venv|\.venv|target|tmp|\.next|\.cache)$/i;
const PROTOS_MAX = 400;

export function protoFiles(root, dir = root, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= PROTOS_MAX) break;
    if (e.isDirectory()) { if (!SKIP.test(e.name)) protoFiles(root, join(dir, e.name), out); }
    else if (e.isFile() && e.name.endsWith(".proto")) out.push(join(dir, e.name));
  }
  return out;
}

// The app's own gRPC libraries, resolved from the folder the app runs in.
export function grpcOf(appDir) {
  const need = createRequire(join(appDir, "package.json"));
  try { return { grpc: need("@grpc/grpc-js"), loader: need("@grpc/proto-loader") }; } catch { return null; }
}

// "/pkg.Service/Method" -> the client class and the method name, from the loaded definitions.
export function serviceAt(grpc, definition, path) {
  const m = /^\/(?:([\w.]+)\.)?(\w+)\/(\w+)$/.exec(path);
  if (!m) return null;
  const [, pkg, service, method] = m;
  const loaded = grpc.loadPackageDefinition(definition);
  const scope = (pkg ? pkg.split(".") : []).reduce((o, k) => (o && o[k]) || null, loaded);
  const Client = scope && scope[service];
  if (typeof Client !== "function") return null;
  const def = Client.service && Client.service[method];
  return def ? { Client, method, def } : null;
}

// One call. `send`: { path, body, headers, port, appDir, root, timeoutMs }. Resolves to
// { status, type, text } like a fetch the command made: 200 with the reply, 500 with the error.
export async function grpcCall({ path, body, headers = {}, port, appDir, root, timeoutMs = 55_000 }) {
  const libs = grpcOf(appDir);
  if (!libs) return { status: 500, type: "application/json", text: JSON.stringify({ error: "this app's own @grpc/grpc-js and @grpc/proto-loader are needed to call its gRPC services, and neither resolves from its folder" }) };
  const files = protoFiles(root);
  if (!files.length) return { status: 500, type: "application/json", text: JSON.stringify({ error: "no .proto file in this folder names the service" }) };
  const includeDirs = [...new Set(files.map((f) => dirname(f)))].concat(root);
  let definition;
  try { definition = libs.loader.loadSync(files, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true, includeDirs }); }
  catch (e) { return { status: 500, type: "application/json", text: JSON.stringify({ error: `the .proto files did not load: ${String(e.message || e).slice(0, 300)}` }) }; }
  const at = serviceAt(libs.grpc, definition, path);
  if (!at) return { status: 500, type: "application/json", text: JSON.stringify({ error: `no service in the .proto files serves ${path}` }) };
  const client = new at.Client(`127.0.0.1:${port}`, libs.grpc.credentials.createInsecure());
  const metadata = new libs.grpc.Metadata();
  for (const [k, v] of Object.entries(headers)) { try { metadata.set(String(k).toLowerCase(), String(v)); } catch { /* a name metadata refuses */ } }
  const request = body && typeof body === "object" ? body : typeof body === "string" && body.trim().startsWith("{") ? JSON.parse(body) : {};
  const deadline = Date.now() + timeoutMs;
  try {
    if (at.def.requestStream) return { status: 500, type: "application/json", text: JSON.stringify({ error: "a client-streaming rpc takes no single message; simulations do not play it" }) };
    if (at.def.responseStream) {
      const text = await new Promise((resolve, reject) => {
        const parts = [];
        const call = client[at.method](request, metadata, { deadline });
        call.on("data", (m) => { if (parts.length < 1000) parts.push(JSON.stringify(m)); });
        call.on("error", reject);
        call.on("end", () => resolve(parts.join("\n")));
      });
      return { status: 200, type: "application/grpc+json-stream", text };
    }
    const reply = await new Promise((resolve, reject) => client[at.method](request, metadata, { deadline }, (err, res) => (err ? reject(err) : resolve(res))));
    return { status: 200, type: "application/grpc+json", text: JSON.stringify(reply === undefined ? null : reply) };
  } catch (e) {
    const code = Number(e && e.code);
    // gRPC's own codes, said as the statuses the rest of the command knows: UNAUTHENTICATED 16 and
    // PERMISSION_DENIED 7 are a sign-in, INVALID_ARGUMENT 3 a body, UNIMPLEMENTED 12 a door that is not there.
    const status = code === 16 ? 401 : code === 7 ? 403 : code === 3 ? 400 : code === 12 || code === 5 ? 404 : code === 4 ? 504 : code === 14 ? 503 : 500;
    return { status, type: "application/json", text: JSON.stringify({ error: String((e && e.details) || (e && e.message) || e).slice(0, 500), code }) };
  } finally {
    try { client.close(); } catch { /* closed */ }
  }
}
