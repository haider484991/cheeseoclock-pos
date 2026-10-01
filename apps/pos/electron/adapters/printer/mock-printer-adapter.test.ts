/**
 * The mock printer (no hardware) writes each job as a .bin and a decoded .txt
 * under userData/printer-mock. Those .txt copies are how the labels are
 * checked by eye while developing — so they must show them: DUPLICATE on a
 * reprint, BILL - NOT PAID on a bill, REFUND on a refund slip, REPRINT on a
 * kitchen reprint, TEST PRINT on a test page.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { renderKitchenTicket, renderReceipt } from '@cheeseoclock/printer-core';
import type { Cents, OrderNumber, OrderSnapshot, UUID } from '@cheeseoclock/shared-types';

const dir = vi.hoisted(() => ({ path: '' }));
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ app: { getPath: () => dir.path } }));

dir.path = mkdtempSync(join(tmpdir(), 'coc-mock-printer-'));
afterAll(() => rmSync(dir.path, { recursive: true, force: true }));

const id = (s: string) => s as UUID;
const cents = (n: number) => n as Cents;
/** Pakistan wall-clock time (UTC+5) on 26 Sep 2026: papers print Pakistan time in any zone. */
const at = (h: number, m: number) => new Date(Date.UTC(2026, 8, 26, h - 5, m));

function order(): OrderSnapshot {
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
      createdAt: at(19, 30).toISOString(),
      paidAt: at(19, 35).toISOString(),
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
        menuItemName: 'Chicken Tikka Pizza Large',
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
        receivedByUserId: id('u1'),
        paidAt: at(19, 35).toISOString(),
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

const branding = { storeName: "Cheese O'Clock", storeTagline: 'Pizza - Phase 6, DHA', phoneLine: '0300 0000000' };

describe('mock printer .txt copies', () => {
  it('show every label as the printer would print it', async () => {
    const { MockPrinterAdapter } = await import('./mock-printer-adapter.js');
    const printer = new MockPrinterAdapter({ transport: 'usb', width: 48 });

    const duplicate = renderReceipt(order(), {
      branding,
      stamp: { kind: 'reprint', number: 1, printedAt: at(19, 52), byName: 'Ali Akbar', firstPrintedAt: at(19, 35) },
    });
    const bill = order();
    Object.assign(bill.order, { mode: 'delivery', status: 'out_for_delivery', paidAt: null });
    bill.payments = [];
    bill.deliveryAddress = 'House 12, Street 7, Phase 6, DHA';
    bill.rider = { id: id('r1'), name: 'Bilal', phone: '0311 1234567' };
    const refunded = order();
    refunded.payments.push({ ...refunded.payments[0]!, id: id('p2'), amountCents: cents(-30_000), tenderedCents: null, paidAt: at(19, 50).toISOString() });
    const refund = renderReceipt(refunded, {
      branding,
      document: 'refund',
      refund: {
        refundedAt: at(19, 50),
        rows: [{ method: 'cash', amountCents: 30_000 }],
        reason: 'cold pizza',
        refundedByName: 'Ali Akbar',
        approvedByName: 'Sana Khan',
        totalRefundedCents: 30_000,
      },
    });
    const kitchen = renderKitchenTicket(order(), {
      now: at(19, 52),
      stamp: { kind: 'reprint', number: 1, printedAt: at(19, 52), byName: 'Ali Akbar', firstPrintedAt: at(19, 35) },
    });

    for (const bytes of [duplicate, renderReceipt(bill, { branding }), refund, kitchen]) {
      expect((await printer.send(bytes)).ok).toBe(true);
    }
    expect((await printer.testPrint({ station: 'receipt' })).ok).toBe(true);

    const out = join(dir.path, 'printer-mock');
    const txt = readdirSync(out)
      .filter((f) => f.endsWith('.txt'))
      .sort()
      .map((f) => readFileSync(join(out, f), 'utf8'));
    expect(txt).toHaveLength(5);
    const [dup, notPaid, slip, reprint, test] = txt as [string, string, string, string, string];
    expect(dup.split('\n')[1]).toBe('DUPLICATE');
    expect(dup).toContain('Reprint #1 | 26/09/2026 19:52 | by Ali Akbar');
    expect(dup).toContain('PAID - CASH (DUPLICATE)');
    expect(dup).toContain('** DUPLICATE - Reprint #1 **');
    expect(notPaid).toContain('BILL - NOT PAID');
    expect(notPaid).toContain('CASH ON DELIVERY');
    expect(notPaid).toContain('Pay the rider Rs 1,160.00');
    expect(slip).toContain('REFUND');
    expect(slip).toContain('Rs 300.00 RETURNED');
    expect(slip).toContain('REFUND SLIP - NOT A RECEIPT FOR PAYMENT');
    expect(reprint).toContain('* REPRINT *');
    expect(reprint).toContain('SAME ORDER - DO NOT COOK TWICE');
    expect(test).toContain('TEST PRINT');
    expect(test).toContain('NOT A RECEIPT');
    expect(test).toContain('Station: Receipt printer');
    const keep = process.env['COC_SHOW_MOCK_TXT'];
    if (keep) {
      // For a person checking the layout: `COC_SHOW_MOCK_TXT=<file> vitest run …`.
      writeFileSync(keep, txt.join('\n\n==========\n\n'));
    }
  });
});
