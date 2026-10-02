/**
 * Every label that says what a paper IS: RECEIPT / BILL - NOT PAID / REFUND /
 * CANCELLED ORDER, the DUPLICATE marks (top band, inside the body, bottom
 * line), SHOP COPY, the state line (PAID - CASH, TO COLLECT, REFUNDED IN
 * FULL), the FBR states, and the kitchen's REPRINT / RE-SENT / LATE /
 * CANCELLED — decoded back from the bytes, as the printer would print them.
 * Times are Pakistan wall-clock instants (papers print Pakistan time), so the
 * test reads the same in any time zone.
 */
import { describe, expect, it } from 'vitest';
import type { Cents, OrderNumber, OrderSnapshot, UUID } from '@cheeseoclock/shared-types';
import { CUT_MARKER, QR_MARKER, decodeEscPos } from './escpos-decode.js';
import { LINES_BEFORE_CUT } from './escpos.js';
import type { MonoRaster } from './logo-raster.js';
import {
  receiptDocumentFor,
  renderKitchenTicket,
  renderReceipt,
  type CopyStamp,
  type ReceiptBranding,
  type RefundSlipInfo,
} from './receipt-renderer.js';

const id = (s: string) => s as UUID;
const cents = (n: number) => n as Cents;
/** Pakistan wall-clock time (UTC+5) on 26 Sep 2026. */
const at = (h: number, m: number) => new Date(Date.UTC(2026, 8, 26, h - 5, m));
const iso = (h: number, m: number) => at(h, m).toISOString();

const branding: ReceiptBranding = { storeName: "Cheese O'Clock", storeTagline: 'Pizza - Phase 6', phoneLine: '0300 0000000' };

/** A paid takeaway: Rs 1,160 (1,000 + 16% tax), cash. */
function paid(): OrderSnapshot {
  return {
    order: {
      id: id('o1'),
      orderNumber: '20260926-0042' as OrderNumber,
      mode: 'takeaway',
      status: 'paid',
      tableId: null,
      customerId: null,
      cashierId: id('u1'),
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
        quantity: 2,
        unitPriceCents: cents(50_000),
        lineTotalCents: cents(100_000),
        taxCategoryId: id('t1'),
        notes: null,
        kitchenStatus: 'pending',
        menuItemName: 'Chicken Tikka Pizza',
        categoryName: 'Pizza',
        prepStation: 'kitchen',
        taxRateBps: 1600,
        modifiers: [
          { id: id('mo1'), orderItemId: id('i1'), modifierId: id('md1'), modifierName: 'Extra Cheese', priceDeltaCents: cents(0) },
        ],
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
        receivedByUserId: id('u1'),
        paidAt: iso(19, 35),
      },
    ],
    cashierName: 'Ali Akbar',
    tableLabel: null,
    customerName: null,
    customerPhone: null,
    deliveryAddress: null,
    rider: null,
  };
}

/** A cash-on-delivery order out with its rider, nothing paid. */
function codBill(): OrderSnapshot {
  const s = paid();
  s.order.mode = 'delivery';
  s.order.status = 'out_for_delivery';
  s.order.paidAt = null;
  s.payments = [];
  s.customerName = 'Hamza';
  s.customerPhone = '0300 1234567';
  s.deliveryAddress = 'House 12, Street 7, Phase 6, DHA';
  s.rider = { id: id('r1'), name: 'Bilal', phone: '0311 1234567' };
  return s;
}

function refundRow(amount: number, h: number, m: number, ref = 'partial-refund: cold pizza') {
  return {
    id: id(`rf-${h}${m}`),
    orderId: id('o1'),
    method: 'cash' as const,
    amountCents: cents(-amount),
    tenderedCents: null,
    referenceNo: ref,
    receivedByUserId: id('u_mgr'),
    paidAt: iso(h, m),
  };
}

function refundInfo(extra: Partial<RefundSlipInfo> = {}): RefundSlipInfo {
  return {
    refundedAt: at(19, 50),
    rows: [{ method: 'cash', amountCents: 30_000 }],
    reason: 'cold pizza',
    refundedByName: 'Ali Akbar',
    approvedByName: 'Sana Khan',
    totalRefundedCents: 30_000,
    ...extra,
  };
}

const reprint2: CopyStamp = {
  kind: 'reprint',
  number: 2,
  printedAt: at(19, 52),
  byName: 'Ali Akbar',
  approvedByName: 'Sana Khan',
  firstPrintedAt: at(19, 35),
};

const text = (bytes: Uint8Array) => decodeEscPos(bytes).map((r) => r.text);
const joined = (bytes: Uint8Array) => text(bytes).join('\n');
const logo = (): MonoRaster => ({ width: 64, height: 20, data: new Uint8Array(8 * 20).fill(0x81) });
const fbr = { irn: '123456-260926193500-0001', qrPayload: 'https://verify.example/123456-260926193500-0001' };

describe('which paper an order prints as', () => {
  it('is chosen from the order, never from the button', () => {
    expect(receiptDocumentFor(paid())).toBe('receipt');
    expect(receiptDocumentFor(codBill())).toBe('bill');
    const refunded = paid();
    refunded.order.status = 'refunded';
    expect(receiptDocumentFor(refunded)).toBe('receipt');
    const voided = codBill();
    voided.order.status = 'void';
    expect(receiptDocumentFor(voided)).toBe('void');
    // Nothing to pay but never tendered: still a bill, not a PAID receipt.
    const free = codBill();
    free.order.totalCents = cents(0);
    expect(receiptDocumentFor(free)).toBe('bill');
  });

  it('a cancelled order never prints as a receipt or a bill, whatever is asked', () => {
    const s = codBill();
    s.order.status = 'void';
    const r = joined(renderReceipt(s, { branding }));
    expect(r).toContain('CANCELLED ORDER');
    expect(r).not.toContain('RECEIPT');
    expect(r).not.toContain('BILL - NOT PAID');
  });
});

describe('customer receipt (paid)', () => {
  it('says RECEIPT at the top and PAID with the method; an original carries no DUPLICATE', () => {
    const rows = decodeEscPos(renderReceipt(paid(), { branding }));
    const title = rows.find((r) => r.text === 'RECEIPT');
    expect(title?.scale).toBe(2);
    const t = rows.map((r) => r.text);
    expect(t.indexOf('RECEIPT')).toBeLessThan(t.findIndex((x) => x.startsWith('Order #')));
    expect(t).toContain('PAID - CASH');
    expect(t.join('\n')).not.toContain('DUPLICATE');
    expect(t.join('\n')).toContain('Thank you');
  });

  it('names every method, biggest first', () => {
    const s = paid();
    s.payments = [
      { ...s.payments[0]!, id: id('p1'), method: 'cash', amountCents: cents(50_000), tenderedCents: cents(100_000) },
      { ...s.payments[0]!, id: id('p2'), method: 'card', amountCents: cents(66_000), tenderedCents: null },
    ];
    expect(text(renderReceipt(s, { branding }))).toContain('PAID - CARD + CASH');
    const fp = paid();
    fp.order.mode = 'foodpanda';
    fp.payments = [{ ...fp.payments[0]!, method: 'foodpanda', tenderedCents: null }];
    expect(text(renderReceipt(fp, { branding }))).toContain('PAID - FOODPANDA');
  });

  it('Change is the cash handed over less the CASH part, not less the whole bill', () => {
    const s = paid();
    s.payments = [
      { ...s.payments[0]!, id: id('p1'), method: 'card', amountCents: cents(66_000), tenderedCents: null },
      { ...s.payments[0]!, id: id('p2'), method: 'cash', amountCents: cents(50_000), tenderedCents: cents(100_000) },
    ];
    const t = text(renderReceipt(s, { branding }));
    expect(t.some((x) => /^Tendered\s+1,000\.00$/.test(x))).toBe(true);
    expect(t.some((x) => /^Change\s+500\.00$/.test(x))).toBe(true);
    expect(t.join('\n')).not.toContain('-160.00');
  });

  it('shows the tax rate when every line has the same one', () => {
    expect(text(renderReceipt(paid(), { branding })).some((x) => /^Tax \(16%\)\s+160\.00$/.test(x))).toBe(true);
    const mixed = paid();
    mixed.items.push({ ...mixed.items[0]!, id: id('i2'), taxRateBps: 500 });
    expect(text(renderReceipt(mixed, { branding })).some((x) => /^Tax\s+160\.00$/.test(x))).toBe(true);
    const unknown = paid();
    delete unknown.items[0]!.taxRateBps;
    expect(text(renderReceipt(unknown, { branding })).some((x) => /^Tax\s+160\.00$/.test(x))).toBe(true);
  });

  it('a paid delivery tells the rider to collect nothing', () => {
    const s = codBill();
    s.order.status = 'out_for_delivery';
    s.order.paidAt = iso(19, 35);
    s.payments = paid().payments;
    const t = text(renderReceipt(s, { branding }));
    expect(t).toContain('RECEIPT');
    expect(t).toContain('PAID - CASH');
    expect(t).toContain('PREPAID - RIDER COLLECTS NOTHING');
    expect(t.some((x) => x.startsWith('TO COLLECT'))).toBe(false);
  });

  it('cash the rider brought back is PAID ON DELIVERY, never PREPAID — on the receipt and on its duplicate', () => {
    // Cash on delivery: the rider left at 19:40, the board took the cash when it was delivered.
    const cod = codBill();
    cod.order.status = 'paid';
    cod.order.dispatchedAt = iso(19, 40);
    cod.order.deliveredAt = iso(20, 5);
    cod.order.paidAt = iso(20, 5);
    cod.payments = [{ ...paid().payments[0]!, paidAt: iso(20, 5) }];
    for (const stamp of [null, reprint2]) {
      const t = text(renderReceipt(cod, { branding, stamp }));
      expect(t).toContain(stamp ? 'PAID - CASH (DUPLICATE)' : 'PAID - CASH');
      expect(t).toContain('PAID ON DELIVERY');
      expect(t.join('\n')).not.toContain('PREPAID');
    }
    // Delivered first, paid later (at the counter, the next day…).
    const later = structuredClone(cod);
    later.order.paidAt = iso(21, 30);
    expect(text(renderReceipt(later, { branding }))).toContain('PAID AFTER DELIVERY');
    // Paid while the rider was out: just PAID, neither PREPAID nor ON DELIVERY.
    const whileOut = structuredClone(cod);
    whileOut.order.status = 'out_for_delivery';
    whileOut.order.deliveredAt = null;
    whileOut.order.paidAt = iso(19, 50);
    const w = text(renderReceipt(whileOut, { branding })).join('\n');
    expect(w).toContain('PAID - CASH');
    expect(w).not.toContain('PREPAID');
    expect(w).not.toContain('ON DELIVERY');
    // Paid at the counter before the rider left, delivered later: still PREPAID.
    const prepaid = structuredClone(cod);
    prepaid.order.paidAt = iso(19, 35);
    expect(text(renderReceipt(prepaid, { branding }))).toContain('PREPAID - RIDER COLLECTS NOTHING');
  });

  it('a free order says NO CHARGE, never a bare "PAID -"', () => {
    const s = paid();
    s.order.totalCents = cents(0);
    s.payments = [];
    const t = text(renderReceipt(s, { branding }));
    expect(t).toContain('NO CHARGE - NOTHING TO PAY');
    expect(t.some((x) => x.startsWith('PAID -'))).toBe(false);
  });

  it('part refunded: each refund, NET PAID, and still PAID', () => {
    const s = paid();
    s.payments.push(refundRow(30_000, 19, 50));
    const t = text(renderReceipt(s, { branding }));
    expect(t.some((x) => /^Refund 19:50 Cash\s+-300\.00$/.test(x))).toBe(true);
    expect(t.some((x) => /^NET PAID\s+860\.00$/.test(x))).toBe(true);
    expect(t).toContain('PAID - CASH');
    expect(t).toContain('PART REFUNDED - Rs 300.00 returned');
  });

  it('refunded in full: titled so, says so, and is not valid for any claim', () => {
    const s = paid();
    s.order.status = 'refunded';
    s.payments.push(refundRow(116_000, 19, 50, 'refund-of:p1'));
    for (const width of [48, 32] as const) {
      const rows = decodeEscPos(renderReceipt(s, { width, branding }));
      const t = rows.map((r) => r.text);
      if (width === 48) expect(t).toContain('RECEIPT - REFUNDED');
      else expect(t.slice(t.indexOf('RECEIPT -'), t.indexOf('RECEIPT -') + 2)).toEqual(['RECEIPT -', 'REFUNDED']);
      expect(t).toContain('REFUNDED IN FULL');
      expect(t.join(' ')).toContain('Rs 1,160.00 returned 26/09/2026 19:50');
      expect(t.join(' ')).toContain('This sale was refunded - not valid for any claim.');
      expect(t.join('\n')).not.toContain('Thank you');
      expect(t.some((x) => x.startsWith('PAID -'))).toBe(false);
    }
  });
});

describe('DUPLICATE', () => {
  it('a band at the very top, before the logo: stars, DUPLICATE in double size, which reprint, when, who', () => {
    const rows = decodeEscPos(renderReceipt(paid(), { width: 48, branding, stamp: reprint2, logo: logo() }));
    expect(rows[0]!.text).toBe('*'.repeat(48));
    expect(rows[1]).toEqual({ text: 'DUPLICATE', scale: 2 });
    expect(rows[2]!.text).toBe('Reprint #2 | 26/09/2026 19:52 | by Ali Akbar');
    expect(rows[3]!.text).toBe('Approved by: Sana Khan');
    expect(rows[4]!.text).toBe('Original: 26/09/2026 19:35');
    expect(rows[5]!.text).toBe('*'.repeat(48));
    expect(rows[6]!.text).toBe('[logo 576×20]');
  });

  it('and a line at the bottom, just above the cut', () => {
    const t = text(renderReceipt(paid(), { branding, stamp: reprint2, fbr }));
    expect(t.at(-1)).toBe(CUT_MARKER);
    const lastText = t.slice(0, -1 - LINES_BEFORE_CUT).filter((x) => x !== '').at(-1);
    expect(lastText).toBe('** DUPLICATE - Reprint #2 **');
    // …after the FBR QR.
    expect(t.lastIndexOf(QR_MARKER)).toBeLessThan(t.indexOf('** DUPLICATE - Reprint #2 **'));
  });

  it('also inside the body: tearing the ends off does not leave an "original"', () => {
    const t = text(renderReceipt(paid(), { branding, stamp: reprint2, logo: logo(), fbr }));
    const body = t.slice(t.indexOf('[logo 576×20]') + 1, t.indexOf(QR_MARKER));
    expect(body.filter((x) => x.includes('DUPLICATE')).length).toBeGreaterThanOrEqual(3);
    expect(body[body.indexOf('RECEIPT') + 1]).toBe('DUPLICATE');
    expect(body.some((x) => /^=+ DUPLICATE =+$/.test(x))).toBe(true);
    expect(body).toContain('PAID - CASH (DUPLICATE)');
  });

  it('the body is the original: same order, times, amounts, FBR number and QR', () => {
    const original = renderReceipt(paid(), { branding, fbr });
    const copy = renderReceipt(paid(), { branding, fbr, stamp: reprint2 });
    // The marks come off; what is left must be the original, row for row.
    const strip = (t: string[]) =>
      t
        .map((x) => (/^=+ DUPLICATE =+$/.test(x) ? '='.repeat(x.length) : x.replace(' (DUPLICATE)', '')))
        .filter((x) => !x.includes('DUPLICATE') && !/^\*+$/.test(x) && !/^(Reprint|Approved|Original)/.test(x) && x !== '');
    expect(strip(text(copy))).toEqual(strip(text(original)));
    expect(text(copy)).toContain(`FBR Invoice No: ${fbr.irn}`);
    // The QR bytes themselves are the same.
    const qr = (b: Uint8Array) => {
      const s = Buffer.from(b).toString('latin1');
      const i = s.indexOf(fbr.qrPayload);
      return i >= 0 ? s.slice(i - 8, i + fbr.qrPayload.length) : null;
    };
    expect(qr(copy)).not.toBeNull();
    expect(qr(copy)).toBe(qr(original));
  });

  it('a printer retry and a second copy the till printed itself say so, without a name', () => {
    const retry = text(renderReceipt(paid(), { branding, stamp: { kind: 'retry', number: 0, printedAt: at(19, 52) } }));
    expect(retry[1]).toBe('DUPLICATE');
    expect(retry[2]).toBe('Printer retry | 26/09/2026 19:52');
    expect(retry[3]).toBe('The first copy may have printed');
    expect(retry).toContain('** DUPLICATE - printer retry **');
    const copy = text(
      renderReceipt(paid(), {
        branding,
        stamp: { kind: 'copy', number: 2, printedAt: at(19, 52), byName: 'Ali Akbar', firstPrintedAt: at(19, 35) },
      }),
    );
    expect(copy[2]).toBe('Copy #2 | 26/09/2026 19:52');
    expect(copy.join('\n')).not.toContain('by Ali Akbar');
    expect(copy).toContain('** DUPLICATE - Copy #2 **');
  });

  it('on 58 mm paper each fact of the band gets its own row', () => {
    const t = text(renderReceipt(paid(), { width: 32, branding, stamp: reprint2 }));
    expect(t.slice(0, 8)).toEqual([
      '*'.repeat(32),
      'DUPLICATE',
      'Reprint #2',
      '26/09/2026 19:52',
      'by Ali Akbar',
      'Approved by: Sana Khan',
      'Original: 26/09/2026 19:35',
      '*'.repeat(32),
    ]);
  });

  it('the first paper with the FBR number after one without says so', () => {
    const t = text(renderReceipt(paid(), { branding, fbr, stamp: { ...reprint2, number: 1, fbrCopy: true } }));
    expect(t).toContain('FBR copy - the first with the FBR number');
  });

  it('a first paper printed by hand long after the sale is not a DUPLICATE, but says when and by whom', () => {
    const t = text(
      renderReceipt(paid(), {
        branding,
        stamp: { kind: 'late', number: 0, printedAt: at(22, 10), byName: 'Sana Khan', approvedByName: null },
      }),
    );
    expect(t.join('\n')).not.toContain('DUPLICATE');
    expect(t).toContain('Printed later: 26/09/2026 22:10 by Sana Khan');
  });

  it('pressed for by hand while the print log could not be read: still DUPLICATE, with no number', () => {
    const stamp: CopyStamp = {
      kind: 'reprint',
      number: 0,
      numberUnknown: true,
      printedAt: at(19, 52),
      byName: 'Ali Akbar',
      approvedByName: 'Sana Khan',
    };
    const t = text(renderReceipt(paid(), { branding, stamp, fbr }));
    expect(t[0]).toBe('*'.repeat(48));
    expect(t[1]).toBe('DUPLICATE');
    expect(t[2]).toBe('Reprint | 26/09/2026 19:52 | by Ali Akbar');
    expect(t[3]).toBe('Approved by: Sana Khan');
    expect(t).toContain('PAID - CASH (DUPLICATE)');
    expect(t).toContain('** DUPLICATE **');
    // No made-up number anywhere, and no "Original: …" it can't know.
    expect(t.join('\n')).not.toMatch(/Reprint #|Copy #|Original:/);
    // A bill pressed for the same way says the same.
    const bill = text(renderReceipt(codBill(), { branding, stamp }));
    expect(bill[1]).toBe('DUPLICATE');
    expect(bill).toContain('** DUPLICATE **');
  });

  it('a SHOP COPY reprinted is both, and still has no FBR block', () => {
    const t = text(renderReceipt(paid(), { branding, copy: 'shop', stamp: reprint2, fbr }));
    expect(t[1]).toBe('DUPLICATE');
    expect(t).toContain('SHOP COPY');
    expect(t).toContain('** DUPLICATE - Reprint #2 **');
    expect(t.join('\n')).not.toContain('FBR');
    expect(t).not.toContain(QR_MARKER);
  });
});

describe('bills (not paid)', () => {
  it('cash on delivery: BILL - NOT PAID, CASH ON DELIVERY, what to collect, who to pay — and no FBR at all', () => {
    const rows = decodeEscPos(renderReceipt(codBill(), { branding, fbr, fbrMissing: 'pending' }));
    const t = rows.map((r) => r.text);
    expect(rows.find((r) => r.text === 'BILL - NOT PAID')?.scale).toBe(2);
    expect(t[t.indexOf('BILL - NOT PAID') + 1]).toBe('CASH ON DELIVERY');
    expect(t.some((x) => /^TO COLLECT\s+Rs 1,160\.00$/.test(x))).toBe(true);
    expect(t).toContain('NOT PAID');
    expect(t).toContain('Pay the rider Rs 1,160.00');
    expect(t.some((x) => /^Rider: Bilal\s+0311 1234567$/.test(x))).toBe(true);
    const all = t.join('\n');
    expect(all).not.toContain('FBR');
    expect(all).not.toContain('pending');
    expect(all).not.toContain('PAID -');
    expect(all).not.toContain('RECEIPT');
  });

  it('at the counter: PAY AT THE COUNTER, TO PAY, and "not a receipt"; money already taken is shown', () => {
    const s = codBill();
    s.order.mode = 'takeaway';
    s.order.status = 'sent_to_kitchen';
    s.rider = null;
    s.deliveryAddress = null;
    s.payments = [{ ...paid().payments[0]!, amountCents: cents(16_000), tenderedCents: null }];
    const t = text(renderReceipt(s, { branding }));
    expect(t[t.indexOf('BILL - NOT PAID') + 1]).toBe('PAY AT THE COUNTER');
    expect(t.some((x) => /^Paid so far\s+160\.00$/.test(x))).toBe(true);
    expect(t.some((x) => /^TO PAY\s+Rs 1,000\.00$/.test(x))).toBe(true);
    expect(t).toContain('NOT PAID - pay at the counter');
    expect(t).toContain('This bill is not a receipt.');
  });

  it('nothing due: the headline says so too — never NOT PAID / CASH ON DELIVERY over "nothing to pay"', () => {
    // A free replacement pizza sent as a delivery: 100% discount, nothing paid.
    const free = codBill();
    free.order.totalCents = cents(0);
    for (const width of [48, 32] as const) {
      const rows = decodeEscPos(renderReceipt(free, { width, branding }));
      const t = rows.map((r) => r.text);
      const all = t.join('\n');
      if (width === 48) expect(rows.find((r) => r.text === 'BILL - NOTHING TO PAY')?.scale).toBe(2);
      else expect(t.slice(t.indexOf('BILL - NOTHING'), t.indexOf('BILL - NOTHING') + 2)).toEqual(['BILL - NOTHING', 'TO PAY']);
      expect(t).toContain('RIDER COLLECTS NOTHING');
      expect(t).toContain('NO CHARGE - NOTHING TO PAY');
      for (const wrong of ['NOT PAID', 'CASH ON DELIVERY', 'TO COLLECT', 'Pay the rider', 'RECEIPT']) {
        expect(all).not.toContain(wrong);
      }
    }
    // At the counter, and money already taken covering it: "nothing more", not "no charge".
    const counter = codBill();
    counter.order.mode = 'takeaway';
    counter.rider = null;
    counter.deliveryAddress = null;
    counter.payments = [{ ...paid().payments[0]!, amountCents: cents(116_000), tenderedCents: null }];
    const c = text(renderReceipt(counter, { branding }));
    expect(c).toContain('BILL - NOTHING TO PAY');
    expect(c).toContain('NOTHING MORE TO PAY');
    expect(c.join('\n')).not.toContain('PAY AT THE COUNTER');
    expect(c.join('\n')).not.toContain('NO CHARGE');
  });

  it('a reprinted bill is a DUPLICATE bill', () => {
    const t = text(renderReceipt(codBill(), { branding, stamp: { ...reprint2, approvedByName: null } }));
    expect(t[1]).toBe('DUPLICATE');
    expect(t).toContain('BILL - NOT PAID');
    expect(t).toContain('** DUPLICATE - Reprint #2 **');
  });
});

describe('refund slip', () => {
  function refunded(): OrderSnapshot {
    const s = paid();
    s.payments.push(refundRow(30_000, 19, 50));
    return s;
  }

  it('says REFUND and how much went back; who, why, when; and is not a receipt', () => {
    const rows = decodeEscPos(renderReceipt(refunded(), { branding, document: 'refund', refund: refundInfo(), fbr }));
    const t = rows.map((r) => r.text);
    expect(rows.find((r) => r.text === 'REFUND')?.scale).toBe(2);
    expect(t).toContain('Rs 300.00 RETURNED');
    expect(t).toContain('Refunded 26/09/2026 19:50');
    expect(t.some((x) => /^Sale 26\/09\/2026 19:35\s+Cashier: Ali Akbar$/.test(x))).toBe(true);
    expect(t.some((x) => /^Cash refund\s+300\.00$/.test(x))).toBe(true);
    expect(t).toContain('Reason: cold pizza');
    expect(t).toContain('Refunded by: Ali Akbar');
    expect(t).toContain('Approved by: Sana Khan');
    expect(t.some((x) => /^Original bill total\s+1,160\.00$/.test(x))).toBe(true);
    expect(t.some((x) => /^Refunded in all\s+300\.00$/.test(x))).toBe(true);
    expect(t.some((x) => /^Net paid\s+860\.00$/.test(x))).toBe(true);
    expect(t).toContain('REFUND SLIP - NOT A RECEIPT FOR PAYMENT');
    const all = t.join('\n');
    for (const gone of ['Thank you', 'TOTAL', 'PAID -', 'TO PAY', 'Tendered', 'FBR Digital Invoice', fbr.irn]) {
      expect(all).not.toContain(gone);
    }
  });

  it('the SHOP COPY is signed by the customer for the cash', () => {
    const t = text(renderReceipt(refunded(), { branding, document: 'refund', copy: 'shop', refund: refundInfo() }));
    expect(t).toContain('SHOP COPY');
    expect(t).toContain('Customer received Rs 300.00');
    expect(t.some((x) => /^Signature: _{8,}$/.test(x))).toBe(true);
  });

  it("carries the refund's own FBR number (debit note), never the sale's", () => {
    const withNote = text(
      renderReceipt(refunded(), {
        branding,
        document: 'refund',
        fbr,
        refund: refundInfo({ debitNote: { irn: 'DN-0007', qrPayload: 'https://verify.example/DN-0007', saleIrn: fbr.irn } }),
      }),
    );
    expect(withNote).toContain('FBR Debit Note');
    expect(withNote).toContain('FBR No: DN-0007');
    expect(withNote).toContain(QR_MARKER);
    expect(withNote.join(' ')).toContain(`Against invoice: ${fbr.irn}`);
    expect(withNote).not.toContain('FBR Digital Invoice');
    const pending = text(renderReceipt(refunded(), { branding, document: 'refund', refund: refundInfo({ debitNoteMissing: 'pending' }) }));
    expect(pending).toContain('FBR debit note: not yet issued');
    const noop = text(renderReceipt(refunded(), { branding, document: 'refund', refund: refundInfo() }));
    expect(noop.join('\n')).not.toContain('FBR');
    const shop = text(
      renderReceipt(refunded(), { branding, document: 'refund', copy: 'shop', refund: refundInfo({ debitNote: { irn: 'DN-0007' } }) }),
    );
    expect(shop.join('\n')).not.toContain('FBR');
  });
});

describe('cancelled order slip', () => {
  it('CANCELLED ORDER, nothing to pay: no prices, no total, no payment, no FBR', () => {
    const s = codBill();
    s.order.status = 'void';
    s.order.voidReason = 'Customer refused';
    s.order.voidedAt = iso(19, 52);
    const rows = decodeEscPos(
      renderReceipt(s, { branding, fbr, cancelled: { at: at(19, 52), byName: 'Sana Khan', reason: 'Customer refused' } }),
    );
    const t = rows.map((r) => r.text);
    expect(rows.find((r) => r.text === 'CANCELLED ORDER')?.scale).toBe(2);
    expect(t).toContain('NOT A BILL - NOTHING TO PAY');
    expect(t).toContain('Cancelled 26/09/2026 19:52');
    expect(t).toContain('Reason: Customer refused');
    expect(t).toContain('Approved by: Sana Khan');
    expect(t).toContain('2 x Chicken Tikka Pizza');
    expect(t).toContain('    Extra Cheese');
    expect(t).toContain('CANCELLED - NOTHING TO PAY');
    const all = t.join('\n');
    for (const gone of ['TOTAL', 'Rs ', 'PAID', 'FBR', 'Thank you', '1,000.00', '1,160.00']) expect(all).not.toContain(gone);
  });
});

describe('FBR block', () => {
  it('noop: nothing; live and issued: the number and QR; sandbox: a test, no QR; live without a number: says so', () => {
    expect(joined(renderReceipt(paid(), { branding }))).not.toContain('FBR');
    const live = text(renderReceipt(paid(), { branding, fbr }));
    expect(live).toContain('FBR Digital Invoice');
    expect(live).toContain(`FBR Invoice No: ${fbr.irn}`);
    expect(live).toContain(QR_MARKER);
    const sandbox = text(renderReceipt(paid(), { branding, fbr: { irn: 'SBX-1', qrPayload: 'x', test: true } }));
    expect(sandbox).toContain('FBR SANDBOX TEST');
    expect(sandbox).toContain('Not a tax invoice');
    expect(sandbox).toContain('Test no: SBX-1');
    expect(sandbox).not.toContain(QR_MARKER);
    expect(sandbox).not.toContain('FBR Digital Invoice');
    expect(text(renderReceipt(paid(), { branding, fbrMissing: 'pending' }))).toContain('FBR invoice no.: not yet issued');
    expect(text(renderReceipt(paid(), { branding, fbrMissing: 'failed' }))).toContain('FBR invoice no.: not issued');
  });
});

describe('kitchen ticket', () => {
  const now = at(19, 52);

  it('a ticket already printed: REPRINT under the number, same order, first printed, who asked', () => {
    const t = text(
      renderKitchenTicket(paid(), {
        now,
        stamp: { kind: 'reprint', number: 1, printedAt: now, byName: 'Ali Akbar', firstPrintedAt: at(19, 35) },
      }),
    );
    expect(t.indexOf('#0042')).toBeLessThan(t.indexOf('* REPRINT *'));
    expect(t).toContain('SAME ORDER - DO NOT COOK TWICE');
    expect(t.join(' ')).toContain('First printed 26/09 19:35 - check the rail');
    expect(t.join(' ')).toContain('Reprint #1 26/09 19:52 by Ali Akbar');
    expect(t.join('\n')).not.toContain('RE-SENT');
  });

  it('the first try may have printed: RE-SENT, check for the ticket before cooking — not "do not cook"', () => {
    const t = text(renderKitchenTicket(paid(), { now, stamp: { kind: 'retry', number: 0, printedAt: now } }));
    expect(t).toContain('* RE-SENT *');
    expect(t).toContain('Printer error on first try');
    expect(t).toContain('CHECK FOR TICKET #0042');
    expect(t).toContain('BEFORE COOKING');
    expect(t.join('\n')).not.toContain('REPRINT');
    expect(t.join('\n')).not.toContain('COOK TWICE');
  });

  it("the kitchen's first ticket carries no stamp, even when printed from the chef-hat button", () => {
    const t = joined(renderKitchenTicket(paid(), { now, stamp: null, reprint: false }));
    expect(t).not.toContain('REPRINT');
    expect(t).not.toContain('RE-SENT');
  });

  it('a ticket printing 2 minutes or more after it was sent says LATE', () => {
    expect(text(renderKitchenTicket(paid(), { now, queuedAt: at(19, 35) }))).toContain('LATE - sent 19:35');
    expect(joined(renderKitchenTicket(paid(), { now, queuedAt: new Date(now.getTime() - 60_000) }))).not.toContain('LATE');
  });

  it('CANCELLED says when, by whom and why', () => {
    const t = text(
      renderKitchenTicket(paid(), {
        now,
        cancelled: true,
        cancelInfo: { at: at(19, 52), byName: 'Sana Khan', reason: 'Customer left' },
      }),
    );
    expect(t).toContain('* CANCELLED *');
    expect(t).toContain('DO NOT MAKE - DO NOT SEND');
    expect(t).toContain('Cancelled 26/09 19:52 by Sana Khan');
    expect(t).toContain('Reason: Customer left');
    expect(t.join('\n')).not.toContain('REPRINT');
  });
});

describe('every paper fits the paper', () => {
  const stamps: Array<CopyStamp | null> = [
    null,
    reprint2,
    { kind: 'retry', number: 0, printedAt: at(19, 52) },
    { kind: 'copy', number: 3, printedAt: at(19, 52), firstPrintedAt: at(19, 35) },
    { kind: 'late', number: 0, printedAt: at(22, 10), byName: 'Muhammad Abdullah Siddiqui', approvedByName: 'Sana Khan' },
    { ...reprint2, byName: 'Muhammad Abdullah Siddiqui', approvedByName: 'Muhammad Abdullah Siddiqui', fbrCopy: true },
  ];
  const papers = (): Array<[string, OrderSnapshot, Parameters<typeof renderReceipt>[1]]> => {
    const partRefund = paid();
    partRefund.payments.push(refundRow(30_000, 19, 50));
    const full = paid();
    full.order.status = 'refunded';
    full.payments.push(refundRow(116_000, 19, 50, 'refund-of:p1'));
    const voided = codBill();
    voided.order.status = 'void';
    voided.order.voidReason = 'Customer refused the order at the door, rider brought it back';
    return [
      ['receipt', paid(), { branding, fbr }],
      ['sandbox receipt', paid(), { branding, fbr: { irn: 'SBX-123456-260926193500-0001', test: true } }],
      ['pending receipt', paid(), { branding, fbrMissing: 'pending' }],
      ['part refunded', partRefund, { branding }],
      ['refunded', full, { branding }],
      ['cod bill', codBill(), { branding }],
      [
        'refund slip',
        partRefund,
        {
          branding,
          document: 'refund',
          refund: refundInfo({ debitNote: { irn: 'DN-123456-260926195000-0002', qrPayload: 'q', saleIrn: fbr.irn } }),
        },
      ],
      ['void', voided, { branding, cancelled: { at: at(19, 52), byName: 'Muhammad Abdullah Siddiqui', reason: voided.order.voidReason } }],
    ];
  };
  for (const width of [48, 32] as const) {
    it(`no row wider than ${width} columns, for every document, copy and stamp`, () => {
      for (const [name, s, opts] of papers()) {
        for (const copy of ['customer', 'shop'] as const) {
          for (const stamp of stamps) {
            for (const row of decodeEscPos(renderReceipt(s, { ...opts, width, copy, stamp }))) {
              expect(row.text.length * row.scale, `${name}/${copy}/${stamp?.kind}: ${JSON.stringify(row.text)}`).toBeLessThanOrEqual(width);
            }
          }
        }
      }
      for (const stamp of stamps) {
        for (const cancelled of [false, true]) {
          const bytes = renderKitchenTicket(paid(), {
            width,
            now: at(19, 52),
            stamp,
            cancelled,
            queuedAt: at(19, 30),
            cancelInfo: { at: at(19, 52), byName: 'Muhammad Abdullah Siddiqui', reason: 'Customer refused the order' },
          });
          for (const row of decodeEscPos(bytes)) {
            expect(row.text.length * row.scale, `kitchen/${stamp?.kind}: ${JSON.stringify(row.text)}`).toBeLessThanOrEqual(width);
          }
        }
      }
    });
  }
});

/**
 * The owner's DUPLICATE rule (27 Sep) meets the order notes (0.7.21): a paper
 * pressed for by hand says DUPLICATE "Reprint #N" — even the first — and
 * still carries what was written for the whole order, once; the till's own
 * paper carries the note and no DUPLICATE.
 */
describe('DUPLICATE and the order note, on the same paper', () => {
  const NOTE = 'Ring the upper bell, customer asleep downstairs';
  const noted = (s: OrderSnapshot = paid()): OrderSnapshot => {
    s.deliveryNotes = NOTE;
    return s;
  };
  const firstByHand: CopyStamp = { kind: 'reprint', number: 1, printedAt: at(19, 52), byName: 'Ali Akbar', approvedByName: null, firstPrintedAt: at(19, 35) };
  const count = (t: string[], s: string) => t.filter((x) => x.includes(s)).length;

  it('receipt: the first paper printed with the button is DUPLICATE Reprint #1, top to bottom, and still has the note, once', () => {
    const t = text(renderReceipt(noted(), { branding, stamp: firstByHand }));
    expect(t[1]).toBe('DUPLICATE');
    expect(t[2]).toBe('Reprint #1 | 26/09/2026 19:52 | by Ali Akbar');
    expect(t).toContain('** DUPLICATE - Reprint #1 **');
    expect(t).toContain('PAID - CASH (DUPLICATE)');
    expect(count(t, 'Order note: Ring the upper bell')).toBe(1);
    // The note is part of the body, between the DUPLICATE band and the items.
    const note = t.findIndex((x) => x.startsWith('Order note: Ring the upper bell'));
    expect(note).toBeGreaterThan(2);
    expect(note).toBeLessThan(t.findIndex((x) => x.startsWith('2x Chicken Tikka')));
  });

  it('the till’s own paper: the note, and no DUPLICATE', () => {
    const t = text(renderReceipt(noted(), { branding }));
    expect(count(t, 'Order note: Ring the upper bell')).toBe(1);
    expect(t.join(' ')).not.toContain('DUPLICATE');
  });

  it('a bill pressed for by hand while the print log could not be read: DUPLICATE with no number, and the note', () => {
    const t = text(renderReceipt(noted(codBill()), { branding, stamp: { ...firstByHand, number: 0, numberUnknown: true } }));
    expect(t[1]).toBe('DUPLICATE');
    expect(t[2]).toBe('Reprint | 26/09/2026 19:52 | by Ali Akbar');
    expect(t).toContain('** DUPLICATE **');
    expect(t).toContain('BILL - NOT PAID');
    expect(count(t, 'Order note: Ring the upper bell')).toBe(1);
  });

  it('kitchen ticket reprinted: REPRINT, who and when, and the note before the first item', () => {
    const t = text(renderKitchenTicket(noted(), { now: at(19, 52), stamp: firstByHand }));
    expect(t).toContain('* REPRINT *');
    expect(t.join(' ')).toContain('Reprint #1 26/09 19:52 by Ali Akbar');
    const note = t.findIndex((x) => x.startsWith('!! ORDER NOTE: Ring the upper bell'));
    expect(note).toBeGreaterThan(t.indexOf('* REPRINT *'));
    expect(note).toBeLessThan(t.findIndex((x) => x.startsWith('2 x Chicken Tikka')));
    expect(count(t, '!! ORDER NOTE:')).toBe(1);
  });
});

/**
 * NO DISCOUNT ON VALUE DEALS (the owner, 2026-10-02): a discount whose
 * frozen rule left the order's value deals alone says so in brackets, in the
 * one phrase the cart, Pay, the website and the printed coupon use, and the
 * words wrap cleanly on both papers. One that found nothing else to come off
 * (Rs 0: the food was taken off, the deals stayed) prints no line at all.
 */
describe('a discount that left the value deals alone', () => {
  /** Rs 1,000 of pizza and a Rs 3,600 value deal (never discounted), Rs 100 off the pizza. */
  function withDeal(d: Partial<OrderSnapshot['discounts'][number]>, opts: { charge?: boolean } = {}): OrderSnapshot {
    const s = paid();
    const base = s.items[0]!;
    s.items.push({
      ...base,
      id: id('i_deal'),
      menuItemName: 'Test Big Deal',
      categoryName: 'Value Deals',
      quantity: 1,
      unitPriceCents: cents(360_000),
      lineTotalCents: cents(360_000),
      noDiscount: true,
      modifiers: [],
    });
    if (opts.charge) {
      s.items.push({
        ...base,
        id: id('i_fee'),
        menuItemName: 'Delivery Charge (Rs 200)',
        categoryName: 'Delivery Charges',
        quantity: 1,
        unitPriceCents: cents(20_000),
        lineTotalCents: cents(20_000),
        noDiscount: false,
        modifiers: [],
      });
    }
    s.discounts = [
      {
        id: id('d1'),
        orderId: id('o1'),
        discountType: 'percent',
        value: 10,
        reason: null,
        appliedByUserId: id('u1'),
        approvedByUserId: null,
        amountCents: cents(10_000),
        source: null,
        alsoOffDeliveryCharge: false,
        skipsNoDiscountLines: true,
        ...d,
      },
    ];
    return s;
  }
  const offer = { id: 'test-wa', name: 'WhatsApp 10% off', type: 'percent' as const, value: 10, minOrderCents: null, maxOffCents: null, declined: false };

  /** The rows between Subtotal and the tax line: the discount's. */
  const discountRows = (s: OrderSnapshot, width: 48 | 32) => {
    const rows = text(renderReceipt(s, { branding, width }));
    return rows.slice(rows.findIndex((r) => r.startsWith('Subtotal')) + 1, rows.findIndex((r) => r.startsWith('Tax')));
  };

  const cases: Array<[string, OrderSnapshot]> = [
    ['Discount 10% (Staff, not on value deals)', withDeal({ reason: 'Staff' })],
    ['Discount 10% (Staff, food only, not on value deals)', withDeal({ reason: 'Staff' }, { charge: true })],
    ['Discount 10% (not on value deals)', withDeal({})],
    ['Discount (Website pick-up 10% off, not on value deals)', withDeal({ reason: 'Website pick-up 10% off', alsoOffDeliveryCharge: true })],
    ['WhatsApp 10% off (not on value deals)', withDeal({ reason: 'WhatsApp 10% off', source: 'offer', offer })],
  ];

  for (const width of [48, 32] as const) {
    it(`says so in words that wrap cleanly at ${width} columns, the amount at the right`, () => {
      for (const [label, s] of cases) {
        const rows = discountRows(s, width);
        for (const r of rows) expect(r.length, `${label}: ${JSON.stringify(r)}`).toBeLessThanOrEqual(width);
        // Wrapped on spaces only: the rows read back as the words, then the amount.
        expect(rows.map((r) => r.trim()).join(' ').replace(/\s+/g, ' ')).toBe(`${label} - 100.00`);
        expect(rows[rows.length - 1]!.endsWith('- 100.00')).toBe(true);
      }
    });
  }

  it('given before 0.7.34, or one that covered the deals (a foodpanda order): exactly as before', () => {
    for (const skips of [undefined, false]) {
      expect(discountRows(withDeal({ reason: 'Staff', skipsNoDiscountLines: skips }), 48)).toEqual([
        'Discount (Staff)                        - 100.00',
      ]);
    }
  });

  it('at Rs 0 (only the deals left) it prints no line — never "- 0.00"; the total reads as the bill', () => {
    for (const width of [48, 32] as const) {
      const s = withDeal({ reason: 'Staff', amountCents: cents(0) });
      s.items = s.items.filter((i) => i.noDiscount === true);
      expect(discountRows(s, width)).toEqual([]);
      const all = text(renderReceipt(s, { branding, width })).join('\n');
      expect(all).not.toContain('Discount');
      expect(all).not.toContain('- 0.00');
    }
    // A Rs 0 discount whose rule did not skip the deals is not this one: it prints as before.
    const old = withDeal({ reason: 'Staff', amountCents: cents(0), skipsNoDiscountLines: undefined });
    expect(discountRows(old, 48)).toEqual(['Discount (Staff)                          - 0.00']);
  });
});
