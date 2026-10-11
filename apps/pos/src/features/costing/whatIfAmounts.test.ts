/**
 * What if on one dish's amounts (whatIfAmounts.ts, 0.7.46): the − / + steps,
 * the differences in words, the price box, and what Save writes. Every
 * amount is made up.
 */
import { describe, expect, it } from 'vitest';
import { formatCents } from '@cheeseoclock/pos-domain';
import { amountStep, amountsChanged, bpsDiff, linesToSave, moneyDiff, priceCentsOf, stepAmount } from './whatIfAmounts';

describe('the − / + steps', () => {
  it('grams and millilitres by 5, by 10 from 100; anything counted by 1', () => {
    expect(amountStep('g', 40)).toBe(5);
    expect(amountStep('g', 150)).toBe(10);
    expect(amountStep('ml', 250)).toBe(10);
    expect(amountStep('pcs', 2)).toBe(1);
    expect(amountStep('slice', 4)).toBe(1);
  });

  it('150 g of fries: + 160, − 140; down from 100 by 5 so 95 is reachable; never below 0', () => {
    expect(stepAmount(150, 'g', 1)).toBe(160);
    expect(stepAmount(150, 'g', -1)).toBe(140);
    expect(stepAmount(100, 'g', -1)).toBe(95);
    expect(stepAmount(95, 'g', 1)).toBe(100);
    expect(stepAmount(3, 'g', -1)).toBe(0);
    expect(stepAmount(0, 'pcs', -1)).toBe(0);
    expect(stepAmount(1, 'pcs', 1)).toBe(2);
  });
});

describe('the differences in words', () => {
  it('money: +Rs, −Rs, or no change', () => {
    expect(moneyDiff(14_500, 19_000)).toBe(`+${formatCents(4_500)}`);
    expect(moneyDiff(19_000, 14_500)).toBe(`−${formatCents(4_500)}`);
    expect(moneyDiff(100, 100)).toBe('no change');
  });

  it('the food cost in points; none when either side has none', () => {
    expect(bpsDiff(1611, 2111)).toBe('+5.0 points');
    expect(bpsDiff(2111, 1861)).toBe('−2.5 points');
    expect(bpsDiff(1500, 1500)).toBe('no change');
    expect(bpsDiff(null, 1500)).toBeNull();
  });
});

describe('the price box and Save', () => {
  it('a price before tax in rupees as paisa; empty or not a price is the menu’s own', () => {
    expect(priceCentsOf('900')).toBe(90_000);
    expect(priceCentsOf(' 1,250.5 ')).toBe(125_050);
    expect(priceCentsOf('')).toBeNull();
    expect(priceCentsOf('abc')).toBeNull();
    expect(priceCentsOf('-5')).toBeNull();
  });

  it('changed when an amount moved; Save leaves out a line tried at 0', () => {
    const saved = [{ qtyPerUnit: 150 }, { qtyPerUnit: 50 }];
    expect(amountsChanged(saved, [{ qtyPerUnit: 150 }, { qtyPerUnit: 50 }])).toBe(false);
    expect(amountsChanged(saved, [{ qtyPerUnit: 160 }, { qtyPerUnit: 50 }])).toBe(true);
    expect(linesToSave([{ id: 'a', qtyPerUnit: 160 }, { id: 'b', qtyPerUnit: 0 }])).toEqual([{ id: 'a', qtyPerUnit: 160 }]);
  });
});
