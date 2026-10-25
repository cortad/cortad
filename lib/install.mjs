// A random id kept on this machine so a day's runs can be counted and capped. It is not an account
// and it is not derived from anything about the person or the machine: a new one is a deleted file
// away, and nothing is lost by deleting it.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = () => join(process.env.CORTAD_HOME ?? homedir(), ".cortad");
const file = () => join(dir(), "install");
const ID = /^[0-9a-f-]{36}$/;

export function installId() {
  try {
    const kept = readFileSync(file(), "utf8").trim();
    if (ID.test(kept)) return kept;
  } catch { /* first run on this machine */ }
  const made = randomUUID();
  try {
    mkdirSync(dir(), { recursive: true, mode: 0o700 });
    writeFileSync(file(), made, { mode: 0o600 });
  } catch { /* a machine that cannot keep it gets a new one each run, which only costs it the cap */ }
  return made;
}
