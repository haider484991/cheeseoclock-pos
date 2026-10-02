/**
 * An order discount's words on the screens that show a bill (the cart, Pay,
 * the order drawer, the receipt after Pay): "food only" exactly when the
 * discount's OWN frozen rule left the order's delivery charge alone, and the
 * words as before otherwise. Made-up names and amounts.
 */
import { describe, expect, it } from 'vitest';
import {
  billLeavesOut,
  cartDiscountDetail,
  cartOfferDetail,
  drawerDiscountLabel,
  payDiscountLabel,
  receiptDiscountLabel,
} from './discountWords';

const FOOD = [{ menuItemName: 'Test Pizza' }, { menuItemName: 'Test Side' }];
const WITH_CHARGE = [...FOOD, { menuItemName: 'Delivery Charge (Rs 200)' }];

const tenPct = (alsoOffDeliveryCharge: boolean | undefined, reason: string | null = null) => ({
  discountType: 'percent' as const,
  value: 10,
  reason,
  ...(alsoOffDeliveryCharge === undefined ? {} : { alsoOffDeliveryCharge }),
});
const rs300 = (alsoOffDeliveryCharge: boolean | undefined) => ({ discountType: 'flat' as const, value: 30_000, reason: null, alsoOffDeliveryCharge });

describe('the cart', () => {
  it('"10% off food" when the delivery charge was left alone; as before otherwise', () => {
    expect(cartDiscountDetail(tenPct(false), WITH_CHARGE)).toBe(' · 10% off food');
    expect(cartDiscountDetail(tenPct(false, 'Staff'), WITH_CHARGE)).toBe(' · 10% off food · Staff');
    expect(cartDiscountDetail(rs300(false), WITH_CHARGE)).toBe(' · Rs 300 off food');
    // It came off the charge too (the owner's switch on, or given before the rule): as before.
    expect(cartDiscountDetail(tenPct(true, 'Staff'), WITH_CHARGE)).toBe(' · 10% · Staff');
    expect(cartDiscountDetail(tenPct(undefined), WITH_CHARGE)).toBe(' · 10%');
    // No delivery charge on the order: nothing to say.
    expect(cartDiscountDetail(tenPct(false), FOOD)).toBe(' · 10%');
  });
});

describe('Pay', () => {
  it('"(food only)" when something came off and the delivery charge was left alone', () => {
    expect(payDiscountLabel(null, tenPct(false), WITH_CHARGE, 20_000)).toBe('Discount (food only)');
    expect(payDiscountLabel('Foodpanda deal 20% off', tenPct(false), WITH_CHARGE, 40_000)).toBe('Foodpanda deal 20% off (food only)');
    expect(payDiscountLabel(null, tenPct(true), WITH_CHARGE, 22_000)).toBe('Discount');
    expect(payDiscountLabel(null, tenPct(undefined), WITH_CHARGE, 22_000)).toBe('Discount');
    expect(payDiscountLabel(null, tenPct(false), FOOD, 20_000)).toBe('Discount');
    expect(payDiscountLabel(null, undefined, WITH_CHARGE, 0)).toBe('Discount');
  });

  it('a foodpanda deal still under its minimum takes nothing off: no "food only" next to −0.00', () => {
    expect(payDiscountLabel('Foodpanda deal 20% off', tenPct(false), WITH_CHARGE, 0)).toBe('Foodpanda deal 20% off');
  });
});

describe('the order drawer', () => {
  it('"Discount (Staff, food only)"; as before otherwise', () => {
    expect(drawerDiscountLabel('Staff', true)).toBe('Discount (Staff, food only)');
    expect(drawerDiscountLabel(null, true)).toBe('Discount (food only)');
    expect(drawerDiscountLabel('Staff', false)).toBe('Discount (Staff)');
    expect(drawerDiscountLabel(undefined, false)).toBe('Discount');
  });
});

describe('the receipt on screen after Pay', () => {
  it('"Discount (10%, food only)" — never "Discount (10%) −200.00" under a Rs 2,200 subtotal with no word why', () => {
    expect(receiptDiscountLabel(tenPct(false), WITH_CHARGE)).toBe('Discount (10%, food only)');
    expect(receiptDiscountLabel(tenPct(false, 'Staff'), WITH_CHARGE)).toBe('Discount (Staff, food only)');
    expect(receiptDiscountLabel(rs300(false), WITH_CHARGE)).toBe('Discount (Rs 300, food only)');
  });

  it('an old order, one that came off the charge too, or no charge: exactly as before', () => {
    expect(receiptDiscountLabel(tenPct(undefined), WITH_CHARGE)).toBe('Discount (10%)');
    expect(receiptDiscountLabel(tenPct(true, 'Staff'), WITH_CHARGE)).toBe('Discount (Staff)');
    expect(receiptDiscountLabel(rs300(false), FOOD)).toBe('Discount (Rs 300)');
  });
});

/**
 * NO DISCOUNT ON VALUE DEALS (the owner, 2026-10-02): the same screens say
 * "not on value deals" exactly when the discount's own frozen rule left the
 * order's value deals alone (skipsNoDiscountLines) and a deal is on the
 * order; with a delivery charge left alone too, both. Everything above reads
 * as it did.
 */
describe('a discount that left the value deals alone', () => {
  const DEAL = { menuItemName: 'Test Big Deal', noDiscount: true };
  const PIZZA = { menuItemName: 'Test Pizza', noDiscount: false };
  const CHARGE = { menuItemName: 'Delivery Charge (Rs 200)' };
  const skips = (reason: string | null = null, alsoOffDeliveryCharge = false) => ({
    discountType: 'percent' as const,
    value: 10,
    reason,
    alsoOffDeliveryCharge,
    skipsNoDiscountLines: true,
  });
  const offer = { ...skips('WhatsApp 10% off'), source: 'offer' as const };

  it('the cart', () => {
    expect(cartDiscountDetail(skips('Staff'), [DEAL, PIZZA])).toBe(' · 10% off, not on value deals · Staff');
    expect(cartDiscountDetail(skips('Staff'), [DEAL, PIZZA, CHARGE])).toBe(' · 10% off food, not on value deals · Staff');
    expect(cartDiscountDetail(skips(), [DEAL, PIZZA])).toBe(' · 10% off, not on value deals');
    expect(cartOfferDetail(offer, [DEAL, PIZZA])).toBe(' · automatic offer, not on value deals');
    expect(cartOfferDetail(offer, [DEAL, PIZZA, CHARGE])).toBe(' · automatic offer, food only, not on value deals');
  });

  it('Pay', () => {
    expect(payDiscountLabel(null, skips(), [DEAL, PIZZA], 15_000)).toBe('Discount (not on value deals)');
    expect(payDiscountLabel(null, skips(), [DEAL, PIZZA, CHARGE], 15_000)).toBe('Discount (food only, not on value deals)');
    expect(payDiscountLabel('WhatsApp 10% off', offer, [DEAL, PIZZA], 15_000)).toBe('WhatsApp 10% off (not on value deals)');
    // Nothing came off (only the deals are left): no words next to −0.00.
    expect(payDiscountLabel(null, skips(), [DEAL], 0)).toBe('Discount');
  });

  it('the order drawer', () => {
    expect(drawerDiscountLabel('Staff', false, null, true)).toBe('Discount (Staff, not on value deals)');
    expect(drawerDiscountLabel('Staff', true, null, true)).toBe('Discount (Staff, food only, not on value deals)');
    expect(drawerDiscountLabel(null, false, null, true)).toBe('Discount (not on value deals)');
    expect(drawerDiscountLabel(null, false, 'WhatsApp 10% off', true)).toBe('WhatsApp 10% off (not on value deals)');
    expect(drawerDiscountLabel('Staff', false, null, false)).toBe('Discount (Staff)');
  });

  it('the receipt on screen after Pay, and the line it leaves out as the paper does', () => {
    expect(receiptDiscountLabel(skips(), [DEAL, PIZZA])).toBe('Discount (10%, not on value deals)');
    expect(receiptDiscountLabel(skips('Staff'), [DEAL, PIZZA, CHARGE])).toBe('Discount (Staff, food only, not on value deals)');
    expect(receiptDiscountLabel(offer, [DEAL, PIZZA])).toBe('WhatsApp 10% off (not on value deals)');
    // A Rs 0 discount that left the deals alone, and an offer taken off: no line. Anything else at Rs 0 shows.
    expect(billLeavesOut({ amountCents: 0, skipsNoDiscountLines: true })).toBe(true);
    expect(billLeavesOut({ amountCents: 0, source: 'offer' })).toBe(true);
    expect(billLeavesOut({ amountCents: 15_000, skipsNoDiscountLines: true })).toBe(false);
    expect(billLeavesOut({ amountCents: 0, source: 'foodpanda' })).toBe(false);
    expect(billLeavesOut({ amountCents: 0 })).toBe(false);
  });

  it('given before 0.7.34, a foodpanda order, or no deal on the order: exactly as before', () => {
    for (const old of [undefined, false]) {
      const d = { ...skips('Staff'), skipsNoDiscountLines: old };
      expect(cartDiscountDetail(d, [DEAL, PIZZA])).toBe(' · 10% · Staff');
      expect(payDiscountLabel(null, d, [DEAL, PIZZA], 15_000)).toBe('Discount');
      expect(receiptDiscountLabel(d, [DEAL, PIZZA])).toBe('Discount (Staff)');
    }
    expect(cartDiscountDetail(skips('Staff'), [PIZZA])).toBe(' · 10% · Staff');
    expect(receiptDiscountLabel(skips(), [PIZZA, CHARGE])).toBe('Discount (10%, food only)');
  });
});

describe('a Free order (v0.7.36) on every screen', () => {
  const free = { discountType: 'percent' as const, value: 100, reason: 'Staff meal', alsoOffDeliveryCharge: true, skipsNoDiscountLines: false, freeOrder: true };
  const deal = [{ menuItemName: 'Test Deal', noDiscount: true }, ...WITH_CHARGE];

  it('reads "Free order" with its reason, never as a 100% discount', () => {
    expect(cartDiscountDetail(free, deal)).toBe(' · Staff meal');
    expect(payDiscountLabel(null, free, deal, 300_000)).toBe('Free order (Staff meal)');
    expect(drawerDiscountLabel('Staff meal', false, null, false, true)).toBe('Free order (Staff meal)');
    expect(receiptDiscountLabel(free, deal)).toBe('Free order (Staff meal)');
    expect(receiptDiscountLabel({ ...free, reason: null }, deal)).toBe('Free order');
  });
});
