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

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.sends.length = 0;
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
