import { describe, expect, it } from 'vitest';
import { DEFAULT_FOODPANDA_DEAL, DEFAULT_FOODPANDA_FEES, type FoodpandaDeal, type FoodpandaFees } from '@cheeseoclock/shared-types';
import {
  bpsFromPercentText,
  centsFromRupeesText,
  checksSummary,
  dealPayer,
  dealSummary,
  feesSummary,
  percentFromBps,
  workedExample,
} from './foodpandaWords';
import { dealFromForm, dealToForm, feesFromForm, feesToForm, sameValue } from './foodpandaForm';

const deal = (over: Partial<FoodpandaDeal> = {}): FoodpandaDeal => ({ ...DEFAULT_FOODPANDA_DEAL, percent: 20, shopPercent: 20, ...over });
const fees = (over: Partial<FoodpandaFees> = {}): FoodpandaFees => ({ ...DEFAULT_FOODPANDA_FEES, confirmed: true, ...over });

describe('the worked example follows the owner’s values', () => {
  it('the owner’s own words, word for word', () => {
    expect(workedExample(deal(), fees())).toBe(
      'A Rs 2,000 foodpanda order with 20% off that you pay: the bill shows Rs 1,600 + tax; foodpanda keeps 25% of Rs 1,600 = Rs 400; you keep Rs 1,200 before food cost.',
    );
  });

  it('shared, paid by foodpanda, no deal', () => {
    expect(workedExample(deal({ shopPercent: 10 }), fees())).toBe(
      'A Rs 2,000 foodpanda order with 20% off, you paying 10%: the bill shows Rs 1,800 + tax and foodpanda pays the other Rs 200; foodpanda keeps 25% of Rs 1,800 = Rs 450; you keep Rs 1,350 before food cost.',
    );
    expect(workedExample(deal({ shopPercent: 0 }), fees())).toContain('that foodpanda pays: the bill shows Rs 2,000 + tax and foodpanda pays the Rs 400 off');
    expect(workedExample(DEFAULT_FOODPANDA_DEAL, fees())).toBe(
      'A Rs 2,000 foodpanda order with no deal: the bill shows Rs 2,000 + tax; foodpanda keeps 25% of Rs 2,000 = Rs 500; you keep Rs 1,500 before food cost.',
    );
  });

  it('suggested commission, a fee, tax on it, a cap and a minimum', () => {
    expect(workedExample(deal(), DEFAULT_FOODPANDA_FEES)).toContain('foodpanda keeps about 25% of Rs 1,600 = Rs 400');
    expect(workedExample(deal(), DEFAULT_FOODPANDA_FEES)).toContain('only suggested until you confirm');
    expect(workedExample(deal(), fees({ fixedFeeCents: 3_000, commissionTaxBps: 1_600 }))).toContain(
      '= Rs 400, plus Rs 64 tax on that and a Rs 30 fee; you keep Rs 1,106 before food cost.',
    );
    expect(workedExample(deal({ maxOffCents: 30_000 }), fees())).toContain('with 20% off (at most Rs 300) that you pay: the bill shows Rs 1,700');
    expect(workedExample(deal({ minOrderCents: 250_000 }), fees())).toMatch(/^A Rs 2,500 foodpanda order with 20% off/);
  });

  it("foodpanda's menu dearer than the till's: the listing, and the commission on foodpanda's prices", () => {
    expect(workedExample(deal(), fees({ upliftBps: 1_000 }))).toBe(
      "A Rs 2,000 foodpanda order (Rs 2,200 on your listing, 10% above the till) with 20% off that you pay: the bill shows Rs 1,600 + tax, Rs 1,760 at foodpanda's prices; foodpanda keeps 25% of Rs 1,760 = Rs 440; you keep Rs 1,320 before food cost.",
    );
  });
});

describe('summaries and typing', () => {
  it('say the setting in one line', () => {
    expect(dealSummary(DEFAULT_FOODPANDA_DEAL)).toBe('No deal: foodpanda orders at full till price');
    expect(dealSummary(deal({ shopPercent: 10, minOrderCents: 100_000, maxOffCents: 30_000, startsOn: '2026-10-01', endsOn: '2026-10-07' }))).toBe(
      '20% off, you pay 10% · orders from Rs 1,000 · at most Rs 300 off · 1 Oct 2026 to 7 Oct 2026',
    );
    expect(feesSummary(DEFAULT_FOODPANDA_FEES)).toBe('25% after the deal (suggested)');
    expect(feesSummary(fees({ commissionBps: 2_250, base: 'before_deal', fixedFeeCents: 3_000, commissionTaxBps: 1_600 }))).toBe(
      '22.5% before the deal · Rs 30 an order · 16% tax on it',
    );
    expect(feesSummary(fees({ upliftBps: 1_250 }))).toBe('25% after the deal · menu 12.5% above the till');
    expect(checksSummary({ v: 1, orderCode: 'required', tabletTotal: 'optional' })).toBe('Order number required · tablet total optional');
    expect(dealPayer({ percent: 20, shopPercent: 20 })).toBe('shop');
    expect(dealPayer({ percent: 20, shopPercent: 0 })).toBe('foodpanda');
    expect(dealPayer({ percent: 20, shopPercent: 5 })).toBe('shared');
  });

  it('reads what the owner types', () => {
    expect(bpsFromPercentText('25')).toBe(2_500);
    expect(bpsFromPercentText('22.5%')).toBe(2_250);
    expect(bpsFromPercentText('16.25')).toBe(1_625);
    expect(bpsFromPercentText('2.555')).toBeNull();
    expect(bpsFromPercentText('abc')).toBeNull();
    expect(percentFromBps(1_625)).toBe('16.25%');
    expect(centsFromRupeesText('1,500')).toBe(150_000);
    expect(centsFromRupeesText('')).toBeNull();
    expect(centsFromRupeesText('12.5')).toBeNaN();
  });
});

describe('the forms', () => {
  it('a saved value round-trips through its form unchanged (Save stays off until something changes)', () => {
    for (const d of [DEFAULT_FOODPANDA_DEAL, deal({ shopPercent: 10, minOrderCents: 100_000, maxOffCents: 30_000, startsOn: '2026-10-01', endsOn: '2026-10-07' }), deal({ shopPercent: 0 })]) {
      const back = dealFromForm(dealToForm(d));
      expect(back.problem).toBeNull();
      expect(sameValue(back.value, d)).toBe(true);
    }
    for (const f of [DEFAULT_FOODPANDA_FEES, fees({ commissionBps: 2_250, base: 'before_deal', fixedFeeCents: 3_000, commissionTaxBps: 1_625, upliftBps: 1_250 })]) {
      const back = feesFromForm(feesToForm(f));
      expect(back.problem).toBeNull();
      expect(sameValue(back.value, f)).toBe(true);
    }
  });

  it('says what is wrong before Save', () => {
    const f = dealToForm(deal());
    expect(dealFromForm({ ...f, percent: '60' }).problem).toMatch(/0 to 50/);
    expect(dealFromForm({ ...f, percent: '12.5' }).problem).toMatch(/whole %/);
    expect(dealFromForm({ ...f, payer: 'shared', shopPercent: '20' }).problem).toMatch(/Your part/);
    expect(dealFromForm({ ...f, minOrder: '10.50' }).problem).toMatch(/smallest order/);
    expect(dealFromForm({ ...f, maxOff: '0' }).problem).toMatch(/most off/);
    expect(dealFromForm({ ...f, startsOn: '2026-10-07', endsOn: '2026-10-01' }).problem).toMatch(/end before/);
    expect(dealFromForm({ ...f, payer: 'foodpanda' }).value).toMatchObject({ percent: 20, shopPercent: 0 });
    const g = feesToForm(fees());
    expect(feesFromForm({ ...g, commission: '55' }).problem).toMatch(/commission/);
    expect(feesFromForm({ ...g, fixedFee: '2500' }).problem).toMatch(/fee/);
    expect(feesFromForm({ ...g, commissionTax: '' }).value).toMatchObject({ commissionTaxBps: 0 });
    expect(feesFromForm({ ...g, uplift: '' }).value).toMatchObject({ upliftBps: 0 });
    expect(feesFromForm({ ...g, uplift: '10' }).value).toMatchObject({ upliftBps: 1_000 });
    expect(feesFromForm({ ...g, uplift: '150' }).problem).toMatch(/dearer/);
  });
});
