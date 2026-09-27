import { describe, expect, it } from 'vitest';
import type { BatchCalc, ItemCostSheet } from '@cheeseoclock/shared-types';
import { costSheetPrintHtml } from './costSheetPrint';

// Made-up figures.
const SHEET: ItemCostSheet = {
  row: {
    menuItemId: 'm1',
    name: 'Fajita <Special> — Medium',
    categoryId: 'c1',
    categoryName: 'Pizza',
    isActive: true,
    basePriceCents: 120_000,
    priceCents: 120_000,
    costCents: 17_641,
    minCostCents: 17_641,
    maxCostCents: 17_641,
    profitCents: 102_359,
    foodCostBps: 1470,
    targetBps: 3000,
    targetConfirmed: true,
    flag: 'green',
    hasRecipe: true,
    missingLines: 0,
    missingIngredients: [],
    estimateLines: 0,
    soldLast28: 12,
  },
  always: [
    { ingredientId: 'i1', name: 'Cheese', unit: 'g', qty: 60, unitCostMc: 120_000, costMc: 7_200_000, costCents: 7_200, shareBps: 4081, priceKind: 'set', madeOf: null },
  ],
  alwaysCostCents: 7_200,
  groups: [],
  paidExtras: [
    { modifierId: 'x', name: 'Extra cheese', groupName: 'Extras', priceDeltaCents: 15_000, costCents: 4_800, marginCents: 10_200, foodCostBps: 3200, flag: 'red', missingLines: 0, lines: [] },
  ],
  leaveOuts: [{ modifierId: 'n', name: 'No onion', ingredientName: 'Onion', savingCents: 150, missingLines: 0 }],
};

/** The made-up "Cola 345 ml": its bottle has no price, so the till can't cost it. */
const COLA: ItemCostSheet = {
  row: {
    ...SHEET.row,
    menuItemId: 'm2',
    name: 'Cola 345 ml',
    categoryName: 'Drinks',
    basePriceCents: 15_000,
    priceCents: 15_000,
    costCents: 0,
    minCostCents: 0,
    maxCostCents: 0,
    profitCents: 15_000,
    foodCostBps: 0,
    targetBps: 6000,
    targetConfirmed: false,
    flag: 'grey',
    missingLines: 1,
    missingIngredients: ['Bottle'],
  },
  always: [{ ingredientId: 'i2', name: 'Bottle', unit: 'pcs', qty: 1, unitCostMc: null, costMc: 0, costCents: 0, shareBps: null, priceKind: 'missing', madeOf: null }],
  alwaysCostCents: 0,
  groups: [],
  paidExtras: [
    // An extra whose only line has no price, and one with no recipe lines at all.
    { modifierId: 'x1', name: 'Side of Test dip', groupName: 'Dips', priceDeltaCents: 10_000, costCents: 0, marginCents: 10_000, foodCostBps: 0, flag: 'grey', missingLines: 1, lines: [{ ingredientId: 'i3', name: 'Test dip', unit: 'g', qty: 25, unitCostMc: null, costMc: 0, costCents: 0, shareBps: null, priceKind: 'missing', madeOf: null }] },
    { modifierId: 'x2', name: 'Ice', groupName: 'Extras', priceDeltaCents: 2_000, costCents: 0, marginCents: 2_000, foodCostBps: 0, flag: 'grey', missingLines: 0, lines: [] },
  ],
  leaveOuts: [{ modifierId: 'n', name: 'No lemon', ingredientName: 'Lemon', savingCents: 0, missingLines: 1 }],
};

describe('the printed cost sheet', () => {
  it('says what it costs, what you keep and the food cost, escaped', () => {
    const html = costSheetPrintHtml(SHEET, new Date('2026-09-27T10:00:00Z'));
    expect(html).toContain('Fajita &lt;Special&gt; — Medium');
    expect(html).not.toContain('<Special>');
    expect(html).toContain('costs Rs 176.41 to make, you keep Rs 1,023.59 per sale at Rs 1,200');
    expect(html).toContain('food cost 14.7% (target 30%)');
    expect(html).toContain('Rs 1,200 / kg');
    expect(html).toContain('Of the plate');
    expect(html).toContain('saves Rs 1.50');
    expect(html).toContain('Extra cheese');
  });

  it('an item that can\'t be costed never prints a Rs 0 cost, a full profit or a 0% food cost', () => {
    const html = costSheetPrintHtml(COLA, new Date('2026-09-27T10:00:00Z'));
    expect(html).toContain("can't be costed yet: Bottle has no price yet. Price Rs 150.");
    expect(html).not.toMatch(/costs Rs 0 to make/);
    expect(html).not.toMatch(/you keep/);
    expect(html).not.toMatch(/food cost 0%/);
    expect(html).toContain('(no price yet)');
    expect(html).toContain('Always in it — at least Rs 0');
    // the paid extras with nothing priced: "—", never "cost Rs 0, you keep Rs 100, 0%"
    expect(html).toContain('Side of Test dip <span class="muted">(no price yet)</span></td><td class="r">Rs 100</td><td class="r">—</td><td class="r">—</td><td class="r">—</td>');
    expect(html).toContain('Ice <span class="muted">(no recipe lines)</span></td><td class="r">Rs 20</td><td class="r">—</td>');
    expect(html).toContain('saving not known yet: Lemon has no price');
    // a dish with no recipe says so
    expect(costSheetPrintHtml({ ...COLA, row: { ...COLA.row, hasRecipe: false, missingIngredients: [] } })).toContain("can't be costed yet: No recipe yet.");
  });

  it('a sauce not fully priced says it is costed at its saved price, above its parts', () => {
    const madeOf: BatchCalc = {
      ingredientId: 's',
      name: 'Test sauce',
      unit: 'g',
      batchYield: 2000,
      amount: 50,
      lines: [
        { inputId: 't', name: 'Test tomato', unit: 'g', perBatchQty: 2500, scaledHundredths: 6250, stockQty: 63, unitCostMc: 12_000, costMc: 750_000, costCents: 750, shareBps: 10_000, priceKind: 'set', madeInHouse: false, madeOf: null },
        { inputId: 'g', name: 'Test garlic', unit: 'g', perBatchQty: 125, scaledHundredths: 313, stockQty: 3, unitCostMc: null, costMc: 0, costCents: 0, shareBps: 0, priceKind: 'missing', madeInHouse: false, madeOf: null },
      ],
      totalCostMc: 750_000,
      totalCostCents: 750,
      perUnitMc: 15_000,
      complete: false,
      unpricedInputs: ['Test garlic'],
      estimateInputs: [],
      roundedAway: [],
      inStock: 0,
      maxAmount: 200_000,
    };
    const html = costSheetPrintHtml({
      ...SHEET,
      always: [{ ingredientId: 's', name: 'Test sauce', unit: 'g', qty: 50, unitCostMc: 16_000, costMc: 800_000, costCents: 800, shareBps: 500, priceKind: 'set', madeOf }],
    });
    expect(html).toContain('Test garlic has no price yet, so this is costed at its saved price (Rs 8) until every input has one; the inputs with a price come to Rs 7.50.');
  });
});
