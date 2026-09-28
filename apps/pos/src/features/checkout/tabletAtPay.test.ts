/**
 * Pay on a foodpanda order (TenderDialog): the tablet's total against the
 * till's at foodpanda's prices, within the owner's tolerance (Settings →
 * foodpanda → checks, the value Reports use), and the owner's two checks.
 * Every amount is made up.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expectedTabletCents } from '@cheeseoclock/pos-domain';
import type { CheckoutRules } from '@cheeseoclock/shared-types';
import { foodpandaPayStep, parseTabletCents, tabletAtPay } from './tabletAtPay';

type Foodpanda = CheckoutRules['foodpanda'];
const fp = (over: Partial<Foodpanda> = {}): Foodpanda => ({
  deal: null,
  checks: { orderCode: 'optional', tabletTotal: 'optional' },
  tabletToleranceCents: 100,
  upliftBps: 0,
  ...over,
});

describe('tabletAtPay: what Pay checks the tablet against', () => {
  it('Rs 0 from the owner is Rs 0 (not the Rs 1 of before the rules read): one paisa off is flagged', () => {
    const t = tabletAtPay({ tabletToleranceCents: 0, upliftBps: 0 }, 150_000);
    expect(t.toleranceCents).toBe(0);
    expect([t.differs(150_000), t.differs(150_001), t.differs(149_999)]).toEqual([false, true, true]);
  });

  it('with foodpanda’s price uplift the expected total is at foodpanda’s prices', () => {
    const t = tabletAtPay({ tabletToleranceCents: 100, upliftBps: 1_000 }, 100_000);
    expect(t.expectedCents).toBe(expectedTabletCents(100_000, 1_000));
    expect(t.expectedCents).not.toBe(100_000);
    expect(t.differs(t.expectedCents + 100)).toBe(false);
    expect(t.differs(t.expectedCents + 101)).toBe(true);
    // The till's own total is now more than Rs 1 from what the tablet should show.
    expect(t.differs(100_000)).toBe(true);
  });

  it('until the rules have read: Rs 1 and no uplift, the till before the setting', () => {
    const t = tabletAtPay(undefined, 200_000);
    expect(t).toMatchObject({ expectedCents: 200_000, toleranceCents: 100 });
    expect([t.differs(200_100), t.differs(200_101), t.differs(199_899)]).toEqual([false, true, true]);
  });

  it('the tablet total as typed: rupees with up to two decimals, commas allowed', () => {
    expect(parseTabletCents('')).toBeNull();
    expect(parseTabletCents('  ')).toBeNull();
    expect(parseTabletCents('1,920')).toBe(192_000);
    expect(parseTabletCents('1920.5')).toBe(192_050);
    expect(parseTabletCents(' 1920.50 ')).toBe(192_050);
    for (const bad of ['19.205', 'abc', '-5', 'Rs 1920']) expect(parseTabletCents(bad)).toBeNaN();
  });
});

describe('foodpandaPayStep: Pay’s whole foodpanda check, in one place', () => {
  const TOTAL = 150_000;

  it('nothing typed and nothing required: pays as before, no tablet total kept', () => {
    expect(foodpandaPayStep(fp(), TOTAL, '', '')).toEqual({ kind: 'pay', tabletTotalCents: null });
    expect(foodpandaPayStep(undefined, TOTAL, '', '')).toEqual({ kind: 'pay', tabletTotalCents: null });
  });

  it('within the owner’s tolerance: pays and keeps the tablet total; further off: asks "Pay anyway?"', () => {
    const rs5 = fp({ tabletToleranceCents: 500 });
    expect(foodpandaPayStep(rs5, TOTAL, 'FP-TEST-1', '1505')).toEqual({ kind: 'pay', tabletTotalCents: 150_500 });
    expect(foodpandaPayStep(rs5, TOTAL, 'FP-TEST-1', '1495')).toEqual({ kind: 'pay', tabletTotalCents: 149_500 });
    expect(foodpandaPayStep(rs5, TOTAL, 'FP-TEST-1', '1505.01')).toEqual({
      kind: 'ask',
      question:
        'The till says Rs 1,500, the tablet says Rs 1,505.01 — check the items and the deal.\nPay anyway? The difference is kept, and Reports list this order to check.',
      tabletTotalCents: 150_501,
    });
    // The Rs 1 of before is not what decides: Rs 3 off is fine at Rs 5.
    expect(foodpandaPayStep(rs5, TOTAL, '', '1503')).toMatchObject({ kind: 'pay' });
    expect(foodpandaPayStep(fp(), TOTAL, '', '1503')).toMatchObject({ kind: 'ask' });
  });

  it('at Rs 0 any difference asks; with the uplift the question names what the tablet should say', () => {
    expect(foodpandaPayStep(fp({ tabletToleranceCents: 0 }), TOTAL, '', '1500.01')).toMatchObject({ kind: 'ask', tabletTotalCents: 150_001 });
    expect(foodpandaPayStep(fp({ tabletToleranceCents: 0 }), TOTAL, '', '1500')).toEqual({ kind: 'pay', tabletTotalCents: 150_000 });
    const dearer = fp({ upliftBps: 1_000 });
    const expected = expectedTabletCents(TOTAL, 1_000);
    expect(foodpandaPayStep(dearer, TOTAL, '', String(expected / 100))).toEqual({ kind: 'pay', tabletTotalCents: expected });
    const ask = foodpandaPayStep(dearer, TOTAL, '', '1500');
    expect(ask).toMatchObject({ kind: 'ask', tabletTotalCents: 150_000 });
    expect(ask.kind === 'ask' && ask.question).toContain("The tablet should say Rs 1,650 (the till's Rs 1,500 at foodpanda's prices), the tablet says Rs 1,500");
  });

  it('the owner’s checks: a required order number or tablet total must be typed; a tablet total that is not rupees is refused', () => {
    const both = fp({ checks: { orderCode: 'required', tabletTotal: 'required' } });
    expect(foodpandaPayStep(both, TOTAL, '  ', '1500')).toEqual({
      kind: 'refuse',
      message: "Type foodpanda's order number — the owner has made it required.",
    });
    expect(foodpandaPayStep(both, TOTAL, 'FP-TEST-2', '')).toEqual({
      kind: 'refuse',
      message: 'Type the total on the foodpanda tablet — the owner has made it required.',
    });
    expect(foodpandaPayStep(fp(), TOTAL, '', '15OO')).toEqual({ kind: 'refuse', message: 'Type the tablet total in rupees, like 1920 or 1920.50.' });
    expect(foodpandaPayStep(both, TOTAL, 'FP-TEST-2', '1500')).toEqual({ kind: 'pay', tabletTotalCents: 150_000 });
  });

  it('Pay carries it out: TenderDialog asks this, and does no tablet arithmetic of its own', () => {
    const src = readFileSync(fileURLToPath(new URL('./TenderDialog.tsx', import.meta.url)), 'utf8');
    expect(src).toContain('const step = foodpandaPayStep(rules.data?.foodpanda, total, fpCode, fpTablet);');
    const submit = src.slice(src.indexOf('async function submit('), src.indexOf('function onKeyDown('));
    const refuse = submit.indexOf("if (step.kind === 'refuse') {");
    const ask = submit.indexOf("if (step.kind === 'ask') {");
    const keep = submit.indexOf('tabletTotalCents = step.tabletTotalCents;');
    const pay = submit.indexOf('await tender(');
    expect(refuse).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(refuse);
    expect(keep).toBeGreaterThan(ask);
    expect(pay).toBeGreaterThan(keep);
    expect(submit.slice(ask, keep)).toContain('await askConfirm(step.question, { safeDefault: true');
    // No tolerance, uplift or difference worked out on the screen.
    expect(src).not.toMatch(/tabletDiffers|expectedTabletCents|FOODPANDA_TABLET_TOLERANCE|tabletToleranceCents|upliftBps|Math\.abs/);
  });
});
