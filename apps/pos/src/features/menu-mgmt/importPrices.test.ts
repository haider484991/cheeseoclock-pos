/**
 * The menu import's price details (costing spec Phase 6): each ingredient
 * grouped by what happens to its price, the till's beside the sheet's.
 * Every name and price is made up.
 */
import { describe, expect, it } from 'vitest';
import type { MenuImportIngredientPlan } from '@cheeseoclock/shared-types';
import { priceDetailGroups, sheetPriceText, tillPriceText } from './importPrices';

const plan = (p: Partial<MenuImportIngredientPlan> & Pick<MenuImportIngredientPlan, 'name'>): MenuImportIngredientPlan => ({
  unit: 'g',
  costPerUnitCents: 0,
  packSize: 1000,
  packPriceCents: 110_000,
  priceKind: 'set',
  action: 'same',
  existingName: null,
  changes: [],
  reason: null,
  price: 'kept',
  tillPrice: null,
  sheetUnitCostMc: 110_000,
  sheetDiffers: false,
  ...p,
});

describe('import price details', () => {
  it('groups by what happens, the ones the sheet disagrees with first', () => {
    const groups = priceDetailGroups([
      plan({ name: 'Test onion', price: 'kept_typed' }),
      plan({ name: 'Test cheese', price: 'kept_delivery', sheetDiffers: true }),
      plan({ name: 'Test basil', price: 'new_from_sheet' }),
      plan({ name: 'Test olive', price: 'kept_typed', sheetDiffers: true }),
      plan({ name: 'Test salt', price: 'kept_free' }),
      plan({ name: 'Test box', price: 'kept' }),
      plan({ name: 'Test sauce', price: 'made_here' }),
      plan({ name: 'Test dip', price: 'batch_kept', sheetDiffers: true }),
      plan({ name: 'Test bottle', price: 'unpriced' }),
      plan({ name: 'Test skipped', price: null, action: 'skip' }),
    ]);
    expect(groups.map((g) => [g.title, g.rows.map((r) => r.name)])).toEqual([
      ['New from the sheet', ['Test basil']],
      ['Kept from deliveries', ['Test cheese']],
      ['Kept as typed', ['Test olive', 'Test onion']],
      ['Kept as they are', ['Test box', 'Test salt']],
      ['Worked out from their batch recipe', ['Test sauce']],
      ['Batches that keep their price (something in them has no price)', ['Test dip']],
      ['Still no price', ['Test bottle']],
    ]);
  });

  it("says the till's price and the sheet's per kg or per piece", () => {
    expect(tillPriceText(plan({ name: 'x', price: 'kept_delivery', tillPrice: { unitCostMc: 130_000, priceKind: 'set', source: 'delivery' } }))).toBe('till Rs 1,300 / kg');
    expect(tillPriceText(plan({ name: 'x', price: 'kept_free' }))).toBe('till: free');
    expect(tillPriceText(plan({ name: 'x', price: 'new_from_sheet' }))).toBe('till: no price');
    // A batch here with no price of its own, priced from its recipe: on the till already, so never "new".
    expect(tillPriceText(plan({ name: 'x', price: 'made_here', action: 'update' }))).toBe('till: no price');
    expect(tillPriceText(plan({ name: 'x', price: 'new_from_sheet', action: 'create' }))).toBe('new');
    expect(tillPriceText(plan({ name: 'x', price: 'made_here', action: 'create' }))).toBe('new');
    expect(sheetPriceText(plan({ name: 'x' }))).toBe('sheet Rs 1,100 / kg');
    expect(sheetPriceText(plan({ name: 'x', unit: 'pcs', packSize: null, packPriceCents: null, costPerUnitCents: 4_000, sheetUnitCostMc: 4_000_000 }))).toBe('sheet Rs 40 / pcs');
    expect(sheetPriceText(plan({ name: 'x', packPriceCents: 0, sheetUnitCostMc: 0 }))).toBe('sheet: Rs 0 (no price)');
  });
});
