// The layer chooses a file as holding a prompt when the code that calls a model takes a string from it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { layerOf } from "./layer.mjs";

const SYSTEM = "You are the support assistant for Acme Shop. Answer questions about orders, refunds and delivery.";
const REFUND = "You handle refund requests. Ask for the order number first, then check the order status.";
const chosen = (files) => layerOf(Object.entries(files).map(([path, full]) => ({ path, head: full.slice(0, 4000), size: Buffer.byteLength(full), full })));

test("a JS model call's imported prompt module and the template it reads from disk are prompts", () => {
  const layer = chosen({
    "package.json": JSON.stringify({ name: "shop", dependencies: { openai: "4.0.0" } }),
    "src/server.js": 'import express from "express";\nimport { answer } from "./agent.js";\nconst app = express();\napp.post("/api/chat", async (req, res) => res.json({ reply: await answer(req.body.message) }));\napp.listen(3000);\n',
    "src/agent.js": [
      'import OpenAI from "openai";',
      'import { readFileSync } from "node:fs";',
      'import { SYSTEM_PROMPT } from "./prompts/index.js";',
      "const client = new OpenAI();",
      'const REFUND = readFileSync(new URL("./prompts/refund.txt", import.meta.url), "utf8");',
      'const ORDERS = readFileSync(new URL("./data/orders.csv", import.meta.url), "utf8");',
      "export async function answer(question, refund = false) {",
      '  const res = await client.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "system", content: refund ? REFUND : SYSTEM_PROMPT }, { role: "user", content: question + ORDERS }] });',
      "  return res.choices[0].message.content;",
      "}",
    ].join("\n"),
    "src/prompts/index.js": 'export { SYSTEM_PROMPT } from "./system.js";\n',
    "src/prompts/system.js": `export const SYSTEM_PROMPT = \`${SYSTEM}\`;\n`,
    "src/prompts/refund.txt": `${REFUND}\n`,
    "src/data/orders.csv": "id,total\n1,20\n",
  });
  assert.equal(layer.why.get("src/prompts/system.js"), "prompt");
  assert.equal(layer.why.get("src/prompts/refund.txt"), "prompt");
  assert.equal(layer.why.get("src/data/orders.csv"), undefined);
});

test("a Python model call's imported prompt module and the template it reads from disk are prompts", () => {
  const layer = chosen({
    "requirements.txt": "openai\nfastapi\n",
    "app/__init__.py": "",
    "app/main.py": 'from fastapi import FastAPI\nfrom app.agent import answer\napp = FastAPI()\n\n@app.post("/api/chat")\ndef chat(body: dict):\n    return {"reply": answer(body["message"])}\n',
    "app/agent.py": [
      "from pathlib import Path",
      "from openai import OpenAI",
      "from .prompts import SYSTEM_PROMPT",
      "client = OpenAI()",
      'REFUND = (Path(__file__).parent / "prompts" / "refund.txt").read_text()',
      "",
      "def answer(question, refund=False):",
      '    res = client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "system", "content": REFUND if refund else SYSTEM_PROMPT}, {"role": "user", "content": question}])',
      "    return res.choices[0].message.content",
    ].join("\n"),
    "app/prompts/__init__.py": "from .system import SYSTEM_PROMPT\n",
    "app/prompts/system.py": `SYSTEM_PROMPT = """${SYSTEM}"""\n`,
    "app/prompts/refund.txt": `${REFUND}\n`,
  });
  assert.equal(layer.why.get("app/prompts/system.py"), "prompt");
  assert.equal(layer.why.get("app/prompts/refund.txt"), "prompt");
});
