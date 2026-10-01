/**
 * web-order-imports-repo (v0.7.33) and migration 0046 on a real database
 * built from the migrations, foreign keys on:
 *   - 0046: a website order imported before it is marked confirmed and seen
 *     at its import time, so the restart that installs it neither warns nor
 *     rings; an import attempt still waiting for its retry, and a failed
 *     row, are left alone; a row written after it starts out unconfirmed
 *     and unseen;
 *   - each function on seeded rows: what the ack retry, the alert restore,
 *     the "website cancelled" card and the PIN screen's "not confirmed"
 *     note will read, and the marks they set (the first time is kept);
 *   - markCancelledOnSite is true once, then false;
 *   - pure-local: no sync entry and no audit row is written, and the orders
 *     themselves are never touched.
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for Electron
 * here); skipped where it is missing. Every name, phone number and amount is
 * made up.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from './connection.js';
import { DEV, DatabaseSync, MIGRATIONS, openMigrated } from './costing-shop.fixture.js';
import {
  MAX_MARK_IDS,
  listUnackedImports,
  markAlertsSeen,
  markCancelNoted,
  markCancelledOnSite,
  markWebOrderAcked,
  openSiteCancels,
  unconfirmedWebOrders,
  unseenWebOrders,
} from './repositories/web-order-imports-repo.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const live = describe.skipIf(!DatabaseSync);

type Db = ReturnType<typeof openMigrated>;
type Row = Record<string, unknown>;

const BASE = Date.parse('2026-10-01T12:00:00.000Z');
/** A time `min` minutes after (or before) noon on 1 Oct 2026. */
const T = (min: number) => new Date(BASE + min * 60_000).toISOString();
const CASHIER = 'u_cash';
const NEW_COLUMNS = ['web_created_at', 'web_total_cents', 'acked_at', 'alert_seen_at', 'site_cancelled_at', 'cancel_noted_at'];

function shop(opts: { stopBefore?: string } = {}): Db {
  const db = openMigrated(opts);
  db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, 'Test Cashier', 'x', 'cashier', ?, ?, ?)`,
  ).run(CASHIER, T(-600), T(-600), DEV);
  return db;
}

/** A POS order, as the import leaves it (made-up customer). */
function order(
  db: Db,
  id: string,
  o: { number: string; status?: string; mode?: 'delivery' | 'takeaway'; deleted?: boolean; name?: string; phone?: string; totalCents?: number },
): void {
  db.prepare(
    `INSERT INTO orders (id, order_number, mode, status, cashier_id, source, customer_name_snapshot, customer_phone_snapshot,
                         total_cents, created_at, updated_at, deleted_at, device_id)
     VALUES (?, ?, ?, ?, ?, 'web', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    o.number,
    o.mode ?? 'delivery',
    o.status ?? 'sent_to_kitchen',
    CASHIER,
    o.name ?? 'Test Customer',
    o.phone ?? '0300-0000000',
    o.totalCents ?? 150_000,
    T(-120),
    T(-120),
    o.deleted ? T(-1) : null,
    DEV,
  );
}

/** A web_order_imports row with only the columns given (so it also works before 0046). */
function importRow(db: Db, row: Row): void {
  const full: Row = { status: 'imported', attempts: 1, created_at: T(-120), updated_at: T(-120), ...row };
  const keys = Object.keys(full);
  db.prepare(`INSERT INTO web_order_imports (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(
    ...keys.map((k) => full[k] ?? null),
  );
}

/** An imported website order: its POS order and its import row. */
function imported(db: Db, n: number, o: Omit<Parameters<typeof order>[2], 'number'> & { number?: string; importRow?: Row } = {}): void {
  order(db, `o${n}`, { ...o, number: o.number ?? `20261001-00${String(n).padStart(2, '0')}` });
  importRow(db, { web_order_id: `w${n}`, pos_order_id: `o${n}`, imported_at: T(-60 + n), last_pushed_status: 'accepted', ...o.importRow });
}

const one = (db: Db, webOrderId: string): Row =>
  db.prepare(`SELECT * FROM web_order_imports WHERE web_order_id = ?`).get(webOrderId) as Row;
const pick = (r: Row, cols: string[]): Row => Object.fromEntries(cols.map((c) => [c, r[c]]));
const count = (db: Db, table: string): number => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

live('migration 0046 on rows written before it', () => {
  it('an imported order is marked confirmed and seen at its import time; an attempt still waiting and a failed row are left alone; a row after it starts empty', () => {
    const db = shop({ stopBefore: '0046' });
    order(db, 'o1', { number: '20261001-0001', status: 'delivered' });
    order(db, 'o2', { number: '20261001-0002' });
    // Imported (the usual row), and imported with no import time (falls back to its last update).
    importRow(db, { web_order_id: 'w1', pos_order_id: 'o1', imported_at: T(-90), updated_at: T(-30), last_pushed_status: 'delivered' });
    importRow(db, { web_order_id: 'w2', pos_order_id: 'o2', imported_at: null, updated_at: T(-80), last_pushed_status: 'accepted' });
    // An import attempt that has not gone through yet (the status column's default), and a failed one.
    importRow(db, { web_order_id: 'w3', attempts: 2, updated_at: T(-70), last_error: 'item gone' });
    importRow(db, { web_order_id: 'w4', status: 'failed', attempts: 0, updated_at: T(-60), last_error: 'stale' });
    const before = db.prepare(`SELECT * FROM web_order_imports ORDER BY web_order_id`).all() as Row[];

    db.exec(readFileSync(join(MIGRATIONS, '0046_web_order_alerts.sql'), 'utf8'));

    // The old columns are as they were…
    const after = db.prepare(`SELECT * FROM web_order_imports ORDER BY web_order_id`).all() as Row[];
    expect(after.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !NEW_COLUMNS.includes(k))))).toEqual(
      before.map((r) => ({ ...r })),
    );
    // …imported rows are confirmed and seen when they came in…
    expect(pick(one(db, 'w1'), NEW_COLUMNS)).toEqual({
      web_created_at: null,
      web_total_cents: null,
      acked_at: T(-90),
      alert_seen_at: T(-90),
      site_cancelled_at: null,
      cancel_noted_at: null,
    });
    expect(pick(one(db, 'w2'), ['acked_at', 'alert_seen_at'])).toEqual({ acked_at: T(-80), alert_seen_at: T(-80) });
    // …and the attempt and the failed row are not.
    for (const id of ['w3', 'w4']) {
      expect(pick(one(db, id), NEW_COLUMNS)).toEqual(Object.fromEntries(NEW_COLUMNS.map((c) => [c, null])));
    }
    // So the first poll and the first boot after the upgrade find nothing to retry, warn about or ring for.
    expect(listUnackedImports(db as AppDatabase, T(-600))).toEqual([]);
    expect(unseenWebOrders(db as AppDatabase, T(-600))).toEqual([]);
    expect(unconfirmedWebOrders(db as AppDatabase, { olderThanIso: T(0), sinceIso: T(-600) })).toEqual([]);

    // The waiting attempt's retry imports it now (the bridge's own import update): it starts unconfirmed and unseen.
    order(db, 'o3', { number: '20261001-0003' });
    db.prepare(
      `UPDATE web_order_imports SET pos_order_id = 'o3', status = 'imported', imported_at = ?, last_pushed_status = 'accepted', updated_at = ? WHERE web_order_id = 'w3'`,
    ).run(T(-5), T(-5));
    // A row written after 0046 starts empty too.
    imported(db, 5, { number: '20261001-0005', importRow: { imported_at: T(-4) } });
    for (const id of ['w3', 'w5']) {
      expect(pick(one(db, id), ['acked_at', 'alert_seen_at'])).toEqual({ acked_at: null, alert_seen_at: null });
    }
    expect(listUnackedImports(db as AppDatabase, T(-600)).map((r) => r.webOrderId)).toEqual(['w3', 'w5']);
    expect(unseenWebOrders(db as AppDatabase, T(-600)).map((r) => r.webOrderId)).toEqual(['w3', 'w5']);
    // The index for the ack retry is there.
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_web_imports_unacked'`).get()).toEqual({
      name: 'idx_web_imports_unacked',
    });
  });
});

live('web-order-imports-repo', () => {
  it('markWebOrderAcked: confirmed once, the first time is kept; the ack retry then leaves it out', () => {
    const db = shop();
    imported(db, 1);
    imported(db, 2);
    markWebOrderAcked(db as AppDatabase, 'w1', T(1));
    expect(pick(one(db, 'w1'), ['acked_at', 'updated_at'])).toEqual({ acked_at: T(1), updated_at: T(1) });
    markWebOrderAcked(db as AppDatabase, 'w1', T(9));
    expect(pick(one(db, 'w1'), ['acked_at', 'updated_at'])).toEqual({ acked_at: T(1), updated_at: T(9) });
    // An id the till never imported: nothing, and no throw.
    expect(() => markWebOrderAcked(db as AppDatabase, 'w-unknown', T(2))).not.toThrow();
    expect(listUnackedImports(db as AppDatabase, T(-600)).map((r) => r.webOrderId)).toEqual(['w2']);
    expect(one(db, 'w2')['acked_at']).toBeNull();
  });

  it('listUnackedImports: imported, unconfirmed, not cancelled on the website, since the time given, oldest first, with its order', () => {
    const db = shop();
    imported(db, 1, { number: '20261001-0001', status: 'preparing', importRow: { imported_at: T(-30) } });
    imported(db, 2, { number: '20261001-0002', deleted: true, importRow: { imported_at: T(-50) } });
    imported(db, 3, { number: '20261001-0003', importRow: { imported_at: T(-10) } });
    // Left out: confirmed, cancelled on the website, imported before the window, an attempt with no order, a failed row.
    imported(db, 4, { number: '20261001-0004', importRow: { imported_at: T(-20), acked_at: T(-19) } });
    imported(db, 5, { number: '20261001-0005', importRow: { imported_at: T(-20), site_cancelled_at: T(-1) } });
    imported(db, 6, { number: '20261001-0006', importRow: { imported_at: T(-200) } });
    importRow(db, { web_order_id: 'w7', imported_at: null });
    importRow(db, { web_order_id: 'w8', status: 'failed', last_error: 'stale' });

    expect(listUnackedImports(db as AppDatabase, T(-120))).toEqual([
      { webOrderId: 'w2', posOrderId: 'o2', orderNumber: '20261001-0002', orderStatus: 'sent_to_kitchen', orderDeleted: true, importedAt: T(-50) },
      { webOrderId: 'w1', posOrderId: 'o1', orderNumber: '20261001-0001', orderStatus: 'preparing', orderDeleted: false, importedAt: T(-30) },
      { webOrderId: 'w3', posOrderId: 'o3', orderNumber: '20261001-0003', orderStatus: 'sent_to_kitchen', orderDeleted: false, importedAt: T(-10) },
    ]);
    // The limit keeps the oldest; the default is 25.
    expect(listUnackedImports(db as AppDatabase, T(-120), 2).map((r) => r.webOrderId)).toEqual(['w2', 'w1']);
    expect(listUnackedImports(db as AppDatabase, T(-600)).map((r) => r.webOrderId)).toEqual(['w6', 'w2', 'w1', 'w3']);
  });

  it('markCancelledOnSite: true once, then false; it records the cancel, counts as the answer and as the last status', () => {
    const db = shop();
    imported(db, 1);
    imported(db, 2, { importRow: { acked_at: T(-40) } });

    expect(markCancelledOnSite(db as AppDatabase, 'w1', T(3))).toBe(true);
    expect(pick(one(db, 'w1'), ['site_cancelled_at', 'acked_at', 'last_pushed_status', 'updated_at'])).toEqual({
      site_cancelled_at: T(3),
      acked_at: T(3),
      last_pushed_status: 'cancelled',
      updated_at: T(3),
    });
    // The second time: false, and nothing moves.
    expect(markCancelledOnSite(db as AppDatabase, 'w1', T(8))).toBe(false);
    expect(pick(one(db, 'w1'), ['site_cancelled_at', 'acked_at', 'updated_at'])).toEqual({
      site_cancelled_at: T(3),
      acked_at: T(3),
      updated_at: T(3),
    });
    // An order already confirmed keeps its confirmation time.
    expect(markCancelledOnSite(db as AppDatabase, 'w2', T(4))).toBe(true);
    expect(pick(one(db, 'w2'), ['site_cancelled_at', 'acked_at'])).toEqual({ site_cancelled_at: T(4), acked_at: T(-40) });
    // Unknown: false.
    expect(markCancelledOnSite(db as AppDatabase, 'w-unknown', T(5))).toBe(false);
    // Neither is retried nor "not confirmed" any more.
    expect(listUnackedImports(db as AppDatabase, T(-600))).toEqual([]);
    expect(unconfirmedWebOrders(db as AppDatabase, { olderThanIso: T(10), sinceIso: T(-600) })).toEqual([]);
  });

  it('markAlertsSeen: by POS order id, only rows not seen yet, the first time kept; junk ids skipped; at most 200 ids', () => {
    const db = shop();
    imported(db, 1);
    imported(db, 2);
    imported(db, 3, { importRow: { alert_seen_at: T(-30) } });
    imported(db, 4);

    expect(markAlertsSeen(db as AppDatabase, ['o1', 'o3', 'o1', '', 'o-unknown'], T(2))).toBe(1);
    expect(pick(one(db, 'w1'), ['alert_seen_at', 'updated_at'])).toEqual({ alert_seen_at: T(2), updated_at: T(-120) });
    expect(one(db, 'w3')['alert_seen_at']).toBe(T(-30));
    expect(markAlertsSeen(db as AppDatabase, ['o1'], T(7))).toBe(0);
    expect(one(db, 'w1')['alert_seen_at']).toBe(T(2));
    // Nothing given: nothing to do.
    expect(markAlertsSeen(db as AppDatabase, [], T(3))).toBe(0);
    expect(markAlertsSeen(db as AppDatabase, [42, null] as unknown as string[], T(3))).toBe(0);
    // A list longer than the cap is cut, not refused: an id after the first 200 is not marked…
    const filler = Array.from({ length: MAX_MARK_IDS }, (_, i) => `o-filler-${i}`);
    expect(MAX_MARK_IDS).toBe(200);
    expect(markAlertsSeen(db as AppDatabase, [...filler, 'o2'], T(4))).toBe(0);
    expect(one(db, 'w2')['alert_seen_at']).toBeNull();
    // …and one within them is.
    expect(markAlertsSeen(db as AppDatabase, [...filler.slice(1), 'o2', 'o4'], T(5))).toBe(1);
    expect(pick(one(db, 'w2'), ['alert_seen_at'])).toEqual({ alert_seen_at: T(5) });
    expect(one(db, 'w4')['alert_seen_at']).toBeNull();
    expect(unseenWebOrders(db as AppDatabase, T(-600)).map((r) => r.webOrderId)).toEqual(['w4']);
  });

  it('markCancelNoted: only rows the website cancelled, the first time kept', () => {
    const db = shop();
    imported(db, 1, { importRow: { site_cancelled_at: T(-5) } });
    imported(db, 2);
    imported(db, 3, { importRow: { site_cancelled_at: T(-4), cancel_noted_at: T(-3) } });

    expect(markCancelNoted(db as AppDatabase, ['w1', 'w2', 'w3', 'w1'], T(1))).toBe(1);
    expect(pick(one(db, 'w1'), ['cancel_noted_at'])).toEqual({ cancel_noted_at: T(1) });
    expect(one(db, 'w2')['cancel_noted_at']).toBeNull();
    expect(one(db, 'w3')['cancel_noted_at']).toBe(T(-3));
    expect(markCancelNoted(db as AppDatabase, ['w1'], T(6))).toBe(0);
    expect(one(db, 'w1')['cancel_noted_at']).toBe(T(1));
    expect(markCancelNoted(db as AppDatabase, [], T(6))).toBe(0);
  });

  it('unseenWebOrders: imported since the time given, not seen, still New on the board; a pick-up reads as one', () => {
    const db = shop();
    imported(db, 1, { mode: 'takeaway', name: 'Test Asma', totalCents: 120_000, importRow: { imported_at: T(-30), web_total_cents: 125_000 } });
    imported(db, 2, { name: 'Test Bilal', totalCents: 180_000, importRow: { imported_at: T(-40) } });
    // Left out: seen, started, deleted, voided, from before the window, a failed row.
    imported(db, 3, { importRow: { imported_at: T(-20), alert_seen_at: T(-19) } });
    imported(db, 4, { status: 'preparing', importRow: { imported_at: T(-20) } });
    imported(db, 5, { deleted: true, importRow: { imported_at: T(-20) } });
    imported(db, 6, { status: 'void', importRow: { imported_at: T(-20) } });
    imported(db, 7, { importRow: { imported_at: T(-800) } });
    importRow(db, { web_order_id: 'w8', status: 'failed', last_error: 'stale' });

    expect(unseenWebOrders(db as AppDatabase, T(-720))).toEqual([
      {
        orderId: 'o2',
        orderNumber: '20261001-0002',
        customerName: 'Test Bilal',
        webOrderId: 'w2',
        fulfilment: 'delivery',
        totalCents: 180_000,
        webTotalCents: null,
        importedAt: T(-40),
      },
      {
        orderId: 'o1',
        orderNumber: '20261001-0001',
        customerName: 'Test Asma',
        webOrderId: 'w1',
        fulfilment: 'pickup',
        totalCents: 120_000,
        webTotalCents: 125_000,
        importedAt: T(-30),
      },
    ]);
  });

  it('openSiteCancels: cancelled on the website since the time given, card not closed, order not dealt with here; name and phone for the signed-in card', () => {
    const db = shop();
    imported(db, 1, { status: 'preparing', name: 'Test Asma', phone: '0300-1111111', importRow: { site_cancelled_at: T(-10) } });
    imported(db, 2, { status: 'ready', name: 'Test Bilal', phone: '0300-2222222', importRow: { site_cancelled_at: T(-20) } });
    // Left out: card closed, order deleted / voided / refunded here, cancelled before the window, never cancelled.
    imported(db, 3, { importRow: { site_cancelled_at: T(-10), cancel_noted_at: T(-9) } });
    imported(db, 4, { deleted: true, importRow: { site_cancelled_at: T(-10) } });
    imported(db, 5, { status: 'void', importRow: { site_cancelled_at: T(-10) } });
    imported(db, 6, { status: 'refunded', importRow: { site_cancelled_at: T(-10) } });
    imported(db, 7, { importRow: { site_cancelled_at: T(-800) } });
    imported(db, 8);

    expect(openSiteCancels(db as AppDatabase, T(-720))).toEqual([
      {
        webOrderId: 'w2',
        orderId: 'o2',
        orderNumber: '20261001-0002',
        customerName: 'Test Bilal',
        customerPhone: '0300-2222222',
        siteCancelledAt: T(-20),
      },
      {
        webOrderId: 'w1',
        orderId: 'o1',
        orderNumber: '20261001-0001',
        customerName: 'Test Asma',
        customerPhone: '0300-1111111',
        siteCancelledAt: T(-10),
      },
    ]);
    markCancelNoted(db as AppDatabase, ['w2'], T(1));
    expect(openSiteCancels(db as AppDatabase, T(-720)).map((r) => r.webOrderId)).toEqual(['w1']);
  });

  it('unconfirmedWebOrders: not confirmed, imported between the two times, oldest first; numbers and times only', () => {
    const db = shop();
    imported(db, 1, { name: 'Test Asma', phone: '0300-1111111', importRow: { imported_at: T(-6), web_created_at: T(-7) } });
    imported(db, 2, { status: 'out_for_delivery', importRow: { imported_at: T(-90) } });
    // Left out: too recent, too old, confirmed, cancelled on the website, deleted / voided / refunded here.
    imported(db, 3, { importRow: { imported_at: T(-3) } });
    imported(db, 4, { importRow: { imported_at: T(-200) } });
    imported(db, 5, { importRow: { imported_at: T(-30), acked_at: T(-29) } });
    imported(db, 6, { importRow: { imported_at: T(-30), site_cancelled_at: T(-1) } });
    imported(db, 7, { deleted: true, importRow: { imported_at: T(-30) } });
    imported(db, 8, { status: 'void', importRow: { imported_at: T(-30) } });
    imported(db, 9, { status: 'refunded', importRow: { imported_at: T(-30) } });

    const rows = unconfirmedWebOrders(db as AppDatabase, { olderThanIso: T(-5), sinceIso: T(-120) });
    expect(rows).toEqual([
      { orderId: 'o2', orderNumber: '20261001-0002', importedAt: T(-90), webCreatedAt: null },
      { orderId: 'o1', orderNumber: '20261001-0001', importedAt: T(-6), webCreatedAt: T(-7) },
    ]);
    // Nothing about the customer goes with it (the PIN screen shows these).
    expect(JSON.stringify(rows)).not.toMatch(/Test Asma|0300/);
    // The edges count: imported exactly at either time is in.
    expect(unconfirmedWebOrders(db as AppDatabase, { olderThanIso: T(-6), sinceIso: T(-6) }).map((r) => r.orderId)).toEqual(['o1']);
  });

  it('is pure-local: no sync entry, no audit row, and the orders are never touched', () => {
    const db = shop();
    imported(db, 1);
    imported(db, 2, { importRow: { site_cancelled_at: T(-5) } });
    imported(db, 3);
    const orders = db.prepare(`SELECT * FROM orders ORDER BY id`).all();
    const ledgers = { sync: count(db, 'sync_queue'), audit: count(db, 'audit_log') };

    markWebOrderAcked(db as AppDatabase, 'w1', T(1));
    markCancelledOnSite(db as AppDatabase, 'w3', T(2));
    markAlertsSeen(db as AppDatabase, ['o1', 'o2', 'o3'], T(3));
    markCancelNoted(db as AppDatabase, ['w2', 'w3'], T(4));

    expect({ sync: count(db, 'sync_queue'), audit: count(db, 'audit_log') }).toEqual(ledgers);
    expect(db.prepare(`SELECT * FROM orders ORDER BY id`).all()).toEqual(orders);
  });
});
