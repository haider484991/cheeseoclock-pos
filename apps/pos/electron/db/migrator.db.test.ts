/**
 * The migrator (migrator.ts: umzug over every migrations/*.sql, bundled with
 * import.meta.glob) on a real database, as the till runs it at boot:
 *   - a brand-new till runs 0001 up to the newest, in number order, once;
 *   - a till on v0.7.22 (0001..0041 applied: 0040 / 0041 are foodpanda's,
 *     released first) runs just 0042_drawer_log, 0043_order_test_delete and
 *     0044_order_came_by, in that order, after a pre-migrate copy — and its v0.7.22 rows (a paid
 *     foodpanda order, its deal and the terms kept at payment) come through
 *     untouched and work with the new code (a test delete, foodpanda's
 *     figures);
 *   - a till already up to date runs nothing.
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for Electron
 * here); skipped where it is missing. Every name, price and amount is made up.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEV, DatabaseSync, migrationFiles, openMigrated } from './costing-shop.fixture.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const h = vi.hoisted(() => ({ snapshots: [] as string[] }));

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', getPath: () => '' },
  BrowserWindow: { getAllWindows: () => [] },
}));
// The pre-migrate copy: recorded, never written to disk here.
vi.mock('../services/backup-service.js', () => ({
  ensureBackupDir: () => 'test-backups',
  snapshotDatabaseTo: (_db: unknown, dest: string) => {
    h.snapshots.push(dest);
  },
}));

const live = describe.skipIf(!DatabaseSync);
const T0 = '2026-09-27T10:00:00.000Z';
const ALL_TIME = { sinceIso: '2000-01-01T00:00:00.000Z', untilIso: '2100-01-01T00:00:00.000Z' };

type Db = ReturnType<typeof openMigrated>;
const ran = (db: Db) => (db.prepare(`SELECT name FROM _migrations ORDER BY rowid`).all() as Array<{ name: string }>).map((r) => r.name);
const columns = (db: Db, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

/**
 * What a v0.7.22 till holds: 0001..0041 run by its migrator (one _migrations
 * row each), and a foodpanda order paid there — the owner's deal on it and
 * the terms kept at payment (0040 / 0041's columns), made-up figures.
 */
function tillOnV0722(): Db {
  const db = openMigrated({ stopBefore: '0042' });
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, ran_at TEXT NOT NULL)`);
  const log = db.prepare(`INSERT INTO _migrations (name, ran_at) VALUES (?, ?)`);
  for (const f of migrationFiles().filter((m) => m < '0042')) log.run(f, T0);

  const user = db.prepare(`INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`);
  user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
  user.run('u_admin', 'Test Owner', 'admin', T0, T0, DEV);
  db.prepare(
    `INSERT INTO orders (id, order_number, mode, status, cashier_id, subtotal_cents, discount_cents, tax_cents,
                         total_cents, source, paid_at, created_at, updated_at, device_id)
     VALUES ('o_fp', '20260927-0007', 'foodpanda', 'sent_to_kitchen', 'u_cash', 200000, 20000, 0, 180000, 'pos', ?, ?, ?, ?)`,
  ).run(T0, T0, T0, DEV);
  db.prepare(
    `INSERT INTO order_discounts (id, order_id, discount_type, value, reason, applied_by_user_id, approved_by_user_id, amount_cents,
                                  source, rule_json, created_at, updated_at, device_id)
     VALUES ('d_fp', 'o_fp', 'percent', 10, 'Foodpanda deal 20% off (your part 10%)', 'u_cash', 'u_admin', 20000,
             'foodpanda', '{"kind":"foodpanda_deal","dealPercent":20,"shopPercent":10}', ?, ?, ?)`,
  ).run(T0, T0, DEV);
  db.prepare(
    `INSERT INTO payments (id, order_id, method, amount_cents, reference_no, received_by_user_id, paid_at, created_at, updated_at, device_id)
     VALUES ('p_fp', 'o_fp', 'foodpanda', 180000, 'FP-0007', 'u_cash', ?, ?, ?, ?)`,
  ).run(T0, T0, T0, DEV);
  db.prepare(
    `INSERT INTO order_channel_terms (id, order_id, channel, deal_label, deal_bps, shop_bps, shop_discount_cents, platform_funded_cents,
                                      commission_bps, commission_base, commission_confirmed, commission_cents, fixed_fee_cents,
                                      commission_tax_cents, expected_payout_cents, uplift_bps, payment_fee_cents,
                                      created_at, updated_at, device_id)
     VALUES ('t_fp', 'o_fp', 'foodpanda', 'Foodpanda deal 20% off (your part 10%)', 2000, 1000, 20000, 20000,
             2500, 'after_deal', 1, 45000, 0, 0, 135000, 0, 0, ?, ?, ?)`,
  ).run(T0, T0, DEV);
  return db;
}

live('migrations at boot (migrator.ts)', () => {
  it('a brand-new till runs 0001 up to the newest, in number order, with no pre-migrate copy', async () => {
    const { runMigrations } = await import('./migrator.js');
    h.snapshots.length = 0;
    const db = openMigrated({ stopBefore: '0001' });
    await runMigrations(db);
    const names = ran(db);
    expect(names).toEqual(migrationFiles());
    expect(names.map((n) => Number(n.slice(0, 4)))).toEqual(names.map((_, i) => i + 1));
    expect(names.slice(-6)).toEqual([
      '0039_shift_close_notes.sql',
      '0040_foodpanda_deal_and_terms.sql',
      '0041_channel_terms_uplift_and_fee.sql',
      '0042_drawer_log.sql',
      '0043_order_test_delete.sql',
      '0044_order_came_by.sql',
    ]);
    expect(h.snapshots).toEqual([]);
  });

  it('a till on v0.7.22 (0001..0041) runs just 0042, 0043 then 0044, after a pre-migrate copy; its foodpanda rows come through untouched', async () => {
    const { runMigrations } = await import('./migrator.js');
    h.snapshots.length = 0;
    const db = tillOnV0722();
    const one = (sql: string) => db.prepare(sql).get() as Record<string, unknown>;
    const before = {
      order: one(`SELECT * FROM orders WHERE id = 'o_fp'`),
      discount: one(`SELECT * FROM order_discounts WHERE id = 'd_fp'`),
      payment: one(`SELECT * FROM payments WHERE id = 'p_fp'`),
      terms: one(`SELECT * FROM order_channel_terms WHERE id = 't_fp'`),
    };
    const had = ran(db);
    expect(had.at(-1)).toBe('0041_channel_terms_uplift_and_fee.sql');
    expect(columns(db, 'drawer_opens')).not.toContain('order_id');
    expect(columns(db, 'orders')).not.toContain('delete_kind');

    await runMigrations(db);

    // Exactly these, in this order, after everything v0.7.22 had.
    expect(ran(db)).toEqual([...had, '0042_drawer_log.sql', '0043_order_test_delete.sql', '0044_order_came_by.sql']);
    expect(h.snapshots).toHaveLength(1);
    // Their columns and the log's start are there…
    expect(columns(db, 'drawer_opens')).toEqual(expect.arrayContaining(['order_id', 'cash_movement_id', 'amount_cents', 'outcome', 'outcome_note', 'settled_at']));
    expect(columns(db, 'orders')).toEqual(expect.arrayContaining(['deleted_by', 'delete_reason', 'delete_kind', 'delete_stock', 'came_by']));
    expect(db.prepare(`SELECT COUNT(*) AS n FROM settings WHERE key = 'drawer.logSince'`).get()).toEqual({ n: 1 });
    // …and v0.7.22's rows are as they were (the order gains the four delete columns and came_by, empty: "not asked").
    expect({
      order: one(`SELECT * FROM orders WHERE id = 'o_fp'`),
      discount: one(`SELECT * FROM order_discounts WHERE id = 'd_fp'`),
      payment: one(`SELECT * FROM payments WHERE id = 'p_fp'`),
      terms: one(`SELECT * FROM order_channel_terms WHERE id = 't_fp'`),
    }).toEqual({ ...before, order: { ...before.order, deleted_by: null, delete_reason: null, delete_kind: null, delete_stock: null, came_by: null } });

    // The next boot: nothing to run, no copy.
    await runMigrations(db);
    expect(ran(db)).toHaveLength(had.length + 3);
    expect(h.snapshots).toHaveLength(1);

    // The new code on the upgraded till: foodpanda's figures read the kept terms…
    const { getFoodpanda } = await import('../services/business-report.js');
    expect(getFoodpanda(db, ALL_TIME)).toMatchObject({ orderCount: 1, commissionCents: 45_000, expectedPayoutCents: 135_000, estimatedOrders: 0 });
    // …and the owner can delete that order as a test: its payment and its terms go with it.
    const { deleteTestOrder } = await import('./repositories/order-repo.js');
    deleteTestOrder(
      db,
      { orderId: 'o_fp', reason: 'Tablet test', restock: null, expectStatus: 'sent_to_kitchen', ownerUserId: 'u_admin' },
      { userId: 'u_admin', deviceId: DEV },
    );
    expect(db.prepare(`SELECT deleted_at IS NOT NULL AS gone FROM order_channel_terms WHERE id = 't_fp'`).get()).toEqual({ gone: 1 });
    expect(db.prepare(`SELECT deleted_at IS NOT NULL AS gone FROM payments WHERE id = 'p_fp'`).get()).toEqual({ gone: 1 });
    expect(getFoodpanda(db, ALL_TIME)).toBeNull();
  });
});
