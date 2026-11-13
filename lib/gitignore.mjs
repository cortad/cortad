const glob = (p) => p.replace(/\*\*\/|\/\*\*$|\*\*|\*|\?|\[[^\]]*\]|[.+^${}()|\\/]/g, (t) =>
  t === "**/" ? "(?:.*/)?" : t === "/**" ? "/.*" : t === "**" ? ".*" : t === "*" ? "[^/]*" : t === "?" ? "[^/]" : t.startsWith("[") ? t.replace(/^\[!/, "[^") : `\\${t}`);

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

export function ignoredBy(rules, rel, isDir) {
  let out = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.base && !rel.startsWith(`${r.base}/`)) continue;
    if (r.re.test(r.base ? rel.slice(r.base.length + 1) : rel)) out = !r.negate;
  }
  return out;
}
