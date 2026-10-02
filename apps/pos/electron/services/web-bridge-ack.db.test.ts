/**
 * The website's ack, checked, recorded and retried (v0.7.33): the till used
 * to send the ack and forget it, so an ack that did not land left the order
 * 'new' on the website until its 45-minute cancel, and nobody at the till
 * knew. Now:
 *   - the import stores when the customer placed the order and what the
 *     website showed them (web_created_at, web_total_cents, 0046);
 *   - an ack that lands is recorded (acked_at); one that does not (no
 *     answer, a refusal) is logged with its status and asked again on every
 *     poll before the GET (and before the GET of the owner's switch-off
 *     drain), whatever the owner's switch says, stopping at the first
 *     failure; an answer that never comes is given up on in time;
 *   - acked:false is checked with the till's own status: a website that
 *     answers it cancelled an order the kitchen has raises ONE loud
 *     'cancelled_on_site' card with the order number; any other answer (a
 *     404 included) counts as confirmed;
 *   - the status push raises the same card, once;
 *   - and (v0.7.34) it follows Send out ('out_for_delivery') and Back to
 *     Ready ('ready') on a website delivery.
 *
 * A real database built from every migration (node:sqlite behind
 * better-sqlite3's shape — costing-shop.fixture.ts), the real order import,
 * the real alert list, and a stand-in for the website's API that records
 * every call. Names, phone numbers, amounts and the site are made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebOrder } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import { CASHIER, DEV, DatabaseSync, OWNER, openCostingShop, openMigrated } from '../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const h = vi.hoisted(() => ({
  /** electron-log warn lines: [message, detail]. */
  warnings: [] as Array<[string, unknown]>,
  /** What the bridge sent to the till window: [channel, payload]. */
  screen: [] as Array<[string, unknown]>,
}));

vi.mock('electron-log/main', () => ({
  default: {
    info: () => {},
    error: () => {},
    warn: (message: string, detail?: unknown) => h.warnings.push([message, detail]),
  },
}));
vi.mock('electron', () => {
  // One till window, in front (so the alert list shows no Windows notice).
  const win = {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    isFocused: () => true,
    flashFrame: () => {},
    webContents: { send: (channel: string, payload: unknown) => h.screen.push([channel, payload]) },
  };
  return {
    BrowserWindow: { getAllWindows: () => [win] },
    app: { getPath: () => '', getVersion: () => '0.0.0-test' },
    // No OS keychain in a test: secrets are stored as typed.
    safeStorage: { isEncryptionAvailable: () => false },
    Notification: class {
      static isSupported() {
        return false;
      }
    },
  };
});
// The kitchen ticket is not what this is about.
vi.mock('./print-spooler.js', () => ({ printSpooler: { onOrderEvent: () => {} } }));

const live = describe.skipIf(!DatabaseSync);

const SITE = 'https://shop.example.test';
const PHONE = '0300-5550123';
type Row = Record<string, unknown>;

/** What the stand-in website answers: a status and a JSON body, or no answer at all. */
type Answer = { status: number; body?: unknown } | 'offline';
interface Call {
  path: string;
  body: Row | null;
}

interface BridgeInside {
  db: AppDatabase | null;
  deviceId: string;
  systemUserId: string | null;
  api: (cfg: unknown, path: string, init?: { method?: string; body?: string }) => Promise<unknown>;
  importOne(cfg: unknown, web: WebOrder): Promise<void>;
  tick(): Promise<void>;
  retryAcks(cfg: unknown): Promise<void>;
  cancelUnclaimedOrders(cfg: unknown): Promise<void>;
  pushStatusUpdates(cfg: unknown): Promise<void>;
  reschedule(): void;
  stop(): void;
}

const ACKED = { status: 200, body: { ok: true, data: { acked: true } } };
const NOT_NEW = { status: 200, body: { ok: true, data: { acked: false } } };
const UPDATED = { status: 200, body: { ok: true, data: { updated: true } } };
const SITE_CANCELLED = { status: 200, body: { ok: true, data: { updated: false, finalStatus: 'cancelled' } } };
const SERVER_ERROR = { status: 500, body: { ok: false, error: 'internal' } };
const NOT_FOUND = { status: 404, body: { ok: false, error: 'not_found' } };
const NO_ORDERS = { status: 200, body: { ok: true, data: [] } };

const isAck = (c: Call) => c.path.endsWith('/ack');
const isStatus = (c: Call) => /\/api\/bridge\/orders\/[^/]+\/status$/.test(c.path);
const isPull = (c: Call) => c.path.startsWith('/api/bridge/orders?');

/** A till with the website linked, a shift open, the menu of the costing fixture, and the real bridge. */
async function till(opts: { enabled?: boolean } = {}) {
  const db = openMigrated();
  const shop = await openCostingShop(db);
  const { openShift } = await import('../db/repositories/shift-repo.js');
  openShift(db, { openingCashCents: 0 }, CASHIER);
  const { setWebBridgeConfig } = await import('./web-bridge-config.js');
  setWebBridgeConfig(
    db,
    {
      enabled: opts.enabled ?? true,
      siteUrl: SITE,
      bridgeSecret: 'made-up-secret',
      pollIntervalMs: 20_000,
      cloudBackupFrequency: 'off',
    },
    OWNER.userId,
  );
  const { webOrdersBridge } = await import('./web-orders-bridge.js');
  const { orderAlerts } = await import('./order-alerts-hub.js');
  const orderRepo = await import('../db/repositories/order-repo.js');
  const bridge = webOrdersBridge as unknown as BridgeInside;
  bridge.db = db;
  bridge.deviceId = DEV;
  bridge.systemUserId = null;

  const calls: Call[] = [];
  let answer: (c: Call) => Answer = () => ACKED;
  bridge.api = async (_cfg, path, init) => {
    const call: Call = { path, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Row) : null };
    calls.push(call);
    const a = answer(call);
    if (a === 'offline') throw new TypeError('fetch failed');
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
  };

  /** A website order for one Baked Wings (Rs 800), as the website sends it: a pick-up, or a delivery. */
  const webOrder = (id: string, createdAt = new Date().toISOString(), delivery = false): WebOrder => ({
    id,
    status: 'new',
    customerName: 'Made-up Customer',
    customerPhone: PHONE,
    addressLine: delivery ? 'House 7, Made-up Street' : 'Collect from the shop',
    area: delivery ? 'Made-up Area' : null,
    notes: null,
    fulfilment: delivery ? 'delivery' : 'pickup',
    items: [{ posItemId: shop.item.bakedWings, name: 'Baked Wings', quantity: 1, unitPriceCents: 80_000, modifiers: [], notes: null }],
    subtotalCents: 80_000,
    discountCents: 0,
    taxCents: 0,
    totalCents: 80_000,
    paymentMethod: 'cod',
    createdAt,
    posOrderId: null,
    posOrderNumber: null,
  });

  /**
   * Import a website order, the website answering `ack` to its ack (and
   * `status` to a status push, when the till checks one); returns the till's order.
   */
  const importWeb = async (id: string, ack: Answer, opts: { status?: Answer; createdAt?: string; delivery?: boolean } = {}) => {
    answer = (c) => (isAck(c) ? ack : (opts.status ?? UPDATED));
    await bridge.importOne({}, webOrder(id, opts.createdAt, opts.delivery));
    const r = row(id);
    expect(r['pos_order_id']).toBeTruthy();
    const o = db.prepare(`SELECT id, order_number FROM orders WHERE id = ?`).get(r['pos_order_id']) as Row;
    return { orderId: String(o['id']), orderNumber: String(o['order_number']) };
  };

  const row = (webOrderId: string): Row =>
    (db.prepare(`SELECT * FROM web_order_imports WHERE web_order_id = ?`).get(webOrderId) as Row | undefined) ?? {};

  /** Every loud or silenced card in the main process's list for the website cancel. */
  const cancelCards = () => orderAlerts.pending().failures.filter((f) => f.reason === 'cancelled_on_site');
  const cancelEvents = () =>
    h.screen.filter(([ch, p]) => ch === 'web-order:import-failed' && (p as Row)['reason'] === 'cancelled_on_site');

  return {
    db,
    bridge,
    orderAlerts,
    orderRepo,
    calls,
    setSite: (fn: (c: Call) => Answer) => {
      answer = fn;
    },
    importWeb,
    row,
    cancelCards,
    cancelEvents,
  };
}

const warned = (message: string) => h.warnings.filter(([m]) => m === message);

beforeEach(() => {
  h.warnings.length = 0;
  h.screen.length = 0;
  // A fresh bridge and alert list for every test: both are singletons.
  vi.resetModules();
});

live('the ack of an imported website order', () => {
  it('a landed ack is recorded; the import stores when it was placed and what the website showed', async () => {
    const t = await till();
    const placed = new Date(Date.now() - 3 * 60_000).toISOString();
    await t.importWeb('web-1', ACKED, { createdAt: placed });
    const r = t.row('web-1');
    expect(r['web_created_at']).toBe(placed);
    expect(r['web_total_cents']).toBe(80_000);
    expect(r['acked_at']).toEqual(expect.any(String));
    // Seen is someone looking at it, not the website confirming it.
    expect(r['alert_seen_at']).toBeNull();
    expect(t.calls.filter(isAck)).toHaveLength(1);
    expect(t.calls.filter(isAck)[0]!.body).toEqual({
      posOrderId: r['pos_order_id'],
      posOrderNumber: expect.stringMatching(/\S/),
    });
  });

  it('a 500 is not confirmed: logged with its status, then the next poll asks again before its GET and records it', async () => {
    const t = await till();
    await t.importWeb('web-1', SERVER_ERROR);
    expect(t.row('web-1')['acked_at']).toBeNull();
    expect(warned('Web order ack refused (imported; will re-ack next poll)')).toEqual([
      ['Web order ack refused (imported; will re-ack next poll)', { webOrderId: 'web-1', status: 500 }],
    ]);
    // The order is on the board all the same: no "did not come in" card.
    expect(t.orderAlerts.pending().failures).toEqual([]);

    t.calls.length = 0;
    t.setSite((c) => (isPull(c) ? NO_ORDERS : ACKED));
    await t.bridge.tick();
    expect(t.row('web-1')['acked_at']).toEqual(expect.any(String));
    // The ack went first: the GET is what runs the website's 45-minute cancel.
    const order = t.calls.map((c) => (isAck(c) ? 'ack' : isPull(c) ? 'pull' : c.path));
    expect(order.indexOf('ack')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('ack')).toBeLessThan(order.indexOf('pull'));

    // Confirmed: the next poll leaves it alone.
    t.calls.length = 0;
    await t.bridge.tick();
    expect(t.calls.filter(isAck)).toEqual([]);
  });

  it('no answer at all (offline) is logged and left for the next poll', async () => {
    const t = await till();
    await t.importWeb('web-1', 'offline');
    expect(t.row('web-1')['acked_at']).toBeNull();
    expect(warned('Web order ack failed (imported; will re-ack next poll)')).toHaveLength(1);
  });

  it('runs with the owner’s switch off while web orders already taken are unfinished', async () => {
    const t = await till({ enabled: true });
    await t.importWeb('web-1', 'offline');
    // The owner switches online orders off; the order is still in the kitchen.
    const { setWebBridgeConfig } = await import('./web-bridge-config.js');
    setWebBridgeConfig(
      t.db,
      { enabled: false, siteUrl: SITE, bridgeSecret: 'made-up-secret', pollIntervalMs: 20_000, cloudBackupFrequency: 'off' },
      OWNER.userId,
    );
    t.calls.length = 0;
    t.setSite(() => ACKED);
    // The poll keeps running for the unfinished order (cloud copies off), and its first tick acks it.
    t.bridge.reschedule();
    try {
      await vi.waitFor(() => expect(t.row('web-1')['acked_at']).toEqual(expect.any(String)));
    } finally {
      t.bridge.stop();
    }
    expect(t.calls.filter(isAck)).toHaveLength(1);
    // No new orders are pulled with the switch off.
    expect(t.calls.filter(isPull)).toEqual([]);
  });

  it('the owner’s switch-off drain asks again before its GET too, and goes on when that fails', async () => {
    const t = await till();
    await t.importWeb('web-1', 'offline');
    const steps = () => t.calls.map((c) => (isAck(c) ? 'ack' : isPull(c) ? 'pull' : c.path));

    // Still offline for the ack: the drain's GET goes ahead all the same.
    t.calls.length = 0;
    t.setSite((c) => (isPull(c) ? NO_ORDERS : 'offline'));
    await t.bridge.cancelUnclaimedOrders({});
    expect(steps()).toEqual(['ack', 'pull']);
    expect(t.row('web-1')['acked_at']).toBeNull();

    // Back online: confirmed before the GET that runs the website's 45-minute cancel.
    t.calls.length = 0;
    t.setSite((c) => (isPull(c) ? NO_ORDERS : ACKED));
    await t.bridge.cancelUnclaimedOrders({});
    expect(steps()).toEqual(['ack', 'pull']);
    expect(t.row('web-1')['acked_at']).toEqual(expect.any(String));
  });

  it('offline it stops after one call, and orders older than 2 hours are not asked about', async () => {
    const t = await till();
    await t.importWeb('web-1', 'offline');
    await t.importWeb('web-2', 'offline');
    await t.importWeb('web-3', 'offline');
    // Imported 3 hours ago: past the website's 45-minute cancel long since.
    const old = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    t.db.prepare(`UPDATE web_order_imports SET imported_at = ? WHERE web_order_id = 'web-1'`).run(old);

    t.calls.length = 0;
    t.setSite(() => 'offline');
    await t.bridge.retryAcks({});
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.path).toBe('/api/bridge/orders/web-2/ack');

    t.calls.length = 0;
    t.setSite(() => ACKED);
    await t.bridge.retryAcks({});
    expect(t.calls.map((c) => c.path)).toEqual(['/api/bridge/orders/web-2/ack', '/api/bridge/orders/web-3/ack']);
    expect(t.row('web-1')['acked_at']).toBeNull();
  });

  it('{data:{}} from an older website counts as confirmed', async () => {
    const t = await till();
    await t.importWeb('web-1', { status: 200, body: { data: {} } });
    expect(t.row('web-1')['acked_at']).toEqual(expect.any(String));
    expect(t.calls.filter(isStatus)).toEqual([]);
  });

  it('acked:false, then the website says it is accepted: confirmed with the till’s own status, no card', async () => {
    const t = await till();
    const o = await t.importWeb('web-1', NOT_NEW, { status: UPDATED });
    expect(t.calls.filter(isStatus)).toEqual([{ path: '/api/bridge/orders/web-1/status', body: { status: 'accepted' } }]);
    const r = t.row('web-1');
    expect(r['acked_at']).toEqual(expect.any(String));
    expect(r['last_pushed_status']).toBe('accepted');
    expect(r['site_cancelled_at']).toBeNull();
    expect(t.cancelCards()).toEqual([]);
    expect(t.cancelEvents()).toEqual([]);
    expect(o.orderNumber).toBeTruthy();
  });

  it('acked:false at the import, the website having cancelled it: one loud card with the order number', async () => {
    const t = await till();
    // The website ran its cancel between the GET and the ack.
    const o = await t.importWeb('web-1', NOT_NEW, { status: SITE_CANCELLED });
    const r = t.row('web-1');
    expect(r['site_cancelled_at']).toEqual(expect.any(String));
    expect(r['last_pushed_status']).toBe('cancelled');
    expect(r['acked_at']).toEqual(expect.any(String));
    // The till pushed its own status ('accepted'), not 'cancelled': the website cancelled it.
    expect(t.calls.filter(isStatus)).toEqual([{ path: '/api/bridge/orders/web-1/status', body: { status: 'accepted' } }]);

    const cards = t.cancelCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      webOrderId: 'web-1',
      orderNumber: o.orderNumber,
      customerPhone: expect.stringContaining('5550123'),
      silenced: false,
    });
    expect(t.orderAlerts.isLoud()).toBe(true);
    // The new-order alert is there too: the order is on the board.
    expect(t.orderAlerts.pending().orders.map((x) => x.orderId)).toEqual([o.orderId]);
    expect(t.cancelEvents()).toHaveLength(1);
    expect(t.cancelEvents()[0]![1]).toMatchObject({ final: true, orderNumber: o.orderNumber, webOrderId: 'web-1' });
    expect(warned('Website cancelled an order the kitchen has')).toHaveLength(1);

    // Not asked about again, nothing more to push, and no second card.
    t.calls.length = 0;
    await t.bridge.retryAcks({});
    await t.bridge.pushStatusUpdates({});
    expect(t.calls).toEqual([]);
    expect(t.cancelEvents()).toHaveLength(1);
    expect(t.cancelCards()).toHaveLength(1);
  });

  it('acked:false on a later poll, the website having cancelled it meanwhile: the same one card', async () => {
    const t = await till();
    const o = await t.importWeb('web-1', 'offline');
    t.setSite((c) => (isAck(c) ? NOT_NEW : SITE_CANCELLED));
    await t.bridge.retryAcks({});
    expect(t.row('web-1')['site_cancelled_at']).toEqual(expect.any(String));
    expect(t.cancelCards()).toEqual([expect.objectContaining({ webOrderId: 'web-1', orderNumber: o.orderNumber })]);
    await t.bridge.retryAcks({});
    expect(t.cancelEvents()).toHaveLength(1);
  });

  it('a test order the till deleted is no website cancel: no card', async () => {
    const t = await till();
    const o = await t.importWeb('web-1', 'offline');
    t.db.prepare(`UPDATE orders SET deleted_at = ? WHERE id = ?`).run(new Date().toISOString(), o.orderId);
    t.setSite((c) => (isAck(c) ? NOT_NEW : SITE_CANCELLED));
    await t.bridge.retryAcks({});
    expect(t.calls.filter(isStatus).at(-1)).toEqual({ path: '/api/bridge/orders/web-1/status', body: { status: 'cancelled' } });
    const r = t.row('web-1');
    expect(r['site_cancelled_at']).toBeNull();
    expect(r['last_pushed_status']).toBe('cancelled');
    expect(r['acked_at']).toEqual(expect.any(String));
    expect(t.cancelCards()).toEqual([]);
  });

  it('a 404 from the website (no such order) counts as confirmed, logged, no card', async () => {
    const t = await till();
    await t.importWeb('web-1', 'offline');
    t.setSite((c) => (isAck(c) ? NOT_NEW : NOT_FOUND));
    await t.bridge.retryAcks({});
    const r = t.row('web-1');
    expect(r['acked_at']).toEqual(expect.any(String));
    expect(r['site_cancelled_at']).toBeNull();
    expect(warned('Website has no record of an imported order')).toHaveLength(1);
    expect(t.cancelCards()).toEqual([]);
  });

  it('a refused check (500 on the status push) is not confirmed and stops the retry', async () => {
    const t = await till();
    await t.importWeb('web-1', 'offline');
    await t.importWeb('web-2', 'offline');
    t.calls.length = 0;
    t.setSite((c) => (isAck(c) ? NOT_NEW : SERVER_ERROR));
    await t.bridge.retryAcks({});
    expect(t.calls.map((c) => c.path)).toEqual(['/api/bridge/orders/web-1/ack', '/api/bridge/orders/web-1/status']);
    expect(t.row('web-1')['acked_at']).toBeNull();
    expect(t.cancelCards()).toEqual([]);
  });

  it('the website handing out an order already on the board: acked again and recorded, not imported twice', async () => {
    const t = await till();
    await t.importWeb('web-1', 'offline');
    const before = Number((t.db.prepare(`SELECT COUNT(*) AS n FROM orders`).get() as Row)['n']);
    // retryAcks is offline; the GET (back online in between) hands the order out again.
    let first = true;
    t.setSite((c) => {
      if (isAck(c) && first) {
        first = false;
        return 'offline';
      }
      if (isPull(c)) return { status: 200, body: { ok: true, data: [{ id: 'web-1' }] } };
      return ACKED;
    });
    await t.bridge.tick();
    expect(t.row('web-1')['acked_at']).toEqual(expect.any(String));
    expect(Number((t.db.prepare(`SELECT COUNT(*) AS n FROM orders`).get() as Row)['n'])).toBe(before);
  });
});

live('an answer whose body never comes', () => {
  it('is given up on when the call’s 20 s are up, the line hung up, and the poll goes on', async () => {
    const t = await till();
    await t.importWeb('web-1', 'offline');
    await t.importWeb('web-2', 'offline');
    // The real call to the website: the ack's headers come after 5 s, its body never does.
    delete (t.bridge as Partial<BridgeInside>).api;
    const hungUp: string[] = [];
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (url: string, init: RequestInit) =>
          new Promise<Response>((resolve) => {
            const path = new URL(url).pathname;
            asked.push(path);
            setTimeout(() => {
              const body = new ReadableStream<Uint8Array>({
                start(c) {
                  init.signal?.addEventListener('abort', () => {
                    hungUp.push(path);
                    c.error(new Error('aborted'));
                  });
                },
              });
              resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }));
            }, 5_000);
          }),
      ),
    );
    vi.useFakeTimers();
    try {
      let done = false;
      const retry = t.bridge.retryAcks({ siteUrl: SITE, bridgeSecret: 'made-up-secret' }).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(20_000 - 1);
      expect(done).toBe(false);
      expect(hungUp).toEqual([]);
      // 20 s after the first ack was sent: given up on, and the next order is asked about.
      await vi.advanceTimersByTimeAsync(1);
      expect(hungUp).toEqual(['/api/bridge/orders/web-1/ack']);
      expect(asked).toEqual(['/api/bridge/orders/web-1/ack', '/api/bridge/orders/web-2/ack']);
      expect(warned('Web bridge: the website’s answer did not come in time')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(done).toBe(true);
      await retry;
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

live('the status push and a website cancel', () => {
  it('raises the loud card once when the website holds cancelled for an order the kitchen has', async () => {
    const t = await till();
    const o = await t.importWeb('web-1', ACKED);
    t.orderRepo.markOrderPreparing(t.db, o.orderId, CASHIER);
    t.calls.length = 0;
    t.setSite(() => SITE_CANCELLED);
    await t.bridge.pushStatusUpdates({});
    expect(t.calls).toEqual([{ path: '/api/bridge/orders/web-1/status', body: { status: 'preparing' } }]);
    const r = t.row('web-1');
    expect(r['site_cancelled_at']).toEqual(expect.any(String));
    expect(r['last_pushed_status']).toBe('cancelled');
    expect(t.cancelCards()).toEqual([expect.objectContaining({ webOrderId: 'web-1', orderNumber: o.orderNumber })]);
    expect(t.cancelEvents()).toHaveLength(1);

    // Nothing more to push for it, and no second card.
    t.calls.length = 0;
    await t.bridge.pushStatusUpdates({});
    expect(t.calls).toEqual([]);
    expect(t.cancelEvents()).toHaveLength(1);
    expect(t.cancelCards()).toHaveLength(1);
  });

  it('any other answer to a status push also confirms an order whose ack never landed', async () => {
    const t = await till();
    const o = await t.importWeb('web-1', 'offline');
    t.orderRepo.markOrderPreparing(t.db, o.orderId, CASHIER);
    t.setSite(() => UPDATED);
    await t.bridge.pushStatusUpdates({});
    const r = t.row('web-1');
    expect(r['last_pushed_status']).toBe('preparing');
    expect(r['acked_at']).toEqual(expect.any(String));
    expect(t.cancelCards()).toEqual([]);
  });
});

live('the status push follows Send out and Back to Ready (v0.7.34)', () => {
  it("Send out pushes 'out_for_delivery'; Back to Ready pushes 'ready'; sent out again, 'out_for_delivery' again", async () => {
    const t = await till();
    const o = await t.importWeb('web-1', ACKED, { delivery: true });
    t.orderRepo.markOrderReady(t.db, o.orderId, CASHIER);
    t.setSite(() => UPDATED);
    await t.bridge.pushStatusUpdates({});
    expect(t.row('web-1')['last_pushed_status']).toBe('ready');

    const pushed = async () => {
      t.calls.length = 0;
      await t.bridge.pushStatusUpdates({});
      return t.calls.filter(isStatus);
    };
    // Send out: an outside rider took it, no rider named; the customer's tracker says it is on its way.
    expect(t.orderRepo.sendOutOrder(t.db, o.orderId, CASHIER)).toMatchObject({ status: 'out_for_delivery', assignedRiderId: null });
    expect(await pushed()).toEqual([{ path: '/api/bridge/orders/web-1/status', body: { status: 'out_for_delivery' } }]);
    expect(t.row('web-1')['last_pushed_status']).toBe('out_for_delivery');
    // Nothing new: nothing pushed.
    expect(await pushed()).toEqual([]);

    // Back to Ready (the rider had not left).
    expect(t.orderRepo.unassignRiderFromOrder(t.db, o.orderId, CASHIER).status).toBe('ready');
    expect(await pushed()).toEqual([{ path: '/api/bridge/orders/web-1/status', body: { status: 'ready' } }]);
    expect(t.row('web-1')['last_pushed_status']).toBe('ready');

    // Sent out again.
    t.orderRepo.sendOutOrder(t.db, o.orderId, CASHIER);
    expect(await pushed()).toEqual([{ path: '/api/bridge/orders/web-1/status', body: { status: 'out_for_delivery' } }]);
    expect(t.cancelCards()).toEqual([]);
  });
});
