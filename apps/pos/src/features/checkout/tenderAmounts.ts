import { getShopLocale } from '@cheeseoclock/shared-types';

/**
 * THE one quick-cash rule: the one-tap "cash given" amounts for a bill, on
 * Pay and on Live Orders' "Picked up / Delivered + Pay". The round notes a
 * customer is likely to hand over, smallest first: the next Rs 100, 500,
 * 1,000 and 5,000 at or above the bill, and for a bill that is already round
 * the next notes up. "Exact" is its own button on both screens, so the bill
 * itself is never one of these. At most `count` (4).
 */
export function quickCashRupees(totalCents: number, count = 4): number[] {
  if (!(totalCents > 0)) return [];
  // The shop's own notes, in whole units, smallest first. Pakistan's are
  // Rs 100, 500, 1,000 and 5,000 — the four this function always used, so a
  // Pakistani till's buttons are what they were (the oracle holds that).
  const notes = getShopLocale().quickCashFacesCents.map((c) => c / 100);
  const out: number[] = [];
  const add = (units: number) => {
    if (units * 100 > totalCents && !out.includes(units)) out.push(units);
  };
  // The next of each note at or above the bill.
  for (const note of notes) add(Math.ceil(totalCents / (note * 100)) * note);
  // A bill that is already round (Rs 1,000) gets the next notes up instead —
  // every note but the smallest, which would only repeat the bill.
  for (const note of notes.slice(1)) add((Math.floor(totalCents / (note * 100)) + 1) * note);
  return out.sort((a, b) => a - b).slice(0, count);
}
