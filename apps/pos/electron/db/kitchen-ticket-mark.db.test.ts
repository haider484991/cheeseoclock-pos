/**
 * "Ticket not printed" (v0.7.33): print-queue-repo kitchenTicketsNotPrinted
 * on a real database built from the migrations, foreign keys on. Nothing new
 * is stored: the mark is worked out from this till's print queue and the
 * print log, where the newest kitchen job decides —
 *   - a kitchen ticket the printer gave up on is listed;
 *   - Try again (requeueFailedJob), a newer Reprint (waiting, printing or
 *     printed) takes it off;
 *   - a Reprint that failed after a ticket did print is not "not printed";
 *   - a CANCELLED slip never counts, failed or not;
 *   - a kitchen ticket the print log says printed (the other till) takes it
 *     off; one that may or may not have printed does not;
 *   - only orders the kitchen still has: not out with the rider, cancelled,
 *     handed over or deleted;
 *   - the orderIds filter, oldest failure first, and the cap;
 *   - it reads through indexes, and writes nothing.
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for Electron
 * here); skipped where it is missing. Every name and amount is made up.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from './connection.js';
import { DEV, DatabaseSync, openMigrated } from './costing-shop.fixture.js';
import {
  TICKETS_NOT_PRINTED_MAX,
  claimNextPendingJob,
  enqueuePrintJob,
  kitchenTicketsNotPrinted,
  markJobDone,
  markJobFailedPermanently,
  requeueFailedJob,
} from './repositories/print-queue-repo.js';
import { recordDocumentPrint, type PrintOutcome } from './repositories/document-print-repo.js';

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => '' } }));

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const live = describe.skipIf(!DatabaseSync);

type Db = ReturnType<typeof openMigrated>;

const CASHIER = 'u_cash';
const OTHER_TILL = 'till-2';
const T0 = '2026-10-01T12:00:00.000Z';

function shop(): Db {
  const db = openMigrated();
  db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, 'Test Cashier', 'x', 'cashier', ?, ?, ?)`,
  ).run(CASHIER, T0, T0, DEV);
  return db;
}

/** An order on the till (made-up figures), in the kitchen unless told otherwise. */
function order(db: Db, n: number, o: { status?: string; deleted?: boolean } = {}): string {
  const id = `o${n}`;
  db.prepare(
    `INSERT INTO orders (id, order_number, mode, status, cashier_id, source, total_cents, created_at, updated_at, deleted_at, device_id)
     VALUES (?, ?, 'takeaway', ?, ?, 'pos', 150000, ?, ?, ?, ?)`,
  ).run(id, `20261001-${String(n).padStart(4, '0')}`, o.status ?? 'sent_to_kitchen', CASHIER, T0, T0, o.deleted ? T0 : null, DEV);
  return id;
}

/** A kitchen job for the order: the ticket, a Reprint, or a CANCELLED slip. */
function kitchenJob(db: Db, orderId: string, o: { reprint?: boolean; cancelled?: boolean } = {}): string {
  return enqueuePrintJob(db as AppDatabase, {
    kind: 'kitchen',
    orderId,
    reprint: o.reprint === true,
    ...(o.cancelled ? { cancelled: true } : {}),
  }).id;
}

/** A kitchen ticket the printer gave up on; `at` sets when. */
function failedTicket(db: Db, orderId: string, o: { reprint?: boolean; cancelled?: boolean; at?: string } = {}): string {
  const id = kitchenJob(db, orderId, o);
  markJobFailedPermanently(db as AppDatabase, id, 'Printer offline');
  if (o.at) db.prepare(`UPDATE print_queue SET updated_at = ? WHERE id = ?`).run(o.at, id);
  return id;
}

/** A kitchen paper in the print log, as `deviceId` wrote it. */
function logged(
  db: Db,
  orderId: string,
  o: { deviceId?: string; outcome?: PrintOutcome; document?: 'kitchen' | 'kitchen_cancel' } = {},
): string {
  const document = o.document ?? 'kitchen';
  return recordDocumentPrint(
    db as AppDatabase,
    {
      orderId,
      orderNumber: '20261001-0001',
      document,
      docKey: document,
      copy: 'kitchen',
      printNo: 0,
      outcome: o.outcome ?? 'printed',
      reason: document === 'kitchen' ? 'auto' : 'cancel',
      requestedByUserId: null,
      approvedByUserId: null,
      printJobId: null,
    },
    o.deviceId ?? OTHER_TILL,
  );
}

const listed = (db: Db, orderIds?: readonly string[]): string[] =>
  kitchenTicketsNotPrinted(db as AppDatabase, orderIds === undefined ? {} : { orderIds }).map((r) => r.orderId);

live('kitchenTicketsNotPrinted', () => {
  it('lists a kitchen ticket the printer gave up on, with its order number and when it failed', () => {
    const db = shop();
    const o = order(db, 42);
    failedTicket(db, o, { at: '2026-10-01T12:05:00.000Z' });
    expect(kitchenTicketsNotPrinted(db as AppDatabase)).toEqual([
      { orderId: o, orderNumber: '20261001-0042', failedAt: '2026-10-01T12:05:00.000Z' },
    ]);
    // A ticket still waiting, or one that printed, is not "not printed".
    const waiting = order(db, 43);
    kitchenJob(db, waiting);
    const printed = order(db, 44);
    markJobDone(db as AppDatabase, kitchenJob(db, printed));
    expect(listed(db)).toEqual([o]);
    // Preparing and ready: the kitchen still has it.
    db.prepare(`UPDATE orders SET status = 'preparing' WHERE id = ?`).run(o);
    expect(listed(db)).toEqual([o]);
    db.prepare(`UPDATE orders SET status = 'ready' WHERE id = ?`).run(o);
    expect(listed(db)).toEqual([o]);
  });

  it('Try again (requeueFailedJob) takes it off; if that fails too, it is back', () => {
    const db = shop();
    const o = order(db, 1);
    const job = failedTicket(db, o);
    expect(requeueFailedJob(db as AppDatabase, job)).toEqual({ orderId: o, kind: 'kitchen' });
    expect(listed(db)).toEqual([]);
    markJobFailedPermanently(db as AppDatabase, job, 'Printer offline');
    expect(listed(db)).toEqual([o]);
  });

  it('a newer kitchen job waiting, being sent or printed takes it off; a newer one failing keeps it', () => {
    const db = shop();
    const o = order(db, 1);
    failedTicket(db, o);
    // Reprint pressed: waiting…
    const reprint = kitchenJob(db, o, { reprint: true });
    expect(listed(db)).toEqual([]);
    // …being sent…
    expect(claimNextPendingJob(db as AppDatabase)?.id).toBe(reprint);
    expect(listed(db)).toEqual([]);
    // …and gave up on as well: still not printed.
    markJobFailedPermanently(db as AppDatabase, reprint, 'Printer offline');
    expect(listed(db)).toEqual([o]);
    // Pressed again, and it printed.
    const again = kitchenJob(db, o, { reprint: true });
    markJobDone(db as AppDatabase, again);
    expect(listed(db)).toEqual([]);
  });

  it('a Reprint that failed after a ticket did print is not "not printed"', () => {
    const db = shop();
    const o = order(db, 1);
    markJobDone(db as AppDatabase, kitchenJob(db, o));
    failedTicket(db, o, { reprint: true });
    expect(listed(db)).toEqual([]);
  });

  it('a CANCELLED slip never counts: one that failed is ignored, and it does not hide a ticket that failed', () => {
    const db = shop();
    // Only a failed slip: nothing.
    const slipOnly = order(db, 1);
    failedTicket(db, slipOnly, { cancelled: true });
    // A failed ticket, then a slip after it (failed, waiting or printed): the ticket still decides.
    const ticket = order(db, 2);
    failedTicket(db, ticket);
    failedTicket(db, ticket, { cancelled: true });
    const ticket2 = order(db, 3);
    failedTicket(db, ticket2);
    markJobDone(db as AppDatabase, kitchenJob(db, ticket2, { cancelled: true }));
    expect(listed(db)).toEqual([ticket, ticket2]);
    // The log's CANCELLED slip is not a ticket either.
    logged(db, ticket, { document: 'kitchen_cancel' });
    expect(listed(db)).toEqual([ticket, ticket2]);
  });

  it('a kitchen ticket the print log says printed (the other till) takes it off; "may have printed" or a deleted row does not', () => {
    const db = shop();
    const other = order(db, 1);
    failedTicket(db, other);
    const unsure = order(db, 2);
    failedTicket(db, unsure);
    const deleted = order(db, 3);
    failedTicket(db, deleted);
    expect(listed(db)).toEqual([other, unsure, deleted]);
    logged(db, other);
    logged(db, unsure, { outcome: 'unsure', deviceId: DEV });
    const row = logged(db, deleted);
    db.prepare(`UPDATE document_prints SET deleted_at = ? WHERE id = ?`).run(T0, row);
    expect(listed(db)).toEqual([unsure, deleted]);
  });

  it('only orders the kitchen still has: not out with the rider, handed over, cancelled, still a cart, or deleted', () => {
    const db = shop();
    const kept = order(db, 1);
    failedTicket(db, kept);
    let n = 2;
    for (const status of ['out_for_delivery', 'served', 'delivered', 'paid', 'void', 'refunded', 'open']) {
      failedTicket(db, order(db, n++, { status }));
    }
    failedTicket(db, order(db, n++, { deleted: true }));
    expect(listed(db)).toEqual([kept]);
  });

  it('orderIds narrows it to those orders; an empty list is none', () => {
    const db = shop();
    const a = order(db, 1);
    const b = order(db, 2);
    const c = order(db, 3);
    for (const o of [a, b, c]) failedTicket(db, o);
    expect(listed(db, [c, a, 'o-unknown'])).toEqual([a, c]);
    expect(listed(db, [b, b])).toEqual([b]);
    expect(listed(db, [])).toEqual([]);
  });

  it('oldest failure first, at most 50', () => {
    const db = shop();
    expect(TICKETS_NOT_PRINTED_MAX).toBe(50);
    const late = order(db, 1);
    failedTicket(db, late, { at: '2026-10-01T12:30:00.000Z' });
    const early = order(db, 2);
    failedTicket(db, early, { at: '2026-10-01T12:10:00.000Z' });
    expect(listed(db)).toEqual([early, late]);
    for (let n = 3; n <= 60; n += 1) failedTicket(db, order(db, n), { at: '2026-10-01T12:20:00.000Z' });
    const all = listed(db);
    expect(all).toHaveLength(50);
    expect(all[0]).toBe(early);
    expect(all).not.toContain(late);
  });

  it('reads through the indexes on orders (status), print_queue (order, kind) and document_prints (order)', () => {
    const db = shop();
    // The query it really runs, caught on its way to the database, then explained with the same values.
    const plan = (orderIds?: readonly string[]): string => {
      let seen: { sql: string; params: unknown[] } | null = null;
      const spy = {
        ...db,
        prepare: (sql: string) => ({ all: (...params: unknown[]) => ((seen = { sql, params }), []) }),
      } as unknown as AppDatabase;
      kitchenTicketsNotPrinted(spy, orderIds === undefined ? {} : { orderIds });
      const caught = seen as { sql: string; params: unknown[] } | null;
      if (!caught) throw new Error('no query ran');
      return (db.raw.prepare(`EXPLAIN QUERY PLAN ${caught.sql}`).all(...caught.params) as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join('\n');
    };
    for (const p of [plan(), plan(['o1', 'o2'])]) {
      expect(p).toContain('idx_print_queue_order_kind');
      expect(p).toContain('idx_document_prints_order');
      // Every table is searched through an index (the plan names tables by their aliases): never a full scan.
      expect(p).not.toMatch(/\bSCAN\b/);
    }
    expect(plan()).toContain('idx_orders_status_created');
  });

  it('reads only: no sync entry, no audit row, nothing changed in the queue', () => {
    const db = shop();
    const o = order(db, 1);
    failedTicket(db, o);
    const count = (t: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
    const before = [count('sync_queue'), count('audit_log'), JSON.stringify(db.prepare(`SELECT * FROM print_queue`).all())];
    listed(db);
    listed(db, [o]);
    expect([count('sync_queue'), count('audit_log'), JSON.stringify(db.prepare(`SELECT * FROM print_queue`).all())]).toEqual(before);
  });
});
