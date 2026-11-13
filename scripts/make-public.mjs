// Builds the public cortad repository from this one: exactly the files the npm package ships, with
// every comment cut, plus a publish workflow. Usage: node scripts/make-public.mjs <out>
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const { parse } = createRequire(import.meta.url)("acorn");

const src = new URL("..", import.meta.url).pathname;
const [out] = process.argv.slice(2);
if (!out) throw new Error("usage: node scripts/make-public.mjs <out>");
const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: src, encoding: "utf8" }))[0].files.map((f) => f.path);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Every comment cut out by the parser's own positions, so a // inside a string, a template or a regex
// is never touched; a line left empty by a cut goes, and every other byte stays as written.
const strippedJs = (path) => {
  const text = readFileSync(path, "utf8");
  const comments = [];
  parse(text, { ecmaVersion: "latest", sourceType: path.endsWith(".cjs") ? "script" : "module", allowHashBang: true, allowReturnOutsideFunction: true, onComment: (block, body, start, end) => comments.push([start, end]) });
  let out = "";
  let at = 0;
  // The hashbang is what makes the file a command: never cut.
  for (const [start, end] of comments) { if (start === 0 && text.startsWith("#!")) continue; out += text.slice(at, start); at = end; }
  out += text.slice(at);
  return out.split("\n").map((line) => line.replace(/[ \t]+$/, "")).filter((line, i, all) => line !== "" || (all[i - 1] ?? "") !== "").join("\n");
};

// Cuts comments and docstrings out by position and leaves every code line as written, so the file runs
// on the same Python versions as before (a re-printed file can use syntax older Pythons reject).
const STRIP_PY = `
import ast, io, sys, tokenize
src = open(sys.argv[1], encoding="utf8").read()
lines = src.splitlines(keepends=True)
cut = {}
for tok in tokenize.generate_tokens(io.StringIO(src).readline):
    if tok.type == tokenize.COMMENT and not tok.string.startswith("#!"):
        cut[tok.start[0]] = tok.start[1]
drop = set()
for node in ast.walk(ast.parse(src)):
    body = getattr(node, "body", None)
    if isinstance(body, list) and body and isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], "value", None), ast.Constant) and isinstance(body[0].value.value, str):
        doc = body[0]
        if len(body) == 1:
            indent = lines[doc.lineno - 1][: doc.col_offset]
            lines[doc.lineno - 1] = indent + "pass\\n"
            drop.update(range(doc.lineno + 1, doc.end_lineno + 1))
        else:
            drop.update(range(doc.lineno, doc.end_lineno + 1))
out = []
for i, line in enumerate(lines, 1):
    if i in drop:
        continue
    if i in cut:
        kept = line[: cut[i]].rstrip()
        if not kept:
            continue
        line = kept + "\\n"
    out.append(line)
sys.stdout.write("".join(out))
`;

for (const rel of packed) {
  const from = join(src, rel);
  const to = join(out, rel);
  mkdirSync(dirname(to), { recursive: true });
  if (/\.(mjs|cjs|js)$/.test(rel)) {
    writeFileSync(to, strippedJs(from));
  } else if (rel.endsWith(".py")) {
    writeFileSync(to, execFileSync("python3", ["-I", "-c", STRIP_PY, from], { encoding: "utf8" }));
  } else {
    cpSync(from, to);
  }
}

const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
delete pkg.scripts;
delete pkg.devDependencies;
pkg.repository = { type: "git", url: "git+https://github.com/cortad/cortad.git" };
pkg.bugs = { url: "https://github.com/cortad/cortad/issues" };
writeFileSync(join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

mkdirSync(join(out, ".github/workflows"), { recursive: true });
writeFileSync(join(out, ".github/workflows/publish.yml"), `name: Publish

on:
  push:
    tags: ["v*"]

permissions:
  id-token: write
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: "24"
          registry-url: "https://registry.npmjs.org"
          package-manager-cache: false
      - name: The tag is the version in package.json
        run: test "v$(node -p "require('./package.json').version")" = "$GITHUB_REF_NAME"
      - run: npm install -g npm@11.15.0
      - run: npm publish --access public --provenance
`);
console.log(`${packed.length} files written to ${out}`);
