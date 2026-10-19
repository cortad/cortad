import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// An env file the start command itself names, wherever it lives: --env-file, dotenv -f, a file
// sourced into the shell, or one read in with $(cat ...). Secrets kept in a folder outside the
// repository are how a provisioned machine gets them, and a value we never read is a value we
// cannot hide in what leaves. A path built from a variable is left alone rather than guessed at.
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

// An env file read the way dotenv and python-dotenv read one: comments and `export` dropped, a quoted
// value kept whole across lines, an unquoted one cut at " #", ${NAME} filled from the names above it
// and then from `outer`. A bare $ is kept as written, as dotenv keeps it: "pa$$word" and a bcrypt hash
// are values, not references. A quote that never closes is the line as written. A line-by-line read
// handed an app the first line of a quoted PEM key and an unquoted value with its comment still on it.
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
// One past the closing quote, or 0 when the value has none yet. A double quote escaped by a backslash
// does not close it.
function closes(body, quote) {
  for (let i = 0; i < body.length; i++) {
    if (quote === '"' && body[i] === "\\") { i++; continue; }
    if (body[i] === quote) return i + 1;
  }
  return 0;
}
