/**
 * The kitchen ticket's rules through the real print spooler (Settings →
 * Printers; this till's printer.policy — per till, never synced, because
 * each till drives its own printer), on a real database built from every
 * migration, with a fake printer that records what it is sent:
 *  - a till with nothing saved prints what it always did: one ticket, the
 *    customer's phone and the drinks on it;
 *  - several tickets: one send, each ticket marked COPY n OF N and cut, one
 *    paper in the print log (so a later reprint is still "Reprint #1"); a
 *    CANCELLED slip prints as many; a ticket printed by hand is one;
 *  - the phone off: the name only; the drinks off: left off with one line,
 *    and an order of only drinks prints no ticket (items added and sent
 *    again still bring it);
 *  - the bounds are checked in the main process (printer:setPolicy's schema).
 *
 * node:sqlite behind a better-sqlite3-shaped shim; skips where it is
 * missing. Orders are made-up snapshots; no real prices or people.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CUT_MARKER, decodeEscPos, escPosToText } from '@cheeseoclock/printer-core';
import type { Cents, OrderNumber, OrderSnapshot, PrinterConnectionConfig, UUID } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const h = vi.hoisted(() => ({
  sends: [] as Uint8Array[],
  snapshots: new Map<string, OrderSnapshot>(),
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
    send: async (bytes: Uint8Array) => {
      h.sends.push(bytes);
      return { ok: true, durationMs: 1 };
    },
    testPrint: async () => ({ ok: true, durationMs: 1 }),
  }),
}));
vi.mock('../db/repositories/order-repo.js', () => ({
  getOrderSnapshot: (_db: unknown, id: string) => h.snapshots.get(id) ?? null,
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
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  raw.exec('PRAGMA foreign_keys = OFF'); // the print log points at made-up orders
  raw.exec(`UPDATE settings SET value_json = '"2026-01-01T00:00:00.000Z"' WHERE key = 'printing.printLogSince'`);
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
type Line = OrderSnapshot['items'][number];
const line = (orderId: string, n: number, name: string, categoryName: string, quantity = 1): Line =>
  ({
    id: id(`${orderId}-i${n}`),
    orderId: id(orderId),
    menuItemId: id(`m${n}`),
    comboId: null,
    parentOrderItemId: null,
    quantity,
    unitPriceCents: cents(50_000),
    lineTotalCents: cents(50_000 * quantity),
    taxCategoryId: id('t1'),
    notes: null,
    kitchenStatus: 'pending',
    menuItemName: name,
    categoryName,
    prepStation: 'kitchen',
    modifiers: [],
  }) as Line;

/** A made-up delivery order sent to the kitchen: a pizza and (unless `drinksOnly`) a cola, or only colas. */
function order(orderId: string, what: 'mixed' | 'drinksOnly' = 'mixed'): string {
  const items = what === 'mixed' ? [line(orderId, 1, 'Test Pizza', 'Pizza'), line(orderId, 2, 'Test Cola', 'Drinks', 2)] : [line(orderId, 2, 'Test Cola', 'Drinks', 2)];
  h.snapshots.set(orderId, {
    order: {
      id: id(orderId),
      orderNumber: `20260928-${orderId.slice(-4)}` as OrderNumber,
      mode: 'delivery',
      status: 'sent_to_kitchen',
      tableId: null,
      customerId: id('c1'),
      cashierId: id('u1'),
      shiftId: null,
      source: 'pos',
      notes: null,
      subtotalCents: cents(150_000),
      discountCents: cents(0),
      taxCents: cents(0),
      totalCents: cents(150_000),
      createdAt: '2026-09-28T10:00:00.000Z',
      paidAt: null,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      assignedRiderId: null,
      dispatchedAt: null,
      deliveredAt: null,
    },
    items,
    discounts: [],
    payments: [],
    cashierName: 'Test Cashier',
    tableLabel: null,
    customerName: 'Test Customer',
    customerPhone: '0300 0000002',
    deliveryAddress: 'Test Street 2',
    rider: null,
  } as unknown as OrderSnapshot);
  return orderId;
}

let db: AppDatabase;
const spooler = async () => (await import('./print-spooler.js')).printSpooler;
const cfg = async () => import('./printer-config.js');
const texts = () => h.sends.map((b) => escPosToText(b));
const cuts = (bytes: Uint8Array) => decodeEscPos(bytes).filter((r) => r.text === CUT_MARKER).length;
const kitchenPapers = (orderId: string) =>
  db.prepare(`SELECT document, print_no AS n, reason FROM document_prints WHERE order_id = ? ORDER BY rowid`).all(orderId);

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.sends.length = 0;
  h.snapshots.clear();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  db = openMigrated();
  const s = await spooler();
  s.init(db);
  await s.whenIdle();
  h.sends.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe.skipIf(!DatabaseSync)('the kitchen ticket’s rules on this till', () => {
  it('nothing saved: one ticket with the phone and the drinks, as always; the policy reads as it was stored', async () => {
    const c = await cfg();
    expect(c.getPrintPolicy(db)).toEqual({ kitchenTicket: true, deliveryBillOnDispatch: true, shopCopy: 'delivery', logoOnReceipt: true });
    const s = await spooler();
    s.onOrderEvent(order('o0001'), 'sent_to_kitchen');
    await s.whenIdle();
    expect(h.sends).toHaveLength(1);
    const t = texts()[0]!;
    expect(t).toContain('0300 0000002');
    expect(t).toContain('2 x Test Cola');
    expect(t).not.toContain('COPY');
    expect(cuts(h.sends[0]!)).toBe(1);
    expect(kitchenPapers('o0001')).toEqual([{ document: 'kitchen', n: 0, reason: 'auto' }]);
  });

  it('two tickets: one send, COPY 1 OF 2 and COPY 2 OF 2, each cut; one paper in the print log; by hand it is one', async () => {
    const c = await cfg();
    c.setPrintPolicy(db, { ...c.getPrintPolicy(db), kitchenCopies: 2 });
    const s = await spooler();
    s.onOrderEvent(order('o0002'), 'sent_to_kitchen');
    await s.whenIdle();
    expect(h.sends).toHaveLength(1);
    const t = texts()[0]!;
    expect(t).toContain('COPY 1 OF 2');
    expect(t).toContain('COPY 2 OF 2');
    expect(cuts(h.sends[0]!)).toBe(2);
    expect(kitchenPapers('o0002')).toEqual([{ document: 'kitchen', n: 0, reason: 'auto' }]);
    // Printed again by hand: one ticket, stamped REPRINT, "Reprint #1".
    h.sends.length = 0;
    s.reprintKitchenTicket('o0002', { requestedByUserId: null });
    await s.whenIdle();
    expect(h.sends).toHaveLength(1);
    expect(cuts(h.sends[0]!)).toBe(1);
    expect(texts()[0]).toContain('* REPRINT *');
    expect(texts()[0]).not.toContain('COPY 1 OF');
    expect(kitchenPapers('o0002')).toHaveLength(2);
  });

  it('a CANCELLED slip prints as many as the tickets', async () => {
    const c = await cfg();
    c.setPrintPolicy(db, { ...c.getPrintPolicy(db), kitchenCopies: 3 });
    const s = await spooler();
    const oid = order('o0003');
    s.onOrderEvent(oid, 'sent_to_kitchen');
    await s.whenIdle();
    h.sends.length = 0;
    h.snapshots.get(oid)!.order.status = 'void';
    s.onOrderEvent(oid, 'cancelled');
    await s.whenIdle();
    expect(h.sends).toHaveLength(1);
    const t = texts()[0]!;
    expect(t).toContain('* CANCELLED *');
    expect(t).toContain('COPY 3 OF 3');
    expect(cuts(h.sends[0]!)).toBe(3);
  });

  it('the phone off: the name only; the drinks off: left off with one line saying how many', async () => {
    const c = await cfg();
    c.setPrintPolicy(db, { ...c.getPrintPolicy(db), kitchenPhone: false, kitchenDrinks: false });
    const s = await spooler();
    s.onOrderEvent(order('o0004'), 'sent_to_kitchen');
    await s.whenIdle();
    const t = texts()[0]!;
    expect(t).toContain('Customer: Test Customer');
    expect(t).not.toContain('0300 0000002');
    expect(t).not.toContain('Test Cola');
    expect(t).toContain('+ 2 drinks from the counter (not listed)');
    expect(t).toContain('Test Pizza');
  });

  it('the drinks off: an order of only drinks prints no ticket; food added and sent again still does', async () => {
    const c = await cfg();
    c.setPrintPolicy(db, { ...c.getPrintPolicy(db), kitchenDrinks: false });
    const s = await spooler();
    const oid = order('o0005', 'drinksOnly');
    s.onOrderEvent(oid, 'sent_to_kitchen');
    await s.whenIdle();
    expect(h.sends).toHaveLength(0);
    expect(kitchenPapers(oid)).toEqual([]);
    // A pizza added and the order sent again: now there is something to cook.
    order(oid, 'mixed');
    s.onOrderEvent(oid, 'sent_to_kitchen');
    await s.whenIdle();
    expect(h.sends).toHaveLength(1);
    expect(texts()[0]).toContain('Test Pizza');
    // With the drinks on (the default), an order of only drinks prints as always.
    c.setPrintPolicy(db, { ...c.getPrintPolicy(db), kitchenDrinks: true });
    s.onOrderEvent(order('o0006', 'drinksOnly'), 'sent_to_kitchen');
    await s.whenIdle();
    expect(h.sends).toHaveLength(2);
  });

  it('the bounds are the main process’s: 1 to 3 tickets, whole; a policy saved before them reads unchanged', async () => {
    const c = await cfg();
    for (const kitchenCopies of [0, 4, 1.5]) {
      expect(c.PrintPolicySchema.safeParse({ ...c.getPrintPolicy(db), kitchenCopies }).success).toBe(false);
    }
    for (const kitchenCopies of [1, 2, 3]) expect(c.PrintPolicySchema.safeParse({ ...c.getPrintPolicy(db), kitchenCopies }).success).toBe(true);
    expect(c.PrintPolicySchema.safeParse({ kitchenPhone: 'no' }).success).toBe(false);
    const { setSetting } = await import('../db/repositories/settings-repo.js');
    setSetting(db, c.PRINT_POLICY_KEY, { kitchenTicket: true, deliveryBillOnDispatch: false, shopCopy: 'always', logoOnReceipt: false });
    expect(c.getPrintPolicy(db)).toEqual({ kitchenTicket: true, deliveryBillOnDispatch: false, shopCopy: 'always', logoOnReceipt: false });
  });
});
