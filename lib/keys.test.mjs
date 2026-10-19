import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { envFilesNamedIn } from "./env-files.mjs";
import { holdsKeys, secretEnvValues } from "./keys.mjs";

test("a file carrying a key is kept, code that reads one from the environment is not", () => {
  assert.ok(holdsKeys('[{"guid":"a1","playlist":"https://x/p.m3u8","aesKey":"9f86d081884c7d659a2feaa0c55ad015"}]'));
  assert.ok(holdsKeys("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MfszSEX8"));
  assert.ok(holdsKeys('const client = new OpenAI({ apiKey: "sk-proj-4eC39HqLyjWDarjtT1zdp7dc" })'));
  assert.ok(holdsKeys("DB=postgres://u:hunter2hunter2@db/x", ["hunter2hunter2"]));
  assert.ok(!holdsKeys("const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })"));
  assert.ok(!holdsKeys('{"name":"app","version":"1.0.0","scripts":{"dev":"next dev"}}'));
  assert.ok(!holdsKeys('const tokenLimit = 4096; const keyName = "OPENAI_API_KEY";'));
});

test("only secret-named values from real env files are looked for", () => {
  const files = { ".env": "OPENAI_API_KEY=sk-live-value-123456\nBUCKET=documents-bucket-01\n", ".env.example": "STRIPE_SECRET=your-secret-here-please\n" };
  assert.deepEqual(secretEnvValues(Object.keys(files), (f) => files[f]), ["sk-live-value-123456"]);
});

test("code that names or looks for a key is not a key", () => {
  assert.ok(!holdsKeys('if (pem.includes("-----BEGIN PRIVATE KEY-----")) return pem;'));
  assert.ok(!holdsKeys('const fake = "sk-live-should-never-leak-anywhere";'));
  assert.ok(holdsKeys('"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7"'));
});

// A start command that brings the settings in from outside the repository: `set -a; . ../secrets/
// api.env`, `--env-file`, `dotenv -f`, `$(cat ...)`. A file we never read is a file whose values we
// cannot hide, and a provisioned machine keeps them nowhere else.
test("env files the start command names are found wherever they live, and an unwritten one is not", () => {
  const base = mkdtempSync(join(tmpdir(), "named-env-"));
  mkdirSync(join(base, "repo"));
  mkdirSync(join(base, "secrets"));
  writeFileSync(join(base, "secrets", "api.env"), "MODEL_API_KEY=mk_live_9Xq2Lp7Vz4Rt8Bw1Yd6Me\n");
  writeFileSync(join(base, "repo", ".env.staging"), "PORT=8810\n");
  const repo = join(base, "repo");
  assert.deepEqual(envFilesNamedIn("set -a; . ../secrets/api.env; set +a; poetry run python main.py", repo), [join(base, "secrets", "api.env")]);
  assert.deepEqual(envFilesNamedIn("node --env-file=.env.staging server.js", repo), [join(repo, ".env.staging")]);
  assert.deepEqual(envFilesNamedIn("dotenv -f ../secrets/api.env -- npm run dev", repo), [join(base, "secrets", "api.env")]);
  assert.deepEqual(envFilesNamedIn("env $(cat ../secrets/api.env | xargs) python main.py", repo), [join(base, "secrets", "api.env")]);
  assert.deepEqual(envFilesNamedIn("poetry run python main.py", repo), []);
  assert.deepEqual(envFilesNamedIn("node --env-file=/etc/nitham/never-written.env server.js", repo), []);
});
