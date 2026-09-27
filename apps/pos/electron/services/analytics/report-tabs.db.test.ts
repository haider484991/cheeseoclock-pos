/**
 * The Reports tabs (costing spec Phase 3) on a real database built from
 * every migration (a made-up shop, db/costing-shop.fixture.ts):
 *  - a tab asked of the worker comes back exactly as the same tab worked
 *    out directly (the worker runs handleRunRequest, the function tested
 *    here, behind a stand-in thread that copies the answer as a real one
 *    would);
 *  - the tabs agree with each other and with the whole page (every
 *    breakdown of business-report.test.ts runs through these builders);
 *  - what a login without costs is handed.
 *
 * node:sqlite behind better-sqlite3's shape (better-sqlite3 here is built
 * for Electron); skips where it is missing. Every name and price is made up.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { REPORT_TABS, type BusinessReportRequest, type ReportTab } from '@cheeseoclock/shared-types';
import { CASHIER, DatabaseSync, openCostingShop, openMigrated } from '../../db/costing-shop.fixture.js';
import type { WorkerReply, WorkerRequest } from './worker-protocol.js';
import type { WorkerLike } from './worker-client.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const live = describe.skipIf(!DatabaseSync);

/** A made-up trading day: 26 Sep 2026 (05:00 → 05:00 Pakistan time). */
const DAY: BusinessReportRequest = {
  sinceIso: '2026-09-26T00:00:00.000Z',
  untilIso: '2026-09-27T00:00:00.000Z',
  compareSinceIso: '2026-09-25T00:00:00.000Z',
  compareUntilIso: '2026-09-26T00:00:00.000Z',
};
const NOW = new Date('2026-09-26T18:00:00.000Z');

let db: ReturnType<typeof openMigrated>;
let tabs: typeof import('./report-tabs.js');
let worker: typeof import('./worker.js');
let client: typeof import('./worker-client.js');
let report: typeof import('../business-report.js');

beforeAll(async () => {
  if (!DatabaseSync) return;
  db = openMigrated();
  const s = await openCostingShop(db);
  // A few sales through the day (stock taken and cost kept as at the till),
  // one the day before, one cancelled.
  const sale = (lines: Parameters<typeof s.ring>[0], at: string) => {
    const o = s.ring(lines);
    s.r.decrementForOrder(db, o, CASHIER);
    s.markPaid(o, new Date(at));
    return o;
  };
  sale([['fajitaM', 2, ['extraCheese']]], '2026-09-26T08:00:00.000Z');
  sale([['deal', 1, ['d1Fajita', 'd2Veggie', 'sideRanch']], ['delivery', 1]], '2026-09-26T14:30:00.000Z');
  sale([['veggieL', 1, ['pickOnion', 'pickPepper', 'pickOlive', 'pickMushroom', 'pickCorn', 'dipChili']]], '2026-09-26T19:59:00.000Z');
  sale([['crispyWings', 1]], '2026-09-25T12:00:00.000Z');
  const cancelled = s.ring([['bakedWings', 1]]);
  db.prepare(`UPDATE orders SET status = 'void', voided_at = ?, void_reason = 'Customer left', created_at = ? WHERE id = ?`).run(
    '2026-09-26T09:05:00.000Z',
    '2026-09-26T09:00:00.000Z',
    cancelled,
  );
  tabs = await import('./report-tabs.js');
  worker = await import('./worker.js');
  client = await import('./worker-client.js');
  report = await import('../business-report.js');
});

/** A stand-in worker thread that runs what the real one runs, answering on the next turn with a copy (structured clone). */
function inProcessWorker(): WorkerLike {
  const listeners: Array<(msg: unknown) => void> = [];
  return {
    postMessage(msg: WorkerRequest) {
      if (msg.type !== 'run') return;
      setImmediate(() => {
        const reply: WorkerReply = worker.handleRunRequest(db, structuredClone(msg));
        for (const l of listeners) l(structuredClone(reply));
      });
    },
    on(event: string, l: (arg: never) => void) {
      if (event === 'message') listeners.push(l as (msg: unknown) => void);
      if (event === 'message' && listeners.length === 1) setImmediate(() => l({ type: 'ready', journalMode: 'memory', ms: 0 } as never));
      return this;
    },
    terminate: () => Promise.resolve(0),
  } as WorkerLike;
}

live('Reports tabs through the worker', () => {
  it('every tab comes back from the worker exactly as worked out directly', async () => {
    const c = new client.AnalyticsWorkerClient({ spawn: inProcessWorker });
    c.start();
    expect(await c.settled()).toBe('ready');
    for (const tab of REPORT_TABS) {
      const viaWorker = await c.run(tab, DAY, NOW.toISOString());
      expect({ tab, figures: viaWorker }).toEqual({ tab, figures: tabs.buildReportTab(db, tab, DAY, NOW) });
    }
    // And they are not empty: the day's three sales are there.
    expect(tabs.buildReportTab(db, 'overview', DAY, NOW).kpis.orderCount).toBe(3);
  });

  it('the tabs agree with each other and with the whole page', () => {
    const t = Object.fromEntries(REPORT_TABS.map((k) => [k, tabs.buildReportTab(db, k, DAY, NOW)])) as {
      [K in ReportTab]: ReturnType<typeof tabs.buildReportTab<K>>;
    };
    const k = t.overview.kpis;
    expect(k.orderCount).toBe(3);
    expect(t.when.kpis).toEqual({ orderCount: k.orderCount, netSalesCents: k.netSalesCents });
    expect(t.menu.kpis).toEqual({ menuSalesCents: k.menuSalesCents, itemCount: k.itemCount });
    expect(t.channels.kpis).toEqual({ orderCount: k.orderCount, netSalesCents: k.netSalesCents, avgOrderCents: k.avgOrderCents });
    expect(t.foodStock.kpis).toEqual({ partialRefundCents: k.partialRefundCents });
    expect(t.team.kpis).toEqual({
      netSalesCents: k.netSalesCents,
      menuSalesCents: k.menuSalesCents,
      partialRefundCents: k.partialRefundCents,
      fullRefundCents: k.fullRefundCents,
      voidCount: k.voidCount,
      voidCents: k.voidCents,
    });
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    expect(sum(t.when.byDay.map((d) => d.netSalesCents))).toBe(k.netSalesCents);
    expect(sum(t.menu.items.map((i) => i.salesCents))).toBe(k.menuSalesCents);
    expect(sum(t.channels.channels.map((c) => c.netSalesCents))).toBe(k.netSalesCents);
    expect(sum(t.team.staff.map((s) => s.netSalesCents))).toBe(k.netSalesCents);
    expect(t.team.voids).toHaveLength(1);
    expect(t.foodStock.foodCost.costOfSalesCents).toBeGreaterThan(0);

    const page = report.getBusinessReport(db, DAY, NOW);
    expect(page.kpis).toEqual(k);
    expect(page.previous).toEqual(t.overview.previous);
    expect(page.items).toEqual(t.menu.items);
    expect(page.byHour).toEqual(t.when.byHour);
    expect(page.deliveries).toEqual(t.channels.deliveries);
    expect(page.foodCost).toEqual(t.foodStock.foodCost);
    expect(page.staff).toEqual(t.team.staff);
    expect(page.voids).toEqual(t.team.voids);
  });

  it('a login without costs: Team says nothing of what waste cost, Food cost & stock is never handed over', () => {
    const team = { ...tabs.buildReportTab(db, 'team', DAY, NOW), engine: 'worker' as const };
    const wasted = {
      ...team,
      voids: team.voids.map((v) => ({ ...v, stock: { outcome: 'wasted' as const, answer: 'made' as const, wasteCents: 18_000, statusBefore: 'ready', flagged: false } })),
      foodCost: { hasCosts: true },
    };
    expect(tabs.reportTabForLogin('team', wasted, true)).toBe(wasted);
    const plain = tabs.reportTabForLogin('team', wasted, false);
    expect(plain.foodCost).toBeNull();
    expect(plain.voids.map((v) => v.stock?.wasteCents)).toEqual([0]);
    expect(plain.staff).toEqual(team.staff);
    const food = { ...tabs.buildReportTab(db, 'foodStock', DAY, NOW), engine: 'worker' as const };
    expect(() => tabs.reportTabForLogin('foodStock', food, false)).toThrow('Only a manager or the owner can see costs.');
    // Menu: its cost columns go with the costs (costing spec Phase 9), and its profit with profit.view.
    const menu = { ...tabs.buildReportTab(db, 'menu', DAY, NOW), engine: 'main' as const };
    expect(menu.costs).not.toBeNull();
    expect(tabs.reportTabForLogin('menu', menu, false)).toEqual({ ...menu, costs: null });
    expect(tabs.reportTabForLogin('menu', menu, true, true)).toBe(menu);
    const noProfit = tabs.reportTabForLogin('menu', menu, true, false);
    expect(Object.values(noProfit.costs!.items).every((c) => c.profitCents === null && c.profitPerSaleCents === null)).toBe(true);
    // Profit is never handed over without profit.view and costs.
    const profit = { ...tabs.buildReportTab(db, 'profit', DAY, NOW), engine: 'worker' as const };
    expect(tabs.reportTabForLogin('profit', profit, true, true)).toBe(profit);
    expect(() => tabs.reportTabForLogin('profit', profit, true, false)).toThrow('Only the owner can see profit.');
    expect(() => tabs.reportTabForLogin('profit', profit, false, true)).toThrow('Only the owner can see profit.');
  });

  it('the worker answers a bad ask with its reason, and carries on', () => {
    const bad = worker.handleRunRequest(db, { type: 'run', id: 7, kind: 'nope' as never, request: DAY, nowIso: NOW.toISOString() });
    expect(bad).toMatchObject({ type: 'result', id: 7, ok: false, message: 'Unknown report tab: nope' });
    const good = worker.handleRunRequest(db, { type: 'run', id: 8, kind: 'when', request: DAY, nowIso: 'not a date' });
    expect(good).toMatchObject({ type: 'result', id: 8, ok: true });
  });

  it('a month fits the main process (the fallback); 32 days do not', () => {
    expect(tabs.fitsMainThread({ sinceIso: '2026-09-01T00:00:00.000Z', untilIso: '2026-10-02T00:00:00.000Z' })).toBe(true);
    expect(tabs.fitsMainThread({ sinceIso: '2026-09-01T00:00:00.000Z', untilIso: '2026-10-03T00:00:00.000Z' })).toBe(false);
    expect(tabs.periodDays({ sinceIso: '2026-01-01T00:00:00.000Z', untilIso: '2027-01-01T00:00:00.000Z' })).toBe(365);
  });
});
