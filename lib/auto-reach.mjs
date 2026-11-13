import { mailbox } from "./mailbox.mjs";
import { needsSignIn, notUp, picked, reachText, REACH_MS, sendOurs, testedLine } from "./reach.mjs";
import { finished } from "./text.mjs";
import { choosableOf } from "./contact-text.mjs";

const box = mailbox("reach");
export const ASK = box.file;
const keyOf = (m) => `${m.method} ${m.path}`;

export const ROUND_MS = 90_000;
const RETRY_MS = 5_000;
const RETRY_MAX_MS = 60_000;
const BATCH = 100;

export function makeAutoReach({ status, runner, waiting, origin, signIn, keys = () => [], mint = async () => null, account = async () => null, browser = async () => null, keptSignIn = async () => null, onSignedIn = () => {}, onKeptRefused = () => {}, stampOf, asked = () => false, busy = () => false, report = async () => {}, say, fetchImpl = fetch, roundMs = ROUND_MS, now = Date.now }) {
  const sent = new Map();
  let n = 0;
  const next = () => ++n;
  const kept = new Map();
  let draining = null, retryAt = 0, backoff = 0, lastSaid = "";
  const drain = async () => {
    while (kept.size && now() >= retryAt) {
      const batch = [...kept.values()].slice(0, BATCH);
      const ok = await Promise.resolve().then(() => report(batch)).then((r) => r !== false, () => false);
      if (!ok) {

        if (!backoff) say(`Cortad did not take what ${kept.size === 1 ? "1 test request" : `${kept.size} test requests`} met. They are kept here and sent again; your app is not asked again.`);
        backoff = Math.min(backoff ? backoff * 2 : RETRY_MS, RETRY_MAX_MS);
        retryAt = now() + backoff;
        return;
      }
      backoff = 0;

      for (const a of batch) if (kept.get(a.door) === a) kept.delete(a.door);
    }
  };
  const tell = (met = []) => {
    for (const a of met) kept.set(a.door, a);
    draining ??= drain().finally(() => { draining = null; });
    return draining;
  };

  return async function round(ask = null) {
    await Promise.resolve().then(() => report([])).catch(() => {});
    await tell();
    const here = runner();
    const down = notUp(here);
    if (down) return { text: `${down} Nothing was sent.\nnext: status`, wait: 5_000 };
    const held = await waiting();
    if (held) return { text: `${held} Nothing was sent.\nnext: status`, wait: 5_000 };
    const d = await status();
    if (!d) return { text: "Cortad did not answer with the list of endpoints. Nothing was sent.\nnext: status", wait: 30_000 };

    if (!ask && d.features === null && choosableOf(d.contact) > 1) {
      const said = "no test message goes to your app until the features to test are chosen: your coding agent asks you, or tick them on the card at the address status gives.";
      if (said !== lastSaid) { lastSaid = said; say(said); }
      return { text: "Nothing is sent until the person chooses which features the first simulation tests.\nnext: status", wait: 5_000 };
    }
    const pick = picked(d.contact, here.receipts, ask?.paths);
    const due = pick.sent.filter((m) => !m.excluded && (ask || sent.get(keyOf(m)) !== stampOf(m)));
    const until = now() + roundMs;
    let cut = false;
    const playing = Boolean(d.run) && !finished(d.run);
    const answers = due.length ? await sendOurs(due, {
      runner: here, origin: origin(), signIn, kept: keptSignIn, keys, mint, account: async () => (d.account?.make ? account(d.contact?.auth) : null), browser, onSignedIn, onKeptRefused, next, stop: () => (!ask && (asked() || (playing && busy()))) || (cut = now() >= until), fetchImpl,
      onAnswer: (a, i) => { const met = outcomes([due[i]], [a]); if (met.length) void tell(met); },
    }) : [];
    await tell();

    answers.forEach((a, i) => { if (!a.down) sent.set(keyOf(due[i]), stampOf(due[i])); });

    const line = testedLine(answers, due);
    if (line) {
      const doors = pick.rows.filter((m) => !m.excluded);
      const proven = d.contact?.proven?.length ?? 0;
      const total = doors.length + proven;
      const soFar = doors.filter((m) => sent.has(keyOf(m))).length + proven;
      const refused = new Set([...doors.filter((m) => m.signIn).map(keyOf), ...due.filter((m, i) => answers[i] && needsSignIn(answers[i])).map(keyOf)]).size;
      const said = [total > 1 ? `${line}; ${soFar} of ${total} endpoints tested so far` : line,
        soFar === total && refused ? `${refused === 1 ? "One endpoint needs" : `${refused} endpoints need`} a signed-in user: your coding agent sends each one message signed in as a test account you name.` : null];
      for (const s of said) if (s && s !== lastSaid) { lastSaid = s; say(s); }
    }

    return { text: reachText({ ...pick, sent: due.slice(0, answers.length) }, answers, `${here.port}, up to four at a time`), wait: !cut && !kept.size && d.read?.complete === true ? 60_000 : 5_000 };
  };
}

const DOOR = /^(?:GET|POST|PUT|PATCH|DELETE|GRPC) \/\S{0,400}$/;
export const outcomes = (rows, answers) => answers.flatMap((a, i) => {
  const door = keyOf(rows[i]);
  return a.unsent || a.down || !DOOR.test(door) ? [] : [{ door, status: a.status ?? 0, signedIn: Boolean(a.signedIn), ...(a.said ? { said: String(a.said).slice(0, 200) } : {}) }];
});

export async function askReach(home, paths, { sleep, waitMs = REACH_MS } = {}) {
  const got = await box.ask(home, { paths: Array.isArray(paths) ? paths.filter((p) => typeof p === "string").slice(0, 50) : [] }, { waitMs, ...(sleep ? { sleep } : {}) });
  return got ?? { text: `The requests are still being sent after ${waitMs / 1000} seconds; the connect command prints each batch as it ends.\nnext: status` };
}

export function takeAsk(home) {
  const ask = box.take(home);
  return ask ? { id: ask.id, paths: Array.isArray(ask.paths) ? ask.paths.filter((p) => typeof p === "string") : [] } : null;
}
export const answerAsk = (home, id, text) => box.answer(home, id, text);
