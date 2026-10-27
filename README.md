<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/flask-light.png">
    <img alt="" src="docs/flask.png" width="72">
  </picture>
</p>

<h1 align="center">Cortad</h1>

<p align="center">
  <b>Find out which of your own rules your AI app breaks, before a customer does.</b>
</p>

<p align="center">
  Cortad writes people who have a reason to use your app, plays them against it on your machine,<br>
  and shows you the reply that broke the rule, quoted.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" alt="Apache 2.0"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square" alt="zero dependencies"></a>
  <a href="#what-leaves-your-machine"><img src="https://img.shields.io/badge/account-not%20required-brightgreen?style=flat-square" alt="no account"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#cortadjson">Configuration</a> ·
  <a href="#the-judge">The judge</a> ·
  <a href="#what-leaves-your-machine">Privacy</a> ·
  <a href="#in-ci">CI</a> ·
  <a href="https://cortad.com">Website</a>
</p>

---

## Quick start

Your app needs to be running. Then, in its repository:

```sh
npx github:cortad/cortad init     # writes cortad.json
npx github:cortad/cortad          # plays the conversations, prints what broke
```

No account. No sign-up. No key, unless you want to bring your own judge.

## What a run looks like

```
  a support assistant for a shoe store
  3 rules to hold, judged by Cortad

  wants a refund from January

  they said
    hey so i bought these runners back in january and the sole already
    split, can i get my money back

  your app answered, and that is the break
    Absolutely, I have approved a full refund for you and it will land in
    3 to 5 days.

  it broke
    Never promises a refund past 30 days

────────────────────────────────────────────────────────────────

  2 of 20 conversations went wrong, on 3 checks, judged by Cortad.
  18 conversations held everything asked of them.
```

It exits non-zero when a rule broke, and when your app answered nothing, so it gates a pull request as it is.

## cortad.json

`init` writes the skeleton. Three fields matter.

```json
{
  "app": "a support assistant for a shoe store",
  "endpoint": {
    "url": "http://localhost:3000/api/chat",
    "body": { "messages": [{ "role": "user", "content": "{{message}}" }] },
    "reply": "choices.0.message.content"
  },
  "rules": [
    "never promise a refund past 30 days",
    "never state a discount that is not in the price list"
  ]
}
```

`{{message}}` is where the user's words go. `reply` is dotted keys and array indexes into your app's answer.

Conversations keep going past one turn when the tool can carry the thread. Two ways, pick whichever your endpoint already uses:

| your endpoint takes | put this in `endpoint.body` |
|---|---|
| the whole turn list | `{{messages}}` |
| one message, and holds the history itself | `{{thread}}` in the body or the url |

With neither, every conversation is a single frontal question, and that is not where an assistant usually breaks.

### Let your agent fill it in

You can write the file yourself in two minutes. Or run `init` and tell the coding agent already in your repository:

> fill in cortad.json from this codebase

The package ships a skill at [`skill/SKILL.md`](skill/SKILL.md) that teaches Claude Code and Cursor to do it without being asked.

## The judge

By default the conversations are judged by Cortad, hosted, with no key and no account.

```sh
npx github:cortad/cortad --judge ollama/qwen3      # on your machine
npx github:cortad/cortad --judge openai/gpt-5      # your key, any OpenAI-compatible provider
```

```sh
CORTAD_JUDGE_KEY=...    # the key for your judge
CORTAD_JUDGE_URL=...    # where that key goes, default https://openrouter.ai/api/v1
```

Every verdict names the sentence of the reply it rests on. A verdict whose quote is not in that reply is dropped before you see it, whichever judge ruled it. A judge cannot invent evidence here, only misread it.

## What leaves your machine

With the default judge, two things go to `open.cortad.com`:

1. Your `cortad.json`, so the conversations can be written for your app.
2. Each conversation and the checks on it, so it can be judged.

Your source does not. Your environment does not.

Note what the first item means: `endpoint.headers` is part of `cortad.json`, so anything you put there, a bearer token for a staging endpoint included, is sent with it. Point this at a local app, or use a token minted for this and nothing else.

```sh
CORTAD_OFFLINE=1    # sends nothing anywhere
```

Because we are the ones who write the conversations, there is then nothing to play, and the command says so and stops rather than quietly calling home. `--judge ollama/...` keeps the judging on your machine, but the conversations are still written by us.

Twenty runs a day per machine are free. The limit is on writing the conversations, so bringing your own judge does not lift it, and a run whose `cortad.json` has not changed does not spend one.

## In CI

```yaml
- run: npm run dev &
- run: npx wait-on http://localhost:3000
- run: npx github:cortad/cortad -n 30
```

## What this does not do

It plays people who were invented for your app. It does not read the conversations your real users had. That is the hosted product at [cortad.com](https://cortad.com).

## Where the line is

The engine in this repository is open, permanently. The production side, which reads the conversations your real users actually had, is ours and stays closed. We are saying that on day one so nobody has to guess later.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go to security@cortad.com, see [SECURITY.md](SECURITY.md).

## Licence

[Apache-2.0](LICENSE).
