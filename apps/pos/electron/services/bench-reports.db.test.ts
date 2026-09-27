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
 * EVERY PRICE IS MADE UP (costing spec D11).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
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
