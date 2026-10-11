import { describe, expect, it } from 'vitest';
import type { ChannelOffer, OfferRule } from '@cheeseoclock/shared-types';
import {
  assignOfferLines,
  isCategoryOffer,
  matchOffers,
  offerRule,
  offerTerms,
  parseOfferRule,
  type OfferLine,
  type OfferOrder,
} from './offers.js';
import { splitDiscountRows, taxAfterDiscountRows } from './discount-base.js';

/**
 * Offers on some categories (the owner, 11 Oct 2026: "category discounts …
 * like we have 10 percent offer on entire menu and separate 20 percent off
 * on regular pizzas so they don't conflict and add separately each").
 * Made-up offers, categories and prices.
 */

const SAVED = '2026-10-11T08:00:00.000Z';
// A Saturday at 20:00 Pakistan time.
const AT = '2026-10-10T15:00:00.000Z';
const offer = (o: Partial<ChannelOffer> & Pick<ChannelOffer, 'id' | 'name' | 'value'>): ChannelOffer => ({
  on: true,
  cameBy: 'any',
  orderTypes: ['takeaway', 'delivery'],
  type: 'percent',
  minOrderCents: null,
  maxOffCents: null,
  days: [0, 1, 2, 3, 4, 5, 6],
  hours: null,
  startsOn: null,
  endsOn: null,
  oncePerCustomerPerDay: false,
  ...o,
});
const MENU10 = offer({ id: 'menu10', name: 'Test 10% off', value: 10 });
const PIZZA20 = offer({ id: 'pizza20', name: 'Test 20% off pizzas', value: 20, categoryIds: ['cat-pizza'] });
const line = (id: string, categoryId: string | null, cents: number, extra: Partial<OfferLine> = {}): OfferLine => ({
  id,
  categoryId,
  lineTotalCents: cents,
  menuItemName: `Test ${id}`,
  ...extra,
});
// Two pizzas (Rs 1,500 + Rs 2,000), a burger (Rs 700), a value deal (Rs 3,000) and a delivery charge (Rs 200).
const LINES: OfferLine[] = [
  line('p1', 'cat-pizza', 150_000),
  line('p2', 'cat-pizza', 200_000),
  line('b1', 'cat-burger', 70_000),
  line('deal', 'cat-deals', 300_000, { noDiscount: true }),
  line('fee', 'cat-fees', 20_000, { menuItemName: 'Delivery Charge (Rs 200)' }),
];
const FOOD = 150_000 + 200_000 + 70_000;
const order = (over: Partial<OfferOrder> = {}): OfferOrder => ({
  source: 'pos',
  mode: 'delivery',
  cameBy: null,
  hasPhone: false,
  createdAt: AT,
  foodCents: FOOD,
  subtotalCents: FOOD + 20_000,
  ...over,
});
const opts = (over: Partial<Parameters<typeof matchOffers>[3]> = {}) => ({
  alsoOffDeliveryCharge: false,
  settingsAt: SAVED,
  current: [] as OfferRule[],
  declined: new Set<string>(),
  ...over,
});
const ruleOf = (o: ChannelOffer, alsoOff = false) => offerRule(offerTerms(o, SAVED), alsoOff);

describe('assignOfferLines: each offer over its own lines', () => {
  it('20% on the pizzas, 10% on the food they leave — never both on one line; the deal and the charge take neither', () => {
    const shares = assignOfferLines([ruleOf(MENU10), ruleOf(PIZZA20)], LINES, FOOD);
    expect(shares.map((x) => [x.rule.offer.id, x.lineIds, x.amountCents])).toEqual([
      ['pizza20', ['p1', 'p2'], 70_000],
      ['menu10', ['b1'], 7_000],
    ]);
  });

  it('a category offer under its minimum takes nothing, and leaves its lines to the whole-menu offer', () => {
    const shares = assignOfferLines([ruleOf(MENU10), ruleOf({ ...PIZZA20, minOrderCents: 1_000_000 })], LINES, FOOD);
    expect(shares.map((x) => [x.rule.offer.id, x.lineIds, x.amountCents])).toEqual([
      ['pizza20', [], 0],
      ['menu10', ['p1', 'p2', 'b1'], 42_000],
    ]);
  });

  it('two offers on one category: the one taking more off has it (then the id)', () => {
    const pizza15 = offer({ id: 'pizza15', name: 'Test 15% off', value: 15, categoryIds: ['cat-pizza', 'cat-burger'] });
    const shares = assignOfferLines([ruleOf(pizza15), ruleOf(PIZZA20)], LINES, FOOD);
    // 20% of the pizzas (Rs 700) beats 15% of pizzas + burger (Rs 630): the burger stays with the 15%.
    expect(shares.map((x) => [x.rule.offer.id, x.lineIds, x.amountCents])).toEqual([
      ['pizza20', ['p1', 'p2'], 70_000],
      ['pizza15', ['b1'], 10_500],
    ]);
  });

  it('the whole-menu offer takes the delivery charge too only when its rule says so; a category offer never does', () => {
    const shares = assignOfferLines([ruleOf(MENU10, true), ruleOf(PIZZA20, true)], LINES, FOOD);
    expect(shares.map((x) => [x.rule.offer.id, x.lineIds])).toEqual([
      ['pizza20', ['p1', 'p2']],
      ['menu10', ['b1', 'fee']],
    ]);
  });

  it('a most-off caps each offer on its own lines', () => {
    const shares = assignOfferLines([ruleOf({ ...PIZZA20, maxOffCents: 50_000 })], LINES, FOOD);
    expect(shares[0]!.amountCents).toBe(50_000);
  });
});

describe('matchOffers: which offers the order carries', () => {
  it('the owner’s example: 20% off the pizzas AND 10% off the rest, each its own offer', () => {
    const picks = matchOffers(order(), LINES, [MENU10, PIZZA20], opts());
    expect(picks.map((p) => [p.rule.offer.id, p.lineIds, p.amountCents, p.isCurrent])).toEqual([
      ['pizza20', ['p1', 'p2'], 70_000, false],
      ['menu10', ['b1'], 7_000, false],
    ]);
  });

  it('no pizza on the order: only the whole-menu offer', () => {
    const lines = LINES.filter((l) => l.categoryId !== 'cat-pizza');
    const picks = matchOffers(order({ foodCents: 70_000 }), lines, [MENU10, PIZZA20], opts());
    expect(picks.map((p) => [p.rule.offer.id, p.lineIds])).toEqual([['menu10', ['b1']]]);
  });

  it('only pizzas: the category offer alone (the whole-menu one finds nothing left)', () => {
    const lines = LINES.filter((l) => l.categoryId === 'cat-pizza');
    const picks = matchOffers(order({ foodCents: 350_000 }), lines, [MENU10, PIZZA20], opts());
    expect(picks.map((p) => p.rule.offer.id)).toEqual(['pizza20']);
  });

  it('the biggest whole-menu offer that fits, on what the category offers left', () => {
    const menu5 = offer({ id: 'menu5', name: 'Test 5% off', value: 5 });
    const flat = offer({ id: 'flat', name: 'Test Rs 100 off', type: 'flat', value: 10_000 });
    const picks = matchOffers(order(), LINES, [menu5, PIZZA20, flat], opts());
    // On the burger alone: 5% = Rs 35, Rs 100 flat = Rs 100.
    expect(picks.map((p) => [p.rule.offer.id, p.amountCents])).toEqual([
      ['pizza20', 70_000],
      ['flat', 10_000],
    ]);
  });

  it('an offer the cashier took off stays off; the others still go on (its pizzas take the 10%)', () => {
    const picks = matchOffers(order(), LINES, [MENU10, PIZZA20], opts({ declined: new Set(['pizza20']) }));
    expect(picks.map((p) => [p.rule.offer.id, p.lineIds])).toEqual([['menu10', ['p1', 'p2', 'b1']]]);
  });

  it('each offer keeps its own rules: one for takeaway only does not go on a delivery', () => {
    const picks = matchOffers(order(), LINES, [MENU10, { ...PIZZA20, orderTypes: ['takeaway'] }], opts());
    expect(picks.map((p) => p.rule.offer.id)).toEqual(['menu10']);
  });

  it('the offers already on keep their frozen terms; a Save since never moves the order — no new offer joins', () => {
    const frozen = ruleOf({ ...PIZZA20, value: 25 });
    const olderSave = { ...frozen, offer: { ...frozen.offer, settingsAt: '2026-10-01T00:00:00.000Z' } };
    const picks = matchOffers(order(), LINES, [MENU10, PIZZA20], opts({ current: [olderSave] }));
    expect(picks.map((p) => [p.rule.offer.id, p.amountCents, p.isCurrent])).toEqual([['pizza20', 87_500, true]]);
  });

  it('a website or foodpanda order never gets an offer', () => {
    expect(matchOffers(order({ source: 'web' }), LINES, [MENU10, PIZZA20], opts())).toEqual([]);
    expect(matchOffers(order({ mode: 'foodpanda' }), LINES, [MENU10, PIZZA20], opts())).toEqual([]);
  });
});

describe('the rule frozen on the row', () => {
  it('keeps the categories and the lines; an old rule reads as the whole menu', () => {
    const rule = { ...ruleOf(PIZZA20), lines: ['p1', 'p2'] };
    const back = parseOfferRule(JSON.stringify(rule));
    expect(back?.offer.categoryIds).toEqual(['cat-pizza']);
    expect(back?.lines).toEqual(['p1', 'p2']);
    expect(isCategoryOffer(back!.offer)).toBe(true);
    const old = parseOfferRule(JSON.stringify(ruleOf(MENU10)));
    expect(old?.offer.categoryIds).toBeUndefined();
    expect(old?.lines).toBeUndefined();
    expect(offerTerms(MENU10, SAVED)).not.toHaveProperty('categoryIds');
  });

  it('a list it can’t read makes the rule unreadable (left as it is), never the whole menu', () => {
    const bad = { ...ruleOf(PIZZA20), offer: { ...ruleOf(PIZZA20).offer, categoryIds: [] } };
    expect(parseOfferRule(JSON.stringify(bad))).toBeNull();
    expect(parseOfferRule(JSON.stringify({ ...ruleOf(MENU10), lines: 'p1' }))).toBeNull();
  });
});

describe('splitDiscountRows: each row over its own lines', () => {
  const lines = LINES.map((l) => ({ ...l, taxRateBps: 1_500 }));
  const rows = [
    { amountCents: 70_000, ruleJson: JSON.stringify({ ...ruleOf(PIZZA20), lines: ['p1', 'p2'] }) },
    { amountCents: 7_000, ruleJson: JSON.stringify({ ...ruleOf(MENU10), lines: ['b1'] }) },
  ];

  it('the pizzas carry the 20%, the burger the 10%; the deal and the charge nothing', () => {
    expect(splitDiscountRows(lines, rows)).toEqual([30_000, 40_000, 7_000, 0, 0]);
  });

  it('the tax: each line on what is left of it', () => {
    const t = taxAfterDiscountRows(lines, rows);
    // 15% of (1,200 + 1,600 + 630 + 3,000 + 200) = 15% of 6,630 = Rs 994.50.
    expect(t.taxCents).toBe(99_450);
  });

  it('one row naming no lines splits exactly as before', () => {
    const one = [{ amountCents: 42_000, ruleJson: JSON.stringify(ruleOf(MENU10)) }];
    expect(splitDiscountRows(lines, one)).toEqual([15_000, 20_000, 7_000, 0, 0]);
  });
});
