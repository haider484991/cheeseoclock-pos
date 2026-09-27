/**
 * Costing, Phase 2 — true food cost from today (cost snapshots at sale
 * time), against a real database built from every migration (0033 included):
 *
 *   - a sale keeps its cost when its stock leaves (decrementForOrder), one
 *     'base' row per line plus one per choice with recipe lines, valued
 *     exactly (deals, veggie picks, leave-outs, paid extras, dips, a guessed
 *     price, a missing price, no recipe), and each stock row keeps its value;
 *   - idempotent: four calls give one set of rows; two tills costing the
 *     same order while the link is down converge on the SAME rows by id;
 *   - a later price change never moves an earlier period's food cost;
 *     orders from before costing are estimated (at the price in force when
 *     they took their stock, costing Phase 4), labelled;
 *   - a cancel "not made" nets the order to exactly Rs 0 at the ORIGINAL
 *     cost; "made" books the waste at what the take cost; a sealed drink
 *     put back plus the waste add up to the take;
 *   - batches, deliveries and waste by hand carry their values and reasons;
 *   - Reports: food sales, known / missing and the food cost reconcile with
 *     the stored orders; food sent out unpaid and stale board orders are
 *     their own lines; a costing failure is 'failed' and the stock is still
 *     taken.
 *
 * node:sqlite behind better-sqlite3's shape (costing-shop.fixture.ts); skips
 * where node:sqlite is missing. EVERY PRICE IS MADE UP (costing spec D11).
 */
import { describe, expect, it, vi } from 'vitest';
import { BASE_PART, totalsByIngredient, expandRecipe, type PickedChoice, type RecipeLine } from '@cheeseoclock/pos-domain';
import type { AppDatabase } from './connection.js';
import { CASHIER, DEV, DatabaseSync, MANAGER, openCostingShop, openMigrated, type Line } from './costing-shop.fixture.js';
import { verifyAuditChain, type AuditChainRow } from './audit-chain.js';

// Builds a real database from every migration per test: seconds on a slow CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const live = describe.skipIf(!DatabaseSync);

const n = (db: AppDatabase, sql: string, ...p: unknown[]) =>
  Number((db.prepare(sql).get(...p) as { n: number } | undefined)?.n ?? 0);

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

/** A shop with the order and stock repositories the till calls. */
async function shop(db: AppDatabase = openMigrated()) {
  const s = await openCostingShop(db);
  const more = {
    ...(await import('./repositories/order-stock-repo.js')),
    ...(await import('./repositories/procurement-repo.js')),
    ...(await import('./repositories/shift-repo.js')),
    ...(await import('./repositories/stock-movement-repo.js')),
    ...(await import('./repositories/order-repo.js')),
  };
  const { getBusinessReport } = await import('../services/business-report.js');
  more.openShift(db, { openingCashCents: 0 }, MANAGER);
  /** orders:sendToKitchen — stock leaves, the sale keeps its cost. */
  const send = (orderId: string) => more.sendOrderToKitchen(db, orderId, CASHIER);
  /** Ring and send. */
  const sell = (lines: Line[]) => {
    const o = s.ring(lines);
    send(o);
    return o;
  };
  /** The cost rows an order kept, per line (in the till's order) and part. */
  const costRows = (orderId: string) =>
    db
      .prepare(
        `SELECT c.id, c.order_item_id AS lineId, c.part, c.modifier_id AS modifierId, c.line_qty AS qty,
                c.cost_cents AS cost, c.status, c.missing_lines AS missing, c.estimate_lines AS estimates
           FROM order_item_costs c JOIN order_items oi ON oi.id = c.order_item_id
          WHERE c.order_id = ? ORDER BY oi.created_at, oi.id, c.part = 'base' DESC, c.rowid`,
      )
      .all(orderId) as Array<{
      id: string;
      lineId: string;
      part: string;
      modifierId: string | null;
      qty: number;
      cost: number;
      status: string;
      missing: number;
      estimates: number;
    }>;
  const lineIds = (orderId: string) =>
    (db.prepare(`SELECT id FROM order_items WHERE order_id = ? ORDER BY created_at, id`).all(orderId) as Array<{ id: string }>).map(
      (r) => r.id,
    );
  /** The order's stock rows, net per reason. */
  const valueOf = (orderId: string, reason?: string) =>
    n(
      db,
      `SELECT COALESCE(SUM(value_cents), 0) AS n FROM stock_movements WHERE ref_order_id = ? ${reason ? 'AND reason = ?' : ''}`,
      ...(reason ? [orderId, reason] : [orderId]),
    );
  /** Test-only: an order from before costing started (no cost kept, its rows carry no value). */
  const asBeforeCosting = (orderId: string) => {
    db.prepare(`DELETE FROM order_item_costs WHERE order_id = ?`).run(orderId);
    db.prepare(`UPDATE stock_movements SET value_cents = NULL, unit_cost_mc = NULL, cost_basis = NULL WHERE ref_order_id = ?`).run(orderId);
  };
  const report = (sinceIso: string, untilIso: string, now = new Date()) => getBusinessReport(db, { sinceIso, untilIso }, now);
  return { db, ...s, r: { ...s.r, ...more }, send, sell, costRows, lineIds, valueOf, asBeforeCosting, report };
}

const AUG_15 = new Date('2026-08-15T10:00:00.000Z');
const AUGUST = { since: '2026-08-01T00:00:00.000Z', until: '2026-09-01T00:00:00.000Z' };

// ---------------------------------------------------------------------------
// The cost a sale keeps
// ---------------------------------------------------------------------------

live('a sale keeps its cost when its stock leaves', () => {
  it('deals, veggie picks, leave-outs, paid extras, dips, guesses, no price and no recipe: exact rows', async () => {
    const s = await shop();
    const o = s.sell([
      ['fajitaM', 2, ['noOnion', 'extraOnion', 'extraCheese']],
      ['deal', 1, ['d1Fajita', 'd2Veggie', 'dealNoOnion', 'sideRanch']],
      ['veggieL', 1, ['pickOnion', 'pickPepper', 'pickOlive', 'pickMushroom', 'pickCorn', 'dipChili']],
      ['cola', 2],
      ['bakedWings', 1],
      ['crispyWings', 1],
    ]);
    const [fajita, deal, veggie, cola, wings, crispy] = s.lineIds(o) as [string, string, string, string, string, string];
    const lines = s.lineIds(o);
    /** Rows in the till's line order, 'base' first, then by part (the order picks are stored in is not the point). */
    const sorted = (xs: Array<Array<string | number>>) =>
      [...xs].sort((x, y) => lines.indexOf(String(x[0])) - lines.indexOf(String(y[0])) || (x[1] === 'base' ? -1 : y[1] === 'base' ? 1 : String(x[1]).localeCompare(String(y[1]))));
    const rows = sorted(s.costRows(o).map((r) => [r.lineId, r.part === BASE_PART ? 'base' : r.part, r.qty, r.cost, r.status, r.missing, r.estimates]));
    const c = s.choice;
    // Made-up prices (costing-shop.fixture.ts): dough 9 p/g, cheese 120 p/g,
    // chicken 90 p/g, onion 15 p/g, sauce rolled up from tomato + garlic
    // (Rs 356.25 a 2 kg batch), box Rs 40. Each row: its lines in millicents,
    // rounded once. The "No onion" pick has no row of its own.
    expect(rows).toEqual(sorted([
      // 400 g dough 3,600 + 100 g sauce 1,781.25 + 120 g cheese 14,400 + 80 g chicken 7,200 + 2 boxes 8,000 (no onion)
      [fajita, 'base', 2, 34_981, 'full', 0, 0],
      [fajita, c.extraOnion, 2, 300, 'full', 0, 0], // the paid extra keeps its onion: 20 g
      [fajita, c.extraCheese, 2, 9_600, 'full', 0, 0],
      [deal, 'base', 1, 0, 'full', 0, 0], // nothing is in every deal
      [deal, c.d1Fajita, 1, 24_325, 'full', 0, 0], // its onion left out by the deal's "No onion"
      [deal, c.d2Veggie, 1, 20_575, 'full', 0, 0],
      [deal, c.sideRanch, 1, 1_755, 'full', 0, 0],
      [veggie, 'base', 1, 18_925, 'full', 0, 0],
      [veggie, c.pickOnion, 1, 150, 'full', 0, 0],
      [veggie, c.pickPepper, 1, 300, 'full', 0, 0],
      [veggie, c.pickOlive, 1, 1_200, 'full', 0, 0],
      [veggie, c.pickMushroom, 1, 800, 'full', 0, 0],
      [veggie, c.pickCorn, 1, 400, 'full', 0, 0],
      [veggie, c.dipChili, 1, 1_255, 'full', 0, 0],
      [cola, 'base', 2, 0, 'partial', 1, 0], // the bottle has no price yet
      [wings, 'base', 1, 0, 'none', 0, 0], // no recipe at all
      [crispy, 'base', 1, 14_500, 'full', 0, 1], // breading is a guess; salt is free
    ]));
    // Name-based ids: the same on every till, for every call.
    expect(s.costRows(o).every((r) => r.id === s.r.saleCostId(r.lineId, r.part))).toBe(true);

    // Each stock row keeps its value at the price it left at: a take is negative.
    const moves = s.db
      .prepare(`SELECT ingredient_id AS ing, delta_qty AS q, value_cents AS v, unit_cost_mc AS mc, cost_basis AS basis FROM stock_movements WHERE ref_order_id = ?`)
      .all(o) as Array<{ ing: string; q: number; v: number; mc: number | null; basis: string }>;
    const cheese = moves.find((m) => m.ing === s.ing.cheese)!;
    // 120 g + 80 g extra on the two Fajitas, 90 g on each deal pizza, 90 g on the Veggie Lovers.
    expect(cheese).toMatchObject({ q: -(120 + 80 + 180 + 90), v: -(470 * 120), mc: 120_000, basis: 'price' });
    expect(moves.find((m) => m.ing === s.ing.bottle)).toMatchObject({ q: -2, v: 0, mc: null, basis: 'none' });
    expect(moves.find((m) => m.ing === s.ing.salt)).toMatchObject({ q: -2, v: 0, mc: 0, basis: 'price' });
    // The sauce, made in-house, at its rolled-up price: round(345 × 35,625 ÷ 2,000).
    expect(moves.find((m) => m.ing === s.ing.sauce)).toMatchObject({ q: -(100 + 160 + 80), v: -6_056, basis: 'price' });

    // What the rows kept and what the stock rows are worth agree to within a paisa a row.
    const kept = s.costRows(o).reduce((t, r) => t + r.cost, 0);
    expect(Math.abs(kept + s.valueOf(o)) <= s.costRows(o).length).toBe(true);
    expect(chainOk(s.db)).toBe(true);
  });

  it('decrementForOrder is the same rule as before: every Phase 1 fixture takes the same stock', async () => {
    const s = await shop();
    const recipe = s.db.prepare(
      `SELECT r.ingredient_id, r.qty_per_unit, r.modifier_id FROM recipes r
         JOIN ingredients i ON i.id = r.ingredient_id AND i.deleted_at IS NULL
        WHERE r.menu_item_id = ? AND r.deleted_at IS NULL`,
    );
    const picks = s.db.prepare(
      `SELECT oim.modifier_id, oim.price_delta_cents, m.removes_ingredient_id
         FROM order_item_modifiers oim JOIN modifiers m ON m.id = oim.modifier_id
        WHERE oim.order_item_id = ? AND oim.deleted_at IS NULL`,
    );
    for (const lines of [
      [['veggieL', 2, ['pickOnion', 'pickPepper', 'pickOlive', 'pickMushroom', 'pickCorn', 'dipChili']]],
      [['deal', 1, ['d1Fajita', 'd2Fajita', 'dealNoOnion', 'sideRanch']]],
      [['fajitaM', 1, ['noOnion', 'extraOnion', 'extraCheese']]],
      [['veggieL', 1, ['pickOnion', 'pickJalapeno', 'dipRanch', 'noOnion', 'extraCheese']]],
      [['fajitaM', 3], ['cola', 2], ['bakedWings', 1]],
    ] as Line[][]) {
      const o = s.sell(lines);
      const expected = new Map<string, number>();
      for (const line of s.db
        .prepare(`SELECT id, menu_item_id, quantity FROM order_items WHERE order_id = ?`)
        .all(o) as Array<{ id: string; menu_item_id: string; quantity: number }>) {
        const r = (recipe.all(line.menu_item_id) as Array<{ ingredient_id: string; qty_per_unit: number; modifier_id: string | null }>).map(
          (x): RecipeLine => ({ ingredientId: x.ingredient_id, qtyPerUnit: x.qty_per_unit, modifierId: x.modifier_id }),
        );
        const p = (picks.all(line.id) as Array<{ modifier_id: string; price_delta_cents: number; removes_ingredient_id: string | null }>).map(
          (x): PickedChoice => ({ modifierId: x.modifier_id, priceDeltaCents: x.price_delta_cents, removesIngredientId: x.removes_ingredient_id }),
        );
        for (const [id, q] of totalsByIngredient(expandRecipe(r, p, line.quantity))) expected.set(id, (expected.get(id) ?? 0) + q);
      }
      const actual = new Map(
        (s.db.prepare(`SELECT ingredient_id AS id, -SUM(delta_qty) AS q FROM stock_movements WHERE ref_order_id = ? GROUP BY ingredient_id`).all(o) as Array<{
          id: string;
          q: number;
        }>).map((x) => [x.id, Number(x.q)]),
      );
      expect(actual).toEqual(expected);
    }
  });

  it('called four times (send, pay, hand-over…): one set of rows, the stock taken once', async () => {
    const s = await shop();
    const o = s.sell([['fajitaM', 1], ['deal', 1, ['d1Fajita', 'd2Veggie']]]);
    const rows = s.costRows(o);
    const stock = n(s.db, `SELECT COUNT(*) AS n FROM stock_movements WHERE ref_order_id = ?`, o);
    for (let i = 0; i < 3; i++) s.r.decrementForOrder(s.db, o, CASHIER);
    expect(s.costRows(o)).toEqual(rows);
    expect(n(s.db, `SELECT COUNT(*) AS n FROM stock_movements WHERE ref_order_id = ?`, o)).toBe(stock);
    expect(n(s.db, `SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ? AND action = 'cost_snapshot'`, o)).toBe(1);
    expect(n(s.db, `SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'order_item_costs'`)).toBe(rows.length);
  });

  it('an order with no recipes (Baked Wings and a delivery charge), four calls: one Rs 0 row per line, no stock rows', async () => {
    const s = await shop();
    const o = s.sell([['bakedWings', 2], ['delivery', 1]]);
    for (let i = 0; i < 3; i++) s.r.decrementForOrder(s.db, o, CASHIER);
    expect(s.costRows(o).map((r) => [r.part, r.qty, r.cost, r.status])).toEqual([
      ['base', 2, 0, 'none'],
      ['base', 1, 0, 'none'],
    ]);
    expect(n(s.db, `SELECT COUNT(*) AS n FROM stock_movements WHERE ref_order_id = ?`, o)).toBe(0);
    // Synced as the rows (images), audited once for the order.
    const queued = s.db.prepare(`SELECT payload_json AS p FROM sync_queue WHERE entity_type = 'order_item_costs'`).all() as Array<{ p: string }>;
    expect(queued).toHaveLength(2);
    expect(JSON.parse(queued[0]!.p)).toMatchObject({ orderId: o, part: 'base', status: 'none', costCents: 0 });
    expect(n(s.db, `SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ? AND action = 'cost_snapshot'`, o)).toBe(1);
  });

  it('a costing error keeps a "failed" row for that line, and the stock is still taken', async () => {
    const s = await shop();
    // Bad data from before the quantities were checked: 2.5 g of chicken on a recipe line.
    s.db.prepare(`UPDATE recipes SET qty_per_unit = 2.5 WHERE menu_item_id = ? AND ingredient_id = ?`).run(s.item.crispyWings, s.ing.chicken);
    const before = s.stockOf('breading');
    const o = s.sell([['crispyWings', 1], ['fajitaM', 1]]);
    expect(s.costRows(o).map((r) => [r.part, r.cost, r.status])).toEqual([
      ['base', 0, 'failed'],
      ['base', 17_641, 'full'],
    ]);
    expect(s.stockOf('breading')).toBe(before - 50);
    expect(n(s.db, `SELECT COUNT(*) AS n FROM stock_movements WHERE ref_order_id = ? AND ingredient_id = ?`, o, s.ing.chicken)).toBe(1);
    const audit = s.db.prepare(`SELECT after_json AS a FROM audit_log WHERE entity_id = ? AND action = 'cost_snapshot'`).get(o) as { a: string };
    expect(JSON.parse(audit.a)).toMatchObject({ rows: 2, statuses: { failed: 1, full: 1 }, failed: [{ orderItemId: s.lineIds(o)[0] }] });
  });

  it('an order that took its stock before costing started never keeps a cost later, at today\'s prices', async () => {
    const s = await shop();
    const o = s.sell([['fajitaM', 1]]);
    s.asBeforeCosting(o);
    s.r.decrementForOrder(s.db, o, CASHIER); // paid at hand-over after the upgrade
    expect(s.costRows(o)).toEqual([]);
    expect(n(s.db, `SELECT COUNT(*) AS n FROM stock_movements WHERE ref_order_id = ?`, o)).toBe(6);
  });
});

live('the send path stays quick however long the ledger gets', () => {
  it('its guards find the order\'s own rows (idx_movements_order), never walking every sale in the ledger', async () => {
    const s = await shop();
    const plan = (sql: string) =>
      (s.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('o_x') as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
    const has = plan(s.r.HAS_STOCK_ROWS);
    const before = plan(s.r.TAKEN_BEFORE_COSTING);
    const lines = plan(s.r.LINE_WITHOUT_COST);
    expect(has).toMatch(/SEARCH stock_movements USING (COVERING )?INDEX idx_movements_order \(ref_order_id=\?\)/);
    expect(before).toMatch(/SEARCH stock_movements USING (COVERING )?INDEX idx_movements_order \(ref_order_id=\?\)/);
    expect(lines).toMatch(/SEARCH oi USING (COVERING )?INDEX idx_order_items_order/);
    expect(lines).toMatch(/SEARCH c USING (COVERING )?INDEX idx_order_item_costs_line_part/);
    for (const p of [has, before, lines]) {
      expect(p).not.toMatch(/idx_movements_reason_time/);
      expect(p).not.toMatch(/SCAN (stock_movements|oi|c)( |$)/);
    }
  });

  it('a repeat call on an order with no recipes writes nothing', async () => {
    const s = await shop();
    const o = s.sell([['bakedWings', 1], ['delivery', 1]]);
    const audits = n(s.db, `SELECT COUNT(*) AS n FROM audit_log`);
    const queued = n(s.db, `SELECT COUNT(*) AS n FROM sync_queue`);
    for (let i = 0; i < 3; i++) expect(s.r.decrementForOrder(s.db, o, CASHIER)).toEqual([]);
    expect(n(s.db, `SELECT COUNT(*) AS n FROM audit_log`)).toBe(audits);
    expect(n(s.db, `SELECT COUNT(*) AS n FROM sync_queue`)).toBe(queued);
    expect(s.costRows(o).map((r) => r.status)).toEqual(['none', 'none']);
  });
});

// ---------------------------------------------------------------------------
// Two tills
// ---------------------------------------------------------------------------

live('two tills cost the same order while the link is down', () => {
  it('both keep the SAME rows by id; after syncing each (line, part) has one row, nothing parked', async () => {
    const s = await shop();
    const { listPendingSync, pendingToChange, markSyncedIds, readParked } = await import('./repositories/sync-repo.js');
    const { applyRemoteBatch } = await import('./repositories/apply-remote.js');
    const db2 = openMigrated();
    const user = db2.prepare(
      `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, 'x', 'x', ?)`,
    );
    user.run(CASHIER.userId, 'Test Cashier', 'cashier', DEV);
    user.run(MANAGER.userId, 'Test Manager', 'manager', DEV);
    user.run('u_admin', 'Test Owner', 'admin', DEV);
    const iAm = (db: AppDatabase, id: string) =>
      db.prepare(`INSERT INTO device_info (id, device_id, display_name, registered_at) VALUES ('singleton', ?, ?, ?)`).run(id, id, new Date().toISOString());
    iAm(s.db, DEV);
    iAm(db2, 'till-2');
    const push = async (from: AppDatabase, fromDevice: string, to: AppDatabase) => {
      const pending = listPendingSync(from, 1_000_000);
      const r = await applyRemoteBatch(to, pending.map((p) => pendingToChange(p, fromDevice)), { pause: async () => {} });
      markSyncedIds(from, pending.map((p) => p.id));
      return r;
    };
    // The order is on both tills (rung on till 1, synced), not sent yet.
    const o = s.ring([['fajitaM', 1, ['extraCheese']], ['deal', 1, ['d1Fajita', 'd2Veggie', 'sideRanch']], ['bakedWings', 1]]);
    expect((await push(s.db, DEV, db2)).waiting).toBe(0);

    // Both tills send it before hearing from each other.
    s.r.decrementForOrder(s.db, o, CASHIER);
    s.r.decrementForOrder(db2, o, { userId: MANAGER.userId, deviceId: 'till-2' });
    const rowsOf = (db: AppDatabase) =>
      db.prepare(`SELECT id, order_item_id AS line, part, cost_cents AS cost FROM order_item_costs ORDER BY id`).all() as Array<{
        id: string;
        line: string;
        part: string;
        cost: number;
      }>;
    const one = rowsOf(s.db);
    expect(rowsOf(db2).map((r) => r.id)).toEqual(one.map((r) => r.id));

    expect((await push(db2, 'till-2', s.db)).waiting).toBe(0);
    expect((await push(s.db, DEV, db2)).waiting).toBe(0);
    for (const db of [s.db, db2]) {
      const rows = rowsOf(db);
      expect(rows.map((r) => r.id)).toEqual(one.map((r) => r.id));
      // One row per (line, part).
      expect(new Set(rows.map((r) => `${r.line}|${r.part}`)).size).toBe(rows.length);
      expect(readParked(db)).toEqual([]);
    }
    expect(rowsOf(db2)).toEqual(rowsOf(s.db));
  });
});

// ---------------------------------------------------------------------------
// Settling a cancelled order at what it cost
// ---------------------------------------------------------------------------

live('a cancel settles at what the take cost', () => {
  it('"Not made" after a price change: back at the ORIGINAL cost, the order nets to exactly Rs 0', async () => {
    const s = await shop();
    const o = s.sell([['fajitaM', 3, ['extraCheese']], ['veggieL', 1, ['pickPepper', 'dipRanch']]]);
    const took = s.valueOf(o, 'sale');
    expect(took).toBeLessThan(0);
    const takenAt = (s.db.prepare(`SELECT MIN(occurred_at) AS at FROM stock_movements WHERE ref_order_id = ?`).get(o) as { at: string }).at;
    // Cheese costs twice as much now.
    s.r.updateIngredient(s.db, { id: s.ing.cheese, packSize: 2000, packPriceCents: 480_000 }, MANAGER);
    s.r.voidOrder(s.db, { orderId: o, reason: 'Test cancel', approverUserId: MANAGER.userId, foodMade: 'not_made' }, CASHIER);
    expect(s.valueOf(o)).toBe(0);
    const back = s.db
      .prepare(`SELECT value_cents AS v, cost_basis AS basis, detail, ref_taken_at AS at FROM stock_movements WHERE ref_order_id = ? AND delta_qty > 0`)
      .all(o) as Array<{ v: number; basis: string; detail: string; at: string }>;
    expect(back.reduce((t, r) => t + r.v, 0)).toBe(-took);
    expect(new Set(back.map((r) => `${r.basis} ${r.detail} ${r.at}`))).toEqual(new Set([`take cancel_put_back ${takenAt}`]));
    // Per ingredient too: every put-back is exactly its take.
    const net = s.db
      .prepare(`SELECT ingredient_id, SUM(value_cents) AS v FROM stock_movements WHERE ref_order_id = ? GROUP BY ingredient_id`)
      .all(o) as Array<{ v: number }>;
    expect(net.every((r) => Number(r.v) === 0)).toBe(true);
  });

  it('"Made": the waste is worth what the take cost; a sealed drink put back plus the waste add up to the take', async () => {
    const s = await shop();
    // The 345 ml bottle gets a (made-up) price, on the Drinks shelf.
    s.r.updateIngredient(s.db, { id: s.ing.bottle, costPerUnitCents: 5_000, priceKind: 'set', category: 'drinks' }, MANAGER);
    const o = s.sell([['fajitaM', 1], ['cola', 2]]);
    const took = -s.valueOf(o, 'sale');
    expect(took).toBe(17_641 + 10_000);
    s.r.markOrderReady(s.db, o, CASHIER);
    // Takeaway, never collected: the food was made, the bottles are still sealed (they go back by default).
    s.r.voidOrder(s.db, { orderId: o, reason: 'Not collected', approverUserId: MANAGER.userId, foodMade: 'made' }, CASHIER);
    const waste = -s.valueOf(o, 'waste');
    const drinkBack = n(s.db, `SELECT SUM(value_cents) AS n FROM stock_movements WHERE ref_order_id = ? AND ingredient_id = ? AND delta_qty > 0`, o, s.ing.bottle);
    expect(waste).toBe(17_641);
    expect(drinkBack).toBe(10_000);
    expect(drinkBack + waste).toBe(took);
    expect(s.valueOf(o, 'sale')).toBe(0);
    expect(
      new Set(
        (s.db.prepare(`SELECT DISTINCT detail FROM stock_movements WHERE ref_order_id = ? AND reason = 'waste'`).all(o) as Array<{ detail: string }>).map(
          (r) => r.detail,
        ),
      ),
    ).toEqual(new Set(['cancel_made']));
    // The dialog and Order History read the same figure.
    expect(s.r.getOrderStockStatus(s.db, o, DEV, Date.now())).toMatchObject({ state: 'wasted', wasteCents: 17_641 });
  });

  it('bad data (2.5 g of chicken on a recipe line, so its take has no value): cancel either way, or refund — it still nets to its take', async () => {
    /** Per ingredient: the order's 'sale' rows net (quantity, value) — 0 once settled. */
    const saleNet = (s: Awaited<ReturnType<typeof shop>>, o: string) =>
      (
        s.db
          .prepare(
            `SELECT ingredient_id AS ing, SUM(delta_qty) AS q, COALESCE(SUM(value_cents), 0) AS v
               FROM stock_movements WHERE ref_order_id = ? AND reason = 'sale' GROUP BY ingredient_id`,
          )
          .all(o) as Array<{ ing: string; q: number; v: number }>
      ).map((r) => [Number(r.q), Number(r.v)]);
    for (const how of ['void not_made', 'void made', 'refund made'] as const) {
      const s = await shop();
      s.db.prepare(`UPDATE recipes SET qty_per_unit = 2.5 WHERE menu_item_id = ? AND ingredient_id = ?`).run(s.item.crispyWings, s.ing.chicken);
      const lines: Line[] = [['crispyWings', 1], ['fajitaM', 1]];
      let o: string;
      if (how === 'refund made') {
        // orders:tender — paid up front, then the stock leaves.
        o = s.ring(lines);
        const total = s.r.findOrder(s.db, o)!.totalCents;
        s.r.tenderOrder(s.db, { orderId: o, payments: [{ method: 'cash', amountCents: total, tenderedCents: total }] }, CASHIER);
        s.r.decrementForOrder(s.db, o, CASHIER);
      } else o = s.sell(lines);
      // The chicken (40 g on the Fajita + 2.5 g) left in one row with no value; the rest kept theirs.
      const chicken = s.db
        .prepare(`SELECT delta_qty AS q, value_cents AS v FROM stock_movements WHERE ref_order_id = ? AND ingredient_id = ?`)
        .get(o, s.ing.chicken) as { q: number; v: number | null };
      expect(chicken).toEqual({ q: -42.5, v: null });
      const took = s.valueOf(o, 'sale');
      expect(took).toBeLessThan(0);
      // The cancel dialog reads it.
      expect(s.r.getOrderStockStatus(s.db, o, DEV, Date.now())).toMatchObject({ state: 'out' });

      if (how === 'refund made') {
        s.r.refundOrder(s.db, { orderId: o, reason: 'Test refund', approverUserId: MANAGER.userId, foodMade: 'made' }, CASHIER);
        expect(s.r.findOrder(s.db, o)).toMatchObject({ status: 'refunded' });
      } else {
        const foodMade = how === 'void made' ? 'made' : 'not_made';
        s.r.voidOrder(s.db, { orderId: o, reason: 'Test cancel', approverUserId: MANAGER.userId, foodMade }, CASHIER);
        expect(s.r.findOrder(s.db, o)).toMatchObject({ status: 'void' });
      }
      // Every ingredient's sale nets to nothing, in quantity and in value.
      expect(saleNet(s, o).every(([q, v]) => q === 0 && v === 0)).toBe(true);
      if (how === 'void not_made') {
        expect(s.valueOf(o)).toBe(0);
        expect(n(s.db, `SELECT COUNT(*) AS n FROM stock_movements WHERE ref_order_id = ? AND reason = 'waste'`, o)).toBe(0);
      } else {
        // Made: the waste is worth exactly what the valued part of the take cost; the chicken's has no value.
        expect(s.valueOf(o, 'waste')).toBe(took);
        const wasteChicken = s.db
          .prepare(`SELECT delta_qty AS q, value_cents AS v FROM stock_movements WHERE ref_order_id = ? AND ingredient_id = ? AND reason = 'waste'`)
          .get(o, s.ing.chicken) as { q: number; v: number | null };
        expect(wasteChicken).toEqual({ q: -42.5, v: null });
        expect(s.r.getOrderStockStatus(s.db, o, DEV, Date.now())).toMatchObject({ state: 'wasted', wasteCents: -took });
      }
      expect(chainOk(s.db)).toBe(true);
    }
  });

  it('bad data on an ingredient with no price (half a bottle): its Rs 0 take splits without refusing', async () => {
    const s = await shop();
    s.db.prepare(`UPDATE recipes SET qty_per_unit = 0.5 WHERE menu_item_id = ? AND ingredient_id = ?`).run(s.item.cola, s.ing.bottle);
    const o = s.sell([['cola', 1], ['fajitaM', 1]]);
    expect(
      s.db.prepare(`SELECT delta_qty AS q, value_cents AS v, cost_basis AS basis FROM stock_movements WHERE ref_order_id = ? AND ingredient_id = ?`).get(o, s.ing.bottle),
    ).toEqual({ q: -0.5, v: 0, basis: 'none' });
    expect(s.r.getOrderStockStatus(s.db, o, DEV, Date.now())).toMatchObject({ state: 'out', estCostCents: 17_641 });
    s.r.voidOrder(s.db, { orderId: o, reason: 'Test cancel', approverUserId: MANAGER.userId, foodMade: 'not_made' }, CASHIER);
    expect(s.valueOf(o)).toBe(0);
    expect(n(s.db, `SELECT SUM(delta_qty) AS n FROM stock_movements WHERE ref_order_id = ? AND ingredient_id = ?`, o, s.ing.bottle)).toBe(0);
  });

  it('waste by reason counts the times as the owner does: cancelled food in orders, waste by hand in entries', async () => {
    const s = await shop();
    for (let i = 0; i < 2; i++) {
      const o = s.sell([['fajitaM', 1]]);
      s.r.voidOrder(s.db, { orderId: o, reason: 'Test cancel', approverUserId: MANAGER.userId, foodMade: 'made' }, CASHIER);
    }
    for (let i = 0; i < 2; i++) {
      s.r.recordStockMovement(s.db, { ingredientId: s.ing.cheese, deltaQty: -30, reason: 'waste', wasteReason: 'burnt' }, MANAGER);
    }
    const f = s.report(new Date(Date.now() - 3_600_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString()).foodCost!;
    // Two pizzas of six ingredient rows each: 2 times, not 12.
    expect(n(s.db, `SELECT COUNT(*) AS n FROM stock_movements WHERE reason = 'waste' AND ref_order_id IS NOT NULL`)).toBe(12);
    expect(f.wasteByReason).toEqual([
      { reason: 'cancelled_made', times: 2, cents: 2 * 17_641 },
      { reason: 'burnt', times: 2, cents: 2 * 3_600 },
    ]);
  });

  it('a late cancel\'s waste stays on the day of the sale', async () => {
    const s = await shop();
    const o = s.sell([['fajitaM', 1]]);
    s.db.prepare(`UPDATE orders SET created_at = '2026-08-15T09:00:00.000Z' WHERE id = ?`).run(o);
    s.db.prepare(`UPDATE stock_movements SET occurred_at = '2026-08-15T09:01:00.000Z' WHERE ref_order_id = ?`).run(o);
    s.r.voidOrder(s.db, { orderId: o, reason: 'Test cancel', approverUserId: MANAGER.userId, foodMade: 'made' }, CASHIER);
    const aug15 = s.report('2026-08-15T00:00:00.000Z', '2026-08-16T00:00:00.000Z').foodCost!;
    expect(aug15).toMatchObject({ wasteCents: 17_641, cancelledWasteCents: 17_641, cancelledOrderCount: 1, costOfSalesCents: 0 });
    // One order's cancelled food (six ingredient rows) is ONE time.
    expect(aug15.wasteByReason).toEqual([{ reason: 'cancelled_made', times: 1, cents: 17_641 }]);
    const today = s.report(new Date(Date.now() - 3_600_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString()).foodCost!;
    expect(today).toMatchObject({ wasteCents: 0, cancelledOrderCount: 0 });
  });
});

// ---------------------------------------------------------------------------
// Batches, deliveries, waste by hand
// ---------------------------------------------------------------------------

live('every other stock row keeps its value', () => {
  it('a batch: inputs at their price, what it made worth exactly their total, one group', async () => {
    const s = await shop();
    s.r.makeBatch(s.db, { ingredientId: s.ing.sauce, amount: 1500 }, MANAGER);
    const rows = s.db
      .prepare(`SELECT ingredient_id AS ing, delta_qty AS q, value_cents AS v, cost_basis AS basis, detail, ref_group_id AS g, unit_cost_mc AS mc FROM stock_movements ORDER BY rowid`)
      .all() as Array<{ ing: string; q: number; v: number; basis: string; detail: string; g: string; mc: number }>;
    // 1,875 g tomato at 12 p/g, 94 g garlic at 45 p/g.
    expect(rows.map((r) => [r.ing, r.q, r.v, r.basis, r.detail])).toEqual([
      [s.ing.tomato, -1875, -22_500, 'price', 'batch_in'],
      [s.ing.garlic, -94, -4_230, 'price', 'batch_in'],
      [s.ing.sauce, 1500, 26_730, 'batch', 'batch_out'],
    ]);
    expect(new Set(rows.map((r) => r.g)).size).toBe(1);
    expect(rows[2]!.mc).toBe(17_820); // 26,730 ÷ 1,500 g, in millicents per gram
    expect(rows.reduce((t, r) => t + r.v, 0)).toBe(0);
  });

  it('a delivery at its purchase order line\'s price; waste by hand with its reason; a stock take and a fix say what they are', async () => {
    const s = await shop();
    const sup = s.r.createSupplier(s.db, { name: 'Test Supplier' }, MANAGER);
    const po = s.r.createPurchaseOrder(s.db, { supplierId: sup.id, items: [{ ingredientId: s.ing.cheese, qtyOrdered: 2000, unitCostCents: 115 }] }, MANAGER);
    // Received at the bill, the usual price kept (said so: a bill within 10% becomes the price by default, costing Phase 5).
    s.r.receiveDelivery(s.db, { purchaseOrderId: po.id, updateCosts: false, receipts: [{ purchaseOrderItemId: po.items[0]!.id, qtyReceivedNow: 2000 }] }, MANAGER);
    s.r.recordStockMovement(s.db, { ingredientId: s.ing.cheese, deltaQty: -30, reason: 'waste', wasteReason: 'burnt' }, MANAGER);
    s.r.recordStockMovement(s.db, { ingredientId: s.ing.dough, deltaQty: -100, reason: 'waste' }, MANAGER);
    s.r.recordStockMovement(s.db, { ingredientId: s.ing.onion, deltaQty: -5, reason: 'count' }, MANAGER);
    s.r.recordStockMovement(s.db, { ingredientId: s.ing.onion, deltaQty: 3, reason: 'adjustment' }, MANAGER);
    const rows = s.db
      .prepare(`SELECT reason, delta_qty AS q, value_cents AS v, unit_cost_mc AS mc, cost_basis AS basis, detail FROM stock_movements ORDER BY rowid`)
      .all() as Array<{ reason: string; q: number; v: number; mc: number; basis: string; detail: string | null }>;
    expect(rows.map((r) => [r.reason, r.q, r.v, r.mc, r.basis, r.detail])).toEqual([
      ['delivery', 2000, 230_000, 115_000, 'bill', null],
      ['waste', -30, -3_600, 120_000, 'price', 'waste:burnt'],
      ['waste', -100, -900, 9_000, 'price', 'waste:other'],
      ['count', -5, -75, 15_000, 'count', 'stock_take'],
      ['adjustment', 3, 45, 15_000, 'price', 'correction'],
    ]);
    // Waste by reason in Reports, at those values.
    const f = s.report(new Date(Date.now() - 3_600_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString()).foodCost!;
    expect(f.wasteCents).toBe(4_500);
    expect(f.wasteByReason).toEqual([
      { reason: 'burnt', times: 1, cents: 3_600 },
      { reason: 'other', times: 1, cents: 900 },
    ]);
    // The manager's history carries the values; the rows say what they are.
    expect(s.r.listMovements(s.db, { reason: 'waste' }).map((m) => [m.detail, m.valueCents, m.costBasis])).toEqual([
      ['waste:other', -900, 'price'],
      ['waste:burnt', -3_600, 'price'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

live('Reports: food cost from the cost each sale kept', () => {
  it('a later price change moves neither last month\'s food cost nor an estimate: it is at the price of its take, labelled', async () => {
    const s = await shop();
    const kept = s.sell([['fajitaM', 1]]);
    s.markPaid(kept, AUG_15);
    const old = s.sell([['fajitaM', 1]]);
    s.asBeforeCosting(old);
    s.markPaid(old, AUG_15);
    const before = s.report(AUGUST.since, AUGUST.until).foodCost!;
    expect(before).toMatchObject({
      costOfSalesCents: 17_641 + 17_641,
      estimatedOrders: 1,
      estimatedCostCents: 17_641,
      foodSalesCents: 240_000,
      knownSalesCents: 240_000,
      foodCostBps: 1_470,
      coverageBps: 10_000,
    });
    expect(before.costingStartedAt).not.toBeNull();

    // Cheese costs twice as much from today.
    s.r.updateIngredient(s.db, { id: s.ing.cheese, packSize: 2000, packPriceCents: 480_000 }, MANAGER);
    const after = s.report(AUGUST.since, AUGUST.until).foodCost!;
    // The sale that kept its cost does not move; nor does the estimate: it is priced at the price in
    // force when its stock was taken, from the price history (costing Phase 4), not at today's.
    expect(after).toMatchObject({ costOfSalesCents: 17_641 + 17_641, estimatedCostCents: 17_641, estimatedOrders: 1 });
    const keptLine = s.db.prepare(`SELECT SUM(cost_cents) AS n FROM order_item_costs WHERE order_id = ?`).get(kept) as { n: number };
    expect(Number(keptLine.n)).toBe(17_641);
    // A sale today keeps today's price.
    const today = s.sell([['fajitaM', 1]]);
    expect(s.costRows(today)[0]!.cost).toBe(24_841);
  });

  it('reconciles: food + fees = what customers paid before tax; known + missing = food sales; the cost adds up', async () => {
    const s = await shop();
    const day = new Date('2026-09-20T10:00:00.000Z');
    const a = s.ring([['fajitaM', 2, ['noOnion', 'extraOnion', 'extraCheese']], ['delivery', 1]]);
    s.r.applyDiscount(s.db, { orderId: a, discountType: 'percent', value: 10, reason: 'Test' }, CASHIER);
    s.send(a);
    const b = s.sell([['deal', 1, ['d1Fajita', 'd2Veggie', 'dealNoOnion', 'sideRanch']], ['cola', 2], ['bakedWings', 1]]);
    const c = s.sell([['veggieL', 1, ['pickOnion', 'pickPepper', 'pickOlive', 'pickMushroom', 'pickCorn', 'dipChili']]]);
    const d = s.sell([['crispyWings', 1]]);
    const e = s.sell([['fajitaM', 1]]);
    s.asBeforeCosting(e);
    for (const o of [a, b, c, d, e]) s.markPaid(o, day);
    // A part refund on C (Rs 100 handed back), recorded as the till records it.
    const t = new Date(day.getTime() + 60_000).toISOString();
    s.db
      .prepare(`INSERT INTO payments (id, order_id, method, amount_cents, reference_no, received_by_user_id, paid_at, created_at, updated_at, device_id)
                VALUES ('p_refund', ?, 'cash', -10000, 'partial-refund: test', ?, ?, ?, ?, ?)`)
      .run(c, MANAGER.userId, t, t, t, DEV);

    const r = s.report('2026-09-20T00:00:00.000Z', '2026-09-21T00:00:00.000Z');
    const f = r.foodCost!;
    // What each order's customers paid before tax: (subtotal − discount) − the refund before tax.
    const paid = (s.db.prepare(`SELECT id, subtotal_cents AS sub, discount_cents AS disc, total_cents AS tot FROM orders WHERE id IN (?, ?, ?, ?, ?)`).all(a, b, c, d, e) as Array<{
      id: string;
      sub: number;
      disc: number;
      tot: number;
    }>).reduce((sum, o) => {
      const ref = o.id === c ? 10_000 : 0;
      const exTax = o.sub - o.disc;
      return sum + exTax - (o.tot > 0 ? Math.round((ref * exTax) / o.tot) : 0);
    }, 0);
    expect(f.foodSalesCents + f.feeSalesCents).toBe(paid);
    // The delivery charge is not food, and the 10% off left it alone (owner,
    // 28 Sep 2026): its full Rs 100. (A discount given before the rule took
    // its 10% too, Rs 90: pinned in the next test.)
    expect(f.feeSalesCents).toBe(10_000);
    expect(f.knownSalesCents + f.missingSalesCents).toBe(f.foodSalesCents);
    // The cost: every kept row of a food line, plus the estimate.
    const keptFood = n(
      s.db,
      `SELECT SUM(c.cost_cents) AS n FROM order_item_costs c JOIN order_items oi ON oi.id = c.order_item_id
        WHERE c.order_id IN (?, ?, ?, ?) AND oi.menu_item_id <> ?`,
      a,
      b,
      c,
      d,
      s.item.delivery,
    );
    expect(f.costOfSalesCents).toBe(keptFood + 17_641);
    expect(f).toMatchObject({ estimatedOrders: 1, estimatedCostCents: 17_641 });
    // The cola (no price) and the Baked Wings (no recipe) are listed, not in the %.
    expect(f.missingSales.map((m) => [m.name, m.why, m.quantity])).toEqual([
      ['Baked Wings', 'no_recipe', 1],
      ['Cola 345 ml', 'no_price', 2],
    ]);
    expect(f.coverageBps).toBe(Math.round((f.knownSalesCents * 10_000) / f.foodSalesCents));
    expect(f.foodCostBps).toBe(Math.round((f.knownCostCents * 10_000) / f.knownSalesCents));
    // The same known sales at menu price reconcile it with the Costing page.
    expect(f.knownMenuSalesCents).toBeGreaterThan(f.knownSalesCents);
    expect(f.menuFoodCostBps!).toBeLessThan(f.foodCostBps!);
    // Items still add up to menu sales, whatever food cost does.
    expect(r.items.reduce((t2, i) => t2 + i.salesCents, 0)).toBe(r.kpis.menuSalesCents);
  });

  it('a discount given before the delivery-charge rule (no rule on its row) keeps its old split: the charge took its 10%', async () => {
    const s = await shop();
    const day = new Date('2026-09-20T10:00:00.000Z');
    // Rung as a 0.7.24 till did: then a discount came off the delivery charge too…
    const { setBusinessSettings } = await import('./repositories/business-settings-repo.js');
    const setSwitch = (alsoOffDeliveryCharge: boolean) =>
      setBusinessSettings(s.db, [{ key: 'discounts.delivery', value: { v: 1, alsoOffDeliveryCharge } }], MANAGER);
    setSwitch(true);
    const a = s.ring([['fajitaM', 2, ['noOnion', 'extraOnion', 'extraCheese']], ['delivery', 1]]);
    s.r.applyDiscount(s.db, { orderId: a, discountType: 'percent', value: 10, reason: 'Test' }, CASHIER);
    // …and its row carries no rule at all (an older till never wrote one).
    s.db.prepare(`UPDATE order_discounts SET rule_json = NULL WHERE order_id = ?`).run(a);
    setSwitch(false);
    s.send(a);
    s.markPaid(a, day);
    const f = s.report('2026-09-20T00:00:00.000Z', '2026-09-21T00:00:00.000Z').foodCost!;
    // The Rs 100 delivery charge took its 10% off: Rs 90, as it was sold. The owner's rule today (No) changes nothing here.
    expect(f.feeSalesCents).toBe(9_000);
    const o = s.db.prepare(`SELECT subtotal_cents AS sub, discount_cents AS disc FROM orders WHERE id = ?`).get(a) as { sub: number; disc: number };
    expect(f.foodSalesCents + f.feeSalesCents).toBe(o.sub - o.disc);
  });

  it('food sent out and never paid (a dine-in served unpaid) is its own line, not in the sales', async () => {
    const s = await shop();
    const o = s.r.createOrder(s.db, { mode: 'dine_in' }, CASHIER).id;
    s.r.addOrderItem(s.db, { orderId: o, menuItemId: s.item.fajitaM, quantity: 1, modifierIds: [], notes: null }, CASHIER);
    s.send(o);
    s.r.markOrderReady(s.db, o, CASHIER);
    s.r.markOrderServed(s.db, { orderId: o }, CASHIER);
    expect(s.r.findOrder(s.db, o)).toMatchObject({ status: 'served', paidAt: null });
    const f = s.report(new Date(Date.now() - 3_600_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString()).foodCost!;
    expect(f.sentNotPaid).toEqual({ orderCount: 1, costCents: 17_641, estimatedOrders: 0 });
    expect(f).toMatchObject({ foodSalesCents: 0, costOfSalesCents: 0 });
  });

  it('food sent, not paid counts only orders that took stock: a Baked Wings (no recipe) served unpaid is not one', async () => {
    const s = await shop();
    const serveUnpaid = (item: 'bakedWings' | 'fajitaM' | 'cola') => {
      const o = s.r.createOrder(s.db, { mode: 'dine_in' }, CASHIER).id;
      s.r.addOrderItem(s.db, { orderId: o, menuItemId: s.item[item], quantity: 1, modifierIds: [], notes: null }, CASHIER);
      s.send(o);
      s.r.markOrderReady(s.db, o, CASHIER);
      s.r.markOrderServed(s.db, { orderId: o }, CASHIER);
      return o;
    };
    const wings = serveUnpaid('bakedWings');
    // It kept its (Rs 0, 'none') cost row, but nothing left the shelf.
    expect(s.costRows(wings).map((r) => r.status)).toEqual(['none']);
    expect(n(s.db, `SELECT COUNT(*) AS n FROM stock_movements WHERE ref_order_id = ?`, wings)).toBe(0);
    const window = () => s.report(new Date(Date.now() - 3_600_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString()).foodCost!;
    expect(window().sentNotPaid).toEqual({ orderCount: 0, costCents: 0, estimatedOrders: 0 });
    // A cola whose bottle has no price yet took a bottle: it went out, at Rs 0.
    serveUnpaid('cola');
    // And a pizza, at its cost.
    serveUnpaid('fajitaM');
    expect(window().sentNotPaid).toEqual({ orderCount: 2, costCents: 17_641, estimatedOrders: 0 });
  });

  it('an order from before costing that took nothing (Baked Wings) is listed as "no recipe", not counted as estimated', async () => {
    const s = await shop();
    const wings = s.sell([['bakedWings', 1]]);
    s.asBeforeCosting(wings);
    s.markPaid(wings, AUG_15);
    const f = s.report(AUGUST.since, AUGUST.until).foodCost!;
    expect(f).toMatchObject({ estimatedOrders: 0, estimatedCostCents: 0, costOfSalesCents: 0, knownSalesCents: 0 });
    expect(f.missingSales.map((m) => [m.name, m.why, m.quantity])).toEqual([['Baked Wings', 'no_recipe', 1]]);
    // One that took stock still is.
    const pizza = s.sell([['fajitaM', 1]]);
    s.asBeforeCosting(pizza);
    s.markPaid(pizza, AUG_15);
    expect(s.report(AUGUST.since, AUGUST.until).foodCost).toMatchObject({ estimatedOrders: 1, estimatedCostCents: 17_641 });
  });

  it('an order from an earlier day still on the board is "still open", not a sale; today\'s is neither', async () => {
    const s = await shop();
    const stale = s.sell([['fajitaM', 1]]);
    s.db.prepare(`UPDATE orders SET created_at = ? WHERE id = ?`).run(new Date(Date.now() - 2 * 86_400_000).toISOString(), stale);
    s.sell([['fajitaM', 1]]); // today's, still cooking
    const f = s.report(new Date(Date.now() - 3 * 86_400_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString()).foodCost!;
    expect(f.stillOpen).toEqual({ orderCount: 1, costCents: 17_641, estimatedOrders: 0 });
    expect(f.costOfSalesCents).toBe(0);
  });

  it('an order whose costing failed altogether is estimated from what it took', async () => {
    const s = await shop();
    s.db.prepare(`UPDATE recipes SET qty_per_unit = 2.5 WHERE menu_item_id = ? AND ingredient_id = ?`).run(s.item.crispyWings, s.ing.chicken);
    const o = s.sell([['crispyWings', 1]]);
    s.markPaid(o, AUG_15);
    const f = s.report(AUGUST.since, AUGUST.until).foodCost!;
    // 50 g breading (Rs 10) and 2 g salt (free) were valued; the 2.5 g of chicken could not be.
    expect(f).toMatchObject({ estimatedOrders: 1, estimatedCostCents: 1_000 });
    expect(f.missingSales).toEqual([{ key: s.item.crispyWings, name: 'Crispy Wings', why: 'no_price', quantity: 1, salesCents: 90_000 }]);
  });
});
