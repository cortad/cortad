# Security

What the `cortad` command does on your machine, what it sends to Cortad, and how Cortad keeps and
deletes it.

## Check it yourself

- This package is built and published from this repository by GitHub Actions, with a signed build
  record on npm. `npm view cortad dist.attestations` shows it.
- `npx -y cortad --explain` lists every file a connect would send, grouped by why each was picked. It
  connects to nothing and writes nothing.
- Everything the command sends to Cortad goes to `https://cortad.com`, over HTTPS. Its other
  connections are to your app on your machine, to the stores your app's env names (samples, below),
  and to the tool you choose for production history.

## What a connect sends

**The files around your AI.** On your machine, Cortad's parsers pick the prompts, the tools the model
can call, the code that calls a model, the routes that reach it and the request shapes they accept,
and your evals. Nothing else in the repository is sent, and Cortad's server can later ask only for a
file in that set. If you would rather choose the files yourself, your coding agent can pick and send
them instead (see README.md).

These are never sent:

- Env files (`.env`, `.env.*`, `*.env`, `.envrc`), key or certificate files (`.pem`, `.key`,
  `.p12`, `.pfx`, `.jks`, `.keystore`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`), anything in `.ssh`,
  `.gnupg` or `.aws`, and `.npmrc` and `.netrc`.
- The `.git` folder and the commit history. Only the 40-character id of the commit you are on is
  sent, so a simulation is tied to the code it tested.
- Files git ignores.
- Any file that holds a private key, a provider token, or the value of a variable named as a secret
  (its name has KEY, SECRET, TOKEN, PASSW, PRIVATE or CREDENTIAL in it, its value 12 characters or
  more) in your env files or your environment.
- Data files: CSV, JSON Lines, Parquet, spreadsheets and JSON over 64 KB.
- Dependency, build and cache folders, databases, logs, lock files, archives, media, fonts, binaries
  and model weights.
- Symbolic links, files over 25 MB, and anything past 256 MB in total.

**The folder's name,** for your account's list of connected apps. Never the hostname or a path.

## What a simulation sends

- **Test conversations.** Simulated users send messages to your app on your machine, each labelled
  with the header `x-cortad-simulation: 1`. Your app's replies go to Cortad. Your app stores the
  conversations wherever it stores its own chats. A simulation starts only after your yes, given in
  the browser or to your coding agent.
- **Your app's model calls.** What your app sent its model while answering a test message, including
  anything it retrieved, and what the model answered.
- **Your app's routes,** as your app lists them.
- **Samples of your app's own content.** Where your app uses a search or vector store (such as Qdrant
  or Elasticsearch), the command opens it on your machine at the address in your app's env, and
  only there: an address Cortad's server sends is ignored, and a key goes only to the store of its
  own variable family (`QDRANT_API_KEY` to the host in `QDRANT_URL`). It sends up to 60 records per
  collection, each cut to 700 characters, after the same rules as production history below remove
  personal details. For a document folder your env names, it sends each file's name and first line,
  only from inside the project folder. Simulated users then ask about your real content.
  `--no-samples` turns this off, and so does `--agent-picks`.
- **Your app's output,** masked: the first error line printed while answering each test message, up
  to 2,000 characters when Cortad asks for the log, and the last 2,000 characters when your app fails to
  start or stops answering. All of it stays on your machine in `~/.cortad/<project>/app.log` (file
  mode 0600).
- **No path of your machine.** Every path in what the command sends is relative to the project, with
  your home folder as `~`.

## How secrets are masked

The command collects the secret values in your env files, in the env files your start command names,
and in environment variables named as credentials, and replaces each with `[masked]` in your app's
output and in everything it sends.

## What Cortad's server can make your machine do

- Send requests to your app's own port, and to no other port or host, the way a visitor of your app
  does. The replies go to Cortad. Where an endpoint needs a signed-in user and you send it one message
  yourself, later test messages to that endpoint carry that same sign-in. To learn the request your own page makes, the command may open that page
  on your machine in a headless browser; nothing the browser sees is sent.
- Get a copy of a file it was sent, and of no other.
- Take samples of your app's stores, as above.
- Restart your app with your own start command.
- Run your project's own test command, as its `package.json` declares it, inside the system sandbox
  (`sandbox-exec` on macOS, bubblewrap on Linux) with no network beyond your machine and no env file
  or key folder readable. Without a sandbox tool it runs nothing, and when the list of what the
  sandbox must hide is too long for it, it runs nothing and says why. The last 20,000 characters of
  its output are sent, masked.

Any other command the server sends is refused and noted in `~/.cortad/<project>/refused.log`.

## What changes on your machine

- While Cortad tests your app, the command raises your app's own request-rate and concurrency limits
  for that session, so simulated users are not turned away. It never raises a spend or budget limit.
- Test accounts are made on your app's own sign-up only after your yes. A token signed with your
  app's JWT secret is made only after a yes given to your coding agent on this machine, kept in
  `~/.cortad`.
- Cortad's tools and skill are added to one coding agent, inside this project only: the agent running
  the connect, or on a plain terminal the one you name, or none. For Claude Code its entry is the
  per-project one in `~/.claude.json`, as `claude mcp add` writes it; nothing else is written to your
  home folder for any agent, and a Cortad skill an older version left there is removed. The command prints
  every file it changed, `cortad unstick` removes the skill, and `README.md` lists every file it
  creates.

## Production conversations, when you send them

`cortad intelligence history` runs only when you ask for it.

- From a database, it first takes only table and field names, never a row. Then it opens only the
  tables you said yes to, read-only, on your machine.
- It sends the newest whole conversations from the last 30 days, up to 2,500 messages.
  Conversations Cortad itself had with your app are left out.
- Before anything is written or sent, Cortad's rules remove from every message, tool call and tool
  result: private keys, tokens and credentials, emails in any script, phone numbers in local and
  international formats (Arabic-Indic and Persian digits counted as digits), national ID and exam seat
  numbers, dates of birth, social handles, street addresses, payment card numbers, IBANs, IP
  addresses, US Social Security numbers and values from your env files.
- `--redact-with "<command>"` runs your own redaction on every text first; if it fails, nothing is
  sent.
- Conversation and user ids are replaced with an HMAC whose salt is made on your computer and never
  sent.
- `--dry-run` writes exactly what would be sent to `~/.cortad/<project>/history-dry-run.jsonl`,
  readable only by you, and sends nothing.

## Where Cortad keeps data

- Database: Postgres, hosted by PlanetScale, reached only over TLS with the server's certificate
  checked.
- Code versions and the words of production conversations: Cloudflare R2, reached only through the
  Cortad API. Conversations brought in from your own store are kept in the database instead,
  encrypted with your account's key.
- The Cortad API runs on Cloudflare Workers and Cloudflare Containers.
- No route of the Cortad API stores a model-provider key.

## Encryption

- In transit: HTTPS.
- Per account: each account has its own 256-bit key, stored only wrapped (AES-256-GCM).
- Each stored object is encrypted with its own data key (AES-256-GCM), made new every time it is
  written: each file's content in a code version, each code version's list of files, and each
  production conversation. The data key is wrapped by the account's key, and the object's storage
  address is bound into the encryption, so an object moved elsewhere does not decrypt.
- Test conversations, simulation results, account records, and short quotes taken from production
  conversations are in the database, which PlanetScale encrypts at rest. R2 also encrypts every object
  at rest (AES-256-GCM).

## Keeping and deleting

- Production conversations are kept for your plan's period: 7 days on Free, 90 days on Pro, 1 year on
  Ultra.
- You can delete a production conversation at any time.
- You can delete your account in Settings. Its keys stop working at once, and its data is deleted
  within the thirty days the Privacy Policy states. You can keep the account during the first seven.
- Whether Cortad may also use your data to improve the service is your choice, on the Data Sharing
  screen or in Settings. It is off until you turn it on.

## Who processes your data

The current list of subprocessors, with what each one does, is at `trust.cortad.com`.

## Reporting a vulnerability

Report it privately through this repository: Security, then Report a vulnerability.
