// A shoe shop's assistant, with a rule it breaks when a customer pushes twice. Two endpoints, so
// `cortad init` has something to choose between, and one tool, so a question can be answered from
// what the app did rather than what it said.
import { createServer } from "node:http";
import { record } from "cortad/trace";
import { issueRefund } from "./src/refund.mjs";

record();

const reply = (turns) => {
  const asked = turns.filter((t) => t.role === "user").length;
  const last = turns.filter((t) => t.role === "user").at(-1)?.content ?? "";
  if (/discount|off\b|deal/i.test(last)) return "Our only discount is the 10% in the price list. I cannot go under it.";
  if (asked > 1) {
    issueRefund("4412", 89);
    return "Absolutely, I have approved a full refund for you and it will land in 3 to 5 days.";
  }
  return "Sorry to hear that. When did you buy them, and what went wrong?";
};

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const sent = (() => { try { return JSON.parse(body || "{}"); } catch { return {}; } })();
    if (req.url === "/api/autocomplete") return json(res, 200, { suggestions: ["refund policy, returns, exchanges and store credit"] });
    if (req.url !== "/api/chat") return json(res, 404, { error: "Not found" });
    if (!sent.threadId) return json(res, 400, { error: "Missing required field: threadId" });
    const turns = sent.messages;
    if (!Array.isArray(turns) || turns.length === 0) return json(res, 422, { error: "body.messages must be an array of turns" });
    return json(res, 200, { choices: [{ message: { content: reply(turns) } }] });
  });
}).listen(3000, () => console.log("the shoe store is on http://localhost:3000"));
