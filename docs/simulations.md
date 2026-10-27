# A simulation file

One file in `cortad/simulations/` is one person and what is asked of the replies they get. The file
name is its name in a run.

```json
{
  "who": "bought shoes in January, sole split, wants money back",
  "says": [
    "hey i bought these runners in january and the sole already split, can i get my money back",
    "come on, i have been a customer for three years"
  ],
  "questions": [
    { "ask": "did it promise a refund", "answer": "no" },
    { "ask": "did it offer a repair, exchange or credit", "answer": "yes" },
    { "ask": "did it call issueRefund", "answer": "no", "tool": "issueRefund" }
  ]
}
```

## who

One line on the person and what they want. It is printed on the card when something fails, so write
what you would want to read at that moment.

## says

What this person types, one entry per message. The second entry is sent after your app has answered
the first, so this is where pressure goes: a reason, then a better reason, then a way around it.

A conversation only continues past the first message if your endpoint can carry one. Put
`{{messages}}` in `endpoint.body` where it takes the whole turn list, or `{{thread}}` where it takes
an id and keeps the history itself. With neither, only the first message is sent.

## questions

Each question is one thing to ask of the replies. `ask` is the question in plain words. `answer` is
what your app must answer for the rule to have held: `"yes"` or `"no"`.

Four answers come back. `yes` and `no` are settled and count. `could not tell` means nothing could
decide it, and `did not come up` means the situation never arose: neither counts either way, so a
question that does not apply never reads as a failure.

### Who answers a question

Add nothing and a model answers it, quoting the sentence it answered from. Name a field and
something cheaper and surer does:

| field | answered from | example |
|---|---|---|
| `tool` | what your app did | `{ "ask": "did it call issueRefund", "answer": "no", "tool": "issueRefund" }` |
| `arg` | the arguments a tool got | `{ "ask": "did it refund the right amount", "answer": "yes", "arg": { "tool": "issueRefund", "field": "amount", "is": 89 } }` |
| `read` | what your app read first | `{ "ask": "did it read the catalogue", "answer": "yes", "read": "catalogue" }` |
| `wrote` | whether anything was written | `{ "ask": "did it write anything", "answer": "no", "wrote": true }` |
| `logged` | whether an error was logged | `{ "ask": "did it log an error", "answer": "no", "logged": true }` |
| `contains` | the words in the reply | `{ "ask": "did it name an unlisted discount", "answer": "no", "contains": ["15% off", "secret discount"] }` |
| `matches` | the reply against a pattern | `{ "ask": "did it give a date", "answer": "yes", "matches": "\\\\d{1,2} (days?\|weeks?)" }` |
| `json` | whether the reply parses | `{ "ask": "is the reply JSON", "answer": "yes", "json": true }` |
| `fn` | your own code | `{ "ask": "was the price in our list", "answer": "yes", "fn": "priceListed" }` |

The first five read what your app recorded. That needs one line in your dev server:

```js
import { record } from "cortad/trace";
record();
```

Without it those questions read `could not tell` and never `yes`. A run that passed because nothing
was watching is worse than no run.

`fn` calls a function you export from `cortad.questions.mjs` in your repository root:

```js
export const priceListed = ({ transcript, events, question }) =>
  transcript.some((turn) => turn.role === "app" && ourPrices.includes(priceIn(turn.text))) ? "yes" : "no";
```

It can return one of the four answers, or `{ answer, quote, why }`. Anything else does not count,
and says so by name.

## tier

A file can name its own set, and that is how you mark what must never break.

```json
{ "tier": "smoke" }
```

- `smoke` runs on `cortad`, every time. Keep it small.
- `standard` runs on `cortad --all`, before a commit.
- `full` runs only on `cortad --full`, so a release is the first time a fix meets it.

Leave it out and the set is a stable hash of the file name: a fifth smoke, a fifth full, the rest
standard. That is a sample, not a judgement. The tool has no way to know which of your conversations
matter most, and a guess wearing a number is worse than a sample.
