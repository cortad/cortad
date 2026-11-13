import dis
import functools
import gc
import re
import sys
import types

SITES_MAX, TEXT_MAX = 16, 300
WRITES_MAX = 1000
FRAMES_MAX, DEPTH_MAX, WIDTH_MAX, NODES_MAX = 24, 8, 8, 256
GENERATORS = (types.GeneratorType, types.AsyncGeneratorType)
HOLDERS = (dict, list, tuple, functools.partial)
SSE_EVENT = re.compile(rb"^event:[ \t]*([\w.:-]{1,40})", re.M)
JSON_EVENT = re.compile(rb'"(?:type|event)"\s*:\s*"([\w.:-]{1,40})"')


def _event(chunk):
    head = chunk[:400]
    m = SSE_EVENT.search(head) or JSON_EVENT.search(head)
    return m.group(1).decode("ascii") if m else None


def _frame(gen):
    return getattr(gen, "ag_frame", None) or getattr(gen, "gi_frame", None)


def _live(o):
    return isinstance(o, GENERATORS) and _frame(o) is not None


def _iterator(o):
    return hasattr(type(o), "__next__") or hasattr(type(o), "__anext__")


def _referents(gen):
    return gc.get_referents(gen) if sys.version_info >= (3, 11) else gc.get_referents(_frame(gen))


def _under(gen):
    try:
        return [g for g in _referents(gen) if _live(g)]
    except Exception:
        return []


def _same(v, chunk):
    if isinstance(v, (bytes, bytearray)):
        return v == chunk
    return isinstance(v, str) and len(v) <= len(chunk) and v.encode("utf-8", "replace") == chunk


def _holds(frame, chunk):
    return any(_same(v, chunk) for v in frame.f_locals.values())


def _handed(frame, message):
    code = frame.f_code
    return any(frame.f_locals.get(name) is message for name in code.co_varnames[:code.co_argcount + code.co_kwonlyargcount])


@functools.lru_cache(maxsize=512)
def _loop_target(code, lasti):
    target, header = None, False
    for ins in dis.get_instructions(code):
        if ins.offset >= lasti:
            break
        if ins.opname in ("FOR_ITER", "GET_ANEXT"):
            target, header = None, True
        elif header and ins.opname.startswith("STORE_FAST"):
            target, header = ins.argval[0] if isinstance(ins.argval, tuple) else ins.argval, False
    return target


def _fed_by(gen, chunk):
    inner, frame = getattr(gen, "gi_yieldfrom", None), _frame(gen)
    if inner is None and _same(frame.f_locals.get(_loop_target(frame.f_code, frame.f_lasti)), chunk):
        mine = {id(v) for v in frame.f_locals.values()}
        inner = next((o for o in reversed(_referents(gen)) if id(o) not in mine and _iterator(o)), None)
    return inner if _live(inner) else None


def _followed(o):
    return isinstance(o, HOLDERS) or (hasattr(o, "__dict__") and type(o).__module__ != "builtins" and not isinstance(o, (type, types.ModuleType)))


def _generators(roots):
    seen, level, found = set(), list(roots), []
    while level and len(seen) < NODES_MAX and not found:
        deeper = []
        for o in level:
            if id(o) in seen:
                continue
            seen.add(id(o))
            if isinstance(o, GENERATORS):
                if _frame(o) is not None:
                    found.append(o)
            elif _followed(o):
                deeper.extend(gc.get_referents(o))
        level = deeper
    return found


class Sites:
    def __init__(self, own_at):
        self.own_at = own_at

    def _made_by(self, gen, chunk):
        level = [gen]
        for _ in range(DEPTH_MAX):
            own = next((g for g in level if _frame(g) and self.own_at(_frame(g))), None)
            if own is not None:
                return self._handed_down(own, chunk)
            level = [u for g in level for u in _under(g)][:WIDTH_MAX]
            if not level:
                return None
        return None

    def _handed_down(self, gen, chunk):
        at = self.own_at(_frame(gen))
        for _ in range(DEPTH_MAX):
            gen = _fed_by(gen, chunk)
            if gen is None:
                break
            at = self.own_at(_frame(gen)) or at
        return at

    def sent(self, req, message, frame, stop):
        chunk = bytes(message.get("body") or b"")
        if self._room(req, chunk):
            self._note(req, chunk, self._sender(req, message, chunk, frame, stop))

    def made(self, req, iterator, chunk):
        chunk = bytes(chunk)
        if self._room(req, chunk):
            self._note(req, chunk, next(filter(None, (self._made_by(g, chunk) for g in _generators([iterator]))), None))

    def _sender(self, req, message, chunk, frame, stop):
        gen = req.get("iterated")
        if gen:
            return self._made_by(gen, chunk)
        sender = True
        for _ in range(FRAMES_MAX):
            if frame is None or frame.f_code is stop:
                break
            if not _handed(frame, message):
                at, held = self.own_at(frame), _holds(frame, chunk)
                if at and (sender or held):
                    return at
                sender = False
                at = self._first_made(req, list(frame.f_locals.values()), chunk) if gen is None and held else None
                if at:
                    return at
            frame = frame.f_back
        if gen is None:
            req["iterated"] = False
        return None

    def _first_made(self, req, values, chunk):
        for g in _generators(values):
            at = self._made_by(g, chunk)
            if at:
                req["iterated"] = g
                return at
        return None

    def iterated(self, req, iterable, chunk):
        chunk = bytes(chunk)
        if not self._room(req, chunk):
            return
        gen = req.get("iterated")
        if gen is None:
            gen = req["iterated"] = next(iter(_generators([iterable])), False)
        self._note(req, chunk, self._made_by(gen, chunk) if gen else None)

    def _room(self, req, chunk):
        req["traced"] = req.get("traced", 0) + 1
        return bool(chunk) and req["traced"] <= WRITES_MAX and len(req.setdefault("sites", [])) < SITES_MAX

    def _note(self, req, chunk, at):
        if not at:
            return
        event = _event(chunk)
        sites = req["sites"]
        if any(s["at"] == at and s.get("event") == event for s in sites):
            return
        sites.append({"at": at, **({"event": event} if event else {}), "text": chunk[:TEXT_MAX].decode("utf-8", "replace")})
