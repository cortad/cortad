---
name: cortad
description: Plays simulated people against the AI in this repository and reports which of the app's own rules its replies broke, with the conversation and the sentence it broke on. Use after changing a system prompt, a tool, a model or agent code, before saying a change to AI behaviour is done, and when asked how this app's AI behaves or whether it holds its rules.
---

# Cortad

Runs conversations against this repository's AI and reports the rules it broke.

## First time in a repository

1. Run `npx github:cortad/cli init`. It writes `cortad.json`.
2. Fill it in from the code. Do not guess any of it:
   - `app`: one sentence on what this app does for the people who use it.
   - `endpoint.url`: the route the app's own client posts a chat message to, on the port the dev server uses.
   - `endpoint.body`: the exact body that route takes, with `{{message}}` where the user's words go. Use `{{messages}}` instead if the route takes the whole turn list, so conversations can keep going.
   - `endpoint.reply`: where the reply sits in the answer, as dotted keys, for example `choices.0.message.content`.
   - `rules`: every rule the system prompt tells the model to keep, one per line, in the prompt's own words. Read the prompt files, not the README.
   - `tools`: each tool the model can call, with one line on what it does.
   - `users`: who uses this app, from the code or the docs.
3. Show the person the filled file before running anything.

## Running it

The app must be up first. Then `npx github:cortad/cli`.

It exits non-zero when a rule broke, and when the app answered nothing, so it works as a gate.

- `npx github:cortad/cli -n 40` runs more conversations.
- `npx github:cortad/cli --judge ollama/qwen3` judges on this machine instead.
- `CORTAD_OFFLINE=1` sends nothing anywhere. The conversations are written by Cortad, so with it set there are none to play and the command says so and stops.

## Reading what comes back

Each card is one rule, the conversation that broke it, and the sentence it broke on. The sentence is quoted from the reply: if it is not in the reply, it never reaches the card.

When a card is real, find the line in the prompt or the code that allows it, and say which line before changing anything. Then change it and run again.

## What not to do

Do not edit `cortad.json` to make a card go away. Do not add a rule the prompt does not state. A run that reports nothing is a result worth reporting.
