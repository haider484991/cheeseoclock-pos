/**
 * FROZEN BASELINE — v0.7.51 (origin/main 182d8cb). DO NOT EDIT. DO NOT "FIX".
 *
 * Word-for-word copies of what the pilot tills PRINT: money on paper and the
 * Pakistan wall clock on paper. Paper is the strictest contract in the shop —
 * a receipt is the customer's record and the FBR's — so the international
 * edition must not move a single character of it for Pakistan.
 *
 * When an oracle test fails, the live code changed the pilot's paper. That is
 * the bug. Changing this file to match hides it.
 */

/** v0.7.51 printer-core/src/paper-money.ts paperMoney, copied word for word. */
export function baselinePaperMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const n = Math.abs(cents);
  const rupees = Math.floor(n / 100);
  const paisa = n % 100;
  const r = rupees.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${r}.${paisa.toString().padStart(2, '0')}`;
}

/** v0.7.51 paperSignedMoney, copied word for word. */
export function baselinePaperSignedMoney(cents: number): string {
  const money = baselinePaperMoney(cents);
  return cents > 0 ? `+${money}` : money;
}

/** v0.7.51 paperRupees, copied word for word. */
export function baselinePaperRupees(cents: number): string {
  const money = baselinePaperMoney(cents);
  return cents % 100 === 0 ? money.slice(0, -3) : money;
}

/** v0.7.51 shared-types/src/paper-time.ts: Pakistan is UTC+5 all year. */
const PKT_OFFSET_MS = 5 * 3_600_000;

type PaperTimeInput = Date | number | string;

/** v0.7.51 paper-time.ts pk(), copied word for word. */
function pk(at: PaperTimeInput): Date | null {
  const ms = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at);
  return Number.isFinite(ms) ? new Date(ms + PKT_OFFSET_MS) : null;
}

const two = (n: number): string => String(n).padStart(2, '0');

/** v0.7.51 paperClock, copied word for word. */
export function baselinePaperClock(at: PaperTimeInput): string {
  const d = pk(at);
  return d ? `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}` : '';
}

/** v0.7.51 paperDayMonthClock, copied word for word. */
export function baselinePaperDayMonthClock(at: PaperTimeInput): string {
  const d = pk(at);
  return d ? `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)} ${baselinePaperClock(at)}` : '';
}

/** v0.7.51 paperDateTime, copied word for word. */
export function baselinePaperDateTime(at: PaperTimeInput): string {
  const d = pk(at);
  return d
    ? `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${baselinePaperClock(at)}`
    : '';
}

/** mulberry32, as in the pos-domain oracle: reproducible sweeps. */
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
