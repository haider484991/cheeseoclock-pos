/**
 * When an order was sent (migration 0048 orders.sent_at; the owner, 2 Oct
 * 2026: count the Live Orders card from when the order is sent), on a real
 * database built from every migration, driven through the repositories:
 *   - Send to kitchen stamps it the first time the order leaves 'open';
 *     Preparing, Ready and a second Send never move it;
 *   - a cart cancelled or dropped before it was sent keeps it empty;
 *   - Pay now (a takeaway) and foodpanda's pay-and-send stamp it at the
 *     payment's time, and the order they return carries it;
 *   - a website order is sent when it is imported (the bridge's own import,
 *     the website stood in for);
 *   - the order's sync image and its audit after-image carry it;
 *   - Live Orders lists the order sent longest ago first, whenever it was
 *     started, and the PIN screen's watch query is served by
 *     idx_orders_status_sent;
 *   - on two tills it travels with the order, and an image without the key
 *     (a till on v0.7.33) leaves the other till's value as it is.
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for
 * Electron); skipped where it is missing. Every name, number and amount is
 * made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebOrder } from '@cheeseoclock/shared-types';
import type { AppDatabase } from './connection.js';
import { DatabaseSync } from './costing-shop.fixture.js';
import { openTill, push } from './two-tills.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '', getVersion: () => '0.0.0-test' },
  dialog: {},
  safeStorage: { isEncryptionAvailable: () => false },
  Notification: class {
    static isSupported() {
      return false;
    }
  },
}));
// The website import's side effects: no printer, no FBR, no alert window here.
vi.mock('../services/print-spooler.js', () => ({
  printSpooler: new Proxy({}, { get: () => () => undefined }),
}));
vi.mock('../services/fbr-worker.js', () => ({
  fbrWorker: { kick: () => {}, resetAdapter: () => {} },
}));
vi.mock('../services/order-alerts-hub.js', () => ({
  orderAlerts: { orderReceived: () => {}, importFailed: () => {} },
}));

const live = describe.skipIf(!DatabaseSync);

const TILL_A = 'till-a';
const TILL_B = 'till-b';
const CASHIER = { userId: 'u_cash', deviceId: TILL_A };
const MANAGER = { userId: 'u_mgr', deviceId: TILL_A };

/** Evening times in Pakistan (UTC+5), as instants. */
const PK = {
  '19:00': '2026-10-02T14:00:00.000Z',
  '19:20': '2026-10-02T14:20:00.000Z',
  '19:25': '2026-10-02T14:25:00.000Z',
  '19:30': '2026-10-02T14:30:00.000Z',
  '19:40': '2026-10-02T14:40:00.000Z',
  '19:45': '2026-10-02T14:45:00.000Z',
  '19:50': '2026-10-02T14:50:00.000Z',
  '20:00': '2026-10-02T15:00:00.000Z',
} as const;
type Clock = keyof typeof PK;
const at = (t: Clock) => vi.setSystemTime(new Date(PK[t]));

const repo = () => import('./repositories/order-repo.js');
type Row = Record<string, unknown>;

/** A till: the made-up users, a 15% tax, a pizza and a side, a shift opened at 18:00. */
async function till(deviceId: string, usersFrom?: string): Promise<{ db: AppDatabase; pizza: string; side: string }> {
  const db = openTill(deviceId, usersFrom ? { usersFrom } : {});
  const actor = { userId: 'u_mgr', deviceId };
  const { createTaxCategory } = await import('./repositories/tax-category-repo.js');
  const { createCategory } = await import('./repositories/category-repo.js');
  const { createMenuItem } = await import('./repositories/menu-item-repo.js');
  const { openShift } = await import('./repositories/shift-repo.js');
  vi.setSystemTime(new Date('2026-10-02T13:00:00.000Z'));
  const tax = createTaxCategory(db, { name: 'Test GST', rateBps: 1_500 }, actor);
  const food = createCategory(db, { name: 'Test Pizzas', displayOrder: 1, colorHex: '#aa5500' }, actor);
  const pizza = createMenuItem(db, { categoryId: food.id, name: 'Test Fajita Pizza', basePriceCents: 150_000, taxCategoryId: tax.id }, actor).id;
  const side = createMenuItem(db, { categoryId: food.id, name: 'Test Fries', basePriceCents: 50_000, taxCategoryId: tax.id }, actor).id;
  openShift(db, { openingCashCents: 0 }, actor);
  return { db, pizza, side };
}

const sentAtOf = (db: AppDatabase, orderId: string) =>
  (db.prepare(`SELECT sent_at FROM orders WHERE id = ?`).get(orderId) as Row | undefined)?.['sent_at'];
const rowOf = (db: AppDatabase, orderId: string) =>
  db.prepare(`SELECT status, created_at, sent_at, paid_at FROM orders WHERE id = ?`).get(orderId) as Row | undefined;

/** A counter order started at `startedAt` with one line on it. */
async function startOrder(db: AppDatabase, menuItemId: string, startedAt: Clock, mode: 'takeaway' | 'delivery' | 'foodpanda' = 'takeaway'): Promise<string> {
  const r = await repo();
  at(startedAt);
  const o = r.createOrder(db, { mode }, CASHIER);
  r.addOrderItem(db, { orderId: o.id, menuItemId, quantity: 1, modifierIds: [] }, CASHIER);
  return o.id;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

live('orders.sent_at: stamped once, the first time the order leaves open', () => {
  it('started 19:00, sent 19:30: sent_at 19:30; Preparing, a second Send and Ready never move it; started stays 19:00', async () => {
    const { db, pizza } = await till(TILL_A);
    const r = await repo();
    const id = await startOrder(db, pizza, '19:00');
    expect(sentAtOf(db, id)).toBeNull();
    expect(r.findOrder(db, id)).not.toHaveProperty('sentAt');

    at('19:30');
    const sent = r.sendOrderToKitchen(db, id, CASHIER);
    expect(sent).toMatchObject({ status: 'sent_to_kitchen', createdAt: PK['19:00'], sentAt: PK['19:30'] });
    expect(rowOf(db, id)).toMatchObject({ status: 'sent_to_kitchen', created_at: PK['19:00'], sent_at: PK['19:30'] });

    // Sent again (the idempotent re-send), then cooked and made ready later: still 19:30.
    at('19:40');
    expect(r.sendOrderToKitchen(db, id, CASHIER).sentAt).toBe(PK['19:30']);
    at('19:45');
    expect(r.markOrderPreparing(db, id, CASHIER).sentAt).toBe(PK['19:30']);
    at('19:50');
    expect(r.markOrderReady(db, id, CASHIER).sentAt).toBe(PK['19:30']);
    expect(rowOf(db, id)).toMatchObject({ status: 'ready', created_at: PK['19:00'], sent_at: PK['19:30'] });
    expect(r.getOrderSnapshot(db, id)?.order).toMatchObject({ createdAt: PK['19:00'], sentAt: PK['19:30'] });
  });

  it('the sync image and the audit after-image of the Send carry it; the later steps keep it in both images', async () => {
    const { db, pizza } = await till(TILL_A);
    const r = await repo();
    const id = await startOrder(db, pizza, '19:00');
    at('19:30');
    r.sendOrderToKitchen(db, id, CASHIER);
    at('19:45');
    r.markOrderPreparing(db, id, CASHIER);

    const images = (db.prepare(`SELECT payload_json FROM sync_queue WHERE entity_type = 'orders' AND entity_id = ? ORDER BY created_at, rowid`).all(id) as Row[]).map(
      (q) => JSON.parse(String(q['payload_json'])) as Row,
    );
    // Before the Send the image has the column, empty; from the Send on, 19:30.
    expect(images.at(0)).toMatchObject({ __rowImage: 1, id, sentAt: null });
    expect(images.slice(-2).map((i) => [i['status'], i['sentAt']])).toEqual([
      ['sent_to_kitchen', PK['19:30']],
      ['preparing', PK['19:30']],
    ]);

    const audit = (action: string) => {
      const a = db.prepare(`SELECT before_json, after_json FROM audit_log WHERE entity_id = ? AND action = ?`).get(id, action) as Row | undefined;
      return { before: JSON.parse(String(a?.['before_json'])) as Row, after: JSON.parse(String(a?.['after_json'])) as Row };
    };
    const send = audit('send_to_kitchen');
    expect(send.before).not.toHaveProperty('sentAt');
    expect(send.after).toMatchObject({ status: 'sent_to_kitchen', sentAt: PK['19:30'] });
    expect(audit('mark_preparing')).toMatchObject({ before: { sentAt: PK['19:30'] }, after: { status: 'preparing', sentAt: PK['19:30'] } });
  });

  it('a cart cancelled, or dropped, before it was ever sent keeps sent_at empty', async () => {
    const { db, pizza, side } = await till(TILL_A);
    const r = await repo();
    const cancelled = await startOrder(db, pizza, '19:00');
    at('19:20');
    r.voidOrder(db, { orderId: cancelled, reason: 'Customer changed order', approverUserId: 'u_mgr' }, MANAGER);
    expect(rowOf(db, cancelled)).toMatchObject({ status: 'void', sent_at: null });
    expect(r.getOrderSnapshot(db, cancelled)?.order).not.toHaveProperty('sentAt');

    const dropped = await startOrder(db, side, '19:25');
    at('19:30');
    r.discardDraft(db, dropped, CASHIER);
    expect(db.prepare(`SELECT status, sent_at, deleted_at IS NOT NULL AS gone FROM orders WHERE id = ?`).get(dropped)).toEqual({ status: 'open', sent_at: null, gone: 1 });
  });

  it('Pay now on a takeaway and foodpanda’s pay-and-send: sent when paid (sent_at = paid_at), on the row, the returned order and its image', async () => {
    const { db, pizza } = await till(TILL_A);
    const r = await repo();
    const takeaway = await startOrder(db, pizza, '19:00');
    at('19:25');
    const total = r.findOrder(db, takeaway)!.totalCents;
    const paid = r.tenderOrder(db, { orderId: takeaway, payments: [{ method: 'cash', amountCents: total, tenderedCents: total }] }, CASHIER);
    expect(paid).toMatchObject({ status: 'sent_to_kitchen', paidAt: PK['19:25'], sentAt: PK['19:25'] });
    expect(rowOf(db, takeaway)).toEqual({ status: 'sent_to_kitchen', created_at: PK['19:00'], sent_at: PK['19:25'], paid_at: PK['19:25'] });
    const tenderAudit = db.prepare(`SELECT after_json FROM audit_log WHERE entity_id = ? AND action = 'tender'`).get(takeaway) as Row | undefined;
    expect(JSON.parse(String(tenderAudit?.['after_json']))).toMatchObject({ sentAt: PK['19:25'], paidAt: PK['19:25'] });
    // Made ready later: still sent at 19:25.
    at('19:40');
    expect(r.markOrderReady(db, takeaway, CASHIER).sentAt).toBe(PK['19:25']);

    const fp = await startOrder(db, pizza, '19:20', 'foodpanda');
    at('19:30');
    const fpTotal = r.findOrder(db, fp)!.totalCents;
    const fpPaid = r.tenderOrder(db, { orderId: fp, payments: [{ method: 'foodpanda', amountCents: fpTotal, referenceNo: 'FP-TEST-01' }] }, CASHIER);
    expect(fpPaid).toMatchObject({ status: 'sent_to_kitchen', paidAt: PK['19:30'], sentAt: PK['19:30'] });
    expect(rowOf(db, fp)).toEqual({ status: 'sent_to_kitchen', created_at: PK['19:20'], sent_at: PK['19:30'], paid_at: PK['19:30'] });
    const image = db.prepare(`SELECT payload_json FROM sync_queue WHERE entity_type = 'orders' AND entity_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(fp) as Row | undefined;
    expect(JSON.parse(String(image?.['payload_json']))).toMatchObject({ status: 'sent_to_kitchen', sentAt: PK['19:30'], paidAt: PK['19:30'] });
  });

  it('a website order is sent when it is imported (the bridge’s own import, the website stood in for)', async () => {
    const { db, pizza } = await till(TILL_A);
    at('19:40');
    const web: WebOrder = {
      id: 'web-sent-at-1',
      status: 'new',
      customerName: 'Web Customer',
      customerPhone: '03111234567',
      addressLine: 'Collect from the shop',
      area: null,
      notes: null,
      fulfilment: 'pickup',
      items: [{ posItemId: pizza, name: 'Test Fajita Pizza', quantity: 1, unitPriceCents: 150_000, modifiers: [], notes: null }],
      subtotalCents: 150_000,
      discountCents: 0,
      taxCents: 22_500,
      totalCents: 172_500,
      paymentMethod: 'cod',
      // Placed on the website a minute before the till took it in.
      createdAt: '2026-10-02T14:39:00.000Z',
      posOrderId: null,
      posOrderNumber: null,
    } as WebOrder;
    const { webOrdersBridge } = await import('../services/web-orders-bridge.js');
    const bridge = webOrdersBridge as unknown as {
      db: unknown;
      deviceId: string;
      systemUserId: string | null;
      api: (...a: unknown[]) => Promise<Response>;
      importOne: (cfg: unknown, web: WebOrder) => Promise<void>;
    };
    bridge.db = db;
    bridge.deviceId = TILL_A;
    bridge.systemUserId = null;
    bridge.api = async () => new Response(JSON.stringify({ ok: true, data: { acked: true } }), { status: 200 });
    await bridge.importOne({}, web);
    const imported = db.prepare(`SELECT pos_order_id, status, imported_at FROM web_order_imports WHERE web_order_id = ?`).get(web.id) as Row | undefined;
    expect(imported).toMatchObject({ status: 'imported', imported_at: PK['19:40'] });
    const id = String(imported?.['pos_order_id']);
    expect(rowOf(db, id)).toMatchObject({ status: 'sent_to_kitchen', created_at: PK['19:40'], sent_at: PK['19:40'], paid_at: null });
    expect((await repo()).findOrder(db, id)?.sentAt).toBe(PK['19:40']);
  });
});

live('the Live Orders clock in the main process', () => {
  it('listActiveOrders puts (started 19:00, sent 19:40) after (started 19:20, sent 19:25); an order from before 0.7.34 sits by when it was started', async () => {
    const { db, pizza, side } = await till(TILL_A);
    const r = await repo();
    const early = await startOrder(db, pizza, '19:00');
    const quick = await startOrder(db, side, '19:20');
    at('19:25');
    r.sendOrderToKitchen(db, quick, CASHIER);
    at('19:40');
    r.sendOrderToKitchen(db, early, CASHIER);
    // Sent before 0.7.34 (no sent_at), started 19:30: between the two.
    const old = await startOrder(db, side, '19:30');
    at('19:30');
    r.sendOrderToKitchen(db, old, CASHIER);
    db.prepare(`UPDATE orders SET sent_at = NULL WHERE id = ?`).run(old);

    expect(r.listActiveOrders(db).map((s) => s.order.id)).toEqual([quick, old, early]);
    expect(r.ORDER_CLOCK_SQL).toBe('COALESCE(sent_at, created_at)');
  });

  it('the PIN screen’s watch query (alert-watch.ts) is served by idx_orders_status_sent', async () => {
    const { db, pizza } = await till(TILL_A);
    const r = await repo();
    const id = await startOrder(db, pizza, '19:00');
    at('19:30');
    r.sendOrderToKitchen(db, id, CASHIER);
    const { KITCHEN_ORDERS_SQL } = await import('../services/alert-watch.js');
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${KITCHEN_ORDERS_SQL}`).all(PK['19:00'], 200) as Row[]).map((p) => String(p['detail']));
    expect(plan.join(' | ')).toContain('idx_orders_status_sent');
    // The rows it reads: the order and when it was sent.
    expect(db.prepare(KITCHEN_ORDERS_SQL).all(PK['19:00'], 200)).toEqual([
      { id, order_number: r.findOrder(db, id)!.orderNumber, status: 'sent_to_kitchen', source: 'pos', since: PK['19:30'] },
    ]);
  });
});

live('two tills: sent_at travels with the order', () => {
  /** Every unsent change `from` → `to`, as a till on v0.7.33 would send it: no sentAt key in the order's image. */
  async function pushWithoutSentAt(from: AppDatabase, fromDevice: string, to: AppDatabase): Promise<void> {
    const sync = await import('./repositories/sync-repo.js');
    const { applyRemoteBatch } = await import('./repositories/apply-remote.js');
    const pending = sync.listPendingSync(from, 1_000_000);
    const changes = pending.map((p) => {
      const c = sync.pendingToChange(p, fromDevice);
      if (c.entityType !== 'orders') return c;
      const image = Object.fromEntries(Object.entries(c.payload as Row).filter(([k]) => k !== 'sentAt'));
      return { ...c, payload: image };
    });
    const res = await applyRemoteBatch(to, changes, { pause: async () => {} });
    expect(res.waiting).toBe(0);
    sync.markSyncedIds(
      from,
      pending.map((p) => p.id),
    );
  }

  it('sent on till A at 19:30: till B reads 19:30; a later image without the key (a v0.7.33 till’s) moves the order on B but leaves 19:30', async () => {
    const a = await till(TILL_A);
    const b = openTill(TILL_B, { usersFrom: TILL_A });
    const r = await repo();
    const id = await startOrder(a.db, a.pizza, '19:00');
    at('19:30');
    r.sendOrderToKitchen(a.db, id, CASHIER);
    await push(a.db, TILL_A, b);
    expect(rowOf(b, id)).toMatchObject({ status: 'sent_to_kitchen', created_at: PK['19:00'], sent_at: PK['19:30'] });
    expect(r.findOrder(b, id)?.sentAt).toBe(PK['19:30']);

    // Till A's next change reaches B in an older till's image: no sentAt key at all.
    at('19:45');
    r.markOrderPreparing(a.db, id, CASHIER);
    await pushWithoutSentAt(a.db, TILL_A, b);
    expect(rowOf(b, id)).toMatchObject({ status: 'preparing', created_at: PK['19:00'], sent_at: PK['19:30'] });
  });

  it('an order sent on till B (this version) is sent on till A too, at B’s time', async () => {
    const a = await till(TILL_A);
    const b = openTill(TILL_B, { usersFrom: TILL_A });
    await push(a.db, TILL_A, b);
    const r = await repo();
    at('19:00');
    const o = r.createOrder(b, { mode: 'takeaway' }, { userId: 'u_cash', deviceId: TILL_B });
    r.addOrderItem(b, { orderId: o.id, menuItemId: a.pizza, quantity: 1, modifierIds: [] }, { userId: 'u_cash', deviceId: TILL_B });
    at('20:00');
    r.sendOrderToKitchen(b, o.id, { userId: 'u_cash', deviceId: TILL_B });
    await push(b, TILL_B, a.db);
    expect(rowOf(a.db, o.id)).toMatchObject({ status: 'sent_to_kitchen', created_at: PK['19:00'], sent_at: PK['20:00'] });
  });
});
