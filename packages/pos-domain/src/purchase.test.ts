import { describe, expect, it } from 'vitest';
import {
  PRICE_GUARD_BPS,
  billPack,
  checkBillPrice,
  orderedPack,
  orderedValueCents,
  priceFromBill,
  usesBillPrice,
  usualPackSize,
  type PriceCheckInput,
} from './purchase.js';
import { typedPricePack, unitCostMc, valueCents } from './units.js';

// Every price here is made up (costing spec D11: the repo is public).

describe('a purchase order line keeps the price it was ordered at, exactly', () => {
  it('a line typed per kg is 1,000 g for Rs X; the bill for any amount is rounded once', () => {
    const pack = typedPricePack({ per: 'thousand', priceCents: 37_550 }, 'g'); // Rs 375.50 / kg
    const line = { orderedPackSize: pack.size, orderedPackPriceCents: pack.priceCents, unitCostCents: 38 };
    expect(orderedPack(line)).toEqual({ size: 1000, priceCents: 37_550 });
    // 2,500 g at Rs 375.50 / kg = Rs 938.75 exactly (per-gram whole paisa would say Rs 950).
    expect(orderedValueCents(2_500, line)).toBe(93_875);
    expect(orderedValueCents(3, line)).toBe(113); // 112.65 → 113, once
  });

  it('a line from before (no ordered pack) is priced per unit', () => {
    const line = { orderedPackSize: null, orderedPackPriceCents: null, unitCostCents: 95 };
    expect(orderedPack(line)).toEqual({ size: 1, priceCents: 95 });
    expect(orderedValueCents(2_000, line)).toBe(190_000);
  });
});

describe('the price a bill gives an ingredient (costing spec 4.1)', () => {
  it('keeps the usual pack: P = round(B × S ÷ q)', () => {
    // Usually bought as 2,000 g; a bill of Rs 2,250 for 6,000 g → Rs 750 per 2,000 g.
    expect(usualPackSize({ unit: 'g', packSize: 2000, packPriceCents: 240_000 })).toBe(2000);
    expect(priceFromBill(6_000, 225_000, 2000)).toEqual({ size: 2000, priceCents: 75_000 });
    // Rs 1,000 for 3 kg, kept per kg: 333.33… → Rs 333.33.
    expect(priceFromBill(3_000, 100_000, 1000)).toEqual({ size: 1000, priceCents: 33_333 });
  });

  it('no pack yet: per kg / litre when weighed, else one piece — never per gram in whole paisa', () => {
    expect(usualPackSize({ unit: 'g', packSize: null, packPriceCents: null })).toBe(1000);
    expect(usualPackSize({ unit: 'ml', packSize: null, packPriceCents: null })).toBe(1000);
    expect(usualPackSize({ unit: 'kg', packSize: null, packPriceCents: null })).toBe(1);
    expect(usualPackSize({ unit: 'pcs', packSize: null, packPriceCents: null })).toBe(1);
    // A size with no price is no pack.
    expect(usualPackSize({ unit: 'pcs', packSize: 12, packPriceCents: null })).toBe(1);
  });

  it('the bill itself is kept exactly: a take valued at it is exact', () => {
    const pack = billPack(6_000, 225_000);
    expect(pack).toEqual({ size: 6_000, priceCents: 225_000 });
    expect(unitCostMc(pack)).toBe(37_500); // Rs 375 / kg
    expect(valueCents(6_000, pack)).toBe(225_000);
  });

  it('refuses what is not a bill', () => {
    expect(() => priceFromBill(0, 100, 1000)).toThrow(/at least 1/);
    expect(() => priceFromBill(10, -1, 1000)).toThrow(/Rs 0 or more/);
    expect(() => priceFromBill(10, 1.5, 1000)).toThrow(/whole paisa/);
    expect(() => billPack(2.5, 100)).toThrow(/whole unit/);
  });
});

describe("D1's guard: does the bill's price become the ingredient's price?", () => {
  // Usually Rs 150 / kg (made up), kept per kg.
  const base = (over: Partial<PriceCheckInput>): PriceCheckInput => ({
    kind: 'quick',
    current: { pack: { size: 1000, priceCents: 15_000 }, kind: 'set' },
    usualSize: 1000,
    qty: 2_000,
    billCents: 30_000,
    ...over,
  });

  it('a quick purchase 25% above the usual price: asked, and NOT used by default', () => {
    const c = checkBillPrice(base({ billCents: 37_500 })); // Rs 187.50 / kg
    expect(c).toMatchObject({ why: 'higher', changeBps: 2_500, ask: true, adoptable: true, adoptByDefault: false });
    expect(c.newPack).toEqual({ size: 1000, priceCents: 18_750 });
    expect(usesBillPrice(c)).toBe(false);
    expect(usesBillPrice(c, true)).toBe(true);
  });

  it('a purchase order delivered 25% above: asked, and used by default (the price was agreed)', () => {
    const c = checkBillPrice(base({ kind: 'order', billCents: 37_500 }));
    expect(c).toMatchObject({ why: 'higher', ask: true, adoptByDefault: true });
    expect(usesBillPrice(c)).toBe(true);
    expect(usesBillPrice(c, false)).toBe(false);
  });

  it('within 10%: used, nothing asked — for either kind; exactly 10% is still within', () => {
    for (const kind of ['order', 'quick'] as const) {
      const up = checkBillPrice(base({ kind, billCents: 31_800 })); // +6%
      expect(up).toMatchObject({ why: 'within', changeBps: 600, ask: false, adoptByDefault: true });
      const edge = checkBillPrice(base({ kind, billCents: 33_000 })); // +10.00%
      expect(edge).toMatchObject({ why: 'within', changeBps: PRICE_GUARD_BPS, ask: false });
      const past = checkBillPrice(base({ kind, billCents: 33_002 })); // +10.01%
      expect(past).toMatchObject({ why: 'higher', ask: true, adoptByDefault: kind === 'order' });
      const down = checkBillPrice(base({ kind, billCents: 24_000 })); // −20%
      expect(down).toMatchObject({ why: 'lower', changeBps: -2_000, ask: true, adoptByDefault: kind === 'order' });
    }
  });

  it('the same price: nothing to change', () => {
    expect(checkBillPrice(base({ billCents: 30_000 }))).toMatchObject({ why: 'same', ask: false, adoptByDefault: true, changeBps: 0 });
    // A per-gram price typed the old way compares at its usual pack (per kg).
    const old = checkBillPrice(base({ current: { pack: { size: 1, priceCents: 15 }, kind: 'set' }, billCents: 30_000 }));
    expect(old).toMatchObject({ why: 'same', currentUnitMc: 15_000 });
  });

  it('no price yet: the bill is its price; a guess within 10% is replaced by the bill', () => {
    const none = checkBillPrice(base({ current: { pack: { size: 1, priceCents: 0 }, kind: 'unset' }, billCents: 99_000 }));
    expect(none).toMatchObject({ why: 'no_price', ask: false, adoptByDefault: true, currentUnitMc: null, changeBps: null });
    for (const kind of ['order', 'quick'] as const) {
      const guessClose = checkBillPrice(base({ kind, current: { pack: { size: 1000, priceCents: 15_000 }, kind: 'estimate' }, billCents: 31_000 }));
      expect(guessClose).toMatchObject({ why: 'guess', ask: false, adoptByDefault: true });
    }
  });

  it("a guess outside 10% follows D1's defaults: a quick purchase 25% above is NOT used by default, a purchase order is", () => {
    const guess = { pack: { size: 1000, priceCents: 15_000 }, kind: 'estimate' as const };
    // A market top-up at a dear stall must not reprice the menu, guessed price or not.
    const quick = checkBillPrice(base({ kind: 'quick', current: guess, billCents: 37_500 })); // +25%
    expect(quick).toMatchObject({ why: 'guess', changeBps: 2_500, ask: true, adoptable: true, adoptByDefault: false });
    expect(usesBillPrice(quick)).toBe(false);
    expect(usesBillPrice(quick, true)).toBe(true);
    const order = checkBillPrice(base({ kind: 'order', current: guess, billCents: 37_500 }));
    expect(order).toMatchObject({ why: 'guess', ask: true, adoptByDefault: true });
    expect(usesBillPrice(order)).toBe(true);
  });

  it("free: always asked, with D1's defaults — yes for a purchase order, no for a quick purchase", () => {
    const freeNow = { pack: { size: 1, priceCents: 0 }, kind: 'free' as const };
    const order = checkBillPrice(base({ kind: 'order', current: freeNow }));
    expect(order).toMatchObject({ why: 'was_free', ask: true, adoptable: true, adoptByDefault: true });
    expect(usesBillPrice(order)).toBe(true);
    const quick = checkBillPrice(base({ kind: 'quick', current: freeNow }));
    expect(quick).toMatchObject({ why: 'was_free', ask: true, adoptable: true, adoptByDefault: false });
    expect(usesBillPrice(quick)).toBe(false);
  });

  it('made here, or a bill of Rs 0', () => {
    const made = checkBillPrice(base({ current: { pack: { size: 2000, priceCents: 26_000 }, kind: 'set', madeHere: true } }));
    expect(made).toMatchObject({ why: 'made_here', adoptable: false, ask: false });
    expect(usesBillPrice(made, true)).toBe(false);
    const gift = checkBillPrice(base({ kind: 'order', billCents: 0 }));
    expect(gift).toMatchObject({ why: 'zero_bill', adoptable: false });
    expect(usesBillPrice(gift, true)).toBe(false);
  });

  it('a different band', () => {
    expect(checkBillPrice(base({ billCents: 33_000, thresholdBps: 500 }))).toMatchObject({ why: 'higher', ask: true });
  });
});
