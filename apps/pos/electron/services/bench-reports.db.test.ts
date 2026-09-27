/**
 * Reports bench (costing spec Phase 2 "Bench", and Phase 3's worker
 * budgets). Kept here as an opt-in test rather than a script in
 * apps/pos/scripts: it needs the repositories and node:sqlite as the other
 * *.db.test.ts files load them. OPT-IN — it builds a year of orders and
 * takes a while:
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
 * Phase 3 (the second bench below; `-t "Phase 3"` runs it alone): each tab
 * for a year on this thread (what the till would stall for, and a month's
 * cost for the main-thread fallback), then the REAL worker — built exactly
 * as for the till (electron.vite.config.ts buildAnalyticsWorker), started
 * through the real client (worker-client.ts), on a file copy of the year
 * opened as the till opens it — working out each year tab while this thread
 * keeps being the till: the Live Orders board read every 10 ms, an order
 * rung and sent every 250 ms. node:sqlite in both threads (the worker's
 * bench driver; the till's worker uses better-sqlite3).
 *
 * Measured 2026-09-27 on the dev laptop (Phase 3; 40,152 orders, 304,577 stock rows):
 *   year on the main thread ........ overview ~290 ms, when ~175, menu ~145,
 *                                    channels ~175, food cost & stock ~965,
 *                                    team ~255 (the counter would wait that long)
 *   31 days on the main thread ..... 12–22 ms a tab, food cost & stock ~87 ms
 *   year in the worker ............. 170–340 ms a tab, food cost & stock ~1.27 s
 *                                    (≤ 2 s: ok); all six at once ~2.5 s
 *   meanwhile on the main thread ... slowest till call ~7 ms, event loop late
 *                                    ≤ ~29 ms (≤ 12 ms with no report running;
 *                                    Windows timers tick every ~15.6 ms)
 *                                    — no call near the 50 ms budget
 *   worker start ................... ~55 ms to "ready"; bundle build ~1 s
 * Re-run on the shop's till PC (or 4× CPU-throttled) before trusting the
 * margins; a miss there is what triggers Contingency R.
 *
 * Costing Phase 4 adds the case this shop meets first: the same year with NO
 * sale's cost kept (snapshots began at v0.7.10, so This year / Last 12
 * months are mostly estimated for a year) and a price history of a change a
 * week per ingredient, every take priced at the price of its day. Measured
 * 2026-09-27 on the dev laptop (974 history rows):
 *   food cost & stock, year, estimated ... main thread ~1.6 s, worker ~1.8 s
 *                                          (≤ 2 s: ok, with little margin;
 *                                          ~2.2–2.4 s before each row's price
 *                                          and value were looked up once and
 *                                          its row read without a spread)
 *   getFoodCost, year, estimated ......... ~1.55 s (Phase 2 measured ~2.2 s)
 * The shop PC is slower: a miss there on this case is the Contingency R trigger.
 *
 * Costing Phase 5 adds a year of stock bought (8 bills a day, 2,920 delivery
 * rows) and Purchases on the Food cost & stock tab. Measured 2026-09-27 on
 * the dev laptop:
 *   purchases, year ....................... ~11 ms (by supplier and by ingredient)
 *   food cost & stock, year, worker ....... ~1.30 s costed, ~1.82 s estimated
 *                                          (≤ 2 s: ok; unchanged margin)
 *
 * Costing Phase 7 (`-t "Phase 7"`): the Dashboard "This week" card with a
 * full "Do this" list, the printed sheet, the trends and a year of When with
 * its heatmap. The card's spec budget is ≤ 300 ms on the SHOP-PC profile (the
 * till PC, or 4× CPU-throttled); unthrottled here, it is held to 300 ÷ 4 =
 * 75 ms (asserted). Measured 2026-09-27 on the dev laptop (40,152 orders,
 * 307,497 stock rows; a whole week so far, 840 orders):
 *   the card, with costs ................ worker ~24 ms (≤ 75 ms: ok), every
 *                                         order estimated ~39 ms; without
 *                                         costs ~1 ms. Its parts: 28 whole
 *                                         days' sales and picks ~42 ms (read
 *                                         once a trading day, and ahead of
 *                                         the first tap in the worker), the
 *                                         week's food cost ~20 ms, prices and
 *                                         recipes ~1 ms. The first ask of the
 *                                         day on the main thread (no worker)
 *                                         ~70 ms. It was ~80–100 ms before:
 *                                         the 28 days read on every tap, their
 *                                         picks in two walks, and the sheet's
 *                                         lines worked out for the card too.
 *   last week in full (the sheet) ....... worker ~46 ms
 *   trends .............................. worker ~58 ms; with each of the 12
 *                                         months' food cost ~1.1 s the first
 *                                         ask of the day, then ~150 ms (the
 *                                         months that are over kept for the
 *                                         day; only this month worked out)
 *   When for a year (heatmap, parts) .... worker ~205 ms
 *   every order estimated ............... trends with food cost ~1.6 s the
 *                                         first ask of the day, then ~190 ms
 *   meanwhile on the main thread ........ slowest till call ≤ ~23 ms, event
 *                                         loop late ≤ ~28 ms (no call near 50 ms)
 *   the card with a stock-take pair ..... (Phase 8: key items a week apart)
 *                                         worker ~61 ms the first ask after
 *                                         one is finished, the worker not
 *                                         told; ~25 ms once it is (the till
 *                                         tells it: asserted ≤ 75 ms)
 *
 * Costing Phase 8 (`-t "Phase 8"`): "used vs should have used" for 90
 * ingredients over a month between two full stock takes. The spec budget,
 * ≤ 200 ms in the worker, is on the SHOP-PC profile like the card's: held
 * to 200 ÷ 4 = 50 ms here, it is MISSED (worker ~113 ms here, ≈ 450 ms on
 * that profile) — printed, not asserted (only a 200 ms guard against it
 * getting slower); a miss confirmed on the shop's till PC is the
 * Contingency R trigger. The Dashboard card with a stock-take pair: ~8–25 ms
 * in the worker once it is told of a finished stock take (asserted ≤ 75 ms),
 * ~61–135 ms when it is not. Figures with the block below.
 *
 * EVERY PRICE IS MADE UP (costing spec D11).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../db/connection.js';
import { CASHIER, DatabaseSync, MANAGER, openCostingShop, openMigrated, type Ing, type Line } from '../db/costing-shop.fixture.js';

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

  // A year of stock bought (costing Phase 5): 8 bills a day, each one line of a made-up market run,
  // recorded through the repository once and cloned a day back each (below).
  const { recordPurchase } = await import('../db/repositories/procurement-repo.js');
  const BUYS: Array<[Ing, number, number]> = [
    ['cheese', 2_000, 250_000],
    ['chicken', 5_000, 460_000],
    ['onion', 5_000, 76_000],
    ['tomato', 10_000, 124_000],
    ['dough', 10_000, 92_000],
    ['cup', 100, 520],
    ['box', 50, 205_000],
    ['pepper', 2_000, 61_000],
  ];
  const purchaseIds = BUYS.map(
    ([k, qty, billCents]) => recordPurchase(db, { lines: [{ ingredientId: s.ing[k], qty, billCents, usePrice: false }] }, MANAGER).purchase.id,
  );
  db.prepare(`UPDATE stock_movements SET occurred_at = ? WHERE reason = 'delivery' AND ref_purchase_order_id IN (SELECT value FROM json_each(?))`).run(
    new Date(YEAR_END - 86_400_000 + 9 * 3_600_000).toISOString(),
    JSON.stringify(purchaseIds),
  );

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
  db.exec(`CREATE TEMP TABLE tplp (id TEXT PRIMARY KEY)`);
  const addPurchase = db.prepare(`INSERT INTO tplp (id) VALUES (?)`);
  for (const id of purchaseIds) addPurchase.run(id);
  db.exec(
    cloneSql(db, 'stock_movements', `stock_movements s JOIN tplp ON tplp.id = s.ref_purchase_order_id CROSS JOIN k WHERE s.reason = 'delivery' AND k.n < ${DAYS}`, {
      id: nid('id'),
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
    deliveries: count(`SELECT COUNT(*) AS n FROM stock_movements WHERE reason = 'delivery'`),
  };
  return { db, s, repos, built, size };
}

const verdict = (ms: number, budget: number) => (ms <= budget ? `ok (≤ ${budget} ms)` : `MISSES the ${budget} ms budget`);

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
    lines.push(`built ${size.orders} orders, ${size.lines} lines, ${size.costRows} cost rows, ${size.stockRows} stock rows in ${built.toFixed(0)} ms`);

    // 1. Steady state: every sale kept its cost.
    const kept = time(5, () => getFoodCost(db, YEAR));
    const keptMonth = time(5, () => getFoodCost(db, MONTH));
    lines.push(`year food cost, every sale costed: ${kept.ms.toFixed(1)} ms — ${verdict(kept.ms, 200)}`);
    lines.push(`31 days, every sale costed: ${keptMonth.ms.toFixed(1)} ms`);
    // Purchases (costing Phase 5): a year of bills, by supplier and by ingredient.
    const { getPurchases } = await import('./business-report.js');
    const buys = time(5, () => getPurchases(db, YEAR));
    lines.push(`year purchases (${size.deliveries} delivery rows): ${buys.ms.toFixed(1)} ms`);
    expect(buys.out.byIngredient.length).toBe(8);
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

// ---------------------------------------------------------------------------
// Phase 3: the tabs, and the Reports worker thread
// ---------------------------------------------------------------------------

/**
 * A price history of one change a week for a year for every priced ingredient
 * (made-up prices wandering up to 4% over the price now), as a busy shop's
 * could be: what Reports' estimates look each take's price up in.
 */
function weeklyPriceHistory(db: AppDatabase, sinceIso: string): void {
  db.prepare(
    `WITH RECURSIVE w(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM w WHERE n < 52)
     INSERT INTO ingredient_costs
       (id, ingredient_id, effective_at, unit, pack_size, pack_price_cents, price_kind, unit_cost_mc, source,
        created_at, updated_at, device_id)
     SELECT i.id || '~w' || w.n, i.id, strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || (w.n * 7) || ' days'), i.unit,
            COALESCE(i.pack_size, 1), COALESCE(i.pack_price_cents, i.cost_per_unit_cents) * (100 + w.n % 5) / 100,
            i.price_kind, 0, 'manual', 'bench', 'bench', 'bench'
       FROM ingredients i CROSS JOIN w
      WHERE i.deleted_at IS NULL AND i.price_kind <> 'unset'`,
  ).run(sinceIso);
}

/** A database file opened as the till opens it (WAL, busy timeout), behind better-sqlite3's shape. */
function openTillFile(file: string): AppDatabase & { close: () => void } {
  const raw = new DatabaseSync!(file) as unknown as {
    exec(sql: string): void;
    prepare(sql: string): unknown;
    close(): void;
  };
  // As the till opens it (db/connection.ts).
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA synchronous = NORMAL');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA busy_timeout = 5000');
  raw.exec('PRAGMA cache_size = -32000');
  raw.exec('PRAGMA temp_store = MEMORY');
  let depth = 0;
  return {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    close: () => raw.close(),
    transaction:
      <A extends unknown[], R>(fn: (...args: A) => R) =>
      (...args: A): R => {
        const sp = `sp_${depth}`;
        raw.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
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
  } as unknown as AppDatabase & { close: () => void };
}

/**
 * The till going on with its day on the main thread while a report runs:
 * every 10 ms the Live Orders board is read (orders:listActive), and every
 * 250 ms a cashier rings an order and sends it to the kitchen (stock taken,
 * cost kept). Records the slowest of each, and how late the event loop was
 * beyond that work (what the report cost the main thread: receiving its
 * answer, garbage collection).
 */
function startTill(till: AppDatabase, work: { board: () => unknown; ringAndSend: () => number }) {
  let maxLag = 0;
  let maxBoard = 0;
  let maxSend = 0;
  let boards = 0;
  let sends = 0;
  let expected = performance.now() + 10;
  let lastSend = performance.now();
  const t = setInterval(() => {
    const now = performance.now();
    // Late by what else held the main thread (not by this tick's own work, timed below).
    maxLag = Math.max(maxLag, now - expected);
    const b0 = performance.now();
    work.board();
    maxBoard = Math.max(maxBoard, performance.now() - b0);
    boards += 1;
    if (now - lastSend >= 250) {
      lastSend = now;
      maxSend = Math.max(maxSend, work.ringAndSend());
      sends += 1;
    }
    expected = performance.now() + 10;
  }, 10);
  void till;
  return {
    stop: () => {
      clearInterval(t);
      return { maxLag, maxBoard, maxSend, boards, sends };
    },
  };
}

bench('Reports bench, Phase 3: a year of each tab, in the worker thread (opt-in)', () => {
  it('each year tab in the worker while the till rings orders; and the same on the main thread for contrast', async () => {
    const { REPORT_TABS } = await import('@cheeseoclock/shared-types');
    const { db, s, repos, size } = await yearShop();
    const { buildReportTab } = await import('./analytics/report-tabs.js');
    const { AnalyticsWorkerClient } = await import('./analytics/worker-client.js');
    const { WORKER_FILE, WORKER_TAG } = await import('./analytics/worker-protocol.js');
    const { buildAnalyticsWorker } = await import('../../electron.vite.config');
    const lines: string[] = [];
    lines.push(`${size.orders} orders, ${size.lines} lines, ${size.costRows} cost rows, ${size.stockRows} stock rows`);
    const YEAR_REQ = { ...YEAR, compareSinceIso: new Date(YEAR_END - 2 * DAYS * 86_400_000).toISOString(), compareUntilIso: YEAR.sinceIso };

    // 1. Each tab for a year on this thread: what the main process would stall for (and the fallback's cost for a month).
    const onMain: Record<string, number> = {};
    for (const tab of REPORT_TABS) {
      onMain[tab] = time(3, () => buildReportTab(db, tab, YEAR_REQ)).ms;
      const month = time(3, () => buildReportTab(db, tab, { ...MONTH })).ms;
      lines.push(`main thread, ${tab}: year ${onMain[tab]!.toFixed(0)} ms (the till would wait this long); 31 days ${month.toFixed(0)} ms`);
    }

    // 2. The real worker, built as for the till, on a file copy of this database.
    const dir = mkdtempSync(join(tmpdir(), 'coc-bench-'));
    const file = join(dir, 'till.sqlite');
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const till = openTillFile(file);
    const tBuild = performance.now();
    await buildAnalyticsWorker({ outDir: dir });
    lines.push(`worker bundle built in ${(performance.now() - tBuild).toFixed(0)} ms`);
    const client = new AnalyticsWorkerClient({
      spawn: () => new Worker(join(dir, WORKER_FILE), { workerData: { tag: WORKER_TAG, dbPath: file, driver: 'node:sqlite' } }),
    });
    const tStart = performance.now();
    client.start();
    expect(await client.settled()).toBe('ready');
    lines.push(`worker ready in ${(performance.now() - tStart).toFixed(0)} ms`);
    await client.run('overview', YEAR_REQ); // warm its statement cache, as the first report of the day does

    const item = s.item;
    const choice = s.choice;
    const work = {
      board: () => repos.listActiveOrders(till, {}),
      /** Three taps, three IPC calls (orders:create, orders:addItem, orders:sendToKitchen): the slowest one. */
      ringAndSend: () => {
        let slowest = 0;
        const timed = <T>(fn: () => T): T => {
          const t0 = performance.now();
          const out = fn();
          slowest = Math.max(slowest, performance.now() - t0);
          return out;
        };
        const o = timed(() => repos.createOrder(till, { mode: 'takeaway' }, CASHIER));
        timed(() => repos.addOrderItem(till, { orderId: o.id, menuItemId: item.fajitaM, quantity: 1, modifierIds: [choice.extraCheese], notes: null }, CASHIER));
        timed(() => repos.sendOrderToKitchen(till, o.id, CASHIER));
        return slowest;
      },
    };

    // For scale: the same till work with no report running.
    const idle = startTill(till, work);
    await new Promise((r) => setTimeout(r, 1_000));
    const quiet = idle.stop();
    lines.push(`no report running, 1 s: event loop late by at most ${quiet.maxLag.toFixed(1)} ms, slowest till call ${Math.max(quiet.maxBoard, quiet.maxSend).toFixed(1)} ms`);

    // 3. While each year tab runs in the worker, the till goes on here.
    let worstLag = 0;
    let worstCall = 0;
    let worstTab = 0;
    for (const tab of REPORT_TABS) {
      const probe = startTill(till, work);
      const t0 = performance.now();
      await client.run(tab, YEAR_REQ);
      const ms = performance.now() - t0;
      const p = probe.stop();
      worstLag = Math.max(worstLag, p.maxLag);
      worstCall = Math.max(worstCall, p.maxBoard, p.maxSend);
      worstTab = Math.max(worstTab, ms);
      lines.push(
        `worker, ${tab}: year in ${ms.toFixed(0)} ms — ${verdict(ms, 2000)}; meanwhile ${p.boards} board reads (slowest ${p.maxBoard.toFixed(1)} ms), ` +
          `${p.sends} orders rung and sent (slowest call ${p.maxSend.toFixed(1)} ms), event loop late by at most ${p.maxLag.toFixed(1)} ms`,
      );
    }
    // "Print everything": all six asked at once.
    const probe = startTill(till, work);
    const tAll = performance.now();
    await Promise.all(REPORT_TABS.map((tab) => client.run(tab, YEAR_REQ)));
    const all = performance.now() - tAll;
    const p = probe.stop();
    worstLag = Math.max(worstLag, p.maxLag);
    worstCall = Math.max(worstCall, p.maxBoard, p.maxSend);
    lines.push(`worker, all six tabs for a year ("Print everything"): ${all.toFixed(0)} ms; event loop late by at most ${p.maxLag.toFixed(1)} ms, slowest till call ${Math.max(p.maxBoard, p.maxSend).toFixed(1)} ms`);
    lines.push(`budgets: a year tab ≤ 2 s — worst ${worstTab.toFixed(0)} ms, ${verdict(worstTab, 2000)}; no main-process call over 50 ms while it runs — worst ${Math.max(worstLag, worstCall).toFixed(1)} ms, ${verdict(Math.max(worstLag, worstCall), 50)}`);
    await client.stop();

    // 4. Costing Phase 4: the same year when NO sale kept a cost — this shop's This year / Last 12
    //    months until the snapshots (v0.7.10) cover a year — with a price history of a change a week
    //    for every priced ingredient: Food cost & stock estimates every order at the price of its day.
    db.exec(`DELETE FROM order_item_costs`);
    db.exec(`UPDATE stock_movements SET value_cents = NULL, unit_cost_mc = NULL, cost_basis = NULL`);
    weeklyPriceHistory(db, YEAR.sinceIso);
    const historyRows = Number((db.prepare(`SELECT COUNT(*) AS n FROM ingredient_costs`).get() as { n: number }).n);
    const estOnMain = time(3, () => buildReportTab(db, 'foodStock', YEAR_REQ));
    lines.push(`every order estimated, ${historyRows} price history rows — main thread, foodStock: year ${estOnMain.ms.toFixed(0)} ms`);
    const estFile = join(dir, 'till-estimated.sqlite');
    db.exec(`VACUUM INTO '${estFile.replace(/'/g, "''")}'`);
    const estClient = new AnalyticsWorkerClient({
      spawn: () => new Worker(join(dir, WORKER_FILE), { workerData: { tag: WORKER_TAG, dbPath: estFile, driver: 'node:sqlite' } }),
    });
    estClient.start();
    expect(await estClient.settled()).toBe('ready');
    await estClient.run('overview', YEAR_REQ);
    const estProbe = startTill(till, work);
    const tEst = performance.now();
    await estClient.run('foodStock', YEAR_REQ);
    const estMs = performance.now() - tEst;
    const ep = estProbe.stop();
    lines.push(
      `every order estimated — worker, foodStock: year in ${estMs.toFixed(0)} ms — ${verdict(estMs, 2000)} ` +
        `(a miss on the shop PC is the spec's Contingency R trigger); slowest till call ${Math.max(ep.maxBoard, ep.maxSend).toFixed(1)} ms, event loop late by at most ${ep.maxLag.toFixed(1)} ms`,
    );
    await estClient.stop();
    till.close();
    rmSync(dir, { recursive: true, force: true });
    // eslint-disable-next-line no-console
    console.log(['', 'Reports bench, Phase 3 (node:sqlite; worker = the built analytics-worker.cjs):', ...lines.map((l) => `  ${l}`)].join('\n'));
    expect(worstTab).toBeLessThan(30_000);
  });
});

// ---------------------------------------------------------------------------
// Phase 7: the owner's week
// ---------------------------------------------------------------------------

/**
 * The card's budget is ≤ 300 ms on the SHOP-PC profile (costing spec 6.3: the
 * shop's till PC, or a 4× CPU-throttled one). This bench runs unthrottled on
 * the dev laptop, so it holds the card to a quarter of that.
 */
const CARD_BUDGET_SHOP_PC_MS = 300;
const CARD_BUDGET_HERE_MS = CARD_BUDGET_SHOP_PC_MS / 4;

/**
 * Costing Phase 7 on the same year: the Dashboard "This week" card (spec
 * budget ≤ 300 ms on the shop-PC profile) with food cost, waste and a full
 * "Do this" list (dishes over target, missing costs, a price alert, a key
 * ingredient running low) and where its time goes; the printed sheet;
 * Overview's trends (8 weeks, 12 months, with each month's food cost the
 * first time in a day and once kept); a year of When with its heatmap — on
 * this thread, then in the real worker while the till keeps ringing; then the
 * trends and the card again on the year with NO sale's cost kept (this shop's
 * first year after costing began: every order estimated).
 */
bench('Reports bench, Phase 7: the owner\'s week (opt-in)', () => {
  it('the Dashboard card, the trends and a year of When, on this thread and in the worker', async () => {
    const { db, s, repos, size } = await yearShop();
    const { saveCostingTargets, saveCostAlertSettings } = await import('./costing-settings.js');
    const { setTypedPrice } = await import('../db/repositories/ingredient-cost-repo.js');
    const { buildAnalytics } = await import('./analytics/report-tabs.js');
    const { buildOwnerWeek, DO_THIS_SOURCES } = await import('./analytics/owner-week.js');
    const { loadCostingContextWith, loadCostingSales, getCostAlerts } = await import('./costing-service.js');
    const { getFoodCost } = await import('./business-report.js');
    const { ownerWeekWindows } = await import('@cheeseoclock/pos-domain');
    const { AnalyticsWorkerClient } = await import('./analytics/worker-client.js');
    const { WORKER_FILE, WORKER_TAG } = await import('./analytics/worker-protocol.js');
    const { buildAnalyticsWorker } = await import('../../electron.vite.config');
    // What a shop in use has: confirmed targets (pizzas and deals over them), key ingredients (one running
    // low) and a price alert not seen yet. Made-up figures.
    saveCostingTargets(
      db,
      {
        defaultBps: 3000,
        amberBps: 500,
        perCategory: { [s.cat.pizza]: { bps: 800, confirmed: true }, [s.cat.deals]: { bps: 800, confirmed: true } },
        nonFoodCategoryIds: [s.cat.fees],
        priceStepCents: 1000,
      },
      MANAGER,
    );
    // The key items live on the ingredients since Phase 8 (one list): saved with the thresholds.
    saveCostAlertSettings(db, { jumpBps: 1_000, impactWeekCents: 100_000, keyIngredientIds: [s.ing.cheese, s.ing.chicken] }, MANAGER);
    s.r.updateIngredient(db, { id: s.ing.chicken, lowThreshold: 100_000_000 }, MANAGER);
    setTypedPrice(db, { ingredientId: s.ing.cheese, typed: { per: 'thousand', priceCents: 150_000 } }, MANAGER);
    // Sunday night, the last trading day of the year's data: a whole week so far.
    const NOW = new Date(YEAR_END - 2 * 86_400_000 + 20 * 3_600_000);
    const LATER = new Date(NOW.getTime() + 60_000); // a minute on, the same trading day: what the day has kept
    const lines: string[] = [`${size.orders} orders, ${size.stockRows} stock rows`];

    // Where the card's time goes (its parts, each alone).
    const week = ownerWeekWindows('this', NOW.getTime()).current;
    const range = { sinceIso: new Date(week.sinceMs).toISOString(), untilIso: new Date(week.untilMs).toISOString() };
    const dayStart = Math.floor(NOW.getTime() / 86_400_000) * 86_400_000;
    const wholeDays = { sinceIso: new Date(dayStart - 28 * 86_400_000).toISOString(), untilIso: new Date(dayStart - 1).toISOString() };
    const daySales = time(5, () => loadCostingSales(db, wholeDays.sinceIso, wholeDays.untilIso));
    const parts = {
      sales: daySales.ms,
      costing: time(5, () => loadCostingContextWith(db, daySales.out)).ms,
      foodCost: time(5, () => getFoodCost(db, range, NOW)).ms,
      alerts: time(5, () => getCostAlerts(db)).ms,
    };
    lines.push(
      `main thread, the card's parts: 28 whole days' sales and picks ${parts.sales.toFixed(0)} ms (read once a trading day, and ahead of time in the worker), prices/recipes/menu/targets ${parts.costing.toFixed(0)} ms, the week's food cost and waste ${parts.foodCost.toFixed(0)} ms, price alerts ${parts.alerts.toFixed(0)} ms (${DO_THIS_SOURCES.length} "Do this" sources)`,
    );

    const tFirst = performance.now();
    buildAnalytics(db, 'ownerWeek', { week: 'this', withCosts: true }, NOW); // the first ask of the day on this thread: the day's sales read too
    const firstCardMs = performance.now() - tFirst;
    const card = time(5, () => buildAnalytics(db, 'ownerWeek', { week: 'this', withCosts: true }, NOW));
    const cardOut = card.out as { doThis: Array<{ kind: string }>; current: { orderCount: number }; sheet: unknown };
    const lean = time(5, () => buildAnalytics(db, 'ownerWeek', { week: 'this', withCosts: false }, NOW));
    const sheet = time(3, () => buildOwnerWeek(db, { week: 'last', withCosts: true, sheet: true }, NOW));
    lines.push(
      `main thread, the card with costs: ${card.ms.toFixed(0)} ms — ${verdict(card.ms, CARD_BUDGET_HERE_MS)} for the shop PC's ${CARD_BUDGET_SHOP_PC_MS} ms (${cardOut.current.orderCount} orders this week; "Do this": ${cardOut.doThis.map((i) => i.kind).join(', ')})`,
    );
    lines.push(
      `main thread, the card's first ask of the day (no worker to read the day's sales ahead): ${firstCardMs.toFixed(0)} ms; without costs: ${lean.ms.toFixed(0)} ms; last week's printed sheet (with last week's food cost): ${sheet.ms.toFixed(0)} ms`,
    );
    expect(cardOut.sheet).toBeNull();
    expect(sheet.out.sheet?.previousCosts).not.toBeNull();

    const trends = time(3, () => buildAnalytics(db, 'trends', { withCosts: false }, NOW));
    const tCold = performance.now();
    buildAnalytics(db, 'trends', { withCosts: true }, NOW); // the first ask of the day: every month worked out
    const coldMs = performance.now() - tCold;
    const warm = time(3, () => buildAnalytics(db, 'trends', { withCosts: true }, LATER)); // the months that are over, kept
    const whenYear = time(3, () => buildAnalytics(db, 'when', YEAR, NOW));
    lines.push(
      `main thread, trends: ${trends.ms.toFixed(0)} ms; with 12 months of food cost: first ask of the day ${coldMs.toFixed(0)} ms, then ${warm.ms.toFixed(0)} ms (this month only); When for a year (heatmap, parts of the day): ${whenYear.ms.toFixed(0)} ms`,
    );
    expect(cardOut.doThis.length).toBeGreaterThanOrEqual(3);

    // The real worker, built as for the till, on a file copy of this database.
    const dir = mkdtempSync(join(tmpdir(), 'coc-bench7-'));
    const file = join(dir, 'till.sqlite');
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const till = openTillFile(file);
    await buildAnalyticsWorker({ outDir: dir });
    const workerOn = (dbPath: string) =>
      new AnalyticsWorkerClient({
        spawn: () => new Worker(join(dir, WORKER_FILE), { workerData: { tag: WORKER_TAG, dbPath, driver: 'node:sqlite' } }),
      });
    const client = workerOn(file);
    client.start();
    expect(await client.settled()).toBe('ready');
    const nowIso = NOW.toISOString();
    await client.run('overview', { ...YEAR }, nowIso); // warm its statement cache, as the first report of the day does
    const item = s.item;
    const choice = s.choice;
    const work = {
      board: () => repos.listActiveOrders(till, {}),
      ringAndSend: () => {
        const t0 = performance.now();
        const o = repos.createOrder(till, { mode: 'takeaway' }, CASHIER);
        repos.addOrderItem(till, { orderId: o.id, menuItemId: item.fajitaM, quantity: 1, modifierIds: [choice.extraCheese], notes: null }, CASHIER);
        repos.sendOrderToKitchen(till, o.id, CASHIER);
        return performance.now() - t0;
      },
    };
    const inWorker = async (label: string, run: () => Promise<unknown>, budget: number | null, runs = 3, warmFirst = true) => {
      if (warmFirst) await run(); // first time: its statements compiled
      const probe = startTill(till, work);
      const t0 = performance.now();
      for (let i = 0; i < runs; i += 1) await run();
      const ms = (performance.now() - t0) / runs;
      const p = probe.stop();
      lines.push(
        `worker, ${label}: ${ms.toFixed(0)} ms${budget ? ` — ${verdict(ms, budget)}` : ''}; meanwhile slowest till call ${Math.max(p.maxBoard, p.maxSend).toFixed(1)} ms, event loop late by at most ${p.maxLag.toFixed(1)} ms`,
      );
      return ms;
    };
    // Each ask differs a little (the clock), so the client never hands back an earlier answer.
    let tick = 0;
    const at = (d: Date) => new Date(d.getTime() + ++tick).toISOString();
    const cardMs = await inWorker(
      `the card with costs (budget here ${CARD_BUDGET_HERE_MS} ms = the shop PC's ${CARD_BUDGET_SHOP_PC_MS} ÷ 4)`,
      () => client.run('ownerWeek', { week: 'this', withCosts: true }, at(NOW)),
      CARD_BUDGET_HERE_MS,
      5,
    );
    await inWorker('the card without costs', () => client.run('ownerWeek', { week: 'this', withCosts: false }, at(NOW)), CARD_BUDGET_HERE_MS, 5);
    await inWorker('last week in full (the printed sheet)', () => client.run('ownerWeek', { week: 'last', withCosts: true, sheet: true }, at(NOW)), 2000, 3);
    await inWorker('trends', () => client.run('trends', { withCosts: false }, at(NOW)), 2000, 3);
    await inWorker('trends with 12 months of food cost, the first ask of the day', () => client.run('trends', { withCosts: true }, nowIso), 2000, 1, false);
    const warmTrendsMs = await inWorker('trends with 12 months of food cost, once the day has kept them', () => client.run('trends', { withCosts: true }, at(LATER)), 2000, 3);
    await inWorker('When for a year (heatmap, parts of the day, notes)', () => client.run('when', { ...YEAR }, at(NOW)), 2000, 3);

    // Phase 8 on the card: "Do this" also compares the latest two key-items stock takes. A key-items count a week
    // before NOW, then one just finished (half of each short: made up), written into the till's file.
    const { startStockCount, saveStockCountLines, finishStockCount } = await import('../db/repositories/stock-count-repo.js');
    const LINK = { on: false, stale: false, lastHeardAt: null };
    const keyTake = (ms: number, shortPct: number) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(ms));
      try {
        const c = startStockCount(till, { scope: 'key_items' }, MANAGER);
        const qty = (id: string) => Number((till.prepare(`SELECT current_qty AS q FROM ingredients WHERE id = ?`).get(id) as { q: number }).q);
        saveStockCountLines(
          till,
          { countId: c.id, lines: c.lines.map((l) => ({ ingredientId: l.ingredientId, countedQty: Math.max(0, Math.round(qty(l.ingredientId) * (1 - shortPct / 100))) })) },
          MANAGER,
        );
        return finishStockCount(till, c.id, MANAGER).count;
      } finally {
        vi.useRealTimers();
      }
    };
    keyTake(NOW.getTime() - 7 * 86_400_000 - 3_600_000, 0);
    keyTake(NOW.getTime() - 3_600_000, 50);
    // The first ask after a stock take is finished, the worker NOT told: the comparison is worked out inside the tap.
    const t0Card = performance.now();
    const firstAfter = (await client.run('ownerWeek', { week: 'this', withCosts: true }, at(NOW))) as { doThis: Array<{ kind: string }> };
    const firstAfterMs = performance.now() - t0Card;
    lines.push(
      `worker, the card's first ask after a stock take is finished, not warmed: ${firstAfterMs.toFixed(0)} ms — ${verdict(firstAfterMs, CARD_BUDGET_HERE_MS)} ("Do this": ${firstAfter.doThis.map((i) => i.kind).join(', ')})`,
    );
    // A recount of the key items later the same day: a new pair. This time the worker is told as it is finished
    // (inventory-handlers → worker-client warm) and has worked it out by the owner's next tap.
    keyTake(NOW.getTime() - 1_800_000, 50);
    client.warm(LINK, at(NOW));
    await client.run('trends', { withCosts: false }, at(NOW)); // queued behind the warm-up: the owner taps a moment later
    const t1Card = performance.now();
    const warmed = (await client.run('ownerWeek', { week: 'this', withCosts: true }, at(NOW))) as { doThis: Array<{ kind: string }> };
    const warmedMs = performance.now() - t1Card;
    lines.push(
      `worker, the card's next ask once the worker was told of the finished stock take: ${warmedMs.toFixed(0)} ms — ${verdict(warmedMs, CARD_BUDGET_HERE_MS)} ("Do this": ${warmed.doThis.map((i) => i.kind).join(', ')})`,
    );
    await client.stop();

    // The year with NO sale's cost kept (every order estimated, a price change a week): this shop's case
    // until the snapshots cover a year.
    db.exec(`DELETE FROM order_item_costs`);
    db.exec(`UPDATE stock_movements SET value_cents = NULL, unit_cost_mc = NULL, cost_basis = NULL`);
    weeklyPriceHistory(db, YEAR.sinceIso);
    const estCard = time(3, () => buildAnalytics(db, 'ownerWeek', { week: 'this', withCosts: true }, NOW));
    const tEst = performance.now();
    buildAnalytics(db, 'trends', { withCosts: true }, NOW);
    const estColdMain = performance.now() - tEst;
    const estWarmMain = time(3, () => buildAnalytics(db, 'trends', { withCosts: true }, LATER));
    lines.push(
      `every order estimated — main thread: the card with costs ${estCard.ms.toFixed(0)} ms; trends with 12 months of food cost, first ask of the day ${estColdMain.toFixed(0)} ms, then ${estWarmMain.ms.toFixed(0)} ms`,
    );
    const estFile = join(dir, 'till-estimated.sqlite');
    db.exec(`VACUUM INTO '${estFile.replace(/'/g, "''")}'`);
    const estClient = workerOn(estFile);
    estClient.start();
    expect(await estClient.settled()).toBe('ready');
    await estClient.run('overview', { ...YEAR }, nowIso);
    const estCardMs = await inWorker('every order estimated, the card with costs', () => estClient.run('ownerWeek', { week: 'this', withCosts: true }, at(NOW)), CARD_BUDGET_HERE_MS, 5);
    const estColdMs = await inWorker('every order estimated, trends with 12 months of food cost, the first ask of the day', () => estClient.run('trends', { withCosts: true }, nowIso), 2000, 1, false);
    const estWarmMs = await inWorker('every order estimated, trends with 12 months of food cost, once kept', () => estClient.run('trends', { withCosts: true }, at(LATER)), 2000, 3);
    await estClient.stop();
    till.close();
    rmSync(dir, { recursive: true, force: true });
    // eslint-disable-next-line no-console
    console.log(['', "Reports bench, Phase 7 (node:sqlite; worker = the built analytics-worker.cjs):", ...lines.map((l) => `  ${l}`)].join('\n'));
    // The card's budget, held to the shop-PC profile (÷ 4 here); re-run on the shop's till PC before trusting the margin.
    expect(cardMs).toBeLessThanOrEqual(CARD_BUDGET_HERE_MS);
    expect(estCardMs).toBeLessThanOrEqual(CARD_BUDGET_HERE_MS);
    // …and with a stock-take pair, once the worker has been told of the finish (as the till tells it).
    expect(warmedMs).toBeLessThanOrEqual(CARD_BUDGET_HERE_MS);
    // Once the day has kept the months that are over, Overview's trends are a month's read, not a year's.
    expect(warmTrendsMs).toBeLessThan(estColdMs);
    expect(estWarmMs).toBeLessThan(estColdMs);
  });
});

// ---------------------------------------------------------------------------
// Phase 8: stock takes and "used vs should have used"
// ---------------------------------------------------------------------------

/**
 * The spec's budget: variance for 90 ingredients over a month ≤ 200 ms in
 * the worker — on the SHOP-PC profile (costing spec 6.3: the till PC, or 4×
 * CPU-throttled), as the Phase 7 card is. Unthrottled here, it is held to a
 * quarter of that, and the verdict printed against it.
 */
const VARIANCE_BUDGET_SHOP_PC_MS = 200;
const VARIANCE_BUDGET_HERE_MS = VARIANCE_BUDGET_SHOP_PC_MS / 4;
/**
 * Asserted only as a guard against it getting slower: the dev laptop's
 * figure before the shop-PC profile was applied. The shop-PC budget above
 * is MISSED (printed); the spec's answer to a miss confirmed on the shop's
 * till PC is Contingency R, not more tuning here.
 */
const VARIANCE_REGRESSION_GUARD_MS = 200;

/**
 * Costing Phase 8 (`-t "Phase 8"`) on the same year of orders: 90 ingredients
 * (the fixture's, and made-up ones to make up the number) with a month of
 * every kind of stock row between two FULL stock takes — every order's
 * takes (~12 rows an order, a busy shop's), a delivery a day for each of the
 * 90, waste, fixes and cancelled orders' put-backs dated back to their take
 * — then "used vs should have used" (with the real food cost, both counts
 * being full) on this thread and in the real worker, while the till keeps
 * ringing orders. Also what finishing a full stock take of 90 lines costs
 * (shop stock for each). Every quantity and price made up.
 *
 * Measured 2026-09-27 on the dev laptop (40,152 orders in the year; 42,372
 * stock rows in the month's window, ~12 an order):
 *   variance, worker ....................... 113–147 ms — MISSES the shop-PC
 *                                            budget held here (200 ÷ 4 = 50
 *                                            ms; ×4 ≈ 450–590 ms there); the
 *                                            till's slowest call meanwhile
 *                                            ~20 ms, event loop late ≤ ~9 ms
 *   variance, main thread .................. ~102 ms (cold page cache ~130 ms:
 *                                            the window's sums ~60, food sales
 *                                            ~58, the rest ~10)
 *   finishing a full stock take (90 lines) . ~82 ms on the main thread (the
 *                                            first, with nothing before it,
 *                                            ~55 ms)
 *   a heavier ledger (60,934 rows, ~17 an order): worker ~153 ms, main ~121 ms
 *   the card after the monthly count ....... worker ~8 ms once told of the
 *                                            finished stock take (warm);
 *                                            ~135 ms when not (the month's
 *                                            comparison inside the tap — over
 *                                            the card's 75 ms here)
 * It first measured ~530 ms in the worker: every row of the window handed to
 * JavaScript, and the food cost's full pass. The window is now added up in
 * SQL (only batches, fixes, counts and later cancels dated row by row), food
 * sales read in one pass without the "known" lines, a later cancel found by
 * idx_movements_taken, and shop stock at a finish summed in SQL too (~330 ms
 * before). What is left is two month-long reads (the window's sums, the food
 * sales) — the pre-aggregated days of Contingency R, if the shop PC confirms
 * the miss. Re-run on the shop's till PC (or 4× CPU-throttled).
 */
bench('Reports bench, Phase 8: stock takes and used vs should have used (opt-in)', () => {
  it('variance for 90 ingredients over a month, on this thread and in the worker', async () => {
    const { db, s, repos, size } = await yearShop();
    const { startStockCount, saveStockCountLines, finishStockCount } = await import('../db/repositories/stock-count-repo.js');
    const { buildVariance } = await import('./analytics/stock-control.js');
    const { AnalyticsWorkerClient } = await import('./analytics/worker-client.js');
    const { WORKER_FILE, WORKER_TAG } = await import('./analytics/worker-protocol.js');
    const { buildAnalyticsWorker } = await import('../../electron.vite.config');
    const lines: string[] = [];

    // 90 ingredients: the fixture's and made-up ones.
    const extra: string[] = [];
    const have = Number((db.prepare(`SELECT COUNT(*) AS n FROM ingredients WHERE deleted_at IS NULL AND is_active = 1`).get() as { n: number }).n);
    for (let i = have; i < 90; i += 1) {
      extra.push(
        s.r.createIngredient(db, { name: `Test extra ${String(i).padStart(2, '0')}`, unit: 'g', currentQty: 200_000, packSize: 1_000, packPriceCents: 10_000 + i * 700 }, MANAGER).id,
      );
    }
    const monthStart = Date.parse(MONTH.sinceIso);
    const monthEnd = Date.parse(MONTH.untilIso);
    const clockAt = (ms: number) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(ms));
    };
    /** A full stock take counted at what the till says, less a little of some things, finished at `ms` (on `on`: this database, or the till's file). */
    const fullCount = (ms: number, short: (id: string, i: number) => number, on: AppDatabase = db) => {
      clockAt(ms);
      const c = startStockCount(on, { scope: 'full' }, MANAGER);
      const qty = new Map(
        (on.prepare(`SELECT id, current_qty AS q FROM ingredients WHERE deleted_at IS NULL`).all() as Array<{ id: string; q: number }>).map((r) => [r.id, Number(r.q)]),
      );
      saveStockCountLines(
        on,
        { countId: c.id, lines: c.lines.map((l, i) => ({ ingredientId: l.ingredientId, countedQty: Math.max(0, (qty.get(l.ingredientId) ?? 0) - short(l.ingredientId, i)) })) },
        MANAGER,
      );
      const t0 = performance.now();
      const done = finishStockCount(on, c.id, MANAGER).count;
      return { count: done, ms: performance.now() - t0 };
    };
    const s0 = fullCount(monthStart - 60_000, () => 0);

    // A month of the made-up ingredients' stock rows, from the month's orders (seeded: every run is the same).
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const orders = db
      .prepare(`SELECT id, created_at AS at FROM orders WHERE created_at >= ? AND created_at < ? ORDER BY created_at`)
      .all(MONTH.sinceIso, MONTH.untilIso) as Array<{ id: string; at: string }>;
    const insert = db.prepare(
      `INSERT INTO stock_movements (id, ingredient_id, delta_qty, reason, ref_order_id, occurred_at, resulting_qty, unit, unit_cost_mc, value_cents, cost_basis, detail, ref_taken_at, created_at, updated_at, device_id, version)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'g', ?, ?, ?, ?, ?, ?, ?, 'bench', 1)`,
    );
    let rows = 0;
    const tRows = performance.now();
    db.exec('PRAGMA foreign_keys = OFF');
    db.transaction(() => {
      const add = (id: string, delta: number, reason: string, at: string, opts: { order?: string | null; detail?: string | null; takenAt?: string | null } = {}) => {
        insert.run(`bench-mv-${rows}`, id, delta, reason, opts.order ?? null, at, 12_000, delta * 12, 'price', opts.detail ?? null, opts.takenAt ?? null, at, at);
        rows += 1;
      };
      for (const o of orders) {
        // Each order also takes 3 of the made-up ingredients: with the fixture's own, ~12 stock rows an
        // order (a real order takes 6–12: dough, sauce, cheese, a topping or two, a box, a drink…).
        for (let k = 0; k < 3; k += 1) add(extra[rand(extra.length)]!, -(20 + rand(80)), 'sale', o.at, { order: o.id });
        // One in fifty is cancelled later: its stock put back, dated back to its take.
        if (rand(50) === 0) {
          const later = new Date(Date.parse(o.at) + 30 * 60_000).toISOString();
          add(extra[rand(extra.length)]!, 30, 'sale', later, { order: o.id, detail: 'cancel_put_back', takenAt: o.at });
        }
      }
      for (let d = 0; d < 31; d += 1) {
        const day = monthStart + d * 86_400_000;
        for (const id of extra) add(id, 5_000, 'delivery', new Date(day + 9 * 3_600_000).toISOString());
        for (let w = 0; w < 10; w += 1) add(extra[rand(extra.length)]!, -(50 + rand(200)), 'waste', new Date(day + 22 * 3_600_000).toISOString(), { detail: 'waste:expired' });
        add(extra[rand(extra.length)]!, 100, 'adjustment', new Date(day + 23 * 3_600_000).toISOString(), { detail: 'correction' });
      }
    })();
    db.exec('PRAGMA foreign_keys = ON');
    // This till's counts as they would stand after those rows.
    db.exec(
      `UPDATE ingredients SET current_qty = current_qty + COALESCE((SELECT SUM(delta_qty) FROM stock_movements m WHERE m.ingredient_id = ingredients.id AND m.device_id = 'bench'), 0)`,
    );
    lines.push(`${size.orders} orders in the year; added ${rows} stock rows for ${extra.length} made-up ingredients over the month in ${(performance.now() - tRows).toFixed(0)} ms`);
    const s1 = fullCount(monthEnd - 60_000, (_id, i) => (i % 7 === 0 ? 250 : 0));
    vi.useRealTimers();
    const windowRows = Number(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM stock_movements WHERE occurred_at > ? AND occurred_at <= ?`).get(s0.count.finishedAt, s1.count.finishedAt) as {
          n: number;
        }
      ).n,
    );
    lines.push(
      `full stock take of ${s1.count.lineCount} lines: finishing (shop stock for each, one transaction) ${s1.ms.toFixed(0)} ms; the first one (no stock take before it) ${s0.ms.toFixed(0)} ms`,
    );

    const job = { fromCountId: s0.count.id, toCountId: s1.count.id, link: { on: false, stale: false, lastHeardAt: null } };
    const onMain = time(5, () => buildVariance(db, job));
    expect(onMain.out.state).toBe('ok');
    expect(onMain.out.lines.length).toBe(90);
    expect(onMain.out.actualCogs).not.toBeNull();
    lines.push(
      `main thread: variance for ${onMain.out.lines.length} ingredients, ${windowRows} stock rows in the window: ${onMain.ms.toFixed(0)} ms (with the real food cost) — ${verdict(onMain.ms, VARIANCE_BUDGET_HERE_MS)} for the shop PC's ${VARIANCE_BUDGET_SHOP_PC_MS} ms ÷ 4`,
    );

    // The real worker, built as for the till, on a file copy, while the till keeps ringing orders.
    const dir = mkdtempSync(join(tmpdir(), 'coc-bench8-'));
    const file = join(dir, 'till.sqlite');
    db.exec(`VACUUM INTO '${file.split("'").join("''")}'`);
    const till = openTillFile(file);
    await buildAnalyticsWorker({ outDir: dir });
    const client = new AnalyticsWorkerClient({
      spawn: () => new Worker(join(dir, WORKER_FILE), { workerData: { tag: WORKER_TAG, dbPath: file, driver: 'node:sqlite' } }),
    });
    client.start();
    expect(await client.settled()).toBe('ready');
    await client.run('variance', job); // its statements compiled, as the first report of the day does
    const item = s.item;
    const choice = s.choice;
    const probe = startTill(till, {
      board: () => repos.listActiveOrders(till, {}),
      ringAndSend: () => {
        const t0 = performance.now();
        const o = repos.createOrder(till, { mode: 'takeaway' }, CASHIER);
        repos.addOrderItem(till, { orderId: o.id, menuItemId: item.fajitaM, quantity: 1, modifierIds: [choice.extraCheese], notes: null }, CASHIER);
        repos.sendOrderToKitchen(till, o.id, CASHIER);
        return performance.now() - t0;
      },
    });
    const runs = 5;
    const t0 = performance.now();
    for (let i = 0; i < runs; i += 1) await client.run('variance', job, new Date(Date.now() + i).toISOString());
    const workerMs = (performance.now() - t0) / runs;
    const p = probe.stop();
    lines.push(
      `worker: variance for 90 ingredients over a month ${workerMs.toFixed(0)} ms — ${verdict(workerMs, VARIANCE_BUDGET_HERE_MS)} for the shop PC's ${VARIANCE_BUDGET_SHOP_PC_MS} ms (÷ 4 here; ×4 ≈ ${(workerMs * 4).toFixed(0)} ms there); meanwhile slowest till call ${Math.max(p.maxBoard, p.maxSend).toFixed(1)} ms, event loop late by at most ${p.maxLag.toFixed(1)} ms`,
    );

    // The Dashboard card after the monthly full stock take (Phase 7's budget: ≤ 300 ms on the shop PC, 75 here):
    // "Do this" compares the latest two full stock takes. A full recount finished later the same trading day is a
    // new pair over the same month: asked with the worker not told of it, then — after another — with it told
    // (inventory-handlers → worker-client warm), as the till does.
    const CARD_NOW = monthEnd + 3_600_000;
    let cardTick = 0;
    const cardAsk = async (label: string) => {
      const t = performance.now();
      const out = (await client.run('ownerWeek', { week: 'this', withCosts: true }, new Date(CARD_NOW + ++cardTick).toISOString())) as { doThis: Array<{ kind: string }> };
      const ms = performance.now() - t;
      lines.push(`worker, the card ${label}: ${ms.toFixed(0)} ms — ${verdict(ms, CARD_BUDGET_HERE_MS)} for the shop PC's ${CARD_BUDGET_SHOP_PC_MS} ms ÷ 4 ("Do this": ${out.doThis.map((i) => i.kind).join(', ')})`);
      return ms;
    };
    await cardAsk("the first ask of the day after the monthly stock take (the day's sales read too)");
    await cardAsk('asked again the same day');
    fullCount(monthEnd - 30_000, (_id, i) => (i % 7 === 0 ? 250 : 0), till);
    vi.useRealTimers();
    const notToldMs = await cardAsk('the first ask after a full recount is finished, the worker not told');
    fullCount(monthEnd - 15_000, (_id, i) => (i % 7 === 0 ? 250 : 0), till);
    vi.useRealTimers();
    client.warm({ on: false, stale: false, lastHeardAt: null }, new Date(CARD_NOW).toISOString());
    await client.run('trends', { withCosts: false }, new Date(CARD_NOW).toISOString()); // queued behind the warm-up: the owner taps a moment later
    const toldMs = await cardAsk('the next ask once the worker was told of the finished stock take');
    await client.stop();
    till.close();
    rmSync(dir, { recursive: true, force: true });
    // eslint-disable-next-line no-console
    console.log(['', 'Reports bench, Phase 8 (node:sqlite; worker = the built analytics-worker.cjs):', ...lines.map((l) => `  ${l}`)].join('\n'));
    // Only a guard against it getting slower: the shop-PC budget is printed above (see VARIANCE_REGRESSION_GUARD_MS).
    expect(workerMs).toBeLessThanOrEqual(VARIANCE_REGRESSION_GUARD_MS);
    // The card, told of the finished stock take as the till tells it, is within its shop-PC budget (÷ 4 here);
    // not told, it waits for the month's comparison inside the tap.
    expect(toldMs).toBeLessThanOrEqual(CARD_BUDGET_HERE_MS);
    expect(toldMs).toBeLessThan(notToldMs);
  });
});
