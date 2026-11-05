/**
 * "Clear practice orders" (Settings → About; owner, 5 Nov 2026: "we want only
 * the logs to clear nothing else menu and items should be there", with "give
 * option to delete customer and drawer logs", only during the trial) on a real
 * database built from every migration, foreign keys on, through the real
 * repositories:
 *  - every refusal (licence key, FBR live, a second till, a shift open,
 *    nothing to clear) writes nothing;
 *  - the orders, their payments, the closed shifts and the cash in / out go;
 *    the menu, staff, tax and settings stay exactly as they were; stock goes
 *    back to what it was before the practice;
 *  - the customers and the drawer log go only when ticked;
 *  - the cleared orders never fill the owner's list of deleted test orders;
 *  - order numbers start again at #0001;
 *  - row + sync_queue + audit for every row, and the audit chain verifies.
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for Electron
 * here); skipped where it is missing. Every name, price and amount is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentMethod } from '@cheeseoclock/shared-types';
import { verifyAuditChain, type AuditChainRow } from './audit-chain.js';
import { CASHIER, DatabaseSync, MANAGER, OWNER, openCostingShop, openMigrated } from './costing-shop.fixture.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => '' } }));

const repos = async () => ({
  ...(await import('./repositories/order-repo.js')),
  ...(await import('./repositories/shift-repo.js')),
  ...(await import('./repositories/stock-movement-repo.js')),
  ...(await import('./repositories/customer-repo.js')),
  ...(await import('./repositories/drawer-open-repo.js')),
  ...(await import('./repositories/practice-clear-repo.js')),
});

type Row = Record<string, unknown>;
const ALONE = { licensed: false, fbrLive: false, secondTill: false };

async function till() {
  const db = openMigrated();
  const shop = await openCostingShop(db);
  const r = await repos();
  const one = (sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as Row | undefined;
  const n = (sql: string, ...p: unknown[]) => Number(one(sql, ...p)?.['n'] ?? 0);
  const live = (table: string) => n(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL`);
  const stock = () => db.prepare(`SELECT id, current_qty FROM ingredients ORDER BY id`).all() as Row[];
  const auditRows = () =>
    db
      .prepare(
        `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action,
                actor_user_id AS actorUserId, before_json AS beforeJson, after_json AS afterJson,
                ip, created_at AS createdAt, prev_hash AS prevHash, row_hash AS rowHash
           FROM audit_log ORDER BY rowid`,
      )
      .all() as unknown as AuditChainRow[];
  /** What must never change: the menu, staff, tax and settings. */
  const kept = () => ({
    menuItems: n(`SELECT COUNT(*) AS n FROM menu_items WHERE deleted_at IS NULL`),
    categories: n(`SELECT COUNT(*) AS n FROM categories WHERE deleted_at IS NULL`),
    modifiers: n(`SELECT COUNT(*) AS n FROM modifiers WHERE deleted_at IS NULL`),
    groups: n(`SELECT COUNT(*) AS n FROM modifier_groups WHERE deleted_at IS NULL`),
    tax: n(`SELECT COUNT(*) AS n FROM tax_categories WHERE deleted_at IS NULL`),
    users: n(`SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL`),
    prices: db.prepare(`SELECT id, name, base_price_cents FROM menu_items ORDER BY id`).all(),
    settings: db.prepare(`SELECT key, value_json FROM settings ORDER BY key`).all(),
    business: db.prepare(`SELECT * FROM business_settings ORDER BY 1`).all(),
  });

  const stockBefore = stock();
  let shift = r.openShift(db, { openingCashCents: 500_000 }, MANAGER);
  const pay = (o: string, method: PaymentMethod = 'cash') => {
    const t = r.findOrder(db, o)!.totalCents;
    r.tenderOrder(db, { orderId: o, payments: [{ method, amountCents: t, tenderedCents: method === 'cash' ? t : null }] }, CASHIER);
    r.decrementForOrder(db, o, CASHIER);
  };

  // The practice: a cash sale, a card sale, an order still with the kitchen
  // (not paid), a cart left unfinished, cash in, the drawer opened by hand,
  // a customer saved.
  const sold = shop.ring([['fajitaM', 1]]);
  pay(sold);
  const card = shop.ring([['cola', 2]]);
  pay(card, 'card');
  const cooking = shop.ring([['veggieL', 1]]);
  r.sendOrderToKitchen(db, cooking, CASHIER);
  const cart = shop.ring([['cola', 1]]);
  r.recordCashMovement(db, { type: 'payin', amountCents: 20_000, reason: 'Change from the bank' }, MANAGER);
  r.recordDrawerOpen(db, { kind: 'no_sale', reason: 'Checked the float' }, MANAGER);
  const customer = r.createCustomer(db, { name: 'Practice Customer', phone: '03001234567' }, MANAGER);

  const closeShift = () => {
    const expected = r.getShiftSummary(db, shift.id).expectedCashCents;
    r.closeShift(db, { shiftId: shift.id, countedCashCents: expected, carryOverReason: 'Practice' }, MANAGER);
  };
  const newShift = () => {
    shift = r.openShift(db, { openingCashCents: 0 }, MANAGER);
    return shift;
  };
  const clear = (ticks: { customers?: boolean; drawerLog?: boolean } = {}, env = ALONE) =>
    r.clearPracticeOrders(db, { customers: !!ticks.customers, drawerLog: !!ticks.drawerLog, ownerUserId: OWNER.userId }, OWNER, env);
  const preview = (env = ALONE) => r.practiceClearPreview(db, OWNER.deviceId, env);

  return { db, shop, r, one, n, live, stock, stockBefore, auditRows, kept, closeShift, newShift, clear, preview, sold, card, cooking, cart, customer };
}

type Till = Awaited<ReturnType<typeof till>>;
let t: Till;
beforeEach(async () => {
  if (!DatabaseSync) return;
  t = await till();
});

describe.skipIf(!DatabaseSync)('clear practice orders: refusals write nothing', () => {
  it('while a shift is open', () => {
    expect(t.preview().blocks.map((b) => b.code)).toEqual(['shift_open']);
    const audits = t.auditRows().length;
    expect(() => t.clear()).toThrow(t.r.PRACTICE_CLEAR_REFUSED.shiftOpen);
    expect(t.live('orders')).toBe(4);
    expect(t.auditRows().length).toBe(audits);
  });

  it('on a till with a licence key, with FBR live, or with a second till connected', () => {
    t.closeShift();
    const cases = [
      [{ ...ALONE, licensed: true }, 'licensed', t.r.PRACTICE_CLEAR_REFUSED.licensed],
      [{ ...ALONE, fbrLive: true }, 'fbr_live', t.r.PRACTICE_CLEAR_REFUSED.fbrLive],
      [{ ...ALONE, secondTill: true }, 'second_till', t.r.PRACTICE_CLEAR_REFUSED.secondTill],
    ] as const;
    for (const [env, code, words] of cases) {
      expect(t.preview(env).blocks.map((b) => b.code)).toEqual([code]);
      const audits = t.auditRows().length;
      expect(() => t.clear({}, env)).toThrow(words);
      expect(t.live('orders')).toBe(4);
      expect(t.auditRows().length).toBe(audits);
    }
  });

  it('when a shift was taken on another till', () => {
    t.closeShift();
    t.db.prepare(`UPDATE shifts SET device_id = 'till-2'`).run();
    expect(t.preview().blocks.map((b) => b.code)).toContain('second_till');
    expect(() => t.clear()).toThrow(t.r.PRACTICE_CLEAR_REFUSED.secondTill);
  });

  it('when there is nothing left to clear', () => {
    t.closeShift();
    t.clear();
    expect(() => t.clear()).toThrow(t.r.PRACTICE_CLEAR_REFUSED.nothing);
  });
});

describe.skipIf(!DatabaseSync)('clear practice orders: only the history goes', () => {
  it('counts what is on the till', () => {
    t.closeShift();
    const p = t.preview();
    expect(p.blocks).toEqual([]);
    expect(p).toMatchObject({ orders: 4, shifts: 1, customers: 1 });
    expect(p.cashMovements).toBeGreaterThanOrEqual(1);
    expect(p.drawerLog).toBeGreaterThanOrEqual(2);
  });

  it('clears orders, payments, shifts and cash in / out; keeps the menu, staff, settings, customers and drawer log', () => {
    t.closeShift();
    const before = t.kept();
    const drawerRows = t.live('drawer_opens');
    const done = t.clear();

    expect(done).toMatchObject({ orders: 4, shifts: 1, customers: 0, drawerLog: 0 });
    expect(done.cashMovements).toBeGreaterThanOrEqual(1);
    for (const table of ['orders', 'payments', 'shifts', 'cash_movements']) expect(t.live(table), table).toBe(0);
    expect(t.live('drawer_opens')).toBe(drawerRows);
    expect(t.live('customers')).toBe(1);
    expect(t.kept()).toEqual(before);

    // Practice, not test: never in the owner's list of deleted test orders.
    expect(t.n(`SELECT COUNT(*) AS n FROM orders WHERE delete_kind = 'practice'`)).toBe(3);
    expect(t.n(`SELECT COUNT(*) AS n FROM orders WHERE delete_kind = 'test'`)).toBe(0);
    expect(t.r.listDeletedTests(t.db, { sinceIso: '2000-01-01T00:00:00.000Z', untilIso: '2100-01-01T00:00:00.000Z' }).total).toBe(0);
    // The unfinished cart went the way any abandoned cart goes.
    expect(t.one(`SELECT deleted_at, delete_kind FROM orders WHERE id = ?`, t.cart)).toMatchObject({ delete_kind: null });
    expect(t.one(`SELECT deleted_at FROM orders WHERE id = ?`, t.cart)?.['deleted_at']).not.toBeNull();

    // The food was never really made: stock is back where it started.
    expect(t.stock()).toEqual(t.stockBefore);
  });

  it('with both ticks, the customers and the drawer log go too', () => {
    t.closeShift();
    const done = t.clear({ customers: true, drawerLog: true });
    expect(done.customers).toBe(1);
    expect(done.drawerLog).toBeGreaterThanOrEqual(2);
    expect(t.live('customers')).toBe(0);
    expect(t.live('customer_addresses')).toBe(0);
    expect(t.live('drawer_opens')).toBe(0);
    // Name and phone blanked, as Customers → Delete does.
    expect(t.one(`SELECT phone FROM customers WHERE id = ?`, t.customer.id)?.['phone']).toBeNull();
    expect(t.kept().menuItems).toBeGreaterThan(0);
  });

  it('order numbers start again at #0001', () => {
    t.closeShift();
    t.clear();
    t.newShift();
    const next = t.shop.ring([['cola', 1]]);
    expect(t.r.findOrder(t.db, next)!.orderNumber).toMatch(/-0001$/);
  });

  it('every row is synced and audited, and the audit chain still verifies', () => {
    t.closeShift();
    const shiftId = String(t.one(`SELECT id FROM shifts`)?.['id']);
    t.clear({ customers: true, drawerLog: true });
    expect(t.n(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'shifts' AND entity_id = ? AND op = 'delete'`, shiftId)).toBe(1);
    expect(t.n(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'shifts' AND entity_id = ? AND action = 'clear_practice_orders'`, shiftId)).toBe(1);
    expect(t.n(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'orders' AND entity_id = ? AND action = 'clear_practice_orders'`, t.sold)).toBe(1);
    const summary = t.one(`SELECT after_json FROM audit_log WHERE entity_type = 'till' AND action = 'clear_practice_orders'`);
    expect(JSON.parse(String(summary?.['after_json']))).toMatchObject({ orders: 4, shifts: 1, customers: 1, options: { customers: true, drawerLog: true } });
    expect(verifyAuditChain(t.auditRows()).ok).toBe(true);
  });
});
