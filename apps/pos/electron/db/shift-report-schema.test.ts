/**
 * The shift report saved at Close shift (shared-types ShiftReport; stored in
 * shifts.close_report_json, migration 0051), read side: parseShiftReportJson
 * (shared-schemas) and the nine section switches the owner chose (owner,
 * 2 Oct 2026: "all orders and totals also add seetngs so we can customize").
 *
 *   - a saved report with its orders list reads as it was, and a newer
 *     till's extra key (at the top, in a section, in a row) is dropped;
 *   - a report of a newer shape (v 2) reads as { newer: true }, so the till
 *     can say so instead of printing figures it may not understand;
 *   - nothing, empty, not JSON, a bare { v: 1 } or a figure of the wrong
 *     kind reads as null, and nothing throws;
 *   - the one writer (pos-domain shiftReportJson) writes the sample as the
 *     text that reads back as it was;
 *   - SHIFT_REPORT_SECTIONS holds the nine sections in the owner's order with
 *     his words.
 *
 * shared-schemas has no test runner and pos-domain must not import it, so
 * this lives here as a plain describe that needs no database. The figures
 * are made up and add up (the repository is public).
 */
import { describe, expect, it } from 'vitest';
import { shiftReportJson } from '@cheeseoclock/pos-domain';
import { parseShiftReportJson, SHIFT_REPORT_MAX_ROWS, shiftReportSchema } from '@cheeseoclock/shared-schemas';
import { SHIFT_REPORT_SECTIONS, SHIFT_REPORT_VERSION, type ShiftReport } from '@cheeseoclock/shared-types';

/**
 * A small made-up night: four orders paid (a takeaway in cash refunded in
 * full, a delivery sent out with an outside rider and settled by EasyPaisa
 * with his fee in cash, a split cash + card takeaway part refunded, a
 * foodpanda order), one cancel, a float of Rs 5,000 and the drawer counted
 * by note, Rs 10 short.
 */
const REPORT: ShiftReport = {
  v: 1,
  shiftId: 's_test_1',
  deviceId: 'till-test-1',
  tillName: 'Front till',
  shopName: 'Test Shop',
  openedAt: '2026-10-01T11:00:00.000Z',
  closedAt: '2026-10-01T20:30:00.000Z',
  openedBy: 'Test Cashier',
  closedBy: 'Test Manager',
  pinOnLoginOf: 'Test Cashier',
  sales: {
    orderCount: 4,
    foodCents: 800_000,
    delivery: { orderCount: 1, cents: 20_000 },
    discounts: [
      { kind: 'foodpanda', orderCount: 1, cents: 20_000 },
      { kind: 'staff', orderCount: 1, cents: 10_000 },
    ],
    taxCents: 118_500,
    taxRateBps: 1500,
    billedCents: 908_500,
    refunds: { orderCount: 2, cents: 230_000 },
    netCents: 678_500,
    averageCents: 227_125,
  },
  payments: [
    { method: 'cash', orderCount: 3, cents: 400_000 },
    { method: 'card', orderCount: 1, cents: 100_000 },
    { method: 'easypaisa', orderCount: 1, cents: 232_000 },
    { method: 'foodpanda', orderCount: 1, cents: 176_500 },
  ],
  paymentRefunds: [
    { method: 'cash', orderCount: 1, cents: 172_500 },
    { method: 'card', orderCount: 1, cents: 57_500 },
  ],
  moneyTakenCents: 678_500,
  partPaymentsCents: 0,
  channels: [
    { channel: 'takeaway', orderCount: 2, billedCents: 480_000, outside: null },
    { channel: 'delivery', orderCount: 1, billedCents: 252_000, outside: { orderCount: 1, billedCents: 252_000 } },
    { channel: 'foodpanda', orderCount: 1, billedCents: 176_500, outside: null },
  ],
  cancelled: [{ orderNumber: '20261001-0005', at: '2026-10-01T15:14:00.000Z', cents: 207_000, made: 'made', reason: 'Customer left' }],
  refunds: [
    { orderNumber: '20261001-0001', at: '2026-10-01T17:05:00.000Z', method: 'cash', cents: 172_500, full: true, reason: 'Cold pizza' },
    { orderNumber: '20261001-0003', at: '2026-10-01T18:40:00.000Z', method: 'card', cents: 57_500, full: false, reason: null },
  ],
  drawer: {
    openingCents: 500_000,
    cashSalesCents: 400_000,
    cashRefundsCents: 172_500,
    cashIn: { count: 1, cents: 200_000 },
    cashOut: { count: 2, cents: 30_000 },
    riderTips: { count: 1, cents: 10_000 },
    riderKept: { count: 1, cents: 20_000, tripCount: 0 },
    otherCents: 0,
    expectedCents: 877_500,
    countedCents: 876_500,
    varianceCents: -1_000,
    countedNotes: {
      notes: [
        { faceCents: 500_000, count: 1 },
        { faceCents: 100_000, count: 3 },
        { faceCents: 50_000, count: 1 },
        { faceCents: 10_000, count: 2 },
        { faceCents: 5_000, count: 1 },
        { faceCents: 2_000, count: 0 },
        { faceCents: 1_000, count: 1 },
      ],
      otherCents: 500,
    },
  },
  unpaid: {
    orders: [{ orderNumber: '20261001-0006', at: '2026-10-01T20:12:00.000Z', takenBy: 'Website', cents: 159_000 }],
    reason: 'Rider still out',
  },
  items: [
    {
      category: 'Pizza',
      quantity: 3,
      cents: 600_000,
      items: [
        { name: 'Test Pizza - Large', quantity: 2, cents: 440_000 },
        { name: 'Test Pizza - Medium', quantity: 1, cents: 160_000 },
      ],
    },
    { category: 'No category', quantity: 2, cents: 200_000, items: [{ name: 'Test Burger', quantity: 2, cents: 200_000 }] },
  ],
  orders: [
    {
      orderNumber: '20261001-0001',
      paidAt: '2026-10-01T11:20:00.000Z',
      channel: 'takeaway',
      outside: false,
      methods: ['cash'],
      totalCents: 172_500,
      refunded: 'full',
    },
    {
      orderNumber: '20261001-0002',
      paidAt: '2026-10-01T12:41:00.000Z',
      channel: 'delivery',
      outside: true,
      methods: ['easypaisa', 'cash'],
      totalCents: 252_000,
      refunded: 'no',
    },
    {
      orderNumber: '20261001-0003',
      paidAt: '2026-10-01T13:05:00.000Z',
      channel: 'takeaway',
      outside: false,
      methods: ['cash', 'card'],
      totalCents: 307_500,
      refunded: 'part',
    },
    {
      orderNumber: '20261001-0004',
      paidAt: '2026-10-01T14:22:00.000Z',
      channel: 'foodpanda',
      outside: false,
      methods: ['foodpanda'],
      totalCents: 176_500,
      refunded: 'no',
    },
  ],
};

/** The report as saved: plain JSON text. */
const TEXT = JSON.stringify(REPORT);

/** The report's JSON with `edit` applied to a copy of it. */
function edited(edit: (r: Record<string, unknown> & ShiftReport) => void): string {
  const copy = JSON.parse(TEXT) as Record<string, unknown> & ShiftReport;
  edit(copy);
  return JSON.stringify(copy);
}

describe('parseShiftReportJson (reads the saved report, never throws)', () => {
  it('the sample adds up the way the paper will print it', () => {
    // Guards on the sample itself, so the reads below are of a report that could be real.
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    expect(REPORT.orders).toHaveLength(REPORT.sales.orderCount);
    expect(sum(REPORT.orders.map((o) => o.totalCents))).toBe(REPORT.sales.billedCents);
    expect(sum(REPORT.channels.map((c) => c.billedCents))).toBe(REPORT.sales.billedCents);
    expect(REPORT.sales.netCents).toBe(REPORT.sales.billedCents - REPORT.sales.refunds.cents);
    expect(REPORT.moneyTakenCents).toBe(sum(REPORT.payments.map((p) => p.cents)) - sum(REPORT.paymentRefunds.map((p) => p.cents)));
    expect(sum(REPORT.items.map((c) => c.cents))).toBe(REPORT.sales.foodCents);
    const d = REPORT.drawer;
    expect(d.openingCents + d.cashSalesCents - d.cashRefundsCents + d.cashIn.cents - d.cashOut.cents - d.riderKept.cents + d.otherCents).toBe(
      d.expectedCents,
    );
    const notes = d.countedNotes;
    expect(notes && sum(notes.notes.map((n) => n.faceCents * n.count)) + notes.otherCents).toBe(d.countedCents);
    expect(d.countedCents - d.expectedCents).toBe(d.varianceCents);
  });

  it('a saved report with its orders list reads as it was', () => {
    expect(parseShiftReportJson(TEXT)).toEqual({ report: REPORT });
    const read = parseShiftReportJson(TEXT);
    expect(read && 'report' in read ? read.report.orders.map((o) => [o.orderNumber, o.methods, o.refunded]) : null).toEqual([
      ['20261001-0001', ['cash'], 'full'],
      ['20261001-0002', ['easypaisa', 'cash'], 'no'],
      ['20261001-0003', ['cash', 'card'], 'part'],
      ['20261001-0004', ['foodpanda'], 'no'],
    ]);
    // Its keys come back in the type's order (the paper's order).
    expect(read && 'report' in read ? Object.keys(read.report) : null).toEqual(Object.keys(REPORT));
  });

  it('a newer till’s extra keys are dropped, at the top, in a section and in a row', () => {
    const text = edited((r) => {
      r['dayReport'] = { tills: 2 };
      (r.sales as unknown as Record<string, unknown>)['tipsCents'] = 500;
      (r.orders[1] as unknown as Record<string, unknown>)['riderName'] = 'Test Rider';
      (r.drawer.countedNotes as unknown as Record<string, unknown>)['by'] = 'Test Manager';
    });
    expect(parseShiftReportJson(text)).toEqual({ report: REPORT });
  });

  it('a shift counted as one figure (no note count), with no cancels, refunds or unpaid orders, reads too', () => {
    const text = edited((r) => {
      r.drawer.countedNotes = null;
      r.pinOnLoginOf = null;
      r.sales.taxRateBps = null;
      r.cancelled = [];
      r.refunds = [];
      r.unpaid = { orders: [], reason: null };
    });
    const read = parseShiftReportJson(text);
    expect(read && 'report' in read ? read.report.drawer.countedNotes : 'not read').toBeNull();
    expect(read && 'report' in read ? [read.report.pinOnLoginOf, read.report.cancelled, read.report.unpaid] : null).toEqual([
      null,
      [],
      { orders: [], reason: null },
    ]);
  });

  it('a report a newer till made (v 2) reads as { newer: true }, whatever else it holds', () => {
    expect(SHIFT_REPORT_VERSION).toBe(1);
    expect(parseShiftReportJson(edited((r) => ((r as unknown as Record<string, unknown>)['v'] = 2)))).toEqual({ newer: true });
    expect(parseShiftReportJson('{"v":2}')).toEqual({ newer: true });
    expect(parseShiftReportJson('{"v":7,"orders":"a new shape"}')).toEqual({ newer: true });
  });

  it('nothing, empty, not JSON, a bare { v: 1 } or a shape it cannot read: null', () => {
    expect(parseShiftReportJson(null)).toBeNull();
    expect(parseShiftReportJson(undefined)).toBeNull();
    expect(parseShiftReportJson('')).toBeNull();
    expect(parseShiftReportJson('not json')).toBeNull();
    expect(parseShiftReportJson('{"v":1}')).toBeNull();
    expect(parseShiftReportJson('null')).toBeNull();
    expect(parseShiftReportJson('[]')).toBeNull();
    expect(parseShiftReportJson('1')).toBeNull();
    expect(parseShiftReportJson('"{}"')).toBeNull();
    expect(parseShiftReportJson('{}')).toBeNull();
    // A version that is not a whole number above 1 is not a newer report.
    expect(parseShiftReportJson(edited((r) => ((r as unknown as Record<string, unknown>)['v'] = 0)))).toBeNull();
    expect(parseShiftReportJson(edited((r) => ((r as unknown as Record<string, unknown>)['v'] = '2')))).toBeNull();
    expect(parseShiftReportJson(edited((r) => ((r as unknown as Record<string, unknown>)['v'] = 1.5)))).toBeNull();
  });

  it('a figure of the wrong kind is not read: paisa as a fraction, a count below 0, an unknown channel or flag, a missing list', () => {
    expect(parseShiftReportJson(edited((r) => (r.sales.billedCents = 908_500.5)))).toBeNull();
    expect(parseShiftReportJson(edited((r) => (r.sales.orderCount = -1)))).toBeNull();
    expect(parseShiftReportJson(edited((r) => (r.orders[0]!.totalCents = Number.NaN)))).toBeNull();
    expect(parseShiftReportJson(edited((r) => ((r.orders[0] as unknown as Record<string, unknown>)['refunded'] = 'yes')))).toBeNull();
    expect(parseShiftReportJson(edited((r) => ((r.orders[0] as unknown as Record<string, unknown>)['channel'] = 'drive_through')))).toBeNull();
    expect(parseShiftReportJson(edited((r) => ((r.cancelled[0] as unknown as Record<string, unknown>)['made'] = 'yes')))).toBeNull();
    expect(parseShiftReportJson(edited((r) => delete (r as Partial<ShiftReport>).orders))).toBeNull();
    expect(parseShiftReportJson(edited((r) => ((r.drawer as unknown as Record<string, unknown>)['expectedCents'] = '877500')))).toBeNull();
    // A note count the lenient count reader refuses (a row counted twice) is not read either.
    expect(
      parseShiftReportJson(
        edited((r) => {
          r.drawer.countedNotes = { notes: [{ faceCents: 1_000, count: 1 }, { faceCents: 1_000, count: 2 }], otherCents: 0 };
        }),
      ),
    ).toBeNull();
  });

  it('a negative figure where one can be negative reads: short, other drawer changes, part payments', () => {
    const text = edited((r) => {
      r.drawer.otherCents = -2_000;
      r.drawer.expectedCents = 875_500;
      r.drawer.varianceCents = 1_000;
      r.partPaymentsCents = -50_000;
    });
    const read = parseShiftReportJson(text);
    expect(read && 'report' in read ? [read.report.drawer.otherCents, read.report.drawer.varianceCents, read.report.partPaymentsCents] : null).toEqual([
      -2_000, 1_000, -50_000,
    ]);
  });

  it('every list holds at most 5,000 rows: the orders list at 5,000 reads, at 5,001 it does not', () => {
    expect(SHIFT_REPORT_MAX_ROWS).toBe(5_000);
    const row = REPORT.orders[3]!;
    const many = (n: number) => edited((r) => (r.orders = Array.from({ length: n }, () => row)));
    const read = parseShiftReportJson(many(5_000));
    expect(read && 'report' in read ? read.report.orders.length : 0).toBe(5_000);
    expect(parseShiftReportJson(many(5_001))).toBeNull();
    expect(shiftReportSchema.safeParse(JSON.parse(many(5_001))).success).toBe(false);
  });

  it('keeps no cost, waste, commission or profit figure: such keys are dropped', () => {
    const text = edited((r) => {
      const top = r as Record<string, unknown>;
      top['foodCostCents'] = 300_000;
      top['profitCents'] = 400_000;
      (r.sales as unknown as Record<string, unknown>)['commissionCents'] = 5_000;
      (r.items[0] as unknown as Record<string, unknown>)['wasteCents'] = 1_000;
    });
    const json = JSON.stringify(parseShiftReportJson(text));
    expect(/cost|profit|commission|waste/i.test(json)).toBe(false);
  });
});

describe('the writer and the reader agree (pos-domain shiftReportJson, the only writer)', () => {
  it('the stored text of the sample is the sample as JSON, and it reads back as it was, keys in the same order', () => {
    expect(shiftReportJson(REPORT)).toBe(TEXT);
    const read = parseShiftReportJson(shiftReportJson(REPORT));
    expect(read).toEqual({ report: REPORT });
    expect(read && 'report' in read ? shiftReportJson(read.report) : null).toBe(TEXT);
  });

  it('a report read back with a newer till’s extra keys is written again without them', () => {
    const read = parseShiftReportJson(
      edited((r) => {
        (r as Record<string, unknown>)['dayReport'] = { tills: 2 };
        (r.drawer as unknown as Record<string, unknown>)['floatTopUpCents'] = 1_000;
      }),
    );
    expect(read && 'report' in read ? shiftReportJson(read.report) : null).toBe(TEXT);
  });
});

describe('the section switches (Settings → Printers → Shift report)', () => {
  it('nine sections, in the owner’s order, with his words', () => {
    expect(SHIFT_REPORT_SECTIONS.map((s) => [s.key, s.label])).toEqual([
      ['sales', 'Sales'],
      ['moneyTaken', 'Money taken'],
      ['channels', 'By channel'],
      ['cancelsRefunds', 'Cancelled and refunded'],
      ['drawer', 'Cash drawer'],
      ['counted', 'Cash counted'],
      ['unpaid', 'Unpaid carried over'],
      ['items', 'Items sold'],
      ['orders', 'All orders'],
    ]);
    expect(new Set(SHIFT_REPORT_SECTIONS.map((s) => s.key)).size).toBe(9);
  });
});
