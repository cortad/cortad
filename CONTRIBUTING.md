# Contributing

## Running it

There is nothing to install. The tool has no dependencies.

```sh
node bin/cortad.mjs --help
node --test test/*.test.mjs
```

The tests run the real binary against a real server on a real port. Three of them start an HTTP server, point the command at it, and read what it printed. Nothing is mocked except the two hosted calls, and those are stood up as local servers rather than stubbed in process.

## What a change needs

One runnable check that fails if the change breaks. Put it in `test/` beside the others and name it as a sentence about behaviour, not about the function.

The states where nothing was tested are the ones that have gone wrong before, and they are pinned in `test/gate.test.mjs`: an app that never answered, offline sending nothing, a thread id meaning the conversation keeps going. If you touch the exit code or what leaves the machine, that file is the one to read first.

## The rules this code follows

A verdict names the sentence of the reply it rests on, and a quote that is not in that reply is dropped before anyone sees it. That rule is in `lib/judge.mjs` and it is not a formality: a judge that can invent evidence produces findings nobody can check.

The command exits non-zero when a rule broke **and** when the app answered nothing. Zero conversations judged is not a pass. A gate that goes green because the app failed to start is worse than no gate.

What leaves the machine is printed before it leaves, and `CORTAD_OFFLINE=1` means nothing leaves at all. If a change adds a network call, it goes behind that check and the README says what it sends.

## Style

Comment what the code cannot say: a constraint, an invariant, a reason the obvious thing was not done. Never narrate a line. No emoji. Keep functions small and files short.

## Reporting a finding that is wrong

If the tool reported something that was not true of your app, that is the most useful issue you can file. Include your `cortad.json` with any secrets removed, the conversation, and what you expected. A false finding is a higher-priority bug here than a missed one.
