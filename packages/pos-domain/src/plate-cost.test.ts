import { describe, expect, it } from 'vitest';
import type { PriceKind } from '@cheeseoclock/shared-types';
import {
  MIX_MIN_UNITS,
  foodCostFlag,
  pickMix,
  plateCost,
  priceToHitTarget,
  requiredPicks,
  type PlateGroup,
  type PlateItemInput,
  type PriceOf,
} from './plate-cost.js';
import type { RecipeLine } from './recipe-expand.js';

// A made-up menu. Prices in paisa per gram (per piece for box and cup),
// kept whole so every golden figure below can be checked by hand.
const PER_UNIT: Record<string, number> = {
  dough: 1,
  cheese: 2,
  chicken: 3,
  onion: 1,
  pepper: 2,
  olive: 4,
  mushroom: 3,
  corn: 1,
  jalapeno: 5,
  tomato: 2,
  box: 50,
  ranch: 2,
  cup: 10,
  cola: 40,
  juice: 90,
};
const priceOf =
  (overrides: Record<string, PriceKind> = {}): PriceOf =>
  (id) => {
    const p = PER_UNIT[id];
    if (p === undefined) return undefined;
    // As a pack of 1,000 (Rs X per kg) so the exact-pack path is the one tested.
    return { pack: { size: 1000, priceCents: p * 1000 }, kind: overrides[id] ?? 'set' };
  };
const line = (ingredientId: string, qtyPerUnit: number, modifierId: string | null = null): RecipeLine => ({
  ingredientId,
  qtyPerUnit,
  modifierId,
});
const opt = (id: string, priceDeltaCents = 0, removesIngredientId: string | null = null) => ({
  id,
  name: id,
  priceDeltaCents,
  removesIngredientId,
});
const group = (id: string, options: ReturnType<typeof opt>[], rules: Partial<PlateGroup> = {}): PlateGroup => ({
  id,
  name: id,
  selectionType: 'multi',
  minSelect: 0,
  maxSelect: 0,
  isRequired: false,
  options,
  ...rules,
});

const FAJITA_LARGE: Array<[string, number]> = [['dough', 300], ['cheese', 90], ['chicken', 60], ['onion', 15], ['box', 1]]; // 725
const VEGGIE_LARGE: Array<[string, number]> = [['dough', 300], ['cheese', 90], ['pepper', 15], ['mushroom', 15], ['box', 1]]; // 605

describe('a sized pizza: each size is its own item', () => {
  const medium: PlateItemInput = {
    basePriceCents: 2000,
    recipe: [line('dough', 200), line('cheese', 60), line('chicken', 40), line('onion', 10), line('box', 1)],
    groups: [],
  };
  const large: PlateItemInput = { basePriceCents: 2900, recipe: FAJITA_LARGE.map(([i, q]) => line(i, q)), groups: [] };

  it('costs the plate from the exact pack, and keeps price − cost', () => {
    const m = plateCost(medium, priceOf());
    expect(m).toMatchObject({ typicalCostCents: 500, typicalPriceCents: 2000, profitCents: 1500, foodCostBps: 2500 });
    expect(m.base.lines.map((l) => l.costMc)).toEqual([200_000, 120_000, 120_000, 10_000, 50_000]);
    const l = plateCost(large, priceOf());
    expect(l).toMatchObject({ typicalCostCents: 725, foodCostBps: 2500, minCostCents: 725, maxCostCents: 725 });
  });
});

const VEGGIES = ['onion', 'pepper', 'olive', 'mushroom', 'corn', 'jalapeno', 'tomato'];
function veggieLovers(mix: PlateItemInput['mix'] = null, rules: Partial<PlateGroup> = {}): PlateItemInput {
  return {
    basePriceCents: 2600,
    recipe: [
      line('dough', 300),
      line('cheese', 90),
      line('box', 1),
      ...VEGGIES.map((v) => line(v, 10, `pick-${v}`)),
      line('cheese', 40, 'extraCheese'),
    ],
    groups: [
      group('Choose 5 veggies', VEGGIES.map((v) => opt(`pick-${v}`)), { minSelect: 1, maxSelect: 5, isRequired: true, ...rules }),
      group('Extra toppings', [opt('extraCheese', 150)]),
    ],
    mix,
  };
}
// 10 g of each veggie: onion 10, pepper 20, olive 40, mushroom 30, corn 10, jalapeno 50, tomato 20 = 180 paisa for all seven.

describe('customer picks: Veggie Lovers "Choose 5 veggies"', () => {
  it('with no sales history: the most picks (5) × the average option — as the costing sheet does', () => {
    const pc = plateCost(veggieLovers(), priceOf());
    const g = pc.groups[0]!;
    expect(g).toMatchObject({ kMin: 1, kMax: 5, basis: 'usual' });
    // 5 × 180 ÷ 7 = 128.571… paisa = 128,571 mc
    expect(g.typicalCostMc).toBe(128_571);
    expect(pc.typicalCostMc).toBe(530_000 + 128_571);
    expect(pc.typicalCostCents).toBe(659);
    expect(g.options.every((o) => o.pickedShareBps === null)).toBe(true);
  });

  it('Min uses k_min (the cheapest pick), Max uses k_max (the five dearest)', () => {
    const pc = plateCost(veggieLovers(), priceOf());
    expect(pc.minCostCents).toBe(530 + 10);
    expect(pc.maxCostCents).toBe(530 + 50 + 40 + 30 + 20 + 20);
    const two = plateCost(veggieLovers(null, { minSelect: 2 }), priceOf());
    expect(two.minCostCents).toBe(530 + 10 + 10);
  });

  it('five veggies picked on a quantity-2 line count twice each (weights × quantity)', () => {
    const mix = pickMix([
      { quantity: 2, modifierIds: ['pick-onion', 'pick-pepper', 'pick-olive', 'pick-mushroom', 'pick-corn'] },
      { quantity: 8, modifierIds: ['pick-jalapeno', 'pick-tomato', 'pick-jalapeno'] },
    ]);
    expect(mix.units).toBe(10);
    expect(mix.picks.get('pick-onion')).toBe(2);
    expect(mix.picks.get('pick-jalapeno')).toBe(8); // once per line, however often it was picked
    const pc = plateCost(veggieLovers(mix), priceOf());
    const g = pc.groups[0]!;
    expect(g.basis).toBe('observed');
    // (2×10 + 2×20 + 2×40 + 2×30 + 2×10 + 8×50 + 8×20) ÷ 10 = 78 paisa
    expect(g.typicalCostMc).toBe(78_000);
    expect(pc.typicalCostCents).toBe(530 + 78);
    expect(g.options.find((o) => o.option.id === 'pick-jalapeno')!.pickedShareBps).toBe(8000);
  });

  it('fewer than 10 sold: the history is not trusted yet', () => {
    const mix = pickMix([{ quantity: MIX_MIN_UNITS - 1, modifierIds: ['pick-onion'] }]);
    expect(plateCost(veggieLovers(mix), priceOf()).groups[0]!.basis).toBe('usual');
  });

  it('fewer picks than the group\'s minimum (orders from before it was raised): the usual fallback, not a cheap plate', () => {
    const mix = pickMix([{ quantity: 20, modifierIds: ['pick-onion'] }]); // one veggie each, but now at least 2
    const g = plateCost(veggieLovers(mix, { minSelect: 2 }), priceOf()).groups[0]!;
    expect(g.basis).toBe('usual');
    expect(g.typicalCostMc).toBe(128_571);
  });
});

describe('a required group attached after the item had been selling', () => {
  // Fries sold 200 times with no dip; "Choose your dip" is now required.
  const DIPS = ['dip-ranch', 'dip-chili'];
  const fries = (mix: PlateItemInput['mix']): PlateItemInput => ({
    basePriceCents: 500,
    recipe: [line('dough', 100), line('ranch', 25, 'dip-ranch'), line('cup', 1, 'dip-ranch'), line('tomato', 25, 'dip-chili'), line('cup', 1, 'dip-chili')],
    groups: [group('Choose your dip', DIPS.map((d) => opt(d)), { selectionType: 'single', minSelect: 1, maxSelect: 1, isRequired: true })],
    mix,
  });
  const groupOf = (id: string) => (DIPS.includes(id) ? 'Choose your dip' : undefined);

  it('no dip picked yet: the usual fallback, never "the dip adds Rs 0"', () => {
    const mix = pickMix([{ quantity: 200, modifierIds: [] }], groupOf);
    expect(mix.groupUnits?.get('Choose your dip') ?? 0).toBe(0);
    const g = plateCost(fries(mix), priceOf()).groups[0]!;
    // ranch dip 25 × 2 + cup 10 = 60, chili 25 × 2 + 10 = 60: the average dip is 60 paisa
    expect(g).toMatchObject({ basis: 'usual', typicalCostMc: 60_000 });
    expect(g.options.every((o) => o.pickedShareBps === null)).toBe(true);
    // …and the same without the per-group counts: no picks at all is not a mix to trust
    expect(plateCost(fries(pickMix([{ quantity: 200, modifierIds: [] }])), priceOf()).groups[0]!.basis).toBe('usual');
  });

  it('weighted over the units that did pick a dip, not over every unit sold', () => {
    const mix = pickMix(
      [
        { quantity: 200, modifierIds: [] }, // before the dip was asked
        { quantity: 9, modifierIds: ['dip-ranch'] },
        { quantity: 3, modifierIds: ['dip-chili'] },
      ],
      groupOf,
    );
    expect(mix.groupUnits?.get('Choose your dip')).toBe(12);
    const g = plateCost(fries(mix), priceOf()).groups[0]!;
    expect(g.basis).toBe('observed');
    expect(g.typicalCostMc).toBe(60_000); // both dips cost 60: the weights sum to one dip, not 12/212 of one
    expect(g.options.map((o) => o.pickedShareBps)).toEqual([7500, 2500]);
  });

  it('a paid extra is costed on its own: price, cost, margin, food cost', () => {
    const pc = plateCost(veggieLovers(), priceOf());
    expect(pc.paidExtras).toHaveLength(1);
    expect(pc.paidExtras[0]).toMatchObject({ groupName: 'Extra toppings', marginCents: 70, foodCostBps: 5333 });
    expect(pc.paidExtras[0]!.cost.costCents).toBe(80);
    // …and is not in the typical plate
    expect(pc.typicalCostCents).toBe(659);
  });

  it('an unpriced veggie makes the item "can\'t cost yet"', () => {
    const pc = plateCost(veggieLovers(), priceOf({ olive: 'unset' }));
    expect(pc.missingLines).toBe(1);
    expect(foodCostFlag({ hasRecipe: true, missingLines: pc.missingLines, costMc: pc.typicalCostMc, priceMc: pc.typicalPriceMc }, T)).toBe('grey');
  });
});

describe('a deal with pizza slots', () => {
  const deal: PlateItemInput = {
    basePriceCents: 6000,
    recipe: [
      ...FAJITA_LARGE.map(([i, q]) => line(i, q, 'slot1-fajita')),
      ...VEGGIE_LARGE.map(([i, q]) => line(i, q, 'slot1-veggie')),
      ...FAJITA_LARGE.map(([i, q]) => line(i, q, 'slot2-fajita')),
      ...VEGGIE_LARGE.map(([i, q]) => line(i, q, 'slot2-veggie')),
    ],
    groups: [
      group('Deal: pizza', [opt('slot1-fajita'), opt('slot1-veggie')], { selectionType: 'single', minSelect: 1, maxSelect: 1, isRequired: true }),
      group('Deal: 2nd pizza', [opt('slot2-fajita'), opt('slot2-veggie')], { selectionType: 'single', minSelect: 1, maxSelect: 1, isRequired: true }),
      group('Leave out · Deal', [opt('no-onion', 0, 'onion')]),
    ],
  };

  it('costs each slot as the average pizza with no history, the range from the cheapest to the dearest', () => {
    const pc = plateCost(deal, priceOf());
    expect(pc.base.lines).toEqual([]);
    expect(pc.groups.map((g) => g.typicalCostMc)).toEqual([665_000, 665_000]);
    expect(pc).toMatchObject({ typicalCostCents: 1330, minCostCents: 1210, maxCostCents: 1450, foodCostBps: 2217 });
  });

  it('a leave-out on a deal saves what it takes off the free pizza picks (not Rs 0)', () => {
    const pc = plateCost(deal, priceOf());
    // the Fajita slot loses 15 g onion: each slot's average drops 7.5 paisa, two slots = 15
    expect(pc.leaveOuts).toEqual([
      expect.objectContaining({ ingredientId: 'onion', savingMc: 15_000, savingCents: 15, missingLines: 0 }),
    ]);
  });

  it('one unpriced ingredient in every pizza of both slots is ONE ingredient to price, not four', () => {
    const pc = plateCost(deal, priceOf({ cheese: 'unset' }));
    expect(pc.missingLines).toBe(4);
    expect(pc.missingIngredientIds).toEqual(['cheese']);
    expect(plateCost(deal, priceOf()).missingIngredientIds).toEqual([]);
  });

  it('leaving out an unpriced ingredient: the saving is not known (it counted as Rs 0)', () => {
    const pc = plateCost(deal, priceOf({ onion: 'unset' }));
    expect(pc.leaveOuts).toEqual([expect.objectContaining({ ingredientId: 'onion', savingCents: 0, missingLines: 2 })]);
    // an unpriced ingredient elsewhere does not make the onion's saving uncertain
    expect(plateCost(deal, priceOf({ cheese: 'unset' })).leaveOuts).toEqual([
      expect.objectContaining({ savingCents: 15, missingLines: 0 }),
    ]);
  });
});

describe('a required paid pick', () => {
  it('adds its usual price to the typical price (observed mix)', () => {
    const item: PlateItemInput = {
      basePriceCents: 1000,
      recipe: [line('dough', 100), line('cola', 1, 'cola'), line('juice', 1, 'juice')],
      groups: [group('Choose your drink', [opt('cola'), opt('juice', 200)], { selectionType: 'single', isRequired: true, maxSelect: 1 })],
      mix: pickMix([{ quantity: 6, modifierIds: ['cola'] }, { quantity: 4, modifierIds: ['juice'] }]),
    };
    const pc = plateCost(item, priceOf());
    // cost 100 + (6×40 + 4×90) ÷ 10 = 160; price 1000 + 4×200 ÷ 10 = 1080
    expect(pc).toMatchObject({ typicalCostCents: 160, typicalPriceCents: 1080, profitCents: 920, groupsPriceMc: 80_000 });
  });

  it('requiredPicks: single = 1, multi up to max (or every option when max is 0), optional = null', () => {
    expect(requiredPicks({ selectionType: 'single', minSelect: 0, maxSelect: 1, isRequired: true }, 4)).toEqual({ kMin: 1, kMax: 1 });
    expect(requiredPicks({ selectionType: 'multi', minSelect: 1, maxSelect: 5, isRequired: false }, 7)).toEqual({ kMin: 1, kMax: 5 });
    expect(requiredPicks({ selectionType: 'multi', minSelect: 2, maxSelect: 0, isRequired: true }, 3)).toEqual({ kMin: 2, kMax: 3 });
    expect(requiredPicks({ selectionType: 'multi', minSelect: 0, maxSelect: 2, isRequired: false }, 3)).toBeNull();
  });
});

const T = { bps: 3000, amberBps: 500, confirmed: true, nonFood: false };

describe('the food-cost chip', () => {
  // A Rs 100 plate: 1 bps of food cost is 1,000 mc of cost.
  const at = (costMc: number, t = T) => foodCostFlag({ hasRecipe: true, missingLines: 0, costMc, priceMc: 10_000_000 }, t);

  it('green at the target, amber up to target + close, red one bps past it', () => {
    expect(at(2_999_000)).toBe('green');
    expect(at(3_000_000)).toBe('green'); // exactly T
    expect(at(3_000_001)).toBe('amber');
    expect(at(3_500_000)).toBe('amber'); // exactly T + A
    expect(at(3_501_000)).toBe('red'); // T + A + 1 bps
  });

  it('neutral while the target is only a suggestion; grey with no recipe or a missing price; nothing for non-food', () => {
    expect(at(9_000_000, { ...T, confirmed: false })).toBe('neutral');
    expect(foodCostFlag({ hasRecipe: false, missingLines: 0, costMc: 0, priceMc: 10_000 }, T)).toBe('grey');
    expect(foodCostFlag({ hasRecipe: true, missingLines: 2, costMc: 100, priceMc: 10_000 }, T)).toBe('grey');
    expect(foodCostFlag({ hasRecipe: true, missingLines: 0, costMc: 100, priceMc: 0 }, T)).toBe('grey');
    expect(at(9_000_000, { ...T, nonFood: true })).toBe('nonfood');
  });
});

describe('price to hit the target', () => {
  it('rounds up to the price step: Rs 609.42 at 30% → Rs 2,031.40 → Rs 2,040', () => {
    expect(priceToHitTarget(60_942_000, 3000, 0, 1000)).toBe(204_000);
  });
  it('takes off what the required paid picks already bring', () => {
    expect(priceToHitTarget(60_942_000, 3000, 10_000_000, 1000)).toBe(194_000);
  });
  it('an exact hit is not pushed up a step, and a zero target gives nothing', () => {
    expect(priceToHitTarget(30_000_000, 3000, 0, 1000)).toBe(100_000);
    expect(priceToHitTarget(30_000_000, 0, 0, 1000)).toBeNull();
  });
});
