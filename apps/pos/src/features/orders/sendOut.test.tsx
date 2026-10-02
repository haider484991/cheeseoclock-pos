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
 *    keeps Rs 200" (or, keeping nothing, the paper's own reason: "· already
 *    paid for this trip" while the bill has its charge, "· no delivery
 *    charge" with none), with an "Assign rider" link.
 *  - An own rider's Out card and a Ready takeaway card: byte-identical to the
 *    cards of the build before this step.
 *  - Assign rider on a sent-out order: the description says so, and "Back to
 *    Ready" (its title points to the cancel, and so do visible words under
 *    it when he keeps something: the trip Back to Ready can't pay) toasts
 *    "Order #0047 is back in Ready".
 *  - Order History: the panel's chip and "Sent out (outside rider)" step, and
 *    the row's "Rider: outside".
 *
 * Step 18-6 (the owner, 2 Oct 2026: Send out asks "Has the rider paid the
 * shop?" [Paid now · Rs <food total>] / [Pays after delivery]; Out cards:
 * PAID + [Delivered], or amber "Rider owes Rs <food total>" + [Rider paid]
 * and [Delivered + Pay]; Q2: a prepaid order's drawer opens at Send out):
 *  - The Send out box, word for word: not paid (with a delivery charge and
 *    without), paid with a charge (the drawer opens), a walk-in. "Pays after
 *    delivery" is focused and sends it out; "Paid now" sends nothing (e2e
 *    fix A): it hands Rider paid the request and what he keeps, and Rider
 *    paid sends it out with his money, so the bill prints after he paid; Esc
 *    and the X change nothing; a refusal keeps it open.
 *  - On Live Orders: Send out opens the box, except a paid order whose rider
 *    keeps nothing (one tap); "Paid now" then opens "Rider paid · #0042" on
 *    the Ready order; the link opens Assign rider instead.
 *  - Out cards: "Rider owes Rs 4,515" and "Rider paid" while he owes; the
 *    PAID chip and "Delivered" once paid; own-rider cards as before.
 *  Live Orders is rendered again after each tap with React's useState kept
 *  in slots between renders (as in markDeliveredOutside.test.tsx), and the
 *  Rider paid and Assign rider boxes stood in by stubs that record what they
 *  were opened with.
 *
 * Step 18-9 (one trip, one fee: the rider was already paid on an order of
 * this customer refunded while still on its trip): the box says "The rider
 * already kept Rs 200 on #0041." and starts on "No delivery charge for him
 * this time" (Rider keeps Rs 0, he gives the shop the whole bill), with
 * "Charge again" back to the order's own figures; Send out's request says
 * riderAlreadyPaid accordingly (every request is now { orderId, ... }).
 *
 * Review fixes C (2 Oct 2026):
 *  - The owing outside Out card: "Rider paid" on its own full-width row
 *    above [Delivered + Pay] [Print] [Cancel] (beside them it pushed Print
 *    and Cancel off the card at 1011 × 663: a 217 px row in 172 px, measured
 *    in Edge with the till's own CSS); "Outside rider" is never cut short.
 *  - An add-on that now goes alone (#0042 cancelled, refunded or delivered
 *    before it went out): the Send out box says "#0042 is no longer here:
 *    this order goes alone with no delivery charge." and offers "Pay the
 *    rider Rs 200 for this trip", not ticked; ticked, a manager's PIN or
 *    password, and the request pays the trip. Assign rider says only the
 *    words. The PIN box is a stand-in here (no state of its own).
 *
 * Review fixes D (2 Oct 2026): a card's last row with no "Rider paid" above
 * it (kitchen, Ready and Out cards) — [the big button] then one group of its
 * icons that never shrinks and goes under the button, on the right, when the
 * two don't fit side by side (at 1011 × 663 a kitchen card's Cancel was cut
 * off and the column scrolled sideways). The cards pinned as "before" are
 * still compared byte for byte, with that one row change taken back out
 * (undoRowD).
 *
 * E2e fixes B (2 Oct 2026): every Out card fits the Out column at the till's
 * narrowest window (1011 × 663 inside: 435 px tall, a 162 px card with a
 * scroll bar; measured in Chrome with the till's own CSS) with its big button
 * in view and every button's words on one line: no Delivery badge (the
 * column says so), the food as one paragraph, no item count; an own rider's
 * box has his name and Change on one line, his phone and "out 12m" under
 * them; while an outside rider owes, "Rider owes Rs 4,515" is his box's last
 * line and the card ends [Rider paid] [Print] [Cancel], then [Delivered +
 * Pay] alone. An own rider's Out card is pinned again in full. Every other
 * card is as it was.
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
import { AssignRiderDialog, BACK_TO_READY_TITLE, backToReadyNote } from './AssignRiderDialog';
import { OrderDetailDrawer } from './OrderDetailDrawer';
import { OrderHistoryPage } from './OrderHistoryPage';
import { ASSIGN_RIDER_LINK_TITLE, nextBoardAction, type PaidNowAtSendOut } from './boardLogic';
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

// The PIN box and its hint line: stand-ins with no state of their own, so Live Orders keeps the
// same number of useState calls on every render while the Send out box asks for a PIN.
vi.mock('../../components/secret/SecretInput', async () => {
  const React = await import('react');
  return {
    SecretInput: ({
      value,
      onChange,
      keyboard: _keyboard,
      wrapperClassName: _wrapper,
      ...rest
    }: { value: string; onChange: (next: string) => void; keyboard?: string; wrapperClassName?: string } & Record<string, unknown>) =>
      React.createElement('input', {
        ...rest,
        type: 'password',
        value,
        onChange: (e: { target: { value: string } }) => onChange(e.target.value),
      }),
  };
});
vi.mock('../../components/secret/SecretHint', () => ({ SecretHint: () => null }));

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

/** The same order with no delivery charge on its bill (only the pizza). */
const noChargeLine = (s: OrderSnapshot): OrderSnapshot => ({ ...s, items: s.items.slice(0, 1) });

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
    expect(seen.calls).toEqual([['orders.sendOut', { orderId: 'o42' }]]);
    expect(seen.toasts).toEqual([]);
  });

  it('a refusal shows "Could not send out" with the till’s own words', async () => {
    seen.refuse = 'This order is already out for delivery';
    card(noCharge(delivery(42, 'ready', { paidAt: minsAgo(30) })));
    tap('Send out');
    await settle();
    expect(seen.calls).toEqual([['orders.sendOut', { orderId: 'o42' }]]);
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
    // Byte for byte as before but for review fixes D's last row (undoRowD) and v0.7.36's Edit order pencil.
    expect(sha256(undoRowD(undoEditIcon(cards.get('#0046')!)))).toBe(BEFORE.readyTakeaway);
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

  it('"Outside rider" is never cut short on a narrow card: one wrapping row, the words in one piece with the truck, the link last on the right', () => {
    const c = card(sentOut(47, 20_000));
    // The label: the truck and both words in one span that does not break or cut (it read "Outside …" at 1011 × 663).
    const label = /<span class="([^"]*)"><svg[^>]*lucide-truck[^>]*>.*?<\/svg>Outside rider<\/span>/.exec(c);
    expect(label).not.toBeNull();
    expect(label![1]).toContain('whitespace-nowrap');
    expect(label![1]).not.toContain('truncate');
    expect(c).not.toContain('truncate font-semibold">Outside');
    // Its row wraps what does not fit to the next line, the link on the right.
    const row = c.slice(c.lastIndexOf('<div', c.indexOf('lucide-truck')), c.indexOf('lucide-truck'));
    expect(row).toContain('flex flex-wrap items-center');
    expect(openingTag(buttonsWith(c, 'Assign rider')[0]!)).toContain('ml-auto');
  });

  it('he keeps nothing on a bill with its charge (one trip, one fee): "· already paid for this trip", as the paper says', () => {
    expect(text(card(sentOut(49, 0)))).toContain('Outside rider · out 12m · already paid for this trip Assign rider');
  });

  it('"· no delivery charge" when he keeps nothing and the bill has none', () => {
    expect(text(card(noChargeLine(sentOut(49, 0))))).toContain('Outside rider · out 12m · no delivery charge Assign rider');
  });

  it('an own rider’s Out card (e2e fixes B) is pinned in full, unpaid and paid, with no outside rider row', () => {
    const { cards } = board([
      delivery(44, 'out_for_delivery', {}, OWN_RIDER),
      delivery(45, 'out_for_delivery', { paidAt: minsAgo(30) }, OWN_RIDER),
    ]);
    expect(plainSpaces(cards.get('#0044')!)).toBe(OWN_RIDER_CARD.join(''));
    expect(sha256(cards.get('#0045')!)).toBe(PINNED_B.ownRiderPaid);
    for (const c of cards.values()) expect(text(c)).not.toContain('Outside rider');
  });

  it('a rider an older till named on a sent-out order shows as his row, not the outside one', () => {
    const c = card(delivery(50, 'out_for_delivery', { riderKeepsCents: 20_000 as never }, OWN_RIDER));
    expect(text(c)).toContain('Test Rider Change 03000000001 · out 12m');
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
    // The warning is also words in the box (a touch screen has no hover): what Back to Ready loses.
    expect(backToReadyNote(20_000)).toBe(
      'Back to Ready only if the rider has not left. If he went and came back, cancel the order instead, so he can be paid Rs 200 for the trip.',
    );
    expect(text(out)).toContain(backToReadyNote(20_000));
    expect(text(out).indexOf(backToReadyNote(20_000))).toBeGreaterThan(text(out).indexOf('Back to Ready'));
    // He keeps nothing: there is no trip to pay, so no such words.
    expect(text(dialog(sentOut(48, 0)))).not.toContain('so he can be paid');
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

  it('nothing kept on a bill with its charge (one trip, one fee): "already paid for this trip", as the paper says', () => {
    expect(panel(sentOut(49, 0)).customer).toContain('Outside rider · already paid for this trip');
  });

  it('nothing kept and no delivery charge on the bill', () => {
    expect(panel(noChargeLine(sentOut(49, 0))).customer).toContain('Outside rider · no delivery charge');
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
  /** What onPaidNow was handed (e2e fix A): the request and figures for Rider paid; nothing sent yet. */
  const handedOn: PaidNowAtSendOut[] = [];
  beforeEach(() => {
    sent.length = 0;
    handedOn.length = 0;
  });

  function box(snap: OrderSnapshot, chargeAgain = false): string {
    signIn('cashier');
    return text(
      render(
        <SendOutDialog
          snap={snap}
          chargeAgain={chargeAgain}
          onChargeAgain={() => seen.events.push('charge again')}
          onClose={() => seen.events.push('closed')}
          onSent={(next) => {
            seen.events.push('sent');
            sent.push(next);
          }}
          onPaidNow={(paidNow) => {
            seen.events.push('Paid now');
            handedOn.push(paidNow);
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

  it('"Pays after delivery" asks the till to send it out, then hands on the order as it went out', async () => {
    const out = ownerExample(42, 'out_for_delivery', { riderKeepsCents: 20_000 as never });
    seen.answer = out;
    box(ownerExample(42, 'ready'));
    tap('Pays after delivery');
    await settle();
    expect(seen.calls).toEqual([['orders.sendOut', { orderId: 'o42' }]]);
    expect(seen.events).toEqual(['orders.sendOut', 'sent']);
    expect(sent).toEqual([out]);
    expect(handedOn).toEqual([]);
    // Paid already: the same; the drawer is the till's part.
    seen.events.length = 0;
    seen.calls.length = 0;
    box(ownerExample(43, 'ready', { paidAt: minsAgo(30) }));
    tap('Send out · drawer opens');
    await settle();
    expect(seen.calls).toEqual([['orders.sendOut', { orderId: 'o43' }]]);
    expect(seen.events).toEqual(['orders.sendOut', 'sent']);
    expect(seen.toasts).toEqual([]);
  });

  // e2e fix A: the bill printed at Send out, before the rider paid, so its SHOP COPY said
  // "RIDER GIVES THE SHOP … NOT PAID". "Paid now" now sends nothing: Rider paid sends it out with his money.
  it('"Paid now" sends nothing: it hands Rider paid the request and what the box showed he keeps', async () => {
    box(ownerExample(42, 'ready'));
    tap('Paid now · Rs 4,515');
    await settle();
    expect(seen.calls).toEqual([]);
    expect(seen.events).toEqual(['Paid now']);
    expect(handedOn).toEqual([{ request: { orderId: 'o42' }, keepsCents: 20_000, tripCents: 0 }]);
    expect(sent).toEqual([]);
    expect(seen.toasts).toEqual([]);
    // No delivery charge on the bill: he keeps nothing and hands over the whole bill.
    handedOn.length = 0;
    seen.events.length = 0;
    box(noCharge(delivery(44, 'ready', { subtotalCents: toCents(390_000), taxCents: toCents(58_500), totalCents: toCents(448_500) })));
    tap('Paid now · Rs 4,485');
    await settle();
    expect(seen.calls).toEqual([]);
    expect(handedOn).toEqual([{ request: { orderId: 'o44' }, keepsCents: 0, tripCents: 0 }]);
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
  // Changed on purpose by e2e fix A: "Paid now" sent the order out first, so its bill printed
  // before the rider paid (SHOP COPY "RIDER GIVES THE SHOP … NOT PAID"). Now nothing is sent until
  // Rider paid sends it out with his money; its bill prints after (markDeliveredOutside.test.tsx).
  it('Send out on an unpaid delivery opens the box; "Paid now" sends nothing and opens "Rider paid · #0042" on the Ready order, with what the box showed', async () => {
    const ready = ownerExample(42, 'ready');
    const b = liveOrders([ready]);
    expect(b.words).not.toContain('Has the rider paid the shop?');
    b.press('Send out');
    expect(b.words).toContain('Send out #0042 The bill prints now · Test Customer');
    expect(b.words).toContain('Has the rider paid the shop? Paid now · Rs 4,515 Pays after delivery');
    expect(seen.calls).toEqual([]);

    b.press('Paid now · Rs 4,515');
    await settle();
    b.view();
    expect(seen.events).toEqual(['opened Rider paid']);
    expect(seen.calls).toEqual([]);
    expect(b.words).not.toContain('Has the rider paid the shop?');
    const riderPaid = stubs.deliver.at(-1) as DeliverProps;
    expect(riderPaid.snap).toBe(ready);
    expect(riderPaid.riderPaidOnly).toBe(true);
    expect(riderPaid.sendOutFirst).toEqual({ request: { orderId: 'o42' }, keepsCents: 20_000, tripCents: 0 });
    expect(seen.toasts).toEqual([]);

    // The real box, opened with exactly those: Rider paid, the food total from him; it goes out on Confirm.
    stubs.on = false;
    const words = text(render(<MarkDeliveredDialog {...riderPaid} />));
    expect(words).toContain('Rider paid · #0042 Test Customer · it goes out, then the bill prints');
    expect(words).toContain('Customer pays Rs 4,715 Rider keeps — delivery charge − Rs 200 Take from the rider Rs 4,515');
    expect(words).toContain('Pays after delivery Confirm');

    // Done (paid, or closed and sent out anyway): the box goes, the board asks again.
    stubs.on = true;
    riderPaid.onDone();
    const rendered = stubs.deliver.length;
    b.view();
    expect(stubs.deliver).toHaveLength(rendered);
  });

  it('the Paid now box closed by the board (its fallback refused): it goes, nothing more is asked', () => {
    const b = liveOrders([ownerExample(42, 'ready')]);
    b.press('Send out');
    b.press('Paid now · Rs 4,515');
    const riderPaid = stubs.deliver.at(-1) as DeliverProps;
    riderPaid.onClose();
    const rendered = stubs.deliver.length;
    b.view();
    expect(stubs.deliver).toHaveLength(rendered);
    expect(b.words).not.toContain('Has the rider paid the shop?');
    expect(seen.calls).toEqual([]);
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
    expect(seen.calls).toEqual([['orders.sendOut', { orderId: 'o45' }]]);
    expect(one.words).not.toContain('Send out #0045');

    seen.calls.length = 0;
    const two = liveOrders([ownerExample(43, 'ready', { paidAt: minsAgo(30) })]);
    two.press('Send out');
    expect(seen.calls).toEqual([]);
    expect(two.words).toContain('Paid already — give the rider Rs 200 from the drawer (his delivery charge). The drawer opens.');
    two.press('Send out · drawer opens');
    await settle();
    two.view();
    expect(seen.calls).toEqual([['orders.sendOut', { orderId: 'o43' }]]);
    expect(stubs.deliver).toEqual([]);
    expect(two.words).not.toContain('Paid already');
  });

  it('an unpaid outside Out card (e2e fixes B): amber "Rider owes Rs 4,515" is the last line of his box; [Rider paid] with Print and Cancel beside it, then Delivered + Pay alone on its line', () => {
    const c = card(ownerExample(47, 'out_for_delivery', { riderKeepsCents: 20_000 as never }));
    expect(text(c)).toContain('Outside rider · out 12m · keeps Rs 200 Assign rider Rider owes Rs 4,515 Rs 4,715 Rider paid Delivered + Pay');
    expect(text(c)).not.toContain('Not paid');
    // The chip: in the rider's box after Assign rider, never beside the total (there it took a second line).
    const box = c.slice(c.indexOf(OUT_RIDER_BOX), c.indexOf(OUT_TOTAL_ROW));
    expect(box.split(OUT_OWES_CHIP)).toHaveLength(2);
    expect(box.indexOf(OUT_OWES_CHIP)).toBeGreaterThan(box.indexOf('Assign rider'));
    expect(text(c.slice(c.indexOf(OUT_TOTAL_ROW), c.indexOf(OUT_SECOND_ROW)))).toBe('Rs 4,715');
    expect(c.split(OUT_OWES_CHIP)).toHaveLength(2);
    // [Rider paid] [Print] [Cancel] in one row, 40 px tall, the words in one line (77 px of a 157 px card at 1024 × 700).
    const row = c.slice(c.indexOf(OUT_SECOND_ROW), c.indexOf('Delivered + Pay'));
    const riderPaid = openingTag(buttonsWith(c, 'Rider paid')[0]!);
    for (const cls of ['h-10', 'min-w-0', 'flex-1', 'whitespace-nowrap', 'px-1', 'text-sm']) expect(riderPaid).toContain(cls);
    expect(riderPaid).not.toContain('w-full');
    expect(row.indexOf('Rider paid')).toBeLessThan(row.indexOf(ICONS_D));
    expect(iconLabels(row)).toEqual(['Print bill or receipt', 'Cancel order (manager approval)']);
    for (const b of row.split('<button type="button" aria-label=').slice(1)) expect(b).toContain('class="flex h-10 w-9 items-center justify-center');
    // Then Delivered + Pay, full width, its words in one line (beside the icons they took two), the card's last thing.
    const primary = openingTag(buttonsWith(c, 'Delivered + Pay')[0]!);
    for (const cls of ['mt-1', 'h-11', 'w-full', 'whitespace-nowrap', 'text-sm']) expect(primary).toContain(cls);
    expect(primary).not.toContain('leading-tight');
    expect(c.endsWith('Delivered + Pay</button>')).toBe(true);
    // A paid outside card and an own rider's card keep the one row they had, with no Rider paid row
    // (pinned elsewhere too; review fixes D made it the row whose icons drop under the button when narrow).
    const paid = card(ownerExample(52, 'out_for_delivery', { riderKeepsCents: 20_000 as never, paidAt: minsAgo(5) }));
    expect(paid).toContain(ROW_D);
    expect(paid).not.toContain(OUT_SECOND_ROW);
    // He keeps nothing: he owes the whole bill.
    expect(text(card(ownerExample(49, 'out_for_delivery', { riderKeepsCents: 0 as never })))).toContain('Rider owes Rs 4,715 Rs 4,715');
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
      expect(text(c)).toContain('Rs 4,715 Paid Delivered');
      expect(text(c)).not.toContain('items');
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
    expect(text(cards.get('#0044')!)).toContain('Rs 4,715 Not paid Delivered + Pay');
  });

  it('a rider an older till named on a sent-out order: the money still goes by what the till froze', () => {
    // The Delivered box takes the food total for this order too (MarkDeliveredDialog follows the till).
    const c = card(ownerExample(50, 'out_for_delivery', { riderKeepsCents: 20_000 as never }, OWN_RIDER));
    expect(text(c)).toContain('Test Rider Change 03000000001 · out 12m Rider owes Rs 4,515 Rs 4,715');
    expect(c.slice(c.indexOf(OUT_RIDER_BOX), c.indexOf(OUT_TOTAL_ROW))).toContain(OUT_OWES_CHIP);
    expect(buttonsWith(c, 'Rider paid')).toHaveLength(1);
  });
});

describe('one trip, one fee (step 18-9): the rider was already paid on a refunded order of this customer', () => {
  /** The order refunded in full while still on its trip: the drawer paid the rider Rs 200 on it. */
  const EARLIER = { orderId: 'o41', orderNumber: '20261001-0041', amountCents: 20_000 } as unknown as NonNullable<
    OrderSnapshot['riderPaidEarlier']
  >;
  /** The owner's example rung again and Ready, for the same customer. */
  const reRung = (n: number, over: Partial<OrderSnapshot['order']> = {}): OrderSnapshot =>
    ({ ...ownerExample(n, 'ready', over), riderPaidEarlier: EARLIER }) as OrderSnapshot;

  function box(snap: OrderSnapshot, chargeAgain = false): string {
    signIn('cashier');
    return text(
      render(
        <SendOutDialog
          snap={snap}
          chargeAgain={chargeAgain}
          onChargeAgain={() => seen.events.push('charge again')}
          onClose={() => seen.events.push('closed')}
          onSent={() => seen.events.push('sent')}
          onPaidNow={(paidNow) => {
            seen.events.push('Paid now');
            handedOn.push(paidNow);
          }}
          onAssignInstead={() => seen.events.push('assign instead')}
        />,
      ),
    );
  }
  const button = (words: string) => seen.buttons.find((b) => b.words === words);
  /** What "Paid now" handed on (it sends nothing itself: e2e fix A). */
  const handedOn: PaidNowAtSendOut[] = [];
  beforeEach(() => {
    handedOn.length = 0;
  });

  it('not paid: "The rider already kept Rs 200 on #0041." and, by default, no delivery charge for him: Rs 0, he gives the shop the whole bill', () => {
    expect(box(reRung(42))).toBe(
      'Send out #0042 The bill prints now · Test Customer ' +
        'The rider already kept Rs 200 on #0041. No delivery charge for him this time Charge again ' +
        'Customer pays the rider Rs 4,715 Rider keeps Rs 0 Rider gives the shop Rs 4,715 ' +
        'Has the rider paid the shop? Paid now · Rs 4,715 Pays after delivery ' +
        'One of your own riders? Assign rider instead',
    );
    expect(seen.buttons.map((b) => b.words)).toEqual(['Charge again', 'Paid now · Rs 4,715', 'Pays after delivery']);
    expect(button('Charge again')).toMatchObject({ variant: 'ghost', autoFocus: undefined });
    // Enter still means "Pays after delivery".
    expect(button('Pays after delivery')).toMatchObject({ autoFocus: true });
  });

  it('"Charge again" only tells the board (nothing is sent); then the order’s own figures and "He keeps Rs 200 on this order too."', () => {
    box(reRung(42));
    tap('Charge again');
    expect(seen.events).toEqual(['charge again']);
    expect(seen.calls).toEqual([]);
    expect(box(reRung(42), true)).toBe(
      'Send out #0042 The bill prints now · Test Customer ' +
        'The rider already kept Rs 200 on #0041. He keeps Rs 200 on this order too. ' +
        'Customer pays the rider Rs 4,715 Rider keeps (delivery charge) Rs 200 Rider gives the shop Rs 4,515 ' +
        'Has the rider paid the shop? Paid now · Rs 4,515 Pays after delivery ' +
        'One of your own riders? Assign rider instead',
    );
    expect(seen.buttons.map((b) => b.words)).toEqual(['Paid now · Rs 4,515', 'Pays after delivery']);
  });

  it('paid already: nothing comes out of the drawer this time; after Charge again the drawer gives him Rs 200 and opens', () => {
    const paid = reRung(43, { paidAt: minsAgo(30) });
    expect(box(paid)).toBe(
      'Send out #0043 The bill prints now · Test Customer ' +
        'The rider already kept Rs 200 on #0041. No delivery charge for him this time Charge again ' +
        'Paid already — nothing comes out of the drawer this time. Send out ' +
        'One of your own riders? Assign rider instead',
    );
    expect(seen.buttons.map((b) => b.words)).toEqual(['Charge again', 'Send out']);
    expect(button('Send out')).toMatchObject({ autoFocus: true });
    expect(box(paid, true)).toBe(
      'Send out #0043 The bill prints now · Test Customer ' +
        'The rider already kept Rs 200 on #0041. He keeps Rs 200 on this order too. ' +
        'Paid already — give the rider Rs 200 from the drawer (his delivery charge). The drawer opens. Send out · drawer opens ' +
        'One of your own riders? Assign rider instead',
    );
  });

  it('the request says riderAlreadyPaid true by default and false after Charge again, for every answer (Paid now hands it on to Rider paid)', async () => {
    for (const [snap, chargeAgain, words] of [
      [reRung(42), false, 'Pays after delivery'],
      [reRung(42), false, 'Paid now · Rs 4,715'],
      [reRung(42), true, 'Pays after delivery'],
      [reRung(42), true, 'Paid now · Rs 4,515'],
      [reRung(43, { paidAt: minsAgo(30) }), false, 'Send out'],
      [reRung(43, { paidAt: minsAgo(30) }), true, 'Send out · drawer opens'],
    ] as const) {
      seen.calls.length = 0;
      handedOn.length = 0;
      box(snap, chargeAgain);
      tap(words);
      await settle();
      const request = { orderId: snap.order.id, riderAlreadyPaid: !chargeAgain };
      if (words.startsWith('Paid now')) {
        expect(seen.calls).toEqual([]);
        expect(handedOn).toEqual([{ request, keepsCents: chargeAgain ? 20_000 : 0, tripCents: 0 }]);
      } else {
        expect(seen.calls).toEqual([['orders.sendOut', request]]);
      }
    }
  });

  it('a bill with no delivery charge: nothing to choose — the box and the request read exactly as before', async () => {
    const plain = noCharge(delivery(44, 'ready', { subtotalCents: toCents(390_000), taxCents: toCents(58_500), totalCents: toCents(448_500) }));
    const before = box(plain);
    const withEarlier = { ...plain, riderPaidEarlier: EARLIER } as OrderSnapshot;
    expect(box(withEarlier)).toBe(before);
    expect(box(withEarlier)).not.toContain('already kept');
    tap('Pays after delivery');
    await settle();
    expect(seen.calls).toEqual([['orders.sendOut', { orderId: 'o44' }]]);
    // None found (null): as before too.
    expect(box({ ...ownerExample(42, 'ready'), riderPaidEarlier: null } as OrderSnapshot)).toBe(box(ownerExample(42, 'ready')));
  });

  it('on Live Orders: Send out opens on no charge; Charge again switches the figures; closed and opened again it starts on no charge; Paid now hands Rider paid riderAlreadyPaid false', async () => {
    const ready = reRung(42);
    const b = liveOrders([ready]);
    b.press('Send out');
    expect(b.words).toContain(
      'The rider already kept Rs 200 on #0041. No delivery charge for him this time Charge again ' +
        'Customer pays the rider Rs 4,715 Rider keeps Rs 0 Rider gives the shop Rs 4,715',
    );
    b.press('Charge again');
    expect(seen.calls).toEqual([]);
    expect(b.words).toContain(
      'The rider already kept Rs 200 on #0041. He keeps Rs 200 on this order too. ' +
        'Customer pays the rider Rs 4,715 Rider keeps (delivery charge) Rs 200 Rider gives the shop Rs 4,515',
    );
    b.esc();
    expect(b.words).not.toContain('already kept');
    b.press('Send out');
    expect(b.words).toContain('No delivery charge for him this time Charge again');
    b.press('Charge again');
    b.press('Paid now · Rs 4,515');
    await settle();
    b.view();
    expect(seen.calls).toEqual([]);
    expect(seen.events).toEqual(['opened Rider paid']);
    const riderPaid = stubs.deliver.at(-1) as DeliverProps;
    expect(riderPaid.snap).toBe(ready);
    expect(riderPaid.sendOutFirst).toEqual({ request: { orderId: 'o42', riderAlreadyPaid: false }, keepsCents: 20_000, tripCents: 0 });
  });

  it('on Live Orders, the default: "Paid now · Rs 4,715" hands Rider paid riderAlreadyPaid true and the whole bill; a paid one asks too and opens no drawer', async () => {
    const ready = reRung(42);
    const b = liveOrders([ready]);
    b.press('Send out');
    b.press('Paid now · Rs 4,715');
    await settle();
    b.view();
    expect(seen.calls).toEqual([]);
    const riderPaid = stubs.deliver.at(-1) as DeliverProps;
    expect(riderPaid).toMatchObject({
      snap: ready,
      riderPaidOnly: true,
      sendOutFirst: { request: { orderId: 'o42', riderAlreadyPaid: true }, keepsCents: 0, tripCents: 0 },
    });
    // The real Rider paid box on the Ready order: he keeps nothing and hands over the whole bill.
    stubs.on = false;
    const words = text(render(<MarkDeliveredDialog {...riderPaid} />));
    expect(words).toContain('Rider keeps nothing (already paid for this trip) Take from the rider Rs 4,715');

    seen.calls.length = 0;
    const p = liveOrders([reRung(43, { paidAt: minsAgo(30) })]);
    p.press('Send out');
    expect(seen.calls).toEqual([]);
    expect(p.words).toContain('Paid already — nothing comes out of the drawer this time.');
    p.press('Send out');
    await settle();
    expect(seen.calls).toEqual([['orders.sendOut', { orderId: 'o43', riderAlreadyPaid: true }]]);
  });
});

describe('add-on delivery (step 18-11): Send out names the same customer’s other delivery', () => {
  /** #0042, the first delivery of the same customer (the same made-up phone), sent before the add-on. */
  const first = (status: OrderStatus, over: Partial<OrderSnapshot['order']> = {}) =>
    delivery(42, status, { sentAt: minsAgo(45), createdAt: minsAgo(46), ...over });
  /** #0045, the add-on: rung while #0042 was still in the shop, so the till left its delivery charge off. */
  const addOn = (over: Partial<OrderSnapshot['order']> = {}) =>
    noCharge(delivery(45, 'ready', { subtotalCents: toCents(390_000), taxCents: toCents(58_500), totalCents: toCents(448_500), ...over }));

  function box(snap: OrderSnapshot, sameCustomer?: Parameters<typeof SendOutDialog>[0]['sameCustomer']): string {
    signIn('cashier');
    return text(
      render(
        <SendOutDialog
          snap={snap}
          chargeAgain={false}
          onChargeAgain={() => seen.events.push('charge again')}
          onClose={() => seen.events.push('closed')}
          onSent={() => seen.events.push('sent')}
          onPaidNow={() => seen.events.push('Paid now')}
          onAssignInstead={() => seen.events.push('assign instead')}
          {...(sameCustomer !== undefined ? { sameCustomer } : {})}
        />,
      ),
    );
  }
  const STILL_HERE = { orderId: 'o42', orderNumber: '20261001-0042', out: false };
  const GONE = { orderId: 'o42', orderNumber: '20261001-0042', out: true };

  it('#0042 still in the shop: "Same customer as #0042 — send them together." above the money, word for word', () => {
    expect(box(addOn(), STILL_HERE)).toBe(
      'Send out #0045 The bill prints now · Test Customer ' +
        'Same customer as #0042 — send them together. ' +
        'Customer pays the rider Rs 4,485 No delivery charge on this bill Rider gives the shop Rs 4,485 ' +
        'Has the rider paid the shop? Paid now · Rs 4,485 Pays after delivery ' +
        'One of your own riders? Assign rider instead',
    );
    // A charged order of the same customer (a website one keeps its fee): the same line.
    expect(box(ownerExample(43, 'ready'), STILL_HERE)).toContain(
      'Same customer as #0042 — send them together. Customer pays the rider Rs 4,715 Rider keeps (delivery charge) Rs 200',
    );
  });

  it('#0042 already out, and no delivery charge on this one: the amber “has already gone out” line', () => {
    const markup = render(
      <SendOutDialog
        snap={addOn()}
        sameCustomer={GONE}
        chargeAgain={false}
        onChargeAgain={() => {}}
        onClose={() => {}}
        onSent={() => {}}
        onPaidNow={() => {}}
        onAssignInstead={() => {}}
      />,
    );
    expect(text(markup)).toBe(
      'Send out #0045 The bill prints now · Test Customer ' +
        'No delivery charge on this order: #0042 has already gone out. ' +
        'Customer pays the rider Rs 4,485 No delivery charge on this bill Rider gives the shop Rs 4,485 ' +
        'Has the rider paid the shop? Paid now · Rs 4,485 Pays after delivery ' +
        'One of your own riders? Assign rider instead',
    );
    expect(markup).toContain('ring-amber-300');
  });

  it('#0042 already out and this order is charged: no line (a new trip); none at all: the box as before', () => {
    const charged = ownerExample(43, 'ready');
    expect(box(charged, GONE)).toBe(box(charged));
    expect(box(charged, null)).toBe(box(charged));
    expect(box(addOn(), null)).toBe(box(addOn()));
    expect(box(charged)).not.toContain('Same customer');
  });

  it('the answers send it out as before: the line changes nothing in the request', async () => {
    box(addOn(), STILL_HERE);
    tap('Pays after delivery');
    await settle();
    expect(seen.calls).toEqual([['orders.sendOut', { orderId: 'o45' }]]);
  });

  it('on Live Orders: "send them together" only while #0042 is New, Preparing or Ready', () => {
    for (const status of ['sent_to_kitchen', 'preparing', 'ready'] as const) {
      const b = liveOrders([first(status), addOn()]);
      b.press('Send out');
      expect(b.words).toContain('Send out #0045 The bill prints now · Test Customer Same customer as #0042 — send them together.');
      b.esc();
    }
    // Out for delivery: the add-on with no charge says it has gone out; nothing about sending them together.
    const out = liveOrders([first('out_for_delivery', { riderKeepsCents: 20_000 as never }), addOn()]);
    out.press('Send out');
    expect(out.words).toContain('Send out #0045 The bill prints now · Test Customer No delivery charge on this order: #0042 has already gone out.');
    expect(out.words).not.toContain('send them together');
    expect(seen.calls).toEqual([]);
  });

  it('on Live Orders: a charged order whose first is out shows no line; another customer’s delivery never counts', () => {
    const charged = liveOrders([first('out_for_delivery', { riderKeepsCents: 20_000 as never }), ownerExample(43, 'ready')]);
    charged.press('Send out');
    expect(charged.words).toContain('Send out #0043 The bill prints now · Test Customer Customer pays the rider Rs 4,715');
    expect(charged.words).not.toContain('Same customer');
    expect(charged.words).not.toContain('already gone out');

    const other = { ...first('preparing'), customerPhone: '03017654321' } as OrderSnapshot;
    const b = liveOrders([other, addOn()]);
    b.press('Send out');
    expect(b.words).toContain('Send out #0045 The bill prints now · Test Customer Customer pays the rider Rs 4,485');
    expect(b.words).not.toContain('Same customer');
  });

  it('a prepaid add-on with no charge opens the box instead of going in one tap; with no other delivery it is still one tap', async () => {
    const paid = addOn({ paidAt: minsAgo(30) });
    const b = liveOrders([first('preparing'), paid]);
    b.press('Send out');
    await settle();
    expect(seen.calls).toEqual([]);
    expect(b.words).toContain(
      'Send out #0045 The bill prints now · Test Customer Same customer as #0042 — send them together. ' +
        'Paid already, and no delivery charge: nothing comes out of the drawer. Send out',
    );
    // #0042 gone out: the box opens on the amber line too.
    const gone = liveOrders([first('out_for_delivery', { riderKeepsCents: 20_000 as never }), paid]);
    gone.press('Send out');
    await settle();
    expect(seen.calls).toEqual([]);
    expect(gone.words).toContain('No delivery charge on this order: #0042 has already gone out. Paid already, and no delivery charge');

    // Alone on the board: one tap, as before.
    const alone = liveOrders([paid]);
    alone.press('Send out');
    await settle();
    expect(seen.calls).toEqual([['orders.sendOut', { orderId: 'o45' }]]);
  });
});

describe('an add-on that now goes alone (review fixes C): "#0042 is no longer here", and the trip tick', () => {
  /** #0042, the delivery the add-on went with: cancelled, refunded or delivered before #0045 went out. */
  const ALONE = { orderId: 'o42', orderNumber: '20261001-0042', feeCents: 20_000 } as unknown as NonNullable<OrderSnapshot['goesAlone']>;
  /** #0045, the add-on: its delivery charge left off for #0042, Ready. */
  const alone = (over: Partial<OrderSnapshot['order']> = {}, goesAlone: OrderSnapshot['goesAlone'] = ALONE) =>
    ({
      ...noCharge(delivery(45, 'ready', { subtotalCents: toCents(390_000), taxCents: toCents(58_500), totalCents: toCents(448_500), ...over })),
      goesAlone,
    }) as OrderSnapshot;
  const LINE = '#0042 is no longer here: this order goes alone with no delivery charge.';
  const TICK = 'Pay the rider Rs 200 for this trip';
  const PIN_WORDS = 'The drawer opens to pay him. A manager’s PIN or password is needed.';

  function box(
    snap: OrderSnapshot,
    more: { payTrip?: boolean; pin?: string; sameCustomer?: Parameters<typeof SendOutDialog>[0]['sameCustomer'] } = {},
  ): string {
    signIn('cashier');
    return render(
      <SendOutDialog
        snap={snap}
        chargeAgain={false}
        onChargeAgain={() => seen.events.push('charge again')}
        onClose={() => seen.events.push('closed')}
        onSent={() => seen.events.push('sent')}
        onPaidNow={(paidNow) => {
          seen.events.push('Paid now');
          seen.calls.push(['handed to Rider paid', paidNow]);
        }}
        onAssignInstead={() => seen.events.push('assign instead')}
        onPayTrip={(on) => seen.events.push(on ? 'ticked' : 'unticked')}
        onPin={(pin) => seen.events.push(`pin ${pin}`)}
        {...(more.payTrip !== undefined ? { payTrip: more.payTrip } : {})}
        {...(more.pin !== undefined ? { pin: more.pin } : {})}
        {...(more.sameCustomer !== undefined ? { sameCustomer: more.sameCustomer } : {})}
      />,
    );
  }
  /** The open box's tick, and its PIN box (the stand-in), as rendered. */
  const tick = () => [...walk(seen.content)].find((e) => e.type === 'input' && e.props['type'] === 'checkbox');
  const pinBox = () => [...walk(seen.content)].find((e) => e.props['aria-label'] === 'Manager PIN or password');

  it('not ticked to start: the amber line and the tick, word for word; no PIN box; the answers ask nothing about a trip', async () => {
    const markup = box(alone());
    expect(text(markup)).toBe(
      'Send out #0045 The bill prints now · Test Customer ' +
        `${LINE} ${TICK} ` +
        'Customer pays the rider Rs 4,485 No delivery charge on this bill Rider gives the shop Rs 4,485 ' +
        'Has the rider paid the shop? Paid now · Rs 4,485 Pays after delivery ' +
        'One of your own riders? Assign rider instead',
    );
    expect(markup).toContain('ring-amber-300');
    expect(markup).toContain('type="checkbox"');
    expect(markup).not.toContain('checked=""');
    expect(pinBox()).toBeUndefined();
    tap('Pays after delivery');
    await settle();
    expect(seen.calls).toEqual([['orders.sendOut', { orderId: 'o45' }]]);
    expect(seen.toasts).toEqual([]);
    expect(seen.events).toEqual(['orders.sendOut', 'sent']);
  });

  it('the tick and the PIN only tell the board (nothing is sent); ticked, the PIN box and its words show', () => {
    box(alone());
    (tick()!.props['onChange'] as (e: unknown) => void)({ target: { checked: true } });
    expect(seen.events).toEqual(['ticked']);

    const markup = box(alone(), { payTrip: true, pin: '' });
    expect(text(markup)).toContain(`${LINE} ${TICK} ${PIN_WORDS}`);
    expect(markup).toContain('checked=""');
    (pinBox()!.props['onChange'] as (next: string) => void)('2468');
    (tick()!.props['onChange'] as (e: unknown) => void)({ target: { checked: false } });
    expect(seen.events).toEqual(['ticked', 'pin 2468', 'unticked']);
    expect(seen.calls).toEqual([]);
  });

  it('ticked with no PIN typed: nothing is sent, nothing is handed on, and the toast says a PIN is needed', async () => {
    for (const answer of ['Pays after delivery', 'Paid now · Rs 4,485']) {
      seen.calls.length = 0;
      seen.toasts.length = 0;
      box(alone(), { payTrip: true, pin: '   ' });
      tap(answer);
      await settle();
      expect(seen.calls).toEqual([]);
      expect(seen.toasts).toEqual([{ title: "A manager's PIN or password is needed", variant: 'warning' }]);
    }
  });

  it('ticked with the PIN: Pays after delivery asks the till to pay the trip (the toast says the drawer opens); Paid now hands the same request and the trip on to Rider paid', async () => {
    const request = { orderId: 'o45', payRiderForTrip: true, approverPin: '2468' };
    box(alone(), { payTrip: true, pin: ' 2468 ' });
    tap('Pays after delivery');
    await settle();
    expect(seen.calls).toEqual([['orders.sendOut', request]]);
    expect(seen.toasts).toEqual([{ title: 'Rider paid Rs 200 for the trip — the drawer opens.', variant: 'success' }]);
    expect(seen.events).toEqual(['orders.sendOut', 'sent']);

    seen.calls.length = 0;
    seen.toasts.length = 0;
    seen.events.length = 0;
    box(alone(), { payTrip: true, pin: ' 2468 ' });
    tap('Paid now · Rs 4,485');
    await settle();
    // Nothing sent yet: Rider paid sends it, and toasts the trip once it went.
    expect(seen.calls).toEqual([['handed to Rider paid', { request, keepsCents: 0, tripCents: 20_000 }]]);
    expect(seen.toasts).toEqual([]);
    expect(seen.events).toEqual(['Paid now']);
    // Prepaid: the one button says the drawer opens only while ticked.
    expect(text(box(alone({ paidAt: minsAgo(30) })))).toContain(
      'Paid already, and no delivery charge: nothing comes out of the drawer. Send out One of',
    );
    expect(text(box(alone({ paidAt: minsAgo(30) }), { payTrip: true, pin: '2468' }))).toContain(
      'Paid already, and no delivery charge: nothing comes out of the drawer. Send out · drawer opens',
    );
  });

  it('no line and no tick while another delivery of this customer is still in the shop (they go together), or the bill has a charge; no tick when no fee was recorded', () => {
    const STILL_HERE = { orderId: 'o44', orderNumber: '20261001-0044', out: false };
    const together = text(box(alone(), { sameCustomer: STILL_HERE }));
    expect(together).toContain('Same customer as #0044 — send them together.');
    expect(together).not.toContain('no longer here');
    expect(together).not.toContain(TICK);
    // One of them already out: this order still goes alone — its line in place of "has already gone out".
    const out = text(box(alone(), { sameCustomer: { ...STILL_HERE, out: true } }));
    expect(out).toContain(`${LINE} ${TICK}`);
    expect(out).not.toContain('already gone out');
    // A charge on the bill: the bill pays this trip.
    const charged = { ...ownerExample(43, 'ready'), goesAlone: ALONE } as OrderSnapshot;
    expect(text(box(charged))).not.toContain('no longer here');
    // No fee recorded: the words, and nothing to tick.
    const noFee = text(box(alone({}, { ...ALONE, feeCents: 0 as never })));
    expect(noFee).toContain(LINE);
    expect(noFee).not.toContain(TICK);
    // Nothing going alone: the box as before.
    expect(text(box(alone({}, null)))).not.toContain('no longer here');
  });

  it('on Live Orders: a prepaid add-on going alone opens the box (not one tap); ticked with the PIN, Send out pays the trip; unticked, the PIN typed goes', async () => {
    const b = liveOrders([alone({ paidAt: minsAgo(30) })]);
    b.press('Send out');
    await settle();
    expect(seen.calls).toEqual([]);
    expect(b.words).toContain(`Send out #0045 The bill prints now · Test Customer ${LINE} ${TICK} Paid already`);

    const tickIt = (on: boolean) => {
      (tick()!.props['onChange'] as (e: unknown) => void)({ target: { checked: on } });
      b.view();
    };
    const typePin = (pin: string) => {
      (pinBox()!.props['onChange'] as (next: string) => void)(pin);
      b.view();
    };
    tickIt(true);
    expect(b.words).toContain(PIN_WORDS);
    typePin('2468');
    expect(pinBox()!.props['value']).toBe('2468');
    // Unticked, the PIN goes with it; ticked again, it is empty.
    tickIt(false);
    expect(b.words).not.toContain(PIN_WORDS);
    tickIt(true);
    expect(pinBox()!.props['value']).toBe('');
    typePin('2468');
    b.press('Send out · drawer opens');
    await settle();
    expect(seen.calls).toEqual([['orders.sendOut', { orderId: 'o45', payRiderForTrip: true, approverPin: '2468' }]]);
  });

  it('on Live Orders, nothing ticked: Pays after delivery sends it out with nothing about a trip', async () => {
    const b = liveOrders([alone()]);
    b.press('Send out');
    b.press('Pays after delivery');
    await settle();
    expect(seen.calls).toEqual([['orders.sendOut', { orderId: 'o45' }]]);
  });

  it('Assign rider (one of the shop’s own riders): only the words — nothing to tick, nothing paid', () => {
    signIn('cashier');
    const words = text(render(<AssignRiderDialog snap={alone()} onClose={() => {}} onAssigned={() => {}} />));
    expect(words).toContain(`Order #0045 · Test Customer ${LINE}`);
    expect(words).not.toContain('Pay the rider');
    // Another delivery of this customer still in the shop: no line.
    const together = text(
      render(
        <AssignRiderDialog
          snap={alone()}
          sameCustomer={{ orderId: 'o44', orderNumber: '20261001-0044', out: false }}
          onClose={() => {}}
          onAssigned={() => {}}
        />,
      ),
    );
    expect(together).not.toContain('no longer here');
    // Live Orders hands it the same customer's other delivery, read as the board is now.
    const b = liveOrders([delivery(44, 'preparing'), alone()]);
    b.press('Send out');
    b.tapInBox('One of your own riders? Assign rider instead');
    expect((stubs.assign.at(-1) as { sameCustomer?: unknown }).sameCustomer).toEqual({ orderId: 'o44', orderNumber: '20261001-0044', out: false });
  });
});

// ---------------------------------------------------------------------------
// Review fixes D: a card's last row with no "Rider paid" above it. At the
// till's narrowest window (1011 × 663, a 172 px card) a kitchen or Ready
// card's [Start preparing] [kitchen ticket] [Print] [Cancel] needed about
// 270 px (measured in Chrome with the till's own CSS): Cancel was cut off and
// the column scrolled sideways; so did an own rider's [Delivered + Pay]
// [Print] [Cancel]. Now the icons are one group that never shrinks and goes
// under the button, on the right, when the two don't fit side by side (there
// the button takes the whole width); a wide window keeps the one row.

/** The row (flex-wrap: the icons may go to a line of their own). */
const ROW_D = '<div class="mt-2 flex flex-wrap items-center gap-1">';
/** The icons' group: pushed to the right, never squeezed. */
const ICONS_D = '<div class="ml-auto flex shrink-0 items-center gap-1">';
/** The row as it was before review fixes D (one row, the icons squeezed then cut off). */
const ROW_BEFORE_D = '<div class="mt-2 flex items-center gap-1">';

/** A card's last row, from the row's own tag to the card's end: [the big button][the icons' group]. */
function lastRowD(card: string): { primary: string; group: string } {
  expect(card.split(ROW_D)).toHaveLength(2);
  expect(card.split(ICONS_D)).toHaveLength(2);
  const row = card.slice(card.indexOf(ROW_D) + ROW_D.length);
  const at = row.indexOf(ICONS_D);
  // The row and the group close together at the card's end.
  expect(row.endsWith('</div></div>')).toBe(true);
  return { primary: row.slice(0, at), group: row.slice(at + ICONS_D.length, -'</div></div>'.length) };
}

/** The card with review fixes D's change taken back out: the row as it was, the icons straight in it. */
function undoRowD(card: string): string {
  lastRowD(card);
  return card.replace(ROW_D, ROW_BEFORE_D).replace(ICONS_D, '').replace(/<\/div><\/div>$/, '</div>');
}

/** The aria-labels of the icon buttons in this markup, in order. */
const iconLabels = (markup: string) => [...markup.matchAll(/<button type="button" aria-label="([^"]+)"/g)].map((m) => m[1]);

/** v0.7.36's Edit order icon (the pencil): first in the icons' group of an unpaid order the kitchen has. */
const EDIT_ICON = 'Edit order (add or take off items)';
/** The card with v0.7.36's Edit order icon taken back out. */
const undoEditIcon = (card: string) => card.replace(/<button type="button" aria-label="Edit order \(add or take off items\)".*?<\/button>/, '');

describe('a card’s last row fits the narrowest window (review fixes D): the icons go under the button when they must', () => {
  const KITCHEN = ['Reprint kitchen ticket', 'Print bill or receipt', 'Cancel order (manager approval)'];
  // v0.7.36: an unpaid order the kitchen has can be changed — its pencil first (four icons fit the narrowest card).
  const EDITABLE = [EDIT_ICON, ...KITCHEN];
  const PLAIN = ['Print bill or receipt', 'Cancel order (manager approval)'];
  const PAID = ['Print bill or receipt', 'Refund order (manager approval)'];
  const CASES: Array<[string, string, OrderSnapshot, string[]]> = [
    ['New (sent to the kitchen)', 'Start preparing', delivery(41, 'sent_to_kitchen'), EDITABLE],
    ['Preparing', 'Mark ready', delivery(43, 'preparing'), EDITABLE],
    ['a Ready delivery', 'Send out', delivery(42, 'ready'), EDITABLE],
    ['a Ready takeaway, unpaid', 'Picked up + Pay', delivery(46, 'ready', {}, null, 'takeaway'), EDITABLE],
    ['a Ready takeaway, paid', 'Picked up', delivery(48, 'ready', { paidAt: minsAgo(30) }, null, 'takeaway'), ['Reprint kitchen ticket', ...PAID]],
    ['an own rider’s Out card, unpaid', 'Delivered + Pay', delivery(44, 'out_for_delivery', {}, OWN_RIDER), PLAIN],
    ['an own rider’s Out card, paid', 'Delivered', delivery(45, 'out_for_delivery', { paidAt: minsAgo(30) }, OWN_RIDER), PAID],
    ['an outside rider’s Out card, paid', 'Delivered', sentOut(52, 20_000, { paidAt: minsAgo(5) }), PAID],
  ];

  it.each(CASES)('%s: [%s] then one group of every icon, on the right, never squeezed', (_name, words, snap, icons) => {
    const c = card(snap);
    const { primary, group } = lastRowD(c);
    // The big button first, alone before the group: its words in one line, taking the row's free width.
    expect(primary.split('<button')).toHaveLength(2);
    expect(text(primary)).toBe(words);
    const tag = openingTag(primary);
    for (const cls of ['h-11', 'flex-1', 'whitespace-nowrap', 'text-sm']) expect(tag).toContain(cls);
    // No min-w-0: the button's own width is what sends the group to the next line when both don't fit.
    expect(tag).not.toContain('min-w-0');
    expect(iconLabels(primary)).toEqual([]);
    // Every icon in the group, in order, and nothing else in it.
    expect(iconLabels(group)).toEqual(icons);
    expect(group.split('<button')).toHaveLength(icons.length + 1);
    for (const b of group.split('<button').slice(1)) expect(b).toContain('class="flex h-11 w-9 items-center justify-center');
    // The row wraps; the group is pushed right and keeps its size.
    expect(c).toContain(ROW_D);
    expect(c).toContain(ICONS_D);
  });

  it('only the last row changed: with the change taken out, the card is the one before it, byte for byte (pinned below too)', () => {
    const c = card(delivery(41, 'sent_to_kitchen'));
    // v0.7.36's pencil taken out first: the rest is the card as review fixes D left it.
    expect(iconLabels(c)[0]).toBe(EDIT_ICON);
    const before = undoRowD(undoEditIcon(c));
    expect(before).not.toContain(ROW_D);
    expect(before).not.toContain(ICONS_D);
    expect(before.indexOf(ROW_BEFORE_D)).toBeGreaterThan(0);
    // The big button and the three icons straight in the old row, as before.
    const oldRow = before.slice(before.indexOf(ROW_BEFORE_D));
    expect(iconLabels(oldRow)).toEqual(KITCHEN);
    expect(text(oldRow)).toBe('Start preparing');
  });

  it('a card with "Rider paid" (e2e fixes B): not this row — Rider paid and the icons’ group share one, the big button is alone under it', () => {
    const c = card(ownerExample(47, 'out_for_delivery', { riderKeepsCents: 20_000 as never }));
    expect(c).not.toContain(ROW_D);
    expect(c.split(ICONS_D)).toHaveLength(2);
    const row = c.slice(c.indexOf(OUT_SECOND_ROW));
    expect(iconLabels(row)).toEqual(PLAIN);
    expect(text(row)).toBe('Rider paid Delivered + Pay');
  });
});

// ---------------------------------------------------------------------------
// E2e fixes B (2 Oct 2026): Out cards fit the Out column at the till's
// narrowest window. Measured in Chrome with the till's own compiled CSS and a
// stand-in app shell (Inter and the system font): at 1011 × 663 inside the
// column is 435 px tall and a card 162 px wide inside (172 with no scroll
// bar); a 1024 × 700 page gives 420 by 157. An outside rider's owing card was
// 493 px ("Rider paid" cut, "Delivered + Pay" below the fold and on two
// lines); a paid one 492, an own rider's 438. Now 395, 379 and 364 (409 with
// five lines of food, a long address and an hour out), at both sizes, with
// every button's words on one line and nothing sticking out sideways. These
// pin the markup that measured so.

/** The food on an Out card: one paragraph, two lines at most. */
const OUT_ITEMS = '<p class="line-clamp-2 text-sm leading-snug text-stone-700 dark:text-stone-300">';
/** Phone, address and rider on an Out card. */
const OUT_CONTACT = '<div class="mt-1.5 space-y-1 rounded-lg bg-stone-50 px-2 py-1.5 text-xs dark:bg-stone-900/60">';
/** A rider's box (one of the shop's own, or the outside rider). */
const OUT_RIDER_BOX =
  '<div class="space-y-1 rounded-md bg-violet-50 px-1.5 py-1 leading-tight text-violet-800 dark:bg-violet-950/40 dark:text-violet-200">';
/** An Out card's total row: the bill, and PAID / NOT PAID unless the rider's box says what he owes. */
const OUT_TOTAL_ROW = '<div class="mt-1.5 flex items-center gap-2 border-t border-stone-100 pt-1.5 dark:border-stone-700">';
/** [Rider paid] [Print] [Cancel]. */
const OUT_SECOND_ROW = '<div class="mt-1.5 flex items-center gap-1">';
/** "Rider owes Rs 4,515", amber. */
const OUT_OWES_CHIP =
  '<span class="inline-flex items-center whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-900 dark:bg-amber-950 dark:text-amber-200">Rider owes Rs 4,515</span>';
/** The Delivery badge every other card has. */
const DELIVERY_BADGE = 'uppercase ring-1 bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950/50 dark:text-violet-200 dark:ring-violet-800">Delivery</span>';

/** Six made-up lines of food (and the delivery charge). */
const sixLines = (s: OrderSnapshot): OrderSnapshot =>
  ({
    ...s,
    items: ['Test Family Pizza', 'Test Fries', 'Test Garlic Bread', 'Test Wings', 'Test Cold Drink 1.5 L', 'Delivery Charge (Rs 200)'].map((name, i) => ({
      id: `${s.order.id}-l${i}`,
      parentOrderItemId: null,
      quantity: i === 1 ? 2 : 1,
      menuItemName: name,
      modifiers: [],
      notes: null,
      lineTotalCents: 10_000,
    })),
  }) as unknown as OrderSnapshot;

describe('Out cards fit the Out column at the till’s narrowest window (e2e fixes B)', () => {
  const OUT_CARDS: Array<[string, OrderSnapshot]> = [
    ['an outside rider’s, owing', ownerExample(47, 'out_for_delivery', { riderKeepsCents: 20_000 as never })],
    ['an outside rider’s, paid', ownerExample(52, 'out_for_delivery', { riderKeepsCents: 20_000 as never, paidAt: minsAgo(5) })],
    ['an own rider’s, unpaid', ownerExample(44, 'out_for_delivery', {}, OWN_RIDER)],
    ['an own rider’s, paid', ownerExample(45, 'out_for_delivery', { paidAt: minsAgo(30) }, OWN_RIDER)],
  ];

  it.each(OUT_CARDS)('%s: no Delivery badge (the column says so), the food as one paragraph, no item count', (_name, snap) => {
    const c = card(snap);
    expect(c).not.toContain(DELIVERY_BADGE);
    expect(c.split(OUT_ITEMS)).toHaveLength(2);
    expect(c).not.toContain('<ul');
    expect(c).not.toContain('<li');
    // "1×" stays with its item (a no-break space), the lines joined by " · ".
    expect(c).toContain('1×</span> Test Family Pizza</span><span> · <span class="font-bold text-stone-900 dark:text-stone-100">1×</span> Delivery Charge (Rs 200)</span></p>');
    expect(text(c)).not.toMatch(/\d items?\b/);
    expect(c.split(OUT_CONTACT)).toHaveLength(2);
    expect(c.split(OUT_RIDER_BOX)).toHaveLength(2);
    expect(c.split(OUT_TOTAL_ROW)).toHaveLength(2);
    // Every button under the total is at least 40 px tall, and none of their words may wrap.
    const bottom = c.slice(c.indexOf(OUT_TOTAL_ROW));
    const tags = bottom.split('<button').slice(1).map((b) => b.slice(0, b.indexOf('>')));
    expect(tags.length).toBeGreaterThanOrEqual(3);
    for (const t of tags) expect(t).toMatch(/\bh-1[01]\b/);
    const big = openingTag(buttonsWith(c, nextBoardAction(snap.order.status, snap.order.mode, snap.order.paidAt !== null).label)[0]!);
    expect(big).toContain('whitespace-nowrap');
    expect(big).toContain('h-11');
  });

  it('every other card keeps its badge, its list of lines and its count (New, Preparing, Ready)', () => {
    for (const snap of [delivery(41, 'sent_to_kitchen'), delivery(43, 'preparing'), delivery(42, 'ready')]) {
      const c = card(snap);
      expect(c).toContain(DELIVERY_BADGE);
      expect(c).toContain('<ul class="space-y-0.5 text-sm text-stone-700 dark:text-stone-300">');
      expect(c).not.toContain(OUT_ITEMS);
      expect(c).not.toContain(OUT_CONTACT);
      expect(text(c)).toContain('2 items');
    }
  });

  it('six lines of food: an Out card names every one (two lines on screen, cut with "…"); a Ready card still lists four and "+2 more…"', () => {
    const out = card(sixLines(ownerExample(47, 'out_for_delivery', { riderKeepsCents: 20_000 as never })));
    expect(text(out)).toContain('1× Test Family Pizza · 2× Test Fries · 1× Test Garlic Bread · 1× Test Wings · 1× Test Cold Drink 1.5 L · 1× Delivery Charge (Rs 200)');
    expect(out).not.toContain('more…');
    const ready = card(sixLines(delivery(42, 'ready')));
    expect(text(ready)).toContain('+2 more…');
    expect(text(ready)).toContain('7 items');
  });

  it('an own rider’s box: his name and Change on the first line, his phone and "· out 12m" under them (on one line they ran into Change)', () => {
    const c = card(ownerExample(44, 'out_for_delivery', {}, OWN_RIDER));
    const box = c.slice(c.indexOf(OUT_RIDER_BOX) + OUT_RIDER_BOX.length, c.indexOf(OUT_TOTAL_ROW));
    const [first, second] = box.split('<div class="flex flex-wrap items-center gap-x-1.5 pl-5 text-[10px]">');
    expect(first).toContain('<div class="flex items-center justify-between gap-1.5"><span class="flex min-w-0 items-center gap-1.5">');
    expect(text(first!)).toBe('Test Rider Change');
    expect(first).toContain('<span class="truncate font-semibold">Test Rider</span>');
    expect(text(second!)).toBe('03000000001 · out 12m');
    expect(text(c)).toContain('Rs 4,715 Not paid Delivered + Pay');
  });

  it('the outside rider’s box: "Outside rider · out 12m · keeps Rs 200" and Assign rider wrap in their own row; while he owes, the chip is the box’s last line', () => {
    const owing = card(ownerExample(47, 'out_for_delivery', { riderKeepsCents: 20_000 as never }));
    const box = owing.slice(owing.indexOf(OUT_RIDER_BOX) + OUT_RIDER_BOX.length, owing.indexOf(OUT_TOTAL_ROW));
    expect(box.startsWith('<div class="flex flex-wrap items-center gap-x-1 gap-y-0.5">')).toBe(true);
    expect(box.endsWith(`<div>${OUT_OWES_CHIP}</div></div></div>`)).toBe(true);
    expect(openingTag(buttonsWith(owing, 'Assign rider')[0]!)).toContain('ml-auto shrink-0 rounded px-1 py-0.5 text-[11px]');
    const paid = card(ownerExample(52, 'out_for_delivery', { riderKeepsCents: 20_000 as never, paidAt: minsAgo(5) }));
    expect(paid).not.toContain('Rider owes');
    expect(text(paid)).toContain('Outside rider · out 12m · keeps Rs 200 Assign rider Rs 4,715 Paid Delivered');
  });
});

// ---------------------------------------------------------------------------
// Pinned cards. A Ready takeaway as in the build before this step (23e7c86,
// v0.7.34 step 16-2), by its SHA-256 with review fixes D's last row taken
// back out (undoRowD). An own rider's Out card as e2e fixes B made it: #0044
// in full, #0045 by its SHA-256 (spaces before am/pm made plain). Rendered
// from the same made-up orders at the same "now".

const BEFORE = {
  /** #0046: a Ready takeaway, unpaid. */
  readyTakeaway: '609e6fe0caf4e7e91a0ffb286c1fdabbe8e1ea8f2e7263a99e7e5929c8d11c14',
};

const PINNED_B = {
  /** #0045: an own rider's Out card, paid. */
  ownRiderPaid: '08351c6d77ba844b5e69d2a4d91568b1d8fe92f19dfb9060c5b0a26fe969288d',
};

/** #0044: an own rider's Out card, unpaid (the article's markup after "<article"). */
const OWN_RIDER_CARD = [
  ' class="rounded-xl bg-white p-3 shadow-soft-sm transition-shadow hover:shadow-soft-md dark:bg-stone-800 ring-2 ring-red-500 dark:ring-red-500">',
  '<header class="mb-1.5 flex items-start justify-between gap-2">',
  '<div class="min-w-0">',
  '<div class="flex flex-wrap items-center gap-1.5">',
  '<span class="font-mono text-lg font-bold leading-none text-stone-900 dark:text-stone-100">#0044</span></div>',
  '<div class="mt-1 flex items-center gap-1.5 truncate text-sm font-semibold text-stone-700 dark:text-stone-200">',
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-user-round h-3.5 w-3.5 shrink-0 text-stone-400"><circle cx="12" cy="8" r="5"></circle><path d="M20 21a8 8 0 0 0-16 0"></path></svg>',
  '<span class="truncate">Test Customer</span></div></div><span class="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-sm font-semibold bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-200" title="Sent 7:22 pm · started 7:20 pm">',
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-hourglass h-3.5 w-3.5"><path d="M5 22h14"></path><path d="M5 2h14"></path><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"></path><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"></path></svg>38m</span></header>',
  '<p class="line-clamp-2 text-sm leading-snug text-stone-700 dark:text-stone-300"><span><span class="font-bold text-stone-900 dark:text-stone-100">1×</span>\u00a0Test Family Pizza</span><span> · <span class="font-bold text-stone-900 dark:text-stone-100">1×</span>\u00a0Delivery Charge (Rs 200)</span></p>',
  '<div class="mt-1.5 space-y-1 rounded-lg bg-stone-50 px-2 py-1.5 text-xs dark:bg-stone-900/60">',
  '<div class="flex items-center gap-1.5 font-mono text-stone-600 dark:text-stone-300">',
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-phone h-3 w-3 shrink-0"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>03001234567</div>',
  '<div class="flex items-start gap-1.5 text-stone-600 dark:text-stone-300">',
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-map-pin mt-0.5 h-3 w-3 shrink-0"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"></path><circle cx="12" cy="10" r="3"></circle></svg><span class="line-clamp-2">House 1, Made-up Street</span></div>',
  '<div class="space-y-1 rounded-md bg-violet-50 px-1.5 py-1 leading-tight text-violet-800 dark:bg-violet-950/40 dark:text-violet-200">',
  '<div class="flex items-center justify-between gap-1.5">',
  '<span class="flex min-w-0 items-center gap-1.5">',
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-bike h-3.5 w-3.5 shrink-0"><circle cx="18.5" cy="17.5" r="3.5"></circle><circle cx="5.5" cy="17.5" r="3.5"></circle><circle cx="15" cy="5" r="1"></circle><path d="M12 17.5V14l-3-3 4-3 2 3h2"></path></svg>',
  '<span class="truncate font-semibold">Test Rider</span></span>',
  '<button type="button" class="shrink-0 rounded px-1 py-0.5 text-[11px] font-semibold text-violet-700 underline-offset-2 hover:underline dark:text-violet-300">Change</button></div>',
  '<div class="flex flex-wrap items-center gap-x-1.5 pl-5 text-[10px]">',
  '<span class="font-mono">03000000001</span>',
  '<span class="whitespace-nowrap">· out 12m</span></div></div></div>',
  '<div class="mt-1.5 flex items-center gap-2 border-t border-stone-100 pt-1.5 dark:border-stone-700">',
  '<span class="whitespace-nowrap font-mono text-base font-bold text-stone-900 dark:text-stone-100">Rs 4,130</span>',
  '<span class="inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200">Not paid</span></div>',
  '<div class="mt-2 flex flex-wrap items-center gap-1">',
  '<button type="button" class="inline-flex items-center justify-center gap-2 font-semibold tracking-tight transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-900 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 select-none bg-gradient-to-b from-emerald-500 to-emerald-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_1px_2px_rgba(0,0,0,0.05)] hover:from-emerald-400 hover:to-emerald-500 hover:shadow-lift active:from-emerald-600 active:to-emerald-700 focus-visible:ring-emerald-500 px-4 rounded-xl h-11 flex-1 whitespace-nowrap text-sm">',
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-check h-4 w-4"><circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path></svg>Delivered + Pay</button>',
  '<div class="ml-auto flex shrink-0 items-center gap-1">',
  '<button type="button" aria-label="Print bill or receipt" title="Print bill or receipt" class="flex h-11 w-9 items-center justify-center rounded-lg text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-700 dark:hover:text-stone-200">',
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-printer h-4 w-4"><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"></path><rect x="6" y="14" width="12" height="8" rx="1"></rect></svg></button>',
  '<button type="button" aria-label="Cancel order (manager approval)" title="Cancel order (manager approval)" class="flex h-11 w-9 items-center justify-center rounded-lg text-stone-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-300">',
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-x h-4 w-4"><circle cx="12" cy="12" r="10"></circle><path d="m15 9-6 6"></path><path d="m9 9 6 6"></path></svg></button></div></div>',
];
