/**
 * A recipe built from the recipes of items already on the menu
 * (recipeFromItems.ts, 0.7.46): another item's lines × how many, under a
 * choice or on every sale, merged into the recipe being edited; a deal's
 * choice matched to its item by name. Every name and amount is made up.
 */
import { describe, expect, it } from 'vitest';
import { itemForChoice, linesFromItem, mergeRecipeLines, type DraftLine } from './recipeFromItems';

const BURGER: DraftLine[] = [
  { ingredientId: 'bun', qtyPerUnit: 1, modifierId: null },
  { ingredientId: 'fillet', qtyPerUnit: 120, modifierId: null },
  { ingredientId: 'sauce', qtyPerUnit: 20, modifierId: null },
  { ingredientId: 'cheese', qtyPerUnit: 25, modifierId: 'extra-cheese' },
];
const FRIES: DraftLine[] = [
  { ingredientId: 'fries', qtyPerUnit: 150, modifierId: null },
  { ingredientId: 'oil', qtyPerUnit: 10, modifierId: null },
  { ingredientId: 'box', qtyPerUnit: 1, modifierId: null },
];

describe('another item’s recipe as lines of this one', () => {
  it('two Zinger Burgers: every-sale lines × 2 on every sale; its choices left out', () => {
    expect(linesFromItem(BURGER, { times: 2, target: null })).toEqual([
      { ingredientId: 'bun', qtyPerUnit: 2, modifierId: null },
      { ingredientId: 'fillet', qtyPerUnit: 240, modifierId: null },
      { ingredientId: 'sauce', qtyPerUnit: 40, modifierId: null },
    ]);
  });

  it('a choice of its ticked (Extra cheese) comes too; under this deal’s choice when one is given', () => {
    expect(linesFromItem(BURGER, { times: 1, withChoices: new Set(['extra-cheese']), target: 'deal-slot-1' })).toEqual([
      { ingredientId: 'bun', qtyPerUnit: 1, modifierId: 'deal-slot-1' },
      { ingredientId: 'fillet', qtyPerUnit: 120, modifierId: 'deal-slot-1' },
      { ingredientId: 'sauce', qtyPerUnit: 20, modifierId: 'deal-slot-1' },
      { ingredientId: 'cheese', qtyPerUnit: 25, modifierId: 'deal-slot-1' },
    ]);
  });

  it('one ingredient twice in the source (its own line and a choice’s) is one line, added together', () => {
    const pizza: DraftLine[] = [
      { ingredientId: 'cheese', qtyPerUnit: 60, modifierId: null },
      { ingredientId: 'cheese', qtyPerUnit: 30, modifierId: 'large' },
    ];
    expect(linesFromItem(pizza, { times: 1, withChoices: new Set(['large']), target: null })).toEqual([{ ingredientId: 'cheese', qtyPerUnit: 90, modifierId: null }]);
  });

  it('how many is a whole number from 1 to 20', () => {
    expect(linesFromItem(FRIES, { times: 0, target: null })[0]!.qtyPerUnit).toBe(150);
    expect(linesFromItem(FRIES, { times: 99, target: null })[0]!.qtyPerUnit).toBe(3_000);
    expect(linesFromItem(FRIES, { times: 2.4, target: null })[0]!.qtyPerUnit).toBe(300);
  });
});

describe('merged into the recipe being edited', () => {
  it('the Big Two deal: 2 burgers then fries; the same ingredient for the same choice is added, never listed twice', () => {
    const deal = mergeRecipeLines(linesFromItem(BURGER, { times: 2, target: null }), [
      ...linesFromItem(FRIES, { times: 1, target: null }),
      { ingredientId: 'sauce', qtyPerUnit: 10, modifierId: null },
      { ingredientId: 'sauce', qtyPerUnit: 15, modifierId: 'deal-dip' },
    ]);
    expect(deal).toEqual([
      { ingredientId: 'bun', qtyPerUnit: 2, modifierId: null },
      { ingredientId: 'fillet', qtyPerUnit: 240, modifierId: null },
      { ingredientId: 'sauce', qtyPerUnit: 50, modifierId: null },
      { ingredientId: 'fries', qtyPerUnit: 150, modifierId: null },
      { ingredientId: 'oil', qtyPerUnit: 10, modifierId: null },
      { ingredientId: 'box', qtyPerUnit: 1, modifierId: null },
      { ingredientId: 'sauce', qtyPerUnit: 15, modifierId: 'deal-dip' },
    ]);
  });

  it('the recipe it was given is left as it was', () => {
    const existing: DraftLine[] = [{ ingredientId: 'fries', qtyPerUnit: 100, modifierId: null }];
    mergeRecipeLines(existing, [{ ingredientId: 'fries', qtyPerUnit: 50, modifierId: null }]);
    expect(existing[0]!.qtyPerUnit).toBe(100);
  });
});

describe('a deal’s choice matched to its item by name', () => {
  const ITEMS = [
    { id: 'fm', name: 'Fajita Pizza — Medium' },
    { id: 'fl', name: 'Fajita Pizza — Large' },
    { id: 'vl', name: 'Veggie Lovers — Large' },
    { id: 'zb', name: 'Zinger Burger' },
    { id: 'rf', name: 'Regular Fries' },
  ];

  it('the same name first; else every word of the choice an item has, the shortest name', () => {
    expect(itemForChoice('Zinger Burger', ITEMS)).toBe('zb');
    expect(itemForChoice('Large: Fajita', ITEMS)).toBe('fl');
    expect(itemForChoice('2nd Large: Veggie', ITEMS)).toBe('vl');
    expect(itemForChoice('Fries', ITEMS)).toBe('rf');
    // "Fajita" alone: both sizes fit; the shorter name (Large) is only a start — the owner checks the box.
    expect(itemForChoice('Fajita', ITEMS)).toBe('fl');
  });

  it('nothing fits: none, for the owner to pick', () => {
    expect(itemForChoice('Pepsi 345 ml', ITEMS)).toBeNull();
    expect(itemForChoice('', ITEMS)).toBeNull();
  });
});
