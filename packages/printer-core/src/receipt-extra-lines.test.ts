/**
 * The owner's extra receipt lines (Settings → Shop & logo, per till) and who
 * a website order says took it ("Cashier: Website").
 *
 *  - With no extra lines (none saved, or []) every paper is byte-for-byte
 *    what the till printed before (receipt-goldens.json: 80 papers — every
 *    kind, both widths, with and without the shop's lines, FBR, DUPLICATE,
 *    late, shop copy, kitchen tickets).
 *  - The lines print under the thank-you line on the customer's receipt and
 *    bill only: never on a kitchen ticket, a shop copy, a refund slip, a
 *    cancelled order, or a receipt refunded in full (no thank-you there).
 *  - A website order prints "Website" where the cashier's name goes, on the
 *    bill, the receipt, the refund slip and the kitchen ticket, reprints
 *    included; the order still records the login the till filed it under.
 *
 * Times are local, so this reads the same in any time zone. Every name is made up.
 */
import { describe, expect, it } from 'vitest';
import {
  RECEIPT_EXTRA_LINE_MAX_CHARS,
  RECEIPT_EXTRA_LINES_MAX,
  WEBSITE_CASHIER_NAME,
  paperCashierName,
  type Cents,
  type OrderNumber,
  type OrderSnapshot,
  type UUID,
} from '@cheeseoclock/shared-types';
import { decodeEscPos } from './escpos-decode.js';
import { toPrinterAscii, unprintableChars } from './escpos.js';
import { fingerprint, goldenCases } from './receipt-goldens.fixture.js';
import goldens from './receipt-goldens.json';
import {
  DEFAULT_FOOTER_LINE,
  receiptExtraLines,
  renderKitchenTicket,
  renderReceipt,
  type ReceiptBranding,
  type RefundSlipInfo,
} from './receipt-renderer.js';

const id = (s: string) => s as UUID;
const cents = (n: number) => n as Cents;
const at = (h: number, m: number) => new Date(2026, 8, 26, h, m);
const iso = (h: number, m: number) => at(h, m).toISOString();
const text = (bytes: Uint8Array) => decodeEscPos(bytes).map((r) => r.text.trim());

const GOLDEN: Record<string, string> = goldens.papers;

describe('no extra lines: every paper is byte-for-byte what it was', () => {
  const cases = goldenCases();

  it('the golden list covers every paper (and nothing was dropped from it)', () => {
    expect(cases.map((c) => c.name).sort()).toEqual(Object.keys(GOLDEN).sort());
    expect(cases.length).toBe(80);
  });

  it('none saved (the default)', () => {
    const moved = cases.filter((c) => fingerprint(c.render((b) => b)) !== GOLDEN[c.name]).map((c) => c.name);
    expect(moved).toEqual([]);
  });

  it('an empty list', () => {
    const moved = cases
      .filter((c) => fingerprint(c.render((b) => ({ ...b, extraLines: [] }))) !== GOLDEN[c.name])
      .map((c) => c.name);
    expect(moved).toEqual([]);
  });

  it('blank lines print nothing either', () => {
    const moved = cases
      .filter((c) => fingerprint(c.render((b) => ({ ...b, extraLines: ['', '   '] }))) !== GOLDEN[c.name])
      .map((c) => c.name);
    expect(moved).toEqual([]);
  });
});

/** A paid takeaway at the counter (Rs 1,160, cash). */
function paid(): OrderSnapshot {
  return {
    order: {
      id: id('o1'),
      orderNumber: '20260926-0042' as OrderNumber,
      mode: 'takeaway',
      status: 'paid',
      tableId: null,
      customerId: null,
      cashierId: id('u_owner'),
      shiftId: id('s1'),
      source: 'pos',
      notes: null,
      subtotalCents: cents(100_000),
      discountCents: cents(0),
      taxCents: cents(16_000),
      totalCents: cents(116_000),
      createdAt: iso(19, 30),
      paidAt: iso(19, 35),
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      assignedRiderId: null,
      dispatchedAt: null,
      deliveredAt: null,
    },
    items: [
      {
        id: id('i1'),
        orderId: id('o1'),
        menuItemId: id('m1'),
        comboId: null,
        parentOrderItemId: null,
        quantity: 1,
        unitPriceCents: cents(100_000),
        lineTotalCents: cents(100_000),
        taxCategoryId: id('t1'),
        notes: null,
        kitchenStatus: 'pending',
        menuItemName: 'Test Pizza',
        categoryName: 'Pizza',
        prepStation: 'kitchen',
        taxRateBps: 1600,
        modifiers: [],
      },
    ],
    discounts: [],
    payments: [
      {
        id: id('p1'),
        orderId: id('o1'),
        method: 'cash',
        amountCents: cents(116_000),
        tenderedCents: cents(120_000),
        referenceNo: null,
        receivedByUserId: id('u_owner'),
        paidAt: iso(19, 35),
      },
    ],
    cashierName: 'Test Owner',
    tableLabel: null,
    customerName: null,
    customerPhone: null,
    deliveryAddress: null,
    rider: null,
  };
}

/** The same order, from the website, not paid yet: a bill. */
function webBill(): OrderSnapshot {
  const s = paid();
  s.order.source = 'web';
  s.order.mode = 'delivery';
  s.order.status = 'sent_to_kitchen';
  s.order.paidAt = null;
  s.order.notes = '[web] Ring twice';
  s.payments = [];
  s.customerName = 'Test Web Customer';
  s.customerPhone = '0300 0000009';
  s.deliveryAddress = 'House 9, Test Street';
  return s;
}

const refund = (): RefundSlipInfo => ({
  refundedAt: at(19, 50),
  rows: [{ method: 'cash', amountCents: 30_000 }],
  reason: 'Test reason',
  refundedByName: 'Test Cashier',
  approvedByName: 'Test Manager',
  totalRefundedCents: 30_000,
});
function partRefunded(s = paid()): OrderSnapshot {
  s.payments.push({
    id: id('rf1'),
    orderId: id('o1'),
    method: 'cash',
    amountCents: cents(-30_000),
    tenderedCents: null,
    referenceNo: 'partial-refund: Test reason',
    receivedByUserId: id('u_mgr'),
    paidAt: iso(19, 50),
  });
  return s;
}

const LINES = ['Insta @test.example', 'Wi-Fi: TestShop / pass 1234', 'Show this for 10% off your next pizza'];
const branding: ReceiptBranding = { storeName: 'Test Shop', footerLine: 'Thank you, come again', extraLines: LINES };

describe('the extra lines print under the thank-you line, on the customer’s receipt and bill only', () => {
  it('receipt: right after the thank-you line, in order', () => {
    const t = text(renderReceipt(paid(), { branding }));
    const thanks = t.indexOf('Thank you, come again');
    expect(thanks).toBeGreaterThan(0);
    expect(t.slice(thanks + 1, thanks + 4)).toEqual(LINES);
  });

  it('bill (not paid yet): the same', () => {
    const t = text(renderReceipt(webBill(), { branding }));
    const thanks = t.indexOf('Thank you, come again');
    expect(t.slice(thanks + 1, thanks + 4)).toEqual(LINES);
  });

  it('with the default thank-you line too', () => {
    const t = text(renderReceipt(paid(), { branding: { storeName: 'Test Shop', extraLines: ['Insta @test.example'] } }));
    expect(t[t.indexOf(toPrinterAscii(DEFAULT_FOOTER_LINE)) + 1]).toBe('Insta @test.example');
  });

  it('never on a kitchen ticket, a shop copy, a refund slip, a cancelled order, or a receipt refunded in full', () => {
    const refundedInFull = paid();
    refundedInFull.order.status = 'refunded';
    const voided = webBill();
    voided.order.status = 'void';
    voided.order.voidedAt = iso(19, 58);
    const papers: Record<string, Uint8Array> = {
      'kitchen ticket': renderKitchenTicket(paid(), { now: at(19, 40) }),
      'website kitchen ticket': renderKitchenTicket(webBill(), { now: at(19, 40) }),
      'receipt, shop copy': renderReceipt(paid(), { branding, copy: 'shop' }),
      'bill, shop copy': renderReceipt(webBill(), { branding, copy: 'shop' }),
      'refund slip': renderReceipt(partRefunded(), { branding, document: 'refund', refund: refund() }),
      'refund slip, shop copy': renderReceipt(partRefunded(), { branding, document: 'refund', refund: refund(), copy: 'shop' }),
      'cancelled order': renderReceipt(voided, { branding, cancelled: { at: at(19, 58), reason: 'Test' } }),
      'cancelled order, shop copy': renderReceipt(voided, { branding, copy: 'shop' }),
      'receipt refunded in full': renderReceipt(refundedInFull, { branding }),
    };
    const found = Object.entries(papers)
      .filter(([, bytes]) => text(bytes).some((row) => LINES.some((l) => row.includes(l.slice(0, 12)))))
      .map(([name]) => name);
    expect(found).toEqual([]);
  });

  it('a long line wraps onto the next row, like the thank-you line (58 mm paper: 32 columns)', () => {
    const long = 'Follow us on Instagram @test.example for the weekly deal of pizzas'.slice(0, RECEIPT_EXTRA_LINE_MAX_CHARS);
    const t = text(renderReceipt(paid(), { width: 32, branding: { storeName: 'Test Shop', extraLines: [long] } }));
    const start = t.indexOf(toPrinterAscii(DEFAULT_FOOTER_LINE)) + 1;
    expect(start).toBeGreaterThan(0);
    const rows = t.slice(start, start + 3).filter((r) => r !== '');
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((r) => r.length <= 32)).toBe(true);
    expect(rows.join(' ')).toBe(long);
  });

  it(`at most ${RECEIPT_EXTRA_LINES_MAX} print, each trimmed, empty ones left out`, () => {
    expect(RECEIPT_EXTRA_LINES_MAX).toBe(3);
    expect(RECEIPT_EXTRA_LINE_MAX_CHARS).toBe(64);
    expect(receiptExtraLines({ extraLines: ['  One ', '', 'Two', 'Three', 'Four'] })).toEqual(['One', 'Two', 'Three']);
    expect(receiptExtraLines({})).toEqual([]);
  });
});

describe('what the printer cannot print is found, to warn about (it prints as "?")', () => {
  it('plain English, dashes, curly quotes and accents print', () => {
    expect(unprintableChars('Wi-Fi: TestShop — “pass” 1234 · Café')).toEqual([]);
  });

  it('Urdu and emoji do not: each listed once', () => {
    expect(unprintableChars('شکریہ شکریہ')).toEqual(['ش', 'ک', 'ر', 'ی', 'ہ']);
    expect(unprintableChars('Pizza 🍕🍕')).toEqual(['🍕']);
  });
});

describe('a website order says "Website" where the cashier goes (never the login it is filed under)', () => {
  it('the bill, the receipt and the refund slip say "Cashier: Website"', () => {
    const paidWeb = webBill();
    paidWeb.order.status = 'paid';
    paidWeb.order.paidAt = iso(19, 35);
    paidWeb.payments = paid().payments;
    const bill = text(renderReceipt(webBill(), { branding: { storeName: 'Test Shop' } }));
    const receipt = text(renderReceipt(paidWeb, { branding: { storeName: 'Test Shop' } }));
    const slip = text(renderReceipt(partRefunded(paidWeb), { branding: { storeName: 'Test Shop' }, document: 'refund', refund: refund() }));
    for (const t of [bill, receipt, slip]) {
      expect(t.some((row) => /Cashier: Website\b/.test(row))).toBe(true);
      expect(t.join('\n')).not.toContain('Test Owner');
    }
  });

  it('the kitchen ticket names "Website" beside the time', () => {
    const t = text(renderKitchenTicket(webBill(), { now: at(19, 40) }));
    expect(t.some((row) => /^26\/09 19:40\s+Website$/.test(row))).toBe(true);
    expect(t.join('\n')).not.toContain('Test Owner');
  });

  it('a reprint of an old website order says it too (it is read from the order, not the print job)', () => {
    const t = text(
      renderReceipt(webBill(), {
        branding: { storeName: 'Test Shop' },
        stamp: { kind: 'reprint', number: 1, printedAt: at(22, 0), byName: 'Test Manager', firstPrintedAt: at(19, 35) },
      }),
    );
    expect(t.some((row) => /Cashier: Website\b/.test(row))).toBe(true);
  });

  it('an order rung up at the till keeps its cashier; the order itself is not changed', () => {
    const s = paid();
    expect(text(renderReceipt(s, { branding: { storeName: 'Test Shop' } })).some((row) => /Cashier: Test Owner\b/.test(row))).toBe(true);
    const web = webBill();
    expect(paperCashierName(web)).toBe(WEBSITE_CASHIER_NAME);
    expect(WEBSITE_CASHIER_NAME).toBe('Website');
    // The snapshot (and the order under it) still carries the login it was filed under.
    renderReceipt(web, { branding: { storeName: 'Test Shop' } });
    expect(web.cashierName).toBe('Test Owner');
    expect(web.order.cashierId).toBe('u_owner');
  });
});
