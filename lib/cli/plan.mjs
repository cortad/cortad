// Writing the first simulations. One call, and what comes back lands in their repository as files
// they own. Nothing is kept on our side that they need to run again.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeUsers } from "../hosted.mjs";
import { DIR, write } from "../suite/files.mjs";
import { tierOf } from "../suite/tiers.mjs";

// The format lands beside the files, so the person or the agent editing one has it open without
// going anywhere. The trace is a local recording, not something to commit.
function explain(root) {
  const dir = join(root, DIR);
  mkdirSync(dir, { recursive: true });
  copyFileSync(new URL("../../docs/simulations.md", import.meta.url), join(dir, "README.md"));
  writeFileSync(join(root, "cortad", ".gitignore"), "trace.jsonl\n");
}

export async function plan({ root = ".", schema, count = 20 }) {
  const cases = await writeUsers(schema, count);
  explain(root);
  const written = [];
  for (const one of cases) {
    const simulation = { id: one.id, who: one.title, says: one.turns, questions: one.questions };
    written.push({ at: write(simulation, root), id: one.id, tier: tierOf(simulation), questions: one.questions.length });
  }
  return written;
}
