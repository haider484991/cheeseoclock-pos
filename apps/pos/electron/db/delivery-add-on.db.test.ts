/**
 * Add-on delivery for the same phone (the owner, 2 Oct 2026: "if its out then
 * it should charge if the rider is not out"; order-edit finding #7, the
 * owner's version): a counter delivery whose phone has another delivery the
 * shop still has goes with it on one trip, so the area's charge stays off.
 * On a real database built from every migration, driven through the
 * repositories (syncOrderDeliveryCharge, the customer save, the order type,
 * and deliveryChargeForArea's 'phone' event):
 *   - the first delivery #A sent to the kitchen (paid or not), being made or
 *     Ready: a new Delivery cart for the same phone, typed '03001234567' or
 *     '+92 300 1234567', in DHA Phase 6 gets no 'Delivery Charge (Rs 200)';
 *     the 'delivery_area' row records goesWith #A and charged 'add_on_off';
 *   - #A out for delivery, delivered, paid, cancelled, refunded or still a
 *     cart, another phone, or no Pakistani number: charged (a new trip);
 *   - 'Put it back' charges it and holds through later saves, a 'phone'
 *     event and the order type switched back to Delivery; the phone changed
 *     to another, or #A gone out before the next event, puts the charge on;
 *   - #A on the other till (its synced row) counts; a website order is never
 *     touched, and one still in the kitchen is a first delivery too;
 *   - every line change has its sync and audit rows; a 'phone' event that
 *     goes with the same delivery writes nothing.
 * Wired to the phone (18-10b):
 *   - Send's and Pay's customer save (snapshotCustomerOntoOrder), with or
 *     without an address, settles the rule before the order is sent or
 *     paid: the charge comes off while #A is in the kitchen, and goes on
 *     when #A went out first; taking the customer off
 *     (detachCustomerFromOrder) clears the add-on with the address;
 *   - the snapshot's addOnTo names #A only while the charge is left off for
 *     it, and only on an open counter delivery;
 *   - 'orders:setDeliveryArea' carries the panel's phone (trimmed, at most
 *     30 characters); 'customers:attachToOrder' answers with addOnTo;
 *   - the add-on sent out freezes rider_keeps_cents 0 while #A keeps Rs 200.
 * An add-on that now goes alone (review fixes C, 2 Oct 2026): #A cancelled,
 * refunded, or delivered (by one of the shop's own riders, or paid to an
 * outside rider) after the add-on #B was sent, before #B's Send out:
 *   - #B's snapshot says goesAlone #A with the area's Rs 200 (null while #A
 *     is in the shop or out, once the charge is put back, or for a charge
 *     put on by hand; absent on carts and on orders already out);
 *   - Send out with nothing ticked writes no payout and no drawer row (he
 *     keeps 0, as before);
 *   - 'Pay the rider Rs 200 for this trip': one payout linked to #B ('Trip
 *     paid to the outside rider — Order #0002 went alone', audited why
 *     'trip', tripWhy 'went_alone'), one drawer 'payout' row for −Rs 200 with
 *     the manager who allowed it, the 'send_out' audit says so; the shift
 *     expects Rs 200 less, and a close counting that is not short;
 *   - refused (nothing written, #B still Ready) when #B does not go alone or
 *     no shift is open; on the IPC it needs a manager's PIN or password, and
 *     the drawer opens once for that row.
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for
 * Electron); skipped where it is missing. Only `defineHandler` (captured),
 * the signed-in session, the printer spooler, the FBR worker and the order
 * alerts are stood in for. Every name, number and amount is made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, OrderSnapshot, UUID } from '@cheeseoclock/shared-types';
import type { AppDatabase } from './connection.js';
import { DatabaseSync } from './costing-shop.fixture.js';
import { openTill, push } from './two-tills.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => Promise<unknown>>(),
  session: null as AuthenticatedUser | null,
  /** Manager PINs the stand-in accepts, and whose they are (none unless a test adds one). */
  managerPins: new Map<string, string>(),
  /** The drawer pulses the handlers asked for (kickDrawerSoon's drawer row ids). */
  kicks: [] as string[],
}));

vi.mock('electron-log/main', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
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
// The orders and customers handlers, captured instead of registered with Electron.
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
    defineHandler: (
      channel: string,
      _ctx: unknown,
      fn: (ctx: unknown, payload: unknown) => Promise<unknown>,
    ) => {
      h.handlers.set(channel, async (ctx, payload) => fn(ctx, payload));
    },
  };
});
// Who is signed in: auth-service's job, stood in for here.
vi.mock('../services/auth-service.js', () => ({
  getCurrentSession: () => h.session,
  verifyManagerPin: async (_db: unknown, pin: string) => {
    const approverUserId = h.managerPins.get(pin);
    if (approverUserId) return { approverUserId, approverName: 'Test Manager' };
    throw new Error("That is not a manager's PIN or password");
  },
}));
// No printer here: the drawer pulses are only noted, the papers ignored.
vi.mock('../services/print-spooler.js', () => ({
  printSpooler: new Proxy(
    {},
    {
      get:
        (_t, method) =>
        (...args: unknown[]) => {
          if (method === 'kickDrawerSoon') h.kicks.push(String(args[0]));
          return undefined;
        },
    },
  ),
  drawerFailureText: () => '',
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

/** The made-up customer, as the first order's cashier typed it. */
const PHONE = '0300 1234567';
const AREA = 'DHA Phase 6';

/** Evening times in Pakistan (UTC+5), as instants. */
const PK = {
  '18:00': '2026-10-02T13:00:00.000Z',
  '19:00': '2026-10-02T14:00:00.000Z',
  '19:10': '2026-10-02T14:10:00.000Z',
  '19:20': '2026-10-02T14:20:00.000Z',
  '19:30': '2026-10-02T14:30:00.000Z',
  '19:40': '2026-10-02T14:40:00.000Z',
  '19:50': '2026-10-02T14:50:00.000Z',
  '19:55': '2026-10-02T14:55:00.000Z',
} as const;
type Clock = keyof typeof PK;
const at = (t: Clock) => vi.setSystemTime(new Date(PK[t]));

const repo = () => import('./repositories/order-repo.js');
const customers = () => import('./repositories/customer-repo.js');
type Row = Record<string, unknown>;

interface Shop {
  db: AppDatabase;
  pizza: string;
  charge200: string;
  charge250: string;
  rider: string;
}

/**
 * A till: the made-up users, a 15% tax, a Rs 1,000 'Test Pizza', the areas'
 * 'Delivery Charge (Rs 200)' and 'Delivery Charge (Rs 250)' (DHA Phase 6 and
 * DHA Phase 8 on the released list), one of the shop's own riders and a
 * shift opened at 18:00.
 */
async function till(deviceId: string = TILL_A): Promise<Shop> {
  const db = openTill(deviceId);
  const actor = { userId: 'u_mgr', deviceId };
  const { createTaxCategory } = await import('./repositories/tax-category-repo.js');
  const { createCategory } = await import('./repositories/category-repo.js');
  const { createMenuItem } = await import('./repositories/menu-item-repo.js');
  const { createRider } = await import('./repositories/rider-repo.js');
  const { openShift } = await import('./repositories/shift-repo.js');
  at('18:00');
  const tax = createTaxCategory(db, { name: 'Test GST', rateBps: 1_500 }, actor);
  const food = createCategory(
    db,
    { name: 'Test Pizzas', displayOrder: 1, colorHex: '#aa5500' },
    actor,
  );
  const fees = createCategory(
    db,
    { name: 'Delivery Charges', displayOrder: 2, colorHex: '#555555' },
    actor,
  );
  const item = (categoryId: string, name: string, basePriceCents: number) =>
    createMenuItem(db, { categoryId, name, basePriceCents, taxCategoryId: tax.id }, actor).id;
  const pizza = item(food.id, 'Test Pizza', 100_000);
  const charge200 = item(fees.id, 'Delivery Charge (Rs 200)', 20_000);
  const charge250 = item(fees.id, 'Delivery Charge (Rs 250)', 25_000);
  const rider = createRider(db, { name: 'Test Own Rider', phone: '03001112222' }, actor).id;
  openShift(db, { openingCashCents: 0 }, actor);
  return { db, pizza, charge200, charge250, rider };
}

/** Where the first delivery is when the add-on is rung. */
type FirstAt =
  | 'open'
  | 'sent_to_kitchen'
  | 'paid_in_kitchen'
  | 'preparing'
  | 'ready'
  | 'out_for_delivery'
  | 'delivered'
  | 'paid'
  | 'void'
  | 'refunded';

/**
 * The first delivery #A for the made-up customer (`phone`, else PHONE) in
 * DHA Phase 6: started at 19:00 with the customer and address saved (its own
 * charge goes on), the pizza, then taken to `where` by 19:20.
 */
async function first(shop: Shop, where: FirstAt, opts: { phone?: string; deviceId?: string } = {}) {
  const r = await repo();
  const c = await customers();
  const who = { ...CASHIER, deviceId: opts.deviceId ?? TILL_A };
  const mgr = { ...MANAGER, deviceId: opts.deviceId ?? TILL_A };
  at('19:00');
  const o = r.createOrder(shop.db, { mode: 'delivery' }, who);
  const customer = c.createCustomer(
    shop.db,
    { name: 'Test Add-on Customer', phone: opts.phone ?? PHONE },
    who,
  );
  const address = c.createAddress(
    shop.db,
    { customerId: customer.id, addressLine: 'House 12, Test Lane', area: AREA },
    who,
  );
  c.snapshotCustomerOntoOrder(
    shop.db,
    { orderId: o.id, customerId: customer.id, addressId: address.id },
    who,
  );
  r.addOrderItem(
    shop.db,
    { orderId: o.id, menuItemId: shop.pizza, quantity: 1, modifierIds: [] },
    who,
  );
  expect(charges(shop.db, o.id)).toEqual([['Delivery Charge (Rs 200)', 20_000, 1]]);
  if (where === 'open') return { id: o.id, orderNumber: o.orderNumber as string };
  const prepaid = where === 'paid_in_kitchen' || where === 'paid' || where === 'refunded';
  at('19:10');
  if (prepaid) {
    const total = r.findOrder(shop.db, o.id)!.totalCents as number;
    r.tenderOrder(
      shop.db,
      { orderId: o.id, payments: [{ method: 'cash', amountCents: total, tenderedCents: total }] },
      who,
    );
  } else {
    r.sendOrderToKitchen(shop.db, o.id, who);
  }
  at('19:20');
  if (where === 'preparing') r.markOrderPreparing(shop.db, o.id, who);
  if (
    where === 'ready' ||
    where === 'out_for_delivery' ||
    where === 'delivered' ||
    where === 'paid'
  )
    r.markOrderReady(shop.db, o.id, who);
  if (where === 'out_for_delivery') r.sendOutOrder(shop.db, o.id, who);
  if (where === 'delivered' || where === 'paid') {
    r.assignRiderToOrder(shop.db, o.id, shop.rider, who);
    r.markOrderDelivered(shop.db, { orderId: o.id }, who);
  }
  if (where === 'void') {
    r.voidOrder(
      shop.db,
      {
        orderId: o.id,
        reason: 'Customer changed order',
        approverUserId: mgr.userId,
        foodMade: 'not_made',
      },
      mgr,
    );
  }
  if (where === 'refunded') {
    r.refundOrder(
      shop.db,
      {
        orderId: o.id,
        reason: 'Customer changed order',
        approverUserId: mgr.userId,
        foodMade: 'not_made',
      },
      mgr,
    );
  }
  const status = where === 'paid_in_kitchen' ? 'sent_to_kitchen' : where;
  expect(r.findOrder(shop.db, o.id)?.status).toBe(status);
  return { id: o.id, orderNumber: o.orderNumber as string };
}

/** A new counter Delivery cart at 19:40 with the pizza; its area told by the panel with `phone` (the add-on). */
async function addOn(
  shop: Shop,
  phone: string | null,
  opts: { deviceId?: string; area?: string } = {},
) {
  const r = await repo();
  const who = { ...CASHIER, deviceId: opts.deviceId ?? TILL_A };
  at('19:40');
  const o = r.createOrder(shop.db, { mode: 'delivery' }, who);
  r.addOrderItem(
    shop.db,
    { orderId: o.id, menuItemId: shop.pizza, quantity: 1, modifierIds: [] },
    who,
  );
  r.syncOrderDeliveryCharge(shop.db, o.id, opts.area ?? AREA, who, { phone });
  return o.id;
}

/** The order's live delivery charge lines: [name, price, quantity]. */
function charges(db: AppDatabase, orderId: string): Array<[string, number, number]> {
  return (
    db
      .prepare(
        `SELECT menu_item_name, unit_price_cents, quantity FROM order_items
          WHERE order_id = ? AND deleted_at IS NULL AND menu_item_name LIKE 'Delivery Charge%' ORDER BY created_at, id`,
      )
      .all(orderId) as Row[]
  ).map((l) => [String(l['menu_item_name']), Number(l['unit_price_cents']), Number(l['quantity'])]);
}

/** The order's last 'delivery_area' audit row, parsed. */
function lastAreaAudit(db: AppDatabase, orderId: string): { before: Row; after: Row } | null {
  const row = db
    .prepare(
      `SELECT before_json, after_json FROM audit_log
        WHERE entity_type = 'orders' AND entity_id = ? AND action = 'delivery_area' ORDER BY rowid DESC LIMIT 1`,
    )
    .get(orderId) as Row | undefined;
  if (!row) return null;
  return {
    before: JSON.parse(String(row['before_json'])) as Row,
    after: JSON.parse(String(row['after_json'])) as Row,
  };
}

const count = (db: AppDatabase, table: string) =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
const totalOf = (db: AppDatabase, orderId: string) =>
  Number(
    (
      db.prepare(`SELECT total_cents FROM orders WHERE id = ?`).get(orderId) as {
        total_cents: number;
      }
    ).total_cents,
  );
const lineIds = (db: AppDatabase, orderId: string, deleted: boolean) =>
  (
    db
      .prepare(
        `SELECT id FROM order_items WHERE order_id = ? AND menu_item_name LIKE 'Delivery Charge%' AND deleted_at IS ${deleted ? 'NOT ' : ''}NULL`,
      )
      .all(orderId) as Row[]
  ).map((l) => String(l['id']));

/** The sync rows and audit rows written after `sinceSync` / `sinceAudit` rows. */
function writtenAfter(db: AppDatabase, sinceSync: number, sinceAudit: number) {
  const sync = (
    db.prepare(`SELECT entity_type, entity_id, op FROM sync_queue ORDER BY rowid`).all() as Row[]
  )
    .slice(sinceSync)
    .map((q) => ({ entityType: q['entity_type'], entityId: q['entity_id'], op: q['op'] }));
  const audit = (
    db.prepare(`SELECT entity_type, entity_id, action FROM audit_log ORDER BY rowid`).all() as Row[]
  )
    .slice(sinceAudit)
    .map((a) => ({ entityType: a['entity_type'], entityId: a['entity_id'], action: a['action'] }));
  return { sync, audit };
}

/** deliveryChargeForArea's 'phone' event, inside its own transaction as its callers run it. */
async function phoneEvent(db: AppDatabase, orderId: string, deviceId: string = TILL_A) {
  const r = await repo();
  return db.transaction(() =>
    r.deliveryChargeForArea(db, orderId, null, 'phone', { ...CASHIER, deviceId }),
  )();
}

/** Pizza Rs 1,000 + 15%: the add-on's bill with no delivery charge. */
const FOOD_ONLY = 115_000;
/** With Delivery Charge (Rs 200) at 15%. */
const WITH_CHARGE = 138_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

live(
  'the first delivery is still in the shop: the add-on goes with it, no second delivery charge',
  () => {
    const inTheShop: FirstAt[] = ['sent_to_kitchen', 'paid_in_kitchen', 'preparing', 'ready'];
    for (const where of inTheShop) {
      for (const typed of ['03001234567', '+92 300 1234567']) {
        it(`#A ${where.replace(/_/g, ' ')}, the add-on typed '${typed}': no 'Delivery Charge (Rs 200)', goesWith #A, charged 'add_on_off'`, async () => {
          const shop = await till();
          const a = await first(shop, where);
          const id = await addOn(shop, typed);
          expect(charges(shop.db, id)).toEqual([]);
          expect(totalOf(shop.db, id)).toBe(FOOD_ONLY);
          expect(lastAreaAudit(shop.db, id)).toEqual({
            before: { area: null, goesWith: null, charged: null },
            after: {
              area: AREA,
              event: 'area',
              mode: 'delivery',
              target: 'fee',
              feeCents: 20_000,
              added: null,
              removed: 0,
              goesWith: { orderId: a.id, orderNumber: a.orderNumber },
              charged: 'add_on_off',
            },
          });
          // #A keeps its own charge: only the second trip's is left off.
          expect(charges(shop.db, a.id)).toEqual([['Delivery Charge (Rs 200)', 20_000, 1]]);
        });
      }
    }

    it('the phone saved on the order after the area (the customer save): the charge already on comes off, the line removal synced and audited', async () => {
      const shop = await till();
      const r = await repo();
      const c = await customers();
      const a = await first(shop, 'ready');
      // The panel told the area with no phone yet: charged.
      const id = await addOn(shop, null);
      expect(charges(shop.db, id)).toEqual([['Delivery Charge (Rs 200)', 20_000, 1]]);
      expect(lastAreaAudit(shop.db, id)?.after).toMatchObject({
        goesWith: null,
        charged: 'normal',
        added: shop.charge200,
      });
      const [line] = lineIds(shop.db, id, false);
      const sync0 = count(shop.db, 'sync_queue');
      const audit0 = count(shop.db, 'audit_log');

      // The customer typed again with the same phone and address (the same area): goes with #A.
      const customer = c.createCustomer(
        shop.db,
        { name: 'Test Add-on Customer', phone: '03001234567' },
        CASHIER,
      );
      const address = c.createAddress(
        shop.db,
        { customerId: customer.id, addressLine: 'House 12, Test Lane', area: AREA },
        CASHIER,
      );
      c.snapshotCustomerOntoOrder(
        shop.db,
        { orderId: id, customerId: customer.id, addressId: address.id },
        CASHIER,
      );

      expect(charges(shop.db, id)).toEqual([]);
      expect(lineIds(shop.db, id, true)).toEqual([line]);
      expect(totalOf(shop.db, id)).toBe(FOOD_ONLY);
      expect(lastAreaAudit(shop.db, id)?.after).toMatchObject({
        event: 'area',
        removed: 1,
        added: null,
        goesWith: { orderId: a.id, orderNumber: a.orderNumber },
        charged: 'add_on_off',
      });
      const written = writtenAfter(shop.db, sync0, audit0);
      expect(written.sync).toContainEqual({
        entityType: 'order_items',
        entityId: line,
        op: 'delete',
      });
      expect(written.sync).toContainEqual(
        expect.objectContaining({ entityType: 'orders', entityId: id }),
      );
      expect(written.audit).toContainEqual({
        entityType: 'order_items',
        entityId: line,
        action: 'delete',
      });
      expect(written.audit.filter((x) => x.action === 'delivery_area')).toEqual([
        { entityType: 'orders', entityId: id, action: 'delivery_area' },
      ]);
      expect(r.findOrder(shop.db, id)?.status).toBe('open');
    });

    it('the area changed while #A is still in the kitchen (DHA Phase 8, Rs 250): still no charge', async () => {
      const shop = await till();
      const r = await repo();
      const a = await first(shop, 'sent_to_kitchen');
      const id = await addOn(shop, '03001234567');
      r.syncOrderDeliveryCharge(shop.db, id, 'DHA Phase 8', CASHIER, { phone: '03001234567' });
      expect(charges(shop.db, id)).toEqual([]);
      expect(lastAreaAudit(shop.db, id)?.after).toMatchObject({
        area: 'DHA Phase 8',
        feeCents: 25_000,
        goesWith: { orderId: a.id },
        charged: 'add_on_off',
      });
    });

    it('becoming a Delivery (a takeaway with the phone and area): the charge stays off', async () => {
      const shop = await till();
      const r = await repo();
      const a = await first(shop, 'preparing');
      at('19:40');
      const o = r.createOrder(shop.db, { mode: 'takeaway' }, CASHIER);
      r.addOrderItem(
        shop.db,
        { orderId: o.id, menuItemId: shop.pizza, quantity: 1, modifierIds: [] },
        CASHIER,
      );
      r.syncOrderDeliveryCharge(shop.db, o.id, AREA, CASHIER, { phone: '03001234567' });
      expect(lastAreaAudit(shop.db, o.id)?.after).toMatchObject({
        mode: 'takeaway',
        goesWith: null,
        charged: 'normal',
      });
      // The customer's phone is on the order before it becomes a delivery (Pay's or Send's save).
      const c = await customers();
      const customer = c.createCustomer(
        shop.db,
        { name: 'Test Add-on Customer', phone: '03001234567' },
        CASHIER,
      );
      c.snapshotCustomerOntoOrder(
        shop.db,
        { orderId: o.id, customerId: customer.id, addressId: null },
        CASHIER,
      );
      r.setOrderMode(shop.db, o.id, 'delivery', CASHIER);
      expect(charges(shop.db, o.id)).toEqual([]);
      expect(lastAreaAudit(shop.db, o.id)?.after).toMatchObject({
        event: 'mode',
        goesWith: { orderId: a.id },
        charged: 'add_on_off',
      });
    });
  },
);

live('a new trip: charged as usual', () => {
  const newTrip: FirstAt[] = ['out_for_delivery', 'delivered', 'paid', 'void', 'refunded', 'open'];
  for (const where of newTrip) {
    it(`#A ${where === 'open' ? 'still a cart' : where.replace(/_/g, ' ')}: the add-on pays its own Delivery Charge (Rs 200)`, async () => {
      const shop = await till();
      await first(shop, where);
      const id = await addOn(shop, '03001234567');
      expect(charges(shop.db, id)).toEqual([['Delivery Charge (Rs 200)', 20_000, 1]]);
      expect(totalOf(shop.db, id)).toBe(WITH_CHARGE);
      expect(lastAreaAudit(shop.db, id)?.after).toMatchObject({
        target: 'fee',
        added: shop.charge200,
        goesWith: null,
        charged: 'normal',
      });
    });
  }

  it('another phone, no phone, or a number that is not a Pakistani phone: charged', async () => {
    const shop = await till();
    await first(shop, 'ready');
    for (const phone of ['0301 7654321', null, '']) {
      const id = await addOn(shop, phone);
      expect(charges(shop.db, id)).toEqual([['Delivery Charge (Rs 200)', 20_000, 1]]);
    }
    // A customer saved with '12345' (not a Pakistani number) never matches another '12345'.
    const odd = await till();
    await first(odd, 'ready', { phone: '12345' });
    const id = await addOn(odd, '12345');
    expect(charges(odd.db, id)).toEqual([['Delivery Charge (Rs 200)', 20_000, 1]]);
  });
});

live("'Put it back', a changed phone, and #A going out", () => {
  it("'Put it back' charges it and it stays charged: the area again (in other words), a 'phone' event, Takeaway and back to Delivery", async () => {
    const shop = await till();
    const r = await repo();
    const a = await first(shop, 'ready');
    const id = await addOn(shop, '03001234567');
    expect(charges(shop.db, id)).toEqual([]);

    r.syncOrderDeliveryCharge(shop.db, id, AREA, CASHIER, { putBack: true, phone: '03001234567' });
    expect(charges(shop.db, id)).toEqual([['Delivery Charge (Rs 200)', 20_000, 1]]);
    expect(lastAreaAudit(shop.db, id)?.after).toMatchObject({
      event: 'put_back',
      added: shop.charge200,
      goesWith: { orderId: a.id, orderNumber: a.orderNumber },
      charged: 'put_back',
    });

    const areaRows = () => count(shop.db, "audit_log WHERE action = 'delivery_area'");
    const rows0 = areaRows();
    r.syncOrderDeliveryCharge(shop.db, id, AREA, CASHIER, { phone: '03001234567' });
    r.syncOrderDeliveryCharge(shop.db, id, 'Phase 6, DHA', CASHIER, { phone: '+92 300 1234567' });
    // The customer saved on the order (Send's or Pay's save), then its 'phone' event.
    const c = await customers();
    const customer = c.createCustomer(
      shop.db,
      { name: 'Test Add-on Customer', phone: '03001234567' },
      CASHIER,
    );
    c.snapshotCustomerOntoOrder(
      shop.db,
      { orderId: id, customerId: customer.id, addressId: null },
      CASHIER,
    );
    await phoneEvent(shop.db, id);
    expect(charges(shop.db, id)).toEqual([['Delivery Charge (Rs 200)', 20_000, 1]]);
    expect(areaRows()).toBe(rows0);

    // Takeaway takes its charge off; back to Delivery puts it on again (the put-back holds).
    r.setOrderMode(shop.db, id, 'takeaway', CASHIER);
    expect(charges(shop.db, id)).toEqual([]);
    r.setOrderMode(shop.db, id, 'delivery', CASHIER);
    expect(charges(shop.db, id)).toEqual([['Delivery Charge (Rs 200)', 20_000, 1]]);
    expect(lastAreaAudit(shop.db, id)?.after).toMatchObject({
      event: 'mode',
      goesWith: { orderId: a.id },
      charged: 'put_back',
    });
  });

  it('the phone changed to another: the charge comes back; changed back: off again', async () => {
    const shop = await till();
    const r = await repo();
    const a = await first(shop, 'sent_to_kitchen');
    const id = await addOn(shop, '03001234567');
    expect(charges(shop.db, id)).toEqual([]);

    r.syncOrderDeliveryCharge(shop.db, id, AREA, CASHIER, { phone: '0301 7654321' });
    expect(charges(shop.db, id)).toEqual([['Delivery Charge (Rs 200)', 20_000, 1]]);
    expect(lastAreaAudit(shop.db, id)).toMatchObject({
      before: { area: AREA, goesWith: { orderId: a.id }, charged: 'add_on_off' },
      after: { event: 'area', added: shop.charge200, goesWith: null, charged: 'normal' },
    });

    r.syncOrderDeliveryCharge(shop.db, id, AREA, CASHIER, { phone: '03001234567' });
    expect(charges(shop.db, id)).toEqual([]);
    expect(lastAreaAudit(shop.db, id)?.after).toMatchObject({
      removed: 1,
      goesWith: { orderId: a.id },
      charged: 'add_on_off',
    });
  });

  it('#A goes out before the next event: the charge goes on (a new trip); the same with the panel asking again', async () => {
    const shop = await till();
    const r = await repo();
    const a = await first(shop, 'ready');
    const id = await addOn(shop, '03001234567');
    const c = await customers();
    const customer = c.createCustomer(
      shop.db,
      { name: 'Test Add-on Customer', phone: '03001234567' },
      CASHIER,
    );
    c.snapshotCustomerOntoOrder(
      shop.db,
      { orderId: id, customerId: customer.id, addressId: null },
      CASHIER,
    );
    expect(charges(shop.db, id)).toEqual([]);

    at('19:50');
    r.sendOutOrder(shop.db, a.id, CASHIER);
    await phoneEvent(shop.db, id);
    expect(charges(shop.db, id)).toEqual([['Delivery Charge (Rs 200)', 20_000, 1]]);
    expect(totalOf(shop.db, id)).toBe(WITH_CHARGE);
    expect(lastAreaAudit(shop.db, id)).toMatchObject({
      before: { area: AREA, goesWith: { orderId: a.id }, charged: 'add_on_off' },
      after: {
        area: AREA,
        event: 'phone',
        added: shop.charge200,
        goesWith: null,
        charged: 'normal',
      },
    });

    // Another add-on whose first went out: the panel's next ask (same area, same phone) charges it.
    const shop2 = await till();
    const a2 = await first(shop2, 'preparing');
    const id2 = await addOn(shop2, '03001234567');
    expect(charges(shop2.db, id2)).toEqual([]);
    r.markOrderReady(shop2.db, a2.id, CASHIER);
    r.sendOutOrder(shop2.db, a2.id, CASHIER);
    r.syncOrderDeliveryCharge(shop2.db, id2, AREA, CASHIER, { phone: '03001234567' });
    expect(charges(shop2.db, id2)).toEqual([['Delivery Charge (Rs 200)', 20_000, 1]]);
  });

  it("a 'phone' event that goes with the same delivery (or still none) writes nothing", async () => {
    const shop = await till();
    const r = await repo();
    await first(shop, 'ready');
    const id = await addOn(shop, '03001234567');
    const c = await customers();
    const customer = c.createCustomer(
      shop.db,
      { name: 'Test Add-on Customer', phone: '03001234567' },
      CASHIER,
    );
    c.snapshotCustomerOntoOrder(
      shop.db,
      { orderId: id, customerId: customer.id, addressId: null },
      CASHIER,
    );
    const ledger = () => ({
      sync: count(shop.db, 'sync_queue'),
      audit: count(shop.db, 'audit_log'),
      lines: count(shop.db, 'order_items'),
      version: (shop.db.prepare(`SELECT version FROM orders WHERE id = ?`).get(id) as Row)[
        'version'
      ],
    });
    const before = ledger();
    expect(await phoneEvent(shop.db, id)).toEqual({ added: null, removed: 0 });
    expect(ledger()).toEqual(before);

    // A delivery with no live delivery to go with: still nothing.
    const other = await addOn(shop, '0301 7654321');
    const before2 = ledger();
    await phoneEvent(shop.db, other);
    expect(ledger()).toEqual(before2);
    // A takeaway: nothing.
    at('19:40');
    const take = r.createOrder(shop.db, { mode: 'takeaway' }, CASHIER);
    c.snapshotCustomerOntoOrder(
      shop.db,
      { orderId: take.id, customerId: customer.id, addressId: null },
      CASHIER,
    );
    const before3 = ledger();
    await phoneEvent(shop.db, take.id);
    expect(ledger()).toEqual(before3);
  });
});

live('two tills and the website', () => {
  it('#A rung on the other till (its synced row) counts; once it goes out there, the next event here charges', async () => {
    const a = await till(TILL_A);
    const b = openTill(TILL_B, { usersFrom: TILL_A });
    const r = await repo();
    const first1 = await first(a, 'sent_to_kitchen');
    await push(a.db, TILL_A, b);

    const shopB: Shop = { ...a, db: b };
    const id = await addOn(shopB, '+92 300 1234567', { deviceId: TILL_B });
    expect(charges(b, id)).toEqual([]);
    expect(lastAreaAudit(b, id)?.after).toMatchObject({
      goesWith: { orderId: first1.id, orderNumber: first1.orderNumber },
      charged: 'add_on_off',
    });

    at('19:50');
    r.markOrderReady(a.db, first1.id, CASHIER);
    r.sendOutOrder(a.db, first1.id, CASHIER);
    await push(a.db, TILL_A, b);
    r.syncOrderDeliveryCharge(
      b,
      id,
      AREA,
      { ...CASHIER, deviceId: TILL_B },
      { phone: '+92 300 1234567' },
    );
    expect(charges(b, id)).toEqual([['Delivery Charge (Rs 200)', 20_000, 1]]);
  });

  it('a website order is never touched; one still in the kitchen is a first delivery too', async () => {
    const shop = await till();
    const r = await repo();
    const c = await customers();
    const customer = c.createCustomer(
      shop.db,
      { name: 'Test Web Customer', phone: PHONE },
      CASHIER,
    );
    const address = c.createAddress(
      shop.db,
      { customerId: customer.id, addressLine: 'Flat 3, Test Road', area: AREA },
      CASHIER,
    );
    at('19:00');
    const web = r.createOrder(shop.db, { mode: 'delivery', source: 'web' }, CASHIER);
    r.addOrderItem(
      shop.db,
      { orderId: web.id, menuItemId: shop.pizza, quantity: 1, modifierIds: [] },
      CASHIER,
    );
    r.addOrderItem(
      shop.db,
      { orderId: web.id, menuItemId: shop.charge200, quantity: 1, modifierIds: [] },
      CASHIER,
    );
    c.snapshotCustomerOntoOrder(
      shop.db,
      { orderId: web.id, customerId: customer.id, addressId: address.id },
      CASHIER,
    );
    at('19:10');
    r.sendOrderToKitchen(shop.db, web.id, CASHIER);

    // A second website order for the same phone: its fee line is its own, whatever the till is told.
    at('19:30');
    const web2 = r.createOrder(shop.db, { mode: 'delivery', source: 'web' }, CASHIER);
    r.addOrderItem(
      shop.db,
      { orderId: web2.id, menuItemId: shop.pizza, quantity: 1, modifierIds: [] },
      CASHIER,
    );
    r.addOrderItem(
      shop.db,
      { orderId: web2.id, menuItemId: shop.charge200, quantity: 1, modifierIds: [] },
      CASHIER,
    );
    const sync0 = count(shop.db, 'sync_queue');
    const audit0 = count(shop.db, 'audit_log');
    c.snapshotCustomerOntoOrder(
      shop.db,
      { orderId: web2.id, customerId: customer.id, addressId: address.id },
      CASHIER,
    );
    r.syncOrderDeliveryCharge(shop.db, web2.id, AREA, CASHIER, { phone: PHONE });
    await phoneEvent(shop.db, web2.id);
    expect(charges(shop.db, web2.id)).toEqual([['Delivery Charge (Rs 200)', 20_000, 1]]);
    expect(lastAreaAudit(shop.db, web2.id)).toBeNull();
    // Only the customer save itself was written (its row, sync and audit).
    expect(writtenAfter(shop.db, sync0, audit0).audit.map((x) => x.action)).toEqual([
      'attach_customer',
    ]);

    // A counter add-on for the same phone goes with the website order still in the kitchen.
    const id = await addOn(shop, '03001234567');
    expect(charges(shop.db, id)).toEqual([]);
    expect(lastAreaAudit(shop.db, id)?.after).toMatchObject({
      goesWith: { orderId: web.id, orderNumber: web.orderNumber },
      charged: 'add_on_off',
    });
  });
});

// ---------------------------------------------------------------------------
// 18-10b: the add-on rule wired to the phone.
// ---------------------------------------------------------------------------

/**
 * Send's or Pay's customer save (snapshotCustomerOntoOrder, as
 * customers:attachToOrder runs it): the made-up customer with `phone`, and an
 * address in `area` when given (none: the area the panel told stays).
 */
async function saveCustomer(shop: Shop, orderId: string, phone: string, area?: string) {
  const c = await customers();
  const customer = c.createCustomer(shop.db, { name: 'Test Add-on Customer', phone }, CASHIER);
  const address = area
    ? c.createAddress(
        shop.db,
        { customerId: customer.id, addressLine: 'House 12, Test Lane', area },
        CASHIER,
      )
    : null;
  c.snapshotCustomerOntoOrder(
    shop.db,
    { orderId, customerId: customer.id, addressId: address ? address.id : null },
    CASHIER,
  );
  return customer.id;
}

const areaRows = (db: AppDatabase) => count(db, "audit_log WHERE action = 'delivery_area'");
const keeps = (db: AppDatabase, orderId: string) =>
  (db.prepare(`SELECT rider_keeps_cents FROM orders WHERE id = ?`).get(orderId) as Row)[
    'rider_keeps_cents'
  ];
const goesWith = (o: { id: string; orderNumber: string }) => ({
  orderId: o.id,
  orderNumber: o.orderNumber,
});
const CHARGE_200: Array<[string, number, number]> = [['Delivery Charge (Rs 200)', 20_000, 1]];

type Outcome = { ok: true; data: unknown } | { ok: false; code: string; message: string };

/** The orders and customers handlers on this till, a cashier signed in; `call` runs one as the IPC would. */
async function tillIpc(shop: Shop) {
  h.handlers.clear();
  const ctx = { db: shop.db, deviceId: TILL_A } as never;
  (await import('../ipc/handlers/orders-handlers.js')).registerOrdersHandlers(ctx);
  (await import('../ipc/handlers/customers-handlers.js')).registerCustomersHandlers(ctx);
  h.session = {
    id: CASHIER.userId as UUID,
    fullName: 'Test Cashier',
    role: 'cashier',
    sessionId: 'sess' as UUID,
  };
  return async (channel: string, payload: unknown): Promise<Outcome> => {
    const fn = h.handlers.get(channel);
    if (!fn) throw new Error(`No handler for ${channel}`);
    try {
      const r = (await fn({ db: shop.db, deviceId: TILL_A }, payload)) as
        | { ok: true; data: unknown }
        | { ok: false; error: { code: string; message: string } };
      return r.ok
        ? { ok: true, data: r.data }
        : { ok: false, code: r.error.code, message: r.error.message };
    } catch (e) {
      const api = (e as { apiError?: { code: string; message: string } }).apiError;
      if (api) return { ok: false, code: api.code, message: api.message };
      throw e;
    }
  };
}

/** A new counter cart at 19:40 with the pizza (a Delivery unless asked), nothing told yet. */
async function cart(shop: Shop, mode: 'delivery' | 'takeaway' = 'delivery') {
  const r = await repo();
  at('19:40');
  const o = r.createOrder(shop.db, { mode }, CASHIER);
  r.addOrderItem(
    shop.db,
    { orderId: o.id, menuItemId: shop.pizza, quantity: 1, modifierIds: [] },
    CASHIER,
  );
  return o.id;
}

live("Send's and Pay's customer save, and taking the customer off (18-10b)", () => {
  it("Send's save with no address (the panel told the area before any phone): the charge comes off while #A is in the kitchen, and the order is sent without it", async () => {
    const shop = await till();
    const r = await repo();
    const a = await first(shop, 'sent_to_kitchen');
    const id = await addOn(shop, null);
    expect(charges(shop.db, id)).toEqual(CHARGE_200);
    expect(r.getOrderSnapshot(shop.db, id)?.addOnTo).toBeNull();
    const [line] = lineIds(shop.db, id, false);
    const sync0 = count(shop.db, 'sync_queue');
    const audit0 = count(shop.db, 'audit_log');

    await saveCustomer(shop, id, '03001234567');

    expect(charges(shop.db, id)).toEqual([]);
    expect(lineIds(shop.db, id, true)).toEqual([line]);
    expect(totalOf(shop.db, id)).toBe(FOOD_ONLY);
    expect(lastAreaAudit(shop.db, id)).toEqual({
      before: { area: AREA, goesWith: null, charged: 'normal' },
      after: {
        area: AREA,
        event: 'phone',
        mode: 'delivery',
        target: 'fee',
        feeCents: 20_000,
        added: null,
        removed: 1,
        goesWith: goesWith(a),
        charged: 'add_on_off',
      },
    });
    // In the save's own transaction: the customer, the line taken off (synced and audited), one area row.
    const written = writtenAfter(shop.db, sync0, audit0);
    expect(written.sync).toContainEqual({ entityType: 'order_items', entityId: line, op: 'delete' });
    expect(written.audit).toContainEqual({
      entityType: 'order_items',
      entityId: line,
      action: 'delete',
    });
    expect(written.audit.filter((x) => x.action === 'attach_customer')).toHaveLength(1);
    expect(written.audit.filter((x) => x.action === 'delivery_area')).toHaveLength(1);
    expect(r.getOrderSnapshot(shop.db, id)?.addOnTo).toEqual(goesWith(a));

    // Send: the kitchen gets it with no second delivery charge.
    r.sendOrderToKitchen(shop.db, id, CASHIER);
    expect(r.findOrder(shop.db, id)).toMatchObject({
      status: 'sent_to_kitchen',
      totalCents: FOOD_ONLY,
    });
    expect(charges(shop.db, id)).toEqual([]);
  });

  it("Send's save when #A went out first: the charge goes back on before the order is sent (a new trip); #A out before the cart was rung, nothing to settle", async () => {
    const shop = await till();
    const r = await repo();
    const a = await first(shop, 'ready');
    const id = await addOn(shop, '03001234567');
    expect(charges(shop.db, id)).toEqual([]);
    at('19:50');
    r.sendOutOrder(shop.db, a.id, CASHIER);
    // Until the next event the cart reads what the main process last settled.
    expect(r.getOrderSnapshot(shop.db, id)?.addOnTo).toEqual(goesWith(a));

    await saveCustomer(shop, id, '03001234567');
    expect(charges(shop.db, id)).toEqual(CHARGE_200);
    expect(lastAreaAudit(shop.db, id)).toMatchObject({
      before: { area: AREA, goesWith: { orderId: a.id }, charged: 'add_on_off' },
      after: {
        area: AREA,
        event: 'phone',
        added: shop.charge200,
        removed: 0,
        goesWith: null,
        charged: 'normal',
      },
    });
    expect(r.getOrderSnapshot(shop.db, id)?.addOnTo).toBeNull();
    r.sendOrderToKitchen(shop.db, id, CASHIER);
    expect(r.findOrder(shop.db, id)?.totalCents).toBe(WITH_CHARGE);

    // #A already out when the cart was rung: charged from the start; the save writes no area row.
    const shop2 = await till();
    await first(shop2, 'out_for_delivery');
    const id2 = await addOn(shop2, null);
    const rows0 = areaRows(shop2.db);
    await saveCustomer(shop2, id2, '03001234567');
    expect(charges(shop2.db, id2)).toEqual(CHARGE_200);
    expect(areaRows(shop2.db)).toBe(rows0);
  });

  it("Pay's save (with the address) does the same: paid with no second charge while #A is in the kitchen; with its charge once #A is out", async () => {
    const shop = await till();
    const r = await repo();
    const a = await first(shop, 'preparing');
    const id = await addOn(shop, null);
    expect(charges(shop.db, id)).toEqual(CHARGE_200);
    await saveCustomer(shop, id, '+92 300 1234567', AREA);
    expect(charges(shop.db, id)).toEqual([]);
    expect(lastAreaAudit(shop.db, id)?.after).toMatchObject({
      goesWith: goesWith(a),
      charged: 'add_on_off',
    });
    r.tenderOrder(
      shop.db,
      {
        orderId: id,
        payments: [{ method: 'cash', amountCents: FOOD_ONLY, tenderedCents: FOOD_ONLY }],
      },
      CASHIER,
    );
    expect(r.findOrder(shop.db, id)).toMatchObject({
      status: 'sent_to_kitchen',
      totalCents: FOOD_ONLY,
    });
    expect(charges(shop.db, id)).toEqual([]);

    // #A out before Pay: the save puts the charge on, so the payment takes the bill with it.
    const shop2 = await till();
    const a2 = await first(shop2, 'ready');
    const id2 = await addOn(shop2, '03001234567');
    expect(charges(shop2.db, id2)).toEqual([]);
    at('19:50');
    r.sendOutOrder(shop2.db, a2.id, CASHIER);
    await saveCustomer(shop2, id2, '03001234567', AREA);
    expect(charges(shop2.db, id2)).toEqual(CHARGE_200);
    r.tenderOrder(
      shop2.db,
      {
        orderId: id2,
        payments: [{ method: 'cash', amountCents: WITH_CHARGE, tenderedCents: WITH_CHARGE }],
      },
      CASHIER,
    );
    expect(r.findOrder(shop2.db, id2)).toMatchObject({
      status: 'sent_to_kitchen',
      totalCents: WITH_CHARGE,
    });
  });

  it('taking the customer off (detachCustomerFromOrder): the add-on is cleared with the address (no area, no charge), and the next area told charges it', async () => {
    const shop = await till();
    const r = await repo();
    const c = await customers();
    const a = await first(shop, 'ready');
    const id = await addOn(shop, '03001234567');
    await saveCustomer(shop, id, '03001234567');
    expect(charges(shop.db, id)).toEqual([]);
    expect(r.getOrderSnapshot(shop.db, id)?.addOnTo).toEqual(goesWith(a));
    const rows0 = areaRows(shop.db);

    c.detachCustomerFromOrder(shop.db, id, CASHIER);
    expect(charges(shop.db, id)).toEqual([]);
    expect(lastAreaAudit(shop.db, id)).toMatchObject({
      before: { area: AREA, goesWith: goesWith(a), charged: 'add_on_off' },
      after: {
        area: null,
        event: 'area',
        added: null,
        removed: 0,
        goesWith: null,
        charged: 'normal',
      },
    });
    // One row: the 'phone' call after it finds nothing more to settle.
    expect(areaRows(shop.db)).toBe(rows0 + 1);
    const s = r.getOrderSnapshot(shop.db, id);
    expect(s?.customerPhone).toBeNull();
    expect(s?.addOnTo).toBeNull();

    // The panel tells the area again with no phone: a delivery like any other, charged.
    r.syncOrderDeliveryCharge(shop.db, id, AREA, CASHIER, { phone: null });
    expect(charges(shop.db, id)).toEqual(CHARGE_200);
    expect(lastAreaAudit(shop.db, id)?.after).toMatchObject({
      event: 'area',
      added: shop.charge200,
      goesWith: null,
      charged: 'normal',
    });
  });

  it('the add-on sent out freezes rider_keeps_cents 0 while #A keeps Rs 200; paid first, no payout and no drawer for it', async () => {
    const shop = await till();
    const r = await repo();
    const a = await first(shop, 'ready');
    // Two add-ons of the same customer, both going with #A: one sent unpaid, one paid at Pay.
    const unpaid = await addOn(shop, '03001234567');
    await saveCustomer(shop, unpaid, '03001234567', AREA);
    r.sendOrderToKitchen(shop.db, unpaid, CASHIER);
    const paid = await addOn(shop, '03001234567');
    await saveCustomer(shop, paid, '03001234567', AREA);
    r.tenderOrder(
      shop.db,
      {
        orderId: paid,
        payments: [{ method: 'cash', amountCents: FOOD_ONLY, tenderedCents: FOOD_ONLY }],
      },
      CASHIER,
    );
    for (const id of [unpaid, paid]) {
      expect(charges(shop.db, id)).toEqual([]);
      expect(lastAreaAudit(shop.db, id)?.after).toMatchObject({
        goesWith: goesWith(a),
        charged: 'add_on_off',
      });
      r.markOrderReady(shop.db, id, CASHIER);
    }

    at('19:50');
    r.sendOutOrder(shop.db, a.id, CASHIER);
    const sentUnpaid = r.sendOutOrder(shop.db, unpaid, CASHIER);
    const sentPaid = r.sendOutOrder(shop.db, paid, CASHIER);
    expect(keeps(shop.db, a.id)).toBe(20_000);
    expect(keeps(shop.db, unpaid)).toBe(0);
    expect(keeps(shop.db, paid)).toBe(0);
    expect(sentUnpaid.drawerOpenId).toBeNull();
    expect(sentPaid.drawerOpenId).toBeNull();
    // Nothing paid out of the drawer to the rider for any of them yet (#A settles when he is back):
    // the only drawer rows are the cash sale's at Pay.
    expect(count(shop.db, 'cash_movements WHERE order_id IS NOT NULL')).toBe(0);
    expect(count(shop.db, "drawer_opens WHERE kind = 'payout'")).toBe(0);
  });
});

live('the snapshot says which delivery the add-on goes with (18-10b)', () => {
  it('addOnTo is #A only while the charge is left off for it: null with no area told, once put back, or for another phone', async () => {
    const shop = await till();
    const r = await repo();
    const a = await first(shop, 'sent_to_kitchen');
    const addOnTo = (id: string) => r.getOrderSnapshot(shop.db, id)?.addOnTo;

    // A delivery cart with no area told yet: null (present).
    const empty = await cart(shop);
    expect(r.getOrderSnapshot(shop.db, empty)).toHaveProperty('addOnTo', null);

    const id = await addOn(shop, '03001234567');
    expect(addOnTo(id)).toEqual(goesWith(a));

    r.syncOrderDeliveryCharge(shop.db, id, AREA, CASHIER, { putBack: true, phone: '03001234567' });
    expect(charges(shop.db, id)).toEqual(CHARGE_200);
    expect(addOnTo(id)).toBeNull();

    // Another phone: no delivery to go with (the put-back charge stays on).
    r.syncOrderDeliveryCharge(shop.db, id, AREA, CASHIER, { phone: '0301 7654321' });
    expect(charges(shop.db, id)).toEqual(CHARGE_200);
    expect(addOnTo(id)).toBeNull();

    // #A's phone again: the charge comes off, and the snapshot names #A again.
    r.syncOrderDeliveryCharge(shop.db, id, AREA, CASHIER, { phone: '03001234567' });
    expect(charges(shop.db, id)).toEqual([]);
    expect(addOnTo(id)).toEqual(goesWith(a));

    // A delivery for another customer: charged, null.
    const other = await addOn(shop, '0301 7654321');
    expect(charges(shop.db, other)).toEqual(CHARGE_200);
    expect(addOnTo(other)).toBeNull();
  });

  it('only on an open counter delivery: none on a takeaway, on the add-on once sent, on #A itself or on a website cart', async () => {
    const shop = await till();
    const r = await repo();
    const a = await first(shop, 'ready');

    const take = await cart(shop, 'takeaway');
    r.syncOrderDeliveryCharge(shop.db, take, AREA, CASHIER, { phone: '03001234567' });
    expect(r.getOrderSnapshot(shop.db, take)).not.toHaveProperty('addOnTo');

    const id = await addOn(shop, '03001234567');
    expect(r.getOrderSnapshot(shop.db, id)?.addOnTo).toEqual(goesWith(a));
    r.sendOrderToKitchen(shop.db, id, CASHIER);
    expect(r.getOrderSnapshot(shop.db, id)).not.toHaveProperty('addOnTo');
    expect(r.getOrderSnapshot(shop.db, a.id)).not.toHaveProperty('addOnTo');

    at('19:40');
    const web = r.createOrder(shop.db, { mode: 'delivery', source: 'web' }, CASHIER);
    expect(r.getOrderSnapshot(shop.db, web.id)).not.toHaveProperty('addOnTo');
  });
});

live("'orders:setDeliveryArea' carries the panel's phone; 'customers:attachToOrder' answers with addOnTo (18-10b)", () => {
  it("the panel's phone, trimmed, links the add-on: the reply names #A and has no second charge; left out, null or blank, charged as usual", async () => {
    const shop = await till();
    const a = await first(shop, 'ready');
    const call = await tillIpc(shop);

    const id = await cart(shop);
    const typed = `${' '.repeat(10)}+92 300 1234567${' '.repeat(10)}`;
    expect(typed.length).toBeGreaterThan(30);
    const res = await call('orders:setDeliveryArea', { orderId: id, area: AREA, phone: typed });
    expect(res.ok).toBe(true);
    const s = (res as { ok: true; data: OrderSnapshot }).data;
    expect(s.addOnTo).toEqual(goesWith(a));
    expect(s.items.map((i) => i.menuItemName)).toEqual(['Test Pizza']);
    expect(s.order.totalCents).toBe(FOOD_ONLY);

    for (const phone of [undefined, null, '   ']) {
      const other = await cart(shop);
      const out = await call('orders:setDeliveryArea', {
        orderId: other,
        area: AREA,
        ...(phone === undefined ? {} : { phone }),
      });
      expect(out).toMatchObject({ ok: true, data: { addOnTo: null } });
      expect(charges(shop.db, other)).toEqual(CHARGE_200);
    }
  });

  it('a phone over 30 characters once trimmed, or one that is not text, is refused and nothing is written; 30 is taken', async () => {
    const shop = await till();
    await first(shop, 'ready');
    const call = await tillIpc(shop);
    const id = await cart(shop);
    const ledger = () => ({
      sync: count(shop.db, 'sync_queue'),
      audit: count(shop.db, 'audit_log'),
      lines: count(shop.db, 'order_items'),
    });
    const before = ledger();
    expect(
      await call('orders:setDeliveryArea', { orderId: id, area: AREA, phone: '0'.repeat(31) }),
    ).toEqual({ ok: false, code: 'validation_failed', message: 'The phone number is too long' });
    expect(
      await call('orders:setDeliveryArea', { orderId: id, area: AREA, phone: 3_001_234_567 }),
    ).toEqual({ ok: false, code: 'validation_failed', message: 'The phone number is not valid' });
    expect(ledger()).toEqual(before);
    expect(lastAreaAudit(shop.db, id)).toBeNull();

    // 30 characters is taken (not a Pakistani number: charged as usual).
    expect(
      await call('orders:setDeliveryArea', { orderId: id, area: AREA, phone: '0'.repeat(30) }),
    ).toMatchObject({ ok: true, data: { addOnTo: null } });
    expect(charges(shop.db, id)).toEqual(CHARGE_200);
  });

  it("Pay's save on the IPC ('customers:attachToOrder') takes the charge off and answers with addOnTo #A", async () => {
    const shop = await till();
    const c = await customers();
    const a = await first(shop, 'sent_to_kitchen');
    const call = await tillIpc(shop);
    const id = await cart(shop);
    expect(await call('orders:setDeliveryArea', { orderId: id, area: AREA })).toMatchObject({
      ok: true,
      data: { addOnTo: null },
    });
    expect(charges(shop.db, id)).toEqual(CHARGE_200);

    const customer = c.createCustomer(
      shop.db,
      { name: 'Test Add-on Customer', phone: '03001234567' },
      CASHIER,
    );
    const res = await call('customers:attachToOrder', {
      orderId: id,
      customerId: customer.id,
      addressId: null,
    });
    expect(res.ok).toBe(true);
    const s = (res as { ok: true; data: OrderSnapshot }).data;
    expect(s.addOnTo).toEqual(goesWith(a));
    expect(s.items.map((i) => i.menuItemName)).toEqual(['Test Pizza']);
    expect(s.order.totalCents).toBe(FOOD_ONLY);
  });
});

// ---------------------------------------------------------------------------
// An add-on that now goes alone (review fixes C): #A no longer here at #B's Send out.
// ---------------------------------------------------------------------------

const shifts = () => import('./repositories/shift-repo.js');

/** How #A leaves after the add-on #B was sent (at 19:50). */
type Gone = 'cancelled' | 'refunded' | 'delivered' | 'delivered_paid';

/**
 * #A (where it starts: Ready, or paid in the kitchen to be refunded), then
 * the add-on #B for the same phone: its charge left off for #A, the
 * customer saved (Send's save), sent to the kitchen and Ready.
 */
async function addOnSent(shop: Shop, gone: Gone) {
  const r = await repo();
  const a = await first(shop, gone === 'refunded' ? 'paid_in_kitchen' : 'ready');
  const b = await addOn(shop, '03001234567');
  await saveCustomer(shop, b, '03001234567', AREA);
  r.sendOrderToKitchen(shop.db, b, CASHIER);
  r.markOrderReady(shop.db, b, CASHIER);
  expect(charges(shop.db, b)).toEqual([]);
  expect(lastAreaAudit(shop.db, b)?.after).toMatchObject({ goesWith: goesWith(a), charged: 'add_on_off', feeCents: 20_000 });
  return { a, b };
}

/** #A leaves the shop's hands at 19:50, the way `gone` says. */
async function goAway(shop: Shop, a: { id: string }, gone: Gone) {
  const r = await repo();
  at('19:50');
  if (gone === 'cancelled') {
    r.voidOrder(
      shop.db,
      { orderId: a.id, reason: 'Customer changed order', approverUserId: MANAGER.userId, foodMade: 'not_made' },
      MANAGER,
    );
  } else if (gone === 'refunded') {
    r.refundOrder(
      shop.db,
      { orderId: a.id, reason: 'Customer changed order', approverUserId: MANAGER.userId, foodMade: 'not_made' },
      MANAGER,
    );
  } else if (gone === 'delivered') {
    // One of the shop's own riders took it, and someone tapped Delivered.
    r.assignRiderToOrder(shop.db, a.id, shop.rider, CASHIER);
    r.markOrderDelivered(shop.db, { orderId: a.id }, CASHIER);
  } else {
    // An outside rider took it alone, and brought the money back: delivered and paid.
    r.sendOutOrder(shop.db, a.id, CASHIER);
    const total = r.findOrder(shop.db, a.id)!.totalCents as number;
    r.markOrderDelivered(
      shop.db,
      { orderId: a.id, payment: { method: 'cash', amountCents: total }, riderKeepsCents: 20_000 },
      CASHIER,
    );
  }
  const status = { cancelled: 'void', refunded: 'refunded', delivered: 'delivered', delivered_paid: 'paid' }[gone];
  expect(r.findOrder(shop.db, a.id)?.status).toBe(status);
}

/** Everything a Send out could have written for #B: its payouts, its drawer rows, all sync and audit rows. */
const moneyLedger = (db: AppDatabase, orderId: string) => ({
  payouts: count(db, `cash_movements WHERE order_id = '${orderId}'`),
  drawer: count(db, `drawer_opens WHERE order_id = '${orderId}'`),
  sync: count(db, 'sync_queue'),
  audit: count(db, 'audit_log'),
});

const sendOutAfter = (db: AppDatabase, orderId: string) =>
  JSON.parse(
    String(
      (
        db
          .prepare(`SELECT after_json FROM audit_log WHERE entity_type = 'orders' AND entity_id = ? AND action = 'send_out' ORDER BY rowid DESC LIMIT 1`)
          .get(orderId) as Row
      )['after_json'],
    ),
  ) as Row;

const WENT_ALONE: Gone[] = ['cancelled', 'refunded', 'delivered', 'delivered_paid'];

live('an add-on that now goes alone: #A no longer here at Send out (review fixes C)', () => {
  for (const gone of WENT_ALONE) {
    it(`#A ${gone.replace('_', ' and ')} after #B was sent: #B's snapshot says it goes alone (Rs 200); Send out with nothing ticked pays nothing`, async () => {
      const shop = await till();
      const r = await repo();
      const { a, b } = await addOnSent(shop, gone);
      // Still with #A in the shop: nothing to say yet.
      expect(r.getOrderSnapshot(shop.db, b)).toHaveProperty('goesAlone', null);

      await goAway(shop, a, gone);
      expect(r.getOrderSnapshot(shop.db, b)?.goesAlone).toEqual({ orderId: a.id, orderNumber: a.orderNumber, feeCents: 20_000 });

      // Not ticked: sent out as before — he keeps 0, no payout, no drawer row, no trip in the audit.
      const before = moneyLedger(shop.db, b);
      at('19:55');
      const sent = r.sendOutOrder(shop.db, b, CASHIER);
      expect(sent.drawerOpenId).toBeNull();
      expect(keeps(shop.db, b)).toBe(0);
      const after = moneyLedger(shop.db, b);
      expect({ payouts: after.payouts, drawer: after.drawer }).toEqual({ payouts: before.payouts, drawer: before.drawer });
      expect(after.payouts).toBe(0);
      expect(sendOutAfter(shop.db, b)).not.toHaveProperty('tripPaidCents');
      expect(sendOutAfter(shop.db, b)).not.toHaveProperty('wentAloneFrom');
      // Out now: the snapshot no longer asks.
      expect(r.getOrderSnapshot(shop.db, b)).not.toHaveProperty('goesAlone');
    });
  }

  for (const gone of ['cancelled', 'delivered'] as const) {
    it(`#A ${gone}: 'Pay the rider Rs 200 for this trip' pays him from the drawer — one payout linked to #B, one drawer row, the manager named; the shift expects Rs 200 less and closes even`, async () => {
      const shop = await till();
      const r = await repo();
      const { getCurrentShift, getShiftSummary, closeShift } = await shifts();
      const { a, b } = await addOnSent(shop, gone);
      await goAway(shop, a, gone);
      const shiftId = getCurrentShift(shop.db, TILL_A)!.id;
      const expectedBefore = getShiftSummary(shop.db, shiftId).expectedCashCents;
      const before = moneyLedger(shop.db, b);

      at('19:55');
      const sent = r.sendOutOrder(shop.db, b, CASHIER, { payRiderForTrip: { approverUserId: MANAGER.userId } });

      expect(r.findOrder(shop.db, b)).toMatchObject({ status: 'out_for_delivery', riderKeepsCents: 0, paidAt: null });
      const short = `#${String(r.findOrder(shop.db, b)!.orderNumber).split('-').pop()}`;
      const reason = `Trip paid to the outside rider — Order ${short} went alone`;
      const payouts = shop.db
        .prepare(`SELECT id, type, amount_cents, reason, order_id, approved_by_user_id FROM cash_movements WHERE order_id = ?`)
        .all(b) as Row[];
      expect(payouts).toEqual([
        { id: expect.any(String), type: 'payout', amount_cents: 20_000, reason, order_id: b, approved_by_user_id: MANAGER.userId },
      ]);
      expect(sent.drawerOpenId).toEqual(expect.any(String));
      expect(
        shop.db.prepare(`SELECT kind, reason, order_id, cash_movement_id, amount_cents, user_id, approved_by_user_id FROM drawer_opens WHERE id = ?`).get(sent.drawerOpenId),
      ).toEqual({
        kind: 'payout',
        reason,
        order_id: b,
        cash_movement_id: payouts[0]!['id'],
        amount_cents: -20_000,
        user_id: CASHIER.userId,
        approved_by_user_id: MANAGER.userId,
      });
      // Exactly one payout and one drawer row, each synced and audited with the order's send out.
      const after = moneyLedger(shop.db, b);
      expect({ payouts: after.payouts - before.payouts, drawer: after.drawer - before.drawer }).toEqual({ payouts: 1, drawer: 1 });
      const written = writtenAfter(shop.db, before.sync, before.audit);
      expect(written.audit.map((x) => `${String(x.entityType)}:${String(x.action)}`)).toEqual([
        'orders:send_out',
        'cash_movements:delivery_charge_to_rider',
        'drawer_opens:drawer_payout',
      ]);
      expect(written.sync.map((x) => `${String(x.entityType)}:${String(x.op)}`)).toEqual(
        expect.arrayContaining(['orders:upsert', 'cash_movements:upsert', 'drawer_opens:upsert']),
      );
      const payoutAudit = JSON.parse(
        String(
          (shop.db.prepare(`SELECT after_json FROM audit_log WHERE action = 'delivery_charge_to_rider' AND entity_id = ?`).get(payouts[0]!['id']) as Row)[
            'after_json'
          ],
        ),
      ) as Row;
      expect(payoutAudit).toMatchObject({ why: 'trip', tripWhy: 'went_alone', amountCents: 20_000, orderId: b });
      expect(sendOutAfter(shop.db, b)).toMatchObject({ wentAloneFrom: a.orderNumber, tripPaidCents: 20_000, riderKeepsCents: 0 });
      expect(r.getOrderSnapshot(shop.db, b)!.deliveryChargeToRider).toEqual({ amountCents: 20_000, at: PK['19:55'], why: 'trip' });

      // The drawer: Rs 200 less than before, and a close counting exactly that is not short.
      const s = getShiftSummary(shop.db, shiftId);
      expect(s.expectedCashCents).toBe(expectedBefore - 20_000);
      expect(s).toMatchObject({ riderChargesCents: 20_000, riderChargeCount: 1 });
      // The rider brings back the food money later (Delivered + Pay, cash): no second payout for him.
      const total = r.findOrder(shop.db, b)!.totalCents as number;
      r.markOrderDelivered(shop.db, { orderId: b, payment: { method: 'cash', amountCents: total }, riderKeepsCents: 0 }, CASHIER);
      expect(count(shop.db, `cash_movements WHERE order_id = '${b}'`)).toBe(1);
      const end = getShiftSummary(shop.db, shiftId).expectedCashCents;
      expect(end).toBe(expectedBefore - 20_000 + total);
      expect(closeShift(shop.db, { shiftId, countedCashCents: end, carryOverReason: 'Test: delivered, money with the rider' }, MANAGER)).toMatchObject({ varianceCents: 0 });
    });
  }

  it('a manager sending it out himself: the payout and the drawer row carry no approver', async () => {
    const shop = await till();
    const r = await repo();
    const { a, b } = await addOnSent(shop, 'cancelled');
    await goAway(shop, a, 'cancelled');
    at('19:55');
    r.sendOutOrder(shop.db, b, MANAGER, { payRiderForTrip: { approverUserId: MANAGER.userId } });
    expect(shop.db.prepare(`SELECT approved_by_user_id AS a FROM cash_movements WHERE order_id = ?`).all(b)).toEqual([{ a: null }]);
    expect(shop.db.prepare(`SELECT approved_by_user_id AS a FROM drawer_opens WHERE order_id = ?`).all(b)).toEqual([{ a: null }]);
  });

  it('refused, with nothing written and #B still Ready: #A still in the shop, #A out (the same trip), the charge put back, or no shift open', async () => {
    const r = await repo();
    const NO_TRIP = 'Nothing to pay the rider for on this order';
    const NO_SHIFT = 'No shift is open on this till — open a shift to pay the rider for the trip';
    const pay = { payRiderForTrip: { approverUserId: MANAGER.userId } };

    // #A still Ready: they go together.
    {
      const shop = await till();
      const { b } = await addOnSent(shop, 'delivered');
      expect(r.getOrderSnapshot(shop.db, b)?.goesAlone).toBeNull();
      const before = moneyLedger(shop.db, b);
      expect(() => r.sendOutOrder(shop.db, b, CASHIER, pay)).toThrow(NO_TRIP);
      expect(moneyLedger(shop.db, b)).toEqual(before);
      expect(r.findOrder(shop.db, b)?.status).toBe('ready');
    }
    // #A out for delivery: Send out's own 'has already gone out' line; nothing paid here.
    {
      const shop = await till();
      const { a, b } = await addOnSent(shop, 'delivered');
      r.sendOutOrder(shop.db, a.id, CASHIER);
      expect(r.getOrderSnapshot(shop.db, b)?.goesAlone).toBeNull();
      const before = moneyLedger(shop.db, b);
      expect(() => r.sendOutOrder(shop.db, b, CASHIER, pay)).toThrow(NO_TRIP);
      expect(moneyLedger(shop.db, b)).toEqual(before);
    }
    // The charge put back before it was sent: its bill pays the trip.
    {
      const shop = await till();
      const a = await first(shop, 'ready');
      const b = await addOn(shop, '03001234567');
      r.syncOrderDeliveryCharge(shop.db, b, AREA, CASHIER, { putBack: true, phone: '03001234567' });
      await saveCustomer(shop, b, '03001234567', AREA);
      r.sendOrderToKitchen(shop.db, b, CASHIER);
      expect(charges(shop.db, b)).toEqual(CHARGE_200);
      await goAway(shop, a, 'delivered');
      expect(r.getOrderSnapshot(shop.db, b)?.goesAlone).toBeNull();
      const before = moneyLedger(shop.db, b);
      expect(() => r.sendOutOrder(shop.db, b, CASHIER, pay)).toThrow(NO_TRIP);
      expect(moneyLedger(shop.db, b)).toEqual(before);
    }
    // No shift open on this till.
    {
      const shop = await till();
      const { closeShift, getCurrentShift } = await shifts();
      const { a, b } = await addOnSent(shop, 'cancelled');
      await goAway(shop, a, 'cancelled');
      const shift = getCurrentShift(shop.db, TILL_A)!;
      closeShift(shop.db, { shiftId: shift.id, countedCashCents: 0, carryOverReason: 'Test: still in the kitchen' }, MANAGER);
      const before = moneyLedger(shop.db, b);
      expect(() => r.sendOutOrder(shop.db, b, CASHIER, pay)).toThrow(NO_SHIFT);
      expect(moneyLedger(shop.db, b)).toEqual(before);
      expect(r.findOrder(shop.db, b)?.status).toBe('ready');
      // Not ticked, it still goes out (no money moves).
      expect(r.sendOutOrder(shop.db, b, CASHIER).drawerOpenId).toBeNull();
    }
  });

  it('no goesAlone on a cart, on #A itself, or on a website order', async () => {
    const shop = await till();
    const r = await repo();
    const { a, b } = await addOnSent(shop, 'cancelled');
    await goAway(shop, a, 'cancelled');
    expect(r.getOrderSnapshot(shop.db, a.id)).not.toHaveProperty('goesAlone');
    const cartId = await addOn(shop, '03001234567');
    expect(r.getOrderSnapshot(shop.db, cartId)).not.toHaveProperty('goesAlone');
    at('19:40');
    const web = r.createOrder(shop.db, { mode: 'delivery', source: 'web' }, CASHIER);
    r.addOrderItem(shop.db, { orderId: web.id, menuItemId: shop.pizza, quantity: 1, modifierIds: [] }, CASHIER);
    r.sendOrderToKitchen(shop.db, web.id, CASHIER);
    expect(r.getOrderSnapshot(shop.db, web.id)).not.toHaveProperty('goesAlone');
    expect(r.getOrderSnapshot(shop.db, b)?.goesAlone).toEqual({ orderId: a.id, orderNumber: a.orderNumber, feeCents: 20_000 });
  });

  it("on the IPC: ticked needs a manager's PIN or password (refused without, or with a wrong one, nothing written); with it, the drawer opens once for that row", async () => {
    const shop = await till();
    const { a, b } = await addOnSent(shop, 'cancelled');
    await goAway(shop, a, 'cancelled');
    const call = await tillIpc(shop);
    h.managerPins.clear();
    h.managerPins.set('2468', MANAGER.userId);
    h.kicks.length = 0;
    at('19:55');
    const before = moneyLedger(shop.db, b);
    expect(await call('orders:sendOut', { orderId: b, payRiderForTrip: true })).toEqual({
      ok: false,
      code: 'forbidden',
      message: "A manager's PIN or password is needed to pay the rider for the trip",
    });
    expect(await call('orders:sendOut', { orderId: b, payRiderForTrip: true, approverPin: '1111' })).toEqual({
      ok: false,
      code: 'forbidden',
      message: "That is not a manager's PIN or password",
    });
    expect(moneyLedger(shop.db, b)).toEqual(before);
    expect(h.kicks).toEqual([]);

    const res = await call('orders:sendOut', { orderId: b, payRiderForTrip: true, approverPin: '2468' });
    expect(res).toMatchObject({ ok: true, data: { order: { status: 'out_for_delivery', riderKeepsCents: 0 }, deliveryChargeToRider: { amountCents: 20_000, why: 'trip' } } });
    const drawerId = (shop.db.prepare(`SELECT id FROM drawer_opens WHERE order_id = ?`).get(b) as Row)['id'];
    expect(h.kicks).toEqual([drawerId]);
    expect(shop.db.prepare(`SELECT approved_by_user_id AS a FROM cash_movements WHERE order_id = ?`).all(b)).toEqual([{ a: MANAGER.userId }]);
    h.managerPins.clear();
  });

  it('on the IPC: not ticked (or anything but true) sends it out with no payout and no drawer pulse', async () => {
    const shop = await till();
    const { a, b } = await addOnSent(shop, 'delivered');
    await goAway(shop, a, 'delivered');
    const call = await tillIpc(shop);
    h.kicks.length = 0;
    at('19:55');
    const res = await call('orders:sendOut', { orderId: b, payRiderForTrip: 'yes', approverPin: '2468' });
    expect(res).toMatchObject({ ok: true, data: { order: { status: 'out_for_delivery', riderKeepsCents: 0 } } });
    expect(count(shop.db, `cash_movements WHERE order_id = '${b}'`)).toBe(0);
    expect(count(shop.db, `drawer_opens WHERE order_id = '${b}'`)).toBe(0);
    expect(h.kicks).toEqual([]);
  });
});
