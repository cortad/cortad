import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const NAMED_FILE = /(?:--env-file[= ]|--dotenv[= ]|-f\s+|\bsource\s+|(?:^|[;&|(]\s*)\.\s+|\bcat\s+)(["']?)([~\w./-]+)\1/g;

export function envFilesNamedIn(command, cwd) {
  const out = [];
  for (const m of String(command ?? "").matchAll(NAMED_FILE)) {
    const said = m[2].replace(/^~(?=\/|$)/, homedir());
    const full = isAbsolute(said) ? said : join(cwd, said);
    if (!out.includes(full) && existsSync(full)) out.push(full);
  }
  return out;
}

export function parseEnv(text, outer = {}) {
  const out = {};
  const fill = (value) => value.replace(/(\\?)\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, escaped, name) => (escaped ? whole.slice(1) : out[name] ?? outer[name] ?? ""));
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const rest = m[2];
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      let body = rest.slice(1);
      let j = i;
      while (!closes(body, quote) && j + 1 < lines.length) body += `\n${lines[++j]}`;
      const end = closes(body, quote);
      if (end) {
        i = j;
        const raw = body.slice(0, end - 1);
        out[m[1]] = quote === "'" ? raw : fill(raw).replace(/\\n/g, "\n").replace(/\\(["\\$])/g, "$1");
        continue;
      }
    }
    out[m[1]] = fill(rest.replace(/\s+#.*$/, "").trim());
  }
  return out;
}

function closes(body, quote) {
  for (let i = 0; i < body.length; i++) {
    if (quote === '"' && body[i] === "\\") { i++; continue; }
    if (body[i] === quote) return i + 1;
  }
  return 0;
}
