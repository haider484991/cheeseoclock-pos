import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FOODPANDA_CHECKS,
  DEFAULT_FOODPANDA_DEAL,
  DEFAULT_FOODPANDA_FEES,
  type FoodpandaDeal,
  type FoodpandaFees,
} from '@cheeseoclock/shared-types';
import {
  andList,
  bpsFromPercentText,
  centsFromRupeesText,
  centsFromWholeRupeesText,
  checksSummary,
  dealPayer,
  dealSummary,
  feesSummary,
  percentFromBps,
  toleranceWords,
  workedExample,
} from './foodpandaWords';
import {
  checksFromForm,
  checksIntro,
  checksToForm,
  dealFromForm,
  dealToForm,
  feesFromForm,
  feesToForm,
  sameValue,
  typeTolerance,
} from './foodpandaForm';
import { lastChangedText } from './SettingCard';

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

  it("the most-off at foodpanda's prices: Rs 300 off the Rs 2,200 listing leaves Rs 1,900 there", () => {
    const text = workedExample(deal({ maxOffCents: 30_000 }), fees({ upliftBps: 1_000 }));
    expect(text).toContain('with 20% off (at most Rs 300) that you pay');
    expect(text).toContain("Rs 1,900 at foodpanda's prices");
  });

  it("foodpanda's fee on the total is in what it keeps", () => {
    expect(workedExample(deal(), fees({ paymentFeeBps: 200 }))).toContain('= Rs 400, plus 2% of the total (Rs 32); you keep Rs 1,168 before food cost.');
    expect(workedExample(deal(), fees({ fixedFeeCents: 3_000, commissionTaxBps: 1_600, paymentFeeBps: 200 }))).toContain(
      '= Rs 400, plus Rs 64 tax on that, a Rs 30 fee and 2% of the total (Rs 32); you keep Rs 1,074 before food cost.',
    );
    expect(andList(['a'])).toBe('a');
    expect(andList(['a', 'b'])).toBe('a and b');
    expect(andList(['a', 'b', 'c'])).toBe('a, b and c');
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
    expect(feesSummary(fees({ paymentFeeBps: 200 }))).toBe('25% after the deal · 2% of the total');
    expect(checksSummary({ v: 2, orderCode: 'required', tabletTotal: 'optional', tabletToleranceCents: 100 })).toBe(
      'Order number required · tablet total optional · flagged when more than Rs 1 different',
    );
    expect(checksSummary({ v: 2, orderCode: 'optional', tabletTotal: 'required', tabletToleranceCents: 500 })).toBe(
      'Order number optional · tablet total required · flagged when more than Rs 5 different',
    );
    expect(checksSummary({ v: 2, orderCode: 'optional', tabletTotal: 'optional', tabletToleranceCents: 0 })).toBe(
      'Order number optional · tablet total optional · flagged when different at all',
    );
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

  it('reads whole rupees only when there is one reading (the smallest website delivery order box)', () => {
    expect(centsFromWholeRupeesText('')).toBeNull();
    expect(centsFromWholeRupeesText('   ')).toBeNull();
    expect(centsFromWholeRupeesText('0')).toBe(0);
    expect(centsFromWholeRupeesText('1500')).toBe(150_000);
    expect(centsFromWholeRupeesText(' 1,500 ')).toBe(150_000);
    expect(centsFromWholeRupeesText('1,000')).toBe(100_000);
    expect(centsFromWholeRupeesText('1,234,567')).toBe(123_456_700);
    expect(centsFromWholeRupeesText('0500')).toBe(50_000);
    for (const bad of ['1,0', '1,00', '10,00', '0,500', ',500', '500,', '1,,000', '1,0000', '1,000,00', '0.5', '10.5', '1.000', '1 000', '-1', '+1', 'Rs 5', '1e3', 'abc', '12345678']) {
      expect({ bad, cents: centsFromWholeRupeesText(bad) }).toEqual({ bad, cents: Number.NaN });
    }
  });
});

describe('the forms', () => {
  it('a saved value round-trips through its form unchanged (Save stays off until something changes)', () => {
    for (const d of [DEFAULT_FOODPANDA_DEAL, deal({ shopPercent: 10, minOrderCents: 100_000, maxOffCents: 30_000, startsOn: '2026-10-01', endsOn: '2026-10-07' }), deal({ shopPercent: 0 })]) {
      const back = dealFromForm(dealToForm(d));
      expect(back.problem).toBeNull();
      expect(sameValue(back.value, d)).toBe(true);
    }
    for (const f of [
      DEFAULT_FOODPANDA_FEES,
      fees({ commissionBps: 2_250, base: 'before_deal', fixedFeeCents: 3_000, commissionTaxBps: 1_625, upliftBps: 1_250, paymentFeeBps: 150 }),
    ]) {
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
    expect(feesFromForm({ ...g, paymentFee: '' }).value).toMatchObject({ paymentFeeBps: 0 });
    expect(feesFromForm({ ...g, paymentFee: '2.5' }).value).toMatchObject({ paymentFeeBps: 250 });
    expect(feesFromForm({ ...g, paymentFee: '60' }).problem).toMatch(/order's total/);
  });

  it('a carried-over card says where its values came from, not "Never changed"', () => {
    const lastChanged = { at: '2026-09-20T09:00:00.000Z', byName: 'Test Owner', onThisTill: null };
    expect(lastChangedText({ lastChanged, carriedOver: true })).toMatch(/^Carried over from Costing → Targets & fees \(saved by Test Owner, .+\): not saved here yet\.$/);
    expect(lastChangedText({ lastChanged: null })).toBe('Never changed: the till works as it always has.');
  });
});

describe('At Pay on a foodpanda order: the difference allowed on the tablet', () => {
  it('the default goes into the form and back unchanged (Rs 1)', () => {
    expect(checksToForm(DEFAULT_FOODPANDA_CHECKS)).toEqual({ orderCode: 'optional', tabletTotal: 'optional', tolerance: '1' });
    expect(checksFromForm(checksToForm(DEFAULT_FOODPANDA_CHECKS))).toEqual({ value: DEFAULT_FOODPANDA_CHECKS, problem: null });
  });

  it('a value an older version saved (format 1, read with Rs 1) goes back in THIS version’s format', () => {
    const readFromV1 = { v: 1, orderCode: 'required' as const, tabletTotal: 'optional' as const, tabletToleranceCents: 100 };
    expect(checksFromForm(checksToForm(readFromV1)).value).toEqual({ ...readFromV1, v: 2 });
  });

  it('whole rupees from Rs 0 to Rs 10 — never more (an anti-fraud check)', () => {
    const form = (tolerance: string) => ({ orderCode: 'optional' as const, tabletTotal: 'required' as const, tolerance });
    expect(checksFromForm(form('0')).value).toMatchObject({ v: 2, tabletTotal: 'required', tabletToleranceCents: 0 });
    expect(checksFromForm(form('10')).value).toMatchObject({ tabletToleranceCents: 1_000 });
    expect(checksFromForm(form(' 5 ')).value).toMatchObject({ tabletToleranceCents: 500 });
    const said = 'The difference allowed on the tablet is whole rupees, Rs 0 to Rs 10.';
    for (const t of ['11', '100', '1.5', '-1', '', 'abc']) expect({ t, problem: checksFromForm(form(t)).problem }).toEqual({ t, problem: said });
  });

  it('the words are built from the value', () => {
    expect(toleranceWords(100)).toBe('more than Rs 1 different');
    expect(toleranceWords(1_000)).toBe('more than Rs 10 different');
    expect(toleranceWords(0)).toBe('different at all');
  });

  it('the box keeps what the owner typed: "0.5" (or "1.5", "10.5") is refused with the card’s message, never read as Rs 5 (or Rs 15, Rs 10)', () => {
    const start = checksToForm(DEFAULT_FOODPANDA_CHECKS);
    const said = 'The difference allowed on the tablet is whole rupees, Rs 0 to Rs 10.';
    for (const typed of ['0.5', '1.5', '10.5', '1,0', 'Rs 5', '5 rupees', '-1', '½']) {
      const form = typeTolerance(start, typed);
      expect({ typed, box: form.tolerance, parsed: checksFromForm(form) }).toEqual({ typed, box: typed, parsed: { value: null, problem: said } });
    }
    // Whole rupees from Rs 0 to Rs 10 still save, as typed.
    for (const [typed, cents] of [
      ['0', 0],
      ['5', 500],
      ['10', 1_000],
      [' 7 ', 700],
    ] as const) {
      expect({ typed, parsed: checksFromForm(typeTolerance(start, typed)).value?.tabletToleranceCents }).toEqual({ typed, parsed: cents });
    }
  });

  it('the card’s intro follows the box as it is typed; while the box holds a value the card refuses, it says the saved one', () => {
    const saved = { ...DEFAULT_FOODPANDA_CHECKS, tabletToleranceCents: 300 };
    const start = checksToForm(saved);
    expect(checksIntro(start, saved)).toBe(
      'Pay can ask for foodpanda’s order number and the total on the foodpanda tablet. If the till’s total is more than Rs 3 different, the till says so and Reports lists the order — how you know the till matches foodpanda, and how a walk-in cash sale rung up as foodpanda shows up.',
    );
    expect(checksIntro(typeTolerance(start, '7'), saved)).toContain('If the till’s total is more than Rs 7 different, the till says so');
    expect(checksIntro(typeTolerance(start, '0'), saved)).toContain('If the till’s total is different at all, the till says so');
    for (const refused of ['', '11', '0.5']) {
      expect({ refused, intro: checksIntro(typeTolerance(start, refused), saved) }).toEqual({
        refused,
        intro: expect.stringContaining('If the till’s total is more than Rs 3 different'),
      });
    }
  });

  it('the card calls both: its intro from the box and the saved value, and the box keeps what is typed', () => {
    const src = readFileSync(fileURLToPath(new URL('../FoodpandaSettings.tsx', import.meta.url)), 'utf8');
    expect(src).toContain('intro={checksIntro(checksForm, checksCard.value)}');
    expect(src).toContain('onChange={(e) => checksD.set(typeTolerance(checksForm, e.target.value))}');
    // Nothing on the screen rewrites what is typed in the box.
    const box = src.slice(src.indexOf('id="fp-tolerance"'), src.indexOf('/>', src.indexOf('id="fp-tolerance"')));
    expect(box).not.toMatch(/replace\(|slice\(/);
  });
});
