import collections
import contextvars
import json
import re
import time
from urllib.parse import parse_qsl

ID = re.compile(r"^(?=.*\d)[\w.:-]{6,200}$")
RECENT_KEPT, RECENT_MS = 32, 300000
BEFORE_MS = 60000
PROMPTS_KEPT, PROMPT_HEAD = 64, 500
CARRY = 60
UNDER_WAY = re.compile(r"^(?:queued|pending|waiting|scheduled|submitted|accepted|created|starting|started|running|processing|generating|working|thinking|searching|retrieving|streaming|in[_ -]?progress|not[_ -]?(?:started|ready))$", re.I)


def _under_way(v, depth=0):
    if depth > 4:
        return False
    if isinstance(v, list):
        return bool(v) and _under_way(v[-1], depth + 1)
    if not isinstance(v, dict):
        return False
    state = v.get("status", v.get("state"))
    if isinstance(state, str) and UNDER_WAY.match(state):
        return True
    return any(isinstance(x, (list, dict)) and _under_way(x, depth + 1) for x in v.values())
_HELD = contextvars.ContextVar("cortad_asker", default=None)


def _scalars(v, out, depth=0):
    if depth > 12 or len(out) > 2000:
        return out
    if isinstance(v, str) or (isinstance(v, int) and not isinstance(v, bool)):
        out.append(str(v))
    elif isinstance(v, list):
        for x in v:
            _scalars(x, out, depth + 1)
    elif isinstance(v, dict):
        for x in v.values():
            _scalars(x, out, depth + 1)
    return out


def _json(raw):
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


def _sentence(v):
    return len(v) >= 8 and (any(c.isspace() for c in v) or not v.isascii())


def _speaks(text):
    v = _json(text)
    return any(_sentence(x) for x in (_scalars(v, []) if v is not None else [str(text or "")]))


def _address_ids(req):
    path, _, query = req["path"].partition("?")
    return {v for v in path.split("/") + [v for _, v in parse_qsl(query)] if ID.match(v)}


def _said_sentences(text):
    text = text.decode("utf-8", "replace") if isinstance(text, (bytes, bytearray)) else str(text or "")
    v = _json(text)
    whole = [s for s in (_scalars(v, []) if v is not None else [text]) if _sentence(s)]
    if len(whole) != 1 or not re.match(r"\s*[\[{]", whole[0]):
        return whole
    return [m for m in re.findall(r'"((?:[^"\\]|\\.){8,})"', whole[0]) if _sentence(m)]


class Tied:
    def __init__(self, norm, body_of, reply_of, said_of=None):
        self.norm, self.body_of, self.reply_of = norm, body_of, reply_of
        self.said_of = said_of or (lambda req: None)
        self.open = {}
        self.recent = collections.deque(maxlen=RECENT_KEPT)
        self.prompts = collections.deque(maxlen=PROMPTS_KEPT)
        self.answered = collections.OrderedDict()

    def _ids(self, req):
        if "ids" not in req:
            got = _scalars(_json(self.body_of(req)), []) + _scalars(_json(self.reply_of(req)), [])
            req["ids"] = _address_ids(req) | {v for v in got if ID.match(v)}
        return req["ids"]

    def _words(self, req):
        return [v for v in _scalars(_json(self.body_of(req)), []) if _sentence(v)]

    def sentences(self, req):
        raw = self.body_of(req)
        v = _json(raw)
        text = raw.decode("utf-8", "replace") if isinstance(raw, (bytes, bytearray)) else str(raw or "")
        return [s for s in (_scalars(v, []) if v is not None else [text]) if _sentence(s)]

    def _says(self, req, prompt):
        return any(self.norm(v) in prompt for v in self._words(req))

    def _answering(self, sayers, prompt):
        if len(sayers) == 1:
            return sayers[0]
        begun = [t for t in sayers if t.get("pinned")]
        if len(begun) == 1:
            return begun[0]
        pool = begun or sayers
        words = {id(t): self._words(t) for t in pool}
        own = {id(t): [v for v in words[id(t)] if self.norm(v) in prompt and not any(o is not t and v in words[id(o)] for o in pool)] for t in pool}
        if not any(own.values()):
            return pool[-1]
        first, second = sorted(((max([prompt.rfind(self.norm(v)) for v in own[id(t)]], default=-1), t) for t in pool), key=lambda p: p[0], reverse=True)[:2]
        return first[1] if first[0] >= 0 and first[0] != second[0] else None

    def _asker(self, req, pinned_only=False):
        mine = _address_ids(req)
        now = int(time.time() * 1000)
        for t in reversed(list(self.recent)) if mine else []:
            if t["at"] <= req["at"] and now - t.get("call_at", t["at"]) <= RECENT_MS and (t.get("pinned") or not pinned_only) and (not t.get("settled") or req["method"] == "GET"):
                shared = mine & self._ids(t)
                if shared:
                    return t, shared
        return None

    def opened(self, req):
        self.open[req["id"]] = req
        found = self._asker(req, pinned_only=True)
        if found:
            req["asker"], req["tie"] = found
            found[0]["fetched"] = True

    def closed(self, req):
        self.open.pop(req["id"], None)
        asker = req.get("asker")
        if asker and not asker.get("written") and not asker.get("calls_open") and self._carries(req, asker):
            since = max([self.answered[i] for i in req["tie"] if self.answered.get(i, asker["at"]) < asker["at"]], default=0)
            before = [p for p in list(self.recent) if p is not asker and not p.get("settled") and since < p["at"] < asker["at"] and asker["at"] - p["at"] <= BEFORE_MS and self._ids(p) & req["tie"]]
            for s in before + [asker]:
                try:
                    self.recent.remove(s)
                except ValueError:
                    pass
            asker["answered"] = True
            self._answered(req["tie"], asker["at"])
            return before + [asker]
        if req["method"] != "GET" and self.body_of(req)[:PROMPT_HEAD] not in self.prompts and (not req.get("noted") or req.get("calls_open") or req.get("late")):
            self.recent.append(req)
        return None

    def _carries(self, fetch, asker):
        said = self.said_of(asker)
        if said is None:
            return True
        raw = self.reply_of(fetch)
        if _under_way(_json(raw)):
            return False
        reply = self.norm(raw)
        return any(self.norm(w)[:CARRY] in reply for one in (said if isinstance(said, (list, tuple)) else [said]) for w in _said_sentences(one))

    def _answered(self, tie, at):
        for i in tie:
            self.answered.pop(i, None)
            self.answered[i] = at
        while len(self.answered) > RECENT_KEPT * 8:
            self.answered.popitem(last=False)

    def sent(self, prompt):
        self.prompts.append(prompt[:PROMPT_HEAD])

    @staticmethod
    def _one_client(found):
        ties = [f[2] for f in found.values()]
        return all(ties) and bool(set.intersection(*map(set, ties)))

    def pinned(self, sent, held=None):
        prompt = self.norm(sent)
        found = {}
        def reads(asker):
            if asker.get("settled"):
                return False
            others = list(self.recent) + list(self.open.values())
            return self._says(asker, prompt) or not any(t is not asker and t["method"] != "GET" and not t.get("settled") and self._says(t, prompt) for t in others)
        for r in list(self.open.values()):
            if r.get("asker"):
                if reads(r["asker"]):
                    found[id(r["asker"])] = (r["asker"], None, r.get("tie") or set())
            elif r["method"] != "GET" and (not r.get("noted") or r.get("pinned")) and self._says(r, prompt):
                found[id(r)] = (r, None, set())
            else:
                asker = self._asker(r)
                if asker and reads(asker[0]):
                    found[id(asker[0])] = (asker[0], (r, asker[1]), asker[1])
        sayers = []
        if not found:
            sayers = [t for t in list(self.recent) if not t.get("settled") and self._says(t, prompt)]
            turn = self._answering(sayers, prompt) if sayers and all(self._ids(t) & self._ids(sayers[-1]) for t in sayers[:-1]) else None
            if turn:
                found[id(turn)] = (turn, None, set())
        candidates = dict(found) or {id(t): (t, None, set()) for t in sayers}
        if len(found) > 1 and not self._one_client(found):
            found = {k: f for k, f in found.items() if self._says(f[0], prompt)}
        if len(found) > 1 and self._one_client(found):
            newest = max(found.values(), key=lambda f: f[0]["at"])
            found = {id(newest[0]): newest}
        if len(found) != 1:
            held = next((h for h in (_HELD.get(), held) if h and not h.get("answered") and (not candidates or id(h) in candidates)), None)
            if not held:
                return None
            found = {id(held): candidates.get(id(held), (held, None, set()))}
        asker, fetch, _ = next(iter(found.values()))
        if fetch:
            fetch[0]["asker"], fetch[0]["tie"] = asker, fetch[1]
            asker["fetched"] = True
        if not asker.get("noted") and asker.get("finished"):
            asker["late"] = True
        asker["pinned"] = True
        asker["calls_open"] = asker.get("calls_open", 0) + 1
        asker["call_at"] = int(time.time() * 1000)
        _HELD.set(asker)
        return asker

    @staticmethod
    def done(req):
        if not req:
            return
        if req.get("waiting"):
            req["waiting"] -= 1
        else:
            req["calls_open"] = max(0, req.get("calls_open", 0) - 1)

    def inside(self, req, sent):
        if req.get("finished") and (not req.get("noted") or req.get("late")) and not self._says(req, self.norm(sent)):
            return self.pinned(sent, req)
        if not req.get("noted") and req.get("finished"):
            req["late"] = True
        if req.get("late"):
            req["pinned"] = True
            req["calls_open"] = req.get("calls_open", 0) + 1
            req["call_at"] = int(time.time() * 1000)
        else:
            req["waiting"] = req.get("waiting", 0) + 1
        return req

    @staticmethod
    def replied(req, status, text):
        req["finished"] = True
        if req.get("heard") or req.get("late") or not (req.get("waiting") or req.get("calls_open")):
            return
        if not (200 <= int(status or 0) < 300) or _speaks(text()):
            return
        req["late"] = req["pinned"] = True
        req["calls_open"] = req.get("calls_open", 0) + req.get("waiting", 0)
        req["waiting"] = 0

    def settled(self, req):
        if not req or not req.get("late") or not req.get("ended") or req.get("calls_open") or req.get("waiting") or req.get("written") or req.get("settled") or (req.get("fetched") and self.said_of(req) is None):
            return False
        req["settled"] = req["answered"] = True
        return True
