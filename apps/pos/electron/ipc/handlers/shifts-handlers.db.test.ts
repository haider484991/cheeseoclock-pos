/**
 * The cash drawer through the real shifts IPC handlers: opening a shift (to
 * put the float in) and a recorded cash in / cash out / rider tip each pulse
 * the drawer exactly once; anything refused pulses nothing. The rules for
 * WHEN the pulse goes are tested in print-spooler.db.test.ts; this pins the
 * handlers' wiring, so moving or dropping a kickDrawerSoon() fails here.
 * Also the close box's order counts as 'shifts:summary' gives them.
 *
 * Only `defineHandler` is replaced (it captures the handler instead of
 * registering it with Electron), the session and the manager check are
 * stand-ins (auth-service owns PINs and passwords), and the printer is a fake
 * that records what it is sent. The shift repository and the print spooler
 * are the real ones, on node's own `node:sqlite` (better-sqlite3 here is
 * built for Electron) — skipped where that is missing. Names are made up.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, PrintResult, PrinterConnectionConfig, UUID } from '@cheeseoclock/shared-types';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Handler = (ctx: unknown, payload: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => Promise<unknown>>(),
  session: null as AuthenticatedUser | null,
  sends: [] as Array<{ bytes: Uint8Array; opts: { drawer?: boolean } | undefined }>,
  script: [] as Array<() => PrintResult>,
  /** What the till windows were told (`printer:failed` toasts). */
  events: [] as Array<{ channel: string; payload: Record<string, unknown> }>,
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
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload: Record<string, unknown>) => h.events.push({ channel, payload }),
        },
      },
    ],
  },
  app: { getPath: () => '' },
}));
vi.mock('../../adapters/printer/factory.js', () => ({
  makePrinterAdapter: (config: PrinterConnectionConfig) => ({
    id: 'fake',
    config,
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    send: async (bytes: Uint8Array, opts?: { drawer?: boolean }) => {
      h.sends.push({ bytes, opts });
      const next = h.script.shift();
      return next ? next() : { ok: true, durationMs: 1 };
    },
    testPrint: async () => ({ ok: true, durationMs: 1 }),
  }),
}));
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
const session = (id: string, role: AuthenticatedUser['role']): AuthenticatedUser => ({
  id: id as UUID,
  fullName: id,
  role,
  sessionId: 'sess' as UUID,
});
const CASHIER = session('u_cash', 'cashier');
const MANAGER = session('u_mgr', 'manager');

let db: ReturnType<typeof openMigrated>;
let kickSoon: ReturnType<typeof vi.fn>;

const call = (channel: string, payload: unknown) => {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  return fn({ db, deviceId: DEV }, payload);
};
const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
/** Pulses the fake printer got, once the spooler has had time to send what it was asked to. */
async function pulses(expected: number): Promise<number> {
  await vi.waitFor(() => expect(h.sends.length).toBeGreaterThanOrEqual(expected));
  // Anything more would already be on its way: give it a moment to show up.
  await new Promise((r) => setTimeout(r, 20));
  return h.sends.filter((s) => s.opts?.drawer === true).length;
}

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.sends.length = 0;
  h.script.length = 0;
  h.events.length = 0;
  h.session = null;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); // no background ticks
  db = openMigrated();
  const user = db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
  user.run('u_mgr', 'Test Manager', 'manager', T0, T0, DEV);
  const { setReceiptPrinterConfig } = await import('../../services/printer-config.js');
  setReceiptPrinterConfig(db as never, { transport: 'network', network: { host: '192.0.2.5', port: 9100 }, width: 48 });
  const { printSpooler } = await import('../../services/print-spooler.js');
  printSpooler.init(db as never);
  printSpooler.resetAdapter();
  await printSpooler.whenIdle();
  kickSoon = vi.spyOn(printSpooler, 'kickDrawerSoon') as unknown as ReturnType<typeof vi.fn>;
  const { registerShiftsHandlers } = await import('./shifts-handlers.js');
  registerShiftsHandlers({ db, deviceId: DEV } as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.skipIf(!DatabaseSync)('shifts handlers open the cash drawer', () => {
  it('opening a shift pulses it once, for the float', async () => {
    h.session = MANAGER;
    const r = (await call('shifts:open', { openingCashCents: 500_000 })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(kickSoon).toHaveBeenCalledTimes(1);
    expect(await pulses(1)).toBe(1);
  });

  it('a refused shift open (one is already open) pulses nothing', async () => {
    h.session = MANAGER;
    await call('shifts:open', { openingCashCents: 0 });
    await pulses(1);
    kickSoon.mockClear();
    h.sends.length = 0;
    await expect(call('shifts:open', { openingCashCents: 0 })).rejects.toMatchObject({
      apiError: { code: 'precondition_failed' },
    });
    expect(kickSoon).not.toHaveBeenCalled();
    expect(await pulses(0)).toBe(0);
  });

  it('each recorded cash in, cash out and rider tip pulses it once', async () => {
    h.session = MANAGER;
    await call('shifts:open', { openingCashCents: 0 });
    await pulses(1);
    for (const [type, n] of [
      ['payin', 2],
      ['payout', 3],
      ['tip_out', 4],
    ] as const) {
      const r = (await call('shifts:recordCashMovement', {
        type,
        amountCents: 50_000,
        reason: 'Change from bank',
      })) as { ok: boolean };
      expect(r.ok).toBe(true);
      expect(kickSoon).toHaveBeenCalledTimes(n);
      expect(await pulses(n)).toBe(n);
    }
    expect(count(`SELECT COUNT(*) AS n FROM cash_movements`)).toBe(3);
  });

  it('a cashier with a manager password records it, and the drawer opens once', async () => {
    h.session = MANAGER;
    await call('shifts:open', { openingCashCents: 0 });
    await pulses(1);
    h.session = CASHIER;
    const r = (await call('shifts:recordCashMovement', {
      type: 'payout',
      amountCents: 20_000,
      reason: 'Gas cylinder',
      approverPin: 'Manager-pass-7',
    })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(await pulses(2)).toBe(2);
  });

  it('a refused cash in / out pulses nothing and records nothing', async () => {
    h.session = MANAGER;
    await call('shifts:open', { openingCashCents: 0 });
    await pulses(1);
    kickSoon.mockClear();
    h.sends.length = 0;

    h.session = CASHIER;
    // No manager PIN, then a wrong one.
    await expect(
      call('shifts:recordCashMovement', { type: 'payout', amountCents: 20_000, reason: 'Gas' }),
    ).rejects.toMatchObject({ apiError: { code: 'precondition_failed' } });
    await expect(
      call('shifts:recordCashMovement', { type: 'payout', amountCents: 20_000, reason: 'Gas', approverPin: '0000' }),
    ).rejects.toMatchObject({ apiError: { code: 'forbidden' } });
    // A manager, but the amount is not above zero.
    h.session = MANAGER;
    await expect(
      call('shifts:recordCashMovement', { type: 'payin', amountCents: 0, reason: 'Change' }),
    ).rejects.toMatchObject({ apiError: { code: 'precondition_failed' } });

    expect(kickSoon).not.toHaveBeenCalled();
    expect(await pulses(0)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM cash_movements`)).toBe(0);
  });

  it('with no shift open, a cash in is refused and nothing opens', async () => {
    h.session = MANAGER;
    await expect(
      call('shifts:recordCashMovement', { type: 'payin', amountCents: 10_000, reason: 'Change' }),
    ).rejects.toMatchObject({ apiError: { code: 'precondition_failed' } });
    expect(kickSoon).not.toHaveBeenCalled();
    expect(await pulses(0)).toBe(0);
  });

  it('a printer failure does not undo the shift: it is open, and the till is told', async () => {
    h.session = MANAGER;
    h.script.push(() => ({
      ok: false,
      durationMs: 1,
      error: { code: 'network_error', message: 'connect EHOSTUNREACH 192.0.2.5:9100', recoverable: true },
    }));
    const r = (await call('shifts:open', { openingCashCents: 100_000 })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(await pulses(1)).toBe(1); // tried once, not again
    expect(count(`SELECT COUNT(*) AS n FROM shifts WHERE closed_at IS NULL`)).toBe(1);
    await vi.waitFor(() => expect(h.events).toHaveLength(1));
    expect(h.events[0]).toMatchObject({
      channel: 'printer:failed',
      payload: { jobKind: 'drawer', retrying: false, error: { code: 'drawer_not_opened' } },
    });
  });
});

describe.skipIf(!DatabaseSync)("shifts:summary, the close box's counts", () => {
  it("the close box's Paid orders and Refunds count the orders settled in the shift, refunded ones still paid (step 19d-1)", async () => {
    // Updated on purpose (step 19d-1): Paid orders used to count the orders
    // STARTED in the shift that were paid and not refunded, whenever and
    // wherever they were paid, and Refunds only the full ones. Now both count
    // what the shift report counts: the orders whose money was taken in this
    // shift (refunded ones stay in), and the orders money went back for in
    // it, in full or in part. Before, the first shift read 2 paid · 1 refund
    // and the second 0 · 0.
    h.session = MANAGER;
    const staff = { userId: 'u_cash', deviceId: DEV };
    const boss = { userId: 'u_mgr', deviceId: DEV };
    const { createTaxCategory } = await import('../../db/repositories/tax-category-repo.js');
    const { createCategory } = await import('../../db/repositories/category-repo.js');
    const { createMenuItem } = await import('../../db/repositories/menu-item-repo.js');
    const r = await import('../../db/repositories/order-repo.js');
    const tax = createTaxCategory(db as never, { name: 'Test GST', rateBps: 1_500 }, boss);
    const food = createCategory(db as never, { name: 'Test Burgers', displayOrder: 1, colorHex: '#aa5500' }, boss);
    const burger = createMenuItem(db as never, { categoryId: food.id, name: 'Test Zinger Burger', basePriceCents: 100_000, taxCategoryId: tax.id }, boss).id;
    const ring = () => {
      const o = r.createOrder(db as never, { mode: 'takeaway' }, staff);
      r.addOrderItem(db as never, { orderId: o.id, menuItemId: burger, quantity: 1, modifierIds: [] }, staff);
      return { id: o.id, total: r.findOrder(db as never, o.id)!.totalCents };
    };
    const summary = async (shiftId: string) =>
      ((await call('shifts:summary', { shiftId })) as { ok: true; data: { paidOrderCount: number; refundedOrderCount: number } }).data;

    const first = ((await call('shifts:open', { openingCashCents: 0 })) as { ok: true; data: { id: string } }).data.id;
    // Carried over: rung up and ready, paid in the next shift.
    const carried = ring();
    r.sendOrderToKitchen(db as never, carried.id, staff);
    r.markOrderReady(db as never, carried.id, staff);
    // Paid by card and refunded in full; paid by card and refunded in part.
    const full = ring();
    r.tenderOrder(db as never, { orderId: full.id, payments: [{ method: 'card', amountCents: full.total, tenderedCents: null }] }, staff);
    r.refundOrder(db as never, { orderId: full.id, reason: 'Test wrong order', approverUserId: 'u_mgr', foodMade: 'not_made' }, boss);
    const part = ring();
    r.tenderOrder(db as never, { orderId: part.id, payments: [{ method: 'card', amountCents: part.total, tenderedCents: null }] }, staff);
    r.refundOrder(db as never, { orderId: part.id, reason: 'Test cold fries', approverUserId: 'u_mgr', amountCents: 10_000 }, boss);
    expect(await summary(first)).toMatchObject({ paidOrderCount: 2, refundedOrderCount: 2 });

    const closed = (await call('shifts:close', {
      shiftId: first,
      countedCashCents: 0,
      carryOverReason: 'Test customer pays later',
      carryOverOrderIds: [carried.id],
    })) as { ok: boolean };
    expect(closed.ok).toBe(true);
    const second = ((await call('shifts:open', { openingCashCents: 0 })) as { ok: true; data: { id: string } }).data.id;
    r.markOrderServed(db as never, { orderId: carried.id, payment: { method: 'card', amountCents: carried.total, tenderedCents: null } }, staff);

    expect(await summary(first)).toMatchObject({ paidOrderCount: 2, refundedOrderCount: 2 });
    expect(await summary(second)).toMatchObject({ paidOrderCount: 1, refundedOrderCount: 0 });
  });
});
