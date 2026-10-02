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

/**
 * The shift report's builder (step 19c-2): SALES, MONEY TAKEN, BY CHANNEL,
 * the cancels and refunds, the CASH DRAWER and the unpaid list, worked out
 * from the facts the till reads at the close; and the one writer of the
 * stored text. ITEMS SOLD and the orders list come in the next step.
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
  items: [],
  orders: [],
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

  it('writes the count by note in its own stored order, and the lists still to come (items, orders) in full', () => {
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
  });
});

describe('the facts', () => {
  it('a line with no menu item and no category is taken as it is; food comes from the orders’ stored subtotals', () => {
    const l: ShiftReportFactsLine = { ...line('0001', 'Test Dip', 10_000), menuItemId: null, categoryName: null, categoryRank: null };
    const r = buildShiftReport(facts({ settled: [sale('0001', 10_000)], lines: [l] }));
    expect(r.sales.foodCents).toBe(10_000);
    expect(r.items).toEqual([]);
  });
});
