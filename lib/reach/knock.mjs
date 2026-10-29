// Finding the app's AI without being told where it is. Four things learned the hard way, each one
// from a real app that was read wrong:
//
//   A route that is not mounted is never the AI, so nothing is asked about a 404.
//   A route whose name says it is machinery is not a conversation, however well it answers.
//   A dev server still compiling gets one more ask, with the time that takes, instead of counting
//     as a crash.
//   The body is learned from the app's own validation refusal before any shape is guessed at.
import { MESSAGE } from "../schema.mjs";
import { isMachinery, notThere, PATHS } from "./paths.mjs";
import { fieldsWanted, withFields } from "./repair.mjs";
import { replyPathOf, SHAPES } from "./shapes.mjs";
import { net } from "../net.mjs";

const ASK = "hi, I need help with an order I placed";
const QUICK_MS = 8_000;
// A first request to a route a dev server has not built yet pays for the build.
const SLOW_MS = 60_000;
const ROUNDS = 3;

async function send(url, body, timeoutMs) {
  try {
    const res = await net(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    return { status: 0, text: "", slow: e.name === "TimeoutError", why: e.cause?.code ?? e.name };
  }
}

const filled = (body) => JSON.parse(JSON.stringify(body).replaceAll(MESSAGE, ASK));

function answered(text) {
  if (!text?.trim()) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return text.trim().length > 20 ? { path: "", length: text.trim().length } : null; }
  const found = replyPathOf(parsed);
  // A short string is a status, an id or a label. A reply to "I need help with an order" is prose.
  return found && found.length > 20 ? found : null;
}

// One route, one shape, with the refusal read and the body repaired as far as it will go.
async function tryShape(url, shape, timeoutMs) {
  let body = filled(shape.body);
  for (let round = 0; round < ROUNDS; round += 1) {
    const res = await send(url, body, round === 0 ? timeoutMs : SLOW_MS);
    if (res.slow && round === 0) continue;
    if (notThere(res.status)) return { gone: true };
    if (res.status === 0) return { unreachable: res.why };
    if (res.status >= 200 && res.status < 300) {
      const reply = answered(res.text);
      return reply ? { ok: true, body: shape.body, reply: reply.path, length: reply.length, shape: shape.name } : { quiet: true };
    }
    const wanted = fieldsWanted(res.text).filter((name) => !JSON.stringify(body).includes(`"${name}"`));
    if (!wanted.length) return { refused: res.status };
    body = withFields(body, wanted);
    shape = { ...shape, body: withFields(shape.body, wanted) };
  }
  return { refused: 400 };
}

export async function knock(base, { paths = PATHS, onTry = () => {} } = {}) {
  const found = [];
  const refused = [];
  for (const path of paths) {
    if (isMachinery(path)) continue;
    const url = new URL(path, base).href;
    onTry(path);
    for (const shape of SHAPES) {
      const tried = await tryShape(url, shape, QUICK_MS);
      if (tried.gone) break;
      if (tried.unreachable) return { found: [], refused: [], unreachable: tried.unreachable };
      if (tried.ok) { found.push({ path, url, ...tried }); break; }
      if (tried.refused) refused.push({ path, status: tried.refused });
    }
  }
  // Longest reply first: a route that said one word and a route that held a conversation are not
  // equally likely to be the chat.
  return { found: found.sort((a, b) => b.length - a.length), refused };
}

export const asEndpoint = (one) => ({
  url: one.url,
  method: "POST",
  headers: {},
  body: one.body,
  reply: one.reply,
});
