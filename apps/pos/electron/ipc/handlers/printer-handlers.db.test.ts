/**
 * "Reprint receipt" and "Reprint kitchen ticket" through the real printer IPC
 * handlers, the real reprint service, spooler and print log:
 *  - a cashier gets one copy by hand of a current order's paid receipt; more,
 *    or an order paid long ago, needs a manager's PIN or password — refused
 *    'forbidden' with details.needs 'manager_pin' until one is given;
 *  - the approving manager is kept on the print log and printed on the paper;
 *  - a cashier's own PIN is not a manager's;
 *  - presses while the printer is down give one paper, not one each;
 *  - the kitchen reprint answers what it did, and refuses a cancelled order;
 *  - Order History's counts.
 *
 * Only `defineHandler` is replaced (it captures the handler), the session and
 * the manager check are stand-ins (auth-service owns PINs), the orders are
 * made-up snapshots and the printer is a fake. node's own `node:sqlite`
 * stands in for better-sqlite3; skipped where it is missing.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { escPosToText } from '@cheeseoclock/printer-core';
import type {
  AuthenticatedUser,
  Cents,
  OrderNumber,
  OrderSnapshot,
  PrintResult,
  PrinterConnectionConfig,
  UUID,
} from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../../db/connection.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Handler = (ctx: unknown, payload: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => Promise<unknown>>(),
  session: null as AuthenticatedUser | null,
  sends: [] as Uint8Array[],
  script: [] as Array<() => PrintResult>,
  snapshots: new Map<string, OrderSnapshot>(),
}));

vi.mock('../registry.js', () => {
  class IpcGuardError extends Error {
    readonly apiError: { code: string; message: string; details?: Record<string, unknown> };
    constructor(apiError: { code: string; message: string; details?: Record<string, unknown> }) {
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
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => '' } }));
vi.mock('../../adapters/printer/factory.js', () => ({
  makePrinterAdapter: (config: PrinterConnectionConfig) => ({
    id: 'fake',
    config,
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    send: async (bytes: Uint8Array) => {
      h.sends.push(bytes);
      const next = h.script.shift();
      return next ? next() : { ok: true, durationMs: 1 };
    },
    testPrint: async () => ({ ok: true, durationMs: 1 }),
  }),
}));
vi.mock('../../services/auth-service.js', () => ({
  getCurrentSession: () => h.session,
  verifyManagerPin: async (_db: unknown, pin: string) => {
    if (pin === 'Manager-pass-7') return { approverUserId: 'u_mgr', approverName: 'Sana Khan' };
    throw new Error("That is not a manager's PIN or password");
  },
}));
vi.mock('../../db/repositories/order-repo.js', () => ({
  getOrderSnapshot: (_db: unknown, id: string) => h.snapshots.get(id) ?? null,
  findOrder: (_db: unknown, id: string) => h.snapshots.get(id)?.order ?? null,
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
const T0 = '2026-01-01T00:00:00.000Z';

function openMigrated(): AppDatabase {
  if (!DatabaseSync) throw new Error('node:sqlite unavailable');
  const raw = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  raw.exec('PRAGMA foreign_keys = OFF'); // the orders are made-up snapshots
  raw.prepare(`UPDATE settings SET value_json = ? WHERE key = 'printing.printLogSince'`).run(JSON.stringify(T0));
  const user = raw.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, 'dev-1')`,
  );
  user.run('u_cash', 'Ali Akbar', 'cashier', T0, T0);
  user.run('u_mgr', 'Sana Khan', 'manager', T0, T0);
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
  } as unknown as AppDatabase;
}

const id = (s: string) => s as UUID;
const cents = (n: number) => n as Cents;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const session = (userId: string, role: AuthenticatedUser['role']): AuthenticatedUser => ({
  id: id(userId),
  fullName: userId,
  role,
  sessionId: id(`s-${userId}`),
});

/** A paid takeaway of this shift (taken with no shift open), paid `paidMinutesAgo` ago. */
function order(orderId: string, paidMinutesAgo: number, status: OrderSnapshot['order']['status'] = 'paid'): string {
  const paidAt = minutesAgo(paidMinutesAgo);
  h.snapshots.set(orderId, {
    order: {
      id: id(orderId),
      orderNumber: `20260926-${orderId.slice(-4)}` as OrderNumber,
      mode: 'takeaway',
      status,
      tableId: null,
      customerId: null,
      cashierId: id('u_cash'),
      shiftId: '' as UUID,
      source: 'pos',
      notes: null,
      subtotalCents: cents(100_000),
      discountCents: cents(0),
      taxCents: cents(16_000),
      totalCents: cents(116_000),
      createdAt: minutesAgo(paidMinutesAgo + 5),
      paidAt,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      assignedRiderId: null,
      dispatchedAt: null,
      deliveredAt: null,
    },
    items: [
      {
        id: id(`${orderId}-i1`),
        orderId: id(orderId),
        menuItemId: id('m1'),
        comboId: null,
        parentOrderItemId: null,
        quantity: 1,
        unitPriceCents: cents(100_000),
        lineTotalCents: cents(100_000),
        taxCategoryId: id('t1'),
        notes: null,
        kitchenStatus: 'pending',
        menuItemName: 'Test Pizza',
        categoryName: 'Pizza',
        prepStation: 'kitchen',
        modifiers: [],
      },
    ],
    discounts: [],
    payments: [
      {
        id: id(`${orderId}-p0`),
        orderId: id(orderId),
        method: 'cash',
        amountCents: cents(116_000),
        tenderedCents: null,
        referenceNo: null,
        receivedByUserId: id('u_cash'),
        paidAt,
      },
    ],
    cashierName: 'Ali Akbar',
    tableLabel: null,
    customerName: null,
    customerPhone: null,
    deliveryAddress: null,
    rider: null,
  } as unknown as OrderSnapshot);
  return orderId;
}

let db: AppDatabase;
const call = (channel: string, payload: unknown) => h.handlers.get(channel)!({ db, deviceId: 'dev-1' }, payload);
const last = () => escPosToText(h.sends.at(-1)!);
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string; details?: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    return (e as { apiError: { code: string; message: string; details?: Record<string, unknown> } }).apiError;
  }
  throw new Error('expected a refusal');
}
const logRows = (orderId: string) =>
  db
    .prepare(
      `SELECT print_no, reason, requested_by_user_id AS requestedBy, approved_by_user_id AS approvedBy
         FROM document_prints WHERE order_id = ? ORDER BY created_at, rowid`,
    )
    .all(orderId);

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.sends.length = 0;
  h.script.length = 0;
  h.snapshots.clear();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  db = openMigrated();
  const { printSpooler } = await import('../../services/print-spooler.js');
  printSpooler.init(db, { deviceId: 'dev-1', currentUserId: () => h.session?.id ?? null });
  await printSpooler.whenIdle();
  const { registerPrinterHandlers } = await import('./printer-handlers.js');
  registerPrinterHandlers({ db, deviceId: 'dev-1' } as never);
  h.session = session('u_cash', 'cashier');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const idle = async () => (await import('../../services/print-spooler.js')).printSpooler.whenIdle();

describe.skipIf(!DatabaseSync)('printer:reprint — who may print a paid receipt again', () => {
  it('a cashier: one copy of a current order free, the next needs a manager', async () => {
    const oid = order('o0001', 3);
    await expect(call('printer:reprint', { orderId: oid })).resolves.toEqual({
      ok: true,
      data: { status: 'queued', document: 'receipt', duplicate: false, printNo: 0 },
    });
    await idle();
    const again = await refusal(call('printer:reprint', { orderId: oid }));
    expect(again.code).toBe('forbidden');
    expect(again.details).toMatchObject({ needs: 'manager_pin', document: 'receipt', printNo: 1 });
    expect(again.message).toMatch(/already printed once.*manager's PIN or password/);
    expect(h.sends).toHaveLength(1);
  });

  it('an order paid long ago: refused until a manager approves; the approver is on the log and on the paper', async () => {
    const oid = order('o0002', 120);
    const refused = await refusal(call('printer:reprint', { orderId: oid }));
    expect(refused).toMatchObject({ code: 'forbidden', details: { needs: 'manager_pin' } });
    expect(refused.message).toMatch(/more than 30 minutes ago/);
    await idle();
    expect(h.sends).toHaveLength(0);

    const ok = (await call('printer:reprint', { orderId: oid, approverPin: 'Manager-pass-7' })) as { data: { status: string } };
    expect(ok.data.status).toBe('queued');
    await idle();
    expect(logRows(oid)).toEqual([{ print_no: 0, reason: 'reprint', requestedBy: 'u_cash', approvedBy: 'u_mgr' }]);
    expect(last()).toContain('Printed later:');
    expect(last()).toContain('by Ali Akbar');
    expect(last()).toContain('Approved by: Sana Khan');
  });

  it("a cashier's own PIN is not a manager's", async () => {
    const oid = order('o0003', 120);
    const r = await refusal(call('printer:reprint', { orderId: oid, approverPin: '1234' }));
    expect(r).toMatchObject({ code: 'forbidden', details: { needs: 'manager_pin', wrongSecret: true } });
    expect(r.message).toMatch(/not a manager/);
    await idle();
    expect(h.sends).toHaveLength(0);
  });

  it('a manager is never asked', async () => {
    h.session = session('u_mgr', 'manager');
    const oid = order('o0004', 600);
    for (let i = 0; i < 3; i += 1) {
      await call('printer:reprint', { orderId: oid });
      await idle();
    }
    expect(h.sends).toHaveLength(3);
    expect(last()).toContain('Reprint #2');
  });

  it('the shop copy again is a manager’s — and the first one carries the approver, though it is no DUPLICATE', async () => {
    const oid = order('o0005', 3);
    const r = await refusal(call('printer:reprint', { orderId: oid, copy: 'shop' }));
    // printNo 0: the screen tells the manager this paper will not say DUPLICATE.
    expect(r.details).toMatchObject({ needs: 'manager_pin', printNo: 0 });
    await call('printer:reprint', { orderId: oid, copy: 'shop', approverPin: 'Manager-pass-7' });
    await idle();
    expect(last()).toContain('SHOP COPY');
    expect(last()).toContain('Approved by: Sana Khan');
    expect(last()).not.toContain('DUPLICATE');
    // The second one does say DUPLICATE, and the screen is told so.
    const again = await refusal(call('printer:reprint', { orderId: oid, copy: 'shop' }));
    expect(again.details).toMatchObject({ needs: 'manager_pin', printNo: 1 });
    await call('printer:reprint', { orderId: oid, copy: 'shop', approverPin: 'Manager-pass-7' });
    await idle();
    expect(last()).toContain('DUPLICATE');
    expect(last()).toContain('Approved by: Sana Khan');
  });

  it('three presses while the printer is down: one paper, no free copies slipped through', async () => {
    const oid = order('o0006', 3);
    // Down for every try the presses cause (each press sends the waiting job now).
    for (let i = 0; i < 3; i += 1) {
      h.script.push(() => ({ ok: false, durationMs: 1, error: { code: 'printer_offline', message: 'off', recoverable: true } }));
    }
    const results = [];
    for (let i = 0; i < 3; i += 1) {
      results.push(((await call('printer:reprint', { orderId: oid })) as { data: { status: string } }).data.status);
      await idle();
    }
    expect(results).toEqual(['queued', 'merged', 'merged']);
    // The printer is back.
    db.prepare(`UPDATE print_queue SET next_attempt_at = ? WHERE order_id = ?`).run(new Date(0).toISOString(), oid);
    await idle();
    expect(h.sends).toHaveLength(4); // three failed tries of ONE job, then its paper
    expect(logRows(oid)).toHaveLength(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM print_queue WHERE order_id = ?`).get(oid)).toEqual({ n: 1 });
  });
});

describe.skipIf(!DatabaseSync)('printer:reprintKitchen and printer:reprintCounts', () => {
  it('says what it did; a cancelled order is refused in plain words', async () => {
    const oid = order('o0101', 3, 'preparing');
    const first = (await call('printer:reprintKitchen', { orderId: oid })) as { data: unknown };
    expect(first.data).toEqual({ status: 'queued', document: 'kitchen', duplicate: false, printNo: 0 });
    await idle();
    const second = (await call('printer:reprintKitchen', { orderId: oid })) as { data: { duplicate: boolean } };
    expect(second.data.duplicate).toBe(true);
    await idle();
    expect(last()).toContain('* REPRINT *');
    h.session = session('u_mgr', 'manager');
    h.snapshots.get(oid)!.order.status = 'void';
    await expect(call('printer:reprintKitchen', { orderId: oid })).rejects.toThrow(/cancelled/);
  });

  it('counts DUPLICATEs printed by hand per order, for Order History — not the first paper', async () => {
    h.session = session('u_mgr', 'manager');
    const a = order('o0201', 3);
    const b = order('o0202', 3);
    // Its receipt never printed at the sale: the first press prints the ORIGINAL…
    await call('printer:reprint', { orderId: a });
    await idle();
    expect(last()).not.toContain('DUPLICATE');
    await expect(call('printer:reprintCounts', { orderIds: [a, b] })).resolves.toEqual({ ok: true, data: {} });
    // …the second a DUPLICATE: "Reprinted ×1", and that copy does say DUPLICATE.
    await call('printer:reprint', { orderId: a });
    await idle();
    expect(last()).toContain('DUPLICATE');
    await expect(call('printer:reprintCounts', { orderIds: [a, b] })).resolves.toEqual({ ok: true, data: { [a]: 1 } });
  });

  it('a chef-hat press after tickets that only may have printed says RE-SENT, not REPRINT', async () => {
    const oid = order('o0102', 3, 'preparing');
    h.script.push(() => ({ ok: false, durationMs: 1, error: { code: 'timeout', message: 'cut off', recoverable: false, maybeSent: true } }));
    await call('printer:reprintKitchen', { orderId: oid });
    await idle();
    const r = (await call('printer:reprintKitchen', { orderId: oid })) as { data: unknown };
    expect(r.data).toEqual({ status: 'queued', document: 'kitchen', duplicate: false, resent: true, printNo: 1 });
    await idle();
    expect(last()).toContain('* RE-SENT *');
  });
});
