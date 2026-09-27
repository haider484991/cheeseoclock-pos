import { describe, expect, it } from 'vitest';
import type { MenuCostRow } from '@cheeseoclock/shared-types';
import {
  amountProblem,
  atLeast,
  batchMakeReady,
  compareWorstFirst,
  formatBps,
  formatHundredths,
  formatUnitPrice,
  groupSizes,
  leaveOutText,
  madeOfNote,
  noPriceText,
  parseAmount,
  parsePercent,
  parseRupees,
  priceKindNote,
  readAmount,
  splitSize,
  summarySentence,
} from './costingFormat';

const row = (name: string, flag: MenuCostRow['flag'], foodCostBps: number | null, categoryId = 'pizza'): MenuCostRow => ({
  menuItemId: name,
  name,
  categoryId,
  categoryName: categoryId,
  isActive: true,
  basePriceCents: 0,
  priceCents: 0,
  costCents: 0,
  minCostCents: 0,
  maxCostCents: 0,
  profitCents: 0,
  foodCostBps,
  targetBps: 3000,
  targetConfirmed: true,
  flag,
  hasRecipe: true,
  missingLines: 0,
  missingIngredients: [],
  estimateLines: 0,
  soldLast28: 0,
});

describe('costing words and numbers', () => {
  it('percentages, unit prices and exact amounts', () => {
    expect(formatBps(1470)).toBe('14.7%');
    expect(formatBps(3000)).toBe('30%');
    expect(formatBps(null)).toBe('—');
    expect(formatUnitPrice(120_000, 'g')).toBe('Rs 1,200 / kg');
    expect(formatUnitPrice(17_813, 'ml')).toBe('Rs 178.13 / litre');
    expect(formatUnitPrice(4_000_000, 'pcs')).toBe('Rs 40 / pcs');
    expect(formatUnitPrice(null, 'g')).toBe('no price');
    expect(formatHundredths(1250, 'g')).toBe('12.5 g');
    expect(priceKindNote('estimate')).toBe('a guess');
    expect(priceKindNote('set')).toBeNull();
  });

  it('the summary line in plain words', () => {
    expect(summarySentence({ items: 31, onTarget: 18, close: 9, over: 4, cantCost: 3, notConfirmed: 0 })).toBe(
      "31 items: 18 on target, 9 close, 4 over, 3 can't be costed yet",
    );
    // Day one, every target a suggestion: nothing was checked, and it must not read as good news.
    expect(summarySentence({ items: 31, onTarget: 0, close: 0, over: 0, cantCost: 3, notConfirmed: 28 })).toBe(
      "31 items: 28 not checked yet (the targets are only suggestions), 3 can't be costed yet",
    );
    expect(summarySentence({ items: 1, onTarget: 0, close: 0, over: 0, cantCost: 0, notConfirmed: 1 })).not.toMatch(/on (suggested )?target/);
  });

  it('worst first, and sizes grouped under their base name at the worst size', () => {
    const rows = [
      row('Fajita Pizza — Medium', 'green', 2500),
      row('Veggie — Large', 'amber', 3300),
      row('Fajita Pizza — Large', 'red', 3900),
      row('Cola', 'grey', null, 'drinks'),
    ];
    expect([...rows].sort(compareWorstFirst).map((r) => r.name)).toEqual([
      'Fajita Pizza — Large',
      'Veggie — Large',
      'Cola',
      'Fajita Pizza — Medium',
    ]);
    expect(groupSizes(rows).map((g) => [g.base, g.rows.map((r) => splitSize(r.name).size)])).toEqual([
      ['Fajita Pizza', ['Large', 'Medium']],
      ['Veggie', ['Large']],
      ['Cola', [null]],
    ]);
    expect(splitSize('Mix-Up Burger')).toEqual({ base: 'Mix-Up Burger', size: null });
  });

  it('reads typed percentages, rupees and amounts without floats', () => {
    expect(parsePercent('32.5')).toBe(3250);
    expect(parsePercent('30%')).toBe(3000);
    expect(parsePercent('0.07')).toBe(7);
    expect(parsePercent('101')).toBeNull();
    expect(parsePercent('abc')).toBeNull();
    expect(parseRupees('10')).toBe(1000);
    expect(parseRupees('1,250.5')).toBe(125_050);
    expect(parseRupees('-3')).toBeNull();
    expect(parseAmount('200', false)).toBe(200);
    expect(parseAmount('12.5', false)).toBeNull(); // stock is whole grams
    expect(parseAmount('1.5', true)).toBe(1500);
    expect(parseAmount('0.0125', true)).toBeNull();
    expect(parseAmount('0', false)).toBeNull();
  });

  it('the batch amount the way people type it: "200 g", "1.5 kg", "1,500g", a unit beats the switch', () => {
    expect(readAmount('200 g', false, 'g')).toEqual({ ok: true, amount: 200 });
    expect(readAmount('200g', true, 'g')).toEqual({ ok: true, amount: 200 }); // typed g while the kg switch is on
    expect(readAmount('1.5 kg', false, 'g')).toEqual({ ok: true, amount: 1500 });
    expect(readAmount('1.5KG', false, 'g')).toEqual({ ok: true, amount: 1500 });
    expect(readAmount('1,500 gm', false, 'g')).toEqual({ ok: true, amount: 1500 });
    expect(readAmount('2 kilo', false, 'g')).toEqual({ ok: true, amount: 2000 });
    expect(readAmount('1.5 litre', false, 'ml')).toEqual({ ok: true, amount: 1500 });
    expect(readAmount('750 ml', true, 'ml')).toEqual({ ok: true, amount: 750 });
    expect(readAmount('12 pcs', false, 'pcs')).toEqual({ ok: true, amount: 12 });
    expect(readAmount('1.5', true, 'pcs')).toEqual({ ok: false, reason: 'part-unit' }); // no kg for pieces
    expect(readAmount('1.5 kg', false, 'ml')).toEqual({ ok: false, reason: 'unreadable' });
    expect(readAmount('abc', false, 'g')).toEqual({ ok: false, reason: 'unreadable' });
    expect(readAmount('', false, 'g')).toEqual({ ok: false, reason: 'empty' });
    expect(readAmount('0 kg', false, 'g')).toEqual({ ok: false, reason: 'zero' });
    expect(readAmount('1.0005 kg', false, 'g')).toEqual({ ok: false, reason: 'too-precise' });
  });

  it('says why an amount cannot be used, in words that make sense to the person who typed it', () => {
    // "1.5" with the g switch on: point at the kg switch, not "whole g only".
    expect(amountProblem(readAmount('1.5', false, 'g'), 'g', false)).toBe(
      'Stock is counted in whole g: type g without a decimal, or switch to kg to type 1.5 kg.',
    );
    expect(amountProblem(readAmount('12.5 g', true, 'g'), 'g', true)).toContain('switch to kg');
    expect(amountProblem(readAmount('lots', false, 'g'), 'g', false)).toBe('Type an amount like 200 or 200 g, or 1.5 kg.');
    expect(amountProblem(readAmount('', true, 'g'), 'g', true)).toBe('Type an amount in kg.');
    expect(amountProblem(readAmount('200 g', false, 'g'), 'g', false)).toBeNull();
  });

  it('"Make this amount" waits until the breakdown on screen is for the amount typed', () => {
    const base = { amount: 200, usable: true, hasLines: true, pending: false, seesCosts: true, shownAmount: 200 };
    expect(batchMakeReady(base)).toBe(true);
    expect(batchMakeReady({ ...base, shownAmount: 2000 })).toBe(false); // still showing the 2,000 g figures
    expect(batchMakeReady({ ...base, shownAmount: null })).toBe(false);
    expect(batchMakeReady({ ...base, seesCosts: false, shownAmount: null })).toBe(true); // amounts worked out on screen
    expect(batchMakeReady({ ...base, pending: true })).toBe(false);
    expect(batchMakeReady({ ...base, usable: false })).toBe(false);
    expect(batchMakeReady({ ...base, hasLines: false })).toBe(false);
  });

  it('missing prices: each ingredient named once; sums with an unpriced part say "at least"', () => {
    expect(noPriceText(['Test garlic'])).toBe('Test garlic has no price yet');
    expect(noPriceText(['Test garlic', 'Test bottle'])).toBe('Test garlic and Test bottle have no price yet');
    expect(noPriceText(['a', 'b', 'c'])).toBe('a, b and c have no price yet');
    expect(noPriceText(['a', 'b', 'c', 'd'])).toBe('4 ingredients have no price yet');
    expect(atLeast(12_000, false)).toBe('Rs 120');
    expect(atLeast(12_000, true)).toBe('at least Rs 120');
    expect(leaveOutText({ savingCents: 150, missingLines: 0, ingredientName: 'Onion' })).toBe('saves Rs 1.5');
    expect(leaveOutText({ savingCents: 150, missingLines: 1, ingredientName: 'Onion' })).toBe('saves at least Rs 1.5');
    expect(leaveOutText({ savingCents: 0, missingLines: 2, ingredientName: 'Onion' })).toBe('saving not known yet: Onion has no price');
  });

  it('a sauce not fully priced says which figure the plate uses and why its parts add up to less', () => {
    const calc = { complete: false, unpricedInputs: ['Test garlic'], totalCostCents: 750 };
    expect(madeOfNote({ costCents: 800, priceKind: 'set' }, calc)).toBe(
      'Test garlic has no price yet, so this is costed at its saved price (Rs 8) until every input has one; the inputs with a price come to Rs 7.5.',
    );
    expect(madeOfNote({ costCents: 0, priceKind: 'missing' }, calc)).toBe(
      "Test garlic has no price yet, so this can't be costed yet; the inputs with a price come to Rs 7.5.",
    );
    expect(madeOfNote({ costCents: 800, priceKind: 'set' }, { ...calc, complete: true })).toBeNull();
  });
});
