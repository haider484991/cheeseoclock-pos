/**
 * Reports bench (costing spec Phase 2 "Bench"; Phase 3 moves it into the
 * worker's budgets). OPT-IN — it builds a year of orders and takes a while:
 *
 *   BENCH_REPORTS=1 pnpm --filter @cheeseoclock/pos exec vitest run electron/services/bench-reports.db.test.ts
 *
 * A year at ~110 orders a day (≈40,000 orders, ≈300,000 stock rows) is
 * cloned from a few dozen orders rung, sent and costed through the real
 * repositories, then:
 *   - food cost for the year when every sale kept its cost (the steady
 *     state: spec budget ≤ 200 ms on a dev laptop);
 *   - the same year when NO sale kept a cost (the first months after the
 *     upgrade: every order estimated from its stock rows);
 *   - the same for 31 days (the longest period that refreshes by itself,
 *     and the longest preset);
 *   - decrementForOrder (stock + cost snapshot) per order, with that ledger
 *     behind it (spec budget ≤ 10 ms per order on the shop-PC profile), and
 *     its repeat calls (tender, serve, hand-over).
 * Figures are printed with each budget's verdict; only the send-path budget
 * is asserted (it is met). node:sqlite in memory, so a file-backed
 * better-sqlite3 on the shop PC is slower: re-run there (or 4× CPU-throttled)
 * before trusting a margin.
 *
 * Measured 2026-09-27 on the dev laptop (v0.7.9 + Phase 2):
 *   year, every sale costed ........ ~920 ms  — MISSES the 200 ms budget
 *   year, every order estimated .... ~2.2 s   (the first months after upgrading)
 *   31 days, costed / estimated .... ~80 ms / ~180 ms
 *   decrementForOrder .............. ~4.7 ms per order; repeat call ~0.02 ms
 * The year budget can't be met on the main thread in Phase 2's design: just
 * joining a year's cost rows to its counted orders is ~130 ms here, its lines
 * ~80 ms. Periods over 31 days refresh only on a tap (dateRange.ts
 * autoRefreshes); Phase 3 moves Reports into a worker (a year tab ≤ 2 s
 * there, no main-process IPC over 50 ms), and Contingency R (daily rollups)
 * follows only if that misses on the shop PC.
 *
 * EVERY PRICE IS MADE UP (costing spec D11).
 */
import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../db/connection.js';
import { CASHIER, DatabaseSync, MANAGER, openCostingShop, openMigrated, type Line } from '../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const bench = describe.skipIf(!DatabaseSync || !process.env['BENCH_REPORTS']);

const ORDERS_PER_DAY = 110;
const DAYS = 365;
/** The trading day the year ends on (exclusive). */
const YEAR_END = Date.parse('2026-09-01T00:00:00.000Z');
const YEAR = { sinceIso: new Date(YEAR_END - DAYS * 86_400_000).toISOString(), untilIso: new Date(YEAR_END).toISOString() };
const MONTH = { sinceIso: new Date(YEAR_END - 31 * 86_400_000).toISOString(), untilIso: YEAR.untilIso };

/** The kinds of order the shop rings, roughly as often as it rings them. */
const TEMPLATES: Array<{ lines: Line[]; discount?: boolean }> = [
  { lines: [['fajitaM', 1]] },
  { lines: [['fajitaM', 2, ['extraCheese']], ['cola', 2]] },
  { lines: [['fajitaM', 1, ['noOnion', 'extraOnion']], ['delivery', 1]] },
  { lines: [['deal', 1, ['d1Fajita', 'd2Veggie', 'sideRanch']], ['cola', 2]] },
  { lines: [['deal', 1, ['d1Fajita', 'd2Fajita', 'dealNoOnion']], ['delivery', 1]] },
  { lines: [['veggieL', 1, ['pickOnion', 'pickPepper', 'pickOlive', 'pickMushroom', 'pickCorn', 'dipChili']]] },
  { lines: [['veggieL', 1, ['pickOnion', 'pickPepper', 'pickOlive', 'pickMushroom', 'pickCorn', 'dipRanch']], ['bakedWings', 1]] },
  { lines: [['crispyWings', 2], ['cola', 1]] },
  { lines: [['bakedWings', 1], ['crispyWings', 1]] },
  { lines: [['fajitaM', 1], ['veggieL', 1, ['pickOnion', 'pickPepper', 'pickOlive', 'pickMushroom', 'pickCorn', 'dipChili']], ['delivery', 1]] },
  { lines: [['fajitaM', 3, ['extraCheese']], ['cola', 3]], discount: true },
  { lines: [['deal', 1, ['d1Veggie', 'd2Veggie', 'sideRanch']]], discount: true },
];

/** Every column of a table, with some replaced by an expression over the source row `s` and the copy number `k.n`. */
function cloneSql(db: AppDatabase, table: string, from: string, replace: Record<string, string>): string {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  return `INSERT INTO ${table} (${cols.join(', ')})
          SELECT ${cols.map((c) => replace[c] ?? `s.${c}`).join(', ')} FROM ${from}`;
}

/** A shop with a year of paid orders, each sent (stock taken, cost kept) through the repositories. */
async function yearShop() {
  const db = openMigrated();
  const s = await openCostingShop(db);
  const repos = {
    ...(await import('../db/repositories/order-repo.js')),
    ...(await import('../db/repositories/shift-repo.js')),
    ...(await import('../db/repositories/stock-movement-repo.js')),
  };
  repos.openShift(db, { openingCashCents: 0 }, MANAGER);
  const templateIds: string[] = [];
  for (const t of TEMPLATES) {
    const o = s.ring(t.lines);
    if (t.discount) repos.applyDiscount(db, { orderId: o, discountType: 'percent', value: 10, reason: 'Bench' }, CASHIER);
    repos.sendOrderToKitchen(db, o, CASHIER);
    s.markPaid(o, new Date(YEAR_END - 86_400_000 + 12 * 3_600_000));
    templateIds.push(o);
  }

  const copies = Math.ceil((ORDERS_PER_DAY * DAYS) / TEMPLATES.length);
  const t0 = performance.now();
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`CREATE TEMP TABLE k (n INTEGER PRIMARY KEY)`);
  db.exec(`WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < ${copies}) INSERT INTO k SELECT n FROM c`);
  db.exec(`CREATE TEMP TABLE tpl (id TEXT PRIMARY KEY)`);
  const add = db.prepare(`INSERT INTO tpl (id) VALUES (?)`);
  for (const id of templateIds) add.run(id);
  /** Copy k lands k days back, wrapping over the year (so every day has ~110 orders). */
  const shift = (col: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', s.${col}, '-' || (k.n % ${DAYS}) || ' days')`;
  const nid = (col: string) => `s.${col} || '~' || k.n`;
  db.exec(
    cloneSql(db, 'orders', `orders s JOIN tpl ON tpl.id = s.id CROSS JOIN k`, {
      id: nid('id'),
      order_number: nid('order_number'),
      created_at: shift('created_at'),
      paid_at: shift('paid_at'),
    }),
  );
  db.exec(
    cloneSql(db, 'order_items', `order_items s JOIN tpl ON tpl.id = s.order_id CROSS JOIN k`, {
      id: nid('id'),
      order_id: nid('order_id'),
      created_at: shift('created_at'),
    }),
  );
  db.exec(
    cloneSql(db, 'order_item_modifiers', `order_item_modifiers s JOIN order_items oi ON oi.id = s.order_item_id JOIN tpl ON tpl.id = oi.order_id CROSS JOIN k`, {
      id: nid('id'),
      order_item_id: nid('order_item_id'),
    }),
  );
  db.exec(
    cloneSql(db, 'order_discounts', `order_discounts s JOIN tpl ON tpl.id = s.order_id CROSS JOIN k`, {
      id: nid('id'),
      order_id: nid('order_id'),
    }),
  );
  db.exec(
    cloneSql(db, 'order_item_costs', `order_item_costs s JOIN tpl ON tpl.id = s.order_id CROSS JOIN k`, {
      id: nid('id'),
      order_id: nid('order_id'),
      order_item_id: nid('order_item_id'),
    }),
  );
  db.exec(
    cloneSql(db, 'stock_movements', `stock_movements s JOIN tpl ON tpl.id = s.ref_order_id CROSS JOIN k`, {
      id: nid('id'),
      ref_order_id: nid('ref_order_id'),
      occurred_at: shift('occurred_at'),
    }),
  );
  db.exec(`DELETE FROM orders WHERE id IN (SELECT id FROM tpl)`); // the templates themselves are "today"
  db.exec('PRAGMA foreign_keys = ON');
  const built = performance.now() - t0;
  const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
  const size = {
    orders: count(`SELECT COUNT(*) AS n FROM orders`),
    lines: count(`SELECT COUNT(*) AS n FROM order_items`),
    costRows: count(`SELECT COUNT(*) AS n FROM order_item_costs`),
    stockRows: count(`SELECT COUNT(*) AS n FROM stock_movements`),
  };
  return { db, s, repos, built, size };
}

function time<T>(runs: number, fn: () => T): { ms: number; out: T } {
  let out!: T;
  fn(); // warm the statement cache
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) out = fn();
  return { ms: (performance.now() - t0) / runs, out };
}

bench('Reports bench: a year of orders (opt-in)', () => {
  it('food cost for a year and for 31 days, and the send path, against a year of ledger', async () => {
    const { db, s, repos, built, size } = await yearShop();
    const { getFoodCost } = await import('./business-report.js');
    const lines: string[] = [];
    const verdict = (ms: number, budget: number) => (ms <= budget ? `ok (≤ ${budget} ms)` : `MISSES the ${budget} ms budget`);
    lines.push(`built ${size.orders} orders, ${size.lines} lines, ${size.costRows} cost rows, ${size.stockRows} stock rows in ${built.toFixed(0)} ms`);

    // 1. Steady state: every sale kept its cost.
    const kept = time(5, () => getFoodCost(db, YEAR));
    const keptMonth = time(5, () => getFoodCost(db, MONTH));
    lines.push(`year food cost, every sale costed: ${kept.ms.toFixed(1)} ms — ${verdict(kept.ms, 200)}`);
    lines.push(`31 days, every sale costed: ${keptMonth.ms.toFixed(1)} ms`);
    expect(kept.out.estimatedOrders).toBe(0);
    expect(kept.out.foodSalesCents).toBeGreaterThan(keptMonth.out.foodSalesCents);

    // 2. Decrement + snapshot per order, with the year's ledger behind it.
    const orders: string[] = [];
    for (let i = 0; i < 200; i++) orders.push(s.ring(TEMPLATES[i % TEMPLATES.length]!.lines));
    const t0 = performance.now();
    for (const o of orders) repos.decrementForOrder(db, o, CASHIER);
    const perOrder = (performance.now() - t0) / orders.length;
    // …and the repeat calls (tender, serve, hand-over) on those orders.
    const t1 = performance.now();
    for (const o of orders) repos.decrementForOrder(db, o, CASHIER);
    const perRepeat = (performance.now() - t1) / orders.length;
    lines.push(`decrementForOrder: ${perOrder.toFixed(2)} ms per order — ${verdict(perOrder, 10)}; repeat call ${perRepeat.toFixed(2)} ms`);

    // 3. The first months after the upgrade: no sale kept a cost; every order is estimated from its stock rows.
    db.exec(`DELETE FROM order_item_costs`);
    db.exec(`UPDATE stock_movements SET value_cents = NULL, unit_cost_mc = NULL, cost_basis = NULL`);
    const est = time(3, () => getFoodCost(db, YEAR));
    const estMonth = time(3, () => getFoodCost(db, MONTH));
    lines.push(`year food cost, every order estimated (before costing): ${est.ms.toFixed(1)} ms — ${verdict(est.ms, 200)}`);
    lines.push(`31 days, every order estimated: ${estMonth.ms.toFixed(1)} ms`);
    expect(est.out.estimatedOrders).toBeGreaterThan(0);

    // eslint-disable-next-line no-console
    console.log(['', 'Reports bench (node:sqlite, in memory):', ...lines.map((l) => `  ${l}`)].join('\n'));
    // The send path is the one budget a cashier feels on every order.
    expect(perOrder).toBeLessThanOrEqual(10);
  });
});
