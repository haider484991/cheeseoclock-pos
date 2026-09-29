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
 *   - costs (the Costing page, the batch calculator's rupees, the recipe
 *     calculator's) are refused to the counter the same way, and the
 *     food-cost targets, the payment fees and the rider cost (costing spec
 *     Phase 9: managers read them) are the owner's alone to change; the
 *     recipe calculator's quantities and its prep list are stock, so
 *     managers' too;
 *   - Reports (every tab's channel with the Profit tab, low stock, the menu
 *     map, the owner's week, day notes, the stock-take variance, the shift
 *     history list) and this till's printer settings are the owner's alone
 *     since 2026-09-27 ("managers can't see the reports and settings"):
 *     refused to the counter AND to managers, in the handlers' plain words,
 *     and nothing is written; a manager keeps everything else it had
 *     (closing the shift, stock, stock takes, costs, customers, order
 *     history);
 *   - profit likewise (costing spec Phase 9, owner 2026-09-27: managers keep
 *     costs but see no profit): Costing → What-if is refused to the counter
 *     as costs and to managers as profit, in plain words; foodpanda's
 *     commission (the cost sheet's foodpanda line, the terms on Targets &
 *     fees) is left out for a manager;
 *   - the owner's shop rules (Settings → foodpanda, Money & discounts, Staff
 *     & kitchen timing, 2026-09-27; Kitchen & stock, 2026-09-28) are the owner's alone: every set channel
 *     is refused to a cashier AND to a manager in the main process, for every
 *     key, and nothing is written; the counter reads only what taking an
 *     order needs (checkout:getRules: the approval limit and the F3 buttons,
 *     the Live Orders minutes, the foodpanda deal and Pay's checks);
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
import { COST_CAPABILITY, DEFAULT_DELIVERY_ZONES, PROFIT_CAPABILITY, SHOP_SETTING_KEYS, hasCapability } from '@cheeseoclock/shared-types';
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
  // The owner's PIN typed again to delete a test order (0043): only this made-up one is the owner's.
  verifyOwnerSecret: async (_db: unknown, secret: string) => {
    if (secret === 'Owner-pass-9') return { ownerUserId: 'u_admin', ownerName: 'Test Owner' };
    throw new Error("That is not the owner's PIN or password.");
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

/** How many rows the audit trail, the sync queue, the settings (both kinds) and the day notes hold: a refusal changes none. */
const writtenRows = () =>
  Object.fromEntries(
    ['audit_log', 'sync_queue', 'settings', 'business_settings', 'day_notes'].map((t) => [
      t,
      db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.['n'],
    ]),
  );

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
  (await import('./settings-handlers.js')).registerSettingsHandlers(ctx);
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
  'inventory:listIngredients': undefined,
  'inventory:getRecipe': { menuItemId: 'no-such-item' },
  'inventory:listRecipeLineCounts': undefined,
  'inventory:getBatchRecipe': { ingredientId: 'no-such-ingredient' },
  'inventory:listMovements': undefined,
  'inventory:searchMovements': {},
  'inventory:listSuppliers': undefined,
  'inventory:listPurchaseOrders': undefined,
  'inventory:getPurchaseOrder': { id: 'no-such-po' },
  // The recipe calculator (2026-09-27): recipes and stock, so managers and the
  // owner — quantities only; its costs are costing:recipeCalc's, below.
  'inventory:recipeCalc': { lines: [{ kind: 'item', menuItemId: 'no-such-item', count: 10, portions: [] }] },
  'inventory:typicalPicks': { menuItemId: 'no-such-item' },
  'inventory:printPrepList': { lines: [{ kind: 'item', menuItemId: 'no-such-item', count: 10, portions: [] }] },
  // Costs (costing spec D6: COST_CAPABILITY = menu.manage).
  'costing:menuCosts': undefined,
  'costing:itemSheet': { menuItemId: 'no-such-item' },
  'costing:missingCosts': undefined,
  'costing:getTargets': undefined,
  'costing:recipeCost': { menuItemId: 'no-such-item', lines: [] },
  'costing:batchCalc': { ingredientId: 'no-such-ingredient', amount: 200 },
  'costing:recipeCalc': { lines: [{ kind: 'batch', ingredientId: 'no-such-ingredient', amount: 200 }] },
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
  // Stock takes (costing spec Phase 8): what the stock is worth and what went
  // missing — managers and the owner only, every channel. (Its "used vs
  // should have used" is Reports: see REPORTS.)
  'inventory:stockCountList': undefined,
  'inventory:stockCountGet': { countId: 'no-such-count' },
  'inventory:stockCountStart': { scope: 'key_items' },
  'inventory:stockCountSave': { countId: 'no-such-count', lines: [{ ingredientId: 'no-such-ingredient', countedQty: 1_000 }] },
  'inventory:stockCountFinish': { countId: 'no-such-count' },
  'inventory:stockCountCancel': { countId: 'no-such-count' },
  'inventory:stockCountOne': { ingredientId: 'no-such-ingredient', countedQty: 1_000 },
  // How many tills take orders (read by managers).
  'costing:getTills': undefined,
  // foodpanda's commission, payment fees and the rider cost (costing spec
  // Phase 9): costs, read by managers; only the owner changes them (OWNER_ONLY).
  'costing:getChannelFees': undefined,
});

/**
 * Reports (report.view): refused to the counter since 2026-09-26, and to
 * managers too since 2026-09-27 (owner: "managers can't see the reports and
 * settings"). The owner's alone, each refused in the words of
 * `reportsRefusal`.
 */
const REPORTS = (): Record<string, unknown> => ({
  // One channel per tab (costing spec Phase 3), each checked in the main
  // process; Food cost & stock needs costs as well.
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
  // Stock takes' "used vs should have used" (costing spec Phase 8).
  'reports:variance': undefined,
  // The cash drawer log (0042): every open, who, why and whether it opened.
  'reports:drawerLog': REPORT_TODAY(),
  // Shift history: every past shift with its totals.
  'shifts:list': {},
  // Profit (costing spec Phase 9): the Profit tab and the menu map. Reports
  // first (report.view), then profit.view and costs: a manager hears the
  // Reports words.
  'reports:profit': REPORT_TODAY(),
  'reports:menuMap': undefined,
});

/** What a REPORTS channel says to a login without report.view (guards.ts REFUSED, shown as it is). */
const reportsRefusal = (channel: string) => (channel === 'shifts:list' ? REFUSED['shiftHistory'] : REFUSED['reports']);

/**
 * Profit outside Reports (profit.view, costing spec Phase 9): the owner's
 * alone since 2026-09-27 (owner question 8: managers keep costs, see no
 * profit). The counter is refused as costs (it has none), a manager as
 * profit — see profitRefusal.
 */
const PROFIT = (): Record<string, unknown> => ({
  // Costing → What-if: prices tried against the last 4 weeks, never saved.
  'costing:whatIf': { ingredients: [], items: [] },
});

/** What a PROFIT channel says: costs first (the counter), then profit (a manager). */
const profitRefusal = (who: AuthenticatedUser) => (who.role === 'cashier' ? REFUSED['costs'] : REFUSED['profit']);

/**
 * This till's printer settings and the drawer test (printer.manage): the
 * Settings page's, so the owner's alone since 2026-09-27, like Reports.
 * Refused to the counter AND to managers in PRINTER_REFUSAL's words.
 */
const PRINTER_SETTINGS = (): Record<string, unknown> => ({
  'printer:setConfig': { config: {} },
  'printer:setBranding': {},
  'printer:setLogoRaster': {},
  'printer:setPolicy': {},
  'printer:setKitchenPrinter': { config: null },
  'printer:testDrawer': undefined,
});

/** What printer-handlers.ts says to a login without printer.manage (shown as it is). */
const PRINTER_REFUSAL = 'Only the owner can change the printers.';

/** The owner's alone (settings.manage): refused to the counter AND to managers. */
const OWNER_ONLY = (): Record<string, unknown> => ({
  // The food-cost targets (settings.manage).
  'costing:setTargets': { defaultBps: 3000, amberBps: 500, perCategory: {}, nonFoodCategoryIds: [], priceStepCents: 1000 },
  // The price alerts' thresholds (settings.manage, costing spec Phase 6).
  'costing:setAlertSettings': { jumpBps: 1_000, impactWeekCents: 100_000, keyIngredientIds: [] },
  // The parts of the day Reports splits sales into (settings.manage, costing spec Phase 7).
  'reports:setDayparts': { dayparts: [{ name: 'Lunch', fromHour: 12, toHour: 15 }, { name: 'Dinner', fromHour: 19, toHour: 23 }] },
  // How many tills take orders (settings.manage, costing spec Phase 8).
  'costing:setTills': { sellingTills: 2 },
  // Payment fees and the rider cost (settings.manage, costing spec Phase 9); foodpanda's terms are Settings → foodpanda's.
  'costing:setChannelFees': {
    fees: { paymentFeeBps: { cash: 0, card: 0, foodpanda: 0, transfer: 0 } },
    riderCost: { mode: 'zone_rate', fixedCents: 0 },
  },
  // FBR's settings and sending the failed invoices again (settings.manage: never a manager's).
  'fbr:setConfig': { mode: 'noop' },
  'fbr:retryFailed': undefined,
  // The owner's shop rules (Settings → foodpanda …, 2026-09-27): reading a card
  // (commission, fees) and saving one, or putting its default back.
  ...SHOP_SETTINGS_OWNER_ONLY(),
});

/** The shop-rules channels (settings.manage), with payloads the owner's screen would send. Every set one writes when the owner sends it. */
const SHOP_SETTINGS_OWNER_ONLY = (): Record<string, unknown> => ({
  'settings:getBusiness': { key: 'foodpanda.fees' },
  'settings:setBusiness': {
    key: 'foodpanda.deal',
    value: { v: 1, percent: 20, shopPercent: 20, minOrderCents: null, maxOffCents: null, startsOn: null, endsOn: null },
  },
  // This till's own (Settings polish, 28 Sep 2026): the receipt's extra lines and the opening float. Never synced.
  'settings:getTill': { key: 'drawer.openingFloat' },
  'settings:setTill': { key: 'receipt.extraLines', value: ['Test line on the receipt'] },
  // Settings → Delivery areas (step 3): the areas AND their fee items, one transaction. Free delivery
  // everywhere here (this test till has no tax category for a fee item), so the owner's Save writes.
  'settings:saveDeliveryZones': FREE_DELIVERY_ZONES(),
});

/** Today's 21 areas, every one free to deliver to: a Save that needs no fee item. Made-up. */
const FREE_DELIVERY_ZONES = () => ({
  zones: DEFAULT_DELIVERY_ZONES.zones.map((z) => ({ ...z, feeCents: 0, feeItemId: null, aliases: [...z.aliases], hints: [...z.hints] })),
});

/** Every way a shop rule can be saved: each key, and "Put back the default". */
const SHOP_SETTING_SAVES = (): unknown[] => [
  { key: 'foodpanda.deal', value: { v: 1, percent: 20, shopPercent: 10, minOrderCents: 50_000, maxOffCents: 40_000, startsOn: null, endsOn: null } },
  { key: 'foodpanda.fees', value: { v: 1, commissionBps: 2_200, confirmed: true, base: 'after_deal', fixedFeeCents: 2_000, commissionTaxBps: 1_600, upliftBps: 0, paymentFeeBps: 0 } },
  { key: 'foodpanda.checks', value: { v: 2, orderCode: 'required', tabletTotal: 'required', tabletToleranceCents: 500 } },
  { key: 'foodpanda.deal', useDefault: true },
  { key: 'foodpanda.fees', useDefault: true },
  { key: 'foodpanda.checks', useDefault: true },
  // Money & discounts (Settings step 2) and Staff & kitchen timing (step 6).
  { key: 'discounts.approval', value: { v: 2, percentOver: 0, flatOverCents: 0, reasonRequired: true } },
  { key: 'discounts.presets', value: { v: 1, percents: [5, 50], flatCents: [30_000], reasons: ['Test reason'] } },
  { key: 'staff.timing', value: { v: 1, idleLogoutMin: 60, maxLoginHours: 24, stepInMin: 30, freeReprints: 3, reprintWindowMin: 120 } },
  { key: 'kitchen.timing', value: { v: 1, amberMin: 45, redMin: 90, notStartedMin: 30, notDoneMin: 60 } },
  { key: 'discounts.approval', useDefault: true },
  { key: 'discounts.presets', useDefault: true },
  { key: 'staff.timing', useDefault: true },
  { key: 'kitchen.timing', useDefault: true },
  // Kitchen & stock (Settings step 7): the stock rules (waste reasons with fixed ids) and what a menu file may change.
  {
    key: 'stock.rules',
    value: {
      v: 1,
      varianceDoThisBps: 250,
      bands: { goodUnderBps: 150, okUpToBps: 250, needsWorkUpToBps: 400 },
      varianceMinWindowDays: 5,
      reminders: { keyItemsEveryDays: 7, fullEveryDays: 30 },
      reorderMultiple: 4,
      wasteReasons: [
        { id: 'burnt', label: 'Test burnt', hidden: false },
        { id: 'dropped', label: 'Dropped', hidden: true },
        { id: 'expired', label: 'Expired / went off', hidden: false },
        { id: 'wrong_order', label: 'Wrong order made', hidden: false },
        { id: 'returned', label: 'Sent back', hidden: false },
        { id: 'staff_meal', label: 'Staff meal', hidden: false },
        { id: 'test_spill', label: 'Test spill', hidden: false },
        { id: 'other', label: 'Other', hidden: false },
      ],
    },
  },
  { key: 'menu.importPolicy', value: { v: 1, itemPrices: 'till', choices: 'till', recipes: 'file', tax: 'till' } },
  { key: 'stock.rules', useDefault: true },
  { key: 'menu.importPolicy', useDefault: true },
  // Whether a discount also comes off the delivery charge (owner, 28 Sep 2026).
  { key: 'discounts.delivery', value: { v: 1, alsoOffDeliveryCharge: true } },
  { key: 'discounts.delivery', useDefault: true },
  // Settings step 3: the website's pick-up offer and "publish the menu by itself" (the areas have their own channel).
  { key: 'discounts.websitePickup', value: { v: 1, offered: false, percent: 15 } },
  { key: 'discounts.websitePickup', useDefault: true },
  {
    key: 'online.options',
    value: {
      v: 2,
      autoPublishMenu: true,
      // v0.7.30: the website's messages and smallest delivery order (made-up words and amount).
      closedNotice: { text: 'Test closed notice', until: '2026-10-03' },
      announcement: { on: true, text: 'Test announcement' },
      minDeliveryOrderCents: 100_000,
    },
  },
  { key: 'online.options', useDefault: true },
  // The automatic offers and the came-by question (Settings step 4).
  {
    key: 'discounts.offers',
    value: {
      v: 1,
      askCameBy: true,
      offers: [
        {
          id: 'test-offer',
          name: 'Test WhatsApp offer',
          on: true,
          cameBy: ['whatsapp'],
          orderTypes: ['delivery'],
          type: 'percent',
          value: 10,
          minOrderCents: null,
          maxOffCents: null,
          days: [0, 1, 2, 3, 4, 5, 6],
          hours: null,
          startsOn: null,
          endsOn: null,
          oncePerCustomerPerDay: false,
        },
      ],
    },
  },
  { key: 'discounts.offers', useDefault: true },
  // The Cancel, Refund and Cash out reason buttons (Settings polish, 28 Sep 2026).
  {
    key: 'orders.reasons',
    value: {
      v: 1,
      cancel: [{ id: 'test_cancel', label: 'Test cancel reason', food: 'made' }],
      refund: [{ id: 'test_refund', label: 'Test refund reason', food: 'ask' }],
      cashOut: ['Test cash out'],
    },
  },
  { key: 'orders.reasons', useDefault: true },
  // The shop's details the website shows (sweep B2 + B4): made-up name, numbers, words and item names.
  {
    key: 'shop.profile',
    value: {
      v: 1,
      name: 'Test Shop',
      tagline: 'Test tagline',
      phone: { display: '0300 1234567', e164: '+923001234567' },
      whatsappLines: [{ display: '0300 1234567', e164: '+923001234567' }],
      address: { street: 'Test Street 1', areaLine: 'Test Area, Karachi', postalCode: '12345' },
      socialLinks: ['https://www.instagram.com/test.shop'],
      priceRange: 'PKR 100–200',
    },
  },
  { key: 'shop.profile', useDefault: true },
  { key: 'shop.hours', value: { v: 1, opens: '11:00', closes: '23:00', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'] } },
  { key: 'shop.hours', useDefault: true },
  {
    key: 'shop.website',
    value: {
      v: 1,
      whatsappGreeting: 'Hi Test Shop! ',
      doorPayments: ['cash', 'card'],
      pickupPayments: ['cash'],
      allergyNotice: 'Test allergy notice: tell us and we leave it out (made-up words).',
    },
  },
  { key: 'shop.website', useDefault: true },
  {
    key: 'website.home',
    value: { v: 1, pizzas: [{ itemRef: { posItemId: null, name: 'Test Pizza — Large' }, headline: 'Test hook' }], burger: null, deals: [] },
  },
  { key: 'website.home', useDefault: true },
];

/** The counter may call these, for some orders / inputs only (tested one by one below). */
const COUNTER_SCOPED = [
  'orders:get',
  // The same rule as orders:get: "Was the food made?" and its stock lines only
  // for an order the counter may open.
  'orders:stockStatus',
  'orders:attachCustomer',
  'orders:detachCustomer',
  // The counter's "Order notes" with no customer: only on the bill still being rung up.
  'orders:setNote',
  'customers:findByPhone',
  'customers:attachToOrder',
  'printer:reprint',
  'printer:reprintKitchen',
  // What the print button would print and the order's papers: the same orders as a reprint.
  'printer:orderPapers',
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
  // How a counter order came in (the chips): the cashier's while it is rung up; a manager's PIN once sent.
  'orders:setCameBy': { orderId: s.draft, cameBy: 'phone' },
  // The delivery area's charge goes on by itself (owner, 28 Sep 2026): any login taking the order.
  'orders:setDeliveryArea': { orderId: s.draft, area: 'DHA Phase 6' },
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
  // Where the Open shift box starts (this till's last count, or the owner's fixed float): a cashier opens the morning shift.
  'shifts:openingFloat': undefined,
  'shifts:recordCashMovement': { type: 'payin', amountCents: 10_000, reason: 'Change' },
  'shifts:openDrawer': { kind: 'no_sale', reason: 'Change for a note' },
  'printer:getConfig': undefined,
  'printer:test': undefined,
  'printer:listSystemPrinters': undefined,
  // How many times a paper was printed by hand: numbers only, for orders the screen already shows.
  'printer:reprintCounts': { orderIds: [] },
  // "Try again" on the failed-print note: that very job again (its order's reprint rule when it has one).
  'printer:retryJob': { jobId: 'no-such-job' },
  'fbr:getConfig': undefined,
  'fbr:getQueueStats': undefined,
  // Kitchen staff record a batch they made (any login, on purpose).
  'inventory:makeBatch': {},
  // What taking an order needs from the owner's shop rules (the foodpanda deal, Pay's checks).
  'checkout:getRules': undefined,
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

/**
 * Already managers' before the counter change (2026-09-26), and still: closing
 * the shift with the drawer count, and looking after the stock. (The printer
 * settings were too, until 2026-09-27: see PRINTER_SETTINGS.)
 */
const ALREADY_MANAGERS = (): Record<string, unknown> => ({
  // A cashier's login closes only with a manager's PIN or password typed on
  // it (shift-close-approval.db.test.ts); with none, it is refused.
  'shifts:close': { shiftId: s.openNow, countedCashCents: 0 },
  'shifts:closeCheck': { shiftId: s.openNow },
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
});

/**
 * Deleting a test order (0043): the OWNER (admin) login only — a manager and
 * a cashier are refused before anything is read — and the delete itself
 * needs the owner's PIN or password typed again.
 */
const TEST_ORDERS_OWNER = (): Record<string, unknown> => ({
  'orders:testDeletePreview': { orderId: s.paidNow },
  'orders:listDeletedTests': REPORT_TODAY(),
  'orders:deleteTest': {
    orderId: s.paidNow,
    reason: 'Printer test',
    restock: null,
    ownerSecret: 'Owner-pass-9',
    expectStatus: 'paid',
  },
});

/**
 * Channels another piece of work is adding right now, known and left to it
 * (none at the moment). Classify them in one of the lists above once they land.
 */
const BEING_ADDED_ELSEWHERE: string[] = [];

// ------------------------------------------------------------------ tests --

describe.skipIf(!Sqlite)('a cashier is refused the manager areas, in the main process', () => {
  it('every new manager channel, Reports and profit say no, in plain words, and change nothing', async () => {
    h.session = CASHIER;
    const before = writtenRows();
    for (const [channel, payload] of Object.entries({ ...COUNTER_REFUSED(), ...REPORTS(), ...PROFIT() })) {
      const o = await call(channel, payload);
      expect({ channel, code: o.ok ? 'ok' : o.code }).toEqual({ channel, code: 'forbidden' });
      // Reports are the owner's alone since 2026-09-27; the rest a manager can do.
      expect(o.ok ? '' : o.message).toMatch(/^Only (a manager or )?the owner can /);
      expect(Object.values(REFUSED)).toContain(o.ok ? '' : o.message);
    }
    const one = (sql: string, ...p: unknown[]) => db.prepare(sql).get(...p);
    expect(one(`SELECT name FROM customers WHERE id = ?`, s.bilal)?.['name']).toBe('Bilal');
    expect(one(`SELECT is_default FROM customer_addresses WHERE id = ?`, s.ayeshaOffice)?.['is_default']).toBe(0);
    expect(one(`SELECT deleted_at FROM customer_addresses WHERE id = ?`, s.sanaHome)?.['deleted_at']).toBeNull();
    expect(writtenRows()).toEqual(before);
  });

  it('what was a manager’s before is still refused to the counter (the printer settings are the owner’s now)', async () => {
    h.session = CASHIER;
    for (const [channel, payload] of Object.entries({ ...ALREADY_MANAGERS(), ...PRINTER_SETTINGS() })) {
      const o = await call(channel, payload);
      expect({ channel, code: o.ok ? 'ok' : o.code }).toEqual({ channel, code: 'forbidden' });
    }
  });

  it('nobody signed in: every new or narrowed channel says "not logged in"', async () => {
    h.session = null;
    const payloads = { ...COUNTER_REFUSED(), ...REPORTS(), ...PROFIT(), ...COUNTER_ALLOWED() } as Record<string, unknown>;
    for (const channel of [...Object.keys(COUNTER_REFUSED()), ...Object.keys(REPORTS()), ...Object.keys(PROFIT()), ...COUNTER_SCOPED]) {
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

  it("Reports and the printer settings too, since 2026-09-27: the counter and managers are refused in the handlers' plain words and nothing is written; the owner may", async () => {
    const before = writtenRows();
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      for (const [channel, payload] of Object.entries(REPORTS())) {
        expect({ channel, who: who.role, o: await call(channel, payload) }).toEqual({
          channel,
          who: who.role,
          o: { ok: false, code: 'forbidden', message: reportsRefusal(channel) },
        });
      }
      for (const [channel, payload] of Object.entries(PRINTER_SETTINGS())) {
        expect({ channel, who: who.role, o: await call(channel, payload) }).toEqual({
          channel,
          who: who.role,
          o: { ok: false, code: 'forbidden', message: PRINTER_REFUSAL },
        });
      }
    }
    expect(writtenRows()).toEqual(before);
    h.session = OWNER;
    const lockedOut: string[] = [];
    for (const [channel, payload] of Object.entries({ ...REPORTS(), ...PRINTER_SETTINGS() })) {
      const why = lockedOutBy(channel, await call(channel, payload));
      if (why) lockedOut.push(`${channel} — ${why}`);
    }
    expect(lockedOut).toEqual([]);
  });

  it('profit too (costing spec Phase 9, owner 2026-09-27): the counter is refused as costs, a manager as profit, nothing is written; the owner may', async () => {
    // The role table itself: profit.view is the owner's, costs are managers' too.
    expect([hasCapability('admin', PROFIT_CAPABILITY), hasCapability('manager', PROFIT_CAPABILITY), hasCapability('cashier', PROFIT_CAPABILITY)]).toEqual([
      true,
      false,
      false,
    ]);
    expect(hasCapability('manager', COST_CAPABILITY)).toBe(true);
    expect(REFUSED['profit']).toBe('Only the owner can see profit.');
    const before = writtenRows();
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      for (const [channel, payload] of Object.entries(PROFIT())) {
        expect({ channel, who: who.role, o: await call(channel, payload) }).toEqual({
          channel,
          who: who.role,
          o: { ok: false, code: 'forbidden', message: profitRefusal(who) },
        });
      }
    }
    expect(writtenRows()).toEqual(before);
    // A manager keeps the card fees and the rider cost, but not foodpanda's commission (profit): the
    // main process leaves Settings → foodpanda's terms out of Targets & fees for anyone but the owner.
    h.session = MANAGER;
    const forManager = await call('costing:getChannelFees');
    expect(forManager).toMatchObject({ ok: true, data: { foodpanda: null } });
    h.session = OWNER;
    expect(await call('costing:getChannelFees')).toMatchObject({ ok: true, data: { foodpanda: { fees: { commissionBps: 2_500 } } } });
    const lockedOut: string[] = [];
    for (const [channel, payload] of Object.entries(PROFIT())) {
      const why = lockedOutBy(channel, await call(channel, payload));
      if (why) lockedOut.push(`${channel} — ${why}`);
    }
    expect(lockedOut).toEqual([]);
  });
});

describe.skipIf(!Sqlite)('test orders: the owner (admin) login only, and the owner\'s PIN or password to delete', () => {
  it('a cashier and a manager are refused every test-order channel in plain words, and nothing is written', async () => {
    const before = writtenRows();
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      for (const [channel, payload] of Object.entries(TEST_ORDERS_OWNER())) {
        const o = await call(channel, payload);
        expect({ channel, who: who.role, o }).toEqual({
          channel,
          who: who.role,
          o: {
            ok: false,
            code: 'forbidden',
            message:
              channel === 'orders:listDeletedTests'
                ? 'The list of deleted test orders needs the owner (admin) login'
                : 'Deleting a test order needs the owner (admin) login',
          },
        });
      }
    }
    h.session = null;
    for (const [channel, payload] of Object.entries(TEST_ORDERS_OWNER())) {
      expect({ channel, code: (await call(channel, payload)) }).toMatchObject({ channel, code: { ok: false, code: 'unauthenticated' } });
    }
    expect(writtenRows()).toEqual(before);
  });

  it("the owner: a manager's PIN is not the owner's (nothing written); with the owner's the test order is deleted", async () => {
    h.session = OWNER;
    expect(await data('orders:testDeletePreview', { orderId: s.paidNow })).toMatchObject({ orderId: s.paidNow, refusal: null });
    const before = writtenRows();
    const wrong = await call('orders:deleteTest', { ...(TEST_ORDERS_OWNER()['orders:deleteTest'] as object), ownerSecret: 'Manager-pass-7' });
    expect(wrong).toEqual({ ok: false, code: 'forbidden', message: "That is not the owner's PIN or password." });
    expect(writtenRows()).toEqual(before);
    const done = await data<{ orderId: string; deleteStock: string }>('orders:deleteTest', TEST_ORDERS_OWNER()['orders:deleteTest']);
    expect(done).toMatchObject({ orderId: s.paidNow, deleteStock: 'none' });
    expect(db.prepare(`SELECT delete_kind AS k, deleted_by AS by FROM orders WHERE id = ?`).get(s.paidNow)).toEqual({ k: 'test', by: 'u_admin' });
    // The kitchen and the printer queue were told after the commit.
    expect(h.spool.map((c) => c.method)).toContain('onOrderDeleted');
    const lastTwoDays = { sinceIso: new Date(Date.now() - 48 * HOUR).toISOString(), untilIso: new Date(Date.now() + HOUR).toISOString() };
    const list = await data<{ total: number; rows: Array<{ orderId: string; reason: string }> }>('orders:listDeletedTests', lastTwoDays);
    expect(list.total).toBe(1);
    expect(list.rows[0]).toMatchObject({ orderId: s.paidNow, reason: 'Printer test' });
    // A second delete: already gone.
    expect(await call('orders:deleteTest', TEST_ORDERS_OWNER()['orders:deleteTest'])).toMatchObject({
      ok: false,
      code: 'precondition_failed',
      message: "This order is already deleted or can't be found.",
    });
  });

  it('the other till\'s order is refused in its words, even for the owner', async () => {
    h.session = OWNER;
    expect(await data('orders:testDeletePreview', { orderId: s.otherTill })).toMatchObject({
      refusal: 'This order was taken on the other till. Delete it on that till.',
    });
  });
});

describe.skipIf(!Sqlite)("the owner's shop rules (Settings → foodpanda …)", () => {
  it('a cashier AND a manager are refused every set channel in the main process, in plain words, and nothing is written', async () => {
    const before = writtenRows();
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      for (const payload of SHOP_SETTING_SAVES()) {
        expect({ who: who.role, payload, o: await call('settings:setBusiness', payload) }).toEqual({
          who: who.role,
          payload,
          o: { ok: false, code: 'forbidden', message: REFUSED['settings'] },
        });
      }
      // …nor save the delivery areas (their Save also writes the fee items), nor put their default back.
      for (const payload of [FREE_DELIVERY_ZONES(), { useDefault: true }]) {
        expect({ who: who.role, o: await call('settings:saveDeliveryZones', payload) }).toEqual({
          who: who.role,
          o: { ok: false, code: 'forbidden', message: REFUSED['settings'] },
        });
      }
      // …nor may they read a card (foodpanda's carries the commission; every one is the owner's).
      expect(SHOP_SETTING_KEYS.length).toBe(19);
      for (const key of SHOP_SETTING_KEYS) {
        expect({ who: who.role, key, o: await call('settings:getBusiness', { key }) }).toMatchObject({
          who: who.role,
          key,
          o: { ok: false, code: 'forbidden' },
        });
      }
    }
    expect(writtenRows()).toEqual(before);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM business_settings`).get()?.['n']).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM menu_items`).get()?.['n']).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM categories`).get()?.['n']).toBe(0);
  });

  it('the delivery areas never go through settings:setBusiness — not even for the owner (their Save makes the fee items)', async () => {
    h.session = OWNER;
    const before = writtenRows();
    expect(await call('settings:setBusiness', { key: 'delivery.zones', value: { v: 1, ...FREE_DELIVERY_ZONES() } })).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
    expect(await call('settings:setBusiness', { key: 'delivery.zones', useDefault: true })).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(writtenRows()).toEqual(before);
    // Through its own channel it saves, synced and audited.
    const o = await call('settings:saveDeliveryZones', FREE_DELIVERY_ZONES());
    expect(o).toMatchObject({ ok: true, data: { key: 'delivery.zones', isDefault: false } });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'business_settings'`).get()?.['n']).toBe(1);
  });

  it('the owner saves each one (synced and audited); nobody signed in is refused', async () => {
    h.session = null;
    expect(await call('settings:setBusiness', SHOP_SETTING_SAVES()[0])).toMatchObject({ ok: false, code: 'unauthenticated' });
    expect(await call('checkout:getRules')).toMatchObject({ ok: false, code: 'unauthenticated' });
    h.session = OWNER;
    for (const payload of SHOP_SETTING_SAVES()) {
      const o = await call('settings:setBusiness', payload);
      expect({ payload, ok: o.ok }).toEqual({ payload, ok: true });
      // The card that comes back says whether it is the default now: "Put back" writes the default's values.
      const isDefault = typeof payload === 'object' && payload !== null && 'useDefault' in payload;
      expect({ payload, o }).toMatchObject({ payload, o: { data: { isDefault } } });
    }
    const audited = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'business_settings'`).get()?.['n'];
    const queued = db.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'business_settings'`).get()?.['n'];
    expect({ audited, queued }).toEqual({ audited: SHOP_SETTING_SAVES().length, queued: SHOP_SETTING_SAVES().length });
  });

  it('a Save the website needs tells the web bridge — the shop’s details too (the shop block) — and no other Save does', async () => {
    h.session = OWNER;
    const { onWebsiteSettingsChanged } = await import('../../services/website-settings-events.js');
    const told: string[] = [];
    let saving = '';
    const stop = onWebsiteSettingsChanged(() => told.push(saving));
    try {
      for (const payload of SHOP_SETTING_SAVES()) {
        saving = (payload as { key: string }).key;
        expect((await call('settings:setBusiness', payload)).ok).toBe(true);
      }
    } finally {
      stop();
    }
    expect([...new Set(told)]).toEqual([
      'discounts.websitePickup',
      'online.options',
      'shop.profile',
      'shop.hours',
      'shop.website',
      'website.home',
    ]);
  });

  it('the counter reads the deal’s % and Pay’s checks — never the commission', async () => {
    h.session = OWNER;
    for (const payload of SHOP_SETTING_SAVES().slice(0, 3)) expect((await call('settings:setBusiness', payload)).ok).toBe(true);
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      const rules = await data<Record<string, unknown>>('checkout:getRules');
      expect(rules).toMatchObject({
        foodpanda: {
          deal: { percent: 20, shopPercent: 10, label: 'Foodpanda deal 20% off (your part 10%)' },
          checks: { orderCode: 'required', tabletTotal: 'required' },
          // The owner's tolerance (Rs 5 here), the one Reports use too.
          tabletToleranceCents: 500,
        },
      });
      // The delivery areas carry their own delivery FEES (the counter charges them); nothing else may say "fee".
      const { delivery, ...rest } = rules;
      expect(JSON.stringify(rest)).not.toMatch(/commission|fee|2200|payout/i);
      expect(JSON.stringify(delivery)).not.toMatch(/commission|2200|payout|rider|updatedBy/i);
    }
  });

  it('the counter reads the approval limit, the F3 buttons and the Live Orders minutes — never the staff timings', async () => {
    h.session = OWNER;
    for (const payload of SHOP_SETTING_SAVES().slice(6, 10)) expect((await call('settings:setBusiness', payload)).ok).toBe(true);
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      const rules = await data<Record<string, unknown>>('checkout:getRules');
      expect(rules).toMatchObject({
        discounts: {
          approval: { percentOver: 0, flatOverCents: 0 },
          presets: { percents: [5, 50], flatCents: [30_000], reasons: ['Test reason'] },
          reasonRequired: true,
        },
        kitchen: { amberMin: 45, redMin: 90, notStartedMin: 30, notDoneMin: 60 },
      });
      expect(JSON.stringify(rules)).not.toMatch(/idleLogout|maxLogin|stepIn|freeReprints|reprintWindow|updatedBy/i);
    }
    // …and both count at once: with no reason, a cashier's 5% is refused for the reason (before any PIN)…
    h.session = CASHIER;
    expect(await call('orders:applyDiscount', { orderId: s.draft, discountType: 'percent', value: 5 })).toMatchObject({
      ok: false,
      code: 'validation_failed',
      message: expect.stringContaining('Pick or type a reason'),
    });
    // …and with one, with 0% it needs a manager.
    expect(
      await call('orders:applyDiscount', { orderId: s.draft, discountType: 'percent', value: 5, reason: 'Test reason' }),
    ).toMatchObject({
      ok: false,
      code: 'precondition_failed',
    });
  });

  it('the counter reads the waste reasons, the stock bar’s multiple and the reminders — never the variance’s figures or the import rule', async () => {
    h.session = OWNER;
    for (const payload of SHOP_SETTING_SAVES().slice(14, 16)) expect((await call('settings:setBusiness', payload)).ok).toBe(true);
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      const rules = await data<Record<string, unknown>>('checkout:getRules');
      expect(rules).toMatchObject({
        stock: {
          reorderMultiple: 4,
          reminders: { keyItemsEveryDays: 7, fullEveryDays: 30 },
          wasteReasons: expect.arrayContaining([{ id: 'test_spill', label: 'Test spill', hidden: false }, { id: 'dropped', label: 'Dropped', hidden: true }]),
        },
      });
      expect(JSON.stringify(rules)).not.toMatch(/varianceDoThis|goodUnder|needsWork|MinWindow|itemPrices|recipes|updatedBy/i);
    }
  });

  it('the counter reads whether a discount comes off the delivery charge (no by default) — in words with no fee or commission', async () => {
    // Picked by its key, never by its place in the list (Settings steps add keys to it).
    const yes = SHOP_SETTING_SAVES().find(
      (p) => (p as { key?: string }).key === 'discounts.delivery' && 'value' in (p as object),
    );
    expect(yes).toEqual({ key: 'discounts.delivery', value: { v: 1, alsoOffDeliveryCharge: true } });
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      const rules = await data<{ discounts: { alsoOffDeliveryCharge: boolean } }>('checkout:getRules');
      expect(rules.discounts.alsoOffDeliveryCharge).toBe(false);
    }
    h.session = OWNER;
    expect((await call('settings:setBusiness', yes)).ok).toBe(true);
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      const rules = await data<Record<string, unknown>>('checkout:getRules');
      expect(rules).toMatchObject({ discounts: { alsoOffDeliveryCharge: true } });
      const { delivery: _areas, ...rest } = rules;
      expect(JSON.stringify(rest)).not.toMatch(/commission|fee|payout/i);
    }
  });

  it('the counter reads the offers that run today and the came-by question — never who saved them — and the manager-only change of a sent order', async () => {
    const offers = SHOP_SETTING_SAVES().find((p) => (p as { key?: string }).key === 'discounts.offers' && 'value' in (p as object)) as {
      value: { offers: unknown[] };
    };
    h.session = OWNER;
    expect((await call('settings:setBusiness', offers)).ok).toBe(true);
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      const rules = await data<Record<string, unknown>>('checkout:getRules');
      expect(rules).toMatchObject({ offers: { askCameBy: true, offers: offers.value.offers } });
      expect(JSON.stringify(rules)).not.toMatch(/commission|payout|updatedBy|savedBy/i);
    }
    // The counter taps a chip on its own draft; once the order is sent a cashier alone can't change it.
    h.session = CASHIER;
    const order = await data<{ id: string }>('orders:create', { mode: 'takeaway', cameBy: 'walk_in' });
    expect(await call('orders:setCameBy', { orderId: order.id, cameBy: 'whatsapp' })).toMatchObject({ ok: true });
    expect(await call('orders:create', { mode: 'takeaway', cameBy: 'carrier-pigeon' })).toMatchObject({ ok: false, code: 'validation_failed' });
    // A sent order (out with the rider): a cashier alone is refused, and a PIN that is not a
    // manager's is refused too — nothing written either way.
    const before = ['audit_log', 'sync_queue'].map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.['n']);
    const cameByOf = () => db.prepare(`SELECT came_by FROM orders WHERE id = ?`).get(s.boardOld)?.['came_by'] ?? null;
    const was = cameByOf();
    expect(await call('orders:setCameBy', { orderId: s.boardOld, cameBy: 'whatsapp' })).toMatchObject({ ok: false, code: 'precondition_failed' });
    expect(await call('orders:setCameBy', { orderId: s.boardOld, cameBy: 'whatsapp', approverPin: 'not-a-manager' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(cameByOf()).toBe(was);
    expect(['audit_log', 'sync_queue'].map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.['n'])).toEqual(before);
  });

  it('the counter reads the reason buttons (today’s until the owner saves) and where the Open shift box starts — never who saved them', async () => {
    const mine = SHOP_SETTING_SAVES().find((p) => (p as { key?: string }).key === 'orders.reasons' && 'value' in (p as object)) as {
      value: { cancel: unknown[]; refund: unknown[]; cashOut: string[] };
    };
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      const rules = await data<{ reasons: { cancel: Array<{ label: string }>; cashOut: string[] } }>('checkout:getRules');
      expect(rules.reasons.cancel.map((r) => r.label)).toEqual([
        'Customer cancelled',
        'Refused at the door',
        'Not collected',
        'Wrong order / duplicate',
        'Out of stock',
      ]);
      expect(rules.reasons.cashOut).toEqual([]);
      // This till closed an earlier shift: the box starts on its count (today's rule).
      expect(await data('shifts:openingFloat')).toMatchObject({ from: 'last_count', lastCount: { countedCashCents: expect.any(Number) } });
    }
    h.session = OWNER;
    expect((await call('settings:setBusiness', mine)).ok).toBe(true);
    expect((await call('settings:setTill', { key: 'drawer.openingFloat', value: { mode: 'fixed', fixedCents: 300_000 } })).ok).toBe(true);
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      const rules = await data<Record<string, unknown>>('checkout:getRules');
      expect(rules).toMatchObject({ reasons: { cancel: mine.value.cancel, refund: mine.value.refund, cashOut: mine.value.cashOut } });
      expect(JSON.stringify(rules)).not.toMatch(/updatedBy|u_admin/i);
      expect(await data('shifts:openingFloat')).toMatchObject({ prefillCents: 300_000, from: 'fixed' });
    }
  });

  it('a cashier gets the owner’s deal on a foodpanda order automatically, and can’t change or take it off without a manager', async () => {
    h.session = OWNER;
    expect((await call('settings:setBusiness', SHOP_SETTING_SAVES()[0])).ok).toBe(true);
    h.session = CASHIER;
    const order = await data<{ id: string }>('orders:create', { mode: 'foodpanda' });
    const deal = () =>
      db.prepare(`SELECT source, value FROM order_discounts WHERE order_id = ? AND deleted_at IS NULL`).all(order.id);
    expect(deal()).toEqual([{ source: 'foodpanda', value: 10 }]);
    const before = writtenRows();
    for (const [channel, payload] of [
      ['orders:applyDiscount', { orderId: order.id, discountType: 'percent', value: 5 }],
      ['orders:clearDiscount', { orderId: order.id }],
    ] as const) {
      expect({ channel, o: await call(channel, payload) }).toMatchObject({ channel, o: { ok: false, code: 'precondition_failed' } });
    }
    // A PIN that is not a manager's is refused too.
    expect(await call('orders:clearDiscount', { orderId: order.id, approverPin: '0000' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(writtenRows()).toEqual(before);
    expect(deal()).toEqual([{ source: 'foodpanda', value: 10 }]);
  });

  it('a value that does not fit is refused with the reason, and nothing is written', async () => {
    h.session = OWNER;
    const before = writtenRows();
    for (const value of [
      { v: 1, percent: 60, shopPercent: 60, minOrderCents: null, maxOffCents: null, startsOn: null, endsOn: null },
      { v: 1, percent: 12.5, shopPercent: 12.5, minOrderCents: null, maxOffCents: null, startsOn: null, endsOn: null },
      { v: 1, percent: 20, shopPercent: 25, minOrderCents: null, maxOffCents: null, startsOn: null, endsOn: null },
      { v: 1, percent: 20, shopPercent: 20, minOrderCents: 12_345, maxOffCents: null, startsOn: null, endsOn: null },
      { v: 1, percent: 20, shopPercent: 20, minOrderCents: null, maxOffCents: null, startsOn: '2026-10-07', endsOn: '2026-10-01' },
      { v: 1, percent: 20, shopPercent: 20, minOrderCents: null, maxOffCents: null, startsOn: null, endsOn: null, extra: true },
      { v: 2, percent: 20, shopPercent: 20, minOrderCents: null, maxOffCents: null, startsOn: null, endsOn: null },
    ]) {
      const o = await call('settings:setBusiness', { key: 'foodpanda.deal', value });
      expect({ value, code: o.ok ? 'ok' : o.code }).toEqual({ value, code: 'validation_failed' });
    }
    expect(await call('settings:setBusiness', { key: 'costing.targets', value: {} })).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(writtenRows()).toEqual(before);
  });
});

describe.skipIf(!Sqlite)('managers keep running the shop; the owner keeps everything', () => {
  /**
   * The lists a login keeps: a manager everything the counter lost but
   * Reports and profit, and what was a manager's before but the printer
   * settings (all the owner's since 2026-09-27); the owner all of it.
   */
  const kept = (who: AuthenticatedUser, managers: Record<string, unknown>, ownerOnly: Record<string, unknown>) =>
    who.role === 'admin' ? { ...managers, ...ownerOnly } : managers;

  for (const who of [MANAGER, OWNER]) {
    it(`${who.role}: every channel the counter lost still works${who.role === 'manager' ? ' (Reports and profit aside)' : ''}`, async () => {
      h.session = who;
      const lockedOut: string[] = [];
      for (const [channel, payload] of Object.entries(kept(who, COUNTER_REFUSED(), { ...REPORTS(), ...PROFIT() }))) {
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

    it(`${who.role}: what was a manager's before still works${who.role === 'manager' ? ' (the printer settings aside)' : ''}`, async () => {
      h.session = who;
      const lockedOut: string[] = [];
      for (const [channel, payload] of Object.entries(kept(who, ALREADY_MANAGERS(), PRINTER_SETTINGS()))) {
        const why = lockedOutBy(channel, await call(channel, payload));
        if (why) lockedOut.push(`${channel} — ${why}`);
      }
      expect(lockedOut).toEqual([]);
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
    expect(lockedOutBy('printer:test', refusal('forbidden', 'Only the owner can change the printers.'))).not.toBeNull();
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
        // Nor its note: the kitchen already has the ticket.
        ['orders:setNote', { orderId: s.kitchenNow, note: 'Too late' }],
        ['orders:setNote', { orderId: s.paidOld, note: 'Too late' }],
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
    // Its note, with no customer typed in: yes, and on the order for the kitchen ticket.
    const noted = await call('orders:setNote', { orderId: s.draft, note: 'Collect by 7pm' });
    expect(noted.ok).toBe(true);
    expect(db.prepare(`SELECT delivery_notes FROM orders WHERE id = ?`).get(s.draft)).toMatchObject({ delivery_notes: 'Collect by 7pm' });
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

/** Every list above, by name (a channel's "home"). */
const classification = (): Record<string, string[]> => ({
  COUNTER_REFUSED: Object.keys(COUNTER_REFUSED()),
  REPORTS: Object.keys(REPORTS()),
  PROFIT: Object.keys(PROFIT()),
  PRINTER_SETTINGS: Object.keys(PRINTER_SETTINGS()),
  OWNER_ONLY: Object.keys(OWNER_ONLY()),
  TEST_ORDERS_OWNER: Object.keys(TEST_ORDERS_OWNER()),
  COUNTER_SCOPED,
  COUNTER_ALLOWED: Object.keys(COUNTER_ALLOWED()),
  ALREADY_MANAGERS: Object.keys(ALREADY_MANAGERS()),
  BEING_ADDED_ELSEWHERE,
});

describe.skipIf(!Sqlite)('every channel is classified', () => {
  it('each channel of these modules is in exactly one list, so a new one must be decided on', () => {
    const lists = classification();
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

describe.skipIf(!Sqlite)('both lines of work, classified where the owner put them (the 0.7.19–0.7.21 release and the test-order / drawer-log / DUPLICATE work)', () => {
  it("each channel is registered and sits in its list; the drawer log, the deleted-test list and profit are the owner's alone", async () => {
    const lists = classification();
    const HOME: Record<string, string> = {
      // The drawer log (0042): Reports, the owner's.
      'reports:drawerLog': 'REPORTS',
      // Test orders (0043): the owner (admin) login, and their PIN to delete.
      'orders:testDeletePreview': 'TEST_ORDERS_OWNER',
      'orders:deleteTest': 'TEST_ORDERS_OWNER',
      'orders:listDeletedTests': 'TEST_ORDERS_OWNER',
      // DUPLICATE: "Try again" on the failed-print note, the papers and the reprint counts.
      'printer:retryJob': 'COUNTER_ALLOWED',
      'printer:orderPapers': 'COUNTER_SCOPED',
      'printer:reprintCounts': 'COUNTER_ALLOWED',
      // 0.7.21: the counter's order note (only on the bill being rung up), the close box.
      'orders:setNote': 'COUNTER_SCOPED',
      'shifts:closeCheck': 'ALREADY_MANAGERS',
      // 0.7.20: profit — Reports' tab and the menu map, and Costing → What-if.
      'reports:profit': 'REPORTS',
      'reports:menuMap': 'REPORTS',
      'costing:whatIf': 'PROFIT',
      'costing:getChannelFees': 'COUNTER_REFUSED',
      'costing:setChannelFees': 'OWNER_ONLY',
      // 0.7.19: the recipe calculator (stock, so managers'), its rupees (costs).
      'inventory:recipeCalc': 'COUNTER_REFUSED',
      'inventory:typicalPicks': 'COUNTER_REFUSED',
      'inventory:printPrepList': 'COUNTER_REFUSED',
      'costing:recipeCalc': 'COUNTER_REFUSED',
    };
    const homes = Object.fromEntries(
      Object.keys(HOME).map((c) => [c, Object.entries(lists).filter(([, l]) => l.includes(c)).map(([n]) => n).join(', ') || '(none)']),
    );
    expect(homes).toEqual(HOME);
    expect(Object.keys(HOME).filter((c) => !h.handlers.has(c))).toEqual([]);

    // Owner-only in the main process: a manager is refused each, the owner gets through.
    const range = REPORT_TODAY();
    const ownerOnly: Array<[string, unknown]> = [
      ['reports:drawerLog', range],
      ['orders:listDeletedTests', range],
      ['reports:profit', range],
      ['reports:menuMap', undefined],
      ['costing:whatIf', { ingredients: [], items: [] }],
    ];
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      for (const [channel, payload] of ownerOnly) {
        const o = await call(channel, payload);
        expect({ channel, who: who.role, code: o.ok ? 'ok' : o.code }).toEqual({ channel, who: who.role, code: 'forbidden' });
      }
    }
    h.session = OWNER;
    for (const [channel, payload] of ownerOnly) {
      const o = await call(channel, payload);
      expect({ channel, ok: o.ok, why: o.ok ? null : o.message }).toEqual({ channel, ok: true, why: null });
    }
  });
});
