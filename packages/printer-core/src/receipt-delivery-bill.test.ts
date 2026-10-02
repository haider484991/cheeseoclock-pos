/**
 * THE DELIVERY BILL on paper (v0.7.34; the owner, 2 Oct 2026: "Food / Sales
 * tax / FOOD TOTAL (with tax) / Delivery charge / CUSTOMER PAYS"). A delivery
 * with a delivery charge prints these rows, from shared-types deliveryBillOf,
 * in place of Subtotal / Tax / TOTAL; the "Delivery Charge (Rs 200)" line no
 * longer prints as an item. The charge keeps its 15% tax (Q1), printed on its
 * own "Sales tax on delivery 15%" line when the discount left the charge
 * alone. Everything after the totals (payments, the state lines, the footer,
 * FBR) prints exactly as before.
 *
 * Times are Pakistan wall-clock instants (papers print Pakistan time). Every
 * name, number and amount is made up.
 */
import { describe, expect, it } from 'vitest';
import { deliveryBillOf, type Cents, type OrderNumber, type OrderSnapshot, type UUID } from '@cheeseoclock/shared-types';
import { QR_MARKER, decodeEscPos } from './escpos-decode.js';
import {
  receiptDocumentFor,
  renderReceipt,
  riderSettledWhileOut,
  type ReceiptBranding,
  type RenderReceiptOpts,
} from './receipt-renderer.js';

const id = (s: string) => s as UUID;
const cents = (n: number) => n as Cents;
/** Pakistan wall-clock time (UTC+5) on 2 Oct 2026. */
const at = (h: number, m: number) => new Date(Date.UTC(2026, 9, 2, h - 5, m));
const iso = (h: number, m: number) => at(h, m).toISOString();

type Line = OrderSnapshot['items'][number];
type Discount = OrderSnapshot['discounts'][number];

function item(key: string, name: string, lineCents: number, taxRateBps: number, extra: Partial<Line> = {}): Line {
  return {
    id: id(`i-${key}`),
    orderId: id('o1'),
    menuItemId: id(`m-${key}`),
    comboId: null,
    parentOrderItemId: null,
    quantity: 1,
    unitPriceCents: cents(lineCents),
    lineTotalCents: cents(lineCents),
    taxCategoryId: id('t1'),
    notes: null,
    kitchenStatus: 'ready',
    menuItemName: name,
    categoryName: 'Test Food',
    prepStation: 'kitchen',
    taxRateBps,
    modifiers: [],
    ...extra,
  };
}

const BIG_TWO = () => item('deal', 'Big Two', 360_000, 1500, { categoryName: 'Value Deals', noDiscount: true });
const FRIES = () => item('fries', 'Fries', 30_000, 1500);
const PIZZA = () => item('pizza', 'Test Pizza', 220_000, 1500);
const CHARGE = (bps: number) => item('fee', 'Delivery Charge (Rs 200)', 20_000, bps, { categoryName: 'Delivery Charges' });

/**
 * A cash-on-delivery order out with the shop's rider, nothing paid. The
 * stored totals are given (worked by hand in each case); the total is
 * subtotal − discount + tax, as the till stores it.
 */
function delivery(items: Line[], stored: { discount?: number; tax: number }, discounts: Discount[] = []): OrderSnapshot {
  const subtotal = items.reduce((n, l) => n + l.lineTotalCents, 0);
  const discount = stored.discount ?? 0;
  return {
    order: {
      id: id('o1'),
      orderNumber: '20261002-0042' as OrderNumber,
      mode: 'delivery',
      status: 'out_for_delivery',
      tableId: null,
      customerId: id('c1'),
      cashierId: id('u1'),
      shiftId: id('s1'),
      source: 'pos',
      notes: null,
      subtotalCents: cents(subtotal),
      discountCents: cents(discount),
      taxCents: cents(stored.tax),
      totalCents: cents(subtotal - discount + stored.tax),
      createdAt: iso(19, 30),
      sentAt: iso(19, 31),
      paidAt: null,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      assignedRiderId: id('r1'),
      dispatchedAt: iso(19, 50),
      deliveredAt: null,
    },
    items,
    discounts,
    payments: [],
    cashierName: 'Test Cashier',
    tableLabel: null,
    customerName: 'Test Customer',
    customerPhone: '0300 0000001',
    deliveryAddress: 'House 1, Test Street, Test Town',
    rider: { id: id('r1'), name: 'Test Rider', phone: '0311 0000002' },
  };
}

/** The owner's example: Big Two Rs 3,600 and Fries Rs 300 at 15%, and the Rs 200 charge (0% or 15%). */
const ownerExample = (chargeBps: 0 | 1500) => delivery([BIG_TWO(), FRIES(), CHARGE(chargeBps)], { tax: 58_500 + (chargeBps ? 3_000 : 0) });

/** A discount row of the till's: 10% off with the given frozen rule. */
function tenPercent(amountCents: number, rule: Partial<Pick<Discount, 'alsoOffDeliveryCharge' | 'skipsNoDiscountLines'>>, reason: string | null = 'Staff'): Discount {
  return {
    id: id('d1'),
    orderId: id('o1'),
    discountType: 'percent',
    value: 10,
    reason,
    amountCents: cents(amountCents),
    appliedByUserId: id('u1'),
    approvedByUserId: null,
    source: null,
    ...rule,
  };
}

/**
 * Big Two Rs 3,600 (a value deal), a Rs 2,200 pizza and the Rs 200 charge,
 * all at 15%, with a staff 10% that left the deal and the charge alone: Rs
 * 220 off the pizza; tax 540 + 297 = Rs 837 on the food, Rs 30 on the charge.
 */
const dealAndStaff = () =>
  delivery([BIG_TWO(), PIZZA(), CHARGE(1500)], { discount: 22_000, tax: 86_700 }, [
    tenPercent(22_000, { alsoOffDeliveryCharge: false, skipsNoDiscountLines: true }),
  ]);

/** Paid in cash when it was delivered (20:10): a receipt. */
function paidOnDelivery(s: OrderSnapshot): OrderSnapshot {
  s.order.status = 'paid';
  s.order.paidAt = iso(20, 10);
  s.order.deliveredAt = iso(20, 10);
  s.payments = [
    {
      id: id('p1'),
      orderId: id('o1'),
      method: 'cash',
      amountCents: s.order.totalCents,
      tenderedCents: cents(500_000),
      referenceNo: null,
      receivedByUserId: id('u1'),
      paidAt: iso(20, 10),
    },
  ];
  return s;
}

/** The same order with its charge line under another name: what the paper printed before the delivery bill. */
function asBefore(s: OrderSnapshot): OrderSnapshot {
  return { ...s, items: s.items.map((l) => (l.menuItemName.startsWith('Delivery Charge') ? { ...l, menuItemName: 'Test Area Fee' } : l)) };
}

const branding: ReceiptBranding = { storeName: 'Test Shop', branchLine: 'Shop 1, Test Road', phoneLine: '0300 0000000' };
const render = (s: OrderSnapshot, opts: Partial<RenderReceiptOpts> = {}) => renderReceipt(s, { branding, ...opts });
const rowsOf = (bytes: Uint8Array) => decodeEscPos(bytes).map((r) => r.text);
const textOf = (bytes: Uint8Array) => rowsOf(bytes).join('\n');

/** The rows from the first that matches `first`, `n` of them. */
function rowsFrom(rows: string[], first: RegExp, n: number): string[] {
  const start = rows.findIndex((r) => first.test(r));
  expect(start, String(first)).toBeGreaterThan(-1);
  return rows.slice(start, start + n);
}

/** Each row matches its pattern, one for one. */
function expectRows(rows: string[], patterns: RegExp[]): void {
  expect(rows.length).toBe(patterns.length);
  patterns.forEach((p, i) => expect(rows[i], `row ${i}: ${String(p)}`).toMatch(p));
}

/** The paper's bytes from the first byte of `marker` (ASCII) to the end. */
function tailFrom(bytes: Uint8Array, marker: string): number[] {
  const want = [...marker].map((c) => c.charCodeAt(0));
  const all = [...bytes];
  const at = all.findIndex((_, i) => want.every((c, k) => all[i + k] === c));
  expect(at, marker).toBeGreaterThan(-1);
  return all.slice(at);
}

/** Rupees as the paper prints them ("4,715.00") to paisa. */
const paisa = (s: string) => Math.round(Number(s.replace(/,/g, '')) * 100);
/** The amount at the right of the row that starts with `label`, or on the row under it when the label wrapped. */
function amountOf(rows: string[], label: string): number {
  const i = rows.findIndex((r) => r.startsWith(label));
  expect(i, label).toBeGreaterThan(-1);
  const m = /(?:Rs )?([\d,]+\.\d\d)\s*$/.exec(rows[i]!) ?? /(?:Rs )?([\d,]+\.\d\d)\s*$/.exec(rows[i + 1] ?? '');
  expect(m, label).not.toBeNull();
  return paisa(m![1]!);
}

describe('the delivery bill on paper', () => {
  it('the owner’s example, the charge zero-rated: items, Food, Sales tax 15%, FOOD TOTAL, Delivery charge, the = rule, CUSTOMER PAYS', () => {
    const rows = rowsOf(render(ownerExample(0)));
    expectRows(rowsFrom(rows, /^1x Big Two/, 9), [
      /^1x Big Two\s+3,600\.00$/,
      /^1x Fries\s+300\.00$/,
      /^-{48}$/,
      /^Food\s+3,900\.00$/,
      /^Sales tax 15%\s+585\.00$/,
      /^FOOD TOTAL \(with tax\)\s+Rs 4,485\.00$/,
      /^Delivery charge\s+200\.00$/,
      /^={48}$/,
      /^CUSTOMER PAYS\s+Rs 4,685\.00$/,
    ]);
    const text = rows.join('\n');
    // The charge prints once, under FOOD TOTAL; the old rows are gone.
    expect(text).not.toContain('Delivery Charge (Rs 200)');
    expect(text).not.toContain('Subtotal');
    expect(text).not.toMatch(/^Tax/m);
    expect(text).not.toMatch(/^TOTAL/m);
    // A zero-rated charge has no tax line of its own.
    expect(text).not.toContain('Sales tax on delivery');
  });

  it('the charge taxed at 15% (the live menu, Q1): Sales tax on delivery 15% 30.00, FOOD TOTAL Rs 4,515.00, CUSTOMER PAYS Rs 4,715.00', () => {
    const rows = rowsOf(render(ownerExample(1500)));
    expectRows(rowsFrom(rows, /^Food\s/, 8), [
      /^Food\s+3,900\.00$/,
      /^Sales tax 15%\s+585\.00$/,
      /^Sales tax on delivery 15%\s+30\.00$/,
      /^FOOD TOTAL \(with tax\)\s+Rs 4,515\.00$/,
      /^Delivery charge\s+200\.00$/,
      /^={48}$/,
      /^CUSTOMER PAYS\s+Rs 4,715\.00$/,
      /^-{48}$/,
    ]);
    expect(rows.join('\n')).not.toContain('Delivery Charge (Rs 200)');
  });

  it('the printed figures add up: FOOD TOTAL + Delivery charge = CUSTOMER PAYS = the stored total, and each is deliveryBillOf’s', () => {
    for (const s of [ownerExample(0), ownerExample(1500), dealAndStaff(), paidOnDelivery(ownerExample(1500))]) {
      const bill = deliveryBillOf(s)!;
      for (const width of [48, 32] as const) {
        const rows = rowsOf(render(s, { width }));
        expect(amountOf(rows, 'Food ')).toBe(bill.foodCents);
        expect(amountOf(rows, 'FOOD TOTAL')).toBe(bill.foodTotalCents);
        expect(amountOf(rows, 'Delivery charge')).toBe(bill.deliveryChargeCents);
        expect(amountOf(rows, 'CUSTOMER PAYS')).toBe(s.order.totalCents);
        expect(amountOf(rows, 'FOOD TOTAL') + amountOf(rows, 'Delivery charge')).toBe(amountOf(rows, 'CUSTOMER PAYS'));
      }
    }
  });

  it('at 58 mm (32 columns): FOOD TOTAL wraps onto two rows, its amount right-aligned under it; no row is wider than the paper', () => {
    for (const s of [ownerExample(0), ownerExample(1500), dealAndStaff()]) {
      const lines = decodeEscPos(render(s, { width: 32, branding: { ...branding, storeTagline: 'Pizza · Burgers · Late-night' } }));
      for (const r of lines) expect(r.text.length * r.scale, JSON.stringify(r.text)).toBeLessThanOrEqual(32);
      const rows = lines.map((r) => r.text);
      const i = rows.indexOf('FOOD TOTAL (with tax)');
      expect(i).toBeGreaterThan(-1);
      expect(rows[i + 1]).toMatch(/^ +Rs [\d,]+\.\d\d$/);
      expect(rows[i + 1]).toHaveLength(32);
      expect(rows[i + 2]).toMatch(/^Delivery charge +200\.00$/);
      expect(rows.find((r) => r.startsWith('CUSTOMER PAYS'))).toHaveLength(32);
    }
    const taxed = rowsOf(render(ownerExample(1500), { width: 32 }));
    expect(taxed).toContain('Sales tax on delivery 15%  30.00');
    expect(taxed[taxed.indexOf('FOOD TOTAL (with tax)') + 1]).toBe(`${' '.repeat(21)}Rs 4,515.00`);
    // And at 80 mm, every row fits too.
    for (const r of decodeEscPos(render(dealAndStaff(), { width: 48 }))) expect(r.text.length * r.scale).toBeLessThanOrEqual(48);
  });

  it('a DUPLICATE: the = rule over CUSTOMER PAYS says DUPLICATE; every figure is the original’s', () => {
    const original = rowsOf(render(ownerExample(1500)));
    const dup = rowsOf(
      render(ownerExample(1500), { stamp: { kind: 'copy', number: 2, printedAt: at(20, 0), firstPrintedAt: at(19, 51) } }),
    );
    const totals = (rows: string[]) => rowsFrom(rows, /^Food\s/, 8);
    const [o, d] = [totals(original), totals(dup)];
    expect(d[5]).toMatch(/^=+ DUPLICATE =+$/);
    expect(d[5]).toHaveLength(48);
    expect([...d.slice(0, 5), ...d.slice(6)]).toEqual([...o.slice(0, 5), ...o.slice(6)]);
    expect(dup.join('\n')).toContain('** DUPLICATE - Copy #2 **');
  });

  it('cash on delivery: the title and what the rider collects are as before (BILL - NOT PAID / CASH ON DELIVERY / TO COLLECT / Pay the rider)', () => {
    const s = ownerExample(1500);
    const rows = rowsOf(render(s));
    expect(rows).toContain('BILL - NOT PAID');
    expect(rows).toContain('CASH ON DELIVERY');
    expect(rows.some((r) => /^TO COLLECT\s+Rs 4,715\.00$/.test(r))).toBe(true);
    expect(rows).toContain('NOT PAID');
    expect(rows).toContain('Pay the rider Rs 4,715.00');
    // Byte for byte what the old layout printed after its totals, the shop copy too.
    for (const copy of ['customer', 'shop'] as const) {
      expect(tailFrom(render(s, { copy }), 'TO COLLECT')).toEqual(tailFrom(render(asBefore(s), { copy }), 'TO COLLECT'));
    }
  });

  it('the shop copy carries the same bill, SHOP COPY and the signature line', () => {
    const rows = rowsOf(render(ownerExample(1500), { copy: 'shop' }));
    expect(rows).toContain('SHOP COPY');
    expect(rowsFrom(rows, /^Food\s/, 7)).toEqual(rowsFrom(rowsOf(render(ownerExample(1500))), /^Food\s/, 7));
    expect(rows.some((r) => r.startsWith('Received by: '))).toBe(true);
  });

  it('paid on delivery with live FBR: PAID - CASH / PAID ON DELIVERY, and the FBR number and QR exactly as before', () => {
    const fbr = { irn: '000000-261002201000-0001', qrPayload: 'https://verify.example/000000-261002201000-0001' };
    const s = paidOnDelivery(ownerExample(1500));
    const bytes = render(s, { fbr });
    const rows = rowsOf(bytes);
    expect(rows).toContain('RECEIPT');
    expect(rows.some((r) => /^CUSTOMER PAYS\s+Rs 4,715\.00$/.test(r))).toBe(true);
    expect(rows.some((r) => /^Cash\s+4,715\.00$/.test(r))).toBe(true);
    expect(rows).toContain('PAID - CASH');
    expect(rows).toContain('PAID ON DELIVERY');
    expect(rows).toContain(`FBR Invoice No: ${fbr.irn}`);
    expect(rows).toContain(QR_MARKER);
    // Payments, state, footer, FBR number and QR: the same bytes the old layout printed.
    expect(tailFrom(bytes, 'Cash ')).toEqual(tailFrom(render(asBefore(s), { fbr }), 'Cash '));
    expect(tailFrom(bytes, 'FBR Digital Invoice')).toEqual(tailFrom(render(asBefore(s), { fbr }), 'FBR Digital Invoice'));
  });

  it('a customer-prepaid order (paid before the rider left): a receipt with the same bill, PREPAID - RIDER COLLECTS NOTHING', () => {
    const s = ownerExample(1500);
    s.order.paidAt = iso(19, 40);
    s.payments = [
      {
        id: id('p1'),
        orderId: id('o1'),
        method: 'easypaisa',
        amountCents: s.order.totalCents,
        tenderedCents: null,
        referenceNo: null,
        receivedByUserId: id('u1'),
        paidAt: iso(19, 40),
      },
    ];
    const rows = rowsOf(render(s));
    expect(rows).toContain('RECEIPT');
    expect(rows.some((r) => /^FOOD TOTAL \(with tax\)\s+Rs 4,515\.00$/.test(r))).toBe(true);
    expect(rows.some((r) => /^CUSTOMER PAYS\s+Rs 4,715\.00$/.test(r))).toBe(true);
    expect(rows).toContain('PAID - EASYPAISA');
    expect(rows).toContain('PREPAID - RIDER COLLECTS NOTHING');
    expect(rows.join('\n')).not.toContain('TO COLLECT');
  });

  it('a website order: the same bill, and "Cashier: Website"', () => {
    const s = ownerExample(1500);
    s.order.source = 'web';
    s.order.notes = '[web] Test note, ring twice';
    const rows = rowsOf(render(s));
    expect(rows.some((r) => /^Cashier: Website\b/.test(r))).toBe(true);
    expect(rows).toContain('Order note: Test note, ring twice');
    expectRows(rowsFrom(rows, /^Food\s/, 7), [
      /^Food\s+3,900\.00$/,
      /^Sales tax 15%\s+585\.00$/,
      /^Sales tax on delivery 15%\s+30\.00$/,
      /^FOOD TOTAL \(with tax\)\s+Rs 4,515\.00$/,
      /^Delivery charge\s+200\.00$/,
      /^={48}$/,
      /^CUSTOMER PAYS\s+Rs 4,715\.00$/,
    ]);
    expect(rows.join('\n')).not.toContain('Delivery Charge (Rs 200)');
  });

  it('a value deal and a staff 10%: the discount under Food in the bill’s own words, Sales tax 837.00, on delivery 30.00, Rs 6,447.00 / Rs 6,647.00', () => {
    for (const width of [48, 32] as const) {
      const rows = rowsOf(render(dealAndStaff(), { width }));
      const text = rows.join('\n');
      // The label wraps on either paper; the amount stays at the right, under it.
      expect(text).toMatch(/^Food\s+5,800\.00\nDiscount\s+10%\s+\(Staff,\s+food\s+only,\s+not\s+on\s+value\s+deals\)\s+- 220\.00\nSales tax 15%\s+837\.00$/m);
      expect(rows.some((r) => /^Sales tax on delivery 15%\s+30\.00$/.test(r))).toBe(true);
      expect(text).toMatch(/^FOOD TOTAL \(with tax\)\s+Rs 6,447\.00$/m);
      expect(text).toMatch(/^CUSTOMER PAYS\s+Rs 6,647\.00$/m);
      expect(text).not.toContain('Delivery Charge (Rs 200)');
    }
  });

  it('a discount that also came off the charge (the owner’s switch, or a row from before 0.7.26): all the tax on one Sales tax line', () => {
    // Test Pizza Rs 2,200 and the charge, 10% of Rs 2,400 = Rs 240 off; 15% of Rs 2,160 = Rs 324.
    for (const rule of [{ alsoOffDeliveryCharge: true }, {}]) {
      const s = delivery([PIZZA(), CHARGE(1500)], { discount: 24_000, tax: 32_400 }, [tenPercent(24_000, rule, null)]);
      const rows = rowsOf(render(s));
      expect(rows.filter((r) => r.startsWith('Sales tax'))).toHaveLength(1);
      expectRows(rowsFrom(rows, /^Food\s/, 7), [
        /^Food\s+2,200\.00$/,
        /^Discount\b.*- 240\.00$/,
        /^Sales tax 15%\s+324\.00$/,
        /^FOOD TOTAL \(with tax\)\s+Rs 2,284\.00$/,
        /^Delivery charge\s+200\.00$/,
        /^={48}$/,
        /^CUSTOMER PAYS\s+Rs 2,484\.00$/,
      ]);
      expect(rows.join('\n')).not.toContain('food only');
    }
  });

  it('Subtotal / Tax / TOTAL as before, byte for byte, for every order that is not a delivery with a charge', () => {
    const takeaway = ownerExample(1500);
    takeaway.order.mode = 'takeaway';
    const foodpanda = ownerExample(1500);
    foodpanda.order.mode = 'foodpanda';
    const noCharge = delivery([BIG_TWO(), FRIES()], { tax: 58_500 });
    const zeroCharge = delivery([BIG_TWO(), FRIES(), { ...CHARGE(1500), unitPriceCents: cents(0), lineTotalCents: cents(0) }], { tax: 58_500 });
    // A legacy 100% off over every line, the charge included: Rs 0 to pay, below the charge.
    const belowCharge = delivery([PIZZA(), CHARGE(1500)], { discount: 240_000, tax: 0 }, [
      { ...tenPercent(240_000, { alsoOffDeliveryCharge: true }, 'Test complaint'), value: 100 },
    ]);
    for (const [name, s] of Object.entries({ takeaway, foodpanda, noCharge, zeroCharge, belowCharge })) {
      expect(deliveryBillOf(s), name).toBeNull();
      const text = textOf(render(s));
      expect(text, name).toMatch(/^Subtotal\s/m);
      expect(text, name).toMatch(/^TOTAL\s+Rs /m);
      expect(text, name).not.toContain('FOOD TOTAL');
      expect(text, name).not.toContain('CUSTOMER PAYS');
    }
    // The charge still prints as an item there, as it always did.
    expect(textOf(render(takeaway))).toMatch(/^1x Delivery Charge \(Rs 200\)\s+200\.00$/m);
    expect(textOf(render(foodpanda))).toMatch(/^1x Delivery Charge \(Rs 200\)\s+200\.00$/m);
  });
});

/**
 * SENT OUT WITH AN OUTSIDE RIDER (v0.7.34, Send out): no rider of the
 * shop's own named, and what he keeps frozen on the order (riderKeepsCents).
 * The owner's example with the taxed charge: CUSTOMER PAYS Rs 4,715, he keeps
 * Rs 200 and hands in Rs 4,515.
 */
function outside(s: OrderSnapshot = ownerExample(1500), keep = 20_000): OrderSnapshot {
  s.order.assignedRiderId = null;
  s.order.riderKeepsCents = cents(keep);
  s.rider = null;
  return s;
}

type Payment = OrderSnapshot['payments'][number];
const payment = (key: string, method: Payment['method'], amount: number, when: string): Payment => ({
  id: id(`p-${key}`),
  orderId: id('o1'),
  method,
  amountCents: cents(amount),
  tenderedCents: null,
  referenceNo: amount < 0 ? 'partial-refund: Test item refused' : null,
  receivedByUserId: id('u1'),
  paidAt: when,
});

/**
 * "Has the rider paid the shop?" — "Paid now", at 19:55 while he is out
 * (it left at 19:50). Cash: one payment of the whole total. A wallet (owner
 * Q4): the food total by EasyPaisa and his fee in cash.
 */
function riderPaid(s: OrderSnapshot, how: 'cash' | 'wallet' = 'cash'): OrderSnapshot {
  const keep = s.order.riderKeepsCents ?? 0;
  s.order.paidAt = iso(19, 55);
  s.payments =
    how === 'cash'
      ? [payment('cash', 'cash', s.order.totalCents, iso(19, 55))]
      : [payment('ep', 'easypaisa', s.order.totalCents - keep, iso(19, 55)), payment('fee', 'cash', keep, iso(19, 55))];
  return s;
}

/** Money given back while he is still out (it goes back through him). */
function refundedWhileOut(s: OrderSnapshot, amount: number, m = 5): OrderSnapshot {
  s.payments.push(payment(`rf${m}`, 'cash', -amount, iso(20, m)));
  return s;
}

/** The customer paid by EasyPaisa at 19:40, before the food left at 19:50. */
function customerPrepaid(s: OrderSnapshot): OrderSnapshot {
  s.order.paidAt = iso(19, 40);
  s.payments = [payment('ep', 'easypaisa', s.order.totalCents, iso(19, 40))];
  return s;
}

/** Delivered at 20:10 (Delivered on the board): the order is closed as paid. */
function delivered(s: OrderSnapshot): OrderSnapshot {
  s.order.status = 'paid';
  s.order.deliveredAt = iso(20, 10);
  return s;
}

/** The rider lines a paper carries (the SHOP COPY's alone). */
const riderRows = (rows: string[]) => rows.filter((r) => /Outside rider|RIDER (GIVES|PAID)|Refunded to the rider|from the drawer/.test(r));

/** The three bytes just before `marker` turn bold on (ESC E 1). */
function boldBefore(bytes: Uint8Array, marker: string): boolean {
  const all = [...bytes];
  const start = all.length - tailFrom(bytes, marker).length;
  return all[start - 3] === 0x1b && all[start - 2] === 0x45 && all[start - 1] === 1;
}

describe('an outside rider on paper (Send out)', () => {
  it('riderSettledWhileOut: an outside delivery, still out, paid at or after it left — from the order’s own facts', () => {
    expect(riderSettledWhileOut(riderPaid(outside()).order)).toBe(true);
    const atTheMinute = outside();
    atTheMinute.order.paidAt = atTheMinute.order.dispatchedAt;
    expect(riderSettledWhileOut(atTheMinute.order)).toBe(true);
    // He keeps nothing (no charge, or already paid for this trip): still an outside rider.
    expect(riderSettledWhileOut(riderPaid(outside(ownerExample(1500), 0)).order)).toBe(true);

    const noTimeOut = riderPaid(outside());
    noTimeOut.order.dispatchedAt = null;
    const takeaway = riderPaid(outside());
    takeaway.order.mode = 'takeaway';
    const ownRider = riderPaid(ownerExample(1500));
    const notThis: Record<string, OrderSnapshot> = {
      'not paid yet': outside(),
      'the customer paid before it left': customerPrepaid(outside()),
      'delivered (status paid)': delivered(riderPaid(outside())),
      'the shop’s own rider (an order from before 0.7.34: no keep at all)': ownRider,
      'no time it left': noTimeOut,
      'a takeaway': takeaway,
    };
    expect(ownRider.order.riderKeepsCents).toBeUndefined();
    for (const [name, s] of Object.entries(notThis)) expect(riderSettledWhileOut(s.order), name).toBe(false);
    ownRider.order.riderKeepsCents = null;
    expect(riderSettledWhileOut(ownRider.order)).toBe(false);
  });

  it('which paper: a bill while only the rider has paid; a receipt once the customer paid before it left, or once delivered', () => {
    expect(receiptDocumentFor(outside())).toBe('bill');
    expect(receiptDocumentFor(riderPaid(outside()))).toBe('bill');
    expect(receiptDocumentFor(riderPaid(outside(), 'wallet'))).toBe('bill');
    expect(receiptDocumentFor(refundedWhileOut(riderPaid(outside()), 30_000))).toBe('bill');
    expect(receiptDocumentFor(customerPrepaid(outside()))).toBe('receipt');
    expect(receiptDocumentFor(delivered(riderPaid(outside())))).toBe('receipt');
    // The shop's own rider paid while out: a receipt, as in v0.7.33.
    expect(receiptDocumentFor(riderPaid(ownerExample(1500)))).toBe('receipt');
    const cancelled = outside();
    cancelled.order.status = 'void';
    expect(receiptDocumentFor(cancelled)).toBe('void');
  });

  it('“Paid now” while he is out: the customer keeps the BILL — TO COLLECT Rs 4,715.00, Pay the rider — and nothing about PAID', () => {
    for (const how of ['cash', 'wallet'] as const) {
      const rows = rowsOf(render(riderPaid(outside(), how)));
      expect(rows).toContain('BILL - NOT PAID');
      expect(rows).toContain('CASH ON DELIVERY');
      expect(rows.some((r) => /^CUSTOMER PAYS\s+Rs 4,715\.00$/.test(r))).toBe(true);
      expect(rows.some((r) => /^TO COLLECT\s+Rs 4,715\.00$/.test(r))).toBe(true);
      expect(rows).toContain('NOT PAID');
      expect(rows).toContain('Pay the rider Rs 4,715.00');
      // When the bill went out (sent 19:31), never when the rider paid.
      expect(rows.some((r) => /^Cashier: Test Cashier\s+02\/10\/2026 19:31$/.test(r))).toBe(true);
      expect(rows.filter((r) => /^PAID\b/.test(r)), how).toEqual([]);
      const text = rows.join('\n');
      for (const never of ['RECEIPT', 'Paid so far', 'PREPAID', 'NOTHING MORE TO PAY', 'RIDER COLLECTS NOTHING', 'NET PAID', 'EasyPaisa', '19:55']) {
        expect(text, `${how}: ${never}`).not.toContain(never);
      }
      expect(rows.some((r) => /^Cash\s/.test(r)), how).toBe(false);
      expect(riderRows(rows), how).toEqual([]);
    }
  });

  it('the customer’s paper is the same bytes whether the rider paid before or after it printed, by cash or wallet, original or copy', () => {
    const copy2: Partial<RenderReceiptOpts> = { stamp: { kind: 'copy', number: 2, printedAt: at(20, 0), firstPrintedAt: at(19, 51) } };
    const retry: Partial<RenderReceiptOpts> = { stamp: { kind: 'retry', number: 2, printedAt: at(20, 0) } };
    for (const opts of [{}, copy2, retry, { width: 32 as const }]) {
      const before = render(outside(), opts);
      expect(render(riderPaid(outside()), opts)).toEqual(before);
      expect(render(riderPaid(outside(), 'wallet'), opts)).toEqual(before);
    }
  });

  it('not paid yet: the SHOP COPY says what he keeps and hands in, right under CUSTOMER PAYS; the customer copy never does', () => {
    const shop = render(outside(), { copy: 'shop' });
    const rows = rowsOf(shop);
    expect(rows).toContain('SHOP COPY');
    expectRows(rowsFrom(rows, /^CUSTOMER PAYS\s/, 4), [
      /^CUSTOMER PAYS\s+Rs 4,715\.00$/,
      /^Outside rider keeps\s+200\.00$/,
      /^RIDER GIVES THE SHOP\s+Rs 4,515\.00$/,
      /^-{48}$/,
    ]);
    expect(boldBefore(shop, 'RIDER GIVES THE SHOP')).toBe(true);
    expect(boldBefore(shop, 'Outside rider keeps')).toBe(false);
    // The rest of the shop copy is the bill as before: TO COLLECT, Received by.
    expect(rows.some((r) => /^TO COLLECT\s+Rs 4,715\.00$/.test(r))).toBe(true);
    expect(rows.some((r) => r.startsWith('Received by: '))).toBe(true);
    // The customer's copy: not a word of it.
    expect(riderRows(rowsOf(render(outside())))).toEqual([]);
  });

  it('the figure is the one Send out froze (total − riderKeepsCents), never worked out again from the bill', () => {
    // Say Send out had frozen Rs 150 (not the bill's Rs 200 charge): the paper follows the frozen figure.
    const rows = rowsOf(render(outside(ownerExample(1500), 15_000), { copy: 'shop' }));
    expectRows(rowsFrom(rows, /^Outside rider keeps/, 2), [/^Outside rider keeps\s+150\.00$/, /^RIDER GIVES THE SHOP\s+Rs 4,565\.00$/]);
    expect(rows.some((r) => /^FOOD TOTAL \(with tax\)\s+Rs 4,515\.00$/.test(r))).toBe(true);
  });

  it('once he has paid (while out): the SHOP COPY says RIDER PAID THE SHOP Rs 4,515.00, and still TO COLLECT for the customer', () => {
    for (const how of ['cash', 'wallet'] as const) {
      const shop = render(riderPaid(outside(), how), { copy: 'shop' });
      const rows = rowsOf(shop);
      expectRows(rowsFrom(rows, /^CUSTOMER PAYS\s/, 4), [
        /^CUSTOMER PAYS\s+Rs 4,715\.00$/,
        /^Outside rider keeps\s+200\.00$/,
        /^RIDER PAID THE SHOP\s+Rs 4,515\.00$/,
        /^-{48}$/,
      ]);
      expect(boldBefore(shop, 'RIDER PAID THE SHOP')).toBe(true);
      expect(rows).toContain('BILL - NOT PAID');
      expect(rows.some((r) => /^TO COLLECT\s+Rs 4,715\.00$/.test(r))).toBe(true);
      expect(rows).toContain('Pay the rider Rs 4,715.00');
      const text = rows.join('\n');
      // Never "the rider collects nothing": he still collects it all at the door.
      for (const never of ['RIDER COLLECTS NOTHING', 'NOTHING MORE TO PAY', 'Paid so far', 'RIDER GIVES', 'Refunded to the rider']) {
        expect(text, `${how}: ${never}`).not.toContain(never);
      }
    }
  });

  it('a Rs 300 refund while he is out: the customer pays the rider Rs 4,415.00; the SHOP COPY keeps RIDER PAID THE SHOP Rs 4,515.00 and says Refunded to the rider 300.00', () => {
    const make = () => refundedWhileOut(riderPaid(outside()), 30_000);
    const customer = rowsOf(render(make()));
    expect(customer).toContain('BILL - NOT PAID');
    expect(customer.some((r) => /^CUSTOMER PAYS\s+Rs 4,715\.00$/.test(r))).toBe(true);
    expect(customer.some((r) => /^TO COLLECT\s+Rs 4,415\.00$/.test(r))).toBe(true);
    expect(customer).toContain('Pay the rider Rs 4,415.00');
    expect(customer.join('\n')).not.toMatch(/Refund|NET PAID|PAID -/);
    expect(riderRows(customer)).toEqual([]);

    const shop = rowsOf(render(make(), { copy: 'shop' }));
    expectRows(rowsFrom(shop, /^CUSTOMER PAYS\s/, 5), [
      /^CUSTOMER PAYS\s+Rs 4,715\.00$/,
      /^Outside rider keeps\s+200\.00$/,
      /^RIDER PAID THE SHOP\s+Rs 4,515\.00$/,
      /^Refunded to the rider\s+300\.00$/,
      /^-{48}$/,
    ]);
    expect(shop.some((r) => /^TO COLLECT\s+Rs 4,415\.00$/.test(r))).toBe(true);
    expect(shop).toContain('Pay the rider Rs 4,415.00');

    // Two refunds add up; the frozen figure never moves.
    const twice = rowsOf(render(refundedWhileOut(refundedWhileOut(riderPaid(outside()), 10_000, 2), 20_000, 7), { copy: 'shop' }));
    expect(twice.some((r) => /^Refunded to the rider\s+300\.00$/.test(r))).toBe(true);
    expect(twice.some((r) => /^RIDER PAID THE SHOP\s+Rs 4,515\.00$/.test(r))).toBe(true);
    expect(twice.some((r) => /^TO COLLECT\s+Rs 4,415\.00$/.test(r))).toBe(true);
  });

  it('a customer who paid before the food left: PREPAID - RIDER COLLECTS NOTHING; the SHOP COPY says his charge came from the drawer and he hands in nothing', () => {
    const customer = rowsOf(render(customerPrepaid(outside())));
    expect(customer).toContain('RECEIPT');
    expect(customer).toContain('PAID - EASYPAISA');
    expect(customer).toContain('PREPAID - RIDER COLLECTS NOTHING');
    expect(riderRows(customer)).toEqual([]);

    const shop = rowsOf(render(customerPrepaid(outside()), { copy: 'shop' }));
    expectRows(rowsFrom(shop, /^CUSTOMER PAYS\s/, 5), [
      /^CUSTOMER PAYS\s+Rs 4,715\.00$/,
      /^Outside rider keeps\s+200\.00$/,
      /^Paid to him from the drawer$/,
      /^RIDER GIVES THE SHOP NOTHING$/,
      /^-{48}$/,
    ]);
    expect(shop).toContain('PREPAID - RIDER COLLECTS NOTHING');
    // Never "the rider paid the shop": the customer did.
    expect(shop.join('\n')).not.toMatch(/RIDER PAID THE SHOP|RIDER GIVES THE SHOP\s+Rs/);
    // He keeps nothing: no drawer line either.
    const none = rowsOf(render(customerPrepaid(outside(ownerExample(1500), 0)), { copy: 'shop' }));
    expect(none.join('\n')).not.toContain('from the drawer');
    expect(none).toContain('RIDER GIVES THE SHOP NOTHING');
  });

  it('after Delivered (status paid): a receipt as today, DUPLICATE on a reprint; the SHOP COPY says RIDER PAID THE SHOP', () => {
    const reprint: Partial<RenderReceiptOpts> = {
      stamp: { kind: 'reprint', number: 1, printedAt: at(21, 0), byName: 'Test Manager', firstPrintedAt: at(19, 51) },
    };
    const rows = rowsOf(render(delivered(riderPaid(outside())), reprint));
    expect(rows).toContain('RECEIPT');
    expect(rows).toContain('DUPLICATE');
    expect(rows).toContain('PAID - CASH (DUPLICATE)');
    expect(rows).toContain('** DUPLICATE - Reprint #1 **');
    expect(rows.join('\n')).not.toContain('TO COLLECT');
    expect(riderRows(rows)).toEqual([]);
    // The customer's receipt is the same bytes as for an order with no outside rider and no rider named.
    const own = delivered(riderPaid(ownerExample(1500)));
    own.rider = null;
    own.order.assignedRiderId = null;
    expect(render(delivered(riderPaid(outside())), reprint)).toEqual(render(own, reprint));
    expect(rowsOf(render(delivered(riderPaid(outside())), { copy: 'shop' })).some((r) => /^RIDER PAID THE SHOP\s+Rs 4,515\.00$/.test(r))).toBe(true);

    // Delivered + Pay (cash at the door): PAID ON DELIVERY; the shop copy, RIDER PAID THE SHOP.
    const cod = () => paidOnDelivery(outside());
    expect(rowsOf(render(cod()))).toContain('PAID ON DELIVERY');
    expect(rowsOf(render(cod(), { copy: 'shop' })).some((r) => /^RIDER PAID THE SHOP\s+Rs 4,515\.00$/.test(r))).toBe(true);
    // Delivered but not paid yet ("Pays after delivery"): he still owes it.
    const owes = outside();
    owes.order.status = 'delivered';
    owes.order.deliveredAt = iso(20, 10);
    expect(rowsOf(render(owes, { copy: 'shop' })).some((r) => /^RIDER GIVES THE SHOP\s+Rs 4,515\.00$/.test(r))).toBe(true);
  });

  it('he keeps nothing: “(already paid for this trip)” when the bill has its charge, and RIDER GIVES THE SHOP the whole Rs 4,715.00', () => {
    for (const width of [48, 32] as const) {
      const rows = rowsOf(render(outside(ownerExample(1500), 0), { copy: 'shop', width }));
      const i = rows.indexOf('Outside rider keeps nothing');
      expect(i, String(width)).toBeGreaterThan(-1);
      expect(rows[i + 1]).toBe('(already paid for this trip)');
      expect(rows[i + 2]).toMatch(/^RIDER GIVES THE SHOP\s+Rs 4,715\.00$/);
      expect(rows.some((r) => /^Delivery charge\s+200\.00$/.test(r))).toBe(true);
    }
  });

  it('he keeps nothing and the bill has no delivery charge: “(no delivery charge)”, under TOTAL on the old layout', () => {
    const noCharge = () => outside(delivery([BIG_TWO(), FRIES()], { tax: 58_500 }), 0);
    const rows = rowsOf(render(noCharge(), { copy: 'shop' }));
    expectRows(rowsFrom(rows, /^TOTAL\s/, 4), [
      /^TOTAL\s+Rs 4,485\.00$/,
      /^Outside rider keeps nothing \(no delivery charge\)$/,
      /^RIDER GIVES THE SHOP\s+Rs 4,485\.00$/,
      /^-{48}$/,
    ]);
    const narrow = rowsOf(render(noCharge(), { copy: 'shop', width: 32 }));
    expect(narrow[narrow.indexOf('Outside rider keeps nothing') + 1]).toBe('(no delivery charge)');
    expect(riderRows(rowsOf(render(noCharge())))).toEqual([]);
  });

  it('the shop’s own rider: no outside lines on any copy, every paper byte for byte as before', () => {
    const before = (s: OrderSnapshot): OrderSnapshot => ({ ...s, order: { ...s.order, riderKeepsCents: undefined } });
    for (const make of [() => ownerExample(1500), () => riderPaid(ownerExample(1500)), () => paidOnDelivery(ownerExample(1500))]) {
      for (const copy of ['customer', 'shop'] as const) {
        const s = make();
        s.order.riderKeepsCents = null;
        expect(riderRows(rowsOf(render(s, { copy })))).toEqual([]);
        expect(render(s, { copy })).toEqual(render(before(s), { copy }));
      }
    }
  });

  it('58 mm: every row of every outside-rider paper fits 32 columns (80 mm: 48), and RIDER GIVES THE SHOP Rs 4,515.00 keeps one row', () => {
    const papers = [
      () => outside(),
      () => riderPaid(outside()),
      () => riderPaid(outside(), 'wallet'),
      () => refundedWhileOut(riderPaid(outside()), 30_000),
      () => customerPrepaid(outside()),
      () => delivered(riderPaid(outside())),
      () => outside(ownerExample(1500), 0),
      () => outside(delivery([BIG_TWO(), FRIES()], { tax: 58_500 }), 0),
      () => outside(dealAndStaff()),
    ];
    for (const make of papers) {
      for (const copy of ['customer', 'shop'] as const) {
        for (const width of [48, 32] as const) {
          for (const r of decodeEscPos(render(make(), { copy, width }))) {
            expect(r.text.length * r.scale, `${copy}/${width}: ${JSON.stringify(r.text)}`).toBeLessThanOrEqual(width);
          }
        }
      }
    }
    const narrow = rowsOf(render(outside(), { copy: 'shop', width: 32 }));
    expect(narrow).toContain('RIDER GIVES THE SHOP Rs 4,515.00');
    expect(narrow).toContain('Outside rider keeps       200.00');
  });
});
