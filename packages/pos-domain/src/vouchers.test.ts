import { describe, expect, it } from 'vitest';
import { VOUCHER_CODE_LENGTH, VOUCHER_CODE_LETTERS } from '@cheeseoclock/shared-types';
import { discountRuleScope, parseDiscountBaseRule } from './discount-base.js';
import { parseOfferRule } from './offers.js';
import {
  isVoucherCode,
  makeVoucherCodes,
  normalizeVoucherCode,
  parseVoucherList,
  parseVoucherNumber,
  parseVoucherRule,
  voucherAmountCents,
  voucherBillReason,
  voucherCanCover,
  voucherEnded,
  voucherLineOf,
  voucherNumberText,
  voucherRule,
  type VoucherLine,
} from './vouchers.js';

const TERMS = {
  v: 1 as const,
  id: '0199a1b2-0000-7000-8000-000000000001',
  batchId: '0199a1b2-0000-7000-8000-0000000000b1',
  number: 1,
  batchName: 'abhi',
  gives: 'One Large pizza from the Regular menu',
  coversCents: 189_900,
  lineId: 'line-pizza',
};

describe('voucher words', () => {
  it('prints the number as the voucher does, three figures at least', () => {
    expect(voucherNumberText(1)).toBe('001');
    expect(voucherNumberText(42)).toBe('042');
    expect(voucherNumberText(100)).toBe('100');
    expect(voucherNumberText(1234)).toBe('1234');
  });

  it('names the row on the bill by its number and who the vouchers are for', () => {
    expect(voucherBillReason(7, 'abhi')).toBe('Voucher No. 007 · abhi');
  });
});

describe('what the cashier types', () => {
  it('reads a code in capitals, without spaces or dashes', () => {
    expect(normalizeVoucherCode(' ab3c ')).toBe('AB3C');
    expect(normalizeVoucherCode('AB-3C')).toBe('AB3C');
    expect(normalizeVoucherCode('ab 3 c')).toBe('AB3C');
    expect(isVoucherCode('AB3C')).toBe(true);
    expect(isVoucherCode('M7')).toBe(false);
    expect(isVoucherCode('AB3C!')).toBe(false);
  });

  it('reads a number with or without its zeros, "No." or "#"', () => {
    expect(parseVoucherNumber('001')).toBe(1);
    expect(parseVoucherNumber('1')).toBe(1);
    expect(parseVoucherNumber('No. 12')).toBe(12);
    expect(parseVoucherNumber('#100')).toBe(100);
    expect(parseVoucherNumber('0')).toBeNull();
    expect(parseVoucherNumber('')).toBeNull();
    expect(parseVoucherNumber('1a')).toBeNull();
    expect(parseVoucherNumber('-3')).toBeNull();
  });
});

describe('a pasted list (parseVoucherList)', () => {
  it('reads "number code" lines, as the abhi log prints them', () => {
    const r = parseVoucherList('001 AB3C\n002 XK7P\n003 RT9D\n');
    expect(r.vouchers).toEqual([
      { number: 1, code: 'AB3C' },
      { number: 2, code: 'XK7P' },
      { number: 3, code: 'RT9D' },
    ]);
    expect(r.skipped).toEqual([]);
    expect(r.repeatedNumbers).toEqual([]);
    expect(r.repeatedCodes).toEqual([]);
  });

  it('reads a spreadsheet\'s two columns, commas, and a code that starts with a figure', () => {
    const r = parseVoucherList('44\t6DWK\n45, JN4R\n46 - lv6e\n47: 9FUT');
    expect(r.vouchers).toEqual([
      { number: 44, code: '6DWK' },
      { number: 45, code: 'JN4R' },
      { number: 46, code: 'LV6E' },
      { number: 47, code: '9FUT' },
    ]);
  });

  it('reads a CSV file: its heading left out, quotes, semicolons, a byte-order mark and Windows line ends', () => {
    const csv = '\uFEFFnumber,code\r\n"001","AB3C"\r\n002;XK7P\r\n3,RT9D,extra column\r\n';
    const r = parseVoucherList(csv);
    expect(r.vouchers).toEqual([
      { number: 1, code: 'AB3C' },
      { number: 2, code: 'XK7P' },
      { number: 3, code: 'RT9D' },
    ]);
    expect(r.skipped).toEqual(['number,code']);
  });

  it('splits a number and code run together as the PDF copies them: the last four letters are the code', () => {
    const r = parseVoucherList('029CY7N\n0446DWK\n100MA7H');
    expect(r.vouchers).toEqual([
      { number: 29, code: 'CY7N' },
      { number: 44, code: '6DWK' },
      { number: 100, code: 'MA7H' },
    ]);
  });

  it('leaves the paper log\'s headings and empty columns out, and lists what it skipped', () => {
    const r = parseVoucherList('NO. CODE DATE ORDER NO. FLAVOUR STAFF\n001 AB3C\n\nN\nO.CODEDATEORDERNO.FLAVOURSTAFF\n002 XK7P   \n');
    expect(r.vouchers).toEqual([
      { number: 1, code: 'AB3C' },
      { number: 2, code: 'XK7P' },
    ]);
    expect(r.skipped).toEqual(['NO. CODE DATE ORDER NO. FLAVOUR STAFF', 'N', 'O.CODEDATEORDERNO.FLAVOURSTAFF']);
  });

  it('says which numbers and codes are on two lines', () => {
    const r = parseVoucherList('001 AB3C\n001 AAAA\n002 AB3C');
    expect(r.repeatedNumbers).toEqual([1]);
    expect(r.repeatedCodes).toEqual(['AB3C']);
  });
});

describe('making codes', () => {
  it('makes the codes asked for, from the letters that never read alike, none twice and none taken', () => {
    let seed = 1;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    const taken = new Set(['AB3C', 'XK7P']);
    const codes = makeVoucherCodes(500, taken, random);
    expect(codes).toHaveLength(500);
    expect(new Set(codes).size).toBe(500);
    for (const c of codes) {
      expect(c).toHaveLength(VOUCHER_CODE_LENGTH);
      expect([...c].every((ch) => VOUCHER_CODE_LETTERS.includes(ch))).toBe(true);
      expect(taken.has(c)).toBe(false);
    }
    expect(VOUCHER_CODE_LETTERS).not.toMatch(/[0O1I2Z5S8B]/);
  });

  it('skips a code it already made or that is taken', () => {
    // Always the first letter: one code possible, so the second can't be made.
    expect(() => makeVoucherCodes(2, new Set(), () => 0)).toThrow('Could not make enough new codes');
    expect(makeVoucherCodes(1, new Set(), () => 0)).toEqual(['AAAA']);
  });
});

describe('its last day', () => {
  it('is over only after the last trading day; no last day never ends', () => {
    expect(voucherEnded('2026-12-31', '2026-12-31')).toBe(false);
    expect(voucherEnded('2026-12-31', '2027-01-01')).toBe(true);
    expect(voucherEnded(null, '2099-01-01')).toBe(false);
  });
});

describe('the rule frozen on a voucher row', () => {
  it('is a till discount on the food only, never a value deal — what a till without vouchers reads', () => {
    const json = JSON.stringify(voucherRule(TERMS));
    expect(parseDiscountBaseRule(json)).toEqual({
      kind: 'discount_base',
      v: 1,
      alsoOffDeliveryCharge: false,
      from: 'till',
      skipsNoDiscountLines: true,
    });
    expect(discountRuleScope(json)).toEqual({ alsoOffDeliveryCharge: false, skipsNoDiscountLines: true });
    // Never taken for an automatic offer.
    expect(parseOfferRule(json)).toBeNull();
  });

  it('reads back with its terms', () => {
    expect(parseVoucherRule(JSON.stringify(voucherRule(TERMS)))).toEqual(voucherRule(TERMS));
  });

  it('is not read from anything else', () => {
    expect(parseVoucherRule(null)).toBeNull();
    expect(parseVoucherRule('nope')).toBeNull();
    expect(parseVoucherRule(JSON.stringify({ kind: 'discount_base', v: 1, alsoOffDeliveryCharge: true, from: 'till' }))).toBeNull();
    expect(parseVoucherRule(JSON.stringify({ ...voucherRule(TERMS), voucher: { ...TERMS, number: 0 } }))).toBeNull();
    expect(parseVoucherRule(JSON.stringify({ ...voucherRule(TERMS), voucher: { ...TERMS, v: 2 } }))).toBeNull();
    expect(parseVoucherRule(JSON.stringify({ ...voucherRule(TERMS), voucher: { ...TERMS, coversCents: 1.5 } }))).toBeNull();
  });
});

describe('the line it comes off, and how much', () => {
  const pizza: VoucherLine = { id: 'line-pizza', menuItemName: 'Fajita Pizza — Large', quantity: 1, lineTotalCents: 189_900 };
  const drink: VoucherLine = { id: 'line-drink', menuItemName: 'Coke 500ml', quantity: 2, lineTotalCents: 30_000 };
  const deal: VoucherLine = { id: 'line-deal', menuItemName: 'Big Two Deal', quantity: 1, lineTotalCents: 299_900, noDiscount: true };
  const charge: VoucherLine = { id: 'line-charge', menuItemName: 'Delivery Charge (Rs 100)', quantity: 1, lineTotalCents: 10_000 };
  const child: VoucherLine = { id: 'line-child', menuItemName: 'Fries', quantity: 1, lineTotalCents: 40_000, parentOrderItemId: 'x' };

  it('comes off food only: never a value deal, a delivery charge, a combo\'s inside line or a free line', () => {
    expect(voucherCanCover(pizza)).toBe(true);
    expect(voucherCanCover(drink)).toBe(true);
    expect(voucherCanCover(deal)).toBe(false);
    expect(voucherCanCover(charge)).toBe(false);
    expect(voucherCanCover(child)).toBe(false);
    expect(voucherCanCover({ ...pizza, lineTotalCents: 0 })).toBe(false);
  });

  it('takes one of the line\'s items off, up to what it covers', () => {
    expect(voucherAmountCents(189_900, pizza)).toBe(189_900);
    // Two pizzas on one line: one is free.
    expect(voucherAmountCents(189_900, { ...pizza, quantity: 2, lineTotalCents: 379_800 })).toBe(189_900);
    // Extra cheese on the pizza: the voucher covers the pizza, the cheese is paid.
    expect(voucherAmountCents(189_900, { ...pizza, lineTotalCents: 214_900 })).toBe(189_900);
    // A cheaper pizza: all of it.
    expect(voucherAmountCents(189_900, { ...pizza, lineTotalCents: 149_900 })).toBe(149_900);
  });

  it('stays on its own line while it can, else moves to the dearest one of the same category; none, it comes off', () => {
    const PIZZAS = 'cat-pizza';
    const p = { ...pizza, categoryId: PIZZAS };
    const d = { ...drink, categoryId: 'cat-drinks' };
    expect(voucherLineOf('line-pizza', [d, p], PIZZAS)?.id).toBe('line-pizza');
    // The pizza was swapped for another flavour: the voucher follows the new pizza, never the drink.
    const other: VoucherLine = { id: 'line-other', menuItemName: 'Tikka Pizza — Large', quantity: 1, lineTotalCents: 189_900, categoryId: PIZZAS };
    const cheaper: VoucherLine = { ...other, id: 'line-cheap', lineTotalCents: 149_900 };
    expect(voucherLineOf('line-pizza', [d, cheaper, other], PIZZAS)?.id).toBe('line-other');
    // Only the drink (another category), a deal and a charge left: it comes off.
    expect(voucherLineOf('line-pizza', [d, deal, charge], PIZZAS)).toBeNull();
    expect(voucherLineOf('line-pizza', [], PIZZAS)).toBeNull();
    // Its category not known: it never moves.
    expect(voucherLineOf('line-pizza', [other], null)).toBeNull();
  });
});
