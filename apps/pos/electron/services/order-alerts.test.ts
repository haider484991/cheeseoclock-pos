/**
 * The main process's list of pending order alerts (order-alerts.ts): what a
 * screen that starts late is told, when the taskbar flashes / the Windows
 * notice shows, and when they are taken away again. Pure — the database,
 * clock, timers and Electron are fakes here.
 */
import { describe, expect, it } from 'vitest';
import {
  FAILURE_TTL_MS,
  MAX_ORDER_ALERTS,
  NOTICE_DEBOUNCE_MS,
  OrderAlertsHub,
  RESTORE_MAX_AGE_MS,
  UNCHECKED_ORDER_TTL_MS,
  type AttentionNotice,
  type FailedWebOrder,
  type ReceivedWebOrder,
} from './order-alerts.js';

function setup(
  opts: {
    waiting?: Set<string> | null;
    stillWaitingThrows?: boolean;
    persistSeen?: (ids: readonly string[]) => void;
    persistClosed?: (ids: readonly string[]) => void;
  } = {},
) {
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
    ...(opts.persistSeen ? { persistSeen: opts.persistSeen } : {}),
    ...(opts.persistClosed ? { persistClosed: opts.persistClosed } : {}),
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

describe('the website cancelled an order the kitchen has', () => {
  const cancel = (webOrderId: string, orderNumber: string | null = 'CO-20261001-0042') => ({
    webOrderId,
    customerName: 'Sara',
    customerPhone: '0300-1234567',
    orderNumber,
    message: 'cancelled on the website while the kitchen had it',
    final: true,
    reason: 'cancelled_on_site' as const,
  });

  it('is a loud card that keeps its order number', () => {
    const t = setup();
    t.hub.importFailed(cancel('w42'));
    expect(t.hub.pending().failures).toEqual([
      expect.objectContaining({ webOrderId: 'w42', reason: 'cancelled_on_site', orderNumber: 'CO-20261001-0042', silenced: false }),
    ]);
    expect(t.hub.isLoud()).toBe(true);
  });

  it('its Windows notice names the order, never the phone', () => {
    const t = setup();
    t.hub.importFailed(cancel('w42'));
    t.advance(NOTICE_DEBOUNCE_MS);
    expect(t.notices).toEqual([
      {
        kind: 'importFailed',
        title: 'Website cancelled order #0042',
        body: 'The kitchen has it. Open the till and call the customer.',
      },
    ]);
    expect(JSON.stringify(t.notices)).not.toContain('0300');
  });

  it('several are counted; other kinds and new orders are mentioned after', () => {
    const t = setup();
    t.hub.importFailed(cancel('w42'));
    t.hub.importFailed(cancel('w43', 'CO-20261001-0043'));
    t.hub.importFailed({ webOrderId: 'w9', customerName: 'Ali', message: 'gave up', final: true, reason: 'gave_up' });
    t.hub.orderReceived(web('1'));
    t.advance(NOTICE_DEBOUNCE_MS);
    expect(t.notices.at(-1)).toEqual({
      kind: 'importFailed',
      title: '2 website orders were cancelled on the website',
      body: 'The kitchen has them. Open the till and call the customers. Also 1 website order did not come in. Also 1 new online order.',
    });
    expect(JSON.stringify(t.notices)).not.toContain('0300');
  });

  it('a "did not come in" card first: the cancel is counted after it', () => {
    const t = setup();
    t.hub.importFailed({ webOrderId: 'w9', customerName: 'Ali', message: 'gave up', final: true, reason: 'gave_up' });
    t.hub.importFailed(cancel('w42'));
    t.advance(NOTICE_DEBOUNCE_MS);
    expect(t.notices.at(-1)).toEqual({
      kind: 'importFailed',
      title: 'Website order from Ali did not come in',
      body: 'Open the till and call the customer. Also 1 website order was cancelled on the website.',
    });
  });

  it('without an order number it still never names the customer', () => {
    const t = setup();
    t.hub.importFailed(cancel('w42', null));
    t.advance(NOTICE_DEBOUNCE_MS);
    expect(t.notices[0]!.title).toBe('Website cancelled an order');
    expect(t.hub.pending().failures[0]).not.toHaveProperty('orderNumber');
  });
});

describe('kept across a restart', () => {
  /** setup()'s clock starts here. */
  const NOW = Date.parse('2026-09-26T12:00:00.000Z');
  const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
  const siteCancel = (webOrderId: string, orderNumber: string, at: string): FailedWebOrder => ({
    webOrderId,
    customerName: 'Sara',
    customerPhone: '0300-1234567',
    orderNumber,
    message: 'cancelled on the website while the kitchen had it',
    final: true,
    reason: 'cancelled_on_site',
    at,
  });

  it('restore() brings unseen orders back with the time they came in, oldest first', () => {
    const t = setup({ waiting: new Set(['1', '2']) });
    t.hub.restore([web('2', { receivedAt: ago(30) }), web('1', { receivedAt: ago(120) })], []);
    const p = t.hub.pending();
    expect(p.orders.map((o) => [o.orderId, o.receivedAt])).toEqual([
      ['1', ago(120)],
      ['2', ago(30)],
    ]);
    expect(t.hub.isLoud()).toBe(true);
    // One Windows notice for the lot, as for orders from one check of the website.
    t.advance(NOTICE_DEBOUNCE_MS);
    expect(t.notices).toEqual([
      { kind: 'newOrder', title: '2 new online orders', body: '#0002, #0001 — click to open the till' },
    ]);
  });

  it('restore() skips an order this process has already seen, and one it already has', () => {
    const t = setup({ waiting: new Set(['1', '2', '3']) });
    t.hub.orderReceived(web('1'));
    t.hub.acknowledge({ orderIds: ['1'] }, { loggedIn: false });
    t.hub.orderReceived(web('2'));
    t.hub.restore([web('1', { receivedAt: ago(10) }), web('2', { receivedAt: ago(10) }), web('3', { receivedAt: ago(5) })], []);
    expect(t.hub.pending().orders.map((o) => o.orderId)).toEqual(['3', '2']);
  });

  it('a time that cannot be read is taken as now', () => {
    const t = setup({ waiting: new Set(['1']) });
    t.hub.restore([web('1', { receivedAt: 'not a time' })], []);
    expect(t.hub.pending().orders[0]!.receivedAt).toBe(new Date(NOW).toISOString());
  });

  it('keeps the newest 50 when more are unseen', () => {
    const ids = Array.from({ length: MAX_ORDER_ALERTS + 5 }, (_, i) => String(i + 1));
    const t = setup({ waiting: new Set(ids) });
    t.hub.restore(
      ids.map((id, i) => web(id, { receivedAt: ago(ids.length - i) })),
      [],
    );
    const kept = t.hub.pending().orders.map((o) => o.orderId);
    expect(kept).toHaveLength(MAX_ORDER_ALERTS);
    expect(kept[0]).toBe('6');
    expect(kept.at(-1)).toBe(String(MAX_ORDER_ALERTS + 5));
  });

  it('a "website cancelled" card comes back loud, with its order number and the time it happened', () => {
    const t = setup();
    // What the database gives back carries no 'final': a restored card is final by definition.
    const { final: _final, ...fromDb } = siteCancel('w42', 'CO-20260926-0042', ago(90));
    t.hub.restore([], [fromDb]);
    expect(t.hub.pending().failures).toEqual([
      expect.objectContaining({
        webOrderId: 'w42',
        reason: 'cancelled_on_site',
        orderNumber: 'CO-20260926-0042',
        silenced: false,
        at: ago(90),
      }),
    ]);
    expect(t.hub.isLoud()).toBe(true);
    // It still goes 12 hours after the cancel, not 12 hours after the restart.
    t.advance(FAILURE_TTL_MS - 90 * 60_000 + 1);
    expect(t.hub.pending().failures).toHaveLength(0);
  });

  it('orders first: a card for an order still on the green row is kept (not taken for "a retry that worked")', () => {
    const t = setup({ waiting: new Set(['42']) });
    t.hub.restore([web('42', { webOrderId: 'w42', receivedAt: ago(40) })], [siteCancel('w42', 'CO-20260926-0042', ago(2))]);
    const p = t.hub.pending();
    expect(p.orders.map((o) => o.orderId)).toEqual(['42']);
    expect(p.failures.map((f) => f.webOrderId)).toEqual(['w42']);
  });

  it('restore() never throws, whatever it is given', () => {
    const t = setup();
    expect(() => t.hub.restore(null as never, undefined as never)).not.toThrow();
    expect(() => t.hub.restore([null as never, { orderId: '' } as never], [null as never, {} as never])).not.toThrow();
    expect(t.hub.pending()).toEqual({ orders: [], failures: [] });
  });

  it('looks back as far as a failure card is kept: 12 hours', () => {
    expect(RESTORE_MAX_AGE_MS).toBe(FAILURE_TTL_MS);
    expect(RESTORE_MAX_AGE_MS).toBe(12 * 60 * 60_000);
  });

  it('Seen is saved: acknowledge hands the order ids to persistSeen, signed in or not', () => {
    const seen: string[][] = [];
    const t = setup({ waiting: new Set(['1', '2']), persistSeen: (ids) => seen.push([...ids]) });
    t.hub.orderReceived(web('1'));
    t.hub.orderReceived(web('2'));
    t.hub.acknowledge({ orderIds: ['1', 7 as never, '2'] }, { loggedIn: false });
    t.hub.acknowledge({ orderIds: ['9'] }, { loggedIn: true });
    // Silencing or closing alone saves no Seen.
    t.hub.acknowledge({ silenceFailureIds: ['w1'], closeFailureIds: ['w1'] }, { loggedIn: true });
    expect(seen).toEqual([['1', '2'], ['9']]);
  });

  it('closing is saved only with someone signed in', () => {
    const closed: string[][] = [];
    const t = setup({ persistClosed: (ids) => closed.push([...ids]) });
    t.hub.importFailed(siteCancel('w42', 'CO-20260926-0042', ago(1)));
    t.hub.acknowledge({ closeFailureIds: ['w42'] }, { loggedIn: false });
    expect(closed).toEqual([]);
    expect(t.hub.pending().failures).toHaveLength(1);
    t.hub.acknowledge({ closeFailureIds: ['w42', 3 as never] }, { loggedIn: true });
    expect(closed).toEqual([['w42']]);
    expect(t.hub.pending().failures).toHaveLength(0);
  });

  it('a save that throws only warns: the alert is still seen or closed', () => {
    const t = setup({
      waiting: new Set(['1']),
      persistSeen: () => {
        throw new Error('SQLITE_BUSY');
      },
      persistClosed: () => {
        throw new Error('SQLITE_BUSY');
      },
    });
    t.hub.orderReceived(web('1'));
    t.hub.importFailed(siteCancel('w42', 'CO-20260926-0042', ago(1)));
    let p = t.hub.acknowledge({ orderIds: ['1'] }, { loggedIn: false });
    expect(p.orders).toHaveLength(0);
    p = t.hub.acknowledge({ closeFailureIds: ['w42'] }, { loggedIn: true });
    expect(p.failures).toHaveLength(0);
    expect(t.warnings).toEqual(['Order alert seen-mark not saved', 'Order alert seen-mark not saved']);
    expect(t.hub.isLoud()).toBe(false);
  });
});
