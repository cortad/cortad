# A shoe shop's assistant

It has a rule in its prompt, "never promise a refund past 30 days", and nothing in the code enforces
it. When a customer pushes twice it approves the refund and calls `issueRefund`. That is the failure
this example exists to show, and the run finds it two ways: in the words, and in what the app did.

```sh
cd examples/shoe-store
npm link ../../..        # or install cortad, this example imports cortad/trace
node app.mjs &
npx cortad init          # finds /api/chat behind the 404 and the autocomplete
# fill in app and rules, or ask your agent to
npx cortad plan
npx cortad
```

Then fix it: make the assistant look at the date before approving anything. Run it again and the
delta says what moved. `npx cortad verify` plays only what failed.

`cortad.questions.mjs` here answers one question in this repository's own code: whether a price the
assistant quoted is one the shop sells at. No model can know that.
