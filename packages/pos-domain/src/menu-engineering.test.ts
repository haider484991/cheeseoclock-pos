import { describe, expect, it } from 'vitest';
import {
  MENU_MAP_MIN_UNITS,
  breakEvenVolumeBps,
  breakEvenVolumeFromShares,
  menuMap,
  menuMapClass,
  raiseToAverageCents,
  type MenuMapDishInput,
} from './menu-engineering.js';

/** A dish with every unit fully costed, at `price` and `cost` paisa each. */
const dish = (id: string, units: number, price: number, cost: number): MenuMapDishInput => ({
  id,
  name: `Dish ${id}`,
  units,
  knownUnits: units,
  knownMenuSalesCents: units * price,
  knownCostCents: units * cost,
});

/**
 * A made-up category in the AHLEI worksheet's shape (costing spec 4.8): eight
 * dishes, 1,000 sold, Σ(units × what one sells for less what it costs) =
 * Rs 3,444.80 — so the profit line is 3,444.80 ÷ 1,000 = Rs 3.44 a sale, and
 * the popularity line 70% × 1/8 = 8.75% (87.5 of the 1,000).
 */
const AHLEI = [
  dish('A', 210, 795, 400), // earns 3.95
  dish('B', 60, 495, 285), // 2.10
  dish('C', 90, 695, 335), // 3.60
  dish('D', 150, 595, 295), // 3.00
  dish('E', 50, 895, 470), // 4.25
  dish('F', 120, 545, 225), // 3.20
  dish('G', 180, 450, 180), // 2.70
  dish('H', 140, 752, 300), // 4.52
];

describe('the menu map (costing spec 4.8)', () => {
  const m = menuMap(AHLEI, 100);
  const cls = (id: string) => m.dishes.find((d) => d.id === id)?.class;

  it('reproduces the AHLEI example: the weighted profit line 3,444.80 ÷ 1,000 = 3.44', () => {
    expect(AHLEI.reduce((s, d) => s + d.units, 0)).toBe(1_000);
    expect(AHLEI.reduce((s, d) => s + (d.knownMenuSalesCents - d.knownCostCents), 0)).toBe(344_480);
    expect(m.state).toBe('ok');
    expect(m.averageProfitMc).toBe(344_480);
    expect(m.averageProfitCents).toBe(344);
    // Not the plain average of the eight dishes (3.415): weighted by what sells.
    const plain = AHLEI.reduce((s, d) => s + (d.knownMenuSalesCents - d.knownCostCents) / d.units, 0) / AHLEI.length;
    expect(plain).toBe(341.5);
  });

  it('the 70% rule: popular at 70% of an equal share — 87.5 of 1,000 with eight dishes', () => {
    expect(m.popularLineBps).toBe(875);
    // C sold 90: just over the line; B (60) and E (50) under it.
    expect(m.dishes.filter((d) => d.popular).map((d) => d.id).sort()).toEqual(['A', 'C', 'D', 'F', 'G', 'H']);
  });

  it('places each dish in plain words', () => {
    expect([cls('A'), cls('C'), cls('H')]).toEqual(['star', 'star', 'star']);
    expect([cls('D'), cls('F'), cls('G')]).toEqual(['plowhorse', 'plowhorse', 'plowhorse']);
    expect(cls('E')).toBe('puzzle');
    expect(cls('B')).toBe('dog');
    expect(menuMapClass(true, true)).toBe('star');
    expect(menuMapClass(false, false)).toBe('dog');
  });

  it('says how far under the average a popular, low-profit dish earns, and the price rise that brings it there', () => {
    const d = m.dishes.find((x) => x.id === 'D')!;
    expect(d.profitPerSaleCents).toBe(300);
    expect(d.belowAverageCents).toBe(44); // 3.4448 − 3.00
    expect(d.raiseToAverageCents).toBe(100); // up to the next Rs 1 step
    expect(m.dishes.find((x) => x.id === 'A')!.raiseToAverageCents).toBeNull();
    // "Rs 60 more on the price brings it to your average": Rs 55 short, Rs 10 steps.
    expect(raiseToAverageCents(50_500_000, 45_000_000, 1_000)).toBe(6_000);
    expect(raiseToAverageCents(45_000_000, 45_000_000, 1_000)).toBe(0);
  });

  it('shares of the category add up, and the most sold comes first', () => {
    expect(m.dishes[0]!.id).toBe('A');
    expect(m.dishes.find((x) => x.id === 'A')!.mixBps).toBe(2_100);
  });

  it('fewer than 200 sold: "not enough sales yet"', () => {
    const few = menuMap([dish('A', 80, 795, 400), dish('B', 60, 495, 285), dish('C', 59, 695, 335)], 1_000);
    expect(few.units).toBe(MENU_MAP_MIN_UNITS - 1);
    expect(few.state).toBe('few_sales');
    expect(few.dishes).toEqual([]);
    expect(menuMap([dish('A', 80, 795, 400), dish('B', 60, 495, 285), dish('C', 60, 695, 335)], 1_000).state).toBe('ok');
  });

  it('a dish with under 90% of its units fully costed can’t be placed yet; under three placed, the category waits', () => {
    const r = menuMap(
      [
        dish('A', 300, 795, 400),
        dish('B', 100, 495, 285),
        { ...dish('C', 100, 695, 335), knownUnits: 89, knownMenuSalesCents: 89 * 695, knownCostCents: 89 * 335 },
        dish('D', 0, 595, 295),
      ],
      1_000,
    );
    expect(r.cantPlace).toEqual([{ id: 'C', name: 'Dish C', units: 100, costedShareBps: 8_900 }]);
    expect(r.notSold).toEqual([{ id: 'D', name: 'Dish D' }]);
    expect(r.state).toBe('few_dishes');
    // At exactly 90% it is placed.
    const ok = menuMap(
      [dish('A', 300, 795, 400), dish('B', 100, 495, 285), { ...dish('C', 100, 695, 335), knownUnits: 90, knownMenuSalesCents: 90 * 695, knownCostCents: 90 * 335 }],
      1_000,
    );
    expect(ok.state).toBe('ok');
    expect(ok.cantPlace).toEqual([]);
    expect(ok.dishes.find((d) => d.id === 'C')!.profitPerSaleCents).toBe(360);
  });

  it('a dish on the menu that did not sell still counts in N: four dishes, the popular line is 17.5%', () => {
    // A 120, B 45, C 35 sold; D is on the menu and sold none. 200 units, N = 4.
    const r = menuMap([dish('A', 120, 795, 400), dish('B', 45, 495, 285), dish('C', 35, 695, 335), dish('D', 0, 595, 295)], 1_000);
    expect(r.state).toBe('ok');
    expect(r.notSold).toEqual([{ id: 'D', name: 'Dish D' }]);
    expect(r.popularLineBps).toBe(1_750);
    const d = (id: string) => r.dishes.find((x) => x.id === id)!;
    // B sold 22.5% of the category: popular (low profit, so "Rs Y more on the price"), not "rework or drop it".
    expect(d('B')).toMatchObject({ mixBps: 2_250, popular: true, class: 'plowhorse' });
    expect(d('B').raiseToAverageCents).toBeGreaterThan(0);
    // C is exactly on the line (35 × 4 × 100 = 70 × 200): popular.
    expect(d('C')).toMatchObject({ mixBps: 1_750, popular: true });
  });

  it('a best-seller that can’t be placed yet stays in the mix: the others’ shares are of every unit sold', () => {
    // A sold 300 but its cost is not known yet (an unpriced dip); B, C, D sold 100 each. N = 4, Σn = 600.
    const r = menuMap(
      [{ ...dish('A', 300, 795, 400), knownUnits: 0, knownMenuSalesCents: 0, knownCostCents: 0 }, dish('B', 100, 495, 285), dish('C', 100, 695, 335), dish('D', 100, 595, 295)],
      1_000,
    );
    expect(r.state).toBe('ok');
    expect(r.cantPlace.map((x) => x.id)).toEqual(['A']);
    expect(r.popularLineBps).toBe(1_750);
    // Each is 1/6 of what the category sold (16.7%): under the line, not a third of the placed dishes' units.
    for (const id of ['B', 'C', 'D']) expect(r.dishes.find((x) => x.id === id)).toMatchObject({ mixBps: 1_667, popular: false });
    // The profit line is still the placed dishes' weighted average: (210 + 360 + 300) ÷ 3 = 2.90.
    expect(r.averageProfitCents).toBe(290);
  });

  it('fewer than three dishes in the category, or fewer than three placed: the category waits', () => {
    expect(menuMap([dish('A', 150, 795, 400), dish('B', 100, 495, 285)], 1_000).state).toBe('few_dishes');
    // Three on the menu, two of them placed.
    expect(menuMap([dish('A', 150, 795, 400), dish('B', 100, 495, 285), dish('C', 0, 695, 335)], 1_000).state).toBe('few_dishes');
  });
});

describe('break-even volume for a price change (costing spec 4.8)', () => {
  it('+20% at a 60% margin: sales can fall 25%; −20%: they must rise 50%', () => {
    expect(breakEvenVolumeFromShares(2_000, 6_000)).toBe(-2_500);
    expect(breakEvenVolumeFromShares(-2_000, 6_000)).toBe(5_000);
    // The same in rupees: a Rs 100 dish earning Rs 60, priced Rs 20 up or down.
    expect(breakEvenVolumeBps(2_000, 6_000)).toBe(-2_500);
    expect(breakEvenVolumeBps(-2_000, 6_000)).toBe(5_000);
  });

  it('no volume makes up for a price that earns nothing; no change is 0', () => {
    expect(breakEvenVolumeBps(-6_000, 6_000)).toBeNull();
    expect(breakEvenVolumeBps(-7_000, 6_000)).toBeNull();
    expect(breakEvenVolumeBps(0, 6_000)).toBe(0);
  });
});
