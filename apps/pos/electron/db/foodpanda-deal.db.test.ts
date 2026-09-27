/**
 * Settings → foodpanda (owner, 2026-09-27) on a real database built from
 * every migration, foreign keys on, driven through the repositories the way
 * the IPC handlers call them:
 *   - the owner's deal goes onto an order the moment it becomes foodpanda
 *     (created as foodpanda, or switched to it), with its terms FROZEN on the
 *     discount row; leaving foodpanda takes it off; with no deal (the
 *     default, 0%) nothing changes from before the setting existed;
 *   - a Save while the order is open does not move it: the rupees come from
 *     the frozen terms (the minimum, the most off, the shop's part);
 *   - only the shop's part is the order's discount; foodpanda's part is
 *     recorded at payment, with the commission, in order_channel_terms —
 *     and next month's terms never rewrite it;
 *   - the FBR invoice follows the stored totals: the deal is a discount like
 *     any other;
 *   - a cashier can't change or take off the deal (a manager's approval);
 *     the deal exists only on foodpanda orders; Pay's checks are enforced;
 *   - a value saved by a newer version of the app is read for what this
 *     version knows, shown read-only and never saved over;
 *   - a setting from the other till lands with its own audit row here.
 *
 * better-sqlite3 here is built for Electron's ABI, so this uses node's own
 * `node:sqlite` behind a small better-sqlite3-shaped shim and skips itself
 * where that is missing. Every name, price and figure is made up.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { mapOrderToFbrPayload } from '@cheeseoclock/fbr-core';
import { allocateDiscount } from '@cheeseoclock/pos-domain';
import { ROW_IMAGE_KEY, type SyncChange } from '@cheeseoclock/sync-core';
import { DEFAULT_FOODPANDA_DEAL, DEFAULT_FOODPANDA_FEES } from '@cheeseoclock/shared-types';
import type { FoodpandaChecks, FoodpandaDeal, FoodpandaFees, OrderMode } from '@cheeseoclock/shared-types';
import type { AppDatabase } from './connection.js';
import { verifyAuditChain, type AuditChainRow } from './audit-chain.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

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
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

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

/** One row, as a plain record (better-sqlite3's types say unknown). */
const one = (db: AppDatabase, sql: string, ...params: unknown[]) =>
  db.prepare(sql).get(...params) as Record<string, unknown> | undefined;

const DEV = 'till-1';
const OTHER_TILL = 'till-2';
const CASHIER = { userId: 'u_cash', deviceId: DEV };
const MANAGER = { userId: 'u_mgr', deviceId: DEV };
const OWNER = { userId: 'u_owner', deviceId: DEV };
const T0 = '2026-01-01T00:00:00.000Z';

const repos = async () => ({
  ...(await import('./repositories/order-repo.js')),
  ...(await import('./repositories/business-settings-repo.js')),
  ...(await import('./repositories/shift-repo.js')),
  ...(await import('./repositories/menu-item-repo.js')),
  ...(await import('./repositories/category-repo.js')),
  ...(await import('./repositories/tax-category-repo.js')),
  ...(await import('./repositories/apply-remote.js')),
  ...(await import('../services/shop-settings.js')),
});

const LINK_ON = { on: true, stale: false, lastHeardAt: null };

const deal = (over: Partial<FoodpandaDeal> = {}): FoodpandaDeal => ({
  v: 1,
  percent: 20,
  shopPercent: 20,
  minOrderCents: null,
  maxOffCents: null,
  startsOn: null,
  endsOn: null,
  ...over,
});
const fees = (over: Partial<FoodpandaFees> = {}): FoodpandaFees => ({
  v: 1,
  commissionBps: 2_500,
  confirmed: true,
  base: 'after_deal',
  fixedFeeCents: 0,
  commissionTaxBps: 0,
  upliftBps: 0,
  ...over,
});

/** A tiny shop: three users, a shift open on this till, a Rs 1,000 pizza and a Rs 500 side, 16% tax. */
async function shop() {
  const db = openMigrated();
  const r = await repos();
  const user = db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
  user.run('u_mgr', 'Test Manager', 'manager', T0, T0, DEV);
  user.run('u_owner', 'Test Owner', 'admin', T0, T0, DEV);
  r.openShift(db, { openingCashCents: 0, notes: null }, MANAGER);
  const tax = r.createTaxCategory(db, { name: 'Test GST', rateBps: 1_600 }, MANAGER);
  const cat = r.createCategory(db, { name: 'Test food', displayOrder: 1, colorHex: '#aa5500' }, MANAGER);
  const pizza = r.createMenuItem(db, { categoryId: cat.id, name: 'Test Pizza', basePriceCents: 100_000, taxCategoryId: tax.id }, MANAGER).id;
  const side = r.createMenuItem(db, { categoryId: cat.id, name: 'Test Side', basePriceCents: 50_000, taxCategoryId: tax.id }, MANAGER).id;

  const add = (orderId: string, menuItemId: string, quantity = 1) =>
    r.addOrderItem(db, { orderId, menuItemId, quantity, modifierIds: [] }, CASHIER);
  const order = (mode: OrderMode) => r.createOrder(db, { mode }, CASHIER);
  const snap = (id: string) => r.getOrderSnapshot(db, id)!;
  const setDeal = (d: FoodpandaDeal) => r.setBusinessSetting(db, 'foodpanda.deal', d, OWNER);
  const setFees = (f: FoodpandaFees) => r.setBusinessSetting(db, 'foodpanda.fees', f, OWNER);
  const setChecks = (c: FoodpandaChecks) => r.setBusinessSetting(db, 'foodpanda.checks', c, OWNER);
  const liveDiscounts = (orderId: string) =>
    db
      .prepare(`SELECT source, value, amount_cents, approved_by_user_id, rule_json FROM order_discounts WHERE order_id = ? AND deleted_at IS NULL`)
      .all(orderId);
  const payFoodpanda = (orderId: string, extra: { code?: string | null; tablet?: number | null } = {}) =>
    r.tenderOrder(
      db,
      {
        orderId,
        payments: [{ method: 'foodpanda', amountCents: snap(orderId).order.totalCents, referenceNo: extra.code ?? null }],
        foodpanda: { tabletTotalCents: extra.tablet ?? null },
      },
      CASHIER,
    );
  const terms = (orderId: string) => one(db, `SELECT * FROM order_channel_terms WHERE order_id = ?`, orderId);
  return { db, r, pizza, side, add, order, snap, setDeal, setFees, setChecks, liveDiscounts, payFoodpanda, terms };
}

describe.skipIf(!DatabaseSync)('the foodpanda deal on an order', () => {
  it('no deal saved (the default, 0%): a foodpanda order is exactly as before — full price, no discount row', async () => {
    const s = await shop();
    const o = s.order('foodpanda');
    s.add(o.id, s.pizza, 2);
    expect(s.liveDiscounts(o.id)).toEqual([]);
    expect(s.snap(o.id).order).toMatchObject({ subtotalCents: 200_000, discountCents: 0, taxCents: 32_000, totalCents: 232_000 });
    // …and a staff discount on it works as it always did (no deal to protect).
    s.r.applyDiscount(s.db, { orderId: o.id, discountType: 'percent', value: 5 }, CASHIER);
    expect(s.snap(o.id).order.discountCents).toBe(10_000);
    // Switching another order to foodpanda keeps its own discount too.
    const t = s.order('takeaway');
    s.add(t.id, s.pizza);
    s.r.applyDiscount(s.db, { orderId: t.id, discountType: 'percent', value: 10 }, CASHIER);
    s.r.setOrderMode(s.db, t.id, 'foodpanda', CASHIER);
    expect(s.liveDiscounts(t.id)).toMatchObject([{ source: null, value: 10 }]);
  });

  it('created as foodpanda: the deal goes on at once, frozen, approved by the owner who saved it, and works as items land', async () => {
    const s = await shop();
    s.setDeal(deal());
    const o = s.order('foodpanda');
    const [row] = s.liveDiscounts(o.id) as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ source: 'foodpanda', value: 20, amount_cents: 0, approved_by_user_id: 'u_owner' });
    expect(JSON.parse(String(row?.['rule_json']))).toMatchObject({ kind: 'foodpanda_deal', dealPercent: 20, shopPercent: 20, label: 'Foodpanda deal 20% off' });
    s.add(o.id, s.pizza, 2);
    // Rs 2,000 of food, 20% off = Rs 400; 16% tax on Rs 1,600 = Rs 256.
    expect(s.snap(o.id).order).toMatchObject({ subtotalCents: 200_000, discountCents: 40_000, taxCents: 25_600, totalCents: 185_600 });
    expect(s.snap(o.id).discounts).toMatchObject([
      { source: 'foodpanda', reason: 'Foodpanda deal 20% off', amountCents: 40_000, foodpanda: { dealPercent: 20, shopPercent: 20, dealCents: 40_000, platformCents: 0 } },
    ]);
  });

  it('switched to foodpanda: the deal replaces a staff discount; switched away: it comes off', async () => {
    const s = await shop();
    s.setDeal(deal({ percent: 15, shopPercent: 15 }));
    const o = s.order('takeaway');
    s.add(o.id, s.pizza, 2);
    s.r.applyDiscount(s.db, { orderId: o.id, discountType: 'percent', value: 5 }, CASHIER);
    s.r.setOrderMode(s.db, o.id, 'foodpanda', CASHIER);
    expect(s.liveDiscounts(o.id)).toMatchObject([{ source: 'foodpanda', value: 15, amount_cents: 30_000 }]);
    expect(s.snap(o.id).order.discountCents).toBe(30_000);
    const replaced = one(s.db, `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'replaced_by_foodpanda_deal'`);
    expect(replaced?.['n']).toBe(1);

    s.r.setOrderMode(s.db, o.id, 'delivery', CASHIER);
    expect(s.liveDiscounts(o.id)).toEqual([]);
    expect(s.snap(o.id).order).toMatchObject({ discountCents: 0, totalCents: 232_000 });
    // Back to foodpanda: the deal as it is NOW.
    s.setDeal(deal({ percent: 25, shopPercent: 25 }));
    s.r.setOrderMode(s.db, o.id, 'foodpanda', CASHIER);
    expect(s.snap(o.id).order.discountCents).toBe(50_000);
  });

  it('a Save while the order is open does not move it; the next order gets the new deal', async () => {
    const s = await shop();
    s.setDeal(deal());
    const open = s.order('foodpanda');
    s.add(open.id, s.pizza);
    s.setDeal(deal({ percent: 30, shopPercent: 30, maxOffCents: 10_000 }));
    s.add(open.id, s.pizza);
    // Still 20% of Rs 2,000, no cap: the terms frozen when it became foodpanda.
    expect(s.snap(open.id).order.discountCents).toBe(40_000);
    const next = s.order('foodpanda');
    s.add(next.id, s.pizza, 2);
    // 30% of Rs 2,000 = Rs 600, capped at Rs 100.
    expect(s.snap(next.id).order.discountCents).toBe(10_000);
    // Put back the default (0%): orders already open keep theirs, new ones get none.
    s.r.setBusinessSetting(s.db, 'foodpanda.deal', deal({ percent: 0, shopPercent: 0 }), OWNER);
    s.add(open.id, s.side);
    expect(s.snap(open.id).order.discountCents).toBe(50_000);
    expect(s.liveDiscounts(s.order('foodpanda').id)).toEqual([]);
  });

  it('the minimum and the most off, whatever the order of edits', async () => {
    const s = await shop();
    s.setDeal(deal({ minOrderCents: 150_000, maxOffCents: 50_000 }));
    const o = s.order('foodpanda');
    const line = s.add(o.id, s.pizza);
    expect(s.snap(o.id).order.discountCents).toBe(0); // Rs 1,000: under the minimum
    expect(s.liveDiscounts(o.id)).toHaveLength(1); // …but the deal stays on the order
    // …and the cart can say from how much it takes off.
    expect(s.snap(o.id).discounts[0]?.foodpanda).toMatchObject({ dealCents: 0, platformCents: 0, minOrderCents: 150_000 });
    s.add(o.id, s.side);
    expect(s.snap(o.id).order.discountCents).toBe(30_000); // Rs 1,500: 20%
    s.r.updateOrderItemQuantity(s.db, o.id, line.id, 5, CASHIER);
    expect(s.snap(o.id).order.discountCents).toBe(50_000); // Rs 5,500: 20% = Rs 1,100, capped at Rs 500
    s.r.updateOrderItemQuantity(s.db, o.id, line.id, 1, CASHIER);
    expect(s.snap(o.id).order.discountCents).toBe(30_000);
    s.r.removeOrderItem(s.db, o.id, line.id, CASHIER);
    expect(s.snap(o.id).order.discountCents).toBe(0); // Rs 500: under the minimum again
  });

  it('a shared deal: only the shop’s part is the discount; foodpanda’s part shows on the snapshot and is kept at payment', async () => {
    const s = await shop();
    s.setDeal(deal({ percent: 20, shopPercent: 10 }));
    s.setFees(fees());
    const o = s.order('foodpanda');
    s.add(o.id, s.pizza, 2);
    const snap = s.snap(o.id);
    // Rs 2,000: the deal is Rs 400, the shop pays Rs 200 of it.
    expect(snap.order).toMatchObject({ discountCents: 20_000, taxCents: 28_800, totalCents: 208_800 });
    expect(snap.discounts[0]).toMatchObject({
      reason: 'Foodpanda deal 20% off (your part 10%)',
      foodpanda: { dealCents: 40_000, platformCents: 20_000 },
    });
    s.payFoodpanda(o.id, { code: 'FP-1001' });
    expect(s.terms(o.id)).toMatchObject({
      channel: 'foodpanda',
      deal_bps: 2_000,
      shop_bps: 1_000,
      shop_discount_cents: 20_000,
      platform_funded_cents: 20_000,
      // 25% of the food after the shop's part (Rs 1,800) = Rs 450.
      commission_cents: 45_000,
      commission_base: 'after_deal',
      commission_confirmed: 1,
      expected_payout_cents: 208_800 - 45_000,
      tablet_total_cents: null,
    });
    expect(s.snap(o.id).payments[0]?.referenceNo).toBe('FP-1001');
  });

  it('"foodpanda does": the bill stays at full price, the deal stays on the order at Rs 0, and foodpanda’s part is kept at payment', async () => {
    const s = await shop();
    s.setDeal(deal({ percent: 20, shopPercent: 0 }));
    s.setFees(fees());
    const o = s.order('foodpanda');
    s.add(o.id, s.pizza, 2);
    const snap = s.snap(o.id);
    expect(snap.order).toMatchObject({ subtotalCents: 200_000, discountCents: 0, taxCents: 32_000, totalCents: 232_000 });
    expect(snap.discounts).toMatchObject([
      { source: 'foodpanda', amountCents: 0, reason: 'Foodpanda deal 20% off (foodpanda pays it)', foodpanda: { dealCents: 40_000, platformCents: 40_000 } },
    ]);
    s.payFoodpanda(o.id, { code: 'FP-5005' });
    expect(s.terms(o.id)).toMatchObject({ shop_discount_cents: 0, platform_funded_cents: 40_000, commission_cents: 50_000 });
  });

  it('the terms kept at payment never change when the owner changes them later', async () => {
    const s = await shop();
    s.setDeal(deal());
    s.setFees(fees());
    const o = s.order('foodpanda');
    s.add(o.id, s.pizza, 2);
    s.payFoodpanda(o.id, { code: '  #FP 2002 ', tablet: 192_000 });
    const before = { terms: s.terms(o.id), order: s.snap(o.id).order };
    expect(before.terms).toMatchObject({ commission_cents: 40_000, tablet_total_cents: 192_000, tablet_diff_cents: 192_000 - 185_600 });
    expect(s.snap(o.id).payments[0]?.referenceNo).toBe('FP 2002');
    s.setDeal(deal({ percent: 40, shopPercent: 40 }));
    s.setFees(fees({ commissionBps: 3_000, fixedFeeCents: 5_000 }));
    expect({ terms: s.terms(o.id), order: s.snap(o.id).order }).toEqual(before);
    // Insert-only: one row per order, the same id on both tills; synced and audited.
    expect(one(s.db, `SELECT COUNT(*) AS n FROM order_channel_terms`)?.['n']).toBe(1);
    expect(before.terms?.['id']).toBe(s.r.orderChannelTermsId(o.id));
    expect(one(s.db, `SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'order_channel_terms'`)?.['n']).toBe(1);
    expect(one(s.db, `SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'order_channel_terms'`)?.['n']).toBe(1);
  });

  it('the FBR invoice carries the deal like any discount: lines net of it, split exactly', async () => {
    const s = await shop();
    s.setDeal(deal({ percent: 15, shopPercent: 15 }));
    const o = s.order('foodpanda');
    s.add(o.id, s.pizza);
    s.add(o.id, s.side);
    s.payFoodpanda(o.id);
    const snap = s.snap(o.id);
    const inv = mapOrderToFbrPayload(snap, { sellerNTNCNIC: '0000000', sellerBusinessName: 'Test Shop', sellerProvince: 'Sindh', sellerAddress: 'Test Street' });
    // Rs 1,500 of food, 15% off = Rs 225, split Rs 150 / Rs 75 over the lines.
    expect(snap.order.discountCents).toBe(22_500);
    expect(inv.items.map((i) => i.discount)).toEqual(allocateDiscount([100_000, 50_000], 22_500).map((c) => c / 100));
    const net = inv.items.reduce((sum, i) => sum + i.valueSalesExcludingST, 0);
    const tax = inv.items.reduce((sum, i) => sum + i.salesTaxApplicable, 0);
    expect(Math.round(net * 100)).toBe(snap.order.subtotalCents - snap.order.discountCents);
    expect(Math.round(tax * 100)).toBe(snap.order.taxCents);
  });

  it('a cashier can’t change or take off the deal; a manager’s approval can, and it is then a staff discount', async () => {
    const s = await shop();
    s.setDeal(deal());
    const o = s.order('foodpanda');
    s.add(o.id, s.pizza, 2);
    expect(() => s.r.applyDiscount(s.db, { orderId: o.id, discountType: 'percent', value: 5 }, CASHIER)).toThrow(s.r.FOODPANDA_DEAL_NEEDS_MANAGER);
    expect(() => s.r.clearDiscount(s.db, o.id, CASHIER)).toThrow(s.r.FOODPANDA_DEAL_NEEDS_MANAGER);
    expect(s.snap(o.id).order.discountCents).toBe(40_000);
    // What the tablet shows: 25%, with the manager's approval.
    s.r.applyDiscount(s.db, { orderId: o.id, discountType: 'percent', value: 25, approverUserId: 'u_mgr', reason: 'As on the tablet' }, CASHIER);
    expect(s.liveDiscounts(o.id)).toMatchObject([{ source: null, value: 25, approved_by_user_id: 'u_mgr' }]);
    expect(s.snap(o.id).order.discountCents).toBe(50_000);
    // No deal on it any more: taking that off follows the usual rules.
    s.r.clearDiscount(s.db, o.id, CASHIER);
    expect(s.snap(o.id).order.discountCents).toBe(0);
    // And a deal taken off with approval.
    const o2 = s.order('foodpanda');
    s.add(o2.id, s.pizza);
    s.r.clearDiscount(s.db, o2.id, CASHIER, { approverUserId: 'u_mgr' });
    expect(s.liveDiscounts(o2.id)).toEqual([]);
  });

  it('the deal exists only on foodpanda orders: Pay refuses it on any other', async () => {
    const s = await shop();
    s.setDeal(deal());
    const o = s.order('foodpanda');
    s.add(o.id, s.pizza);
    // Forced behind the repository's back (setOrderMode would have taken it off).
    s.db.prepare(`UPDATE orders SET mode = 'takeaway' WHERE id = ?`).run(o.id);
    const total = s.snap(o.id).order.totalCents;
    expect(() =>
      s.r.tenderOrder(s.db, { orderId: o.id, payments: [{ method: 'cash', amountCents: total, tenderedCents: total }] }, CASHIER),
    ).toThrow(/still has the foodpanda deal/);
    expect(s.snap(o.id).order.status).toBe('open');
  });

  it("Pay's checks: optional by default, enforced once the owner makes them required", async () => {
    const s = await shop();
    const a = s.order('foodpanda');
    s.add(a.id, s.pizza);
    s.payFoodpanda(a.id);
    expect(s.terms(a.id)).toMatchObject({ tablet_total_cents: null, tablet_diff_cents: null });
    s.setChecks({ v: 1, orderCode: 'required', tabletTotal: 'required' });
    const b = s.order('foodpanda');
    s.add(b.id, s.pizza);
    expect(() => s.payFoodpanda(b.id, { tablet: 116_000 })).toThrow(/order number/);
    expect(() => s.payFoodpanda(b.id, { code: '   ', tablet: 116_000 })).toThrow(/order number/);
    expect(() => s.payFoodpanda(b.id, { code: 'FP-3003' })).toThrow(/tablet/);
    expect(s.snap(b.id).order.status).toBe('open');
    s.payFoodpanda(b.id, { code: 'FP-3003', tablet: 116_000 });
    expect(s.terms(b.id)).toMatchObject({ tablet_total_cents: 116_000, tablet_diff_cents: 0 });
  });

  it('every write above is in the hash chain, unbroken', async () => {
    const s = await shop();
    s.setDeal(deal({ shopPercent: 10 }));
    const o = s.order('foodpanda');
    s.add(o.id, s.pizza);
    s.r.setOrderMode(s.db, o.id, 'takeaway', CASHIER);
    s.r.setOrderMode(s.db, o.id, 'foodpanda', CASHIER);
    s.payFoodpanda(o.id, { code: 'FP-4004', tablet: 100 });
    const rows = (
      s.db
        .prepare(
          `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action, actor_user_id AS actorUserId,
                  before_json AS beforeJson, after_json AS afterJson, ip, created_at AS createdAt,
                  prev_hash AS prevHash, row_hash AS rowHash
             FROM audit_log ORDER BY rowid`,
        )
        .all() as unknown as AuditChainRow[]
    ).map((r) => ({ ...r, rowid: Number(r.rowid) }));
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['apply_foodpanda_deal', 'remove_foodpanda_deal', 'tender']));
    expect(verifyAuditChain(rows).ok).toBe(true);
  });
});

describe.skipIf(!DatabaseSync)('a setting saved by a newer version of the app', () => {
  it('is used for what this version knows, shown read-only, and never saved over', async () => {
    const s = await shop();
    s.setDeal(deal());
    // As a newer till would leave it: format 2 with a field this version does not know.
    s.db
      .prepare(`UPDATE business_settings SET value_json = ?, version = version + 1 WHERE key = 'foodpanda.deal'`)
      .run(JSON.stringify({ ...deal({ percent: 25, shopPercent: 25 }), v: 2, perCategory: { pizzas: 30 } }));
    const inUse = s.r.readShopSetting(s.db, 'foodpanda.deal');
    expect(inUse).toMatchObject({ isDefault: false, newerFormat: true, value: { percent: 25, shopPercent: 25 } });
    expect(inUse.value).not.toHaveProperty('perCategory');
    const card = s.r.getShopSettingCard(s.db, 'foodpanda.deal', LINK_ON);
    expect(card).toMatchObject({ readOnly: true, isDefault: false });
    // The deal still works on this till, from what it knows.
    const o = s.order('foodpanda');
    s.add(o.id, s.pizza, 2);
    expect(s.snap(o.id).order.discountCents).toBe(50_000);

    const count = () => ({
      audit: one(s.db, `SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'business_settings'`)?.['n'],
      sync: one(s.db, `SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'business_settings'`)?.['n'],
      value: one(s.db, `SELECT value_json FROM business_settings WHERE key = 'foodpanda.deal'`)?.['value_json'],
    });
    const before = count();
    expect(() => s.setDeal(deal({ percent: 10, shopPercent: 10 }))).toThrow(s.r.NEWER_FORMAT_REFUSAL);
    expect(count()).toEqual(before);
    // The other keys are not affected.
    expect(() => s.setFees(fees())).not.toThrow();
  });

  it('a costing key keeps its old behaviour (no format, read with its own schema)', async () => {
    const s = await shop();
    s.r.setBusinessSetting(s.db, 'analytics.tills', { sellingTills: 2 }, OWNER);
    expect(s.r.getBusinessSetting(s.db, 'analytics.tills')).toMatchObject({ value: { sellingTills: 2 }, newerFormat: false });
  });
});

describe.skipIf(!DatabaseSync)('the Settings card', () => {
  it('says who changed it last and where, keeps a history, and knows when the other till does not have it yet', async () => {
    const s = await shop();
    // Nothing saved: every shop rule reads as its frozen default (today's behaviour).
    const all = s.r.getShopSettings(s.db);
    expect(Object.values(all).every((x) => x.isDefault && !x.newerFormat)).toBe(true);
    expect(all['foodpanda.deal'].value).toMatchObject({ percent: 0 });
    expect(all['foodpanda.fees'].value).toMatchObject({ commissionBps: 2_500, confirmed: false });
    expect(all['foodpanda.checks'].value).toMatchObject({ orderCode: 'optional', tabletTotal: 'optional' });
    const fresh = s.r.getShopSettingCard(s.db, 'foodpanda.deal', LINK_ON);
    expect(fresh).toMatchObject({ isDefault: true, readOnly: false, lastChanged: null, notOnOtherTillYet: false, history: [] });
    expect(fresh.value).toEqual(fresh.defaultValue);

    s.setDeal(deal());
    s.setDeal(deal({ percent: 25, shopPercent: 25 }));
    const card = s.r.getShopSettingCard(s.db, 'foodpanda.deal', LINK_ON);
    expect(card).toMatchObject({
      isDefault: false,
      value: { percent: 25 },
      lastChanged: { byName: 'Test Owner', onThisTill: true },
      notOnOtherTillYet: true,
    });
    expect(card.history.map((h) => h.value?.percent)).toEqual([25, 20]);
    // The link off: nothing to wait for.
    expect(s.r.getShopSettingCard(s.db, 'foodpanda.deal', { on: false, stale: false, lastHeardAt: null }).notOnOtherTillYet).toBe(false);
    // Sent: no longer waiting.
    s.db.prepare(`UPDATE sync_queue SET synced_at = ? WHERE entity_type = 'business_settings'`).run(new Date().toISOString());
    expect(s.r.getShopSettingCard(s.db, 'foodpanda.deal', LINK_ON).notOnOtherTillYet).toBe(false);

    // "Put back the default" writes the default's values: the card is the default again
    // (the button greys out), and it still says who put it back.
    s.setDeal({ ...DEFAULT_FOODPANDA_DEAL });
    const back = s.r.getShopSettingCard(s.db, 'foodpanda.deal', LINK_ON);
    expect(back).toMatchObject({ isDefault: true, value: { percent: 0 }, lastChanged: { byName: 'Test Owner', onThisTill: true } });
    expect(back.history.map((h) => h.value?.percent)).toEqual([0, 25, 20]);
    // The same values written in another order are still the default.
    s.setChecks({ tabletTotal: 'optional', orderCode: 'optional', v: 1 });
    expect(s.r.getShopSettingCard(s.db, 'foodpanda.checks', LINK_ON).isDefault).toBe(true);
    // Any change is not.
    s.setFees({ ...DEFAULT_FOODPANDA_FEES, confirmed: true });
    expect(s.r.getShopSettingCard(s.db, 'foodpanda.fees', LINK_ON).isDefault).toBe(false);
  });

  it("a Save on the other till lands here with its own audit row, and the card says where it came from", async () => {
    const s = await shop();
    s.setDeal(deal());
    const id = s.r.businessSettingId('foodpanda.deal');
    const at = new Date(Date.now() + 60_000).toISOString();
    const image = {
      [ROW_IMAGE_KEY]: 1,
      id,
      key: 'foodpanda.deal',
      valueJson: JSON.stringify(deal({ percent: 30, shopPercent: 15 })),
      updatedByUserId: 'u_owner',
      createdAt: T0,
      updatedAt: at,
      deletedAt: null,
      deviceId: OTHER_TILL,
      version: 2,
    };
    const change: SyncChange = { entityType: 'business_settings', entityId: id, op: 'upsert', payload: image, updatedAt: at, deviceId: OTHER_TILL, version: 2 };
    const r = await s.r.applyRemoteBatch(s.db, [change]);
    expect(r).toMatchObject({ applied: 1, settingsChanged: true });
    expect(s.r.readShopSetting(s.db, 'foodpanda.deal').value).toMatchObject({ percent: 30, shopPercent: 15 });
    const audit = one(s.db, `SELECT action, after_json FROM audit_log WHERE entity_id = ? AND action = 'remote_apply'`, id);
    expect(JSON.parse(String(audit?.['after_json']))).toMatchObject({ key: 'foodpanda.deal', value: { percent: 30 }, updatedByUserId: 'u_owner', fromDeviceId: OTHER_TILL });
    const card = s.r.getShopSettingCard(s.db, 'foodpanda.deal', LINK_ON);
    expect(card.lastChanged).toMatchObject({ byName: 'Test Owner', onThisTill: false });
    expect(card.history[0]).toMatchObject({ onThisTill: false, byName: 'Test Owner', value: { percent: 30 } });
    // A batch with no setting in it says so.
    expect((await s.r.applyRemoteBatch(s.db, [])).settingsChanged).toBe(false);
  });

  it('the counter gets the deal a new order would get — inside its dates only — and never the fees', async () => {
    const s = await shop();
    expect(s.r.checkoutRules(s.db).foodpanda.deal).toBeNull();
    s.setDeal(deal({ startsOn: '2026-10-01', endsOn: '2026-10-07' }));
    expect(s.r.checkoutRules(s.db, new Date('2026-09-30T12:00:00.000Z')).foodpanda.deal).toBeNull();
    expect(s.r.checkoutRules(s.db, new Date('2026-10-03T12:00:00.000Z')).foodpanda).toMatchObject({
      deal: { percent: 20, label: 'Foodpanda deal 20% off' },
      checks: { orderCode: 'optional', tabletTotal: 'optional' },
      tabletToleranceCents: 100,
    });
  });
});

describe.skipIf(!DatabaseSync)('Reports: foodpanda on Channels, the deal on Team & leakage', () => {
  const period = () => ({
    sinceIso: new Date(Date.now() - 3_600_000).toISOString(),
    untilIso: new Date(Date.now() + 3_600_000).toISOString(),
  });

  it('what foodpanda kept and what the shop kept, from each order’s kept terms; older orders estimated; the orders to check', async () => {
    const s = await shop();
    const br = await import('../services/business-report.js');
    s.setDeal(deal({ percent: 20, shopPercent: 10 }));
    s.setFees(fees());
    // A: typed number, tablet matches. Rs 2,000 food, shop pays Rs 200, 16% on Rs 1,800.
    const a = s.order('foodpanda');
    s.add(a.id, s.pizza, 2);
    s.payFoodpanda(a.id, { code: 'FP-A', tablet: 208_800 });
    // B: no number, tablet says Rs 50 more. Rs 1,000 food, shop pays Rs 100.
    const b = s.order('foodpanda');
    s.add(b.id, s.pizza);
    s.payFoodpanda(b.id, { tablet: 104_400 + 5_000 });
    // C: paid before this version (no kept terms): worked with the terms of now, "estimated".
    const c = s.order('foodpanda');
    s.add(c.id, s.side);
    s.payFoodpanda(c.id, { code: 'FP-C' });
    s.db.prepare(`DELETE FROM order_channel_terms WHERE order_id = ?`).run(c.id);
    // D: refunded in full: no sale, no commission.
    const d = s.order('foodpanda');
    s.add(d.id, s.pizza);
    s.payFoodpanda(d.id, { code: 'FP-D' });
    s.r.refundOrder(s.db, { orderId: d.id, reason: 'Never arrived', approverUserId: 'u_mgr', foodMade: 'made' }, MANAGER);
    // Next month the owner changes his terms: A and B keep theirs.
    s.setFees(fees({ commissionBps: 3_000 }));

    const fp = br.getFoodpanda(s.db, period())!;
    expect(fp).toMatchObject({
      orderCount: 3,
      tillPriceSalesCents: 350_000,
      shopDealCents: 20_000 + 10_000 + 5_000,
      foodpandaDealCents: 20_000 + 10_000 + 5_000,
      // 25% of Rs 1,800 and of Rs 900 (kept), 30% of Rs 450 (C, estimated with today's terms).
      commissionCents: 45_000 + 22_500 + 13_500,
      estimatedOrders: 1,
      commissionSuggested: false,
      missingCodeCount: 1,
      tabletDiffCount: 1,
    });
    expect(fp.youKeepCents).toBe(350_000 - 35_000 - fp.commissionCents);
    expect(fp.expectedPayoutCents).toBe(208_800 + 104_400 + s.snap(c.id).order.totalCents - fp.commissionCents);
    // The one with no number and the one whose tablet differs come first.
    expect(fp.toCheck.slice(0, 1).map((l) => l.orderId)).toEqual([b.id]);
    expect(fp.toCheck.find((l) => l.orderId === b.id)).toMatchObject({ foodpandaCode: null, diffCents: 5_000, differs: true });
    expect(fp.toCheck.find((l) => l.orderId === a.id)).toMatchObject({ foodpandaCode: 'FP-A', diffCents: 0, differs: false });
    expect(fp.toCheck.map((l) => l.orderId)).not.toContain(d.id);

    // On the Channels tab; the block is foodpanda's commission and what the shop keeps — profit — so a
    // login without profit.view (or without costs) gets none of it; the owner gets all of it.
    const tab = br.buildChannelsTab(s.db, period());
    expect(tab.foodpanda).toMatchObject({ orderCount: 3 });
    const { reportTabForLogin } = await import('../services/analytics/report-tabs.js');
    const full = {
      ...tab,
      areas: [],
      noRateDeliveries: [],
      noRateCount: 0,
      profit: null,
      foodpanda: { ...tab.foodpanda!, foodCost: { costedOrders: 1, costCents: 1, ofSalesBps: 1, ofKeptBps: 1 } },
      engine: 'main' as const,
    };
    expect(reportTabForLogin('channels', full, false).foodpanda).toBeNull();
    expect(reportTabForLogin('channels', full, true, false).foodpanda).toBeNull();
    expect(reportTabForLogin('channels', full, true, true).foodpanda?.foodCost).toMatchObject({ costedOrders: 1 });
    // No foodpanda orders: no block.
    expect(br.getFoodpanda(s.db, { sinceIso: '2020-01-01T00:00:00.000Z', untilIso: '2020-01-02T00:00:00.000Z' })).toBeNull();
  });

  it('a commission kept while only suggested is re-worked when the owner confirms his real one; a confirmed one never moves', async () => {
    const s = await shop();
    const br = await import('../services/business-report.js');
    // A: paid on the default fees (25%, suggested). Rs 1,000 food, no deal, 16% tax.
    const a = s.order('foodpanda');
    s.add(a.id, s.pizza);
    s.payFoodpanda(a.id, { code: 'FP-A' });
    expect(s.terms(a.id)).toMatchObject({ commission_bps: 2_500, commission_confirmed: 0, commission_cents: 25_000 });
    expect(br.getFoodpanda(s.db, period())).toMatchObject({
      commissionCents: 25_000,
      estimatedOrders: 1,
      commissionSuggested: true,
      unconfirmedCommissionBps: 2_500,
    });
    // The owner types 22% but does not tick "confirmed": the note says 22%, not the suggested figure.
    s.setFees(fees({ commissionBps: 2_200, confirmed: false }));
    expect(br.getFoodpanda(s.db, period())).toMatchObject({ commissionCents: 22_000, commissionSuggested: true, unconfirmedCommissionBps: 2_200 });
    // He confirms 20%: A is worked out at 20% and nothing is "suggested" any more.
    s.setFees(fees({ commissionBps: 2_000, confirmed: true }));
    expect(br.getFoodpanda(s.db, period())).toMatchObject({
      commissionCents: 20_000,
      expectedPayoutCents: 116_000 - 20_000,
      estimatedOrders: 1,
      commissionSuggested: false,
      unconfirmedCommissionBps: null,
    });
    // B: paid with the confirmed 20%. Next month he agrees 30%: B keeps 20%, A (never confirmed) follows.
    const b = s.order('foodpanda');
    s.add(b.id, s.pizza);
    s.payFoodpanda(b.id, { code: 'FP-B' });
    s.setFees(fees({ commissionBps: 3_000, confirmed: true }));
    expect(br.getFoodpanda(s.db, period())).toMatchObject({ commissionCents: 20_000 + 30_000, estimatedOrders: 1, commissionSuggested: false });
    // The kept rows themselves never change (insert-only).
    expect(s.terms(a.id)).toMatchObject({ commission_bps: 2_500, commission_confirmed: 0, commission_cents: 25_000 });
    expect(s.terms(b.id)).toMatchObject({ commission_bps: 2_000, commission_confirmed: 1, commission_cents: 20_000 });
  });

  it('Team & leakage lists the deal under "Standing offers", not under the cashier who rang the order', async () => {
    const s = await shop();
    const br = await import('../services/business-report.js');
    s.setDeal(deal());
    const fp = s.order('foodpanda');
    s.add(fp.id, s.pizza, 2);
    s.payFoodpanda(fp.id, { code: 'FP-1' });
    const t = s.order('takeaway');
    s.add(t.id, s.pizza);
    s.r.applyDiscount(s.db, { orderId: t.id, discountType: 'percent', value: 5, reason: 'Regular' }, CASHIER);
    const total = s.snap(t.id).order.totalCents;
    s.r.tenderOrder(s.db, { orderId: t.id, payments: [{ method: 'cash', amountCents: total, tenderedCents: total }] }, CASHIER);

    const team = br.buildTeamTab(s.db, period());
    expect(team.discounts.totalCents).toBe(40_000 + 5_000);
    expect(team.discounts.standing).toEqual([{ name: 'foodpanda deal (set by the owner)', count: 1, amountCents: 40_000 }]);
    expect(team.discounts.byPerson).toEqual([{ name: 'Test Cashier', count: 1, amountCents: 5_000, approvedCount: 0 }]);
    // "Each discount" is the staff's: the deal order is not listed as the cashier's, nor as the owner-approved giving.
    expect(team.discounts.staffCount).toBe(1);
    expect(team.discounts.recent.map((l) => l.orderId)).toEqual([t.id]);
    expect(team.discounts.recent.some((l) => l.source === 'foodpanda')).toBe(false);
    // "Orders taken" (and the Excel / print staff tables): the cashier gave Rs 50, not Rs 450.
    expect(team.staff).toMatchObject([{ name: 'Test Cashier', orderCount: 2, discountCents: 5_000 }]);
    // The shop's own totals still count the deal.
    expect(br.buildOverviewTab(s.db, period()).kpis).toMatchObject({ discountCents: 40_000 + 5_000, discountedOrderCount: 2 });
  });

  it('a deal a manager changed for one order is then a staff discount, under that order’s cashier', async () => {
    const s = await shop();
    const br = await import('../services/business-report.js');
    s.setDeal(deal());
    const fp = s.order('foodpanda');
    s.add(fp.id, s.pizza, 2);
    s.r.applyDiscount(s.db, { orderId: fp.id, discountType: 'percent', value: 15, approverUserId: 'u_mgr', reason: 'As on the tablet' }, CASHIER);
    s.payFoodpanda(fp.id, { code: 'FP-2' });
    const team = br.buildTeamTab(s.db, period());
    expect(team.discounts.standing).toEqual([]);
    expect(team.discounts.byPerson).toEqual([{ name: 'Test Cashier', count: 1, amountCents: 30_000, approvedCount: 1 }]);
    expect(team.discounts.recent).toMatchObject([{ orderId: fp.id, source: null, approvedBy: 'Test Manager' }]);
    expect(team.staff).toMatchObject([{ name: 'Test Cashier', discountCents: 30_000 }]);
  });
});

// ---------------------------------------------------------------------------
// One source of truth for foodpanda's money (Settings → foodpanda + v0.7.20's
// Phase 9 profit): the one reader, foodpanda's dearer prices, and Reports →
// Profit agreeing with Reports → Channels to the rupee.
// ---------------------------------------------------------------------------

/** v0.7.20's 'channels.fees' as it saved it (its foodpanda part now retired). */
const legacyChannelFees = (foodpanda: { commissionBps: number; base: 'sales_ex_tax' | 'paid_incl_tax' | 'menu_price'; fixedFeeCents: number; upliftBps: number }) => ({
  foodpanda,
  paymentFeeBps: { cash: 0, card: 250, foodpanda: 0, transfer: 0 },
});

describe.skipIf(!DatabaseSync)("the one reader of foodpanda's fees: v0.7.20's terms carried over", () => {
  it('never saved in Settings → foodpanda: what v0.7.20 saved is in force — confirmed, the base mapped, the uplift kept — nothing rewritten', async () => {
    const s = await shop();
    // Nothing saved anywhere: the suggested default.
    expect(s.r.readShopSetting(s.db, 'foodpanda.fees')).toMatchObject({ value: DEFAULT_FOODPANDA_FEES, isDefault: true, carriedOver: false });
    // v0.7.20 saved its card fees with foodpanda at 22.5% of what the customer paid, Rs 25 an order, 10% dearer.
    s.r.setBusinessSetting(s.db, 'channels.fees', legacyChannelFees({ commissionBps: 2_250, base: 'paid_incl_tax', fixedFeeCents: 2_500, upliftBps: 1_000 }), OWNER);
    const saved = one(s.db, `SELECT updated_at FROM business_settings WHERE key = 'channels.fees'`);
    const inUse = s.r.readShopSetting(s.db, 'foodpanda.fees');
    expect(inUse).toMatchObject({
      value: { v: 1, commissionBps: 2_250, confirmed: true, base: 'after_deal', fixedFeeCents: 2_500, commissionTaxBps: 0, upliftBps: 1_000 },
      isDefault: false,
      carriedOver: true,
      savedAt: saved?.['updated_at'],
      savedByUserId: 'u_owner',
    });
    // Read time only: no 'foodpanda.fees' row appeared.
    expect(one(s.db, `SELECT COUNT(*) AS n FROM business_settings WHERE key = 'foodpanda.fees'`)?.['n']).toBe(0);
    // The other two bases.
    s.r.setBusinessSetting(s.db, 'channels.fees', legacyChannelFees({ commissionBps: 2_000, base: 'menu_price', fixedFeeCents: 0, upliftBps: 0 }), OWNER);
    expect(s.r.readShopSetting(s.db, 'foodpanda.fees').value).toMatchObject({ base: 'before_deal', commissionBps: 2_000, confirmed: true });
    s.r.setBusinessSetting(s.db, 'channels.fees', legacyChannelFees({ commissionBps: 2_000, base: 'sales_ex_tax', fixedFeeCents: 0, upliftBps: 0 }), OWNER);
    expect(s.r.readShopSetting(s.db, 'foodpanda.fees').value).toMatchObject({ base: 'after_deal' });
    // The Settings card shows it, and says so.
    expect(s.r.getShopSettingCard(s.db, 'foodpanda.fees', LINK_ON)).toMatchObject({ carriedOver: true, isDefault: false, value: { commissionBps: 2_000, confirmed: true } });
    // Pay keeps the carried-over commission as the owner's (confirmed) on the order.
    const o = s.order('foodpanda');
    s.add(o.id, s.pizza);
    s.payFoodpanda(o.id, { code: 'FP-C1' });
    expect(s.terms(o.id)).toMatchObject({ commission_bps: 2_000, commission_confirmed: 1, commission_base: 'after_deal', commission_cents: 20_000 });
    // Once saved in Settings → foodpanda, that is what is in force.
    s.setFees(fees({ commissionBps: 2_400, confirmed: false }));
    expect(s.r.readShopSetting(s.db, 'foodpanda.fees')).toMatchObject({ value: { commissionBps: 2_400, confirmed: false }, carriedOver: false });
    expect(s.r.getShopSettingCard(s.db, 'foodpanda.fees', LINK_ON).carriedOver).toBe(false);
  });

  it('card fees saved with no foodpanda part (this version): nothing to carry over, the suggested default stays', async () => {
    const s = await shop();
    s.r.setBusinessSetting(s.db, 'channels.fees', { paymentFeeBps: { cash: 0, card: 250, foodpanda: 0, transfer: 0 } }, OWNER);
    expect(s.r.readShopSetting(s.db, 'foodpanda.fees')).toMatchObject({ value: DEFAULT_FOODPANDA_FEES, isDefault: true, carriedOver: false });
  });
});

describe.skipIf(!DatabaseSync)("foodpanda's dearer prices (Settings → foodpanda uplift)", () => {
  it("Pay expects the tablet at foodpanda's prices: a matching tablet is not flagged; the counter is told the uplift, never the commission", async () => {
    const s = await shop();
    s.setDeal(deal());
    s.setFees(fees({ upliftBps: 1_000 }));
    expect(s.r.checkoutRules(s.db).foodpanda).toMatchObject({ upliftBps: 1_000 });
    expect(JSON.stringify(s.r.checkoutRules(s.db))).not.toMatch(/commission/i);
    const o = s.order('foodpanda');
    s.add(o.id, s.pizza, 2);
    // The till's Rs 1,856 (Rs 1,600 + 16% tax) is Rs 2,041.60 at foodpanda's prices.
    expect(s.snap(o.id).order.totalCents).toBe(185_600);
    s.payFoodpanda(o.id, { code: 'FP-U1', tablet: 204_160 });
    expect(s.terms(o.id)).toMatchObject({
      tablet_total_cents: 204_160,
      tablet_diff_cents: 0,
      // 25% of Rs 1,760 (the food after the deal at foodpanda's prices).
      commission_cents: 44_000,
      expected_payout_cents: 204_160 - 44_000,
    });
    const br = await import('../services/business-report.js');
    const range = { sinceIso: new Date(Date.now() - 3_600_000).toISOString(), untilIso: new Date(Date.now() + 3_600_000).toISOString() };
    const fp = br.getFoodpanda(s.db, range)!;
    expect(fp).toMatchObject({ tabletDiffCount: 0, upliftCents: 16_000, youKeepCents: 160_000 + 16_000 - 44_000 });
    expect(fp.toCheck[0]).toMatchObject({ tillTotalCents: 185_600, expectedTabletCents: 204_160, diffCents: 0, differs: false });
  });
});

describe.skipIf(!DatabaseSync)('Reports → Profit and Reports → Channels agree on foodpanda to the rupee', () => {
  it('one per-order rule: shop-paid deal, foodpanda-paid deal, unconfirmed-then-confirmed, and an order paid before terms existed', async () => {
    const s = await shop();
    const br = await import('../services/business-report.js');
    const profit = await import('../services/analytics/profit.js');
    const range = { sinceIso: new Date(Date.now() - 3_600_000).toISOString(), untilIso: new Date(Date.now() + 3_600_000).toISOString() };
    const confirmedFees = fees({ commissionBps: 2_500, confirmed: true, fixedFeeCents: 2_000, commissionTaxBps: 1_600, upliftBps: 1_000 });

    // A: the deal paid by the shop (20%), commission confirmed at payment, foodpanda 10% dearer.
    s.setDeal(deal());
    s.setFees(confirmedFees);
    const a = s.order('foodpanda');
    s.add(a.id, s.pizza, 2);
    s.payFoodpanda(a.id, { code: 'FP-A' });
    // B: the deal paid by foodpanda, confirmed at payment.
    s.setDeal(deal({ shopPercent: 0 }));
    const b = s.order('foodpanda');
    s.add(b.id, s.pizza);
    s.add(b.id, s.side);
    s.payFoodpanda(b.id, { code: 'FP-B' });
    // C: paid while the commission was only suggested…
    s.setFees(fees({ commissionBps: 3_000, confirmed: false }));
    const c = s.order('foodpanda');
    s.add(c.id, s.pizza);
    s.payFoodpanda(c.id, { code: 'FP-C' });
    // D: paid before order_channel_terms existed (v0.7.20).
    const d = s.order('foodpanda');
    s.add(d.id, s.side);
    s.payFoodpanda(d.id, { code: 'FP-D' });
    s.db.prepare(`DELETE FROM order_channel_terms WHERE order_id = ?`).run(d.id);
    // A takeaway order: no commission, no uplift.
    const t = s.order('takeaway');
    s.add(t.id, s.pizza);
    s.r.tenderOrder(s.db, { orderId: t.id, payments: [{ method: 'cash', amountCents: s.snap(t.id).order.totalCents }] }, CASHIER);
    // …then the owner confirms his real commission: C and D are worked with it; A and B keep theirs.
    s.setFees(fees({ commissionBps: 2_200, confirmed: true, fixedFeeCents: 2_000, commissionTaxBps: 1_600, upliftBps: 500 }));

    // By hand (paisa):
    //  A: food 200,000 − the shop's 40,000 = 160,000; uplift 16,000; 25% of 176,000 = 44,000 + 16% tax 7,040 + fee 2,000 = 53,040.
    //  B: 150,000 (foodpanda's 30,000 is not the shop's discount); uplift 15,000; 25% of 165,000 = 41,250 + 6,600 + 2,000 = 49,850.
    //  C: 100,000; today's: uplift 5,000; 22% of 105,000 = 23,100 + 3,696 + 2,000 = 28,796.
    //  D: 50,000; today's: uplift 2,500; 22% of 52,500 = 11,550 + 1,848 + 2,000 = 15,398.
    const keeps = 53_040 + 49_850 + 28_796 + 15_398;
    const uplift = 16_000 + 15_000 + 5_000 + 2_500;
    const fp = br.getFoodpanda(s.db, range)!;
    expect(fp).toMatchObject({
      orderCount: 4,
      tillPriceSalesCents: 500_000,
      shopDealCents: 40_000,
      foodpandaDealCents: 30_000 + 20_000 + 10_000,
      commissionCents: 44_000 + 41_250 + 23_100 + 11_550,
      feeCents: 4 * 2_000,
      commissionTaxCents: 7_040 + 6_600 + 3_696 + 1_848,
      foodpandaKeepsCents: keeps,
      upliftCents: uplift,
      estimatedOrders: 2,
      commissionSuggested: false,
    });
    expect(fp.youKeepCents).toBe(460_000 + uplift - keeps);

    // Reports → Profit: the waterfall's commission and uplift steps, and the foodpanda row.
    const tab = profit.buildProfitTab(s.db, range);
    expect(tab.steps.find((x) => x.key === 'commission')?.cents).toBe(-keeps);
    expect(tab.steps.find((x) => x.key === 'uplift')?.cents).toBe(uplift);
    const row = tab.channels.find((x) => x.channel === 'foodpanda')!;
    expect(row).toMatchObject({ orderCount: 4, commissionCents: keeps, upliftCents: uplift });
    // Sales already hold the shop's part of the deal as a discount; foodpanda's part is neither added nor lost:
    // the foodpanda row's sales are the stored food after the shop's part, exactly the block's.
    expect(row.salesCents).toBe(fp.tillPriceSalesCents - fp.shopDealCents);
    expect(row.salesCents + row.upliftCents - row.commissionCents).toBe(fp.youKeepCents);
    expect(tab.channels.find((x) => x.channel === 'takeaway')).toMatchObject({ commissionCents: 0, upliftCents: 0 });
    // Reports → Channels' own "what each order type earns" (the same screen as the block).
    const extras = profit.channelsExtras(s.db, range, true);
    expect(extras.profit?.channels.find((x) => x.channel === 'foodpanda')).toMatchObject({ commissionCents: fp.foodpandaKeepsCents, upliftCents: fp.upliftCents });
    // The notes under both say the terms in force: Settings → foodpanda's.
    expect(tab.fees.foodpanda).toMatchObject({ commissionBps: 2_200, confirmed: true, upliftBps: 500 });
    expect(extras.profit?.fees.foodpanda).toEqual(tab.fees.foodpanda);
  });
});
