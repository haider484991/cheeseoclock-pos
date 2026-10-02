/**
 * The bill after an Edit order and a Free order on paper (v0.7.36):
 *  - ORDER CHANGED and "This replaces the earlier bill" under the title, on
 *    the customer's bill and the SHOP COPY, and never DUPLICATE; not on a
 *    cancelled-order slip;
 *  - a Free order's line reads "Free order (Staff meal)", and its bill says
 *    BILL - NOTHING TO PAY / RIDER COLLECTS NOTHING over TOTAL Rs 0.00.
 *
 * Every name, number and amount is made up.
 */
import { describe, expect, it } from 'vitest';
import type { Cents, OrderNumber, OrderSnapshot, UUID } from '@cheeseoclock/shared-types';
import { escPosToText } from './escpos-decode.js';
import { renderReceipt, type ReceiptBranding, type RenderReceiptOpts } from './receipt-renderer.js';

const id = (s: string) => s as UUID;
const cents = (n: number) => n as Cents;
type Line = OrderSnapshot['items'][number];
const BRANDING: ReceiptBranding = { storeName: 'Test Shop' };

const item = (key: string, name: string, lineCents: number, categoryName = 'Test Food'): Line => ({
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
  kitchenStatus: 'pending',
  menuItemName: name,
  categoryName,
  prepStation: 'kitchen',
  taxRateBps: 1500,
  modifiers: [],
});

/** A delivery the kitchen has (Ready after Back to Ready): a Rs 2,200 pizza and the Rs 200 charge, at 15%. */
function order(free = false): OrderSnapshot {
  const items = [item('pizza', 'Test Pizza', 220_000), item('fee', 'Delivery Charge (Rs 200)', 20_000, 'Delivery Charges')];
  return {
    order: {
      id: id('o1'),
      orderNumber: '20261003-0042' as OrderNumber,
      mode: 'delivery',
      status: 'ready',
      tableId: null,
      customerId: id('c1'),
      cashierId: id('u1'),
      shiftId: id('s1'),
      source: 'pos',
      notes: null,
      subtotalCents: cents(240_000),
      discountCents: cents(free ? 240_000 : 0),
      taxCents: cents(free ? 0 : 36_000),
      totalCents: cents(free ? 0 : 276_000),
      createdAt: '2026-10-03T14:30:00.000Z',
      paidAt: null,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      assignedRiderId: null,
      dispatchedAt: null,
      deliveredAt: null,
    },
    items,
    discounts: free
      ? [
          {
            id: id('d1'),
            orderId: id('o1'),
            discountType: 'percent',
            value: 100,
            reason: 'Staff meal',
            amountCents: cents(240_000),
            appliedByUserId: id('u1'),
            approvedByUserId: id('u2'),
            source: null,
            alsoOffDeliveryCharge: true,
            skipsNoDiscountLines: false,
            freeOrder: true,
          },
        ]
      : [],
    payments: [],
    cashierName: 'Test Cashier',
    tableLabel: null,
    customerName: 'Test Customer',
    customerPhone: '0300 0000001',
    deliveryAddress: 'House 1, Test Street',
    rider: null,
  };
}

const paper = (s: OrderSnapshot, opts: Partial<RenderReceiptOpts> = {}) => escPosToText(renderReceipt(s, { branding: BRANDING, ...opts }));

describe('the bill after an edit', () => {
  it('says ORDER CHANGED under the title, on the customer’s bill and the SHOP COPY, and is no DUPLICATE', () => {
    for (const copy of ['customer', 'shop'] as const) {
      const t = paper(order(), { orderChanged: true, copy });
      const title = t.indexOf('BILL - NOT PAID');
      expect(title).toBeGreaterThanOrEqual(0);
      expect(t.indexOf('ORDER CHANGED')).toBeGreaterThan(title);
      expect(t).toContain('This replaces the earlier bill');
      expect(t).not.toContain('DUPLICATE');
    }
    // Any other bill: no such words.
    expect(paper(order())).not.toContain('ORDER CHANGED');
  });

  it('never on a cancelled-order slip', () => {
    const s = order();
    s.order.status = 'void';
    s.order.voidedAt = '2026-10-03T15:00:00.000Z';
    expect(paper(s, { orderChanged: true })).not.toContain('ORDER CHANGED');
  });
});

describe('a Free order on paper', () => {
  it('prints as itself, with nothing to pay and nothing for the rider to collect', () => {
    const t = paper(order(true));
    expect(t).toContain('Free order (Staff meal)');
    expect(t).not.toMatch(/Discount \(/);
    expect(t).toContain('BILL - NOTHING TO PAY');
    expect(t).toContain('RIDER COLLECTS NOTHING');
    expect(t).toMatch(/Free order \(Staff meal\)\s+- 2,400\.00/);
    expect(t).toMatch(/TOTAL\s+Rs 0\.00/);
    expect(t).toContain('NO CHARGE - NOTHING TO PAY');
  });
});
