// SARIF, so a failed question lands on a line in the pull request instead of in a log somebody has
// to go and open.
//
// Where it lands: the file the app's own trace names, when the question was answered from the trace.
// Otherwise the simulation file, which is a real file in their repository and the place a reader
// goes to see what was asked. Never a guessed line in their prompt.
import { ABSENT, UNKNOWN } from "../answer/verdict.mjs";
import { DIR } from "../suite/files.mjs";

const where = (conversation, ruled) => {
  const from = (conversation.events ?? []).find((e) => ruled.by === "trace" && typeof e?.from === "string")?.from;
  if (from) {
    const [file, line] = from.split(":");
    return { file, line: Number(line) || 1 };
  }
  return { file: `${DIR}/${conversation.id}.json`, line: 1 };
};

export function asSarif(result) {
  const results = [];
  for (const one of result.run.conversations) {
    for (const r of one.ruled) {
      if (r.got === r.wanted || r.got === UNKNOWN || r.got === ABSENT) continue;
      const at = where(one, r);
      results.push({
        ruleId: "cortad/question",
        level: "error",
        message: { text: `${r.ask}: wanted ${r.wanted}, got ${r.got}. ${r.why}`.trim() },
        locations: [{ physicalLocation: { artifactLocation: { uri: at.file }, region: { startLine: at.line } } }],
        partialFingerprints: { question: r.id },
      });
    }
    if (one.error) {
      results.push({
        ruleId: "cortad/no-answer",
        level: "error",
        message: { text: `${one.id} never got an answer: ${one.error}` },
        locations: [{ physicalLocation: { artifactLocation: { uri: `${DIR}/${one.id}.json` }, region: { startLine: 1 } } }],
      });
    }
  }
  return JSON.stringify({
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "Cortad", informationUri: "https://cortad.com", rules: [
        { id: "cortad/question", shortDescription: { text: "A question about your app's replies was answered the wrong way." } },
        { id: "cortad/no-answer", shortDescription: { text: "Your app never answered, so nothing was tested." } },
      ] } },
      results,
    }],
  }, null, 2);
}
