/**
 * "Was the food made?" through the real orders IPC handlers: the answer is
 * checked at the boundary and reaches the repository, the reply says what the
 * till did to stock, a cancel while the kitchen still has the order queues a
 * CANCELLED kitchen slip, and `orders:stockStatus` reads the question. The
 * stock rules themselves are measured in db/stock-on-cancel.db.test.ts; this
 * pins the wiring.
 *
 * Only `defineHandler` is replaced (it captures the handler instead of
 * registering it with Electron), the session and the manager check are
 * stand-ins (auth-service owns PINs and passwords), FBR's worker is idle, and
 * the printer is a fake. Repositories and the print spooler are the real
 * ones, on node's own `node:sqlite` (better-sqlite3 here is built for
 * Electron) — skipped where that is missing. Names and prices are made up.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AuthenticatedUser,
  OrderSnapshot,
  OrderSnapshotWithStock,
  OrderStockStatus,
  PrinterConnectionConfig,
  UUID,
} from '@cheeseoclock/shared-types';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Handler = (ctx: unknown, payload: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => Promise<unknown>>(),
  session: null as AuthenticatedUser | null,
  sends: [] as Uint8Array[],
  /** The fake printer gives up on everything sent while this is on. */
  printerDown: false,
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
      h.handlers.set(channel, async (ctx, payload) => fn(ctx, payload));
    },
  };
});
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '' },
}));
vi.mock('../../adapters/printer/factory.js', () => ({
  makePrinterAdapter: (config: PrinterConnectionConfig) => ({
    id: 'fake',
    config,
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    send: async (bytes: Uint8Array) => {
      if (h.printerDown) {
        return { ok: false, durationMs: 1, error: { code: 'offline', message: 'Printer offline', recoverable: false } };
      }
      h.sends.push(bytes);
      return { ok: true, durationMs: 1 };
    },
    testPrint: async () => ({ ok: true, durationMs: 1 }),
  }),
}));
vi.mock('../../services/fbr-worker.js', () => ({ fbrWorker: { kick: () => {} } }));
// Who is signed in, and the manager check: auth-service's job, stood in for here.
vi.mock('../../services/auth-service.js', () => ({
  getCurrentSession: () => h.session,
  verifyManagerPin: async (_db: unknown, pin: string) => {
    if (pin === 'Manager-pass-7') return { approverUserId: 'u_mgr', approverName: 'Test Manager' };
    throw new Error("That is not a manager's PIN or password");
  },
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
type RawDbCtor = new (path: string) => RawDb;
let DatabaseSync: RawDbCtor | null = null;
try {
  DatabaseSync = (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: RawDbCtor }).DatabaseSync;
} catch {
  DatabaseSync = null;
}
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

function openMigrated(): RawDb & { transaction: unknown } {
  if (!DatabaseSync) throw new Error('node:sqlite unavailable');
  const raw = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
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
const CASHIER: AuthenticatedUser = { id: 'u_cash' as UUID, fullName: 'Test Cashier', role: 'cashier', sessionId: 's' as UUID };
const MANAGER: AuthenticatedUser = { id: 'u_mgr' as UUID, fullName: 'Test Manager', role: 'manager', sessionId: 's2' as UUID };
const ACTOR = { userId: 'u_cash', deviceId: DEV };
const PIN = 'Manager-pass-7';

let db: ReturnType<typeof openMigrated>;
let cheeseId = '';
let pizzaId = '';
let customerId = '';
let addressId = '';
let riderId = '';

const call = (channel: string, payload: unknown) => {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  return fn({ db, deviceId: DEV }, payload) as Promise<{ ok: true; data: unknown }>;
};
const cheese = () => Number((db.prepare(`SELECT current_qty AS q FROM ingredients WHERE id = ?`).get(cheeseId) as { q: number }).q);
const kitchenJobs = (orderId: string) =>
  (
    db.prepare(`SELECT payload_json AS p FROM print_queue WHERE order_id = ? AND job_kind = 'kitchen' ORDER BY rowid`).all(orderId) as Array<{
      p: string;
    }>
  ).map((r) => JSON.parse(r.p) as { cancelled?: boolean });

/** A takeaway with one pizza (90 g of cheese), rung up and sent through the handlers. */
async function sentOrder(): Promise<string> {
  const r = await import('../../db/repositories/order-repo.js');
  const c = await import('../../db/repositories/customer-repo.js');
  const o = r.createOrder(db as never, { mode: 'takeaway' }, ACTOR);
  c.snapshotCustomerOntoOrder(db as never, { orderId: o.id, customerId, addressId: null }, ACTOR);
  r.addOrderItem(db as never, { orderId: o.id, menuItemId: pizzaId, quantity: 1, modifierIds: [], notes: null }, ACTOR);
  await call('orders:sendToKitchen', { orderId: o.id });
  return o.id;
}

/** A cash-on-delivery order sent, made and handed to a rider, through the handlers. */
async function deliveryOut(): Promise<string> {
  const r = await import('../../db/repositories/order-repo.js');
  const c = await import('../../db/repositories/customer-repo.js');
  const o = r.createOrder(db as never, { mode: 'delivery' }, ACTOR);
  c.snapshotCustomerOntoOrder(db as never, { orderId: o.id, customerId, addressId }, ACTOR);
  r.addOrderItem(db as never, { orderId: o.id, menuItemId: pizzaId, quantity: 1, modifierIds: [], notes: null }, ACTOR);
  await call('orders:sendToKitchen', { orderId: o.id });
  await call('orders:markPreparing', { orderId: o.id });
  await call('orders:markReady', { orderId: o.id });
  await call('orders:assignRider', { orderId: o.id, riderId });
  return o.id;
}

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.sends.length = 0;
  h.printerDown = false;
  h.session = CASHIER;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); // no background ticks
  db = openMigrated();
  const user = db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
  user.run('u_mgr', 'Test Manager', 'manager', T0, T0, DEV);
  const MGR = { userId: 'u_mgr', deviceId: DEV };
  const ing = await import('../../db/repositories/ingredient-repo.js');
  const menu = await import('../../db/repositories/menu-item-repo.js');
  const cat = await import('../../db/repositories/category-repo.js');
  const tax = await import('../../db/repositories/tax-category-repo.js');
  const shift = await import('../../db/repositories/shift-repo.js');
  const cust = await import('../../db/repositories/customer-repo.js');
  // 20 paisa / g, made up.
  cheeseId = ing.createIngredient(db as never, { name: 'Test Cheese', unit: 'g', currentQty: 10_000, costPerUnitCents: 20 }, MGR).id;
  const t = tax.createTaxCategory(db as never, { name: 'Test tax', rateBps: 0 }, MGR);
  const k = cat.createCategory(db as never, { name: 'Test pizzas', displayOrder: 1, colorHex: '#aa5500' }, MGR);
  pizzaId = menu.createMenuItem(db as never, { categoryId: k.id, name: 'Test Pizza', basePriceCents: 100_000, taxCategoryId: t.id }, MGR).id;
  ing.setRecipeForItem(db as never, pizzaId, [{ ingredientId: cheeseId, qtyPerUnit: 90, modifierId: null }], MGR);
  shift.openShift(db as never, { openingCashCents: 0 }, MGR);
  customerId = cust.createCustomer(db as never, { name: 'Test Customer', phone: '03001234567' }, ACTOR).id;
  addressId = cust.createAddress(db as never, { customerId, addressLine: 'House 1, Test Street', area: 'Test Area' }, ACTOR).id;
  const riders = await import('../../db/repositories/rider-repo.js');
  riderId = riders.createRider(db as never, { name: 'Test Rider', phone: '03009876543' }, MGR).id;
  const { setReceiptPrinterConfig } = await import('../../services/printer-config.js');
  setReceiptPrinterConfig(db as never, { transport: 'network', network: { host: '192.0.2.5', port: 9100 }, width: 48 });
  const { printSpooler } = await import('../../services/print-spooler.js');
  printSpooler.init(db as never);
  printSpooler.resetAdapter();
  await printSpooler.whenIdle();
  const { registerOrdersHandlers } = await import('./orders-handlers.js');
  registerOrdersHandlers({ db, deviceId: DEV } as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.skipIf(!DatabaseSync)('orders handlers: "Was the food made?"', () => {
  it('stockStatus reads the question for a sent order', async () => {
    const o = await sentOrder();
    // Queued on send; not printed yet — the one hint worth showing.
    expect(((await call('orders:stockStatus', { orderId: o })).data as OrderStockStatus).kitchenTicket).toBe('not_printed');
    const { printSpooler } = await import('../../services/print-spooler.js');
    await printSpooler.whenIdle();
    const r = await call('orders:stockStatus', { orderId: o });
    const st = r.data as OrderStockStatus;
    expect(st).toMatchObject({ state: 'out', status: 'sent_to_kitchen', kitchenTicket: 'printed' });
    expect(st.question).toMatchObject({ ask: 'choose', preselect: null });
    await expect(call('orders:stockStatus', { orderId: 'no-such-order' })).rejects.toMatchObject({ apiError: { code: 'not_found' } });
    // A manager sees what will move, and what it costs.
    h.session = MANAGER;
    const full = (await call('orders:stockStatus', { orderId: o })).data as OrderStockStatus;
    expect(full.lines.map((l) => [l.name, l.qty, l.estCostCents])).toEqual([['Test Cheese', 90, 1_800]]);
    expect(full).toMatchObject({ estCostCents: 1_800, hasCosts: true, hiddenLines: 0 });
  });

  it('a counter login gets the question, not the ingredients or their cost (owner 2026-09-26)', async () => {
    const o = await sentOrder();
    const st = (await call('orders:stockStatus', { orderId: o })).data as OrderStockStatus;
    expect(st).toMatchObject({ state: 'out', question: { ask: 'choose' }, lines: [], estCostCents: 0, hasCosts: false, hiddenLines: 1 });
    expect(JSON.stringify(st)).not.toContain('Test Cheese');
    // …nor through the reply to the cancel.
    await call('orders:markPreparing', { orderId: o });
    const done = (await call('orders:void', { orderId: o, reason: 'Not collected', approverPin: PIN, foodMade: 'made' }))
      .data as OrderSnapshotWithStock;
    expect(done.stock).toMatchObject({ outcome: 'made', lines: [], wasteCents: 0, hasCosts: false, hiddenLines: 1, wastedLines: 1 });
    expect(JSON.stringify(done.stock)).not.toContain('Test Cheese');
    // The manager, afterwards, in Order History: the whole story, with its cost.
    h.session = MANAGER;
    const after = (await call('orders:stockStatus', { orderId: o })).data as OrderStockStatus;
    expect(after).toMatchObject({ state: 'wasted', answer: 'made', wasteCents: 1_800, hasCosts: true });
  });

  it('a counter login may not read an order from an earlier shift', async () => {
    const o = await sentOrder();
    await call('orders:void', { orderId: o, reason: 'Customer cancelled', approverPin: PIN, foodMade: 'not_made' });
    // Readable at the counter while its shift is open…
    expect(((await call('orders:stockStatus', { orderId: o })).data as OrderStockStatus).state).toBe('returned');
    const shift = await import('../../db/repositories/shift-repo.js');
    const open = shift.getCurrentShift(db as never, DEV)!;
    shift.closeShift(db as never, { shiftId: open.id, countedCashCents: 0 }, { userId: 'u_mgr', deviceId: DEV });
    // …not once the shift is closed (was: any order id, with its costs).
    await expect(call('orders:stockStatus', { orderId: o })).rejects.toMatchObject({ apiError: { code: 'forbidden' } });
    h.session = MANAGER;
    expect(((await call('orders:stockStatus', { orderId: o })).data as OrderStockStatus).state).toBe('returned');
  });

  it('a cancel with no answer, or a made-up one, is refused and changes nothing', async () => {
    const o = await sentOrder();
    const before = cheese();
    for (const foodMade of [undefined, 'maybe', 1]) {
      await expect(
        call('orders:void', { orderId: o, reason: 'Customer cancelled', approverPin: PIN, ...(foodMade !== undefined ? { foodMade } : {}) }),
      ).rejects.toMatchObject({ apiError: { code: 'precondition_failed', message: 'Say whether the food was made' } });
    }
    await expect(
      call('orders:void', { orderId: o, reason: 'x', approverPin: PIN, foodMade: 'made', putBack: 'all' }),
    ).rejects.toMatchObject({ apiError: { code: 'precondition_failed' } });
    await expect(
      call('orders:void', { orderId: o, reason: 'x', approverPin: PIN, foodMade: 'made', expectStatus: 'cooking' }),
    ).rejects.toMatchObject({ apiError: { code: 'precondition_failed' } });
    expect(cheese()).toBe(before);
    const st = (await call('orders:stockStatus', { orderId: o })).data as OrderStockStatus;
    expect(st.status).toBe('sent_to_kitchen');
  });

  it('"Not made" reaches the repository: the stock goes back, the reply says so, the kitchen gets a CANCELLED slip', async () => {
    const o = await sentOrder();
    expect(cheese()).toBe(9_910);
    // The kitchen ticket went out on send (per the default policy).
    expect(kitchenJobs(o)).toHaveLength(1);
    const r = await call('orders:void', {
      orderId: o,
      reason: 'Customer cancelled',
      approverPin: PIN,
      foodMade: 'not_made',
      expectStatus: 'sent_to_kitchen',
    });
    const snap = r.data as OrderSnapshotWithStock;
    expect(snap.order.status).toBe('void');
    expect(snap.stock).toMatchObject({ outcome: 'not_made', answered: 'staff', how: 'cancelled' });
    expect(cheese()).toBe(10_000);
    expect(kitchenJobs(o).map((j) => j.cancelled === true)).toEqual([false, true]);
  });

  it('the kitchen moved on while the dialog was open: refused, "check again"', async () => {
    const o = await sentOrder();
    await call('orders:markPreparing', { orderId: o });
    await expect(
      call('orders:void', { orderId: o, reason: 'x', approverPin: PIN, foodMade: 'not_made', expectStatus: 'sent_to_kitchen' }),
    ).rejects.toMatchObject({ apiError: { code: 'precondition_failed', message: expect.stringMatching(/check again/) } });
    const r = await call('orders:void', { orderId: o, reason: 'x', approverPin: PIN, foodMade: 'made', expectStatus: 'preparing' });
    expect((r.data as OrderSnapshotWithStock).stock).toMatchObject({ outcome: 'made' });
    expect(cheese()).toBe(9_910);
  });

  it('a cancel from ready, or while out with the rider, still gets the kitchen its CANCELLED slip', async () => {
    const { printSpooler } = await import('../../services/print-spooler.js');
    // Ready on the pass.
    const ready = await sentOrder();
    await printSpooler.whenIdle();
    await call('orders:markPreparing', { orderId: ready });
    await call('orders:markReady', { orderId: ready });
    await call('orders:void', { orderId: ready, reason: 'Customer left', approverPin: PIN, foodMade: 'made' });
    await printSpooler.whenIdle();
    expect(kitchenJobs(ready).map((j) => j.cancelled === true)).toEqual([false, true]);

    // Out with the rider.
    const out = await deliveryOut();
    await printSpooler.whenIdle();
    expect(kitchenJobs(out)).toHaveLength(1);
    await call('orders:void', { orderId: out, reason: 'Customer refused at the door', approverPin: PIN, foodMade: 'made' });
    await printSpooler.whenIdle();
    expect(kitchenJobs(out).map((j) => j.cancelled === true)).toEqual([false, true]);
    // And it printed: the kitchen's paper says so.
    const { escPosToText } = await import('@cheeseoclock/printer-core');
    expect(escPosToText(h.sends.at(-1)!)).toContain('* CANCELLED *');
  });

  it('a cancel after the food was served or delivered sends the kitchen nothing — no "DO NOT MAKE" for food already eaten', async () => {
    const { printSpooler } = await import('../../services/print-spooler.js');
    // Takeaway handed over unpaid (collect later), then cancelled: the customer
    // walked off without paying.
    const served = await sentOrder();
    await printSpooler.whenIdle();
    await call('orders:markPreparing', { orderId: served });
    await call('orders:markReady', { orderId: served });
    await call('orders:markServed', { orderId: served });
    // Cash on delivery, delivered, the money never came back.
    const delivered = await deliveryOut();
    await printSpooler.whenIdle();
    await call('orders:markDelivered', { orderId: delivered });
    // Both kitchen tickets printed.
    expect(kitchenJobs(served)).toHaveLength(1);
    expect(kitchenJobs(delivered)).toHaveLength(1);
    const sendsBefore = h.sends.length;

    for (const [orderId, status] of [
      [served, 'served'],
      [delivered, 'delivered'],
    ] as const) {
      const done = (
        await call('orders:void', { orderId, reason: 'Never paid', approverPin: PIN, foodMade: 'made', expectStatus: status })
      ).data as OrderSnapshotWithStock;
      expect(done.order.status).toBe('void');
    }
    await printSpooler.whenIdle();
    expect(kitchenJobs(served).map((j) => j.cancelled === true)).toEqual([false]);
    expect(kitchenJobs(delivered).map((j) => j.cancelled === true)).toEqual([false]);
    // Nothing reached the kitchen printer at all.
    const { escPosToText } = await import('@cheeseoclock/printer-core');
    const after = h.sends.slice(sendsBefore).map((b) => escPosToText(b));
    expect(after.filter((t) => t.includes('CANCELLED') || t.includes('DO NOT MAKE'))).toEqual([]);
  });

  it('no CANCELLED slip for an order the kitchen never got a ticket for', async () => {
    const { getPrintPolicy, setPrintPolicy } = await import('../../services/printer-config.js');
    setPrintPolicy(db as never, { ...getPrintPolicy(db as never), kitchenTicket: false });
    const o = await sentOrder();
    const { printSpooler } = await import('../../services/print-spooler.js');
    await printSpooler.whenIdle();
    await call('orders:markPreparing', { orderId: o });
    await call('orders:markReady', { orderId: o });
    await call('orders:void', { orderId: o, reason: 'Customer left', approverPin: PIN, foodMade: 'made' });
    await printSpooler.whenIdle();
    expect(kitchenJobs(o)).toEqual([]);
  });

  it('a full refund before the food was handed over gets the slip; after it was handed over, none', async () => {
    const { printSpooler } = await import('../../services/print-spooler.js');
    const prepaid = async () => {
      const r = await import('../../db/repositories/order-repo.js');
      const c = await import('../../db/repositories/customer-repo.js');
      const o = r.createOrder(db as never, { mode: 'takeaway' }, ACTOR);
      c.snapshotCustomerOntoOrder(db as never, { orderId: o.id, customerId, addressId: null }, ACTOR);
      r.addOrderItem(db as never, { orderId: o.id, menuItemId: pizzaId, quantity: 1, modifierIds: [], notes: null }, ACTOR);
      await call('orders:tender', { orderId: o.id, payments: [{ method: 'card', amountCents: 100_000 }] });
      await printSpooler.whenIdle();
      await call('orders:markPreparing', { orderId: o.id });
      await call('orders:markReady', { orderId: o.id });
      return o.id;
    };
    // Paid up front, ready on the pass, then refunded in full: the kitchen hears of it.
    const ready = await prepaid();
    await call('orders:refund', { orderId: ready, reason: 'Customer left', approverPin: PIN, foodMade: 'made' });
    await printSpooler.whenIdle();
    expect(kitchenJobs(ready).map((j) => j.cancelled === true)).toEqual([false, true]);
    // Picked up, then refunded: money only.
    const pickedUp = await prepaid();
    await call('orders:markServed', { orderId: pickedUp });
    await call('orders:refund', { orderId: pickedUp, reason: 'Cold', approverPin: PIN, foodMade: 'made' });
    await printSpooler.whenIdle();
    expect(kitchenJobs(pickedUp).map((j) => j.cancelled === true)).toEqual([false]);
  });

  it('a part refund ignores the answer (money only); refunding the rest asks and settles', async () => {
    const r = await import('../../db/repositories/order-repo.js');
    const c = await import('../../db/repositories/customer-repo.js');
    const o = r.createOrder(db as never, { mode: 'takeaway' }, ACTOR);
    c.snapshotCustomerOntoOrder(db as never, { orderId: o.id, customerId, addressId: null }, ACTOR);
    r.addOrderItem(db as never, { orderId: o.id, menuItemId: pizzaId, quantity: 1, modifierIds: [], notes: null }, ACTOR);
    await call('orders:tender', { orderId: o.id, payments: [{ method: 'card', amountCents: 100_000 }] });
    expect(cheese()).toBe(9_910);

    const part = await call('orders:refund', { orderId: o.id, reason: 'Cold', approverPin: PIN, amountCents: 20_000, foodMade: 'made' });
    expect((part.data as OrderSnapshotWithStock).stock).toBeNull();
    expect(cheese()).toBe(9_910);

    await expect(call('orders:refund', { orderId: o.id, reason: 'Cancelled', approverPin: PIN })).rejects.toMatchObject({
      apiError: { message: 'Say whether the food was made' },
    });
    const rest = await call('orders:refund', { orderId: o.id, reason: 'Cancelled', approverPin: PIN, foodMade: 'not_made' });
    expect((rest.data as OrderSnapshotWithStock).order.status).toBe('refunded');
    expect((rest.data as OrderSnapshotWithStock).stock).toMatchObject({ outcome: 'not_made', how: 'refunded' });
    expect(cheese()).toBe(10_000);
  });
});

describe.skipIf(!DatabaseSync)('orders:listActive: "Ticket not printed" (v0.7.33)', () => {
  const board = async (payload?: { mode: 'takeaway' | 'delivery' }) =>
    (await call('orders:listActive', payload)).data as OrderSnapshot[];

  it('marks only the order whose kitchen ticket the printer gave up on; the others are the plain snapshot', async () => {
    const { printSpooler } = await import('../../services/print-spooler.js');
    const { getOrderSnapshot } = await import('../../db/repositories/order-repo.js');
    const printed = await sentOrder();
    await printSpooler.whenIdle();
    h.printerDown = true;
    const failed = await sentOrder();
    await printSpooler.whenIdle();
    h.printerDown = false;

    const cards = await board();
    const card = (id: string) => cards.find((s) => s.order.id === id);
    expect(cards.map((s) => s.order.id).sort()).toEqual([printed, failed].sort());
    expect(card(failed)?.kitchenTicketNotPrinted).toBe(true);
    // Absent, not false, on the others: each is the order as it stands, and nothing else.
    expect(card(printed)).not.toHaveProperty('kitchenTicketNotPrinted');
    expect(card(printed)).toEqual(getOrderSnapshot(db as never, printed));
    expect(card(failed)).toEqual({ ...getOrderSnapshot(db as never, failed), kitchenTicketNotPrinted: true });
    // A mode filter keeps it.
    expect((await board({ mode: 'takeaway' })).find((s) => s.order.id === failed)?.kitchenTicketNotPrinted).toBe(true);

    // Reprint, and it printed: the mark is gone by itself.
    printSpooler.reprintKitchenTicket(failed);
    await printSpooler.whenIdle();
    expect((await board()).filter((s) => 'kitchenTicketNotPrinted' in s)).toEqual([]);
  });

  it('a mark that cannot be read leaves the board as it is, and says so in the log', async () => {
    const { printSpooler } = await import('../../services/print-spooler.js');
    const log = (await import('electron-log/main')).default;
    const warn = vi.spyOn(log, 'warn');
    h.printerDown = true;
    const failed = await sentOrder();
    await printSpooler.whenIdle();
    db.exec('DROP TABLE document_prints');
    const cards = await board();
    expect(cards.map((s) => s.order.id)).toEqual([failed]);
    expect(cards[0]).not.toHaveProperty('kitchenTicketNotPrinted');
    expect(warn).toHaveBeenCalledWith('Kitchen ticket marks not read', expect.objectContaining({ error: expect.any(String) }));
  });
});

describe.skipIf(!DatabaseSync)('orders:create drops this till’s emptied cart, never reuses it (owner 2026-10-02)', () => {
  interface Created {
    id: string;
    orderNumber: string;
  }
  const create = async (payload: Record<string, unknown> = { mode: 'takeaway' }) =>
    (await call('orders:create', payload)).data as Created;
  const row = (id: string) =>
    db.prepare(`SELECT status, deleted_at AS deletedAt FROM orders WHERE id = ?`).get(id) as {
      status: string;
      deletedAt: string | null;
    };
  const discards = (id: string) =>
    db.prepare(`SELECT action FROM audit_log WHERE entity_type = 'orders' AND entity_id = ? AND action = 'discard_empty_draft'`).all(id);
  const deletes = (id: string) =>
    db.prepare(`SELECT op FROM sync_queue WHERE entity_type = 'orders' AND entity_id = ? AND op = 'delete'`).all(id);
  /** A counter cart rung up and then emptied by hand, through the handlers. */
  const emptiedCart = async (): Promise<Created> => {
    const o = await create();
    const added = (await call('orders:addItem', { orderId: o.id, menuItemId: pizzaId, quantity: 1, modifierIds: [] }))
      .data as OrderSnapshot;
    const line = added.items[0]!;
    const left = (await call('orders:removeItem', { orderId: o.id, orderItemId: line.id })).data as OrderSnapshot;
    expect(left.items).toEqual([]);
    expect(left.order.status).toBe('open');
    return o;
  };

  it('the emptied #0001 is dropped (audit discard_empty_draft, synced as a delete) and the new cart is #0002', async () => {
    const first = await emptiedCart();
    expect(first.orderNumber).toMatch(/-0001$/);
    const next = await create({ mode: 'delivery', cameBy: 'phone' });
    expect(next.orderNumber).toMatch(/-0002$/);
    expect(next.id).not.toBe(first.id);
    expect(row(first.id).deletedAt).not.toBeNull();
    expect(discards(first.id)).toHaveLength(1);
    expect(deletes(first.id)).toHaveLength(1);
    // The new cart is the one in hand: open, not dropped, and what the restart would pick back up once it has a line.
    expect(row(next.id)).toEqual({ status: 'open', deletedAt: null });
    expect(discards(next.id)).toEqual([]);
  });

  it('leaves alone: a cart with a line, another till’s empty cart, sent orders and website orders', async () => {
    const r = await import('../../db/repositories/order-repo.js');
    // A cart on this till with something in it (a draft the restart would bring back).
    const held = r.createOrder(db as never, { mode: 'takeaway' }, ACTOR);
    r.addOrderItem(db as never, { orderId: held.id, menuItemId: pizzaId, quantity: 1, modifierIds: [], notes: null }, ACTOR);
    // The other till's empty cart (arrived by sync): that cashier's screen, not this one.
    const otherTill = r.createOrder(db as never, { mode: 'takeaway' }, { userId: 'u_cash', deviceId: 'dev-till-2' });
    // A sent order; even one whose lines are all gone (made by hand here) is never a cart.
    const sent = await sentOrder();
    db.prepare(`UPDATE order_items SET deleted_at = ? WHERE order_id = ?`).run(T0, sent);
    // A website order the bridge started on this till, still empty and open.
    const web = r.createOrder(db as never, { mode: 'delivery', source: 'web' }, ACTOR);

    await create();
    for (const id of [held.id, otherTill.id, sent, web.id]) {
      expect(row(id).deletedAt).toBeNull();
      expect(discards(id)).toEqual([]);
      expect(deletes(id)).toEqual([]);
    }
    expect(row(sent).status).toBe('sent_to_kitchen');
    expect(row(web.id).status).toBe('open');
  });

  it('a create that fails drops nothing: the emptied cart and the number stay as they were', async () => {
    const first = await emptiedCart();
    // No such table: the new order cannot be written.
    await expect(create({ mode: 'dine_in', tableId: 'no-such-table' })).rejects.toThrow();
    expect(row(first.id)).toEqual({ status: 'open', deletedAt: null });
    expect(discards(first.id)).toEqual([]);
    expect(deletes(first.id)).toEqual([]);
    // The next good create drops it then, and takes the number the failed try did not use.
    const next = await create();
    expect(next.orderNumber).toMatch(/-0002$/);
    expect(row(first.id).deletedAt).not.toBeNull();
  });
});

describe.skipIf(!DatabaseSync)('orders:sendOut: the bill goes with the food, once across both tills (owner 2026-10-02)', () => {
  const OTHER_TILL = 'dev-till-2';
  let chargeId = '';
  beforeEach(async () => {
    if (!DatabaseSync) return;
    const MGR = { userId: 'u_mgr', deviceId: DEV };
    const tax = await import('../../db/repositories/tax-category-repo.js');
    const cat = await import('../../db/repositories/category-repo.js');
    const menu = await import('../../db/repositories/menu-item-repo.js');
    const t = tax.createTaxCategory(db as never, { name: 'Test no tax', rateBps: 0 }, MGR);
    const fees = cat.createCategory(db as never, { name: 'Delivery Charges', displayOrder: 2, colorHex: '#555555' }, MGR);
    chargeId = menu.createMenuItem(
      db as never,
      { categoryId: fees.id, name: 'Delivery Charge (Rs 200)', basePriceCents: 20_000, taxCategoryId: t.id },
      MGR,
    ).id;
  });

  const idle = async () => (await import('../../services/print-spooler.js')).printSpooler.whenIdle();
  /** A cash-on-delivery order (the pizza and the area's Rs 200 charge: Rs 1,200), sent, made and ready on the pass, its kitchen ticket printed. */
  async function readyDelivery(): Promise<string> {
    const r = await import('../../db/repositories/order-repo.js');
    const c = await import('../../db/repositories/customer-repo.js');
    const o = r.createOrder(db as never, { mode: 'delivery' }, ACTOR);
    c.snapshotCustomerOntoOrder(db as never, { orderId: o.id, customerId, addressId }, ACTOR);
    r.addOrderItem(db as never, { orderId: o.id, menuItemId: pizzaId, quantity: 1, modifierIds: [], notes: null }, ACTOR);
    r.addOrderItem(db as never, { orderId: o.id, menuItemId: chargeId, quantity: 1, modifierIds: [], notes: null }, ACTOR);
    await call('orders:sendToKitchen', { orderId: o.id });
    await call('orders:markPreparing', { orderId: o.id });
    await call('orders:markReady', { orderId: o.id });
    await idle();
    return o.id;
  }
  const sendOut = async (orderId: string) => (await call('orders:sendOut', { orderId })).data as OrderSnapshot;
  /** This till's receipt jobs for the order: [reason, copies]. */
  const receiptJobs = (orderId: string) =>
    db
      .prepare(`SELECT payload_json AS p FROM print_queue WHERE order_id = ? AND job_kind = 'receipt' ORDER BY rowid`)
      .all(orderId)
      .map((r) => {
        const p = JSON.parse(String(r['p'])) as { reason: string; copies: string[] };
        return [p.reason, p.copies];
      });
  const drawerJobs = (orderId: string) =>
    Number(db.prepare(`SELECT COUNT(*) AS n FROM print_queue WHERE order_id = ? AND job_kind = 'drawer'`).get(orderId)?.['n']);
  /** The order's papers in the print log, both tills': what, which copy, and which till ('here' or 'other till'). */
  const papers = (orderId: string) =>
    db
      .prepare(
        `SELECT reason, document, copy, device_id AS device FROM document_prints
          WHERE order_id = ? AND deleted_at IS NULL AND copy <> 'kitchen' ORDER BY created_at, rowid`,
      )
      .all(orderId)
      .map((p) => ({
        reason: p['reason'],
        document: p['document'],
        copy: p['copy'],
        till: p['device'] === OTHER_TILL ? 'other till' : 'here',
      }));
  /** A paper the other till printed for the order, as sync brings it here (by default: its bill for the trip). */
  const fromOtherTill = (
    orderId: string,
    p: { reason?: string; outcome?: 'printed' | 'unsure'; deletedAt?: string | null } = {},
  ) => {
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO document_prints
         (id, order_id, document, doc_key, copy, print_no, outcome, reason, print_job_id,
          created_at, updated_at, synced_at, deleted_at, device_id, version)
       VALUES (?, ?, 'bill', 'bill', 'customer', 0, ?, ?, 'job-on-till-2', ?, ?, ?, ?, ?, 1)`,
    ).run(`dp-${orderId}-${p.reason ?? 'dispatch'}-${p.deletedAt ? 'gone' : 'kept'}`, orderId, p.outcome ?? 'printed', p.reason ?? 'dispatch', at, at, at, p.deletedAt ?? null, OTHER_TILL);
  };

  it('Send out: out for delivery with no rider, what he keeps on the reply; one bill and its SHOP COPY, reason dispatch, no drawer', async () => {
    const o = await readyDelivery();
    const sendsBefore = h.sends.length;
    const snap = await sendOut(o);
    expect(snap.order).toMatchObject({ status: 'out_for_delivery', assignedRiderId: null, riderKeepsCents: 20_000, totalCents: 120_000 });
    expect(snap.order.dispatchedAt).toEqual(expect.any(String));
    await idle();
    expect(receiptJobs(o)).toEqual([['dispatch', ['customer', 'shop']]]);
    expect(papers(o)).toEqual([
      { reason: 'dispatch', document: 'bill', copy: 'customer', till: 'here' },
      { reason: 'dispatch', document: 'bill', copy: 'shop', till: 'here' },
    ]);
    const { escPosToText } = await import('@cheeseoclock/printer-core');
    const out = h.sends.slice(sendsBefore).map((b) => escPosToText(b));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('SHOP COPY');
    // No money moved: no drawer.
    expect(drawerJobs(o)).toBe(0);
  });

  it('Send out, then Assign rider: an own rider now (nothing kept), and no second bill', async () => {
    const o = await readyDelivery();
    await sendOut(o);
    await idle();
    const sendsBefore = h.sends.length;
    const assigned = (await call('orders:assignRider', { orderId: o, riderId })).data as OrderSnapshot;
    expect(assigned.order).toMatchObject({ status: 'out_for_delivery', assignedRiderId: riderId });
    expect(assigned.order).not.toHaveProperty('riderKeepsCents');
    await idle();
    expect(receiptJobs(o)).toEqual([['dispatch', ['customer', 'shop']]]);
    expect(h.sends.length).toBe(sendsBefore);
  });

  it('Send out, Back to Ready, Send out again: still one bill', async () => {
    const o = await readyDelivery();
    await sendOut(o);
    await idle();
    const sendsBefore = h.sends.length;
    const back = (await call('orders:unassignRider', { orderId: o })).data as OrderSnapshot;
    expect(back.order).toMatchObject({ status: 'ready', assignedRiderId: null });
    expect(back.order).not.toHaveProperty('riderKeepsCents');
    expect((await sendOut(o)).order).toMatchObject({ status: 'out_for_delivery', assignedRiderId: null, riderKeepsCents: 20_000 });
    await idle();
    expect(receiptJobs(o)).toEqual([['dispatch', ['customer', 'shop']]]);
    expect(papers(o).map((p) => p['reason'])).toEqual(['dispatch', 'dispatch']);
    expect(h.sends.length).toBe(sendsBefore);
  });

  it('with "Print the delivery bill when it leaves" off, Send out prints nothing', async () => {
    const { getPrintPolicy, setPrintPolicy } = await import('../../services/printer-config.js');
    setPrintPolicy(db as never, { ...getPrintPolicy(db as never), deliveryBillOnDispatch: false });
    const o = await readyDelivery();
    const sendsBefore = h.sends.length;
    expect((await sendOut(o)).order).toMatchObject({ status: 'out_for_delivery', riderKeepsCents: 20_000 });
    await idle();
    expect(receiptJobs(o)).toEqual([]);
    expect(papers(o)).toEqual([]);
    expect(h.sends.length).toBe(sendsBefore);
  });

  it("the other till's bill for the trip stops the bill here, and the receipt when the rider brings the money back", async () => {
    // Sent out on the other till, which printed the bill: Send out here prints nothing.
    const a = await readyDelivery();
    fromOtherTill(a);
    const sendsBefore = h.sends.length;
    expect((await sendOut(a)).order.status).toBe('out_for_delivery');
    await idle();
    expect(receiptJobs(a)).toEqual([]);
    expect(h.sends.length).toBe(sendsBefore);

    // The other till's bill left with the food; here a rider is assigned and
    // brings the cash back: the drawer opens, and that is all.
    const b = await readyDelivery();
    fromOtherTill(b);
    await call('orders:assignRider', { orderId: b, riderId });
    await idle();
    expect(receiptJobs(b)).toEqual([]);
    const sendsBeforeCash = h.sends.length;
    const paid = (
      await call('orders:markDelivered', { orderId: b, payment: { method: 'cash', amountCents: 120_000, tenderedCents: 120_000 } })
    ).data as OrderSnapshot;
    expect(paid.order.status).toBe('paid');
    await idle();
    expect(drawerJobs(b)).toBe(1);
    expect(receiptJobs(b)).toEqual([]);
    expect(h.sends.length).toBe(sendsBeforeCash + 1);
    expect(papers(b)).toEqual([{ reason: 'dispatch', document: 'bill', copy: 'customer', till: 'other till' }]);
  });

  it("only the other till's bill for the trip counts: one that may have printed does; a reprint or a deleted row does not", async () => {
    const { hasLoggedPaper } = await import('../../db/repositories/document-print-repo.js');
    // It may have printed there (the printer failed mid-way): no second bill here.
    const unsure = await readyDelivery();
    fromOtherTill(unsure, { outcome: 'unsure' });
    expect(hasLoggedPaper(db as never, unsure, 'dispatch')).toBe(true);
    await sendOut(unsure);
    await idle();
    expect(receiptJobs(unsure)).toEqual([]);

    // A copy printed there by hand, and a bill row since deleted: the bill still goes with the food here.
    const other = await readyDelivery();
    fromOtherTill(other, { reason: 'reprint' });
    fromOtherTill(other, { deletedAt: T0 });
    expect(hasLoggedPaper(db as never, other, 'dispatch')).toBe(false);
    expect(hasLoggedPaper(db as never, other, 'reprint')).toBe(true);
    await sendOut(other);
    await idle();
    expect(receiptJobs(other)).toEqual([['dispatch', ['customer', 'shop']]]);
  });

  it('a print log that cannot be read never stops Send out: this till decides the bill by itself, and says so in the log', async () => {
    const log = (await import('electron-log/main')).default;
    const warn = vi.spyOn(log, 'warn');
    const o = await readyDelivery();
    db.exec('DROP TABLE document_prints');
    expect((await sendOut(o)).order).toMatchObject({ status: 'out_for_delivery', riderKeepsCents: 20_000 });
    expect(receiptJobs(o)).toEqual([['dispatch', ['customer', 'shop']]]);
    expect(warn).toHaveBeenCalledWith(
      'Print log unreadable; the delivery bill decided by this till alone',
      expect.objectContaining({ orderId: o, error: expect.any(String) }),
    );
    await idle();
  });

  it('refusals come back as "precondition_failed" with the repository\'s words, and print nothing', async () => {
    const takeaway = await sentOrder();
    await expect(call('orders:sendOut', { orderId: takeaway })).rejects.toMatchObject({
      apiError: { code: 'precondition_failed', message: 'Only delivery orders can be sent out' },
    });
    const o = await readyDelivery();
    await sendOut(o);
    await idle();
    await expect(call('orders:sendOut', { orderId: o })).rejects.toMatchObject({
      apiError: { code: 'precondition_failed', message: 'This order is already out for delivery' },
    });
    await expect(call('orders:sendOut', { orderId: 'no-such-order' })).rejects.toMatchObject({
      apiError: { code: 'precondition_failed', message: 'Order not found' },
    });
    await idle();
    expect(receiptJobs(takeaway)).toEqual([]);
    expect(receiptJobs(o)).toEqual([['dispatch', ['customer', 'shop']]]);
  });
});
