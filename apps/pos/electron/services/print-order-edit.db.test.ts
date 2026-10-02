/**
 * The papers of an Edit order (v0.7.36) through the real print spooler, on a
 * real database built from every migration, with a fake printer that records
 * what it is sent:
 *  - the kitchen's CHANGE slip prints after the ticket, under the same number,
 *    as its own paper in the print log (the ticket's series is untouched);
 *  - none while the order's own ticket is still waiting to print (it prints
 *    the order as it is, edit included), none with kitchen tickets off, none
 *    when only drinks changed and this till leaves drinks off;
 *  - the bill again, marked ORDER CHANGED (not DUPLICATE), when a bill had
 *    gone out — the rider's bill before Back to Ready — and the next Send out
 *    prints no third one; no bill at all when none had gone out.
 *
 * node:sqlite behind a better-sqlite3-shaped shim; skips where it is missing.
 * Orders are made-up snapshots; no real prices or people.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { escPosToText } from '@cheeseoclock/printer-core';
import type { Cents, KitchenChange, OrderNumber, OrderSnapshot, PrinterConnectionConfig, UUID } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const h = vi.hoisted(() => ({
  sends: [] as Uint8Array[],
  snapshots: new Map<string, OrderSnapshot>(),
  offline: false,
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
      if (h.offline) return { ok: false, durationMs: 1, error: { code: 'offline', message: 'Printer offline (test)', recoverable: true } };
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

/** A made-up delivery order the kitchen has: a pizza and two colas, Rs 1,500. */
function order(orderId: string): string {
  h.snapshots.set(orderId, {
    order: {
      id: id(orderId),
      orderNumber: `20261003-${orderId.slice(-4)}` as OrderNumber,
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
      createdAt: '2026-10-03T10:00:00.000Z',
      paidAt: null,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      assignedRiderId: null,
      dispatchedAt: null,
      deliveredAt: null,
    },
    items: [line(orderId, 1, 'Test Pizza', 'Pizza'), line(orderId, 2, 'Test Cola', 'Drinks', 2)],
    discounts: [],
    payments: [],
    cashierName: 'Test Cashier',
    tableLabel: null,
    customerName: 'Test Customer',
    customerPhone: '0300 0000003',
    deliveryAddress: 'Test Street 3',
    rider: null,
  } as unknown as OrderSnapshot);
  return orderId;
}

/** The edit as saved: a second pizza added (Rs 500 more on the order), or only a cola taken off. */
function edited(orderId: string, what: 'pizza' | 'cola' = 'pizza'): KitchenChange {
  const s = h.snapshots.get(orderId)!;
  if (what === 'pizza') {
    s.items = [...s.items, line(orderId, 3, 'Test Wings', 'Wings')];
    s.order.subtotalCents = s.order.totalCents = cents(200_000);
  }
  return {
    editNo: 1,
    at: '2026-10-03T10:20:00.000Z',
    byUserId: null,
    reason: what === 'cola' ? 'Customer changed order' : null,
    added: what === 'pizza' ? [{ name: 'Test Wings', quantity: 1, modifiers: [], notes: null, drink: false }] : [],
    removed: what === 'cola' ? [{ name: 'Test Cola', quantity: 1, modifiers: [], notes: null, drink: true }] : [],
  };
}

let db: AppDatabase;
const spooler = async () => (await import('./print-spooler.js')).printSpooler;
const cfg = async () => import('./printer-config.js');
const texts = () => h.sends.map((b) => escPosToText(b));
type Row = Record<string, unknown>;
const papers = (orderId: string) =>
  db.prepare(`SELECT document, doc_key AS docKey, copy, print_no AS n, reason FROM document_prints WHERE order_id = ? ORDER BY rowid`).all(orderId) as Row[];
const queued = (orderId: string): Row[] =>
  (db.prepare(`SELECT status, payload_json FROM print_queue WHERE order_id = ? ORDER BY rowid`).all(orderId) as Row[]).map((r) => ({
    status: r['status'],
    ...(JSON.parse(String(r['payload_json'])) as Row),
  }));

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.sends.length = 0;
  h.snapshots.clear();
  h.offline = false;
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

describe.skipIf(!DatabaseSync)('the kitchen’s CHANGE slip', () => {
  it('prints after the ticket, under the same number, as a paper of its own', async () => {
    const s = await spooler();
    const oid = order('o0101');
    s.onOrderEvent(oid, 'sent_to_kitchen');
    await s.whenIdle();
    s.onOrderEdited(oid, edited(oid));
    await s.whenIdle();
    expect(h.sends).toHaveLength(2);
    const slip = texts()[1]!;
    expect(slip).toContain('* ORDER CHANGED *');
    expect(slip).toContain('#0101');
    expect(slip).toContain('ADD - MAKE NOW');
    expect(slip).toContain('1 x Test Wings');
    expect(slip).not.toContain('Test Pizza');
    expect(papers(oid)).toEqual([
      { document: 'kitchen', docKey: 'kitchen', copy: 'kitchen', n: 0, reason: 'auto' },
      { document: 'kitchen_change', docKey: 'kitchen_change:1', copy: 'kitchen', n: 0, reason: 'edited' },
    ]);
    // No bill had gone out: none now.
    expect(queued(oid).filter((j) => j['kind'] === 'receipt')).toEqual([]);
  });

  it('none while the ticket is still waiting to print: the ticket prints the order as it is, edit included', async () => {
    const s = await spooler();
    const oid = order('o0102');
    h.offline = true;
    s.onOrderEvent(oid, 'sent_to_kitchen');
    await s.whenIdle();
    expect(queued(oid)).toMatchObject([{ kind: 'kitchen', status: 'pending' }]);
    s.onOrderEdited(oid, edited(oid));
    await s.whenIdle();
    expect(queued(oid).filter((j) => j['change'] !== undefined)).toEqual([]);
  });

  it('none with kitchen tickets off; none when only a drink changed and drinks are left off the tickets', async () => {
    const c = await cfg();
    const s = await spooler();
    c.setPrintPolicy(db, { ...c.getPrintPolicy(db), kitchenDrinks: false });
    const drinks = order('o0103');
    s.onOrderEvent(drinks, 'sent_to_kitchen');
    await s.whenIdle();
    h.sends.length = 0;
    s.onOrderEdited(drinks, edited(drinks, 'cola'));
    await s.whenIdle();
    expect(h.sends).toHaveLength(0);

    c.setPrintPolicy(db, { ...c.getPrintPolicy(db), kitchenTicket: false, kitchenDrinks: true });
    const off = order('o0104');
    s.onOrderEdited(off, edited(off));
    await s.whenIdle();
    expect(h.sends).toHaveLength(0);
  });
});

describe.skipIf(!DatabaseSync)('the bill after an edit', () => {
  it('a bill had gone out (the rider’s, before Back to Ready): it prints again, ORDER CHANGED, not DUPLICATE; Send out again prints no third', async () => {
    const s = await spooler();
    const oid = order('o0105');
    const snap = h.snapshots.get(oid)!;
    s.onOrderEvent(oid, 'sent_to_kitchen');
    snap.order.status = 'out_for_delivery';
    s.onOrderEvent(oid, 'dispatched');
    await s.whenIdle();
    expect(texts().filter((t) => t.includes('BILL - NOT PAID'))).toHaveLength(1);
    // Back to Ready, then the edit: the bill the rider took back is wrong now.
    snap.order.status = 'ready';
    h.sends.length = 0;
    s.onOrderEdited(oid, edited(oid));
    await s.whenIdle();
    const bill = texts().find((t) => t.includes('BILL - NOT PAID'))!;
    expect(bill).toContain('ORDER CHANGED');
    expect(bill).toContain('This replaces the earlier bill');
    expect(bill).toContain('Test Wings');
    expect(bill).not.toContain('DUPLICATE');
    expect(papers(oid).filter((p) => p['document'] === 'bill')).toEqual([
      { document: 'bill', docKey: 'bill', copy: 'customer', n: 0, reason: 'dispatch' },
      { document: 'bill', docKey: 'bill', copy: 'shop', n: 0, reason: 'dispatch' },
      { document: 'bill', docKey: 'bill:edit1', copy: 'customer', n: 0, reason: 'edited' },
      { document: 'bill', docKey: 'bill:edit1', copy: 'shop', n: 0, reason: 'edited' },
    ]);
    // The rider leaves with the new bill: Send out prints no third.
    h.sends.length = 0;
    snap.order.status = 'out_for_delivery';
    s.onOrderEvent(oid, 'dispatched');
    await s.whenIdle();
    expect(h.sends).toHaveLength(0);
  });

  it('none while a bill is still waiting to print (it prints the order as it is)', async () => {
    const s = await spooler();
    const oid = order('o0106');
    s.onOrderEvent(oid, 'sent_to_kitchen');
    h.snapshots.get(oid)!.order.status = 'out_for_delivery';
    s.onOrderEvent(oid, 'dispatched');
    await s.whenIdle();
    h.offline = true;
    s.reprintReceipt(oid, { requestedByUserId: null });
    await s.whenIdle();
    h.snapshots.get(oid)!.order.status = 'ready';
    s.onOrderEdited(oid, edited(oid));
    await s.whenIdle();
    expect(queued(oid).filter((j) => j['reason'] === 'edited')).toEqual([]);
  });
});
