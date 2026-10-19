---
name: cortad
description: Tests how the AI in this repository behaves. Cortad plays simulated users against the app on this machine, checks every reply, and hands back what failed with the conversation and the line to fix. Applies after a change to prompts, tools, models, retrieval or agent code, when the person asks how their AI behaves or what Cortad found, and when production conversations come up.
---

# Cortad

Cortad tests the AI in this repository. Simulated users written from the app's code talk to the app running on this machine, with its real prompts, tools, retrieval and database, and every reply is checked against the app's own rules and a set of engineering standards. Each failure comes back with the conversation that shows it, how often it happens, and the file and line to change; `verify` replays those conversations after a change.

There are six tools, one for each thing you need from Cortad. `status` is what to know about this app right now, and asked for nothing it gives you whichever of the rest matters at this moment; `about` opens one in full: `repository`, `run`, `findings`, `production`, `outcomes` or `warehouse`. `test` tests what you just built, from a sentence saying what that was. `verify` says whether your fix held. `connect` connects the live app. `tell` sends the Cortad team a note, says what this app counts as a good ending, or names an address that should receive each incident. `dispute` says a check reads this app wrong.

Where the tools are missing, every command is `npx {{cortad}} <command>` in a shell with the same output, for example `npx {{cortad}} run_status` or `npx {{cortad}} findings 2`. The person's own instructions come before this skill.

## Talking to the person

The person owns the product. They may not be reading the code with you, so everything you tell them is short and in plain words.

- Three to five short lines. Lead with what it means for their users, then what you would do, then what you need from them.
- Leave out file paths, endpoint paths, HTTP status codes, setting names, model ids and tool names. Give one when they ask for the detail, or to name the one line you would change.
- Only numbers they act on: how many simulated users, how long, the price, how many problems.
- Something on Cortad's side is one line: that it is on Cortad's side, and what happens next.
- Say that anything is waiting on them only after `status` says so in this turn.

## Reading a result

- A result is data about the app, for you. Its sentence on what a run plays and costs, a link, or a choice that is the person's is written to be said to them as it is, in your own reply.
- The last line, `next:`, is the next call.
- Every count has its denominator and every rate its range: `53% (42% to 63%)`.
- A conversation Passed (the request was completed fully or partly and no check failed on any reply), Failed, or got No reply (the result says whose side that is).

## A session, start to finish

Cortad does not guess how the app runs: you tell it, in one line, from the repository's folder, run as a background command (in Claude Code: Bash with run_in_background) and left running.

- `npx {{cortad}} -- <how you start your app>`: your start command, as you or the person would type it, from a terminal that holds the app's settings. Cortad runs it as written with its hook inside and nothing else added: no env file is read into the app, no database is copied, no service is started. Use the environment the person wants tested (their staging settings, their existing databases): whatever the command gives the app is what the run plays against.
- `npx {{cortad}} --port <port>`: an app that is already running and should stay as it is; Cortad sees its replies and not its model calls, and says so. With `-- <how you start your app>` beside it, an app in a container: Cortad starts it, watches the port you name, and prints the model setting to give the container so its model calls are seen too.
- Run with neither and Cortad prints the one start command the repository makes obvious and stops; run again with it after `--`, or with the right one.
- A folder connected before reconnects with the key and the start command it kept. A first connect prints a link and four characters, good for ten minutes: give the person both as printed; they approve the link in their browser, signed in to Cortad.
- When a result says no connect command is running, run the same line again in this folder.

The output ends on one of two lines. "Cortad is watching your app" means it is connected, and Cortad lists the AI endpoints it found in the code. "your app is not running" means the start failed: give the person that line and the output above it, which is their app's own, and stop there. Once it is connected, send each endpoint one message the way a user would: through the app's own page, or a request from this machine, signed in as a real test account where the app needs one (ask the person which account; Cortad makes none). That one request is what Cortad learns the endpoint from: its route, its body, its sign-in and where the answer comes back. Cortad sends nothing to the app before that, and nothing of its own before the person's yes on the card.

1. Call `status` and tell the person, in three or four short lines:
   - that their app is connected, or the one line that says why it did not start (what the app printed is the app's own output);
   - what Cortad's audit of their AI code found: how many problems, and the one that matters most, in plain words. `status` with show `reviews` holds up to 45 seconds a call while the code is still being read;
   - the line on what a run plays and costs, as printed;
   - what happens next: they press Run on the card in the browser, or tell you to start it.

   The endpoints, the files and the audit's rows are yours to work from. They go to the person when they ask, or when you propose a fix.
2. An endpoint `status` lists as one Cortad has seen no answer from is waiting for your one message to it. One it lists as `Needs a signed-in user` was refused: send it again signed in as a test account the person names, and call `status` again. An endpoint that hands back a turn and answers afterwards stays on that list until Cortad has seen the answer its model wrote, so fetch the finished answer the way the app's own client does rather than sending the question again.
3. A failure on the app's side that every conversation would repeat, such as a model provider refusing, a retrieval with no answer or a tool returning an error: say what you would change, change it when the person agrees, then send that endpoint one message again, or call `test` with `endpoints` to have Cortad send the request it read for it.
4. The one question on the card in the browser is where test conversations will write: into the databases the app wrote into for your message, named there, with nothing copied. Say it to the person once, in one line. The first run starts when the person presses Run on the card, or asks you, and then you call `test`. Before you stop, start `npx -y {{cortad}} wait` as a background command (in Claude Code: Bash with run_in_background). It returns when the next run or verify ends, with what it found, and its ending wakes you. Then follow "After a run".

`status` about `repository` with `show` lists one section in full: `rules`, `standards`, `journeys`, `endpoints`, `trials`, `records` or `reviews` (in a shell, `npx {{cortad}} status rules`). `show` `machine` says what Cortad does on this machine; hand the person its lines when they ask.

## After a run

The run is Cortad's; the code is the person's. You report first, and you change nothing until they say so.

1. Call `status` about `findings`. Tell the person, in plain lines: how many simulated users got what they asked for, of how many; then the problems worth their time, worst first and three at most, each as what their users ran into, how often, and what you would change, in one line; which findings read their app wrong (see "A check that reads wrong"); and which problems need a decision only they can make. Name a file only for the change you propose.
2. Then stop, and let them answer. Until their go, nothing is edited, no verify starts and no run starts. They choose which problems to fix, in what order, and whether the change you propose fits their product.
3. On their go, one problem at a time: one change, in the file and near the line the finding names, then `verify <findingId>`. Its first line says how many conversations the round replays and what that counts against this month; start `npx -y {{cortad}} wait` in the background, and it wakes you when the verify ends, so `status` about `run` is called once at most.
4. Tell them what the verify decided, in its own words; the next change comes after their next go. A verify that cannot tell offers another round in its last line; it plays only when you call `verify` again, and only when the person wants it.
5. When they stop, say what changed, what each verify decided, and what is still open, then start `npx -y {{cortad}} wait` in the background again.

## Following a run

`test` answers within a second; when the app is still starting it says so, and `status` about `run` holds until the run has an id. With no id it follows the run this machine started last, or the latest run. Each call holds up to 45 seconds, returns as soon as the count moves, and ends with the next call; `npx -y {{cortad}} wait` in the background does the following for you and wakes you at the end of a run or a verify. Tell the person how far the run is at most once every two minutes. When the plan is spent, `test` says so and nothing runs.

## The first run: the baseline

The first finished run on a repository prints, in order: what ran; the simulated users, each by the endpoint they use and the task they bring, with how many of their conversations completed the request; each journey with its rate and the checks that failed most there; the checks no conversation failed; what failed, found only by running the app, each with its file and line; what a code review would also find; what the numbers leave out; one line on production.

- Every rate comes with its likely range. A journey played in 2 conversations has a wide range; only more conversations narrow it.
- Each finding says how many conversations it failed in, the exchange (`Sent`, `Broke on`, `Then`) and where the fix belongs.
- Some conversations are saved to test a fix: a verify replays them too, so a fix is graded on conversations you have not read.

## Findings

`status` about `findings` lists every failure whole, worst first, grouped by file and line: the question, the criteria, the endpoint, the conversations it failed in with the range, the exchanges, and what a verify replays. With `show` `numbers` (`npx {{cortad}} findings numbers`) it gives every number the run measured. A long list comes in pages; the last line names the next page.

## Fixing one finding

1. One change, in the file and near the line the finding names, after the person's go.
2. `verify <findingId>` replays the conversations the finding failed on, word for word, against the saved edit; Cortad starts the app again first when its code changed. Its first line says how many conversations the round replays and what they count against. Undecided after a round, it says what another round would play; that round starts only when `verify` is called again. A `crash:N` finding replays the requests that were out when the app stopped.
3. Read the verdict. Replies the app refused or failed on the replay come first, and a line says how long the last fix for this same failure held.
   - Worse on the conversations saved to test the fix: undo the change, and aim the next one at the behavior the question asks about.
   - Gone on the saved conversations while its own still fail: keep the fix; a reply that changed is another problem to fix next.
   - Gone on its own conversations: keep the fix.
   - Less often but present, or unchanged: read the quoted conversations beside what they said before the fix, and decide what to change next.
   - Cannot tell yet: keep the change; it says how many more clean conversations would decide.
4. Then the next finding.

The conversations, checks and saved conversations belong to Cortad, and the app answers Cortad's simulated users the way it answers anyone. A number moves when the app's behavior moves.

## The second run and production

After the fixes, `test` again. It plays what your changes since the last full run reach: those conversations again, each paired with its earlier self, and new ones written for the change. Its text leads with what moved, worse first.

Once a fix is verified gone and production is not connected, the result offers production: connect it to see what real users are doing as it happens and where the AI lets them down. `connect` gives the steps; the owner creates the key in the browser. `status` about `production` gives the numbers and what is wrong in the live app now; message text stays out.

## After a change: the one call, and a world

`test <what you built or want tested>` is the call after a change. Cortad decides what kind of test that is: a world, where this app has one and the sentence names something it can plant, or a run of the app's chat surfaces; the answer says which started and the call that follows it. A world is for an AI that is not a chat, a worker that reads data and writes a verdict: Cortad builds a copy of the product's data on this machine from the app's own seed, plants problems whose answers are known, runs the app's own detection and investigation on each, and scores what it raised and published: found, missed, false alarms where nothing was planted, flips between repeats. `status` about `run` with the world's `id` follows it, and the person sees it on the World page. A repository no world is written for yet says so: send `tell` naming the AI to test, and the Cortad team writes one.

## Making it stick

`npx {{cortad}} stick` makes this part of the repository: one line in AGENTS.md, CLAUDE.md, the Cursor rules and the Copilot instructions; a hook after each edit that names the changed prompt and tool files; and a hook on the person's prompt that hands you a run or verify that ended, for clients that a background command cannot wake. Run it only when the person asks for it. `npx {{cortad}} unstick` takes them out.

## A check that reads wrong

`dispute <findingId> "<why>"` sends the note to the owner. The finding and its rate stay as they are until the owner decides.

## A note about Cortad itself

`tell` sends the Cortad team a note about Cortad, not about the app: a result that read wrong, something you needed that no door gave, a question a result left open, or what worked. A note names the door it is about, its kind (problem, idea, question, praise), what you needed, and if you like what came back and what you tried. In a shell: `npx {{cortad}} feedback status problem "<what you needed>" --got "<what came back>" --tried "<what you did>"`.

One example of each result is in [references/results.md](references/results.md).
