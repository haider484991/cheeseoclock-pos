/**
 * The receipt after Pay says the time exactly as the paper does: Pakistan
 * time, day first ("14/09/2026 19:35"), whatever the PC's own zone — not the
 * Windows locale and zone ("9/14/2026, 2:35:00 PM"). Static renders
 * (react-dom/server, no browser; nothing calls the till); Radix's dialog is
 * stood in for by plain elements. Every name and amount is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrderSnapshot } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { ReceiptDialog } from './ReceiptDialog';

// A server render has no portal: the dialog's parts render in place.
vi.mock('@radix-ui/react-dialog', async () => {
  const React = await import('react');
  const h = React.createElement;
  type P = { children?: ReactNode; className?: string };
  const pass = ({ children }: P) => h(React.Fragment, null, children);
  const tag =
    (t: string) =>
    ({ children, className }: P) =>
      h(t, { className }, children);
  return {
    Root: pass,
    Portal: pass,
    Overlay: () => null,
    Content: tag('div'),
    Title: tag('h2'),
    Description: tag('p'),
    Close: pass,
    Trigger: pass,
  };
});

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function render(snapshot: OrderSnapshot): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return text(
    renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <ReceiptDialog snapshot={snapshot} onClose={() => {}} />
        </ToastProvider>
      </QueryClientProvider>,
    ),
  );
}

/** A takeaway paid in cash at 14:35 UTC on 14 Sep 2026 — 19:35 in Pakistan. */
function paidTakeaway(): OrderSnapshot {
  return {
    order: {
      id: 'o1',
      orderNumber: '20260914-0042',
      mode: 'takeaway',
      status: 'paid',
      source: 'pos',
      notes: null,
      cashierId: 'u1',
      tableId: null,
      subtotalCents: 100_000,
      discountCents: 0,
      taxCents: 16_000,
      totalCents: 116_000,
      createdAt: '2026-09-14T14:20:00.000Z',
      paidAt: '2026-09-14T14:35:00.000Z',
      dispatchedAt: null,
    },
    items: [
      {
        id: 'l1',
        orderId: 'o1',
        menuItemId: 'm1',
        menuItemName: 'Test Pizza',
        quantity: 1,
        unitPriceCents: 100_000,
        lineTotalCents: 100_000,
        taxRateBps: 1_600,
        notes: null,
        modifiers: [],
        kitchenStatus: 'pending',
        createdAt: '2026-09-14T14:20:00.000Z',
      },
    ],
    discounts: [],
    payments: [
      { id: 'p1', orderId: 'o1', method: 'cash', amountCents: 116_000, tenderedCents: 116_000, referenceNo: null, receivedByUserId: 'u1', paidAt: '2026-09-14T14:35:00.000Z' },
    ],
    cashierName: 'Test Cashier',
    tableLabel: null,
    customerName: null,
    customerPhone: null,
    deliveryAddress: null,
    deliveryNotes: null,
    rider: null,
  } as unknown as OrderSnapshot;
}

describe('the receipt after Pay shows the paper’s time', () => {
  for (const zone of ['UTC', 'America/New_York', 'Asia/Karachi']) {
    it(`with the PC's zone set to ${zone}: 14/09/2026 19:35, Pakistan time`, () => {
      process.env.TZ = zone;
      const words = render(paidTakeaway());
      expect(words).toContain('14/09/2026 19:35 Cashier: Test Cashier · Takeaway');
      // Not the Windows locale's own words ("9/14/2026, 2:35:00 PM").
      expect(words).not.toMatch(/\d:\d\d:\d\d/);
    });
  }
});

/**
 * An unpaid bill on screen: the paper's own time line (receipt-renderer
 * appendSaleBody), paidAt ?? sentAt ?? createdAt. A cart started at 19:00
 * and sent at 19:30 Pakistan time reads 19:30, not the PC's clock now.
 */
function unpaidSent(sentAt: string | null): OrderSnapshot {
  const s = paidTakeaway();
  return {
    ...s,
    order: {
      ...s.order,
      status: 'sent_to_kitchen',
      createdAt: '2026-09-14T14:00:00.000Z',
      paidAt: null,
      ...(sentAt === null ? {} : { sentAt }),
    },
    payments: [],
  } as OrderSnapshot;
}

describe('an unpaid bill on screen shows the same time as its paper (v0.7.34)', () => {
  it('started 19:00, sent 19:30 (Pakistan): 14/09/2026 19:30 with the PC set to UTC', () => {
    process.env.TZ = 'UTC';
    const words = render(unpaidSent('2026-09-14T14:30:00.000Z'));
    expect(words).toContain('14/09/2026 19:30 Cashier: Test Cashier · Takeaway');
    expect(words).not.toContain('14/09/2026 19:00');
  });

  it('no send time (an order from before 0.7.34): when it was started', () => {
    process.env.TZ = 'UTC';
    expect(render(unpaidSent(null))).toContain('14/09/2026 19:00 Cashier: Test Cashier · Takeaway');
  });

  it('a paid one still shows when it was paid', () => {
    process.env.TZ = 'UTC';
    const paid = paidTakeaway();
    const words = render({ ...paid, order: { ...paid.order, sentAt: '2026-09-14T14:30:00.000Z' } } as OrderSnapshot);
    expect(words).toContain('14/09/2026 19:35 Cashier: Test Cashier · Takeaway');
  });
});
