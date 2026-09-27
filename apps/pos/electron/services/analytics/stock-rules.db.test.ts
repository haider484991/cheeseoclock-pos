/**
 * The owner's stock rules (Settings → Kitchen & stock, 'stock.rules') where
 * the till uses them, against a real database built from every migration
 * and a made-up shop: the Dashboard's "Do this" (its trigger and shortest
 * stretch), the rating on Reports → Between stock takes and the weekly
 * sheet (the bands, said as they are), and the stock-take reminders. With
 * nothing saved every one of them is today's (the existing
 * stock-control.db.test.ts pins those numbers unchanged).
 *
 * node:sqlite behind better-sqlite3's shape; skips where it is missing.
 * EVERY PRICE AND QUANTITY IS MADE UP.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STOCK_RULES, type StockRules, type TillLinkState } from '@cheeseoclock/shared-types';
import { DatabaseSync, MANAGER, OWNER, openCostingShop, openMigrated } from '../../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, safeStorage: { isEncryptionAvailable: () => false } }));

const live = describe.skipIf(!DatabaseSync);
const OFF: TillLinkState = { on: false, stale: false, lastHeardAt: null };

afterEach(() => {
  vi.useRealTimers();
});

async function shop() {
  const db = openMigrated();
  const s = await openCostingShop(db);
  const r = {
    ...s.r,
    ...(await import('../../db/repositories/stock-count-repo.js')),
    ...(await import('../../db/repositories/order-stock-repo.js')),
    ...(await import('../../db/repositories/ingredient-repo.js')),
    ...(await import('../../db/repositories/business-settings-repo.js')),
    ...(await import('./stock-control.js')),
    ...(await import('./owner-week.js')),
  };
  const clock = (iso: string) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  };
  const sell = (lines: Parameters<typeof s.ring>[0]) => {
    const o = s.ring(lines);
    r.sendOrderToKitchen(db, o, { userId: 'u_cash', deviceId: 'till-1' });
    s.markPaid(o, new Date());
    return o;
  };
  const tillCount = (id: string) => Number((db.prepare(`SELECT current_qty AS q FROM ingredients WHERE id = ?`).get(id) as { q: number }).q);
  /** A key-items (or full) stock take of the cheese, counted as given, finished now. */
  const stockTake = (qty: number, scope: 'key_items' | 'full' = 'key_items') => {
    const c = r.startStockCount(db, { scope }, MANAGER);
    r.saveStockCountLines(
      db,
      { countId: c.id, lines: c.lines.map((l) => ({ ingredientId: l.ingredientId, countedQty: l.ingredientId === s.ing.cheese ? qty : tillCount(l.ingredientId) })) },
      MANAGER,
    );
    return r.finishStockCount(db, c.id, MANAGER).count;
  };
  /** The owner saves the stock rules (business-settings-repo: synced, audited). */
  const saveRules = (over: Partial<StockRules>) =>
    r.setBusinessSetting(db, 'stock.rules', { ...structuredClone(DEFAULT_STOCK_RULES as StockRules), ...over }, OWNER);
  const doThis = (now: Date) => r.buildOwnerWeek(db, { week: 'this', withCosts: true, link: OFF }, now).doThis;
  const sheet = (now: Date) => r.buildOwnerWeek(db, { week: 'this', withCosts: true, sheet: true, link: OFF }, now).sheet!;
  return { ...s, db, r, clock, sell, tillCount, stockTake, saveRules, doThis, sheet };
}

/** The cheese, a key item, counted Monday 14 and Monday 21 Sep with `shortG` gone unexplained between (Rs 2,400 of food sales). */
async function weekOfCheese(shortG: number, from = '2026-09-14T06:00:00.000Z') {
  const s = await shop();
  s.r.setKeyItems(s.db, [s.ing.cheese], MANAGER);
  s.clock(from);
  const s0 = s.stockTake(s.tillCount(s.ing.cheese));
  s.clock(new Date(Date.parse(from) + 3 * 3_600_000).toISOString());
  s.sell([['fajitaM', 2]]);
  s.clock('2026-09-21T06:00:00.000Z');
  const s1 = s.stockTake(s.tillCount(s.ing.cheese) - shortG);
  return { s, s0, s1 };
}
const NOW = new Date('2026-09-21T07:00:00.000Z');

live('"Do this" with the owner’s trigger and shortest stretch', () => {
  it('2.5% unexplained: not a line at the released 3%; a line once the owner says 2%', async () => {
    // 50 g of cheese: Rs 60 of Rs 2,400 (2.5%).
    const { s, s1 } = await weekOfCheese(50);
    expect(s.doThis(NOW).some((i) => i.kind === 'stock_variance')).toBe(false);
    s.saveRules({ varianceDoThisBps: 200 });
    expect(s.doThis(NOW).find((i) => i.kind === 'stock_variance')).toMatchObject({ toCountId: s1.id, varianceBps: 250, totalCents: 6_000 });
    // …and 3% again: gone.
    s.saveRules({ varianceDoThisBps: 300 });
    expect(s.doThis(NOW).some((i) => i.kind === 'stock_variance')).toBe(false);
  });

  it('two stock takes two days apart: not a line at the released 6 days; a line once the owner says 2 days', async () => {
    const { s } = await weekOfCheese(250, '2026-09-19T06:00:00.000Z');
    expect(s.doThis(NOW).some((i) => i.kind === 'stock_variance')).toBe(false);
    s.saveRules({ varianceMinWindowDays: 2 });
    expect(s.doThis(NOW).find((i) => i.kind === 'stock_variance')).toMatchObject({ varianceBps: 1_250 });
  });
});

live('the rating with the owner’s bands', () => {
  it('Reports rate and say them as they are; the weekly sheet follows a Save the same day', async () => {
    // 250 g: Rs 300 of Rs 2,400 (12.5%): "Look at it now" at the released 2 / 3 / 5%.
    const { s, s0, s1 } = await weekOfCheese(250);
    const report = () => s.r.buildVariance(s.db, { fromCountId: s0.id, toCountId: s1.id, link: OFF });
    expect(report()).toMatchObject({ band: 'look_now', bands: { goodUnderBps: 200, okUpToBps: 300, needsWorkUpToBps: 500 } });
    expect(s.sheet(NOW).lastStockTake).toMatchObject({ band: 'look_now' });
    s.saveRules({ bands: { goodUnderBps: 500, okUpToBps: 1_000, needsWorkUpToBps: 1_500 } });
    expect(report()).toMatchObject({ band: 'needs_work', bands: { goodUnderBps: 500, okUpToBps: 1_000, needsWorkUpToBps: 1_500 } });
    // Kept for the day, but a Save is a new key: the sheet shows the new rating at once.
    expect(s.sheet(NOW).lastStockTake).toMatchObject({ band: 'needs_work' });
    s.saveRules({ bands: { goodUnderBps: 1_300, okUpToBps: 1_400, needsWorkUpToBps: 1_500 } });
    expect(s.sheet(NOW).lastStockTake).toMatchObject({ band: 'good' });
  });
});

live('stock-take reminders', () => {
  const MON_28 = new Date('2026-09-28T07:00:00.000Z');
  const reminders = (s: Awaited<ReturnType<typeof shop>>, now: Date) => s.doThis(now).filter((i) => i.kind === 'stock_take_due');

  it('off (the default): no line, however long ago the last count was', async () => {
    const { s } = await weekOfCheese(0);
    expect(reminders(s, new Date('2026-12-01T07:00:00.000Z'))).toEqual([]);
  });

  it('the key items every 7 days: pinned on the 7th day, not the 6th; a full count stops it too', async () => {
    const { s, s1 } = await weekOfCheese(0);
    s.saveRules({ reminders: { keyItemsEveryDays: 7, fullEveryDays: null } });
    expect(reminders(s, new Date('2026-09-27T07:00:00.000Z'))).toEqual([]);
    expect(reminders(s, MON_28)).toEqual([
      {
        kind: 'stock_take_due',
        key: 'stock_take_due:key_items',
        weekCents: null,
        pinned: true,
        cost: false,
        scope: 'key_items',
        everyDays: 7,
        lastAt: s1.finishedAt,
        daysSince: 7,
      },
    ]);
    // Not for costs: a login without them sees it too (it carries none).
    expect(s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: false, link: OFF }, MON_28).doThis.some((i) => i.kind === 'stock_take_due')).toBe(true);
    // A full stock take on the Sunday counts the key items.
    s.clock('2026-09-27T06:00:00.000Z');
    s.stockTake(s.tillCount(s.ing.cheese), 'full');
    expect(reminders(s, MON_28)).toEqual([]);
  });

  it('a full stock take every 30 days, never done: that line alone', async () => {
    const { s } = await weekOfCheese(0);
    s.saveRules({ reminders: { keyItemsEveryDays: 7, fullEveryDays: 30 } });
    expect(reminders(s, MON_28)).toMatchObject([{ scope: 'full', everyDays: 30, lastAt: null, daysSince: null }]);
  });
});
