# cortad

Runs Cortad's test conversations against the AI app on your machine, gives your coding agent the tools to start them, and sets up Cortad Intelligence for the live app. The command it installs is `cortad`.

```
npx cortad <code>
```

Run it in your app's folder with the code from cortad.com and your own start command after `--`: Cortad runs that command as you typed it, with its hook inside and nothing else added, connects the app, and adds Cortad for this project to the coding agent running the command (Claude Code, Codex, Cursor or Copilot), or, from a plain terminal, to the one you name when it asks, or to none. Cortad then sends each AI endpoint you choose one test request from this machine and learns the endpoint from the answer; you send one message yourself only where an endpoint needs a signed-in user. Simulations start when you press Start simulation in the browser or ask your agent for one. Ctrl-C disconnects.

```
npx cortad <code> -- npm run dev     your command, as you start it, from the terminal that holds its settings
npx cortad <code> --port 3000        an app already running: its replies are seen, its model calls are not
```

## Cortad Intelligence

```
npx cortad intelligence
```

Run it in your app's folder, or let your coding agent run it from the prompt on cortad.com/live. Each run says what is done and the one next step, with the question for you where one is yours. On a computer it has not seen, it first prints a link and four characters to approve in your browser.

1. Your recent conversations. It asks where they are: a tool your app already sends its traces to, or your app's own database. For a database it first reads only the names of its tables and fields, never a row, and proposes the table the conversations are in, with one question for you; only your yes reads that table, read-only, on this computer. It sends the newest whole conversations from the last 30 days, up to 2,500 messages, counted as your app's replies, and they count against nothing.
2. Cortad in your code. It writes `CORTAD_INGEST_KEY` and `CORTAD_PUBLIC_KEY` to your git-ignored env file, then prints the change: the SDK around the one model call that writes the reply, and the page tag. Your agent makes the change and you review it. It edits no code itself.

```
cortad intelligence history          find the table your conversations are in from table and field names alone, and ask
cortad intelligence history --store postgres --table messages
                                     read that table, the one you said yes to, and no other
cortad intelligence history --from langfuse|langsmith|helicone|braintrust|phoenix|opik
                                     read from that tool on this computer with the keys already in your env
cortad intelligence history --stdin  read your own export, one JSON line per conversation
cortad intelligence history --skip   start from your next deploy
cortad intelligence key --to vercel|cloudflare|fly|github
                                     add CORTAD_INGEST_KEY to production with that host's own command, the value on its input
cortad intelligence site <address>   the one site the page key answers
cortad intelligence --wait           return when the history is read, with what it found
```

Before anything is written or sent, Cortad's rules take out of every message, tool call and tool result: keys, emails (in any script), phone numbers in local and international formats, national ID and exam seat numbers, dates of birth, social handles and addresses, with Arabic-Indic and Persian digits read as digits. Conversation and user ids are pseudonymized with an HMAC whose salt is made on this computer at first use and never sent. Names written in a message are not removed by Cortad's rules. To remove them, add `--redact-with "<command>"`: your command runs on every message first, reads one JSON line per text (`{"text": "..."}`) on its input and writes the same lines back, in order; if it fails, nothing is sent.

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

`cortad wait` returns when the next simulation ends, with what it found; an agent starts it in the background so the simulation's end wakes it.

A simulation needs your app up. If nothing on this machine is holding it, the command starts it with the key and the start command kept in `~/.cortad`, and stops it ten minutes after the last simulation.

To make checking with Cortad part of the repository:

```
cortad stick     one line in AGENTS.md, CLAUDE.md, .cursor/rules and .github/copilot-instructions.md, and two hooks for Claude Code and Codex
cortad unstick   takes them out, and the skill a connect added to this project
```

The hooks run after an edit and on your next message: the first names the prompt and tool files you changed since the last simulation, and both tell the agent of a simulation that ended while it was not looking. Both commands print every file they changed. Neither touches git.

## Your agent picks the files

By default a connect sends the code around your AI and nothing else (`npx cortad --explain` lists it). To choose those files yourself through your coding agent instead:

```
npx cortad <code> --agent-picks -- npm run dev     connects and starts your app, and sends no file
npx cortad send <file> <file> ...                  shows what would be sent and which need each file covers
npx cortad send --yes <file> <file> ...            sends them; a later send adds to the set
```

Cortad needs every prompt and prompt template, every place the code calls a model, the routes that reach those calls with their request and reply shapes, tool definitions, and eval cases. Env files, keys, files git ignores and data files are refused, each named with why. Cortad studies only the files sent, and may ask this machine for no other file later.

## Flags

```
-- <command>         how your app starts; everything after -- is run as typed (--start "cmd" says the same)
--port 3000          use an app that is already running, as it is
--port 3000 -- <command>   start a container and watch the port it publishes; the model base URL to set inside it is printed
--verbose            print your app's output
--agent-picks        send no file at connect: your coding agent picks them with `npx cortad send`
--no-samples         open none of your app's search or vector stores for samples of its content (--agent-picks implies it)
--explain            list every file a connect would send and why each was picked; connects to nothing and writes nothing
--yes                send: send the files the preview listed
--from <tool>        intelligence history: the tool your conversations are read from
--stdin              intelligence history: read your own export from standard input
--skip               intelligence history: start from the next deploy
--store <kind>       intelligence history: the database you chose (postgres, mongo, qdrant and the rest)
--table <names>      intelligence history: the tables you chose, comma-separated; rows are read from these alone
--redact-with "<command>"  intelligence history: your own redaction, run on every message before anything is written or sent
--dry-run            intelligence history: write exactly what would be sent to ~/.cortad/<project>/history-dry-run.jsonl, readable only by you, print a few of its messages, and send nothing
--anyway             intelligence history: send what looks like a development copy
--to <host>          intelligence key: the production host
--wait               intelligence: return when the history is read
```

Your app gets this terminal's environment and its request-rate and concurrency limits raised while Cortad tests it (never a spend or budget limit), so its simulated users are not blocked. Test conversations write where your app writes, after your yes in the browser or to your coding agent.

## Files it creates

- `~/.cortad/<project>/`     the key, the start command, the last tree digest, which process holds your app up, your app's output in `app.log`, after your yes to test sign-ins the sign-ins Cortad's test requests used and in `test-account.json` the one test account made on your app's sign-up, in `sign-in-yes.json` (readable only by you) your yes given to your coding agent, without which no token is signed with your app's JWT secret, in `refused.log` any command Cortad's server sent that this machine refused to run, the simulation it asked for last, in `news.txt` the line a finished simulation left for your agent, removed once the agent has it, in `heard.txt` the ids of the simulations your agent has read, and in `pairing.json` a link waiting for your approval
- Cortad's tools and skill, added to one coding agent, for this project only: for Claude Code its entry for this folder in `~/.claude.json` (where `claude mcp add --scope local` puts it) and `.claude/skills/cortad/`, for Codex `.codex/config.toml` and `.agents/skills/cortad/`, for Cursor `.cursor/mcp.json` and `.cursor/skills/cortad/`, for Copilot `.mcp.json` and `.github/skills/cortad/`. No skill is written to your home folder for any agent, and a Cortad skill an older version left in `~/.claude/skills`, `~/.agents/skills` or `~/.copilot/skills` is removed, as is a Cortad entry for Claude Code an earlier build put in `.mcp.json`. `cortad unstick` removes the skill from this project
- `~/.cortad/<project>/pseudonym.salt`   the salt that pseudonymizes your conversation and user ids, readable only by you; it never leaves this computer
- `~/.cortad/<project>/history-dry-run.jsonl`   what a dry run would have sent, readable only by you
- your app's env file (`.env.local`, `.env` or `.dev.vars`, whichever it loads)   Cortad's lines alone: `CORTAD_INGEST_KEY`, `CORTAD_PUBLIC_KEY` and `CORTAD_ENV=development`; only when git ignores the file
- `$TMPDIR/cortad-<pid>/`    removed on exit

macOS and Linux, Node 20 or later. One dependency, playwright-core, loaded only to capture a request your app's own page makes.

## Licence

Yours to run and to read, for connecting your own app to Cortad. Not to redistribute or to rebuild as a service. See LICENSE.
