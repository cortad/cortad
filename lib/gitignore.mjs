// .gitignore read without git, for a folder that is not a repository: a file the person marked never
// to commit is never sent from there either. The patterns git documents: `#` comments, `!` to take a
// file back, a trailing `/` for folders only, a `/` inside to anchor at the file's own folder, and
// `*`, `?`, `[...]` and `**`.

const glob = (p) => p.replace(/\*\*\/|\/\*\*$|\*\*|\*|\?|\[[^\]]*\]|[.+^${}()|\\/]/g, (t) =>
  t === "**/" ? "(?:.*/)?" : t === "/**" ? "/.*" : t === "**" ? ".*" : t === "*" ? "[^/]*" : t === "?" ? "[^/]" : t.startsWith("[") ? t.replace(/^\[!/, "[^") : `\\${t}`);

// The rules of one .gitignore whose folder is `base`, relative to the root ("" for the root itself).
export function rulesOf(text, base) {
  const rules = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes("/");
    const body = glob(line.replace(/^\//, "").replace(/^\\/, ""));
    rules.push({ negate, dirOnly, base, re: new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`) });
  }
  return rules;
}

// Whether `rel` (relative to the root, with `/`) is ignored by these rules: the last that matches wins.
export function ignoredBy(rules, rel, isDir) {
  let out = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.base && !rel.startsWith(`${r.base}/`)) continue;
    if (r.re.test(r.base ? rel.slice(r.base.length + 1) : rel)) out = !r.negate;
  }
  return out;
}
