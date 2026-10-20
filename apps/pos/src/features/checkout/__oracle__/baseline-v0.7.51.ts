/**
 * FROZEN BASELINE — v0.7.51. DO NOT EDIT. DO NOT "FIX".
 *
 * The one-tap "cash given" amounts exactly as the pilot tills offer them,
 * copied from the v0.7.51 source by `git show v0.7.51:<path>` rather than
 * retyped. The live quickCashRupees now reads the shop's notes from its
 * locale; for Pakistan it must keep giving these answers to the rupee.
 */
export function baselineQuickCashRupees(totalCents: number, count = 4): number[] {
  if (!(totalCents > 0)) return [];
  const out: number[] = [];
  const add = (rupees: number) => {
    if (rupees * 100 > totalCents && !out.includes(rupees)) out.push(rupees);
  };
  // The next Rs 100, 500, 1,000 and 5,000 at or above the bill.
  for (const note of [100, 500, 1000, 5000]) add(Math.ceil(totalCents / (note * 100)) * note);
  // A bill that is already round (Rs 1,000) gets the next notes up instead.
  for (const note of [500, 1000, 5000]) add((Math.floor(totalCents / (note * 100)) + 1) * note);
  return out.sort((a, b) => a - b).slice(0, count);
}

/** mulberry32, as in the other oracles: reproducible sweeps. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
