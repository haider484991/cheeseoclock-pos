import { describe, expect, it } from 'vitest';
import { parseVoucherList } from '@cheeseoclock/pos-domain';
import type { VoucherRow } from '@cheeseoclock/shared-types';
import {
  batchCountWords,
  batchNumbersWords,
  batchTermsWords,
  pastedListWords,
  rupeesToCents,
  voucherListText,
  voucherMatches,
} from './voucherPageWords';
import { voucherCheckWords, voucherLineWords } from '../checkout/voucherWords';

const row = (number: number, code: string, orderNumber: string | null = null): VoucherRow => ({
  id: `v${number}`,
  number,
  code,
  state: orderNumber ? 'used' : 'not_used',
  use: orderNumber
    ? {
        orderId: 'o1',
        orderNumber,
        at: '2026-10-14T10:00:00.000Z',
        paidAt: '2026-10-14T10:05:00.000Z',
        refunded: false,
        item: 'Fajita Pizza — Large',
        amountCents: 189_900,
        staffName: 'Ali',
        customerName: null,
        customerPhone: null,
      }
    : null,
  alsoOn: [],
});

describe('the Vouchers page in words', () => {
  it('says how many are used, on an order and not used — the order line only when there is one', () => {
    expect(batchCountWords({ count: 100, used: 37, onOrder: 1, notUsed: 62 })).toBe('37 of 100 used · 1 on an order not paid yet · 62 not used');
    expect(batchCountWords({ count: 100, used: 0, onOrder: 0, notUsed: 100 })).toBe('0 of 100 used · 100 not used');
  });

  it('names the numbers as printed, and what one covers until when', () => {
    expect(batchNumbersWords({ firstNumber: 1, lastNumber: 100 })).toBe('No. 001–100');
    expect(batchNumbersWords({ firstNumber: 7, lastNumber: 7 })).toBe('No. 007');
    expect(batchNumbersWords({ firstNumber: null, lastNumber: null })).toBe('');
    expect(batchTermsWords({ coversCents: 189_900, goodUntil: null })).toBe('Covers up to Rs 1,899 · no end date');
    expect(batchTermsWords({ coversCents: 189_900, goodUntil: '2026-12-31' })).toBe('Covers up to Rs 1,899 · until 31/12/2026');
  });

  it('copies the list as printed, one a line — which the Add vouchers box reads back', () => {
    const text = voucherListText([row(1, 'MF7U'), row(2, 'EQW6'), row(100, 'EJD3')]);
    expect(text).toBe('001 MF7U\n002 EQW6\n100 EJD3');
    expect(parseVoucherList(text).vouchers).toEqual([
      { number: 1, code: 'MF7U' },
      { number: 2, code: 'EQW6' },
      { number: 100, code: 'EJD3' },
    ]);
  });

  it('finds a voucher by its number (with or without zeros), its code, or the order it was used on', () => {
    const used = row(12, 'Q7TR', '20261014-0042');
    expect(voucherMatches(used, '12')).toBe(true);
    expect(voucherMatches(used, '012')).toBe(true);
    expect(voucherMatches(used, 'No. 12')).toBe(true);
    expect(voucherMatches(used, 'q7t')).toBe(true);
    expect(voucherMatches(used, '#0042')).toBe(true);
    expect(voucherMatches(used, '13')).toBe(false);
    expect(voucherMatches(row(13, 'ADD9'), 'Q7')).toBe(false);
    expect(voucherMatches(row(13, 'ADD9'), '  ')).toBe(true);
  });

  it('reads a pasted list back to the owner: how many, which numbers, what is wrong, what was left out', () => {
    expect(pastedListWords(parseVoucherList(''))).toEqual({
      summary: 'Paste the list: one voucher a line, its number then its code (001 MF7U).',
      problems: [],
      skipped: null,
    });
    expect(pastedListWords(parseVoucherList('NO. CODE DATE\n001 MF7U\n002 EQW6\n002 AAAA\n003 MF7U'))).toEqual({
      summary: '4 vouchers read · No. 001–003',
      problems: ['On the list twice: No. 002', 'The same code twice: MF7U'],
      skipped: '1 line left out (not a number and a code): “NO. CODE DATE”',
    });
  });

  it('reads rupees as typed', () => {
    expect(rupeesToCents('1899')).toBe(189_900);
    expect(rupeesToCents('1,899.50')).toBe(189_950);
    expect(rupeesToCents('Rs 1899')).toBe(189_900);
    expect(rupeesToCents('0')).toBeNull();
    expect(rupeesToCents('abc')).toBeNull();
  });
});

describe('the till’s words for a typed voucher', () => {
  const batch = {
    id: 'b1',
    name: 'abhi',
    gives: 'One Large pizza from the Regular menu',
    coversCents: 189_900,
    goodUntil: null,
    createdAt: '2026-10-12T00:00:00.000Z',
    createdByName: 'Owner',
  };

  it('a voucher that can be used: its number, whose, what it gets and covers', () => {
    expect(voucherCheckWords({ ok: true, voucherId: 'v1', number: 1, code: 'MF7U', batch })).toEqual({
      ok: true,
      title: 'Voucher No. 001 · abhi',
      detail: 'One Large pizza from the Regular menu · covers up to Rs 1,899',
    });
    expect(voucherCheckWords({ ok: true, voucherId: 'v1', number: 1, code: 'MF7U', batch: { ...batch, goodUntil: '2026-12-31' } }).detail).toBe(
      'One Large pizza from the Regular menu · covers up to Rs 1,899 · until 31/12/2026',
    );
  });

  it('one that can’t: the main process’s own words', () => {
    expect(voucherCheckWords({ ok: false, problem: 'used', message: 'Voucher No. 001 was already used: order #0042 on 14/10/2026 15:05.' })).toEqual({
      ok: false,
      title: 'Voucher No. 001 was already used: order #0042 on 14/10/2026 15:05.',
      detail: null,
    });
  });

  it('lists a line by its name, and one of several on a line by its price each', () => {
    expect(voucherLineWords({ menuItemName: 'Fajita Pizza — Large', quantity: 1, lineTotalCents: 189_900 })).toBe('Fajita Pizza — Large');
    expect(voucherLineWords({ menuItemName: 'Fajita Pizza — Large', quantity: 2, lineTotalCents: 379_800 })).toBe(
      '2× Fajita Pizza — Large (Rs 1,899 each)',
    );
  });
});
