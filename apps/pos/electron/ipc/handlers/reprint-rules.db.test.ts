/**
 * The owner's reprint rule (Settings → Staff & kitchen timing, 'staff.timing'
 * freeReprints and reprintWindowMin) through the real printer IPC handler,
 * reprint service, spooler and print log: the service reads the saved value
 * on every press, so a cashier's free papers and the free-reprint window
 * follow what the owner saved — and the marks on the paper (DUPLICATE,
 * "Printed later") and the print log are the same as before.
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

async function saveStaffTiming(freeReprints: number, reprintWindowMin: number): Promise<void> {
  const { setBusinessSetting } = await import('../../db/repositories/business-settings-repo.js');
  setBusinessSetting(
    db,
    'staff.timing',
    { v: 1, idleLogoutMin: 15, maxLoginHours: 12, stepInMin: 10, freeReprints, reprintWindowMin },
    { userId: 'u_mgr', deviceId: 'dev-1' },
  );
}

describe.skipIf(!DatabaseSync)('printer:reprint follows the owner’s reprint rule', () => {
  it('two free papers: the second copy by hand is free, the third needs a manager', async () => {
    await saveStaffTiming(2, 30);
    const oid = order('o0101', 3);
    for (const printNo of [0, 1]) {
      await expect(call('printer:reprint', { orderId: oid })).resolves.toMatchObject({ ok: true, data: { status: 'queued', printNo } });
      await idle();
    }
    const third = await refusal(call('printer:reprint', { orderId: oid }));
    expect(third).toMatchObject({ code: 'forbidden', details: { needs: 'manager_pin', printNo: 2 } });
    expect(third.message).toMatch(/already printed 2 times/);
    // The second paper is a DUPLICATE, as every second copy always was.
    expect(last()).toContain('DUPLICATE');
    expect(h.sends).toHaveLength(2);
  });

  it('none free: the first paper still prints, any copy after it needs a manager', async () => {
    await saveStaffTiming(0, 30);
    const oid = order('o0102', 3);
    await expect(call('printer:reprint', { orderId: oid })).resolves.toMatchObject({ ok: true, data: { printNo: 0 } });
    await idle();
    const again = await refusal(call('printer:reprint', { orderId: oid }));
    expect(again).toMatchObject({ code: 'forbidden', details: { needs: 'manager_pin', printNo: 1 } });
    const ok = (await call('printer:reprint', { orderId: oid, approverPin: 'Manager-pass-7' })) as { data: { status: string } };
    expect(ok.data.status).toBe('queued');
    await idle();
    expect(logRows(oid)).toEqual([
      { print_no: 0, reason: 'reprint', requestedBy: 'u_cash', approvedBy: null },
      { print_no: 1, reason: 'reprint', requestedBy: 'u_cash', approvedBy: 'u_mgr' },
    ]);
  });

  it('a 60-minute window: paid 45 minutes ago is free; 61 minutes needs a manager, and says 60', async () => {
    await saveStaffTiming(1, 60);
    const recent = order('o0103', 45);
    await expect(call('printer:reprint', { orderId: recent })).resolves.toMatchObject({ ok: true, data: { status: 'queued' } });
    await idle();
    // The mark is the released one: a first paper by hand this long after the sale still says so.
    expect(last()).toContain('Printed later:');
    const old = order('o0104', 61);
    const refused = await refusal(call('printer:reprint', { orderId: old }));
    expect(refused).toMatchObject({ code: 'forbidden', details: { needs: 'manager_pin' } });
    expect(refused.message).toMatch(/more than 60 minutes ago/);
  });

  it('nothing saved: today’s rule (one copy, 30 minutes) — the same presses as before', async () => {
    const recent = order('o0105', 45);
    const refused = await refusal(call('printer:reprint', { orderId: recent }));
    expect(refused.message).toMatch(/more than 30 minutes ago/);
    const current = order('o0106', 3);
    await expect(call('printer:reprint', { orderId: current })).resolves.toMatchObject({ ok: true });
    await idle();
    expect((await refusal(call('printer:reprint', { orderId: current }))).message).toMatch(/already printed once/);
  });
});
