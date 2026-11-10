import { execFileSync } from "node:child_process";

// What this folder tells the setup card in the browser: which history tool its env names, how far the
// history send has got, and whether each code change is in the working tree yet. A report that does
// not land changes nothing here, so it never fails the command it rides on.

// Cortad in the backend: the SDK imported in the app's own code, not only installed.
const SDK = String.raw`from ["']@cortad/sdk["']|require\(["']@cortad/sdk["']\)|from cortad import|^[[:space:]]*import cortad([^_[:alnum:]]|$)`;
// Cortad's page script, where the app serves its pages.
const TAG = String.raw`b\.cortad\.com/i/cortad\.js`;
const NOT_CODE = [":(exclude)*package.json", ":(exclude)*lock*", ":(exclude)*requirements*.txt", ":(exclude)*pyproject.toml", ":(exclude).cortad"];

const inTree = (root, pattern) => {
  try {
    execFileSync("git", ["-C", root, "grep", "-q", "-I", "-E", "--untracked", "-e", pattern, "--", ".", ...NOT_CODE], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch { return false; }
};

// Each change as the working tree holds it now, tracked or not yet committed; a folder that is not a
// git checkout reads as neither.
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
