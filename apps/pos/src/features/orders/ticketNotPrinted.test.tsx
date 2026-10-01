/**
 * "Ticket not printed" on the Live Orders card (v0.7.33), rendered to static
 * markup (react-dom/server, no browser; nothing calls the till): the red
 * strip and its Reprint button show only on a card orders:listActive marked
 * (kitchenTicketNotPrinted), and only while the kitchen still has the order
 * — the same rule as the chef-hat button, which stays. Every name and amount
 * is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, OrderSnapshot, OrderStatus, UUID } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { OrdersBoardPage } from './OrdersBoardPage';
import { TICKET_NOT_PRINTED_TEXT, TICKET_REPRINT_LABEL, TicketNotPrinted } from './OrderBadges';

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

/** A takeaway on the board (made-up), marked or not. */
function order(n: number, status: OrderStatus, notPrinted?: boolean): OrderSnapshot {
  return {
    order: {
      id: `o${n}`,
      orderNumber: `20261001-00${n}`,
      mode: 'takeaway',
      status,
      source: 'pos',
      notes: null,
      totalCents: 150_000,
      createdAt: new Date().toISOString(),
      paidAt: null,
      dispatchedAt: null,
    },
    items: [],
    discounts: [],
    payments: [],
    cashierName: 'Test Cashier',
    tableLabel: null,
    customerName: null,
    customerPhone: null,
    deliveryAddress: null,
    deliveryNotes: null,
    rider: null,
    ...(notPrinted === undefined ? {} : { kitchenTicketNotPrinted: notPrinted }),
  } as unknown as OrderSnapshot;
}

/** Each card's markup, by its short number ("#0042"). */
function cards(orders: OrderSnapshot[]): Map<string, string> {
  signIn('cashier');
  const html = render(<OrdersBoardPage />, [[['orders', 'active', 'all'], orders]]);
  const out = new Map<string, string>();
  for (const part of html.split('<article').slice(1)) {
    const num = /#(\d{4})/.exec(part)?.[1];
    if (num) out.set(`#${num}`, part.split('</article>')[0]!);
  }
  return out;
}

const reprintButtons = (card: string) => card.split(`aria-label="${TICKET_REPRINT_LABEL}"`).length - 1;

describe('"Ticket not printed" on the Live Orders card', () => {
  it('the strip and its Reprint button, only on the marked card', () => {
    const board = cards([order(41, 'sent_to_kitchen'), order(42, 'sent_to_kitchen', true), order(43, 'preparing', false)]);
    expect([...board.keys()]).toEqual(['#0041', '#0042', '#0043']);
    const marked = board.get('#0042')!;
    expect(marked).toContain(TICKET_NOT_PRINTED_TEXT);
    expect(marked).toMatch(/<button[^>]*aria-label="Reprint kitchen ticket"[^>]*>Reprint<\/button>/);
    // The chef-hat button stays beside it.
    expect(reprintButtons(marked)).toBe(2);
    for (const k of ['#0041', '#0043']) {
      expect(board.get(k)).not.toContain(TICKET_NOT_PRINTED_TEXT);
      expect(reprintButtons(board.get(k)!)).toBe(1);
    }
  });

  it('marked while preparing or ready too; never once the kitchen is done with it', () => {
    const board = cards([
      order(51, 'preparing', true),
      order(52, 'ready', true),
      order(53, 'out_for_delivery', true),
    ]);
    expect(board.get('#0051')).toContain(TICKET_NOT_PRINTED_TEXT);
    expect(board.get('#0052')).toContain(TICKET_NOT_PRINTED_TEXT);
    // Out with the rider: the till refuses that ticket, so neither the strip nor the chef hat shows.
    expect(board.get('#0053')).not.toContain(TICKET_NOT_PRINTED_TEXT);
    expect(reprintButtons(board.get('#0053')!)).toBe(0);
  });

  it('the strip on its own: the words and one button that does not submit anything', () => {
    const html = renderToStaticMarkup(<TicketNotPrinted onReprint={() => {}} />);
    expect(html).toContain('>Ticket not printed<');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="Reprint kitchen ticket"');
    expect(html).toContain('bg-red-50');
  });
});
