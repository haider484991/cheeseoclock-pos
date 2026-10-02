/**
 * The Cancel box and the outside rider's wasted trip (v0.7.34, step 18-8b;
 * the owner, 2 Oct 2026: "YES, pay the rider's fee if they went"; order-edit
 * finding #3). Rendered to static markup (react-dom/server, no browser), with
 * the harness of refundOrderDialog.test.tsx: React's useState is stood in for
 * by slots kept from one render to the next, a tap, a typed word or Enter is
 * the handler as it was rendered, and the box is rendered again after it. The
 * till's IPC is a stand-in that records each call; the toasts are recorded
 * too. Every name, number and amount is made up.
 *
 *  - An order an outside rider (Send out) still has: 'The rider has the bill
 *    for #0042: take it back.'
 *  - When he keeps a charge and nothing was paid to him yet: the required
 *    question 'Pay the rider Rs 200 for the trip?' — 'Yes, pay Rs 200 ·
 *    drawer opens' or 'No'. Enter with no answer only says 'Tap Yes or No for
 *    the rider's trip' and asks nothing of the till.
 *  - The answer goes to the till as payRiderForTrip; Yes adds 'Rider paid
 *    Rs 200 for the trip — the drawer opens.' to the cancel's note.
 *  - No question for own riders, for a rider who keeps nothing, or when the
 *    drawer already paid him; no payRiderForTrip is sent then.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AuthenticatedUser,
  OrderSnapshot,
  OrderStatus,
  OrderStockStatus,
  StockSettlement,
  UUID,
} from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { SecretInput } from '../../components/secret/SecretInput';
import { useSessionStore } from '../../stores/sessionStore';
import { tripToPayCents, voidDoneToast, VoidOrderDialog } from './VoidOrderDialog';

/** useState's slots, kept between renders: `cursor` is where this render is. */
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));

vi.mock('react', async (importOriginal) => {
  const React = await importOriginal<typeof import('react')>();
  function useState<T>(init: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
    const i = hooks.cursor++;
    if (i >= hooks.slots.length)
      hooks.slots.push(typeof init === 'function' ? (init as () => T)() : init);
    const set = (next: T | ((prev: T) => T)) => {
      hooks.slots[i] =
        typeof next === 'function' ? (next as (prev: T) => T)(hooks.slots[i] as T) : next;
    };
    return [hooks.slots[i] as T, set];
  }
  return { ...React, useState, default: { ...React, useState } };
});

/** What the box asked of the till, what it toasted, the box's body as last rendered, and a refusal to give. */
const seen = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  toasts: [] as Array<{ title: string; description?: string; variant?: string }>,
  content: null as unknown,
  refuse: null as string | null,
  /** The order the stand-in till cancels. */
  snap: null as unknown,
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
        // As the till answers: the order cancelled; with Yes, the trip payout on it.
        void: async (req: { payRiderForTrip?: boolean }) => {
          seen.calls.push(['orders.void', req]);
          if (seen.refuse) throw new Error(seen.refuse);
          const snap = seen.snap as OrderSnapshot;
          const keep = (snap.order.riderKeepsCents ?? 0) as number;
          return {
            ...snap,
            order: { ...snap.order, status: 'void' },
            ...(req.payRiderForTrip === true
              ? { deliveryChargeToRider: { amountCents: keep, at: NOW, why: 'trip' } }
              : {}),
            stock: null,
          };
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
  useSessionStore.setState({
    user: { id: 'u1' as UUID, fullName: 'Test', role, sessionId: 's1' as UUID },
    status: 'authenticated',
  });
}

const decode = (s: string) =>
  s
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
const text = (markup: string) =>
  decode(markup.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/** Lets the mutation run to the end (its till call, then its toasts). */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

/** A React element as JSX made it. */
type El = { type: unknown; props: Record<string, unknown> };
const isEl = (n: unknown): n is El =>
  typeof n === 'object' && n !== null && 'type' in n && 'props' in n;
/**
 * The box's own parts that call no hook: rendered here as plain functions, so
 * their buttons can be tapped (the trip's Yes / No, "Was the food made?").
 */
const PARTS = new Set(['TripButton', 'FoodMadeQuestion', 'AnswerButton']);
function* walk(node: unknown): Generator<El> {
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n);
  } else if (isEl(node)) {
    yield node;
    if (typeof node.type === 'function' && PARTS.has((node.type as { name: string }).name)) {
      yield* walk((node.type as (p: Record<string, unknown>) => unknown)(node.props));
    }
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

const TRIP_LINE = 'The rider has the bill for #0042: take it back.';
const QUESTION = 'Pay the rider Rs 200 for the trip?';
const YES = 'Yes, pay Rs 200 · drawer opens';

/**
 * The owner's example as a delivery out with its rider, not paid: Test Family
 * Pizza and 'Delivery Charge (Rs 200)', Rs 4,715. `outside`: sent out with an
 * outside rider (Send out) who keeps `keep`; `payout`: what the drawer has
 * already paid him for it (none by default). Otherwise one of the shop's own
 * riders (Assign rider).
 */
function outFor({
  outside = true,
  keep = 20_000,
  payout = null,
  status = 'out_for_delivery' as OrderStatus,
}: {
  outside?: boolean;
  keep?: number;
  payout?: OrderSnapshot['deliveryChargeToRider'];
  status?: OrderStatus;
} = {}): OrderSnapshot {
  return {
    order: {
      id: 'o1',
      orderNumber: '20261002-0042',
      mode: 'delivery',
      status,
      source: 'pos',
      notes: null,
      subtotalCents: 410_000,
      discountCents: 0,
      taxCents: 61_500,
      totalCents: 471_500,
      createdAt: minsAgo(40),
      sentAt: minsAgo(40),
      paidAt: null,
      voidedAt: null,
      voidReason: null,
      assignedRiderId: outside ? null : 'r1',
      dispatchedAt: status === 'out_for_delivery' ? minsAgo(15) : null,
      deliveredAt: null,
      ...(outside ? { riderKeepsCents: keep } : {}),
    },
    items: [
      {
        id: 'l1',
        parentOrderItemId: null,
        quantity: 1,
        menuItemName: 'Test Family Pizza',
        modifiers: [],
        notes: null,
        lineTotalCents: 390_000,
      },
      {
        id: 'l2',
        parentOrderItemId: null,
        quantity: 1,
        menuItemName: 'Delivery Charge (Rs 200)',
        modifiers: [],
        notes: null,
        lineTotalCents: 20_000,
      },
    ],
    discounts: [],
    payments: [],
    cashierName: 'Test Cashier',
    tableLabel: null,
    customerName: 'Test Customer',
    customerPhone: '03001234567',
    deliveryAddress: 'House 1, Made-up Street',
    deliveryNotes: null,
    rider: outside ? null : { id: 'r1', name: 'Test Rider', phone: '03000000001' },
    ...(outside ? { deliveryChargeToRider: payout } : {}),
  } as unknown as OrderSnapshot;
}

/** orders:stockStatus as the till answers it: nothing to ask, or "Was the food made?". */
function stockOf(snap: OrderSnapshot, ask: boolean): OrderStockStatus {
  return {
    orderId: snap.order.id,
    status: snap.order.status,
    state: ask ? 'out' : 'none',
    takenAt: ask ? minsAgo(40) : null,
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

/** The Cancel box open on this order, rendered again after every tap, word or Enter. */
function openBox(snap: OrderSnapshot, { askStock = false } = {}) {
  signIn('manager');
  hooks.slots = [];
  seen.snap = snap;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['orders', 'stock', snap.order.id], stockOf(snap, askStock));
  let html = '';
  let calls = -1;
  let done = 0;
  let closed = 0;
  const view = () => {
    hooks.cursor = 0;
    seen.content = null;
    html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ToastProvider>
            <VoidOrderDialog snap={snap} onClose={() => (closed += 1)} onDone={() => (done += 1)} />
          </ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // The slots are kept by call order: the same number of calls every render, or they mean nothing.
    if (calls >= 0 && hooks.cursor !== calls)
      throw new Error(`useState was called ${hooks.cursor} times, not ${calls}`);
    calls = hooks.cursor;
  };
  view();
  const one = (what: string, match: (e: El) => boolean): El => {
    const hits = [...walk(seen.content)].filter(match);
    if (hits.length !== 1) throw new Error(`${hits.length} × ${what}`);
    return hits[0]!;
  };
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
    get closed() {
      return closed;
    },
    /** The words of every pressed button (aria-pressed="true"). */
    get pressed() {
      return html
        .split('<button')
        .slice(1)
        .filter((b) => b.slice(0, b.indexOf('>')).includes('aria-pressed="true"'))
        .map((b) => text(`<x${b.split('</button>')[0]!}`));
    },
    /** The words of every button that can be pressed (aria-pressed true or false). */
    get pressable() {
      return html
        .split('<button')
        .slice(1)
        .filter((b) => b.slice(0, b.indexOf('>')).includes('aria-pressed='))
        .map((b) => text(`<x${b.split('</button>')[0]!}`));
    },
    /** A plain button in the box, by its words run together ('Not madePut the stock back'). */
    tap(words: string) {
      const b = one(
        `button "${words}"`,
        (e) => e.type === 'button' && wordsOf(e.props['children']).trim() === words,
      );
      (b.props['onClick'] as () => void)();
      view();
    },
    reason(value: string) {
      const input = one('reason box', (e) => e.type === 'input' && e.props['id'] === 'void-reason');
      (input.props['onChange'] as (e: { target: { value: string } }) => void)({
        target: { value },
      });
      view();
    },
    pin(value: string) {
      (one('PIN box', (e) => e.type === SecretInput).props['onChange'] as (v: string) => void)(
        value,
      );
      view();
    },
    /** Enter anywhere in the box: the form's submit. */
    enter() {
      (
        one('form', (e) => e.type === 'form').props['onSubmit'] as (e: {
          preventDefault: () => void;
        }) => void
      )({
        preventDefault() {},
      });
      view();
    },
  };
}

const voidCalls = () => seen.calls.filter(([name]) => name === 'orders.void').map(([, req]) => req);

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
  seen.refuse = null;
});
afterEach(() => {
  useSessionStore.setState({ user: null, status: 'idle' });
});

describe('an order an outside rider took out (Send out): the bill comes back, and his trip', () => {
  it('says the rider has the bill, and asks "Pay the rider Rs 200 for the trip?" with neither answer chosen', () => {
    const box = openBox(outFor());
    expect(box.words).toContain(TRIP_LINE);
    expect(box.words).toContain(`${QUESTION} ${YES} No`);
    expect(box.pressable).toEqual(expect.arrayContaining([YES, 'No']));
    expect(box.pressed).toEqual([]);
    // Above the manager's PIN, which approves it all.
    expect(box.words.indexOf(QUESTION)).toBeLessThan(box.words.indexOf('Manager PIN or password'));
  });

  it('Enter with no answer only says "Tap Yes or No for the rider\'s trip": nothing is sent', async () => {
    const box = openBox(outFor());
    box.reason('Test customer not home');
    box.pin('1234');
    box.enter();
    await settle();
    expect(seen.toasts).toEqual([
      { title: "Tap Yes or No for the rider's trip", variant: 'warning' },
    ]);
    expect(voidCalls()).toEqual([]);
    expect(box.done).toBe(0);
    expect(box.closed).toBe(0);
    // Still asking.
    expect(box.words).toContain(QUESTION);
  });

  it('Yes: the till is told payRiderForTrip true, and the note says the rider was paid and the drawer opens', async () => {
    const box = openBox(outFor());
    box.tap(YES);
    expect(box.pressed).toEqual([YES]);
    box.reason('Test customer not home');
    box.pin('1234');
    box.enter();
    await settle();
    expect(voidCalls()).toEqual([
      {
        orderId: 'o1',
        reason: 'Test customer not home',
        approverPin: '1234',
        expectStatus: 'out_for_delivery',
        payRiderForTrip: true,
      },
    ]);
    expect(seen.toasts).toEqual([
      {
        title: 'Order cancelled',
        description: 'Rider paid Rs 200 for the trip — the drawer opens.',
      },
    ]);
    expect(box.done).toBe(1);
  });

  it('No: payRiderForTrip false, and the note is the plain cancel', async () => {
    const box = openBox(outFor());
    box.tap('No');
    expect(box.pressed).toEqual(['No']);
    box.reason('Test customer not home');
    box.pin('1234');
    box.enter();
    await settle();
    expect(voidCalls()).toEqual([
      {
        orderId: 'o1',
        reason: 'Test customer not home',
        approverPin: '1234',
        expectStatus: 'out_for_delivery',
        payRiderForTrip: false,
      },
    ]);
    expect(seen.toasts).toEqual([{ title: 'Order cancelled' }]);
    expect(box.done).toBe(1);
  });

  it('the answer can be changed before Enter: the last tap is what is sent', async () => {
    const box = openBox(outFor());
    box.tap(YES);
    box.tap('No');
    expect(box.pressed).toEqual(['No']);
    box.tap(YES);
    expect(box.pressed).toEqual([YES]);
    box.reason('Test customer not home');
    box.pin('1234');
    box.enter();
    await settle();
    expect(voidCalls()).toEqual([expect.objectContaining({ payRiderForTrip: true })]);
  });

  it('asked after "Was the food made?" and before the PIN: each missing answer has its own word, in that order', async () => {
    const box = openBox(outFor(), { askStock: true });
    expect(box.words.indexOf('Was the food made?')).toBeLessThan(box.words.indexOf(QUESTION));
    box.reason('Test customer not home');
    box.enter();
    box.tap('MadeFood is gone — counts as waste');
    box.enter();
    box.tap('No');
    box.enter();
    await settle();
    expect(seen.toasts.map((t) => t.title)).toEqual([
      'Tap Made or Not made',
      "Tap Yes or No for the rider's trip",
      expect.stringMatching(/PIN|password/i),
    ]);
    expect(voidCalls()).toEqual([]);
    box.pin('1234');
    box.enter();
    await settle();
    expect(voidCalls()).toEqual([
      {
        orderId: 'o1',
        reason: 'Test customer not home',
        approverPin: '1234',
        expectStatus: 'out_for_delivery',
        foodMade: 'made',
        putBack: [],
        payRiderForTrip: false,
      },
    ]);
  });

  it("Yes with no shift open: the till refuses it and the box says so in the till's words, still open", async () => {
    seen.refuse = 'No shift is open on this till — open a shift to pay the rider for the trip';
    const box = openBox(outFor());
    box.tap(YES);
    box.reason('Test customer not home');
    box.pin('1234');
    box.enter();
    await settle();
    expect(voidCalls()).toEqual([expect.objectContaining({ payRiderForTrip: true })]);
    expect(seen.toasts).toEqual([
      {
        title: 'Could not cancel',
        description: 'No shift is open on this till — open a shift to pay the rider for the trip',
        variant: 'error',
      },
    ]);
    expect(box.done).toBe(0);
    expect(box.closed).toBe(0);
  });
});

describe('no trip question: nothing to pay him, or not an outside rider', () => {
  it('sent out with no delivery charge for him (keeps Rs 0): the take-it-back line, no question, no answer sent', async () => {
    const box = openBox(outFor({ keep: 0 }));
    expect(box.words).toContain(TRIP_LINE);
    expect(box.words).not.toContain('for the trip?');
    expect(box.pressable).not.toContain('No');
    box.reason('Test customer not home');
    box.pin('1234');
    box.enter();
    await settle();
    expect(voidCalls()).toEqual([
      {
        orderId: 'o1',
        reason: 'Test customer not home',
        approverPin: '1234',
        expectStatus: 'out_for_delivery',
      },
    ]);
    expect(seen.toasts).toEqual([{ title: 'Order cancelled' }]);
  });

  it('the drawer already paid him for it: the take-it-back line, no question, no answer sent', async () => {
    for (const why of ['kept', 'trip'] as const) {
      seen.calls.length = 0;
      const box = openBox(
        outFor({ payout: { amountCents: 20_000 as never, at: minsAgo(10), why } }),
      );
      expect(box.words).toContain(TRIP_LINE);
      expect(box.words).not.toContain('for the trip?');
      box.reason('Test customer not home');
      box.pin('1234');
      box.enter();
      await settle();
      expect(voidCalls()).toEqual([
        {
          orderId: 'o1',
          reason: 'Test customer not home',
          approverPin: '1234',
          expectStatus: 'out_for_delivery',
        },
      ]);
    }
  });

  it("one of the shop's own riders (Assign rider): no rider words, no question, no answer sent", async () => {
    const box = openBox(outFor({ outside: false }));
    expect(box.words).not.toContain('take it back');
    expect(box.words).not.toContain('for the trip?');
    box.reason('Test customer not home');
    box.pin('1234');
    box.enter();
    await settle();
    expect(voidCalls()).toEqual([
      {
        orderId: 'o1',
        reason: 'Test customer not home',
        approverPin: '1234',
        expectStatus: 'out_for_delivery',
      },
    ]);
    expect(seen.toasts).toEqual([{ title: 'Order cancelled' }]);
  });

  it('an order still in the shop: the box as before', () => {
    const box = openBox(outFor({ outside: false, status: 'ready' }));
    expect(box.words).not.toMatch(/rider/i);
  });
});

describe('the rule and the note, as plain functions', () => {
  it('tripToPayCents: what he keeps, only for an unpaid outside order still out with nothing paid to him yet', () => {
    expect(tripToPayCents(outFor())).toBe(20_000);
    expect(tripToPayCents(outFor({ keep: 25_000 }))).toBe(25_000);
    expect(tripToPayCents(outFor({ keep: 0 }))).toBeNull();
    expect(tripToPayCents(outFor({ outside: false }))).toBeNull();
    expect(
      tripToPayCents(outFor({ payout: { amountCents: 20_000 as never, at: NOW, why: 'kept' } })),
    ).toBeNull();
    const paid = outFor();
    expect(
      tripToPayCents({ ...paid, order: { ...paid.order, paidAt: NOW } } as OrderSnapshot),
    ).toBeNull();
    expect(tripToPayCents(outFor({ status: 'void' }))).toBeNull();
  });

  it('voidDoneToast: the payout from the till’s reply, after the stock words; nothing added without a trip', () => {
    const drinks = {
      outcome: 'made',
      drinksBack: 1,
      wastedLines: 1,
      returnedLines: 0,
      hasCosts: false,
      wasteCents: 0,
    } as unknown as StockSettlement;
    expect(
      voidDoneToast(
        {
          stock: drinks,
          deliveryChargeToRider: { amountCents: 25_000 as never, at: NOW, why: 'trip' },
        },
        20_000,
      ),
    ).toEqual({
      title: 'Order cancelled · counted as waste',
      description:
        'Rider paid Rs 250 for the trip — the drawer opens. The sealed drink went back in the fridge.',
    });
    // The reply carries no trip payout: the box's own figure.
    expect(voidDoneToast({ stock: null, deliveryChargeToRider: null }, 20_000)).toEqual({
      title: 'Order cancelled',
      description: 'Rider paid Rs 200 for the trip — the drawer opens.',
    });
    expect(voidDoneToast({ stock: null }, null)).toEqual({ title: 'Order cancelled' });
  });

  it('no native confirm() or alert() in the box', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./VoidOrderDialog.tsx', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/\b(window\.)?(confirm|alert)\s*\(/);
  });
});
