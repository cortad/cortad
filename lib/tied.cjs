"use strict";

const ID = /^(?=.*\d)[\w.:-]{6,200}$/;
const RECENT_KEPT = 32, RECENT_MS = 300_000;

const BEFORE_MS = 60_000;

const scalars = (v, out = [], depth = 0) => {
  if (depth > 12 || out.length > 2000) return out;
  if (typeof v === "string" || (typeof v === "number" && Number.isInteger(v))) out.push(String(v));
  else if (Array.isArray(v)) for (const x of v) scalars(x, out, depth + 1);
  else if (v && typeof v === "object") for (const x of Object.values(v)) scalars(x, out, depth + 1);
  return out;
};
const json = (raw) => { try { return JSON.parse(raw); } catch { return undefined; } };
const addressIds = (req) => {
  const [path, query = ""] = req.path.split("?");
  return new Set([...path.split("/"), ...new URLSearchParams(query).values()].filter((v) => ID.test(v)));
};
const meets = (a, b) => [...a].some((v) => b.has(v));

const sentence = (v) => v.length >= 8 && /\s|[^\x00-\x7F]/.test(v);

const sentencesIn = (text) => { const v = json(text); return (v === undefined ? [String(text || "")] : scalars(v)).filter(sentence); };
const PROMPTS_KEPT = 64, PROMPT_HEAD = 500;

const CARRY = 60;

const UNDER_WAY = /^(?:queued|pending|waiting|scheduled|submitted|accepted|created|starting|started|running|processing|generating|working|thinking|searching|retrieving|streaming|in[_ -]?progress|not[_ -]?(?:started|ready))$/i;
const underWay = (v, depth = 0) => {
  if (!v || typeof v !== "object" || depth > 4) return false;
  if (Array.isArray(v)) return underWay(v.at(-1), depth + 1);
  const state = v.status ?? v.state;
  if (typeof state === "string" && UNDER_WAY.test(state)) return true;
  return Object.values(v).some((x) => x && typeof x === "object" && underWay(x, depth + 1));
};

const saidSentences = (text) => {
  const whole = sentencesIn(text);
  if (whole.length !== 1 || !/^\s*[[{]/.test(whole[0])) return whole;
  return [...whole[0].matchAll(/"((?:[^"\\]|\\.){8,})"/g)].map((m) => m[1]).filter(sentence);
};

function makeTied({ norm, bodyOf, replyOf, saidOf = () => undefined }) {
  const open = new Set();
  const recent = [];

  const prompts = [];
  const idsOf = (req) => (req.ids ??= new Set([...addressIds(req), ...scalars(json(bodyOf(req))), ...scalars(json(replyOf(req)))].filter((v) => ID.test(v))));
  const wordsOf = (req) => scalars(json(bodyOf(req))).filter(sentence);
  const says = (req, prompt) => wordsOf(req).some((v) => prompt.includes(norm(v)));
  const speaks = (text) => sentencesIn(text).length > 0;

  const answering = (sayers, prompt) => {
    if (sayers.length === 1) return sayers[0];
    const begun = sayers.filter((t) => t.pinned);
    if (begun.length === 1) return begun[0];
    const pool = begun.length ? begun : sayers;
    const own = (t) => wordsOf(t).filter((v) => prompt.includes(norm(v)) && !pool.some((o) => o !== t && wordsOf(o).includes(v)));
    if (pool.every((t) => !own(t).length)) return pool.at(-1);
    const [first, second] = pool.map((t) => [t, Math.max(-1, ...own(t).map((v) => prompt.lastIndexOf(norm(v))))]).sort((a, b) => b[1] - a[1]);
    return first[1] >= 0 && first[1] !== second[1] ? first[0] : null;
  };
  const drop = (req) => { const i = recent.indexOf(req); if (i >= 0) recent.splice(i, 1); };

  const carries = (fetch, asker) => {
    const said = saidOf(asker);
    if (said === undefined) return true;
    const raw = replyOf(fetch);
    if (underWay(json(raw))) return false;
    const reply = norm(raw);
    return [].concat(said).flatMap(saidSentences).some((w) => reply.includes(norm(w).slice(0, CARRY)));
  };

  const newestOf = (found) => {
    const ties = [...found.values()].map((f) => f.tie);
    if (!ties.every((t) => t.size) || ![...ties[0]].some((v) => ties.every((t) => t.has(v)))) return null;
    return [...found.keys()].reduce((a, b) => (b.at > a.at ? b : a));
  };

  const answered = new Map();
  const answeredAt = (tie, at) => {
    for (const i of tie) { answered.delete(i); answered.set(i, at); }
    while (answered.size > RECENT_KEPT * 8) answered.delete(answered.keys().next().value);
  };

  const askerOf = (req, pinnedOnly = false) => {
    const mine = addressIds(req);
    const now = Date.now();
    for (let i = mine.size ? recent.length - 1 : -1; i >= 0; i--) {
      const t = recent[i];

      if (t.at > req.at || now - (t.callAt ?? t.at) > RECENT_MS || (pinnedOnly && !t.pinned) || (t.settled && req.method !== "GET")) continue;
      const tie = [...mine].filter((v) => idsOf(t).has(v));
      if (tie.length) return { asker: t, tie: new Set(tie) };
    }
    return null;
  };
  return {
    opened(req) {
      open.add(req);
      const found = askerOf(req, true);
      if (found) { Object.assign(req, found); found.asker.fetched = true; }
    },

    closed(req) {
      open.delete(req);
      const { asker } = req;
      if (asker && !asker.written && !asker.callsOpen && carries(req, asker)) {
        const since = Math.max(0, ...[...req.tie].map((i) => answered.get(i) ?? asker.at).filter((at) => at < asker.at));
        const before = recent.filter((p) => p !== asker && !p.settled && since < p.at && p.at < asker.at && asker.at - p.at <= BEFORE_MS && meets(idsOf(p), req.tie));
        for (const s of [...before, asker]) drop(s);
        answeredAt(req.tie, asker.at);
        return [...before, asker];
      }
      if (req.method !== "GET" && !prompts.includes(bodyOf(req).slice(0, PROMPT_HEAD)) && (!req.noted || req.callsOpen || req.late)) { recent.push(req); if (recent.length > RECENT_KEPT) recent.shift(); }
      return null;
    },
    sent(prompt) {
      prompts.push(String(prompt).slice(0, PROMPT_HEAD));
      if (prompts.length > PROMPTS_KEPT) prompts.shift();
    },
    pinned,

    done(req) {
      if (!req) return;
      if (req.waiting) req.waiting -= 1;
      else req.callsOpen = Math.max(0, (req.callsOpen || 0) - 1);
    },

    inside(req, sent) {
      if (req.finished && (!req.noted || req.late) && !says(req, norm(sent))) return pinned(sent, req);
      if (!req.noted && req.finished) req.late = true;
      if (req.late) { req.pinned = true; req.callsOpen = (req.callsOpen || 0) + 1; req.callAt = Date.now(); }
      else req.waiting = (req.waiting || 0) + 1;
      return req;
    },

    replied(req, status, text) {
      req.finished = true;
      if (req.heard || req.late || !(req.waiting || req.callsOpen)) return;
      if (!(status >= 200 && status < 300) || speaks(text())) return;
      req.late = true;
      req.pinned = true;
      req.callsOpen = (req.callsOpen || 0) + (req.waiting || 0);
      req.waiting = 0;
    },

    settled(req) {
      if (!req || !req.late || !req.ended || req.callsOpen || req.waiting || req.written || req.settled || (req.fetched && saidOf(req) === undefined)) return false;
      req.settled = true;
      return true;
    },
  };

  function pinned(sent, held) {
    const prompt = norm(sent);
    const found = new Map();

    const reads = (asker) => !asker.settled && (says(asker, prompt) || ![...recent, ...open].some((t) => t !== asker && t.method !== "GET" && !t.settled && says(t, prompt)));
    for (const r of open) {
      if (r.asker) { if (reads(r.asker)) found.set(r.asker, { fetch: null, tie: r.tie ?? new Set() }); continue; }

      if (r.method !== "GET" && (!r.noted || r.pinned) && says(r, prompt)) { found.set(r, { fetch: null, tie: new Set() }); continue; }
      const tied = askerOf(r);
      if (tied && reads(tied.asker)) found.set(tied.asker, { fetch: { r, tie: tied.tie }, tie: tied.tie });
    }
    let sayers = [];
    if (!found.size) {
      sayers = recent.filter((t) => !t.settled && says(t, prompt));
      const last = sayers.at(-1);
      const turn = last && sayers.every((t) => t === last || meets(idsOf(t), idsOf(last))) ? answering(sayers, prompt) : null;
      if (turn) found.set(turn, { fetch: null, tie: new Set() });
    }
    if (found.size > 1 && !newestOf(found)) for (const t of [...found.keys()]) if (!says(t, prompt)) found.delete(t);
    const newest = found.size > 1 && newestOf(found);
    if (newest) for (const t of [...found.keys()]) if (t !== newest) found.delete(t);
    if (found.size !== 1) {
      const among = found.size ? [...found.keys()] : sayers;
      if (!held || held.settled || (among.length && !among.includes(held))) return undefined;
      found.clear();
      found.set(held, { fetch: null, tie: new Set() });
    }
    const [[asker, { fetch }]] = found;
    if (fetch) { Object.assign(fetch.r, { asker, tie: fetch.tie }); asker.fetched = true; }
    if (!asker.noted && asker.finished) asker.late = true;
    asker.pinned = true;
    asker.callsOpen = (asker.callsOpen || 0) + 1;
    asker.callAt = Date.now();
    return asker;
  }
}

module.exports = { makeTied, sentencesIn };
