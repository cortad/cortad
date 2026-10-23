import { createRequire } from "node:module";
import { browserHeaders } from "./reach.mjs";

// The last rung before the agent is asked: when the repository serves its own frontend on this
// machine, a headless browser opens it, sends one message the way a person would, and hands back the
// request the frontend really made to the app, headers and all (its origin, its cookies, its sign-in,
// its CSRF token, whatever custom header it adds). Cortad's test request is then that request. The
// browser is the machine's own Chrome or Edge through playwright-core, headless, closed within the
// time box; nothing of what it sees leaves the machine. His yes of 2026-10-24.

const KEEP = /^(?:cookie|authorization|origin|referer|content-type|accept|x-[a-z0-9-]+|sec-fetch-[a-z]+|user-agent)$/i;
const STATIC = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|woff2?|ttf|webp|json)(?:\?|$)/i;
const INPUT = "textarea:visible, input[type=text]:visible, input[type=search]:visible, input:not([type]):visible, [contenteditable=true]:visible";
const SEND = "button[type=submit]:visible, form button:visible, button:has-text('Send'):visible, button[aria-label*='send' i]:visible";

function playwright() {
  try { return createRequire(import.meta.url)("playwright-core"); } catch { return null; }
}
async function launch(pw) {
  for (const channel of ["chrome", "msedge", undefined]) {
    try { return await pw.chromium.launch({ headless: true, ...(channel ? { channel } : {}) }); } catch { /* the next */ }
  }
  return null;
}
// Whether a browser can be launched on this machine at all; a test that cannot is skipped, not failed.
export async function canLaunch(pw = playwright()) {
  if (!pw) return false;
  const browser = await launch(pw);
  if (!browser) return false;
  await browser.close().catch(() => {});
  return true;
}
export async function reachable(origin, fetchImpl = fetch) {
  try { const res = await fetchImpl(origin, { headers: browserHeaders(null), redirect: "manual", signal: AbortSignal.timeout(2_500) }); return res.status < 500; } catch { return false; }
}

// { headers, request } of the first request the frontend made to the app after one message, or null:
// no frontend answering at `clientOrigin`, no browser on this machine, or no request within the time.
export async function clientRequestOf({ clientOrigin, appOrigin, text = "Hello", timeoutMs = 25_000, fetchImpl = fetch, pw = playwright() }) {
  if (!clientOrigin || !appOrigin || !pw || !(await reachable(clientOrigin, fetchImpl))) return null;
  const browser = await launch(pw);
  if (!browser) return null;
  const until = Date.now() + timeoutMs;
  const left = () => Math.max(250, until - Date.now());
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    let got = null;
    const settle = new Promise((resolve) => {
      page.on("request", (req) => {
        if (got || req.method() === "OPTIONS") return;
        let url;
        try { url = new URL(req.url()); } catch { return; }
        if (url.origin !== appOrigin || STATIC.test(url.pathname)) return;
        if (req.method() === "GET" && !/json|event-stream/i.test(req.headers().accept ?? "")) return;
        got = { method: req.method(), path: `${url.pathname}${url.search}`, headers: req.headers(), body: req.postData() ?? null };
        resolve(got);
      });
    });
    await page.goto(clientOrigin, { waitUntil: "domcontentloaded", timeout: left() }).catch(() => {});
    const input = page.locator(INPUT).first();
    if (await input.count().catch(() => 0)) {
      await input.click({ timeout: left() }).catch(() => {});
      await input.fill(text, { timeout: left() }).catch(() => input.type(text).catch(() => {}));
      await input.press("Enter").catch(() => {});
      const button = page.locator(SEND).first();
      await Promise.race([settle, new Promise((r) => setTimeout(r, 3_000))]);
      if (!got && (await button.count().catch(() => 0))) await button.click({ timeout: left() }).catch(() => {});
    }
    await Promise.race([settle, new Promise((r) => setTimeout(r, left()))]);
    if (!got) return null;
    const cookies = await context.cookies([appOrigin, clientOrigin]).catch(() => []);
    const headers = Object.fromEntries(Object.entries(got.headers).filter(([k]) => KEEP.test(k) && !/^content-length$/i.test(k)));
    if (cookies.length && !headers.cookie) headers.cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    return { headers, request: { method: got.method, path: got.path, body: got.body }, how: "the request your app's own frontend sends, captured in a browser on this machine" };
  } finally {
    await browser.close().catch(() => {});
  }
}
