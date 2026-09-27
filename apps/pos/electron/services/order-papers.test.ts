/**
 * "Papers printed" in the order panel, worked out from the print log alone —
 * the owner's rule (27 Sep 2026): the paper the till prints by itself is the
 * original; every paper printed with a print button says DUPLICATE "Reprint
 * #N", the first of its kind too. Pure: made-up log rows, no database.
 */
import { describe, expect, it } from 'vitest';
import type { OrderPrintRow } from '../db/repositories/document-print-repo.js';
import { handReprintNumber, labelOrderPapers, seriesHasOriginal } from './order-papers.js';

let seq = 0;
const at = (m: number) => new Date(Date.UTC(2026, 8, 27, 14, m)).toISOString();
function row(over: Partial<OrderPrintRow>): OrderPrintRow {
  seq += 1;
  return {
    id: `p${String(seq).padStart(3, '0')}`,
    document: 'receipt',
    docKey: 'receipt',
    copy: 'customer',
    printNo: 0,
    outcome: 'printed',
    reason: 'payment',
    printJobId: `job${seq}`,
    requestedByUserId: 'u1',
    approvedByUserId: null,
    fbrIrn: null,
    createdAt: at(seq),
    deviceId: 'till-1',
    requestedByName: 'Test Cashier',
    approvedByName: null,
    ...over,
  };
}
const ctx = { legacy: () => 0, paidAt: at(0), deviceId: 'till-1' };
const labels = (rows: OrderPrintRow[]) => labelOrderPapers(rows, ctx).map((p) => [p.document, p.label, p.duplicate]);

describe('the number a hand press carries', () => {
  it('counts the papers before it, plus one when none of them was the original', () => {
    expect(handReprintNumber([], 0)).toBe(1);
    const original = row({ printNo: 0 });
    expect(seriesHasOriginal([original], 0)).toBe(true);
    expect(handReprintNumber([original], 0)).toBe(1);
    const firstByHand = row({ printNo: 1, reason: 'reprint' });
    expect(seriesHasOriginal([firstByHand], 0)).toBe(false);
    expect(handReprintNumber([firstByHand], 0)).toBe(2);
    // A paper the version before the log printed counts as the original.
    expect(handReprintNumber([], 1)).toBe(1);
    // A press the printer fumbled is one paper.
    const tryA = row({ printNo: 1, reason: 'reprint', printJobId: 'same', outcome: 'unsure' });
    const tryB = row({ printNo: 1, reason: 'reprint', printJobId: 'same' });
    expect(handReprintNumber([original, tryA, tryB], 0)).toBe(2);
  });
});

describe('Papers printed', () => {
  it('the till prints the original; every hand press is a DUPLICATE Reprint #N', () => {
    expect(
      labels([
        row({ printNo: 0, reason: 'payment' }),
        row({ printNo: 1, reason: 'reprint' }),
        row({ printNo: 2, reason: 'reprint', approvedByUserId: 'u2', approvedByName: 'Test Manager' }),
      ]),
    ).toEqual([
      ['receipt', 'Original', false],
      ['receipt', 'Reprint #1', true],
      ['receipt', 'Reprint #2', true],
    ]);
  });

  it('a first bill by hand is Reprint #1; the dispatch paper the till prints after it is the Original; a bill and a receipt are separate', () => {
    expect(
      labels([
        row({ document: 'bill', docKey: 'bill', printNo: 1, reason: 'reprint' }),
        row({ document: 'bill', docKey: 'bill', printNo: 1, reason: 'reprint' }),
        row({ document: 'bill', docKey: 'bill', printNo: 0, reason: 'dispatch' }),
        row({ document: 'bill', docKey: 'bill', printNo: 3, reason: 'reprint' }),
        row({ printNo: 1, reason: 'reprint' }),
      ]),
    ).toEqual([
      ['bill', 'Reprint #1', true],
      ['bill', 'Reprint #2', true],
      ['bill', 'Original', false],
      ['bill', 'Reprint #3', true],
      ['receipt', 'Reprint #1', true],
    ]);
  });

  it('a retry after the printer failed mid-way, a second automatic copy, and a paper that may have printed', () => {
    const job = 'job-retry';
    expect(
      labels([
        row({ printNo: 0, reason: 'payment', printJobId: job, outcome: 'unsure' }),
        row({ printNo: 1, reason: 'payment', printJobId: job }),
        row({ printNo: 2, reason: 'dispatch' }),
      ]),
    ).toEqual([
      ['receipt', 'May have printed', false],
      ['receipt', 'Printer retry', true],
      // The fumbled job was one paper: this is the second.
      ['receipt', 'Copy #2', true],
    ]);
  });

  it('a paper printed before the rule (v0.7.19 and older) keeps what it said: "Printed later" for a first receipt printed by hand long after', () => {
    const old = row({ printNo: 0, reason: 'reprint', createdAt: new Date(Date.parse(at(0)) + 90 * 60_000).toISOString() });
    expect(labelOrderPapers([old], ctx)[0]).toMatchObject({ label: 'Printed later', duplicate: false });
    // …and the hand press after it counts it as the original.
    expect(labelOrderPapers([old, row({ printNo: 1, reason: 'reprint', createdAt: new Date(Date.parse(at(0)) + 95 * 60_000).toISOString() })], ctx)[1]).toMatchObject({
      label: 'Reprint #1',
    });
  });

  it('kitchen tickets say REPRINT / RE-SENT; the other till is named; each shop copy is its own series', () => {
    const lines = labelOrderPapers(
      [
        row({ document: 'kitchen', docKey: 'kitchen', copy: 'kitchen', printNo: 0, reason: 'auto' }),
        row({ document: 'kitchen', docKey: 'kitchen', copy: 'kitchen', printNo: 1, reason: 'reprint' }),
        row({ copy: 'shop', printNo: 0, reason: 'payment', deviceId: 'till-2' }),
        row({ copy: 'shop', printNo: 1, reason: 'reprint' }),
      ],
      ctx,
    );
    expect(lines.map((p) => [p.copy, p.label, p.otherTill])).toEqual([
      ['kitchen', 'Original', false],
      ['kitchen', 'Reprint #1', false],
      ['shop', 'Original', true],
      ['shop', 'Reprint #1', false],
    ]);
  });
});
