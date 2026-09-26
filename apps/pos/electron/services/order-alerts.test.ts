/**
 * The main process's list of pending order alerts (order-alerts.ts): what a
 * screen that starts late is told, when the taskbar flashes / the Windows
 * notice shows, and when they are taken away again. Pure — the database,
 * clock, timers and Electron are fakes here.
 */
import { describe, expect, it } from 'vitest';
import {
  FAILURE_TTL_MS,
  NOTICE_DEBOUNCE_MS,
  OrderAlertsHub,
  UNCHECKED_ORDER_TTL_MS,
  type AttentionNotice,
  type ReceivedWebOrder,
} from './order-alerts.js';

function setup(opts: { waiting?: Set<string> | null; stillWaitingThrows?: boolean } = {}) {
  let now = Date.parse('2026-09-26T12:00:00.000Z');
  let waiting: Set<string> | null = opts.waiting === undefined ? null : opts.waiting;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 1;
  const notices: AttentionNotice[] = [];
  let clears = 0;
  const warnings: string[] = [];
  const hub = new OrderAlertsHub({
    now: () => now,
    stillWaiting: (ids) => {
      if (opts.stillWaitingThrows) throw new Error('database is closed');
      return waiting ? new Set(ids.filter((id) => waiting!.has(id))) : null;
    },
    requestAttention: (n) => notices.push(n),
    clearAttention: () => {
      clears += 1;
    },
    formatMoney: (c) => `Rs ${(c / 100).toLocaleString('en-PK')}`,
    warn: (m) => warnings.push(m),
    schedule: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    cancel: (h) => {
      timers.delete(h as number);
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  return {
    hub,
    notices,
    warnings,
    advance,
    clears: () => clears,
    setWaiting: (s: Set<string> | null) => {
      waiting = s;
    },
  };
}

const web = (id: string, extra: Partial<ReceivedWebOrder> = {}): ReceivedWebOrder => ({
  orderId: id,
  orderNumber: `CO-20260926-${id.padStart(4, '0')}`,
  customerName: 'Ali',
  webOrderId: `w${id}`,
  fulfilment: 'delivery',
  totalCents: 185_000,
  ...extra,
});

describe('orders that came in before the screen was listening', () => {
  it('are kept until someone looks, so a screen that starts late still rings', () => {
    const { hub } = setup({ waiting: new Set(['1', '2']) });
    hub.orderReceived(web('1'));
    hub.orderReceived(web('2', { fulfilment: 'pickup', totalCents: null }));
    const p = hub.pending();
    expect(p.orders.map((o) => o.orderId)).toEqual(['1', '2']);
    expect(p.orders[1]).toMatchObject({ fulfilment: 'pickup', totalCents: null, webOrderId: 'w2' });
  });

  it('the same event twice is one alert', () => {
    const { hub } = setup();
    hub.orderReceived(web('1'));
    hub.orderReceived(web('1'));
    expect(hub.pending().orders).toHaveLength(1);
  });

  it('drop out once the order is started, voided or done', () => {
    const t = setup({ waiting: new Set(['1', '2']) });
    t.hub.orderReceived(web('1'));
    t.hub.orderReceived(web('2'));
    t.setWaiting(new Set(['2']));
    expect(t.hub.pending().orders.map((o) => o.orderId)).toEqual(['2']);
    // …and never come back, even if the event is repeated.
    t.hub.orderReceived(web('1'));
    expect(t.hub.pending().orders.map((o) => o.orderId)).toEqual(['2']);
  });

  it('stay while the order is still not started, however long (the database says so)', () => {
    const t = setup({ waiting: new Set(['1']) });
    t.hub.orderReceived(web('1'));
    t.advance(3 * UNCHECKED_ORDER_TTL_MS);
    expect(t.hub.pending().orders).toHaveLength(1);
  });

  it('are forgotten after an hour when the database cannot say', () => {
    const t = setup({ waiting: null });
    t.hub.orderReceived(web('1'));
    t.advance(UNCHECKED_ORDER_TTL_MS - 1);
    expect(t.hub.pending().orders).toHaveLength(1);
    t.advance(2);
    expect(t.hub.pending().orders).toHaveLength(0);
  });

  it('a database error never loses the list or throws', () => {
    const t = setup({ stillWaitingThrows: true });
    t.hub.orderReceived(web('1'));
    expect(() => t.hub.pending()).not.toThrow();
    expect(t.hub.pending().orders).toHaveLength(1);
  });

  it('bad input never throws', () => {
    const { hub } = setup();
    expect(() => hub.orderReceived(null as unknown as ReceivedWebOrder)).not.toThrow();
    expect(() => hub.orderReceived({ orderId: '' } as ReceivedWebOrder)).not.toThrow();
    expect(() => hub.importFailed(undefined as never)).not.toThrow();
    expect(() => hub.acknowledge(undefined as never, { loggedIn: true })).not.toThrow();
    expect(hub.pending()).toEqual({ orders: [], failures: [] });
  });
});

describe('seen, silenced, closed', () => {
  it('Seen takes the order away for good', () => {
    const t = setup({ waiting: new Set(['1']) });
    t.hub.orderReceived(web('1'));
    const p = t.hub.acknowledge({ orderIds: ['1'] }, { loggedIn: false });
    expect(p.orders).toHaveLength(0);
    t.hub.orderReceived(web('1'));
    expect(t.hub.pending().orders).toHaveLength(0);
  });

  it('a failure card is silenced by anyone but closed only with a login', () => {
    const t = setup();
    t.hub.importFailed({ webOrderId: 'w9', customerName: 'Sara', customerPhone: '0300', message: 'gave up', final: true, reason: 'gave_up' });
    let p = t.hub.acknowledge({ silenceFailureIds: ['w9'], closeFailureIds: ['w9'] }, { loggedIn: false });
    expect(p.failures).toEqual([expect.objectContaining({ webOrderId: 'w9', silenced: true, customerPhone: '0300' })]);
    p = t.hub.acknowledge({ closeFailureIds: ['w9'] }, { loggedIn: true });
    expect(p.failures).toHaveLength(0);
    // Closed: the same failure reported again does not come back.
    t.hub.importFailed({ webOrderId: 'w9', customerName: 'Sara', message: 'gave up', final: true });
    expect(t.hub.pending().failures).toHaveLength(0);
  });

  it('old failure cards go after 12 hours', () => {
    const t = setup();
    t.hub.importFailed({ webOrderId: 'w9', customerName: 'Sara', message: 'x', final: true });
    t.advance(FAILURE_TTL_MS + 1);
    expect(t.hub.pending().failures).toHaveLength(0);
  });
});

describe('import failures', () => {
  it('a failed try that will be retried is not kept (no "call the customer" yet)', () => {
    const { hub } = setup();
    hub.importFailed({ webOrderId: 'w1', customerName: 'Sara', message: 'timeout', final: false });
    hub.importFailed({ webOrderId: 'w2', customerName: 'Sara', message: 'timeout' });
    expect(hub.pending().failures).toHaveLength(0);
  });

  it('one card per website order', () => {
    const { hub } = setup();
    hub.importFailed({ webOrderId: 'w1', customerName: 'Sara', message: 'gave up', final: true, reason: 'gave_up' });
    hub.importFailed({ webOrderId: 'w1', customerName: 'Sara', message: 'gave up', final: true, reason: 'gave_up' });
    expect(hub.pending().failures).toHaveLength(1);
  });

  it('came in while the till was off: a card with no alarm and no Windows notice', () => {
    const t = setup();
    t.hub.importFailed({ webOrderId: 'w1', customerName: 'Sara', message: 'stale', final: true, reason: 'stale' });
    expect(t.hub.pending().failures[0]).toMatchObject({ reason: 'stale', silenced: true });
    expect(t.hub.isLoud()).toBe(false);
    t.advance(NOTICE_DEBOUNCE_MS);
    expect(t.notices).toHaveLength(0);
  });

  it('an order that came in on a later try clears its failure', () => {
    const { hub } = setup();
    hub.importFailed({ webOrderId: 'w5', customerName: 'Sara', message: 'gave up', final: true });
    hub.orderReceived(web('5', { webOrderId: 'w5' }));
    expect(hub.pending().failures).toHaveLength(0);
  });
});

describe('taskbar flash and Windows notice', () => {
  it('one notice for orders from one check of the website', () => {
    const t = setup();
    t.hub.orderReceived(web('1'));
    t.advance(300);
    t.hub.orderReceived(web('2'));
    t.advance(NOTICE_DEBOUNCE_MS);
    expect(t.notices).toEqual([
      { kind: 'newOrder', title: '2 new online orders', body: '#0001, #0002 — click to open the till' },
    ]);
  });

  it('one order: its number, delivery or pick-up, total and name', () => {
    const t = setup();
    t.hub.orderReceived(web('42'));
    t.advance(NOTICE_DEBOUNCE_MS);
    expect(t.notices[0]).toEqual({
      kind: 'newOrder',
      title: 'New online order #0042',
      body: 'Delivery · Rs 1,850 · Ali — click to open the till',
    });
  });

  it('a failed order comes first, without the phone number (the notice sits in Action Center)', () => {
    const t = setup();
    t.hub.orderReceived(web('1'));
    t.hub.importFailed({ webOrderId: 'w9', customerName: 'Sara', customerPhone: '0300-1234567', message: 'x', final: true });
    t.advance(NOTICE_DEBOUNCE_MS);
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toMatchObject({ kind: 'importFailed', title: 'Website order from Sara did not come in' });
    expect(t.notices[0]!.body).toContain('Also 1 new online order.');
    expect(JSON.stringify(t.notices)).not.toContain('0300');
  });

  it('is taken away when nothing is left to look at', () => {
    const t = setup({ waiting: new Set(['1']) });
    t.hub.orderReceived(web('1'));
    t.advance(NOTICE_DEBOUNCE_MS);
    expect(t.clears()).toBe(0);
    t.hub.acknowledge({ orderIds: ['1'] }, { loggedIn: false });
    expect(t.clears()).toBe(1);
  });

  it('seen before the pause is over: no notice at all', () => {
    const t = setup();
    t.hub.orderReceived(web('1'));
    t.hub.acknowledge({ orderIds: ['1'] }, { loggedIn: false });
    t.advance(NOTICE_DEBOUNCE_MS);
    expect(t.notices).toHaveLength(0);
  });

  it('stays while an alarm is still ringing', () => {
    const t = setup();
    t.hub.orderReceived(web('1'));
    t.hub.importFailed({ webOrderId: 'w9', customerName: 'Sara', message: 'x', final: true });
    t.hub.acknowledge({ orderIds: ['1'] }, { loggedIn: false });
    expect(t.clears()).toBe(0);
    t.hub.acknowledge({ silenceFailureIds: ['w9'] }, { loggedIn: false });
    expect(t.clears()).toBe(1);
  });

  it('goes when the order is started elsewhere (noticed on the next check)', () => {
    const t = setup({ waiting: new Set(['1']) });
    t.hub.orderReceived(web('1'));
    t.setWaiting(new Set());
    t.hub.pending();
    expect(t.clears()).toBe(1);
  });
});
