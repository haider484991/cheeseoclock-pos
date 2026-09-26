/**
 * Who may open the cash drawer by hand, and what is kept on record — the
 * rules in drawer-service, through the real repositories and the real print
 * spooler, with a fake printer and a stand-in for the manager-PIN check
 * (auth-service owns PINs and passwords; this only sees yes or no).
 *
 * Uses node's own `node:sqlite` (better-sqlite3 here is built for Electron)
 * and skips itself where that is missing. Names, ids and PINs are made up.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, PrintResult, PrinterConnectionConfig, UUID } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const h = vi.hoisted(() => ({
  sends: [] as Array<{ bytes: Uint8Array; opts: unknown }>,
  script: [] as Array<() => PrintResult>,
  pins: [] as string[],
}));

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => '' } }));
vi.mock('../adapters/printer/factory.js', () => ({
  makePrinterAdapter: (config: PrinterConnectionConfig) => ({
    id: 'fake',
    config,
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    send: async (bytes: Uint8Array, opts?: unknown) => {
      h.sends.push({ bytes, opts });
      const next = h.script.shift();
      return next ? next() : { ok: true, durationMs: 1 };
    },
    testPrint: async () => ({ ok: true, durationMs: 1 }),
  }),
}));
vi.mock('../db/repositories/order-repo.js', () => ({ getOrderSnapshot: () => null }));
// The manager check itself belongs to auth-service; here only its answer matters.
vi.mock('./auth-service.js', () => ({
  verifyManagerPin: async (_db: unknown, pin: string) => {
    h.pins.push(pin);
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
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

function openMigrated(): AppDatabase {
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
  } as unknown as AppDatabase;
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
const OWNER = session('u_owner', 'admin');

let db: AppDatabase;
const svc = () => import('./drawer-service.js');
const opens = () =>
  db
    .prepare(`SELECT kind, reason, user_id AS userId, approved_by_user_id AS approver FROM drawer_opens ORDER BY rowid`)
    .all() as Array<Record<string, unknown>>;

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.sends.length = 0;
  h.script.length = 0;
  h.pins.length = 0;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  db = openMigrated();
  const user = db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
  user.run('u_mgr', 'Test Manager', 'manager', T0, T0, DEV);
  user.run('u_owner', 'Test Owner', 'admin', T0, T0, DEV);
  const { setReceiptPrinterConfig } = await import('./printer-config.js');
  setReceiptPrinterConfig(db, { transport: 'network', network: { host: '192.0.2.5', port: 9100 }, width: 48 });
  const { printSpooler } = await import('./print-spooler.js');
  printSpooler.init(db);
  printSpooler.resetAdapter();
});

afterEach(() => {
  vi.useRealTimers();
});

describe.skipIf(!DatabaseSync)('Open drawer (no sale)', () => {
  it('a manager or the owner opens it directly: saved first, then one pulse', async () => {
    const { openDrawerNoSale } = await svc();
    for (const who of [MANAGER, OWNER]) {
      const r = await openDrawerNoSale(db, who, DEV, { kind: 'no_sale', reason: 'Change' });
      expect(r).toMatchObject({ opened: true, unsure: false, noPrinter: false, message: null });
    }
    expect(opens()).toEqual([
      { kind: 'no_sale', reason: 'Change', userId: 'u_mgr', approver: null },
      { kind: 'no_sale', reason: 'Change', userId: 'u_owner', approver: null },
    ]);
    expect(h.sends).toHaveLength(2);
    expect(h.sends[0]!.opts).toMatchObject({ drawer: true });
    expect(h.pins).toEqual([]);
  });

  it('a cashier without a PIN, or with a wrong one, is refused: nothing saved, nothing opened', async () => {
    const { openDrawerNoSale, DrawerOpenRefused } = await svc();
    await expect(openDrawerNoSale(db, CASHIER, DEV, { kind: 'no_sale' })).rejects.toMatchObject({
      code: 'precondition_failed',
    });
    await expect(openDrawerNoSale(db, CASHIER, DEV, { kind: 'no_sale', approverPin: '   ' })).rejects.toBeInstanceOf(
      DrawerOpenRefused,
    );
    await expect(
      openDrawerNoSale(db, CASHIER, DEV, { kind: 'no_sale', approverPin: '123456' }),
    ).rejects.toMatchObject({ code: 'forbidden', message: "That is not a manager's PIN or password" });
    expect(opens()).toEqual([]);
    expect(h.sends).toEqual([]);
  });

  it('a cashier with a manager password (letters too) opens it; the manager is saved as approver', async () => {
    const { openDrawerNoSale } = await svc();
    const r = await openDrawerNoSale(db, CASHIER, DEV, {
      kind: 'no_sale',
      reason: 'Check notes',
      approverPin: 'Manager-pass-7',
    });
    expect(r.opened).toBe(true);
    // Passed on as typed: the sign-in rules decide what a PIN or password is.
    expect(h.pins).toEqual(['Manager-pass-7']);
    expect(opens()).toEqual([{ kind: 'no_sale', reason: 'Check notes', userId: 'u_cash', approver: 'u_mgr' }]);
  });

  it('a printer failure still leaves the open on record, with a plain reason', async () => {
    const { openDrawerNoSale } = await svc();
    h.script.push(() => ({
      ok: false,
      durationMs: 1,
      error: { code: 'network_error', message: 'connect EHOSTUNREACH 192.0.2.5:9100', recoverable: true },
    }));
    const r = await openDrawerNoSale(db, MANAGER, DEV, { kind: 'no_sale' });
    expect(r).toMatchObject({ opened: false, unsure: false });
    expect(r.message).toMatch(/didn't answer/);
    expect(opens()).toHaveLength(1);
    expect(h.sends).toHaveLength(1); // never retried
  });

  it('says "unsure" when the pulse may have gone out', async () => {
    const { openDrawerNoSale } = await svc();
    h.script.push(() => ({
      ok: false,
      durationMs: 1,
      error: { code: 'printer_maybe_sent', message: 'stopped', recoverable: false, maybeSent: true },
    }));
    const r = await openDrawerNoSale(db, MANAGER, DEV, { kind: 'no_sale' });
    expect(r).toMatchObject({ opened: false, unsure: true });
  });

  it('on the no-printer setup it is noted, and the answer says nothing opened', async () => {
    const { setReceiptPrinterConfig, DEFAULT_RECEIPT_CONFIG } = await import('./printer-config.js');
    setReceiptPrinterConfig(db, DEFAULT_RECEIPT_CONFIG);
    const { openDrawerNoSale } = await svc();
    const r = await openDrawerNoSale(db, MANAGER, DEV, { kind: 'no_sale' });
    expect(r.noPrinter).toBe(true);
    expect(opens()).toHaveLength(1);
  });
});

describe.skipIf(!DatabaseSync)('Open drawer to count', () => {
  it('only a manager or the owner, and only with a shift open', async () => {
    const { openDrawerNoSale } = await svc();
    await expect(
      openDrawerNoSale(db, CASHIER, DEV, { kind: 'count', approverPin: 'Manager-pass-7' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(openDrawerNoSale(db, MANAGER, DEV, { kind: 'count' })).rejects.toMatchObject({
      code: 'precondition_failed',
    });
    expect(opens()).toEqual([]);
    expect(h.sends).toEqual([]);

    const { openShift } = await import('../db/repositories/shift-repo.js');
    openShift(db, { openingCashCents: 0 }, { userId: 'u_mgr', deviceId: DEV });
    await openDrawerNoSale(db, MANAGER, DEV, { kind: 'count' });
    await openDrawerNoSale(db, MANAGER, DEV, { kind: 'count' });
    // Pressing it again shows up as a no-sale open.
    expect(opens().map((o) => o['kind'])).toEqual(['count', 'no_sale']);
    expect(h.sends).toHaveLength(2);
  });

  it('refuses a kind it does not know', async () => {
    const { openDrawerNoSale } = await svc();
    await expect(openDrawerNoSale(db, MANAGER, DEV, { kind: 'test' as never })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(opens()).toEqual([]);
  });
});

describe.skipIf(!DatabaseSync)('Test drawer', () => {
  it('is saved as a test, then pulses once', async () => {
    const { testDrawer } = await svc();
    const r = await testDrawer(db, MANAGER, DEV);
    expect(r.ok).toBe(true);
    expect(opens()).toEqual([{ kind: 'test', reason: null, userId: 'u_mgr', approver: null }]);
    expect(h.sends).toHaveLength(1);
  });

  it('a failure comes back in plain words', async () => {
    const { testDrawer } = await svc();
    h.script.push(() => ({
      ok: false,
      durationMs: 1,
      error: { code: 'printer_offline', message: 'Windows says the printer is off (status 0x80)', recoverable: true },
    }));
    const r = await testDrawer(db, MANAGER, DEV);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toBe('The printer is not ready. Windows says the printer is off (status 0x80)');
  });
});
