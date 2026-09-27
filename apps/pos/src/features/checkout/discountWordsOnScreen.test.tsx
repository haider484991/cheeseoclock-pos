/**
 * The owner, 28 Sep 2026: "Delivery charges is separate we don't want to add
 * discount to it". Every screen that shows a bill says so when an order's
 * discount left its delivery charge alone — the cart, Pay, the receipt after
 * Pay and the order drawer — from the discount's OWN frozen rule (the
 * snapshot's alsoOffDeliveryCharge), and reads exactly as before for a
 * discount that came off the charge too. Static renders (react-dom/server,
 * no browser; nothing calls the till); Radix's dialog is stood in for by
 * plain elements. Every name and amount is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, OrderSnapshot, UUID } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { CartPane } from './CartPane';
import { TenderDialog } from './TenderDialog';
import { ReceiptDialog } from './ReceiptDialog';
import { OrderDetailDrawer } from '../orders/OrderDetailDrawer';

// A server render has no portal: the dialog's parts render in place.
vi.mock('@radix-ui/react-dialog', async () => {
  const React = await import('react');
  const h = React.createElement;
  type P = { children?: ReactNode; className?: string };
  const pass = ({ children }: P) => h(React.Fragment, null, children);
  const tag =
    (t: string, extra: Record<string, string> = {}) =>
    ({ children, className }: P) =>
      h(t, { className, ...extra }, children);
  return {
    Root: pass,
    Portal: pass,
    Overlay: () => null,
    Content: tag('div', { role: 'dialog' }),
    Title: tag('h2'),
    Description: tag('p'),
    Close: pass,
    Trigger: pass,
  };
});

// A server render reads a zustand store's INITIAL state; the till's window reads each as it is now.
vi.mock('zustand', async (importOriginal) => {
  const z = await importOriginal<typeof import('zustand')>();
  type Hook = ((select?: (state: unknown) => unknown) => unknown) & { getState: () => unknown };
  const live = (hook: Hook) =>
    Object.assign((select: (state: unknown) => unknown = (state) => state) => select(hook.getState()), hook);
  const make = (init: unknown) => live(z.create(init as Parameters<typeof z.create>[0]) as unknown as Hook);
  return { ...z, create: (init?: unknown) => (init === undefined ? make : make(init)) };
});

function signIn(role: AuthenticatedUser['role']) {
  useSessionStore.setState({ user: { id: 'u1' as UUID, fullName: 'Test', role, sessionId: 's1' as UUID }, status: 'authenticated' });
}

function render(node: ReactNode, seed: Array<[readonly unknown[], unknown]> = []): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [key, data] of seed) qc.setQueryData(key, data);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ToastProvider>{node}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const text = (markup: string) => decode(markup.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const line = (id: string, name: string, cents: number) => ({
  id,
  orderId: 'o1',
  menuItemId: `m_${id}`,
  menuItemName: name,
  quantity: 1,
  unitPriceCents: cents,
  lineTotalCents: cents,
  taxRateBps: 1_600,
  notes: null,
  modifiers: [],
  kitchenStatus: 'pending',
  createdAt: '2026-09-28T10:00:00.000Z',
});

/**
 * A delivery order: Rs 2,000 of food and a Rs 200 delivery charge, 10% off.
 * `alsoOff` is the discount's frozen rule: false = the food only (Rs 200
 * off), true = the whole bill (Rs 220), undefined = a row with no rule.
 */
function deliveryOrder(status: 'open' | 'paid', alsoOff: boolean | undefined): OrderSnapshot {
  const discountCents = alsoOff === false ? 20_000 : 22_000;
  const taxCents = alsoOff === false ? 32_000 : 31_680;
  const totalCents = 220_000 - discountCents + taxCents;
  return {
    order: {
      id: 'o1',
      orderNumber: '20260928-0007',
      mode: 'delivery',
      status,
      source: 'pos',
      notes: null,
      cashierId: 'u1',
      tableId: null,
      subtotalCents: 220_000,
      discountCents,
      taxCents,
      totalCents,
      createdAt: '2026-09-28T10:00:00.000Z',
      paidAt: status === 'paid' ? '2026-09-28T10:20:00.000Z' : null,
      dispatchedAt: null,
    },
    items: [line('l1', 'Test Pizza', 100_000), line('l2', 'Delivery Charge (Rs 200)', 20_000), line('l3', 'Test Side', 100_000)],
    discounts: [
      {
        id: 'd1',
        orderId: 'o1',
        discountType: 'percent',
        value: 10,
        reason: 'Staff',
        appliedByUserId: 'u1',
        approvedByUserId: null,
        amountCents: discountCents,
        source: null,
        foodpanda: null,
        ...(alsoOff === undefined ? {} : { alsoOffDeliveryCharge: alsoOff }),
      },
    ],
    payments:
      status === 'paid'
        ? [{ id: 'p1', orderId: 'o1', method: 'cash', amountCents: totalCents, tenderedCents: totalCents, referenceNo: null, receivedByUserId: 'u1', paidAt: '2026-09-28T10:20:00.000Z' }]
        : [],
    cashierName: 'Test Cashier',
    tableLabel: null,
    customerName: 'Test Customer',
    customerPhone: '03001234567',
    deliveryAddress: 'House 1, Test Street',
    deliveryNotes: null,
    rider: null,
  } as unknown as OrderSnapshot;
}

const noop = () => {};

describe('a discount that left the delivery charge alone says "food only" on every bill screen', () => {
  it('the cart', () => {
    signIn('cashier');
    useCheckoutStore.setState({ snapshot: deliveryOrder('open', false), busy: false });
    const words = text(
      render(
        <CartPane
          step="items"
          onContinue={noop}
          onBack={noop}
          onPay={noop}
          onDiscount={noop}
          onRemoveDeal={noop}
          onSendToKitchen={noop}
          onCustomize={noop}
        />,
      ),
    );
    expect(words).toContain('Discount · 10% off food · Staff');
  });

  it('Pay', () => {
    signIn('cashier');
    const snapshot = deliveryOrder('open', false);
    useCheckoutStore.setState({ snapshot, busy: false });
    expect(text(render(<TenderDialog snapshot={snapshot} onClose={noop} onPaid={noop} />))).toContain('Discount (food only)');
  });

  it('the receipt after Pay: "Discount (Staff, food only)" under a Rs 2,200 subtotal', () => {
    signIn('cashier');
    const words = text(render(<ReceiptDialog snapshot={deliveryOrder('paid', false)} onClose={noop} />));
    expect(words).toContain('Discount (Staff, food only)');
    expect(words).toContain('Subtotal 2,200 Discount (Staff, food only) −200 Tax 320 Total Rs 2,320');
  });

  it('the order drawer', () => {
    signIn('admin');
    const snapshot = deliveryOrder('paid', false);
    const words = text(render(<OrderDetailDrawer orderId="o1" onClose={noop} />, [[['orders', 'detail', 'o1'], snapshot]]));
    expect(words).toContain('Discount (Staff, food only)');
  });
});

describe('a discount that came off the delivery charge too (or given before the rule) reads exactly as before', () => {
  for (const alsoOff of [true, undefined]) {
    it(`frozen rule ${String(alsoOff)}: no "food only" anywhere`, () => {
      signIn('admin');
      const open = deliveryOrder('open', alsoOff);
      useCheckoutStore.setState({ snapshot: open, busy: false });
      const cart = text(
        render(
          <CartPane
            step="items"
            onContinue={noop}
            onBack={noop}
            onPay={noop}
            onDiscount={noop}
            onRemoveDeal={noop}
            onSendToKitchen={noop}
            onCustomize={noop}
          />,
        ),
      );
      expect(cart).toContain('Discount · 10% · Staff');
      const pay = text(render(<TenderDialog snapshot={open} onClose={noop} onPaid={noop} />));
      const paid = deliveryOrder('paid', alsoOff);
      const receipt = text(render(<ReceiptDialog snapshot={paid} onClose={noop} />));
      expect(receipt).toContain('Discount (Staff)');
      const drawer = text(render(<OrderDetailDrawer orderId="o1" onClose={noop} />, [[['orders', 'detail', 'o1'], paid]]));
      expect(drawer).toContain('Discount (Staff)');
      for (const words of [cart, pay, receipt, drawer]) expect(words).not.toContain('food only');
    });
  }
});
