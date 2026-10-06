/**
 * The card rate on paper (migration 0052; the owner, 6 Oct 2026). An order
 * whose lines charge less by card, wallet or bank carries its bill by card
 * beside its total: an UNPAID bill prints it under the total ("By card /
 * wallet"), so the customer can choose. Once paid, the tax line says what was
 * charged: "Tax (8%)" on a bill paid entirely by card, two lines — "Tax 15%
 * (cash part)" and "Tax 8% (card part)" — on one paid part and part, and the
 * usual "Tax (15%)" on a cash sale, byte for byte as before 0052. The
 * delivery bill does the same on its "Sales tax" line. Every name and amount
 * is made up.
 */
import { describe, expect, it } from 'vitest';
import type { Cents, OrderNumber, OrderSnapshot, UUID } from '@cheeseoclock/shared-types';
import { decodeEscPos } from './escpos-decode.js';
import { renderReceipt, type ReceiptBranding } from './receipt-renderer.js';

const id = (s: string) => s as UUID;
const cents = (n: number) => n as Cents;
type Line = OrderSnapshot['items'][number];

const branding: ReceiptBranding = { storeName: 'Test Shop' };

/** A Rs 1,000 plate at 15% in cash, 8% by card (digitalRateBps). */
function plate(key = 'plate', digitalRateBps: number | null = 800): Line {
  return {
    id: id(`i-${key}`),
    orderId: id('o1'),
    menuItemId: id(`m-${key}`),
    comboId: null,
    parentOrderItemId: null,
    quantity: 1,
    unitPriceCents: cents(100_000),
    lineTotalCents: cents(100_000),
    taxCategoryId: id('t1'),
    notes: null,
    kitchenStatus: 'pending',
    menuItemName: 'Test Plate',
    categoryName: 'Test Food',
    prepStation: 'kitchen',
    taxRateBps: 1500,
    ...(digitalRateBps === null ? {} : { digitalRateBps }),
    modifiers: [],
  };
}

/** A takeaway order with the stored figures given, as the till stores them. */
function order(
  items: Line[],
  stored: { tax: number; total: number; byCard?: number | null; cardNet?: number; cardTax?: number; paid?: boolean },
): OrderSnapshot {
  const subtotal = items.reduce((n, l) => n + l.lineTotalCents, 0);
  const paid = stored.paid ?? false;
  return {
    order: {
      id: id('o1'),
      orderNumber: '20261006-0007' as OrderNumber,
      mode: 'takeaway',
      status: paid ? 'paid' : 'sent_to_kitchen',
      tableId: null,
      customerId: null,
      cashierId: id('u1'),
      shiftId: id('s1'),
      source: 'pos',
      notes: null,
      subtotalCents: cents(subtotal),
      discountCents: cents(0),
      taxCents: cents(stored.tax),
      totalCents: cents(stored.total),
      ...(typeof stored.byCard === 'number' ? { digitalTotalCents: cents(stored.byCard) } : {}),
      ...(stored.cardNet ? { digitalNetCents: cents(stored.cardNet) } : {}),
      ...(stored.cardTax ? { digitalTaxCents: cents(stored.cardTax) } : {}),
      createdAt: '2026-10-06T14:00:00.000Z',
      sentAt: '2026-10-06T14:01:00.000Z',
      paidAt: paid ? '2026-10-06T14:05:00.000Z' : null,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      assignedRiderId: null,
      dispatchedAt: null,
      deliveredAt: null,
    },
    items,
    discounts: [],
    payments: paid
      ? [
          {
            id: id('p1'),
            orderId: id('o1'),
            method: stored.cardNet ? 'card' : 'cash',
            amountCents: cents(stored.total),
            tenderedCents: null,
            referenceNo: null,
            receivedByUserId: id('u1'),
            paidAt: '2026-10-06T14:05:00.000Z',
          },
        ]
      : [],
    cashierName: 'Test Cashier',
    tableLabel: null,
    customerName: null,
    customerPhone: null,
    deliveryAddress: null,
    rider: null,
  };
}

const rows = (s: OrderSnapshot) => decodeEscPos(renderReceipt(s, { branding })).map((r) => r.text);
const row = (s: OrderSnapshot, starts: string) => rows(s).find((t) => t.startsWith(starts));

describe('the bill by card on an unpaid bill (0052)', () => {
  it('prints "By card / wallet" under TOTAL when the lines charge less by card; not once paid; never without a card rate', () => {
    const open = order([plate()], { tax: 15_000, total: 115_000, byCard: 108_000 });
    const text = rows(open);
    const total = text.findIndex((t) => t.startsWith('TOTAL'));
    expect(text[total]).toContain('1,150.00');
    expect(text[total + 1]).toMatch(/^By card \/ wallet\s+Rs 1,080\.00$/);
    expect(row(open, 'Tax')).toMatch(/^Tax \(15%\)\s+150\.00$/);

    const paid = order([plate()], { tax: 15_000, total: 115_000, byCard: 108_000, paid: true });
    expect(row(paid, 'By card')).toBeUndefined();
    const plain = order([plate('plain', null)], { tax: 15_000, total: 115_000 });
    expect(row(plain, 'By card')).toBeUndefined();
    // The same bill by card as the total (every line zero-rated, say): no line either.
    expect(row(order([plate()], { tax: 15_000, total: 115_000, byCard: 115_000 }), 'By card')).toBeUndefined();
  });
});

describe('the tax line(s) of a paid receipt (0052)', () => {
  it('a cash sale: "Tax (15%)", exactly as before', () => {
    const s = order([plate()], { tax: 15_000, total: 115_000, byCard: 108_000, paid: true });
    expect(rows(s).filter((t) => t.startsWith('Tax'))).toEqual([expect.stringMatching(/^Tax \(15%\)\s+150\.00$/)]);
  });

  it('paid entirely by card: one "Tax (8%)" line at the card rate', () => {
    const s = order([plate()], { tax: 8_000, total: 108_000, byCard: 108_000, cardNet: 100_000, cardTax: 8_000, paid: true });
    expect(rows(s).filter((t) => t.startsWith('Tax'))).toEqual([expect.stringMatching(/^Tax \(8%\)\s+80\.00$/)]);
    expect(row(s, 'TOTAL')).toContain('1,080.00');
  });

  it('half on the card, half in cash: the cash part at 15% and the card part at 8%, from the stored figures', () => {
    const s = order([plate()], { tax: 11_500, total: 111_500, byCard: 108_000, cardNet: 50_000, cardTax: 4_000, paid: true });
    expect(rows(s).filter((t) => t.startsWith('Tax'))).toEqual([
      expect.stringMatching(/^Tax 15% \(cash part\)\s+75\.00$/),
      expect.stringMatching(/^Tax 8% \(card part\)\s+40\.00$/),
    ]);
    expect(row(s, 'TOTAL')).toContain('1,115.00');
  });

  it('lines at different card rates: the parts print with no rate', () => {
    const s = order([plate('a', 800), plate('b', 500)], { tax: 20_000, total: 220_000, byCard: 213_000, cardNet: 100_000, cardTax: 6_500, paid: true });
    expect(rows(s).filter((t) => t.startsWith('Tax'))).toEqual([
      expect.stringMatching(/^Tax 15% \(cash part\)\s+135\.00$/),
      expect.stringMatching(/^Tax \(card part\)\s+65\.00$/),
    ]);
  });
});

describe('the delivery bill (0052)', () => {
  const charge = (): Line => ({
    ...plate('fee', 800),
    unitPriceCents: cents(20_000),
    lineTotalCents: cents(20_000),
    menuItemName: 'Delivery Charge (Rs 200)',
    categoryName: 'Delivery Charges',
  });
  const delivery = (stored: Parameters<typeof order>[1]): OrderSnapshot => {
    const s = order([plate(), charge()], stored);
    return { ...s, order: { ...s.order, mode: 'delivery' }, customerName: 'Test Customer', customerPhone: '0300 0000001', deliveryAddress: 'House 1, Test Street' };
  };

  it('unpaid: the charge taxed on its own line as ever, and "By card / wallet" under CUSTOMER PAYS', () => {
    const s = delivery({ tax: 18_000, total: 138_000, byCard: 129_600 });
    const text = rows(s);
    expect(text.filter((t) => t.startsWith('Sales tax'))).toEqual([
      expect.stringMatching(/^Sales tax 15%\s+150\.00$/),
      expect.stringMatching(/^Sales tax on delivery 15%\s+30\.00$/),
    ]);
    const pays = text.findIndex((t) => t.startsWith('CUSTOMER PAYS'));
    expect(text[pays + 1]).toMatch(/^By card \/ wallet\s+Rs 1,296\.00$/);
  });

  it('paid entirely by card: one "Sales tax 8%" line for the whole tax; part and part: "Sales tax" with no rate', () => {
    const byCard = delivery({ tax: 9_600, total: 129_600, byCard: 129_600, cardNet: 120_000, cardTax: 9_600, paid: true });
    expect(rows(byCard).filter((t) => t.startsWith('Sales tax'))).toEqual([expect.stringMatching(/^Sales tax 8%\s+96\.00$/)]);
    expect(row(byCard, 'By card')).toBeUndefined();
    const mixed = delivery({ tax: 13_800, total: 133_800, byCard: 129_600, cardNet: 60_000, cardTax: 4_800, paid: true });
    expect(rows(mixed).filter((t) => t.startsWith('Sales tax'))).toEqual([expect.stringMatching(/^Sales tax\s+138\.00$/)]);
  });
});
