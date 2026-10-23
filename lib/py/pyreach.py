# The call graph of a Python repository from the language's own parser, for discover/callgraph-py.ts.
# Reads {"files": [{"path", "content"}]} on stdin and writes {"defs", "edges"}: every function and
# method with its lines, and every call inside one that resolves to a definition in these files.
#
# Resolved: a name imported from a module (`from a.b import f`), a module imported whole and called
# through (`import a.b as m; m.f()`, `from a import b; b.f()`), a package whose __init__ re-exports
# the name, a function or class defined in the same file, a class's method called on an instance
# made in the same function (`p = Provider(); p.generate()`), `self.method()` and the methods of the
# bases a class names. Not resolved, and left to the runtime: a method on a value whose class the
# parser cannot name, and anything dispatched through a string.
import ast
import json
import sys

files = json.load(sys.stdin)["files"]
texts = {f["path"]: f["content"] for f in files}

def module_of(path):
    stem = path[:-3] if path.endswith(".py") else path
    if stem.endswith("/__init__"):
        stem = stem[: -len("/__init__")]
    return stem.replace("/", ".")

modules = {}
for path in texts:
    modules.setdefault(module_of(path), path)
# A module named without its leading folders ("modules.research" for "backend/modules/research") is
# found by its tail, nearest the importer.
by_tail = {}
for mod, path in modules.items():
    parts = mod.split(".")
    for i in range(len(parts)):
        by_tail.setdefault(".".join(parts[i:]), []).append(mod)

def find_module(name, importer):
    if name in modules:
        return name
    for cand in by_tail.get(name, []):
        return cand
    return None

def relative(importer_path, level, name):
    base = module_of(importer_path).split(".")
    if not importer_path.endswith("/__init__.py"):
        base = base[:-1]
    if level > 1:
        base = base[: -(level - 1)] if level - 1 <= len(base) else []
    return ".".join([p for p in base if p] + ([name] if name else []))

class Index(ast.NodeVisitor):
    def __init__(self, path, tree):
        self.path = path
        self.defs = {}        # qualname -> (lineno, end)
        self.imports = {}     # local name -> ("module", modname) | ("symbol", modname, name)
        self.classes = {}     # class name -> {"methods": {name: lineno}, "bases": [names]}
        self.stack = []
        self.calls = []       # (caller def line, callee expr, local assignments in scope)
        self.assigns = {}     # (def line) -> {var: ("call", callee expr)}
        self.visit(tree)

    def visit_Import(self, node):
        for a in node.names:
            local = a.asname or a.name.split(".")[0]
            self.imports[local] = ("module", a.name if a.asname else a.name.split(".")[0])

    def visit_ImportFrom(self, node):
        mod = relative(self.path, node.level, node.module) if node.level else (node.module or "")
        for a in node.names:
            if a.name == "*":
                self.imports["*"] = ("star", mod)
                continue
            self.imports[a.asname or a.name] = ("symbol", mod, a.name)

    def visit_ClassDef(self, node):
        info = {"methods": {}, "bases": [b.id for b in node.bases if isinstance(b, ast.Name)] + [b.attr for b in node.bases if isinstance(b, ast.Attribute)], "line": node.lineno}
        self.classes[node.name] = info
        self.defs[node.name] = (node.lineno, getattr(node, "end_lineno", node.lineno))
        self.stack.append(node.name)
        for child in node.body:
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                info["methods"][child.name] = child.lineno
        self.generic_visit(node)
        self.stack.pop()

    def _def(self, node):
        qual = ".".join(self.stack + [node.name])
        self.defs[qual] = (node.lineno, getattr(node, "end_lineno", node.lineno))
        self.stack.append(node.name)
        self.generic_visit(node)
        self.stack.pop()

    visit_FunctionDef = _def
    visit_AsyncFunctionDef = _def

    def visit_Assign(self, node):
        if isinstance(node.value, ast.Call) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            self.assigns.setdefault(self._here(), {})[node.targets[0].id] = node.value.func
        self.generic_visit(node)

    def _here(self):
        return ".".join(self.stack) if self.stack else ""

    def visit_Call(self, node):
        if self.stack:
            self.calls.append((self._here(), node.func, node.lineno))
        self.generic_visit(node)

indexes = {}
for path, text in texts.items():
    try:
        indexes[path] = Index(path, ast.parse(text))
    except SyntaxError:
        continue

def def_line(path, qual):
    idx = indexes.get(path)
    if not idx:
        return None
    hit = idx.defs.get(qual)
    return (path, hit[0]) if hit else None

def symbol_in(modname, name, depth=0):
    # Where `name` of module `modname` is defined: in the module, or where its __init__ took it from.
    path = modules.get(modname)
    if not path or depth > 4:
        return None
    hit = def_line(path, name)
    if hit:
        return hit
    idx = indexes.get(path)
    if not idx:
        return None
    imp = idx.imports.get(name)
    if imp and imp[0] == "symbol":
        target = find_module(imp[1], path)
        return symbol_in(target, imp[2], depth + 1) if target else None
    if imp and imp[0] == "module":
        return None
    star = idx.imports.get("*")
    if star:
        target = find_module(star[1], path)
        return symbol_in(target, name, depth + 1) if target else None
    return None

def method_in(path, cls, meth, depth=0):
    idx = indexes.get(path)
    if not idx or depth > 4:
        return None
    info = idx.classes.get(cls)
    if not info:
        return None
    if meth in info["methods"]:
        return (path, info["methods"][meth])
    for base in info["bases"]:
        where = resolve_name(path, base, None)
        if where:
            hit = method_in(where[0], base, meth, depth + 1)
            if hit:
                return hit
    return None

def resolve_name(path, name, scope):
    # A bare name used in `path`: a definition here, or an import.
    idx = indexes[path]
    hit = def_line(path, name)
    if hit:
        return hit
    imp = idx.imports.get(name)
    if imp and imp[0] == "symbol":
        target = find_module(imp[1], path)
        return symbol_in(target, imp[2]) if target else None
    return None

def resolve_call(path, scope, func):
    idx = indexes[path]
    if isinstance(func, ast.Name):
        return resolve_name(path, func.id, scope)
    if isinstance(func, ast.Attribute):
        owner, attr = func.value, func.attr
        if isinstance(owner, ast.Name):
            if owner.id == "self" and scope:
                cls = scope.split(".")[0]
                return method_in(path, cls, attr)
            imp = idx.imports.get(owner.id)
            if imp and imp[0] == "module":
                target = find_module(imp[1], path)
                return symbol_in(target, attr) if target else None
            if imp and imp[0] == "symbol":
                target = find_module(imp[1], path)
                # `from pkg import mod; mod.f()`: the symbol is a module of its own.
                sub = find_module(f"{imp[1]}.{imp[2]}", path) if target else None
                if sub:
                    return symbol_in(sub, attr)
                # `from pkg import Cls; Cls.method()` or an instance of it.
                where = symbol_in(target, imp[2]) if target else None
                if where:
                    return method_in(where[0], imp[2], attr)
            # `p = Provider(); p.generate()`: the class the local was made from, in this scope.
            made = idx.assigns.get(scope, {}).get(owner.id)
            if isinstance(made, ast.Name):
                where = resolve_name(path, made.id, scope)
                if where:
                    return method_in(where[0], made.id, attr)
            if owner.id in idx.classes:
                return method_in(path, owner.id, attr)
        if isinstance(owner, ast.Attribute) and isinstance(owner.value, ast.Name):
            # `a.b.f()` where `a` is a package: module a.b, name f.
            imp = idx.imports.get(owner.value.id)
            if imp and imp[0] == "module":
                target = find_module(f"{imp[1]}.{owner.attr}", path)
                return symbol_in(target, attr) if target else None
    return None

defs = [{"path": p, "name": q, "line": d[0], "end": d[1]} for p, idx in indexes.items() for q, d in idx.defs.items()]
edges = []
for path, idx in indexes.items():
    for scope, func, lineno in idx.calls:
        to = resolve_call(path, scope, func)
        if to:
            edges.append({"from": {"path": path, "line": lineno}, "to": {"path": to[0], "line": to[1]}})
json.dump({"defs": defs, "edges": edges}, sys.stdout)
