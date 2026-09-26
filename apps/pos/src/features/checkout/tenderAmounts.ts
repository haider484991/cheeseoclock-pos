/**
 * One-tap cash amounts for the payment screen: the round notes a customer is
 * likely to hand over for this bill, smallest first. "Exact" is its own
 * button, so the bill itself is never one of these.
 */
export function quickCashRupees(totalCents: number, count = 4): number[] {
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
