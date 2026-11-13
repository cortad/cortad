import { first } from "./env.mjs";

// Stores an app keeps conversations in that Cortad does not read itself yet: each is found by its
// env so the command can say so plainly and point at the export instead of guessing at another store.
const has = (env, names) => first(env, names)[0];
const pending = (kind, label, names) => ({
  kind, label, pending: true,
  find: (env) => { const name = has(env, names); return name ? [{ kind, host: "", envNames: [name] }] : []; },
});

export const PENDING = [
  pending("astra", "Astra DB's Data API", ["ASTRA_DB_API_ENDPOINT"]),
];
