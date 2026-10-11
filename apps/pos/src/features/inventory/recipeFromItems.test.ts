/**
 * A recipe built from the recipes of items already on the menu
 * (recipeFromItems.ts): 0.7.47 links them (the same item for the same choice
 * added together; a copy 0.7.46 made of it taken out, so nothing counts
 * twice); another item's lines × how many as 0.7.46 copied them; a deal's
 * choice matched to its item by name. Every name and amount is made up.
 */
import { describe, expect, it } from 'vitest';
import {
  itemForChoice,
  linesFromItem,
  linkProblem,
  linksToSave,
  mergeLinks,
  withoutCopiedLines,
  type DraftLine,
  type DraftLink,
} from './recipeFromItems';

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

  it('how many is a whole number from 1 to 99 (a link’s limit)', () => {
    expect(linesFromItem(FRIES, { times: 0, target: null })[0]!.qtyPerUnit).toBe(150);
    expect(linesFromItem(FRIES, { times: 120, target: null })[0]!.qtyPerUnit).toBe(14_850);
    expect(linesFromItem(FRIES, { times: 2.4, target: null })[0]!.qtyPerUnit).toBe(300);
  });
});

const link = (componentItemId: string, qtyPerUnit: number, modifierId: string | null = null, choices: Array<[string, string]> = []): DraftLink => ({
  componentItemId,
  qtyPerUnit,
  modifierId,
  componentModifierIds: choices.map(([id]) => id),
  componentName: componentItemId === 'zinger' ? 'Zinger Burger' : componentItemId === 'fries' ? 'Regular Fries' : componentItemId,
  componentModifierNames: choices.map(([, name]) => name),
});

describe('links added to the recipe being edited (0.7.47)', () => {
  it('the same item for the same choice is one link, the amounts added and its ticked choices joined; another choice is its own link', () => {
    const merged = mergeLinks(
      [link('zinger', 2), link('fries', 1)],
      [link('zinger', 1, null, [['extra-cheese', 'Extra cheese']]), link('zinger', 1, 'deal-slot-1'), link('fries', 1)],
    );
    expect(merged.map((l) => [l.componentItemId, l.qtyPerUnit, l.modifierId, l.componentModifierIds])).toEqual([
      ['zinger', 3, null, ['extra-cheese']],
      ['fries', 2, null, []],
      ['zinger', 1, 'deal-slot-1', []],
    ]);
    expect(merged[0]!.componentModifierNames).toEqual(['Extra cheese']);
  });

  it('never more than 99 of one item; the links it was given are left as they were', () => {
    const existing = [link('fries', 98)];
    expect(mergeLinks(existing, [link('fries', 5)])[0]!.qtyPerUnit).toBe(99);
    expect(existing[0]!.qtyPerUnit).toBe(98);
  });

  it('Save sends each link as setRecipe takes it; one tried at 0 is left out', () => {
    expect(linksToSave([link('zinger', 2, null, [['extra-cheese', 'Extra cheese']]), link('fries', 0)])).toEqual([
      { componentItemId: 'zinger', qtyPerUnit: 2, modifierId: null, componentModifierIds: ['extra-cheese'] },
    ]);
  });

  it('what stops a save, in words: a count outside 1–99, the same item twice for one choice', () => {
    expect(linkProblem([link('zinger', 2), link('fries', 1)])).toBeNull();
    expect(linkProblem([link('zinger', 0)])).toBe('How many Zinger Burger: a whole number from 1 to 99.');
    expect(linkProblem([link('zinger', 100)])).toBe('How many Zinger Burger: a whole number from 1 to 99.');
    expect(linkProblem([link('zinger', 2), link('zinger', 1)])).toBe('Zinger Burger is linked twice for the same choice: change how many instead.');
    expect(linkProblem([link('zinger', 2), link('zinger', 1, 'deal-slot-1')])).toBeNull();
  });
});

describe('a copy made before (0.7.46) taken out when the item is linked', () => {
  // The Big Two deal as 0.7.46 built it: 2 burgers' lines then the fries' (with a sauce sachet), and the deal's own dip.
  const FRIES_WITH_SAUCE: DraftLine[] = [...FRIES, { ingredientId: 'sauce', qtyPerUnit: 10, modifierId: null }];
  const copied: DraftLine[] = [
    { ingredientId: 'bun', qtyPerUnit: 2, modifierId: null },
    { ingredientId: 'fillet', qtyPerUnit: 240, modifierId: null },
    { ingredientId: 'sauce', qtyPerUnit: 50, modifierId: null },
    { ingredientId: 'fries', qtyPerUnit: 150, modifierId: null },
    { ingredientId: 'oil', qtyPerUnit: 10, modifierId: null },
    { ingredientId: 'box', qtyPerUnit: 1, modifierId: null },
    { ingredientId: 'sauce', qtyPerUnit: 15, modifierId: 'deal-dip' },
  ];

  it('linking the 2 burgers takes their lines out (of the sauce both use, only theirs); the rest stays', () => {
    const r = withoutCopiedLines(copied, linesFromItem(BURGER, { times: 2, target: null }));
    expect(r.removed).toBe(true);
    expect(r.lines).toEqual([
      { ingredientId: 'sauce', qtyPerUnit: 10, modifierId: null },
      { ingredientId: 'fries', qtyPerUnit: 150, modifierId: null },
      { ingredientId: 'oil', qtyPerUnit: 10, modifierId: null },
      { ingredientId: 'box', qtyPerUnit: 1, modifierId: null },
      { ingredientId: 'sauce', qtyPerUnit: 15, modifierId: 'deal-dip' },
    ]);
    // Then the fries: only the deal's own dip is left.
    const r2 = withoutCopiedLines(r.lines, linesFromItem(FRIES_WITH_SAUCE, { times: 1, target: null }));
    expect(r2.lines).toEqual([{ ingredientId: 'sauce', qtyPerUnit: 15, modifierId: 'deal-dip' }]);
  });

  it('not a copy (a line missing, too little of one, another choice): nothing comes out', () => {
    expect(withoutCopiedLines(copied, linesFromItem(BURGER, { times: 3, target: null })).removed).toBe(false);
    expect(withoutCopiedLines(copied, linesFromItem(BURGER, { times: 1, target: 'deal-slot-1' })).removed).toBe(false);
    const r = withoutCopiedLines(copied, linesFromItem(BURGER, { times: 1, withChoices: new Set(['extra-cheese']), target: null }));
    expect(r.removed).toBe(false);
    expect(r.lines).toEqual(copied);
    // An item with no lines of its own (a deal made only of links) has no copy to take out.
    expect(withoutCopiedLines(copied, []).removed).toBe(false);
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
