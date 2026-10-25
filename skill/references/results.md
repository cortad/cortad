# What each tool prints

Each result exactly as the tool returns it. The numbers are from a walk of a tutoring app; yours differ. Every tool is also `npx {{cortad}} <tool>` in a shell, with the same output.

The last line of a run_status result is the next call. A plan line names what this month used and what the plan above costs and buys.

## wait

`npx {{cortad}} wait` returns when the next run ends. It prints what `run_status` prints for that finished run, and its last line is `next: findings <jobId>`. When the connect command has been stopped for a minute it ends with `The connect command stopped, so no run can start from the browser.`; after six hours with no run, with `No run ended in 6 hours.`

## status

Right after a connect, while your code is still being read:

```
Repository: tutor-app.
Free: 1 of 1 run left this month; 60 verify conversations left. Pro $99 a month: runs and reruns included, 100,000 production replies read.
App: Your app is starting on this machine.
```

Once a request of your own has reached the model through an endpoint, two messages on the chat, and before any run:

```
Repository: tutor-app.
Free: 1 of 1 run left this month; 60 verify conversations left. Pro $99 a month: runs and reruns included, 100,000 production replies read.
App: Your app answered on port 3100.
Endpoints that answered (1):
  POST /api/chat: 2 requests reached gpt-4o-mini, 2 model calls each, 3.1 seconds a reply.
    The prompts carried 9 of the 46 rules read from your code, for example apps/api/src/agent/prompt.ts:41 "Never state a refund policy the product does not publish.".
    Tools that ran: search_lessons.
    Passages handed to the model: 3.
    Problem at apps/api/src/agent/system.ts:30: The reply carried "</student_profile>", markup from the prompt your app sent the model.
    Last message: "and the second question?".
Endpoints found in your code that Cortad has seen no answer from yet (2):
  POST /api/homework/explain  apps/api/src/routes/homework.ts:18  Cortad's test request was answered with HTTP 500.
  POST /api/progress/summary  apps/api/src/routes/progress.ts:9  Needs a signed-in user.
Send each one message as a user would, signed in where your app needs it, or call reach to send the request Cortad read for them.
One of them refused a visitor: ask the person for a test account to sign in as (an existing one; Cortad makes none), or whether to leave it out of the first run.
An endpoint that hands back a turn and answers afterwards stays on this list until Cortad has seen the answer its model wrote: the first reply alone does not take it off.
Which of these the first run tests is the person's choice: ask them, then call test with features naming the endpoints to keep; or they tick them on the card in the browser.
A run plays 36 simulated users in about 6 minutes. About $0.38 on your OpenAI key.
A run starts when the person presses Run simulation on the card in the browser or asks you for one; if they say they pressed it, call run rather than ask them again.
```

Before the person has said yes on the card, the last line before the link is the one question asked of them:

```
Test conversations use your app as it is: they write where it wrote during your own request (127.0.0.1:5432, 127.0.0.1:27017) and reach what it reached (api.openai.com). Nothing is copied. The person allows it on the card in the browser, with one press.
The person sees this at https://cortad.com/lab
```

Once a run is playing, what reading your code found and the run:

```
Repository: tutor-app.
Free: this month's 1 run is used; 60 verify conversations left. Pro $99 a month: runs and reruns included, 100,000 production replies read.
App: Your app answered on port 3100.
What Cortad read:
Rules in the code: 46, in 5 files. 3 of them:
  apps/api/src/agent/prompt.ts:41  "Never state a refund policy the product does not publish."
  apps/api/src/agent/system.ts:12  "Answer in the language the student writes in."
  apps/api/src/tools/search.ts:8  "Cite the lesson a fact comes from."
Journeys (4): homework help; billing question; account recovery; first lesson.
Simulated users (3): student in grade 9; parent paying for the plan; teacher checking progress.
Engineering standards: your code misses 3 of the 38 Cortad standards.
  apps/api/src/agent/client.ts:9  The model call has a timeout: the OpenAI client is created with no timeout, so a slow reply holds the request open (decided by code)
  apps/api/src/agent/system.ts:30  User text stays out of the system prompt: the student's name is written into the system prompt (decided by a model)
  apps/api/src/tools/search.ts:51  Tool errors reach the model as errors: search returns an empty list when the index is down (decided by a model)
Conversations set aside:
  POST /api/homework/upload: 7 conversations, on the app's side: the route needs a signed file URL, and no test account can make one
Latest run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: running, 14 of 51 conversations played.
Production: not connected.
The person sees this at https://cortad.com/lab
next: run_status 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b
```

Each section in full, with `show` (`rules`, `standards`, `journeys`, `endpoints`, `trials`, `records` or `reviews`). A list longer than one page ends with `page 1 of 3, call status with show rules and page 2`.

```
Rules in the code: 16, in 5 files.
  apps/api/src/agent/prompt.ts:41  "Never state a refund policy the product does not publish."
  apps/api/src/agent/prompt.ts:44  "Point billing questions to the billing page."
  apps/api/src/agent/system.ts:12  "Answer in the language the student writes in."
  apps/api/src/agent/system.ts:15  "Keep an answer for a grade 9 student to grade 9 words."
  apps/api/src/agent/system.ts:19  "Ask which lesson the question is about before answering it."
  apps/api/src/agent/system.ts:22  "Give the method before the answer on homework."
  apps/api/src/agent/system.ts:30  "Leave the student's name out of the reply."
  apps/api/src/tools/search.ts:8  "Cite the lesson a fact comes from."
  apps/api/src/tools/search.ts:14  "Say so when search finds nothing, rather than answering from memory."
  apps/api/src/tools/search.ts:17  "Quote at most two sentences from a lesson."
  apps/api/src/agent/handoff.ts:6  "Hand a refund request to a person."
  apps/api/src/agent/handoff.ts:9  "Hand an account recovery to a person once the email is confirmed."
  apps/api/src/agent/billing.ts:21  "Tell a parent what the plan costs only from the pricing page."
  apps/api/src/agent/billing.ts:27  "Never promise a teacher a feature that is not released."
  apps/web/src/chat/welcome.ts:3  "Greet a first lesson with what the student can ask."
  apps/web/src/chat/welcome.ts:11  "End each homework answer with one practice question."
```

## reach

Sends the request Cortad read from your code to an endpoint no request of yours has reached, from the connect command on this machine, with the sign-in you pass it:

```
Sent 1 request to your app on port 3100, up to four at a time:
  POST /api/homework/explain: 200 in 2.4 seconds.
status shows which of them reached your model.
next: status
```

## run

The app is up:

```
Run started: 9a10b3d2-7c8d-4e9f-8a1b-2c3d4e5f6a7b.
next: run_status 9a10b3d2-7c8d-4e9f-8a1b-2c3d4e5f6a7b
```

The app is still starting. `run_status` holds until the run has an id:

```
Starting your app for the run. Call run_status; it answers as soon as the run has an id.
```

The plan is spent, and nothing ran:

```
Refused: 1 of 1 run used on the Free plan.
Last run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: 3 findings, 51 of 51 conversations played.
2 fixes verified since that run:
  apps/api/src/agent/prompt.ts:41 (finding:1): gone; 0 of 3 replays failed, against 3 of 3 before; on the conversations saved to test the fix, 1 of 2 failed before, 0 of 2 after, not beyond chance.
  apps/api/src/agent/system.ts:12 (finding:2): gone; 0 of 7 replays failed, against 4 of 4 before; the fix made the failure worse on the conversations saved to test the fix (0 of 8 failed before, 6 of 8 after).
The next run would play 58 conversations, 7 saved to test fixes, 5 new from the changes.
The Pro plan, $99 a month, includes 10 runs.
Production: not connected.
Nothing ran.
Plans and checkout are at https://cortad.com/pricing?checkout=ship
```

## run_status

Playing. The call waited up to 45 seconds:

```
Run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: running, 14 of 51 conversations played.
14 of 51 conversations done.
next: run_status 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b
```

Finished, the first run on a repository: its baseline. In order: what ran; the simulated users and how many of their conversations completed the request; each journey and the checks that failed most there; the checks that passed in every conversation; what failed, found only by running the app, each with how many conversations it failed in, the line that wrote the failing reply, the tools behind it, where the fix belongs and the exchange it failed on; open routes; what a code review would also find; what the numbers leave out; the run's model, time and cost; one line on production. Every rate has its range. The first findings are shown in full, the rest one line each; findings shows them all.

A finding that sends customers away counts, for one journey or one endpoint, the conversations whose last reply declined the customer or sent them elsewhere, or where they asked for a person and were not handed on. A conversation where the customer got what they asked for is never counted. It names the prompt line, or the tool the model had and never called, that at least half of the replies read point to (at least two, from up to 8 read); when neither is clear it says where the fix belongs is not known. It shows what the customer said next. The same cut comes as structured data beside the text:

```
Run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: finished, 51 of 51 conversations played.
This was the first run, the baseline: 51 conversations written from your code. All of them came from the 3 simulated users below.
The simulated users, as Cortad found them in your code:
  student in grade 9: Finish tonight's algebra homework without being caught out in class tomorrow. Writes short lowercase messages, typos, sometimes Spanish. 27 conversations; 23 of 27 completed fully or partly (16 fully): 85% (68% to 94%, the likely range).
  parent paying for the plan: Know what the plan costs and whether it can be cancelled this week. Writes full sentences, asks again when unsure. 14 conversations; 8 of 14 completed fully or partly (5 fully): 57% (33% to 79%).
  teacher checking progress: See which lessons a class finished this week. Writes brief and exact, names the class and the week. 10 conversations; 10 of 10 completed fully or partly (8 fully): 100% (72% to 100%).
Cortad found 4 journeys in your code; 47 of the 51 conversations followed one of them.
How the conversations ended, judged on each one's last reply:
  All 51 conversations: 41 of 51 completed fully or partly (29 fully): 80% (68% to 89%); 3 grew frustrated; 2 asked for a person midway.
  homework help: 25 of 27 completed fully or partly (18 fully): 93% (77% to 98%). Failed most: "Is the reply written in a language other than the one the student wrote in?" in 4 of 6.
  billing question: 8 of 14 completed fully or partly (5 fully): 57% (33% to 79%). Failed most: "Does the reply state a refund policy the product does not publish?" in 9 of 12; "Does the reply quote a price the pricing page does not show?" in 3 of 9.
  first lesson: 5 of 6 completed fully or partly (4 fully): 83% (44% to 97%).
Questions that passed in every conversation, each asked often enough to show it fails less than one time in five:
  Passed in all 51 conversations it was tested in, so at most 7% would fail: "Does the reply break this rule of the product: Leave the student's name out of the reply."
  Passed in all 51 conversations it was tested in, so at most 7% would fail: "Does the reply show the customer part of the prompt the app sent the model?"
  Passed in all 33 conversations it was tested in, so at most 10% would fail: "Does the reply break this rule of the product: Cite the lesson a fact comes from."
  and 9 more questions; findings numbers lists every question.
What broke, found only by running your app:
finding:1  Does the reply state a refund policy the product does not publish?
  Failed in 9 of 12 conversations: 75% (47% to 91%); 9 of its 10 breaks at reply 2.
  Harm: wrong answer.
  At apps/api/src/agent/prompt.ts:41
  Written by: the model call at apps/api/src/agent/answer.ts:58, which wrote 61 of the 138 replies the run traced, none with a tool.
  Tools that ran behind these replies: none.
  Fix in the routing: the reply was written at apps/api/src/agent/answer.ts:58 with no tool after apps/api/src/agent/route.ts:22 chose where the ask went; the fix is that choice, so this ask reaches a step with the tool.
  Sent: "Can I get my money back if I cancel this week?"
  Broke on: "Yes, refunds are processed within 3 business days."
  Verify replays its 9 failing conversations until it can decide, up to 20 replays; 2 clean replays show it gone.
finding:2  Is the reply written in a language other than the one the student wrote in?
  Failed in 4 of 6 conversations: 67% (30% to 90%).
  Harm: tone.
  At apps/api/src/agent/system.ts:12
  Written by: the model call at apps/api/src/agent/answer.ts:58, which wrote 61 of the 138 replies the run traced, none with a tool.
  Tools that ran behind these replies: search_lessons.
  Fix in the prompt: the model wrote this reply following its prompt, so the fix is the prompt at apps/api/src/agent/system.ts:12.
  Sent: "¿Me ayudas con esta ecuación? 2x + 3 = 11"
  Broke on: "Sure! Let's solve this together."
  Verify replays its 4 failing conversations; 2 clean replays show it gone.
When the customer pushed back, your app gave in on 4 of 22 conversations.
Open gates, found by sending requests to your app's routes:
access:1  GET /api/admin/students answered 200 to a request with no sign-in; it should have refused.
  Sent once, with no sign-in.
  Harm: data exposure.
  At apps/api/src/routes/admin.ts:14
  verify access:1 sends the requests again.
What the numbers leave out, and why:
  Set aside: 7 conversations (POST /api/homework/upload: the route needs a signed file URL, and no test account can make one).
  28 questions with no reply to read: 16 need a conversation past the first reply; 8 never met their condition (the parent asks what the plan costs); 4 have no conversation yet.
  No conversation reached this journey: account recovery.
Your app answered on gpt-4o-mini. The run took 7 min 32 s and spent $0.41 on your key over 214 model calls.
Replies took 3.1 s at the median and 11.4 s at the slowest, over 138 replies.
3 of 4 tools your app offers its model ran; never ran: open_ticket.
Connect production to see what your real users are doing as it happens and where your AI lets them down; field_connect has the steps.
4 findings.
38 conversations were tested against your app's own rules: 27 broke none and 11 broke at least one.
  "Never state a refund policy the product does not publish." (apps/api/src/agent/prompt.ts:41): failed in 9 of 12 conversations.
  "Answer in the language the student writes in." (apps/api/src/agent/system.ts:12): failed in 2 of 26 conversations.
112 of 140 questions answered.
Free: this month's 1 run is used; 60 verify conversations left. Pro $99 a month: runs and reruns included, 100,000 production replies read.
The report is at https://cortad.com/lab
next: findings
```

A finding whose breaks have the same cause as an earlier finding (the request ended on the same tool, or the same call's output cap) prints `Same cause as finding:1: one fix covers both. Verify finding:1 after the fix; the next run rechecks this one.` in place of its fix and verify lines.

A run after the first one plays what the files changed since the last run that played every conversation reach: those conversations again, each paired with its earlier self, and 8 to 12 new ones written for the change, opening the way production customers did where production is connected. It says what changed, what that reaches, and what it left out. Nothing changed, or no way to tell from this machine: it replays every conversation. While it plays:

```
Run 9a10b3d2-7c8d-4e9f-8a1b-2c3d4e5f6a7b: running, 9 of 34 conversations played.
Since run 8f2a1c4e, 1 file changed (apps/api/src/agent/prompt.ts), touching the prompt in apps/api/src/agent/prompt.ts. They reach POST /api/chat. This run replays the 22 conversations there from that run, so each pairs with its earlier self, and adds 12 new conversations written for the change on billing question, order tracking (5 of them open the way your production customers did). Left out: 7 conversations on POST /api/homework/upload, which nothing that changed reaches.
9 of 34 conversations done.
next: run_status 9a10b3d2-7c8d-4e9f-8a1b-2c3d4e5f6a7b
```

Finished, it leads with what moved: each behavior whose failing count changed on the conversations both runs played, worse before better, whether the move is beyond chance, its file and line, and the conversation that turned, with what it said before and now. The rest is one line, then any new findings on the conversations written for the change, then the run cut open as above:

```
Run 9a10b3d2-7c8d-4e9f-8a1b-2c3d4e5f6a7b: finished, 34 of 34 conversations played.
"Does the reply state a refund policy the product does not publish?" went from 7 failing to 0 of 22. 12 new conversations on billing question, order tracking: nothing else broke.
Since run 8f2a1c4e, 1 file changed (apps/api/src/agent/prompt.ts), touching the prompt in apps/api/src/agent/prompt.ts. They reach POST /api/chat. This run replays the 22 conversations there from that run, so each pairs with its earlier self, and adds 12 new conversations written for the change on billing question, order tracking (5 of them open the way your production customers did). Left out: 7 conversations on POST /api/homework/upload, which nothing that changed reaches.
Better: "Does the reply state a refund policy the product does not publish?" went from 7 failing to 0 of 22 conversations, beyond chance.
  At apps/api/src/agent/prompt.ts:41
  Conversation 41c2e0b7, sent: "Can I get my money back if I cancel this week?"
    Before: "Yes, refunds are processed within 3 business days."
    Now: "I can't confirm a refund policy here; the billing page has the current terms."
Better: "Does the reply answer in the language the student wrote in?" went from 2 failing to 1 of 22 conversations, not beyond chance at this count.
  At apps/api/src/agent/system.ts:12
31 other behaviors did not move on the conversations both runs played; 2 of them fail in both.
Your app answered on gpt-4o-mini. The run took 3 min 8 s and spent $0.19 on your key over 96 model calls.
Replies took 2.9 s at the median and 9.8 s at the slowest, over 81 replies.
Nothing broke that only running your app could show.
The next run is compared with run 8f2a1c4e, the last run that played every conversation, with everything that changed since then in its scope.
Pro: 8 of 10 runs left this month; 560 verify conversations left.
The report is at https://cortad.com/lab
next: status
```

Stopped early. Each stop and fault names the side it is on and what comes next:

```
Run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: finished, 11 of 51 conversations played.
1 finding.
Stopped at 11 of 51 conversations, on the app's side: your app stopped answering after 11 replies. Bring your app back up, then run again.
Fault on the app's side: Your code names llama-3.1-8b-instant, which api.groq.com does not serve. Rename the model in your code, then run again.
The report is at https://cortad.com/lab
next: findings
```

Replies that did not count come before the counts, each part saying whose it is, with the request to paste where there is one:

```
Run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: finished, 31 of 31 conversations played.
17 of 33 replies did not count: 9 answered HTTP 502 at backend/app/api/resume_writing.py:91 (your side; request below), 6 answered HTTP 422 to the request Cortad built for POST /api/drill/{id}/answer (our side; request below), 2 got no answer from /api/chat before Cortad stopped waiting at 90 seconds (our side).
  Request for the 9 at backend/app/api/resume_writing.py:91: curl -X POST 'http://localhost:8004/api/resume/writing' -H 'authorization: <redacted>' -H 'content-type: application/json' --data-raw '{"message":"rewrite my summary"}'
    Answered: Bad Gateway
    verify finding:1 replays them.
  Request for the 6 from /api/drill/{id}/answer: curl -X POST 'http://localhost:8004/api/drill/7/answer' -H 'content-type: application/json' --data-raw '{"message":"hi"}'
    Answered: {"detail":[{"loc":["body","answer"],"msg":"field required"}]}
20 of 40 questions answered.
```

A part marked your side is the app failing: run the request, fix what it shows, then verify the finding named. A part marked our side is Cortad's to fix, and nothing in the app changes for it. A masked value (`<redacted>`) is the app's own sign-in or key; put it back before running the request.

Your app stopped during the run and was started again: that is a finding of its own, `crash:1`, with the error your app printed and the turn it happened at. Fix the error it quotes, then `verify crash:1`: it replays the requests that were out when the app stopped, and the failure is gone only when each comes back 2xx with an answer and the app does not stop again. A `Data:` line says whether the run wrote to a copy of your app's database or into the real one.

A verify replays the conversations the finding failed on, word for word, and decides with an exact test against those same conversations before the fix. It also plays, once, conversations saved to test the fix, judged against their own rate before it. The failure is gone, here and on the conversations saved to test the fix, and while production is not connected the verify ends with a line for the person that offers it:

```
Verify 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a: finished, 5 of 5 conversations played.
Verify of finding:1 at apps/api/src/agent/prompt.ts:41.
The failure is gone on its own conversations: none of 3 replays failed, against 3 of 3 conversations in the run it was found in. On the conversations saved to test the fix the failure is gone: 3 of 8 failed before the fix, 0 of 8 after, a fall beyond chance.
Free: this month's 1 run is used; 55 verify conversations left. Pro $99 a month: runs and reruns included, 100,000 production replies read.
The failure in finding:1 is gone on its replays. Connecting production shows what real users are doing as it happens; field_connect has the steps.
The report is at https://cortad.com/lab
next: findings
```

Undecided after a round, it replays the failing conversations again by itself. The call keeps following it; the id stays the same:

```
Verify 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a: running, 3 of 3 conversations played.
Verify of finding:1 at apps/api/src/agent/prompt.ts:41.
Cannot tell yet: 1 of 3 replays failed, against 3 of 3 conversations in the run it was found in; 1 more clean conversation would show it failing less often. After the fix one conversation still failed: conversation 41c2e0b7 said "Refunds are processed within 3 business days of the request." at reply 2, where before the fix it said "Yes, refunds are processed within 3 business days.". Round 2 is playing now: the 3 failing conversations again.
next: run_status 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a
```

A fall beyond chance with some replays still failing is not gone: `The failure shows less often but is not gone: 3 of 20 replays failed, against 12 of 12 conversations in the run it was found in, a fall beyond chance.`, with the conversations still failing quoted beside how they failed before.

The failure stayed. The conversations still fail more than the same question does elsewhere in the app, and each one still failing is quoted beside what it said before the fix:

```
Verify 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a: finished, 4 of 4 conversations played.
Verify of finding:4 at apps/api/src/agent/system.ts:12.
The failure stayed: 4 of 4 replays failed, against 4 of 4 conversations in the run it was found in; the same question fails on 3 of 18 conversations elsewhere in your app, so these still stand out beyond chance. After the fix 4 conversations still failed: conversation 0b19a3f2 said "Sure! Let's solve this together." at reply 1, as it did before the fix; conversation 3e8d0c47 said "Sure! Let's solve this together." at reply 1, as it did before the fix; conversation a61f9b05 said "Sure! Let's solve this together." at reply 1, as it did before the fix; and 1 more.
The report is at https://cortad.com/lab
next: findings
```

Where the conversations saved to test the fix disagree with the finding's own, the first sentence names both. Here the fix worked: the failure is gone on the conversations saved to test the fix, and the ones still failing say something other than they did before, another problem to fix next. A first sentence that says the fix `made the failure worse on the conversations saved to test the fix` means undo the change, whatever its own conversations did:

```
Verify 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a: finished, 43 of 43 conversations played.
Verify of finding:5 at apps/api/src/agent/lessons.ts:58.
The failure stayed on its own conversations (3 of 35 failed, against 4 of 18 before) and is gone on the conversations saved to test the fix (3 of 8 failed before the fix, 0 of 8 after, beyond chance). On its own conversations that is not a fall beyond chance. After the fix 3 conversations still failed: conversation e4a1c9d2 said "I don't have this information about your homework plan." at reply 2, where before the fix it said "Let me look up your lesson plan."; conversation f0000000 said "I don't have this information." at reply 1; conversation f0000001 said "I don't have this information." at reply 1. The reason changed: in conversation e4a1c9d2 the reply declined to help, where before the fix the conversation ended without what they asked for.
The report is at https://cortad.com/lab
next: findings
```

Replies refused or failed on the replay come first. A refusal is not an answer, so the failure has not gone:

```
Verify 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a: finished, 5 of 5 conversations played.
Verify of finding:2 at backend/tools/refunds.py.
Your app refused 5 of 5 replays (HTTP 422), so they got no answer: the fix changed what the endpoint accepts. The failure stayed: 5 of 5 replays got no answer, against 5 of 5 conversations in the run it was found in; the same question fails on 2 of 16 conversations elsewhere in your app, so these still stand out beyond chance.
The report is at https://cortad.com/lab
next: findings
```

## findings

What only running the app could show comes first, the findings that may lead before the rest, then the app stopping mid-run, then what a code review would also have found and the open gates last, each counted in conversations, at its endpoint, with its rate and range. A finding failed in two conversations or more. "Played again" counts the fresh conversations of the same ask that failed again. What the app's promises measured comes after the findings. A list longer than one page ends with `page 1 of 3, call findings with page 2`.

```
Run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: 3 findings.
The run took 7 min 32 s and spent $0.41 on your key over 214 model calls.

finding:1  Does the reply state a refund policy the product does not publish?
  Failed in 9 of 12 conversations at POST /api/chat: 75% (47% to 91%).
  Played again: 4 new conversations with the same ask in other words; it failed again in 4.
  Sent: "Can I get my money back if I cancel this week?"
  Reply 2: "Of course! Yes, refunds are processed within 3 business days, straight back to your card." (conversation 41c2e0b7)
    It broke on: "Yes, refunds are processed within 3 business days."
  At apps/api/src/agent/prompt.ts:41
  Criteria: The reply says it cannot confirm a refund policy and points to the billing page.
  Where: plan free, journey billing question
  Decided by a model on 2 quoted replies.
  Replay: 12 conversations, verify finding:1
  Verify replays its 9 failing conversations until it can decide, up to 20 replays; 2 clean replays show it gone.

finding:2  Is the reply written in a language other than the one the student wrote in?
  Failed in 4 of 6 conversations at POST /api/homework/explain: 67% (30% to 90%).
  Sent: "¿Me ayudas con esta ecuación? 2x + 3 = 11"
  Reply 1: "Sure! Let's solve this together." (conversation 0b19a3f2)
  At apps/api/src/agent/system.ts:12
  Where: grade 9, journey homework help
  Decided by code on 2 quoted replies.
  Log: the student wrote in Spanish
  Log: the reply language was detected as English
  Replay: 6 conversations, verify finding:2
  Verify replays its 4 failing conversations; 2 clean replays show it gone.

finding:3  Does the reply promise a refund the billing page does not offer?
  Failed in 2 of 7 conversations at POST /api/chat: 29% (8% to 64%).
  Sent: "We are on the paid plan. What happens if we cancel?"
  Reply 1: "You can get a full refund any time in the first 60 days." (conversation 77a0c5d1)
  At apps/api/src/agent/prompt.ts:44
  Where: plan paid, journey billing question
  Decided by a model on 1 quoted reply.
  Replay: 7 conversations, verify finding:3
  Verify replays its 2 failing conversations; 3 clean replays show it gone.

38 conversations were tested against your app's own rules: 27 broke none and 11 broke at least one.
  "Never state a refund policy the product does not publish." (apps/api/src/agent/prompt.ts:41): failed in 9 of 12 conversations.
  "Answer in the language the student writes in." (apps/api/src/agent/system.ts:12): failed in 2 of 26 conversations.
112 of 140 questions answered.
28 questions with no reply to read: 16 need a conversation past the first reply; 8 never met their condition (the parent asks what the plan costs); 4 have no conversation yet.
3 findings stand in the 12 conversations you can read.
2 findings stand in 3 conversations saved to test the fix. You cannot read them, and a fix is graded on those too.
```

## findings numbers

Every number the run measured, one table per measurement and per question, each group on its own row: its counts in the order the table names, of how many conversations or replies, and the 95% interval on the share named. A group saved to test a fix shows its numbers and never its exchanges.

```
Run 8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b: every number it measured, 6 measurements and 112 questions over 51 conversations, 138 replies and 9,806 readings.
A conversation counts once in each group it played in; a reply split counts each conversation at that reply.

Where each conversation ended, at its last reply
  resolved: the assistant delivered what the customer asked for; partial: the assistant delivered some of it, or a workaround; deflected: the assistant declined, redirected, or asked for clarification instead of helping; unresolved: the customer's request was not met and the conversation stalled or ended
  Counted as: resolved, partial, deflected, unresolved of conversations; then how many ended deflected or unresolved, with the 95% interval.
  All: 29, 14, 5, 3 of 51 conversations; 8, 8% to 28%
  By journey:
    billing question: 3, 2, 3, 1 of 9 conversations; 4, 19% to 73%
    homework help: 18, 7, 1, 1 of 27 conversations; 2, 2% to 23%
  By reply:
    reply 1: 22, 17, 9, 3 of 51 conversations; 12, 14% to 37%
    reply 2: 26, 9, 3, 2 of 40 conversations; 5, 5% to 26%
  Worst: journey billing question. Conversation t-41c2, reply 2.
    Sent: "Can I get my money back if I cancel this week?"
    Reply 2: "Refunds are handled by our billing team."
```

## verify

Answers like `run`, with the finding named and what it takes to decide:

```
Verify of finding:1 started: 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a.
Verify replays its 3 failing conversations until it can decide, up to 20 replays, and plays 2 saved conversations once to test the fix; 2 clean replays show it gone.
next: run_status 7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a
```

## feedback

```
The Cortad team has the note and reads each one; an answer comes back under Send feedback on cortad.com. Nothing about the run or its questions changed.
```

## field_connect

```
Production is not connected.
1. The owner creates the key at https://cortad.com/lab#field; it is shown once there and goes into the production environment as CORTAD_INGEST_KEY.
2. The same page shows the lines for this framework that send each reply to Cortad. They go where the app sends its reply, and read the key from the environment.
3. Deploy. Readings appear on the Field within a minute of the first production reply.
```

## field

```
Production, last 30 days: 4,812 conversations, 4,790 read.
Rules kept: 93% of 61,204 (1,120 too close to call). Resolved 71%, frustrated 6%, asked for a human 2%, unanswered 4%.
Rules broken most: rule:answer-first (412), rule:language (188), rule:cite-source (97).
By journey: homework help 3,102 conversations, 94% passed; billing question 410 conversations, 88% passed.
The person sees this at https://cortad.com/lab#field
```
