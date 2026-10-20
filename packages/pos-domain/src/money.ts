import type { Cents, ShopLocale } from '@cheeseoclock/shared-types';
import { getShopLocale } from '@cheeseoclock/shared-types';

/**
 * Format cents as the shop's money. The only place money is formatted for a
 * screen (CLAUDE.md), which is why the locale goes inside the function rather
 * than through its 545 call sites.
 *
 * With no locale given it uses the one this process is running as, which is
 * Pakistan until a till says otherwise — so every existing caller still gets
 * "Rs 4,000" and the pilot cannot tell the difference. The oracle tests in
 * __oracle__ hold that to v0.7.51 to the character.
 */
export function formatCents(
  cents: Cents | number,
  opts?: { showSymbol?: boolean; locale?: ShopLocale },
): string {
  const showSymbol = opts?.showSymbol ?? true;
  const locale = opts?.locale ?? getShopLocale();
  const value = (cents as number) / 100;
  // Whole units print bare ("Rs 4,000"); part units always show both minor
  // digits ("Rs 641.10", never "Rs 641.1").
  const whole = Math.round(cents as number) % 100 === 0;
  const formatted = new Intl.NumberFormat(locale.numberLocale, {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
  return showSymbol ? `${locale.symbol}${locale.symbolSeparator}${formatted}` : formatted;
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
