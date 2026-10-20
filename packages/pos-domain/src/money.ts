import type { Cents } from '@cheeseoclock/shared-types';

/**
 * formatCents and formatNumber moved to shared-types/money-format.ts so the
 * Zod schemas can use them too. Re-exported here because this is where the
 * till has always imported money formatting from, and the oracle with it.
 */
export { formatCents, formatNumber } from '@cheeseoclock/shared-types';

/** Sum a list of cents safely. */
export function sumCents(values: Array<Cents | number>): Cents {
  let total = 0;
  for (const v of values) total += v as number;
  return total as Cents;
}

/** Multiply cents by a quantity (integer). */
export function multCents(cents: Cents | number, qty: number): Cents {
  return Math.round((cents as number) * qty) as Cents;
}

/** Apply a basis-point rate to cents, rounded to nearest cent. */
export function applyBps(cents: Cents | number, bps: number): Cents {
  return Math.round(((cents as number) * bps) / 10_000) as Cents;
}
