/**
 * Money on paper. The receipt, the bill, the refund slip and (from v0.7.35)
 * the shift report print every figure through these, so a rupee looks the
 * same on all of them:
 *
 *   paperMoney(360000)        "3,600.00"
 *   paperMoney(-172500)       "-1,725.00"
 *   paperSignedMoney(25000)   "+250.00"    (the shift report's OVER)
 *   paperRupees(500000)       "5,000"      (the note faces: "Rs 5,000 x 12")
 *
 * Money is integer cents. There is no currency symbol (the paper adds "Rs "
 * where it wants one) and no locale: toLocaleString and Intl follow the PC's
 * own settings, and a paper must read the same on every till. ASCII only.
 */

/**
 * "1,234.56": rupees grouped in threes with commas, then both paisa digits,
 * with a leading "-" when negative. No currency symbol. This is the receipt's
 * own formatter (formatCentsForReceipt), moved here unchanged so receipts stay
 * byte for byte what they were.
 */
export function paperMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const n = Math.abs(cents);
  const rupees = Math.floor(n / 100);
  const paisa = n % 100;
  const r = rupees.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${r}.${paisa.toString().padStart(2, '0')}`;
}

/**
 * paperMoney with a "+" in front of a figure above zero: "+250.00" (OVER),
 * "-100.00" (SHORT), and plain "0.00" when it matches.
 */
export function paperSignedMoney(cents: number): string {
  const money = paperMoney(cents);
  return cents > 0 ? `+${money}` : money;
}

/**
 * Whole rupees with paperMoney's grouping and no paisa: "5,000", "10",
 * "-1,000". For the note faces of the cash count ("Rs 5,000 x 12"). A figure
 * that is not whole rupees keeps its two paisa digits ("7.50"), so a value is
 * never rounded away on paper.
 */
export function paperRupees(cents: number): string {
  const money = paperMoney(cents);
  return cents % 100 === 0 ? money.slice(0, -3) : money;
}
