import { describe, expect, it } from 'vitest';
import { DEFAULT_DISCOUNT_APPROVAL, DEFAULT_DISCOUNT_PRESETS } from '@cheeseoclock/shared-types';
import { FLAT_PRESETS_RUPEES, PERCENT_PRESETS, REASON_PRESETS, presetButtons, previewDiscount } from './discountPresets';
import {
  DEFAULT_COUNTER_DISCOUNTS,
  DEFAULT_COUNTER_KITCHEN,
  discountRulesOf,
  kitchenTimingOf,
} from '../settings/shop-rules/counterRules';

/**
 * The F3 screen built from the owner's values (Settings → Money & discounts,
 * from checkout:getRules): its buttons, and the lock on a button above the
 * limit — the same pos-domain rule the till checks when it saves. Made-up
 * prices: Rs 1,000 + Rs 500 + Rs 500 at 16% tax.
 */
const lines = [
  { lineTotalCents: 100_000, taxRateBps: 1600 },
  { lineTotalCents: 50_000, taxRateBps: 1600 },
  { lineTotalCents: 50_000, taxRateBps: 1600 },
];
const subtotal = 200_000;

describe('the buttons come from the owner’s values', () => {
  it('in the order he saved them, labelled as the till writes money', () => {
    const b = presetButtons({ percents: [15, 5], flatCents: [25_000, 100_000] });
    expect(b.percent).toEqual([
      { key: 'p15', label: '15%', choice: { type: 'percent', value: 15 } },
      { key: 'p5', label: '5%', choice: { type: 'percent', value: 5 } },
    ]);
    expect(b.flat).toEqual([
      { key: 'f25000', label: 'Rs 250', choice: { type: 'flat', value: 25_000 } },
      { key: 'f100000', label: 'Rs 1,000', choice: { type: 'flat', value: 100_000 } },
    ]);
  });

  it('with nothing saved they are today’s buttons, exactly', () => {
    const b = presetButtons(DEFAULT_DISCOUNT_PRESETS);
    expect(b.percent.map((x) => x.label)).toEqual(['10%', '20%', '25%', '50%', '100%']);
    expect(b.flat.map((x) => x.label)).toEqual(['Rs 100', 'Rs 200', 'Rs 500']);
    expect([...PERCENT_PRESETS]).toEqual([...DEFAULT_DISCOUNT_PRESETS.percents]);
    expect([...FLAT_PRESETS_RUPEES]).toEqual(DEFAULT_DISCOUNT_PRESETS.flatCents.map((c) => c / 100));
    expect([...REASON_PRESETS]).toEqual(['Staff', 'Friends & family', 'Regular customer', 'Complaint']);
  });
});

describe('the lock follows the owner’s limit', () => {
  it('a button above the limit shows the lock; one at or under it does not', () => {
    const limits = { percentOver: 15, flatOverCents: 25_000 };
    const locked = (choice: { type: 'percent' | 'flat'; value: number }) => previewDiscount(lines, subtotal, choice, { approval: limits, alsoOffDeliveryCharge: false }).needsApproval;
    expect(locked({ type: 'percent', value: 15 })).toBe(false);
    expect(locked({ type: 'percent', value: 20 })).toBe(true);
    // Rs 250 off Rs 2,000 is 12.5%: under both limits. Today's rule (10%) would lock it.
    expect(locked({ type: 'flat', value: 25_000 })).toBe(false);
    expect(previewDiscount(lines, subtotal, { type: 'flat', value: 25_000 }).needsApproval).toBe(true);
    expect(locked({ type: 'flat', value: 30_000 })).toBe(true);
  });

  it('0% locks every button', () => {
    const none = { percentOver: 0, flatOverCents: 0 };
    for (const b of [...presetButtons(DEFAULT_DISCOUNT_PRESETS).percent, ...presetButtons(DEFAULT_DISCOUNT_PRESETS).flat]) {
      expect({ b: b.label, locked: previewDiscount(lines, subtotal, b.choice, { approval: none, alsoOffDeliveryCharge: false }).needsApproval }).toEqual({ b: b.label, locked: true });
    }
  });

  it('the money on the bill never depends on the limit', () => {
    const a = previewDiscount(lines, subtotal, { type: 'percent', value: 20 }, { approval: { percentOver: 50, flatOverCents: 500_000 }, alsoOffDeliveryCharge: false });
    const b = previewDiscount(lines, subtotal, { type: 'percent', value: 20 });
    expect({ ...a, needsApproval: null }).toEqual({ ...b, needsApproval: null });
  });
});

describe('a till whose rules have not come yet (or with nothing saved) uses the released ones', () => {
  it('the F3 rules and the kitchen minutes', () => {
    expect(discountRulesOf(undefined)).toEqual(DEFAULT_COUNTER_DISCOUNTS);
    expect(DEFAULT_COUNTER_DISCOUNTS).toEqual({
      approval: { percentOver: DEFAULT_DISCOUNT_APPROVAL.percentOver, flatOverCents: DEFAULT_DISCOUNT_APPROVAL.flatOverCents },
      presets: {
        percents: [10, 20, 25, 50, 100],
        flatCents: [10_000, 20_000, 50_000],
        reasons: ['Staff', 'Friends & family', 'Regular customer', 'Complaint'],
      },
      // A discount leaves the delivery charge alone (the owner, 28 Sep 2026).
      alsoOffDeliveryCharge: false,
      // The reason is optional, as before "a discount needs a reason" (format 2).
      reasonRequired: false,
    });
    expect(kitchenTimingOf(null)).toEqual({ amberMin: 15, redMin: 30, notStartedMin: 10, notDoneMin: 30 });
    expect(kitchenTimingOf(undefined)).toBe(DEFAULT_COUNTER_KITCHEN);
  });

  it('what the till answered wins', () => {
    const discounts = {
      approval: { percentOver: 5, flatOverCents: 0 },
      presets: { percents: [5], flatCents: [100], reasons: ['Test'] },
      alsoOffDeliveryCharge: true,
      reasonRequired: true,
    };
    const kitchen = { amberMin: 8, redMin: 12, notStartedMin: 6, notDoneMin: 25 };
    expect(discountRulesOf({ discounts })).toBe(discounts);
    expect(kitchenTimingOf({ kitchen })).toBe(kitchen);
  });
});
