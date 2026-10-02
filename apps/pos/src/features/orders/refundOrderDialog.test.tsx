/**
 * The Refund box (v0.7.34, step 18-4; the owner, 2 Oct 2026: "Refund box
 * opens with neither 'All of it' nor 'Part of it' chosen (Enter can't refund
 * everything)"; order-edit findings #4 and #13). Rendered to static markup
 * (react-dom/server, no browser). A server render keeps no state, so React's
 * useState is stood in for by slots kept from one render to the next, in the
 * order the box calls it; a tap, a typed word or Enter is the handler as it
 * was rendered, and the box is rendered again after it. The till's IPC is a
 * stand-in that records each call; the toasts are recorded too. Every name,
 * number and amount is made up.
 *
 *  - A paid takeaway opens with no choice: no pressed button, '—',
 *    'Choose All of it or Part of it.' and 'Refund…'. Enter only says
 *    "Choose All of it or Part of it" and asks nothing of the till.
 *  - 'All of it' then Enter sends the full refund as before; 'Part of it'
 *    works as before.
 *  - An order an outside rider (Send out) paid the shop for while he is
 *    still out (the paper's rule, riderSettledWhileOut: paid at or after it
 *    left) opens on 'Part of it' with Cash, and says what goes to the rider.
 *    One the customer paid before it left opens neutral, on how it was paid,
 *    with no "he collects … less" (review fixes B). What the drawer paid him
 *    is never taken back, and the box says so, word for word.
 *  - startOn, startMethod and note are honoured.
 *  - Own riders and takeaways: no rider words.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, OrderSnapshot, OrderStatus, OrderStockStatus, PaymentMethod, UUID } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { SecretInput } from '../../components/secret/SecretInput';
import { useSessionStore } from '../../stores/sessionStore';
import { RefundOrderDialog } from './RefundOrderDialog';

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

/** What the box asked of the till, what it toasted, and the box's body as last rendered. */
const seen = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  toasts: [] as Array<{ title: string; description?: string; variant?: string }>,
  content: null as unknown,
}));

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
    Root: pass,
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

vi.mock('../../ipc/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../ipc/client')>();
  return {
    ...real,
    ipc: {
      ...real.ipc,
      orders: {
        ...real.ipc.orders,
        // A full refund ends the order; a part refund leaves it paid.
        refund: async (req: { amountCents?: number }) => {
          seen.calls.push(['orders.refund', req]);
          return { order: { status: req.amountCents === undefined ? 'refunded' : 'paid' }, stock: null };
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

function pay(method: PaymentMethod, amountCents: number, n = 1): OrderSnapshot['payments'][number] {
  return {
    id: `p${n}`,
    orderId: 'o1',
    method,
    amountCents,
    tenderedCents: null,
    referenceNo: null,
    receivedByUserId: 'u1',
    paidAt: minsAgo(20),
  } as unknown as OrderSnapshot['payments'][number];
}

/** A paid takeaway: Test Pizza, Rs 1,160, paid in cash (or as given). */
function takeaway(payments = [pay('cash', 116_000)]): OrderSnapshot {
  return {
    order: {
      id: 'o1',
      orderNumber: '20261002-0007',
      mode: 'takeaway',
      status: 'paid',
      source: 'pos',
      notes: null,
      subtotalCents: 100_000,
      discountCents: 0,
      taxCents: 16_000,
      totalCents: 116_000,
      createdAt: minsAgo(30),
      sentAt: minsAgo(30),
      paidAt: minsAgo(20),
      voidedAt: null,
      voidReason: null,
      assignedRiderId: null,
      dispatchedAt: null,
      deliveredAt: null,
    },
    items: [{ id: 'l1', parentOrderItemId: null, quantity: 1, menuItemName: 'Test Pizza', modifiers: [], notes: null, lineTotalCents: 100_000 }],
    discounts: [],
    payments,
    cashierName: 'Test Cashier',
    tableLabel: null,
    customerName: null,
    customerPhone: null,
    deliveryAddress: null,
    deliveryNotes: null,
    rider: null,
  } as unknown as OrderSnapshot;
}

/**
 * A delivery of Rs 4,715 (Test Family Pizza + 'Delivery Charge (Rs 200)'),
 * sent out 15 minutes ago. `outside`: with an outside rider who keeps Rs 200,
 * and the drawer paid him (`payout`); he paid the shop in cash while out, 10
 * minutes ago (Rider paid) — or, with `prepaid`, the customer paid at the
 * counter 20 minutes ago, before it left (by `method`). Otherwise one of the
 * shop's own riders, paid in cash 20 minutes ago.
 */
function delivery(
  status: OrderStatus,
  {
    outside,
    keep = 20_000,
    payout = true,
    prepaid = false,
    method = 'cash',
  }: { outside: boolean; keep?: number; payout?: boolean; prepaid?: boolean; method?: PaymentMethod },
): OrderSnapshot {
  // Rider paid while out: at or after it left (the paper's rule). The customer: before it left.
  const paidAt = outside && !prepaid ? minsAgo(10) : minsAgo(20);
  const base = takeaway([{ ...pay(method, 471_500), paidAt }]);
  return {
    ...base,
    order: {
      ...base.order,
      paidAt,
      orderNumber: '20261002-0042',
      mode: 'delivery',
      status,
      subtotalCents: 410_000,
      taxCents: 61_500,
      totalCents: 471_500,
      dispatchedAt: minsAgo(15),
      deliveredAt: status === 'paid' ? minsAgo(5) : null,
      assignedRiderId: outside ? null : 'r1',
      ...(outside ? { riderKeepsCents: keep } : {}),
    },
    customerName: 'Test Customer',
    customerPhone: '03001234567',
    deliveryAddress: 'House 1, Made-up Street',
    rider: outside ? null : { id: 'r1', name: 'Test Rider', phone: '03000000001' },
    ...(outside ? { deliveryChargeToRider: payout ? { amountCents: keep, at: minsAgo(20), why: 'kept' } : null } : {}),
  } as unknown as OrderSnapshot;
}

/** orders:stockStatus as the till answers it: nothing to ask, or "Was the food made?". */
function stockOf(snap: OrderSnapshot, ask: boolean): OrderStockStatus {
  return {
    orderId: snap.order.id,
    status: snap.order.status,
    state: ask ? 'out' : 'none',
    takenAt: ask ? minsAgo(30) : null,
    lines: [],
    estCostCents: 0,
    hasCosts: false,
    question: ask ? { ask: 'choose', preselect: null, lean: null, hint: 'Test hint' } : null,
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

type Extra = Pick<Parameters<typeof RefundOrderDialog>[0], 'startOn' | 'startMethod' | 'note'>;

/** The Refund box open on this order, rendered again after every tap, word or Enter. */
function openBox(snap: OrderSnapshot, extra: Extra = {}, { askStock = false } = {}) {
  signIn('manager');
  hooks.slots = [];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['orders', 'stock', snap.order.id], stockOf(snap, askStock));
  let html = '';
  let calls = -1;
  let done = 0;
  const view = () => {
    hooks.cursor = 0;
    seen.content = null;
    html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ToastProvider>
            <RefundOrderDialog snap={snap} onClose={() => {}} onDone={() => (done += 1)} {...extra} />
          </ToastProvider>
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
  const isInput = (what: 'amount' | 'reason') => (e: El) =>
    e.type === 'input' && (what === 'reason' ? e.props['id'] === 'refund-reason' : e.props['placeholder'] === 'e.g. 300');
  const input = (what: 'amount' | 'reason') => one(`${what} box`, isInput(what));
  return {
    get html() {
      return html;
    },
    get words() {
      return text(html);
    },
    get done() {
      return done;
    },
    /** The words of every pressed button (aria-pressed="true"). */
    get pressed() {
      return html
        .split('<button')
        .slice(1)
        .filter((b) => b.slice(0, b.indexOf('>')).includes('aria-pressed="true"'))
        .map((b) => text(`<x${b.split('</button>')[0]!}`));
    },
    /** The orange "Give back" box's words. */
    get giveBack() {
      const from = html.indexOf('Give back');
      return text(html.slice(from, html.indexOf('<div class="space-y-3">', from)));
    },
    autoFocus: (what: 'amount' | 'reason') => input(what).props['autoFocus'] === true,
    /** How many of this box there are (0 or 1). */
    count: (what: 'amount' | 'reason') => [...walk(seen.content)].filter(isInput(what)).length,
    tap(words: string) {
      const b = one(`button "${words}"`, (e) => e.type === 'button' && wordsOf(e.props['children']).trim() === words);
      (b.props['onClick'] as () => void)();
      view();
    },
    type(what: 'amount' | 'reason', value: string) {
      (input(what).props['onChange'] as (e: { target: { value: string } }) => void)({ target: { value } });
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

const refundCalls = () => seen.calls.filter(([name]) => name === 'orders.refund').map(([, req]) => req);

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
});
afterEach(() => {
  useSessionStore.setState({ user: null, status: 'idle' });
});

describe('the Refund box opens with neither "All of it" nor "Part of it" chosen', () => {
  it('a paid takeaway: nothing pressed, "—", "Choose All of it or Part of it." and "Refund…"', () => {
    const box = openBox(takeaway());
    expect(box.pressed).toEqual([]);
    expect(box.html).not.toContain('aria-pressed="true"');
    expect(box.html).toContain('aria-pressed="false"');
    expect(box.giveBack).toBe('Give back — Choose All of it or Part of it.');
    expect(box.words).toContain('Refund…');
    expect(box.words).not.toContain('Refund Rs 1,160');
    expect(box.words).not.toContain('Everything still paid goes back');
    // No amount box, no way to pay back yet; the reason box has the cursor.
    expect(box.count('reason')).toBe(1);
    expect(box.count('amount')).toBe(0);
    expect(box.autoFocus('reason')).toBe(true);
    // The submit button stays enabled.
    const submit = box.html.split('<button').find((b) => b.includes('type="submit"'))!;
    expect(submit.slice(0, submit.indexOf('>'))).not.toMatch(/\sdisabled(=|\s|>)/);
  });

  it('Enter with the reason and PIN typed only says "Choose All of it or Part of it": nothing is refunded', async () => {
    const box = openBox(takeaway());
    box.type('reason', 'Test cold food');
    box.pin('1234');
    box.enter();
    await settle();
    expect(seen.toasts).toEqual([{ title: 'Choose All of it or Part of it', variant: 'warning' }]);
    expect(refundCalls()).toEqual([]);
    expect(box.done).toBe(0);
    expect(box.giveBack).toBe('Give back — Choose All of it or Part of it.');
  });

  it('no stock question until a choice is made; "All of it" asks it, "Part of it" says a part refund moves no stock', () => {
    const box = openBox(takeaway(), {}, { askStock: true });
    expect(box.words).not.toContain('Was the food made?');
    expect(box.words).not.toContain("A part refund doesn't change stock");
    expect(box.words).not.toContain('approves the refund and the stock');
    box.tap('All of it');
    expect(box.words).toContain('Was the food made?');
    expect(box.words).toContain('approves the refund and the stock');
    box.tap('Part of it');
    expect(box.words).not.toContain('Was the food made?');
    expect(box.words).toContain("A part refund doesn't change stock. If an item was never made, fix it in Inventory → Stock.");
  });

  it('"All of it" then Enter: the full refund, exactly as before', async () => {
    const box = openBox(takeaway());
    box.tap('All of it');
    expect(box.pressed).toEqual(['All of it']);
    expect(box.giveBack).toBe(
      'Give back Rs 1,160 Everything still paid goes back, the way it was paid. The order becomes Refunded.',
    );
    expect(box.words).toContain('Refund Rs 1,160');
    expect(box.autoFocus('reason')).toBe(true);
    box.type('reason', 'Test cold food');
    box.pin('1234');
    box.enter();
    await settle();
    expect(refundCalls()).toEqual([
      { orderId: 'o1', reason: 'Test cold food', approverPin: '1234', expectStatus: 'paid' },
    ]);
    expect(seen.toasts).toEqual([{ title: 'Refund done · Rs 1,160 back' }]);
    expect(box.done).toBe(1);
  });

  it('"Part of it": the amount, how it goes back, then Enter — as before', async () => {
    const box = openBox(takeaway());
    box.tap('Part of it');
    expect(box.pressed).toEqual(['Part of it', 'Cash']);
    expect(box.autoFocus('amount')).toBe(true);
    expect(box.autoFocus('reason')).toBe(false);
    expect(box.giveBack).toBe('Give back Rs 0 Up to Rs 1,160. The order stays paid until all of it is given back.');
    box.type('amount', '300');
    expect(box.words).toContain('Refund Rs 300');
    box.type('reason', 'Test cold food');
    box.pin('1234');
    box.enter();
    await settle();
    expect(refundCalls()).toEqual([
      { orderId: 'o1', reason: 'Test cold food', approverPin: '1234', amountCents: 30_000, method: 'cash', expectStatus: 'paid' },
    ]);
    expect(seen.toasts).toEqual([{ title: 'Part refund done', description: 'Rs 300 back to the customer' }]);
    // No rider here: none of his words.
    expect(box.words).not.toMatch(/rider/i);
  });

  it('"Part of it" still refuses an empty amount and one above what was paid', async () => {
    const box = openBox(takeaway());
    box.tap('Part of it');
    box.type('reason', 'Test cold food');
    box.pin('1234');
    box.enter();
    box.type('amount', '2000');
    box.enter();
    await settle();
    expect(seen.toasts).toEqual([
      { title: 'Type how much to give back', variant: 'warning' },
      { title: 'That is more than was paid', description: 'Most you can give back: Rs 1,160', variant: 'warning' },
    ]);
    expect(refundCalls()).toEqual([]);
  });
});

describe('an order an outside rider still has (Send out, not back yet)', () => {
  it('opens on "Part of it" with Cash, says what the rider keeps, and tells staff to give the money to him', async () => {
    const box = openBox(delivery('out_for_delivery', { outside: true }));
    expect(box.pressed).toEqual(['Part of it', 'Cash']);
    expect(box.autoFocus('amount')).toBe(true);
    expect(box.giveBack).toBe(
      'Give back Rs 0 Up to Rs 4,715. The order stays paid until all of it is given back. The rider keeps his Rs 200.',
    );
    expect(box.words).toContain('Give this to the rider: he collects that much less.');
    box.type('amount', '300');
    expect(box.giveBack).toBe(
      'Give back Rs 300 Up to Rs 4,715. The order stays paid until all of it is given back. Rs 300 goes back. The rider keeps his Rs 200.',
    );
    expect(box.words).toContain('Give this to the rider: he collects Rs 300 less.');
    // The money goes back as it is chosen: the request is a plain part refund.
    box.type('reason', 'Test item refused');
    box.pin('1234');
    box.enter();
    await settle();
    expect(refundCalls()).toEqual([
      { orderId: 'o1', reason: 'Test item refused', approverPin: '1234', amountCents: 30_000, method: 'cash', expectStatus: 'out_for_delivery' },
    ]);
  });

  it('the hint is for cash only', () => {
    const box = openBox(delivery('out_for_delivery', { outside: true }));
    box.type('amount', '300');
    box.tap('EasyPaisa');
    expect(box.pressed).toEqual(['Part of it', 'EasyPaisa']);
    expect(box.words).not.toContain('Give this to the rider');
    // His keep is still his.
    expect(box.giveBack).toContain('Rs 300 goes back. The rider keeps his Rs 200.');
    box.tap('Cash');
    expect(box.words).toContain('Give this to the rider: he collects Rs 300 less.');
  });

  it('"All of it": the payout is never taken back, and the box says so word for word', () => {
    const box = openBox(delivery('out_for_delivery', { outside: true }));
    box.tap('All of it');
    expect(box.pressed).toEqual(['All of it']);
    expect(box.giveBack).toBe(
      'Give back Rs 4,715 Everything still paid goes back, the way it was paid. The order becomes Refunded. ' +
        "The rider kept Rs 200 delivery charge when this was settled. A refund does not take it back: refunding the full Rs 4,715 comes out of the shop's money.",
    );
    // No 'Give back as' on a full refund: no hint either.
    expect(box.words).not.toContain('Give this to the rider');
  });

  it('sent out with no delivery charge for him (nothing paid out): Part of it and Cash, the hint, no keep words', () => {
    const box = openBox(delivery('out_for_delivery', { outside: true, keep: 0, payout: false }));
    expect(box.pressed).toEqual(['Part of it', 'Cash']);
    expect(box.words).toContain('Give this to the rider: he collects that much less.');
    expect(box.words).not.toContain('The rider keeps his');
    box.tap('All of it');
    expect(box.words).not.toContain('The rider kept');
  });
});

describe('an outside rider’s order the customer paid for before it left (still out)', () => {
  it('opens neutral, gives back the way it was paid, and never says the rider collects less', async () => {
    const box = openBox(delivery('out_for_delivery', { outside: true, prepaid: true, method: 'card' }));
    expect(box.pressed).toEqual([]);
    expect(box.giveBack).toBe('Give back — Choose All of it or Part of it.');
    box.tap('Part of it');
    expect(box.pressed).toEqual(['Part of it', 'Card']);
    box.type('amount', '1,000');
    // The drawer paid him at Send out; that stays his. He collects nothing on this order.
    expect(box.giveBack).toContain('Rs 1,000 goes back. The rider keeps his Rs 200.');
    expect(box.words).not.toContain('Give this to the rider');
    expect(box.words).not.toContain('collects');
    // Even on Cash: no rider hint.
    box.tap('Cash');
    expect(box.words).not.toContain('Give this to the rider');
    box.tap('Card');
    box.type('reason', 'Test item refused');
    box.pin('1234');
    box.enter();
    await settle();
    expect(refundCalls()).toEqual([
      { orderId: 'o1', reason: 'Test item refused', approverPin: '1234', amountCents: 100_000, method: 'card', expectStatus: 'out_for_delivery' },
    ]);
  });

  it('paid by EasyPaisa: opens neutral; Part of it starts on EasyPaisa', () => {
    const box = openBox(delivery('out_for_delivery', { outside: true, prepaid: true, method: 'easypaisa' }));
    expect(box.pressed).toEqual([]);
    box.tap('Part of it');
    expect(box.pressed).toEqual(['Part of it', 'EasyPaisa']);
    expect(box.words).not.toContain('Give this to the rider');
  });
});

describe('an outside rider’s order he has already brought back (delivered)', () => {
  it('opens neutral; the rider words follow the choice, word for word; no hint (he is not out)', () => {
    const box = openBox(delivery('paid', { outside: true }));
    expect(box.pressed).toEqual([]);
    expect(box.giveBack).toBe('Give back — Choose All of it or Part of it.');
    box.tap('All of it');
    expect(box.giveBack).toContain(
      "The rider kept Rs 200 delivery charge when this was settled. A refund does not take it back: refunding the full Rs 4,715 comes out of the shop's money.",
    );
    box.tap('Part of it');
    expect(box.pressed).toEqual(['Part of it', 'Cash']);
    expect(box.giveBack).toContain('The rider keeps his Rs 200.');
    expect(box.giveBack).not.toContain('goes back. The rider');
    box.type('amount', '1,000');
    expect(box.giveBack).toContain('Rs 1,000 goes back. The rider keeps his Rs 200.');
    expect(box.words).not.toContain('Give this to the rider');
  });
});

describe('startOn, startMethod and note', () => {
  const NOTE = 'Test note: the rider brought less than the bill.';

  it('startOn "partial" with startMethod "cash" on an order paid by card, and the note at the top', () => {
    const box = openBox(takeaway([pay('card', 116_000)]), { startOn: 'partial', startMethod: 'cash', note: NOTE });
    expect(box.pressed).toEqual(['Part of it', 'Cash']);
    expect(box.html).toContain(`role="note"`);
    expect(box.words).toContain(NOTE);
    // At the top of the body: before the two choices.
    expect(box.html.indexOf(NOTE)).toBeLessThan(box.html.indexOf('All of it'));
    expect(box.words).not.toContain('Give this to the rider');
  });

  it('without startMethod, an order paid by card gives back by card, as before', () => {
    const box = openBox(takeaway([pay('card', 116_000)]), { startOn: 'partial' });
    expect(box.pressed).toEqual(['Part of it', 'Card']);
    expect(box.html).not.toContain('role="note"');
  });

  it('startOn "full" opens on "All of it" with the amount', () => {
    const box = openBox(takeaway(), { startOn: 'full' });
    expect(box.pressed).toEqual(['All of it']);
    expect(box.words).toContain('Refund Rs 1,160');
    expect(box.autoFocus('reason')).toBe(true);
  });

  it('startOn and startMethod win over the outside rider’s own start', () => {
    const box = openBox(delivery('out_for_delivery', { outside: true }), { startOn: 'full' });
    expect(box.pressed).toEqual(['All of it']);
    const wallet = openBox(delivery('out_for_delivery', { outside: true }), { startMethod: 'jazzcash' });
    expect(wallet.pressed).toEqual(['Part of it', 'JazzCash']);
    expect(wallet.words).not.toContain('Give this to the rider');
  });
});

describe('own riders and takeaways: no rider words', () => {
  it('an own rider’s order still out opens neutral, and no choice shows rider words', () => {
    const box = openBox(delivery('out_for_delivery', { outside: false }));
    expect(box.pressed).toEqual([]);
    for (const choice of ['All of it', 'Part of it']) {
      box.tap(choice);
      if (choice === 'Part of it') box.type('amount', '300');
      expect(box.words).not.toContain('The rider kept');
      expect(box.words).not.toContain('The rider keeps his');
      expect(box.words).not.toContain('Give this to the rider');
    }
  });

  it('an own rider’s order delivered, and a takeaway: none either', () => {
    for (const snap of [delivery('paid', { outside: false }), takeaway()]) {
      const box = openBox(snap);
      box.tap('All of it');
      expect(box.words).not.toMatch(/The rider (kept|keeps)|Give this to the rider/);
      box.tap('Part of it');
      box.type('amount', '300');
      expect(box.words).not.toMatch(/The rider (kept|keeps)|Give this to the rider/);
    }
  });
});
