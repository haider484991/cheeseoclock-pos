import { describe, expect, it } from 'vitest';
import type { OrderPaperLine } from '@cheeseoclock/shared-types';
import { paperButtonLabel, paperLineText, paperTime } from './paperLabels';

/** 26 Sep 2026, Karachi wall-clock time (UTC+5). */
const pk = (h: number, m: number) => new Date(Date.UTC(2026, 8, 26, h - 5, m)).toISOString();

describe('paperButtonLabel — the print button says what it will print', () => {
  it('the first paper of an order is printed, not re-printed', () => {
    expect(paperButtonLabel({ document: 'bill', printedBefore: 0, reprintNo: 1, waiting: false })).toBe('Print bill');
    expect(paperButtonLabel({ document: 'receipt', printedBefore: 0, reprintNo: 1, waiting: false })).toBe('Print receipt');
    expect(paperButtonLabel({ document: 'void', printedBefore: 0, reprintNo: 1, waiting: false })).toBe('Print cancelled slip');
  });

  it('a later copy of the same paper is printed again', () => {
    expect(paperButtonLabel({ document: 'bill', printedBefore: 1, reprintNo: 1, waiting: false })).toBe('Print bill again');
    expect(paperButtonLabel({ document: 'receipt', printedBefore: 2, reprintNo: 2, waiting: false })).toBe('Reprint receipt');
    expect(paperButtonLabel({ document: 'void', printedBefore: 1, reprintNo: 1, waiting: false })).toBe('Print cancelled slip again');
  });

  it('a paper still waiting for the printer, and not known yet', () => {
    expect(paperButtonLabel({ document: 'receipt', printedBefore: 0, reprintNo: 1, waiting: true })).toBe('Printing…');
    expect(paperButtonLabel(null)).toBe('Print bill or receipt');
    expect(paperButtonLabel(undefined)).toBe('Print bill or receipt');
  });

  it("the till's own paper failed and nothing came since: the button sends that one again (the original)", () => {
    expect(paperButtonLabel({ document: 'receipt', printedBefore: 0, reprintNo: 1, waiting: false, failedJobId: 'j1' })).toBe(
      'Print the receipt that failed',
    );
    expect(paperButtonLabel({ document: 'bill', printedBefore: 0, reprintNo: 1, waiting: false, failedJobId: 'j1' })).toBe(
      'Print the bill that failed',
    );
    expect(paperButtonLabel({ document: 'receipt', printedBefore: 0, reprintNo: 1, waiting: false, failedJobId: null })).toBe('Print receipt');
  });
});

const line = (over: Partial<OrderPaperLine>): OrderPaperLine => ({
  at: pk(19, 35),
  document: 'receipt',
  copy: 'customer',
  label: 'Original',
  duplicate: false,
  byName: 'Ali',
  approvedByName: null,
  reason: 'payment',
  otherTill: false,
  ...over,
});

describe('paperLineText — one line of "Papers printed"', () => {
  it('the original at payment, and a reprint a manager allowed', () => {
    expect(paperLineText(line({}))).toBe('19:35 RECEIPT — Original — at payment — Ali');
    expect(
      paperLineText(
        line({ at: pk(19, 52), label: 'Reprint #1', duplicate: true, byName: 'Sana', approvedByName: 'Owner', reason: 'reprint' }),
      ),
    ).toBe('19:52 RECEIPT — DUPLICATE Reprint #1 — Sana (approved by Owner)');
  });

  it('bills, copies, shop copies, the other till and the kitchen', () => {
    expect(paperLineText(line({ document: 'bill', reason: 'dispatch' }))).toBe('19:35 BILL — Original — when the rider left — Ali');
    expect(paperLineText(line({ label: 'Copy #2', duplicate: true, reason: 'dispatch', byName: null }))).toBe(
      '19:35 RECEIPT — DUPLICATE Copy #2 — when the rider left',
    );
    expect(paperLineText(line({ copy: 'shop', otherTill: true }))).toBe('19:35 RECEIPT (shop copy) — Original — at payment — Ali (other till)');
    expect(paperLineText(line({ document: 'kitchen', copy: 'kitchen', label: 'RE-SENT', duplicate: true, reason: 'reprint' }))).toBe(
      '19:35 KITCHEN TICKET — RE-SENT — by hand — Ali',
    );
    expect(paperLineText(line({ label: 'Printed later', reason: 'reprint' }))).toBe('19:35 RECEIPT — Printed later — by hand — Ali');
    expect(paperLineText(line({ label: 'May have printed', duplicate: true }))).toContain('May have printed');
  });

  it('a paper from another day shows its date', () => {
    expect(paperTime(pk(19, 35), pk(10, 0))).toBe('19:35');
    expect(paperTime(new Date(Date.UTC(2026, 8, 27, 7, 0)).toISOString(), pk(10, 0))).toMatch(/^Sun 27 Sept? 12:00$/);
  });
});
