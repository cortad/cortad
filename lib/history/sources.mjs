import { BRAINTRUST } from "./braintrust.mjs";
import { HELICONE } from "./helicone.mjs";
import { LANGFUSE } from "./langfuse.mjs";
import { LANGSMITH } from "./langsmith.mjs";
import { OPIK } from "./opik.mjs";
import { PHOENIX } from "./phoenix.mjs";

// Every tool history can be read from, and which of them an env names every key of. Names only:
// a value is checked for being there, never read out or sent.
export const SOURCES = [LANGFUSE, LANGSMITH, HELICONE, BRAINTRUST, PHOENIX, OPIK];
export const sourcesIn = (env) => SOURCES.filter((s) => s.needs.every((n) => env[n]));
