// Which simulations reach a file the agent just edited, read off what the app recorded in the last
// run rather than guessed from names. A file nothing reaches has no coverage, and saying so is more
// use than running the whole suite and calling it green.
import { filesReached } from "./trace/read.mjs";

const tidy = (path) => path.replace(/^\.\//, "");

export function reaching(run, files) {
  const reached = filesReached(run?.conversations ?? []);
  const want = files.map(tidy);
  const ids = new Set();
  const covered = [];
  const bare = [];
  for (const file of want) {
    const found = reached.get(file);
    if (found?.size) {
      covered.push({ file, count: found.size });
      for (const id of found) ids.add(id);
    } else {
      bare.push(file);
    }
  }
  return { ids: [...ids], covered, bare, traced: reached.size > 0 };
}

// What the suite reaches, with no denominator invented. How many files their AI runs through is
// theirs to know; this says which ones a conversation has actually been through.
export function coverage(run) {
  const reached = filesReached(run?.conversations ?? []);
  return [...reached.entries()].map(([file, ids]) => ({ file, count: ids.size })).sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
}
