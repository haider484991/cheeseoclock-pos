import { describe, expect, it } from 'vitest';
import {
  billByMethod,
  billDependsOnMethod,
  billsByMethod,
  cleanMethodRates,
  methodMapJson,
  parseMethodRates,
  parseMethodTotals,
  paysOwnRate,
  rateByMethod,
} from '@cheeseoclock/shared-types';
import { digitalCentsOf, splitTender } from './split-tender.js';
import { movedLegAmount, settleLegs } from './settle-legs.js';

// A Rs 1,000 bill before tax: Rs 1,150 in cash (15%), Rs 1,080 by card (8%).
const cardRate = { totalCents: 115_000, digitalTotalCents: 108_000, netCents: 100_000 };

describe('rateByMethod: a rate for each way of paying', () => {
  const gst = { rateBps: 1500, digitalRateBps: 800, methodRatesBps: { jazzcash: 1500, bank_transfer: 1000 } };

  it('cash (and foodpanda) the rate; a way with its own, its own; the rest the card rate', () => {
    expect(rateByMethod(gst, 'cash')).toBe(1500);
    expect(rateByMethod(gst, 'foodpanda')).toBe(1500);
    expect(rateByMethod(gst, 'card')).toBe(800);
    expect(rateByMethod(gst, 'easypaisa')).toBe(800);
    expect(rateByMethod(gst, 'jazzcash')).toBe(1500);
    expect(rateByMethod(gst, 'bank_transfer')).toBe(1000);
  });

  it('a category from before 0.7.45: every way but cash at the card rate, as since 0052', () => {
    const old = { rateBps: 1500, digitalRateBps: 800 };
    for (const m of ['card', 'easypaisa', 'jazzcash', 'bank_transfer']) expect(rateByMethod(old, m)).toBe(800);
    expect(rateByMethod({ rateBps: 1500, digitalRateBps: null }, 'jazzcash')).toBe(1500);
  });

  it('no card rate, but JazzCash has its own: only JazzCash differs', () => {
    const r = { rateBps: 1500, digitalRateBps: null, methodRatesBps: { jazzcash: 800 } };
    expect(rateByMethod(r, 'card')).toBe(1500);
    expect(rateByMethod(r, 'jazzcash')).toBe(800);
  });
});

describe('cleanMethodRates: only the ways that differ from the card rate are stored', () => {
  it('keeps the ones that differ, drops the card and the ones at the card rate', () => {
    expect(cleanMethodRates({ card: 500, easypaisa: 800, jazzcash: 1500, bank_transfer: 1000 }, { rateBps: 1500, digitalRateBps: 800 })).toEqual({
      jazzcash: 1500,
      bank_transfer: 1000,
    });
  });

  it('every way at the card rate: none (stored as before 0.7.45)', () => {
    expect(cleanMethodRates({ easypaisa: 800, jazzcash: 800 }, { rateBps: 1500, digitalRateBps: 800 })).toBeNull();
    expect(cleanMethodRates(null, { rateBps: 1500 })).toBeNull();
  });

  it('no card rate: the ways are measured against the rate', () => {
    expect(cleanMethodRates({ jazzcash: 1500, easypaisa: 800 }, { rateBps: 1500, digitalRateBps: null })).toEqual({ easypaisa: 800 });
  });

  it('refuses a rate that is not whole basis points from 0% to 100%', () => {
    expect(() => cleanMethodRates({ jazzcash: 10_001 }, { rateBps: 1500 })).toThrow(/basis points/);
    expect(() => cleanMethodRates({ jazzcash: 12.5 }, { rateBps: 1500 })).toThrow(/basis points/);
    expect(() => cleanMethodRates({ jazzcash: -1 }, { rateBps: 1500 })).toThrow(/basis points/);
  });
});

describe('the stored JSON', () => {
  it('round-trips in the ways’ own order', () => {
    const json = methodMapJson({ bank_transfer: 1000, jazzcash: 1500 });
    expect(json).toBe('{"jazzcash":1500,"bank_transfer":1000}');
    expect(parseMethodRates(json)).toEqual({ jazzcash: 1500, bank_transfer: 1000 });
    expect(methodMapJson({})).toBeNull();
    expect(methodMapJson(null)).toBeNull();
  });

  it('reads only what it knows: a way it does not know, a rate that is not one, text that is not JSON', () => {
    expect(parseMethodRates('{"jazzcash":1500,"crypto":100,"card":"8"}')).toEqual({ jazzcash: 1500 });
    expect(parseMethodRates('{"jazzcash":20000}')).toBeNull();
    expect(parseMethodRates('not json')).toBeNull();
    expect(parseMethodRates('[1500]')).toBeNull();
    expect(parseMethodRates(null)).toBeNull();
    expect(parseMethodTotals('{"easypaisa":108000,"jazzcash":-5}')).toEqual({ easypaisa: 108_000 });
  });
});

describe('billByMethod / billsByMethod', () => {
  const order = { totalCents: 115_000, digitalTotalCents: 108_000, methodTotalsCents: { jazzcash: 115_000, bank_transfer: 110_000 } };

  it('cash the total; a way with a bill of its own, its own; the rest the bill by card', () => {
    expect(billByMethod(order, 'cash')).toBe(115_000);
    expect(billByMethod(order, 'card')).toBe(108_000);
    expect(billByMethod(order, 'easypaisa')).toBe(108_000);
    expect(billByMethod(order, 'jazzcash')).toBe(115_000);
    expect(billByMethod(order, 'bank_transfer')).toBe(110_000);
  });

  it('groups the ways whose bill is not the total, in their own order', () => {
    expect(billsByMethod(order)).toEqual([
      { methods: ['card', 'easypaisa'], totalCents: 108_000 },
      { methods: ['bank_transfer'], totalCents: 110_000 },
    ]);
    expect(billsByMethod({ totalCents: 115_000, digitalTotalCents: null })).toEqual([]);
    expect(billDependsOnMethod({ totalCents: 115_000, digitalTotalCents: null })).toBe(false);
    expect(billDependsOnMethod({ totalCents: 115_000, methodTotalsCents: { jazzcash: 108_000 } })).toBe(true);
  });

  it('a way at the cash rate does not pay a rate of its own; a card rate always does (as since 0052)', () => {
    expect(paysOwnRate(order, 'jazzcash')).toBe(false);
    expect(paysOwnRate(order, 'bank_transfer')).toBe(true);
    expect(paysOwnRate(order, 'card')).toBe(true);
    expect(paysOwnRate(order, 'cash')).toBe(false);
    expect(paysOwnRate({ totalCents: 115_000, digitalTotalCents: null }, 'card')).toBe(false);
  });
});

describe('settleLegs: the 0052 rule for any number of ways', () => {
  it('every order from before 0.7.45 settles exactly as splitTender', () => {
    const legSets = [
      [{ method: 'cash', amountCents: 115_000 }],
      [{ method: 'card', amountCents: 108_000 }],
      [{ method: 'jazzcash', amountCents: 108_000 }],
      [
        { method: 'card', amountCents: 54_000 },
        { method: 'cash', amountCents: 57_500 },
      ],
      [
        { method: 'easypaisa', amountCents: 20_000 },
        { method: 'bank_transfer', amountCents: 30_000 },
        { method: 'cash', amountCents: 1 },
      ],
      [{ method: 'card', amountCents: 108_001 }],
    ];
    for (const q of [cardRate, { totalCents: 115_000, digitalTotalCents: null, netCents: 100_000 }]) {
      for (const legs of legSets) {
        expect(settleLegs(q, legs)).toEqual(splitTender(q, digitalCentsOf(legs)));
      }
    }
  });

  it('JazzCash at the cash rate: the cash bill, and nothing at a rate of its own', () => {
    const q = { ...cardRate, methodTotalsCents: { jazzcash: 115_000 } };
    expect(settleLegs(q, [{ method: 'jazzcash', amountCents: 115_000 }])).toEqual({
      ok: true,
      cashDueCents: 0,
      totalCents: 115_000,
      taxCents: 15_000,
      digitalNetCents: 0,
      digitalTaxCents: 0,
    });
    // …and the card still pays the card bill beside it.
    expect(settleLegs(q, [{ method: 'card', amountCents: 108_000 }])).toMatchObject({ ok: true, totalCents: 108_000, digitalNetCents: 100_000 });
  });

  it('a way with a rate of its own (10%): its own bill, all of it at that rate', () => {
    const q = { ...cardRate, methodTotalsCents: { bank_transfer: 110_000 } };
    expect(settleLegs(q, [{ method: 'bank_transfer', amountCents: 110_000 }])).toEqual({
      ok: true,
      cashDueCents: 0,
      totalCents: 110_000,
      taxCents: 10_000,
      digitalNetCents: 100_000,
      digitalTaxCents: 10_000,
    });
  });

  it('half by card (8%), half by bank (10%): each half at its own bill, nothing left for cash', () => {
    const q = { ...cardRate, methodTotalsCents: { bank_transfer: 110_000 } };
    expect(
      settleLegs(q, [
        { method: 'card', amountCents: 54_000 },
        { method: 'bank_transfer', amountCents: 55_000 },
      ]),
    ).toEqual({ ok: true, cashDueCents: 0, totalCents: 109_000, taxCents: 9_000, digitalNetCents: 100_000, digitalTaxCents: 9_000 });
  });

  it('a quarter by card, a quarter by bank: the other half in cash at cash prices', () => {
    const q = { ...cardRate, methodTotalsCents: { bank_transfer: 110_000 } };
    const s = settleLegs(q, [
      { method: 'card', amountCents: 27_000 },
      { method: 'bank_transfer', amountCents: 27_500 },
    ]);
    expect(s).toEqual({ ok: true, cashDueCents: 57_500, totalCents: 112_000, taxCents: 12_000, digitalNetCents: 50_000, digitalTaxCents: 4_500 });
  });

  it('refuses parts that come to more than the bill, in plain words', () => {
    const q = { ...cardRate, methodTotalsCents: { bank_transfer: 110_000 } };
    expect(
      settleLegs(q, [
        { method: 'card', amountCents: 60_000 },
        { method: 'bank_transfer', amountCents: 60_000 },
      ]),
    ).toEqual({ ok: false, reason: 'Rs 600 by card and Rs 600 by bank transfer come to more than the bill' });
    expect(
      settleLegs(q, [
        { method: 'card', amountCents: 1 },
        { method: 'bank_transfer', amountCents: 110_001 },
      ]),
    ).toEqual({ ok: false, reason: 'Rs 1,100.01 by bank transfer is more than the bill by bank transfer (Rs 1,100)' });
    expect(settleLegs(q, [{ method: 'card', amountCents: -5 }])).toEqual({ ok: false, reason: 'Each payment must be whole paisa, not below zero' });
  });

  it('any mix: the parts add up to what was paid, the tax is the total less the bill before tax', () => {
    const q = { ...cardRate, methodTotalsCents: { jazzcash: 115_000, bank_transfer: 110_000 } };
    for (const [card, bank, jazz] of [
      [1, 1, 1],
      [12_345, 6_789, 1_000],
      [30_000, 30_000, 30_000],
      [107_999, 0, 0],
      [0, 0, 114_999],
    ] as const) {
      const legs = [
        { method: 'card', amountCents: card },
        { method: 'bank_transfer', amountCents: bank },
        { method: 'jazzcash', amountCents: jazz },
      ];
      const s = settleLegs(q, legs);
      expect(s.ok).toBe(true);
      if (!s.ok) continue;
      expect(s.totalCents).toBe(card + bank + jazz + s.cashDueCents);
      expect(s.taxCents).toBe(s.totalCents - q.netCents);
      expect(s.cashDueCents).toBeGreaterThanOrEqual(0);
      // JazzCash pays the cash rate here: only the card and the bank parts are at a rate of their own.
      expect(s.digitalNetCents + s.digitalTaxCents).toBe(card + bank);
    }
  });
});

describe('movedLegAmount: a payment moved to another way keeps its share of the bill', () => {
  it('cash to card: the bill by card', () => {
    expect(movedLegAmount(cardRate, [{ method: 'cash', amountCents: 115_000 }], 0, 'card')).toBe(108_000);
  });

  it('card to cash: the bill in cash', () => {
    expect(movedLegAmount(cardRate, [{ method: 'card', amountCents: 108_000 }], 0, 'cash')).toBe(115_000);
  });

  it('the cash half of a card + cash sale to card: the other half by card', () => {
    const legs = [
      { method: 'card', amountCents: 54_000 },
      { method: 'cash', amountCents: 57_500 },
    ];
    expect(movedLegAmount(cardRate, legs, 1, 'card')).toBe(54_000);
    expect(movedLegAmount(cardRate, legs, 0, 'cash')).toBe(57_500);
  });

  it('cash to JazzCash at the cash rate: the same amount; to a bank at 10%: its bill', () => {
    const q = { ...cardRate, methodTotalsCents: { jazzcash: 115_000, bank_transfer: 110_000 } };
    expect(movedLegAmount(q, [{ method: 'cash', amountCents: 115_000 }], 0, 'jazzcash')).toBe(115_000);
    expect(movedLegAmount(q, [{ method: 'cash', amountCents: 115_000 }], 0, 'bank_transfer')).toBe(110_000);
    expect(movedLegAmount(q, [{ method: 'card', amountCents: 108_000 }], 0, 'bank_transfer')).toBe(110_000);
  });

  it('an order with no card rate: the same amount, whatever the way', () => {
    const plain = { totalCents: 115_000, digitalTotalCents: null, netCents: 100_000 };
    expect(movedLegAmount(plain, [{ method: 'cash', amountCents: 115_000 }], 0, 'card')).toBe(115_000);
    expect(
      movedLegAmount(
        plain,
        [
          { method: 'card', amountCents: 40_000 },
          { method: 'cash', amountCents: 75_000 },
        ],
        0,
        'jazzcash',
      ),
    ).toBe(40_000);
  });

  it('awkward paisa: the amount found settles the sale exactly', () => {
    const q = { totalCents: 123_457, digitalTotalCents: 111_111, netCents: 107_354, methodTotalsCents: { bank_transfer: 117_284 } };
    const legs = [
      { method: 'card', amountCents: 33_333 },
      { method: 'cash', amountCents: 0 },
    ];
    const cash = settleLegs(q, [legs[0]!]);
    expect(cash.ok).toBe(true);
    if (!cash.ok) return;
    legs[1]!.amountCents = cash.cashDueCents;
    const moved = movedLegAmount(q, legs, 1, 'bank_transfer');
    expect(moved).not.toBeNull();
    const after = settleLegs(q, [legs[0]!, { method: 'bank_transfer', amountCents: moved! }]);
    expect(after).toMatchObject({ ok: true, cashDueCents: 0 });
  });

  it('no leg there: null', () => {
    expect(movedLegAmount(cardRate, [], 0, 'card')).toBeNull();
  });
});
