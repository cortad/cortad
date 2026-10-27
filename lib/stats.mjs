// A rate with no margin is an opinion wearing a number. Below a few hundred settled questions an
// improvement claim is noise, and the only honest way to say so is to print the interval beside it.
// Wilson, because the normal approximation is wrong at the edges, which is exactly where a suite
// that mostly holds lives.
const Z = 1.959964;

export function bounds(held, settled) {
  if (settled === 0) return { low: 0, high: 1 };
  const p = held / settled;
  const denom = 1 + (Z * Z) / settled;
  const centre = (p + (Z * Z) / (2 * settled)) / denom;
  const spread = (Z * Math.sqrt((p * (1 - p)) / settled + (Z * Z) / (4 * settled * settled))) / denom;
  return { low: Math.max(0, centre - spread), high: Math.min(1, centre + spread) };
}

export function rate(held, settled) {
  const { low, high } = bounds(held, settled);
  const lo = Math.round(low * 100);
  const hi = Math.round(high * 100);
  return {
    held,
    settled,
    percent: settled === 0 ? null : Math.round((held / settled) * 100),
    low: lo,
    high: hi,
    plusMinus: Math.round(((hi - lo) / 2) * 10) / 10,
  };
}
