// How their app most likely starts, and from which folder, read off the repository: printed as the
// one suggestion when the person gave no start command (local.mjs), never run on its own. A
// monorepo root has no app of its own: the app is the workspace that serves the AI.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const read = (file) => { try { return readFileSync(file, "utf8"); } catch { return ""; } };
const json = (file) => { try { return JSON.parse(read(file)); } catch { return null; } };
const MODEL_SDK = /^(?:openai|ai|@ai-sdk\/.+|@anthropic-ai\/sdk|langchain|@langchain\/.+|llamaindex|@google\/generative-ai|@google\/genai|groq-sdk|@mistralai\/.+|cohere-ai|ollama|replicate|together-ai)$/;
const SERVER = /^(?:express|fastify|hono|koa|@nestjs\/core|@strapi\/strapi|next|nuxt|@remix-run\/.+|@sveltejs\/kit|@hapi\/hapi|restify|elysia)$/;
const PY_MODEL = /^\s*["']?(?:openai|anthropic|langchain|langgraph|litellm|llama[-_]index|google-generativeai|google-genai|groq|cohere|mistralai|ollama|fireworks-ai|together)\b/im;
const PY_SERVER = /^\s*["']?(?:fastapi|flask|django|starlette|quart|litestar|sanic|aiohttp|uvicorn|gunicorn)\b/im;
const ENTRIES = ["main.py", "app.py", "server.py", "run.py", "api.py", "wsgi.py", "asgi.py", "src/main.py", "app/main.py", "src/app.py", "backend/main.py", "api/main.py"];
// A twelve-name list is not how apps name their entry file: agent-service-toolkit's is
// src/run_service.py, and asking a person how their app starts because of a filename is asking
// them to do our job. Every plausibly named file beside the manifest is a candidate.
const ENTRY_NAME = /^(?:main|app|server|serve|api|run|start|service|web|backend|wsgi|asgi)[\w-]*\.py$/i;
const entriesIn = (dir) => ["", "src", "app", "backend", "api"].flatMap((sub) => {
  try { return readdirSync(join(dir, sub)).filter((f) => ENTRY_NAME.test(f)).map((f) => (sub ? `${sub}/${f}` : f)); }
  catch { return []; }
});
// What tells an entry file from a script that also runs itself: this one brings a server up.
const SERVES = /uvicorn\.run|FastAPI\(|Flask\(|Starlette\(|Litestar\(|Quart\(|app\.run\(|run_server|serve\(/;
// The same question of a package script: does this command put something on a port, or run a task
// and exit. `crewai run` and `python main.py` are tasks; `next dev` and `nodemon server.js` serve.
const SERVES_JS = /\b(?:next|nuxt|vite|nest|remix|astro|sveltekit|serve|nodemon|ts-node-dev|uvicorn|gunicorn|rails|strapi)\b/;
// Where this workspace's install lives: the nearest folder at or above it holding a lockfile, never
// past the repository the customer ran the command in.
const LOCKS = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "package-lock.json"];

// The manager this repository was installed with, named by its lockfile.
const manager = (dir) => (existsSync(join(dir, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(dir, "yarn.lock")) ? "yarn" : existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock")) ? "bun" : "npm");

// A script that only bundles or serves a browser build: the AI is never behind it.
const BUNDLER = /\b(?:vite|next|nuxt|astro|svelte-kit|vinxi|webpack(?:-dev-server)?|react-scripts|parcel|rsbuild|storybook)\b/;
// A script that runs a server file, or runs everything at once.
const RUNS_SERVER = /\b(?:node|nodemon|tsx|ts-node(?:-dev)?|bun run|deno run|concurrently|npm-run-all|run-p|turbo run)\b|\.(?:sh|mjs|cjs|js|ts)\b/;
const SERVER_SCRIPT = /^(?:dev:(?:full|all|server|api|backend)|server|start:server|backend(?::dev)?|api(?::dev)?|start:api|serve:api|start)$/;
// The script that starts the AI, not the page: flowviz's dev runs vite and its server runs node
// server.js with openai behind express; tududi's dev is the frontend and backend:dev the API.
function serverScript(scripts, deps) {
  const first = ["dev", "develop", "start:dev", "serve", "start"].find((s) => scripts?.[s]);
  if (!first) return null;
  const command = String(scripts[first]);
  const frontendOnly = BUNDLER.test(command) && !RUNS_SERVER.test(command.replace(BUNDLER, ""));
  if (!frontendOnly || !deps.some((d) => SERVER.test(d) || MODEL_SDK.test(d))) return first;
  const better = Object.keys(scripts).filter((s) => SERVER_SCRIPT.test(s) && s !== first && RUNS_SERVER.test(String(scripts[s])) && !(BUNDLER.test(String(scripts[s])) && !/concurrently|npm-run-all|run-p|\.sh\b/.test(String(scripts[s]))));
  const rank = (s) => (/full|all/.test(s) ? 0 : /server|backend|api/.test(s) ? 1 : 2);
  return better.sort((a, b) => rank(a) - rank(b))[0] ?? first;
}

function nodeStart(dir, onPath) {
  const pkg = json(join(dir, "package.json"));
  if (!pkg) return null;
  const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  const script = serverScript(pkg.scripts, deps);
  if (!script) return null;
  const locked = manager(dir);
  // A lockfile names the manager the repository was installed with, not one this machine has.
  return { cmd: `${onPath(locked) ? locked : "npm"} run ${script}`, serves: deps.some((d) => SERVER.test(d)) || SERVES_JS.test(pkg.scripts[script]) };
}

// A package that serves through its own console script: pyproject [project.scripts] names it, and
// its command module defines a serve or run command (typer, click, argparse). RepoWiki starts with
// `repowiki serve --port N`; no module-level app object exists to hand uvicorn.
function consoleServe(dir, venv) {
  if (!venv) return null;
  const toml = read(join(dir, "pyproject.toml"));
  const block = /\[project\.scripts\]([^[]*)/.exec(toml)?.[1] ?? "";
  for (const m of block.matchAll(/^\s*"?([\w.-]+)"?\s*=\s*"([\w.]+):(\w+)"/gm)) {
    const [, name, module] = m;
    const file = ["src/", ""].map((base) => join(dir, base, `${module.split(".").join("/")}.py`)).find(existsSync);
    const text = file ? read(file) : "";
    const sub = /(?:def serve\(|@\w+\.command\(\s*(?:name\s*=\s*)?["']serve["']|add_parser\(\s*["']serve["']|["']serve["']\s*:)/.test(text) ? "serve"
      : /(?:def run\(|add_parser\(\s*["']run["']|@\w+\.command\(\s*(?:name\s*=\s*)?["']run["'])/.test(text) ? "run" : null;
    const bin = join(dirname(venv), name);
    if (sub && existsSync(bin)) return { cmd: `${JSON.stringify(bin)} ${sub}${/--port/.test(text) ? " --port 8000" : ""}`, serves: true };
  }
  return null;
}

function pythonStart(dir, onPath) {
  if (!["requirements.txt", "pyproject.toml", "manage.py", "Pipfile", "uv.lock"].some((f) => existsSync(join(dir, f)))) return null;
  const venv = [".venv/bin/python", "venv/bin/python", "env/bin/python"].map((p) => join(dir, p)).find(existsSync);
  const py = venv ? JSON.stringify(venv) : existsSync(join(dir, "uv.lock")) && onPath("uv") ? "uv run python" : existsSync(join(dir, "poetry.lock")) && onPath("poetry") ? "poetry run python" : "python3";
  if (existsSync(join(dir, "manage.py"))) return { cmd: `${py} manage.py runserver`, serves: true };
  const served = consoleServe(dir, venv);
  if (served) return served;
  const named = [...new Set([...ENTRIES, ...entriesIn(dir)])].map((entry) => [entry, read(join(dir, entry))]).filter(([, text]) => text);
  const manifest = `${read(join(dir, "requirements.txt"))}\n${read(join(dir, "pyproject.toml"))}\n${read(join(dir, "Pipfile"))}`;
  // The file that serves before the file that merely runs: src/run_agent.py runs a conversation in
  // the terminal and src/run_service.py is the app, and they sit in one folder.
  for (const [entry, text] of [...named.filter(([, text]) => SERVES.test(text)), ...named]) {
    // Their own way of starting it carries their own port and settings.
    if (/if\s+__name__\s*==\s*["']__main__["']/.test(text)) return { cmd: `${py} ${entry}`, serves: SERVES.test(text) };
    const module = entry.replace(/\.py$/, "").split("/").join(".");
    const fast = /^(\w+)\s*=\s*(?:FastAPI|Starlette|Litestar|Quart)\(/m.exec(text);
    if (fast) return { cmd: `${py} -m uvicorn ${module}:${fast[1]} --host 127.0.0.1 --port 8000`, serves: true };
    const flask = /^(\w+)\s*=\s*Flask\(/m.exec(text);
    if (flask) return { cmd: `${py} -m flask --app ${module} run --port 5000`, serves: true };
    // The app object built elsewhere and only bound or re-exported here: resumeforge's
    // backend/app/main.py is `from .application import (app, ...)`, and the server the manifest
    // names says what serves it.
    const bound = BOUND_APP.exec(text)?.[1] ?? IMPORTED_APP.exec(text)?.slice(1).find(Boolean);
    if (bound && /\b(?:fastapi|starlette|litestar|quart)\b/i.test(manifest)) return { cmd: `${py} -m uvicorn ${module}:${bound} --host 127.0.0.1 --port 8000`, serves: true };
    if (bound && /\bflask\b/i.test(manifest)) return { cmd: `${py} -m flask --app ${module}:${bound} run --port 5000`, serves: true };
  }
  return null;
}

// `app = create_app()` at the top of the file, or `from .application import app`.
const BOUND_APP = /^(app|application)\s*=\s*[\w.]+\(/m;
const IMPORTED_APP = /^from\s+[\w.]+\s+import\s+(?:\(\s*[^)]*?\b(app|application)\b[^)]*\)|[^\n(]*\b(app|application)\b)/m;
const KNOWN = ["package.json", "pyproject.toml", "requirements.txt", "manage.py", "Pipfile", "uv.lock"];
// A folder whose app the hooks can load into: Node, Bun or Python. Any other is seen through lib/proxy.mjs.
// Whether the hook can ride into the process the command starts: a Node, Bun or Python process takes it
// from its environment whatever folder it runs in; a container, a Go or Java binary does not, and is
// watched from outside (lib/proxy.mjs). Judged by the command when there is one, else by the folder.
const HOOKED = /^(?:python3?(?:\.\d+)?|node|nodemon|tsx|ts-node|bun|bunx|deno|npm|npx|pnpm|yarn|uvicorn|gunicorn|hypercorn|flask|fastapi|poetry|uv|pipenv)$/;
// The program a command runs, past any PORT=3000 in front of it, an `env` or `exec` that only sets
// those, and the quotes or folder around it.
const runtimeOf = (cmd) => {
  const words = cmd.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)).map((w) => w.replace(/^["']|["']$/g, "").split("/").pop() ?? "");
  return words.find((w) => w !== "env" && w !== "exec" && !w.startsWith("-")) ?? "";
};
export const hookable = (dir, cmd = "") => (cmd ? HOOKED.test(runtimeOf(cmd)) : KNOWN.some((f) => existsSync(join(dir, f))));

const startOf = (dir, onPath) => nodeStart(dir, onPath) ?? pythonStart(dir, onPath);

// How much a folder looks like the thing that serves the AI.
function weight(dir, name) {
  const pkg = json(join(dir, "package.json"));
  const deps = Object.keys({ ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) });
  const py = `${read(join(dir, "requirements.txt"))}\n${read(join(dir, "pyproject.toml"))}`;
  const model = deps.some((d) => MODEL_SDK.test(d)) || PY_MODEL.test(py);
  const server = deps.some((d) => SERVER.test(d)) || PY_SERVER.test(py);
  return (model ? 4 : 0) + (server ? 2 : 0) + (/back|api|server|service/i.test(name) ? 1 : 0) - (!model && /front|web|client|ui|mobile|docs|site|landing|admin/i.test(name) ? 3 : 0);
}

// A folder whose start only bundles a page for the browser: the AI is never behind it, whatever it
// imports (wecom-sales-agent's console/ imports hono for its client's types). A framework that also
// serves routes is not a page.
const PAGE_BUNDLER = /\b(?:vite|webpack(?:-dev-server)?|react-scripts|parcel|rsbuild|storybook)\b/;
const FULLSTACK = /^(?:next|nuxt|@remix-run\/.+|@react-router\/dev|@sveltejs\/kit|astro|@solidjs\/start|@tanstack\/(?:react-)?start|vinxi|@analogjs\/platform|@builder\.io\/qwik-city)$/;
function pageOnly(dir) {
  const pkg = json(join(dir, "package.json"));
  if (!pkg?.scripts) return false;
  const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  const command = String(pkg.scripts[serverScript(pkg.scripts, deps)] ?? "");
  return PAGE_BUNDLER.test(command) && !RUNS_SERVER.test(command.replace(PAGE_BUNDLER, "")) && !deps.some((d) => FULLSTACK.test(d));
}
const weighed = (dir, name) => weight(dir, name) - (pageOnly(dir) ? 4 : 0);

// A monorepo root that serves the AI itself: its start runs a file of its own, not one inside a
// workspace or a helper under scripts/. A root's dependencies are often every workspace's, hoisted,
// so they say nothing about whether the root serves: TavernHeadless's root lists fastify and the AI
// SDK and its dev only runs a menu script.
function servesItself(root, members) {
  const pkg = json(join(root, "package.json"));
  const deps = Object.keys({ ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) });
  const command = String(pkg?.scripts?.[serverScript(pkg?.scripts, deps)] ?? "");
  return [...command.matchAll(/(?:^|\s)(?:\.\/)?([\w./-]+\.(?:[cm]?[jt]s|py))\b/g)].map((m) => join(root, m[1]))
    .some((file) => existsSync(file) && !/\/(?:scripts|tools|bin)\//.test(file.slice(root.length)) && !members.some((dir) => file.startsWith(`${dir}/`)));
}

const SKIP = /^(?:node_modules|\.git|dist|build|\.next|coverage|\.venv|venv|__pycache__|\.turbo|\.cache)$/;
export function workspaces(root) {
  const found = [];
  const visit = (dir, depth) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (SKIP.test(name) || name.startsWith(".")) continue;
      const at = join(dir, name);
      try { if (!statSync(at).isDirectory()) continue; } catch { continue; }
      if (["package.json", "requirements.txt", "pyproject.toml", "manage.py"].some((f) => existsSync(join(at, f)))) found.push(at);
      else if (depth < 2) visit(at, depth + 1);
    }
  };
  visit(root, 1);
  return found;
}

export function startPlan({ root, typed, onPath }) {
  if (typed) return { cmd: typed, cwd: root };
  const pkg = json(join(root, "package.json"));
  const mono = Boolean(pkg?.workspaces) || existsSync(join(root, "pnpm-workspace.yaml")) || existsSync(join(root, "turbo.json")) || existsSync(join(root, "lerna.json"));
  // A root with both manifests: the side that names a model SDK is the app; the other is its page.
  const rootPkg = json(join(root, "package.json"));
  const rootPy = `${read(join(root, "requirements.txt"))}\n${read(join(root, "pyproject.toml"))}`;
  const pythonFirst = Boolean(rootPkg) && PY_MODEL.test(rootPy) && !Object.keys({ ...(rootPkg.dependencies ?? {}), ...(rootPkg.devDependencies ?? {}) }).some((d) => MODEL_SDK.test(d));
  const own = mono ? null : pythonFirst ? (pythonStart(root, onPath) ?? nodeStart(root, onPath)) : startOf(root, onPath);
  if (own) return { cmd: own.cmd, cwd: root };
  // A monorepo root can serve the AI itself (wecom-sales-agent's root runs src/server.ts), so it is
  // weighed beside its workspaces.
  const members = workspaces(root);
  const ranked = [...(mono && servesItself(root, members) ? [root] : []), ...members].map((dir) => ({ dir, start: startOf(dir, onPath), weight: weighed(dir, relative(root, dir)) })).filter((w) => w.start).sort((a, b) => b.weight - a.weight);
  const best = ranked[0];
  const at = (w) => ({ cmd: w.start.cmd, cwd: w.dir, ...(w.dir === root ? {} : { within: relative(root, w.dir) }) });
  if (best && best.weight > 0 && (ranked.length === 1 || best.weight > ranked[1].weight)) return at(best);
  // A root that does have a start of its own after all (a monorepo whose root script runs everything).
  const rootStart = startOf(root, onPath);
  if (rootStart) return { cmd: rootStart.cmd, cwd: root };
  // Nothing at all that we know how to start. A repository written in a language we read, holding
  // no way to serve, is a package rather than an app: camel is one. Anything else is a start
  // command we have not learned.
  if (!best) return KNOWN.some((f) => existsSync(join(root, f))) ? { cmd: null, cwd: root, noServer: true } : null;
  // Nothing here stands out, so the one that serves wins. A file that only runs in a terminal is
  // not an app: camel is a package people import, swarm and the crewai examples are scripts that
  // print to a terminal, and starting one of them puts a chat loop where nothing can knock on it.
  const serving = ranked.find((w) => w.start.serves);
  return serving ? { ...at(serving), unsure: true } : { cmd: null, cwd: root, noServer: true };
}

// The start command as it leaves this machine: a value typed into it (DATABASE_URL=...) stays here
// unless it is a plain word, and it is cut to the length the server keeps. A command past that
// length was refused whole, as "port is required", with a valid port beside it.
export const SHOWN_COMMAND = 200;
export const shownCommand = (cmd, mask = (text) => text) => (cmd == null ? cmd
  : mask(String(cmd)).replace(/\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, (whole, name, value) => (/^[\w.-]{1,24}$/.test(value) ? whole : `${name}=***`)).slice(0, SHOWN_COMMAND));

