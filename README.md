# cortad

Runs Cortad's test conversations against the AI app on your machine, gives your coding agent the tools to run them, and sets up Cortad Intelligence for the live app. The command it installs is `cortad`.

```
npx cortad <code>
```

Run it in your app's folder with the code from cortad.com and your own start command after `--`: Cortad runs that command as you typed it, with its hook inside and nothing else added, connects the app, and adds Cortad to the coding agent running the command (Claude Code, Codex, Cursor or Copilot), or to each of them on this machine when it is run from a plain terminal. Cortad then sends each AI endpoint you choose one test request from this machine and learns the endpoint from the answer; you send one message yourself only where an endpoint needs a signed-in user. Runs start when you press Run simulation in the browser or ask your agent for one. Ctrl-C disconnects.

```
npx cortad <code> -- npm run dev     your command, as you start it, from the terminal that holds its settings
npx cortad <code> --port 3000        an app already running: its replies are seen, its model calls are not
```

## Cortad Intelligence

```
npx cortad intelligence
```

Run it in your app's folder, or let your coding agent run it from the prompt on cortad.com/live. Each run says what is done and the one next step, with the question for you where one is yours. On a computer it has not seen, it first prints a link and four characters to approve in your browser.

1. Your recent conversations. It asks where they are: a tool your app already sends its traces to, or your own database through a read-only export your agent writes. It sends the newest whole conversations from the last 30 days, up to 2,500 messages, and they count against nothing.
2. Cortad in your code. It writes `CORTAD_INGEST_KEY` and `CORTAD_PUBLIC_KEY` to your git-ignored env file, then prints the change: the SDK around the one model call that writes the reply, and the page tag. Your agent makes the change and you review it. It edits no code itself.

```
cortad intelligence history --from langfuse|langsmith|helicone|braintrust|phoenix|opik
                                     read from that tool on this computer with the keys already in your env
cortad intelligence history --stdin  read your own export, one JSON line per conversation
cortad intelligence history --skip   start from your next deploy
cortad intelligence key --to vercel|cloudflare|fly|github
                                     add CORTAD_INGEST_KEY to production with that host's own command, the value on its input
cortad intelligence site <address>   the one site the page key answers
cortad intelligence --wait           return when the history is read, with what it found
```

## Your coding agent

After the connect, your agent has six tools, one for each thing it needs from Cortad:

- `status` what to know about this app right now; with nothing asked for, whichever of the rest matters at this moment
- `test` test what you just built
- `verify` did your fix hold
- `connect` set up Cortad Intelligence for the live app, the same steps as `cortad intelligence`
- `tell` a note to the Cortad team, what counts as a good ending here, or where to send each incident
- `dispute` this question reads my app wrong

The same work as commands:

```
cortad status
cortad reach
cortad run
cortad findings
cortad verify <findingId>
```

`cortad wait` returns when the next run ends, with what it found; an agent starts it in the background so the run's end wakes it.

A run needs your app up. If nothing on this machine is holding it, the command starts it with the key and the start command kept in `~/.cortad`, and stops it ten minutes after the last run.

To make checking with Cortad part of the repository:

```
cortad stick     one line in AGENTS.md, CLAUDE.md, .cursor/rules and .github/copilot-instructions.md, and two hooks for Claude Code and Codex
cortad unstick   takes them out
```

The hooks run after an edit and on your next message: the first names the prompt and tool files you changed since the last run, and both tell the agent of a run that ended while it was not looking. Both commands print every file they changed. Neither touches git.

## Flags

```
-- <command>         how your app starts; everything after -- is run as typed (--start "cmd" says the same)
--port 3000          use an app that is already running, as it is
--port 3000 -- <command>   start a container and watch the port it publishes; the model base URL to set inside it is printed
--verbose            print your app's output
--from <tool>        intelligence history: the tool your conversations are read from
--stdin              intelligence history: read your own export from standard input
--skip               intelligence history: start from the next deploy
--dry-run            intelligence history: write what would be sent to ~/.cortad and stop
--anyway             intelligence history: send what looks like a development copy
--to <host>          intelligence key: the production host
--wait               intelligence: return when the history is read
```

Your app gets this terminal's environment and its request limits raised while Cortad tests it, so its simulated users are not blocked. Test conversations write where your app writes, after your yes in the browser.

## Files it creates

- `~/.cortad/<project>/`     the key, the start command, the last tree digest, which process holds your app up, your app's output in `app.log`, the sign-in your own request carried, the run it asked for last, in `news.txt` the line a finished run left for your agent, removed once the agent has it, in `heard.txt` the ids of the runs your agent has read, and in `pairing.json` a link waiting for your approval
- your app's env file (`.env.local`, `.env` or `.dev.vars`, whichever it loads)   Cortad's lines alone: `CORTAD_INGEST_KEY`, `CORTAD_PUBLIC_KEY` and `CORTAD_ENV=development`; only when git ignores the file
- `$TMPDIR/cortad-<pid>/`    removed on exit

macOS and Linux, Node 20 or later. One dependency, playwright-core, loaded only to capture a request your app's own page makes.

## Licence

Yours to run and to read, for connecting your own app to Cortad. Not to redistribute or to rebuild as a service. See LICENSE.
