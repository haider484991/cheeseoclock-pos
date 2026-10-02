/**
 * Edit order and Free order (v0.7.36) through the real IPC handlers and
 * repositories, on a real SQLite database built from every migration:
 *   - a cashier adds to an order the kitchen has: no PIN, and one CHANGE
 *     slip for the kitchen with only the new line (drinks marked as drinks);
 *   - taking a line off: the reason is asked first (no PIN attempt used up),
 *     then a manager's PIN; a wrong one is refused and nothing is written;
 *     the slip says what not to make, with the reason;
 *   - an edit worked on an order that changed since is refused, and a
 *     discount-only edit sends the kitchen nothing to make;
 *   - a Free order on the cart: 100% only, never foodpanda, the reason
 *     before the PIN; then Rs 0;
 *   - a Free order sent with Send, and one made in an edit: paid at Rs 0
 *     with its FBR invoice queued, and Send out pays the outside rider his
 *     charge from the drawer.
 *
 * Only `defineHandler` (captured), the signed-in session and the manager
 * check (auth-service), the printer spooler (its edit slips recorded) and the
 * FBR worker are stood in for. node's own `node:sqlite` stands in for
 * better-sqlite3 (built for Electron); skipped where it is missing. Every
 * name and amount is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import type { AuthenticatedUser, KitchenChange, OrderEditPreview, OrderSnapshot, UUID } from '@cheeseoclock/shared-types';
import { FREE_ORDER_IS_ALL, FREE_ORDER_NEEDS_MANAGER, FREE_ORDER_NEEDS_REASON, FREE_ORDER_NOT_FOODPANDA } from '@cheeseoclock/pos-domain';
import { CASHIER, DEV, DatabaseSync, MANAGER, openCostingShop, openMigrated, type Item } from '../../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Handler = (ctx: unknown, payload: unknown) => unknown;
const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => unknown>(),
  session: null as unknown,
  pinChecks: 0,
  slips: [] as Array<{ orderId: string; change: unknown }>,
}));

const PIN = 'Test-manager-7';

vi.mock('../registry.js', () => {
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
    defineHandler: (channel: string, _ctx: unknown, fn: Handler) => {
      h.handlers.set(channel, fn);
    },
  };
});
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '', getVersion: () => '0.0.0-test' },
  safeStorage: { isEncryptionAvailable: () => false },
  Notification: class {
    static isSupported() {
      return false;
    }
  },
}));
vi.mock('../../services/auth-service.js', () => ({
  getCurrentSession: () => h.session,
  verifyManagerPin: async (_db: unknown, pin: string) => {
    h.pinChecks += 1;
    if (pin === 'Test-manager-7') return { approverUserId: 'u_mgr', approverName: 'Test Manager' };
    throw new Error("That is not a manager's PIN or password");
  },
}));
vi.mock('../../services/print-spooler.js', () => ({
  printSpooler: new Proxy(
    {},
    {
      get: (_t, key) =>
        key === 'onOrderEdited'
          ? (orderId: string, change: unknown) => {
              h.slips.push({ orderId, change });
            }
          : () => undefined,
    },
  ),
}));
vi.mock('../../services/fbr-worker.js', () => ({ fbrWorker: { kick: () => {}, resetAdapter: () => {} } }));

const live = describe.skipIf(!DatabaseSync);
type Row = Record<string, unknown>;
const user = (id: string, role: AuthenticatedUser['role']): AuthenticatedUser => ({ id: id as UUID, fullName: id, role, sessionId: 'sess' as UUID });
const CASHIER_LOGIN = user(CASHIER.userId, 'cashier');

let db: ReturnType<typeof openMigrated>;
let shop: Awaited<ReturnType<typeof openCostingShop>>;

type Outcome = { ok: true; data: unknown } | { ok: false; code: string; message: string };
async function call(channel: string, payload?: unknown): Promise<Outcome> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  try {
    const r = (await fn({ db, deviceId: DEV }, payload)) as { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
    return r.ok ? { ok: true, data: r.data } : { ok: false, code: r.error.code, message: r.error.message };
  } catch (e) {
    const api = (e as { apiError?: { code: string; message: string } }).apiError;
    if (api) return { ok: false, code: api.code, message: api.message };
    return { ok: false, code: 'threw', message: e instanceof Error ? e.message : String(e) };
  }
}
async function data<T = unknown>(channel: string, payload?: unknown): Promise<T> {
  const o = await call(channel, payload);
  if (!o.ok) throw new Error(`${channel} refused: ${o.code} ${o.message}`);
  return o.data as T;
}

/** A counter order rung up and sent to the kitchen through the till's own calls. */
async function sentOrder(lines: Array<[Item, number]>, mode: 'takeaway' | 'delivery' = 'takeaway'): Promise<string> {
  const o = await data<{ id: string }>('orders:create', { mode });
  for (const [it, quantity] of lines) await data('orders:addItem', { orderId: o.id, menuItemId: shop.item[it], quantity });
  if (mode === 'delivery') await withCustomer(o.id);
  await data('orders:sendToKitchen', { orderId: o.id });
  return o.id;
}
async function withCustomer(orderId: string): Promise<void> {
  const c = await import('../../db/repositories/customer-repo.js');
  const cust = c.createCustomer(db as never, { name: 'Test Customer', phone: '03001234567' }, CASHIER);
  const addr = c.createAddress(db as never, { customerId: cust.id, label: 'Home', addressLine: 'House 1, Test Street', area: 'Test Area' }, CASHIER);
  c.snapshotCustomerOntoOrder(db as never, { orderId, customerId: cust.id, addressId: addr.id }, CASHIER);
}
const snap = (orderId: string): OrderSnapshot => shop.r.getOrderSnapshot(db, orderId)!;
const lineOf = (orderId: string, it: Item) => snap(orderId).items.find((i) => i.menuItemId === shop.item[it])!;
const add = (it: Item, quantity = 1) => ({ op: 'add' as const, lineId: uuidv7(), menuItemId: shop.item[it], quantity, modifierIds: [], notes: null });
const count = (sql: string, ...p: unknown[]) => Number((db.prepare(sql).get(...p) as Row)['n']);
const edits = (orderId: string) => count(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ? AND action = 'order_edit'`, orderId);
const fbrRows = (orderId: string) => count(`SELECT COUNT(*) AS n FROM fbr_submission_queue WHERE order_id = ?`, orderId);
const slip = () => h.slips.at(-1)?.change as KitchenChange;

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.slips.length = 0;
  h.pinChecks = 0;
  db = openMigrated();
  shop = await openCostingShop(db);
  const { openShift } = await import('../../db/repositories/shift-repo.js');
  openShift(db, { openingCashCents: 0, notes: null }, MANAGER);
  (await import('./orders-handlers.js')).registerOrdersHandlers({ db, deviceId: DEV } as never);
  h.session = CASHIER_LOGIN;
});

live('Edit order through the till’s calls', () => {
  it('a cashier adds to an order the kitchen has: no PIN, and a CHANGE slip with only the new line', async () => {
    const id = await sentOrder([['fajitaM', 1]]);
    const pizza = add('fajitaM');
    const cola = add('cola', 2);
    const p = await data<OrderEditPreview>('orders:previewEdit', { orderId: id, ops: [pizza, cola] });
    expect(p.needs).toEqual({ pin: false, why: [], reason: false });
    const r = await data<{ snapshot: OrderSnapshot }>('orders:saveEdit', { orderId: id, baseKey: p.baseKey, ops: [pizza, cola] });
    expect(r.snapshot.order.orderNumber).toBe(snap(id).order.orderNumber);
    expect(r.snapshot.items.map((i) => i.id)).toEqual(expect.arrayContaining([pizza.lineId, cola.lineId]));
    expect(h.pinChecks).toBe(0);
    expect(h.slips).toHaveLength(1);
    expect(slip()).toMatchObject({
      editNo: 1,
      byUserId: CASHIER.userId,
      reason: null,
      added: [
        { name: 'Fajita Pizza — Medium', quantity: 1, drink: false },
        { name: 'Cola 345 ml', quantity: 2, drink: true },
      ],
      removed: [],
    });
    expect(edits(id)).toBe(1);
  });

  it('taking a line off: the reason first, then a manager’s PIN; a wrong one writes nothing; the slip says what not to make', async () => {
    const id = await sentOrder([['fajitaM', 1], ['bakedWings', 1]]);
    const wings = lineOf(id, 'bakedWings');
    const ops = [{ op: 'remove', orderItemId: wings.id }];
    const p = await data<OrderEditPreview>('orders:previewEdit', { orderId: id, ops });
    expect(p.needs).toEqual({ pin: true, why: ['An item the kitchen has comes off'], reason: true });

    const noReason = await call('orders:saveEdit', { orderId: id, baseKey: p.baseKey, ops, approverPin: PIN });
    expect(noReason).toMatchObject({ ok: false, code: 'validation_failed', message: expect.stringMatching(/^Say why/) });
    expect(h.pinChecks).toBe(0);

    const noPin = await call('orders:saveEdit', { orderId: id, baseKey: p.baseKey, ops, reason: 'Customer changed order' });
    expect(noPin).toMatchObject({ ok: false, code: 'precondition_failed', message: "An item the kitchen has comes off — a manager's PIN or password is needed." });

    const wrong = await call('orders:saveEdit', { orderId: id, baseKey: p.baseKey, ops, reason: 'Customer changed order', approverPin: 'Not-the-pin-1' });
    expect(wrong).toMatchObject({ ok: false, code: 'forbidden' });
    expect(snap(id).items).toHaveLength(2);
    expect(edits(id)).toBe(0);
    expect(h.slips).toHaveLength(0);

    await data('orders:saveEdit', {
      orderId: id,
      baseKey: p.baseKey,
      ops,
      reason: 'Customer changed order',
      approverPin: PIN,
      foodMade: { [wings.id]: 'not_made' },
    });
    expect(snap(id).items.map((i) => i.menuItemName)).toEqual(['Fajita Pizza — Medium']);
    expect(slip()).toMatchObject({ editNo: 1, reason: 'Customer changed order', added: [], removed: [{ name: 'Baked Wings', quantity: 1, drink: false }] });
    const audit = db.prepare(`SELECT after_json FROM audit_log WHERE entity_id = ? AND action = 'order_edit'`).get(id) as Row;
    expect(JSON.parse(String(audit['after_json']))).toMatchObject({ approverUserId: MANAGER.userId, reason: 'Customer changed order' });
  });

  it('an edit worked on an order that changed since is refused; a discount-only edit gives the kitchen nothing to make', async () => {
    const id = await sentOrder([['fajitaM', 1]]);
    const first = await data<OrderEditPreview>('orders:previewEdit', { orderId: id, ops: [] });
    await data('orders:saveEdit', { orderId: id, baseKey: first.baseKey, ops: [add('cola')] });
    const stale = await call('orders:saveEdit', { orderId: id, baseKey: first.baseKey, ops: [add('cola')] });
    expect(stale).toMatchObject({ ok: false, code: 'precondition_failed', message: expect.stringMatching(/changed while you were editing/) });

    h.slips.length = 0;
    const off = [{ op: 'discount', discountType: 'percent', value: 10, reason: 'Forgot the discount' }];
    const p = await data<OrderEditPreview>('orders:previewEdit', { orderId: id, ops: off });
    await data('orders:saveEdit', { orderId: id, baseKey: p.baseKey, ops: off, reason: 'Forgot the discount' });
    expect(snap(id).order.discountCents).toBeGreaterThan(0);
    expect(slip()).toMatchObject({ added: [], removed: [] });
  });
});

live('Free order through the till’s calls', () => {
  it('on the cart: 100% only, never foodpanda, the reason before the PIN; then Rs 0', async () => {
    const o = await data<{ id: string }>('orders:create', { mode: 'takeaway' });
    await data('orders:addItem', { orderId: o.id, menuItemId: shop.item.fajitaM, quantity: 1 });
    const free = { orderId: o.id, discountType: 'percent', value: 100, free: true };
    expect(await call('orders:applyDiscount', { ...free, value: 50, reason: 'Staff meal', approverPin: PIN })).toMatchObject({ ok: false, message: FREE_ORDER_IS_ALL });
    expect(await call('orders:applyDiscount', { ...free, approverPin: PIN })).toMatchObject({ ok: false, message: FREE_ORDER_NEEDS_REASON });
    expect(h.pinChecks).toBe(0);
    expect(await call('orders:applyDiscount', { ...free, reason: 'Staff meal' })).toMatchObject({ ok: false, message: FREE_ORDER_NEEDS_MANAGER });
    expect(await call('orders:applyDiscount', { ...free, reason: 'Staff meal', approverPin: 'Not-the-pin-1' })).toMatchObject({ ok: false, code: 'forbidden' });
    const made = await data<OrderSnapshot>('orders:applyDiscount', { ...free, reason: 'Staff meal', approverPin: PIN });
    expect(made.order.totalCents).toBe(0);
    expect(made.discounts.at(-1)).toMatchObject({ freeOrder: true, reason: 'Staff meal' });

    const fp = await data<{ id: string }>('orders:create', { mode: 'foodpanda' });
    await data('orders:addItem', { orderId: fp.id, menuItemId: shop.item.fajitaM, quantity: 1 });
    expect(await call('orders:applyDiscount', { ...free, orderId: fp.id, reason: 'Staff meal', approverPin: PIN })).toMatchObject({
      ok: false,
      message: FREE_ORDER_NOT_FOODPANDA,
    });
  });

  it('sent with Send: paid at Rs 0 with its FBR invoice queued, and Send out pays the rider his charge from the drawer', async () => {
    const o = await data<{ id: string }>('orders:create', { mode: 'delivery' });
    await data('orders:addItem', { orderId: o.id, menuItemId: shop.item.fajitaM, quantity: 1 });
    await data('orders:addItem', { orderId: o.id, menuItemId: shop.item.delivery, quantity: 1 });
    await withCustomer(o.id);
    await data('orders:applyDiscount', { orderId: o.id, discountType: 'percent', value: 100, free: true, reason: 'Owner guest', approverPin: PIN });
    const sent = await data<OrderSnapshot>('orders:sendToKitchen', { orderId: o.id });
    expect(sent.order.paidAt).not.toBeNull();
    expect(sent.payments).toHaveLength(0);
    expect(fbrRows(o.id)).toBe(1);
    const out = await data<OrderSnapshot>('orders:sendOut', { orderId: o.id });
    expect(out.order.riderKeepsCents).toBe(10_000);
    const payout = db.prepare(`SELECT amount_cents, type FROM cash_movements WHERE order_id = ? AND deleted_at IS NULL`).get(o.id) as Row;
    expect(payout).toMatchObject({ type: 'payout' });
    expect(Math.abs(Number(payout['amount_cents']))).toBe(10_000);
  });

  it('made in an edit: paid at Rs 0 with its FBR invoice queued, the kitchen told nothing to make', async () => {
    const id = await sentOrder([['fajitaM', 1], ['delivery', 1]], 'delivery');
    expect(fbrRows(id)).toBe(0);
    const ops = [{ op: 'discount', discountType: 'percent', value: 100, reason: 'Complaint', free: true }];
    const p = await data<OrderEditPreview>('orders:previewEdit', { orderId: id, ops });
    expect(p.needs).toEqual({ pin: true, why: ['A Free order'], reason: true });
    expect(p.diff.freeOrder).toBe(true);
    expect(p.snapshot.order.totalCents).toBe(0);
    await data('orders:saveEdit', { orderId: id, baseKey: p.baseKey, ops, reason: 'Complaint', approverPin: PIN });
    const after = snap(id);
    expect(after.order.paidAt).not.toBeNull();
    expect(after.order.totalCents).toBe(0);
    expect(fbrRows(id)).toBe(1);
    expect(slip()).toMatchObject({ added: [], removed: [] });
  });
});
