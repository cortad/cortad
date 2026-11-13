import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

// The small pieces every rendering shares: numbers with their units, file and line, whose side a
// stop is on, and the pages a long answer is cut into.

// Copilot cuts a result past about 10 KB; a page stays under this.
export const PAGE_CHARS = 9000;
export const SIDE = { theirs: "on the app's side" };

export const has = (v) => v !== undefined && v !== null;
export const num = (x) => (typeof x === "number" ? Math.round(x).toLocaleString("en-US") : String(x));
export const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
export const upper = (s) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
// A moment as this machine's clock shows it, "08:45": the agent says it to the person beside it.
export const clock = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
// A simulation the person started from the browser, said as the fact it is, with when and how many
// simulated users it plays: one that began unannounced was taken by their agent as one nobody had
// approved, and it asked them to hold off while it played (2026-11-13).
export const pressedLine = (d) => (d?.pressedAt
  ? `You pressed Start simulation on Cortad's page at ${clock(d.pressedAt)}: your simulation ${d.of ? `is playing, with ${plural(d.of, "simulated user")}` : "has started"}.`
  : null);
// A provider's full model path (accounts/fireworks/models/glm-5p3) is read by its last part, the name.
export const modelSaid = (m) => String(m).split("/").filter(Boolean).at(-1) ?? String(m);
// A reading between 35 and 85 in 100 is too close to call; a block says that band the first time.
export const closeToCall = (n, said = {}) => { const band = said.close ? "" : " (between 35 and 85 in 100)"; said.close = true; return `${num(n)} too close to call${band}`; };
// A line past the end of the file as it stands on this machine is not an address: the file moved
// on since it was read, and an agent was sent to line 204 of a 172-line file. The file stays.
// Read each time, never kept: the agent edits these files while this server runs. Only a path
// inside the project is opened, and only its length is used.
const linesIn = (path) => {
  const root = process.cwd();
  const file = resolve(root, path);
  if (file !== root && !file.startsWith(`${root}${sep}`)) return null;
  try { return readFileSync(file, "utf8").split("\n").length; } catch { return null; }
};
export const at = (path, line) => {
  const n = has(line) && line > 0 && path ? linesIn(path) : null;
  // A line of 0 is no line: "finding at :0" read to an agent as an address that pointed nowhere.
  return `${path}${has(line) && line > 0 && !(n !== null && line > n) ? `:${line}` : ""}`;
};
export const clip = (s, max) => (String(s).length > max ? `${String(s).slice(0, max - 3)}...` : String(s));

// One page of many, with the call that reads the next one: `next(2)` gives "findings with page 2".
export function pageOf(pages, page, next) {
  const n = Math.min(Math.max(1, Math.floor(Number(page)) || 1), pages.length);
  const tail = pages.length === 1 ? "" : n < pages.length ? `\npage ${n} of ${pages.length}, call ${next(n + 1)}` : `\npage ${n} of ${pages.length}`;
  return `${pages[n - 1]}${tail}`;
}

// Lines packed into pages under PAGE_CHARS; every page after the first opens with `continued`.
export function pack(head, lines, continued, budget = PAGE_CHARS - 80) {
  const pages = [];
  let page = head;
  let filled = false;
  for (const line of lines) {
    if (filled && page.length + line.length + 1 > budget) {
      pages.push(page);
      page = continued;
      filled = false;
    }
    page += `\n${line}`;
    filled = true;
  }
  return [...pages, page];
}
