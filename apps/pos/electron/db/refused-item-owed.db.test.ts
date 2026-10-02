/**
 * "Customer refused an item" leaves a trace until its part refund is done
 * (v0.7.34, review fixes B; order-edit finding #5, the owner's two-step
 * design: Delivered + Pay takes the outside rider's money for the whole
 * bill, then a manager-PIN part refund of the item on the same till). The
 * owner's pain was a shift closed SHORT with no explanation: if the second
 * step is skipped, the drawer is short by the item and the till must say
 * why. On a real database built from every migration, through the real
 * orders and shifts handlers and the repositories:
 *   (1) Delivered + Pay with refusedItem writes the money exactly as without
 *       it, plus the marker in the SAME audit row (its after-image), in the
 *       same transaction; the hash chain holds;
 *   (2) the order says so — the snapshot's refusedItem {refundAt: null},
 *       Recent Orders' row — and so does the Close shift box
 *       (shifts:closeCheck), which still closes: the shortage is explained,
 *       never a block;
 *   (3) a part refund of the item clears it everywhere (the refund's audit
 *       row says it settled the refused item) and the drawer then matches;
 *       a refund made on the other till clears it too once it arrives;
 *   (4) a plain Delivered + Pay never marks; refusedItem on anything but an
 *       outside rider's Delivered + Pay is refused and writes nothing;
 *   (5) the close box lists only this shift's: an owed item from an earlier
 *       shift still shows on the order, not in the next shift's close.
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for
 * Electron); skipped where it is missing. Every name, number and amount is
 * made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliveryBillOf, type AuthenticatedUser, type ShiftCloseCheck, type UUID } from '@cheeseoclock/shared-types';
import type { AppDatabase } from './connection.js';
import { DatabaseSync } from './costing-shop.fixture.js';
import { openTill, push } from './two-tills.fixture.js';
import { verifyAuditChain, type AuditChainRow } from './audit-chain.js';
import { REFUSED_ITEM_AUDIT_KEY } from './order-history-query.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => Promise<unknown>>(),
  session: null as AuthenticatedUser | null,
}));

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
// The handlers, captured instead of registered with Electron.
vi.mock('../ipc/registry.js', () => {
  class IpcGuardError extends Error {
    readonly apiError: { code: string; message: string };
    constructor(apiError: { code: string; message: string }) {
      super(apiError.message);
      this.apiError = apiError;
      this.name = 'IpcGuardError';
    }
  }
  return {
    IpcGuardError,
    defineHandler: (channel: string, _ctx: unknown, fn: (ctx: unknown, payload: unknown) => Promise<unknown>) => {
      h.handlers.set(channel, async (ctx, payload) => fn(ctx, payload));
    },
  };
});
// Who is signed in, and the manager check: auth-service's job, stood in for here.
vi.mock('../services/auth-service.js', () => ({
  getCurrentSession: () => h.session,
  verifyManagerPin: async (_db: unknown, pin: string) => {
    if (pin === '1234') return { approverUserId: 'u_mgr', approverName: 'Test Manager' };
    throw new Error("That is not a manager's PIN or password");
  },
}));
// No printer here.
vi.mock('../services/print-spooler.js', () => ({
  printSpooler: new Proxy({}, { get: () => () => undefined }),
  drawerFailureText: () => '',
}));
vi.mock('../services/fbr-worker.js', () => ({ fbrWorker: { kick: () => {}, resetAdapter: () => {} } }));
vi.mock('../services/order-alerts-hub.js', () => ({ orderAlerts: { orderReceived: () => {}, importFailed: () => {} } }));
// Website orders follow the shift (tested elsewhere): nothing to do with this.
vi.mock('../services/web-orders-shift-pause.js', () => ({
  followShiftForWebOrders: () => {},
  closeWouldPauseWebOrders: () => false,
}));

const live = describe.skipIf(!DatabaseSync);

const TILL = 'till-a';
const OTHER = 'till-b';
const CASHIER = { userId: 'u_cash', deviceId: TILL };
const MANAGER = { userId: 'u_mgr', deviceId: TILL };
const FLOAT = 500_000;
/** The refused item, with its tax: Test Fries Rs 500 at 15%. */
const FRIES_WITH_TAX = 57_500;

const PK = {
  '18:00': '2026-10-02T13:00:00.000Z',
  '19:00': '2026-10-02T14:00:00.000Z',
  '19:30': '2026-10-02T14:30:00.000Z',
  '19:45': '2026-10-02T14:45:00.000Z',
  '19:50': '2026-10-02T14:50:00.000Z',
  '20:20': '2026-10-02T15:20:00.000Z',
  '20:30': '2026-10-02T15:30:00.000Z',
  '20:40': '2026-10-02T15:40:00.000Z',
  '21:00': '2026-10-02T16:00:00.000Z',
  '21:30': '2026-10-02T16:30:00.000Z',
} as const;
const at = (t: keyof typeof PK) => vi.setSystemTime(new Date(PK[t]));

const repo = () => import('./repositories/order-repo.js');
const shiftRepo = () => import('./repositories/shift-repo.js');

interface Shop {
  db: AppDatabase;
  shiftId: string;
  bigTwo: string;
  fries: string;
  charge: string;
  rider: string;
}

/** A till: the made-up users, 15% tax, Test Big Two Rs 3,400, Test Fries Rs 500, the Rs 200 delivery charge, an own rider, a shift on a Rs 5,000 float. */
async function till(device = TILL): Promise<Shop> {
  const db = openTill(device);
  const actor = { userId: 'u_mgr', deviceId: device };
  const { createTaxCategory } = await import('./repositories/tax-category-repo.js');
  const { createCategory } = await import('./repositories/category-repo.js');
  const { createMenuItem } = await import('./repositories/menu-item-repo.js');
  const { createRider } = await import('./repositories/rider-repo.js');
  const { openShift } = await shiftRepo();
  at('18:00');
  const tax = createTaxCategory(db, { name: 'Test GST', rateBps: 1_500 }, actor);
  const food = createCategory(db, { name: 'Test Burgers', displayOrder: 1, colorHex: '#aa5500' }, actor);
  const fees = createCategory(db, { name: 'Delivery Charges', displayOrder: 2, colorHex: '#555555' }, actor);
  const item = (categoryId: string, name: string, basePriceCents: number) =>
    createMenuItem(db, { categoryId, name, basePriceCents, taxCategoryId: tax.id }, actor).id;
  const bigTwo = item(food.id, 'Test Big Two', 340_000);
  const fries = item(food.id, 'Test Fries', 50_000);
  const charge = item(fees.id, 'Delivery Charge (Rs 200)', 20_000);
  const rider = createRider(db, { name: 'Test Own Rider', phone: '03001112222' }, actor).id;
  const shiftId = openShift(db, { openingCashCents: FLOAT }, actor).id;
  return { db, shiftId, bigTwo, fries, charge, rider };
}

/** A counter delivery (Big Two + Fries + the charge), sent at 19:30, ready 19:45, at 19:50 sent out (outside rider) or given to the own rider. */
async function out(shop: Shop, opts: { own?: boolean } = {}) {
  const r = await repo();
  at('19:00');
  const o = r.createOrder(shop.db, { mode: 'delivery' }, CASHIER);
  for (const menuItemId of [shop.bigTwo, shop.fries, shop.charge]) {
    r.addOrderItem(shop.db, { orderId: o.id, menuItemId, quantity: 1, modifierIds: [] }, CASHIER);
  }
  at('19:30');
  r.sendOrderToKitchen(shop.db, o.id, CASHIER);
  at('19:45');
  r.markOrderReady(shop.db, o.id, CASHIER);
  at('19:50');
  const sent = opts.own ? r.assignRiderToOrder(shop.db, o.id, shop.rider, CASHIER) : r.sendOutOrder(shop.db, o.id, CASHIER);
  const snap = r.getOrderSnapshot(shop.db, o.id)!;
  return {
    id: o.id,
    orderNumber: sent.orderNumber as string,
    total: sent.totalCents as number,
    keep: (sent.riderKeepsCents ?? 0) as number,
    foodTotal: deliveryBillOf(snap)?.foodTotalCents ?? (sent.totalCents as number),
  };
}

/** The orders, shifts and counter handlers on this till; `call` runs one as the IPC would. */
async function ipc(shop: Shop, device = TILL) {
  h.handlers.clear();
  const { registerOrdersHandlers } = await import('../ipc/handlers/orders-handlers.js');
  const { registerShiftsHandlers } = await import('../ipc/handlers/shifts-handlers.js');
  const { registerCounterHandlers } = await import('../ipc/handlers/counter-handlers.js');
  registerOrdersHandlers({ db: shop.db, deviceId: device } as never);
  registerShiftsHandlers({ db: shop.db, deviceId: device } as never);
  registerCounterHandlers({ db: shop.db, deviceId: device } as never);
  const call = async <T>(channel: string, payload: unknown, as: 'cashier' | 'manager' = 'cashier'): Promise<T> => {
    h.session =
      as === 'manager'
        ? { id: 'u_mgr' as UUID, fullName: 'Test Manager', role: 'manager', sessionId: 'sess-m' as UUID }
        : { id: 'u_cash' as UUID, fullName: 'Test Cashier', role: 'cashier', sessionId: 'sess-c' as UUID };
    const fn = h.handlers.get(channel);
    if (!fn) throw new Error(`No handler for ${channel}`);
    const res = (await fn({ db: shop.db, deviceId: device }, payload)) as { ok: boolean; data: T };
    return res.data;
  };
  return call;
}

const count = (db: AppDatabase, table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
const lastAudit = (db: AppDatabase, orderId: string) =>
  db
    .prepare(`SELECT action, after_json FROM audit_log WHERE entity_type = 'orders' AND entity_id = ? ORDER BY rowid DESC LIMIT 1`)
    .get(orderId) as { action: string; after_json: string };

function chainOk(db: AppDatabase): boolean {
  const rows = (
    db
      .prepare(
        `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action, actor_user_id AS actorUserId,
                before_json AS beforeJson, after_json AS afterJson, ip, created_at AS createdAt,
                prev_hash AS prevHash, row_hash AS rowHash
           FROM audit_log ORDER BY rowid`,
      )
      .all() as unknown as AuditChainRow[]
  ).map((r) => ({ ...r, rowid: Number(r.rowid) }));
  return verifyAuditChain(rows).ok;
}

/** Delivered + Pay, cash, as the dialog sends it (the full total; the till pays his share itself). */
const deliverPay = (o: { id: string; total: number; keep: number }, refusedItem?: boolean) => ({
  orderId: o.id,
  payment: { method: 'cash', amountCents: o.total, tenderedCents: null, referenceNo: null },
  riderKeepsCents: o.keep,
  ...(refusedItem === undefined ? {} : { refusedItem }),
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

live('(1) Delivered + Pay with "Customer refused an item": the same money, and the marker in the same audit row', () => {
  it('money as without it; the mark_delivered_with_payment after-image says the refund is owed; the chain holds', async () => {
    const shop = await till();
    const o = await out(shop);
    const call = await ipc(shop);
    const before = { payments: count(shop.db, 'payments'), audit: count(shop.db, 'audit_log') };
    at('20:20');
    const snap = await call<{ order: { status: string }; refusedItem?: unknown }>('orders:markDelivered', deliverPay(o, true));
    expect(snap.order.status).toBe('paid');
    // The money: one cash payment of the total, the rider's payout and the drawer row — as without the refusal.
    expect(count(shop.db, 'payments')).toBe(before.payments + 1);
    const { getShiftSummary } = await shiftRepo();
    expect(getShiftSummary(shop.db, shop.shiftId).expectedCashCents).toBe(FLOAT + o.foodTotal);
    // The marker: in the order's own audit row of this step, never a column or another write.
    const audit = lastAudit(shop.db, o.id);
    expect(audit.action).toBe('mark_delivered_with_payment');
    expect(JSON.parse(audit.after_json)).toMatchObject({ status: 'paid', [REFUSED_ITEM_AUDIT_KEY]: true });
    expect(count(shop.db, 'audit_log') - before.audit).toBe(4);
    expect(chainOk(shop.db)).toBe(true);
    // The order the dialog gets back already says it.
    expect(snap.refusedItem).toEqual({ refundAt: null });
  });
});

live('(2) until its refund is done, the order and the Close shift box say so — and the shift still closes', () => {
  it('snapshot, Recent Orders and the close box; closing short is allowed and the short is the refused item', async () => {
    const shop = await till();
    const o = await out(shop);
    const call = await ipc(shop);
    at('20:20');
    await call('orders:markDelivered', deliverPay(o, true));

    const r = await repo();
    expect(r.getOrderSnapshot(shop.db, o.id)!.refusedItem).toEqual({ refundAt: null });
    const recent = await call<Array<{ id: string; refusedItemRefundOwed?: true }>>('orders:recentAtCounter', undefined);
    expect(recent.find((x) => x.id === o.id)).toMatchObject({ refusedItemRefundOwed: true });

    const check = await call<ShiftCloseCheck>('shifts:closeCheck', { shiftId: shop.shiftId }, 'manager');
    expect(check.refusedItemRefundsOwed).toEqual([{ orderId: o.id, orderNumber: o.orderNumber }]);
    // Never the shift's money before the count.
    expect(JSON.stringify(check)).not.toMatch(/expected|cash/i);

    // The rider brought the food total less the refused item: the close goes ahead, short by exactly that.
    at('21:00');
    const closed = await call<{ closedAt: string | null; varianceCents: number }>(
      'shifts:close',
      { shiftId: shop.shiftId, countedCashCents: FLOAT + o.foodTotal - FRIES_WITH_TAX, notes: null, carryOverOrderIds: [] },
      'manager',
    );
    expect(closed.closedAt).not.toBeNull();
    expect(closed.varianceCents).toBe(-FRIES_WITH_TAX);
  });
});

live('(3) a part refund of the item clears it, and the drawer then matches', () => {
  it('Part of it in Cash (manager PIN): the order, Recent Orders and the close box are clear; its audit row says it settled the item', async () => {
    const shop = await till();
    const o = await out(shop);
    const call = await ipc(shop);
    at('20:20');
    await call('orders:markDelivered', deliverPay(o, true));
    at('20:30');
    await call('orders:refund', {
      orderId: o.id,
      reason: 'Test item refused',
      approverPin: '1234',
      amountCents: FRIES_WITH_TAX,
      method: 'cash',
      expectStatus: 'paid',
    });

    const r = await repo();
    expect(r.getOrderSnapshot(shop.db, o.id)!.refusedItem).toEqual({ refundAt: PK['20:30'] });
    const recent = await call<Array<{ id: string; refusedItemRefundOwed?: true }>>('orders:recentAtCounter', undefined);
    expect(recent.find((x) => x.id === o.id)).not.toHaveProperty('refusedItemRefundOwed');
    const check = await call<ShiftCloseCheck>('shifts:closeCheck', { shiftId: shop.shiftId }, 'manager');
    expect(check).not.toHaveProperty('refusedItemRefundsOwed');
    const audit = lastAudit(shop.db, o.id);
    expect(audit.action).toBe('refund_partial');
    expect(JSON.parse(audit.after_json)).toMatchObject({ refusedItemRefund: true });
    expect(chainOk(shop.db)).toBe(true);

    // The drawer holds what the rider really brought: a close counting it is not short.
    const { getShiftSummary } = await shiftRepo();
    expect(getShiftSummary(shop.db, shop.shiftId).expectedCashCents).toBe(FLOAT + o.foodTotal - FRIES_WITH_TAX);

    // A later refund on the same order is a plain one: its audit row says nothing about the item.
    at('20:40');
    await call('orders:refund', { orderId: o.id, reason: 'Test late complaint', approverPin: '1234', amountCents: 10_000, method: 'cash', expectStatus: 'paid' });
    expect(JSON.parse(lastAudit(shop.db, o.id).after_json)).not.toHaveProperty('refusedItemRefund');
    expect(r.getOrderSnapshot(shop.db, o.id)!.refusedItem).toEqual({ refundAt: PK['20:30'] });
  });

  it('a refund made on the other till clears it here once it arrives (refunds sync; the marker stays this till’s)', async () => {
    const a = await till(TILL);
    const b = await till(OTHER);
    const o = await out(a);
    const callA = await ipc(a);
    at('20:20');
    await callA('orders:markDelivered', deliverPay(o, true));
    await push(a.db, TILL, b.db);
    const r = await repo();
    // The other till never had the marker (the audit log does not sync).
    expect(r.getOrderSnapshot(b.db, o.id)).not.toHaveProperty('refusedItem');
    at('20:30');
    r.refundOrder(
      b.db,
      { orderId: o.id, reason: 'Test item refused', approverUserId: 'u_mgr', amountCents: FRIES_WITH_TAX, method: 'cash' },
      { userId: 'u_cash', deviceId: OTHER },
    );
    await push(b.db, OTHER, a.db);
    expect(r.getOrderSnapshot(a.db, o.id)!.refusedItem).toEqual({ refundAt: PK['20:30'] });
    expect(r.listRefusedItemRefundsOwed(a.db, a.shiftId)).toEqual([]);
  });
});

live('(4) only an outside rider’s Delivered + Pay with the refusal marks an order', () => {
  it('a plain Delivered + Pay: no marker anywhere', async () => {
    const shop = await till();
    const o = await out(shop);
    const call = await ipc(shop);
    at('20:20');
    const snap = await call<{ refusedItem?: unknown }>('orders:markDelivered', deliverPay(o));
    expect(snap).not.toHaveProperty('refusedItem');
    expect(JSON.parse(lastAudit(shop.db, o.id).after_json)).not.toHaveProperty(REFUSED_ITEM_AUDIT_KEY);
    const recent = await call<Array<{ id: string; refusedItemRefundOwed?: true }>>('orders:recentAtCounter', undefined);
    expect(recent.find((x) => x.id === o.id)).not.toHaveProperty('refusedItemRefundOwed');
    expect(await call<ShiftCloseCheck>('shifts:closeCheck', { shiftId: shop.shiftId }, 'manager')).not.toHaveProperty('refusedItemRefundsOwed');
  });

  it('refusedItem on one of the shop’s own riders is refused in the words and writes nothing', async () => {
    const shop = await till();
    const o = await out(shop, { own: true });
    const r = await repo();
    const before = { payments: count(shop.db, 'payments'), audit: count(shop.db, 'audit_log'), sync: count(shop.db, 'sync_queue') };
    at('20:20');
    expect(() =>
      r.markOrderDelivered(
        shop.db,
        { orderId: o.id, payment: { method: 'cash', amountCents: o.total }, refusedItem: true },
        CASHIER,
      ),
    ).toThrow(r.REFUSED_ITEM_OUTSIDE_ONLY);
    expect({ payments: count(shop.db, 'payments'), audit: count(shop.db, 'audit_log'), sync: count(shop.db, 'sync_queue') }).toEqual(before);
    expect(r.findOrder(shop.db, o.id)!.status).toBe('out_for_delivery');
  });
});

live('(5) the close box lists this shift’s only; the order keeps saying it', () => {
  it('an item still owed from the shift before: on the order, not in the next shift’s close', async () => {
    const shop = await till();
    const o = await out(shop);
    const call = await ipc(shop);
    at('20:20');
    await call('orders:markDelivered', deliverPay(o, true));
    const { closeShift, openShift } = await shiftRepo();
    at('21:00');
    closeShift(shop.db, { shiftId: shop.shiftId, countedCashCents: FLOAT + o.foodTotal - FRIES_WITH_TAX }, MANAGER);
    at('21:30');
    const next = openShift(shop.db, { openingCashCents: FLOAT }, MANAGER);
    const r = await repo();
    expect(r.listRefusedItemRefundsOwed(shop.db, shop.shiftId)).toEqual([{ orderId: o.id, orderNumber: o.orderNumber }]);
    expect(r.listRefusedItemRefundsOwed(shop.db, next.id)).toEqual([]);
    expect(r.getOrderSnapshot(shop.db, o.id)!.refusedItem).toEqual({ refundAt: null });
  });
});
