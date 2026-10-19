import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer as createNetServer } from "node:net";

// A free port for each server these tests start, picked when the file loads: a fixed one collided
// with a dev server another session left on 4331.
const freePort = () => new Promise((resolve) => { const srv = createNetServer().listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); }); });
const P4321 = await freePort();
// Set in the app file itself (.scratch/py-app), so it stays as that file names it.
const P4322 = 4322;
const P4325 = await freePort();
const P4331 = await freePort();
const P4332 = await freePort();
const P4333 = await freePort();
const P4334 = await freePort();
// Set in the app file itself (.scratch/py-app), so it stays as that file names it.
const P4335 = 4335;
const P4336 = await freePort();
const P4337 = await freePort();
const P4338 = await freePort();
const P4339 = await freePort();

const APP = new URL("../.scratch/py-app/", import.meta.url).pathname;
const PY = join(APP, ".venv/bin/python");
const HOOK = new URL("./pyhook/", import.meta.url).pathname;
const up = async (port) => { for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${port}/nothing`); return true; } catch { await new Promise((r) => setTimeout(r, 250)); } } return false; };
const rowsOf = (file) => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

// Real FastAPI under uvicorn with the OpenAI SDK, and real Flask with requests: the two stacks most
// Python AI backends are one of. Skipped where the scratch virtualenv has not been made.
const skip = !existsSync(PY);

test("FastAPI: the request that called a model is written down, with body, sign-in and what the app answered", { skip }, async () => {
  const file = join(mkdtempSync(join(tmpdir(), "pyhook-")), "trace.jsonl");
  const child = spawn(PY, ["-m", "uvicorn", "fast_app:app", "--port", String(P4321)], { cwd: APP, env: { ...process.env, PYTHONPATH: HOOK, CORTAD_TRACE_FILE: file }, stdio: "ignore" });
  try {
    assert.ok(await up(P4321), "the app starts with the hook loaded");
    const post = (path, body, headers = {}) => fetch(`http://127.0.0.1:${P4321}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    assert.equal((await post("/v2/save", { prompt: "not a chat" })).status, 200);
    const mine = await post("/v2/assist", { prompt: "hello from python", thread: 3 }, { "x-session": "py-session-only-they-have" });
    assert.equal(mine.status, 200);
    assert.match((await mine.json()).answer, /hello from python/, "the app still read its own body");
    await new Promise((r) => setTimeout(r, 300));
    const lines = rowsOf(file);
    assert.equal(lines[0].hello, "python");
    const rows = lines.filter((l) => !l.hello && !l.call && !l.listen && !l.routes && !l.conn && !l.receipt);
    assert.equal(rows.length, 1);
    assert.equal(`${rows[0].method} ${rows[0].path}`, "POST /v2/assist");
    assert.deepEqual(JSON.parse(rows[0].body), { prompt: "hello from python", thread: 3 });
    assert.equal(rows[0].headers["x-session"], "py-session-only-they-have");
    assert.match(rows[0].sent[0], /hello from python/);
    assert.equal(rows[0].status, 200);
    assert.match(JSON.parse(rows[0].reply).answer, /You asked: hello from python/, "what the app answered, as it answered it");
  } finally { child.kill("SIGKILL"); }
});

test("Flask: the same, through werkzeug and requests", { skip }, async () => {
  const file = join(mkdtempSync(join(tmpdir(), "pyhook-")), "trace.jsonl");
  const child = spawn(PY, ["flask_app.py"], { cwd: APP, env: { ...process.env, PYTHONPATH: HOOK, CORTAD_TRACE_FILE: file }, stdio: "ignore" });
  try {
    assert.ok(await up(P4322));
    const mine = await fetch(`http://127.0.0.1:${P4322}/helper/reply`, { method: "POST", headers: { "content-type": "application/json", cookie: "sid=flask-cookie" }, body: JSON.stringify({ text: "hello from flask" }) });
    assert.equal(mine.status, 200);
    await new Promise((r) => setTimeout(r, 300));
    const rows = rowsOf(file).filter((l) => !l.hello && !l.call && !l.listen && !l.routes && !l.conn && !l.receipt);
    assert.equal(rows.length, 1);
    assert.equal(`${rows[0].method} ${rows[0].path}`, "POST /helper/reply");
    assert.equal(rows[0].headers.cookie, "sid=flask-cookie");
    assert.deepEqual(JSON.parse(rows[0].body), { text: "hello from flask" }, "the body werkzeug read, through readinto as Werkzeug 3 reads it");
    assert.match(rows[0].sent[0], /hello from flask/);
    assert.equal(rows[0].status, 200);
  } finally { child.kill("SIGKILL"); }
});

test("every model call through the OpenAI SDK is metered, streamed or not", { skip }, async () => {
  const file = join(mkdtempSync(join(tmpdir(), "pyhook-")), "trace.jsonl");
  const out = await new Promise((done) => {
    const child = spawn(PY, ["meter_app.py"], { cwd: APP, env: { ...process.env, PYTHONPATH: HOOK, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
    let said = ""; child.stdout.on("data", (d) => { said += d; }); child.on("close", () => done(said));
  });
  assert.match(out, /DONE/);
  const calls = Object.fromEntries(rowsOf(file).filter((l) => l.call).map((l) => [l.call.model, l.call]));
  assert.deepEqual([calls["py-json-model"]?.promptTokens, calls["py-json-model"]?.completionTokens, calls["py-json-model"]?.usage], [9, 2, true]);
  assert.deepEqual([calls["py-stream-model"]?.status, calls["py-stream-model"]?.usage], [200, false], "a stream with no counts is a call whose counts were not read");
  assert.deepEqual([calls["py-async-model"]?.promptTokens, calls["py-async-model"]?.usage], [9, true], "an async stream is read to its last chunk");
});

// The same two facts from the Python hook: the turn tag on the call row, and the rule ids the prompt
// carried, read through the SDK's ASCII-escaped JSON.
test("FastAPI: a model call carries its turn and the rule ids its prompt held", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pyhook-"));
  const file = join(dir, "trace.jsonl");
  const rulesFile = join(dir, "rules.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(rulesFile, JSON.stringify([
    { id: "rule:aaaaaaaaaa", text: "始终只使用手机号后四位定位用户" },
    { id: "rule:bbbbbbbbbb", text: "Answer in {language} and nothing else, ever." },
    { id: "rule:cccccccccc", text: "This sentence is not in any prompt." },
  ]));
  const child = spawn(PY, ["-m", "uvicorn", "fast_app:app", "--port", String(P4325)], { cwd: APP, env: { ...process.env, PYTHONPATH: HOOK, CORTAD_TRACE_FILE: file, CORTAD_RULES_FILE: rulesFile }, stdio: "ignore" });
  try {
    assert.ok(await up(P4325));
    const prompt = "Rules:\n始终只使用手机号后四位定位用户\nAnswer in Chinese and nothing else, ever.";
    const res = await fetch(`http://127.0.0.1:${P4325}/v2/assist`, { method: "POST", headers: { "content-type": "application/json", "x-session": "py-session-only-they-have", "x-cortad-turn": "case_3:1" }, body: JSON.stringify({ prompt, thread: 1 }) });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 400));
    const lines = rowsOf(file);
    const call = lines.find((l) => l.call)?.call;
    assert.equal(call?.turn, "case_3:1");
    assert.deepEqual(call?.rules, ["rule:aaaaaaaaaa", "rule:bbbbbbbbbb"]);
    const door = lines.find((l) => l.path === "/v2/assist");
    assert.equal(door?.headers["x-cortad-turn"], undefined);
  } finally { child.kill("SIGKILL"); }
});

// One turn through the OpenAI SDK (a chat stream and a responses call), a raw Anthropic stream over
// httpx and a vector store over requests, inside a FastAPI handler: the tools the model asked for,
// this turn's tool answers, the passages the prompt labels as retrieved, and what the store answered.
const FIXTURE = new URL("./hook-fixture.json", import.meta.url).pathname;
const TURN_APP = `
import asyncio, json, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import httpx, requests
from fastapi import FastAPI
from openai import AsyncOpenAI

fx = json.load(open(${JSON.stringify(FIXTURE)}))
written = ["reactCrew", "reactLangchain", "xmlTag", "jsonText", "reactProse"]
styles = [fx["chat"], fx["chatJson"], fx["responses"], fx["responsesStream"], fx["anthropic"], fx["store"], fx["ragBlock"], fx["ragCode"], fx["records"]] + [fx[w] for w in written]

class Provider(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length") or 0))
        s = next(x for x in styles if self.path == x["path"])
        raw = s["reply"].encode()
        self.send_response(200)
        self.send_header("content-type", s["type"])
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def log_message(self, *a):
        pass

server = HTTPServer(("127.0.0.1", 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % server.server_port
client = AsyncOpenAI(api_key="k", base_url=base + "/v1", max_retries=0)
app = FastAPI()

@app.post("/talk")
async def talk():
    chat = dict(fx["chat"]["sent"]); chat.pop("stream")
    async for _ in await client.chat.completions.create(stream=True, **chat):
        pass
    await client.responses.create(**fx["responses"]["sent"])
    async with httpx.AsyncClient() as h:
        # Steps run as tasks of their own, the way LangChain runs a chain's steps and a model's batch.
        await asyncio.create_task(h.post(base + fx["chatJson"]["path"], json=fx["chatJson"]["sent"]))
        for style in ["responsesStream", "anthropic", "ragCode"] + written:
            async with h.stream("POST", base + fx[style]["path"], json=fx[style]["sent"]) as r:
                async for _ in r.aiter_bytes():
                    pass
        await asyncio.gather(h.post(base + fx["ragBlock"]["path"], json=fx["ragBlock"]["sent"]))
        # A prompt past 64 KB, as an app's list of tools makes it, is still read whole.
        tools = [{"type": "function", "function": {"name": "tool_%d" % i, "description": "x" * 400, "parameters": {"type": "object"}}} for i in range(200)]
        await h.post(base + fx["records"]["path"], json=dict(fx["records"]["sent"], tools=tools))
    requests.post(base + fx["store"]["path"], json={"vector": [0.1]})
    return {"ok": True}
`;
test("FastAPI: a model call carries the tools it asked for, the passages its prompt was handed and the line of the app that made it", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pyhook-"));
  const file = join(dir, "trace.jsonl");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "turn_app.py"), TURN_APP);
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const child = spawn(PY, ["-m", "uvicorn", "turn_app:app", "--port", String(P4331)], { cwd: dir, env: { ...process.env, PYTHONPATH: HOOK, CORTAD_TRACE_FILE: file }, stdio: "ignore" });
  try {
    assert.ok(await up(P4331));
    const res = await fetch(`http://127.0.0.1:${P4331}/talk`, { method: "POST", headers: { "x-cortad-turn": fx.turn } });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 400));
  } finally { child.kill("SIGKILL"); }
  const rows = rowsOf(file);
  const calls = Object.fromEntries(rows.filter((l) => l.call).map((l) => [l.call.model, l.call]));
  for (const style of ["chat", "chatJson", "responses", "responsesStream", "anthropic", "reactCrew", "reactLangchain", "xmlTag", "jsonText", "reactProse", "ragBlock", "ragCode", "records"]) {
    const call = calls[fx[style].sent.model];
    assert.equal(call?.turn, fx.turn, style);
    assert.deepEqual(call.called, fx[style].called, `${style}: the tools it asked for`);
    assert.deepEqual(call.passages, fx[style].passages, `${style}: the passages it was handed`);
  }
  for (const call of Object.values(calls)) assert.match(call.caller?.[0] ?? "", /^turn_app\.py:\d+$/, `${call.model}: the line of the app that made the call`);
  const lineOf = (text) => TURN_APP.split("\n").findIndex((l) => l.includes(text)) + 1;
  assert.deepEqual(calls["chat-json"].caller, [`turn_app.py:${lineOf("asyncio.create_task(h.post")}`], "a call made in a task of its own is placed at the line that awaits it");
  assert.deepEqual(calls["rag-block"].caller, [`turn_app.py:${lineOf("asyncio.gather(h.post")}`], "and one made in a gathered task");
  assert.deepEqual(calls["chat-stream"].tools, fx.chat.tools, "this turn's tool answer, and not an earlier turn's");
  assert.deepEqual(calls["responses-json"].tools, fx.responses.tools);
  for (const style of ["reactCrew", "reactLangchain", "xmlTag"]) assert.deepEqual(calls[fx[style].sent.model].tools, fx[style].tools, `${style}: what the tool answered, named`);
  assert.ok(!/abc123|sk-livekey|hunter2/.test(readFileSync(file, "utf8")), "a secret argument is never written");
  const store = rows.find((l) => l.dep && l.dep.passages)?.dep;
  assert.deepEqual([store?.turn, store?.passages], [fx.turn, fx.store.passages], "what the store answered, pinned to the turn");
});

// The same two styles the Node hook reads: a provider's tools and the error it met, off the recorded
// stream, and a call its schema refuses.
const PROVIDER_APP = `
import json, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import httpx
from fastapi import FastAPI

fx = json.load(open(${JSON.stringify(FIXTURE)}))
styles = [fx["providerTools"], fx["refusedArgs"]]

class Provider(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length") or 0))
        s = next(x for x in styles if self.path == x["path"])
        raw = s["reply"].encode()
        self.send_response(200)
        self.send_header("content-type", s["type"])
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def log_message(self, *a):
        pass

server = HTTPServer(("127.0.0.1", 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % server.server_port
app = FastAPI()

@app.post("/talk")
async def talk():
    async with httpx.AsyncClient() as h:
        for s in styles:
            async with h.stream("POST", base + s["path"], json=s["sent"]) as r:
                async for _ in r.aiter_bytes():
                    pass
    return {"ok": True}
`;
test("FastAPI: the tools a provider ran and what they answered, and a call its schema refuses, ride on the model call", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pyhook-"));
  const file = join(dir, "trace.jsonl");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "provider_app.py"), PROVIDER_APP);
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const child = spawn(PY, ["-m", "uvicorn", "provider_app:app", "--port", String(P4337)], { cwd: dir, env: { ...process.env, PYTHONPATH: HOOK, CORTAD_TRACE_FILE: file }, stdio: "ignore" });
  try {
    assert.ok(await up(P4337));
    const res = await fetch(`http://127.0.0.1:${P4337}/talk`, { method: "POST", headers: { "x-cortad-turn": fx.turn } });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 400));
  } finally { child.kill("SIGKILL"); }
  const calls = Object.fromEntries(rowsOf(file).filter((l) => l.call).map((l) => [l.call.model, l.call]));
  assert.deepEqual(calls["responses-provider-tools"]?.called, fx.providerTools.called);
  assert.deepEqual(calls["responses-provider-tools"]?.tools, fx.providerTools.tools);
  assert.deepEqual(calls["refused-args"]?.called, fx.refusedArgs.called);
});

// An app whose own code picks the tool from a classifier's answer: the fixture's shop, in Python.
// The run writes the list after the app has loaded, as a real run does; the hook wraps the function
// in its module and wherever the app took it by name or put it in a table of its own.
const DISPATCH_APP = (fx) => `
import json, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import httpx
from fastapi import FastAPI, Request
from ${fx.module} import query_order

styles = json.loads(${JSON.stringify(JSON.stringify([fx.classify, fx.answer]))})
HANDLERS = {"order": query_order}

class Provider(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length") or 0))
        s = next(x for x in styles if self.path == x["path"])
        raw = s["reply"].encode()
        self.send_response(200)
        self.send_header("content-type", s["type"])
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def log_message(self, *a):
        pass

server = HTTPServer(("127.0.0.1", 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % server.server_port
app = FastAPI()

@app.post("/api/chat")
async def chat(request: Request):
    body = await request.json()
    async with httpx.AsyncClient() as h:
        intent = json.loads((await h.post(base + styles[0]["path"], json=styles[0]["sent"])).json()["choices"][0]["message"]["content"])["intent"]
        if intent == "order":
            (HANDLERS[intent] if body.get("via") == "table" else query_order)(body["message"])
        await h.post(base + styles[1]["path"], json=styles[1]["sent"])
    return {"ok": True}
`;
const SHOP_TOOLS = (fx) => `
def query_order(message):
    return ${JSON.stringify(fx.returns)}

def search_faq(question):
    return "never asked"

REFUND_POLICY = "seven days"
`;
test("FastAPI: a tool the app's own code runs is recorded with its arguments and what it returned; a password never is", { skip }, async () => {
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8")).dispatched;
  const dir = mkdtempSync(join(tmpdir(), "pyhook-"));
  const file = join(dir, "trace.jsonl");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "dispatch_app.py"), DISPATCH_APP(fx));
  writeFileSync(join(dir, `${fx.module}.py`), SHOP_TOOLS(fx));
  const toolsFile = join(dir, "tools.json");
  const child = spawn(PY, ["-m", "uvicorn", "dispatch_app:app", "--port", String(P4336)], { cwd: dir, env: { ...process.env, PYTHONPATH: HOOK, CORTAD_TRACE_FILE: file, CORTAD_TOOLS_FILE: toolsFile }, stdio: ["ignore", "ignore", "pipe"] });
  let said = "";
  child.stderr.on("data", (d) => { said += d; });
  try {
    assert.ok(await up(P4336));
    writeFileSync(toolsFile, JSON.stringify(fx.tools.map((t) => ({ ...t, file: t.file === "app" ? "dispatch_app.py" : `${fx.module}.py` }))));
    for (const [turn, via] of [["case_4:1", "name"], ["case_4:2", "table"]]) {
      const res = await fetch(`http://127.0.0.1:${P4336}/api/chat`, { method: "POST", headers: { "content-type": "application/json", "x-cortad-turn": turn }, body: JSON.stringify({ message: fx.message, via }) });
      assert.equal(res.status, 200);
    }
    await new Promise((r) => setTimeout(r, 400));
  } finally { child.kill("SIGKILL"); }
  const rows = rowsOf(file);
  const ran = rows.filter((l) => l.dep && l.dep.host === "in-app").map((l) => l.dep);
  assert.deepEqual(ran.map((d) => [d.turn, d.called, d.tools]), [["case_4:1", fx.called, fx.toolRows], ["case_4:2", fx.called, fx.toolRows]], "taken by name and from the app's own table; search_faq was never called");
  const calls = rows.filter((l) => l.call).map((l) => l.call);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c.tools === undefined), "the second chain's prompt and the person's message are not a tool's answer");
  assert.ok(rows.every((l) => ![...(l.call?.tools ?? []), ...(l.dep?.tools ?? [])].some((t) => !t.name)), "nothing in tools has an empty name");
  assert.ok(!readFileSync(file, "utf8").includes("hunter2"), "the password the person typed is in no row");
  assert.equal(said.split(fx.unwatched.replace("%s", "py")).length - 1, 1, "a named tool that is not a function is said once in the app's log");
});

// The route table read off the app object the server was handed, in one path syntax.
const tableOf = async (args, port, extra = {}) => {
  const file = join(mkdtempSync(join(tmpdir(), "pyhook-")), "trace.jsonl");
  const child = spawn(args[0], args.slice(1), { cwd: APP, env: { ...process.env, PYTHONPATH: HOOK, CORTAD_TRACE_FILE: file, ...extra }, stdio: "ignore", detached: true });
  try {
    assert.ok(await up(port), "the app starts with the hook loaded");
    const rows = rowsOf(file).filter((l) => l.routes);
    assert.ok(rows.length, "a routes row is written");
    const table = rows[rows.length - 1].routes;
    return { ...table, said: table.routes.map((r) => `${r.method} ${r.path}`) };
  } finally { process.kill(-child.pid, "SIGKILL"); }
};

test("FastAPI: an APIRouter's prefixed route with an int path parameter, and the OpenAPI document", { skip }, async () => {
  const t = await tableOf([PY, "-m", "uvicorn", "fast_app:app", "--port", String(P4331)], P4331);
  assert.deepEqual([t.framework, t.port], ["fastapi", P4331]);
  assert.ok(t.said.includes("POST /api/things/{thing_id}"), t.said.join(", "));
  assert.deepEqual(t.routes.find((r) => r.path === "/api/things/{thing_id}"), { method: "POST", path: "/api/things/{thing_id}", file: "fast_app.py", handler: "update_thing" });
  assert.ok(t.openapi?.paths?.["/api/things/{thing_id}"]?.post, "the in-process OpenAPI document carries the route");
  assert.equal(t.routes.find((r) => r.path === "/docs").file, "", "the framework's own files are not theirs");
});

test("Flask: url_map rules with converters, static left out", { skip }, async () => {
  const t = await tableOf([PY, "flask_app.py"], P4322);
  assert.deepEqual([t.framework, t.port, t.openapi], ["flask", P4322, null]);
  assert.deepEqual(t.said, ["POST /helper/reply", "POST /helper/threads/{thread_id}"]);
});

const hasDjango = existsSync(join(APP, ".venv/bin/django-admin"));
test("Django: included patterns keep their prefix, converters and regex groups become {name}", { skip: skip || !hasDjango }, async () => {
  const t = await tableOf([PY, "django_app.py", "runserver", String(P4332), "--noreload"], P4332);
  assert.deepEqual([t.framework, t.port], ["django", P4332]);
  assert.deepEqual(t.said, ["POST /api/chat/{pk}/", "GET /api/chat/{pk}/", "POST /api/notes/{slug}/"], "a function view's methods are unknown; a class view's are its own");
});

const hasGunicorn = existsSync(join(APP, ".venv/bin/gunicorn"));
test("gunicorn with uvicorn's worker: the port is gunicorn's socket, not uvicorn's default", { skip: skip || !hasGunicorn }, async () => {
  const t = await tableOf([join(APP, ".venv/bin/gunicorn"), "-k", "uvicorn.workers.UvicornWorker", "-b", `127.0.0.1:${P4333}`, "fast_app:app"], P4333);
  assert.deepEqual([t.framework, t.port], ["fastapi", P4333]);
  assert.ok(t.said.includes("POST /api/things/{thing_id}"));
});

const hasLitestar = existsSync(join(APP, ".venv/bin/litestar"));
test("Litestar and aiohttp: typed path parameters come out as {name}", { skip: skip || !hasLitestar }, async () => {
  const lite = await tableOf([PY, "-m", "uvicorn", "litestar_app:app", "--port", String(P4334)], P4334);
  assert.equal(lite.framework, "litestar");
  assert.deepEqual(lite.routes.find((r) => r.path === "/api/chat/{chat_id}"), { method: "POST", path: "/api/chat/{chat_id}", file: "litestar_app.py", handler: "chat" });
  assert.ok(lite.openapi?.paths?.["/api/chat/{chat_id}"]);
  const aio = await tableOf([PY, "aiohttp_app.py"], P4335);
  assert.deepEqual([aio.framework, aio.port, aio.said], ["aiohttp", P4335, ["POST /api/chat/{chat_id}"]]);
});

// A store's client connects to an address its name was resolved to: the name is read where it is
// resolved and the address where it connects, host and port alone, once each. Plain Python, no venv.
test("each server a Python app reaches is written down by name and by address, and nothing else of it", { timeout: 20_000 }, async () => {
  const { createServer } = await import("node:net");
  const server = createServer((s) => s.end()).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;
  const file = join(mkdtempSync(join(tmpdir(), "pyhook-")), "trace.jsonl");
  const script = `import socket\nfor _ in range(2):\n    socket.create_connection(("localhost", ${port})).close()\n`;
  const child = spawn("python3", ["-c", script], { env: { PATH: process.env.PATH, PYTHONPATH: HOOK, CORTAD_TRACE_FILE: file }, stdio: "ignore" });
  await new Promise((r) => child.on("exit", r));
  server.close();
  const conns = rowsOf(file).filter((l) => l.conn).map((l) => l.conn);
  const hosts = conns.filter((c) => c.port === port).map((c) => c.host);
  // Each address tried is its own row: ::1 first where localhost resolves to it too.
  assert.ok(hosts.includes("localhost") && hosts.includes("127.0.0.1") && hosts.length === new Set(hosts).size, JSON.stringify(hosts));
  assert.ok(rowsOf(file).filter((l) => l.conn).every((l) => Object.keys(l).length === 1 && Object.keys(l.conn).join() === "host,port"));
});

// A FastAPI turn that writes out through httpx, requests and aiohttp (once by a whole address, once
// by a path under the session's base address) to a host off this machine, which its own lookup sends
// to a fake provider here, and calls a model both ways.
test("a model call that stopped at its output cap says so, with the cap the app set and what reasoning spent of it", { skip, timeout: 30_000 }, async () => {
  const { createServer } = await import("node:http");
  const { writeFileSync } = await import("node:fs");
  const replies = {
    "/v1/chat/completions": { model: "py-capped", choices: [{ finish_reason: "length", message: { content: "" } }], usage: { prompt_tokens: 20, completion_tokens: 350, completion_tokens_details: { reasoning_tokens: 350 } } },
    "/v1/responses": { model: "py-incomplete", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 290 } } },
    "/v1/chat/completions?done": { model: "py-whole", choices: [{ finish_reason: "stop", message: { content: "Hello" } }], usage: { prompt_tokens: 20, completion_tokens: 5 } },
  };
  const provider = createServer((req, res) => { req.resume(); req.on("end", () => res.end(JSON.stringify(replies[req.url]))); });
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "pycapped-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "capped.py"), [
    "import os, requests",
    "base = 'http://127.0.0.1:%s' % os.environ['FAKE_PORT']",
    "requests.post(base + '/v1/chat/completions', json={'model': 'py-capped', 'max_completion_tokens': 350})",
    "requests.post(base + '/v1/responses', json={'model': 'py-incomplete', 'max_output_tokens': 300})",
    "requests.post(base + '/v1/chat/completions?done', json={'model': 'py-whole', 'max_tokens': 900})",
    "print('DONE')",
  ].join("\n"));
  try {
    const out = await new Promise((done) => {
      const child = spawn(PY, ["capped.py"], { cwd: dir, env: { ...process.env, PYTHONPATH: HOOK, CORTAD_TRACE_FILE: file, FAKE_PORT: String(provider.address().port) }, stdio: ["ignore", "pipe", "inherit"] });
      let said = ""; child.stdout.on("data", (d) => { said += d; }); child.on("close", () => done(said));
    });
    assert.match(out, /DONE/);
    const by = Object.fromEntries(rowsOf(file).filter((l) => l.call).map((l) => [l.call.model, l.call.limit ?? null]));
    assert.deepEqual(by, { "py-capped": { cap: 350, reasoning: 350 }, "py-incomplete": { cap: 300, reasoning: 290 }, "py-whole": null });
  } finally { provider.close(); }
});

// One customer's main chat in Python: a system prompt past 64 KB and the person's message last. Cut at its
// head, the record held the system message alone and never parsed.
const LONG_APP = `
import json, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import httpx
from fastapi import FastAPI, Request

SYSTEM = "You are a teacher. Answer in Arabic, the language of the user; you are an academic assistant only. " * 800

class Provider(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length") or 0))
        raw = json.dumps({"model": "m", "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "ok"}}], "usage": {"prompt_tokens": 25000, "completion_tokens": 1}}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def log_message(self, *a):
        pass

server = HTTPServer(("127.0.0.1", 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % server.server_port
app = FastAPI()

@app.post("/v1/chat")
async def chat(request: Request):
    body = await request.json()
    messages = [{"role": "system", "content": SYSTEM}, *body.get("conversationHistory", []), {"role": "user", "content": body["message"]}]
    async with httpx.AsyncClient() as h:
        r = await h.post(base + "/v1/chat/completions", json={"model": "m", "messages": messages})
    return {"reply": r.json()["choices"][0]["message"]["content"]}
`;
test("FastAPI: a model request past the record's size keeps its shape and the person's message", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pyhook-"));
  const file = join(dir, "trace.jsonl");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "long_app.py"), LONG_APP);
  const port = await freePort();
  const child = spawn(PY, ["-m", "uvicorn", "long_app:app", "--port", String(port)], { cwd: dir, env: { ...process.env, PYTHONPATH: HOOK, CORTAD_TRACE_FILE: file }, stdio: "ignore" });
  try {
    assert.ok(await up(port));
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "اشرح لي قانون نيوتن الثاني", conversationHistory: [], language: "arabic" }) });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 400));
  } finally { child.kill("SIGKILL"); }
  const [row] = rowsOf(file).filter((l) => l.ex && l.method);
  assert.ok(row.sent[0].length <= 65536, `${row.sent[0].length}`);
  const sent = JSON.parse(row.sent[0]);
  assert.deepEqual(sent.messages.map((m) => m.role), ["system", "user"]);
  assert.equal(sent.messages.at(-1).content, "اشرح لي قانون نيوتن الثاني");
});

// A Qdrant server as its REST API answers, counting which collection every write landed in.
function fakeQdrant(createServer) {
  const collections = new Map([["docs", [{ id: 1, vector: [0.1, 0.2], payload: { text: "the first page" } }]]]);
  const writes = [];
  const json = (res, result, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ result, status: "ok" })); };
  const server = createServer((req, res) => {
    let b = ""; req.on("data", (c) => { b += c; });
    req.on("end", () => {
      const m = /^\/collections\/([^/?]+)(\/[^?]*)?/.exec(req.url);
      const name = m && decodeURIComponent(m[1]), rest = (m && m[2]) || "";
      const held = name && collections.get(name);
      if (req.headers["api-key"] !== "q-key") return json(res, null, 401);
      if (req.method === "GET" && rest === "") return held ? json(res, { points_count: held.length, config: { params: { vectors: { size: 2, distance: "Cosine" } } }, payload_schema: {} }) : json(res, null, 404);
      if (req.method === "PUT" && rest === "") { collections.set(name, []); writes.push(`create ${name}`); return json(res, true); }
      if (req.method === "DELETE" && rest === "") { collections.delete(name); writes.push(`drop ${name}`); return json(res, true); }
      if (req.method === "POST" && rest === "/points/scroll") return json(res, { points: held ?? [], next_page_offset: null });
      if (req.method === "PUT" && rest === "/points") { if (!held) return json(res, null, 404); held.push(...JSON.parse(b).points); writes.push(`upsert ${name}`); return json(res, { status: "completed" }); }
      if (req.method === "POST" && rest === "/points/search") return json(res, (held ?? []).map((pt) => ({ id: pt.id, score: 1, payload: pt.payload })));
      json(res, null, 404);
    });
  });
  return { server, collections, writes };
}

// An app whose turn writes into three Qdrant collections, one per client, and searches the first.
