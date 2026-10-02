/**
 * Send out on screen (v0.7.34, step 16-3; the owner, 2 Oct 2026: "Ready
 * delivery -> Send out ... Assign rider optional, smaller, for own riders";
 * "Third-party rider keeps the delivery charge"). Rendered to static markup
 * (react-dom/server, no browser). The till's IPC is a stand-in that records
 * each call; the toasts are recorded too; a button's tap is its own onClick,
 * kept as it was rendered. Every name, number and amount is made up.
 *
 *  - A Ready delivery card: the big "Send out" button (truck), and the small
 *    "Assign rider" link with its title. Tapping Send out asks the till once,
 *    with no success toast (the card moving is the feedback); a refusal
 *    shows "Could not send out" with the till's own words.
 *  - An Out card sent out with an outside rider: "Outside rider · out 12m ·
 *    keeps Rs 200" (or "· no delivery charge"), with an "Assign rider" link.
 *  - An own rider's Out card and a Ready takeaway card: byte-identical to the
 *    cards of the build before this step.
 *  - Assign rider on a sent-out order: the description says so, and "Back to
 *    Ready" (its title points to the cancel) toasts "Order #0047 is back in
 *    Ready".
 *  - Order History: the panel's chip and "Sent out (outside rider)" step, and
 *    the row's "Rider: outside".
 */
import { createHash } from 'node:crypto';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, OrderHistoryPage as HistoryPage, OrderHistoryRow, OrderSnapshot, OrderStatus, UUID } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { OrdersBoardPage } from './OrdersBoardPage';
import { AssignRiderDialog, BACK_TO_READY_TITLE } from './AssignRiderDialog';
import { OrderDetailDrawer } from './OrderDetailDrawer';
import { OrderHistoryPage } from './OrderHistoryPage';
import { ASSIGN_RIDER_LINK_TITLE } from './boardLogic';
import { HISTORY_PAGE_SIZE, historyRange } from './historyFilters';

// A server render reads a zustand store's INITIAL state; the till's window reads each as it is now.
vi.mock('zustand', async (importOriginal) => {
  const z = await importOriginal<typeof import('zustand')>();
  type Hook = ((select?: (state: unknown) => unknown) => unknown) & { getState: () => unknown };
  const live = (hook: Hook) =>
    Object.assign((select: (state: unknown) => unknown = (state) => state) => select(hook.getState()), hook);
  const make = (init: unknown) => live(z.create(init as Parameters<typeof z.create>[0]) as unknown as Hook);
  return { ...z, create: (init?: unknown) => (init === undefined ? make : make(init)) };
});

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

/** What the screens asked of the till, what they toasted, and each Button as rendered (its words, title and tap). */
const seen = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  toasts: [] as Array<{ title: string; description?: string; variant?: string }>,
  buttons: [] as Array<{ words: string; title: string | undefined; tap: (() => void) | undefined }>,
  /** The till's answer to Send out / Back to Ready: its snapshot, or a refusal in its own words. */
  refuse: null as string | null,
}));

vi.mock('../../components/toast/ToastProvider', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../components/toast/ToastProvider')>();
  const toast = (t: { title: string; description?: string; variant?: string }) => {
    seen.toasts.push(t);
  };
  return { ...real, useToast: () => ({ toast }) };
});

vi.mock('@cheeseoclock/ui', async (importOriginal) => {
  const ui = await importOriginal<typeof import('@cheeseoclock/ui')>();
  const React = await import('react');
  const words = (n: unknown): string =>
    typeof n === 'string' || typeof n === 'number'
      ? String(n)
      : Array.isArray(n)
        ? n.map(words).join('')
        : React.isValidElement(n)
          ? words((n.props as { children?: unknown }).children)
          : '';
  type Props = React.ComponentProps<typeof ui.Button>;
  const Button = React.forwardRef<HTMLButtonElement, Props>(function Button(props, ref) {
    const onClick = props.onClick;
    seen.buttons.push({
      words: words(props.children).trim(),
      title: props.title,
      tap: onClick ? () => onClick({ preventDefault() {}, stopPropagation() {} } as never) : undefined,
    });
    return React.createElement(ui.Button, { ...props, ref });
  });
  return { ...ui, Button };
});

vi.mock('../../ipc/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../ipc/client')>();
  const answer = (name: string) => async (arg: unknown) => {
    seen.calls.push([name, arg]);
    if (seen.refuse) throw new Error(seen.refuse);
    return {} as OrderSnapshot;
  };
  return {
    ...real,
    ipc: {
      ...real.ipc,
      orders: { ...real.ipc.orders, sendOut: answer('orders.sendOut'), unassignRider: answer('orders.unassignRider') },
    },
  };
});

function signIn(role: AuthenticatedUser['role']) {
  useSessionStore.setState({ user: { id: 'u1' as UUID, fullName: 'Test', role, sessionId: 's1' as UUID }, status: 'authenticated' });
}

function render(node: ReactNode, seed: Array<[readonly unknown[], unknown]> = []): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [key, data] of seed) qc.setQueryData(key, data);
  seen.buttons.length = 0;
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ToastProvider>{node}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Taps the last-rendered Button with exactly these words. */
function tap(words: string): void {
  const hit = seen.buttons.filter((b) => b.words === words).pop();
  if (!hit?.tap) throw new Error(`No button "${words}" (saw: ${seen.buttons.map((b) => b.words).join(' | ')})`);
  hit.tap();
}

/** Lets the tapped mutation run to the end (its till call, then its toasts). */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const text = (markup: string) => decode(markup.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
/** Node's ICU may write the space before am/pm as U+202F. */
const plainSpaces = (s: string) => s.replace(/ /g, ' ');
const sha256 = (s: string) => createHash('sha256').update(plainSpaces(s), 'utf8').digest('hex');

/** 8:00 pm in Pakistan (UTC+5) on 1 Oct 2026, the screens' "now". */
const NOW = Date.UTC(2026, 9, 1, 15, 0);
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const OWN_RIDER = { id: 'r1' as UUID, name: 'Test Rider', phone: '03000000001' };

/**
 * A made-up delivery: Test Family Pizza and 'Delivery Charge (Rs 200)',
 * started 40 minutes ago, sent 38 minutes ago, out 12 minutes ago when out.
 */
function delivery(
  n: number,
  status: OrderStatus,
  over: Partial<OrderSnapshot['order']> = {},
  rider: OrderSnapshot['rider'] = null,
  mode: OrderSnapshot['order']['mode'] = 'delivery',
): OrderSnapshot {
  return {
    order: {
      id: `o${n}`,
      orderNumber: `20261001-00${n}`,
      mode,
      status,
      source: 'pos',
      notes: null,
      subtotalCents: 410_000,
      discountCents: 0,
      taxCents: 3_000,
      totalCents: 413_000,
      createdAt: minsAgo(40),
      sentAt: minsAgo(38),
      paidAt: null,
      voidedAt: null,
      voidReason: null,
      assignedRiderId: rider?.id ?? null,
      dispatchedAt: status === 'out_for_delivery' ? minsAgo(12) : null,
      deliveredAt: null,
      ...over,
    },
    items: [
      { id: `i${n}a`, parentOrderItemId: null, quantity: 1, menuItemName: 'Test Family Pizza', modifiers: [], notes: null, lineTotalCents: 390_000 },
      { id: `i${n}b`, parentOrderItemId: null, quantity: 1, menuItemName: 'Delivery Charge (Rs 200)', modifiers: [], notes: null, lineTotalCents: 20_000 },
    ],
    discounts: [],
    payments: [],
    cashierName: 'Test Cashier',
    tableLabel: null,
    customerName: 'Test Customer',
    customerPhone: '03001234567',
    deliveryAddress: 'House 1, Made-up Street',
    deliveryNotes: null,
    rider,
  } as unknown as OrderSnapshot;
}

/** Sent out with an outside rider 12 minutes ago, keeping `keep` (Send out froze it). */
const sentOut = (n: number, keep: number, over: Partial<OrderSnapshot['order']> = {}) =>
  delivery(n, 'out_for_delivery', { riderKeepsCents: keep as never, ...over });

/** The board with these orders: its markup, and each card's by its short number ("#0042"). */
function board(orders: OrderSnapshot[]): { html: string; cards: Map<string, string> } {
  signIn('cashier');
  const html = render(<OrdersBoardPage />, [[['orders', 'active', 'all'], orders]]);
  const cards = new Map<string, string>();
  for (const part of html.split('<article').slice(1)) {
    const num = /#(\d{4})/.exec(part)?.[1];
    if (num) cards.set(`#${num}`, part.split('</article>')[0]!);
  }
  return { html, cards };
}
const card = (o: OrderSnapshot) => board([o]).cards.get(`#${o.order.orderNumber.split('-').pop()}`)!;

/** The opening tag of each <button> whose words are exactly `words`, with those words. */
const buttonsWith = (markup: string, words: string) =>
  markup
    .split('<button')
    .slice(1)
    .map((b) => `<button${b.split('</button>')[0]!}</button>`)
    .filter((b) => text(b) === words);
const openingTag = (button: string) => button.slice(0, button.indexOf('>') + 1);

const consoleError = console.error;
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((msg: unknown, ...rest: unknown[]) => {
    if (String(msg).includes('useLayoutEffect does nothing on the server')) return;
    consoleError(msg, ...rest);
  });
});
afterAll(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  seen.calls.length = 0;
  seen.toasts.length = 0;
  seen.refuse = null;
});
afterEach(() => {
  vi.useRealTimers();
  useSessionStore.setState({ user: null, status: 'idle' });
});

describe('a Ready delivery card: "Send out", and "Assign rider" as a small link', () => {
  it('the big button is Send out with the truck, paid or not; the link has its title', () => {
    for (const o of [delivery(42, 'ready'), delivery(43, 'ready', { paidAt: minsAgo(30) })]) {
      const c = card(o);
      const send = buttonsWith(c, 'Send out');
      expect(send).toHaveLength(1);
      expect(send[0]).toContain('lucide-truck');
      expect(openingTag(send[0]!)).not.toMatch(/\sdisabled(=|\s|>)/);
      // "Assign rider" is the small link only, never the big button.
      const link = buttonsWith(c, 'Assign rider');
      expect(link).toHaveLength(1);
      expect(openingTag(link[0]!)).toContain(`title="${ASSIGN_RIDER_LINK_TITLE}"`);
      expect(decode(openingTag(link[0]!))).toContain('title="Optional — one of your own riders (they bring back the full bill)"');
      expect(openingTag(link[0]!)).toContain('text-violet-700');
      expect(link[0]).toContain('lucide-bike');
      expect(seen.buttons.map((b) => b.words)).not.toContain('Assign rider');
      expect(text(c)).not.toContain('Outside rider');
    }
  });

  it('tapping Send out asks the till once, for this order, and shows no toast', async () => {
    card(delivery(42, 'ready'));
    tap('Send out');
    await settle();
    expect(seen.calls).toEqual([['orders.sendOut', 'o42']]);
    expect(seen.toasts).toEqual([]);
  });

  it('a refusal shows "Could not send out" with the till’s own words', async () => {
    seen.refuse = 'This order is already out for delivery';
    card(delivery(42, 'ready'));
    tap('Send out');
    await settle();
    expect(seen.calls).toEqual([['orders.sendOut', 'o42']]);
    expect(seen.toasts).toEqual([
      { title: 'Could not send out', description: 'This order is already out for delivery', variant: 'error' },
    ]);
  });

  it('a Ready takeaway or foodpanda card has no rider link, and the takeaway card is the same as before', () => {
    const { cards } = board([
      delivery(46, 'ready', {}, null, 'takeaway'),
      delivery(48, 'ready', { paidAt: minsAgo(30) }, null, 'foodpanda'),
    ]);
    for (const c of cards.values()) {
      expect(buttonsWith(c, 'Assign rider')).toEqual([]);
      expect(buttonsWith(c, 'Send out')).toEqual([]);
    }
    expect(sha256(cards.get('#0046')!)).toBe(BEFORE.readyTakeaway);
  });
});

describe('an Out card sent out with an outside rider', () => {
  it('"Outside rider · out 12m · keeps Rs 200", with an "Assign rider" link', () => {
    const c = card(sentOut(47, 20_000));
    expect(text(c)).toContain('Outside rider · out 12m · keeps Rs 200 Assign rider');
    const link = buttonsWith(c, 'Assign rider');
    expect(link).toHaveLength(1);
    expect(openingTag(link[0]!)).toContain(`title="${ASSIGN_RIDER_LINK_TITLE}"`);
    expect(c).toContain('lucide-truck');
    // No own rider's row: no Change, no phone of a rider.
    expect(buttonsWith(c, 'Change')).toEqual([]);
    expect(c).not.toContain('03000000001');
    // The next step is still the rider coming back: Delivered + Pay (unpaid).
    expect(buttonsWith(c, 'Delivered + Pay')).toHaveLength(1);
  });

  it('"· no delivery charge" when he keeps nothing', () => {
    expect(text(card(sentOut(49, 0)))).toContain('Outside rider · out 12m · no delivery charge Assign rider');
  });

  it('an own rider’s Out card is byte-identical to before (unpaid and paid), with no outside rider row', () => {
    const { cards } = board([
      delivery(44, 'out_for_delivery', {}, OWN_RIDER),
      delivery(45, 'out_for_delivery', { paidAt: minsAgo(30) }, OWN_RIDER),
    ]);
    expect(plainSpaces(cards.get('#0044')!)).toBe(OWN_RIDER_CARD_BEFORE.join(''));
    expect(sha256(cards.get('#0045')!)).toBe(BEFORE.ownRiderPaid);
    for (const c of cards.values()) expect(text(c)).not.toContain('Outside rider');
  });

  it('a rider an older till named on a sent-out order shows as his row, not the outside one', () => {
    const c = card(delivery(50, 'out_for_delivery', { riderKeepsCents: 20_000 as never }, OWN_RIDER));
    expect(text(c)).toContain('Test Rider 03000000001 · out 12m Change');
    expect(text(c)).not.toContain('Outside rider');
  });
});

describe('Assign rider on a sent-out order', () => {
  function dialog(snap: OrderSnapshot, onAssigned: () => void = () => {}): string {
    signIn('cashier');
    return render(<AssignRiderDialog snap={snap} onClose={() => {}} onAssigned={onAssigned} />, [
      [['riders', 'active'], [{ ...OWN_RIDER, active: true }]],
      [['orders', 'active', 'delivery'], [snap]],
    ]);
  }

  it('says it was sent out with an outside rider, and offers Back to Ready with its title', () => {
    const out = dialog(sentOut(47, 20_000));
    expect(text(out)).toContain('Order #0047 · Test Customer · sent out with an outside rider');
    const back = buttonsWith(out, 'Back to Ready');
    expect(back).toHaveLength(1);
    expect(back[0]).toContain('lucide-undo2');
    expect(decode(openingTag(back[0]!))).toContain(`title="${BACK_TO_READY_TITLE}"`);
    expect(BACK_TO_READY_TITLE).toBe(
      'Only if the rider has not left. If he went and came back, cancel the order instead: it asks about his trip.',
    );
    expect(buttonsWith(out, 'Take rider off')).toEqual([]);
    // One of the shop's own riders can still take it.
    expect(text(out)).toContain('Test Rider');
    expect(text(out)).toContain('Assign →');
  });

  it('Back to Ready asks the till once and toasts "Order #0047 is back in Ready"', async () => {
    let assigned = 0;
    dialog(sentOut(47, 20_000), () => {
      assigned += 1;
    });
    tap('Back to Ready');
    await settle();
    expect(seen.calls).toEqual([['orders.unassignRider', 'o47']]);
    expect(seen.toasts).toEqual([{ title: 'Order #0047 is back in Ready' }]);
    expect(assigned).toBe(1);
  });

  it('a refusal says so in the till’s words', async () => {
    seen.refuse = 'Order changed state before this action could complete. Refresh and try again.';
    dialog(sentOut(47, 0));
    tap('Back to Ready');
    await settle();
    expect(seen.toasts).toEqual([
      {
        title: 'Could not bring it back to Ready',
        description: 'Order changed state before this action could complete. Refresh and try again.',
        variant: 'error',
      },
    ]);
  });

  it('an own rider’s order keeps "Take rider off" and its words; a Ready one offers neither', async () => {
    const own = dialog(delivery(44, 'out_for_delivery', {}, OWN_RIDER));
    expect(text(own)).toContain('Order #0044 · Test Customer · now with Test Rider');
    expect(text(own)).not.toContain('outside rider');
    expect(buttonsWith(own, 'Take rider off')).toHaveLength(1);
    expect(buttonsWith(own, 'Back to Ready')).toEqual([]);
    tap('Take rider off');
    await settle();
    expect(seen.calls).toEqual([['orders.unassignRider', 'o44']]);
    expect(seen.toasts).toEqual([{ title: 'Rider taken off — order is back in Ready' }]);

    const ready = dialog(delivery(42, 'ready'));
    expect(text(ready)).toContain('Order #0042 · Test Customer');
    expect(text(ready)).not.toContain('outside rider');
    expect(buttonsWith(ready, 'Back to Ready')).toEqual([]);
    expect(buttonsWith(ready, 'Take rider off')).toEqual([]);
  });
});

describe('Order History: the order panel', () => {
  function panel(snap: OrderSnapshot): { customer: string; whatHappened: string } {
    signIn('admin');
    const html = render(<OrderDetailDrawer orderId={snap.order.id} onClose={() => {}} />, [[['orders', 'detail', snap.order.id], snap]]);
    const customer = text(html.split('<section')[1]?.split('</section>')[0] ?? '');
    const whatHappened = text(html.split('What happened')[1]?.split('</ol>')[0] ?? '');
    return { customer, whatHappened };
  }

  it('the chip says what the outside rider kept, and the step says it was sent out', () => {
    const p = panel(sentOut(47, 20_000));
    expect(p.customer).toContain('Outside rider · kept Rs 200 delivery charge');
    expect(plainSpaces(p.whatHappened)).toBe('Taken 7:20 pm · by Test Cashier Sent 7:22 pm Sent out (outside rider) 7:48 pm');
  });

  it('no delivery charge kept', () => {
    expect(panel(sentOut(49, 0)).customer).toContain('Outside rider · no delivery charge');
  });

  it('delivered later, it still says so', () => {
    const p = panel(sentOut(51, 25_000, { status: 'delivered', deliveredAt: minsAgo(2), paidAt: minsAgo(2) }));
    expect(p.customer).toContain('Outside rider · kept Rs 250 delivery charge');
    expect(p.whatHappened).toContain('Sent out (outside rider)');
  });

  it('one of the shop’s own riders reads as before', () => {
    const p = panel(delivery(44, 'out_for_delivery', {}, OWN_RIDER));
    expect(p.customer).toContain('Rider Test Rider · 03000000001');
    expect(p.customer).not.toContain('Outside rider');
    expect(plainSpaces(p.whatHappened)).toBe('Taken 7:20 pm · by Test Cashier Sent 7:22 pm Out with rider 7:48 pm · Test Rider');
  });
});

describe('Order History: the row', () => {
  const row = (n: number, over: Partial<OrderHistoryRow>): OrderHistoryRow => ({
    id: `o${n}`,
    orderNumber: `20261001-00${n}`,
    mode: 'delivery',
    source: 'pos',
    status: 'out_for_delivery',
    customerName: 'Test Customer',
    customerPhone: '03001234567',
    tableLabel: null,
    cashierName: 'Test Cashier',
    riderName: null,
    itemCount: 2,
    totalCents: 413_000,
    refundedCents: 0,
    paidAt: null,
    createdAt: minsAgo(40),
    paymentMethods: [],
    ...over,
  });

  it('"Rider: outside" for an order sent out with an outside rider; an own rider by name; nothing otherwise', () => {
    signIn('cashier');
    const page: HistoryPage = {
      rows: [row(47, { outsideRider: true }), row(44, { riderName: 'Test Rider' }), row(42, { status: 'ready' })],
      total: 3,
      summary: {
        orderCount: 3,
        paidCount: 0,
        salesCents: 0,
        notPaidCount: 3,
        notPaidCents: 1_239_000,
        cancelledCount: 0,
        cancelledCents: 0,
        refundCount: 0,
        refundedCents: 0,
        byMethod: [],
      },
    };
    const request = {
      ...historyRange('today', new Date()),
      statusGroup: 'all',
      channel: 'all',
      paymentMethod: 'all',
      limit: HISTORY_PAGE_SIZE,
      offset: 0,
    };
    const html = render(<OrderHistoryPage />, [[['orders', 'history', request], page]]);
    const rows = new Map<string, string>();
    for (const part of html.split('<tr').slice(1)) {
      const num = /#(\d{4})/.exec(part)?.[1];
      if (num) rows.set(`#${num}`, text(part.split('</tr>')[0]!));
    }
    expect([...rows.keys()]).toEqual(['#0047', '#0044', '#0042']);
    expect(rows.get('#0047')).toContain('Test Customer 03001234567 Rider: outside');
    expect(rows.get('#0044')).toContain('Test Customer 03001234567 Rider: Test Rider');
    expect(rows.get('#0044')).not.toContain('outside');
    expect(rows.get('#0042')).not.toContain('Rider:');
  });
});

// ---------------------------------------------------------------------------
// The cards of the build before this step (23e7c86, v0.7.34 step 16-2),
// rendered from the same made-up orders at the same "now". An own rider's Out
// card in full; the rest by their SHA-256 (spaces before am/pm made plain).

const BEFORE = {
  /** #0045: an own rider's Out card, paid. */
  ownRiderPaid: '5a1ef36ed15339d90f3fa61b991230ac6e04368160ca97c7843b2eac0d75957d',
  /** #0046: a Ready takeaway, unpaid. */
  readyTakeaway: '609e6fe0caf4e7e91a0ffb286c1fdabbe8e1ea8f2e7263a99e7e5929c8d11c14',
};

/** #0044: an own rider's Out card, unpaid (the article's markup after "<article"). */
const OWN_RIDER_CARD_BEFORE = [
  ' class="rounded-xl bg-white p-3 shadow-soft-sm transition-shadow hover:shadow-soft-md dark:bg-stone-800 ring-2 ring-red-500 dark:ring-red-500">',
  '<header class="mb-1.5 flex items-start justify-between gap-2">',
  '<div class="min-w-0">',
  '<div class="flex flex-wrap items-center gap-1.5">',
  '<span class="font-mono text-lg font-bold leading-none text-stone-900 dark:text-stone-100">#0044</span>',
  '<span class="inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ring-1 bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950/50 dark:text-violet-200 dark:ring-violet-800">Delivery</span></div>',
  '<div class="mt-1 flex items-center gap-1.5 truncate text-sm font-semibold text-stone-700 dark:text-stone-200">',
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-user-round h-3.5 w-3.5 shrink-0 text-stone-400"><circle cx="12" cy="8" r="5"></circle><path d="M20 21a8 8 0 0 0-16 0"></path></svg>',
  '<span class="truncate">Test Customer</span></div></div>',
  '<span class="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-sm font-semibold bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-200" title="Sent 7:22 pm · started 7:20 pm">',
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-hourglass h-3.5 w-3.5"><path d="M5 22h14"></path><path d="M5 2h14"></path><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"></path><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"></path></svg>38m</span></header>',
  '<ul class="space-y-0.5 text-sm text-stone-700 dark:text-stone-300">',
  '<li>',
  '<div class="truncate"><span class="font-bold text-stone-900 dark:text-stone-100">1×</span> Test Family Pizza</div></li>',
  '<li>',
  '<div class="truncate"><span class="font-bold text-stone-900 dark:text-stone-100">1×</span> Delivery Charge (Rs 200)</div></li></ul>',
  '<div class="mt-2 space-y-1 rounded-lg bg-stone-50 p-2 text-xs dark:bg-stone-900/60">',
  '<div class="flex items-center gap-1.5 font-mono text-stone-600 dark:text-stone-300">',
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-phone h-3 w-3 shrink-0"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>03001234567</div>',
  '<div class="flex items-start gap-1.5 text-stone-600 dark:text-stone-300">',
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-map-pin mt-0.5 h-3 w-3 shrink-0"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"></path><circle cx="12" cy="10" r="3"></circle></svg><span class="line-clamp-2">House 1, Made-up Street</span></div>',
  '<div class="flex items-center justify-between gap-1.5 rounded-md bg-violet-50 p-1.5 text-violet-800 dark:bg-violet-950/40 dark:text-violet-200">',
  '<span class="flex min-w-0 items-center gap-1.5">',
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-bike h-3.5 w-3.5 shrink-0"><circle cx="18.5" cy="17.5" r="3.5"></circle><circle cx="5.5" cy="17.5" r="3.5"></circle><circle cx="15" cy="5" r="1"></circle><path d="M12 17.5V14l-3-3 4-3 2 3h2"></path></svg>',
  '<span class="truncate font-semibold">Test Rider</span>',
  '<span class="font-mono text-[10px]">03000000001</span>',
  '<span class="whitespace-nowrap text-[10px]">· out 12m</span></span>',
  '<button type="button" class="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold text-violet-700 underline-offset-2 hover:underline dark:text-violet-300">Change</button></div></div>',
  '<div class="mt-2 flex items-center justify-between border-t border-stone-100 pt-2 dark:border-stone-700">',
  '<div class="flex items-center gap-2">',
  '<span class="font-mono text-base font-bold text-stone-900 dark:text-stone-100">Rs 4,130</span>',
  '<span class="inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200">Not paid</span></div><span class="text-xs text-stone-500">2 items</span></div>',
  '<div class="mt-2 flex items-center gap-1">',
  '<button type="button" class="inline-flex items-center justify-center gap-2 font-semibold tracking-tight transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-900 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 select-none bg-gradient-to-b from-emerald-500 to-emerald-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_1px_2px_rgba(0,0,0,0.05)] hover:from-emerald-400 hover:to-emerald-500 hover:shadow-lift active:from-emerald-600 active:to-emerald-700 focus-visible:ring-emerald-500 px-4 rounded-xl h-11 flex-1 whitespace-nowrap text-sm">',
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-check h-4 w-4"><circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path></svg>Delivered + Pay</button>',
  '<button type="button" aria-label="Print bill or receipt" title="Print bill or receipt" class="flex h-11 w-9 items-center justify-center rounded-lg text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-700 dark:hover:text-stone-200">',
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-printer h-4 w-4"><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"></path><rect x="6" y="14" width="12" height="8" rx="1"></rect></svg></button>',
  '<button type="button" aria-label="Cancel order (manager approval)" title="Cancel order (manager approval)" class="flex h-11 w-9 items-center justify-center rounded-lg text-stone-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-300">',
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-x h-4 w-4"><circle cx="12" cy="12" r="10"></circle><path d="m15 9-6 6"></path><path d="m9 9 6 6"></path></svg></button></div>',
];
