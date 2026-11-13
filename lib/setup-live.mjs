import { execFileSync } from "node:child_process";

const SDK = String.raw`from ["']@cortad/sdk["']|require\(["']@cortad/sdk["']\)|from cortad import|^[[:space:]]*import cortad([^_[:alnum:]]|$)`;

const TAG = String.raw`b\.cortad\.com/i/cortad\.js`;
const NOT_CODE = [":(exclude)*package.json", ":(exclude)*lock*", ":(exclude)*requirements*.txt", ":(exclude)*pyproject.toml", ":(exclude).cortad"];

const inTree = (root, pattern) => {
  try {
    execFileSync("git", ["-C", root, "grep", "-q", "-I", "-E", "--untracked", "-e", pattern, "--", ".", ...NOT_CODE], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch { return false; }
};

export const changesIn = (root) => ({ sdk: inTree(root, SDK), tag: inTree(root, TAG) });

export async function report({ apiBase, token, fetchImpl = fetch }, body) {
  if (!token) return false;
  try {
    const res = await fetchImpl(`${apiBase}/mcp/setup/live`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch { return false; }
}
