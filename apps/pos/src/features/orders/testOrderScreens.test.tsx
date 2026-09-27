/**
 * Deleting a test order on screen (the owner only; migration 0043): who sees
 * the button, the dialog's words, when "Delete test order" can be pressed, a
 * refusal shown in its own words, the toast after, and the owner's list of
 * deleted test orders. Static renders (react-dom/server) with made-up
 * figures; nothing calls the till.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { DeletedTestsPage, TestDeletePreview } from '@cheeseoclock/shared-types';
import { DeleteTestOrderForm, type DeleteTestOrderFormProps } from './DeleteTestOrderDialog';
import { DeletedTestOrdersPanel, NO_DELETED_TESTS, deletedTestsTitle } from './DeletedTestOrdersPanel';
import {
  deletedPaidWords,
  deletedStockWords,
  mayDeleteTestOrder,
  testDeleteAlsoLines,
  testDeleteCashLines,
  testDeleteMissing,
  testDeletePaidLine,
  testDeleteStockLine,
  testDeleteToast,
} from './testDeleteCopy';

const PREVIEW: TestDeletePreview = {
  orderId: 'o1',
  orderNumber: '20260927-0042',
  status: 'preparing',
  mode: 'takeaway',
  totalCents: 125_000,
  takenAt: '2026-09-27T10:00:00.000Z',
  takenBy: 'Test Cashier',
  items: [{ name: 'Test Pizza', quantity: 1 }],
  paid: [{ method: 'cash', netCents: 125_000 }],
  refusal: null,
  stock: {
    state: 'holds',
    lines: [{ ingredientId: 'i1', name: 'Test Cheese', unit: 'g', qty: 90, estCostCents: 10_800, drink: false, note: null }],
  },
  cash: [{ shiftId: 's1', open: true, netCents: 125_000 }],
  kitchenSlip: true,
  web: false,
};

function form(over: Partial<DeleteTestOrderFormProps> = {}): string {
  const props: DeleteTestOrderFormProps = {
    orderNumber: PREVIEW.orderNumber,
    preview: PREVIEW,
    loading: false,
    loadError: null,
    restock: null,
    onRestock: () => {},
    reason: '',
    onReason: () => {},
    secret: '',
    onSecret: () => {},
    pending: false,
    onSubmit: () => {},
    onClose: () => {},
    ...over,
  };
  return renderToStaticMarkup(<DeleteTestOrderForm {...props} />);
}
/** The Delete button's tag. */
const deleteButton = (html: string) => /<button[^>]*type="submit"[^>]*>[^<]*<\/button>/.exec(html)?.[0] ?? '';

describe('who is offered "Delete test order…"', () => {
  it('the owner (admin) login only, and never for a cart still being rung up', () => {
    expect(mayDeleteTestOrder('admin', 'paid')).toBe(true);
    expect(mayDeleteTestOrder('admin', 'preparing')).toBe(true);
    expect(mayDeleteTestOrder('admin', 'void')).toBe(true);
    expect(mayDeleteTestOrder('admin', 'open')).toBe(false);
    expect(mayDeleteTestOrder('manager', 'paid')).toBe(false);
    expect(mayDeleteTestOrder('cashier', 'paid')).toBe(false);
    expect(mayDeleteTestOrder(null, 'paid')).toBe(false);
    expect(mayDeleteTestOrder('admin', undefined)).toBe(false);
  });
});

describe('the dialog', () => {
  it('asks "Put the stock back?" with nothing picked, says what happens to the cash, and stays greyed out until everything is filled in', () => {
    const html = form();
    expect(html).toContain('Delete test order #0042');
    expect(html).toContain('Only for orders made to test the till.');
    expect(html).toContain('A real order? Close this and use Cancel or Refund.');
    expect(html).toContain('Put the stock back?');
    expect(html).toContain('Yes — put it back (the food was not made)');
    expect(html).toContain('No — count it as waste (the food was made)');
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).toContain('Test Cheese 90 g');
    expect(html).toContain('Paid — Cash Rs 1,250');
    expect(html).toContain("This shift’s expected cash goes down by Rs 1,250.");
    expect(html).toContain('The kitchen gets a CANCELLED slip.');
    expect(html).toContain('Printer test');
    expect(html).toContain('Type your owner PIN or password to confirm');
    expect(html).toContain('Keep the order');
    expect(deleteButton(html)).toContain('disabled=""');
    // Answer the stock only: still not ready.
    expect(deleteButton(form({ restock: true }))).toContain('disabled=""');
    expect(deleteButton(form({ restock: true, reason: 'Printer test' }))).toContain('disabled=""');
    // Everything filled in.
    const ready = deleteButton(form({ restock: false, reason: 'Printer test', secret: 'x' }));
    expect(ready).toContain('Delete test order');
    expect(ready).not.toContain('disabled=""');
  });

  it('no stock held: one line instead of the question, and no stock answer is needed', () => {
    const html = form({ preview: { ...PREVIEW, stock: { state: 'returned_before', lines: [] } }, reason: 'Staff training', secret: 'x' });
    expect(html).not.toContain('Put the stock back?');
    expect(html).toContain('Its stock was already put back when it was cancelled.');
    expect(deleteButton(html)).not.toContain('disabled=""');
  });

  it('a refusal is shown in its own words and the form is hidden', () => {
    const html = form({ preview: { ...PREVIEW, refusal: "This sale was sent to FBR, so it can't be deleted. Refund it instead." } });
    expect(html).toContain('role="alert"');
    expect(html).toContain('This sale was sent to FBR, so it can&#x27;t be deleted. Refund it instead.');
    expect(html).not.toContain('Put the stock back?');
    expect(html).not.toContain('Type your owner PIN or password');
    expect(deleteButton(html)).toBe('');
    expect(html).toContain('Keep the order');
    // The order could not be read at all (gone, or not the owner's login).
    expect(form({ preview: null, loadError: "This order is already deleted or can't be found." })).toContain('role="alert"');
  });

  it('never asks with window.confirm, alert or prompt', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const f of ['DeleteTestOrderDialog.tsx', 'DeletedTestOrdersPanel.tsx', 'OrderDetailDrawer.tsx', 'OrderHistoryPage.tsx', 'testDeleteCopy.ts']) {
      const src = readFileSync(join(here, f), 'utf8');
      expect({ f, native: /\b(window\.)?(confirm|alert|prompt)\(/.test(src) }).toEqual({ f, native: false });
    }
  });
});

describe("the dialog's words", () => {
  it('cash per shift: open lowers the expected cash, closed is noted in Reports; other methods come off their total', () => {
    expect(
      testDeleteCashLines({
        cash: [
          { shiftId: 's1', open: true, netCents: 125_000 },
          { shiftId: 's0', open: false, netCents: 30_000 },
        ],
        paid: [
          { method: 'cash', netCents: 155_000 },
          { method: 'card', netCents: 50_000 },
        ],
      }),
    ).toEqual([
      'This shift’s expected cash goes down by Rs 1,250. If no real money went into the drawer for this test, the count will now match. If real money did go in, take it out.',
      'The shift that took this money is already closed. Its saved count and short/over do not change; Reports will note Rs 300 of deleted test orders on that shift.',
      'Card Rs 500 comes off the card total.',
    ]);
    expect(testDeleteCashLines({ cash: [], paid: [] })).toEqual(['No money is left on this order, so no cash or card total changes.']);
    expect(testDeleteAlsoLines({ kitchenSlip: false, web: true })).toEqual(['The website will show the order as cancelled.']);
  });

  it('a foodpanda order (Settings → foodpanda, 0.7.22): paid through foodpanda, no drawer cash — and it leaves foodpanda’s figures on Channels', () => {
    // As the main process previews one (foodpanda-test-orders.db.test.ts): foodpanda's payment, no cash of any shift.
    const foodpanda: Pick<TestDeletePreview, 'cash' | 'paid'> = { cash: [], paid: [{ method: 'foodpanda', netCents: 185_600 }] };
    expect(testDeletePaidLine(foodpanda.paid)).toBe('Paid — Foodpanda Rs 1,856');
    expect(testDeleteCashLines(foodpanda)).toEqual([
      'Foodpanda Rs 1,856 comes off the foodpanda total, and the order leaves foodpanda’s figures on Reports → Channels (what foodpanda keeps, the payout expected, the orders to check). No cash went into the drawer for it.',
    ]);
    // Nothing in the dialog tells the owner to take cash out of the drawer, nor that a shift's expected cash moves.
    const html = form({ preview: { ...PREVIEW, mode: 'foodpanda', totalCents: 185_600, ...foodpanda } });
    expect(html).toContain('Paid — Foodpanda Rs 1,856');
    expect(html).toContain('No cash went into the drawer for it.');
    expect(html).not.toMatch(/expected cash|take it out/);
    // The toast after: no word of the shift's cash either.
    expect(testDeleteToast({ orderNumber: '20260927-0044', deleteStock: 'none', cash: foodpanda.cash })).toBe('Order #0044 deleted as a test order.');
  });

  it('stock, paid, what is missing, and the toast', () => {
    expect(testDeleteStockLine('none')).toBe('This order took no stock.');
    expect(testDeleteStockLine('wasted_before')).toBe('Its food was already counted as waste when it was cancelled.');
    expect(testDeleteStockLine('holds')).toBeNull();
    expect(testDeletePaidLine([])).toBe('Not paid');
    expect(testDeleteMissing({ holdsStock: true, restock: null, reason: 'x', secret: 'x' })).toBe('Choose whether to put the stock back.');
    expect(testDeleteMissing({ holdsStock: false, restock: null, reason: ' ', secret: 'x' })).toBe('Write why this was a test order.');
    expect(testDeleteMissing({ holdsStock: false, restock: null, reason: 'x', secret: '' })).toBe('Type your owner PIN or password.');
    expect(testDeleteMissing({ holdsStock: true, restock: false, reason: 'x', secret: 'x' })).toBeNull();
    expect(
      testDeleteToast({ orderNumber: '20260927-0042', deleteStock: 'put_back', cash: [{ shiftId: 's1', open: true, netCents: 125_000 }] }),
    ).toBe('Order #0042 deleted as a test order. Stock put back. This shift’s expected cash is now Rs 1,250 lower.');
    expect(testDeleteToast({ orderNumber: '20260927-0043', deleteStock: 'waste', cash: [{ shiftId: 's0', open: false, netCents: 1_000 }] })).toBe(
      'Order #0043 deleted as a test order. Its food is counted as waste.',
    );
  });
});

describe("the owner's list of deleted test orders", () => {
  const PAGE: DeletedTestsPage = {
    total: 2,
    totalCents: 250_000,
    rows: [
      {
        orderId: 'o2',
        orderNumber: '20260927-0043',
        mode: 'takeaway',
        status: 'paid',
        totalCents: 125_000,
        takenAt: '2026-09-27T10:00:00.000Z',
        takenBy: 'Test Cashier',
        deletedAt: '2026-09-27T11:00:00.000Z',
        deletedBy: 'Test Owner',
        reason: 'Staff training',
        paidCents: 125_000,
        paidMethods: ['cash'],
        deleteStock: 'waste',
        wasteCents: 18_000,
        itemsSummary: '1× Test Pizza',
      },
      {
        orderId: 'o1',
        orderNumber: '20260927-0042',
        mode: 'takeaway',
        status: 'void',
        totalCents: 125_000,
        takenAt: '2026-09-27T09:00:00.000Z',
        takenBy: 'Test Cashier',
        deletedAt: '2026-09-27T10:30:00.000Z',
        deletedBy: 'Test Owner',
        reason: 'Printer test',
        paidCents: 0,
        paidMethods: [],
        deleteStock: 'settled_before',
        wasteCents: 0,
        itemsSummary: '1× Test Pizza',
      },
    ],
  };
  const render = (page: DeletedTestsPage | undefined, node: ReactNode) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    if (page) qc.setQueryData(['orders', 'deletedTests', 'A', 'B'], page);
    return renderToStaticMarkup(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
  };

  it('each row: the order and its items, taken, deleted, why, total, paid and what happened to its stock', () => {
    const html = render(PAGE, <DeletedTestOrdersPanel sinceIso="A" untilIso="B" />);
    for (const words of ['#0043', '1× Test Pizza', 'by Test Cashier', 'by Test Owner', 'Staff training', 'Rs 1,250', 'Waste Rs 180', 'Dealt with when cancelled', 'Not paid']) {
      expect(html).toContain(words);
    }
    expect(deletedTestsTitle(PAGE)).toBe('Test orders deleted — 2 (Rs 2,500)');
    expect(deletedStockWords({ deleteStock: 'put_back', wasteCents: 0 })).toBe('Put back');
    expect(deletedStockWords({ deleteStock: 'none', wasteCents: 0 })).toBe('No stock');
    expect(deletedPaidWords({ paidCents: 125_000, paidMethods: ['cash', 'card'] })).toBe('Rs 1,250 Cash + Card');
  });

  it('none in the period', () => {
    const html = render({ total: 0, totalCents: 0, rows: [] }, <DeletedTestOrdersPanel sinceIso="A" untilIso="B" />);
    expect(html).toContain(NO_DELETED_TESTS);
  });
});
