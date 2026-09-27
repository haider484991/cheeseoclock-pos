/**
 * What a cashier's login reaches, through the real IPC handlers, against a
 * real SQLite database built from every migration (owner, 2026-09-26):
 *   - the manager areas are refused in the main process, not only hidden:
 *     the customer list and everything behind it, order history, shift
 *     totals, stock / recipes / suppliers;
 *   - the counter still does its job: a customer found by the WHOLE phone
 *     number (one, never a list), their saved addresses, a new customer, the
 *     address saved with the order, the Live Orders board, Recent Orders;
 *   - a counter login opens and reprints only the draft, board orders and
 *     orders of the shift open now; a kitchen ticket only while the kitchen
 *     still has the order; the customer on a sent or paid bill never changes;
 *   - managers and the owner keep all of it;
 *   - costs (the Costing page, the batch calculator's rupees) are refused
 *     to the counter the same way, and the food-cost targets are the
 *     owner's alone;
 *   - Reports (every tab's channel, and low stock) likewise;
 *   - every channel of these modules is classified here, so one added later
 *     fails until someone decides whether the counter may call it.
 *
 * Only `defineHandler` (captured instead of registered with Electron), the
 * signed-in session, the printer spooler, the FBR worker, the cash drawer and
 * Windows' printer list are stood in for; the handlers, repositories, guards
 * and the counter rule are the real ones. better-sqlite3 is built for
 * Electron's ABI, so this uses `node:sqlite` with a small `transaction()`
 * shim and skips itself where node:sqlite is missing. Every name and number
 * is made up.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, OrderStatus, UUID } from '@cheeseoclock/shared-types';
import { BOARD_STATUSES, KITCHEN_TICKET_STATUSES, RECENT_AT_COUNTER_LIMIT } from '@cheeseoclock/pos-domain';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Handler = (ctx: unknown, payload: unknown) => unknown;
const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => unknown>(),
  session: null as unknown,
  /** Every call made to the (stand-in) print spooler, by method. */
  spool: [] as Array<{ method: string; args: unknown[] }>,
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
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '' },
  safeStorage: { isEncryptionAvailable: () => false },
  Notification: class {
    static isSupported() {
      return false;
    }
  },
}));
// Who is signed in, and the manager check: auth-service's job, stood in for here.
vi.mock('../../services/auth-service.js', () => ({
  getCurrentSession: () => h.session,
  verifyManagerPin: async () => {
    throw new Error("That is not a manager's PIN or password");
  },
}));
// The spooler records what it was asked and prints nothing; any method works,
// so the reprint work going on beside this one can add its own.
vi.mock('../../services/print-spooler.js', () => ({
  printSpooler: new Proxy(
    {},
    {
      get:
        (_t, method) =>
        (...args: unknown[]) => {
          h.spool.push({ method: String(method), args });
          return undefined;
        },
    },
  ),
}));
vi.mock('../../services/fbr-worker.js', () => ({ fbrWorker: { kick: () => {}, resetAdapter: () => {} } }));
vi.mock('../../services/drawer-service.js', () => ({
  DrawerOpenRefused: class extends Error {
    code = 'forbidden';
  },
  openDrawerNoSale: async () => ({ opened: true }),
  testDrawer: async () => ({ opened: true }),
}));
vi.mock('../../services/system-printers.js', () => ({
  isSystemPrintingSupported: () => false,
  listSystemPrinters: async () => [],
}));

interface Stmt {
  run(...p: unknown[]): unknown;
  all(...p: unknown[]): Array<Record<string, unknown>>;
  get(...p: unknown[]): Record<string, unknown> | undefined;
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
}
const Sqlite = (() => {
  try {
    return (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => RawDb })
      .DatabaseSync;
  } catch {
    return null;
  }
})();
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

function openMigrated() {
  const raw = new Sqlite!(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  raw.exec('PRAGMA foreign_keys = ON');
  let depth = 0;
  return {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction:
      <A extends unknown[], R>(fn: (...args: A) => R) =>
      (...args: A): R => {
        const sp = `sp_${depth}`;
        raw.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
        depth += 1;
        try {
          const out = fn(...args);
          depth -= 1;
          raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
          return out;
        } catch (e) {
          depth -= 1;
          if (depth === 0) raw.exec('ROLLBACK');
          else raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
          throw e;
        }
      },
  };
}

const DEV = 'dev-till-1';
const OTHER_TILL = 'dev-till-2';
const T0 = '2026-01-01T00:00:00.000Z';
const HOUR = 60 * 60 * 1000;
const session = (id: string, role: AuthenticatedUser['role']): AuthenticatedUser => ({
  id: id as UUID,
  fullName: id,
  role,
  sessionId: 'sess' as UUID,
});
const CASHIER = session('u_cash', 'cashier');
const MANAGER = session('u_mgr', 'manager');
const OWNER = session('u_admin', 'admin');

let db: ReturnType<typeof openMigrated>;
let REFUSED: Record<string, string>;
/** The ids made by seed(). */
let s: Awaited<ReturnType<typeof seed>>;

type Outcome = { ok: true; data: unknown } | { ok: false; code: string; message: string };

/** What the screen would get back: the handler's answer, or the guard's / repository's refusal. */
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

/** The counter's own "not this order" answers (order-access.ts). */
const refusedByCounterScope = (o: Outcome) =>
  !o.ok && o.code === 'forbidden' && /earlier shift|more than a day old|kitchen is done/.test(o.message);

async function seed() {
  const user = db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
  user.run('u_mgr', 'Test Manager', 'manager', T0, T0, DEV);
  user.run('u_admin', 'Test Owner', 'admin', T0, T0, DEV);

  const { openShift, closeShift } = await import('../../db/repositories/shift-repo.js');
  const { createCustomer, createAddress } = await import('../../db/repositories/customer-repo.js');
  const { createOrder } = await import('../../db/repositories/order-repo.js');
  const mgr = { userId: 'u_mgr', deviceId: DEV };
  const d = db as never;

  const earlierShift = openShift(d, { openingCashCents: 0, notes: null }, mgr);
  closeShift(d, { shiftId: earlierShift.id, countedCashCents: 0, notes: null }, mgr);
  const openNow = openShift(d, { openingCashCents: 0, notes: null }, mgr);

  const ayesha = createCustomer(d, { name: 'Ayesha', phone: '03001234567', email: 'a@example.com', notes: 'Regular' }, mgr);
  const bilal = createCustomer(d, { name: 'Bilal', phone: '03001234568' }, mgr);
  const sana = createCustomer(d, { name: 'Sana', phone: '03451112222' }, mgr);
  const addr = (customerId: string, addressLine: string, isDefault = false) =>
    createAddress(d, { customerId, label: 'Home', addressLine, area: 'DHA Phase 6', city: 'Karachi', isDefault }, mgr).id;
  const ayeshaHome = addr(ayesha.id, 'House 41-C, Lane 3', true);
  const ayeshaOffice = addr(ayesha.id, 'Office 9, Zamzama');
  const bilalHome = addr(bilal.id, 'House 12, Street 4', true);
  const sanaHome = addr(sana.id, 'House 7-A, Lane 1', true);

  const now = Date.now();
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  const order = (status: OrderStatus, shiftId: string | null, createdAt: string, device = DEV) => {
    const o = createOrder(d, { mode: 'delivery' }, { userId: 'u_cash', deviceId: device });
    const paid = status === 'paid' || status === 'served' || status === 'delivered';
    db.prepare(`UPDATE orders SET status = ?, shift_id = ?, created_at = ?, paid_at = ? WHERE id = ?`).run(
      status,
      shiftId,
      createdAt,
      paid ? createdAt : null,
      o.id,
    );
    return o.id;
  };
  const draft = createOrder(d, { mode: 'delivery' }, { userId: 'u_cash', deviceId: DEV }).id;
  return {
    earlierShift: earlierShift.id,
    openNow: openNow.id,
    ayesha: ayesha.id,
    bilal: bilal.id,
    sana: sana.id,
    ayeshaHome,
    ayeshaOffice,
    bilalHome,
    sanaHome,
    draft,
    /** Still out with the rider, from a shift closed three days ago. */
    boardOld: order('out_for_delivery', earlierShift.id, at(72 * HOUR)),
    /** Paid and done, earlier today, in the shift that was closed. */
    paidOld: order('paid', earlierShift.id, at(3 * HOUR)),
    /** Paid and done in the shift open now. */
    paidNow: order('paid', openNow.id, at(HOUR)),
    /** Still being made, in the shift open now. */
    kitchenNow: order('preparing', openNow.id, at(10 * 60_000)),
    /** Taken with no shift open, yesterday. */
    noShiftOld: order('paid', null, at(30 * HOUR)),
    /** The other till's order, a few minutes ago. */
    otherTill: order('paid', null, at(5 * 60_000), OTHER_TILL),
  };
}

beforeEach(async () => {
  if (!Sqlite) return;
  h.handlers.clear();
  h.spool.length = 0;
  h.session = null;
  db = openMigrated();
  ({ REFUSED } = (await import('../guards.js')) as unknown as { REFUSED: Record<string, string> });
  const ctx = { db, deviceId: DEV } as never;
  (await import('./orders-handlers.js')).registerOrdersHandlers(ctx);
  (await import('./customers-handlers.js')).registerCustomersHandlers(ctx);
  (await import('./printer-handlers.js')).registerPrinterHandlers(ctx);
  (await import('./shifts-handlers.js')).registerShiftsHandlers(ctx);
  (await import('./inventory-handlers.js')).registerInventoryHandlers(ctx);
  (await import('./fbr-handlers.js')).registerFbrHandlers(ctx);
  (await import('./counter-handlers.js')).registerCounterHandlers(ctx);
  (await import('./costing-handlers.js')).registerCostingHandlers(ctx);
  (await import('./reports-handlers.js')).registerReportsHandlers(ctx);
  s = await seed();
});

// ------------------------------------------------------------ the classes --

/** A report period around now: what the Reports page sends. */
const REPORT_TODAY = () => ({
  sinceIso: new Date(Date.now() - 3_600_000).toISOString(),
  untilIso: new Date(Date.now() + 3_600_000).toISOString(),
});

/** New in this change: managers and the owner only. Payloads a manager's screen would send. */
const COUNTER_REFUSED = (): Record<string, unknown> => ({
  'customers:list': { search: '0300' },
  'customers:page': {},
  'customers:update': { id: s.bilal, name: 'Bilal Khan' },
  'customers:listAddresses': { customerId: s.ayesha },
  'customers:searchAddresses': { query: 'House', limit: 6 },
  'customers:setDefaultAddress': { addressId: s.ayeshaOffice },
  'customers:deleteAddress': { addressId: s.sanaHome },
  'customers:orderHistory': { customerId: s.ayesha, limit: 20 },
  'orders:list': {},
  'orders:history': {},
  'shifts:summary': { shiftId: s.earlierShift },
  'shifts:list': {},
  'inventory:listIngredients': undefined,
  'inventory:getRecipe': { menuItemId: 'no-such-item' },
  'inventory:listRecipeLineCounts': undefined,
  'inventory:getBatchRecipe': { ingredientId: 'no-such-ingredient' },
  'inventory:listMovements': undefined,
  'inventory:searchMovements': {},
  'inventory:listSuppliers': undefined,
  'inventory:listPurchaseOrders': undefined,
  'inventory:getPurchaseOrder': { id: 'no-such-po' },
  // Costs (costing spec D6: COST_CAPABILITY = menu.manage).
  'costing:menuCosts': undefined,
  'costing:itemSheet': { menuItemId: 'no-such-item' },
  'costing:missingCosts': undefined,
  'costing:getTargets': undefined,
  'costing:recipeCost': { menuItemId: 'no-such-item', lines: [] },
  'costing:batchCalc': { ingredientId: 'no-such-ingredient', amount: 200 },
  // Prices and their history (costing spec Phase 4): costs, both ways.
  'inventory:priceHistory': { ingredientId: 'no-such-ingredient' },
  'inventory:setPrice': { ingredientId: 'no-such-ingredient', per: 'piece', priceCents: 1_000 },
  // The costing sheet's price as the price (costing spec Phase 6): a price, so costs.
  'inventory:useSheetPrice': { ingredientId: 'no-such-ingredient' },
  // Price alerts (costing spec Phase 6): read, marked seen, and their thresholds read.
  'costing:alerts': undefined,
  'costing:markAlertsSeen': { ids: ['no-such-alert'] },
  'costing:getAlertSettings': undefined,
  // Purchases (costing spec Phase 5): what was paid, and the drawer's payouts.
  'inventory:recordPurchase': { lines: [{ ingredientId: 'no-such-ingredient', qty: 1_000, billCents: 10_000 }], paidFromDrawer: true },
  'inventory:payoutToPurchase': { cashMovementId: 'no-such-payout', lines: [{ ingredientId: 'no-such-ingredient', qty: 1_000, billCents: 10_000 }] },
  'inventory:listDrawerPayouts': undefined,
  // Reports: one channel per tab (costing spec Phase 3), each checked in the
  // main process; Food cost & stock needs costs as well.
  'reports:overview': REPORT_TODAY(),
  'reports:when': REPORT_TODAY(),
  'reports:menu': REPORT_TODAY(),
  'reports:channels': REPORT_TODAY(),
  'reports:foodStock': REPORT_TODAY(),
  'reports:team': REPORT_TODAY(),
  'reports:lowStock': undefined,
  // The owner's week (costing spec Phase 7): the Dashboard card, the trends,
  // day notes and the parts of the day, all behind report.view.
  'reports:ownerWeek': { week: 'this' },
  'reports:trends': undefined,
  'reports:addDayNote': { day: new Date().toISOString().slice(0, 10), tag: 'rain', note: 'Heavy rain after 8' },
  'reports:removeDayNote': { id: 'no-such-note' },
  'reports:getDayparts': undefined,
});

/** The owner's alone: refused to the counter AND to managers. */
const OWNER_ONLY = (): Record<string, unknown> => ({
  // The food-cost targets (settings.manage).
  'costing:setTargets': { defaultBps: 3000, amberBps: 500, perCategory: {}, nonFoodCategoryIds: [], priceStepCents: 1000 },
  // The price alerts' thresholds (settings.manage, costing spec Phase 6).
  'costing:setAlertSettings': { jumpBps: 1_000, impactWeekCents: 100_000, keyIngredientIds: [] },
  // The parts of the day Reports splits sales into (settings.manage, costing spec Phase 7).
  'reports:setDayparts': { dayparts: [{ name: 'Lunch', fromHour: 12, toHour: 15 }, { name: 'Dinner', fromHour: 19, toHour: 23 }] },
});

/** The counter may call these, for some orders / inputs only (tested one by one below). */
const COUNTER_SCOPED = [
  'orders:get',
  // The same rule as orders:get: "Was the food made?" and its stock lines only
  // for an order the counter may open.
  'orders:stockStatus',
  'orders:attachCustomer',
  'orders:detachCustomer',
  'customers:findByPhone',
  'customers:attachToOrder',
  'printer:reprint',
  'printer:reprintKitchen',
  'shifts:listCashMovements',
  'fbr:getInvoiceStatus',
];

/** What taking orders needs: the counter's guard lets them through (the order or input may still be refused). */
const COUNTER_ALLOWED = (): Record<string, unknown> => ({
  'orders:create': { mode: 'takeaway' },
  'orders:addItem': { orderId: s.draft, menuItemId: 'no-such-item', quantity: 1 },
  'orders:updateItemQuantity': { orderId: s.draft, orderItemId: 'no-such-line', quantity: 2 },
  'orders:removeItem': { orderId: s.draft, orderItemId: 'no-such-line' },
  'orders:updateItemOptions': { orderId: s.draft, orderItemId: 'no-such-line', modifierIds: [], notes: null },
  'orders:applyDiscount': { orderId: s.draft, discountType: 'percent', value: 5 },
  'orders:clearDiscount': { orderId: s.draft },
  'orders:resumeDraft': undefined,
  'orders:setMode': { orderId: s.draft, mode: 'takeaway' },
  'orders:tender': { orderId: s.draft, payments: [] },
  'orders:sendToKitchen': { orderId: s.draft },
  'orders:listActive': undefined,
  'orders:markPreparing': { orderId: s.kitchenNow },
  'orders:markReady': { orderId: s.kitchenNow },
  'orders:assignRider': { orderId: s.kitchenNow, riderId: 'no-such-rider' },
  'orders:unassignRider': { orderId: s.kitchenNow },
  'orders:markServed': { orderId: s.kitchenNow },
  'orders:markDelivered': { orderId: s.boardOld },
  'orders:void': { orderId: s.paidNow, reason: 'Customer left' },
  'orders:refund': { orderId: s.paidNow, reason: 'Cold pizza', approverPin: '0000' },
  'orders:discardDraft': { orderId: s.draft },
  'orders:recentAtCounter': undefined,
  'customers:areaUsage': undefined,
  'customers:get': { id: s.ayesha },
  'customers:create': { name: 'Zara', phone: '03219876543' },
  'customers:createAddress': { customerId: s.ayesha, addressLine: 'Flat 3, Block 5' },
  'shifts:current': undefined,
  'shifts:open': { openingCashCents: 0 },
  'shifts:lastCount': undefined,
  'shifts:recordCashMovement': { type: 'payin', amountCents: 10_000, reason: 'Change' },
  'shifts:openDrawer': { kind: 'no_sale', reason: 'Change for a note' },
  'printer:getConfig': undefined,
  'printer:test': undefined,
  'printer:listSystemPrinters': undefined,
  // How many times a paper was printed by hand: numbers only, for orders the screen already shows.
  'printer:reprintCounts': { orderIds: [] },
  'fbr:getConfig': undefined,
  'fbr:getQueueStats': undefined,
  // Kitchen staff record a batch they made (any login, on purpose).
  'inventory:makeBatch': {},
});

/**
 * The only 'forbidden' answers the COUNTER_ALLOWED sweep accepts, per channel:
 * refusals about the order or the approval typed with it, not about who is
 * signed in. Keep this list short and exact.
 */
const EXPECTED_REFUSALS: Record<string, RegExp> = {
  // Sent with no PIN: the counter cancels only with a manager's approval.
  'orders:void': /^A manager's PIN or password is needed to cancel an order$/,
  // Sent with a PIN nobody has.
  'orders:refund': /^That is not a manager's PIN or password$/,
};

/**
 * Why a COUNTER_ALLOWED channel's answer shuts the counter out, or null: any
 * "not logged in" or "not allowed", whatever its wording, unless it is the
 * one refusal expected for that channel.
 */
function lockedOutBy(channel: string, o: Outcome): string | null {
  if (o.ok || (o.code !== 'unauthenticated' && o.code !== 'forbidden')) return null;
  if (EXPECTED_REFUSALS[channel]?.test(o.message)) return null;
  return `${o.code}: ${o.message}`;
}

/** Already managers' before this change, and still. */
const ALREADY_MANAGERS = (): Record<string, unknown> => ({
  'shifts:close': { shiftId: s.openNow, countedCashCents: 0 },
  'printer:setConfig': { config: {} },
  'printer:setBranding': {},
  'printer:setLogoRaster': {},
  'printer:setPolicy': {},
  'printer:setKitchenPrinter': { config: null },
  'printer:testDrawer': undefined,
  'inventory:createIngredient': {},
  'inventory:updateIngredient': {},
  'inventory:deleteIngredient': { id: 'x' },
  'inventory:convertIngredientUnit': {},
  'inventory:setRecipe': {},
  'inventory:setBatchRecipe': {},
  'inventory:recordMovement': {},
  'inventory:createSupplier': {},
  'inventory:updateSupplier': {},
  'inventory:createPurchaseOrder': {},
  'inventory:setPurchaseOrderStatus': {},
  'inventory:receiveDelivery': {},
  'fbr:setConfig': {},
  'fbr:retryFailed': undefined,
});

/**
 * Channels another piece of work is adding right now, known and left to it
 * (none at the moment). Classify them in one of the lists above once they land.
 */
const BEING_ADDED_ELSEWHERE: string[] = [];

// ------------------------------------------------------------------ tests --

describe.skipIf(!Sqlite)('a cashier is refused the manager areas, in the main process', () => {
  it('every new manager channel says no, in plain words, and changes nothing', async () => {
    h.session = CASHIER;
    for (const [channel, payload] of Object.entries(COUNTER_REFUSED())) {
      const o = await call(channel, payload);
      expect({ channel, code: o.ok ? 'ok' : o.code }).toEqual({ channel, code: 'forbidden' });
      expect(o.ok ? '' : o.message).toMatch(/^Only a manager or the owner can /);
      expect(Object.values(REFUSED)).toContain(o.ok ? '' : o.message);
    }
    const one = (sql: string, ...p: unknown[]) => db.prepare(sql).get(...p);
    expect(one(`SELECT name FROM customers WHERE id = ?`, s.bilal)?.['name']).toBe('Bilal');
    expect(one(`SELECT is_default FROM customer_addresses WHERE id = ?`, s.ayeshaOffice)?.['is_default']).toBe(0);
    expect(one(`SELECT deleted_at FROM customer_addresses WHERE id = ?`, s.sanaHome)?.['deleted_at']).toBeNull();
  });

  it('what was a manager’s before stays a manager’s', async () => {
    h.session = CASHIER;
    for (const [channel, payload] of Object.entries(ALREADY_MANAGERS())) {
      const o = await call(channel, payload);
      expect({ channel, code: o.ok ? 'ok' : o.code }).toEqual({ channel, code: 'forbidden' });
    }
  });

  it('nobody signed in: every new or narrowed channel says "not logged in"', async () => {
    h.session = null;
    const payloads = { ...COUNTER_REFUSED(), ...COUNTER_ALLOWED() } as Record<string, unknown>;
    for (const channel of [...Object.keys(COUNTER_REFUSED()), ...COUNTER_SCOPED]) {
      const o = await call(channel, payloads[channel] ?? { orderId: s.paidNow, id: s.paidNow, phone: '03001234567', shiftId: s.openNow });
      expect({ channel, code: o.ok ? 'ok' : o.code }).toEqual({ channel, code: 'unauthenticated' });
    }
  });
});

describe.skipIf(!Sqlite)("the owner's alone", () => {
  it('refused to the counter and to managers, in the main process; the owner may', async () => {
    for (const [channel, payload] of Object.entries(OWNER_ONLY())) {
      for (const who of [CASHIER, MANAGER]) {
        h.session = who;
        const o = await call(channel, payload);
        expect({ channel, who: who.role, code: o.ok ? 'ok' : o.code }).toEqual({ channel, who: who.role, code: 'forbidden' });
      }
      h.session = OWNER;
      expect({ channel, ok: (await call(channel, payload)).ok }).toEqual({ channel, ok: true });
    }
  });
});

describe.skipIf(!Sqlite)('managers and the owner keep everything', () => {
  for (const who of [MANAGER, OWNER]) {
    it(`${who.role}: every channel the counter lost still works`, async () => {
      h.session = who;
      const lockedOut: string[] = [];
      for (const [channel, payload] of Object.entries(COUNTER_REFUSED())) {
        const why = lockedOutBy(channel, await call(channel, payload));
        if (why) lockedOut.push(`${channel} — ${why}`);
      }
      expect(lockedOut).toEqual([]);
      // …with the same answers as before: the whole list, searchable by part of a number.
      expect((await data<unknown[]>('customers:list', { search: '0300' })).length).toBeGreaterThanOrEqual(2);
      expect((await data<{ total: number }>('customers:page', {})).total).toBe(3);
      // Three saved houses, less the one deleteAddress took off above.
      expect((await data<Array<{ customerName: string }>>('customers:searchAddresses', { query: 'House' })).length).toBe(2);
    });

    it(`${who.role}: opens, reprints and reads any order and shift, however old`, async () => {
      h.session = who;
      for (const id of [s.paidOld, s.noShiftOld, s.boardOld, s.paidNow]) {
        expect(await data<{ order: { id: string } } | null>('orders:get', { id })).toMatchObject({ order: { id } });
        expect(refusedByCounterScope(await call('printer:reprint', { orderId: id }))).toBe(false);
        expect((await call('fbr:getInvoiceStatus', { orderId: id })).ok).toBe(true);
      }
      expect(refusedByCounterScope(await call('printer:reprintKitchen', { orderId: s.paidOld }))).toBe(false);
      expect((await call('shifts:listCashMovements', { shiftId: s.earlierShift })).ok).toBe(true);
      expect((await call('shifts:summary', { shiftId: s.earlierShift })).ok).toBe(true);
      expect((await data<{ rows: unknown[] }>('orders:history', {})).rows.length).toBeGreaterThanOrEqual(5);
    });

    it(`${who.role}: sees a customer's email and notes`, async () => {
      h.session = who;
      expect(await data('customers:get', { id: s.ayesha })).toMatchObject({ email: 'a@example.com', notes: 'Regular' });
      expect(await data('customers:findByPhone', { phone: '03001234567' })).toMatchObject({ email: 'a@example.com' });
    });
  }
});

describe.skipIf(!Sqlite)('the counter still takes orders', () => {
  it('every channel taking orders needs gets past the guard', async () => {
    // Any "not logged in" or "not allowed" counts as locked out, whatever its
    // wording: guards in these modules say it in many ways ("You are not
    // allowed to open a shift", "… requires manager or admin role"). Only the
    // refusals listed in EXPECTED_REFUSALS, about the order or the approval
    // rather than who is signed in, are let through.
    const lockedOut: string[] = [];
    for (const [channel, payload] of Object.entries(COUNTER_ALLOWED())) {
      h.session = CASHIER;
      const why = lockedOutBy(channel, await call(channel, payload));
      if (why) lockedOut.push(`${channel} — ${why}`);
    }
    expect(lockedOut).toEqual([]);
  });

  it('the sweep counts a guard with its own wording as a lock-out', () => {
    // Wordings other guards in these modules use: none may slip through as "allowed".
    const refusal = (code: string, message: string): Outcome => ({ ok: false, code, message });
    expect(lockedOutBy('shifts:open', refusal('forbidden', 'You are not allowed to open a shift'))).not.toBeNull();
    expect(lockedOutBy('printer:test', refusal('forbidden', 'Printer settings require manager or admin role'))).not.toBeNull();
    expect(lockedOutBy('inventory:makeBatch', refusal('forbidden', 'Inventory management requires manager or admin role'))).not.toBeNull();
    expect(lockedOutBy('orders:create', refusal('unauthenticated', 'Session ended'))).not.toBeNull();
    // …and a manager-PIN refusal only where one is expected.
    expect(lockedOutBy('orders:void', refusal('forbidden', "A manager's PIN or password is needed to cancel an order"))).toBeNull();
    expect(lockedOutBy('orders:tender', refusal('forbidden', "A manager's PIN or password is needed to cancel an order"))).not.toBeNull();
    expect(lockedOutBy('orders:create', refusal('precondition_failed', 'That address is not saved for this customer'))).toBeNull();
  });

  it('the whole phone number finds exactly that one customer; part of a number or a name finds no one', async () => {
    h.session = CASHIER;
    for (const phone of ['03001234567', '0300 1234567', '+92 300 1234567']) {
      expect(await data('customers:findByPhone', { phone })).toMatchObject({ id: s.ayesha, name: 'Ayesha' });
    }
    for (const phone of ['0300', '03', '1234567', '300123456', '4567', 'Ayesha', '', '   ']) {
      expect({ phone, found: await data('customers:findByPhone', { phone }) }).toEqual({ phone, found: null });
    }
  });

  it("the counter gets a customer's name, phone and saved addresses — not the email or the notes", async () => {
    h.session = CASHIER;
    const c = await data<{ name: string; email: unknown; notes: unknown; addresses: Array<{ id: string }> }>(
      'customers:get',
      { id: s.ayesha },
    );
    expect(c).toMatchObject({ name: 'Ayesha', email: null, notes: null });
    expect(c.addresses.map((a) => a.id).sort()).toEqual([s.ayeshaHome, s.ayeshaOffice].sort());
    expect(await data('customers:findByPhone', { phone: '03001234567' })).toMatchObject({ email: null, notes: null });
    // "Create" with a saved number hands back that customer — as the counter sees them.
    expect(await data('customers:create', { name: 'A', phone: '0300 1234567' })).toMatchObject({
      id: s.ayesha,
      email: null,
      notes: null,
    });
  });

  it('a new customer, their address and the order: all at the counter', async () => {
    h.session = CASHIER;
    const zara = await data<{ id: string }>('customers:create', { name: 'Zara', phone: '03219876543' });
    const flat = await data<{ id: string; isDefault: boolean }>('customers:createAddress', {
      customerId: zara.id,
      addressLine: 'Flat 3, Block 5',
      area: 'Clifton Block 5',
      city: 'Karachi',
      isDefault: true,
    });
    expect(flat.isDefault).toBe(true);
    const snap = await data<{ customerName: string; order: { customerId: string } }>('customers:attachToOrder', {
      orderId: s.draft,
      customerId: zara.id,
      addressId: flat.id,
    });
    expect(snap).toMatchObject({ customerName: 'Zara', order: { customerId: zara.id } });
    expect((await data<unknown[]>('customers:areaUsage')).length).toBeGreaterThan(0);
  });

  it("a regular who moved: the new address saved with the order becomes the one filled in next time", async () => {
    h.session = CASHIER;
    const moved = await data<{ id: string }>('customers:createAddress', {
      customerId: s.ayesha,
      addressLine: 'House 99, Khayaban-e-Ittehad',
      area: 'DHA Phase 7',
      city: 'Karachi',
      isDefault: true,
    });
    const c = await data<{ addresses: Array<{ id: string; isDefault: boolean }> }>('customers:get', { id: s.ayesha });
    expect(c.addresses.filter((a) => a.isDefault).map((a) => a.id)).toEqual([moved.id]);
  });

  it("at the counter the address on an order is that customer's own", async () => {
    h.session = CASHIER;
    const o = await call('customers:attachToOrder', { orderId: s.draft, customerId: s.ayesha, addressId: s.bilalHome });
    expect(o).toMatchObject({ ok: false, code: 'precondition_failed' });
    expect(db.prepare(`SELECT customer_id FROM orders WHERE id = ?`).get(s.draft)?.['customer_id']).toBeNull();
    const own = await call('customers:attachToOrder', { orderId: s.draft, customerId: s.ayesha, addressId: s.ayeshaHome });
    expect(own.ok).toBe(true);
  });

  it('a new order with a customer: the same rule, and a refused one writes no order at all', async () => {
    const orders = () => db.prepare(`SELECT COUNT(*) AS n FROM orders`).get()?.['n'];
    const { deleteAddress } = await import('../../db/repositories/customer-repo.js');
    deleteAddress(db as never, s.ayeshaOffice, { userId: 'u_mgr', deviceId: DEV });
    h.session = CASHIER;
    const before = orders();
    for (const customerAddressId of [s.bilalHome, s.ayeshaOffice, 'no-such-address']) {
      const o = await call('orders:create', { mode: 'delivery', customerId: s.ayesha, customerAddressId });
      expect({ customerAddressId, o }).toMatchObject({
        customerAddressId,
        o: { ok: false, code: 'precondition_failed', message: 'That address is not saved for this customer' },
      });
    }
    expect(orders()).toBe(before);
    const own = await data<{ id: string }>('orders:create', { mode: 'delivery', customerId: s.ayesha, customerAddressId: s.ayeshaHome });
    const row = db.prepare(`SELECT customer_id, delivery_address_snapshot FROM orders WHERE id = ?`).get(own.id);
    expect(row?.['customer_id']).toBe(s.ayesha);
    expect(String(row?.['delivery_address_snapshot'])).toContain('House 41-C, Lane 3');
    // A manager keeps the house-number search, which can put another customer's saved house on purpose.
    h.session = MANAGER;
    expect((await call('orders:create', { mode: 'delivery', customerId: s.ayesha, customerAddressId: s.bilalHome })).ok).toBe(true);
  });

  it('the customer on a sent, paid or cancelled bill never changes — for anyone', async () => {
    const before = db.prepare(`SELECT customer_id, customer_name_snapshot, version FROM orders WHERE id = ?`).get(s.paidOld);
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      for (const [channel, payload] of [
        ['customers:attachToOrder', { orderId: s.paidOld, customerId: s.ayesha, addressId: null }],
        ['orders:attachCustomer', { orderId: s.paidOld, customerId: s.ayesha, addressId: null }],
        ['orders:detachCustomer', { orderId: s.paidOld }],
        ['orders:attachCustomer', { orderId: s.kitchenNow, customerId: s.ayesha, addressId: null }],
      ] as const) {
        const o = await call(channel, payload);
        expect({ channel, who: who.role, o }).toMatchObject({ channel, who: who.role, o: { ok: false, code: 'precondition_failed' } });
      }
    }
    const after = db.prepare(`SELECT customer_id, customer_name_snapshot, version FROM orders WHERE id = ?`).get(s.paidOld);
    expect(after).toEqual(before);
    // The draft still being rung up: yes.
    h.session = CASHIER;
    expect((await call('orders:attachCustomer', { orderId: s.draft, customerId: s.ayesha, addressId: s.ayeshaHome })).ok).toBe(true);
    expect((await call('orders:detachCustomer', { orderId: s.draft })).ok).toBe(true);
  });

  it("Live Orders shows the board; Recent Orders shows this till's orders of the shift open now", async () => {
    h.session = CASHIER;
    const board = (await data<Array<{ order: { id: string } }>>('orders:listActive')).map((x) => x.order.id);
    expect(board).toEqual(expect.arrayContaining([s.boardOld, s.kitchenNow]));
    const recent = await data<Array<{ id: string; paid: boolean }>>('orders:recentAtCounter');
    // Newest first; not the draft, not the closed shift's, not yesterday's, not the other till's.
    expect(recent.map((r) => r.id)).toEqual([s.kitchenNow, s.paidNow]);
    expect(recent[1]).toMatchObject({ paid: true });
    expect(Object.keys(recent[0] ?? {}).sort()).toEqual(['createdAt', 'id', 'mode', 'orderNumber', 'paid', 'source', 'status']);
  });

  it('a busy shift: an order past the newest 20 is found by its whole number, and only one of this shift', async () => {
    const { createOrder } = await import('../../db/repositories/order-repo.js');
    const now = Date.now();
    const made: Array<{ id: string; orderNumber: string }> = [];
    for (let i = 0; i < RECENT_AT_COUNTER_LIMIT + 5; i++) {
      const o = createOrder(db as never, { mode: 'takeaway' }, { userId: 'u_cash', deviceId: DEV });
      const t = new Date(now - (60 - i) * 60_000).toISOString();
      db.prepare(`UPDATE orders SET status = 'paid', shift_id = ?, created_at = ?, paid_at = ? WHERE id = ?`).run(s.openNow, t, t, o.id);
      made.push({ id: o.id, orderNumber: o.orderNumber });
    }
    h.session = CASHIER;
    const list = await data<Array<{ id: string }>>('orders:recentAtCounter');
    expect(list).toHaveLength(RECENT_AT_COUNTER_LIMIT);
    const first = made[0]!;
    expect(list.map((r) => r.id)).not.toContain(first.id);

    const day = first.orderNumber.split('-').pop()!;
    for (const orderNumber of [day, `#${day}`, String(Number(day)), first.orderNumber]) {
      const found = await data<Array<{ id: string }>>('orders:recentAtCounter', { orderNumber });
      expect({ orderNumber, found: found.map((r) => r.id) }).toEqual({ orderNumber, found: [first.id] });
    }
    expect(await data('orders:get', { id: first.id })).toMatchObject({ order: { id: first.id } });

    // Not an order of the closed shift, not the other till's, not a part of a number or a pattern.
    const numberOf = (id: string) => String(db.prepare(`SELECT order_number FROM orders WHERE id = ?`).get(id)?.['order_number']);
    for (const orderNumber of [numberOf(s.paidOld), numberOf(s.otherTill), numberOf(s.noShiftOld), first.orderNumber.slice(0, 6), '%', '1%', '']) {
      expect({ orderNumber, found: await data('orders:recentAtCounter', { orderNumber }) }).toEqual({ orderNumber, found: [] });
    }
  });

  it('a till clock put back mid-shift: that shift’s orders dated ahead still list and open', async () => {
    const ahead = new Date(Date.now() + 3 * HOUR).toISOString();
    db.prepare(`UPDATE orders SET created_at = ?, paid_at = ? WHERE id = ?`).run(ahead, ahead, s.paidNow);
    h.session = CASHIER;
    expect((await data<Array<{ id: string }>>('orders:recentAtCounter')).map((r) => r.id)).toContain(s.paidNow);
    expect(await data('orders:get', { id: s.paidNow })).toMatchObject({ order: { id: s.paidNow } });
    expect(refusedByCounterScope(await call('printer:reprint', { orderId: s.paidNow }))).toBe(false);
    // More than a day back, even in the shift still open: a manager's, and said as it is.
    const old = new Date(Date.now() - 25 * HOUR).toISOString();
    db.prepare(`UPDATE orders SET created_at = ?, paid_at = ? WHERE id = ?`).run(old, old, s.paidNow);
    expect(await call('orders:get', { id: s.paidNow })).toEqual({
      ok: false,
      code: 'forbidden',
      message: 'This order is more than a day old. Ask a manager to open it.',
    });
    expect((await data<Array<{ id: string }>>('orders:recentAtCounter')).map((r) => r.id)).not.toContain(s.paidNow);
  });

  it('with no shift open, Recent Orders is this till’s orders taken without one, from the last day', async () => {
    // Closed behind the till's back (the real close wants the unpaid orders settled first).
    db.prepare(`UPDATE shifts SET closed_at = ? WHERE id = ?`).run(new Date().toISOString(), s.openNow);
    h.session = CASHIER;
    expect(await data('orders:recentAtCounter')).toEqual([]);
    db.prepare(`UPDATE orders SET created_at = ? WHERE id = ?`).run(new Date(Date.now() - HOUR).toISOString(), s.noShiftOld);
    expect((await data<Array<{ id: string }>>('orders:recentAtCounter')).map((r) => r.id)).toEqual([s.noShiftOld]);
  });
});

describe.skipIf(!Sqlite)('which orders a counter login opens and reprints', () => {
  it('opens the draft, board orders (however old) and the shift open now — not an earlier shift', async () => {
    h.session = CASHIER;
    for (const id of [s.draft, s.boardOld, s.paidNow, s.kitchenNow]) {
      expect(await data('orders:get', { id })).toMatchObject({ order: { id } });
    }
    expect(await call('orders:get', { id: s.paidOld })).toEqual({
      ok: false,
      code: 'forbidden',
      message: 'This order is from an earlier shift. Ask a manager to open it.',
    });
    // Taken with no shift, yesterday: no shift to name, so its age is what is said.
    expect(await call('orders:get', { id: s.noShiftOld })).toEqual({
      ok: false,
      code: 'forbidden',
      message: 'This order is more than a day old. Ask a manager to open it.',
    });
    expect(await data('orders:get', { id: 'no-such-order' })).toBeNull();
  });

  it('reprints a receipt of the board and this shift; an earlier shift is refused and nothing prints', async () => {
    h.session = CASHIER;
    for (const orderId of [s.paidNow, s.boardOld]) {
      expect(refusedByCounterScope(await call('printer:reprint', { orderId }))).toBe(false);
    }
    h.spool.length = 0;
    expect(await call('printer:reprint', { orderId: s.paidOld })).toEqual({
      ok: false,
      code: 'forbidden',
      message: 'This order is from an earlier shift. Ask a manager to reprint it.',
    });
    expect(await call('printer:reprint', { orderId: s.draft })).toMatchObject({ ok: false, code: 'precondition_failed' });
    expect(await call('printer:reprint', { orderId: 'no-such-order' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(h.spool).toEqual([]);
  });

  it('reprints a kitchen ticket only while the kitchen still has the order', async () => {
    h.session = CASHIER;
    expect(refusedByCounterScope(await call('printer:reprintKitchen', { orderId: s.kitchenNow }))).toBe(false);
    h.spool.length = 0;
    for (const orderId of [s.boardOld, s.paidNow, s.paidOld]) {
      const o = await call('printer:reprintKitchen', { orderId });
      expect({ orderId, o }).toMatchObject({ orderId, o: { ok: false, code: 'forbidden' } });
    }
    expect(h.spool).toEqual([]);
  });

  it("the counter's kitchen-ticket rule is the spooler's, so the refusal never sends anyone to a manager", async () => {
    // The spooler refuses a finished order's kitchen ticket for managers too
    // (reprint-policy.ts), so the counter's words must not say "ask a manager".
    const { KITCHEN_REPRINT_STATUSES } = await import('../../services/reprint-policy.js');
    expect([...KITCHEN_TICKET_STATUSES].sort()).toEqual([...KITCHEN_REPRINT_STATUSES].sort());
    h.session = CASHIER;
    const o = await call('printer:reprintKitchen', { orderId: s.boardOld });
    expect(o).toEqual({
      ok: false,
      code: 'forbidden',
      message: 'The kitchen is done with this order, so its ticket is not printed again',
    });
  });

  it("reads an order's stock (\"Was the food made?\") only when it may open it — the same answer as orders:get, word for word", async () => {
    const { createOrder } = await import('../../db/repositories/order-repo.js');
    const ALL: OrderStatus[] = ['open', 'sent_to_kitchen', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'served', 'paid', 'void', 'refunded'];
    // Every status, long ago, in the shift that was closed: only the board makes them the counter's.
    const old = ALL.map((status) => {
      const o = createOrder(db as never, { mode: 'delivery' }, { userId: 'u_cash', deviceId: DEV });
      db.prepare(`UPDATE orders SET status = ?, shift_id = ?, created_at = ? WHERE id = ?`).run(status, s.earlierShift, T0, o.id);
      return o.id;
    });
    const ids = [s.draft, s.boardOld, s.paidOld, s.paidNow, s.kitchenNow, s.noShiftOld, s.otherTill, ...old];
    const answer = (o: Outcome) => (o.ok ? 'ok' : `${o.code}: ${o.message}`);
    h.session = CASHIER;
    let refused = 0;
    for (const id of ids) {
      const opened = answer(await call('orders:get', { id }));
      const stock = answer(await call('orders:stockStatus', { orderId: id }));
      expect({ id, stock }).toEqual({ id, stock: opened });
      if (opened !== 'ok') refused += 1;
    }
    expect(refused).toBeGreaterThanOrEqual(5);
    expect(await call('orders:stockStatus', { orderId: s.paidOld })).toEqual({
      ok: false,
      code: 'forbidden',
      message: 'This order is from an earlier shift. Ask a manager to open it.',
    });
    expect(await call('orders:stockStatus', { orderId: s.noShiftOld })).toEqual({
      ok: false,
      code: 'forbidden',
      message: 'This order is more than a day old. Ask a manager to open it.',
    });
    expect(await call('orders:stockStatus', { orderId: 'no-such-order' })).toMatchObject({ ok: false, code: 'not_found' });
    // Managers and the owner read any of them.
    for (const who of [MANAGER, OWNER]) {
      h.session = who;
      for (const id of ids) expect({ who: who.role, id, ok: (await call('orders:stockStatus', { orderId: id })).ok }).toEqual({ who: who.role, id, ok: true });
    }
  });

  it('reads the FBR status of an order it may open only', async () => {
    h.session = CASHIER;
    expect((await call('fbr:getInvoiceStatus', { orderId: s.paidNow })).ok).toBe(true);
    expect(await call('fbr:getInvoiceStatus', { orderId: s.paidOld })).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('every order on the Live Orders board is one the counter may open (the board and the rule agree)', async () => {
    const { createOrder } = await import('../../db/repositories/order-repo.js');
    const ALL: OrderStatus[] = ['open', 'sent_to_kitchen', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'served', 'paid', 'void', 'refunded'];
    const byStatus = new Map<string, OrderStatus>();
    for (const status of ALL) {
      const o = createOrder(db as never, { mode: 'delivery' }, { userId: 'u_cash', deviceId: DEV });
      // Long ago, in the shift that was closed: only the board makes them the counter's.
      db.prepare(`UPDATE orders SET status = ?, shift_id = ?, created_at = ? WHERE id = ?`).run(status, s.earlierShift, T0, o.id);
      byStatus.set(o.id, status);
    }
    h.session = CASHIER;
    const onBoard = (await data<Array<{ order: { id: string; status: OrderStatus } }>>('orders:listActive'))
      .filter((x) => byStatus.has(x.order.id))
      .map((x) => x.order.status);
    expect(onBoard.sort()).toEqual([...BOARD_STATUSES].sort());
    for (const [id, status] of byStatus) {
      if (status === 'open') continue;
      expect({ status, opened: (await call('orders:get', { id })).ok }).toEqual({ status, opened: BOARD_STATUSES.includes(status) });
    }
  });
});

describe.skipIf(!Sqlite)('shift money at the counter', () => {
  it('the shift open now and the last count: yes; totals, past shifts and an earlier shift’s cash: no', async () => {
    h.session = CASHIER;
    expect((await call('shifts:current')).ok).toBe(true);
    expect((await call('shifts:lastCount')).ok).toBe(true);
    expect((await call('shifts:listCashMovements', { shiftId: s.openNow })).ok).toBe(true);
    expect(await call('shifts:listCashMovements', { shiftId: s.earlierShift })).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(await call('shifts:listCashMovements', { shiftId: 'no-such-shift' })).toMatchObject({ ok: false, code: 'forbidden' });
    for (const channel of ['shifts:summary', 'shifts:list']) {
      expect(await call(channel, { shiftId: s.openNow })).toMatchObject({ ok: false, code: 'forbidden' });
    }
  });
});

describe.skipIf(!Sqlite)('every channel is classified', () => {
  it('each channel of these modules is in exactly one list, so a new one must be decided on', () => {
    const lists: Record<string, string[]> = {
      COUNTER_REFUSED: Object.keys(COUNTER_REFUSED()),
      OWNER_ONLY: Object.keys(OWNER_ONLY()),
      COUNTER_SCOPED,
      COUNTER_ALLOWED: Object.keys(COUNTER_ALLOWED()),
      ALREADY_MANAGERS: Object.keys(ALREADY_MANAGERS()),
      BEING_ADDED_ELSEWHERE,
    };
    const unclassified: string[] = [];
    const twice: string[] = [];
    for (const channel of h.handlers.keys()) {
      const homes = Object.entries(lists).filter(([, l]) => l.includes(channel)).map(([n]) => n);
      if (homes.length === 0) unclassified.push(channel);
      if (homes.length > 1) twice.push(`${channel}: ${homes.join(', ')}`);
    }
    expect(
      unclassified,
      'New channel(s): may a cashier call them? Add each to one list in counter-access.db.test.ts',
    ).toEqual([]);
    expect(twice).toEqual([]);
    // And the lists name real channels (a renamed one must be moved, not forgotten).
    const known = new Set(h.handlers.keys());
    const stale = Object.entries(lists)
      .filter(([n]) => n !== 'BEING_ADDED_ELSEWHERE')
      .flatMap(([, l]) => l.filter((c) => !known.has(c)));
    expect(stale).toEqual([]);
  });
});
