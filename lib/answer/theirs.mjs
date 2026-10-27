// Their own questions, answered by their own code. A question we cannot imagine is the common case:
// whether the quote matched their price list, whether the ticket landed in their queue. This runs a
// function from their repository and takes its word, as long as the word is one of the four answers.
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isAnswer, ABSENT } from "./verdict.mjs";

export const QUESTIONS_FILE = "cortad.questions.mjs";

export async function loadTheirs(path) {
  if (!existsSync(path)) return {};
  const loaded = await import(pathToFileURL(path).href);
  const found = loaded.default ?? loaded;
  return Object.fromEntries(Object.entries(found).filter(([, v]) => typeof v === "function"));
}

const read = (given) => {
  if (isAnswer(given)) return { answer: given, quote: "", why: "" };
  if (given && isAnswer(given.answer)) {
    return { answer: given.answer, quote: typeof given.quote === "string" ? given.quote : "", why: typeof given.why === "string" ? given.why : "" };
  }
  return null;
};

export async function decide(question, theirs, context) {
  const name = question.fn;
  const fn = typeof name === "string" ? theirs[name] : undefined;
  if (!fn) return { answer: ABSENT, quote: "", why: `${QUESTIONS_FILE} exports no ${name ?? "function"} for this question` };
  let given;
  try {
    given = await fn({ question, ...context });
  } catch (e) {
    return { answer: ABSENT, quote: "", why: `${name} threw: ${e.message}` };
  }
  const answer = read(given);
  if (!answer) return { answer: ABSENT, quote: "", why: `${name} answered something that is not one of the four answers` };
  return { ...answer, why: answer.why || `answered by ${name} in ${QUESTIONS_FILE}` };
}
