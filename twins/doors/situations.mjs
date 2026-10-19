// Moments a coding agent is actually in, written the way the person says them, with the call that
// reaches the answer under each arm. Where more than one tool reaches it, every one of them counts
// as right, so the nineteen are not scored against a single blessed answer they could miss by taste.
//
// `six.about: [undefined, ...]` means the door with nothing asked for already routes there, so
// naming the lane and leaving it out are both right.

export const SITUATIONS = [
  { said: "I just rewrote the system prompt in this repo. Check how the AI behaves now.",
    twenty: ["test", "run"], six: { door: "test" } },
  { said: "What did the run find?",
    twenty: ["findings", "run_status"], six: { door: "status", about: [undefined, "findings", "run"] } },
  { said: "Is the run finished yet?",
    twenty: ["run_status"], six: { door: "status", about: [undefined, "run"] } },
  { said: "I changed the refund wording for finding:3. Did that fix it?",
    twenty: ["verify"], six: { door: "verify" } },
  { said: "What is happening to the AI in our live app right now?",
    twenty: ["intelligence", "field", "incidents"], six: { door: "status", about: ["production"] } },
  { said: "Something started going wrong for real users on Tuesday. What and why?",
    twenty: ["incidents", "intelligence"], six: { door: "status", about: ["production"] } },
  { said: "Set this up on our live app so we can see what real users are doing.",
    twenty: ["connect", "field_connect"], six: { door: "connect" } },
  { said: "The check behind finding:2 is measuring something our product does not do at all.",
    twenty: ["dispute"], six: { door: "dispute" } },
  { said: "Let the Cortad team know their findings output was confusing to read.",
    twenty: ["feedback"], six: { door: "tell" } },
  { said: "How many live conversations mentioned refunds in the last 30 days? I want the count.",
    twenty: ["query", "field"], six: { door: "status", about: ["warehouse", "production"] } },
  { said: "What does this app count as a successful session, and how often do people get there?",
    twenty: ["outcomes"], six: { door: "status", about: ["outcomes"] } },
  { said: "I want our own service to get a POST whenever something goes wrong in the live app.",
    twenty: ["subscribe"], six: { door: "tell" } },
  { said: "I just opened this repo. Where are we?",
    twenty: ["status"], six: { door: "status", about: [undefined, "repository"] } },
  { said: "Our /api/chat endpoint did not answer earlier. Try it again.",
    twenty: ["reach"], six: { door: "test" } },
  { said: "The AI here is not a chatbot: it reads uploaded documents and flags risk. Test that.",
    twenty: ["test", "world"], six: { door: "test" } },
  { said: "How did the document test go?",
    twenty: ["world_status", "run_status"], six: { door: "status", about: [undefined, "run"] } },
  { said: "Give me every number the last run measured, not just the problems.",
    twenty: ["findings"], six: { door: "status", about: ["findings"] } },
  { said: "Try it again but only play 10 conversations, I do not want a big bill.",
    twenty: ["run", "test"], six: { door: "test" } },
  { said: "Which rules is our prompt being checked against?",
    twenty: ["status"], six: { door: "status", about: [undefined, "repository"] } },
  { said: "I think finishing signup should count as a win in this app. Put that forward.",
    twenty: ["outcomes"], six: { door: "tell" } },
  { said: "Nothing has come back since I changed the retrieval. What is going on?",
    twenty: ["status", "run_status"], six: { door: "status", about: [undefined, "run", "repository"] } },
  { said: "finding:7 came back as cannot tell. Run it again.",
    twenty: ["verify"], six: { door: "verify" } },
  { said: "What would a full run on this repo cost us?",
    twenty: ["status"], six: { door: "status", about: [undefined, "repository"] } },
  { said: "Which of our prompt's rules has never once been broken in a run?",
    twenty: ["findings", "status"], six: { door: "status", about: [undefined, "findings", "repository"] } },
];

// Whether the call an agent made reaches what the situation needed.
export const hit = (arm, one, call) => {
  if (!call) return false;
  if (arm === "twenty") return one.twenty.includes(call.name);
  if (call.name !== one.six.door) return false;
  return one.six.about === undefined || one.six.about.includes(call.arguments?.about);
};
