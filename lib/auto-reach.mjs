// The agent's `reach`, sent by the connect command: one request to each endpoint the ask names, or to
// every endpoint status lists as not reached, from this machine to the app on its port. The ask
// reaches this process through two files beside the runner record, since the sign-in the person's own
// request carried lives here and nowhere else. A round with no ask sends each due endpoint once and
// again only when its file changes; the connect command runs none, so nothing reaches the app on
// Cortad's own account.
import { mailbox } from "./mailbox.mjs";
import { needsSignIn, notUp, picked, reachText, REACH_MS, sendOurs, testedLine } from "./reach.mjs";
import { finished } from "./text.mjs";
import { choosableOf } from "./contact-text.mjs";

const box = mailbox("reach");
export const ASK = box.file;
const keyOf = (m) => `${m.method} ${m.path}`;

// `status()`: status's data, or null. `runner()`: the app's record while it is up and not restarting.
// `waiting()`: why nothing of Cortad's may reach the app yet, or null; a run's requests wait on the
// same (a store being copied, a store off this machine the person has not said yes to).
// `stampOf(row)`: what the row's file is now, so an edit to it sends the row again.
// `asked()`: true once the agent's ask waits, so a round stops between two sends to take it.
// `report(answers)`: what each test request met, for the server (POST /local/:box/reached). Each round
// opens with an empty list, which says this command sends them, so status stops asking the agent to;
// the caller posts it once per connection. Each answer is reported as it lands: reported only when
// its round ended, one endpoint that took 55 seconds held every faster one's answer back with it.
// `report` answering false, or failing, leaves its answers kept here and said again later: the server
// hears them late, and the app is never asked again for the sake of a report that did not arrive.
// What is kept is each endpoint's latest answer, so it is never more than the endpoints the app has
// and nothing is dropped to make room. One report is out at a time; the first that fails stops the
// rest, and the next is tried RETRY_MS later, twice as long after each failure up to RETRY_MAX_MS:
// 250 answers behind a server that was not answering were 250 reports of 15 seconds each, one after
// the other, and the fifty oldest were thrown away with their endpoints already marked as tested.
// `roundMs`: past it a round starts no further request; the rows left are sent in the next round. It
// bounds what a round starts, not a request already out (REACH_MS each) nor the connection as a whole.
export const ROUND_MS = 90_000;
const RETRY_MS = 5_000;
const RETRY_MAX_MS = 60_000;
const BATCH = 100;
// `keys()`: the keys the app's env holds for a caller that must carry one (lib/origins.mjs).
// `busy()`: the app is answering a run's requests right now; a round yields to those and to the
// agent's ask, never to the read's own few requests, which cut every round to one endpoint and made
// thirteen endpoints take eight minutes (2026-10-24).
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
        // Said once per outage, so a card that is not moving has its reason in the terminal.
        if (!backoff) say(`Cortad did not take what ${kept.size === 1 ? "1 test request" : `${kept.size} test requests`} met. They are kept here and sent again; your app is not asked again.`);
        backoff = Math.min(backoff ? backoff * 2 : RETRY_MS, RETRY_MAX_MS);
        retryAt = now() + backoff;
        return;
      }
      backoff = 0;
      // An endpoint answered again while its last answer was out keeps the newer one.
      for (const a of batch) if (kept.get(a.door) === a) kept.delete(a.door);
    }
  };
  const tell = (met = []) => {
    for (const a of met) kept.set(a.door, a);
    draining ??= drain().finally(() => { draining = null; });
    return draining;
  };
  // `ask`: the agent's call, { paths }: sent whatever was sent before, and answered with each line.
  // `wait`: when to look again: soon while the code is still being read, rarely once it is.
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
    // With more than one feature, no test message goes to the app before the person has chosen which
    // the first run tests (`features` null from a server that sends it): the choice comes before the
    // proving, not after. An agent's own ask, naming paths, is sent as asked.
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
    // A request that never reached the app (refused, or a GET cut off) is sent again next round. One
    // that may have reached it, a POST reset or timed out, is not: sending it twice could do twice
    // whatever it does. The agent's `reach` or an edit to its file sends it again.
    answers.forEach((a, i) => { if (!a.down) sent.set(keyOf(due[i]), stampOf(due[i])); });
    // Each round names what it tested and where that leaves the whole: thirteen rounds of "tested 1
    // endpoint: 0 answered, 1 needs a signed-in user" read as one endpoint stuck, and nobody was told
    // that the next message was the agent's, signed in. Said once each; a round that moved nothing says nothing.
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
    // Rows the round's time left unsent are due in seconds, never a minute on. An ask of the agent's
    // that stopped the round is taken within a second whatever this says.
    return { text: reachText({ ...pick, sent: due.slice(0, answers.length) }, answers, `${here.port}, up to four at a time`), wait: !cut && !kept.size && d.read?.complete === true ? 60_000 : 5_000 };
  };
}

// What reached the app, as the server's reached route takes it: a row never sent, or cut by a
// restart, met nothing.
const DOOR = /^(?:GET|POST|PUT|PATCH|DELETE|GRPC) \/\S{0,400}$/;
export const outcomes = (rows, answers) => answers.flatMap((a, i) => {
  const door = keyOf(rows[i]);
  return a.unsent || a.down || !DOOR.test(door) ? [] : [{ door, status: a.status ?? 0, signedIn: Boolean(a.signedIn), ...(a.said ? { said: String(a.said).slice(0, 200) } : {}) }];
});

// The agent's side: the ask is left for the connect command, and its answer waited on.
export async function askReach(home, paths, { sleep, waitMs = REACH_MS } = {}) {
  const got = await box.ask(home, { paths: Array.isArray(paths) ? paths.filter((p) => typeof p === "string").slice(0, 50) : [] }, { waitMs, ...(sleep ? { sleep } : {}) });
  return got ?? { text: `The requests are still being sent after ${waitMs / 1000} seconds; the connect command prints each batch as it ends.\nnext: status` };
}

// The connect command's side: the agent's ask, taken once, and its answer left where the agent waits.
export function takeAsk(home) {
  const ask = box.take(home);
  return ask ? { id: ask.id, paths: Array.isArray(ask.paths) ? ask.paths.filter((p) => typeof p === "string") : [] } : null;
}
export const answerAsk = (home, id, text) => box.answer(home, id, text);
