import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startPlan, shownCommand } from "./start.mjs";

const tree = (files) => { const root = mkdtempSync(join(tmpdir(), "start-")); for (const [rel, text] of Object.entries(files)) { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); } return root; };
const onPath = (bin) => bin === "npm";

test("a monorepo root starts the workspace that serves the AI, not the frontend", () => {
  const root = tree({
    "package.json": JSON.stringify({ private: true, workspaces: ["backend", "frontend"], scripts: { "dev:backend": "yarn workspace be dev" } }),
    "backend/package.json": JSON.stringify({ scripts: { dev: "strapi develop" }, dependencies: { "@strapi/strapi": "4", openai: "4" } }),
    "backend/yarn.lock": "",
    "frontend/package.json": JSON.stringify({ scripts: { dev: "vite" }, dependencies: { react: "18" } }),
  });
  const plan = startPlan({ root, onPath });
  assert.equal(plan.within, "backend");
  assert.equal(plan.cmd, "npm run dev", "yarn is not on this machine, so npm runs the same script");
});

// wecom-sales-agent: the root serves the AI (hono, src/server.ts), and its console/ workspace is an
// admin page that imports hono only for its client types. The page was started, and nothing answered.
test("a monorepo root that serves the AI itself is started over a workspace that only bundles a page", () => {
  const root = tree({
    "package.json": JSON.stringify({ private: true, scripts: { dev: "tsx watch src/server.ts", start: "tsx src/server.ts" }, dependencies: { hono: "4", "@hono/node-server": "1" } }),
    "pnpm-workspace.yaml": "packages:\n  - console\n",
    "pnpm-lock.yaml": "",
    "console/package.json": JSON.stringify({ scripts: { dev: "vite", build: "vite build" }, dependencies: { hono: "4", react: "19" }, devDependencies: { vite: "7" } }),
  });
  const plan = startPlan({ root, onPath });
  assert.equal(plan.cwd, root, "the root's own server, not the console page");
  assert.equal(plan.cmd, "npm run dev", "pnpm is not on this machine, so npm runs the same script");
});

// TavernHeadless: the root lists every workspace's dependencies, hoisted, and its dev only runs a menu
// script; the API workspace is the app.
test("a monorepo root whose dependencies are hoisted but whose start only runs a helper script defers to its API workspace", () => {
  const root = tree({
    "package.json": JSON.stringify({ private: true, scripts: { dev: "node scripts/dev-select.mjs" }, dependencies: { fastify: "5", ai: "5", "@ai-sdk/openai": "2" } }),
    "scripts/dev-select.mjs": "",
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
    "pnpm-lock.yaml": "",
    "apps/api/package.json": JSON.stringify({ scripts: { dev: "tsx watch src/index.ts" }, dependencies: { fastify: "5" } }),
    "apps/api/src/index.ts": "",
    "apps/web/package.json": JSON.stringify({ scripts: { dev: "vite" }, dependencies: { vue: "3" } }),
  });
  assert.equal(startPlan({ root, onPath }).within, "apps/api");
});

test("a plain app starts from its own folder", () => {
  const root = tree({ "package.json": JSON.stringify({ scripts: { dev: "nodemon server.js" }, dependencies: { express: "4" } }) });
  assert.deepEqual(startPlan({ root, onPath }), { cmd: "npm run dev", cwd: root });
});

test("a Python app is started the way it starts itself, from its own virtualenv", () => {
  const root = tree({ "requirements.txt": "fastapi\nopenai\n", "main.py": "from fastapi import FastAPI\napp = FastAPI()\n", ".venv/bin/python": "" });
  assert.equal(startPlan({ root, onPath }).cmd, `${JSON.stringify(join(root, ".venv/bin/python"))} -m uvicorn main:app --host 127.0.0.1 --port 8000`);
  const own = tree({ "requirements.txt": "fastapi\n", "server.py": "import uvicorn\nif __name__ == \"__main__\":\n    uvicorn.run(app, port=8000)\n" });
  assert.equal(startPlan({ root: own, onPath }).cmd, "python3 server.py");
});

test("what they typed wins", () => {
  assert.deepEqual(startPlan({ root: "/x", typed: "make dev", onPath }), { cmd: "make dev", cwd: "/x" });
});

// agent-service-toolkit: the app is src/run_service.py, beside src/run_agent.py and
// src/run_client.py, and the fixed list of entry names knew none of the three.
test("the entry file is found by what it does, not by a list of twelve names", () => {
  const root = tree({
    "pyproject.toml": "[project]\ndependencies = [\"fastapi\", \"langgraph\"]\n",
    "src/run_agent.py": "if __name__ == \"__main__\":\n    asyncio.run(main())\n",
    "src/run_service.py": "import uvicorn\nif __name__ == \"__main__\":\n    uvicorn.run(\"service:app\", port=8080)\n",
  });
  assert.equal(startPlan({ root, onPath }).cmd, "python3 src/run_service.py");
});

// camel, swarm and the crewai examples: packages and terminal scripts, no server anywhere. Starting
// the best-looking script put a chat loop on no port and reported a missing import as the reason.
test("a repository with nothing that serves says so instead of starting a script", () => {
  const scripts = tree({
    "pyproject.toml": "[project]\nname = \"lib\"\n",
    "examples/bot/requirements.txt": "qdrant-client\n",
    "examples/bot/main.py": "import qdrant_client\nif __name__ == \"__main__\":\n    run_demo_loop()\n",
  });
  assert.deepEqual(startPlan({ root: scripts, onPath }), { cmd: null, cwd: scripts, noServer: true });
  const lib = tree({ "pyproject.toml": "[project]\nname = \"camel-ai\"\n" });
  assert.equal(startPlan({ root: lib, onPath }).noServer, true);
});

test("a backend whose entry only re-exports the app is started, and beats the frontend beside it", () => {
  const root = tree({
    "pyproject.toml": "[tool.ruff]\nline-length = 100\n",
    "backend/requirements.txt": "fastapi==0.1\nuvicorn\nopenai\n",
    "backend/app/main.py": "from .application import (\n    app,\n    create_app,\n)\n\n__all__ = ['app']\n",
    "backend/app/application.py": "from fastapi import FastAPI\n\ndef create_app():\n    return FastAPI()\n\napp = create_app()\n",
    "backend/.venv/bin/python": "",
    "frontend/package.json": JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "6" } }),
  });
  const plan = startPlan({ root, onPath });
  assert.equal(plan.within, "backend");
  assert.match(plan.cmd, new RegExp(`^${JSON.stringify(join(root, "backend/.venv/bin/python")).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} -m uvicorn app\.(?:main|application):app --host 127\.0\.0\.1 --port 8000$`));
  assert.equal(plan.unsure, undefined);
});

test("an app bound from a factory is served by the server its manifest names", () => {
  const root = tree({ "requirements.txt": "flask\nopenai\n", "server.py": "from factory import make\napp = make()\n" });
  assert.equal(startPlan({ root, onPath }).cmd, "python3 -m flask --app server:app run --port 5000");
});

test("a package whose dev script only bundles the page starts its server script instead", () => {
  const root = tree({ "package.json": JSON.stringify({ scripts: { dev: "vite", server: "node server.js", start: "node server.js" }, dependencies: { express: "5", openai: "4", react: "19" }, devDependencies: { vite: "7" } }) });
  assert.equal(startPlan({ root, onPath }).cmd, "npm run server");
  const both = tree({ "package.json": JSON.stringify({ scripts: { dev: "vite", "dev:full": "concurrently \"npm run server\" \"npm run dev\"", server: "node server.js" }, dependencies: { express: "5", openai: "4" } }) });
  assert.equal(startPlan({ root: both, onPath }).cmd, "npm run dev:full");
  const plain = tree({ "package.json": JSON.stringify({ scripts: { dev: "vite" }, dependencies: { react: "19" } }) });
  assert.equal(startPlan({ root: plain, onPath }).cmd, "npm run dev", "a page with no server keeps its dev script");
});

test("a Python package with a serve command in its console script starts through it", () => {
  const root = tree({
    "pyproject.toml": "[project]\nname = \"repowiki\"\ndependencies = [\"fastapi\", \"litellm\"]\n\n[project.scripts]\nrepowiki = \"repowiki.cli:main\"\n",
    "src/repowiki/cli.py": "import typer\napp = typer.Typer()\n\n@app.command()\ndef serve(port: int = typer.Option(8000, '--port')):\n    pass\n",
    ".venv/bin/python": "", ".venv/bin/repowiki": "",
  });
  assert.equal(startPlan({ root, onPath }).cmd, `${JSON.stringify(join(root, ".venv/bin/repowiki"))} serve --port 8000`);
});

test("a root that holds a Python app and its page in one package.json starts the app", () => {
  const root = tree({
    "package.json": JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "7" } }),
    "requirements.txt": "fastapi\nopenai\n", "main.py": "from fastapi import FastAPI\napp = FastAPI()\n", ".venv/bin/python": "",
  });
  assert.match(startPlan({ root, onPath }).cmd, /uvicorn main:app/);
});

// One customer, 2026-10-06: a start command typed at the repository's root was past the length the
// server keeps, and the registration was refused as "port is required" on port 3002.
test("the start command leaves the machine cut to the length the server keeps, with no value typed into it", () => {
  const typed = `cd apps/api && DATABASE_URL=postgres://app:hunter22@db.internal:5432/app REDIS_URL='redis://:p4ss@cache:6379/0' NODE_ENV=development PORT=3002 bun run --hot src/index.ts ${"--flag ".repeat(40)}`;
  const shown = shownCommand(typed);
  assert.equal(shown.length, 200);
  assert.ok(shown.startsWith("cd apps/api && DATABASE_URL=*** REDIS_URL=*** NODE_ENV=development PORT=3002 bun run --hot src/index.ts"));
  assert.ok(!/hunter22|p4ss/.test(shown));
  assert.equal(shownCommand(null), null);
});

