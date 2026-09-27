/**
 * An order discount's words on the screens that show a bill (the cart, Pay,
 * the order drawer, the receipt after Pay): "food only" exactly when the
 * discount's OWN frozen rule left the order's delivery charge alone, and the
 * words as before otherwise. Made-up names and amounts.
 */
import { describe, expect, it } from 'vitest';
import { cartDiscountDetail, drawerDiscountLabel, payDiscountLabel, receiptDiscountLabel } from './discountWords';

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
