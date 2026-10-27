// Three sets, so the thing can be run after every edit instead of once before a release.
//
//   smoke     a fifth of the suite, played by default. Seconds, not minutes.
//   standard  the rest of what runs before a commit.
//   full      a fifth the default loop never touches, so a release run is the first time a fix
//             meets them.
//
// Which fifth is a stable hash of the name, not a judgement: the tool has no way to know which of
// their conversations matter most, and pretending otherwise would be a guess wearing a number. A
// file can say its own tier, and that is how they mark what must never break.
export const TIERS = ["smoke", "standard", "full"];

// FNV-1a over the name. Small, stable across machines and versions, and nothing here is a secret.
export function hashOf(name) {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function tierOf(simulation) {
  if (TIERS.includes(simulation?.tier)) return simulation.tier;
  const at = hashOf(simulation?.id ?? "") % 5;
  if (at === 0) return "full";
  if (at === 1) return "smoke";
  return "standard";
}

// What a named run plays. Each set contains the ones before it, so a release run is never a
// different measurement from the loop that led to it.
export const PLAYS = { smoke: ["smoke"], all: ["smoke", "standard"], full: TIERS };

export const inRun = (simulation, which = "smoke") => (PLAYS[which] ?? PLAYS.smoke).includes(tierOf(simulation));
