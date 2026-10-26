# Security

## Reporting

Email security@cortad.com. Please do not open a public issue for a vulnerability.

Include what you did, what happened, and what you expected. We will confirm receipt within two working days and tell you what we are doing about it.

## What this tool sends

Two requests, both to `open.cortad.com`, both anonymous:

1. Your `cortad.json`, so the conversations can be written for your app.
2. Each conversation and the checks on it, so it can be judged.

Your source is not sent. Your environment is not sent. There is no account and no email address attached to either request. A random id is kept in `~/.cortad/install` so a day's runs can be counted against the free limit; deleting that file loses nothing.

`CORTAD_OFFLINE=1` sends nothing anywhere. Because the conversations are written by us, there is then nothing to play, and the command says so and stops rather than quietly calling home.

## What is kept

The conversations and the verdicts, against that random id, and used to make the tool better.

## The thing to be careful about

`endpoint.headers` is part of `cortad.json`, and `cortad.json` is sent. If you put a bearer token there to reach a protected endpoint, that token is sent with it. Point the tool at an app on your own machine, or use a credential minted for this and nothing else, scoped to nothing you would mind rotating.

## What this tool does to your app

It sends real requests to the endpoint you name, as a user would. Those requests have real effects: if your app writes rows, sends mail or calls a paid API, a run does all of that. Point it at development or staging unless you mean otherwise.

It never writes to your files. It runs no command from your repository.
