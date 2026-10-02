/**
 * "Ticket not printed" on the Live Orders card (v0.7.33), rendered to static
 * markup (react-dom/server, no browser; nothing calls the till): the red
 * strip and its Reprint button show only on a card orders:listActive marked
 * (kitchenTicketNotPrinted), and only while the kitchen still has the order
 * — the same rule as the chef-hat button, which stays. Then the card's clock
 * (v0.7.34): it counts from when the order was sent, and Order History's
 * drawer shows the send as its own step. Every name and amount is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, OrderSnapshot, OrderStatus, UUID } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { OrdersBoardPage } from './OrdersBoardPage';
import { OrderDetailDrawer } from './OrderDetailDrawer';
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

// ---------------------------------------------------------------------------
// The card's clock counts from when the order was sent (the owner, 2 Oct
// 2026: "i placed order at some time and it showed some 30 mint").

/** 8:00 pm in Pakistan (UTC+5) on 1 Oct 2026, the board's "now". */
const NOW = Date.UTC(2026, 9, 1, 15, 0);
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

/** A takeaway in New, started `startedMin` ago and sent `sentMin` ago (null: no send time, an order from before 0.7.34). */
function timed(n: number, startedMin: number, sentMin: number | null): OrderSnapshot {
  const snap = order(n, 'sent_to_kitchen');
  return {
    ...snap,
    order: { ...snap.order, createdAt: minsAgo(startedMin), ...(sentMin === null ? {} : { sentAt: minsAgo(sentMin) }) },
  } as OrderSnapshot;
}

function boardHtml(orders: OrderSnapshot[]): string {
  signIn('cashier');
  return render(<OrdersBoardPage />, [[['orders', 'active', 'all'], orders]]);
}

/** A card's own ring (CARD_RING): the article's class, not its buttons' focus rings. */
const ring = (card: string) => (/^\s*class="([^"]*)"/.exec(card)?.[1] ?? '').split(' ').filter((c) => c.startsWith('ring-'));

/** The age chip of a card: its title and its words. */
function chip(card: string): { title: string; label: string } {
  const m = /<span[^>]*title="([^"]*)"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]*)<\/span>/.exec(card);
  return { title: m?.[1] ?? '', label: m?.[2] ?? '' };
}

describe('the Live Orders clock counts from when the order was sent', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a cart started 31 minutes ago and sent 2 minutes ago: "2m", no late ring, not in the late count', () => {
    const html = boardHtml([timed(61, 31, 2)]);
    const card = cards([timed(61, 31, 2)]).get('#0061')!;
    expect(chip(card).label).toBe('2m');
    expect(chip(card).title).toMatch(/^Sent 7:58\spm · started 7:29\spm$/);
    expect(ring(card)).toContain('ring-stone-200');
    expect(ring(card)).not.toContain('ring-2');
    expect(html).toContain('1 active order');
    expect(html).not.toContain('waiting over');
  });

  it('an order with no send time (before 0.7.34) still counts from when it was started: "31m", red, in the late count', () => {
    const html = boardHtml([timed(61, 31, 2), timed(62, 31, null)]);
    const old = cards([timed(61, 31, 2), timed(62, 31, null)]).get('#0062')!;
    expect(chip(old).label).toBe('31m');
    expect(chip(old).title).toMatch(/^Taken 7:29\spm$/);
    expect(ring(old)).toContain('ring-red-500');
    // Only the old one is late.
    expect(html).toContain('1 waiting over 30 min');
  });

  it('sent within a minute of starting: one time on the chip', () => {
    const quick = timed(63, 5, 5);
    expect(chip(cards([quick]).get('#0063')!).title).toMatch(/^Sent 7:55\spm$/);
  });

  it('cards in a column go in sent order, the one sent longest ago first', () => {
    // Started first but sent last; started last but sent first; an old one in between.
    const board = cards([timed(71, 40, 3), timed(72, 12, 10), timed(73, 6, null)]);
    expect([...board.keys()]).toEqual(['#0072', '#0073', '#0071']);
  });
});

describe('Order History: "Sent" in What happened', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const whatHappened = (snap: OrderSnapshot) => {
    signIn('admin');
    const html = render(<OrderDetailDrawer orderId={snap.order.id} onClose={() => {}} />, [[['orders', 'detail', snap.order.id], snap]]);
    const part = html.split('What happened')[1]?.split('</ol>')[0] ?? '';
    return part.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  };

  it('a step at the send time when it came a minute or more after the start', () => {
    const words = whatHappened(timed(81, 31, 2));
    expect(words).toMatch(/^Taken 7:29\spm · by Test Cashier Sent 7:58\spm$/);
  });

  it('none when it was sent within a minute, or has no send time', () => {
    expect(whatHappened(timed(82, 5, 5))).toMatch(/^Taken 7:55\spm · by Test Cashier$/);
    expect(whatHappened(timed(83, 31, null))).toMatch(/^Taken 7:29\spm · by Test Cashier$/);
  });
});
