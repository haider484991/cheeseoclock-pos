/**
 * Golden papers (test fixture, never imported by the app). Every kind of
 * paper the till prints — receipt, bill, refund slip, cancelled order,
 * customer and shop copy, original, DUPLICATE and late print, both paper
 * widths, with and without the shop's address lines, FBR — and the kitchen
 * ticket, rendered from made-up orders. receipt-goldens.json holds a
 * fingerprint of each one's bytes as the renderer printed them before the
 * receipt's extra lines existed (v0.7.26, plus "Cashier: Website" on a
 * website order), so a change that moves a single byte of a paper with no
 * extra lines fails receipt-extra-lines.test.ts. Papers that did not exist
 * before a version are added with it, never regenerated: v0.7.34's value
 * deals (the receipt-deals-* papers).
 *
 * Times are Pakistan wall-clock instants: papers print Pakistan time, so the
 * bytes are the same in any time zone.
 * Every name, number and amount is made up.
 */
import type { Cents, OrderNumber, OrderSnapshot, PrinterWidth, UUID } from '@cheeseoclock/shared-types';
import {
  renderKitchenTicket,
  renderReceipt,
  type CopyStamp,
  type ReceiptBranding,
  type RefundSlipInfo,
  type RenderReceiptOpts,
} from './receipt-renderer.js';

const id = (s: string) => s as UUID;
const cents = (n: number) => n as Cents;
/** Pakistan wall-clock time (UTC+5) on 26 Sep 2026. */
const at = (h: number, m: number) => new Date(Date.UTC(2026, 8, 26, h - 5, m));
const iso = (h: number, m: number) => at(h, m).toISOString();

/** A paid takeaway at the counter: Rs 1,160 (1,000 + 16% tax), cash. */
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
        unitPriceCents: cents(45_000),
        lineTotalCents: cents(90_000),
        taxCategoryId: id('t1'),
        notes: 'Well done please',
        kitchenStatus: 'pending',
        menuItemName: 'Test Tikka Pizza — Large',
        categoryName: 'Pizza',
        prepStation: 'kitchen',
        taxRateBps: 1600,
        modifiers: [
          { id: id('mo1'), orderItemId: id('i1'), modifierId: id('md1'), modifierName: 'Extra Cheese', priceDeltaCents: cents(0) },
          { id: id('mo2'), orderItemId: id('i1'), modifierId: id('md2'), modifierName: 'No onion', priceDeltaCents: cents(0) },
        ],
      },
      {
        id: id('i2'),
        orderId: id('o1'),
        menuItemId: id('m2'),
        comboId: null,
        parentOrderItemId: null,
        quantity: 1,
        unitPriceCents: cents(10_000),
        lineTotalCents: cents(10_000),
        taxCategoryId: id('t1'),
        notes: null,
        kitchenStatus: 'pending',
        menuItemName: 'Test Cola 500ml',
        categoryName: 'Drinks',
        prepStation: 'bar',
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
        receivedByUserId: id('u1'),
        paidAt: iso(19, 35),
      },
    ],
    cashierName: 'Test Cashier',
    tableLabel: null,
    customerName: null,
    customerPhone: null,
    deliveryAddress: null,
    rider: null,
  };
}

/** A cash-on-delivery order out with its rider, nothing paid yet, a discount and a note. */
function codBill(): OrderSnapshot {
  const s = paid();
  s.order.mode = 'delivery';
  s.order.status = 'out_for_delivery';
  s.order.paidAt = null;
  s.order.dispatchedAt = iso(19, 50);
  s.order.discountCents = cents(10_000);
  s.order.taxCents = cents(14_400);
  s.order.totalCents = cents(104_400);
  s.discounts = [
    {
      id: id('d1'),
      orderId: id('o1'),
      discountType: 'percent',
      value: 10,
      reason: 'Test regular',
      amountCents: cents(10_000),
      appliedByUserId: id('u1'),
      approvedByUserId: null,
    },
  ];
  s.payments = [];
  s.customerName = 'Test Customer';
  s.customerPhone = '0300 0000001';
  s.deliveryAddress = 'House 1, Test Street, Phase 0, Test Town';
  s.deliveryNotes = 'Ring the top bell';
  s.rider = { id: id('r1'), name: 'Test Rider', phone: '0311 0000002' };
  return s;
}

/** A website pick-up order, paid by card. */
function webPaid(): OrderSnapshot {
  const s = paid();
  s.order.source = 'web';
  s.order.notes = '[web pick-up] Please pack the dips';
  s.payments = [{ ...s.payments[0]!, method: 'card', tenderedCents: null }];
  s.customerName = 'Test Web Customer';
  s.customerPhone = '0300 0000003';
  return s;
}

function refundRow(amount: number, h: number, m: number) {
  return {
    id: id(`rf-${h}${m}`),
    orderId: id('o1'),
    method: 'cash' as const,
    amountCents: cents(-amount),
    tenderedCents: null,
    referenceNo: 'partial-refund: test reason',
    receivedByUserId: id('u2'),
    paidAt: iso(h, m),
  };
}

/** Paid, then Rs 300 went back. */
function partRefunded(): OrderSnapshot {
  const s = paid();
  s.payments.push(refundRow(30_000, 19, 50));
  return s;
}

/** Paid, then refunded in full. */
function fullyRefunded(): OrderSnapshot {
  const s = paid();
  s.order.status = 'refunded';
  s.payments.push(refundRow(116_000, 19, 55));
  return s;
}

/** Cancelled before payment. */
function cancelled(): OrderSnapshot {
  const s = codBill();
  s.order.status = 'void';
  s.order.voidedAt = iso(19, 58);
  s.order.voidReason = 'Test cancel reason';
  return s;
}

/** A dine-in table, nothing to pay (100% off). */
function freeTable(): OrderSnapshot {
  const s = paid();
  s.order.mode = 'dine_in';
  s.order.status = 'served';
  s.order.paidAt = null;
  s.order.discountCents = cents(100_000);
  s.order.taxCents = cents(0);
  s.order.totalCents = cents(0);
  s.discounts = [
    {
      id: id('d2'),
      orderId: id('o1'),
      discountType: 'percent',
      value: 100,
      reason: 'Test staff meal',
      amountCents: cents(100_000),
      appliedByUserId: id('u1'),
      approvedByUserId: id('u2'),
    },
  ];
  s.payments = [];
  s.tableLabel = 'T-3';
  return s;
}

/**
 * NO DISCOUNT ON VALUE DEALS (v0.7.34): a paid takeaway of a value deal (its
 * line marked noDiscount, Rs 3,600) and a pizza (Rs 1,500), and a discount
 * whose frozen rule left the deal alone: 10% of the pizza = Rs 150 off; tax
 * 16% of 3,600 + 1,350 = Rs 792; Rs 5,742. No delivery charge on these, so
 * the delivery bill's layout never moves them.
 */
function dealsPaid(discount: { reason: string; source?: 'offer'; alsoOffDeliveryCharge: boolean }): OrderSnapshot {
  const s = paid();
  s.order.subtotalCents = cents(510_000);
  s.order.discountCents = cents(15_000);
  s.order.taxCents = cents(79_200);
  s.order.totalCents = cents(574_200);
  s.items = [
    {
      ...s.items[1]!,
      id: id('i3'),
      menuItemId: id('m3'),
      quantity: 1,
      unitPriceCents: cents(360_000),
      lineTotalCents: cents(360_000),
      menuItemName: 'Test Big Deal',
      categoryName: 'Value Deals',
      prepStation: 'kitchen',
      noDiscount: true,
      modifiers: [],
    },
    {
      ...s.items[1]!,
      id: id('i4'),
      menuItemId: id('m4'),
      quantity: 1,
      unitPriceCents: cents(150_000),
      lineTotalCents: cents(150_000),
      menuItemName: 'Test Fajita Pizza - Medium',
      categoryName: 'Pizza',
      prepStation: 'kitchen',
      noDiscount: false,
      modifiers: [],
    },
  ];
  s.discounts = [
    {
      id: id('d3'),
      orderId: id('o1'),
      discountType: 'percent',
      value: 10,
      reason: discount.reason,
      amountCents: cents(15_000),
      appliedByUserId: id('u1'),
      approvedByUserId: null,
      source: discount.source ?? null,
      ...(discount.source === 'offer'
        ? {
            offer: { id: 'test-wa', name: discount.reason, type: 'percent' as const, value: 10, minOrderCents: null, maxOffCents: null, declined: false },
          }
        : {}),
      alsoOffDeliveryCharge: discount.alsoOffDeliveryCharge,
      skipsNoDiscountLines: true,
    },
  ];
  s.payments = [{ ...s.payments[0]!, amountCents: cents(574_200), tenderedCents: cents(600_000) }];
  return s;
}

/** A staff discount at the counter: "Discount 10% (Test staff, not on value deals)". */
const dealsStaff = () => dealsPaid({ reason: 'Test staff', alsoOffDeliveryCharge: false });

/** A website pick-up worked on the lines the site priced: "Discount (Website pick-up 10% off, not on value deals)". */
function dealsWebPickup(): OrderSnapshot {
  const s = dealsPaid({ reason: 'Website pick-up 10% off', alsoOffDeliveryCharge: true });
  s.order.source = 'web';
  s.order.notes = '[web pick-up] Test note';
  s.payments = [{ ...s.payments[0]!, method: 'card', tenderedCents: null }];
  s.customerName = 'Test Web Customer';
  s.customerPhone = '0300 0000003';
  return s;
}

/** One of the owner's automatic offers, by its name: "Test WhatsApp 10% off (not on value deals)". */
const dealsOffer = () => dealsPaid({ reason: 'Test WhatsApp 10% off', source: 'offer', alsoOffDeliveryCharge: false });

/**
 * Only the deal is left: the pizza was taken off after a staff discount, so
 * the discount stays on the order at Rs 0 (its rule skips the deal) and
 * prints no line, never "- 0.00". Rs 3,600 + 16% = Rs 4,176.
 */
function dealsOnly(): OrderSnapshot {
  const s = dealsStaff();
  s.items = [s.items[0]!];
  s.order.subtotalCents = cents(360_000);
  s.order.discountCents = cents(0);
  s.order.taxCents = cents(57_600);
  s.order.totalCents = cents(417_600);
  s.discounts = [{ ...s.discounts[0]!, amountCents: cents(0) }];
  s.payments = [{ ...s.payments[0]!, amountCents: cents(417_600), tenderedCents: cents(500_000) }];
  return s;
}

const refundInfo = (): RefundSlipInfo => ({
  refundedAt: at(19, 50),
  rows: [{ method: 'cash', amountCents: 30_000 }],
  reason: 'Test refund reason',
  refundedByName: 'Test Cashier',
  approvedByName: 'Test Manager',
  totalRefundedCents: 30_000,
  debitNoteMissing: 'pending',
});

const reprint: CopyStamp = {
  kind: 'reprint',
  number: 1,
  printedAt: at(19, 52),
  byName: 'Test Cashier',
  approvedByName: 'Test Manager',
  firstPrintedAt: at(19, 35),
};
const late: CopyStamp = { kind: 'late', number: 1, printedAt: at(21, 5), byName: 'Test Manager' };
const fbr = { irn: '000000-260926193500-0001', qrPayload: 'https://verify.example/000000-260926193500-0001' };

/** The shop's lines as the owner typed them: every bottom line set, and a long thank-you. */
const FULL_BRANDING: ReceiptBranding = {
  storeName: 'Test Pizza Shop',
  storeTagline: 'Pizza · Burgers · Late-night',
  branchLine: 'Shop 1, Test Road, Phase 0, Test Town',
  phoneLine: '0300 0000000',
  websiteLine: 'test.example',
  footerLine: 'Thank you — order again on test.example, we deliver till late',
};
/** Only the name (nothing else set): the default thank-you line prints. */
const BARE_BRANDING: ReceiptBranding = { storeName: 'Test Pizza Shop' };

export interface GoldenCase {
  name: string;
  /** Renders the paper; `brand` may change the shop's lines first (a kitchen ticket has none). */
  render: (brand: (b: ReceiptBranding) => ReceiptBranding) => Uint8Array;
}

function receiptCases(): GoldenCase[] {
  const out: GoldenCase[] = [];
  const papers: Array<[string, () => OrderSnapshot, Omit<RenderReceiptOpts, 'branding' | 'width'>]> = [
    ['receipt', paid, {}],
    ['receipt-fbr', paid, { fbr }],
    ['receipt-fbr-pending', paid, { fbrMissing: 'pending' }],
    ['receipt-duplicate', paid, { stamp: reprint, fbr }],
    ['receipt-late', paid, { stamp: late }],
    ['receipt-shop-copy', paid, { copy: 'shop' }],
    ['receipt-web', webPaid, {}],
    ['receipt-part-refunded', partRefunded, {}],
    ['receipt-refunded-in-full', fullyRefunded, {}],
    ['bill-cod', codBill, {}],
    ['bill-cod-shop-copy', codBill, { copy: 'shop' }],
    ['bill-cod-duplicate', codBill, { stamp: { ...reprint, kind: 'copy', number: 2 } }],
    ['bill-nothing-to-pay', freeTable, {}],
    ['refund-slip', partRefunded, { document: 'refund', refund: refundInfo() }],
    ['refund-slip-shop-copy', partRefunded, { document: 'refund', refund: refundInfo(), copy: 'shop' }],
    ['cancelled-order', cancelled, { cancelled: { at: at(19, 58), byName: 'Test Manager', reason: 'Test cancel reason' } }],
    ['cancelled-order-shop-copy', cancelled, { copy: 'shop' }],
    // NO DISCOUNT ON VALUE DEALS (v0.7.34): papers that did not exist before, added (never regenerated).
    ['receipt-deals-staff', dealsStaff, {}],
    ['receipt-deals-web-pickup', dealsWebPickup, {}],
    ['receipt-deals-offer', dealsOffer, {}],
    ['receipt-deals-only', dealsOnly, {}],
  ];
  for (const [paper, snap, opts] of papers) {
    for (const [brandName, branding] of [
      ['full', FULL_BRANDING],
      ['bare', BARE_BRANDING],
    ] as const) {
      for (const width of [48, 32] as PrinterWidth[]) {
        out.push({
          name: `${paper}/${brandName}/${width}`,
          render: (brand) => renderReceipt(snap(), { ...opts, width, branding: brand({ ...branding }) }),
        });
      }
    }
  }
  return out;
}

function kitchenCases(): GoldenCase[] {
  const now = at(19, 40);
  const tickets: Array<[string, () => OrderSnapshot, Parameters<typeof renderKitchenTicket>[1]]> = [
    ['kitchen', paid, { now }],
    ['kitchen-web', webPaid, { now }],
    ['kitchen-delivery', codBill, { now, queuedAt: at(19, 30) }],
    ['kitchen-reprint', paid, { now, stamp: reprint }],
    ['kitchen-cancelled', cancelled, { now, cancelled: true, cancelInfo: { at: at(19, 58), byName: 'Test Manager', reason: 'Test cancel reason' } }],
    ['kitchen-copies-no-drinks', paid, { now, copyOf: { n: 1, of: 2 }, showDrinks: false, showPhone: false }],
  ];
  const out: GoldenCase[] = [];
  for (const [name, snap, opts] of tickets) {
    for (const width of [48, 32] as PrinterWidth[]) {
      out.push({ name: `${name}/${width}`, render: () => renderKitchenTicket(snap(), { ...opts, width }) });
    }
  }
  return out;
}

/** Every golden paper. */
export function goldenCases(): GoldenCase[] {
  return [...receiptCases(), ...kitchenCases()];
}

/**
 * A fingerprint of a paper's bytes: its length and two independent 32-bit
 * hashes (FNV-1a and a multiplicative one). Not cryptographic; any changed,
 * added or dropped byte changes it.
 */
export function fingerprint(bytes: Uint8Array): string {
  let fnv = 0x811c9dc5;
  let mul = 0;
  for (const b of bytes) {
    fnv = Math.imul(fnv ^ b, 0x01000193) >>> 0;
    mul = (Math.imul(mul, 31) + b + 1) >>> 0;
  }
  return `${bytes.length}:${fnv.toString(16).padStart(8, '0')}:${mul.toString(16).padStart(8, '0')}`;
}
