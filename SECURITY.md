# Security

## Reporting

Email security@cortad.com. Please do not open a public issue for a vulnerability.

Include what you did, what happened, and what you expected. We will confirm receipt within two working days and tell you what we are doing about it.

## What this tool sends

Two requests, both to `open.cortad.com`, both anonymous:

1. Your `cortad.json`, so the conversations can be written for your app.
2. Each conversation and the checks on it, so it can be judged.

Your source is not sent and your environment is not sent, with one exception worth knowing: a question written from one of your eval files carries text from that file, and the default judge sees it. Run `cortad evals` and read what it wrote before a run if that matters to you. There is no account and no email address attached to either request. A random id is kept in `~/.cortad/install` so a day's runs can be counted against the free limit; deleting that file loses nothing.

`CORTAD_OFFLINE=1` means nothing leaves this machine. A request to this machine is still allowed, so your app on localhost and a model in ollama both work; every other address is refused with a sentence naming it. It is one rule in `lib/net.mjs` that every request in the tool goes through, rather than a check at each call site.

## The thing to be careful about

`endpoint.headers` is part of `cortad.json`, and `cortad.json` is sent. If you put a bearer token there to reach a protected endpoint, that token is sent with it. Point the tool at an app on your own machine, or use a credential minted for this and nothing else, scoped to nothing you would mind rotating.

## What this tool does to your app

It sends real requests to the endpoint you name, as a user would. Those requests have real effects: if your app writes rows, sends mail or calls a paid API, a run does all of that. Point it at development or staging unless you mean otherwise.

## What it writes, and what it runs

It writes only under `cortad/`, plus `cortad.json` on `init`, `~/.cortad/install`, and whatever you name with `--junit` and `--sarif`. It never touches your source.

It runs the functions you export from `cortad.questions.mjs`, because that is how you answer a question with your own code, and nothing else from your repository. In CI that means a pull request which adds or edits that file runs its code on your runner, the same as any other build script, so review it the way you review one.

`cortad/runs/*.json` holds full transcripts and any tool arguments your app recorded. Those are the files `--changed` needs you to commit, so read one before you commit them.

## Everywhere this tool connects

Beyond the two requests above: the endpoint in your `cortad.json`, your own model if you name one with `--writer` or `--judge` (OpenRouter by default, or `CORTAD_JUDGE_URL`, or ollama), any URL you pass to `packs add`, and, during `init`, a HEAD and a short series of POSTs to the local ports it checks for your app.
