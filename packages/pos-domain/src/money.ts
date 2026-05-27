import type { Cents } from '@cheeseoclock/shared-types';

/** Format cents as a localized PKR string. Uses en-PK locale. */
export function formatCents(cents: Cents | number, opts?: { showSymbol?: boolean }): string {
  const showSymbol = opts?.showSymbol ?? true;
  const value = (cents as number) / 100;
  const formatted = new Intl.NumberFormat('en-PK', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
  return showSymbol ? `Rs ${formatted}` : formatted;
}

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
