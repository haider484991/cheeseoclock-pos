import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AMBER_BPS,
  DEFAULT_TARGET_BPS,
  confirmAll,
  resolveTargets,
  suggestedNonFood,
  suggestedTargetBps,
} from './cost-targets.js';

describe('suggested targets by category name', () => {
  it('Pizza 30%, Burgers 35%, Fries & Sides 35%, Value Deals 35%, Dips 30%, Drinks 60%', () => {
    expect(suggestedTargetBps('Pizza')).toBe(3000);
    expect(suggestedTargetBps('Signature Pizzas')).toBe(3000);
    expect(suggestedTargetBps('Burgers')).toBe(3500);
    expect(suggestedTargetBps('Fries & Sides')).toBe(3500);
    expect(suggestedTargetBps('Value Deals')).toBe(3500);
    expect(suggestedTargetBps('Dips')).toBe(3000);
    expect(suggestedTargetBps('Drinks')).toBe(6000);
    expect(suggestedTargetBps('Wings')).toBe(DEFAULT_TARGET_BPS);
  });
  it('delivery charges are not food', () => {
    expect(suggestedNonFood('Delivery Charges')).toBe(true);
    expect(suggestedNonFood('Delivery fee')).toBe(true);
    expect(suggestedNonFood('Burgers')).toBe(false);
  });
});

describe('resolveTargets', () => {
  const cats = [
    { id: 'c-pizza', name: 'Pizza' },
    { id: 'c-drinks', name: 'Drinks' },
    { id: 'c-del', name: 'Delivery Charges' },
  ];

  it('nothing saved: every category on its suggestion, unconfirmed', () => {
    const r = resolveTargets(null, cats);
    expect(r.amberBps).toBe(DEFAULT_AMBER_BPS);
    expect(r.byCategory.get('c-pizza')).toEqual({ bps: 3000, suggestedBps: 3000, confirmed: false, nonFood: false });
    expect(r.byCategory.get('c-drinks')).toMatchObject({ bps: 6000, confirmed: false });
    expect(r.byCategory.get('c-del')).toMatchObject({ nonFood: true });
  });

  it('"Use these" confirms every category as shown; a category added later starts on its suggestion', () => {
    const saved = confirmAll(resolveTargets(null, cats));
    expect(saved.perCategory['c-pizza']).toEqual({ bps: 3000, confirmed: true });
    expect(saved.nonFoodCategoryIds).toEqual(['c-del']);
    const later = resolveTargets(saved, [...cats, { id: 'c-burgers', name: 'Burgers' }]);
    expect(later.byCategory.get('c-pizza')).toMatchObject({ confirmed: true });
    expect(later.byCategory.get('c-burgers')).toMatchObject({ bps: 3500, confirmed: false });
  });

  it('a saved target and a saved non-food list win over the names', () => {
    const r = resolveTargets(
      { defaultBps: 2800, amberBps: 300, perCategory: { 'c-pizza': { bps: 2700, confirmed: true } }, nonFoodCategoryIds: [] },
      cats,
    );
    expect(r.byCategory.get('c-pizza')).toEqual({ bps: 2700, suggestedBps: 3000, confirmed: true, nonFood: false });
    expect(r.byCategory.get('c-del')).toMatchObject({ nonFood: false, bps: 2800 });
    expect(r.amberBps).toBe(300);
  });
});
