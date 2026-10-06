/**
 * The migrator (migrator.ts: umzug over every migrations/*.sql, bundled with
 * import.meta.glob) on a real database, as the till runs it at boot:
 *   - a brand-new till runs 0001 up to the newest, in number order, once;
 *   - a till on v0.7.22 (0001..0041 applied: 0040 / 0041 are foodpanda's,
 *     released first) runs just 0042_drawer_log, 0043_order_test_delete,
 *     0044_order_came_by, 0045_web_availability, 0046_web_order_alerts,
 *     0047_no_discount, 0048_order_sent_at, 0049_outside_rider,
 *     0050_shift_counted_notes and 0051_shift_close_report, in that order,
 *     after a pre-migrate copy — and its
 *     v0.7.22 rows (a paid
 *     foodpanda order, its deal and the terms kept at payment) come through
 *     untouched and work with the new code (a test delete, foodpanda's
 *     figures);
 *   - a till on v0.7.29 (0001..0044) runs just 0045_web_availability, then
 *     0046_web_order_alerts, 0047_no_discount, 0048_order_sent_at,
 *     0049_outside_rider, 0050_shift_counted_notes and
 *     0051_shift_close_report: its menu rows come through
 *     untouched, every item and category reads "on the website", and the
 *     website gets the menu it got before;
 *   - a till on v0.7.32 (0001..0045) runs just 0046_web_order_alerts, then
 *     0047_no_discount, 0048_order_sent_at, 0049_outside_rider,
 *     0050_shift_counted_notes and 0051_shift_close_report: its
 *     website-order rows come through, the ones
 *     imported are marked confirmed and seen at their import time (so the
 *     restart that installs it neither warns nor rings), an import attempt
 *     still waiting for its retry and a failed row are left alone, and the
 *     audit chain verifies;
 *   - a till on v0.7.33 (0001..0046) runs just 0047_no_discount, then
 *     0048_order_sent_at, 0049_outside_rider, 0050_shift_counted_notes and
 *     0051_shift_close_report: its
 *     categories and order lines come through untouched (no version, no
 *     updated_at, no sync or audit row), every category reads by its name
 *     (Value Deals never discounted, Pizza discounted), every line sold
 *     reads 0, and paid orders keep their stored totals;
 *   - the same v0.7.33 database with a closed shift (an order carried over
 *     out for delivery with one of the shop's own riders): its shift, order
 *     and cash rows come through untouched, the order reads as an own
 *     rider's with no sentAt (its clock falls back to when it was started),
 *     the closed shift reads as it closed (no note count, no saved report,
 *     none in Shift history) and its figures still add up with the new code,
 *     the pre-migrate copy holds the database as v0.7.33 left it, and the
 *     audit chain verifies;
 *   - a till with 0047 (0001..0047) runs just 0048_order_sent_at, then
 *     0049_outside_rider, 0050_shift_counted_notes and
 *     0051_shift_close_report: every order reads
 *     sent_at NULL (its Live Orders
 *     clock falls back to when it was started), its version and updated_at
 *     untouched, no sync or audit row added;
 *   - a till with 0048 (0001..0048) runs just 0049_outside_rider, then
 *     0050_shift_counted_notes and 0051_shift_close_report: every
 *     order reads rider_keeps_cents NULL and every cash movement order_id
 *     NULL, untouched, no sync or audit row added, and an order already out
 *     for delivery reads as one of the shop's own riders (no riderKeepsCents);
 *   - a till on v0.7.34 (0001..0049) runs just 0050_shift_counted_notes,
 *     then 0051_shift_close_report: every shift reads counted_notes_json and
 *     close_report_json NULL (a closed one has no note count and no saved
 *     report, its figures as they were), untouched, no sync or audit row
 *     added, and the shift still open there closes counted by note;
 *   - the same v0.7.34 database with a closed shift and its orders (a
 *     delivery an outside rider paid in cash, keeping his charge, and a card
 *     takeaway): the pre-migrate copy holds it as v0.7.34 left it, every row
 *     comes through untouched, the shift reads no note count and no saved
 *     report (none in Shift history either), its figures add up as they did,
 *     and the audit chain verifies;
 *   - a till already up to date runs nothing.
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for Electron
 * here); skipped where it is missing. Every name, price and amount is made up.
 */
import { describe, expect, it, vi } from 'vitest';
import { CASH_NOTE_FACE_CENTS } from '@cheeseoclock/shared-types';
import { DEV, DatabaseSync, migrationFiles, openMigrated } from './costing-shop.fixture.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const h = vi.hoisted(() => ({
  snapshots: [] as string[],
  /** What each pre-migrate copy holds: the last migration run, and the shifts table's columns, when it was taken. */
  copied: [] as Array<{ lastRan: string | undefined; shiftColumns: string[] }>,
}));

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', getPath: () => '' },
  BrowserWindow: { getAllWindows: () => [] },
}));
// The pre-migrate copy: recorded (what the database held at that moment), never written to disk here.
vi.mock('../services/backup-service.js', () => ({
  ensureBackupDir: () => 'test-backups',
  snapshotDatabaseTo: (db: { prepare: (sql: string) => { all: () => unknown[] } }, dest: string) => {
    h.snapshots.push(dest);
    const names = (db.prepare(`SELECT name FROM _migrations ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name);
    const shiftColumns = (db.prepare(`PRAGMA table_info(shifts)`).all() as Array<{ name: string }>).map((c) => c.name);
    h.copied.push({ lastRan: names.at(-1), shiftColumns });
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
    expect(names.slice(-14)).toEqual([
      '0039_shift_close_notes.sql',
      '0040_foodpanda_deal_and_terms.sql',
      '0041_channel_terms_uplift_and_fee.sql',
      '0042_drawer_log.sql',
      '0043_order_test_delete.sql',
      '0044_order_came_by.sql',
      '0045_web_availability.sql',
      '0046_web_order_alerts.sql',
      '0047_no_discount.sql',
      '0048_order_sent_at.sql',
      '0049_outside_rider.sql',
      '0050_shift_counted_notes.sql',
      '0051_shift_close_report.sql',
      '0052_card_rate.sql',
    ]);
    expect(h.snapshots).toEqual([]);
  });

  it('a till on v0.7.22 (0001..0041) runs just 0042, 0043, 0044, 0045, 0046, 0047, 0048, 0049, 0050, 0051 then 0052, after a pre-migrate copy; its foodpanda rows come through untouched', async () => {
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
    expect(ran(db)).toEqual([
      ...had,
      '0042_drawer_log.sql',
      '0043_order_test_delete.sql',
      '0044_order_came_by.sql',
      '0045_web_availability.sql',
      '0046_web_order_alerts.sql',
      '0047_no_discount.sql',
      '0048_order_sent_at.sql',
      '0049_outside_rider.sql',
      '0050_shift_counted_notes.sql',
      '0051_shift_close_report.sql',
      '0052_card_rate.sql',
    ]);
    expect(h.snapshots).toHaveLength(1);
    // Their columns and the log's start are there…
    expect(columns(db, 'drawer_opens')).toEqual(expect.arrayContaining(['order_id', 'cash_movement_id', 'amount_cents', 'outcome', 'outcome_note', 'settled_at']));
    expect(columns(db, 'orders')).toEqual(expect.arrayContaining(['deleted_by', 'delete_reason', 'delete_kind', 'delete_stock', 'came_by', 'sent_at', 'rider_keeps_cents']));
    expect(db.prepare(`SELECT COUNT(*) AS n FROM settings WHERE key = 'drawer.logSince'`).get()).toEqual({ n: 1 });
    // …and v0.7.22's rows are as they were (the order gains the four delete columns and came_by, empty: "not asked";
    // and sent_at, empty: its clock reads from when it was started; and rider_keeps_cents, empty: no outside rider).
    expect({
      order: one(`SELECT * FROM orders WHERE id = 'o_fp'`),
      discount: one(`SELECT * FROM order_discounts WHERE id = 'd_fp'`),
      payment: one(`SELECT * FROM payments WHERE id = 'p_fp'`),
      terms: one(`SELECT * FROM order_channel_terms WHERE id = 't_fp'`),
    }).toEqual({
      ...before,
      order: { ...before.order, deleted_by: null, delete_reason: null, delete_kind: null, delete_stock: null, came_by: null, sent_at: null, rider_keeps_cents: null, digital_total_cents: null, digital_net_cents: 0, digital_tax_cents: 0 },
    });

    // The next boot: nothing to run, no copy.
    await runMigrations(db);
    expect(ran(db)).toHaveLength(had.length + 11);
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

  it('a till on v0.7.29 (0001..0044) runs just 0045, 0046, 0047, 0048, 0049, 0050, 0051 then 0052, after a pre-migrate copy: its menu rows are untouched, every item and category reads on the website, and the published menu is what it was', async () => {
    const { runMigrations } = await import('./migrator.js');
    h.snapshots.length = 0;
    const db = openMigrated({ stopBefore: '0045' });
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, ran_at TEXT NOT NULL)`);
    const log = db.prepare(`INSERT INTO _migrations (name, ran_at) VALUES (?, ?)`);
    for (const f of migrationFiles().filter((m) => m < '0045')) log.run(f, T0);
    // v0.7.29's menu, as its repositories wrote it (made-up names and prices).
    db.prepare(`INSERT INTO tax_categories (id, name, rate_bps, created_at, updated_at, device_id) VALUES ('t1', 'Test GST', 1600, ?, ?, ?)`).run(T0, T0, DEV);
    const cat = db.prepare(
      `INSERT INTO categories (id, name, display_order, color_hex, is_active, created_at, updated_at, device_id) VALUES (?, ?, ?, '#aa5500', ?, ?, ?, ?)`,
    );
    cat.run('c_food', 'Test food', 1, 1, T0, T0, DEV);
    cat.run('c_old', 'Test old', 2, 0, T0, T0, DEV);
    const item = db.prepare(
      `INSERT INTO menu_items (id, category_id, name, description, base_price_cents, is_active, prep_station, tax_category_id, sort_order, created_at, updated_at, device_id)
       VALUES (?, ?, ?, ?, ?, ?, 'kitchen', 't1', ?, ?, ?, ?)`,
    );
    item.run('i_pizza', 'c_food', 'Test Pizza', 'Pick-up only', 100_000, 1, 1, T0, T0, DEV);
    item.run('i_side', 'c_food', 'Test Side', null, 30_000, 0, 2, T0, T0, DEV);
    const one = (sql: string) => db.prepare(sql).get() as Record<string, unknown>;
    const before = { pizza: one(`SELECT * FROM menu_items WHERE id = 'i_pizza'`), food: one(`SELECT * FROM categories WHERE id = 'c_food'`) };
    const had = ran(db);
    expect(had.at(-1)).toBe('0044_order_came_by.sql');
    expect(columns(db, 'menu_items')).not.toContain('web_availability');
    expect(columns(db, 'categories')).not.toContain('is_on_website');

    await runMigrations(db);

    expect(ran(db)).toEqual([
      ...had,
      '0045_web_availability.sql',
      '0046_web_order_alerts.sql',
      '0047_no_discount.sql',
      '0048_order_sent_at.sql',
      '0049_outside_rider.sql',
      '0050_shift_counted_notes.sql',
      '0051_shift_close_report.sql',
      '0052_card_rate.sql',
    ]);
    expect(h.snapshots).toHaveLength(1);
    // Every row as it was, with the two new columns at "on the website" (and 0047's, empty: by its name).
    expect({
      pizza: one(`SELECT * FROM menu_items WHERE id = 'i_pizza'`),
      food: one(`SELECT * FROM categories WHERE id = 'c_food'`),
    }).toEqual({ pizza: { ...before.pizza, web_availability: 'on' }, food: { ...before.food, is_on_website: 1, no_discount: null } });
    expect(db.prepare(`SELECT DISTINCT web_availability AS w FROM menu_items`).all()).toEqual([{ w: 'on' }]);
    expect(db.prepare(`SELECT DISTINCT is_on_website AS w FROM categories`).all()).toEqual([{ w: 1 }]);
    // The repositories read them so.
    const { listMenuItems } = await import('./repositories/menu-item-repo.js');
    const { listCategories } = await import('./repositories/category-repo.js');
    expect(listMenuItems(db).map((i) => [i.id, i.webAvailability])).toEqual([
      ['i_pizza', 'on'],
      ['i_side', 'on'],
    ]);
    expect(listCategories(db).map((c) => [c.id, c.isOnWebsite])).toEqual([
      ['c_food', true],
      ['c_old', true],
    ]);
    // The next boot: nothing to run, no copy.
    await runMigrations(db);
    expect(ran(db)).toHaveLength(had.length + 8);
    expect(h.snapshots).toHaveLength(1);
  });

  it('a till on v0.7.32 (0001..0045) runs just 0046, 0047, 0048, 0049, 0050, 0051 then 0052, after a pre-migrate copy: its website-order rows come through, the imported ones read confirmed and seen, a waiting attempt and a failed row do not, and the audit chain verifies', async () => {
    const { runMigrations } = await import('./migrator.js');
    const { writeAudit } = await import('./repositories/audit-repo.js');
    const { verifyAuditChain } = await import('./audit-chain.js');
    const repo = await import('./repositories/web-order-imports-repo.js');
    h.snapshots.length = 0;
    const db = openMigrated({ stopBefore: '0046' });
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, ran_at TEXT NOT NULL)`);
    const log = db.prepare(`INSERT INTO _migrations (name, ran_at) VALUES (?, ?)`);
    for (const f of migrationFiles().filter((m) => m < '0046')) log.run(f, T0);
    // v0.7.32's website orders, as its bridge left them (made-up customer): one delivered, one still New.
    db.prepare(`INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES ('u_admin', 'Test Owner', 'x', 'admin', ?, ?, ?)`).run(T0, T0, DEV);
    const order = db.prepare(
      `INSERT INTO orders (id, order_number, mode, status, cashier_id, source, customer_name_snapshot, customer_phone_snapshot,
                           total_cents, created_at, updated_at, device_id)
       VALUES (?, ?, ?, ?, 'u_admin', 'web', 'Test Customer', '0300-0000000', 150000, ?, ?, ?)`,
    );
    order.run('o_w1', '20260927-0001', 'delivery', 'delivered', T0, T0, DEV);
    order.run('o_w2', '20260927-0002', 'takeaway', 'sent_to_kitchen', T0, T0, DEV);
    for (const id of ['o_w1', 'o_w2']) {
      writeAudit(db, { entityType: 'order', entityId: id, action: 'create', actorUserId: 'u_admin', before: null, after: { id } });
    }
    const imp = db.prepare(
      `INSERT INTO web_order_imports (web_order_id, pos_order_id, status, attempts, last_error, last_pushed_status, imported_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    imp.run('w1', 'o_w1', 'imported', 1, null, 'delivered', '2026-09-27T10:01:00.000Z', T0, '2026-09-27T11:00:00.000Z');
    imp.run('w2', 'o_w2', 'imported', 1, null, 'accepted', '2026-09-27T10:02:00.000Z', T0, '2026-09-27T10:02:00.000Z');
    // An import attempt waiting for its retry (the status column's default), and one the till gave up on.
    imp.run('w3', null, 'imported', 2, 'item gone', null, null, T0, '2026-09-27T10:03:00.000Z');
    imp.run('w4', null, 'failed', 0, 'stale', null, null, T0, '2026-09-27T10:04:00.000Z');
    const all = (sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>;
    const before = {
      imports: all(`SELECT * FROM web_order_imports ORDER BY web_order_id`),
      orders: all(`SELECT * FROM orders ORDER BY id`),
      audit: all(`SELECT * FROM audit_log ORDER BY rowid`),
    };
    const had = ran(db);
    expect(had.at(-1)).toBe('0045_web_availability.sql');
    expect(columns(db, 'web_order_imports')).not.toContain('acked_at');

    await runMigrations(db);

    expect(ran(db)).toEqual([
      ...had,
      '0046_web_order_alerts.sql',
      '0047_no_discount.sql',
      '0048_order_sent_at.sql',
      '0049_outside_rider.sql',
      '0050_shift_counted_notes.sql',
      '0051_shift_close_report.sql',
      '0052_card_rate.sql',
    ]);
    expect(h.snapshots).toHaveLength(1);
    const added =['web_created_at', 'web_total_cents', 'acked_at', 'alert_seen_at', 'site_cancelled_at', 'cancel_noted_at'];
    expect(columns(db, 'web_order_imports')).toEqual([...Object.keys(before.imports[0] ?? {}), ...added]);
    // Every row as it was, with the new columns: the imported ones confirmed and seen when they came in.
    const empty = Object.fromEntries(added.map((c) => [c, null]));
    const seenAt = (r: Record<string, unknown>) => ({ ...empty, acked_at: r['imported_at'], alert_seen_at: r['imported_at'] });
    expect(all(`SELECT * FROM web_order_imports ORDER BY web_order_id`)).toEqual(
      before.imports.map((r) => ({ ...r, ...(r['pos_order_id'] !== null && r['status'] === 'imported' ? seenAt(r) : empty) })),
    );
    expect(all(`SELECT web_order_id AS id, acked_at FROM web_order_imports WHERE acked_at IS NOT NULL ORDER BY web_order_id`).map((r) => r['id'])).toEqual(['w1', 'w2']);
    // Orders and the audit trail untouched (an order gains sent_at and rider_keeps_cents, empty), and the chain still verifies.
    expect(all(`SELECT * FROM orders ORDER BY id`)).toEqual(before.orders.map((r) => ({ ...r, sent_at: null, rider_keeps_cents: null, digital_total_cents: null, digital_net_cents: 0, digital_tax_cents: 0 })));
    expect(all(`SELECT * FROM audit_log ORDER BY rowid`)).toEqual(before.audit);
    const chainRows = all(
      `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action, actor_user_id AS actorUserId,
              before_json AS beforeJson, after_json AS afterJson, ip, created_at AS createdAt,
              prev_hash AS prevHash, row_hash AS rowHash
         FROM audit_log ORDER BY rowid`,
    ).map((r) => ({ ...r, rowid: Number(r['rowid']) })) as unknown as Parameters<typeof verifyAuditChain>[0];
    expect(verifyAuditChain(chainRows)).toMatchObject({ ok: true, checkedRows: 2 });
    // The first poll and the first boot find nothing to retry or ring for: the New order was seen on v0.7.32.
    expect(repo.listUnackedImports(db, '2026-09-27T00:00:00.000Z')).toEqual([]);
    expect(repo.unseenWebOrders(db, '2026-09-27T00:00:00.000Z')).toEqual([]);

    // The next boot: nothing to run, no copy.
    await runMigrations(db);
    expect(ran(db)).toHaveLength(had.length + 7);
    expect(h.snapshots).toHaveLength(1);
  });

  it('a till on v0.7.33 (0001..0046) runs just 0047, 0048, 0049, 0050, 0051 then 0052, after a pre-migrate copy: its categories and order lines are untouched (no version, no updated_at, no sync or audit row), each category reads by its name, each line sold reads 0, and paid orders keep their stored totals', async () => {
    const { runMigrations } = await import('./migrator.js');
    const { writeAudit } = await import('./repositories/audit-repo.js');
    h.snapshots.length = 0;
    const db = openMigrated({ stopBefore: '0047' });
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, ran_at TEXT NOT NULL)`);
    const log = db.prepare(`INSERT INTO _migrations (name, ran_at) VALUES (?, ?)`);
    for (const f of migrationFiles().filter((m) => m < '0047')) log.run(f, T0);
    // v0.7.33's menu and a paid order with a deal and a pizza on it, as its repositories left them (made-up names and prices).
    db.prepare(`INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES ('u_admin', 'Test Owner', 'x', 'admin', ?, ?, ?)`).run(T0, T0, DEV);
    db.prepare(`INSERT INTO tax_categories (id, name, rate_bps, created_at, updated_at, device_id) VALUES ('t1', 'Test GST', 1500, ?, ?, ?)`).run(T0, T0, DEV);
    const cat = db.prepare(
      `INSERT INTO categories (id, name, display_order, color_hex, is_active, created_at, updated_at, device_id, version) VALUES (?, ?, ?, '#aa5500', 1, ?, ?, ?, ?)`,
    );
    cat.run('c_deals', 'Test Value Deals', 1, T0, T0, DEV, 3);
    cat.run('c_pizza', 'Test Pizza', 2, T0, T0, DEV, 2);
    const item = db.prepare(
      `INSERT INTO menu_items (id, category_id, name, base_price_cents, is_active, prep_station, tax_category_id, sort_order, created_at, updated_at, device_id)
       VALUES (?, ?, ?, ?, 1, 'kitchen', 't1', ?, ?, ?, ?)`,
    );
    item.run('i_deal', 'c_deals', 'Test Big Deal', 360_000, 1, T0, T0, DEV);
    item.run('i_pizza', 'c_pizza', 'Test Pizza Large', 150_000, 2, T0, T0, DEV);
    db.prepare(
      `INSERT INTO orders (id, order_number, mode, status, cashier_id, subtotal_cents, discount_cents, tax_cents, total_cents,
                           source, paid_at, created_at, updated_at, device_id)
       VALUES ('o_paid', '20261001-0004', 'takeaway', 'paid', 'u_admin', 510000, 51000, 68850, 527850, 'pos', ?, ?, ?, ?)`,
    ).run(T0, T0, T0, DEV);
    const line = db.prepare(
      `INSERT INTO order_items (id, order_id, menu_item_id, menu_item_name, quantity, unit_price_cents, line_total_cents,
                                tax_category_id, tax_rate_bps_snapshot, prep_station_snapshot, created_at, updated_at, device_id)
       VALUES (?, 'o_paid', ?, ?, 1, ?, ?, 't1', 1500, 'kitchen', ?, ?, ?)`,
    );
    line.run('l_deal', 'i_deal', 'Test Big Deal', 360_000, 360_000, T0, T0, DEV);
    line.run('l_pizza', 'i_pizza', 'Test Pizza Large', 150_000, 150_000, T0, T0, DEV);
    writeAudit(db, { entityType: 'categories', entityId: 'c_deals', action: 'create', actorUserId: 'u_admin', before: null, after: { id: 'c_deals' } });
    const all = (sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>;
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const before = {
      categories: all(`SELECT * FROM categories ORDER BY id`),
      lines: all(`SELECT * FROM order_items ORDER BY id`),
      orders: all(`SELECT * FROM orders ORDER BY id`),
      sync: count('sync_queue'),
      audit: count('audit_log'),
    };
    const had = ran(db);
    expect(had.at(-1)).toBe('0046_web_order_alerts.sql');
    expect(columns(db, 'categories')).not.toContain('no_discount');
    expect(columns(db, 'order_items')).not.toContain('no_discount');

    await runMigrations(db);

    expect(ran(db)).toEqual([
      ...had,
      '0047_no_discount.sql',
      '0048_order_sent_at.sql',
      '0049_outside_rider.sql',
      '0050_shift_counted_notes.sql',
      '0051_shift_close_report.sql',
      '0052_card_rate.sql',
    ]);
    expect(h.snapshots).toHaveLength(1);
    // Every row as it was — the same version and updated_at — with the new column: empty on a category, 0 on a line
    // (and 0048's sent_at and 0049's rider_keeps_cents, empty on an order).
    expect(all(`SELECT * FROM categories ORDER BY id`)).toEqual(before.categories.map((r) => ({ ...r, no_discount: null })));
    expect(all(`SELECT * FROM order_items ORDER BY id`)).toEqual(before.lines.map((r) => ({ ...r, no_discount: 0, digital_rate_bps_snapshot: null })));
    expect(all(`SELECT * FROM orders ORDER BY id`)).toEqual(before.orders.map((r) => ({ ...r, sent_at: null, rider_keeps_cents: null, digital_total_cents: null, digital_net_cents: 0, digital_tax_cents: 0 })));
    expect(all(`SELECT id, subtotal_cents, discount_cents, tax_cents, total_cents FROM orders`)).toEqual([
      { id: 'o_paid', subtotal_cents: 510_000, discount_cents: 51_000, tax_cents: 68_850, total_cents: 527_850 },
    ]);
    // Nothing to send to the other till, nothing in the audit trail: the migration changed no business fact.
    expect({ sync: count('sync_queue'), audit: count('audit_log') }).toEqual({ sync: before.sync, audit: before.audit });
    // Each category reads by its name: the deals never discounted, the pizza discounted.
    const { listCategories } = await import('./repositories/category-repo.js');
    const { categoryNeverDiscounted } = await import('@cheeseoclock/shared-types');
    expect(listCategories(db).map((c) => [c.id, c.noDiscount, categoryNeverDiscounted(c)])).toEqual([
      ['c_deals', null, true],
      ['c_pizza', null, false],
    ]);

    // The next boot: nothing to run, no copy.
    await runMigrations(db);
    expect(ran(db)).toHaveLength(had.length + 6);
    expect(h.snapshots).toHaveLength(1);
  });

  it('a v0.7.33 database (0001..0046) with a closed shift and an order out for delivery runs 0047, 0048, 0049, 0050, 0051 then 0052 after a pre-migrate copy: the order reads as an own rider’s with no sentAt, the shift as it closed with no note count and no saved report, and the audit chain verifies', async () => {
    const { runMigrations } = await import('./migrator.js');
    const { writeAudit } = await import('./repositories/audit-repo.js');
    const { verifyAuditChain } = await import('./audit-chain.js');
    const { isOutsideRiderOrder } = await import('@cheeseoclock/shared-types');
    h.snapshots.length = 0;
    h.copied.length = 0;
    const db = openMigrated({ stopBefore: '0047' });
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, ran_at TEXT NOT NULL)`);
    const log = db.prepare(`INSERT INTO _migrations (name, ran_at) VALUES (?, ?)`);
    for (const f of migrationFiles().filter((m) => m < '0047')) log.run(f, T0);
    // What v0.7.33 left (made-up names and numbers): last night's shift, closed Rs 10 short with a gas payout,
    // and a delivery still out with one of the shop's own riders, carried over unpaid at the close.
    const user = db.prepare(`INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`);
    user.run('u_admin', 'Test Owner', 'admin', T0, T0, DEV);
    user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
    db.prepare(`INSERT INTO riders (id, name, phone, created_at, updated_at, device_id) VALUES ('r_own', 'Test Rider', '03001234567', ?, ?, ?)`).run(T0, T0, DEV);
    const opened = '2026-10-01T13:00:00.000Z';
    const closed = '2026-10-01T18:00:00.000Z';
    db.prepare(
      `INSERT INTO shifts (id, device_id, opened_by_user_id, opened_at, opening_cash_cents, closed_by_user_id, closed_at,
                           counted_cash_cents, expected_cash_cents, variance_cents, close_notes, carried_unpaid_count, carry_over_reason,
                           created_at, updated_at, version)
       VALUES ('s_closed', ?, 'u_admin', ?, 500000, 'u_admin', ?, 489000, 490000, -1000, 'Test: Rs 10 short', 1, 'Rider still out', ?, ?, 2)`,
    ).run(DEV, opened, closed, opened, closed);
    db.prepare(
      `INSERT INTO cash_movements (id, shift_id, type, amount_cents, reason, user_id, created_at, updated_at, device_id)
       VALUES ('m_gas', 's_closed', 'payout', 10000, 'Gas cylinder', 'u_admin', ?, ?, ?)`,
    ).run(opened, opened, DEV);
    db.prepare(
      `INSERT INTO orders (id, order_number, mode, status, cashier_id, subtotal_cents, tax_cents, total_cents, source, shift_id,
                           assigned_rider_id, dispatched_at, created_at, updated_at, device_id, version)
       VALUES ('o_out', '20261001-0031', 'delivery', 'out_for_delivery', 'u_cash', 410000, 61500, 471500, 'pos', 's_closed',
               'r_own', '2026-10-01T17:40:00.000Z', '2026-10-01T17:00:00.000Z', '2026-10-01T17:40:00.000Z', ?, 5)`,
    ).run(DEV);
    writeAudit(db, { entityType: 'orders', entityId: 'o_out', action: 'assign_rider', actorUserId: 'u_cash', before: null, after: { id: 'o_out', assignedRiderId: 'r_own' } });
    writeAudit(db, { entityType: 'shifts', entityId: 's_closed', action: 'shift_close', actorUserId: 'u_admin', before: null, after: { id: 's_closed', varianceCents: -1000 } });
    const all = (sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>;
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const before = {
      shifts: all(`SELECT * FROM shifts ORDER BY id`),
      orders: all(`SELECT * FROM orders ORDER BY id`),
      movements: all(`SELECT * FROM cash_movements ORDER BY id`),
      audit: all(`SELECT * FROM audit_log ORDER BY rowid`),
      sync: count('sync_queue'),
    };
    const had = ran(db);
    expect(had.at(-1)).toBe('0046_web_order_alerts.sql');
    expect(columns(db, 'orders')).not.toContain('sent_at');
    expect(columns(db, 'orders')).not.toContain('rider_keeps_cents');
    expect(columns(db, 'cash_movements')).not.toContain('order_id');

    await runMigrations(db);

    // In order, after the pre-migrate copy.
    expect(ran(db)).toEqual([
      ...had,
      '0047_no_discount.sql',
      '0048_order_sent_at.sql',
      '0049_outside_rider.sql',
      '0050_shift_counted_notes.sql',
      '0051_shift_close_report.sql',
      '0052_card_rate.sql',
    ]);
    expect(h.snapshots).toHaveLength(1);
    // The copy was taken first: the database as v0.7.33 left it, before 0047 ran, with no note count or report column.
    expect(h.copied).toEqual([{ lastRan: '0046_web_order_alerts.sql', shiftColumns: Object.keys(before.shifts[0] ?? {}) }]);
    expect(h.copied[0]?.shiftColumns).not.toContain('counted_notes_json');
    // Every row as it was, with the new columns empty; the audit trail and the link's queue untouched.
    expect(all(`SELECT * FROM shifts ORDER BY id`)).toEqual(before.shifts.map((r) => ({ ...r, counted_notes_json: null, close_report_json: null })));
    expect(all(`SELECT * FROM orders ORDER BY id`)).toEqual(before.orders.map((r) => ({ ...r, sent_at: null, rider_keeps_cents: null, digital_total_cents: null, digital_net_cents: 0, digital_tax_cents: 0 })));
    expect(all(`SELECT * FROM cash_movements ORDER BY id`)).toEqual(before.movements.map((r) => ({ ...r, order_id: null })));
    expect(all(`SELECT * FROM audit_log ORDER BY rowid`)).toEqual(before.audit);
    expect(count('sync_queue')).toBe(before.sync);

    // The order out reads as one of the shop's own riders, with no sentAt: its rider and the time it left kept.
    const { findOrder, getOrderSnapshot } = await import('./repositories/order-repo.js');
    const out = findOrder(db, 'o_out')!;
    expect(out).not.toHaveProperty('sentAt');
    expect(out).not.toHaveProperty('riderKeepsCents');
    expect(isOutsideRiderOrder(out)).toBe(false);
    expect(out).toMatchObject({ status: 'out_for_delivery', assignedRiderId: 'r_own', dispatchedAt: '2026-10-01T17:40:00.000Z', createdAt: '2026-10-01T17:00:00.000Z' });
    const snap = getOrderSnapshot(db, 'o_out')!;
    expect(snap.order).not.toHaveProperty('sentAt');
    expect(snap.order).not.toHaveProperty('riderKeepsCents');
    expect(snap).not.toHaveProperty('deliveryChargeToRider');

    // The closed shift reads as it closed, and the new code's figures for it add up as v0.7.33's did: no rider charges.
    const { findShift, getShiftCloseReport, getShiftSummary } = await import('./repositories/shift-repo.js');
    expect(findShift(db, 's_closed')).toMatchObject({
      closedAt: closed,
      openingCashCents: 500_000,
      countedCashCents: 489_000,
      expectedCashCents: 490_000,
      varianceCents: -1_000,
      closeNotes: 'Test: Rs 10 short',
      carriedUnpaidCount: 1,
      carryOverReason: 'Rider still out',
      countedNotes: null,
    });
    expect(getShiftSummary(db, 's_closed')).toMatchObject({
      cashSalesCents: 0,
      cashOutCents: 10_000,
      riderChargesCents: 0,
      riderChargeCount: 0,
      expectedCashCents: 490_000,
    });
    // No saved report to read back or print, and Shift history says so (no note count either).
    expect(getShiftCloseReport(db, 's_closed')).toBeNull();
    const { buildTeamTab } = await import('../services/business-report.js');
    expect(buildTeamTab(db, ALL_TIME).shifts.find((s) => s.id === 's_closed')).toMatchObject({ countedNotes: null, hasCloseReport: false });

    // The audit chain verifies.
    const chainRows = all(
      `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action, actor_user_id AS actorUserId,
              before_json AS beforeJson, after_json AS afterJson, ip, created_at AS createdAt,
              prev_hash AS prevHash, row_hash AS rowHash
         FROM audit_log ORDER BY rowid`,
    ).map((r) => ({ ...r, rowid: Number(r['rowid']) })) as unknown as Parameters<typeof verifyAuditChain>[0];
    expect(verifyAuditChain(chainRows)).toMatchObject({ ok: true, checkedRows: 2 });

    // The next boot: nothing to run, no copy.
    await runMigrations(db);
    expect(ran(db)).toHaveLength(had.length + 6);
    expect(h.snapshots).toHaveLength(1);
  });

  it('a till with 0047 (0001..0047) runs just 0048, 0049, 0050, 0051 then 0052, after a pre-migrate copy: every order reads sent_at NULL (its clock falls back to when it was started), the same version and updated_at, and no sync or audit row is added', async () => {
    const { runMigrations } = await import('./migrator.js');
    const { writeAudit } = await import('./repositories/audit-repo.js');
    h.snapshots.length = 0;
    const db = openMigrated({ stopBefore: '0048' });
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, ran_at TEXT NOT NULL)`);
    const log = db.prepare(`INSERT INTO _migrations (name, ran_at) VALUES (?, ?)`);
    for (const f of migrationFiles().filter((m) => m < '0048')) log.run(f, T0);
    // Orders as a till with 0047 left them (made-up numbers): one in the kitchen, one paid, a cart still open.
    db.prepare(`INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES ('u_admin', 'Test Owner', 'x', 'admin', ?, ?, ?)`).run(T0, T0, DEV);
    const order = db.prepare(
      `INSERT INTO orders (id, order_number, mode, status, cashier_id, total_cents, source, paid_at, created_at, updated_at, device_id, version)
       VALUES (?, ?, 'takeaway', ?, 'u_admin', 150000, 'pos', ?, ?, ?, ?, ?)`,
    );
    order.run('o_kitchen', '20261001-0011', 'preparing', null, T0, '2026-09-27T10:05:00.000Z', DEV, 3);
    order.run('o_paid', '20261001-0012', 'paid', T0, T0, '2026-09-27T10:20:00.000Z', DEV, 4);
    order.run('o_cart', '20261001-0013', 'open', null, T0, T0, DEV, 1);
    writeAudit(db, { entityType: 'orders', entityId: 'o_paid', action: 'tender', actorUserId: 'u_admin', before: null, after: { id: 'o_paid' } });
    const all = (sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>;
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const before = { orders: all(`SELECT * FROM orders ORDER BY id`), sync: count('sync_queue'), audit: count('audit_log') };
    const had = ran(db);
    expect(had.at(-1)).toBe('0047_no_discount.sql');
    expect(columns(db, 'orders')).not.toContain('sent_at');

    await runMigrations(db);

    expect(ran(db)).toEqual([...had, '0048_order_sent_at.sql', '0049_outside_rider.sql', '0050_shift_counted_notes.sql', '0051_shift_close_report.sql', '0052_card_rate.sql']);
    expect(h.snapshots).toHaveLength(1);
    // Every order as it was — the same version and updated_at — with sent_at empty (no backfill), and 0049's rider_keeps_cents.
    expect(all(`SELECT * FROM orders ORDER BY id`)).toEqual(before.orders.map((r) => ({ ...r, sent_at: null, rider_keeps_cents: null, digital_total_cents: null, digital_net_cents: 0, digital_tax_cents: 0 })));
    expect(all(`SELECT id, version, updated_at FROM orders ORDER BY id`)).toEqual([
      { id: 'o_cart', version: 1, updated_at: T0 },
      { id: 'o_kitchen', version: 3, updated_at: '2026-09-27T10:05:00.000Z' },
      { id: 'o_paid', version: 4, updated_at: '2026-09-27T10:20:00.000Z' },
    ]);
    // Nothing to send to the other till, nothing in the audit trail: the migration changed no business fact.
    expect({ sync: count('sync_queue'), audit: count('audit_log') }).toEqual({ sync: before.sync, audit: before.audit });
    // The index is there, and the repository reads no sentAt: the clock falls back to when the order was started.
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_orders_status_sent'`).get()).toEqual({ name: 'idx_orders_status_sent' });
    const { findOrder } = await import('./repositories/order-repo.js');
    expect(findOrder(db, 'o_kitchen')).not.toHaveProperty('sentAt');

    // The next boot: nothing to run, no copy.
    await runMigrations(db);
    expect(ran(db)).toHaveLength(had.length + 5);
    expect(h.snapshots).toHaveLength(1);
  });

  it('a till with 0048 (0001..0048) runs just 0049, 0050, 0051 then 0052, after a pre-migrate copy: orders and cash movements come through untouched with the new columns empty, no sync or audit row is added, and an order already out reads as one of the shop’s own riders', async () => {
    const { runMigrations } = await import('./migrator.js');
    const { writeAudit } = await import('./repositories/audit-repo.js');
    const { isOutsideRiderOrder } = await import('@cheeseoclock/shared-types');
    h.snapshots.length = 0;
    const db = openMigrated({ stopBefore: '0049' });
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, ran_at TEXT NOT NULL)`);
    const log = db.prepare(`INSERT INTO _migrations (name, ran_at) VALUES (?, ?)`);
    for (const f of migrationFiles().filter((m) => m < '0049')) log.run(f, T0);
    // What a till with 0048 holds (made-up names and numbers): a delivery out with one of its riders,
    // one ready, one paid, and a shift with a payout (gas) and a pay-in (change).
    db.prepare(`INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES ('u_admin', 'Test Owner', 'x', 'admin', ?, ?, ?)`).run(T0, T0, DEV);
    db.prepare(`INSERT INTO riders (id, name, phone, created_at, updated_at, device_id) VALUES ('r_own', 'Test Rider', '03001234567', ?, ?, ?)`).run(T0, T0, DEV);
    db.prepare(`INSERT INTO shifts (id, device_id, opened_by_user_id, opened_at, created_at, updated_at) VALUES ('s_1', ?, 'u_admin', ?, ?, ?)`).run(DEV, T0, T0, T0);
    const order = db.prepare(
      `INSERT INTO orders (id, order_number, mode, status, cashier_id, total_cents, source, paid_at, assigned_rider_id, dispatched_at,
                           sent_at, created_at, updated_at, device_id, version)
       VALUES (?, ?, 'delivery', ?, 'u_admin', 471500, 'pos', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    order.run('o_out', '20261002-0021', 'out_for_delivery', null, 'r_own', '2026-09-27T10:30:00.000Z', T0, T0, '2026-09-27T10:30:00.000Z', DEV, 5);
    order.run('o_ready', '20261002-0022', 'ready', null, null, null, T0, T0, '2026-09-27T10:25:00.000Z', DEV, 4);
    order.run('o_paid', '20261002-0023', 'paid', T0, null, null, T0, T0, '2026-09-27T10:40:00.000Z', DEV, 6);
    const movement = db.prepare(
      `INSERT INTO cash_movements (id, shift_id, type, amount_cents, reason, user_id, created_at, updated_at, device_id, version)
       VALUES (?, 's_1', ?, ?, ?, 'u_admin', ?, ?, ?, ?)`,
    );
    movement.run('m_gas', 'payout', 50_000, 'Gas cylinder', T0, T0, DEV, 1);
    movement.run('m_change', 'payin', 100_000, 'Change for the float', T0, '2026-09-27T10:10:00.000Z', DEV, 2);
    writeAudit(db, { entityType: 'orders', entityId: 'o_out', action: 'assign_rider', actorUserId: 'u_admin', before: null, after: { id: 'o_out' } });
    const all = (sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>;
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const before = {
      orders: all(`SELECT * FROM orders ORDER BY id`),
      movements: all(`SELECT * FROM cash_movements ORDER BY id`),
      sync: count('sync_queue'),
      audit: count('audit_log'),
    };
    const had = ran(db);
    expect(had.at(-1)).toBe('0048_order_sent_at.sql');
    expect(columns(db, 'orders')).not.toContain('rider_keeps_cents');
    expect(columns(db, 'cash_movements')).not.toContain('order_id');

    await runMigrations(db);

    expect(ran(db)).toEqual([...had, '0049_outside_rider.sql', '0050_shift_counted_notes.sql', '0051_shift_close_report.sql', '0052_card_rate.sql']);
    expect(h.snapshots).toHaveLength(1);
    // Every row as it was — the same version and updated_at — with the new column empty (no backfill).
    expect(all(`SELECT * FROM orders ORDER BY id`)).toEqual(before.orders.map((r) => ({ ...r, rider_keeps_cents: null, digital_total_cents: null, digital_net_cents: 0, digital_tax_cents: 0 })));
    expect(all(`SELECT * FROM cash_movements ORDER BY id`)).toEqual(before.movements.map((r) => ({ ...r, order_id: null })));
    // Nothing to send to the other till, nothing in the audit trail: the migration changed no business fact.
    expect({ sync: count('sync_queue'), audit: count('audit_log') }).toEqual({ sync: before.sync, audit: before.audit });
    // The payouts-by-order index is there, only over the rows that have an order.
    expect(db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_cash_movements_order'`).get()).toEqual({
      sql: 'CREATE INDEX idx_cash_movements_order ON cash_movements(order_id) WHERE order_id IS NOT NULL',
    });
    // The order already out reads as one of the shop's own riders: no riderKeepsCents, its rider and its time kept.
    const { findOrder, getOrderSnapshot } = await import('./repositories/order-repo.js');
    const out = findOrder(db, 'o_out')!;
    expect(out).not.toHaveProperty('riderKeepsCents');
    expect(isOutsideRiderOrder(out)).toBe(false);
    expect(out).toMatchObject({ status: 'out_for_delivery', assignedRiderId: 'r_own', dispatchedAt: '2026-09-27T10:30:00.000Z' });
    expect(getOrderSnapshot(db, 'o_ready')?.order).not.toHaveProperty('riderKeepsCents');

    // The next boot: nothing to run, no copy.
    await runMigrations(db);
    expect(ran(db)).toHaveLength(had.length + 4);
    expect(h.snapshots).toHaveLength(1);
  });

  it('a till on v0.7.34 (0001..0049) runs just 0050, 0051 then 0052, after a pre-migrate copy: every shift reads counted_notes_json and close_report_json NULL (a closed one has no note count and no saved report, its figures as they were), no sync or audit row is added, and the shift still open closes counted by note', async () => {
    const { runMigrations } = await import('./migrator.js');
    const { writeAudit } = await import('./repositories/audit-repo.js');
    h.snapshots.length = 0;
    const db = openMigrated({ stopBefore: '0050' });
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, ran_at TEXT NOT NULL)`);
    const log = db.prepare(`INSERT INTO _migrations (name, ran_at) VALUES (?, ?)`);
    for (const f of migrationFiles().filter((m) => m < '0050')) log.run(f, T0);
    // What v0.7.34 left (made-up numbers): last night's shift, closed Rs 10 short with a gas payout,
    // and tonight's, still open on a Rs 5,000 float.
    db.prepare(`INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES ('u_admin', 'Test Owner', 'x', 'admin', ?, ?, ?)`).run(T0, T0, DEV);
    const opened = '2026-10-01T13:00:00.000Z';
    const closed = '2026-10-01T18:00:00.000Z';
    db.prepare(
      `INSERT INTO shifts (id, device_id, opened_by_user_id, opened_at, opening_cash_cents, closed_by_user_id, closed_at,
                           counted_cash_cents, expected_cash_cents, variance_cents, close_notes, created_at, updated_at, version)
       VALUES ('s_closed', ?, 'u_admin', ?, 500000, 'u_admin', ?, 489000, 490000, -1000, 'Test: Rs 10 short', ?, ?, 2)`,
    ).run(DEV, opened, closed, opened, closed);
    db.prepare(
      `INSERT INTO cash_movements (id, shift_id, type, amount_cents, reason, user_id, created_at, updated_at, device_id)
       VALUES ('m_gas', 's_closed', 'payout', 10000, 'Gas cylinder', 'u_admin', ?, ?, ?)`,
    ).run(opened, opened, DEV);
    db.prepare(
      `INSERT INTO shifts (id, device_id, opened_by_user_id, opened_at, opening_cash_cents, created_at, updated_at, version)
       VALUES ('s_open', ?, 'u_admin', '2026-10-02T13:00:00.000Z', 500000, '2026-10-02T13:00:00.000Z', '2026-10-02T13:00:00.000Z', 1)`,
    ).run(DEV);
    writeAudit(db, { entityType: 'shifts', entityId: 's_closed', action: 'shift_close', actorUserId: 'u_admin', before: null, after: { id: 's_closed' } });
    const all = (sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>;
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const before = { shifts: all(`SELECT * FROM shifts ORDER BY id`), sync: count('sync_queue'), audit: count('audit_log') };
    const had = ran(db);
    expect(had.at(-1)).toBe('0049_outside_rider.sql');
    expect(columns(db, 'shifts')).not.toContain('counted_notes_json');
    expect(columns(db, 'shifts')).not.toContain('close_report_json');

    await runMigrations(db);

    expect(ran(db)).toEqual([...had, '0050_shift_counted_notes.sql', '0051_shift_close_report.sql', '0052_card_rate.sql']);
    expect(h.snapshots).toHaveLength(1);
    // Every shift as it was — the same version and updated_at — with the new columns empty (no backfill), last, in that order.
    expect(all(`SELECT * FROM shifts ORDER BY id`)).toEqual(before.shifts.map((r) => ({ ...r, counted_notes_json: null, close_report_json: null })));
    expect(columns(db, 'shifts').slice(-2)).toEqual(['counted_notes_json', 'close_report_json']);
    // Nothing to send to the other till, nothing in the audit trail: the migration changed no business fact.
    expect({ sync: count('sync_queue'), audit: count('audit_log') }).toEqual({ sync: before.sync, audit: before.audit });

    // Last night's shift reads as it closed, with no note count, and its figures add up as they did.
    const { closeShift, findShift, getShiftSummary, listShifts } = await import('./repositories/shift-repo.js');
    expect(findShift(db, 's_closed')).toMatchObject({ countedCashCents: 489_000, expectedCashCents: 490_000, varianceCents: -1_000, countedNotes: null });
    expect(getShiftSummary(db, 's_closed')).toMatchObject({ cashOutCents: 10_000, expectedCashCents: 490_000 });
    expect(listShifts(db, {}).map((s) => [s.id, s.countedNotes])).toEqual([
      ['s_open', null],
      ['s_closed', null],
    ]);

    // Tonight's shift, opened before the update, closes counted by note: Rs 5,000 × 1.
    const notes = { notes: CASH_NOTE_FACE_CENTS.map((faceCents) => ({ faceCents, count: faceCents === 500_000 ? 1 : 0 })), otherCents: 0 };
    expect(closeShift(db, { shiftId: 's_open', countedCashCents: 500_000, countedNotes: notes }, { userId: 'u_admin', deviceId: DEV })).toMatchObject({
      countedCashCents: 500_000,
      varianceCents: 0,
      countedNotes: notes,
    });

    // The next boot: nothing to run, no copy.
    await runMigrations(db);
    expect(ran(db)).toHaveLength(had.length + 3);
    expect(h.snapshots).toHaveLength(1);
  });

  it('a v0.7.34 database (0001..0049) with a closed shift and its orders (a delivery an outside rider paid in cash, keeping his charge; a card takeaway) runs 0050, 0051 then 0052 after a pre-migrate copy: every row as it was, the shift reads no note count and no saved report, its figures add up as they did, and the audit chain verifies', async () => {
    const { runMigrations } = await import('./migrator.js');
    const { writeAudit } = await import('./repositories/audit-repo.js');
    const { verifyAuditChain } = await import('./audit-chain.js');
    const { isOutsideRiderOrder } = await import('@cheeseoclock/shared-types');
    h.snapshots.length = 0;
    h.copied.length = 0;
    const db = openMigrated({ stopBefore: '0050' });
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, ran_at TEXT NOT NULL)`);
    const log = db.prepare(`INSERT INTO _migrations (name, ran_at) VALUES (?, ?)`);
    for (const f of migrationFiles().filter((m) => m < '0050')) log.run(f, T0);
    // What v0.7.34 left (made-up names and numbers): last night's shift on a Rs 5,000 float, closed even at Rs 9,515.
    // In it a delivery (Rs 4,715) sent out with an outside rider, who paid it in cash and kept the Rs 200 charge (the
    // payout linked to the order, 0049), and a takeaway (Rs 1,150) paid by card.
    const user = db.prepare(`INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`);
    user.run('u_admin', 'Test Owner', 'admin', T0, T0, DEV);
    user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
    const opened = '2026-10-02T13:00:00.000Z';
    const closed = '2026-10-02T18:00:00.000Z';
    db.prepare(
      `INSERT INTO shifts (id, device_id, opened_by_user_id, opened_at, opening_cash_cents, closed_by_user_id, closed_at,
                           counted_cash_cents, expected_cash_cents, variance_cents, created_at, updated_at, version)
       VALUES ('s_closed', ?, 'u_cash', ?, 500000, 'u_admin', ?, 951500, 951500, 0, ?, ?, 2)`,
    ).run(DEV, opened, closed, opened, closed);
    const order = db.prepare(
      `INSERT INTO orders (id, order_number, mode, status, cashier_id, subtotal_cents, tax_cents, total_cents, source, shift_id,
                           sent_at, dispatched_at, delivered_at, rider_keeps_cents, paid_at, created_at, updated_at, device_id, version)
       VALUES (?, ?, ?, 'paid', 'u_cash', ?, ?, ?, 'pos', 's_closed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    order.run(
      'o_out', '20261002-0031', 'delivery', 410_000, 61_500, 471_500,
      '2026-10-02T14:30:00.000Z', '2026-10-02T14:50:00.000Z', '2026-10-02T15:20:00.000Z', 20_000,
      '2026-10-02T15:10:00.000Z', '2026-10-02T14:00:00.000Z', '2026-10-02T15:20:00.000Z', DEV, 6,
    );
    order.run(
      'o_card', '20261002-0032', 'takeaway', 100_000, 15_000, 115_000,
      '2026-10-02T15:00:00.000Z', null, null, null,
      '2026-10-02T15:00:00.000Z', '2026-10-02T14:58:00.000Z', '2026-10-02T15:00:00.000Z', DEV, 3,
    );
    const payment = db.prepare(
      `INSERT INTO payments (id, order_id, method, amount_cents, tendered_cents, received_by_user_id, paid_at, shift_id, created_at, updated_at, device_id)
       VALUES (?, ?, ?, ?, ?, 'u_cash', ?, 's_closed', ?, ?, ?)`,
    );
    payment.run('p_out', 'o_out', 'cash', 471_500, 471_500, '2026-10-02T15:10:00.000Z', '2026-10-02T15:10:00.000Z', '2026-10-02T15:10:00.000Z', DEV);
    payment.run('p_card', 'o_card', 'card', 115_000, null, '2026-10-02T15:00:00.000Z', '2026-10-02T15:00:00.000Z', '2026-10-02T15:00:00.000Z', DEV);
    db.prepare(
      `INSERT INTO cash_movements (id, shift_id, type, amount_cents, reason, user_id, order_id, created_at, updated_at, device_id)
       VALUES ('m_kept', 's_closed', 'payout', 20000, 'Delivery charge kept by the outside rider — Order #0031', 'u_cash', 'o_out', ?, ?, ?)`,
    ).run('2026-10-02T15:10:00.000Z', '2026-10-02T15:10:00.000Z', DEV);
    writeAudit(db, { entityType: 'orders', entityId: 'o_out', action: 'send_out', actorUserId: 'u_cash', before: null, after: { id: 'o_out', riderKeepsCents: 20_000 } });
    writeAudit(db, { entityType: 'orders', entityId: 'o_out', action: 'rider_payment', actorUserId: 'u_cash', before: null, after: { id: 'o_out' } });
    writeAudit(db, { entityType: 'orders', entityId: 'o_card', action: 'tender', actorUserId: 'u_cash', before: null, after: { id: 'o_card' } });
    writeAudit(db, { entityType: 'shifts', entityId: 's_closed', action: 'shift_close', actorUserId: 'u_admin', before: null, after: { id: 's_closed', varianceCents: 0 } });
    const all = (sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>;
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const before = {
      shifts: all(`SELECT * FROM shifts ORDER BY id`),
      orders: all(`SELECT * FROM orders ORDER BY id`),
      payments: all(`SELECT * FROM payments ORDER BY id`),
      movements: all(`SELECT * FROM cash_movements ORDER BY id`),
      audit: all(`SELECT * FROM audit_log ORDER BY rowid`),
      sync: count('sync_queue'),
    };
    const had = ran(db);
    expect(had.at(-1)).toBe('0049_outside_rider.sql');
    expect(columns(db, 'shifts')).not.toContain('counted_notes_json');
    expect(columns(db, 'shifts')).not.toContain('close_report_json');

    await runMigrations(db);

    // In order, after the pre-migrate copy — the database as v0.7.34 left it, before 0050 ran.
    expect(ran(db)).toEqual([...had, '0050_shift_counted_notes.sql', '0051_shift_close_report.sql', '0052_card_rate.sql']);
    expect(h.snapshots).toHaveLength(1);
    expect(h.copied).toEqual([{ lastRan: '0049_outside_rider.sql', shiftColumns: Object.keys(before.shifts[0] ?? {}) }]);
    // Every row as it was, the shift with the two new columns empty; the audit trail and the link's queue untouched.
    expect(all(`SELECT * FROM shifts ORDER BY id`)).toEqual(before.shifts.map((r) => ({ ...r, counted_notes_json: null, close_report_json: null })));
    expect({
      orders: all(`SELECT * FROM orders ORDER BY id`),
      payments: all(`SELECT * FROM payments ORDER BY id`),
      movements: all(`SELECT * FROM cash_movements ORDER BY id`),
      audit: all(`SELECT * FROM audit_log ORDER BY rowid`),
      sync: count('sync_queue'),
    }).toEqual({ orders: before.orders.map((r) => ({ ...r, digital_total_cents: null, digital_net_cents: 0, digital_tax_cents: 0 })), payments: before.payments, movements: before.movements, audit: before.audit, sync: before.sync });

    // The orders read as v0.7.34 left them: the delivery an outside rider's, its clock and his charge kept.
    const { findOrder } = await import('./repositories/order-repo.js');
    const out = findOrder(db, 'o_out')!;
    expect(out).toMatchObject({ status: 'paid', sentAt: '2026-10-02T14:30:00.000Z', riderKeepsCents: 20_000 });
    expect(isOutsideRiderOrder(out)).toBe(true);

    // The closed shift reads as it closed — no note count, no saved report — and its figures add up as they did.
    const { findShift, getShiftCloseReport, getShiftSummary } = await import('./repositories/shift-repo.js');
    expect(findShift(db, 's_closed')).toMatchObject({
      closedAt: closed,
      openingCashCents: 500_000,
      countedCashCents: 951_500,
      expectedCashCents: 951_500,
      varianceCents: 0,
      countedNotes: null,
    });
    expect(getShiftCloseReport(db, 's_closed')).toBeNull();
    expect(getShiftSummary(db, 's_closed')).toMatchObject({
      paidOrderCount: 2,
      cashSalesCents: 471_500,
      cashOutCents: 20_000,
      riderChargesCents: 20_000,
      riderChargeCount: 1,
      riderTripCount: 0,
      netRevenueCents: 586_500,
      expectedCashCents: 951_500,
    });
    const { buildTeamTab } = await import('../services/business-report.js');
    expect(buildTeamTab(db, ALL_TIME).shifts.find((s) => s.id === 's_closed')).toMatchObject({ countedNotes: null, hasCloseReport: false });

    // The audit chain verifies.
    const chainRows = all(
      `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action, actor_user_id AS actorUserId,
              before_json AS beforeJson, after_json AS afterJson, ip, created_at AS createdAt,
              prev_hash AS prevHash, row_hash AS rowHash
         FROM audit_log ORDER BY rowid`,
    ).map((r) => ({ ...r, rowid: Number(r['rowid']) })) as unknown as Parameters<typeof verifyAuditChain>[0];
    expect(verifyAuditChain(chainRows)).toMatchObject({ ok: true, checkedRows: 4 });

    // The next boot: nothing to run, no copy.
    await runMigrations(db);
    expect(ran(db)).toHaveLength(had.length + 3);
    expect(h.snapshots).toHaveLength(1);
  });
});
