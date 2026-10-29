// JUnit, so any CI shows the failures in its own test panel without being taught anything.
// A question nothing settled is skipped, not failed: a run that could not decide is not a red build.
import { failed, settled } from "../answer/verdict.mjs";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function asJunit(result) {
  const all = result.run.conversations.flatMap((c) => c.ruled.map((r) => ({ ...r, who: c.who, conversation: c.id })));
  const broke = all.filter(failed);
  const skipped = all.filter((r) => !settled(r.got));
  const errors = result.errors;
  const cases = [
    ...all.map((r) => {
      const name = `${r.conversation}: ${r.ask}`;
      if (!settled(r.got)) return `    <testcase classname="cortad" name="${esc(name)}"><skipped message="${esc(r.got)}"/></testcase>`;
      if (!failed(r)) return `    <testcase classname="cortad" name="${esc(name)}"/>`;
      return `    <testcase classname="cortad" name="${esc(name)}"><failure message="${esc(`wanted ${r.wanted}, got ${r.got}`)}">${esc(`${r.why}\n${r.quote}`)}</failure></testcase>`;
    }),
    ...errors.map((e) => `    <testcase classname="cortad" name="${esc(`${e.id}: never answered`)}"><failure message="${esc(e.error)}"/></testcase>`),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="cortad" tests="${cases.length}" failures="${broke.length + errors.length}" skipped="${skipped.length}">
${cases.join("\n")}
  </testsuite>
</testsuites>
`;
}
