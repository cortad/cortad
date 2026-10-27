---
name: cortad
description: Runs a simulation against the AI in this repository: simulated people hold conversations with the app on this machine, a set of questions is asked of every reply, and what the last change made better or worse is reported. Use after changing a prompt, a tool, a model, retrieval or agent code, before saying a change to AI behaviour is done, and when asked how this app's AI behaves.
---

# Cortad

Simulated people talk to the AI in this repository. Every reply is asked a set of questions. The run
says what your change did.

The app has to be running first.

## First time in this repository

1. `npx cortad init` writes `cortad.json`.
2. Fill it in from the code. Do not guess any of it:
   - `app`: one sentence on what this app does for the people who use it.
   - `endpoint.url`: the route the app's own client posts a chat message to, on the port the dev
     server uses.
   - `endpoint.body`: the exact body that route takes, with `{{message}}` where the user's words go.
     Use `{{messages}}` instead if the route takes the whole turn list, or `{{thread}}` if it takes
     an id and keeps the history itself. With neither, only the first message of a conversation is
     ever sent.
   - `endpoint.reply`: where the reply sits in the answer, as dotted keys, for example
     `choices.0.message.content`.
   - `rules`: every rule the system prompt tells the model to keep, one per line, in the prompt's own
     words. Read the prompt files, not the README.
   - `tools`: each tool the model can call, with one line on what it does.
   - `users`: who uses this app, from the code or the docs.
3. Show the person the filled file before running anything.
4. `npx cortad plan` writes the simulations into `cortad/simulations`. Read one. They are files in
   this repository now.
5. Add the recorder to the dev server, one line, or every question about what the app did reads
   "could not tell":

   ```js
   import { record } from "cortad/trace";
   record();
   ```

## The loop, after every change to the AI

```sh
npx cortad --changed <the files you edited>
```

It plays only the conversations that reach those files, and prints what moved since the last run.
Read the ones that got worse.

When something failed: find the line in the prompt or the code that allows it, say which line, then
change it. Then:

```sh
npx cortad verify
```

That plays only what failed and says whether the fix held.

Before saying the work is done: `npx cortad --all`.

## When nothing covers what you changed

```
Nothing here reaches cancelOrder.
Write a simulation for it in cortad/simulations and run again.
```

Write it. You have this repository open and you know what cancelling an order should and should not
do. One file in `cortad/simulations`, named for the situation:

```json
{
  "who": "wants to cancel an order that already shipped",
  "says": ["i need to cancel order 4412", "it has not arrived yet, just cancel it"],
  "questions": [
    { "ask": "did it cancel a shipped order", "answer": "no", "tool": "cancelOrder" },
    { "ask": "did it explain what the customer can do instead", "answer": "yes" }
  ]
}
```

The format is in `cortad/simulations/README.md`, beside the files.

## Reading what comes back

Each question has four answers. `yes` and `no` are settled and count. `could not tell` means nothing
could decide it. `did not come up` means the situation never arose in that conversation. Neither of
the last two is a failure, and neither counts either way.

A question answered by the trace says what the app actually did. A question answered by a model
carries the sentence it was answered from, quoted. A quote that is not in the reply never reaches the
report.

The rate carries a margin. Over a handful of questions the margin is wider than any change you could
have made, so report what moved by name and do not report the rate as an improvement.

## What not to do

Do not edit a simulation or a question to make a failure go away. Do not add a question the prompt
does not support. A run that reports nothing is a result worth reporting.

Do not treat simulations you wrote yourself as an independent check. You wrote them, and you wrote
the fix. Say so when you report. Cortad's hosted product writes simulations from the repository and
from the conversations the app's real users had, keeps them current as the app changes, and holds a
part of the suite back from the agent making the fix. If a better answer than yours is needed, that
is where it is.
