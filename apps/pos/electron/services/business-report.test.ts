import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BusinessReport, ReportDiscountLine, ReportItemLine } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import {
  channelOf,
  getBusinessReport,
  ingredientCostCents,
  pakistanHourOf,
  paymentGroup,
  tradingDayOf,
  refundReason,
  rollUpCategories,
  summarizeDiscounts,
} from './business-report.js';

/**
 * The report's SQL, run for real: every migration applied to an in-memory
 * database, a known trading day of orders seeded, then the figures checked —
 * exact amounts, and that every breakdown adds back up to the stored order
 * totals.
 *
 * better-sqlite3 in this repo is built for Electron's ABI and cannot open
 * under plain Node (see db-contracts.test.ts), so this uses Node's own
 * `node:sqlite` (Node ≥ 22.13) behind a tiny better-sqlite3-shaped shim. On
 * a Node without it the SQL tests skip; the pure helpers still run.
 *
 * All prices below are made up (round test numbers), not the shop's.
 */

interface NodeStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}
interface NodeDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeStatement;
  close(): void;
}
type NodeDatabaseCtor = new (path: string) => NodeDatabase;

// require, not import: Vite's resolver does not know `node:sqlite` is built in.
let DatabaseSync: NodeDatabaseCtor | null = null;
try {
  DatabaseSync = (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: NodeDatabaseCtor }).DatabaseSync;
} catch {
  DatabaseSync = null;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

function openMigrated(): { raw: NodeDatabase; db: AppDatabase } {
  if (!DatabaseSync) throw new Error('node:sqlite unavailable');
  const raw = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  // Seeding picks its own ids; the report only reads.
  raw.exec('PRAGMA foreign_keys = OFF');
  const shim = {
    prepare: (sql: string) => raw.prepare(sql),
    exec: (sql: string) => raw.exec(sql),
    transaction:
      <T>(fn: () => T) =>
      (): T => {
        raw.exec('BEGIN');
        try {
          const out = fn();
          raw.exec('COMMIT');
          return out;
        } catch (err) {
          raw.exec('ROLLBACK');
          throw err;
        }
      },
  };
  return { raw, db: shim as unknown as AppDatabase };
}

// ------------------------------------------------------------------ seeding --

const DEV = 'dev-test';
const T0 = '2026-01-01T00:00:00.000Z';

function seedBasics(raw: NodeDatabase): void {
  const user = raw.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_ali', 'Ali', 'cashier', T0, T0, DEV);
  user.run('u_sara', 'Sara', 'manager', T0, T0, DEV);
  user.run('u_owner', 'Owner', 'admin', T0, T0, DEV);
  raw
    .prepare(`INSERT INTO tax_categories (id, name, rate_bps, created_at, updated_at, device_id) VALUES ('tx', 'GST', 1600, ?, ?, ?)`)
    .run(T0, T0, DEV);
  const cat = raw.prepare(`INSERT INTO categories (id, name, created_at, updated_at, device_id) VALUES (?, ?, ?, ?, ?)`);
  cat.run('c_burger', 'Burgers', T0, T0, DEV);
  cat.run('c_drink', 'Drinks', T0, T0, DEV);
  const item = raw.prepare(
    `INSERT INTO menu_items (id, category_id, name, base_price_cents, tax_category_id, created_at, updated_at, device_id)
     VALUES (?, ?, ?, ?, 'tx', ?, ?, ?)`,
  );
  item.run('m_burger', 'c_burger', 'Test Burger', 50000, T0, T0, DEV);
  item.run('m_drink', 'c_drink', 'Test Drink', 10000, T0, T0, DEV);
  raw
    .prepare(`INSERT INTO riders (id, name, phone, created_at, updated_at, device_id) VALUES ('r_bilal', 'Bilal', '0300', ?, ?, ?)`)
    .run(T0, T0, DEV);
}

interface SeedOrder {
  id: string;
  mode?: string;
  source?: string;
  status?: string;
  cashier?: string;
  createdAt: string;
  paidAt?: string | null;
  deletedAt?: string | null;
  subtotal: number;
  discount?: number;
  tax: number;
  total: number;
  items?: Array<{ menuItemId: string; name: string; qty: number; lineTotal: number }>;
  payments?: Array<{ method: string; amount: number; at?: string; ref?: string | null; by?: string }>;
  voidedBy?: string | null;
  voidReason?: string | null;
  rider?: string | null;
  dispatchedAt?: string | null;
  deliveredAt?: string | null;
  address?: string | null;
}

let seq = 0;
function seedOrder(raw: NodeDatabase, o: SeedOrder): void {
  raw
    .prepare(
      `INSERT INTO orders (id, order_number, mode, status, cashier_id, source, subtotal_cents, discount_cents,
         tax_cents, total_cents, paid_at, voided_at, voided_by, void_reason, assigned_rider_id, dispatched_at,
         delivered_at, delivery_address_snapshot, created_at, updated_at, deleted_at, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      o.id,
      `N-${o.id}`,
      o.mode ?? 'takeaway',
      o.status ?? 'paid',
      o.cashier ?? 'u_ali',
      o.source ?? 'pos',
      o.subtotal,
      o.discount ?? 0,
      o.tax,
      o.total,
      o.paidAt === undefined ? o.createdAt : o.paidAt,
      o.voidedBy ? o.createdAt : null,
      o.voidedBy ?? null,
      o.voidReason ?? null,
      o.rider ?? null,
      o.dispatchedAt ?? null,
      o.deliveredAt ?? null,
      o.address ?? null,
      o.createdAt,
      o.createdAt,
      o.deletedAt ?? null,
      DEV,
    );
  for (const it of o.items ?? []) {
    seq += 1;
    raw
      .prepare(
        `INSERT INTO order_items (id, order_id, menu_item_id, menu_item_name, quantity, unit_price_cents,
           line_total_cents, tax_category_id, tax_rate_bps_snapshot, prep_station_snapshot, created_at, updated_at, device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'tx', 1600, 'kitchen', ?, ?, ?)`,
      )
      .run(`oi${seq}`, o.id, it.menuItemId, it.name, it.qty, Math.round(it.lineTotal / it.qty), it.lineTotal, o.createdAt, o.createdAt, DEV);
  }
  for (const p of o.payments ?? []) {
    seq += 1;
    const at = p.at ?? o.createdAt;
    raw
      .prepare(
        `INSERT INTO payments (id, order_id, method, amount_cents, reference_no, received_by_user_id, paid_at,
           created_at, updated_at, device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(`p${seq}`, o.id, p.method, p.amount, p.ref ?? null, p.by ?? o.cashier ?? 'u_ali', at, at, at, DEV);
  }
}

function seedDiscount(
  raw: NodeDatabase,
  d: { orderId: string; type: 'percent' | 'flat'; value: number; amount: number; reason: string | null; by: string; approvedBy?: string | null; at: string; deletedAt?: string },
): void {
  seq += 1;
  raw
    .prepare(
      `INSERT INTO order_discounts (id, order_id, discount_type, value, reason, applied_by_user_id, approved_by_user_id,
         amount_cents, created_at, updated_at, deleted_at, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(`d${seq}`, d.orderId, d.type, d.value, d.reason, d.by, d.approvedBy ?? null, d.amount, d.at, d.at, d.deletedAt ?? null, DEV);
}

const burger = (qty: number) => ({ menuItemId: 'm_burger', name: 'Test Burger', qty, lineTotal: 50000 * qty });
const drink = (qty: number) => ({ menuItemId: 'm_drink', name: 'Test Drink', qty, lineTotal: 10000 * qty });

/**
 * Trading day 2026-09-25 runs 05:00 PKT on the 25th to 05:00 PKT on the 26th
 * = 2026-09-25T00:00Z → 2026-09-26T00:00Z.
 */
const DAY = { sinceIso: '2026-09-25T00:00:00.000Z', untilIso: '2026-09-26T00:00:00.000Z' };
const DAY_BEFORE = { sinceIso: '2026-09-24T00:00:00.000Z', untilIso: '2026-09-25T00:00:00.000Z' };

function seedTradingDay(raw: NodeDatabase): void {
  seedBasics(raw);
  // O1 — counter takeaway at 1 pm, cash.
  seedOrder(raw, {
    id: 'o1', createdAt: '2026-09-25T08:00:00.000Z', subtotal: 100000, tax: 16000, total: 116000,
    items: [burger(2)], payments: [{ method: 'cash', amount: 116000 }],
  });
  // O2 — phone delivery at 8:30 pm, 10% off, card; Rs 50 handed back in cash the NEXT day.
  seedOrder(raw, {
    id: 'o2', mode: 'delivery', createdAt: '2026-09-25T15:30:00.000Z', subtotal: 70000, discount: 7000, tax: 10080,
    total: 73080, items: [burger(1), drink(2)],
    payments: [
      { method: 'card', amount: 73080 },
      { method: 'cash', amount: -5000, at: '2026-09-26T10:00:00.000Z', ref: 'partial-refund: cold drink', by: 'u_sara' },
    ],
    rider: 'r_bilal', dispatchedAt: '2026-09-25T15:50:00.000Z', deliveredAt: '2026-09-25T16:20:00.000Z',
    address: JSON.stringify({ label: 'Home', addressLine: 'House 1', area: 'DHA Phase 6', city: 'Karachi', notes: null }),
  });
  seedDiscount(raw, { orderId: 'o2', type: 'percent', value: 10, amount: 7000, reason: 'Regular customer', by: 'u_ali', at: '2026-09-25T15:31:00.000Z' });
  // A discount that was taken off before payment must not count.
  seedDiscount(raw, { orderId: 'o2', type: 'flat', value: 2000, amount: 2000, reason: 'Removed', by: 'u_ali', at: '2026-09-25T15:30:30.000Z', deletedAt: '2026-09-25T15:31:00.000Z' });
  // O3 — foodpanda at 00:59 on the 26th (Pakistan): still the 25th's trading day.
  // Its item is gone from the menu since; the sold name must carry it.
  seedOrder(raw, {
    id: 'o3', mode: 'foodpanda', createdAt: '2026-09-25T19:59:00.000Z', subtotal: 30000, tax: 4800, total: 34800,
    items: [{ menuItemId: 'm_gone', name: 'Loaded Fries', qty: 1, lineTotal: 30000 }],
    payments: [{ method: 'foodpanda', amount: 34800 }],
  });
  // O4 — website pick-up at 5 pm, paid by Easypaisa, still on the board (prepaid).
  seedOrder(raw, {
    id: 'o4', source: 'web', mode: 'takeaway', status: 'sent_to_kitchen', cashier: 'u_owner',
    createdAt: '2026-09-25T12:00:00.000Z', subtotal: 50000, discount: 5000, tax: 7200, total: 52200,
    items: [burger(1)], payments: [{ method: 'easypaisa', amount: 52200 }],
  });
  seedDiscount(raw, { orderId: 'o4', type: 'percent', value: 10, amount: 5000, reason: 'Website pick-up 10%', by: 'u_owner', at: '2026-09-25T12:00:00.000Z' });
  // O5 — website delivery at 6 pm, cash on delivery, no rider marked, old free-text address.
  seedOrder(raw, {
    id: 'o5', source: 'web', mode: 'delivery', status: 'delivered', cashier: 'u_owner',
    createdAt: '2026-09-25T13:00:00.000Z', subtotal: 10000, tax: 1600, total: 11600,
    items: [drink(1)], payments: [{ method: 'cash', amount: 11600 }], address: 'House 5, Street 2',
  });
  // O6 — refunded in full: out of the sales, into the refunds.
  seedOrder(raw, {
    id: 'o6', status: 'refunded', createdAt: '2026-09-25T09:00:00.000Z', subtotal: 50000, tax: 8000, total: 58000,
    items: [burger(1)], voidedBy: 'u_sara', voidReason: 'Wrong order',
    payments: [
      { method: 'card', amount: 58000 },
      { method: 'card', amount: -58000, at: '2026-09-25T09:30:00.000Z', ref: 'refund-of:p-x', by: 'u_sara' },
    ],
  });
  // O7 — cancelled before payment.
  seedOrder(raw, {
    id: 'o7', status: 'void', paidAt: null, createdAt: '2026-09-25T10:00:00.000Z', subtotal: 20000, tax: 3200,
    total: 23200, items: [drink(2)], voidedBy: 'u_sara', voidReason: 'Customer left',
  });
  // O8 — a delivery still on the road, not paid yet.
  seedOrder(raw, {
    id: 'o8', mode: 'delivery', status: 'out_for_delivery', paidAt: null, createdAt: '2026-09-25T18:00:00.000Z',
    subtotal: 10000, tax: 1600, total: 11600, items: [drink(1)],
  });
  // O9 — an empty cart: nothing at all.
  seedOrder(raw, { id: 'o9', status: 'open', paidAt: null, createdAt: '2026-09-25T18:30:00.000Z', subtotal: 0, tax: 0, total: 0 });
  // O10 — 04:59 on the 25th (Pakistan): the 24th's trading day.
  seedOrder(raw, {
    id: 'o10', createdAt: '2026-09-24T23:59:59.999Z', subtotal: 10000, tax: 1600, total: 11600,
    items: [drink(1)], payments: [{ method: 'cash', amount: 11600 }],
  });
  // O11 — 05:00 on the 26th: the next trading day.
  seedOrder(raw, {
    id: 'o11', createdAt: '2026-09-26T00:00:00.000Z', subtotal: 10000, tax: 1600, total: 11600,
    items: [drink(1)], payments: [{ method: 'cash', amount: 11600 }],
  });
  // O12 — deleted: never counts.
  seedOrder(raw, {
    id: 'o12', createdAt: '2026-09-25T11:00:00.000Z', deletedAt: '2026-09-25T11:01:00.000Z', subtotal: 10000,
    tax: 1600, total: 11600, items: [drink(1)], payments: [{ method: 'cash', amount: 11600 }],
  });
  // O13 — split cash + card at 10 pm, taken by the manager.
  seedOrder(raw, {
    id: 'o13', cashier: 'u_sara', createdAt: '2026-09-25T17:00:00.000Z', subtotal: 30000, tax: 4800, total: 34800,
    items: [drink(3)], payments: [{ method: 'cash', amount: 20000 }, { method: 'card', amount: 14800 }],
  });

  // Shifts: one in the day (closed Rs 100 short, Rs 200 paid out), one the day before.
  raw
    .prepare(
      `INSERT INTO shifts (id, device_id, opened_by_user_id, opened_at, opening_cash_cents, closed_by_user_id, closed_at,
         counted_cash_cents, expected_cash_cents, variance_cents, created_at, updated_at)
       VALUES (?, ?, 'u_sara', ?, 500000, 'u_sara', ?, ?, ?, ?, ?, ?)`,
    )
    .run('s1', DEV, '2026-09-25T07:00:00.000Z', '2026-09-25T20:30:00.000Z', 590000, 600000, -10000, T0, T0);
  raw
    .prepare(
      `INSERT INTO shifts (id, device_id, opened_by_user_id, opened_at, opening_cash_cents, created_at, updated_at)
       VALUES ('s0', ?, 'u_ali', '2026-09-24T07:00:00.000Z', 0, ?, ?)`,
    )
    .run(DEV, T0, T0);
  raw
    .prepare(
      `INSERT INTO cash_movements (id, shift_id, type, amount_cents, reason, user_id, created_at, updated_at, device_id)
       VALUES ('cm1', 's1', 'payout', 20000, 'Gas', 'u_sara', ?, ?, ?)`,
    )
    .run(T0, T0, DEV);

  // Stock: buns at Rs 20 each (no pack), cheese bought as 1,000 g for Rs 1,500.
  const ing = raw.prepare(
    `INSERT INTO ingredients (id, name, unit, cost_per_unit_cents, pack_size, pack_price_cents, created_at, updated_at, device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  ing.run('i_bun', 'Bun', 'pcs', 2000, null, null, T0, T0, DEV);
  ing.run('i_cheese', 'Cheese', 'g', 150, 1000, 150000, T0, T0, DEV);
  const mv = raw.prepare(
    `INSERT INTO stock_movements (id, ingredient_id, delta_qty, reason, occurred_at, resulting_qty, created_at, updated_at, device_id)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  );
  mv.run('mv1', 'i_bun', -4, 'sale', '2026-09-25T08:00:00.000Z', T0, T0, DEV);
  mv.run('mv2', 'i_bun', 1, 'sale', '2026-09-25T10:00:00.000Z', T0, T0, DEV); // a cancellation put one back
  mv.run('mv3', 'i_bun', -1, 'waste', '2026-09-25T21:00:00.000Z', T0, T0, DEV);
  mv.run('mv4', 'i_cheese', -250, 'sale', '2026-09-25T15:30:00.000Z', T0, T0, DEV);
  mv.run('mv5', 'i_cheese', 5000, 'delivery', '2026-09-25T06:00:00.000Z', T0, T0, DEV); // a delivery is not usage
  mv.run('mv6', 'i_cheese', -999, 'sale', '2026-09-24T15:30:00.000Z', T0, T0, DEV); // the day before
}

// -------------------------------------------------------------------- tests --

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/** Every identity the page relies on: all the breakdowns add back up. */
function expectReconciles(r: BusinessReport): void {
  const k = r.kpis;
  expect(k.menuSalesCents - k.discountCents + k.taxCents).toBe(k.billedCents);
  expect(k.billedCents - k.partialRefundCents).toBe(k.netSalesCents);
  expect(sum(r.byDay.map((d) => d.netSalesCents))).toBe(k.netSalesCents);
  expect(sum(r.byDay.map((d) => d.orderCount))).toBe(k.orderCount);
  expect(sum(r.byHour.map((h) => h.netSalesCents))).toBe(k.netSalesCents);
  expect(sum(r.channels.map((c) => c.netSalesCents))).toBe(k.netSalesCents);
  expect(sum(r.channels.map((c) => c.orderCount))).toBe(k.orderCount);
  expect(sum(r.staff.map((s) => s.netSalesCents))).toBe(k.netSalesCents);
  expect(sum(r.staff.map((s) => s.discountCents))).toBe(k.discountCents);
  expect(sum(Object.values(k.payments)) + k.unrecordedPaymentCents).toBe(k.netSalesCents);
  expect(sum(r.items.map((i) => i.salesCents))).toBe(k.menuSalesCents);
  expect(sum(r.items.map((i) => i.quantity))).toBe(k.itemCount);
  expect(sum(r.categories.map((c) => c.salesCents))).toBe(k.menuSalesCents);
  expect(r.discounts.totalCents).toBe(k.discountCents);
  expect(r.discounts.totalCount).toBe(k.discountedOrderCount);
  expect(sum(r.discounts.byReason.map((d) => d.amountCents))).toBe(k.discountCents);
  expect(sum(r.discounts.byPerson.map((d) => d.amountCents))).toBe(k.discountCents);
  expect(sum(r.refunds.map((x) => x.amountCents))).toBe(k.partialRefundCents + k.fullRefundCents);
  expect(sum(r.voids.map((v) => v.amountCents))).toBe(k.voidCents);
}

describe.skipIf(!DatabaseSync)('business report (real SQL on the real migrations)', () => {
  let report: BusinessReport;

  beforeAll(() => {
    const { raw, db } = openMigrated();
    seedTradingDay(raw);
    report = getBusinessReport(db, { ...DAY, compareSinceIso: DAY_BEFORE.sinceIso, compareUntilIso: DAY_BEFORE.untilIso });
    raw.close();
  });

  it('adds up the headline figures from the stored order totals', () => {
    expect(report.kpis).toEqual({
      orderCount: 6,
      itemCount: 11,
      menuSalesCents: 290000,
      discountCents: 12000,
      discountedOrderCount: 2,
      taxCents: 44480,
      billedCents: 322480,
      partialRefundCents: 5000,
      partialRefundOrderCount: 1,
      netSalesCents: 317480,
      avgOrderCents: 52913,
      fullRefundCount: 1,
      fullRefundCents: 58000,
      voidCount: 1,
      voidCents: 23200,
      unpaidCount: 1,
      unpaidCents: 11600,
      payments: { cash: 142600, card: 87880, foodpanda: 34800, transfer: 52200 },
      unrecordedPaymentCents: 0,
    });
  });

  it('every breakdown reconciles with the headline', () => {
    expectReconciles(report);
  });

  it('cuts the trading day at 05:00 Pakistan time, not midnight', () => {
    // O3 at 00:59 PKT on the 26th is the 25th's; O10 at 04:59 PKT on the 25th is not; O11 at 05:00 on the 26th is not.
    expect(report.byDay).toEqual([{ day: '2026-09-25', orderCount: 6, netSalesCents: 317480 }]);
    expect(report.previous?.orderCount).toBe(1);
    expect(report.previous?.netSalesCents).toBe(11600);
  });

  it('puts sales in Pakistan clock hours', () => {
    expect(report.byHour.map((h) => [h.hour, h.netSalesCents])).toEqual([
      [0, 34800], // 00:59 foodpanda
      [13, 116000],
      [17, 52200],
      [18, 11600],
      [20, 68080],
      [22, 34800],
    ]);
  });

  it('lists items and categories at menu price, keeping items gone from the menu', () => {
    expect(report.items.map((i) => [i.name, i.categoryName, i.quantity, i.salesCents])).toEqual([
      ['Test Burger', 'Burgers', 4, 200000],
      ['Test Drink', 'Drinks', 6, 60000],
      ['Loaded Fries', 'No category', 1, 30000],
    ]);
    expect(report.categories.map((c) => [c.name, c.quantity, c.salesCents])).toEqual([
      ['Burgers', 4, 200000],
      ['Drinks', 6, 60000],
      ['No category', 1, 30000],
    ]);
  });

  it('splits order types the way the owner names them', () => {
    const byChannel = Object.fromEntries(report.channels.map((c) => [c.channel, [c.orderCount, c.netSalesCents]]));
    expect(byChannel).toEqual({
      takeaway: [2, 150800],
      delivery: [1, 68080],
      foodpanda: [1, 34800],
      web_pickup: [1, 52200],
      web_delivery: [1, 11600],
    });
  });

  it('gives website orders their own staff line and counts cancellations per person', () => {
    expect(report.staff.map((s) => [s.name, s.orderCount, s.netSalesCents, s.discountCents, s.voidCount])).toEqual([
      ['Ali', 3, 218880, 7000, 1],
      ['Website orders', 2, 63800, 5000, 0],
      ['Sara', 1, 34800, 0, 0],
    ]);
  });

  it('shows the shifts of the period with their stored drawer figures', () => {
    expect(report.shifts).toEqual([
      {
        id: 's1',
        openedAt: '2026-09-25T07:00:00.000Z',
        closedAt: '2026-09-25T20:30:00.000Z',
        openedBy: 'Sara',
        closedBy: 'Sara',
        openingCashCents: 500000,
        expectedCashCents: 600000,
        countedCashCents: 590000,
        varianceCents: -10000,
        cashInCents: 0,
        cashOutCents: 20000,
      },
    ]);
  });

  it('says who gave each discount and why', () => {
    expect(report.discounts.byReason).toEqual([
      { reason: 'Regular customer', count: 1, amountCents: 7000 },
      { reason: 'Website pick-up 10%', count: 1, amountCents: 5000 },
    ]);
    expect(report.discounts.byPerson).toEqual([
      { name: 'Ali', count: 1, amountCents: 7000, approvedCount: 0 },
      { name: 'Owner', count: 1, amountCents: 5000, approvedCount: 0 },
    ]);
    expect(report.discounts.recent[0]).toMatchObject({ orderId: 'o2', entered: '10%', givenBy: 'Ali' });
  });

  it('lists refunds (with their reasons and approvers) and cancelled orders', () => {
    expect(report.refunds.map((r) => [r.orderId, r.amountCents, r.method, r.full, r.reason, r.approvedBy])).toEqual([
      ['o2', 5000, 'cash', false, 'cold drink', 'Sara'],
      ['o6', 58000, 'card', true, 'Wrong order', 'Sara'],
    ]);
    expect(report.voids.map((v) => [v.orderId, v.amountCents, v.reason, v.approvedBy, v.takenBy])).toEqual([
      ['o7', 23200, 'Customer left', 'Sara', 'Ali'],
    ]);
  });

  it('values ingredient usage and waste at the stored prices', () => {
    expect(report.foodCost.ingredients.map((i) => [i.name, i.usedQty, i.usedCents, i.wastedQty, i.wastedCents])).toEqual([
      ['Cheese', 250, 37500, 0, 0],
      ['Bun', 3, 6000, 1, 2000],
    ]);
    expect(report.foodCost).toMatchObject({ usedCents: 43500, wasteCents: 2000, hasCosts: true, hasUsage: true });
  });

  it('breaks own-rider deliveries down by rider and area', () => {
    expect(report.deliveries.byRider).toEqual([
      { riderId: 'r_bilal', name: 'Bilal', deliveries: 1, netSalesCents: 68080, avgMinutesOut: 30 },
      { riderId: null, name: 'No rider recorded', deliveries: 1, netSalesCents: 11600, avgMinutesOut: null },
    ]);
    expect(report.deliveries.byArea).toEqual([
      { area: 'DHA Phase 6', orderCount: 1, netSalesCents: 68080 },
      { area: 'Area not recorded', orderCount: 1, netSalesCents: 11600 },
    ]);
  });

  it('an empty period is all zeros, not an error', () => {
    const { raw, db } = openMigrated();
    const r = getBusinessReport(db, { sinceIso: '2030-01-01T00:00:00.000Z', untilIso: '2030-01-02T00:00:00.000Z' });
    raw.close();
    expect(r.kpis.netSalesCents).toBe(0);
    expect(r.kpis.avgOrderCents).toBe(0);
    expect(r.previous).toBeNull();
    expect(r.items).toEqual([]);
    expect(r.foodCost).toMatchObject({ usedCents: 0, hasUsage: false, hasCosts: false });
  });

  it('reconciles on a month of generated orders (random refunds, splits, discounts)', () => {
    const { raw, db } = openMigrated();
    seedBasics(raw);
    let state = 42;
    const rand = (n: number) => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % n;
    };
    const methods = ['cash', 'card', 'easypaisa', 'jazzcash', 'bank_transfer'];
    for (let i = 0; i < 600; i += 1) {
      const created = new Date(Date.UTC(2026, 7, 1) + rand(31 * 24 * 60) * 60_000).toISOString();
      const burgers = rand(3);
      const drinks = 1 + rand(3);
      const subtotal = burgers * 50000 + drinks * 10000;
      const discount = rand(4) === 0 ? Math.round(subtotal / 10) : 0;
      const tax = Math.round(((subtotal - discount) * 1600) / 10000);
      const total = subtotal - discount + tax;
      const foodpanda = rand(6) === 0;
      const split = !foodpanda && rand(5) === 0 ? rand(total) + 1 : 0;
      const payments: SeedOrder['payments'] = foodpanda
        ? [{ method: 'foodpanda', amount: total }]
        : split > 0 && split < total
          ? [{ method: 'cash', amount: split }, { method: 'card', amount: total - split }]
          : [{ method: methods[rand(methods.length)]!, amount: total }];
      const fate = rand(20);
      let status = 'paid';
      if (fate === 0) {
        status = 'refunded';
        payments.push({ method: 'cash', amount: -total, ref: 'refund-rest: test' });
      } else if (fate === 1) {
        payments.push({ method: 'cash', amount: -Math.min(total, 1000 + rand(5000)), ref: 'partial-refund: test' });
      }
      const voided = fate === 2;
      const id = `g${i}`;
      seedOrder(raw, {
        id,
        mode: foodpanda ? 'foodpanda' : ['takeaway', 'delivery'][rand(2)],
        source: !foodpanda && rand(4) === 0 ? 'web' : 'pos',
        status: voided ? 'void' : status,
        cashier: ['u_ali', 'u_sara'][rand(2)],
        createdAt: created,
        paidAt: voided ? null : created,
        subtotal,
        discount,
        tax,
        total,
        items: [...(burgers ? [burger(burgers)] : []), drink(drinks)],
        payments: voided ? [] : payments,
        voidedBy: voided ? 'u_sara' : null,
        voidReason: voided ? 'test' : null,
      });
      if (discount > 0) seedDiscount(raw, { orderId: id, type: 'percent', value: 10, amount: discount, reason: 'Test', by: 'u_ali', at: created });
    }
    const month = getBusinessReport(db, { sinceIso: '2026-08-01T00:00:00.000Z', untilIso: '2026-09-01T00:00:00.000Z' });
    // Two halves add up to the whole month.
    const a = getBusinessReport(db, { sinceIso: '2026-08-01T00:00:00.000Z', untilIso: '2026-08-16T00:00:00.000Z' });
    const b = getBusinessReport(db, { sinceIso: '2026-08-16T00:00:00.000Z', untilIso: '2026-09-01T00:00:00.000Z' });
    raw.close();
    expect(month.kpis.orderCount).toBeGreaterThan(400);
    expect(month.refunds.length).toBeLessThanOrEqual(300);
    expectReconciles(month);
    expect(month.kpis.unrecordedPaymentCents).toBe(0);
    expect(a.kpis.netSalesCents + b.kpis.netSalesCents).toBe(month.kpis.netSalesCents);
    expect(a.kpis.orderCount + b.kpis.orderCount).toBe(month.kpis.orderCount);
  });

  it('reads orders and stock by date through an index, not a full-table scan', () => {
    const { raw } = openMigrated();
    const plan = (sql: string) =>
      (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(DAY.sinceIso, DAY.untilIso) as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join(' | ');
    const orders = plan(
      `SELECT COUNT(*) FROM orders o WHERE o.created_at >= ? AND o.created_at < ? AND o.deleted_at IS NULL
         AND o.paid_at IS NOT NULL AND o.status NOT IN ('void', 'refunded')`,
    );
    const stock = plan(
      `SELECT COUNT(*) FROM stock_movements m WHERE m.reason IN ('sale', 'waste') AND m.occurred_at >= ?
         AND m.occurred_at < ? AND m.deleted_at IS NULL`,
    );
    raw.close();
    expect(orders).toMatch(/USING (COVERING )?INDEX/);
    expect(orders).not.toMatch(/^SCAN o$|SCAN o \||SCAN orders$/);
    expect(stock).toMatch(/USING (COVERING )?INDEX/);
  });
});

describe('report helpers', () => {
  it('puts an instant in its trading day (05:00 → 05:00 Pakistan) and its Pakistan hour', () => {
    // 00:59 PKT on the 26th → the 25th's trading day, hour 0.
    expect(tradingDayOf('2026-09-25T19:59:00.000Z')).toBe('2026-09-25');
    expect(pakistanHourOf('2026-09-25T19:59:00.000Z')).toBe(0);
    // 04:59:59 PKT on the 25th → still the 24th.
    expect(tradingDayOf('2026-09-24T23:59:59.999Z')).toBe('2026-09-24');
    expect(pakistanHourOf('2026-09-24T23:59:59.999Z')).toBe(4);
    // 05:00 PKT → a new trading day.
    expect(tradingDayOf('2026-09-25T00:00:00.000Z')).toBe('2026-09-25');
    expect(pakistanHourOf('2026-09-25T00:00:00.000Z')).toBe(5);
    // 8:30 pm PKT.
    expect(pakistanHourOf('2026-09-25T15:30:00.000Z')).toBe(20);
  });

  it('names order types the way the owner does', () => {
    expect(channelOf('takeaway', 'pos')).toBe('takeaway');
    expect(channelOf('delivery', 'pos')).toBe('delivery');
    expect(channelOf('foodpanda', 'pos')).toBe('foodpanda');
    expect(channelOf('takeaway', 'web')).toBe('web_pickup');
    expect(channelOf('delivery', 'web')).toBe('web_delivery');
    expect(channelOf('dine_in', 'pos')).toBe('dine_in');
    expect(channelOf('online', 'pos')).toBe('online');
  });

  it('groups payment methods the way the owner counts money', () => {
    expect(['cash', 'card', 'foodpanda', 'easypaisa', 'jazzcash', 'bank_transfer'].map(paymentGroup)).toEqual([
      'cash',
      'card',
      'foodpanda',
      'transfer',
      'transfer',
      'transfer',
    ]);
  });

  it('finds a refund reason in the payment reference, else on the order', () => {
    expect(refundReason('partial-refund: cold pizza', 'x')).toBe('cold pizza');
    expect(refundReason('refund-rest: changed mind', null)).toBe('changed mind');
    expect(refundReason('refund-of:0190abc', 'Wrong order')).toBe('Wrong order');
    expect(refundReason(null, '  ')).toBe('No reason given');
    expect(refundReason('partial-refund:   ', 'On the order')).toBe('On the order');
  });

  it('prices ingredients exactly from the pack, rounding once', () => {
    // 6,000 g for Rs 2,250 → 37.5 paisa a gram; 3 g = 112.5 → 113 (not 3 × 38 = 114).
    expect(ingredientCostCents(3, { costPerUnitCents: 38, packSize: 6000, packPriceCents: 225000 })).toBe(113);
    expect(ingredientCostCents(3, { costPerUnitCents: 38, packSize: null, packPriceCents: null })).toBe(114);
    expect(ingredientCostCents(0, { costPerUnitCents: 38, packSize: null, packPriceCents: null })).toBe(0);
    expect(ingredientCostCents(-2, { costPerUnitCents: 100, packSize: null, packPriceCents: null })).toBe(-200);
  });

  it('rolls categories up from the item lines', () => {
    const items: ReportItemLine[] = [
      { key: 'a', name: 'A', categoryId: 'c1', categoryName: 'Pizza', quantity: 2, salesCents: 2000 },
      { key: 'b', name: 'B', categoryId: 'c2', categoryName: 'Drinks', quantity: 5, salesCents: 500 },
      { key: 'c', name: 'C', categoryId: 'c1', categoryName: 'Pizza', quantity: 1, salesCents: 1500 },
      { key: 'd', name: 'D', categoryId: null, categoryName: 'No category', quantity: 1, salesCents: 700 },
    ];
    expect(rollUpCategories(items)).toEqual([
      { categoryId: 'c1', name: 'Pizza', quantity: 3, salesCents: 3500 },
      { categoryId: null, name: 'No category', quantity: 1, salesCents: 700 },
      { categoryId: 'c2', name: 'Drinks', quantity: 5, salesCents: 500 },
    ]);
  });

  it('rolls discounts up by reason (ignoring case) and by person, capping the list', () => {
    const line = (amount: number, reason: string, givenBy: string, approvedBy: string | null = null): ReportDiscountLine => ({
      orderId: `o${amount}`,
      orderNumber: 'n',
      createdAt: T0,
      amountCents: amount,
      entered: '10%',
      reason,
      givenBy,
      approvedBy,
    });
    const s = summarizeDiscounts([line(100, 'Staff', 'Ali'), line(300, 'staff ', 'Sara', 'Owner'), line(50, 'Friend', 'Ali')], 2);
    expect(s.totalCount).toBe(3);
    expect(s.totalCents).toBe(450);
    expect(s.byReason).toEqual([
      { reason: 'Staff', count: 2, amountCents: 400 },
      { reason: 'Friend', count: 1, amountCents: 50 },
    ]);
    expect(s.byPerson).toEqual([
      { name: 'Sara', count: 1, amountCents: 300, approvedCount: 1 },
      { name: 'Ali', count: 2, amountCents: 150, approvedCount: 0 },
    ]);
    expect(s.recent).toHaveLength(2);
  });
});
