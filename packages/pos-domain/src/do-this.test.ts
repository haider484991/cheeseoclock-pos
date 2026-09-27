import { describe, expect, it } from 'vitest';
import {
  DO_THIS_CAP,
  DO_THIS_MAX_PINNED,
  collectDoThis,
  missingCostsWeekCents,
  rankDoThis,
  redItemWeekCents,
  type DoThisCandidate,
  type DoThisSource,
} from './do-this.js';

const line = (key: string, weekCents: number | null, extra: Partial<DoThisCandidate> = {}): DoThisCandidate => ({
  kind: extra.kind ?? 'red_item',
  key,
  weekCents,
  pinned: false,
  cost: true,
  ...extra,
});

describe('"Do this": the ranking (costing spec 4.17)', () => {
  it('most rupees a week first; a line with no rupee figure after every line with one; ties by key', () => {
    const r = rankDoThis([line('b', 20_000), line('a', 150_000), line('c', null, { cost: false, kind: 'low_stock' }), line('d', 20_000)], { canSeeCosts: true });
    expect(r.items.map((i) => i.key)).toEqual(['a', 'b', 'd', 'c']);
    expect(r.more).toBe(0);
  });

  it('a key ingredient running low is pinned first, whatever the rupees', () => {
    const r = rankDoThis(
      [line('dear', 900_000), line('cheese-low', null, { pinned: true, cost: false, kind: 'low_stock' }), line('cheap', 1_000)],
      { canSeeCosts: true },
    );
    expect(r.items.map((i) => i.key)).toEqual(['cheese-low', 'dear', 'cheap']);
  });

  it('pins take at most two places, so money lines still show on a till that never counted its stock', () => {
    const lows = ['a-low', 'b-low', 'c-low', 'd-low', 'e-low'].map((k) => line(k, null, { pinned: true, cost: false, kind: 'low_stock' }));
    const r = rankDoThis([...lows, line('red', 50_000), line('missing', 20_000, { kind: 'missing_costs' })], { canSeeCosts: true });
    expect(DO_THIS_MAX_PINNED).toBe(2);
    expect(r.items.map((i) => i.key)).toEqual(['a-low', 'b-low', 'red', 'missing', 'c-low']);
    expect(r.more).toBe(2);
  });

  it('at most five lines, and says how many more there were', () => {
    const many = Array.from({ length: 8 }, (_, i) => line(`k${i}`, (i + 1) * 1_000));
    const r = rankDoThis(many, { canSeeCosts: true });
    expect(DO_THIS_CAP).toBe(5);
    expect(r.items.map((i) => i.key)).toEqual(['k7', 'k6', 'k5', 'k4', 'k3']);
    expect(r.more).toBe(3);
  });

  it('cost lines are absent for a login without costs', () => {
    const r = rankDoThis([line('red', 50_000), line('low', null, { pinned: true, cost: false, kind: 'low_stock' })], { canSeeCosts: false });
    expect(r.items.map((i) => i.key)).toEqual(['low']);
    expect(r.more).toBe(0);
  });
});

describe('"Do this": the sources', () => {
  interface Ctx {
    calls: string[];
  }
  const source = (kind: string, cost: boolean, lines: DoThisCandidate[] | Error): DoThisSource<Ctx> => ({
    kind,
    cost,
    collect: (ctx) => {
      ctx.calls.push(kind);
      if (lines instanceof Error) throw lines;
      return lines;
    },
  });

  it("a cost source never runs for a login without costs; later phases' sources rank with the rest", () => {
    const ctx: Ctx = { calls: [] };
    const sources = [
      source('low_stock', false, [line('low', null, { pinned: true, cost: false, kind: 'low_stock' })]),
      source('red_item', true, [line('red', 40_000)]),
      // A later phase's source (Phase 8's stock variance), registered the same way.
      source('variance', true, [line('var', 90_000, { kind: 'variance' })]),
    ];
    const owner = collectDoThis(sources, ctx, { canSeeCosts: true });
    expect(owner.items.map((i) => i.key)).toEqual(['low', 'var', 'red']);
    expect(ctx.calls).toEqual(['low_stock', 'red_item', 'variance']);

    const noCosts: Ctx = { calls: [] };
    const r = collectDoThis(sources, noCosts, { canSeeCosts: false });
    expect(r.items.map((i) => i.key)).toEqual(['low']);
    expect(noCosts.calls).toEqual(['low_stock']);
  });

  it('a source that fails is left out and named; the rest still show', () => {
    const r = collectDoThis(
      [source('price_alert', true, new Error('bad row')), source('red_item', true, [line('red', 40_000)])],
      { calls: [] },
      { canSeeCosts: true },
    );
    expect(r.items.map((i) => i.key)).toEqual(['red']);
    expect(r.failed).toEqual(['price_alert']);
  });
});

describe('"Do this": rupees per week', () => {
  it('a dish over target: a week of sales × (cost − target × price)', () => {
    // 40 sold in 28 days (10 a week); costs Rs 400 on a Rs 1,000 price; target 30% → Rs 100 over each: Rs 1,000 a week.
    expect(redItemWeekCents(40, 40_000_000, 100_000_000, 3_000)).toBe(100_000);
    // At or under target: nothing.
    expect(redItemWeekCents(40, 30_000_000, 100_000_000, 3_000)).toBe(0);
    expect(redItemWeekCents(40, 25_000_000, 100_000_000, 3_000)).toBe(0);
    // Not sold: nothing.
    expect(redItemWeekCents(0, 40_000_000, 100_000_000, 3_000)).toBe(0);
    // Rounded once, half up: 1 sold × 2 paisa over ÷ 4 = 0.5 → 1 paisa.
    expect(redItemWeekCents(1, 30_002_000, 100_000_000, 3_000)).toBe(1);
  });

  it("missing costs: the week's sales they touch × each category's target", () => {
    // Rs 4,000 of a 30% dish and Rs 2,000 of a 35% dish over 28 days: (1,200 + 700) ÷ 4 = Rs 475 a week.
    expect(
      missingCostsWeekCents([
        { salesLast28Cents: 400_000, targetBps: 3_000 },
        { salesLast28Cents: 200_000, targetBps: 3_500 },
      ]),
    ).toBe(47_500);
    expect(missingCostsWeekCents([{ salesLast28Cents: 0, targetBps: 3_000 }])).toBe(0);
    expect(missingCostsWeekCents([])).toBe(0);
  });
});
