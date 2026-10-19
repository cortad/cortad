# cortad

Runs Cortad's test conversations against the AI app on your machine, and gives your coding agent the tools to run them.

```
npx cortad <code>
```

Run it in your app's folder with the code from cortad.com and your own start command after `--`: Cortad runs that command as you typed it, with its hook inside and nothing else added, connects the app, and adds Cortad to Claude Code, Codex, Cursor and Copilot on this machine. Then send your AI one message the way a user would; that one request is what Cortad learns the endpoint from. Runs start when you press Run in the browser or ask your agent for one. Ctrl-C disconnects.

```
npx cortad <code> -- npm run dev           your command, as you start it, from the terminal that holds its settings
npx cortad <code> --port 3000              an app already running: its replies are seen, its model calls are not
```

## Your coding agent

After that, your agent has the tools `status`, `reach`, `run`, `run_status`, `findings`, `verify`, `dispute`, `feedback`, `field_connect`, `field`, `world`, `world_status`, `test`, `connect`, `intelligence`, `incidents`, `outcomes`, `subscribe` and `query`. The same work as commands:

```
npx cortad status
npx cortad reach
npx cortad run
npx cortad findings
npx cortad verify <findingId>
```

`npx cortad wait` returns when the next run ends, with what it found; an agent starts it in the background so the run's end wakes it.

A run needs your app up. If nothing on this machine is holding it, the command starts it with the key and the start command kept in `~/.cortad`, and stops it ten minutes after the last run.

To make checking with Cortad part of the repository:

```
npx cortad stick     one line in AGENTS.md, CLAUDE.md, .cursor/rules and .github/copilot-instructions.md, and two hooks for Claude Code and Codex
npx cortad unstick   takes them out
```

The hooks run after an edit and on your next message: the first names the prompt and tool files you changed since the last run, and both tell the agent of a run that ended while it was not looking. Both commands print every file they changed. Neither touches git.

## Flags

```
-- <command>         how your app starts; everything after -- is run as typed (--start "cmd" says the same)
--port 3000          use an app that is already running, as it is
--port 3000 -- <command>   start a container and watch the port it publishes; the model base URL to set inside it is printed
--explain            show what would be sent and started, then exit
--verbose            print your app's output
```

Nothing about your environment is guessed or changed. Your app gets this terminal's environment and its own request limits raised for the session, by name; its env files are read only to hide their values in what leaves this machine. Nothing is copied or started beside it: test conversations write where your app writes, after your yes in the browser.

## Files it creates

- `~/.cortad/<project>/`     the key, the start command, the last tree digest, which process holds your app up, your app's output in `app.log`, the sign-in your own request carried, the run it asked for last, in `news.txt` the line a finished run left for your agent, removed once the agent has it, and in `heard.txt` the ids of the runs your agent has read
- `$TMPDIR/cortad-<pid>/`    removed on exit

macOS and Linux, Node 20 or later. No dependencies. What is sent and what stays on your machine: `npx cortad --explain`, and cortad.com/privacy.

## Licence

Yours to run and to read, for connecting your own app to Cortad. Not to redistribute or to rebuild as a service. See LICENSE.
