import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const read = (file) => { try { return readFileSync(file, "utf8"); } catch { return ""; } };
const json = (file) => { try { return JSON.parse(read(file)); } catch { return null; } };
const MODEL_SDK = /^(?:openai|ai|@ai-sdk\/.+|@anthropic-ai\/sdk|langchain|@langchain\/.+|llamaindex|@google\/generative-ai|@google\/genai|groq-sdk|@mistralai\/.+|cohere-ai|ollama|replicate|together-ai)$/;
const SERVER = /^(?:express|fastify|hono|koa|@nestjs\/core|@strapi\/strapi|next|nuxt|@remix-run\/.+|@sveltejs\/kit|@hapi\/hapi|restify|elysia)$/;
const PY_MODEL = /^\s*["']?(?:openai|anthropic|langchain|langgraph|litellm|llama[-_]index|google-generativeai|google-genai|groq|cohere|mistralai|ollama|fireworks-ai|together)\b/im;
const PY_SERVER = /^\s*["']?(?:fastapi|flask|django|starlette|quart|litestar|sanic|aiohttp|uvicorn|gunicorn)\b/im;
const ENTRIES = ["main.py", "app.py", "server.py", "run.py", "api.py", "wsgi.py", "asgi.py", "src/main.py", "app/main.py", "src/app.py", "backend/main.py", "api/main.py"];

const ENTRY_NAME = /^(?:main|app|server|serve|api|run|start|service|web|backend|wsgi|asgi)[\w-]*\.py$/i;
const entriesIn = (dir) => ["", "src", "app", "backend", "api"].flatMap((sub) => {
  try { return readdirSync(join(dir, sub)).filter((f) => ENTRY_NAME.test(f)).map((f) => (sub ? `${sub}/${f}` : f)); }
  catch { return []; }
});

const SERVES = /uvicorn\.run|FastAPI\(|Flask\(|Starlette\(|Litestar\(|Quart\(|app\.run\(|run_server|serve\(/;

const SERVES_JS = /\b(?:next|nuxt|vite|nest|remix|astro|sveltekit|serve|nodemon|ts-node-dev|uvicorn|gunicorn|rails|strapi)\b/;

const LOCKS = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "package-lock.json"];

const manager = (dir) => (existsSync(join(dir, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(dir, "yarn.lock")) ? "yarn" : existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock")) ? "bun" : "npm");

const BUNDLER = /\b(?:vite|next|nuxt|astro|svelte-kit|vinxi|webpack(?:-dev-server)?|react-scripts|parcel|rsbuild|storybook)\b/;

const RUNS_SERVER = /\b(?:node|nodemon|tsx|ts-node(?:-dev)?|bun run|deno run|concurrently|npm-run-all|run-p|turbo run)\b|\.(?:sh|mjs|cjs|js|ts)\b/;
const SERVER_SCRIPT = /^(?:dev:(?:full|all|server|api|backend)|server|start:server|backend(?::dev)?|api(?::dev)?|start:api|serve:api|start)$/;

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

  return { cmd: `${onPath(locked) ? locked : "npm"} run ${script}`, serves: deps.some((d) => SERVER.test(d)) || SERVES_JS.test(pkg.scripts[script]) };
}

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

  for (const [entry, text] of [...named.filter(([, text]) => SERVES.test(text)), ...named]) {

    if (/if\s+__name__\s*==\s*["']__main__["']/.test(text)) return { cmd: `${py} ${entry}`, serves: SERVES.test(text) };
    const module = entry.replace(/\.py$/, "").split("/").join(".");
    const fast = /^(\w+)\s*=\s*(?:FastAPI|Starlette|Litestar|Quart)\(/m.exec(text);
    if (fast) return { cmd: `${py} -m uvicorn ${module}:${fast[1]} --host 127.0.0.1 --port 8000`, serves: true };
    const flask = /^(\w+)\s*=\s*Flask\(/m.exec(text);
    if (flask) return { cmd: `${py} -m flask --app ${module} run --port 5000`, serves: true };

    const bound = BOUND_APP.exec(text)?.[1] ?? IMPORTED_APP.exec(text)?.slice(1).find(Boolean);
    if (bound && /\b(?:fastapi|starlette|litestar|quart)\b/i.test(manifest)) return { cmd: `${py} -m uvicorn ${module}:${bound} --host 127.0.0.1 --port 8000`, serves: true };
    if (bound && /\bflask\b/i.test(manifest)) return { cmd: `${py} -m flask --app ${module}:${bound} run --port 5000`, serves: true };
  }
  return null;
}

const BOUND_APP = /^(app|application)\s*=\s*[\w.]+\(/m;
const IMPORTED_APP = /^from\s+[\w.]+\s+import\s+(?:\(\s*[^)]*?\b(app|application)\b[^)]*\)|[^\n(]*\b(app|application)\b)/m;
const KNOWN = ["package.json", "pyproject.toml", "requirements.txt", "manage.py", "Pipfile", "uv.lock"];

const HOOKED = /^(?:python3?(?:\.\d+)?|node|nodemon|tsx|ts-node|bun|bunx|deno|npm|npx|pnpm|yarn|uvicorn|gunicorn|hypercorn|flask|fastapi|poetry|uv|pipenv)$/;

const runtimeOf = (cmd) => {
  const words = cmd.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)).map((w) => w.replace(/^["']|["']$/g, "").split("/").pop() ?? "");
  return words.find((w) => w !== "env" && w !== "exec" && !w.startsWith("-")) ?? "";
};
export const hookable = (dir, cmd = "") => (cmd ? HOOKED.test(runtimeOf(cmd)) : KNOWN.some((f) => existsSync(join(dir, f))));

const startOf = (dir, onPath) => nodeStart(dir, onPath) ?? pythonStart(dir, onPath);

function weight(dir, name) {
  const pkg = json(join(dir, "package.json"));
  const deps = Object.keys({ ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) });
  const py = `${read(join(dir, "requirements.txt"))}\n${read(join(dir, "pyproject.toml"))}`;
  const model = deps.some((d) => MODEL_SDK.test(d)) || PY_MODEL.test(py);
  const server = deps.some((d) => SERVER.test(d)) || PY_SERVER.test(py);
  return (model ? 4 : 0) + (server ? 2 : 0) + (/back|api|server|service/i.test(name) ? 1 : 0) - (!model && /front|web|client|ui|mobile|docs|site|landing|admin/i.test(name) ? 3 : 0);
}

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

  const rootPkg = json(join(root, "package.json"));
  const rootPy = `${read(join(root, "requirements.txt"))}\n${read(join(root, "pyproject.toml"))}`;
  const pythonFirst = Boolean(rootPkg) && PY_MODEL.test(rootPy) && !Object.keys({ ...(rootPkg.dependencies ?? {}), ...(rootPkg.devDependencies ?? {}) }).some((d) => MODEL_SDK.test(d));
  const own = mono ? null : pythonFirst ? (pythonStart(root, onPath) ?? nodeStart(root, onPath)) : startOf(root, onPath);
  if (own) return { cmd: own.cmd, cwd: root };

  const members = workspaces(root);
  const ranked = [...(mono && servesItself(root, members) ? [root] : []), ...members].map((dir) => ({ dir, start: startOf(dir, onPath), weight: weighed(dir, relative(root, dir)) })).filter((w) => w.start).sort((a, b) => b.weight - a.weight);
  const best = ranked[0];
  const at = (w) => ({ cmd: w.start.cmd, cwd: w.dir, ...(w.dir === root ? {} : { within: relative(root, w.dir) }) });
  if (best && best.weight > 0 && (ranked.length === 1 || best.weight > ranked[1].weight)) return at(best);

  const rootStart = startOf(root, onPath);
  if (rootStart) return { cmd: rootStart.cmd, cwd: root };

  if (!best) return KNOWN.some((f) => existsSync(join(root, f))) ? { cmd: null, cwd: root, noServer: true } : null;

  const serving = ranked.find((w) => w.start.serves);
  return serving ? { ...at(serving), unsure: true } : { cmd: null, cwd: root, noServer: true };
}

export const SHOWN_COMMAND = 200;
export const shownCommand = (cmd, mask = (text) => text) => (cmd == null ? cmd
  : mask(String(cmd)).replace(/\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, (whole, name, value) => (/^[\w.-]{1,24}$/.test(value) ? whole : `${name}=***`)).slice(0, SHOWN_COMMAND));

export const inContainer = (cmd = "") => /^\s*(?:sudo\s+)?(?:docker|podman)(?:-compose)?\b/.test(cmd);

export const publishedPorts = (cmd = "") => [...cmd.matchAll(/(?:^|\s)(?:-p|--publish)(?:\s+|=)(?:[\d.]+:)?(\d{2,5}):\d{2,5}\b/g)].map((m) => Number(m[1]));

const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
export const composePorts = (cmd = "", dir = ".") => {
  if (!/\bcompose\b/.test(cmd)) return [];
  const named = [...cmd.matchAll(/(?:^|\s)(?:-f|--file)(?:\s+|=)(\S+)/g)].map((m) => m[1]);
  const text = (named.length ? named : COMPOSE_FILES).map((f) => read(join(dir, f))).join("\n");
  const short = [...text.matchAll(/^\s*-\s*["']?(?:[\d.]+:)?(\d{2,5}):\d{2,5}(?:\/tcp)?["']?\s*$/gm)];
  const long = [...text.matchAll(/^\s*published:\s*["']?(\d{2,5})["']?\s*$/gm)];
  return [...new Set([...short, ...long].map((m) => Number(m[1])))];
};

export const forContainer = (env) => Object.fromEntries(Object.entries(env).map(([name, value]) => [name, value.replace("//127.0.0.1:", "//host.docker.internal:")]));

export const passedThrough = (cmd = "") => new Set([...cmd.matchAll(/(?:^|\s)(?:-e|--env)(?:\s+|=)([A-Za-z_][A-Za-z0-9_]*)(?=\s|$)/g)].map((m) => m[1]));
