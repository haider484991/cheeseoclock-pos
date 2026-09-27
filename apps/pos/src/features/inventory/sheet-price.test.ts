/**
 * "Use the sheet's price" asks what it replaces (costing spec Phase 6): the
 * till's price and where it came from, never only the sheet's figure. Every
 * name and price is made up.
 */
import { describe, expect, it } from 'vitest';
import { tillPriceIsFromBill, tillPriceText, sheetPriceQuestion } from './sheet-price';

type I = Parameters<typeof sheetPriceQuestion>[0];

const cheese = (p: Partial<I> = {}): I => ({
  name: 'Test cheese',
  unit: 'g',
  priceKind: 'set',
  costPerUnitCents: 130,
  packSize: 2000,
  packPriceCents: 260_000,
  latestPrice: {
    source: 'delivery',
    effectiveAt: '2026-09-20T08:00:00.000Z',
    unit: 'g',
    packSize: 2000,
    packPriceCents: 260_000,
    priceKind: 'set',
    unitCostMc: 130_000,
    prevUnitCostMc: 120_000,
  },
  sheetPrice: { packSize: 1000, packPriceCents: 110_000, priceKind: 'set', unitCostMc: 110_000, at: '2026-09-21T08:00:00.000Z' },
  ...p,
});

describe("the question before \"Use the sheet's price\"", () => {
  it("says what the sheet's price replaces, where that came from and when — and that a bill is what was paid", () => {
    const q = sheetPriceQuestion(cheese())!;
    const parts = q.split('\n\n');
    expect(parts[0]).toBe('Use the costing sheet\'s price for "Test cheese"?');
    expect(parts[1]).toMatch(/^The sheet's Rs 1,100 \/ kg replaces the till's Rs 1,300 \/ kg from a delivery bill on 20 Sep/);
    expect(parts[2]).toBe("The till's price is what the shop last paid; the sheet's may be older.");
    expect(parts[3]).toBe("Every dish that uses it is costed at the sheet's price from now (kept in its price history as typed).");
    expect(tillPriceIsFromBill(cheese())).toBe(true);
  });

  it('a typed price, a starting price, one with no price, and a price from before a unit change', () => {
    const typed = cheese({ latestPrice: { ...cheese().latestPrice!, source: 'manual' } });
    expect(sheetPriceQuestion(typed)).toMatch(/replaces the till's Rs 1,300 \/ kg typed on the till on 20 Sep/);
    expect(sheetPriceQuestion(typed)).not.toContain('last paid');
    expect(tillPriceIsFromBill(typed)).toBe(false);
    expect(tillPriceText(cheese({ latestPrice: { ...cheese().latestPrice!, source: 'seed', effectiveAt: '1970-01-01T00:00:00.000Z' } }))).toBe(
      'Rs 1,300 / kg (the price it had when the till started keeping price history)',
    );
    expect(tillPriceText(cheese({ priceKind: 'unset', costPerUnitCents: 0, packSize: null, packPriceCents: null, latestPrice: null }))).toBe('no price yet');
    // The newest history line is in kg (from before a Convert): the price as it stands now, without a source.
    expect(tillPriceText(cheese({ latestPrice: { ...cheese().latestPrice!, unit: 'kg' } }))).toBe('Rs 1,300 / kg');
    expect(tillPriceIsFromBill(cheese({ latestPrice: { ...cheese().latestPrice!, unit: 'kg' } }))).toBe(false);
  });

  it('nothing to ask when the sheet has no price', () => {
    expect(sheetPriceQuestion(cheese({ sheetPrice: null }))).toBeNull();
    expect(sheetPriceQuestion(cheese({ sheetPrice: { ...cheese().sheetPrice!, priceKind: 'unset', packPriceCents: 0, unitCostMc: 0 } }))).toBeNull();
  });
});
