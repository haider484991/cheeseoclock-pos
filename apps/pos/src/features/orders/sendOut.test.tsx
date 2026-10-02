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
 *
 * Step 18-6 (the owner, 2 Oct 2026: Send out asks "Has the rider paid the
 * shop?" [Paid now · Rs <food total>] / [Pays after delivery]; Out cards:
 * PAID + [Delivered], or amber "Rider owes Rs <food total>" + [Rider paid]
 * and [Delivered + Pay]; Q2: a prepaid order's drawer opens at Send out):
 *  - The Send out box, word for word: not paid (with a delivery charge and
 *    without), paid with a charge (the drawer opens), a walk-in. "Pays after
 *    delivery" is focused; every answer asks the till to send it out before
 *    anything else; Esc and the X change nothing; a refusal keeps it open.
 *  - On Live Orders: Send out opens the box, except a paid order whose rider
 *    keeps nothing (one tap); "Paid now" then opens "Rider paid · #0042" on
 *    the order as the till sent it; the link opens Assign rider instead.
 *  - Out cards: "Rider owes Rs 4,515" and "Rider paid" while he owes; the
 *    PAID chip and "Delivered" once paid; own-rider cards as before.
 *  Live Orders is rendered again after each tap with React's useState kept
 *  in slots between renders (as in markDeliveredOutside.test.tsx), and the
 *  Rider paid and Assign rider boxes stood in by stubs that record what they
 *  were opened with.
 */
import { createHash } from 'node:crypto';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, OrderHistoryPage as HistoryPage, OrderHistoryRow, OrderSnapshot, OrderStatus, UUID } from '@cheeseoclock/shared-types';
import { deliveryBillOf, toCents } from '@cheeseoclock/shared-types';
import { formatCents } from '@cheeseoclock/pos-domain';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { OrdersBoardPage } from './OrdersBoardPage';
import { AssignRiderDialog, BACK_TO_READY_TITLE } from './AssignRiderDialog';
import { OrderDetailDrawer } from './OrderDetailDrawer';
import { OrderHistoryPage } from './OrderHistoryPage';
import { ASSIGN_RIDER_LINK_TITLE } from './boardLogic';
import { SendOutDialog } from './SendOutDialog';
import { MarkDeliveredDialog } from './MarkDeliveredDialog';
import { HISTORY_PAGE_SIZE, historyRange } from './historyFilters';

/** useState's slots, kept between renders: `cursor` is where this render is. Every render() starts them afresh. */
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));

vi.mock('react', async (importOriginal) => {
  const React = await importOriginal<typeof import('react')>();
  function useState<T>(init: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
    const i = hooks.cursor++;
    if (i >= hooks.slots.length) hooks.slots.push(typeof init === 'function' ? (init as () => T)() : init);
    const set = (next: T | ((prev: T) => T)) => {
      hooks.slots[i] = typeof next === 'function' ? (next as (prev: T) => T)(hooks.slots[i] as T) : next;
    };
    return [hooks.slots[i] as T, set];
  }
  return { ...React, useState, default: { ...React, useState } };
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
    // Esc (or a tap outside) is the Root's onOpenChange(false): kept so a test can press it.
    Root: ({ children, onOpenChange }: P & { onOpenChange?: (open: boolean) => void }) => {
      seen.openChange = onOpenChange ?? null;
      return h(React.Fragment, null, children);
    },
    Portal: pass,
    Overlay: () => null,
    // The open box's body, kept for its plain buttons' taps.
    Content: ({ children, className }: P) => {
      seen.content = children;
      return h('div', { className, role: 'dialog' }, children);
    },
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
  buttons: [] as Array<{
    words: string;
    title: string | undefined;
    tap: (() => void) | undefined;
    autoFocus: boolean | undefined;
    variant: string | undefined;
    className: string | undefined;
    disabled: boolean | undefined;
  }>,
  /** The till's answer to Send out / Back to Ready: its snapshot, or a refusal in its own words. */
  refuse: null as string | null,
  /** The snapshot the till answers Send out with (the order as it went out). */
  answer: null as unknown,
  /** The till's calls and the screens' callbacks, in the order they happened. */
  events: [] as string[],
  /** The open box's Root onOpenChange (Esc), and its body. */
  openChange: null as ((open: boolean) => void) | null,
  content: null as unknown,
}));

/** With `on`, the Rider paid and Assign rider boxes are stand-ins that only record what they were opened with. */
const stubs = vi.hoisted(() => ({ on: false, deliver: [] as unknown[], assign: [] as unknown[] }));

vi.mock('./MarkDeliveredDialog', async (importOriginal) => {
  const real = await importOriginal<typeof import('./MarkDeliveredDialog')>();
  const React = await import('react');
  return {
    ...real,
    MarkDeliveredDialog: (props: Parameters<typeof real.MarkDeliveredDialog>[0]) => {
      if (!stubs.on) return React.createElement(real.MarkDeliveredDialog, props);
      if (!stubs.deliver.some((d) => (d as { snap: unknown }).snap === props.snap)) {
        seen.events.push(props.riderPaidOnly ? 'opened Rider paid' : 'opened Delivered + Pay');
      }
      stubs.deliver.push(props);
      return null;
    },
  };
});

vi.mock('./AssignRiderDialog', async (importOriginal) => {
  const real = await importOriginal<typeof import('./AssignRiderDialog')>();
  const React = await import('react');
  return {
    ...real,
    AssignRiderDialog: (props: Parameters<typeof real.AssignRiderDialog>[0]) => {
      if (!stubs.on) return React.createElement(real.AssignRiderDialog, props);
      stubs.assign.push(props);
      return null;
    },
  };
});

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
      autoFocus: props.autoFocus,
      variant: props.variant,
      className: props.className,
      disabled: props.disabled,
    });
    return React.createElement(ui.Button, { ...props, ref });
  });
  return { ...ui, Button };
});

vi.mock('../../ipc/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../ipc/client')>();
  const answer = (name: string) => async (arg: unknown) => {
    seen.calls.push([name, arg]);
    seen.events.push(name);
    if (seen.refuse) throw new Error(seen.refuse);
    return (seen.answer ?? {}) as OrderSnapshot;
  };
  return {
    ...real,
    ipc: {
      ...real.ipc,
      orders: {
        ...real.ipc.orders,
        sendOut: answer('orders.sendOut'),
        unassignRider: answer('orders.unassignRider'),
        markDelivered: answer('orders.markDelivered'),
      },
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
  hooks.slots = [];
  hooks.cursor = 0;
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

/** The same order with no delivery-charge line: Send out freezes Rs 0 for the rider. */
const noCharge = (s: OrderSnapshot): OrderSnapshot =>
  ({ ...s, items: s.items.filter((i) => !/^Delivery Charge/.test(i.menuItemName)) }) as OrderSnapshot;

/**
 * The owner's example: Test Family Pizza Rs 3,900 and 'Delivery Charge (Rs
 * 200)', 15% tax on both: CUSTOMER PAYS Rs 4,715, FOOD TOTAL Rs 4,515.
 */
const ownerExample = (n: number, status: OrderStatus, over: Partial<OrderSnapshot['order']> = {}, rider: OrderSnapshot['rider'] = null) =>
  delivery(n, status, { subtotalCents: toCents(410_000), taxCents: toCents(61_500), totalCents: toCents(471_500), ...over }, rider);

/** A React element as JSX made it. */
type El = { type: unknown; props: Record<string, unknown> };
const isEl = (n: unknown): n is El => typeof n === 'object' && n !== null && 'type' in n && 'props' in n;
function* walk(node: unknown): Generator<El> {
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n);
  } else if (isEl(node)) {
    yield node;
    yield* walk(node.props['children']);
  }
}
const wordsOf = (node: unknown): string =>
  typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : Array.isArray(node)
      ? node.map(wordsOf).join('')
      : isEl(node)
        ? wordsOf(node.props['children'])
        : '';

/** Taps the open box's one plain <button> with exactly these words, or this aria-label (the X is "Close"). */
function tapInBox(words: string): void {
  const hits = [...walk(seen.content)].filter(
    (e) => e.type === 'button' && (wordsOf(e.props['children']).trim() === words || e.props['aria-label'] === words),
  );
  if (hits.length !== 1) throw new Error(`${hits.length} × button "${words}" in the box`);
  (hits[0]!.props['onClick'] as () => void)();
}

/**
 * Live Orders with these orders, rendered again after every tap with
 * useState kept in its slots (the same number of calls every render, or the
 * slots mean nothing). The Rider paid and Assign rider boxes are stubs.
 */
function liveOrders(orders: OrderSnapshot[]) {
  signIn('cashier');
  stubs.on = true;
  hooks.slots = [];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['orders', 'active', 'all'], orders);
  let html = '';
  let count = -1;
  const view = () => {
    hooks.cursor = 0;
    seen.buttons.length = 0;
    seen.content = null;
    seen.openChange = null;
    html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ToastProvider>
            <OrdersBoardPage />
          </ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    if (count >= 0 && hooks.cursor !== count) throw new Error(`useState was called ${hooks.cursor} times, not ${count}`);
    count = hooks.cursor;
  };
  view();
  return {
    view,
    get words() {
      return text(html);
    },
    /** A ui-kit Button (a card's, the Send out box's), then the board again. */
    press(words: string) {
      tap(words);
      view();
    },
    /** A plain button in the open box, then the board again. */
    tapInBox(words: string) {
      tapInBox(words);
      view();
    },
    /** Esc on the open box, then the board again. */
    esc() {
      seen.openChange!(false);
      view();
    },
  };
}

type DeliverProps = Parameters<typeof MarkDeliveredDialog>[0];

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
  seen.answer = null;
  seen.events.length = 0;
  seen.openChange = null;
  seen.content = null;
  stubs.on = false;
  stubs.deliver.length = 0;
  stubs.assign.length = 0;
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

  // Changed on purpose in step 18-6 (the owner, 2 Oct 2026: Send out asks
  // "Has the rider paid the shop?"): Send out was one tap for every Ready
  // delivery; now only a paid order whose rider keeps nothing goes in one
  // tap, so these two use that order (the order 16-3 used, #0042 unpaid with
  // a Rs 200 charge, now opens the Send out box: see below).
  it('tapping Send out on a paid order with no delivery charge asks the till once, for this order, and shows no toast', async () => {
    card(noCharge(delivery(42, 'ready', { paidAt: minsAgo(30) })));
    tap('Send out');
    await settle();
    expect(seen.calls).toEqual([['orders.sendOut', 'o42']]);
    expect(seen.toasts).toEqual([]);
  });

  it('a refusal shows "Could not send out" with the till’s own words', async () => {
    seen.refuse = 'This order is already out for delivery';
    card(noCharge(delivery(42, 'ready', { paidAt: minsAgo(30) })));
    tap('Send out');
    await settle();
    expect(seen.calls).toEqual([['orders.sendOut', 'o42']]);
    expect(seen.toasts).toEqual([
      { title: 'Could not send out', description: 'This order is already out for delivery', variant: 'error' },
    ]);
  });

  it('an unpaid one (and a paid one with a charge) asks the till nothing yet: the Send out box opens', async () => {
    for (const o of [delivery(42, 'ready'), noCharge(delivery(44, 'ready')), delivery(43, 'ready', { paidAt: minsAgo(30) })]) {
      card(o);
      tap('Send out');
      await settle();
    }
    expect(seen.calls).toEqual([]);
    expect(seen.toasts).toEqual([]);
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

describe('the Send out box (step 18-6): "Has the rider paid the shop?"', () => {
  /** What onSent was handed: the order as the till sent it out. */
  const sent: OrderSnapshot[] = [];
  beforeEach(() => {
    sent.length = 0;
  });

  function box(snap: OrderSnapshot): string {
    signIn('cashier');
    return text(
      render(
        <SendOutDialog
          snap={snap}
          onClose={() => seen.events.push('closed')}
          onSent={(next, riderPaidNow) => {
            seen.events.push(riderPaidNow ? 'sent, Paid now' : 'sent');
            sent.push(next);
          }}
          onAssignInstead={() => seen.events.push('assign instead')}
        />,
      ),
    );
  }
  const button = (words: string) => seen.buttons.find((b) => b.words === words);

  it('not paid: the bill split, the question and its two answers, word for word', () => {
    const o = ownerExample(42, 'ready');
    expect(box(o)).toBe(
      'Send out #0042 The bill prints now · Test Customer ' +
        'Customer pays the rider Rs 4,715 Rider keeps (delivery charge) Rs 200 Rider gives the shop Rs 4,515 ' +
        'Has the rider paid the shop? Paid now · Rs 4,515 Pays after delivery ' +
        'One of your own riders? Assign rider instead',
    );
    // The delivery bill's figures: he hands over its FOOD TOTAL, the paper's own.
    const bill = deliveryBillOf(o)!;
    expect(box(o)).toContain(`Customer pays the rider ${formatCents(bill.customerPaysCents)}`);
    expect(box(o)).toContain(`Rider keeps (delivery charge) ${formatCents(bill.deliveryChargeCents)}`);
    expect(box(o)).toContain(`Rider gives the shop ${formatCents(bill.foodTotalCents)}`);
    expect(seen.buttons.map((b) => b.words)).toEqual([`Paid now · ${formatCents(bill.foodTotalCents)}`, 'Pays after delivery']);
  });

  it('"Pays after delivery" is focused, so Enter means after; both answers are h-14', () => {
    box(ownerExample(42, 'ready'));
    expect(button('Pays after delivery')).toMatchObject({ autoFocus: true, variant: 'primary' });
    expect(button('Paid now · Rs 4,515')).toMatchObject({ autoFocus: undefined, variant: 'success' });
    for (const words of ['Pays after delivery', 'Paid now · Rs 4,515']) expect(button(words)!.className).toContain('h-14');
  });

  it('no delivery charge: "No delivery charge on this bill", and he hands over the whole bill', () => {
    const words = box(
      noCharge(delivery(44, 'ready', { subtotalCents: toCents(390_000), taxCents: toCents(58_500), totalCents: toCents(448_500) })),
    );
    expect(words).toBe(
      'Send out #0044 The bill prints now · Test Customer ' +
        'Customer pays the rider Rs 4,485 No delivery charge on this bill Rider gives the shop Rs 4,485 ' +
        'Has the rider paid the shop? Paid now · Rs 4,485 Pays after delivery ' +
        'One of your own riders? Assign rider instead',
    );
    expect(words).not.toContain('Rider keeps');
  });

  it('paid already, with a charge: the drawer gives him Rs 200 and opens (owner Q2)', () => {
    const words = box(ownerExample(43, 'ready', { paidAt: minsAgo(30) }));
    expect(words).toBe(
      'Send out #0043 The bill prints now · Test Customer ' +
        'Paid already — give the rider Rs 200 from the drawer (his delivery charge). The drawer opens. ' +
        'Send out · drawer opens ' +
        'One of your own riders? Assign rider instead',
    );
    expect(seen.buttons.map((b) => b.words)).toEqual(['Send out · drawer opens']);
    expect(button('Send out · drawer opens')).toMatchObject({ autoFocus: true });
    expect(button('Send out · drawer opens')!.className).toContain('h-14');
  });

  it('paid already with no charge (Live Orders sends it in one tap): if it opens, nothing moves', () => {
    const words = box(noCharge(delivery(45, 'ready', { paidAt: minsAgo(30) })));
    expect(words).toContain('Paid already, and no delivery charge: nothing comes out of the drawer.');
    expect(seen.buttons.map((b) => b.words)).toEqual(['Send out']);
    expect(words).not.toContain('drawer opens');
  });

  it('a walk-in: the customer’s details stay optional', () => {
    const o = { ...ownerExample(42, 'ready'), customerName: null, customerPhone: null, deliveryAddress: null } as OrderSnapshot;
    expect(box(o)).toContain('Send out #0042 The bill prints now · Walk-in Customer pays the rider Rs 4,715');
  });

  it('every answer asks the till to send it out first, then hands on the order as it went out', async () => {
    const out = ownerExample(42, 'out_for_delivery', { riderKeepsCents: 20_000 as never });
    for (const [words, heard] of [
      ['Pays after delivery', 'sent'],
      ['Paid now · Rs 4,515', 'sent, Paid now'],
    ] as const) {
      seen.events.length = 0;
      seen.calls.length = 0;
      sent.length = 0;
      seen.answer = out;
      box(ownerExample(42, 'ready'));
      tap(words);
      await settle();
      expect(seen.calls).toEqual([['orders.sendOut', 'o42']]);
      expect(seen.events).toEqual(['orders.sendOut', heard]);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toBe(out);
    }
    // Paid already: the same; the drawer is the till's part.
    seen.events.length = 0;
    seen.calls.length = 0;
    box(ownerExample(43, 'ready', { paidAt: minsAgo(30) }));
    tap('Send out · drawer opens');
    await settle();
    expect(seen.calls).toEqual([['orders.sendOut', 'o43']]);
    expect(seen.events).toEqual(['orders.sendOut', 'sent']);
    expect(seen.toasts).toEqual([]);
  });

  it('a refusal says "Could not send out" in the till’s words, and nothing else happens', async () => {
    seen.refuse = 'No shift is open on this till — open a shift to give the rider his Rs 200 delivery charge';
    box(ownerExample(43, 'ready', { paidAt: minsAgo(30) }));
    tap('Send out · drawer opens');
    await settle();
    expect(seen.events).toEqual(['orders.sendOut']);
    expect(seen.toasts).toEqual([
      {
        title: 'Could not send out',
        description: 'No shift is open on this till — open a shift to give the rider his Rs 200 delivery charge',
        variant: 'error',
      },
    ]);
  });

  it('Esc or the X closes it with nothing changed', () => {
    box(ownerExample(42, 'ready'));
    seen.openChange!(false);
    tapInBox('Close');
    expect(seen.events).toEqual(['closed', 'closed']);
    expect(seen.calls).toEqual([]);
  });

  it('"One of your own riders? Assign rider instead": nothing is sent', () => {
    box(ownerExample(42, 'ready'));
    tapInBox('One of your own riders? Assign rider instead');
    expect(seen.events).toEqual(['assign instead']);
    expect(seen.calls).toEqual([]);
  });
});

describe('Live Orders: Send out asks, then Rider owes / Rider paid (step 18-6)', () => {
  it('Send out on an unpaid delivery opens the box; "Paid now" sends it out, then opens "Rider paid · #0042" on the order as sent', async () => {
    const out = ownerExample(42, 'out_for_delivery', { riderKeepsCents: 20_000 as never });
    seen.answer = out;
    const b = liveOrders([ownerExample(42, 'ready')]);
    expect(b.words).not.toContain('Has the rider paid the shop?');
    b.press('Send out');
    expect(b.words).toContain('Send out #0042 The bill prints now · Test Customer');
    expect(b.words).toContain('Has the rider paid the shop? Paid now · Rs 4,515 Pays after delivery');
    expect(seen.calls).toEqual([]);

    b.press('Paid now · Rs 4,515');
    await settle();
    b.view();
    // Sent out first, then Rider paid: the rider can only pay for an order that has left.
    expect(seen.events).toEqual(['orders.sendOut', 'opened Rider paid']);
    expect(seen.calls).toEqual([['orders.sendOut', 'o42']]);
    expect(b.words).not.toContain('Has the rider paid the shop?');
    const riderPaid = stubs.deliver.at(-1) as DeliverProps;
    expect(riderPaid.snap).toBe(out);
    expect(riderPaid.riderPaidOnly).toBe(true);
    expect(seen.toasts).toEqual([]);

    // The real box, opened with exactly those: Rider paid, the food total from him.
    stubs.on = false;
    const words = text(render(<MarkDeliveredDialog {...riderPaid} />));
    expect(words).toContain('Rider paid · #0042 Test Customer · the order stays out for delivery');
    expect(words).toContain('Customer pays Rs 4,715 Rider keeps — delivery charge − Rs 200 Take from the rider Rs 4,515');
  });

  it('"Pays after delivery" sends it out and opens nothing more: the card moving is the feedback', async () => {
    seen.answer = ownerExample(42, 'out_for_delivery', { riderKeepsCents: 20_000 as never });
    const b = liveOrders([ownerExample(42, 'ready')]);
    b.press('Send out');
    b.press('Pays after delivery');
    await settle();
    b.view();
    expect(seen.events).toEqual(['orders.sendOut']);
    expect(stubs.deliver).toEqual([]);
    expect(b.words).not.toContain('Has the rider paid the shop?');
    expect(seen.toasts).toEqual([]);
  });

  it('Esc closes the box with nothing sent', () => {
    const b = liveOrders([ownerExample(42, 'ready')]);
    b.press('Send out');
    expect(b.words).toContain('Has the rider paid the shop?');
    b.esc();
    expect(b.words).not.toContain('Has the rider paid the shop?');
    expect(seen.calls).toEqual([]);
  });

  it('the link opens Assign rider on the same order instead, with nothing sent', () => {
    const ready = ownerExample(42, 'ready');
    const b = liveOrders([ready]);
    b.press('Send out');
    expect(stubs.assign).toEqual([]);
    b.tapInBox('One of your own riders? Assign rider instead');
    expect(b.words).not.toContain('Has the rider paid the shop?');
    expect((stubs.assign.at(-1) as { snap: OrderSnapshot }).snap).toBe(ready);
    expect(seen.calls).toEqual([]);
  });

  it('a paid order whose rider keeps nothing goes out in one tap; a paid one with a charge asks first, then opens the drawer', async () => {
    const one = liveOrders([noCharge(delivery(45, 'ready', { paidAt: minsAgo(30) }))]);
    one.press('Send out');
    await settle();
    one.view();
    expect(seen.calls).toEqual([['orders.sendOut', 'o45']]);
    expect(one.words).not.toContain('Send out #0045');

    seen.calls.length = 0;
    const two = liveOrders([ownerExample(43, 'ready', { paidAt: minsAgo(30) })]);
    two.press('Send out');
    expect(seen.calls).toEqual([]);
    expect(two.words).toContain('Paid already — give the rider Rs 200 from the drawer (his delivery charge). The drawer opens.');
    two.press('Send out · drawer opens');
    await settle();
    two.view();
    expect(seen.calls).toEqual([['orders.sendOut', 'o43']]);
    expect(stubs.deliver).toEqual([]);
    expect(two.words).not.toContain('Paid already');
  });

  it('an unpaid outside Out card: amber "Rider owes Rs 4,515" by the total, and "Rider paid" beside Delivered + Pay', () => {
    const c = card(ownerExample(47, 'out_for_delivery', { riderKeepsCents: 20_000 as never }));
    expect(text(c)).toContain('Outside rider · out 12m · keeps Rs 200 Assign rider');
    expect(text(c)).toContain('Rs 4,715 Rider owes Rs 4,515 2 items');
    expect(text(c)).not.toContain('Not paid');
    expect(c).toContain('bg-amber-100');
    expect(buttonsWith(c, 'Delivered + Pay')).toHaveLength(1);
    const riderPaid = buttonsWith(c, 'Rider paid');
    expect(riderPaid).toHaveLength(1);
    // Full height, in the chef-hat button's place: after the big button, before the printer.
    expect(openingTag(riderPaid[0]!)).toContain('h-11');
    const row = c.slice(c.indexOf('Delivered + Pay'));
    expect(row.indexOf('Rider paid')).toBeGreaterThan(0);
    expect(row.indexOf('Rider paid')).toBeLessThan(row.indexOf('Print bill or receipt'));
    // He keeps nothing: he owes the whole bill.
    expect(text(card(ownerExample(49, 'out_for_delivery', { riderKeepsCents: 0 as never })))).toContain('Rs 4,715 Rider owes Rs 4,715');
  });

  it('"Rider paid" opens the Rider paid box on that order; Delivered + Pay is still the Delivered box', () => {
    const o = ownerExample(47, 'out_for_delivery', { riderKeepsCents: 20_000 as never });
    const b = liveOrders([o]);
    b.press('Rider paid');
    const d = stubs.deliver.at(-1) as DeliverProps;
    expect(d.snap).toBe(o);
    expect(d.riderPaidOnly).toBe(true);
    expect(seen.calls).toEqual([]);
    d.onDone();
    const rendered = stubs.deliver.length;
    b.view();
    expect(stubs.deliver).toHaveLength(rendered);

    b.press('Delivered + Pay');
    const dp = stubs.deliver.at(-1) as DeliverProps;
    expect(dp.snap).toBe(o);
    expect(dp.riderPaidOnly).toBeUndefined();
  });

  it('paid (by the rider while out, or before it left): the PAID chip and Delivered, which closes it with no payment', async () => {
    for (const [n, paidAt] of [
      [52, minsAgo(5)],
      [53, minsAgo(30)],
    ] as const) {
      seen.calls.length = 0;
      const c = card(ownerExample(n, 'out_for_delivery', { riderKeepsCents: 20_000 as never, paidAt }));
      expect(text(c)).toContain('Outside rider · out 12m · keeps Rs 200 Assign rider');
      expect(text(c)).toContain('Rs 4,715 Paid 2 items');
      expect(text(c)).not.toContain('Rider owes');
      expect(buttonsWith(c, 'Rider paid')).toEqual([]);
      expect(buttonsWith(c, 'Delivered')).toHaveLength(1);
      tap('Delivered');
      await settle();
      expect(seen.calls).toEqual([['orders.markDelivered', { orderId: `o${n}` }]]);
    }
  });

  it('an own rider’s Out card has neither, paid or not', () => {
    const { cards } = board([
      ownerExample(44, 'out_for_delivery', {}, OWN_RIDER),
      ownerExample(45, 'out_for_delivery', { paidAt: minsAgo(30) }, OWN_RIDER),
    ]);
    expect(cards.size).toBe(2);
    for (const c of cards.values()) {
      expect(text(c)).not.toContain('Rider owes');
      expect(buttonsWith(c, 'Rider paid')).toEqual([]);
    }
    expect(text(cards.get('#0044')!)).toContain('Rs 4,715 Not paid 2 items');
  });

  it('a rider an older till named on a sent-out order: the money still goes by what the till froze', () => {
    // The Delivered box takes the food total for this order too (MarkDeliveredDialog follows the till).
    const c = card(ownerExample(50, 'out_for_delivery', { riderKeepsCents: 20_000 as never }, OWN_RIDER));
    expect(text(c)).toContain('Test Rider 03000000001 · out 12m Change');
    expect(text(c)).toContain('Rs 4,715 Rider owes Rs 4,515');
    expect(buttonsWith(c, 'Rider paid')).toHaveLength(1);
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
