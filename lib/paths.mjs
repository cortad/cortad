import { realpathSync } from "node:fs";

const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Every path as the project sees it, for anything that leaves this machine: the project folder is
// ".", a file in it is its path from there, and the home folder is "~", so neither the folder's
// place nor the user's name goes with it. Longest form first: on a Mac /private/var/x holds /var/x,
// and the shorter one taken first would leave "/private" behind.
export function relativePaths(text, { root, home }) {
  const forms = [[root, "."], [home, "~"]]
    .flatMap(([p, as]) => (p && p !== "/" ? [...new Set([p, real(p)])].map((form) => [form.replace(/\/+$/, ""), as]) : []))
    .sort(([a], [b]) => b.length - a.length);
  let out = text;
  for (const [form, as] of forms) {
    out = out.split(`${form}/`).join(as === "." ? "" : "~/").replace(new RegExp(`${esc(form)}(?![\\w.-])`, "g"), as);
  }
  return out;
}
