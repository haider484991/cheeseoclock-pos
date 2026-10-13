/**
 * WEBSITE DISCOUNT BY CATEGORY (v0.7.50): the website works an order's
 * parts with shared-types websiteDiscountParts; the till bills them as the
 * owner's offers' rows (websitePartRule) worked by its offers engine
 * (assignOfferLines, then the tax per line over each row's own lines). The
 * two must give the same amounts, the same lines and the same tax, to the
 * paisa — or the till would bill another total than the customer saw. Every
 * price is made up.
 */
import { describe, expect, it } from 'vitest';
import {
  discountPartsToSend,
  readDiscountParts,
  websiteDiscountParts,
  type DiscountPartLine,
  type WebDiscountPart,
  type WebsiteCategoryPercent,
} from '@cheeseoclock/shared-types';
import { allocateDiscount } from './discount.js';
import { taxAfterDiscountRows } from './discount-base.js';
import { assignOfferLines } from './offers.js';
import { computeTax } from './tax.js';
import { websitePartName, websitePartRule } from './website-offers.js';

const PIZZA = 'cat-pizza';
const SIGNATURE = 'cat-signature';
const BURGERS = 'cat-burgers';
const DEALS = 'cat-deals';
const DRINKS = 'cat-drinks';

interface Line extends DiscountPartLine {
  id: string;
  taxRateBps: number;
  menuItemName: string;
}
const line = (id: string, cents: number, categoryId: string | null, extra: Partial<Line> = {}): Line => ({
  id,
  lineTotalCents: cents,
  categoryId,
  taxRateBps: 1500,
  menuItemName: id,
  ...extra,
});

/** The website's bill: each part over its lines (allocateDiscount), each line taxed on what is left. */
function websiteBill(lines: readonly Line[], mainPercent: number, cats: readonly WebsiteCategoryPercent[]) {
  const plans = websiteDiscountParts(lines, mainPercent, cats);
  const shares = lines.map(() => 0);
  for (const p of plans) {
    if (p.amountCents <= 0) continue;
    const weights = lines.map((l, i) => (p.lineIndexes.includes(i) ? l.lineTotalCents : 0));
    allocateDiscount(weights, p.amountCents).forEach((x, i) => (shares[i] = shares[i]! + x));
  }
  const tax = lines.reduce(
    (t, l, i) => t + (computeTax(Math.max(0, l.lineTotalCents - shares[i]!), l.taxRateBps, 'exclusive').taxCents as number),
    0,
  );
  const discount = plans.reduce((s, p) => s + p.amountCents, 0);
  return { plans, discount, tax, parts: discountPartsToSend(plans) };
}

/** The till's bill for the parts the order carries: their offer rows, worked by the offers engine. */
function tillBill(lines: readonly Line[], parts: readonly WebDiscountPart[], pickup = true) {
  const rules = parts.map((p) => websitePartRule(p, { pickup, categoryName: p.categoryId }));
  const offerLines = lines.map((l) => ({
    id: l.id,
    categoryId: l.categoryId ?? null,
    lineTotalCents: l.lineTotalCents,
    menuItemName: l.menuItemName,
    noDiscount: l.noDiscount === true,
  }));
  const food = lines.filter((l) => l.noDiscount !== true).reduce((s, l) => s + l.lineTotalCents, 0);
  const shares = assignOfferLines(rules, offerLines, food);
  const worked = rules.map((rule) => {
    const share = shares.find((x) => x.rule === rule)!;
    return { amountCents: share.amountCents, ruleJson: JSON.stringify({ ...rule, lines: share.lineIds }), lineIds: share.lineIds };
  });
  const tax = taxAfterDiscountRows(
    lines.map((l) => ({ ...l, noDiscount: l.noDiscount === true })),
    worked,
  ).taxCents;
  return { worked, discount: worked.reduce((s, w) => s + w.amountCents, 0), tax };
}

describe('the website and the till bill a category’s own % the same, to the paisa', () => {
  const cats: WebsiteCategoryPercent[] = [{ categoryId: PIZZA, percent: 20 }];

  it('a pick-up: 2 pizzas at 20%, a burger and a drink at 10%, a value deal at full price', () => {
    const lines = [
      line('pz-large', 200_000, PIZZA),
      line('pz-medium', 150_000, PIZZA),
      line('burger', 80_000, BURGERS),
      line('deal', 360_000, DEALS, { noDiscount: true }),
      line('drink', 12_000, DRINKS),
    ];
    const web = websiteBill(lines, 10, cats);
    expect(web.plans.map((p) => [p.categoryId, p.amountCents])).toEqual([
      [PIZZA, 70_000],
      [null, 9_200],
    ]);
    expect(web.parts).toEqual([
      { percent: 20, categoryId: PIZZA },
      { percent: 10, categoryId: null },
    ]);
    const till = tillBill(lines, web.parts!);
    expect(till.discount).toBe(web.discount);
    expect(till.tax).toBe(web.tax);
    // Each row over its own lines: the pizzas' row, then the rest of the food (never the deal).
    expect(till.worked.map((w) => w.lineIds)).toEqual([['pz-large', 'pz-medium'], ['burger', 'drink']]);
  });

  it('a delivery: the charge is never discounted; odd amounts round once per part as the till does', () => {
    const lines = [
      line('pz', 123_400, PIZZA),
      line('pz2', 98_700, PIZZA),
      line('sig', 210_300, SIGNATURE),
      line('fries', 33_300, BURGERS),
      line('Delivery Charge (Rs 200)', 20_000, null, { noDiscount: true, taxRateBps: 1600 }),
    ];
    const web = websiteBill(lines, 10, [{ categoryId: PIZZA, percent: 20 }, { categoryId: SIGNATURE, percent: 15 }]);
    expect(web.parts).not.toBeNull();
    const till = tillBill(lines, web.parts!, false);
    expect(till.discount).toBe(web.discount);
    expect(till.tax).toBe(web.tax);
    expect(till.worked.flatMap((w) => w.lineIds)).not.toContain('Delivery Charge (Rs 200)');
  });

  it('only pizzas in the cart: the category part alone (no main part); the till bills the same', () => {
    const lines = [line('pz', 200_000, PIZZA), line('deal', 260_000, DEALS, { noDiscount: true })];
    const web = websiteBill(lines, 10, cats);
    expect(web.parts).toEqual([{ percent: 20, categoryId: PIZZA }]);
    const till = tillBill(lines, web.parts!);
    expect([till.discount, till.tax]).toEqual([web.discount, web.tax]);
  });

  it('no line in a category with its own %: no parts — the order goes with one %, as before', () => {
    const lines = [line('burger', 80_000, BURGERS), line('drink', 12_000, DRINKS)];
    const web = websiteBill(lines, 10, cats);
    expect(web.parts).toBeNull();
    expect(web.discount).toBe(9_200);
  });

  it('a main % of 0: only the categories take anything off', () => {
    const lines = [line('pz', 150_000, PIZZA), line('burger', 80_000, BURGERS)];
    const web = websiteBill(lines, 0, cats);
    expect(web.parts).toEqual([{ percent: 20, categoryId: PIZZA }]);
    expect(web.discount).toBe(30_000);
    expect(tillBill(lines, web.parts!).discount).toBe(30_000);
  });

  it('many orders, made-up but varied: never a paisa apart', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const catIds = [PIZZA, SIGNATURE, BURGERS, DEALS, DRINKS, null];
    for (let k = 0; k < 400; k++) {
      const lines: Line[] = [];
      const n = 1 + rnd(7);
      for (let i = 0; i < n; i++) {
        const cat = catIds[rnd(catIds.length)]!;
        lines.push(line(`l${i}`, (1 + rnd(4000)) * 100 + rnd(100), cat, cat === DEALS ? { noDiscount: true } : {}));
      }
      const own: WebsiteCategoryPercent[] = [
        { categoryId: PIZZA, percent: 1 + rnd(50) },
        ...(rnd(2) ? [{ categoryId: SIGNATURE, percent: 1 + rnd(50) }] : []),
      ];
      const main = rnd(51);
      const web = websiteBill(lines, main, own);
      if (!web.parts) continue;
      const till = tillBill(lines, web.parts, rnd(2) === 0);
      expect([till.discount, till.tax]).toEqual([web.discount, web.tax]);
    }
  });
});

describe('the parts on the order, and their rows', () => {
  it('read back strictly: whole % 1–50, each category once, at most one main part; a list with no category part is none', () => {
    expect(readDiscountParts([{ percent: 20, categoryId: PIZZA }, { percent: 10, categoryId: null }])).toEqual([
      { percent: 20, categoryId: PIZZA },
      { percent: 10, categoryId: null },
    ]);
    expect(readDiscountParts([{ percent: 10, categoryId: null }])).toBeNull();
    expect(readDiscountParts([{ percent: 0, categoryId: PIZZA }])).toBeNull();
    expect(readDiscountParts([{ percent: 51, categoryId: PIZZA }])).toBeNull();
    expect(readDiscountParts([{ percent: 20.5, categoryId: PIZZA }])).toBeNull();
    expect(readDiscountParts([{ percent: 20, categoryId: PIZZA }, { percent: 15, categoryId: PIZZA }])).toBeNull();
    expect(readDiscountParts('nonsense')).toBeNull();
    expect(readDiscountParts(undefined)).toBeNull();
  });

  it('the rows print as “Website pick-up 10% off” and “Website 20% off Pizza”, at most 30 letters', () => {
    expect(websitePartName({ percent: 10, categoryId: null }, true, null)).toBe('Website pick-up 10% off');
    expect(websitePartName({ percent: 10, categoryId: null }, false, null)).toBe('Website delivery 10% off');
    expect(websitePartName({ percent: 20, categoryId: PIZZA }, true, 'Pizza')).toBe('Website 20% off Pizza');
    const long = websitePartName({ percent: 20, categoryId: PIZZA }, true, 'Regular Pizzas of every kind');
    expect(long.length).toBeLessThanOrEqual(30);
    expect(long.endsWith('…')).toBe(true);
    const rule = websitePartRule({ percent: 20, categoryId: PIZZA }, { pickup: false, categoryName: 'Pizza' });
    expect(rule).toMatchObject({ alsoOffDeliveryCharge: false, skipsNoDiscountLines: true, offer: { categoryIds: [PIZZA], orderTypes: ['delivery'], value: 20 } });
  });
});
