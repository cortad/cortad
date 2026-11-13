import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

// Which cortad the coding agents on this machine start, and the skill and stick name: the
// CORTAD_CLI_SPEC the connect ran with (cortad@next, or an absolute folder for an unpublished
// build), else this very version: under cortad@next the agents ran rc.15 while the connector they
// talked to was the rc.14 the connect command pinned. The spec ends up in a shell line in the
// repository (lib/stick.mjs), so anything else in the variable is ignored.
const PACKAGE_JSON = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const VERSION = PACKAGE_JSON.version;
// The package this connector is published as. Versions 0.6.1 to 0.6.11 were published as
// `@cortad/connector`; lines they wrote are still recognised as ours.
export const PACKAGE = PACKAGE_JSON.name;
// Also how lib/stick.mjs tells a line of its own from another tool's.
export const SPEC = "(?:(?:@cortad\\/connector|cortad)(?:@[A-Za-z0-9._-]+)?|/[A-Za-z0-9._/-]+)";
const SAFE = new RegExp(`^${SPEC}$`);

// A pin older than this very version loses to it: a connect run as cortad@0.3.8 wrote a skill and an
// MCP server pinned to 0.3.7, and the agent asked whether the two were meant to mix.
export function cliSpec({ env = process.env, version = VERSION } = {}) {
  const pinned = env.CORTAD_CLI_SPEC && SAFE.test(env.CORTAD_CLI_SPEC) ? env.CORTAD_CLI_SPEC : null;
  if (!pinned) return `${PACKAGE}@${version}`;
  const released = /^(?:@cortad\/connector|cortad)@(\d+\.\d+\.\d+)$/.exec(pinned)?.[1];
  return released && newer(version, released) ? `${PACKAGE}@${version}` : pinned;
}
const newer = (a, b) => {
  if (!/^\d+\.\d+\.\d+$/.test(a)) return false;
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

// npx needs -y to fetch a package without asking; a local folder is not fetched.
export const npxArgs = (spec) => (isAbsolute(spec) ? [spec] : ["-y", spec]);

// How a line a person reads names the command: plain `cortad` when that is what npx resolves anyway.
export const npxName = (spec) => (spec === "cortad@latest" ? "cortad" : spec);
