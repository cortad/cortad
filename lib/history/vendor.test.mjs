import assert from "node:assert/strict";
import { test } from "node:test";
import { addressOf, answered, grouped, msOf, rootOf, threadIn } from "./vendor.mjs";

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("a vendor's key goes only to https, or to http on this computer", () => {
  assert.equal(rootOf("https://api.example.com/opik/api/?x=1#y"), "https://api.example.com/opik/api");
  assert.equal(rootOf("http://localhost:6006/"), "http://localhost:6006");
  assert.equal(rootOf("http://127.0.0.1:6006"), "http://127.0.0.1:6006");
  assert.throws(() => addressOf("http://phoenix.internal:6006"), /^Error: phoenix\.internal:6006 is not reached over https$/);
  assert.throws(() => addressOf("https://me:secret@api.example.com"), /not a plain URL/, "a password in the address is never sent on");
  assert.throws(() => addressOf("api.example.com"), /not a plain URL/);
});

test("a 429 is waited out as the vendor asks, a refusal names whose keys, and any other failure names its status", async () => {
  const url = "https://api.example.com/v1/x";
  let calls = 0;
  const busyTwice = async () => (++calls <= 2 ? json({}, 429, { "retry-after": "0" }) : json({ ok: true }));
  assert.deepEqual(await answered(busyTwice, url, {}, "LANGSMITH"), { ok: true });
  assert.equal(calls, 3);

  calls = 0;
  const alwaysBusy = async () => { calls += 1; return json({}, 429, { "retry-after": "0" }); };
  await assert.rejects(answered(alwaysBusy, url, {}, "LANGSMITH"), /^Error: api\.example\.com answered 429$/);
  assert.equal(calls, 4, "a few tries, then the 429 is said");

  await assert.rejects(answered(async () => json({}, 401), url, {}, "LANGSMITH"), /^Error: api\.example\.com refused the LANGSMITH keys in your env$/);
  await assert.rejects(answered(async () => json({}, 403), url, {}, "OPIK"), /refused the OPIK keys/);
  await assert.rejects(answered(async () => json({}, 403), url, {}, null), /^Error: api\.example\.com answered 403$/, "no keys went to a signed URL");
  await assert.rejects(answered(async () => json({}, 500), url, {}, "OPIK"), /^Error: api\.example\.com answered 500$/);
});

test("turns become conversations: a session's turns together, a turn with none alone, a turn with no text counted", () => {
  const { conversations, withoutText } = grouped([
    { conversation: "s1", user: "u1", at: "2026-11-02T10:00:00Z", question: " Is it in stock? ", answer: "Yes." },
    { conversation: "t9", at: "2026-11-02T09:00:00+02:00", question: "Hours?", answer: "" },
    { conversation: "s1", at: "2026-11-01 10:00:00.250", question: "Hi", answer: "Hello" },
    { conversation: "t8", at: "2026-11-01T08:00:00Z", question: "", answer: "  " },
  ]);
  assert.equal(withoutText, 1);
  assert.deepEqual(conversations, [
    { id: "s1", user: "u1", messages: [
      { role: "user", text: "Is it in stock?", at: "2026-11-02T10:00:00.000Z" },
      { role: "assistant", text: "Yes.", at: "2026-11-02T10:00:00.001Z" },
      { role: "user", text: "Hi", at: "2026-11-01T10:00:00.250Z" },
      { role: "assistant", text: "Hello", at: "2026-11-01T10:00:00.251Z" },
    ] },
    { id: "t9", messages: [{ role: "user", text: "Hours?", at: "2026-11-02T07:00:00.000Z" }] },
  ]);
  assert.equal(msOf("2025-08-16 00:31:37.520"), Date.parse("2025-08-16T00:31:37.520Z"), "a time with no zone is UTC, never this machine's");
  assert.equal(threadIn({ conversation_id: "c", user_id: "u" }), "c");
  assert.equal(threadIn({ thread_id: "" }), null);
});
