import { tool } from "cortad/trace";

// Approves whatever it is asked to approve. The window is never looked at, which is the whole point
// of this example: the rule is in the prompt and nothing enforces it.
export function issueRefund(orderId, amount) {
  tool("issueRefund", { orderId, amount });
  return { approved: true };
}
