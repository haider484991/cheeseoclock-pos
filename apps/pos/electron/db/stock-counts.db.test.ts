/**
 * Stock takes (costing spec Phase 8, migration 0038) against a real database
 * built from every migration and a made-up shop (costing-shop.fixture.ts):
 *   - start, count, finish: finishing is ONE transaction — each counted line
 *     against SHOP stock (costing spec 4.6), this till's count before, its
 *     value at the price then, and a 'count' stock row that sets this till's
 *     count — synced and audited, and finishing again writes nothing;
 *   - a failure half-way writes nothing at all; a cancelled stock take
 *     writes nothing to stock;
 *   - shop stock includes the other till's stock rows and leaves 'count'
 *     rows out (two tills, the link carrying the rows);
 *   - the Stock button's one-line stock take is a stock take like any other;
 *   - the key items are ONE list, on the ingredients: migration 0038 moved
 *     the price alerts' saved list there (or ticked the till's suggestions by
 *     name), and the price alerts, the "Do this" pins and the weekly stock
 *     take all read it.
 *
 * node:sqlite behind better-sqlite3's shape; skips where it is missing.
 * EVERY PRICE AND QUANTITY IS MADE UP (costing spec D11).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { suggestedKeyIngredient } from '@cheeseoclock/pos-domain';
import type { AppDatabase } from './connection.js';
import { CASHIER, DEV, DatabaseSync, MANAGER, MIGRATIONS, OWNER, openCostingShop, openMigrated } from './costing-shop.fixture.js';
import { verifyAuditChain, type AuditChainRow } from './audit-chain.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const live = describe.skipIf(!DatabaseSync);
const TILL_2 = 'till-2';

afterEach(() => {
  vi.useRealTimers();
});

async function repos() {
  return {
    ...(await import('./repositories/stock-count-repo.js')),
    ...(await import('./repositories/stock-movement-repo.js')),
    ...(await import('./repositories/order-repo.js')),
    ...(await import('./repositories/ingredient-repo.js')),
    ...(await import('./repositories/procurement-repo.js')),
    ...(await import('./repositories/business-settings-repo.js')),
    ...(await import('./repositories/sync-repo.js')),
    ...(await import('./repositories/apply-remote.js')),
    ...(await import('../services/costing-service.js')),
    ...(await import('../services/costing-settings.js')),
  };
}

function chainOk(db: AppDatabase): boolean {
  const rows = (
    db
      .prepare(
        `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action, actor_user_id AS actorUserId,
                before_json AS beforeJson, after_json AS afterJson, ip, created_at AS createdAt,
                prev_hash AS prevHash, row_hash AS rowHash
           FROM audit_log ORDER BY rowid`,
      )
      .all() as unknown as AuditChainRow[]
  ).map((r) => ({ ...r, rowid: Number(r.rowid) }));
  return verifyAuditChain(rows).ok;
}

async function shop(db: AppDatabase = openMigrated()) {
  const s = await openCostingShop(db);
  const r = { ...s.r, ...(await repos()) };
  const n = (sql: string, ...p: unknown[]) => Number((db.prepare(sql).get(...p) as { n: number } | undefined)?.n ?? 0);
  /** The till's clock (orders, stock rows and stock takes are dated by it). */
  const clock = (iso: string) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  };
  const send = (lines: Parameters<typeof s.ring>[0]) => {
    const o = s.ring(lines);
    r.sendOrderToKitchen(db, o, CASHIER);
    return o;
  };
  /** A stock take of these ingredients, counted as given, finished. */
  const stockTake = (counts: Partial<Record<keyof typeof s.ing, number>>) => {
    const ids = Object.keys(counts).map((k) => s.ing[k as keyof typeof s.ing]);
    const c = r.startStockCount(db, { scope: 'custom', ingredientIds: ids }, MANAGER);
    r.saveStockCountLines(
      db,
      { countId: c.id, lines: Object.entries(counts).map(([k, q]) => ({ ingredientId: s.ing[k as keyof typeof s.ing], countedQty: q! })) },
      MANAGER,
    );
    return r.finishStockCount(db, c.id, MANAGER).count;
  };
  return { ...s, db, r, n, clock, send, stockTake };
}

const line = <L extends { ingredientId: string }>(c: { lines: L[] }, id: string): L => c.lines.find((l) => l.ingredientId === id)!;

live('a stock take (costing Phase 8)', () => {
  it('start, count, finish: one transaction against shop stock, synced and audited; finishing again writes nothing', async () => {
    const s = await shop();
    s.clock('2026-09-21T06:00:00.000Z');
    const c = s.r.startStockCount(s.db, { scope: 'custom', ingredientIds: [s.ing.cheese, s.ing.onion, s.ing.box] }, MANAGER);
    expect(c).toMatchObject({ scope: 'custom', status: 'open', lineCount: 3, countedCount: 0, finishedAt: null, thisTill: true, shortCents: null });
    expect(c.lines.map((l) => l.countedQty)).toEqual([null, null, null]);
    expect(s.n(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'stock_count_lines'`)).toBe(3);
    expect(s.n(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'stock_counts' AND action = 'stock_count_start'`)).toBe(1);

    // The cook counts the cheese shelf and the onions; the boxes are left blank.
    s.r.saveStockCountLines(s.db, { countId: c.id, lines: [{ ingredientId: s.ing.cheese, countedQty: 98_000 }, { ingredientId: s.ing.onion, countedQty: 100_500 }] }, MANAGER);
    // Saving the same again writes nothing.
    const audit0 = s.n(`SELECT COUNT(*) AS n FROM audit_log`);
    s.r.saveStockCountLines(s.db, { countId: c.id, lines: [{ ingredientId: s.ing.cheese, countedQty: 98_000 }] }, MANAGER);
    expect(s.n(`SELECT COUNT(*) AS n FROM audit_log`)).toBe(audit0);

    s.clock('2026-09-21T06:30:00.000Z');
    const done = s.r.finishStockCount(s.db, c.id, MANAGER);
    expect(done.alreadyFinished).toBe(false);
    expect(done.count).toMatchObject({ status: 'done', scope: 'custom', finishedAt: '2026-09-21T06:30:00.000Z', lineCount: 3, countedCount: 2 });
    // Cheese Rs 1,200 / kg: 2 kg short = Rs 2,400. Onion Rs 150 / kg: 500 g over = Rs 75. Never counted before: the till's count.
    expect(line(done.count, s.ing.cheese)).toMatchObject({
      countedQty: 98_000,
      expectedQty: 100_000,
      expectedFrom: 'till',
      tillQty: 100_000,
      differenceQty: -2_000,
      differenceCents: -240_000,
      valueCents: 11_760_000,
      unitCostMc: 120_000,
    });
    expect(line(done.count, s.ing.onion)).toMatchObject({ differenceQty: 500, differenceCents: 7_500 });
    expect(line(done.count, s.ing.box)).toMatchObject({ countedQty: null, expectedQty: null });
    expect(done.count).toMatchObject({ shortCents: 240_000, overCents: 7_500 });
    // This till's count is what was counted; the blank line moved nothing.
    expect([s.stockOf('cheese'), s.stockOf('onion'), s.stockOf('box')]).toEqual([98_000, 100_500, 1_000]);
    const rows = s.db
      .prepare(`SELECT ingredient_id AS id, delta_qty AS d, detail, ref_group_id AS g, occurred_at AS at, cost_basis AS basis FROM stock_movements WHERE reason = 'count' ORDER BY rowid`)
      .all() as Array<{ id: string; d: number; detail: string; g: string; at: string; basis: string }>;
    expect(rows).toEqual([
      { id: s.ing.cheese, d: -2_000, detail: 'stock_take', g: c.id, at: '2026-09-21T06:30:00.000Z', basis: 'count' },
      { id: s.ing.onion, d: 500, detail: 'stock_take', g: c.id, at: '2026-09-21T06:30:00.000Z', basis: 'count' },
    ]);
    expect(s.n(`SELECT COUNT(*) AS n FROM stock_count_lines WHERE stock_count_id = ? AND movement_id IS NOT NULL`, c.id)).toBe(2);
    expect(s.n(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'stock_counts' AND action = 'stock_count_finish'`)).toBe(1);
    expect(chainOk(s.db)).toBe(true);

    // Finishing again: the same answer, nothing written.
    const before = ['stock_movements', 'audit_log', 'sync_queue'].map((t) => s.n(`SELECT COUNT(*) AS n FROM ${t}`));
    const again = s.r.finishStockCount(s.db, c.id, MANAGER);
    expect(again.alreadyFinished).toBe(true);
    expect(line(again.count, s.ing.cheese)).toMatchObject({ expectedQty: 100_000, differenceCents: -240_000 });
    expect(['stock_movements', 'audit_log', 'sync_queue'].map((t) => s.n(`SELECT COUNT(*) AS n FROM ${t}`))).toEqual(before);
    // …and it can't be counted into any more.
    expect(() => s.r.saveStockCountLines(s.db, { countId: c.id, lines: [{ ingredientId: s.ing.cheese, countedQty: 1 }] }, MANAGER)).toThrow(/finished/);
    expect(() => s.r.cancelStockCount(s.db, c.id, MANAGER)).toThrow(/can't be cancelled/);

    // The next stock take expects SHOP stock: that count, then a sale, a purchase and waste.
    s.clock('2026-09-21T07:00:00.000Z');
    s.send([['fajitaM', 1]]); // 60 g cheese
    s.clock('2026-09-21T08:00:00.000Z');
    s.r.recordPurchase(s.db, { lines: [{ ingredientId: s.ing.cheese, qty: 2_000, billCents: 240_000, usePrice: false }] }, MANAGER);
    s.clock('2026-09-21T09:00:00.000Z');
    s.r.recordStockMovement(s.db, { ingredientId: s.ing.cheese, deltaQty: -100, reason: 'waste', wasteReason: 'dropped' }, MANAGER);
    s.clock('2026-09-21T10:00:00.000Z');
    const next = s.stockTake({ cheese: 99_700 });
    expect(line(next, s.ing.cheese)).toMatchObject({ expectedQty: 98_000 - 60 + 2_000 - 100, expectedFrom: 'shop', tillQty: 99_840, differenceQty: -140 });
    expect(s.stockOf('cheese')).toBe(99_700);
  });

  it('a shelf counted before the finish is carried to the finish by what the till did in between (the till kept selling)', async () => {
    const s = await shop();
    s.clock('2026-09-21T10:00:00.000Z');
    const c = s.r.startStockCount(s.db, { scope: 'custom', ingredientIds: [s.ing.cheese, s.ing.onion] }, MANAGER);
    // 10:00 the cheese shelf: 99 kg (the till says 100 kg: 1 kg is missing).
    s.r.saveStockCountLines(s.db, { countId: c.id, lines: [{ ingredientId: s.ing.cheese, countedQty: 99_000 }] }, MANAGER);
    // 10:30 a pizza is sent (60 g of cheese, 10 g of onion) — and made.
    s.clock('2026-09-21T10:30:00.000Z');
    s.send([['fajitaM', 1]]);
    // 10:45 the onions, counted after the pizza: nothing to carry.
    s.clock('2026-09-21T10:45:00.000Z');
    s.r.saveStockCountLines(s.db, { countId: c.id, lines: [{ ingredientId: s.ing.onion, countedQty: 99_990 }] }, MANAGER);
    s.clock('2026-09-21T11:00:00.000Z');
    const done = s.r.finishStockCount(s.db, c.id, MANAGER).count;
    // The shelf at 11:00 is 99 kg less the pizza's 60 g; the till expected 100 kg less 60 g: the same 1 kg short.
    expect(line(done, s.ing.cheese)).toMatchObject({ countedQty: 98_940, expectedQty: 99_940, tillQty: 99_940, differenceQty: -1_000, differenceCents: -120_000 });
    expect(line(done, s.ing.onion)).toMatchObject({ countedQty: 99_990, expectedQty: 99_990, differenceQty: 0 });
    // This till's count is the shelf at the finish — not the pizza's cheese twice over.
    expect(s.stockOf('cheese')).toBe(98_940);
    // The audit says what was carried, from when.
    const audit = JSON.parse(
      (s.db.prepare(`SELECT after_json AS a FROM audit_log WHERE entity_type = 'stock_counts' AND action = 'stock_count_finish'`).get() as { a: string }).a,
    ) as { lines: Array<{ ingredientId: string; countedAt?: string; movedSince?: number }> };
    expect(audit.lines.find((l) => l.ingredientId === s.ing.cheese)).toMatchObject({ countedAt: '2026-09-21T10:00:00.000Z', movedSince: -60 });
    expect(audit.lines.find((l) => l.ingredientId === s.ing.onion)?.movedSince).toBeUndefined();
    // The next stock take finds the shelf where the till says: nothing wrongly "over", in the stock take or the variance.
    s.clock('2026-09-21T12:00:00.000Z');
    const next = s.stockTake({ cheese: 98_940 });
    expect(line(next, s.ing.cheese)).toMatchObject({ expectedFrom: 'shop', expectedQty: 98_940, differenceQty: 0 });
    const { buildVariance } = await import('../services/analytics/stock-control.js');
    const v = buildVariance(s.db, { fromCountId: c.id, toCountId: next.id, link: { on: false, stale: false, lastHeardAt: null } });
    expect(v.lines.find((l) => l.ingredientId === s.ing.cheese)).toMatchObject({ opening: 98_940, closing: 98_940, unexplained: 0 });
  });

  it('a failure half-way through finishing writes nothing at all', async () => {
    const s = await shop();
    const c = s.r.startStockCount(s.db, { scope: 'custom', ingredientIds: [s.ing.cheese, s.ing.onion] }, MANAGER);
    s.r.saveStockCountLines(s.db, { countId: c.id, lines: [{ ingredientId: s.ing.cheese, countedQty: 90_000 }, { ingredientId: s.ing.onion, countedQty: 90_000 }] }, MANAGER);
    const before = ['stock_movements', 'audit_log', 'sync_queue'].map((t) => s.n(`SELECT COUNT(*) AS n FROM ${t}`));
    // The onion's stock row can't be written (after the cheese's was).
    s.db.exec(`CREATE TEMP TRIGGER boom BEFORE INSERT ON stock_movements WHEN NEW.ingredient_id = '${s.ing.onion}' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    expect(() => s.r.finishStockCount(s.db, c.id, MANAGER)).toThrow(/boom/);
    s.db.exec(`DROP TRIGGER boom`);
    expect(['stock_movements', 'audit_log', 'sync_queue'].map((t) => s.n(`SELECT COUNT(*) AS n FROM ${t}`))).toEqual(before);
    expect([s.stockOf('cheese'), s.stockOf('onion')]).toEqual([100_000, 100_000]);
    expect(s.n(`SELECT COUNT(*) AS n FROM stock_counts WHERE id = ? AND status = 'open' AND finished_at IS NULL`, c.id)).toBe(1);
    expect(s.n(`SELECT COUNT(*) AS n FROM stock_count_lines WHERE stock_count_id = ? AND expected_qty IS NOT NULL`, c.id)).toBe(0);
    // Once it can be written, it finishes whole.
    expect(s.r.finishStockCount(s.db, c.id, MANAGER).count.countedCount).toBe(2);
  });

  it('cancelling writes nothing to stock; a second cancel does nothing', async () => {
    const s = await shop();
    const c = s.r.startStockCount(s.db, { scope: 'custom', ingredientIds: [s.ing.cheese] }, MANAGER);
    s.r.saveStockCountLines(s.db, { countId: c.id, lines: [{ ingredientId: s.ing.cheese, countedQty: 5 }] }, MANAGER);
    expect(s.r.cancelStockCount(s.db, c.id, MANAGER)).toBe(true);
    expect(s.n(`SELECT COUNT(*) AS n FROM stock_movements WHERE reason = 'count'`)).toBe(0);
    expect(s.stockOf('cheese')).toBe(100_000);
    expect(s.n(`SELECT COUNT(*) AS n FROM stock_count_lines WHERE stock_count_id = ? AND (expected_qty IS NOT NULL OR value_cents IS NOT NULL OR movement_id IS NOT NULL)`, c.id)).toBe(0);
    expect(s.r.getStockCount(s.db, c.id, DEV)).toMatchObject({ status: 'cancelled', finishedAt: null, shortCents: null });
    expect(s.n(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'stock_counts' AND action = 'stock_count_cancel'`)).toBe(1);
    const audit = s.n(`SELECT COUNT(*) AS n FROM audit_log`);
    expect(s.r.cancelStockCount(s.db, c.id, MANAGER)).toBe(false);
    expect(s.n(`SELECT COUNT(*) AS n FROM audit_log`)).toBe(audit);
    expect(() => s.r.finishStockCount(s.db, c.id, MANAGER)).toThrow(/cancelled/);
    // A cancelled one is not an anchor: the next stock take expects the till's count.
    const next = s.stockTake({ cheese: 100_000 });
    expect(line(next, s.ing.cheese)).toMatchObject({ expectedFrom: 'till', expectedQty: 100_000 });
    expect(chainOk(s.db)).toBe(true);
  });

  it('the key items, the whole store room, or picked ones; a full one with blanks becomes a part stock take', async () => {
    const s = await shop();
    // Nothing saved yet: the key items the till picked by name as the shop was set up.
    const key = s.r.startStockCount(s.db, { scope: 'key_items' }, MANAGER);
    expect(key.lines.map((l) => l.name).sort()).toEqual(['Test box', 'Test chicken', 'Test dough']);
    s.r.cancelStockCount(s.db, key.id, MANAGER);
    const full = s.r.startStockCount(s.db, { scope: 'full' }, MANAGER);
    expect(full.lineCount).toBe(s.n(`SELECT COUNT(*) AS n FROM ingredients WHERE deleted_at IS NULL AND is_active = 1`));
    // Every line on its shelf.
    expect(line(full, s.ing.cheese).shelf).toBe('cheese');
    expect(() => s.r.finishStockCount(s.db, full.id, MANAGER)).toThrow(/Count at least one item/);
    s.r.saveStockCountLines(s.db, { countId: full.id, lines: [{ ingredientId: s.ing.cheese, countedQty: 100_000 }] }, MANAGER);
    expect(s.r.finishStockCount(s.db, full.id, MANAGER).count).toMatchObject({ scope: 'custom', countedCount: 1 });
    // The owner's own list, even an empty one: then there is nothing to count.
    s.r.saveCostAlertSettings(s.db, { jumpBps: 1_000, impactWeekCents: 100_000, keyIngredientIds: [] }, OWNER);
    expect(() => s.r.startStockCount(s.db, { scope: 'key_items' }, MANAGER)).toThrow(/no key items yet/);
    expect(() => s.r.startStockCount(s.db, { scope: 'custom', ingredientIds: ['no-such-ingredient'] }, MANAGER)).toThrow(/Pick at least one/);
    // The list: newest first.
    const list = s.r.listStockCounts(s.db, DEV);
    expect(list.map((c) => [c.scope, c.status])).toEqual([
      ['custom', 'done'],
      ['key_items', 'cancelled'],
    ]);
  });

  it("the Stock button's stock take is a one-line stock take", async () => {
    const s = await shop();
    s.clock('2026-09-21T06:00:00.000Z');
    const first = s.r.countOneIngredient(s.db, { ingredientId: s.ing.cheese, countedQty: 99_000, notes: '  top shelf ' }, MANAGER);
    expect(first.count).toMatchObject({ scope: 'custom', status: 'done', lineCount: 1, notes: 'top shelf' });
    expect(line(first.count, s.ing.cheese)).toMatchObject({ expectedFrom: 'till', expectedQty: 100_000, differenceQty: -1_000 });
    s.clock('2026-09-21T07:00:00.000Z');
    s.send([['fajitaM', 2]]);
    s.clock('2026-09-21T08:00:00.000Z');
    const second = s.r.countOneIngredient(s.db, { ingredientId: s.ing.cheese, countedQty: 98_880 }, MANAGER);
    expect(line(second.count, s.ing.cheese)).toMatchObject({ expectedFrom: 'shop', expectedQty: 99_000 - 120, differenceQty: 0 });
    expect(s.stockOf('cheese')).toBe(98_880);
    expect(() => s.r.countOneIngredient(s.db, { ingredientId: 'no-such-ingredient', countedQty: 1 }, MANAGER)).toThrow();
    expect(s.n(`SELECT COUNT(*) AS n FROM stock_counts`)).toBe(2);
  });

  it('shop stock added up in SQL is the figure pos-domain gives from the rows one by one (a cancel across the stock take, rows from before costing)', async () => {
    const s = await shop();
    const { shopStockAt, ledgerRowsOf, firstTakesOf, countAnchors } = await import('./stock-ledger-read.js');
    const { shopStockOf } = await import('@cheeseoclock/pos-domain');
    const { settleOrderStock } = await import('./repositories/order-stock-repo.js');
    const ids = [s.ing.cheese, s.ing.onion, s.ing.chicken, s.ing.box];
    s.clock('2026-09-21T06:00:00.000Z');
    const o0 = s.send([['fajitaM', 1]]); // taken before the stock take…
    s.clock('2026-09-21T07:00:00.000Z');
    s.stockTake({ cheese: 100_000, onion: 100_000, chicken: 100_000, box: 1_000 });
    s.clock('2026-09-21T08:00:00.000Z');
    const o1 = s.send([['fajitaM', 2]]);
    s.clock('2026-09-21T09:00:00.000Z');
    // …and settled after it: dated back before the stock take, so already in its count.
    settleOrderStock(s.db, { orderId: o0, how: 'cancelled', statusBefore: 'sent_to_kitchen', foodMade: 'made', approverUserId: MANAGER.userId }, MANAGER);
    settleOrderStock(s.db, { orderId: o1, how: 'cancelled', statusBefore: 'sent_to_kitchen', foodMade: 'made', approverUserId: MANAGER.userId }, MANAGER);
    s.r.recordStockMovement(s.db, { ingredientId: s.ing.box, deltaQty: 20, reason: 'adjustment', notes: 'Found a sleeve' }, MANAGER);
    // o1's settle rows as a till from before costing wrote them (no ref_taken_at): dated by its first take.
    s.db.prepare(`UPDATE stock_movements SET ref_taken_at = NULL WHERE ref_order_id = ? AND NOT (reason = 'sale' AND delta_qty < 0)`).run(o1);
    s.clock('2026-09-21T10:00:00.000Z');
    const at = new Date().toISOString();
    const ings = ids.map((id) => {
      const row = s.db.prepare(`SELECT unit, current_qty AS q FROM ingredients WHERE id = ?`).get(id) as { unit: string; q: number };
      return { id, unit: row.unit, currentQty: Number(row.q) };
    });
    const sql = shopStockAt(s.db, ings, at);
    const anchors = countAnchors(s.db, ids, at);
    for (const i of ings) {
      const anchor = anchors.get(i.id)!;
      const rows = ledgerRowsOf(s.db, i.id, anchor.finishedAt);
      const pure = shopStockOf({ unitNow: i.unit, anchor, tillQty: i.currentQty, rows, atIso: at, firstTakeOf: firstTakesOf(s.db, rows) });
      expect({ id: i.id, shop: sql.get(i.id) }).toEqual({ id: i.id, shop: pure });
    }
    // Made food is gone (o1: 2 × 60 g cheese); o0's was already out of the count; the box sleeve is in.
    expect(sql.get(s.ing.cheese)).toEqual({ qty: 100_000 - 120, from: 'shop', unconvertible: false });
    expect(sql.get(s.ing.box)).toEqual({ qty: 1_000 - 2 + 20, from: 'shop', unconvertible: false });
  });

  it("shop stock includes the other till's rows and leaves 'count' rows out", async () => {
    const s = await shop();
    const { listPendingSync, pendingToChange, markSyncedIds, applyRemoteBatch } = s.r;
    const iAm = (db: AppDatabase, id: string) =>
      db.prepare(`INSERT INTO device_info (id, device_id, display_name, registered_at) VALUES ('singleton', ?, ?, ?)`).run(id, id, new Date().toISOString());
    const b = openMigrated();
    const user = b.prepare(`INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, 'x', 'x', ?)`);
    user.run(CASHIER.userId, 'Test Cashier', 'cashier', DEV);
    user.run(MANAGER.userId, 'Test Manager', 'manager', DEV);
    user.run(OWNER.userId, 'Test Owner', 'admin', DEV);
    iAm(s.db, DEV);
    iAm(b, TILL_2);
    const push = async (from: AppDatabase, fromDevice: string, to: AppDatabase) => {
      const pending = listPendingSync(from, 1_000_000);
      const res = await applyRemoteBatch(to, pending.map((p) => pendingToChange(p, fromDevice)), { pause: async () => {} });
      markSyncedIds(from, pending.map((p) => p.id));
      return res;
    };
    s.clock('2026-09-21T06:00:00.000Z');
    s.stockTake({ cheese: 100_000 });
    expect(await push(s.db, DEV, b)).toMatchObject({ waiting: 0, dropped: 0 });

    // The other till sells a pizza (60 g cheese) and books a one-off count on its own count.
    s.clock('2026-09-21T07:00:00.000Z');
    const other = { userId: CASHIER.userId, deviceId: TILL_2 };
    const o = s.r.createOrder(b, { mode: 'takeaway' }, other);
    s.r.addOrderItem(b, { orderId: o.id, menuItemId: s.item.fajitaM, quantity: 1, modifierIds: [], notes: null }, other);
    s.r.sendOrderToKitchen(b, o.id, other);
    s.r.recordStockMovement(b, { ingredientId: s.ing.cheese, deltaQty: 500, reason: 'count' }, { userId: MANAGER.userId, deviceId: TILL_2 });
    expect(await push(b, TILL_2, s.db)).toMatchObject({ waiting: 0, dropped: 0 });
    // This till's own count is untouched by the other till's sale.
    expect(s.stockOf('cheese')).toBe(100_000);

    s.clock('2026-09-21T09:00:00.000Z');
    const next = s.stockTake({ cheese: 99_900 });
    expect(line(next, s.ing.cheese)).toMatchObject({ expectedFrom: 'shop', expectedQty: 100_000 - 60, tillQty: 100_000, differenceQty: -40 });
  });
});

live('the key items: one list, on the ingredients (Phase 6 + Phase 8)', () => {
  it('migration 0038 moves a saved list onto the ingredients, and ticks the till’s suggestions where none was saved', () => {
    const names = ['Mozzarella', 'Cheese Mix', 'Cheese  mix', 'Chicken Tikka', 'Beef Patty', 'Patties (frozen)', 'Pan Pizza Dough', 'Flour', 'Cooking Oil', 'Pizza Box 12"', 'Boxes', 'Burger Foil', 'Boiled Egg', 'Chickenpox', 'Boxing gloves', 'Onion', 'Cheddar'];
    const fill = (saved: string | null) => {
      const db = openMigrated({ stopBefore: '0038' });
      const ins = db.prepare(`INSERT INTO ingredients (id, name, unit, current_qty, low_threshold, created_at, updated_at, device_id) VALUES (?, ?, 'g', 0, 0, 'x', 'x', 'd')`);
      names.forEach((name, i) => ins.run(`i${i}`, name));
      if (saved !== null) {
        db.prepare(`INSERT INTO business_settings (id, key, value_json, created_at, updated_at, device_id) VALUES ('b1', 'costing.alerts', ?, 'x', 'x', 'd')`).run(saved);
      }
      db.exec(readFileSync(join(MIGRATIONS, '0038_stock_counts.sql'), 'utf8'));
      return new Map((db.prepare(`SELECT name, count_weekly AS k FROM ingredients`).all() as Array<{ name: string; k: number }>).map((r) => [r.name, r.k === 1]));
    };
    // Nothing saved: exactly the till's suggestions by name (pos-domain's rule, whole words).
    const suggested = fill(null);
    for (const name of names) expect({ name, key: suggested.get(name) }).toEqual({ name, key: suggestedKeyIngredient(name) });
    // A saved list is the list, whatever the names say.
    const saved = fill(JSON.stringify({ jumpBps: 1_000, impactWeekCents: 100_000, keyIngredientIds: ['i16', 'i13'] }));
    expect([...saved].filter(([, k]) => k).map(([n]) => n).sort()).toEqual(['Chickenpox', 'Cheddar'].sort());
    // A saved list that is empty stays empty.
    const empty = fill(JSON.stringify({ jumpBps: 1_000, impactWeekCents: 100_000, keyIngredientIds: [] }));
    expect([...empty.values()].some(Boolean)).toBe(false);
    // Anything unreadable is not a saved list: the suggestions.
    const broken = fill('{not json');
    expect(broken.get('Mozzarella')).toBe(true);
  });

  it('saving the price alerts writes the key items onto the ingredients (each synced and audited); everything reads that list', async () => {
    const s = await shop();
    // Nothing saved: a new ingredient named like a key item is one.
    const flour = s.r.createIngredient(s.db, { name: 'Test flour', unit: 'g' }, MANAGER);
    expect(flour.countWeekly).toBe(true);
    const syncBefore = s.n(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'ingredients'`);
    s.r.saveCostAlertSettings(s.db, { jumpBps: 1_500, impactWeekCents: 50_000, keyIngredientIds: [s.ing.cheese, s.ing.chicken, 'no-such-ingredient'] }, OWNER);
    const keys = (s.db.prepare(`SELECT id FROM ingredients WHERE count_weekly = 1 ORDER BY name`).all() as Array<{ id: string }>).map((r) => r.id);
    expect(keys.sort()).toEqual([s.ing.cheese, s.ing.chicken].sort());
    // Changed: cheese on; box, dough, flour off (chicken was already one). Each its row, sync entry and audit row.
    expect(s.n(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'ingredients'`) - syncBefore).toBe(4);
    expect(s.n(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'ingredients' AND action IN ('key_item_on', 'key_item_off')`)).toBe(4);
    // The list lives on the ingredients; the setting keeps the thresholds and a copy of the list for a till not yet upgraded.
    const stored = JSON.parse((s.db.prepare(`SELECT value_json AS v FROM business_settings WHERE key = 'costing.alerts'`).get() as { v: string }).v);
    expect(stored).toEqual({ jumpBps: 1_500, impactWeekCents: 50_000, keyIngredientIds: [s.ing.cheese, s.ing.chicken].sort() });
    expect([...s.r.loadAlertSettings(s.db).keyIds].sort()).toEqual([s.ing.cheese, s.ing.chicken].sort());
    // Ticking "Key item" on an ingredient changes the same list.
    s.r.updateIngredient(s.db, { id: s.ing.onion, countWeekly: true }, MANAGER);
    expect(s.r.loadAlertSettings(s.db).keyIds.has(s.ing.onion)).toBe(true);
    expect(s.r.getCostAlertSettings(s.db).ingredients.find((i) => i.ingredientId === s.ing.onion)).toMatchObject({ key: true });
    const weekly = s.r.startStockCount(s.db, { scope: 'key_items' }, MANAGER);
    expect(weekly.lines.map((l) => l.ingredientId).sort()).toEqual([s.ing.cheese, s.ing.chicken, s.ing.onion].sort());
    // Once the owner has picked his list, a new ingredient is not one unless ticked.
    expect(s.r.createIngredient(s.db, { name: 'Test chicken wings', unit: 'g' }, MANAGER).countWeekly).toBe(false);
    expect(s.r.createIngredient(s.db, { name: 'Test garnish', unit: 'g', countWeekly: true }, MANAGER).countWeekly).toBe(true);
    // An old list still inside a saved value (a till not yet upgraded wrote it) is not read.
    s.r.setBusinessSetting(s.db, 'costing.alerts', { jumpBps: 1_500, impactWeekCents: 50_000, keyIngredientIds: [s.ing.box] }, OWNER);
    expect(s.r.loadAlertSettings(s.db).keyIds.has(s.ing.box)).toBe(false);
    expect(chainOk(s.db)).toBe(true);
  });

  it("a till upgraded after the other gets the owner's key items, not the name suggestions: the setting carries a copy", async () => {
    // Till A, upgraded: the owner picks cheese and onion (none of them named like a suggestion).
    const s = await shop();
    const settingJson = () => (s.db.prepare(`SELECT value_json AS v FROM business_settings WHERE key = 'costing.alerts'`).get() as { v: string }).v;
    // Ticking a box before any alert setting is saved writes no setting (new ingredients keep being picked by name).
    s.r.updateIngredient(s.db, { id: s.ing.onion, countWeekly: true }, MANAGER);
    expect(s.n(`SELECT COUNT(*) AS n FROM business_settings WHERE key = 'costing.alerts'`)).toBe(0);
    s.r.saveCostAlertSettings(s.db, { jumpBps: 1_200, impactWeekCents: 80_000, keyIngredientIds: [s.ing.cheese, s.ing.onion] }, OWNER);
    // Exactly the three keys v0.7.16's strict schema reads — so the till still on it keeps the owner's thresholds and list meanwhile.
    expect(Object.keys(JSON.parse(settingJson())).sort()).toEqual(['impactWeekCents', 'jumpBps', 'keyIngredientIds']);

    // Till B, still before 0038: the same ingredients, and the setting row as the link carried it. The ingredients'
    // key ticks never reached it (it had no column for them).
    const tillB = (json: string) => {
      const b = openMigrated({ stopBefore: '0038' });
      const ins = b.prepare(`INSERT INTO ingredients (id, name, unit, current_qty, low_threshold, created_at, updated_at, device_id) VALUES (?, ?, 'g', 0, 0, 'x', 'x', 'd')`);
      for (const r of s.db.prepare(`SELECT id, name FROM ingredients WHERE deleted_at IS NULL`).all() as Array<{ id: string; name: string }>) ins.run(r.id, r.name);
      b.prepare(`INSERT INTO business_settings (id, key, value_json, created_at, updated_at, device_id) VALUES ('b1', 'costing.alerts', ?, 'x', 'x', 'd')`).run(json);
      // …then it is upgraded.
      b.exec(readFileSync(join(MIGRATIONS, '0038_stock_counts.sql'), 'utf8'));
      return (b.prepare(`SELECT id FROM ingredients WHERE count_weekly = 1 ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);
    };
    expect(tillB(settingJson())).toEqual([s.ing.cheese, s.ing.onion].sort());
    // Without the copy it would have ticked the name suggestions (box, chicken, dough): the two tills' lists would differ.
    expect(tillB(JSON.stringify({ jumpBps: 1_200, impactWeekCents: 80_000 }))).toEqual([s.ing.box, s.ing.chicken, s.ing.dough].sort());

    // A "Key item" box ticked on one ingredient keeps the copy up to date, in the same transaction (synced, audited).
    const syncBefore = s.n(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'business_settings'`);
    s.r.updateIngredient(s.db, { id: s.ing.box, countWeekly: true }, MANAGER);
    expect(tillB(settingJson())).toEqual([s.ing.box, s.ing.cheese, s.ing.onion].sort());
    expect(s.n(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'business_settings'`)).toBe(syncBefore + 1);
    // …and a new ingredient made a key item.
    const garnish = s.r.createIngredient(s.db, { name: 'Test garnish', unit: 'g', countWeekly: true }, MANAGER).id;
    expect(JSON.parse(settingJson()).keyIngredientIds).toContain(garnish);
    // Nothing changed about the list: nothing written.
    const audit = s.n(`SELECT COUNT(*) AS n FROM audit_log`);
    s.r.updateIngredient(s.db, { id: s.ing.box, notes: 'Top shelf' }, MANAGER);
    expect(s.n(`SELECT COUNT(*) AS n FROM audit_log`)).toBe(audit + 1);
    // This till never reads the copy: its list is the ingredients'.
    expect([...s.r.loadAlertSettings(s.db).keyIds].sort()).toEqual([s.ing.box, s.ing.cheese, s.ing.onion, garnish].sort());
    expect(chainOk(s.db)).toBe(true);
  });
});
