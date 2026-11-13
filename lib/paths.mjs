import { realpathSync } from "node:fs";

const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
