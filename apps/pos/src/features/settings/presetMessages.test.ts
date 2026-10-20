/**
 * The discount buttons' refusals, written when the value is checked: the
 * count words come from an array-level errorMap (same order .min/.max gave),
 * the label from a lazy moneyField name. Pakistan word for word; the US in
 * its own words.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { discountPresetsSchema } from '@cheeseoclock/shared-schemas';
import { PRESET_FLATS_MAX, US_SHOP_LOCALE, resetShopLocale, setShopLocale } from '@cheeseoclock/shared-types';

afterEach(resetShopLocale);

const presets = (flatCents: number[]) => ({ v: 1, percents: [10], flatCents, reasons: ['Staff'] });
const refusal = (flatCents: number[]): string => {
  const r = discountPresetsSchema.safeParse(presets(flatCents));
  if (r.success) throw new Error(`${JSON.stringify(flatCents)} was accepted`);
  return r.error.issues[0]?.message ?? '';
};

describe('Pakistan: the rupee buttons, as they always read', () => {
  it('refuses in the same words', () => {
    expect(refusal([])).toBe('Keep at least one rupee button');
    expect(refusal(Array.from({ length: PRESET_FLATS_MAX + 1 }, (_, i) => (i + 1) * 100))).toBe(
      `At most ${PRESET_FLATS_MAX} rupee buttons`,
    );
    expect(refusal([100, 100])).toBe('Two rupee buttons are the same');
    expect(refusal([0])).toBe('A rupee button is at least Rs 1');
    expect(refusal([150])).toBe('A rupee button is in whole rupees');
  });
});

describe('the US: dollar buttons', () => {
  it('refuses in its own words', () => {
    setShopLocale(US_SHOP_LOCALE);
    expect(refusal([])).toBe('Keep at least one dollar button');
    expect(refusal([100, 100])).toBe('Two dollar buttons are the same');
    expect(refusal([0])).toBe('A dollar button is at least $1');
    expect(refusal([150])).toBe('A dollar button is in whole dollars');
    expect(discountPresetsSchema.safeParse(presets([100, 200, 500])).success).toBe(true);
  });
});
