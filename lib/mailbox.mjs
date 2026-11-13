import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ID = /^[a-z0-9]{8,32}$/;

export function mailbox(name) {
  const askFile = (home) => join(home, `${name}-ask.json`);
  const answerFile = (home, id) => join(home, `${name}-${id}.json`);
  return {
    file: `${name}-ask.json`,

    async ask(home, body, { waitMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
      const id = Math.random().toString(36).slice(2, 12).padEnd(8, "0");
      const tmp = join(home, `${name}-ask.json.${id}`);
      writeFileSync(tmp, JSON.stringify({ ...body, id }), { mode: 0o600 });
      renameSync(tmp, askFile(home));
      const file = answerFile(home, id);
      for (const end = Date.now() + waitMs; Date.now() < end; await sleep(250)) {
        if (!existsSync(file)) continue;
        try { const { text } = JSON.parse(readFileSync(file, "utf8")); rmSync(file, { force: true }); return { text }; } catch {  }
      }
      return null;
    },

    take(home) {
      const file = askFile(home);
      if (!existsSync(file)) return null;
      let ask = null;
      try { ask = JSON.parse(readFileSync(file, "utf8")); } catch {  return null; }
      rmSync(file, { force: true });

      const stale = new RegExp(`^${name}-[a-z0-9]+\\.json$`);
      for (const f of readdirSync(home)) if (stale.test(f)) rmSync(join(home, f), { force: true });
      return ID.test(String(ask?.id)) ? ask : null;
    },
    answer(home, id, text) {
      const tmp = `${answerFile(home, id)}.tmp`;
      writeFileSync(tmp, JSON.stringify({ text }), { mode: 0o600 });
      renameSync(tmp, answerFile(home, id));
    },
  };
}
