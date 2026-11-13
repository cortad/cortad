import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

export const PAGE_CHARS = 9000;
export const SIDE = { theirs: "on the app's side" };

export const has = (v) => v !== undefined && v !== null;
export const num = (x) => (typeof x === "number" ? Math.round(x).toLocaleString("en-US") : String(x));
export const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
export const upper = (s) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

export const clock = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

export const pressedLine = (d) => (d?.pressedAt
  ? `The person pressed Start simulation on Cortad's page at ${clock(d.pressedAt)}: their simulation ${d.of ? `is playing, with ${plural(d.of, "simulated user")}` : "has started"}.`
  : null);

export const modelSaid = (m) => String(m).split("/").filter(Boolean).at(-1) ?? String(m);

export const closeToCall = (n, said = {}) => { const band = said.close ? "" : " (between 35 and 85 in 100)"; said.close = true; return `${num(n)} too close to call${band}`; };

const linesIn = (path) => {
  const root = process.cwd();
  const file = resolve(root, path);
  if (file !== root && !file.startsWith(`${root}${sep}`)) return null;
  try { return readFileSync(file, "utf8").split("\n").length; } catch { return null; }
};
export const at = (path, line) => {
  const n = has(line) && line > 0 && path ? linesIn(path) : null;

  return `${path}${has(line) && line > 0 && !(n !== null && line > n) ? `:${line}` : ""}`;
};
export const clip = (s, max) => (String(s).length > max ? `${String(s).slice(0, max - 3)}...` : String(s));

export function pageOf(pages, page, next) {
  const n = Math.min(Math.max(1, Math.floor(Number(page)) || 1), pages.length);
  const tail = pages.length === 1 ? "" : n < pages.length ? `\npage ${n} of ${pages.length}, call ${next(n + 1)}` : `\npage ${n} of ${pages.length}`;
  return `${pages[n - 1]}${tail}`;
}

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
