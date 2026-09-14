import { describe, expect, it } from 'vitest';
import type { Cents, OrderNumber, OrderSnapshot, UUID } from '@cheeseoclock/shared-types';
import { LINES_BEFORE_CUT } from './escpos.js';
import { CUT_MARKER, QR_MARKER, decodeEscPos } from './escpos-decode.js';
import { renderReceipt, type ReceiptBranding } from './receipt-renderer.js';

const id = (s: string) => s as UUID;
const cents = (n: number) => n as Cents;

/** A delivery order with everything that can make a receipt line long. */
function snapshot(): OrderSnapshot {
  return {
    order: {
      id: id('o1'),
      orderNumber: '20260914-0042' as OrderNumber,
      mode: 'delivery',
      status: 'paid',
      tableId: null,
      customerId: id('c1'),
      cashierId: id('u1'),
      shiftId: id('s1'),
      source: 'web',
      notes: null,
      subtotalCents: cents(304_800),
      discountCents: cents(20_000),
      taxCents: cents(45_568),
      totalCents: cents(330_368),
      createdAt: '2026-09-14T11:05:00.000Z',
      paidAt: '2026-09-14T11:20:00.000Z',
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
        unitPriceCents: cents(149_900),
        lineTotalCents: cents(299_800),
        taxCategoryId: id('t1'),
        notes: 'Extra crispy please — and cut into 8 slices',
        kitchenStatus: 'served',
        menuItemName: 'Chicken Tikka Pizza Large (15") with Stuffed Crust',
        categoryName: 'Pizza',
        prepStation: 'kitchen',
        modifiers: [
          {
            id: id('mo1'),
            orderItemId: id('i1'),
            modifierId: id('md1'),
            modifierName: 'Extra Cheese',
            priceDeltaCents: cents(15_000),
          },
          {
            id: id('mo2'),
            orderItemId: id('i1'),
            modifierId: id('md2'),
            modifierName: 'No onions',
            priceDeltaCents: cents(0),
          },
        ],
      },
      {
        id: id('i2'),
        orderId: id('o1'),
        menuItemId: id('m2'),
        comboId: null,
        parentOrderItemId: null,
        quantity: 1,
        unitPriceCents: cents(5_000),
        lineTotalCents: cents(5_000),
        taxCategoryId: id('t1'),
        notes: null,
        kitchenStatus: 'served',
        menuItemName: 'Coke 500ml',
        categoryName: 'Drinks',
        prepStation: 'bar',
        modifiers: [],
      },
    ],
    discounts: [
      {
        id: id('d1'),
        orderId: id('o1'),
        discountType: 'flat',
        value: 20_000,
        reason: 'Friends & family — Eid',
        appliedByUserId: id('u1'),
        approvedByUserId: id('u2'),
        amountCents: cents(20_000),
      },
    ],
    payments: [
      {
        id: id('p1'),
        orderId: id('o1'),
        method: 'cash',
        amountCents: cents(330_368),
        tenderedCents: cents(350_000),
        referenceNo: null,
        receivedByUserId: id('u1'),
        paidAt: '2026-09-14T11:20:00.000Z',
      },
    ],
    cashierName: 'Ali Akbar',
    tableLabel: null,
    customerName: 'Hamza',
    customerPhone: '0300 9367865',
    deliveryAddress: 'House 12, Street 7, Phase 6, DHA, Karachi — ring the bell twice',
    rider: null,
  };
}

const branding: ReceiptBranding = {
  storeName: 'Cheese O’Clock',
  storeTagline: 'Pakistani pizza · cafe — open till late, every night of the week',
  branchLine: 'Phase 6, DHA, Karachi',
  phoneLine: '0300 9367865',
  footerLine: 'Thank you — order again at www.cheeseoclock.net and follow us for deals',
};

describe('renderReceipt', () => {
  for (const width of [48, 32] as const) {
    it(`never hands the printer a row wider than ${width} columns`, () => {
      const rows = decodeEscPos(renderReceipt(snapshot(), { width, branding }));
      expect(rows.length).toBeGreaterThan(20);
      for (const r of rows) {
        expect(r.text.length * r.scale, JSON.stringify(r.text)).toBeLessThanOrEqual(width);
      }
    });
  }

  it('prints typography as ASCII stand-ins, never as ?', () => {
    const text = decodeEscPos(renderReceipt(snapshot(), { branding }))
      .map((r) => r.text)
      .join('\n');
    expect(text).not.toContain('?');
    expect(text).toContain("Cheese O'Clock");
    expect(text).toContain('Thank you - order again at www.cheeseoclock.net');
    expect(text).toContain('Discount (Friends & family - Eid)');
    expect(text).toContain('[ FBR fiscal QR - pending ]');
  });

  it('wraps long free text on word boundaries', () => {
    const rows = decodeEscPos(renderReceipt(snapshot(), { width: 48, branding })).map(
      (r) => r.text,
    );
    const tagline = rows.indexOf('Pakistani pizza - cafe - open till late, every');
    expect(tagline).toBeGreaterThan(0);
    expect(rows[tagline + 1]).toBe('night of the week');
    const footer = rows.indexOf('Thank you - order again at www.cheeseoclock.net');
    expect(footer).toBeGreaterThan(tagline);
    expect(rows[footer + 1]).toBe('and follow us for deals');
    expect(rows).toContain('  House 12, Street 7, Phase 6, DHA, Karachi -');
    expect(rows).toContain('  ring the bell twice');
  });

  it('shows the item, totals, tendered cash and change', () => {
    const rows = decodeEscPos(renderReceipt(snapshot(), { width: 48, branding })).map(
      (r) => r.text,
    );
    expect(
      rows.some((r) => /^2x Chicken Tikka Pizza Large \(15"\) with\s+2,998\.00$/.test(r)),
    ).toBe(true);
    expect(rows).toContain('Stuffed Crust');
    expect(rows.some((r) => /^ {4}Extra Cheese\s+\+ 150\.00$/.test(r))).toBe(true);
    expect(rows).toContain('    No onions');
    expect(rows.some((r) => /^Subtotal\s+3,048\.00$/.test(r))).toBe(true);
    expect(rows.some((r) => /^TOTAL\s+Rs 3,303\.68$/.test(r))).toBe(true);
    expect(rows.some((r) => /^Tendered\s+3,500\.00$/.test(r))).toBe(true);
    expect(rows.some((r) => /^Change\s+196\.32$/.test(r))).toBe(true);
  });

  it('ends with a bottom margin and then the cut', () => {
    const rows = decodeEscPos(renderReceipt(snapshot(), { branding }));
    expect(rows.at(-1)?.text).toBe(CUT_MARKER);
    const margin = rows.slice(-1 - LINES_BEFORE_CUT, -1);
    expect(margin.every((r) => r.text === '')).toBe(true);
  });

  it('can skip the cut and open the drawer on request', () => {
    const plain = renderReceipt(snapshot(), { branding, cutPaper: false });
    expect(decodeEscPos(plain).at(-1)?.text).not.toBe(CUT_MARKER);
    const drawerKick = [0x1b, 0x70, 0x00, 0x19, 0xfa].join(',');
    expect([...plain].join(',')).not.toContain(drawerKick);
    const withDrawer = renderReceipt(snapshot(), { branding, openDrawer: true });
    expect([...withDrawer].join(',')).toContain(drawerKick);
  });

  it('prints the FBR block with a QR once an IRN exists', () => {
    const rows = decodeEscPos(
      renderReceipt(snapshot(), {
        branding,
        fbr: { irn: 'ABC123', qrPayload: 'https://fbr.gov.pk/verify/ABC123' },
      }),
    ).map((r) => r.text);
    expect(rows).toContain('FBR Digital Invoice');
    expect(rows).toContain('IRN: ABC123');
    expect(rows).toContain(QR_MARKER);
    expect(rows).not.toContain('[ FBR fiscal QR - pending ]');
  });
});
