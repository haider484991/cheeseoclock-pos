/**
 * Money bounds whose messages are written when the value is CHECKED, not when
 * this module is imported.
 *
 * Why this exists. The schemas here are module-level consts, so a message
 * written as `'The price step is at least Rs 1'` is built the moment the
 * module is first imported. In the till that happens at startup, BEFORE the
 * settings are read and the shop's locale is known. Interpolating the locale
 * into such a string would therefore bake Pakistan into a US till's errors —
 * the exact opposite of what the international edition is for.
 *
 * Zod v3 takes `message` as a plain string, so a built-in check like .min()
 * cannot be made lazy. superRefine's callback, though, runs at parse time, so
 * that is where these bounds live.
 *
 * Order matters. ZodNumber reports a failing check per declared check, and
 * every caller in the till reads issues[0].message, so the first issue is the
 * one a cashier sees. The checks below run in the same order the chained
 * .int().min().max() ran in, and stop at the first failure, so the message a
 * cashier reads is the one they read before.
 */
import { z } from 'zod';
import { formatCents, getShopLocale } from '@cheeseoclock/shared-types';

export interface MoneyFieldRules {
  /**
   * How the message names this value, e.g. "The price step" — or a function,
   * when the name itself has the money in it ("The rupee limit").
   */
  what: string | (() => string);
  /** Smallest allowed, in minor units. */
  minCents?: number;
  /** Largest allowed, in minor units. */
  maxCents?: number;
  /** Whole major units only (no paisa / no cents). */
  wholeMajorUnits?: boolean;
  /** Wording for the "below the minimum" case, which reads differently per field. */
  belowWording?: 'cannot be below' | "can't be below" | 'is at least';
  /**
   * Wording for "not a whole number". The till says this two ways already —
   * "is a whole number of paisa" on the price step, "is in whole paisa" on the
   * weekly amount — and a cashier should keep reading whichever they read
   * before, so the caller picks.
   */
  wholeWording?: 'is in whole' | 'is a whole number of';
  /**
   * Extra words after the minimum, where a field explains the way out:
   * "A delivery charge is at least Rs 1 (to take it off, use Take it off)".
   */
  minSuffix?: string;
  /**
   * Said when the value is not a number at all. This goes through a
   * schema-level errorMap rather than invalid_type_error, because an errorMap
   * is consulted at PARSE time while invalid_type_error is a plain string
   * fixed at import — the very thing this module exists to avoid.
   */
  invalidTypeWording?: 'is an amount in';
}

/**
 * A money amount in minor units, bounded, with every message in the shop's
 * own words and currency at the moment the value is checked.
 */
export function moneyField(rules: MoneyFieldRules) {
  const {
    what,
    minCents,
    maxCents,
    wholeMajorUnits,
    belowWording = 'is at least',
    wholeWording = 'is in whole',
    minSuffix,
    invalidTypeWording,
  } = rules;
  const named = (): string => (typeof what === 'function' ? what() : what);
  const base = invalidTypeWording
    ? z.number({
        errorMap: (issue, ctx) =>
          issue.code === z.ZodIssueCode.invalid_type
            ? { message: `${named()} ${invalidTypeWording} ${getShopLocale().words.major}` }
            : { message: ctx.defaultError },
      })
    : z.number();
  return base.superRefine((value, ctx) => {
    const locale = getShopLocale();
    const what = named();
    const fail = (message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    };
    if (!Number.isInteger(value)) {
      const unit = wholeMajorUnits ? locale.words.major : locale.words.minor;
      fail(`${what} ${wholeWording} ${unit}`);
      return;
    }
    if (minCents !== undefined && value < minCents) {
      fail(`${what} ${belowWording} ${formatCents(minCents)}${minSuffix ? ` ${minSuffix}` : ''}`);
      return;
    }
    if (maxCents !== undefined && value > maxCents) {
      fail(`${what} is at most ${formatCents(maxCents)}`);
      return;
    }
    if (wholeMajorUnits && value % 100 !== 0) {
      fail(`${what} ${wholeWording} ${locale.words.major}`);
    }
  });
}

/**
 * The words for the money, for a message this helper does not build itself.
 * Read at the moment it is called, for the same reason as above.
 */
export const moneyWords = (): { major: string; minor: string } => getShopLocale().words;
