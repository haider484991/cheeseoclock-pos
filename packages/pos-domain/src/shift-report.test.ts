import { describe, expect, it } from 'vitest';
import type { CashCount, ShiftReport } from '@cheeseoclock/shared-types';
import {
  buildShiftReport,
  shiftReportDiscountKind,
  shiftReportDrawerAddsUp,
  shiftReportJson,
  type ShiftReportDrawerFacts,
  type ShiftReportFacts,
  type ShiftReportFactsLine,
  type ShiftReportFactsOrder,
  type ShiftReportFactsPayment,
  type ShiftReportFactsRefund,
} from './shift-report.js';
import { SAMPLE_NIGHT, SAMPLE_NIGHT_CATEGORIES } from './shift-report.fixture.js';

/**
 * The shift report's builder: SALES, MONEY TAKEN, BY CHANNEL, the cancels
 * and refunds, the CASH DRAWER and the unpaid list (step 19c-2), ITEMS SOLD
 * and the ORDERS list (step 19c-3), worked out from the facts the till reads
 * at the close; and the one writer of the stored text. The busy night of the
 * sample paper is shift-report.fixture.ts.
 * Made-up names and figures (the repository is public); 15% tax throughout.
 */

const HEADER = {
  shiftId: 's_test_1',
  deviceId: 'till-test-1',
  tillName: 'Front till',
  shopName: 'Test Shop',
  openedAt: '2026-10-01T11:00:00.000Z',
  closedAt: '2026-10-01T20:30:00.000Z',
  openedBy: 'Test Cashier',
  closedBy: 'Test Manager',
  pinOnLoginOf: 'Test Cashier',
} as const;

const NONE = { count: 0, cents: 0 };

/** A drawer with only the float in it. */
const FLOAT_ONLY: ShiftReportDrawerFacts = {
  openingCents: 500_000,
  cashSalesCents: 0,
  cashRefundsCents: 0,
  cashIn: NONE,
  payouts: NONE,
  tips: NONE,
  riderKept: { count: 0, cents: 0, tripCount: 0 },
  expectedCents: 500_000,
  countedCents: 500_000,
  varianceCents: 0,
  countedNotes: null,
};

function facts(over: Partial<ShiftReportFacts> = {}): ShiftReportFacts {
  return {
    ...HEADER,
    settled: [],
    lines: [],
    payments: [],
    refunds: [],
    cancelled: [],
    drawer: FLOAT_ONLY,
    unpaid: { orders: [], reason: null },
    ...over,
  };
}

/**
 * A settled order priced the till's way: subtotal = food + delivery charge,
 * tax = 15% of (subtotal − discount), total = subtotal − discount + tax.
 */
function sale(
  id: string,
  foodCents: number,
  o: Partial<ShiftReportFactsOrder> & { chargeCents?: number } = {},
): ShiftReportFactsOrder {
  const { chargeCents = 0, ...rest } = o;
  const discount = rest.discountCents ?? 0;
  const subtotal = foodCents + chargeCents;
  const tax = Math.round((subtotal - discount) * 0.15);
  return {
    id,
    orderNumber: `20261001-${id}`,
    channel: 'takeaway',
    outside: false,
    subtotalCents: subtotal,
    discountCents: discount,
    taxCents: tax,
    totalCents: subtotal - discount + tax,
    deliveryChargeCents: chargeCents,
    discountKind: null,
    paidAt: '2026-10-01T12:00:00.000Z',
    status: 'paid',
    methods: [],
    hasRefund: false,
    ...rest,
  };
}

function line(orderId: string, name: string, lineTotalCents: number, taxRateBps = 1500): ShiftReportFactsLine {
  return { orderId, menuItemId: `mi_${name}`, name, categoryName: 'Pizza', categoryRank: 0, quantity: 1, lineTotalCents, taxRateBps };
}

function pay(orderId: string, method: string, cents: number): ShiftReportFactsPayment {
  return { orderId, method, cents };
}

function refund(o: ShiftReportFactsOrder, method: string, cents: number, full: boolean, reason: string | null = null): ShiftReportFactsRefund {
  return { orderId: o.id, orderNumber: o.orderNumber, at: '2026-10-01T18:00:00.000Z', method, cents, full, reason };
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

// -----------------------------------------------------------------------------
// A small night, every figure worked out by hand
// -----------------------------------------------------------------------------

/** A takeaway in cash. 2,000 + 300 tax = 2,300. */
const O1 = sale('0001', 200_000, { methods: ['cash'] });
/** A delivery by the shop's own rider in cash, Rs 200 staff discount: 3,000 + 200 − 200 + 450 = 3,450. */
const O2 = sale('0002', 300_000, { channel: 'delivery', chargeCents: 20_000, discountCents: 20_000, discountKind: 'staff', methods: ['cash'] });
/** A delivery sent out with an outside rider, settled by EasyPaisa (his Rs 200 in cash): 2,000 + 200 + 330 = 2,530. */
const O3 = sale('0003', 200_000, { channel: 'delivery', chargeCents: 20_000, outside: true, methods: ['easypaisa', 'cash'] });
/** A website delivery sent out with an outside rider, in cash: 1,000 + 200 + 180 = 1,380. */
const O4 = sale('0004', 100_000, { channel: 'web_delivery', chargeCents: 20_000, outside: true, methods: ['cash'] });
/** A website pick-up with its Rs 100 pick-up discount, by card: 1,000 − 100 + 135 = 1,035. */
const O5 = sale('0005', 100_000, { channel: 'web_pickup', discountCents: 10_000, discountKind: 'website', methods: ['card'] });
/** A foodpanda order with the foodpanda deal (Rs 400 off): 2,000 − 400 + 240 = 1,840. */
const O6 = sale('0006', 200_000, { channel: 'foodpanda', discountCents: 40_000, discountKind: 'foodpanda', methods: ['foodpanda'] });
/** A takeaway with an automatic offer (Rs 100 off), in cash, refunded in full: 1,100 − 100 + 150 = 1,150. */
const O7 = sale('0007', 110_000, { discountCents: 10_000, discountKind: 'offer', methods: ['cash'], status: 'refunded', hasRefund: true });
/** A takeaway paid Rs 500 cash + Rs 650 card, Rs 230 handed back on the card: 1,000 + 150 = 1,150. */
const O8 = sale('0008', 100_000, { methods: ['card', 'cash'], hasRefund: true });

const COUNT: CashCount = {
  notes: [
    { faceCents: 500_000, count: 2 },
    { faceCents: 100_000, count: 3 },
    { faceCents: 50_000, count: 1 },
    { faceCents: 10_000, count: 3 },
    { faceCents: 5_000, count: 0 },
    { faceCents: 2_000, count: 0 },
    { faceCents: 1_000, count: 0 },
  ],
  otherCents: 2_000,
};

/** The facts as the till might read them: in no particular order. */
const NIGHT: ShiftReportFacts = facts({
  settled: [O6, O4, O1, O8, O3, O7, O2, O5],
  lines: [
    line('0001', 'Test Pizza - Large', 200_000),
    line('0002', 'Test Pizza - Medium', 150_000),
    line('0002', 'Test Burger', 150_000),
    line('0003', 'Test Pizza - Large', 200_000),
    line('0004', 'Test Burger', 100_000),
    line('0005', 'Test Burger', 100_000),
    line('0006', 'Test Pizza - Large', 200_000),
    line('0007', 'Test Fries', 110_000),
    line('0008', 'Test Burger', 100_000),
  ],
  payments: [
    pay('0006', 'foodpanda', 184_000),
    pay('0008', 'card', 65_000),
    pay('0003', 'easypaisa', 233_000),
    pay('0001', 'cash', 230_000),
    pay('0007', 'cash', 115_000),
    pay('0002', 'cash', 345_000),
    pay('0003', 'cash', 20_000),
    pay('0004', 'cash', 138_000),
    pay('0005', 'card', 103_500),
    pay('0008', 'cash', 50_000),
    pay('0007', 'cash', -115_000),
    pay('0008', 'card', -23_000),
  ],
  refunds: [refund(O7, 'cash', 115_000, true, 'Cold pizza'), refund(O8, 'card', 23_000, false)],
  cancelled: [
    { orderNumber: '20261001-0009', at: '2026-10-01T15:14:00.000Z', cents: 207_000, made: 'made', reason: 'Customer left' },
    { orderNumber: '20261001-0011', at: '2026-10-01T19:40:00.000Z', cents: 138_000, made: 'not_made', reason: null },
  ],
  drawer: {
    openingCents: 500_000,
    // Cash in: 2,300 + 3,450 + 200 + 1,380 + 1,150 + 500.
    cashSalesCents: 898_000,
    cashRefundsCents: 115_000,
    cashIn: { count: 1, cents: 200_000 },
    payouts: { count: 1, cents: 50_000 },
    tips: { count: 2, cents: 10_000 },
    riderKept: { count: 2, cents: 40_000, tripCount: 0 },
    // The close's own sum: 5,000 + 8,980 − 1,150 + 2,000 − (500 + 400 + 100).
    expectedCents: 1_383_000,
    countedCents: 1_382_000,
    varianceCents: -1_000,
    countedNotes: COUNT,
  },
  unpaid: {
    orders: [{ orderNumber: '20261001-0010', createdAt: '2026-10-01T20:12:00.000Z', totalCents: 159_000, takenBy: 'Website' }],
    reason: 'Rider still out',
  },
});

const NIGHT_REPORT: ShiftReport = {
  v: 1,
  ...HEADER,
  sales: {
    orderCount: 8,
    foodCents: 1_310_000,
    delivery: { orderCount: 3, cents: 60_000 },
    discounts: [
      { kind: 'foodpanda', orderCount: 1, cents: 40_000 },
      { kind: 'staff', orderCount: 1, cents: 20_000 },
      { kind: 'website', orderCount: 1, cents: 10_000 },
      { kind: 'offer', orderCount: 1, cents: 10_000 },
    ],
    taxCents: 193_500,
    taxRateBps: 1500,
    billedCents: 1_483_500,
    refunds: { orderCount: 2, cents: 138_000 },
    netCents: 1_345_500,
    averageCents: 185_438,
  },
  payments: [
    { method: 'cash', orderCount: 6, cents: 898_000 },
    { method: 'card', orderCount: 2, cents: 168_500 },
    { method: 'easypaisa', orderCount: 1, cents: 233_000 },
    { method: 'foodpanda', orderCount: 1, cents: 184_000 },
  ],
  paymentRefunds: [
    { method: 'cash', orderCount: 1, cents: 115_000 },
    { method: 'card', orderCount: 1, cents: 23_000 },
  ],
  moneyTakenCents: 1_345_500,
  partPaymentsCents: 0,
  channels: [
    { channel: 'takeaway', orderCount: 3, billedCents: 460_000, outside: null },
    { channel: 'delivery', orderCount: 2, billedCents: 598_000, outside: { orderCount: 1, billedCents: 253_000 } },
    { channel: 'web_pickup', orderCount: 1, billedCents: 103_500, outside: null },
    { channel: 'web_delivery', orderCount: 1, billedCents: 138_000, outside: { orderCount: 1, billedCents: 138_000 } },
    { channel: 'foodpanda', orderCount: 1, billedCents: 184_000, outside: null },
  ],
  cancelled: [
    { orderNumber: '20261001-0009', at: '2026-10-01T15:14:00.000Z', cents: 207_000, made: 'made', reason: 'Customer left' },
    { orderNumber: '20261001-0011', at: '2026-10-01T19:40:00.000Z', cents: 138_000, made: 'not_made', reason: null },
  ],
  refunds: [
    { orderNumber: '20261001-0007', at: '2026-10-01T18:00:00.000Z', method: 'cash', cents: 115_000, full: true, reason: 'Cold pizza' },
    { orderNumber: '20261001-0008', at: '2026-10-01T18:00:00.000Z', method: 'card', cents: 23_000, full: false, reason: null },
  ],
  drawer: {
    openingCents: 500_000,
    cashSalesCents: 898_000,
    cashRefundsCents: 115_000,
    cashIn: { count: 1, cents: 200_000 },
    cashOut: { count: 3, cents: 60_000 },
    riderTips: { count: 2, cents: 10_000 },
    riderKept: { count: 2, cents: 40_000, tripCount: 0 },
    otherCents: 0,
    expectedCents: 1_383_000,
    countedCents: 1_382_000,
    varianceCents: -1_000,
    countedNotes: COUNT,
  },
  unpaid: {
    orders: [{ orderNumber: '20261001-0010', at: '2026-10-01T20:12:00.000Z', takenBy: 'Website', cents: 159_000 }],
    reason: 'Rider still out',
  },
  // Every line of the eight orders: the items add up to Food (13,100.00).
  items: [
    {
      category: 'Pizza',
      quantity: 9,
      cents: 1_310_000,
      items: [
        { name: 'Test Burger', quantity: 4, cents: 450_000 },
        { name: 'Test Pizza - Large', quantity: 3, cents: 600_000 },
        { name: 'Test Pizza - Medium', quantity: 1, cents: 150_000 },
        { name: 'Test Fries', quantity: 1, cents: 110_000 },
      ],
    },
  ],
  // All paid at the same moment, so in number order; they add up to TOTAL (with tax).
  orders: [
    { orderNumber: '20261001-0001', paidAt: '2026-10-01T12:00:00.000Z', channel: 'takeaway', outside: false, methods: ['cash'], totalCents: 230_000, refunded: 'no' },
    { orderNumber: '20261001-0002', paidAt: '2026-10-01T12:00:00.000Z', channel: 'delivery', outside: false, methods: ['cash'], totalCents: 345_000, refunded: 'no' },
    // The wallet's Rs 2,330 before his Rs 200 in cash: biggest first.
    { orderNumber: '20261001-0003', paidAt: '2026-10-01T12:00:00.000Z', channel: 'delivery', outside: true, methods: ['easypaisa', 'cash'], totalCents: 253_000, refunded: 'no' },
    { orderNumber: '20261001-0004', paidAt: '2026-10-01T12:00:00.000Z', channel: 'web_delivery', outside: true, methods: ['cash'], totalCents: 138_000, refunded: 'no' },
    { orderNumber: '20261001-0005', paidAt: '2026-10-01T12:00:00.000Z', channel: 'web_pickup', outside: false, methods: ['card'], totalCents: 103_500, refunded: 'no' },
    { orderNumber: '20261001-0006', paidAt: '2026-10-01T12:00:00.000Z', channel: 'foodpanda', outside: false, methods: ['foodpanda'], totalCents: 184_000, refunded: 'no' },
    { orderNumber: '20261001-0007', paidAt: '2026-10-01T12:00:00.000Z', channel: 'takeaway', outside: false, methods: ['cash'], totalCents: 115_000, refunded: 'full' },
    // Rs 650 card and Rs 500 cash: the card first.
    { orderNumber: '20261001-0008', paidAt: '2026-10-01T12:00:00.000Z', channel: 'takeaway', outside: false, methods: ['card', 'cash'], totalCents: 115_000, refunded: 'part' },
  ],
};

describe('buildShiftReport: a small night', () => {
  it('works out every figure as the paper will print it', () => {
    expect(buildShiftReport(NIGHT)).toEqual(NIGHT_REPORT);
  });

  it('its own sums hold: food + delivery − discounts + tax = TOTAL; channels and money add up; NET = MONEY TAKEN', () => {
    const r = buildShiftReport(NIGHT);
    const s = r.sales;
    expect(s.foodCents + s.delivery.cents - sum(s.discounts.map((d) => d.cents)) + s.taxCents).toBe(s.billedCents);
    expect(sum(r.channels.map((c) => c.billedCents))).toBe(s.billedCents);
    expect(sum(r.channels.map((c) => c.orderCount))).toBe(s.orderCount);
    expect(sum(r.payments.map((p) => p.cents)) - sum(r.paymentRefunds.map((p) => p.cents))).toBe(r.moneyTakenCents);
    expect(r.moneyTakenCents).toBe(s.netCents);
    expect(shiftReportDrawerAddsUp(r)).toBe(true);
  });

  it('keys come out in the type’s order, so the stored text is the report as built', () => {
    const r = buildShiftReport(NIGHT);
    expect(Object.keys(r)).toEqual(Object.keys(NIGHT_REPORT));
    expect(shiftReportJson(r)).toBe(JSON.stringify(r));
    expect(shiftReportJson(r)).toBe(JSON.stringify(NIGHT_REPORT));
  });

  it('holds no cost, waste, commission or profit figure', () => {
    expect(/cost|waste|commission|profit/i.test(shiftReportJson(buildShiftReport(NIGHT)))).toBe(false);
  });
});

describe('buildShiftReport: an empty shift', () => {
  it('is all zeros and empty lists, the drawer the float alone, and does not throw', () => {
    const r = buildShiftReport(facts());
    expect(r.sales).toEqual({
      orderCount: 0,
      foodCents: 0,
      delivery: { orderCount: 0, cents: 0 },
      discounts: [],
      taxCents: 0,
      taxRateBps: null,
      billedCents: 0,
      refunds: { orderCount: 0, cents: 0 },
      netCents: 0,
      averageCents: 0,
    });
    expect([r.payments, r.paymentRefunds, r.channels, r.cancelled, r.refunds, r.items, r.orders]).toEqual([[], [], [], [], [], [], []]);
    expect([r.moneyTakenCents, r.partPaymentsCents]).toEqual([0, 0]);
    expect(r.unpaid).toEqual({ orders: [], reason: null });
    expect(r.drawer).toMatchObject({ openingCents: 500_000, cashOut: NONE, otherCents: 0, expectedCents: 500_000, countedNotes: null });
    expect(shiftReportDrawerAddsUp(r)).toBe(true);
  });
});

describe('SALES', () => {
  it('food is the subtotals less the delivery charges; the charges count the orders that had one', () => {
    const r = buildShiftReport(facts({ settled: [sale('0001', 100_000), sale('0002', 200_000, { channel: 'delivery', chargeCents: 15_000 })] }));
    expect(r.sales.foodCents).toBe(300_000);
    expect(r.sales.delivery).toEqual({ orderCount: 1, cents: 15_000 });
  });

  it('a declined offer (its row re-worked to Rs 0) adds nothing to Discounts or its count', () => {
    const declined = sale('0001', 200_000, { discountCents: 0, discountKind: 'offer' });
    const r = buildShiftReport(facts({ settled: [declined, sale('0002', 100_000, { discountCents: 10_000, discountKind: 'offer' })] }));
    expect(r.sales.discounts).toEqual([{ kind: 'offer', orderCount: 1, cents: 10_000 }]);
    expect(buildShiftReport(facts({ settled: [declined] })).sales.discounts).toEqual([]);
    expect(shiftReportDiscountKind(0, 'offer', 'pos')).toBeNull();
  });

  it('kinds print in the order foodpanda, staff, website, offer, and a kind with no orders is left out', () => {
    const r = buildShiftReport(
      facts({
        settled: [
          sale('0001', 100_000, { discountCents: 5_000, discountKind: 'offer' }),
          sale('0002', 100_000, { discountCents: 5_000, discountKind: 'staff' }),
          sale('0003', 100_000, { discountCents: 7_000, discountKind: 'offer' }),
          sale('0004', 100_000, { channel: 'foodpanda', discountCents: 20_000, discountKind: 'foodpanda' }),
        ],
      }),
    );
    expect(r.sales.discounts).toEqual([
      { kind: 'foodpanda', orderCount: 1, cents: 20_000 },
      { kind: 'staff', orderCount: 1, cents: 5_000 },
      { kind: 'offer', orderCount: 2, cents: 12_000 },
    ]);
  });

  it('a discounted order with no kind in the facts is the staff’s, so the kinds always add up to the discounts', () => {
    const r = buildShiftReport(facts({ settled: [sale('0001', 100_000, { discountCents: 5_000, discountKind: null })] }));
    expect(r.sales.discounts).toEqual([{ kind: 'staff', orderCount: 1, cents: 5_000 }]);
  });

  it('the one tax rate of the lines; mixed rates or none print no rate; a 0% line does not count', () => {
    const one = sale('0001', 300_000);
    const rate = (lines: ShiftReportFactsLine[]) => buildShiftReport(facts({ settled: [one], lines })).sales.taxRateBps;
    expect(rate([line('0001', 'Test Pizza', 200_000, 1500), line('0001', 'Test Water', 100_000, 0)])).toBe(1500);
    expect(rate([line('0001', 'Test Pizza', 200_000, 1500), line('0001', 'Test Fries', 100_000, 800)])).toBeNull();
    expect(rate([line('0001', 'Test Water', 300_000, 0)])).toBeNull();
    expect(rate([])).toBeNull();
    // A line of an order not settled in this shift is not this shift's rate.
    expect(rate([line('0001', 'Test Pizza', 300_000, 1500), line('0099', 'Test Fries', 100_000, 800)])).toBe(1500);
  });

  it('the average bill is TOTAL ÷ orders, rounded to the paisa', () => {
    const r = buildShiftReport(facts({ settled: [sale('0001', 100_000), sale('0002', 100_000), sale('0003', 100_001)] }));
    // 115,000 + 115,000 + 115,001 = 345,001 → 115,000.33
    expect(r.sales.billedCents).toBe(345_001);
    expect(r.sales.averageCents).toBe(115_000);
  });

  it('a fully refunded order stays in SALES and BY CHANNEL, and its money comes off at Refunds', () => {
    const o = sale('0001', 200_000, { status: 'refunded', hasRefund: true, methods: ['cash'] });
    const r = buildShiftReport(
      facts({
        settled: [o],
        payments: [pay('0001', 'cash', 230_000), pay('0001', 'cash', -230_000)],
        refunds: [refund(o, 'cash', 230_000, true, 'Cold pizza')],
      }),
    );
    expect(r.sales).toMatchObject({ orderCount: 1, foodCents: 200_000, billedCents: 230_000, refunds: { orderCount: 1, cents: 230_000 }, netCents: 0 });
    expect(r.channels).toEqual([{ channel: 'takeaway', orderCount: 1, billedCents: 230_000, outside: null }]);
    expect(r.payments).toEqual([{ method: 'cash', orderCount: 1, cents: 230_000 }]);
    expect(r.paymentRefunds).toEqual([{ method: 'cash', orderCount: 1, cents: 230_000 }]);
    expect([r.moneyTakenCents, r.partPaymentsCents]).toEqual([0, 0]);
  });

  it('two refunds of one order count it once', () => {
    const o = sale('0001', 200_000, { hasRefund: true });
    const r = buildShiftReport(
      facts({
        settled: [o],
        payments: [pay('0001', 'card', 230_000), pay('0001', 'card', -20_000), pay('0001', 'card', -10_000)],
        refunds: [refund(o, 'card', 20_000, false), refund(o, 'card', 10_000, false)],
      }),
    );
    expect(r.sales.refunds).toEqual({ orderCount: 1, cents: 30_000 });
    expect(r.paymentRefunds).toEqual([{ method: 'card', orderCount: 1, cents: 30_000 }]);
    expect(r.refunds).toHaveLength(2);
  });
});

describe('shiftReportDiscountKind (what the till reads from the latest discount row)', () => {
  it('foodpanda and offer as the row says; no source is the website’s on a website order and the staff’s on a counter order', () => {
    expect(shiftReportDiscountKind(40_000, 'foodpanda', 'pos')).toBe('foodpanda');
    expect(shiftReportDiscountKind(10_000, 'offer', 'pos')).toBe('offer');
    expect(shiftReportDiscountKind(10_000, null, 'web')).toBe('website');
    expect(shiftReportDiscountKind(10_000, null, 'pos')).toBe('staff');
    expect(shiftReportDiscountKind(10_000, undefined, 'pos')).toBe('staff');
  });

  it('nothing when the stored discount is Rs 0, whatever the row says', () => {
    expect(shiftReportDiscountKind(0, 'offer', 'pos')).toBeNull();
    expect(shiftReportDiscountKind(0, 'foodpanda', 'pos')).toBeNull();
    expect(shiftReportDiscountKind(0, null, 'web')).toBeNull();
  });

  it('a source this version does not know reads as Reports reads it: no source', () => {
    expect(shiftReportDiscountKind(10_000, 'loyalty', 'pos')).toBe('staff');
    expect(shiftReportDiscountKind(10_000, 'loyalty', 'web')).toBe('website');
  });
});

describe('MONEY TAKEN', () => {
  it('methods in the order cash, card, EasyPaisa, JazzCash, bank transfer, foodpanda, then any other by name', () => {
    const r = buildShiftReport(
      facts({
        payments: [
          pay('a', 'voucher', 100),
          pay('b', 'foodpanda', 100),
          pay('c', 'bank_transfer', 100),
          pay('d', 'jazzcash', 100),
          pay('e', 'gift_card', 100),
          pay('f', 'easypaisa', 100),
          pay('g', 'card', 100),
          pay('h', 'cash', 100),
        ],
      }),
    );
    expect(r.payments.map((p) => p.method)).toEqual(['cash', 'card', 'easypaisa', 'jazzcash', 'bank_transfer', 'foodpanda', 'gift_card', 'voucher']);
  });

  it('each method counts an order once; a split payment counts under both', () => {
    const r = buildShiftReport(
      facts({ payments: [pay('a', 'cash', 50_000), pay('a', 'card', 65_000), pay('b', 'cash', 10_000), pay('b', 'cash', 20_000)] }),
    );
    expect(r.payments).toEqual([
      { method: 'cash', orderCount: 2, cents: 80_000 },
      { method: 'card', orderCount: 1, cents: 65_000 },
    ]);
  });

  /** One order and its money, as one flow writes it. */
  function flow(o: ShiftReportFactsOrder, rows: Array<[string, number]>, refunds: ShiftReportFactsRefund[] = []): ShiftReport {
    return buildShiftReport(facts({ settled: [o], payments: rows.map(([m, c]) => pay(o.id, m, c)), refunds }));
  }

  it('NET SALES = MONEY TAKEN and part payments 0 in every flow where an order’s money comes in at one time', () => {
    const t = (o: ShiftReportFactsOrder) => o.totalCents;
    const takeaway = sale('0001', 200_000);
    const delivery = sale('0002', 200_000, { channel: 'delivery', chargeCents: 20_000 });
    const outside = sale('0003', 200_000, { channel: 'delivery', chargeCents: 20_000, outside: true });
    const panda = sale('0004', 200_000, { channel: 'foodpanda', discountCents: 40_000, discountKind: 'foodpanda' });
    const free = sale('0005', 0);
    const flows: ShiftReport[] = [
      flow(takeaway, [['cash', t(takeaway)]]),
      flow(takeaway, [['card', t(takeaway)]]),
      flow(takeaway, [['easypaisa', t(takeaway)]]),
      flow(takeaway, [['jazzcash', t(takeaway)]]),
      flow(takeaway, [['bank_transfer', t(takeaway)]]),
      flow(takeaway, [['cash', 100_000], ['card', t(takeaway) - 100_000]]),
      flow(delivery, [['cash', t(delivery)]]),
      flow(panda, [['foodpanda', t(panda)]]),
      // An outside rider in cash: one payment of the total (his Rs 200 is a drawer payout, not a payment).
      flow(outside, [['cash', t(outside)]]),
      // By EasyPaisa: the wallet for the food total and his fee from the customer's cash.
      flow(outside, [['easypaisa', t(outside) - 20_000], ['cash', 20_000]]),
      // Refunded in full, and in part, in this shift.
      flow(takeaway, [['cash', t(takeaway)], ['cash', -t(takeaway)]], [refund(takeaway, 'cash', t(takeaway), true)]),
      flow(takeaway, [['card', t(takeaway)], ['card', -30_000]], [refund(takeaway, 'card', 30_000, false)]),
      // A Rs 0 order: paid with no money.
      flow(free, []),
    ];
    for (const r of flows) {
      expect(r.moneyTakenCents).toBe(r.sales.netCents);
      expect(r.partPaymentsCents).toBe(0);
    }
  });

  it('a refund today of an order settled in an earlier shift comes off NET SALES and MONEY TAKEN alike', () => {
    const earlier = sale('0001', 200_000, { hasRefund: true });
    const r = buildShiftReport(facts({ payments: [pay('0001', 'cash', -50_000)], refunds: [refund(earlier, 'cash', 50_000, false)] }));
    expect(r.sales).toMatchObject({ orderCount: 0, billedCents: 0, refunds: { orderCount: 1, cents: 50_000 }, netCents: -50_000 });
    expect([r.moneyTakenCents, r.partPaymentsCents]).toEqual([-50_000, 0]);
  });

  it('the guard: money for an order not settled in this shift shows as part payments (no flow does this today)', () => {
    // Made from raw facts: Rs 1,000 of an order's Rs 2,300 taken in an earlier shift.
    const o = sale('0001', 200_000);
    const deposit = buildShiftReport(facts({ settled: [o], payments: [pay('0001', 'cash', 130_000)] }));
    expect(deposit.sales.netCents).toBe(230_000);
    expect(deposit.moneyTakenCents).toBe(130_000);
    expect(deposit.partPaymentsCents).toBe(-100_000);
    // And Rs 500 taken here for an order settled in another shift.
    const elsewhere = buildShiftReport(facts({ payments: [pay('0099', 'cash', 50_000)] }));
    expect(elsewhere.partPaymentsCents).toBe(50_000);
  });
});

describe('BY CHANNEL', () => {
  it('in the order takeaway, delivery, website pick-up, website delivery, foodpanda, dine-in, online; only those with orders', () => {
    const r = buildShiftReport(
      facts({
        settled: [
          sale('0001', 100_000, { channel: 'online' }),
          sale('0002', 100_000, { channel: 'foodpanda' }),
          sale('0003', 100_000, { channel: 'dine_in' }),
          sale('0004', 100_000, { channel: 'web_pickup' }),
          sale('0005', 100_000, { channel: 'takeaway' }),
        ],
      }),
    );
    expect(r.channels.map((c) => c.channel)).toEqual(['takeaway', 'web_pickup', 'foodpanda', 'dine_in', 'online']);
  });

  it('a website delivery sent out with an outside rider is split out under Website delivery, not hidden', () => {
    const r = buildShiftReport(
      facts({
        settled: [
          sale('0001', 100_000, { channel: 'web_delivery', chargeCents: 20_000, outside: true }),
          sale('0002', 200_000, { channel: 'web_delivery', chargeCents: 20_000 }),
        ],
      }),
    );
    expect(r.channels).toEqual([{ channel: 'web_delivery', orderCount: 2, billedCents: 391_000, outside: { orderCount: 1, billedCents: 138_000 } }]);
  });

  it('outside riders only when an order went out with one; never under a channel that is not a delivery', () => {
    const own = buildShiftReport(facts({ settled: [sale('0001', 100_000, { channel: 'delivery', chargeCents: 20_000 })] }));
    expect(own.channels[0]?.outside).toBeNull();
    const odd = buildShiftReport(facts({ settled: [sale('0001', 100_000, { channel: 'takeaway', outside: true })] }));
    expect(odd.channels[0]?.outside).toBeNull();
  });
});

describe('cancels, refunds and the unpaid list are copied as read', () => {
  it('row by row, in the order read, with only the report’s keys', () => {
    const o = sale('0007', 100_000);
    const extra = { ...refund(o, 'cash', 115_000, true, 'Cold pizza'), approvedBy: 'Test Manager' };
    const r = buildShiftReport(
      facts({
        refunds: [extra],
        cancelled: [
          { orderNumber: '20261001-0012', at: '2026-10-01T19:00:00.000Z', cents: 50_000, made: null, reason: 'Wrong item rung' },
          { orderNumber: '20261001-0009', at: '2026-10-01T15:00:00.000Z', cents: 70_000, made: 'made', reason: null },
        ],
        unpaid: {
          orders: [
            { orderNumber: '20261001-0013', createdAt: '2026-10-01T20:01:00.000Z', totalCents: 115_000, takenBy: 'Test Cashier' },
            { orderNumber: '20261001-0014', createdAt: '2026-10-01T20:10:00.000Z', totalCents: 230_000, takenBy: 'Website' },
          ],
          reason: 'Rider still out',
        },
      }),
    );
    expect(r.refunds).toEqual([{ orderNumber: '20261001-0007', at: '2026-10-01T18:00:00.000Z', method: 'cash', cents: 115_000, full: true, reason: 'Cold pizza' }]);
    expect(Object.keys(r.refunds[0]!)).toEqual(['orderNumber', 'at', 'method', 'cents', 'full', 'reason']);
    expect(r.cancelled.map((c) => c.orderNumber)).toEqual(['20261001-0012', '20261001-0009']);
    expect(r.unpaid).toEqual({
      orders: [
        { orderNumber: '20261001-0013', at: '2026-10-01T20:01:00.000Z', takenBy: 'Test Cashier', cents: 115_000 },
        { orderNumber: '20261001-0014', at: '2026-10-01T20:10:00.000Z', takenBy: 'Website', cents: 230_000 },
      ],
      reason: 'Rider still out',
    });
  });
});

describe('CASH DRAWER (copied from the close)', () => {
  /** A drawer whose expected cash is the close's own formula over these parts. */
  function drawer(p: Partial<ShiftReportDrawerFacts>, unknownCents = 0): ShiftReportDrawerFacts {
    const d = { ...FLOAT_ONLY, ...p };
    // closeShift: opening + cash sales − cash refunds + in − out, where out is every payout and tip.
    const out = d.payouts.cents + d.tips.cents + d.riderKept.cents;
    const expected = d.openingCents + d.cashSalesCents - d.cashRefundsCents + d.cashIn.cents - out + unknownCents;
    return { ...d, expectedCents: expected, countedCents: expected, varianceCents: 0 };
  }

  it('cash taken out is the payouts typed by hand and the rider tips; the tips are a part of it and are not taken off again', () => {
    const d = drawer({
      cashSalesCents: 900_000,
      payouts: { count: 2, cents: 31_500 },
      tips: { count: 3, cents: 6_000 },
      riderKept: { count: 8, cents: 18_000, tripCount: 1 },
    });
    const r = buildShiftReport(facts({ drawer: d }));
    expect(r.drawer.cashOut).toEqual({ count: 5, cents: 37_500 });
    expect(r.drawer.riderTips).toEqual({ count: 3, cents: 6_000 });
    expect(r.drawer.riderKept).toEqual({ count: 8, cents: 18_000, tripCount: 1 });
    expect(r.drawer.otherCents).toBe(0);
    expect(r.drawer.expectedCents).toBe(500_000 + 900_000 - 37_500 - 18_000);
    expect(shiftReportDrawerAddsUp(r)).toBe(true);
    // Taking the tips off a second time would not add up.
    const d2 = r.drawer;
    expect(d2.openingCents + d2.cashSalesCents - d2.cashOut.cents - d2.riderTips.cents - d2.riderKept.cents).not.toBe(d2.expectedCents);
  });

  it('a drawer change the breakdown does not know (a newer till’s movement type) shows as other, and the block still adds up', () => {
    const r = buildShiftReport(facts({ drawer: drawer({ cashSalesCents: 100_000, cashIn: { count: 1, cents: 50_000 } }, -7_500) }));
    expect(r.drawer.otherCents).toBe(-7_500);
    expect(shiftReportDrawerAddsUp(r)).toBe(true);
  });

  it('expected, counted, short or over and the count by note are the close’s own, never worked out again', () => {
    const d: ShiftReportDrawerFacts = { ...FLOAT_ONLY, expectedCents: 500_000, countedCents: 499_000, varianceCents: -1_000, countedNotes: COUNT };
    const r = buildShiftReport(facts({ drawer: d }));
    expect([r.drawer.expectedCents, r.drawer.countedCents, r.drawer.varianceCents]).toEqual([500_000, 499_000, -1_000]);
    expect(r.drawer.countedNotes).toEqual(COUNT);
  });

  it('shiftReportDrawerAddsUp is false when a figure was changed after', () => {
    const r = buildShiftReport(NIGHT);
    expect(shiftReportDrawerAddsUp({ ...r, drawer: { ...r.drawer, cashSalesCents: r.drawer.cashSalesCents + 1 } })).toBe(false);
    expect(shiftReportDrawerAddsUp({ ...r, drawer: { ...r.drawer, otherCents: 100 } })).toBe(false);
  });
});

/** The same value with every object's keys in reverse order and an extra key in each. */
function scrambled(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrambled);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = { zzExtra: 'from a newer till' };
  for (const k of Object.keys(value).reverse()) out[k] = scrambled((value as Record<string, unknown>)[k]);
  return out;
}

describe('shiftReportJson (the only writer of shifts.close_report_json)', () => {
  it('the same text whatever order the keys came in and whatever else they carried', () => {
    const text = shiftReportJson(NIGHT_REPORT);
    expect(shiftReportJson(scrambled(NIGHT_REPORT) as ShiftReport)).toBe(text);
    expect(text).not.toContain('zzExtra');
  });

  it('JSON.parse of it deep-equals the report, keys in the type’s order', () => {
    const text = shiftReportJson(scrambled(NIGHT_REPORT) as ShiftReport);
    expect(JSON.parse(text)).toEqual(NIGHT_REPORT);
    expect(Object.keys(JSON.parse(text) as object)).toEqual(Object.keys(NIGHT_REPORT));
    expect(text.startsWith('{"v":1,"shiftId":"s_test_1","deviceId":"till-test-1","tillName":"Front till"')).toBe(true);
  });

  it('writes the count by note in its own stored order, and the items and orders lists in full', () => {
    const full: ShiftReport = {
      ...NIGHT_REPORT,
      items: [{ category: 'Pizza', quantity: 2, cents: 400_000, items: [{ name: 'Test Pizza - Large', quantity: 2, cents: 400_000 }] }],
      orders: [
        {
          orderNumber: '20261001-0003',
          paidAt: '2026-10-01T12:41:00.000Z',
          channel: 'delivery',
          outside: true,
          methods: ['easypaisa', 'cash'],
          totalCents: 253_000,
          refunded: 'no',
        },
      ],
    };
    const text = shiftReportJson(scrambled(full) as ShiftReport);
    expect(JSON.parse(text)).toEqual(full);
    expect(text).toContain(
      '"countedNotes":{"notes":[{"faceCents":500000,"count":2},{"faceCents":100000,"count":3},{"faceCents":50000,"count":1},' +
        '{"faceCents":10000,"count":3},{"faceCents":5000,"count":0},{"faceCents":2000,"count":0},{"faceCents":1000,"count":0}],"otherCents":2000}',
    );
    expect(text.endsWith(
      '"items":[{"category":"Pizza","quantity":2,"cents":400000,"items":[{"name":"Test Pizza - Large","quantity":2,"cents":400000}]}],' +
        '"orders":[{"orderNumber":"20261001-0003","paidAt":"2026-10-01T12:41:00.000Z","channel":"delivery","outside":true,' +
        '"methods":["easypaisa","cash"],"totalCents":253000,"refunded":"no"}]}',
    )).toBe(true);
  });

  it('a shift with no count by note and no outside riders writes nulls', () => {
    const r = buildShiftReport(facts({ settled: [sale('0001', 100_000)] }));
    const text = shiftReportJson(r);
    expect(text).toContain('"countedNotes":null');
    expect(text).toContain('"outside":null');
    expect(JSON.parse(text)).toEqual(r);
  });
});

/** A small seeded random number source (mulberry32), so the run is the same every time. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('a long busy shift (2,000 made-up orders)', () => {
  it('every figure is a safe whole number, every sum holds, NET = MONEY TAKEN and the drawer adds up', () => {
    const rnd = seeded(20261002);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const settled: ShiftReportFactsOrder[] = [];
    const lines: ShiftReportFactsLine[] = [];
    const payments: ShiftReportFactsPayment[] = [];
    const refunds: ShiftReportFactsRefund[] = [];
    let cashSales = 0;
    let cashRefunds = 0;
    let riderKept = 0;
    let riderCount = 0;
    for (let i = 0; i < 2_000; i += 1) {
      const id = String(i).padStart(4, '0');
      const channel = pick(['takeaway', 'delivery', 'web_pickup', 'web_delivery', 'foodpanda'] as const);
      const isDelivery = channel === 'delivery' || channel === 'web_delivery';
      const outside = isDelivery && rnd() < 0.4;
      const charge = isDelivery ? pick([15_000, 20_000]) : 0;
      let food = 0;
      for (let n = 1 + Math.floor(rnd() * 4); n > 0; n -= 1) {
        const cents = (1 + Math.floor(rnd() * 40)) * 10_000 * (1 + Math.floor(rnd() * 3));
        food += cents;
        lines.push(line(id, pick(['Test Pizza', 'Test Burger', 'Test Fries', 'Test Dip']), cents));
      }
      const kind = channel === 'foodpanda' ? 'foodpanda' : channel === 'web_pickup' ? pick([null, 'website'] as const) : pick([null, null, 'staff', 'offer'] as const);
      const discount = kind ? Math.floor(food * 0.1) : 0;
      const o = sale(id, food, { channel, chargeCents: charge, outside, discountCents: discount, discountKind: kind });
      const total = o.totalCents;
      const keep = outside ? Math.min(charge, total) : 0;
      const how = channel === 'foodpanda' ? 'foodpanda' : outside ? pick(['cash', 'easypaisa'] as const) : pick(['cash', 'card', 'split', 'jazzcash'] as const);
      const rows: Array<[string, number]> =
        how === 'split' ? [['cash', Math.floor(total / 2)], ['card', total - Math.floor(total / 2)]]
        : how === 'easypaisa' && keep > 0 ? [['easypaisa', total - keep], ['cash', keep]]
        : [[how, total]];
      for (const [m, c] of rows) {
        payments.push(pay(id, m, c));
        if (m === 'cash') cashSales += c;
      }
      if (keep > 0) {
        riderKept += keep;
        riderCount += 1;
      }
      const r = rnd();
      const back = r < 0.05 ? total : r < 0.1 ? Math.floor(total / 3) : 0;
      if (back > 0) {
        const method = rows[0]![0];
        payments.push(pay(id, method, -back));
        refunds.push(refund(o, method, back, back === total));
        if (method === 'cash') cashRefunds += back;
      }
      settled.push({ ...o, status: back === total ? 'refunded' : 'paid', methods: [...new Set(rows.map(([m]) => m))], hasRefund: back > 0 });
    }
    const opening = 500_000;
    const cashIn = { count: 3, cents: 600_000 };
    const payouts = { count: 4, cents: 120_000 };
    const tips = { count: 6, cents: 30_000 };
    const expected = opening + cashSales - cashRefunds + cashIn.cents - (payouts.cents + tips.cents + riderKept);
    const r = buildShiftReport(
      facts({
        settled,
        lines,
        payments,
        refunds,
        drawer: {
          openingCents: opening,
          cashSalesCents: cashSales,
          cashRefundsCents: cashRefunds,
          cashIn,
          payouts,
          tips,
          riderKept: { count: riderCount, cents: riderKept, tripCount: 0 },
          expectedCents: expected,
          countedCents: expected - 1_000,
          varianceCents: -1_000,
          countedNotes: null,
        },
      }),
    );

    const numbers: number[] = [];
    JSON.parse(shiftReportJson(r), (_k, v: unknown) => {
      if (typeof v === 'number') numbers.push(v);
      return v;
    });
    expect(numbers.length).toBeGreaterThan(50);
    expect(numbers.every((n) => Number.isSafeInteger(n))).toBe(true);

    const s = r.sales;
    expect(s.orderCount).toBe(2_000);
    expect(s.foodCents + s.delivery.cents - sum(s.discounts.map((d) => d.cents)) + s.taxCents).toBe(s.billedCents);
    expect(s.foodCents).toBe(sum(lines.map((l) => l.lineTotalCents)));
    expect(sum(r.channels.map((c) => c.billedCents))).toBe(s.billedCents);
    expect(sum(r.channels.map((c) => c.orderCount))).toBe(2_000);
    expect(sum(r.payments.map((p) => p.cents)) - sum(r.paymentRefunds.map((p) => p.cents))).toBe(r.moneyTakenCents);
    expect(r.moneyTakenCents).toBe(s.netCents);
    expect(r.partPaymentsCents).toBe(0);
    expect(s.taxRateBps).toBe(1500);
    expect(r.drawer.otherCents).toBe(0);
    expect(shiftReportDrawerAddsUp(r)).toBe(true);
    expect(JSON.parse(shiftReportJson(r))).toEqual(r);

    // ITEMS SOLD always adds up to Food, every line counted once.
    expect(sum(r.items.map((c) => c.cents))).toBe(s.foodCents);
    expect(sum(r.items.flatMap((c) => c.items.map((i) => i.cents)))).toBe(s.foodCents);
    expect(sum(r.items.map((c) => c.quantity))).toBe(lines.length);
    // ORDERS is the SALES set: one entry each, adding up to TOTAL (with tax).
    expect(r.orders).toHaveLength(s.orderCount);
    expect(sum(r.orders.map((o) => o.totalCents))).toBe(s.billedCents);
    expect(r.orders.filter((o) => o.refunded === 'full')).toHaveLength(settled.filter((o) => o.status === 'refunded').length);
    expect(r.orders.filter((o) => o.refunded === 'part')).toHaveLength(settled.filter((o) => o.hasRefund && o.status !== 'refunded').length);
  });
});

describe('the facts', () => {
  it('a line with no menu item and no category is taken as it is; food comes from the orders’ stored subtotals', () => {
    const l: ShiftReportFactsLine = { ...line('0001', 'Test Dip', 10_000), menuItemId: null, categoryName: null, categoryRank: null };
    const r = buildShiftReport(facts({ settled: [sale('0001', 10_000)], lines: [l] }));
    expect(r.sales.foodCents).toBe(10_000);
    expect(r.items).toEqual([{ category: 'No category', quantity: 1, cents: 10_000, items: [{ name: 'Test Dip', quantity: 1, cents: 10_000 }] }]);
  });
});

// -----------------------------------------------------------------------------
// ITEMS SOLD
// -----------------------------------------------------------------------------

/** A line of a given category and menu item. */
function sold(
  orderId: string,
  name: string,
  lineTotalCents: number,
  o: { quantity?: number; menuItemId?: string | null; category?: string | null; rank?: number | null } = {},
): ShiftReportFactsLine {
  const category = o.category === undefined ? 'Pizza' : o.category;
  return {
    orderId,
    menuItemId: o.menuItemId === undefined ? `mi_${name}` : o.menuItemId,
    name,
    categoryName: category,
    categoryRank: o.rank === undefined ? 0 : o.rank,
    quantity: o.quantity ?? 1,
    lineTotalCents,
    taxRateBps: 1500,
  };
}

describe('ITEMS SOLD', () => {
  /** The report of one settled order '0001' carrying these lines (its food is theirs). */
  function itemsOf(lines: ShiftReportFactsLine[]): ShiftReport['items'] {
    const food = sum(lines.filter((l) => l.orderId === '0001').map((l) => l.lineTotalCents));
    return buildShiftReport(facts({ settled: [sale('0001', food)], lines })).items;
  }

  it('categories in the till’s own order (rank, then name), one the rank does not place after them, and No category last', () => {
    const items = itemsOf([
      sold('0001', 'Test Water', 5_000, { menuItemId: null, category: null, rank: null }),
      sold('0001', 'Test Cola', 12_000, { category: 'Drinks', rank: 6 }),
      sold('0001', 'Test Special', 50_000, { category: 'Specials', rank: null }),
      sold('0001', 'Test Burger', 80_000, { category: 'Burgers', rank: 2 }),
      sold('0001', 'Test Pizza', 200_000, { category: 'Pizza', rank: 1 }),
      sold('0001', 'Test Star', 220_000, { category: 'Signature Pizzas', rank: 0 }),
      // Two categories at one rank: by name.
      sold('0001', 'Test Fries', 45_000, { category: 'Fries & Sides', rank: 2 }),
    ]);
    expect(items.map((c) => c.category)).toEqual(['Signature Pizzas', 'Pizza', 'Burgers', 'Fries & Sides', 'Drinks', 'Specials', 'No category']);
  });

  it('an item is its menu item: its lines are added up, quantities included, under one name whatever order they came in', () => {
    const lines = [
      sold('0001', 'Test Pizza — Large', 200_000),
      sold('0001', 'Test Pizza — Large', 400_000, { quantity: 2 }),
      // The same menu item under the name it was sold with before a rename (the menu item since deleted).
      sold('0001', 'Old Test Pizza', 200_000, { menuItemId: 'mi_Test Pizza — Large' }),
      sold('0001', 'Test Pizza — Medium', 150_000),
    ];
    const expected = [
      {
        category: 'Pizza',
        quantity: 5,
        cents: 950_000,
        items: [
          { name: 'Old Test Pizza', quantity: 4, cents: 800_000 },
          { name: 'Test Pizza — Medium', quantity: 1, cents: 150_000 },
        ],
      },
    ];
    expect(itemsOf(lines)).toEqual(expected);
    expect(itemsOf([...lines].reverse())).toEqual(expected);
  });

  it('a line with no menu item is its name as sold; it never joins a menu item of the same name', () => {
    const items = itemsOf([
      sold('0001', 'Test Dip', 10_000, { menuItemId: null }),
      sold('0001', 'Test Dip', 20_000, { menuItemId: null, quantity: 2 }),
      sold('0001', 'Test Dip', 10_000),
    ]);
    expect(items[0]?.items).toEqual([
      { name: 'Test Dip', quantity: 3, cents: 30_000 },
      { name: 'Test Dip', quantity: 1, cents: 10_000 },
    ]);
  });

  it('most sold first: quantity, then money, then name', () => {
    const items = itemsOf([
      sold('0001', 'Test C', 30_000, { quantity: 3 }),
      sold('0001', 'Test B', 80_000, { quantity: 4 }),
      sold('0001', 'Test A', 60_000, { quantity: 4 }),
      sold('0001', 'Test D', 80_000, { quantity: 4 }),
      sold('0001', 'Test E', 900_000, { quantity: 1 }),
    ]);
    expect(items[0]?.items.map((i) => i.name)).toEqual(['Test B', 'Test D', 'Test A', 'Test C', 'Test E']);
  });

  it('only the lines of orders settled in this shift; a fully refunded order’s items stay', () => {
    const refunded = sale('0002', 100_000, { status: 'refunded', hasRefund: true });
    const r = buildShiftReport(
      facts({
        settled: [sale('0001', 200_000), refunded],
        lines: [sold('0001', 'Test Pizza', 200_000), sold('0002', 'Test Burger', 100_000), sold('0099', 'Test Fries', 45_000)],
      }),
    );
    expect(r.items).toEqual([
      {
        category: 'Pizza',
        quantity: 2,
        cents: 300_000,
        items: [
          { name: 'Test Pizza', quantity: 1, cents: 200_000 },
          { name: 'Test Burger', quantity: 1, cents: 100_000 },
        ],
      },
    ]);
    expect(sum(r.items.map((c) => c.cents))).toBe(r.sales.foodCents);
  });

  it('the delivery charge is never an item: items add up to Food, which leaves the charges out', () => {
    const o = sale('0001', 200_000, { channel: 'delivery', chargeCents: 20_000 });
    const r = buildShiftReport(facts({ settled: [o], lines: [sold('0001', 'Test Pizza', 200_000)] }));
    expect(r.items.flatMap((c) => c.items.map((i) => i.name))).toEqual(['Test Pizza']);
    expect(sum(r.items.map((c) => c.cents))).toBe(r.sales.foodCents);
    expect(r.sales.foodCents).toBe(o.subtotalCents - o.deliveryChargeCents);
  });
});

// -----------------------------------------------------------------------------
// ORDERS
// -----------------------------------------------------------------------------

describe('ORDERS', () => {
  it('in the order they were paid, then by number, then by id; the same moment written two ways is one time', () => {
    const at = (id: string, paidAt: string, orderNumber = `20261001-${id}`) => sale(id, 100_000, { paidAt, orderNumber });
    const r = buildShiftReport(
      facts({
        settled: [
          at('0005', '2026-10-01T13:00:00.000Z'),
          at('0004', '2026-10-01T12:30:00Z'),
          at('0002', '2026-10-01T12:30:00.000Z'),
          at('0001', '2026-10-01T14:00:00.000Z'),
          // Two tills number their orders apart: the same number, told apart by id.
          at('0007', '2026-10-01T12:00:00.000Z', '20261001-0003'),
          at('0003', '2026-10-01T12:00:00.000Z'),
          // A time that does not read goes last.
          at('0006', 'not a time'),
        ],
      }),
    );
    expect(r.orders.map((o) => `${o.orderNumber} ${o.paidAt}`)).toEqual([
      '20261001-0003 2026-10-01T12:00:00.000Z',
      '20261001-0003 2026-10-01T12:00:00.000Z',
      '20261001-0002 2026-10-01T12:30:00.000Z',
      '20261001-0004 2026-10-01T12:30:00Z',
      '20261001-0005 2026-10-01T13:00:00.000Z',
      '20261001-0001 2026-10-01T14:00:00.000Z',
      '20261001-0006 not a time',
    ]);
    // The id breaks the tie: '0003' before '0007', whatever order they came in.
    const twins = (settled: ShiftReportFactsOrder[]) => buildShiftReport(facts({ settled })).orders.map((o) => o.totalCents);
    const a = at('0003', '2026-10-01T12:00:00.000Z', '20261001-0003');
    const b = { ...at('0007', '2026-10-01T12:00:00.000Z', '20261001-0003'), totalCents: 999 };
    expect(twins([b, a])).toEqual([a.totalCents, 999]);
    expect(twins([a, b])).toEqual([a.totalCents, 999]);
  });

  it('methods biggest first from the money this shift took; a tie in the MONEY TAKEN order; each once', () => {
    const o = (id: string, methods: string[]) => sale(id, 100_000, { methods });
    const r = buildShiftReport(
      facts({
        settled: [
          o('0001', ['cash', 'easypaisa']),
          o('0002', ['card', 'cash']),
          o('0003', ['card', 'cash']),
          o('0004', ['jazzcash', 'cash', 'cash']),
          o('0005', ['voucher', 'card']),
          o('0006', []),
        ],
        payments: [
          // An outside rider's EasyPaisa settlement: the wallet, then his charge in cash.
          pay('0001', 'easypaisa', 95_000),
          pay('0001', 'cash', 20_000),
          // Rs 600 cash and Rs 550 card; a refund on the cash does not change the order.
          pay('0002', 'cash', 60_000),
          pay('0002', 'card', 55_000),
          pay('0002', 'cash', -30_000),
          // A tie.
          pay('0003', 'card', 57_500),
          pay('0003', 'cash', 57_500),
          // Two cash rows add up.
          pay('0004', 'jazzcash', 60_000),
          pay('0004', 'cash', 30_000),
          pay('0004', 'cash', 40_000),
          // A method with no money in this shift's rows goes after.
          pay('0005', 'card', 115_000),
        ],
      }),
    );
    expect(r.orders.map((x) => x.methods)).toEqual([
      ['easypaisa', 'cash'],
      ['cash', 'card'],
      ['cash', 'card'],
      ['cash', 'jazzcash'],
      ['card', 'voucher'],
      [],
    ]);
  });

  it('refunded in full, in part, or not; channel and outside rider as the order says', () => {
    const r = buildShiftReport(
      facts({
        settled: [
          sale('0001', 100_000, { status: 'refunded', hasRefund: true }),
          sale('0002', 100_000, { hasRefund: true, channel: 'delivery', chargeCents: 20_000, outside: true }),
          sale('0003', 100_000, { channel: 'web_delivery', chargeCents: 25_000, status: 'delivered' }),
        ],
      }),
    );
    expect(r.orders.map((x) => [x.refunded, x.channel, x.outside])).toEqual([
      ['full', 'takeaway', false],
      ['part', 'delivery', true],
      ['no', 'web_delivery', false],
    ]);
  });

  it('items and orders carry only the report’s keys, in the type’s order', () => {
    const r = buildShiftReport(facts({ settled: [sale('0001', 100_000, { methods: ['cash'] })], lines: [sold('0001', 'Test Pizza', 100_000)] }));
    expect(Object.keys(r.orders[0]!)).toEqual(['orderNumber', 'paidAt', 'channel', 'outside', 'methods', 'totalCents', 'refunded']);
    expect(Object.keys(r.items[0]!)).toEqual(['category', 'quantity', 'cents', 'items']);
    expect(Object.keys(r.items[0]!.items[0]!)).toEqual(['name', 'quantity', 'cents']);
  });
});

// -----------------------------------------------------------------------------
// The sample night (shift-report.fixture.ts): the corrected sample paper
// -----------------------------------------------------------------------------

/** The sample paper's figures, as printed (Sample-Shift-Report-80mm.txt), in cents. */
const SAMPLE_SALES = {
  orderCount: 62,
  foodCents: 16_876_000,
  delivery: { orderCount: 18, cents: 400_000 },
  discounts: [
    { kind: 'foodpanda', orderCount: 9, cents: 486_000 },
    { kind: 'staff', orderCount: 3, cents: 164_000 },
    { kind: 'website', orderCount: 2, cents: 56_000 },
    { kind: 'offer', orderCount: 2, cents: 56_000 },
  ],
  taxCents: 2_477_100,
  taxRateBps: 1500,
  billedCents: 18_991_100,
  refunds: { orderCount: 1, cents: 172_500 },
  netCents: 18_818_600,
  averageCents: 306_308,
};

const SAMPLE_CHANNELS = [
  { channel: 'takeaway', orderCount: 33, billedCents: 9_437_000, outside: null },
  { channel: 'delivery', orderCount: 17, billedCents: 5_513_000, outside: { orderCount: 8, billedCents: 2_553_000 } },
  { channel: 'web_pickup', orderCount: 2, billedCents: 579_600, outside: null },
  { channel: 'web_delivery', orderCount: 1, billedCents: 294_400, outside: null },
  { channel: 'foodpanda', orderCount: 9, billedCents: 3_167_100, outside: null },
];

/** ITEMS SOLD (158), as the sample prints it (the till's names keep the menu's '—'; the paper prints '-'). */
const SAMPLE_ITEMS: ReadonlyArray<readonly [string, number, number, ReadonlyArray<readonly [string, number, number]>]> = [
  ['Signature Pizzas', 22, 4_840_000, [
    ['Shawarma Pizza — Large', 8, 1_760_000],
    ['Crown Crust — Large', 5, 1_100_000],
    ['Cheesy Star — Large', 4, 880_000],
    ['Meat Lovers — Large', 3, 660_000],
    ['Cheetos — Large', 2, 440_000],
  ]],
  ['Pizza', 26, 4_550_000, [
    ['Fajita Pizza — Medium', 5, 750_000],
    ['Chicken Tikka Pizza — Large', 4, 800_000],
    ['Fajita Pizza — Large', 4, 800_000],
    ['Malai Supreme — Medium', 4, 600_000],
    ['Classic Pepperoni — Large', 3, 600_000],
    ['Cheesalious — Medium', 3, 450_000],
    ['Chicken Tikka Malai — Large', 2, 400_000],
    ['Veggie Lovers — Medium', 1, 150_000],
  ]],
  ['Burgers', 19, 1_605_000, [
    ['Crispy Signature', 7, 560_000],
    ['Nashville Authentic (Hot)', 5, 475_000],
    ['Signature Cheese Dipped', 4, 360_000],
    ['Classic Crispy Chicken', 3, 210_000],
  ]],
  ['Fries & Sides', 23, 1_341_000, [
    ['Fries — Large', 8, 360_000],
    ['Signature Loaded Fries', 6, 420_000],
    ['Signature Mayo Masala Fries — Large', 4, 220_000],
    ['Nuggets', 3, 201_000],
    ['Baked Wings', 2, 140_000],
  ]],
  ['Dips', 29, 290_000, [
    ['Signature Orange Dip', 14, 140_000],
    ['Garlic Mayo Dip', 9, 90_000],
    ['Ranch Dip', 6, 60_000],
  ]],
  ['Value Deals', 12, 3_770_000, [
    ['Big Two', 5, 1_800_000],
    ['Perfect Pair', 4, 1_040_000],
    ['Family Feast', 3, 930_000],
  ]],
  ['Drinks', 27, 480_000, [
    ['Soft Drink — 345 ml', 15, 180_000],
    ['Soft Drink — 1 litre', 12, 300_000],
  ]],
];

describe('the sample night (62 orders): every figure of the sample paper', () => {
  const r = buildShiftReport(SAMPLE_NIGHT);

  it('the header', () => {
    expect([r.tillName, r.shopName, r.openedBy, r.closedBy, r.pinOnLoginOf]).toEqual([
      'DESKTOP-7Q2M1KD',
      "Cheese O'Clock",
      'Ali Raza',
      'Imran Ali',
      'Ali Raza',
    ]);
    // Opened 01/10/2026 16:02 and closed 02/10/2026 01:48, Pakistan time.
    expect([r.openedAt, r.closedAt]).toEqual(['2026-10-01T11:02:00.000Z', '2026-10-01T20:48:00.000Z']);
  });

  it('SALES: food, delivery, the four kinds of discount, tax, TOTAL, refunds, NET SALES and the average bill', () => {
    expect(r.sales).toEqual(SAMPLE_SALES);
    const s = r.sales;
    expect(s.foodCents + s.delivery.cents - sum(s.discounts.map((d) => d.cents)) + s.taxCents).toBe(s.billedCents);
  });

  it('MONEY TAKEN: each method’s money as the sample, refunds off; NET SALES = MONEY TAKEN, no part payments', () => {
    // A split cash + card order and five outside riders' EasyPaisa + cash settlements count under both methods.
    expect(r.payments).toEqual([
      { method: 'cash', orderCount: 38, cents: 9_635_000 },
      { method: 'card', orderCount: 12, cents: 3_526_000 },
      { method: 'easypaisa', orderCount: 6, cents: 1_743_000 },
      { method: 'jazzcash', orderCount: 3, cents: 920_000 },
      { method: 'foodpanda', orderCount: 9, cents: 3_167_100 },
    ]);
    expect(r.paymentRefunds).toEqual([{ method: 'cash', orderCount: 1, cents: 172_500 }]);
    expect(r.moneyTakenCents).toBe(18_818_600);
    expect(r.moneyTakenCents).toBe(r.sales.netCents);
    expect(r.partPaymentsCents).toBe(0);
  });

  it('BY CHANNEL: the own and outside riders under Delivery, and the channels add up to TOTAL (with tax)', () => {
    expect(r.channels).toEqual(SAMPLE_CHANNELS);
    expect(sum(r.channels.map((c) => c.billedCents))).toBe(r.sales.billedCents);
    expect(sum(r.channels.map((c) => c.orderCount))).toBe(r.sales.orderCount);
    // Own riders 29,600.00 + outside riders 25,530.00 = Delivery 55,130.00.
    const delivery = r.channels.find((c) => c.channel === 'delivery')!;
    expect(delivery.billedCents - delivery.outside!.billedCents).toBe(2_960_000);
  });

  it('CANCELLED AND REFUNDED, and UNPAID - CARRIED OVER', () => {
    expect(r.cancelled).toEqual([
      { orderNumber: '20261001-0021', at: '2026-10-01T16:14:00.000Z', cents: 207_000, made: 'made', reason: 'Customer left' },
      { orderNumber: '20261001-0047', at: '2026-10-01T18:40:00.000Z', cents: 138_000, made: 'not_made', reason: 'Wrong item rung' },
    ]);
    expect(r.refunds).toEqual([
      { orderNumber: '20261001-0033', at: '2026-10-01T17:05:00.000Z', method: 'cash', cents: 172_500, full: true, reason: 'Cold pizza' },
    ]);
    expect(r.unpaid).toEqual({
      orders: [
        { orderNumber: '20261001-0064', at: '2026-10-01T20:12:00.000Z', takenBy: 'Ali Raza', cents: 247_000 },
        { orderNumber: '20261001-0066', at: '2026-10-01T20:30:00.000Z', takenBy: 'Website', cents: 159_000 },
      ],
      reason: 'Rider still out',
    });
  });

  it('CASH DRAWER and CASH COUNTED: cash taken out 5 / 3,750.00 with the rider tips a part of it, riders 8 / 1,800.00, SHORT 100.00', () => {
    expect(r.drawer).toEqual({
      openingCents: 500_000,
      cashSalesCents: 9_635_000,
      cashRefundsCents: 172_500,
      cashIn: { count: 1, cents: 200_000 },
      cashOut: { count: 5, cents: 375_000 },
      riderTips: { count: 3, cents: 60_000 },
      riderKept: { count: 8, cents: 180_000, tripCount: 0 },
      otherCents: 0,
      expectedCents: 9_607_500,
      countedCents: 9_597_500,
      varianceCents: -10_000,
      countedNotes: SAMPLE_NIGHT.drawer.countedNotes,
    });
    expect(shiftReportDrawerAddsUp(r)).toBe(true);
    const notes = r.drawer.countedNotes!;
    expect(sum(notes.notes.map((n) => n.faceCents * n.count)) + notes.otherCents).toBe(r.drawer.countedCents);
    // The fixture's own money agrees with its drawer: the cash in and out of the payment rows, the riders' charges.
    expect(sum(SAMPLE_NIGHT.payments.filter((p) => p.method === 'cash' && p.cents > 0).map((p) => p.cents))).toBe(r.drawer.cashSalesCents);
    expect(-sum(SAMPLE_NIGHT.payments.filter((p) => p.method === 'cash' && p.cents < 0).map((p) => p.cents))).toBe(r.drawer.cashRefundsCents);
    const outside = SAMPLE_NIGHT.settled.filter((o) => o.outside);
    expect([outside.length, sum(outside.map((o) => o.deliveryChargeCents))]).toEqual([8, 180_000]);
  });

  it('ITEMS SOLD (158): seven categories in the menu’s order, every item most sold first, adding up to Food', () => {
    expect(r.items).toEqual(
      SAMPLE_ITEMS.map(([category, quantity, cents, items]) => ({
        category,
        quantity,
        cents,
        items: items.map(([name, q, c]) => ({ name, quantity: q, cents: c })),
      })),
    );
    expect(r.items.map((c) => c.category)).toEqual([...SAMPLE_NIGHT_CATEGORIES]);
    expect(r.items[1]?.items[0]).toEqual({ name: 'Fajita Pizza — Medium', quantity: 5, cents: 750_000 });
    expect(sum(r.items.map((c) => c.quantity))).toBe(158);
    expect(sum(r.items.map((c) => c.cents))).toBe(r.sales.foodCents);
    for (const c of r.items) {
      expect(sum(c.items.map((i) => i.quantity))).toBe(c.quantity);
      expect(sum(c.items.map((i) => i.cents))).toBe(c.cents);
    }
    // #0033 was refunded in full: its Malai Supreme stays in the four sold.
    expect(SAMPLE_NIGHT.lines.filter((l) => l.orderId === 'ord-0033').map((l) => l.name)).toEqual(['Malai Supreme — Medium']);
    // The delivery charges are never items.
    expect(r.items.some((c) => c.items.some((i) => /delivery/i.test(i.name)))).toBe(false);
  });

  it('ORDERS (62): every order paid, in the order paid, adding up to TOTAL (with tax)', () => {
    expect(r.orders).toHaveLength(62);
    expect(r.orders).toHaveLength(r.sales.orderCount);
    expect(sum(r.orders.map((o) => o.totalCents))).toBe(18_991_100);
    expect(new Set(r.orders.map((o) => o.orderNumber)).size).toBe(62);
    for (let i = 1; i < r.orders.length; i += 1) expect(r.orders[i]!.paidAt >= r.orders[i - 1]!.paidAt).toBe(true);
    // #0001 to #0008 as the ORDERS sample shows them (#0007 not refunded here: the night's refund is #0033).
    const row = (o: ShiftReport['orders'][number]) => [o.orderNumber.slice(-4), o.paidAt.slice(11, 16), o.channel, o.outside, o.methods.join(' + '), o.totalCents, o.refunded];
    expect(r.orders.slice(0, 8).map(row)).toEqual([
      ['0001', '11:20', 'takeaway', false, 'cash', 253_000, 'no'],
      ['0002', '11:41', 'delivery', false, 'cash', 437_000, 'no'],
      ['0003', '12:05', 'foodpanda', false, 'foodpanda', 264_500, 'no'],
      ['0004', '12:22', 'takeaway', false, 'card', 172_500, 'no'],
      ['0005', '12:48', 'web_pickup', false, 'cash', 289_800, 'no'],
      ['0006', '13:02', 'delivery', true, 'easypaisa + cash', 437_000, 'no'],
      ['0007', '13:15', 'takeaway', false, 'cash', 172_500, 'no'],
      ['0008', '13:31', 'takeaway', false, 'jazzcash', 356_500, 'no'],
    ]);
    const byNumber = (n: string) => r.orders.find((o) => o.orderNumber === `20261001-${n}`)!;
    const place = (n: string) => r.orders.indexOf(byNumber(n));
    // Refunded in full; the split payment; an outside rider's EasyPaisa settlement.
    expect(byNumber('0033').refunded).toBe('full');
    expect(r.orders.filter((o) => o.refunded !== 'no').map((o) => o.orderNumber)).toEqual(['20261001-0033']);
    expect(byNumber('0062').methods).toEqual(['cash', 'card']);
    expect(byNumber('0059')).toMatchObject({ channel: 'delivery', outside: true, methods: ['easypaisa', 'cash'] });
    // Paid order, not number order: #0013 (19:12) before #0012, whose rider came back at 19:20;
    // #0040 and #0045 came back together at 22:50, in number order.
    expect(place('0013')).toBeLessThan(place('0012'));
    expect(place('0045')).toBe(place('0040') + 1);
    expect(byNumber('0040').paidAt).toBe(byNumber('0045').paidAt);
    // The night ends with the orders paid after midnight.
    expect(r.orders[r.orders.length - 1]?.orderNumber).toBe('20261001-0065');
  });

  it('a part refund flags its order part; the full one stays full', () => {
    const o44 = SAMPLE_NIGHT.settled.find((o) => o.orderNumber === '20261001-0044')!;
    const partly: ShiftReportFacts = {
      ...SAMPLE_NIGHT,
      settled: SAMPLE_NIGHT.settled.map((o) => (o === o44 ? { ...o, hasRefund: true } : o)),
      payments: [...SAMPLE_NIGHT.payments, pay(o44.id, 'card', -50_000)],
      refunds: [...SAMPLE_NIGHT.refunds, { ...refund(o44, 'card', 50_000, false, 'Missing dip'), at: '2026-10-01T18:10:00.000Z' }],
    };
    const p = buildShiftReport(partly);
    expect(p.orders.filter((o) => o.refunded !== 'no').map((o) => [o.orderNumber, o.refunded])).toEqual([
      ['20261001-0033', 'full'],
      ['20261001-0044', 'part'],
    ]);
    expect(p.sales.refunds).toEqual({ orderCount: 2, cents: 222_500 });
    // Gross: the order stays in SALES, the items and the list.
    expect([p.sales.billedCents, p.orders.length, sum(p.items.map((c) => c.cents))]).toEqual([18_991_100, 62, 16_876_000]);
    expect(p.moneyTakenCents).toBe(p.sales.netCents);
  });

  it('the facts in any order (orders, lines, payments, each order’s methods) give the same report', () => {
    const reversed: ShiftReportFacts = {
      ...SAMPLE_NIGHT,
      settled: [...SAMPLE_NIGHT.settled].reverse().map((o) => ({ ...o, methods: [...o.methods].reverse() })),
      lines: [...SAMPLE_NIGHT.lines].reverse(),
      payments: [...SAMPLE_NIGHT.payments].reverse(),
    };
    expect(buildShiftReport(reversed)).toEqual(r);
    expect(shiftReportJson(buildShiftReport(reversed))).toBe(shiftReportJson(r));
  });

  it('the stored text is the report; no cost, waste, commission or profit in it', () => {
    const text = shiftReportJson(r);
    expect(JSON.parse(text)).toEqual(r);
    expect(Object.keys(JSON.parse(text) as object)).toEqual(Object.keys(NIGHT_REPORT));
    expect(/cost|waste|commission|profit/i.test(text)).toBe(false);
  });
});
