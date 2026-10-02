/**
 * Delivered + Pay and Rider paid for an outside rider (v0.7.34, step 18-5;
 * the owner, 2 Oct 2026: "[Rider paid] and [Delivered + Pay] take the food
 * total from the rider"; order-edit finding #5: the customer refuses one item
 * with an outside rider on "Pays after delivery"). Rendered to static markup
 * (react-dom/server, no browser). A server render keeps no state, so React's
 * useState is stood in for by slots kept from one render to the next, in the
 * order the screen calls it; a tap, a typed word or Enter is the handler as
 * it was rendered, and the screen is rendered again after it. The till's IPC
 * is a stand-in that records each call; the toasts are recorded too. Every
 * name, number and amount is made up.
 *
 *  - The outside rider's box, word for word: Customer pays Rs 4,715, Rider
 *    keeps — delivery charge − Rs 200, Take from the rider Rs 4,515, Cash from
 *    the rider (Rs), Exact = Rs 4,515 (the food total, with its 15% tax),
 *    Change to give the rider. No Card. Short cash is refused before the till
 *    is asked.
 *  - The request carries what he keeps (frozen at Send out) and the method;
 *    the payment is the full total, whatever the method.
 *  - riderPaidOnly: "Rider paid · #0042", orders:riderPaid, the order stays out.
 *  - sendOutFirst (Send out's "Paid now", e2e fix A): the order is still
 *    Ready; Confirm is ONE call, orders:sendOut with riderPayment (out and
 *    paid, then the bill); a refusal keeps the box; "Pays after delivery",
 *    the X or Esc send it out alone, once (it still goes out with its bill).
 *  - "Customer refused an item": his cash is taken at the food total, as it
 *    is, and the request says refusedItem (the till keeps the item's refund
 *    as owed until it is done); then the Refund box opens on Part of it with
 *    Cash and the note, from Live Orders and from the order panel alike. The
 *    order panel says the refund is not done yet, and its Refund… opens the
 *    same way, until it is (review fixes B).
 *  - He keeps nothing: the paper's own reason — "already paid for this trip"
 *    while the bill has its charge (one trip, one fee), "no delivery charge"
 *    with none (review fixes B).
 *  - Own rider, takeaway, foodpanda and a prepaid outside order: the box is
 *    byte-identical to the build before this step.
 */
import { createHash } from 'node:crypto';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, OrderSnapshot, OrderStockStatus, PaymentMethod, UUID } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { SecretInput } from '../../components/secret/SecretInput';
import { useSessionStore } from '../../stores/sessionStore';
import { MarkDeliveredDialog, REFUSED_ITEM_REFUND, type RefundItemNext } from './MarkDeliveredDialog';
import { REFUSED_ITEM_OWED_TEXT } from './refusedItemWords';
import type { PaidNowAtSendOut } from './boardLogic';
import { RefundOrderDialog } from './RefundOrderDialog';
import { OrdersBoardPage } from './OrdersBoardPage';
import { OrderDetailDrawer } from './OrderDetailDrawer';

/** useState's slots, kept between renders: `cursor` is where this render is. */
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

type DeliverProps = Parameters<typeof MarkDeliveredDialog>[0];
type RefundProps = Parameters<typeof RefundOrderDialog>[0];

/** What the screens asked of the till, what they toasted, the open box's body and each Button as rendered. */
const seen = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  toasts: [] as Array<{ title: string; description?: string; variant?: string }>,
  content: null as unknown,
  buttons: [] as Array<{ words: string; tap: (() => void) | undefined }>,
  /** The till's answer to markDelivered / riderPaid: this snapshot, or a refusal in its own words. */
  answer: null as unknown,
  refuse: null as string | null,
  /** The open box's Root onOpenChange (Esc, or a tap outside). */
  openChange: null as ((open: boolean) => void) | null,
}));

/**
 * The Live Orders and order-panel tests stand the two boxes in with stubs
 * that only record what they were opened with (stubs.on); otherwise the
 * real boxes render.
 */
const stubs = vi.hoisted(() => ({ on: false, deliver: [] as unknown[], refund: [] as unknown[] }));

vi.mock('./MarkDeliveredDialog', async (importOriginal) => {
  const real = await importOriginal<typeof import('./MarkDeliveredDialog')>();
  const React = await import('react');
  return {
    ...real,
    MarkDeliveredDialog: (props: Parameters<typeof real.MarkDeliveredDialog>[0]) => {
      if (!stubs.on) return React.createElement(real.MarkDeliveredDialog, props);
      stubs.deliver.push(props);
      return null;
    },
  };
});

vi.mock('./RefundOrderDialog', async (importOriginal) => {
  const real = await importOriginal<typeof import('./RefundOrderDialog')>();
  const React = await import('react');
  return {
    ...real,
    RefundOrderDialog: (props: Parameters<typeof real.RefundOrderDialog>[0]) => {
      if (!stubs.on) return React.createElement(real.RefundOrderDialog, props);
      stubs.refund.push(props);
      return null;
    },
  };
});

// A server render has no portal: the dialog's parts render in place. The body is kept for its handlers.
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

vi.mock('../../components/toast/ToastProvider', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../components/toast/ToastProvider')>();
  const toast = (t: { title: string; description?: string; variant?: string }) => {
    seen.toasts.push(t);
  };
  return { ...real, useToast: () => ({ toast }) };
});

// Each Button as rendered, with its words and its tap (a card's "Delivered + Pay", the panel's "Collect payment").
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
      tap: onClick ? () => onClick({ preventDefault() {}, stopPropagation() {} } as never) : undefined,
    });
    return React.createElement(ui.Button, { ...props, ref });
  });
  return { ...ui, Button };
});

vi.mock('../../ipc/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../ipc/client')>();
  const answer = (name: string) => async (req: unknown) => {
    seen.calls.push([name, req]);
    if (seen.refuse) throw new Error(seen.refuse);
    return seen.answer;
  };
  return {
    ...real,
    ipc: {
      ...real.ipc,
      orders: {
        ...real.ipc.orders,
        markDelivered: answer('orders.markDelivered'),
        markServed: answer('orders.markServed'),
        riderPaid: answer('orders.riderPaid'),
        sendOut: answer('orders.sendOut'),
        refund: async (req: unknown) => {
          seen.calls.push(['orders.refund', req]);
          return { order: { status: 'paid' }, stock: null };
        },
        stockStatus: (orderId: string) => {
          seen.calls.push(['orders.stockStatus', orderId]);
          return new Promise(() => {});
        },
      },
    },
  };
});

function signIn(role: AuthenticatedUser['role']) {
  useSessionStore.setState({ user: { id: 'u1' as UUID, fullName: 'Test', role, sessionId: 's1' as UUID }, status: 'authenticated' });
}

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const text = (markup: string) => decode(markup.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
/** Node's ICU may write the space before am/pm as U+202F. */
const sha256 = (s: string) => createHash('sha256').update(s.replace(/ /g, ' '), 'utf8').digest('hex');

/** Lets the mutation run to the end (its till call, then its toasts). */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

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

const NOW = '2026-10-02T15:00:00.000Z';
const minsAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();

function pay(method: PaymentMethod, amountCents: number): OrderSnapshot['payments'][number] {
  return {
    id: 'p1',
    orderId: 'o1',
    method,
    amountCents,
    tenderedCents: null,
    referenceNo: null,
    receivedByUserId: 'u1',
    paidAt: NOW,
  } as unknown as OrderSnapshot['payments'][number];
}

/**
 * #0042: Test Family Pizza Rs 3,900 and 'Delivery Charge (Rs 200)', 15% tax
 * on both: Rs 4,715 (FOOD TOTAL Rs 4,515). Sent out 12 minutes ago with an
 * outside rider who keeps Rs 200 (frozen at Send out), not paid yet.
 */
function outsideOrder(over: Record<string, unknown> = {}): OrderSnapshot {
  return {
    order: {
      id: 'o1',
      orderNumber: '20261002-0042',
      mode: 'delivery',
      status: 'out_for_delivery',
      source: 'pos',
      notes: null,
      subtotalCents: 410_000,
      discountCents: 0,
      taxCents: 61_500,
      totalCents: 471_500,
      createdAt: minsAgo(40),
      sentAt: minsAgo(38),
      paidAt: null,
      voidedAt: null,
      voidReason: null,
      assignedRiderId: null,
      dispatchedAt: minsAgo(12),
      deliveredAt: null,
      riderKeepsCents: 20_000,
      ...over,
    },
    items: [
      { id: 'l1', parentOrderItemId: null, quantity: 1, menuItemName: 'Test Family Pizza', modifiers: [], notes: null, lineTotalCents: 390_000, taxRateBps: 1500 },
      { id: 'l2', parentOrderItemId: null, quantity: 1, menuItemName: 'Delivery Charge (Rs 200)', modifiers: [], notes: null, lineTotalCents: 20_000, taxRateBps: 1500 },
    ],
    discounts: [],
    payments: [],
    cashierName: 'Test Cashier',
    tableLabel: null,
    customerName: 'Test Customer',
    customerPhone: '03001234567',
    deliveryAddress: 'House 1, Made-up Street',
    deliveryNotes: null,
    rider: null,
    deliveryChargeToRider: null,
  } as unknown as OrderSnapshot;
}

/** #0042 as the till answers after Delivered + Pay: paid in cash, delivered, the rider's Rs 200 paid out. */
function paidAfterDelivered(): OrderSnapshot {
  const s = outsideOrder({ status: 'paid', paidAt: NOW, deliveredAt: NOW });
  return { ...s, payments: [pay('cash', 471_500)], deliveryChargeToRider: { amountCents: 20_000, at: NOW, why: 'kept' } } as unknown as OrderSnapshot;
}

/** orders:stockStatus with nothing to ask. */
function noStock(snap: OrderSnapshot): OrderStockStatus {
  return {
    orderId: snap.order.id,
    status: snap.order.status,
    state: 'none',
    takenAt: null,
    lines: [],
    estCostCents: 0,
    hasCosts: false,
    question: null,
    kitchenTicket: 'none',
    otherTill: false,
    settledAt: null,
    settledByName: null,
    approvedByName: null,
    answer: null,
    wasteCents: 0,
    hiddenLines: 0,
  };
}

/** A screen, rendered again after every tap, word or Enter (useState kept in its slots). */
function mount(node: () => ReactElement, seed: Array<[readonly unknown[], unknown]> = []) {
  hooks.slots = [];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [key, data] of seed) qc.setQueryData(key, data);
  let html = '';
  let calls = -1;
  const view = () => {
    hooks.cursor = 0;
    seen.content = null;
    seen.buttons.length = 0;
    html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ToastProvider>{node()}</ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // The slots are kept by call order: the same number of calls every render, or they mean nothing.
    if (calls >= 0 && hooks.cursor !== calls) throw new Error(`useState was called ${hooks.cursor} times, not ${calls}`);
    calls = hooks.cursor;
  };
  view();
  const one = (what: string, match: (e: El) => boolean): El => {
    const hits = [...walk(seen.content)].filter(match);
    if (hits.length !== 1) throw new Error(`${hits.length} × ${what}`);
    return hits[0]!;
  };
  const isButton = (words: string) => (e: El) => e.type === 'button' && wordsOf(e.props['children']).trim() === words;
  const isCash = (e: El) => e.type === 'input' && e.props['inputMode'] === 'decimal';
  const isRef = (e: El) => e.type === 'input' && e.props['placeholder'] === 'e.g. EP-981-XXX';
  const isAmount = (e: El) => e.type === 'input' && e.props['placeholder'] === 'e.g. 300';
  const isReason = (e: El) => e.type === 'input' && e.props['id'] === 'refund-reason';
  const inputs = { cash: isCash, ref: isRef, amount: isAmount, reason: isReason };
  type Box = keyof typeof inputs;
  return {
    view,
    get html() {
      return html;
    },
    get words() {
      return text(html);
    },
    /** The words of every pressed button (aria-pressed="true"). */
    get pressed() {
      return html
        .split('<button')
        .slice(1)
        .filter((b) => b.slice(0, b.indexOf('>')).includes('aria-pressed="true"'))
        .map((b) => text(`<x${b.split('</button>')[0]!}`));
    },
    /** The box's payment methods, in order, and whether each can be tapped. */
    get methods() {
      return [...walk(seen.content)]
        .filter((e) => e.type === 'button' && 'aria-pressed' in e.props && wordsOf(e.props['children']).trim() !== 'Customer refused an item')
        .map((e) => `${wordsOf(e.props['children']).trim()}${e.props['disabled'] === true ? ' (off)' : ''}`);
    },
    /** The one-tap amounts under the cash box ("Exact" as it is). */
    get quick() {
      return [...walk(seen.content)]
        .filter((e) => e.type === 'button' && !('aria-pressed' in e.props) && e.props['aria-label'] === undefined)
        .map((e) => wordsOf(e.props['children']).trim());
    },
    /** The submit button's words. */
    get confirm() {
      const submit = html.split('<button').find((b) => b.slice(0, b.indexOf('>')).includes('type="submit"'))!;
      return text(`<x${submit.split('</button>')[0]!}`);
    },
    input: (box: Box) => one(`${box} box`, inputs[box]).props,
    count: (box: Box) => [...walk(seen.content)].filter(inputs[box]).length,
    /** A plain button in the open box. */
    tap(words: string) {
      (one(`button "${words}"`, isButton(words)).props['onClick'] as () => void)();
      view();
    },
    /** A Button (the ui kit's) with exactly these words, as last rendered. */
    press(words: string) {
      const hit = seen.buttons.filter((b) => b.words === words).pop();
      if (!hit?.tap) throw new Error(`No button "${words}" (saw: ${seen.buttons.map((b) => b.words).join(' | ')})`);
      hit.tap();
      view();
    },
    type(box: Box, value: string) {
      (one(`${box} box`, inputs[box]).props['onChange'] as (e: { target: { value: string } }) => void)({ target: { value } });
      view();
    },
    pin(value: string) {
      (one('PIN box', (e) => e.type === SecretInput).props['onChange'] as (v: string) => void)(value);
      view();
    },
    /** Enter anywhere in the box: the form's submit. */
    enter() {
      (one('form', (e) => e.type === 'form').props['onSubmit'] as (e: { preventDefault: () => void }) => void)({
        preventDefault() {},
      });
      view();
    },
  };
}

/** The box open on this order, with what its onDone heard. */
function openBox(snap: OrderSnapshot, riderPaidOnly?: boolean) {
  signIn('cashier');
  const done: Array<RefundItemNext | undefined> = [];
  const box = mount(() => (
    <MarkDeliveredDialog
      snap={snap}
      onClose={() => {}}
      onDone={(next) => {
        done.push(next);
      }}
      {...(riderPaidOnly === undefined ? {} : { riderPaidOnly })}
    />
  ));
  return Object.assign(box, { done });
}

const calls = (name: string) => seen.calls.filter(([n]) => n === name).map(([, req]) => req);

const consoleError = console.error;
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((msg: unknown, ...rest: unknown[]) => {
    if (String(msg).includes('useLayoutEffect does nothing on the server')) return;
    consoleError(msg, ...rest);
  });
});
afterAll(() => vi.restoreAllMocks());

beforeEach(() => {
  seen.calls.length = 0;
  seen.toasts.length = 0;
  seen.answer = paidAfterDelivered();
  seen.refuse = null;
  stubs.on = false;
  stubs.deliver.length = 0;
  stubs.refund.length = 0;
});
afterEach(() => {
  useSessionStore.setState({ user: null, status: 'idle' });
});

describe('Delivered + Pay with an outside rider: the food total from him', () => {
  it('the words, exactly: what the customer pays, what he keeps, what he hands in', () => {
    const box = openBox(outsideOrder());
    expect(box.words).toContain('Delivered + take payment');
    expect(box.words).toContain('Order #0042 · Test Customer');
    expect(box.words).toContain('Customer pays Rs 4,715 Rider keeps — delivery charge − Rs 200 Take from the rider Rs 4,515');
    expect(box.words).toContain('Cash from the rider (Rs)');
    expect(box.words).not.toContain('Cash given (Rs)');
    expect(box.words).not.toContain('To collect');
    expect(box.words).toContain('Customer refused an item');
    expect(box.confirm).toBe('Confirm');
  });

  it('Exact is the food total, Rs 4,515 (its tax in it), and the notes are counted from it', () => {
    const box = openBox(outsideOrder());
    expect(box.input('cash')['value']).toBe('4515');
    expect(box.quick).toEqual(['Exact', 'Rs 4,600', 'Rs 5,000']);
    box.type('cash', '5000');
    box.tap('Exact');
    expect(box.input('cash')['value']).toBe('4515');
    // No change on the exact amount.
    expect(box.words).not.toContain('Change to give');
  });

  it('Cash, EasyPaisa and JazzCash only: no Card', () => {
    const box = openBox(outsideOrder());
    expect(box.methods).toEqual(['Cash', 'EasyPaisa', 'JazzCash']);
    expect(box.pressed).toEqual(['Cash']);
    expect(box.words).not.toContain('Card');
    expect(box.html).toContain('grid-cols-3');
  });

  it('the change is the rider’s: "Change to give the rider"', () => {
    const box = openBox(outsideOrder());
    box.type('cash', '5000');
    expect(box.words).toContain('Change to give the rider Rs 485');
  });

  it('short cash says "The rider’s cash must cover Rs 4,515" and sends nothing', async () => {
    const box = openBox(outsideOrder());
    box.type('cash', '4000');
    box.enter();
    await settle();
    expect(seen.toasts).toEqual([{ title: "The rider's cash must cover Rs 4,515", variant: 'warning' }]);
    expect(seen.calls).toEqual([]);
    expect(box.done).toEqual([]);
  });

  it('cash: the full total, what he keeps and the method go to the till; "Delivered · payment taken"', async () => {
    const box = openBox(outsideOrder());
    box.type('cash', '5000');
    box.enter();
    await settle();
    expect(seen.calls).toEqual([
      [
        'orders.markDelivered',
        {
          orderId: 'o1',
          payment: { method: 'cash', amountCents: 471_500, tenderedCents: null, referenceNo: null },
          riderKeepsCents: 20_000,
        },
      ],
    ]);
    expect(seen.toasts).toEqual([{ title: 'Delivered · payment taken', description: 'Give the rider change: Rs 485' }]);
    expect(box.done).toEqual([undefined]);
  });

  it('EasyPaisa: the full total too (the till splits it), with the reference', async () => {
    const box = openBox(outsideOrder());
    box.tap('EasyPaisa');
    expect(box.count('cash')).toBe(0);
    box.type('ref', 'EP-TEST-1');
    box.enter();
    await settle();
    expect(calls('orders.markDelivered')).toEqual([
      {
        orderId: 'o1',
        payment: { method: 'easypaisa', amountCents: 471_500, tenderedCents: null, referenceNo: 'EP-TEST-1' },
        riderKeepsCents: 20_000,
      },
    ]);
    expect(seen.toasts).toEqual([{ title: 'Delivered · payment taken' }]);
  });

  it('a refusal is shown in the till’s own words', async () => {
    seen.refuse = 'This order changed since this window opened — close it and open the order again.';
    const box = openBox(outsideOrder());
    box.enter();
    await settle();
    expect(seen.toasts).toEqual([
      {
        title: 'Could not mark delivered',
        description: 'This order changed since this window opened — close it and open the order again.',
        variant: 'error',
      },
    ]);
    expect(box.done).toEqual([]);
  });

  it('he keeps nothing on a bill with its charge (one trip, one fee): "nothing (already paid for this trip)", as the paper says', async () => {
    const box = openBox(outsideOrder({ riderKeepsCents: 0 }));
    expect(box.words).toContain('Customer pays Rs 4,715 Rider keeps nothing (already paid for this trip) Take from the rider Rs 4,715');
    expect(box.words).not.toContain('no delivery charge');
    expect(box.input('cash')['value']).toBe('4715');
    box.enter();
    await settle();
    expect(calls('orders.markDelivered')).toEqual([
      { orderId: 'o1', payment: { method: 'cash', amountCents: 471_500, tenderedCents: null, referenceNo: null }, riderKeepsCents: 0 },
    ]);
    // Rider paid says it the same way.
    expect(openBox(outsideOrder({ riderKeepsCents: 0 }), true).words).toContain('Rider keeps nothing (already paid for this trip)');
  });

  it('he keeps nothing and the bill has no delivery charge: "nothing (no delivery charge)", and he hands in the whole bill', () => {
    const noCharge = outsideOrder({ riderKeepsCents: 0, subtotalCents: 390_000, taxCents: 58_500, totalCents: 448_500 });
    const s = { ...noCharge, items: noCharge.items.slice(0, 1) } as OrderSnapshot;
    const box = openBox(s);
    expect(box.words).toContain('Customer pays Rs 4,485 Rider keeps nothing (no delivery charge) Take from the rider Rs 4,485');
  });

  it('delivered but not paid (the order panel’s Collect payment) is the same outside box', () => {
    const box = openBox(outsideOrder({ status: 'delivered', deliveredAt: minsAgo(2) }));
    expect(box.words).toContain('Take from the rider Rs 4,515');
    expect(box.methods).toEqual(['Cash', 'EasyPaisa', 'JazzCash']);
  });
});

describe('Rider paid (riderPaidOnly): he pays the shop while still out', () => {
  it('"Rider paid · #0042", the same money words, no refused-item button', () => {
    const box = openBox(outsideOrder(), true);
    expect(box.words).toContain('Rider paid · #0042');
    expect(box.words).toContain('Test Customer · the order stays out for delivery');
    expect(box.words).not.toContain('Delivered + take payment');
    expect(box.words).toContain('Customer pays Rs 4,715 Rider keeps — delivery charge − Rs 200 Take from the rider Rs 4,515');
    expect(box.methods).toEqual(['Cash', 'EasyPaisa', 'JazzCash']);
    expect(box.words).not.toContain('Customer refused an item');
  });

  it('calls orders:riderPaid (never markDelivered) and says "Rider paid · Rs 4,515 for the shop"', async () => {
    seen.answer = { ...outsideOrder({ paidAt: NOW }), payments: [pay('cash', 471_500)] };
    const box = openBox(outsideOrder(), true);
    box.type('cash', '5000');
    box.enter();
    await settle();
    expect(seen.calls).toEqual([['orders.riderPaid', { orderId: 'o1', method: 'cash', referenceNo: null, riderKeepsCents: 20_000 }]]);
    expect(seen.toasts).toEqual([{ title: 'Rider paid · Rs 4,515 for the shop', description: 'Give the rider change: Rs 485' }]);
    expect(box.done).toEqual([undefined]);
  });

  it('JazzCash with a reference; short cash is refused before the till is asked', async () => {
    const short = openBox(outsideOrder(), true);
    short.type('cash', '4500');
    short.enter();
    await settle();
    expect(seen.toasts).toEqual([{ title: "The rider's cash must cover Rs 4,515", variant: 'warning' }]);
    expect(seen.calls).toEqual([]);

    seen.toasts.length = 0;
    const box = openBox(outsideOrder(), true);
    box.tap('JazzCash');
    box.type('ref', 'JC-TEST-2');
    box.enter();
    await settle();
    expect(calls('orders.riderPaid')).toEqual([{ orderId: 'o1', method: 'jazzcash', referenceNo: 'JC-TEST-2', riderKeepsCents: 20_000 }]);
    expect(seen.toasts).toEqual([{ title: 'Rider paid · Rs 4,515 for the shop' }]);
  });

  it('a refusal is shown in the till’s own words', async () => {
    seen.refuse = 'No shift is open on this till — open a shift before taking or returning money';
    const box = openBox(outsideOrder(), true);
    box.enter();
    await settle();
    expect(seen.toasts).toEqual([
      {
        title: "Could not take the rider's payment",
        description: 'No shift is open on this till — open a shift before taking or returning money',
        variant: 'error',
      },
    ]);
    expect(box.done).toEqual([]);
  });
});

describe('"Customer refused an item" (Delivered + Pay, order-edit #5)', () => {
  it('locks his cash at the food total, hides the change, says what comes next, and changes the button', () => {
    const box = openBox(outsideOrder());
    box.type('cash', '5000');
    expect(box.words).toContain('Change to give the rider Rs 485');
    box.tap('Customer refused an item');
    expect(box.pressed).toEqual(['Cash', 'Customer refused an item']);
    expect(box.input('cash')['value']).toBe('4515');
    expect(box.input('cash')['readOnly']).toBe(true);
    expect(box.quick).toEqual([]);
    expect(box.words).not.toContain('Change to give');
    expect(box.words).toContain("Take the rider's cash. The refund box opens next: hand out no cash.");
    expect(box.confirm).toBe('Confirm · then refund the item');
    // The refused item goes back in Cash: the wallets are off while it is on.
    expect(box.methods).toEqual(['Cash', 'EasyPaisa (off)', 'JazzCash (off)']);
  });

  it('on EasyPaisa, it goes back to Cash; off again, the box is as it was', () => {
    const box = openBox(outsideOrder());
    box.tap('EasyPaisa');
    box.tap('Customer refused an item');
    expect(box.pressed).toEqual(['Cash', 'Customer refused an item']);
    expect(box.input('cash')['value']).toBe('4515');
    box.tap('Customer refused an item');
    expect(box.pressed).toEqual(['Cash']);
    expect(box.input('cash')['readOnly']).toBe(false);
    expect(box.quick).toEqual(['Exact', 'Rs 4,600', 'Rs 5,000']);
    expect(box.methods).toEqual(['Cash', 'EasyPaisa', 'JazzCash']);
    expect(box.confirm).toBe('Confirm');
    expect(box.words).not.toContain('The refund box opens next');
  });

  it('Confirm takes the full total his way and says refusedItem (its refund owed till done), then onDone hears {refundItem: true}', async () => {
    const box = openBox(outsideOrder());
    box.tap('Customer refused an item');
    box.enter();
    await settle();
    expect(seen.calls).toEqual([
      [
        'orders.markDelivered',
        {
          orderId: 'o1',
          payment: { method: 'cash', amountCents: 471_500, tenderedCents: null, referenceNo: null },
          riderKeepsCents: 20_000,
          refusedItem: true,
        },
      ],
    ]);
    expect(seen.toasts).toEqual([{ title: 'Delivered · payment taken' }]);
    expect(box.done).toHaveLength(1);
    expect(box.done[0]).toMatchObject({ refundItem: true });
    expect(box.done[0]!.snap).toBe(seen.answer);
  });

  it('the Refund box it opens: Part of it, Cash, the note; the refused item goes back in Cash', async () => {
    expect(REFUSED_ITEM_REFUND).toEqual({
      startOn: 'partial',
      startMethod: 'cash',
      note: "The rider brought less than the bill. Type the refused item's price with tax, keep Cash, and hand out no cash: the drawer then matches what he brought.",
    });
    signIn('manager');
    const fresh = paidAfterDelivered();
    const box = mount(() => <RefundOrderDialog snap={fresh} onClose={() => {}} onDone={() => {}} {...REFUSED_ITEM_REFUND} />, [
      [['orders', 'stock', 'o1'], noStock(fresh)],
    ]);
    expect(box.pressed).toEqual(['Part of it', 'Cash']);
    expect(box.html).toContain('role="note"');
    expect(box.words).toContain(REFUSED_ITEM_REFUND.note);
    expect(box.words).toContain('The rider keeps his Rs 200.');
    // Rs 500 refused (with its tax): the rider brought Rs 4,015; the drawer then expects 4,515 − 500.
    box.type('amount', '500');
    expect(box.words).toContain('Rs 500 goes back. The rider keeps his Rs 200.');
    box.type('reason', 'Test item refused');
    box.pin('1234');
    box.enter();
    await settle();
    expect(calls('orders.refund')).toEqual([
      { orderId: 'o1', reason: 'Test item refused', approverPin: '1234', amountCents: 50_000, method: 'cash', expectStatus: 'paid' },
    ]);
  });
});

describe('Live Orders: Delivered + Pay, then the Refund box on the same till', () => {
  function board(orders: OrderSnapshot[]) {
    signIn('cashier');
    stubs.on = true;
    return mount(() => <OrdersBoardPage />, [[['orders', 'active', 'all'], orders]]);
  }
  const lastDeliver = () => stubs.deliver.at(-1) as DeliverProps | undefined;
  const lastRefund = () => stubs.refund.at(-1) as RefundProps | undefined;

  it('"Customer refused an item" opens RefundOrderDialog on Part of it with Cash and the note, on the order as now paid', () => {
    const order = outsideOrder();
    const b = board([order]);
    expect(stubs.deliver).toEqual([]);
    b.press('Delivered + Pay');
    const deliver = lastDeliver()!;
    expect(deliver.snap).toBe(order);
    expect(deliver.riderPaidOnly).toBeUndefined();
    expect(stubs.refund).toEqual([]);

    const fresh = paidAfterDelivered();
    deliver.onDone({ refundItem: true, snap: fresh });
    const rendered = stubs.deliver.length;
    b.view();
    // The Delivered box has closed; the Refund box is open with the fresh order.
    expect(stubs.deliver).toHaveLength(rendered);
    const refund = lastRefund()!;
    expect(refund.snap).toBe(fresh);
    expect(refund.startOn).toBe('partial');
    expect(refund.startMethod).toBe('cash');
    expect(refund.note).toBe(REFUSED_ITEM_REFUND.note);

    // The real box, opened with exactly those: Part of it and Cash pressed, the note at the top.
    stubs.on = false;
    signIn('manager');
    const real = mount(() => <RefundOrderDialog {...refund} />, [[['orders', 'stock', 'o1'], noStock(fresh)]]);
    expect(real.pressed).toEqual(['Part of it', 'Cash']);
    expect(real.html).toContain('role="note"');
    expect(real.words).toContain(REFUSED_ITEM_REFUND.note);
    expect(real.html.indexOf(REFUSED_ITEM_REFUND.note)).toBeLessThan(real.html.indexOf('All of it'));
  });

  it('a plain Delivered + Pay opens no Refund box', () => {
    const b = board([outsideOrder()]);
    b.press('Delivered + Pay');
    lastDeliver()!.onDone();
    b.view();
    expect(stubs.refund).toEqual([]);
  });
});

describe('Order panel: Collect payment, then the Refund box', () => {
  it('"Customer refused an item" opens the Refund box on Part of it with Cash and the note, on the order as now paid', () => {
    signIn('cashier');
    stubs.on = true;
    const order = outsideOrder();
    const panel = mount(() => <OrderDetailDrawer orderId="o1" onClose={() => {}} />, [[['orders', 'detail', 'o1'], order]]);
    panel.press('Collect payment · Rs 4,715');
    const deliver = stubs.deliver.at(-1) as DeliverProps;
    expect(deliver.snap).toBe(order);
    expect(stubs.refund).toEqual([]);

    const fresh = paidAfterDelivered();
    deliver.onDone({ refundItem: true, snap: fresh });
    panel.view();
    const refund = stubs.refund.at(-1) as RefundProps;
    expect(refund.snap).toBe(fresh);
    expect({ startOn: refund.startOn, startMethod: refund.startMethod, note: refund.note }).toEqual(REFUSED_ITEM_REFUND);
  });

  it('a plain Collect payment opens no Refund box', () => {
    signIn('cashier');
    stubs.on = true;
    const panel = mount(() => <OrderDetailDrawer orderId="o1" onClose={() => {}} />, [[['orders', 'detail', 'o1'], outsideOrder()]]);
    panel.press('Collect payment · Rs 4,715');
    (stubs.deliver.at(-1) as DeliverProps).onDone();
    panel.view();
    expect(stubs.refund).toEqual([]);
  });

  it('its refund not done yet: the panel says so, and Refund… opens on Part of it with Cash and the note', () => {
    signIn('manager');
    stubs.on = true;
    const owed = { ...paidAfterDelivered(), refusedItem: { refundAt: null } } as OrderSnapshot;
    const panel = mount(() => <OrderDetailDrawer orderId="o1" onClose={() => {}} />, [[['orders', 'detail', 'o1'], owed]]);
    expect(panel.words).toContain(REFUSED_ITEM_OWED_TEXT);
    expect(REFUSED_ITEM_OWED_TEXT).toBe('Customer refused an item - refund not done yet');
    expect(panel.words).toContain('the drawer is short by that item until it is refunded');
    panel.press('Refund…');
    const refund = stubs.refund.at(-1) as RefundProps;
    expect(refund.snap).toBe(owed);
    expect({ startOn: refund.startOn, startMethod: refund.startMethod, note: refund.note }).toEqual(REFUSED_ITEM_REFUND);
  });

  it('once refunded, or never refused: no words, and Refund… opens neutral as before', () => {
    signIn('manager');
    stubs.on = true;
    for (const snap of [
      { ...paidAfterDelivered(), refusedItem: { refundAt: NOW } } as OrderSnapshot,
      paidAfterDelivered(),
    ]) {
      stubs.refund.length = 0;
      const panel = mount(() => <OrderDetailDrawer orderId="o1" onClose={() => {}} />, [[['orders', 'detail', 'o1'], snap]]);
      expect(panel.words).not.toContain('refund not done yet');
      panel.press('Refund…');
      const refund = stubs.refund.at(-1) as RefundProps;
      expect(refund.startOn).toBeUndefined();
      expect(refund.startMethod).toBeUndefined();
      expect(refund.note).toBeUndefined();
    }
  });
});

describe('own rider, takeaway, foodpanda and a prepaid outside order: as before', () => {
  /** The orders the box was checked on in the build before this step (the hashes are of that build's markup). */
  function plain(
    mode: 'delivery' | 'takeaway' | 'foodpanda',
    status: string,
    paid: boolean,
    extra: Record<string, unknown> = {},
    rider: unknown = null,
  ): OrderSnapshot {
    return {
      order: {
        id: 'o1',
        orderNumber: '20261002-0042',
        mode,
        status,
        source: 'pos',
        notes: null,
        subtotalCents: 410_000,
        discountCents: 0,
        taxCents: 61_500,
        totalCents: 471_500,
        createdAt: '2026-10-02T14:00:00.000Z',
        sentAt: '2026-10-02T14:00:00.000Z',
        paidAt: paid ? '2026-10-02T14:10:00.000Z' : null,
        voidedAt: null,
        voidReason: null,
        assignedRiderId: null,
        dispatchedAt: null,
        deliveredAt: null,
        ...extra,
      },
      items: [],
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
  const RIDER = { id: 'r1', name: 'Test Rider', phone: '03000000001' };
  const BEFORE: Array<[string, OrderSnapshot, string]> = [
    ['own rider, unpaid', plain('delivery', 'out_for_delivery', false, {}, RIDER), 'abfaa07abf6d0fcb9584a829199183dc9f3fda5ad4b64f7170c3a34709be336c'],
    ['own rider, paid', plain('delivery', 'out_for_delivery', true, {}, RIDER), '05fbb773c85faaa1b3a091bef2c9a03844f9631ece07136661e9ebbd2e00d10b'],
    ['takeaway, unpaid', plain('takeaway', 'ready', false), '431e6b35b6836307c8ee182052729821e69c63f504598d70e2cbb2e48cacbef5'],
    ['foodpanda, unpaid', plain('foodpanda', 'ready', false), '90d9be3bfcf2c6c3a816dd99368d0eeeddbc832c72357d91b7179d3972601a36'],
    // Paid before it went out: the rider was paid from the drawer at Send out; Delivered only closes it.
    ['outside rider, prepaid', plain('delivery', 'out_for_delivery', true, { riderKeepsCents: 20_000 }), '05fbb773c85faaa1b3a091bef2c9a03844f9631ece07136661e9ebbd2e00d10b'],
    [
      'walk-in takeaway with paisa',
      { ...plain('takeaway', 'ready', false, { totalCents: 185_050 }), customerName: null } as unknown as OrderSnapshot,
      '261b989dda2fcf365f22a8b508248347b0093812d5cbb544b6571ae1c55287cb',
    ],
  ];

  it('the box is byte-identical to the build before this step', () => {
    for (const [name, snap, hash] of BEFORE) {
      expect({ name, hash: sha256(openBox(snap).html) }).toEqual({ name, hash });
    }
  });

  it('an own rider’s Delivered + Pay asks the till exactly as before (no riderKeepsCents, the cash given)', async () => {
    const box = openBox(plain('delivery', 'out_for_delivery', false, {}, RIDER));
    expect(box.methods).toEqual(['Cash', 'Card', 'EasyPaisa', 'JazzCash']);
    expect(box.words).not.toContain('Customer refused an item');
    box.type('cash', '5000');
    expect(box.words).toContain('Change to give Rs 285');
    box.enter();
    await settle();
    expect(seen.calls).toEqual([
      ['orders.markDelivered', { orderId: 'o1', payment: { method: 'cash', amountCents: 471_500, tenderedCents: 500_000, referenceNo: null } }],
    ]);
    expect(seen.toasts).toEqual([{ title: 'Delivered · payment taken', description: 'Give change: Rs 285' }]);
  });

  it('a takeaway’s short cash still says "Cash given must cover the total"', async () => {
    const box = openBox(plain('takeaway', 'ready', false));
    box.type('cash', '4000');
    box.enter();
    await settle();
    expect(seen.toasts).toEqual([{ title: 'Cash given must cover the total', variant: 'warning' }]);
    expect(seen.calls).toEqual([]);
  });
});

describe('Send out\'s "Paid now" (sendOutFirst, e2e fix A): sent out and paid in one step, then the bill', () => {
  /** #0042 still Ready: nothing sent out, nothing kept yet. */
  const readyOrder = () => outsideOrder({ status: 'ready', dispatchedAt: null, riderKeepsCents: undefined });
  const PLAN = { request: { orderId: 'o1' }, keepsCents: 20_000, tripCents: 0 };
  /** The Paid now box open on the Ready order, with what onDone and onClose heard. */
  function openPaidNow(plan: PaidNowAtSendOut = PLAN) {
    signIn('cashier');
    const done: Array<RefundItemNext | undefined> = [];
    const closed: string[] = [];
    seen.openChange = null;
    const box = mount(() => (
      <MarkDeliveredDialog
        snap={readyOrder()}
        riderPaidOnly
        sendOutFirst={plan}
        onClose={() => closed.push('closed')}
        onDone={(next) => {
          done.push(next);
        }}
      />
    ));
    return Object.assign(box, { done, closed });
  }

  it('"Rider paid · #0042", it goes out and then the bill prints; the figures the Send out box showed; "Pays after delivery" in place of Back', () => {
    const box = openPaidNow();
    expect(box.words).toContain('Rider paid · #0042 Test Customer · it goes out, then the bill prints');
    expect(box.words).toContain('Customer pays Rs 4,715 Rider keeps — delivery charge − Rs 200 Take from the rider Rs 4,515');
    expect(box.methods).toEqual(['Cash', 'EasyPaisa', 'JazzCash']);
    expect(box.words).not.toContain('Customer refused an item');
    expect(box.words).toContain('Pays after delivery Confirm');
    expect(box.words).not.toContain('Back');
    expect(box.html).toContain('aria-label="Pays after delivery"');
  });

  it('Confirm (cash): ONE till call — Send out with his payment — and "Rider paid · Rs 4,515 for the shop", the change his', async () => {
    seen.answer = { ...outsideOrder({ paidAt: NOW }), payments: [pay('cash', 471_500)] };
    const box = openPaidNow();
    box.type('cash', '5000');
    expect(box.words).toContain('Change to give the rider Rs 485');
    box.enter();
    await settle();
    expect(seen.calls).toEqual([
      ['orders.sendOut', { orderId: 'o1', riderPayment: { method: 'cash', referenceNo: null, riderKeepsCents: 20_000 } }],
    ]);
    expect(seen.toasts).toEqual([{ title: 'Rider paid · Rs 4,515 for the shop', description: 'Give the rider change: Rs 485' }]);
    expect(box.done).toEqual([undefined]);
    expect(box.closed).toEqual([]);
  });

  it('EasyPaisa with a reference, and the Send out request as the box made it (one trip, one fee; the trip and its PIN)', async () => {
    const plan = { request: { orderId: 'o1', riderAlreadyPaid: true, payRiderForTrip: true, approverPin: '2468' }, keepsCents: 0, tripCents: 20_000 };
    const box = openPaidNow(plan);
    expect(box.words).toContain('Rider keeps nothing (already paid for this trip) Take from the rider Rs 4,715');
    box.tap('EasyPaisa');
    box.type('ref', 'EP-TEST-7');
    box.enter();
    await settle();
    expect(calls('orders.sendOut')).toEqual([
      { ...plan.request, riderPayment: { method: 'easypaisa', referenceNo: 'EP-TEST-7', riderKeepsCents: 0 } },
    ]);
    expect(seen.toasts).toEqual([
      { title: 'Rider paid Rs 200 for the trip — the drawer opens.', variant: 'success' },
      { title: 'Rider paid · Rs 4,715 for the shop' },
    ]);
  });

  it('short cash is refused before the till is asked', async () => {
    const box = openPaidNow();
    box.type('cash', '4500');
    box.enter();
    await settle();
    expect(seen.toasts).toEqual([{ title: "The rider's cash must cover Rs 4,515", variant: 'warning' }]);
    expect(seen.calls).toEqual([]);
  });

  it('a refused Confirm: "Could not send out" in the till’s words (nothing went out, nothing was taken); the box stays, and does not send it out by itself', async () => {
    seen.refuse = 'No shift is open on this till — open a shift before taking or returning money';
    const box = openPaidNow();
    box.enter();
    await settle();
    expect(seen.toasts).toEqual([
      { title: 'Could not send out', description: 'No shift is open on this till — open a shift before taking or returning money', variant: 'error' },
    ]);
    expect(calls('orders.sendOut')).toHaveLength(1);
    expect(box.done).toEqual([]);
    expect(box.closed).toEqual([]);
  });

  it('not paid now — "Pays after delivery", the X or Esc: Send out alone, once, so the order still goes out with its bill; then the box is done', async () => {
    for (const how of ['Pays after delivery', 'the X', 'Esc'] as const) {
      seen.calls.length = 0;
      seen.toasts.length = 0;
      seen.answer = outsideOrder();
      const box = openPaidNow();
      if (how === 'Pays after delivery') box.press('Pays after delivery');
      else if (how === 'the X') box.tap('');
      else seen.openChange!(false);
      await settle();
      expect(seen.calls).toEqual([['orders.sendOut', { orderId: 'o1' }]]);
      expect(seen.toasts).toEqual([]);
      expect(box.done).toEqual([undefined]);
      expect(box.closed).toEqual([]);
    }
  });

  it('not paid now with the trip ticked: Send out alone pays the trip, and says the drawer opens', async () => {
    const plan = { request: { orderId: 'o1', payRiderForTrip: true, approverPin: '2468' }, keepsCents: 0, tripCents: 20_000 };
    const box = openPaidNow(plan);
    box.press('Pays after delivery');
    await settle();
    expect(calls('orders.sendOut')).toEqual([plan.request]);
    expect(seen.toasts).toEqual([{ title: 'Rider paid Rs 200 for the trip — the drawer opens.', variant: 'success' }]);
  });

  it('not paid now, and Send out is refused too: "Could not send out" in its words, and the box closes — nothing went out, so no bill', async () => {
    seen.refuse = 'This order is already out for delivery';
    const box = openPaidNow();
    box.press('Pays after delivery');
    await settle();
    expect(calls('orders.sendOut')).toEqual([{ orderId: 'o1' }]);
    expect(seen.toasts).toEqual([{ title: 'Could not send out', description: 'This order is already out for delivery', variant: 'error' }]);
    expect(box.closed).toEqual(['closed']);
    expect(box.done).toEqual([]);
  });
});
