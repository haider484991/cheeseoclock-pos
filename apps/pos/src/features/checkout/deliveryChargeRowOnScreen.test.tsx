/**
 * The delivery-charge row under the area on the customer panel (owner,
 * 28 Sep 2026: "if delivery area selected the delivery fee should be
 * automatically added"). The main process puts the charge on with the area
 * on every path; this row only SHOWS what the bill carries, with "Take it
 * off" / "Put it back". Rendered to static markup (react-dom/server, no
 * browser, nothing calls the till): the charge on the bill with "Take it
 * off"; before the till has answered, the fee without "taken off by hand"
 * (never a wrong claim during the moment it takes); an area not on the list
 * says the till adds no charge and takes the old one off. Made-up figures.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DELIVERY_ZONES, type OrderSnapshot } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { CustomerInlinePanel, makeEmptyCustomerForm } from './CustomerInlinePanel';

// A server render reads a zustand store's INITIAL state; the till's window reads each as it is now.
vi.mock('zustand', async (importOriginal) => {
  const z = await importOriginal<typeof import('zustand')>();
  type Hook = ((select?: (state: unknown) => unknown) => unknown) & { getState: () => unknown };
  const live = (hook: Hook) =>
    Object.assign((select: (state: unknown) => unknown = (state) => state) => select(hook.getState()), hook);
  const make = (init: unknown) => live(z.create(init as Parameters<typeof z.create>[0]) as unknown as Hook);
  return { ...z, create: (init?: unknown) => (init === undefined ? make : make(init)) };
});

const MENU = [
  { id: 'fee-200', name: 'Delivery Charge (Rs 200)', basePriceCents: 20_000, isActive: true, categoryId: 'c-fees' },
  { id: 'fee-250', name: 'Delivery Charge (Rs 250)', basePriceCents: 25_000, isActive: true, categoryId: 'c-fees' },
  { id: 'fee-300', name: 'Delivery Charge (Rs 300)', basePriceCents: 30_000, isActive: true, categoryId: 'c-fees' },
];

/** The areas the till has (Settings → Delivery areas); the released ones unless a test raises a fee. */
let rules: unknown = undefined;
function render(node: ReactNode): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['menu', 'items', { categoryId: null, activeOnly: true }], MENU);
  if (rules !== undefined) qc.setQueryData(['checkout-rules'], rules);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ToastProvider>{node}</ToastProvider>
    </QueryClientProvider>,
  );
}
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const text = (markup: string) => decode(markup.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function order(lines: Array<[string, number]>): OrderSnapshot {
  return {
    order: { id: 'o1', status: 'open', mode: 'delivery', source: 'pos', tableId: null },
    items: lines.map(([name, cents], i) => ({
      id: `l${i}`,
      orderId: 'o1',
      menuItemId: name.startsWith('Delivery') ? `fee-${cents / 100}` : 'm_pizza',
      menuItemName: name,
      quantity: 1,
      unitPriceCents: cents,
      lineTotalCents: cents,
      taxRateBps: 1_600,
      notes: null,
      modifiers: [],
      kitchenStatus: 'pending',
      createdAt: '2026-09-28T10:00:00.000Z',
    })),
    discounts: [],
    payments: [],
  } as unknown as OrderSnapshot;
}
const panel = (area: string) =>
  render(<CustomerInlinePanel mode="delivery" form={{ ...makeEmptyCustomerForm(), area }} setForm={() => {}} />);

afterEach(() => {
  useCheckoutStore.setState({ snapshot: null, mode: 'takeaway' });
  rules = undefined;
});

describe('the delivery-charge row only shows what the bill carries', () => {
  it('the area’s charge on the bill: says so, with “Take it off”', () => {
    useCheckoutStore.setState({ mode: 'delivery', snapshot: order([['Test Pizza', 100_000], ['Delivery Charge (Rs 200)', 20_000]]) });
    const t = text(panel('DHA Phase 6'));
    expect(t).toContain('Rs 200 delivery charge is on the bill');
    expect(t).toContain('Take it off');
    expect(t).not.toContain('Put it back');
  });

  it('not on the bill before the till has answered: the fee, never “taken off by hand”, no button yet', () => {
    useCheckoutStore.setState({ mode: 'delivery', snapshot: order([['Test Pizza', 100_000]]) });
    const t = text(panel('DHA Phase 8'));
    expect(t).toContain('Delivery to this area is Rs 250');
    expect(t).not.toContain('taken off by hand');
    expect(t).not.toContain('Put it back');
  });

  it('an area not on the list: the till adds no charge and takes the old area’s off — in words', () => {
    useCheckoutStore.setState({ mode: 'delivery', snapshot: order([['Test Pizza', 100_000]]) });
    expect(text(panel('Gulshan Block 13'))).toContain(
      'Not one of the delivery areas (Settings → Delivery areas): the till adds no delivery charge, and takes off the one it added for the area before. Add one by hand if you deliver there.',
    );
  });

  // Review of 865657b: with a charge at ANOTHER fee on the bill the row said "Delivery to this area
  // is Rs 300 — not on the bill (taken off by hand)" and "Put it back", while Rs 250 WAS on the bill.
  it('a fee raised while the order is open: the bill’s Rs 250 and the area’s Rs 300, with a one-tap swap — never “taken off by hand”', () => {
    rules = {
      delivery: {
        zones: DEFAULT_DELIVERY_ZONES.zones.map((z) => (z.id === 'dha-8' ? { ...z, feeCents: 30_000, feeItemId: 'fee-300' } : z)),
      },
    };
    useCheckoutStore.setState({ mode: 'delivery', snapshot: order([['Test Pizza', 100_000], ['Delivery Charge (Rs 250)', 25_000]]) });
    const t = text(panel('DHA Phase 8'));
    expect(t).toContain('The bill has a Rs 250 delivery charge — this area is now Rs 300');
    expect(t).toContain('Change to Rs 300');
    expect(t).not.toContain('taken off by hand');
    expect(t).not.toContain('Put it back');
    expect(t).not.toContain('is on the bill');
  });

  it('another charge tapped on by hand: the same words and swap', () => {
    useCheckoutStore.setState({ mode: 'delivery', snapshot: order([['Test Pizza', 100_000], ['Delivery Charge (Rs 200)', 20_000]]) });
    const t = text(panel('DHA Phase 8'));
    expect(t).toContain('The bill has a Rs 200 delivery charge — this area is now Rs 250');
    expect(t).toContain('Change to Rs 250');
    expect(t).not.toContain('taken off by hand');
  });

  it('the area’s charge and another on the bill: never just “on the bill” — says both, and keeps only the area’s in one tap', () => {
    useCheckoutStore.setState({
      mode: 'delivery',
      snapshot: order([['Test Pizza', 100_000], ['Delivery Charge (Rs 200)', 20_000], ['Delivery Charge (Rs 250)', 25_000]]),
    });
    const t = text(panel('DHA Phase 8'));
    expect(t).toContain('The bill has a Rs 200 delivery charge as well as this area’s Rs 250 — check it');
    expect(t).toContain('Keep only Rs 250');
    expect(t).not.toContain('Rs 250 delivery charge is on the bill');
  });
});
