/**
 * The owner's automatic offers (Settings → Money & discounts,
 * 'discounts.offers') at their edges, through the real IPC handlers and
 * repositories on a real SQLite database built from every migration. These
 * pin behaviour offers.db.test.ts does not (an independent check found each
 * could be broken with no test failing):
 *   - an offer's most-off is applied end to end (10% capped at Rs 150);
 *   - "once a customer a day" follows the trading day from 05:00 PKT, not
 *     the calendar day;
 *   - a cancelled order, or one where the offer was taken off, does not use
 *     up the day; the same phone typed differently still counts;
 *   - the counter is still told about an offer on its last day;
 *   - the repository itself refuses a came-by change on a sent order without
 *     a manager (the handler checks too).
 * node's own `node:sqlite` stands in for better-sqlite3; skipped where it is
 * missing. Every name, phone and amount is made up.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, ChannelOffer, UUID } from '@cheeseoclock/shared-types';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

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
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
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
    if (pin === 'Test-manager-7') return { approverUserId: 'u_mgr', approverName: 'Test Manager' };
    throw new Error("That is not a manager's PIN or password");
  },
}));
vi.mock('../../services/print-spooler.js', () => ({
  printSpooler: new Proxy({}, { get: () => () => undefined }),
}));
vi.mock('../../services/fbr-worker.js', () => ({ fbrWorker: { kick: () => {}, resetAdapter: () => {} } }));

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
    return (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => RawDb }).DatabaseSync;
  } catch {
    return null;
  }
})();
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'db', 'migrations');

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
const T0 = '2026-01-01T00:00:00.000Z';
const session = (id: string, role: AuthenticatedUser['role']): AuthenticatedUser => ({
  id: id as UUID,
  fullName: id,
  role,
  sessionId: 'sess' as UUID,
});
const CASHIER = session('u_cash', 'cashier');
const OWNER = session('u_admin', 'admin');
const PHONE_A = '03001234567';

let db: ReturnType<typeof openMigrated>;
let menu: { pizza: string; side: string; charge: string };

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

const repos = async () => ({
  ...(await import('../../db/repositories/order-repo.js')),
  ...(await import('../../db/repositories/customer-repo.js')),
});

/** An offer as the owner's card would save it (made-up figures). */
function offer(over: Partial<ChannelOffer> = {}): ChannelOffer {
  return {
    id: 'test-wa',
    name: 'Test WhatsApp 10%',
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
    ...over,
  };
}

/** The owner saves the offers (Settings → Money & discounts). */
async function saveOffers(offers: ChannelOffer[], askCameBy = false): Promise<void> {
  const before = h.session;
  h.session = OWNER;
  try {
    const o = await call('settings:setBusiness', { key: 'discounts.offers', value: { v: 1, askCameBy, offers } });
    expect(o).toMatchObject({ ok: true });
  } finally {
    h.session = before;
  }
}

/** The customer's phone saved on the order, as Pay / Send do (customers:attachToOrder). */
async function savePhone(orderId: string, phone: string, who = CASHIER): Promise<void> {
  const r = await repos();
  const actor = { userId: who.id, deviceId: DEV };
  const found = r.findCustomerByPhone(db as never, phone);
  const c = found ?? r.createCustomer(db as never, { name: 'Test Customer', phone }, actor);
  const a = r.createAddress(db as never, { customerId: c.id, label: 'Home', addressLine: 'House 1, Test Street', area: 'Test Area' }, actor);
  r.snapshotCustomerOntoOrder(db as never, { orderId, customerId: c.id, addressId: a.id }, actor);
}

/**
 * A counter order rung up by the cashier: a Rs 1,000 pizza, two Rs 500 sides
 * (Rs 2,000 of food) and, on a delivery, the area's Rs 200 delivery charge,
 * all at 16%. `startedAt` moves when it was started (for the days, hours
 * and dates). `phone`: the customer's phone saved on it.
 */
async function counterOrder(
  opts: { mode?: 'delivery' | 'takeaway' | 'foodpanda'; cameBy?: string | null; phone?: string | null; startedAt?: string; who?: AuthenticatedUser } = {},
): Promise<string> {
  const mode = opts.mode ?? 'delivery';
  h.session = opts.who ?? CASHIER;
  const order = await data<{ id: string }>('orders:create', { mode, ...(opts.cameBy ? { cameBy: opts.cameBy } : {}) });
  if (opts.startedAt) db.prepare(`UPDATE orders SET created_at = ? WHERE id = ?`).run(opts.startedAt, order.id);
  await data('orders:addItem', { orderId: order.id, menuItemId: menu.pizza, quantity: 1 });
  if (mode === 'delivery') await data('orders:addItem', { orderId: order.id, menuItemId: menu.charge, quantity: 1 });
  await data('orders:addItem', { orderId: order.id, menuItemId: menu.side, quantity: 2 });
  if (opts.phone) await savePhone(order.id, opts.phone, opts.who ?? CASHIER);
  return order.id;
}

const orderRow = (orderId: string) =>
  db.prepare(`SELECT subtotal_cents, discount_cents, tax_cents, total_cents, status, came_by FROM orders WHERE id = ?`).get(orderId);
async function pay(orderId: string, who = CASHIER): Promise<void> {
  const o = orderRow(orderId)!;
  h.session = who;
  await data('orders:tender', {
    orderId,
    payments: [{ method: 'cash', amountCents: Number(o['total_cents']), tenderedCents: Number(o['total_cents']) }],
  });
}
beforeEach(async () => {
  if (!Sqlite) return;
  h.handlers.clear();
  h.session = null;
  db = openMigrated();
  const user = db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_admin', 'Test Owner', 'admin', T0, T0, DEV);
  user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
  user.run('u_cash2', 'Test Cashier Two', 'cashier', T0, T0, DEV);
  user.run('u_mgr', 'Test Manager', 'manager', T0, T0, DEV);
  const d = db as never;
  const mgr = { userId: 'u_mgr', deviceId: DEV };
  const { openShift } = await import('../../db/repositories/shift-repo.js');
  const { createTaxCategory } = await import('../../db/repositories/tax-category-repo.js');
  const { createCategory } = await import('../../db/repositories/category-repo.js');
  const { createMenuItem } = await import('../../db/repositories/menu-item-repo.js');
  openShift(d, { openingCashCents: 0, notes: null }, mgr);
  const tax = createTaxCategory(d, { name: 'Test GST', rateBps: 1_600 }, mgr);
  const food = createCategory(d, { name: 'Test food', displayOrder: 1, colorHex: '#aa5500' }, mgr);
  const fees = createCategory(d, { name: 'Delivery Charges', displayOrder: 2, colorHex: '#555555' }, mgr);
  menu = {
    pizza: createMenuItem(d, { categoryId: food.id, name: 'Test Pizza', basePriceCents: 100_000, taxCategoryId: tax.id }, mgr).id,
    side: createMenuItem(d, { categoryId: food.id, name: 'Test Side', basePriceCents: 50_000, taxCategoryId: tax.id }, mgr).id,
    charge: createMenuItem(d, { categoryId: fees.id, name: 'Delivery Charge (Rs 200)', basePriceCents: 20_000, taxCategoryId: tax.id }, mgr).id,
  };
  const ctx = { db, deviceId: DEV } as never;
  (await import('./orders-handlers.js')).registerOrdersHandlers(ctx);
  (await import('./settings-handlers.js')).registerSettingsHandlers(ctx);
  (await import('./customers-handlers.js')).registerCustomersHandlers(ctx);
});


describe.skipIf(!Sqlite)('automatic offers at the edges: most-off, the 05:00 day, cancelled and declined orders, the last day, the repository lock', () => {
  it('10% capped at Rs 150 stores Rs 150 end to end', async () => {
    await saveOffers([offer({ cameBy: 'any', maxOffCents: 15_000 })]);
    const id = await counterOrder();
    expect(orderRow(id)).toMatchObject({ discount_cents: 15_000 });
  });
  it('once a day, 04:30 PKT then 05:30 PKT the same calendar morning are two trading days: both get it', async () => {
    await saveOffers([offer({ cameBy: 'any', oncePerCustomerPerDay: true })]);
    const a = await counterOrder({ phone: PHONE_A, startedAt: '2026-10-01T23:30:00.000Z' }); // Fri 2 Oct 04:30 PKT = Thu trading day
    await pay(a);
    const b = await counterOrder({ phone: PHONE_A, startedAt: '2026-10-02T00:30:00.000Z' }); // Fri 05:30 PKT
    expect([orderRow(a)!['discount_cents'], orderRow(b)!['discount_cents']]).toEqual([20_000, 20_000]);
  });
  it('once a day, 19:30 PKT and 02:00 PKT the next calendar day are ONE trading day: the second gets none', async () => {
    await saveOffers([offer({ cameBy: 'any', oncePerCustomerPerDay: true })]);
    const a = await counterOrder({ phone: PHONE_A, startedAt: '2026-10-02T14:30:00.000Z' }); // Fri 19:30 PKT
    await pay(a);
    const b = await counterOrder({ phone: PHONE_A, startedAt: '2026-10-02T21:00:00.000Z' }); // Sat 02:00 PKT, Fri trading day
    expect([orderRow(a)!['discount_cents'], orderRow(b)!['discount_cents']]).toEqual([20_000, 0]);
  });
  it('once a day, 06:00 PKT then 13:00 PKT the same trading day: the second gets none', async () => {
    await saveOffers([offer({ cameBy: 'any', oncePerCustomerPerDay: true })]);
    const a = await counterOrder({ phone: PHONE_A, startedAt: '2026-10-02T01:00:00.000Z' });
    await pay(a);
    const b = await counterOrder({ phone: PHONE_A, startedAt: '2026-10-02T08:00:00.000Z' });
    expect([orderRow(a)!['discount_cents'], orderRow(b)!['discount_cents']]).toEqual([20_000, 0]);
  });
  it('a voided order that had the once-a-day offer does not block the next one', async () => {
    await saveOffers([offer({ cameBy: 'any', oncePerCustomerPerDay: true })]);
    const a = await counterOrder({ phone: PHONE_A, startedAt: '2026-10-02T09:00:00.000Z' });
    db.prepare(`UPDATE orders SET status = 'void' WHERE id = ?`).run(a);
    const b = await counterOrder({ phone: PHONE_A, startedAt: '2026-10-02T10:00:00.000Z' });
    expect(orderRow(b)).toMatchObject({ discount_cents: 20_000 });
  });
  it('an order where the cashier took the offer off does not use up the day', async () => {
    await saveOffers([offer({ cameBy: 'any', oncePerCustomerPerDay: true })]);
    const a = await counterOrder({ phone: PHONE_A, startedAt: '2026-10-02T09:00:00.000Z' });
    h.session = CASHIER;
    await data('orders:clearDiscount', { orderId: a });
    await pay(a);
    const b = await counterOrder({ phone: PHONE_A, startedAt: '2026-10-02T10:00:00.000Z' });
    expect(orderRow(b)).toMatchObject({ discount_cents: 20_000 });
  });
  it('the counter is still told about an offer ending today', async () => {
    const last = offer({ id: 'last', name: 'Test last day', endsOn: '2026-10-02' });
    await saveOffers([last]);
    const { checkoutRules } = await import('../../services/shop-settings.js');
    expect(checkoutRules(db as never, new Date('2026-10-02T17:00:00.000Z')).offers).toEqual({ askCameBy: false, offers: [last] });
  });
  it('the same phone typed differently on another order still counts (customer rows are normalised)', async () => {
    await saveOffers([offer({ cameBy: 'any', oncePerCustomerPerDay: true })]);
    const a = await counterOrder({ phone: '0300 1234567', startedAt: '2026-10-02T09:00:00.000Z' });
    await pay(a);
    const b = await counterOrder({ phone: '+92-300-1234567', startedAt: '2026-10-02T10:00:00.000Z' });
    expect([orderRow(a)!['discount_cents'], orderRow(b)!['discount_cents']]).toEqual([20_000, 0]);
  });
  it('the repository refuses a came-by change on a sent order without a manager', async () => {
    await saveOffers([offer()]);
    const id = await counterOrder({ cameBy: 'whatsapp', phone: PHONE_A });
    h.session = CASHIER;
    await data('orders:sendToKitchen', { orderId: id });
    const r = await repos();
    expect(() => r.setOrderCameBy(db as never, id, 'walk_in', { userId: 'u_cash', deviceId: DEV })).toThrow(/locked/);
  });
});
