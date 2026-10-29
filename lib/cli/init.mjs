// Writing the config by finding the app rather than asking about it. What a person has to type
// here is nothing.
import { knock, asEndpoint } from "../reach/knock.mjs";
import { SKELETON } from "../schema.mjs";

// Where a dev server usually is. Checked in this order, and the first one that answers anything at
// all is the one knocked at.
export const PORTS = [3000, 3001, 5173, 8000, 8080, 4000, 5000, 7860];

async function listening(base) {
  try {
    await fetch(base, { method: "HEAD", signal: AbortSignal.timeout(1_500) });
    return true;
  } catch (e) {
    // A server that refuses HEAD is still a server. Only a refused connection means nothing is here.
    return e.cause?.code !== "ECONNREFUSED" && e.name !== "TimeoutError";
  }
}

export async function findApp({ at, onTry = () => {} }) {
  const bases = at ? [at] : PORTS.map((p) => `http://localhost:${p}`);
  for (const base of bases) {
    if (!(await listening(base))) continue;
    const out = await knock(base, { onTry });
    if (out.found.length) return { base, ...out };
    if (at) return { base, ...out };
  }
  return { base: null, found: [], refused: [] };
}

export function configFrom(found) {
  if (!found) return SKELETON;
  return { ...SKELETON, endpoint: asEndpoint(found) };
}
