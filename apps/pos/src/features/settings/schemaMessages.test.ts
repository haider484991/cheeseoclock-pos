/**
 * What a cashier reads when a value is refused.
 *
 * These schemas are module-level consts, so until now their messages were
 * built when the module was first imported — at till startup, before the shop
 * locale is known. moneyField moves the wording into superRefine, which runs
 * at parse time, so the message follows the shop.
 *
 * The Pakistani half of this file is an oracle: every string is what the till
 * answered before the change, captured from the running schemas. If one of
 * these fails, a cashier at Cheese O'Clock is being shown something new.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { costingPriceStepSchema, costingAlertsSchema } from '@cheeseoclock/shared-schemas';
import { setShopLocale, resetShopLocale, US_SHOP_LOCALE } from '@cheeseoclock/shared-types';

afterEach(resetShopLocale);

/** The message a cashier is shown: every caller in the till reads issues[0]. */
function refusal(schema: { safeParse: (v: unknown) => unknown }, value: unknown): string {
  const r = schema.safeParse(value) as
    | { success: true }
    | { success: false; error: { issues: Array<{ message: string }> } };
  if (r.success) throw new Error(`${JSON.stringify(value)} was accepted, not refused`);
  return r.error.issues[0]?.message ?? '';
}

describe('Pakistan reads exactly what it read before', () => {
  it('refuses a price step in the same words', () => {
    expect(refusal(costingPriceStepSchema, 50)).toBe('The price step is at least Rs 1');
    expect(refusal(costingPriceStepSchema, 200_000)).toBe('The price step is at most Rs 1,000');
    expect(refusal(costingPriceStepSchema, 1.5)).toBe('The price step is a whole number of paisa');
  });

  it('refuses a weekly alert amount in the same words', () => {
    const bad = (impactWeekCents: number) => refusal(costingAlertsSchema, { jumpBps: 100, impactWeekCents });
    expect(bad(-1)).toBe('The weekly amount cannot be below Rs 0');
    expect(bad(1.5)).toBe('The weekly amount is in whole paisa');
    expect(bad(200_000_000)).toBe('The weekly amount is at most Rs 1,000,000');
  });

  it('still accepts what it always accepted', () => {
    expect(costingPriceStepSchema.safeParse(100).success).toBe(true);
    expect(costingPriceStepSchema.safeParse(100_000).success).toBe(true);
    expect(costingAlertsSchema.safeParse({ jumpBps: 100, impactWeekCents: 0 }).success).toBe(true);
  });
});

describe('a US till is told about dollars', () => {
  it('names the money the shop actually takes', () => {
    setShopLocale(US_SHOP_LOCALE);
    expect(refusal(costingPriceStepSchema, 50)).toBe('The price step is at least $1');
    expect(refusal(costingPriceStepSchema, 200_000)).toBe('The price step is at most $1,000');
    // "paisa" is not a word in a US kitchen.
    expect(refusal(costingPriceStepSchema, 1.5)).toBe('The price step is a whole number of cents');
  });

  it('builds the message at parse time, not at import time', () => {
    // The point of the whole change: the module was imported long before this
    // line ran, and the message still follows the locale set afterwards.
    expect(refusal(costingPriceStepSchema, 50)).toBe('The price step is at least Rs 1');
    setShopLocale(US_SHOP_LOCALE);
    expect(refusal(costingPriceStepSchema, 50)).toBe('The price step is at least $1');
    resetShopLocale();
    expect(refusal(costingPriceStepSchema, 50)).toBe('The price step is at least Rs 1');
  });
});
