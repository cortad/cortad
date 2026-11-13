import assert from "node:assert/strict";
import { test } from "node:test";
import { CASES } from "./redact-cases.mjs";
import { redactWith, scrub, scrubValue } from "./redact.mjs";

// What must be gone: the whole value, and every run of two or more digits in it, so a date cut to
// "[redacted] March 2011" does not pass for one taken out.
const left = (out, gone) => gone.filter((g) => out.includes(g) || (g.match(/[\d٠-٩۰-۹]{2,}/g) ?? []).some((run) => out.includes(run)));

test("Cortad's rules take every phone, ID, seat number, email, handle, date of birth and address out of students' messages", () => {
  assert.ok(CASES.filter((c) => !c.kept).length >= 60);
  for (const c of CASES) {
    const out = scrub(c.text).text;
    if (c.kept) assert.equal(out, c.text, "a message with nothing personal is sent as written");
    else assert.deepEqual(left(out, c.gone), [], `${c.text} -> ${out}`);
  }
});

test("a name written in a sentence is not removed by the rules, which is why the person's own step exists", () => {
  assert.match(scrub("my name is Ahmad Khaled, I am in grade 9").text, /Ahmad Khaled/);
});

test("a tool call's arguments lose what their names say is private, and every other value is scrubbed", () => {
  const out = scrubValue({ student: { full_name: "Sara Ali", phone: "0791234567", grade: 9 }, note: "reach me at sara@x.io", password: "hunter2" });
  assert.deepEqual(out, { student: { full_name: "[redacted:full_name]", phone: "[redacted:phone]", grade: 9 }, note: "reach me at [redacted:email]", password: "[redacted:password]" });
  assert.equal(scrubValue('{"national_id":"9861234567","q":"x"}'), '{"national_id":"[redacted:national_id]","q":"x"}', "a result kept as JSON text is opened");
});

test("the person's own step gets every text and gives each one back; anything else stops the send", () => {
  const names = `node -e 'require("readline").createInterface({input:process.stdin}).on("line",(l)=>console.log(JSON.stringify({text:JSON.parse(l).text.replace(/Sara/g,"[name]")})))'`;
  assert.deepEqual(redactWith(names, ["hi Sara", "ok"]), ["hi [name]", "ok"]);
  assert.throws(() => redactWith("exit 3", ["a"]), /ended with code 3/);
  assert.throws(() => redactWith("echo '{\"text\":\"a\"}'", ["a", "b"]), /gave back 1 lines for 2/);
  assert.throws(() => redactWith("echo nope", ["a"]), /not JSON/);
});
