// A question only this repository can answer: whether a price the assistant quoted is one we sell
// at. A percentage is not a price, which is the kind of thing a model reading the words gets wrong.
const PRICES = [59, 79, 89, 129];
const MONEY = /(?:£|\$|€)\s?(\d{2,4})|\b(\d{2,4})\s?(?:dollars|pounds|euros|usd|gbp|eur)\b/gi;

export const pricesAreOurs = ({ transcript }) => {
  const quoted = transcript
    .filter((t) => t.role === "app")
    .flatMap((t) => [...t.text.matchAll(MONEY)].map((m) => Number(m[1] ?? m[2])));
  if (!quoted.length) return "did not come up";
  const wrong = quoted.find((n) => !PRICES.includes(n));
  return wrong === undefined ? "yes" : { answer: "no", quote: String(wrong), why: `${wrong} is not a price we sell at` };
};
