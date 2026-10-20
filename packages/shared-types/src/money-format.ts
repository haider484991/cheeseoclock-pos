/**
 * Money and numbers as the shop writes them.
 *
 * This lives in shared-types, not pos-domain, because the Zod schemas in
 * shared-schemas put real figures into the messages a cashier reads ("at most
 * Rs 2,000") and shared-schemas depends on shared-types alone (CLAUDE.md).
 * pos-domain re-exports both, so every existing caller and the oracle keep
 * importing them exactly where they always did.
 */
import type { Cents } from './money.js';
import type { ShopLocale } from './shop-locale.js';
import { getShopLocale } from './shop-locale.js';

/**
 * Built Intl formatters, kept by locale and options.
 *
 * Constructing an Intl.NumberFormat is slow enough that several places in the
 * till hoisted one to module scope on purpose. The sweep moves those call
 * sites to formatNumber, so the cache has to live here instead — otherwise a
 * list of a hundred rows would build a hundred formatters on every render.
 * Keyed on the values that define the formatter, so a till that switches
 * locale simply starts using a different entry.
 */
const formatters = new Map<string, Intl.NumberFormat>();

function numberFormat(numberLocale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${numberLocale}|${options.minimumFractionDigits ?? ''}|${options.maximumFractionDigits ?? ''}|${options.useGrouping ?? ''}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(numberLocale, options);
    formatters.set(key, f);
  }
  return f;
}

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
  const formatted = numberFormat(locale.numberLocale, {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
  return showSymbol ? `${locale.symbol}${locale.symbolSeparator}${formatted}` : formatted;
}

/**
 * A plain number in the shop's format: a count, a quantity, a weight.
 *
 * Not money — money goes through formatCents, which also adds the symbol and
 * holds the two-minor-digit rule. This exists because about 70 Intl calls
 * around the till passed 'en-PK' directly and so never saw a shop's locale at
 * all. They read the same in Pakistan and follow the shop elsewhere.
 */
export function formatNumber(
  value: number,
  opts?: {
    locale?: ShopLocale;
    minFractionDigits?: number;
    maxFractionDigits?: number;
    useGrouping?: boolean;
  },
): string {
  const locale = opts?.locale ?? getShopLocale();
  return numberFormat(locale.numberLocale, {
    ...(opts?.minFractionDigits === undefined
      ? {}
      : { minimumFractionDigits: opts.minFractionDigits }),
    ...(opts?.maxFractionDigits === undefined
      ? {}
      : { maximumFractionDigits: opts.maxFractionDigits }),
    ...(opts?.useGrouping === undefined ? {} : { useGrouping: opts.useGrouping }),
  }).format(value);
}
