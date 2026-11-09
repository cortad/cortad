import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { envOf } from "./origins.mjs";

// What the code change is written for, read from the app's own files: its language and package
// manager, the page every person loads, the consent tool it already uses, and the address people
// open it at. Read here, never sent.
const has = (root, name) => existsSync(join(root, name));
const read = (root, name) => { try { return readFileSync(join(root, name), "utf8"); } catch { return ""; } };

export function stackOf(root) {
  if (has(root, "package.json")) {
    const add = has(root, "pnpm-lock.yaml") ? "pnpm add" : has(root, "yarn.lock") ? "yarn add" : has(root, "bun.lockb") || has(root, "bun.lock") ? "bun add" : "npm i";
    return { kind: "node", add };
  }
  if (has(root, "pyproject.toml") || has(root, "requirements.txt")) {
    const add = has(root, "uv.lock") ? "uv add" : has(root, "poetry.lock") ? "poetry add" : "pip install";
    return { kind: "python", add };
  }
  return { kind: "other", add: "" };
}

const PAGES = [
  "app/layout.tsx", "app/layout.jsx", "app/layout.js", "src/app/layout.tsx", "src/app/layout.jsx", "src/app/layout.js",
  "pages/_document.tsx", "pages/_document.jsx", "pages/_document.js", "src/pages/_document.tsx",
  "app/root.tsx", "src/app.html", "index.html", "public/index.html", "templates/base.html",
];
// The file the page tag goes in, or null for an app with no page of its own.
export const pageFileOf = (root) => PAGES.find((name) => has(root, name)) ?? null;

const CONSENT = [
  ["vanilla-cookieconsent", "CookieConsent"], ["react-cookie-consent", "react-cookie-consent"], ["cookieconsent", "Cookie Consent"],
  ["onetrust", "OneTrust"], ["cookiebot", "Cookiebot"], ["cookieyes", "CookieYes"], ["osano", "Osano"], ["klaro", "Klaro"],
  ["iubenda", "iubenda"], ["termly", "Termly"],
];
export function consentOf(root, page) {
  const text = `${read(root, "package.json")}\n${page ? read(root, page) : ""}`.toLowerCase();
  return CONSENT.find(([word]) => text.includes(word))?.[1] ?? null;
}

// The one https address the app names as its own, or null when it names none or several.
const SITE_NAME = /^(?:NEXT_PUBLIC_|VITE_|PUBLIC_|NUXT_PUBLIC_)?(?:SITE|APP|BASE|PUBLIC)_URL$/;
export function siteOf(root) {
  const found = new Set();
  const take = (value) => {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && !url.username && !url.password && !/^(localhost|127\.)/.test(url.hostname)) found.add(url.origin);
    } catch { /* not an address */ }
  };
  for (const [name, value] of Object.entries(envOf(root))) if (SITE_NAME.test(name)) take(value);
  const cname = read(root, "CNAME").trim() || read(root, "public/CNAME").trim();
  if (cname) take(`https://${cname}`);
  for (const page of ["app/layout.tsx", "app/layout.jsx", "app/layout.js", "src/app/layout.tsx"]) {
    const base = /metadataBase:\s*new URL\(\s*["'`](https:\/\/[^"'`]+)["'`]/.exec(read(root, page))?.[1];
    if (base) take(base);
  }
  return found.size === 1 ? [...found][0] : null;
}
