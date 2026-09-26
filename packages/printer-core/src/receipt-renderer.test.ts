import { describe, expect, it } from 'vitest';
import type { Cents, OrderNumber, OrderSnapshot, UUID } from '@cheeseoclock/shared-types';
import { EscPosBuilder, LINES_BEFORE_CUT } from './escpos.js';
import { CUT_MARKER, QR_MARKER, decodeEscPos } from './escpos-decode.js';
import type { MonoRaster } from './logo-raster.js';
import {
  LOGO_GAP_DOTS,
  appendLogo,
  renderDrawerKick,
  renderKitchenTicket,
  renderReceipt,
  type ReceiptBranding,
} from './receipt-renderer.js';

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
        menuItemName: 'Chicken Tikka Pizza Large (12") with Stuffed Crust',
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
      rows.some((r) => /^2x Chicken Tikka Pizza Large \(12"\) with\s+2,998\.00$/.test(r)),
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

const DRAWER_KICK = [0x1b, 0x70, 0x00, 0x19, 0xfa].join(',');
const rows = (bytes: Uint8Array) => decodeEscPos(bytes).map((r) => r.text);

describe('renderReceipt — copies and balance', () => {
  it('a settled order says PAID; the customer copy carries no signature line', () => {
    const r = rows(renderReceipt(snapshot(), { branding }));
    expect(r).toContain('PAID');
    expect(r.some((x) => x.startsWith('TO PAY'))).toBe(false);
    expect(r).not.toContain('SHOP COPY');
    expect(r.some((x) => x.startsWith('Received by:'))).toBe(false);
  });

  it('a bill printed before payment shows what to collect', () => {
    const s = snapshot();
    s.order.status = 'out_for_delivery';
    s.order.paidAt = null;
    s.payments = [];
    s.rider = { id: id('r1'), name: 'Bilal', phone: '0311 1234567' };
    const r = rows(renderReceipt(s, { branding }));
    expect(r.some((x) => /^TO PAY\s+Rs 3,303\.68$/.test(x))).toBe(true);
    expect(r).not.toContain('PAID');
    expect(r.some((x) => /^Rider: Bilal\s+0311 1234567$/.test(x))).toBe(true);
  });

  it('the shop copy is labelled, has a signature line and no fiscal QR', () => {
    const r = rows(
      renderReceipt(snapshot(), {
        branding,
        copy: 'shop',
        fbr: { irn: 'ABC123', qrPayload: 'https://fbr.gov.pk/verify/ABC123' },
      }),
    );
    expect(r).toContain('SHOP COPY');
    expect(r.some((x) => /^Received by: _{8,}$/.test(x))).toBe(true);
    expect(r).not.toContain(QR_MARKER);
    expect(r).not.toContain('IRN: ABC123');
    // Still a full receipt: items and total are there for the till count.
    expect(r.some((x) => /^TOTAL\s+Rs 3,303\.68$/.test(x))).toBe(true);
  });

  for (const width of [48, 32] as const) {
    it(`shop copy and unpaid bill fit ${width} columns`, () => {
      const s = snapshot();
      s.payments = [];
      s.rider = { id: id('r1'), name: 'Bilal', phone: '0311 1234567' };
      for (const copy of ['customer', 'shop'] as const) {
        for (const row of decodeEscPos(renderReceipt(s, { width, branding, copy }))) {
          expect(row.text.length * row.scale, JSON.stringify(row.text)).toBeLessThanOrEqual(width);
        }
      }
    });
  }
});

describe('renderKitchenTicket', () => {
  const now = new Date(2026, 8, 14, 19, 35);

  it('shouts the order number and mode, lists what to cook, and never a price', () => {
    const r = rows(renderKitchenTicket(snapshot(), { now }));
    expect(r).toContain('KITCHEN');
    expect(r).toContain('#0042');
    expect(r).toContain('DELIVERY');
    expect(r.some((x) => /^14\/09 19:35\s+Ali Akbar$/.test(x))).toBe(true);
    expect(r.some((x) => /^Customer: Hamza\s+0300 9367865$/.test(x))).toBe(true);
    expect(r.some((x) => x.startsWith('2 x Chicken Tikka Pizza Large (12")'))).toBe(true);
    expect(r.join(' ')).toContain('with Stuffed Crust');
    expect(r).toContain('    + Extra Cheese');
    // a leave-out shouts, without the "+", ahead of the extras
    expect(r).toContain('    NO ONIONS');
    expect(r).not.toContain('    + No onions');
    expect(r.indexOf('    NO ONIONS')).toBeLessThan(r.indexOf('    + Extra Cheese'));
    expect(r.join(' ')).toContain('!! ALLERGY/NOTE: Extra crispy please');
    expect(r).toContain('1 x Coke 500ml');
    expect(r).toContain('  House 12, Street 7, Phase 6, DHA, Karachi -');
    const text = r.join('\n');
    expect(text).not.toContain('Rs');
    expect(text).not.toContain('2,998');
    expect(text).not.toContain('TOTAL');
    expect(text).not.toContain('Subtotal');
    expect(text).not.toContain('Cash');
    expect(r.at(-1)).toBe(CUT_MARKER);
  });

  it('marks a reprint so the line does not cook it twice', () => {
    expect(rows(renderKitchenTicket(snapshot(), { now }))).not.toContain('* REPRINT *');
    expect(rows(renderKitchenTicket(snapshot(), { now, reprint: true }))).toContain('* REPRINT *');
  });

  it('prints order notes for the kitchen', () => {
    const s = snapshot();
    s.order.notes = '[web] ring the bell twice, leave at the gate';
    const r = rows(renderKitchenTicket(s, { now }));
    expect(r).toContain('Note: [web] ring the bell twice, leave at the');
  });

  for (const width of [48, 32] as const) {
    it(`never hands the printer a row wider than ${width} columns`, () => {
      const decoded = decodeEscPos(renderKitchenTicket(snapshot(), { width, now, reprint: true }));
      expect(decoded.length).toBeGreaterThan(10);
      for (const row of decoded) {
        expect(row.text.length * row.scale, JSON.stringify(row.text)).toBeLessThanOrEqual(width);
      }
    });
  }

  it('does not touch the drawer', () => {
    expect([...renderKitchenTicket(snapshot(), { now })].join(',')).not.toContain(DRAWER_KICK);
  });
});

describe('renderDrawerKick', () => {
  it('is only the pulse — no text, no cut', () => {
    const bytes = renderDrawerKick();
    expect([...bytes].join(',')).toContain(DRAWER_KICK);
    const decoded = decodeEscPos(bytes);
    expect(decoded.map((r) => r.text).filter(Boolean)).toEqual([]);
    expect(decoded.some((r) => r.text === CUT_MARKER)).toBe(false);
  });
});

describe('renderReceipt — shop logo', () => {
  /** A 64×20 logo with two dots in every eight: printable, not too dark. */
  const logo = (): MonoRaster => ({ width: 64, height: 20, data: new Uint8Array(8 * 20).fill(0x81) });
  const indexOf = (bytes: Uint8Array, seq: number[]) => {
    for (let i = 0; i + seq.length <= bytes.length; i++) {
      if (seq.every((v, k) => bytes[i + k] === v)) return i;
    }
    return -1;
  };
  const GS_V_0 = [0x1d, 0x76, 0x30];

  it('prints the logo first, across the full paper width, then the shop name', () => {
    for (const [width, dots] of [
      [48, 576],
      [32, 384],
    ] as const) {
      const r = rows(renderReceipt(snapshot(), { width, branding, logo: logo() }));
      expect(r[0]).toBe(`[logo ${dots}×20]`);
      expect(r[1]).toBe("Cheese O'Clock");
    }
  });

  it('centres the picture, then resets the printer and centres again before the name', () => {
    const bytes = renderReceipt(snapshot(), { branding, logo: logo() });
    const pic = indexOf(bytes, GS_V_0);
    expect(pic).toBeGreaterThan(0);
    expect(indexOf(bytes, [0x1b, 0x61, 0x01])).toBeLessThan(pic);
    // Header: 576 dots = 72 bytes a row, 20 rows.
    expect([...bytes.slice(pic, pic + 8)]).toEqual([0x1d, 0x76, 0x30, 0x00, 72, 0x00, 20, 0x00]);
    // The 64-dot logo sits in the middle: 32 blank bytes, its 8, 32 blank.
    const row0 = [...bytes.slice(pic + 8, pic + 8 + 72)];
    expect(row0.slice(0, 32).every((b) => b === 0)).toBe(true);
    expect(row0.slice(32, 40)).toEqual(Array(8).fill(0x81));
    expect(row0.slice(40).every((b) => b === 0)).toBe(true);
    const after = pic + 8 + 72 * 20;
    expect([...bytes.slice(after, after + 8)]).toEqual([0x1b, 0x40, 0x1b, 0x61, 0x01, 0x1b, 0x4a, LOGO_GAP_DOTS]);
  });

  it('puts it on the shop copy and on an unpaid delivery bill too', () => {
    expect(rows(renderReceipt(snapshot(), { branding, copy: 'shop', logo: logo() }))[0]).toBe('[logo 576×20]');
    const s = snapshot();
    s.order.status = 'out_for_delivery';
    s.order.paidAt = null;
    s.payments = [];
    expect(rows(renderReceipt(s, { branding, logo: logo() }))[0]).toBe('[logo 576×20]');
  });

  it('prints exactly the text-only receipt when the logo is unusable', () => {
    const plain = renderReceipt(snapshot(), { branding });
    const bad: unknown[] = [
      null,
      undefined,
      { width: 64, height: 20, data: new Uint8Array(8 * 20 - 1) }, // data length off
      { width: 10, height: 20, data: new Uint8Array(40) }, // not whole bytes
      { width: 64, height: 20, data: new Uint8Array(8 * 20) }, // blank
      { width: 64, height: 20, data: new Uint8Array(8 * 20).fill(0xff) }, // a black block
      { width: 64, height: 200, data: new Uint8Array(8 * 200).fill(0x81) }, // too tall
      { width: 64, height: 20, data: Array(160).fill(0x81) }, // not bytes
      'garbage',
    ];
    for (const l of bad) {
      expect(renderReceipt(snapshot(), { branding, logo: l as MonoRaster })).toEqual(plain);
    }
    // Made for 80 mm paper, sent to a 58 mm printer: too wide, left out.
    const wide = { width: 576, height: 20, data: new Uint8Array(72 * 20).fill(0x81) };
    expect(renderReceipt(snapshot(), { width: 32, branding, logo: wide })).toEqual(
      renderReceipt(snapshot(), { width: 32, branding }),
    );
  });

  for (const width of [48, 32] as const) {
    it(`with a logo still never hands the printer a row wider than ${width} columns`, () => {
      for (const copy of ['customer', 'shop'] as const) {
        for (const row of decodeEscPos(renderReceipt(snapshot(), { width, branding, copy, logo: logo() }))) {
          expect(row.text.length * row.scale, JSON.stringify(row.text)).toBeLessThanOrEqual(width);
        }
      }
    });
  }

  it('keeps the drawer pulse and the cut at the end', () => {
    const bytes = renderReceipt(snapshot(), { branding, logo: logo(), openDrawer: true });
    expect([...bytes].join(',')).toContain(DRAWER_KICK);
    expect(rows(bytes).at(-1)).toBe(CUT_MARKER);
  });

  it('never goes on a kitchen ticket', () => {
    const now = new Date(2026, 8, 14, 19, 35);
    for (const width of [48, 32] as const) {
      expect(indexOf(renderKitchenTicket(snapshot(), { width, now }), GS_V_0)).toBe(-1);
      expect(indexOf(renderKitchenTicket(snapshot(), { width, now, reprint: true }), GS_V_0)).toBe(-1);
    }
  });

  it('appendLogo never throws and writes nothing when it cannot print', () => {
    const b = new EscPosBuilder(48);
    const weird = { width: 64, height: 20, get data(): Uint8Array { throw new Error('boom'); } };
    expect(appendLogo(b, weird as unknown as MonoRaster, 48)).toBe(false);
    expect([...b.build()]).toEqual([0x1b, 0x40]);
    expect(appendLogo(b, logo(), 48)).toBe(true);
  });
});
