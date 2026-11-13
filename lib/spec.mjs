import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const PACKAGE_JSON = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const VERSION = PACKAGE_JSON.version;

export const PACKAGE = PACKAGE_JSON.name;

export const SPEC = "(?:(?:@cortad\\/connector|cortad)(?:@[A-Za-z0-9._-]+)?|/[A-Za-z0-9._/-]+)";
const SAFE = new RegExp(`^${SPEC}$`);

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

export const npxArgs = (spec) => (isAbsolute(spec) ? [spec] : ["-y", spec]);

export const npxName = (spec) => (spec === "cortad@latest" ? "cortad" : spec);
