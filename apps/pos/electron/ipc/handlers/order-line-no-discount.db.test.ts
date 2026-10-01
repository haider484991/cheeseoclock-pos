/**
 * Never discounted, frozen on each order line (migration 0047
 * order_items.no_discount; the owner, 2026-10-02: "there is no discount on
 * combos"). Through the real orders and menu IPC handlers and repositories on
 * a real SQLite database built from every migration:
 *   - a line takes its category's answer when it is added (Big Two in Value
 *     Deals, by its name: never; a pizza: discounted), and the row, the
 *     snapshot, the audit after-image and the sync image all carry it;
 *   - a delivery charge is never marked, whatever category it sits in;
 *   - a later change to the category (the owner's mark, or the item moved)
 *     leaves the lines already sold as they are, open or paid; the snapshot
 *     reads the line, never the category it is in today;
 *   - the renderer can't set it (orders:addItem passes only its named
 *     fields); the web bridge's own flag wins over the category;
 *   - changing a line's choices or quantity keeps it;
 *   - a category value this version does not know reads by the name.
 *
 * Only `defineHandler` (captured), the signed-in session, the printer
 * spooler and the FBR worker are stood in for. node's own `node:sqlite`
 * stands in for better-sqlite3 (built for Electron); skipped where it is
 * missing. Every name, id and amount is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, OrderSnapshot, UUID } from '@cheeseoclock/shared-types';
import { DatabaseSync, openMigrated } from '../../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Handler = (ctx: unknown, payload: unknown) => unknown;
const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => unknown>(),
  session: null as unknown,
}));

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
vi.mock('electron-log/main', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {} },
}));
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
vi.mock('../../services/auth-service.js', () => ({
  getCurrentSession: () => h.session,
  verifyManagerPin: async () => {
    throw new Error("That is not a manager's PIN or password");
  },
}));
vi.mock('../../services/print-spooler.js', () => ({
  printSpooler: new Proxy({}, { get: () => () => undefined }),
}));
vi.mock('../../services/fbr-worker.js', () => ({
  fbrWorker: { kick: () => {}, resetAdapter: () => {} },
}));

const live = describe.skipIf(!DatabaseSync);

const DEV = 'dev-till-1';
const T0 = '2026-01-01T00:00:00.000Z';
const session = (id: string, role: AuthenticatedUser['role']): AuthenticatedUser => ({
  id: id as UUID,
  fullName: id,
  role,
  sessionId: 'sess' as UUID,
});
const CASHIER = session('u_cash', 'cashier');
const OWNER = session('u_admin', 'admin');
const CASH_ACTOR = { userId: 'u_cash', deviceId: DEV };
const MGR_ACTOR = { userId: 'u_mgr', deviceId: DEV };

type Db = ReturnType<typeof openMigrated>;
let db: Db;
let menu: {
  food: string;
  deals: string;
  fees: string;
  pizza: string;
  bigTwo: string;
  fee: string;
  feeInDeals: string;
  extraDip: string;
};

type Outcome = { ok: true; data: unknown } | { ok: false; code: string; message: string };

async function call(channel: string, payload?: unknown): Promise<Outcome> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  try {
    const r = (await fn({ db, deviceId: DEV }, payload)) as
      | { ok: true; data: unknown }
      | { ok: false; error: { code: string; message: string } };
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

/** Users, a 15% tax, pizzas, the value deals (Big Two, with a paid extra dip), the delivery charges and a shift. */
async function seedTill(d: Db): Promise<typeof menu> {
  const user = d.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_admin', 'Test Owner', 'admin', T0, T0, DEV);
  user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
  user.run('u_mgr', 'Test Manager', 'manager', T0, T0, DEV);
  const x = d as never;
  const { createTaxCategory } = await import('../../db/repositories/tax-category-repo.js');
  const { createCategory } = await import('../../db/repositories/category-repo.js');
  const { createMenuItem } = await import('../../db/repositories/menu-item-repo.js');
  const mods = await import('../../db/repositories/modifier-repo.js');
  const { openShift } = await import('../../db/repositories/shift-repo.js');
  const tax = createTaxCategory(x, { name: 'Test GST', rateBps: 1_500 }, MGR_ACTOR);
  const food = createCategory(x, { name: 'Test Pizzas', displayOrder: 1, colorHex: '#aa5500' }, MGR_ACTOR);
  const deals = createCategory(x, { name: 'Value Deals', displayOrder: 2, colorHex: '#aa0055' }, MGR_ACTOR);
  const fees = createCategory(x, { name: 'Delivery Charges', displayOrder: 3, colorHex: '#555555' }, MGR_ACTOR);
  const item = (categoryId: string, name: string, cents: number) =>
    createMenuItem(x, { categoryId, name, basePriceCents: cents, taxCategoryId: tax.id }, MGR_ACTOR).id;
  const pizza = item(food.id, 'Test Fajita Pizza', 150_000);
  const bigTwo = item(deals.id, 'Big Two', 360_000);
  const fee = item(fees.id, 'Delivery Charge (Rs 200)', 20_000);
  // A fee item someone filed under the deals: still a delivery charge by its name.
  const feeInDeals = item(deals.id, 'Delivery Charge (Rs 250)', 25_000);
  const dips = mods.createModifierGroup(x, { name: 'Test extra dips', selectionType: 'multi', minSelect: 0, maxSelect: 2, isRequired: false }, MGR_ACTOR);
  const extraDip = mods.createModifier(x, { modifierGroupId: dips.id, name: 'Test garlic dip', priceDeltaCents: 10_000 }, MGR_ACTOR).id;
  mods.setItemModifierGroups(x, bigTwo, [{ modifierGroupId: dips.id, sortOrder: 0 }], MGR_ACTOR);
  openShift(x, { openingCashCents: 0 }, MGR_ACTOR);
  return { food: food.id, deals: deals.id, fees: fees.id, pizza, bigTwo, fee, feeInDeals, extraDip };
}

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.session = null;
  db = openMigrated({});
  menu = await seedTill(db);
  (await import('./menu-handlers.js')).registerMenuHandlers({ db, deviceId: DEV } as never);
  (await import('./orders-handlers.js')).registerOrdersHandlers({ db, deviceId: DEV } as never);
});

const repo = () => import('../../db/repositories/order-repo.js');
async function newOrder(mode: 'takeaway' | 'delivery' = 'takeaway'): Promise<string> {
  return (await repo()).createOrder(db as never, { mode }, CASH_ACTOR).id;
}
/** orders:addItem as the till sends it, signed in as the cashier; the new line's id. */
async function ring(orderId: string, menuItemId: string, extra: Record<string, unknown> = {}): Promise<string> {
  h.session = CASHIER;
  const before = new Set(lineIds(orderId));
  await data<OrderSnapshot>('orders:addItem', { orderId, menuItemId, quantity: 1, modifierIds: [], notes: null, ...extra });
  const added = lineIds(orderId).filter((id) => !before.has(id));
  if (added.length !== 1) throw new Error(`expected one new line, got ${added.length}`);
  return added[0] as string;
}
const lineIds = (orderId: string) =>
  (db.prepare(`SELECT id FROM order_items WHERE order_id = ? AND deleted_at IS NULL ORDER BY created_at, id`).all(orderId) as Array<{ id: string }>).map(
    (r) => r.id,
  );
/** [name sold under, no_discount] per line, as stored. */
const stored = (orderId: string) =>
  (
    db
      .prepare(`SELECT menu_item_name AS name, no_discount AS nd FROM order_items WHERE order_id = ? AND deleted_at IS NULL ORDER BY created_at, id`)
      .all(orderId) as Array<{ name: string; nd: number }>
  ).map((r) => [r.name, r.nd]);
const snapshotLines = async (orderId: string) =>
  (await repo()).getOrderSnapshot(db as never, orderId)!.items.map((i) => [i.menuItemName, i.categoryName, i.noDiscount]);
const lastImage = (lineId: string) =>
  JSON.parse(
    (db.prepare(`SELECT payload_json FROM sync_queue WHERE entity_type = 'order_items' AND entity_id = ? ORDER BY rowid DESC LIMIT 1`).get(lineId) as {
      payload_json: string;
    }).payload_json,
  ) as Record<string, unknown>;
const createAudit = (lineId: string) =>
  JSON.parse(
    (db.prepare(`SELECT after_json FROM audit_log WHERE entity_type = 'order_items' AND entity_id = ? AND action = 'create'`).get(lineId) as {
      after_json: string;
    }).after_json,
  ) as Record<string, unknown>;
const orderLineQueue = () =>
  (db.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type IN ('order_items', 'orders')`).get() as { n: number }).n;

live('Each order line keeps the "never discounted" answer it was sold under (0047 order_items.no_discount)', () => {
  it('Big Two (Value Deals, by its name) is sold never discounted, a pizza is not: the row, the reply, the snapshot, the audit after-image and the sync image all say so', async () => {
    const o = await newOrder();
    const deal = await ring(o, menu.bigTwo);
    h.session = CASHIER;
    const reply = await data<OrderSnapshot>('orders:addItem', { orderId: o, menuItemId: menu.pizza, quantity: 2, modifierIds: [], notes: null });
    const pizza = lineIds(o)[1] as string;
    expect(stored(o)).toEqual([
      ['Big Two', 1],
      ['Test Fajita Pizza', 0],
    ]);
    expect(reply.items.map((i) => [i.menuItemName, i.noDiscount])).toEqual([
      ['Big Two', true],
      ['Test Fajita Pizza', false],
    ]);
    expect(await snapshotLines(o)).toEqual([
      ['Big Two', 'Value Deals', true],
      ['Test Fajita Pizza', 'Test Pizzas', false],
    ]);
    expect(createAudit(deal)).toMatchObject({ menuItemName: 'Big Two', noDiscount: true });
    expect(createAudit(pizza)).toMatchObject({ menuItemName: 'Test Fajita Pizza', noDiscount: false });
    expect(lastImage(deal)).toMatchObject({ id: deal, noDiscount: 1 });
    expect(lastImage(pizza)).toMatchObject({ id: pizza, noDiscount: 0 });
  });

  it('a delivery charge is never marked: not one filed under Value Deals, not one in a category the owner set never discounted', async () => {
    h.session = OWNER;
    await data('menu:updateCategory', { id: menu.fees, noDiscount: true });
    expect(db.prepare(`SELECT no_discount FROM categories WHERE id = ?`).get(menu.fees)).toEqual({ no_discount: 1 });
    const o = await newOrder('delivery');
    const inDeals = await ring(o, menu.feeInDeals);
    const inFees = await ring(o, menu.fee);
    expect(stored(o)).toEqual([
      ['Delivery Charge (Rs 250)', 0],
      ['Delivery Charge (Rs 200)', 0],
    ]);
    expect((await snapshotLines(o)).map(([, , nd]) => nd)).toEqual([false, false]);
    expect([createAudit(inDeals)['noDiscount'], createAudit(inFees)['noDiscount']]).toEqual([false, false]);
    expect([lastImage(inDeals)['noDiscount'], lastImage(inFees)['noDiscount']]).toEqual([0, 0]);
  });

  it('a later change to the category — the owner’s mark, or the item moved — leaves the lines already sold as they are, open or paid; a new line takes the answer of its time', async () => {
    const r = await repo();
    const open = await newOrder();
    await ring(open, menu.bigTwo);
    await ring(open, menu.pizza);
    const paid = await newOrder();
    await ring(paid, menu.bigTwo);
    await ring(paid, menu.pizza);
    const total = r.findOrder(db as never, paid)!.totalCents;
    r.tenderOrder(db as never, { orderId: paid, payments: [{ method: 'cash', amountCents: total, tenderedCents: total }] }, CASH_ACTOR);
    const money = `SELECT paid_at, subtotal_cents, discount_cents, tax_cents, total_cents FROM orders WHERE id = ?`;
    const paidBefore = db.prepare(money).get(paid);
    expect(paidBefore).toMatchObject({ paid_at: expect.any(String), total_cents: total });
    const queued = orderLineQueue();

    // The owner lets discounts come off Value Deals; a manager moves the pizza into a category whose name says never.
    h.session = OWNER;
    await data('menu:updateCategory', { id: menu.deals, noDiscount: false });
    const { createCategory } = await import('../../db/repositories/category-repo.js');
    const { updateMenuItem } = await import('../../db/repositories/menu-item-repo.js');
    const combos = createCategory(db as never, { name: 'Test Combo Deals', displayOrder: 4, colorHex: '#123456' }, MGR_ACTOR);
    updateMenuItem(db as never, { id: menu.pizza, categoryId: combos.id }, MGR_ACTOR);

    // Nothing sold moved: not a row, not a sync entry for a line or an order, not the paid order's money.
    expect(orderLineQueue()).toBe(queued);
    for (const o of [open, paid]) {
      expect(stored(o)).toEqual([
        ['Big Two', 1],
        ['Test Fajita Pizza', 0],
      ]);
      // The snapshot reads the line, even though the pizza's category now says never by its name.
      expect(await snapshotLines(o)).toEqual([
        ['Big Two', 'Value Deals', true],
        ['Test Fajita Pizza', 'Test Combo Deals', false],
      ]);
    }
    expect(db.prepare(money).get(paid)).toEqual(paidBefore);

    // What is rung up now takes the categories as they are now.
    await ring(open, menu.bigTwo);
    await ring(open, menu.pizza);
    expect(stored(open)).toEqual([
      ['Big Two', 1],
      ['Test Fajita Pizza', 0],
      ['Big Two', 0],
      ['Test Fajita Pizza', 1],
    ]);
  });

  it('orders:addItem takes no noDiscount from the renderer: a pizza sent as never discounted is stored 0, Big Two sent as discounted is stored 1', async () => {
    const o = await newOrder();
    const pizza = await ring(o, menu.pizza, { noDiscount: true });
    const deal = await ring(o, menu.bigTwo, { noDiscount: false });
    expect(stored(o)).toEqual([
      ['Test Fajita Pizza', 0],
      ['Big Two', 1],
    ]);
    expect([createAudit(pizza)['noDiscount'], createAudit(deal)['noDiscount']]).toEqual([false, true]);
  });

  it('the web bridge’s own flag (bridge only) wins over the category; a delivery charge stays 0 whatever it says', async () => {
    const r = await repo();
    const o = await newOrder('delivery');
    const add = (menuItemId: string, noDiscount: boolean) =>
      r.addOrderItem(db as never, { orderId: o, menuItemId, quantity: 1, modifierIds: [], noDiscount }, CASH_ACTOR);
    const pizza = add(menu.pizza, true);
    const deal = add(menu.bigTwo, false);
    const fee = add(menu.fee, true);
    expect([pizza.noDiscount, deal.noDiscount, fee.noDiscount]).toEqual([true, false, false]);
    expect(stored(o)).toEqual([
      ['Test Fajita Pizza', 1],
      ['Big Two', 0],
      ['Delivery Charge (Rs 200)', 0],
    ]);
    expect([lastImage(pizza.id)['noDiscount'], lastImage(deal.id)['noDiscount'], lastImage(fee.id)['noDiscount']]).toEqual([1, 0, 0]);
  });

  it('changing a line’s choices or its quantity keeps its answer, in the row and in the sync image', async () => {
    const o = await newOrder();
    const deal = await ring(o, menu.bigTwo);
    const pizza = await ring(o, menu.pizza);
    h.session = CASHIER;
    await data('orders:updateItemOptions', { orderId: o, orderItemId: deal, modifierIds: [menu.extraDip], notes: 'Test: extra dip' });
    await data('orders:updateItemQuantity', { orderId: o, orderItemId: deal, quantity: 3 });
    await data('orders:updateItemQuantity', { orderId: o, orderItemId: pizza, quantity: 2 });
    expect(db.prepare(`SELECT quantity, line_total_cents, no_discount FROM order_items WHERE id = ?`).get(deal)).toEqual({
      quantity: 3,
      line_total_cents: 3 * (360_000 + 10_000),
      no_discount: 1,
    });
    expect(db.prepare(`SELECT quantity, no_discount FROM order_items WHERE id = ?`).get(pizza)).toEqual({ quantity: 2, no_discount: 0 });
    expect(lastImage(deal)).toMatchObject({ quantity: 3, noDiscount: 1 });
    expect(lastImage(pizza)).toMatchObject({ quantity: 2, noDiscount: 0 });
    expect((await snapshotLines(o)).map(([, , nd]) => nd)).toEqual([true, false]);
  });

  it('a category value this version does not know (a newer till’s) reads by the name: Value Deals never, the pizzas discounted', async () => {
    db.prepare(`UPDATE categories SET no_discount = 2 WHERE id IN (?, ?)`).run(menu.deals, menu.food);
    const o = await newOrder();
    await ring(o, menu.bigTwo);
    await ring(o, menu.pizza);
    expect(stored(o)).toEqual([
      ['Big Two', 1],
      ['Test Fajita Pizza', 0],
    ]);
  });
});
