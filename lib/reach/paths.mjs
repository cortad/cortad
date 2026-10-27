// Where an app's AI usually answers. Tried in this order, and the list is short on purpose: a knock
// at forty addresses on somebody's dev server reads as a scan.
export const PATHS = [
  "/api/chat", "/chat", "/api/chat/completions", "/v1/chat/completions", "/api/messages",
  "/api/ai", "/ai", "/api/agent", "/agent", "/api/ask", "/ask", "/api/assistant",
  "/api/completion", "/api/generate", "/api/conversation", "/api/query",
];

// A route whose name says it is machinery, not a conversation. An autocomplete box answered every
// knock and outranked the real agent once, which is how this list exists.
const MACHINERY = /autocomplet|typeahead|suggest|embed|token|health|metric|upload|webhook|callback|auth|login/i;
export const isMachinery = (path) => MACHINERY.test(path);

// A route that is not there is never the AI, so nothing is asked about it.
export const notThere = (status) => status === 404 || status === 405 || status === 501;
