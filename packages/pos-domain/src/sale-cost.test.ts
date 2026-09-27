import { describe, expect, it } from 'vitest';
import type { PriceKind, StockMovement } from '@cheeseoclock/shared-types';
import { allocateDiscount } from './discount.js';
import type { PriceOf } from './plate-cost.js';
import { BASE_PART, totalsByIngredient, type PickedChoice, type RecipeLine } from './recipe-expand.js';
import {
  costSaleLine,
  emptyFoodCostTally,
  lineCostStatus,
  lineNetsExTax,
  movementWithoutCosts,
  orderKeptCost,
  stockValueAt,
  tallyFoodCost,
  tallyPlainOrders,
  wasteReasonOf,
  type FoodCostLine,
} from './sale-cost.js';
import type { Pack } from './units.js';

// Made-up prices (costing spec D11): a pack of N base units for P paisa.
const PRICES: Record<string, { pack: Pack; kind: PriceKind }> = {
  dough: { pack: { size: 1000, priceCents: 9_000 }, kind: 'set' }, // 9 paisa / g
  cheese: { pack: { size: 2000, priceCents: 240_000 }, kind: 'set' }, // 120 paisa / g
  onion: { pack: { size: 1000, priceCents: 15_000 }, kind: 'set' }, // 15 paisa / g
  pepper: { pack: { size: 1000, priceCents: 30_000 }, kind: 'set' },
  ranch: { pack: { size: 1000, priceCents: 70_000 }, kind: 'set' },
  cup: { pack: { size: 100, priceCents: 500 }, kind: 'set' },
  breading: { pack: { size: 1000, priceCents: 20_000 }, kind: 'estimate' },
  salt: { pack: { size: 1, priceCents: 0 }, kind: 'free' },
  bottle: { pack: { size: 1, priceCents: 0 }, kind: 'unset' },
  third: { pack: { size: 3000, priceCents: 1_000 }, kind: 'set' }, // a third of a paisa per g
};
const priceOf: PriceOf = (id) => PRICES[id];

const line = (ingredientId: string, qtyPerUnit: number, modifierId: string | null = null): RecipeLine => ({
  ingredientId,
  qtyPerUnit,
  modifierId,
});
const pick = (modifierId: string, priceDeltaCents = 0, removesIngredientId: string | null = null): PickedChoice => ({
  modifierId,
  priceDeltaCents,
  removesIngredientId,
});

const FAJITA: RecipeLine[] = [
  line('dough', 300),
  line('cheese', 90),
  line('onion', 15),
  line('onion', 10, 'extraOnion'),
  line('ranch', 25, 'sideRanch'),
  line('cup', 1, 'sideRanch'),
];
const VEGGIE: RecipeLine[] = [line('dough', 300), line('cheese', 90), line('onion', 10, 'pickOnion'), line('pepper', 10, 'pickPepper')];
const DEAL: RecipeLine[] = [
  line('dough', 300, 'd1Fajita'),
  line('cheese', 90, 'd1Fajita'),
  line('onion', 15, 'd1Fajita'),
  line('dough', 300, 'd2Veggie'),
  line('cheese', 90, 'd2Veggie'),
  line('pepper', 10, 'd2Veggie'),
];

describe('costSaleLine: the cost rows one order line keeps', () => {
  it('a plain item: one base row for the whole line quantity', () => {
    const { parts } = costSaleLine(FAJITA, [], 2, priceOf);
    // 600 g dough 5,400 + 180 g cheese 21,600 + 30 g onion 450
    expect(parts).toEqual([{ part: BASE_PART, modifierId: null, costCents: 27_450, status: 'full', missingLines: 0, estimateLines: 0 }]);
  });

  it('a deal: a base row (nothing always in it) and one row per pizza picked', () => {
    const { parts } = costSaleLine(DEAL, [pick('d1Fajita'), pick('d2Veggie')], 1, priceOf);
    expect(parts.map((p) => [p.part, p.costCents, p.status])).toEqual([
      [BASE_PART, 0, 'full'],
      ['d1Fajita', 2_700 + 10_800 + 225, 'full'],
      ['d2Veggie', 2_700 + 10_800 + 300, 'full'],
    ]);
  });

  it('a leave-out on free choices: no row of its own, the onion is off the pizza it came with', () => {
    const { parts } = costSaleLine(DEAL, [pick('d1Fajita'), pick('d2Veggie'), pick('dealNoOnion', 0, 'onion')], 1, priceOf);
    expect(parts.map((p) => p.part)).toEqual([BASE_PART, 'd1Fajita', 'd2Veggie']);
    expect(parts.find((p) => p.part === 'd1Fajita')!.costCents).toBe(2_700 + 10_800);
  });

  it('"No onion" beside a paid "Extra onion": the base loses its onion, the paid extra keeps it', () => {
    const { parts } = costSaleLine(FAJITA, [pick('noOnion', 0, 'onion'), pick('extraOnion', 5_000)], 1, priceOf);
    expect(parts.map((p) => [p.part, p.costCents])).toEqual([
      [BASE_PART, 2_700 + 10_800],
      ['extraOnion', 150],
    ]);
  });

  it('a free pick whose only line a leave-out takes off keeps a row, at Rs 0', () => {
    const { parts } = costSaleLine(VEGGIE, [pick('pickOnion'), pick('pickPepper'), pick('noOnion', 0, 'onion')], 1, priceOf);
    expect(parts.map((p) => [p.part, p.costCents, p.status])).toEqual([
      [BASE_PART, 13_500, 'full'],
      ['pickOnion', 0, 'full'],
      ['pickPepper', 300, 'full'],
    ]);
  });

  it('veggie picks on a quantity-2 line are costed for both', () => {
    const { parts } = costSaleLine(VEGGIE, [pick('pickOnion'), pick('pickPepper')], 2, priceOf);
    expect(parts.map((p) => [p.part, p.costCents])).toEqual([
      [BASE_PART, 27_000],
      ['pickOnion', 300],
      ['pickPepper', 600],
    ]);
  });

  it('a paid dip on the side and a choice picked twice: one row each', () => {
    const { parts } = costSaleLine(FAJITA, [pick('sideRanch', 10_000), pick('sideRanch', 10_000)], 1, priceOf);
    expect(parts.map((p) => [p.part, p.costCents])).toEqual([
      [BASE_PART, 13_725],
      ['sideRanch', 1_750 + 5],
    ]);
  });

  it('an item with no recipe keeps one base row, "none", at Rs 0', () => {
    expect(costSaleLine([], [pick('x', 1_000)], 3, priceOf).parts).toEqual([
      { part: BASE_PART, modifierId: null, costCents: 0, status: 'none', missingLines: 0, estimateLines: 0 },
    ]);
  });

  it('an unpriced ingredient makes its row partial; a guessed or free one is full', () => {
    const drink = costSaleLine([line('bottle', 1)], [], 2, priceOf).parts[0]!;
    expect(drink).toMatchObject({ costCents: 0, status: 'partial', missingLines: 1 });
    const wings = costSaleLine([line('breading', 50), line('salt', 2)], [], 1, priceOf).parts[0]!;
    expect(wings).toMatchObject({ costCents: 1_000, status: 'full', estimateLines: 1, missingLines: 0 });
    // An ingredient gone from Inventory counts as unpriced, never as nothing.
    expect(costSaleLine([line('gone', 5)], [], 1, priceOf).parts[0]).toMatchObject({ status: 'partial', missingLines: 1 });
  });

  it('rounds each line in millicents and the row once', () => {
    // 1 g at a third of a paisa = 333 mc; two such lines = 666 mc → 1 paisa (not 0 + 0).
    const { parts } = costSaleLine([line('third', 1), line('third', 1)], [], 1, priceOf);
    expect(parts[0]!.costCents).toBe(1);
  });

  it('the rows and the stock rows agree to within a paisa a row', () => {
    const cases: Array<[RecipeLine[], PickedChoice[], number]> = [
      [FAJITA, [pick('noOnion', 0, 'onion'), pick('extraOnion', 5_000), pick('sideRanch', 10_000)], 3],
      [VEGGIE, [pick('pickOnion'), pick('pickPepper')], 7],
      [DEAL, [pick('d1Fajita'), pick('d2Veggie')], 5],
      [[line('third', 7), line('third', 11, 'a'), line('onion', 13, 'a'), line('third', 5, 'b')], [pick('a'), pick('b')], 3],
    ];
    for (const [recipe, picks, qty] of cases) {
      const { parts, expanded } = costSaleLine(recipe, picks, qty, priceOf);
      const kept = parts.reduce((s, p) => s + p.costCents, 0);
      let stock = 0;
      for (const [id, q] of totalsByIngredient(expanded)) stock += -stockValueAt(-q, priceOf(id)).valueCents;
      expect(Math.abs(kept - stock)).toBeLessThanOrEqual(parts.length);
    }
  });
});

describe('lineCostStatus', () => {
  it('failed over partial over none over full; null when nothing was kept', () => {
    expect(lineCostStatus([])).toBeNull();
    expect(lineCostStatus(['full', 'full'])).toBe('full');
    expect(lineCostStatus(['full', 'partial'])).toBe('partial');
    expect(lineCostStatus(['none'])).toBe('none');
    expect(lineCostStatus(['partial', 'failed', 'full'])).toBe('failed');
  });
});

describe('stockValueAt: what a stock row is worth', () => {
  it('is signed like the quantity, so a take and its put-back net to exactly 0', () => {
    for (const q of [1, 2, 3, 7, 1_499, 1_500, 1_501]) {
      const take = stockValueAt(-q, PRICES.third);
      const back = stockValueAt(q, PRICES.third);
      expect(take.valueCents + back.valueCents).toBe(0);
    }
    // 1.5 paisa rounds away from zero both ways.
    expect(stockValueAt(-3, { pack: { size: 2, priceCents: 1 }, kind: 'set' }).valueCents).toBe(-2);
    expect(stockValueAt(3, { pack: { size: 2, priceCents: 1 }, kind: 'set' }).valueCents).toBe(2);
  });

  it('keeps the unit price in millicents and says how it was valued', () => {
    expect(stockValueAt(-300, PRICES.dough)).toEqual({ valueCents: -2_700, unitCostMc: 9_000, basis: 'price' });
    expect(stockValueAt(-2, PRICES.salt)).toEqual({ valueCents: 0, unitCostMc: 0, basis: 'price' });
  });

  it('an unpriced or missing ingredient is Rs 0, marked "none"', () => {
    expect(stockValueAt(-1, PRICES.bottle)).toEqual({ valueCents: 0, unitCostMc: null, basis: 'none' });
    expect(stockValueAt(-1, undefined)).toEqual({ valueCents: 0, unitCostMc: null, basis: 'none' });
  });
});

describe('lineNetsExTax: what the customer paid per line, before tax', () => {
  it('shares the discount exactly as the till does for tax, then the part refund before tax', () => {
    const totals = [120_000, 10_000, 80_000, 20_001];
    const disc = 23_000;
    const nets = lineNetsExTax(totals, disc, 244_201, 0);
    const shares = allocateDiscount(totals, disc);
    expect(nets).toEqual(totals.map((t, i) => t - shares[i]!));
    expect(nets.reduce((s, x) => s + x, 0)).toBe(230_001 - 23_000);
  });

  it('a part refund comes off before tax: Rs 116 back on a Rs 1,160 bill (16% tax) is Rs 100 off the sale', () => {
    expect(lineNetsExTax([100_000], 0, 116_000, 11_600)).toEqual([90_000]);
    const nets = lineNetsExTax([70_000, 30_000, 1], 10_000, 104_401, 7_777);
    const refundExTax = Math.round((7_777 * 90_001) / 104_401);
    expect(nets.reduce((s, x) => s + x, 0)).toBe(90_001 - refundExTax);
  });

  it('a free order (total 0) has nothing to refund', () => {
    expect(lineNetsExTax([5_000], 5_000, 0, 0)).toEqual([0]);
  });
});

const L = (over: Partial<FoodCostLine>): FoodCostLine => ({
  key: 'm',
  name: 'Item',
  quantity: 1,
  lineTotalCents: 0,
  isFee: false,
  parts: 1,
  costCents: 0,
  status: 'full',
  hasRecipeNow: true,
  ...over,
});

describe('tallyFoodCost: one counted order into the food cost', () => {
  it('an order that kept its cost: full lines are known, the rest listed, fees left out', () => {
    const t = emptyFoodCostTally();
    tallyFoodCost(t, {
      discountCents: 23_000,
      totalCents: 240_120,
      refundedCents: 0,
      lines: [
        L({ key: 'pizza', lineTotalCents: 120_000, costCents: 30_000 }),
        L({ key: 'dip', name: 'Dip', lineTotalCents: 10_000, costCents: 500, status: 'partial' }),
        L({ key: 'wings', name: 'Wings', lineTotalCents: 80_000, status: 'none' }),
        L({ key: 'fee', lineTotalCents: 20_000, isFee: true, status: 'none' }),
      ],
      estimate: null,
    });
    // 10% off each line: 108,000 / 9,000 / 72,000 / 18,000
    expect(t).toMatchObject({
      foodSalesCents: 189_000,
      feeSalesCents: 18_000,
      costOfSalesCents: 30_500,
      knownSalesCents: 108_000,
      knownMenuSalesCents: 120_000,
      knownCostCents: 30_000,
      estimatedOrders: 0,
      hasUsage: true,
    });
    expect([...t.missing.values()]).toEqual([
      { key: 'dip', name: 'Dip', why: 'no_price', quantity: 1, salesCents: 9_000 },
      { key: 'wings', name: 'Wings', why: 'no_recipe', quantity: 1, salesCents: 72_000 },
    ]);
  });

  it('a line whose costing failed is "not recorded"; an order whose costing failed altogether is estimated', () => {
    const t = emptyFoodCostTally();
    tallyFoodCost(t, {
      discountCents: 0,
      totalCents: 1,
      refundedCents: 0,
      lines: [L({ key: 'x', lineTotalCents: 5_000, status: 'failed' }), L({ key: 'y', lineTotalCents: 7_000, costCents: 2_000 })],
      estimate: null,
    });
    expect([...t.missing.values()]).toEqual([{ key: 'x', name: 'Item', why: 'not_recorded', quantity: 1, salesCents: 5_000 }]);
    expect(t).toMatchObject({ knownSalesCents: 7_000, estimatedOrders: 0 });

    const failed = [L({ key: 'x', lineTotalCents: 5_000, status: 'failed' })];
    expect(orderKeptCost(failed)).toBe(false);
    tallyFoodCost(t, { discountCents: 0, totalCents: 1, refundedCents: 0, lines: failed, estimate: { costCents: 1_500, priced: true, tookStock: true } });
    expect(t).toMatchObject({ knownSalesCents: 12_000, knownCostCents: 3_500, estimatedOrders: 1 });
  });

  it('an order with no cost kept is estimated; it is known when every ingredient had a price', () => {
    const t = emptyFoodCostTally();
    const lines = [L({ key: 'pizza', lineTotalCents: 100_000, parts: 0, status: null }), L({ key: 'wings', lineTotalCents: 80_000, parts: 0, status: null, hasRecipeNow: false })];
    expect(orderKeptCost(lines)).toBe(false);
    tallyFoodCost(t, { discountCents: 0, totalCents: 180_000, refundedCents: 0, lines, estimate: { costCents: 25_000, priced: true, tookStock: true } });
    expect(t).toMatchObject({
      foodSalesCents: 180_000,
      costOfSalesCents: 25_000,
      estimatedCostCents: 25_000,
      estimatedOrders: 1,
      knownSalesCents: 100_000,
      knownCostCents: 25_000,
    });
    expect([...t.missing.values()]).toEqual([{ key: 'wings', name: 'Item', why: 'no_recipe', quantity: 1, salesCents: 80_000 }]);

    // An ingredient with no price: its cost counts, but none of it is "known".
    tallyFoodCost(t, { discountCents: 0, totalCents: 1, refundedCents: 0, lines: [L({ key: 'pizza', lineTotalCents: 100_000, parts: 0, status: null })], estimate: { costCents: 20_000, priced: false, tookStock: true } });
    expect(t).toMatchObject({ costOfSalesCents: 45_000, knownSalesCents: 100_000, knownCostCents: 25_000, estimatedOrders: 2 });
    expect(t.missing.get('pizza|no_price')).toMatchObject({ salesCents: 100_000 });

    // It took nothing at all (sold before stock was kept): not recorded, not "Rs 0".
    tallyFoodCost(t, { discountCents: 0, totalCents: 1, refundedCents: 0, lines: [L({ key: 'pizza', lineTotalCents: 50_000, parts: 0, status: null })], estimate: { costCents: 0, priced: true, tookStock: false } });
    expect(t.missing.get('pizza|not_recorded')).toMatchObject({ salesCents: 50_000 });
    expect(t.knownSalesCents).toBe(100_000);
    // …and nothing was estimated for it: still the two orders above.
    expect(t).toMatchObject({ estimatedOrders: 2, estimatedCostCents: 45_000, costOfSalesCents: 45_000 });
  });

  it('an order from before costing that took nothing (no recipe, no stock rows) is listed, never counted as estimated', () => {
    const t = emptyFoodCostTally();
    const lines = [L({ key: 'wings', name: 'Wings', lineTotalCents: 80_000, parts: 0, status: null, hasRecipeNow: false })];
    // No stock rows at all: no estimate.
    tallyFoodCost(t, { discountCents: 0, totalCents: 80_000, refundedCents: 0, lines, estimate: null });
    // Stock rows that took nothing (only put-backs, say): an estimate that took no stock.
    tallyFoodCost(t, { discountCents: 0, totalCents: 80_000, refundedCents: 0, lines, estimate: { costCents: 0, priced: true, tookStock: false } });
    // A delivery charge alone.
    tallyFoodCost(t, {
      discountCents: 0,
      totalCents: 15_000,
      refundedCents: 0,
      lines: [L({ key: 'fee', lineTotalCents: 15_000, isFee: true, parts: 0, status: null, hasRecipeNow: false })],
      estimate: null,
    });
    expect(t).toMatchObject({
      estimatedOrders: 0,
      estimatedCostCents: 0,
      costOfSalesCents: 0,
      foodSalesCents: 160_000,
      feeSalesCents: 15_000,
      knownSalesCents: 0,
      hasUsage: false,
    });
    expect([...t.missing.values()]).toEqual([{ key: 'wings', name: 'Wings', why: 'no_recipe', quantity: 2, salesCents: 160_000 }]);
  });

  it('a part refund lowers the sales, not the cost: the food was made', () => {
    const t = emptyFoodCostTally();
    tallyFoodCost(t, { discountCents: 0, totalCents: 116_000, refundedCents: 11_600, lines: [L({ lineTotalCents: 100_000, costCents: 30_000 })], estimate: null });
    expect(t).toMatchObject({ foodSalesCents: 90_000, knownSalesCents: 90_000, knownMenuSalesCents: 100_000, knownCostCents: 30_000, costOfSalesCents: 30_000 });
  });
});

describe('tallyPlainOrders: plain orders added up at once give what order-by-order gives', () => {
  it('the same sales, cost, known and missing as tallyFoodCost on each order', () => {
    const orders: FoodCostLine[][] = [
      [L({ key: 'pizza', lineTotalCents: 120_000, costCents: 30_000 }), L({ key: 'fee', lineTotalCents: 20_000, isFee: true, status: 'none' })],
      [L({ key: 'pizza', lineTotalCents: 120_000, costCents: 30_000 }), L({ key: 'dip', lineTotalCents: 10_000, costCents: 400, status: 'partial' })],
      [L({ key: 'wings', lineTotalCents: 80_000, status: 'none' }), L({ key: 'x', lineTotalCents: 5_000, costCents: 700, status: 'failed' }), L({ key: 'pizza', lineTotalCents: 60_000, costCents: 15_000 })],
      [L({ key: 'y', lineTotalCents: 7_000, parts: 0, status: null }), L({ key: 'pizza', lineTotalCents: 60_000, costCents: 15_000 })],
    ];
    const one = emptyFoodCostTally();
    for (const lines of orders) tallyFoodCost(one, { discountCents: 0, totalCents: 1, refundedCents: 0, lines, estimate: null });
    const all = orders.flat();
    const food = all.filter((l) => !l.isFee);
    const at = emptyFoodCostTally();
    tallyPlainOrders(at, {
      lineCount: all.length,
      foodSalesCents: food.reduce((s2, l) => s2 + l.lineTotalCents, 0),
      feeSalesCents: all.filter((l) => l.isFee).reduce((s2, l) => s2 + l.lineTotalCents, 0),
      foodCostCents: food.reduce((s2, l) => s2 + l.costCents, 0),
      notFull: food.filter((l) => l.status !== 'full'),
    });
    expect(at).toEqual(one);
  });

  it('no plain orders: nothing changes', () => {
    const t = emptyFoodCostTally();
    tallyPlainOrders(t, { lineCount: 0, foodSalesCents: 0, feeSalesCents: 0, foodCostCents: 0, notFull: [] });
    expect(t).toEqual(emptyFoodCostTally());
  });
});

describe('wasteReasonOf', () => {
  it('food made for a cancelled order, or the reason picked; "other" when none', () => {
    expect(wasteReasonOf('cancel_made', 'o1')).toBe('cancelled_made');
    expect(wasteReasonOf(null, 'o1')).toBe('cancelled_made'); // before reasons were kept
    expect(wasteReasonOf('waste:burnt', null)).toBe('burnt');
    expect(wasteReasonOf('waste:staff_meal', null)).toBe('staff_meal');
    expect(wasteReasonOf('waste:eaten_by_cat', null)).toBe('other');
    expect(wasteReasonOf(null, null)).toBe('other');
  });
});

describe('movementWithoutCosts', () => {
  it('drops the value, unit price and basis; keeps the quantity and the waste reason', () => {
    const m = {
      id: 'm1',
      ingredientId: 'i1',
      deltaQty: -5,
      reason: 'waste',
      refOrderId: null,
      refPurchaseOrderId: null,
      notes: null,
      actorUserId: null,
      occurredAt: 'x',
      resultingQty: 10,
      detail: 'waste:burnt',
      valueCents: -75,
      unitCostMc: 15_000,
      costBasis: 'price',
    } as unknown as StockMovement;
    const out = movementWithoutCosts(m);
    expect(out).not.toHaveProperty('valueCents');
    expect(out).not.toHaveProperty('unitCostMc');
    expect(out).not.toHaveProperty('costBasis');
    expect(out).toMatchObject({ deltaQty: -5, detail: 'waste:burnt' });
  });
});
