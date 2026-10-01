/**
 * The one deals rule (shared-types menu.ts; migration 0047, the owner's
 * "there is no discount on combos", 2026-10-02): which categories are never
 * discounted. Here, not in shared-types, because shared-types has no test
 * runner. NULL on a category = its name decides: the whole word deal(s) or
 * combo(s); what the owner set (Menu → Categories) wins over the name. The
 * food-cost targets read the same name test.
 */
import { describe, expect, it } from 'vitest';
import { VALUE_DEALS_NAME_RE, categoryNeverDiscounted } from '@cheeseoclock/shared-types';
import { suggestedTargetBps } from './cost-targets.js';

describe('categoryNeverDiscounted: by its name while nothing is set', () => {
  it.each(['Value Deals', 'Deals', 'Combos', 'Combo Deals', 'VALUE DEALS', 'Deal of the Day', 'combo', 'Family deal'])(
    '%s → never discounted',
    (name) => {
      expect(categoryNeverDiscounted({ name })).toBe(true);
      expect(categoryNeverDiscounted({ name, noDiscount: null })).toBe(true);
    },
  );

  it.each(['Pizza', 'Signature Pizzas', 'Dips', 'Delivery Charges', 'Ideal Sides', 'Dealers', 'Combination Platters', 'Ordeals', ''])(
    '%s → discounts come off',
    (name) => {
      expect(categoryNeverDiscounted({ name })).toBe(false);
      expect(categoryNeverDiscounted({ name, noDiscount: null })).toBe(false);
    },
  );
});

describe('categoryNeverDiscounted: what the owner set wins over the name', () => {
  it('an explicit no (false) puts the discounts back on a deals name; an explicit yes (true) keeps them off any name', () => {
    expect(categoryNeverDiscounted({ name: 'Value Deals', noDiscount: false })).toBe(false);
    expect(categoryNeverDiscounted({ name: 'Combos', noDiscount: false })).toBe(false);
    expect(categoryNeverDiscounted({ name: 'Drinks', noDiscount: true })).toBe(true);
    expect(categoryNeverDiscounted({ name: 'Bundles', noDiscount: true })).toBe(true);
    // The same answer as the name, set: still that answer.
    expect(categoryNeverDiscounted({ name: 'Value Deals', noDiscount: true })).toBe(true);
    expect(categoryNeverDiscounted({ name: 'Pizza', noDiscount: false })).toBe(false);
  });
});

describe('one deals rule', () => {
  it('the name test keeps no state between calls (no g flag): the same answer twice in a row', () => {
    expect(VALUE_DEALS_NAME_RE.flags).not.toContain('g');
    expect([VALUE_DEALS_NAME_RE.test('Value Deals'), VALUE_DEALS_NAME_RE.test('Value Deals')]).toEqual([true, true]);
  });

  it('the food-cost target suggestion reads the same name test: every deals name is 35%, a look-alike is not', () => {
    for (const name of ['Value Deals', 'Combos', 'Combo Deals', 'Deal of the Day']) expect({ name, bps: suggestedTargetBps(name) }).toEqual({ name, bps: 3500 });
    expect(suggestedTargetBps('Dealers')).toBe(3000);
  });
});
