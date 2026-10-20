import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { credentialShaped, environmentSecrets, maskedLines, maskWith, secretValues } from "./env-secrets.mjs";

test("a model's name is shown and priced; keys, and a key under a model's name, stay masked", () => {
  const file = join(mkdtempSync(join(tmpdir(), "env-secrets-")), ".env");
  writeFileSync(file, [
    "OPENAI_MODEL=accounts/fireworks/models/glm-5p3-flash",
    "MODEL_PROVIDER=openai",
    "OPENAI_API_KEY=sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c",
    "EMBED_MODEL=abcdefghijklmnopqrstuvwxyz0123456789",
    "DATABASE_URL=postgres://app:hunter2hunter2@db:5432/app",
  ].join("\n"));
  const masked = secretValues([file]);
  assert.ok(!masked.includes("accounts/fireworks/models/glm-5p3-flash"));
  assert.ok(!masked.includes("openai"));
  assert.ok(masked.includes("sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c"));
  assert.ok(masked.includes("abcdefghijklmnopqrstuvwxyz0123456789"));
  assert.ok(masked.includes("postgres://app:hunter2hunter2@db:5432/app"));
});

// A request dump with a long context and the app's key, one JSON line past the size kept whole, with
// the pipe's chunk ending inside the key: both halves were written unmasked, a newline between them.
test("a line too long to keep whole goes on early, never cut inside a value and with nothing added", () => {
  const key = "sk-proj-Q7vQ7vQ7vQ7vQ7vQ7vQ7vQ7vQ7vQ7vx9";
  assert.equal(key.length, 40);
  const line = `${"a".repeat(19_980)}${key}${"b".repeat(19_980)}`;
  const wrote = [];
  const write = maskedLines(() => [key], (text) => wrote.push(text));
  write(Buffer.from(line.slice(0, 20_000)));
  write(Buffer.from(`${line.slice(20_000)}\n`));
  assert.ok(wrote.length === 2 && wrote[0].length < 20_000, "the cut came before the line ended");
  assert.equal(wrote.join(""), `${line.replace(key, "[masked]")}\n`);
});

// One customer's twin: MONGO_DB=research made every route table path read /v2/[masked]/ask, and the trial
// of that door answered 404 while the person's own request answered. A configuration word is a route
// word; a credential is not.
test("a configuration word is not masked out of a route table, a credential still is", () => {
  const key = "sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c";
  const values = ["research", "hunter2hunter2", key];
  const routes = JSON.stringify({ routes: [{ method: "POST", path: `/v2/research/ask?k=${key}` }] });
  const masked = maskWith(routes, values.filter(credentialShaped));
  assert.ok(masked.includes("/v2/research/ask"), "the route word stands");
  assert.ok(!masked.includes(key), "the key is masked");
  assert.ok(!credentialShaped("research") && !credentialShaped("albaheth corpus"));
  assert.ok(credentialShaped("hunter2hunter2") && credentialShaped(key) && credentialShaped("abcdefghijklmnopqrstuvwxyz"));
});

// Their shape: no env file in the repository at all. The settings are applied to a folder beside it
// and sourced by the start command, and one more secret is exported into the shell that runs it. We
// read neither, so their own app printed both back into what we keep and what we send.
test("a secret handed in through the shell is masked, and a setting, a path and a port are not", () => {
  const masked = environmentSecrets({
    MODEL_API_KEY: "mk_live_9Xq2Lp7Vz4Rt8Bw1Yd6Me",
    NITHAM_SERVICE_TOKEN: "ntm_s3cr3t_7Kq2Lp9Vx4Rz8Bw1Yd6Me",
    OPENAI_API_KEY: "short",
    AWS_SECRET_ACCESS_KEY: "/opt/nitham/credentials",
    SESSION_TOKEN: "aaaaaaaaaaaaaaaaaaaa",
    MONGO_DB: "research",
    PORT: "8810",
  });
  assert.deepEqual(masked.sort(), ["mk_live_9Xq2Lp7Vz4Rt8Bw1Yd6Me", "ntm_s3cr3t_7Kq2Lp9Vx4Rz8Bw1Yd6Me"]);
  const file = join(mkdtempSync(join(tmpdir(), "env-shell-")), ".env");
  writeFileSync(file, "OPENAI_API_KEY=sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c\n");
  const values = secretValues([file], masked);
  assert.ok(values.includes("mk_live_9Xq2Lp7Vz4Rt8Bw1Yd6Me") && values.includes("sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c"));
  assert.deepEqual(values, [...values].sort((a, b) => b.length - a.length), "longest first, so one value inside another is masked whole");
});
