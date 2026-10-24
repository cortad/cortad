import { test } from "node:test";
import assert from "node:assert/strict";
import { startCause } from "./start-cause.mjs";

test("a failed start names its cause from the app's own words, or nothing", () => {
  assert.match(startCause("psycopg2.OperationalError: connection to server at \"127.0.0.1\", port 5432 failed: Connection refused\n    Is the server running"), /port 5432/);
  assert.match(startCause("Error: connect ECONNREFUSED 127.0.0.1:6379\n    at TCPConnectWrap"), /port 6379/);
  assert.match(startCause("pymongo.errors.ServerSelectionTimeoutError: db.internal:27017: [Errno 8] nodename nor servname provided"), /resolve the host db\.internal/);
  assert.match(startCause("Error: getaddrinfo ENOTFOUND qdrant.svc"), /resolve the host qdrant\.svc/);
  assert.match(startCause("  File \"app/settings.py\", line 12\nKeyError: 'OPENAI_API_KEY'"), /missing the setting OPENAI_API_KEY/);
  assert.match(startCause("Error: Missing required environment variable DATABASE_URL"), /missing the setting DATABASE_URL/);
  assert.match(startCause("ModuleNotFoundError: No module named 'litellm'"), /missing the package litellm/);
  assert.match(startCause("FATAL:  password authentication failed for user \"app\""), /refused its credentials/);
  assert.equal(startCause("Traceback (most recent call last):\n  ZeroDivisionError: division by zero"), null);
  assert.equal(startCause(""), null);
});
