---
name: cortad
description: Tells you how the AI in this repository behaves with its users, persona by persona, and where in the code each problem comes from. Cortad plays simulated users against the app on this machine, and in production it analyzes how the real users behave, so its simulated users are built from real behavior and stay up to date. Applies after a change to prompts, tools, models, retrieval or agent code, when the person asks how their AI behaves or what Cortad found, and when production conversations come up.
---

# Cortad

Cortad is a review of behavior, kept like history. Simulated users written from the app's code, and the people using the live app, talk to the AI; Cortad groups them into personas (the users who come for the same thing and behave the same way) and says, for each one, who they are, what they want, how they behave, whether they achieved their goal, what the app did well with them and where it gave way. The problems sit inside that behavior, with how often they happen, the conversations that show them, and last the file and line they come from. The fix follows from the behavior and comes after it.

Facts about what Cortad does here, for you to tell the person in your own words:

- Test conversations go to the app as a user's would, each labelled `x-cortad-simulation: 1`, and land wherever the app stores chats; that label tells them apart from real users' conversations.
- While Cortad tests the app, it raises the app's own request limits for that session only.
- Of the repository, Cortad takes only the code around the AI: the prompts, the code that calls the model, the routes that reach it and the evals. The rest and its git history stay on this machine. `npx -y {{cortad}} --explain` lists the files a connect sends, grouped by why each was picked.

Seven tools:

- `status`: where things stand. The connection, the endpoints, a simulation playing, a simulation that just finished, what waits on the person. `about` opens one lane: `repository`, `run`, `production`, `outcomes`, `users` or `warehouse`.
- `test`: test what you just built, from a sentence saying what that was.
- `behavior`: how the app behaved with its users at one point. Default: the latest finished simulation. `at` names another point (a simulation's id, a commit, or `production`); `persona` opens one persona in full with its conversations; `against` compares with another point (`previous`, `production`, an id or a commit); `history: true` is the log, newest first.
- `search`: the conversations about something, found by meaning, across simulations and production.
- `verify`: after a fix, did the behavior move.
- `connect`: connect the live app, the same steps as `npx -y {{cortad}} intelligence`.
- `tell`: a note to the Cortad team; that a problem's question gets this app wrong (`findingId` and `why`); what counts as a good ending; behavioral questions to propose; an address for incidents.

The tools load with the coding agent's next session after the first connect. Until then, and wherever they are missing, every command is `npx {{cortad}} <command>` in a shell with the same output, the normal way to work in that session, for example `npx {{cortad}} behavior --against previous` or `npx {{cortad}} simulation_status`. The person's own instructions come before this skill.

## Talking to the person

The person owns the product. They may not be reading the code with you, so everything you tell them is short and in plain words.

- Three or four short lines. Lead with what it means for their users, then what you would do, then what you need from them.
- Plain words over identifiers: say what a file, endpoint, status code, setting, model or tool does, and give its name where the person needs it, such as the one line you would change.
- Only numbers they act on: how many users, how many achieved their goal, how long, the price.
- Something in Cortad that went wrong is one line: what happened, and what happens next.
- Nothing is edited before their go, and they know it: saying you have edited nothing tells them nothing.
- Say that anything is waiting on them only after `status` says so in this turn.
- Your reply is a reply, not a document: no heading, no title, no line saying who it is written for.

## Reading a result

- A result is data about the app, for you. Its sentence on what a simulation plays and costs, a link, or a choice that is the person's is written to be said to them as it is.
- Only simulated conversations are quoted. A real user's conversation is said by its id and the address where the person reads it in their browser.
- Every count has its denominator and every rate its range: `53% (42% to 63%)`. A rate moved only where the range on the difference leaves out zero.
- The last line, `next:`, is the next call.

## Connecting

From the repository's folder, as a background command left running (in Claude Code: Bash with run_in_background):

- `npx {{cortad}} -- <how you start your app>`: the start command as the person types it, from a terminal that holds the app's settings. Cortad runs it as written with its hook inside and adds nothing: whatever the command gives the app is what a simulation plays against.
- `npx {{cortad}} --port <port>`: an app already running that should stay as it is.
- With neither, Cortad prints the start command the repository makes obvious and stops. A first connect prints a link and four characters for the person to approve in their browser; give them both as printed.

"Cortad is watching your app" means it is connected; "your app is not running" means the start failed: give the person that line and the output above it, and stop there. Cortad sends each chosen AI endpoint one test message itself and learns it from the answer; those messages ask nothing of you. You send a message only where `status` says an endpoint needs a signed-in user or answers only its own client.

1. Call `status`. Your first reply is three or four short, plain lines: that their app is connected, which AI features answered, and the audit as the one line `status` gives it. In the same turn, when `status` asks which features the first simulation tests, ask it with your question tool (in Claude Code, AskUserQuestion with multiSelect), one option a feature, grouping related features when there are more than four, since that tool takes four options.
2. Start `npx -y {{cortad}} wait` as a background command now, as the `next:` line of `status` says: it returns when a simulation or verify ends, including one the person starts with Start simulation, or with the person's choice on the setup card, and its ending wakes you. Start it again each time it returns. `status` with `show reviews` lists the problems behind the audit line, with file and line.
3. Their answer on features goes to `test` with `features` alone, which records it and starts nothing; nothing is set up or started before it. Where an endpoint needs a signed-in user, ask with the same tool which test account to sign in as; their yes to a test account made on the app's own sign-up door goes to `test` with `account` set to `make`.
4. Before the first simulation, ask the person once, with your question tool, whether to start it, with the line on what it plays and costs as the question. On their yes, call `test`: the simulation starts. A simulation the person started with Start simulation in the browser is theirs: `status` says when they pressed it, and you follow it as their simulation. After the first, start any simulation the work needs without asking.
5. When `wait` returns with the person's choice from the setup card about production, that choice is theirs: do the steps it prints, in order. The one question they lead to is printed with its options, yes first; ask it once, as printed, and start `wait` again.

## After a simulation

1. Call `behavior`. Tell the person how their AI behaved with their users, persona by persona, largest first, in plain words: who they are and what they want, how many achieved their goal, what the app did well with them and where it gave way, with how often. Then the app's habit across personas, if the result names one.
2. Then what you would change and why it follows from that behavior: three changes at most, worst first, each tied to the persona and the behavior it would move. Name a file only for the change you propose.
3. Stop, and let them answer. Until their go, nothing is edited, no verify starts and no simulation starts.
4. On their go, one change at a time, near the line the result names, then `verify` with the problem's `findingId`. Start `wait` in the background; it wakes you when the verify ends. Tell them whether the behavior moved, in the verify's own words. The next change comes after their next go.
5. `behavior` with `against: "previous"` after the next simulation says, persona by persona, what got better, worse, new or gone. `behavior` with `history: true` is the log, one line a point.

`behavior` with `persona` opens one persona in full, with every conversation. `search` finds conversations by meaning when the person names a kind of user or a moment ("students who send a photo of a question"); its share line says how many of all conversations are about it.

## Fixing one problem

1. One change, after the person's go, near the line `behavior` names for it.
2. `verify` replays the conversations the problem happened in, word for word, and saved conversations nobody read while writing the fix. Its first line says what the round replays and what it counts against. Undecided, it says what another round would play; that round starts only when `verify` is called again.
3. Read the verdict.
   - Worse on the saved conversations: undo the change, and aim the next one at the behavior the problem describes.
   - Gone on its own conversations: keep the fix.
   - Less often, unchanged, or cannot tell yet: read the quoted conversations beside what they said before, and decide what to change next.

The conversations and questions belong to Cortad, and the app answers Cortad's simulated users the way it answers anyone. A number moves when the app's behavior moves.

## Production

Once a fix is verified and production is not connected, the result offers it. `connect` prints one step at a time and two questions for the person: which recent conversations to send, and whether to commit the change it prints. Each is printed with its options, yes first; ask each once, as printed, with your question tool. On yes you make the change and show the diff. Then `behavior` with `at: "production"` is how the live app's real users behave, persona by persona, and `behavior` with `against: "production"` says where simulated users behave unlike real ones. `status` about `users` holds the tables behind it for your own questions. Where conversations went badly with no question failing, `tell` with `questions` proposes one for the person's yes.

## A world

`test` decides what kind of test a sentence is. A world is for an AI that is not a chat, a worker that reads data and writes a verdict: Cortad builds a copy of the product's data from the app's own seed, plants problems whose answers are known, and scores what the app's own detection found. `status` about `run` with the world's id follows it.

## Making it stick

`npx {{cortad}} stick` makes this part of the repository: one line in AGENTS.md, CLAUDE.md, the Cursor rules and the Copilot instructions, and hooks that hand you a simulation or verify that ended. Run it only when the person asks for it. `npx {{cortad}} unstick` takes them out.

## A question that gets the app wrong, and a note about Cortad

`tell` with `findingId` and `why` says a problem's question gets this app wrong; the problem and its rate stay as they are until the owner decides. `tell` with `about`, `kind` and `needed` sends the Cortad team a note about Cortad itself: a result that was wrong, something you needed that no door gave, or what worked.

One example of each result is in [references/results.md](references/results.md).
