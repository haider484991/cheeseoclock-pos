/**
 * Costing, Phase 4 — exact prices and price history (ingredient_costs,
 * migration 0034), against a real database built from every migration:
 *
 *   - the ONE price path: every repository path that writes a price (the
 *     ingredient form's create and update, "Set price", Convert, a delivery,
 *     the menu import, a batch rolled up) appends exactly one history row,
 *     with its sync entry and audit row, in one transaction — a failure
 *     writes none of it — and no other repository writes a price at all;
 *   - the history is append-only: the same menu file imported again after a
 *     price typed by hand adds a row (the same one on both tills), never
 *     rewrites the first; the ▲ / ▼ is against the history's price before;
 *   - the starting prices (seed): written once, again writes nothing; two
 *     tills seeding while the link is down hold the same rows by id, in
 *     force from the start (never after a price typed in between); a take
 *     from before the history began is priced at the starting price, and at
 *     the first price known when it had none then;
 *   - the menu file on both tills: one 'import' row per ingredient per file;
 *     a batch whose inputs all have a price keeps its roll-up (the sheet's
 *     figure is only a reference);
 *   - Convert with a purchase order open keeps what the order owes exactly,
 *     or is refused in plain words;
 *   - "Set price" on a batch costed from its recipe is refused;
 *   - batches roll up bottom-up, once, only on the till that wrote the
 *     price — the other till receives the rows and rolls nothing up; a loop
 *     is guarded;
 *   - Reports' estimates use the price in force when the stock was taken.
 *
 * node:sqlite behind better-sqlite3's shape (costing-shop.fixture.ts); skips
 * where node:sqlite is missing. EVERY PRICE IS MADE UP (costing spec D11).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { menuImportFileSchema } from '@cheeseoclock/shared-schemas';
import type { AppDatabase } from './connection.js';
import { CASHIER, DEV, DatabaseSync, MANAGER, OWNER, openCostingShop, openMigrated, type Line } from './costing-shop.fixture.js';
import { verifyAuditChain, type AuditChainRow } from './audit-chain.js';

// Builds a real database from every migration per test: seconds on a slow CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const live = describe.skipIf(!DatabaseSync);
const TILL_2 = 'till-2';

afterEach(() => {
  vi.useRealTimers();
});

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

interface CostRow {
  id: string;
  source: string;
  unit: string;
  pack_size: number;
  pack_price_cents: number;
  price_kind: string;
  unit_cost_mc: number;
  prev_unit_cost_mc: number | null;
  effective_at: string;
}
const historyOf = (db: AppDatabase, ingredientId: string) =>
  (
    db
      .prepare(
        `SELECT id, source, unit, pack_size, pack_price_cents, price_kind, unit_cost_mc, prev_unit_cost_mc, effective_at
           FROM ingredient_costs WHERE ingredient_id = ? ORDER BY effective_at, rowid`,
      )
      .all(ingredientId) as unknown as CostRow[]
  ).map((r) => ({ ...r, pack_size: Number(r.pack_size), pack_price_cents: Number(r.pack_price_cents), unit_cost_mc: Number(r.unit_cost_mc) }));
const priceOf = (db: AppDatabase, ingredientId: string) =>
  db.prepare(`SELECT cost_per_unit_cents, pack_size, pack_price_cents, price_kind FROM ingredients WHERE id = ?`).get(ingredientId);

/** The one history row a write added, and its sync entry and audit row. */
function oneNewRow(db: AppDatabase, ingredientId: string, before: number) {
  const rows = historyOf(db, ingredientId);
  expect(rows).toHaveLength(before + 1);
  const row = rows[rows.length - 1]!;
  expect(n(db, `SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'ingredient_costs' AND entity_id = ?`, row.id)).toBe(1);
  expect(n(db, `SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'ingredient_costs' AND entity_id = ?`, row.id)).toBe(1);
  // The row travels as itself (a row image), with the exact pack.
  const queued = db
    .prepare(`SELECT payload_json FROM sync_queue WHERE entity_type = 'ingredient_costs' AND entity_id = ?`)
    .get(row.id) as { payload_json: string };
  expect(JSON.parse(queued.payload_json)).toMatchObject({ id: row.id, packSize: row.pack_size, packPriceCents: row.pack_price_cents });
  return row;
}

async function repos() {
  return {
    ...(await import('./repositories/ingredient-cost-repo.js')),
    ...(await import('./repositories/procurement-repo.js')),
    ...(await import('./repositories/menu-import-repo.js')),
    ...(await import('./repositories/sync-repo.js')),
    ...(await import('./repositories/apply-remote.js')),
    ...(await import('./repositories/order-repo.js')),
    ...(await import('./repositories/shift-repo.js')),
    ...(await import('./price-history-read.js')),
    ...(await import('../services/costing-seed.js')),
  };
}

/** The made-up shop, with this file's repositories beside the fixture's. */
async function shop(db: AppDatabase = openMigrated()) {
  const s = await openCostingShop(db);
  const r = { ...s.r, ...(await repos()) };
  return { db, ...s, r };
}

/** A menu file (made-up prices). */
const menuFile = (ingredients: Array<Record<string, unknown>>) =>
  menuImportFileSchema.parse({ format: 'cheeseoclock-menu-import', version: 1, source: 'test', categories: [], ingredients, items: [] });

// ---------------------------------------------------------------------------
// Two tills
// ---------------------------------------------------------------------------

function iAm(db: AppDatabase, id: string) {
  db.prepare(`INSERT INTO device_info (id, device_id, display_name, registered_at) VALUES ('singleton', ?, ?, ?)`).run(id, id, new Date().toISOString());
}

/** A second till: the same users, then everything till 1 has sent. */
async function secondTill(from: AppDatabase) {
  const { listPendingSync, pendingToChange, markSyncedIds, applyRemoteBatch } = await repos();
  const db2 = openMigrated();
  const user = db2.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, 'x', 'x', ?)`,
  );
  user.run(CASHIER.userId, 'Test Cashier', 'cashier', DEV);
  user.run(MANAGER.userId, 'Test Manager', 'manager', DEV);
  user.run(OWNER.userId, 'Test Owner', 'admin', DEV);
  iAm(from, DEV);
  iAm(db2, TILL_2);
  const push = async (a: AppDatabase, aDevice: string, b: AppDatabase) => {
    const pending = listPendingSync(a, 1_000_000);
    const res = await applyRemoteBatch(b, pending.map((p) => pendingToChange(p, aDevice)), { pause: async () => {} });
    markSyncedIds(a, pending.map((p) => p.id));
    return res;
  };
  expect(await push(from, DEV, db2)).toMatchObject({ waiting: 0, dropped: 0 });
  return { db2, push };
}

const TILL2_MANAGER = { userId: MANAGER.userId, deviceId: TILL_2 };

// ---------------------------------------------------------------------------
// The one price path
// ---------------------------------------------------------------------------

const REPOSITORIES = join(dirname(fileURLToPath(import.meta.url)), 'repositories');
const PRICE_COLUMN = /\b(cost_per_unit_cents|pack_size|pack_price_cents|price_kind)\b/i;

/** SQL that writes an ingredient's price columns, found in a repository's code (comments dropped). */
function priceWrites(file: string): string[] {
  const src = readFileSync(join(REPOSITORIES, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const found: string[] = [];
  for (const m of src.matchAll(/UPDATE\s+ingredients\s+SET\b([\s\S]*?)\bWHERE\b/gi)) {
    if (PRICE_COLUMN.test(m[1] ?? '')) found.push(m[0].replace(/\s+/g, ' ').slice(0, 120));
  }
  for (const m of src.matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+ingredients\s*\(([^)]*)\)/gi)) {
    if (PRICE_COLUMN.test(m[1] ?? '')) found.push(m[0].replace(/\s+/g, ' ').slice(0, 120));
  }
  return found;
}

describe('one price path: no repository but ingredient-cost-repo writes a price', () => {
  it('scans every repository (apply-remote writes rows as they arrived, and is outside the rule)', () => {
    const files = readdirSync(REPOSITORIES).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const offenders = files
      .filter((f) => f !== 'ingredient-cost-repo.ts' && f !== 'apply-remote.ts')
      .flatMap((f) => priceWrites(f).map((sql) => `${f}: ${sql}`));
    expect(offenders).toEqual([]);
    // The scan sees a price write where there is one.
    expect(priceWrites('ingredient-cost-repo.ts').length).toBeGreaterThan(0);
  });
});

live('every price-writing path appends exactly one history row, synced and audited', () => {
  it('create (the ingredient form, and the first price of a new ingredient)', async () => {
    const s = await shop();
    const ing = s.r.createIngredient(s.db, { name: 'Test flour', unit: 'g', packSize: 1000, packPriceCents: 9_000 }, MANAGER);
    const row = oneNewRow(s.db, ing.id, 0);
    expect(row).toMatchObject({ source: 'manual', unit: 'g', pack_size: 1000, pack_price_cents: 9_000, price_kind: 'set', unit_cost_mc: 9_000, prev_unit_cost_mc: null });
    expect(priceOf(s.db, ing.id)).toEqual({ cost_per_unit_cents: 9, pack_size: 1000, pack_price_cents: 9_000, price_kind: 'set' });
    // One create in the trail for the ingredient itself, as before.
    expect(n(s.db, `SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'ingredients' AND entity_id = ?`, ing.id)).toBe(1);
    // A new ingredient with no price starts its history as "no price yet".
    const cup = s.r.createIngredient(s.db, { name: 'Test lid', unit: 'pcs' }, MANAGER);
    expect(oneNewRow(s.db, cup.id, 0)).toMatchObject({ price_kind: 'unset', pack_size: 1, pack_price_cents: 0 });
  });

  it('update (the ingredient form): a new price is one row; the same price saved again, none', async () => {
    const s = await shop();
    const before = historyOf(s.db, s.ing.cheese).length;
    s.r.updateIngredient(s.db, { id: s.ing.cheese, packSize: 2000, packPriceCents: 250_000 }, MANAGER);
    const row = oneNewRow(s.db, s.ing.cheese, before);
    // Rs 1,200 / kg → Rs 1,250 / kg (a gram's price in mc is the kg's in paisa).
    expect(row).toMatchObject({ source: 'manual', pack_size: 2000, pack_price_cents: 250_000, unit_cost_mc: 125_000, prev_unit_cost_mc: 120_000 });
    s.r.updateIngredient(s.db, { id: s.ing.cheese, name: 'Test cheese', packSize: 2000, packPriceCents: 250_000, priceKind: 'set' }, MANAGER);
    expect(historyOf(s.db, s.ing.cheese)).toHaveLength(before + 1);
    // Mark free: a real Rs 0 is a price too.
    s.r.updateIngredient(s.db, { id: s.ing.cheese, priceKind: 'free' }, MANAGER);
    expect(oneNewRow(s.db, s.ing.cheese, before + 1)).toMatchObject({ price_kind: 'free', pack_price_cents: 0, prev_unit_cost_mc: 125_000 });
  });

  it('"Set price": Rs X per kg, per pack of N, per piece — kept as that exact pack', async () => {
    const s = await shop();
    const before = historyOf(s.db, s.ing.onion).length;
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.onion, typed: { per: 'thousand', priceCents: 15_500 } }, MANAGER);
    expect(oneNewRow(s.db, s.ing.onion, before)).toMatchObject({ source: 'manual', pack_size: 1000, pack_price_cents: 15_500, unit_cost_mc: 15_500 });
    expect(priceOf(s.db, s.ing.onion)).toEqual({ cost_per_unit_cents: 16, pack_size: 1000, pack_price_cents: 15_500, price_kind: 'set' });
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.cup, typed: { per: 'pack', priceCents: 1_000, packSize: 12 }, priceKind: 'estimate' }, MANAGER);
    expect(historyOf(s.db, s.ing.cup).at(-1)).toMatchObject({ pack_size: 12, pack_price_cents: 1_000, price_kind: 'estimate', unit_cost_mc: 83_333 });
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.box, typed: { per: 'piece', priceCents: 4_500 } }, MANAGER);
    expect(historyOf(s.db, s.ing.box).at(-1)).toMatchObject({ pack_size: 1, pack_price_cents: 4_500, prev_unit_cost_mc: 4_000_000 });
    expect(() => s.r.setTypedPrice(s.db, { ingredientId: s.ing.onion, typed: { per: 'piece', priceCents: 100 } }, MANAGER)).toThrow(/Per piece/);
  });

  it('Convert: the same price in grams (1,000 g for Rs 375), one row, every value unchanged', async () => {
    const s = await shop();
    const ghee = s.r.createIngredient(s.db, { name: 'Test ghee', unit: 'kg', currentQty: 5, costPerUnitCents: 37_500 }, MANAGER);
    const wasWorth = 3 * 37_500;
    s.r.convertIngredientToBaseUnit(s.db, ghee.id, MANAGER);
    const row = oneNewRow(s.db, ghee.id, 1);
    expect(row).toMatchObject({ source: 'convert', unit: 'g', pack_size: 1000, pack_price_cents: 37_500, unit_cost_mc: 37_500, prev_unit_cost_mc: 37_500 });
    expect(priceOf(s.db, ghee.id)).toEqual({ cost_per_unit_cents: 38, pack_size: 1000, pack_price_cents: 37_500, price_kind: 'set' });
    const { valueCents, effectivePack } = await import('@cheeseoclock/pos-domain');
    const p = priceOf(s.db, ghee.id) as { cost_per_unit_cents: number; pack_size: number; pack_price_cents: number };
    expect(valueCents(3000, effectivePack({ costPerUnitCents: p.cost_per_unit_cents, packSize: p.pack_size, packPriceCents: p.pack_price_cents }))).toBe(wasWorth);
  });

  it('Convert with a purchase order open: what the order owes stays exactly the same, or the Convert is refused in plain words', async () => {
    const s = await shop();
    const sup = s.r.createSupplier(s.db, { name: 'Test Dairy' }, MANAGER);
    // Rs 380 a kg (made up) is exactly 38 paisa a gram.
    const ghee = s.r.createIngredient(s.db, { name: 'Test ghee', unit: 'kg', currentQty: 5, costPerUnitCents: 38_000 }, MANAGER);
    const po = s.r.createPurchaseOrder(s.db, { supplierId: sup.id, items: [{ ingredientId: ghee.id, qtyOrdered: 5, unitCostCents: 38_000 }] }, MANAGER);
    const owed = (id: string) => s.db.prepare(`SELECT qty_ordered * unit_cost_cents AS n, qty_ordered AS q, unit_cost_cents AS c FROM purchase_order_items WHERE purchase_order_id = ?`).get(id);
    expect(owed(po.id)).toEqual({ n: 190_000, q: 5, c: 38_000 });
    s.r.convertIngredientToBaseUnit(s.db, ghee.id, MANAGER);
    expect(owed(po.id)).toEqual({ n: 190_000, q: 5_000, c: 38 });

    // Rs 375.50 a kg is 37.55 paisa a gram: rounding it would make the order owe Rs 1,900, not Rs 1,877.50.
    const oil = s.r.createIngredient(s.db, { name: 'Test oil', unit: 'l', currentQty: 5, costPerUnitCents: 37_550 }, MANAGER);
    const po2 = s.r.createPurchaseOrder(s.db, { supplierId: sup.id, items: [{ ingredientId: oil.id, qtyOrdered: 5, unitCostCents: 37_550 }] }, MANAGER);
    const before = { ing: priceOf(s.db, oil.id), rows: historyOf(s.db, oil.id).length, queued: n(s.db, `SELECT COUNT(*) AS n FROM sync_queue`) };
    expect(() => s.r.convertIngredientToBaseUnit(s.db, oil.id, MANAGER)).toThrow(
      /"Test oil" is on an open purchase order .*at Rs 375\.50 per l, which can't be kept exactly per ml\. Receive or cancel that order first, then count it in ml\./,
    );
    expect(owed(po2.id)).toEqual({ n: 187_750, q: 5, c: 37_550 });
    expect(s.db.prepare(`SELECT unit, current_qty FROM ingredients WHERE id = ?`).get(oil.id)).toEqual({ unit: 'l', current_qty: 5 });
    expect(priceOf(s.db, oil.id)).toEqual(before.ing);
    expect(historyOf(s.db, oil.id)).toHaveLength(before.rows);
    expect(n(s.db, `SELECT COUNT(*) AS n FROM sync_queue`)).toBe(before.queued);
    // Once that order is received, the Convert goes through.
    s.r.receiveDelivery(s.db, { purchaseOrderId: po2.id, receipts: [{ purchaseOrderItemId: po2.items[0]!.id, qtyReceivedNow: 5 }] }, MANAGER);
    s.r.convertIngredientToBaseUnit(s.db, oil.id, MANAGER);
    expect(priceOf(s.db, oil.id)).toMatchObject({ pack_size: 1000, pack_price_cents: 37_550 });
  });

  it('a delivery taken as the new cost: one row naming the supplier and the purchase order', async () => {
    const s = await shop();
    const sup = s.r.createSupplier(s.db, { name: 'Test Dairy' }, MANAGER);
    const po = s.r.createPurchaseOrder(s.db, { supplierId: sup.id, items: [{ ingredientId: s.ing.chicken, qtyOrdered: 2000, unitCostCents: 95 }] }, MANAGER);
    const before = historyOf(s.db, s.ing.chicken).length;
    s.r.receiveDelivery(s.db, { purchaseOrderId: po.id, updateCosts: true, receipts: [{ purchaseOrderItemId: po.items[0]!.id, qtyReceivedNow: 2000 }] }, MANAGER);
    const row = oneNewRow(s.db, s.ing.chicken, before);
    expect(row).toMatchObject({ source: 'delivery', pack_size: 1, pack_price_cents: 95, prev_unit_cost_mc: 90_000 });
    const h = s.r.listPriceHistory(s.db, s.ing.chicken)[0]!;
    expect(h).toMatchObject({ source: 'delivery', supplierName: 'Test Dairy', purchaseOrderId: po.id, actorName: 'Test Manager' });
  });

  it('the menu import: one "import" row for a price the file changes', async () => {
    const s = await shop();
    const before = historyOf(s.db, s.ing.chili).length;
    s.r.applyMenuImport(s.db, menuFile([{ name: 'Test chili', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 55_000 }]), 'test.json', OWNER);
    const row = oneNewRow(s.db, s.ing.chili, before);
    expect(row).toMatchObject({ source: 'import', pack_size: 1000, pack_price_cents: 55_000 });
    expect(row.id).toBe(s.r.importPriceRowId(s.ing.chili, s.r.menuFileSha256(menuFile([{ name: 'Test chili', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 55_000 }]))));
  });

  it('a batch rolled up: one "batch" row for the sauce when its tomatoes change', async () => {
    const s = await shop();
    const before = historyOf(s.db, s.ing.sauce).length;
    const res = s.r.setTypedPrice(s.db, { ingredientId: s.ing.tomato, typed: { per: 'pack', priceCents: 70_000, packSize: 5000 } }, MANAGER);
    const row = oneNewRow(s.db, s.ing.sauce, before);
    // 2,500 g at Rs 140 / kg + 125 g garlic at Rs 450 / kg = Rs 350 + Rs 56.25, for 2,000 g.
    expect(row).toMatchObject({ source: 'batch', pack_size: 2000, pack_price_cents: 40_625 });
    expect(row.id).toBe(s.r.batchPriceRowId(s.ing.sauce, res.entryId!));
    expect(res.rolledUp).toEqual([s.ing.sauce]);
    expect(chainOk(s.db)).toBe(true);
  });
});

live('the price, its history row, their sync entries and audit rows: one transaction', () => {
  const refuse = (db: AppDatabase, table: 'audit_log' | 'sync_queue') =>
    db.exec(
      `CREATE TEMP TRIGGER refuse_cost_row BEFORE INSERT ON ${table}
         WHEN NEW.entity_type = 'ingredient_costs' BEGIN SELECT RAISE(ABORT, 'test: refused'); END`,
    );

  for (const table of ['audit_log', 'sync_queue'] as const) {
    it(`a failure writing the history row's ${table === 'audit_log' ? 'audit row' : 'sync entry'} leaves the price as it was`, async () => {
      const s = await shop();
      const price = priceOf(s.db, s.ing.cheese);
      const rows = historyOf(s.db, s.ing.cheese).length;
      const queued = n(s.db, `SELECT COUNT(*) AS n FROM sync_queue`);
      const audits = n(s.db, `SELECT COUNT(*) AS n FROM audit_log`);
      refuse(s.db, table);
      expect(() => s.r.updateIngredient(s.db, { id: s.ing.cheese, packSize: 2000, packPriceCents: 250_000 }, MANAGER)).toThrow(/refused/);
      expect(() => s.r.setTypedPrice(s.db, { ingredientId: s.ing.tomato, typed: { per: 'thousand', priceCents: 14_000 } }, MANAGER)).toThrow(/refused/);
      expect(() => s.r.createIngredient(s.db, { name: 'Test semolina', unit: 'g', packSize: 1000, packPriceCents: 20_000 }, MANAGER)).toThrow(/refused/);
      expect(priceOf(s.db, s.ing.cheese)).toEqual(price);
      expect(historyOf(s.db, s.ing.cheese)).toHaveLength(rows);
      expect(n(s.db, `SELECT COUNT(*) AS n FROM ingredients WHERE name = 'Test semolina'`)).toBe(0);
      expect(n(s.db, `SELECT COUNT(*) AS n FROM sync_queue`)).toBe(queued);
      expect(n(s.db, `SELECT COUNT(*) AS n FROM audit_log`)).toBe(audits);
      s.db.exec(`DROP TRIGGER refuse_cost_row`);
      expect(chainOk(s.db)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// The starting prices
// ---------------------------------------------------------------------------

/** A till from before price history: its ingredients have none yet. */
function asBeforeHistory(db: AppDatabase) {
  db.prepare(`DELETE FROM ingredient_costs`).run();
  db.prepare(`DELETE FROM sync_queue WHERE entity_type = 'ingredient_costs'`).run();
}

live('the starting prices (seed)', () => {
  it('one row per ingredient, at the price costing used then (a batch at its rolled-up price); again writes nothing', async () => {
    const s = await shop();
    asBeforeHistory(s.db);
    // The sauce's own price is the costing sheet's (a made-up Rs 300 a batch); costing rolls it up.
    s.db.prepare(`UPDATE ingredients SET pack_size = 2000, pack_price_cents = 30000, cost_per_unit_cents = 15, price_kind = 'set' WHERE id = ?`).run(s.ing.sauce);
    const live = n(s.db, `SELECT COUNT(*) AS n FROM ingredients WHERE deleted_at IS NULL`);
    const first = s.r.seedPriceHistoryOnce(s.db, DEV);
    expect(first).toEqual({ written: live, alreadyDone: false });
    expect(n(s.db, `SELECT COUNT(*) AS n FROM ingredient_costs WHERE source = 'seed'`)).toBe(live);
    const cheese = historyOf(s.db, s.ing.cheese);
    expect(cheese).toEqual([expect.objectContaining({ id: s.r.seedPriceRowId(s.ing.cheese), source: 'seed', pack_size: 2000, pack_price_cents: 240_000, prev_unit_cost_mc: null })]);
    expect(historyOf(s.db, s.ing.sauce)[0]).toMatchObject({ source: 'seed', pack_size: 2000, pack_price_cents: 35_625, price_kind: 'set' });
    expect(historyOf(s.db, s.ing.bottle)[0]).toMatchObject({ source: 'seed', price_kind: 'unset' });
    expect(historyOf(s.db, s.ing.salt)[0]).toMatchObject({ source: 'seed', price_kind: 'free' });
    // The ingredients themselves are not touched.
    expect(priceOf(s.db, s.ing.sauce)).toEqual({ cost_per_unit_cents: 15, pack_size: 2000, pack_price_cents: 30_000, price_kind: 'set' });
    // Every row synced and audited.
    expect(n(s.db, `SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'ingredient_costs'`)).toBe(live);
    expect(
      n(
        s.db,
        `SELECT COUNT(*) AS n FROM audit_log a JOIN ingredient_costs c ON c.id = a.entity_id
          WHERE a.entity_type = 'ingredient_costs' AND a.action = 'create' AND c.source = 'seed'`,
      ),
    ).toBe(live);
    // Idempotent: the flag, and nothing to write even without it.
    expect(s.r.seedPriceHistoryOnce(s.db, DEV)).toEqual({ written: 0, alreadyDone: true });
    expect(s.r.writeSeedPrices(s.db, { userId: null, deviceId: DEV })).toBe(0);
    expect(n(s.db, `SELECT COUNT(*) AS n FROM ingredient_costs`)).toBe(live);
    expect(chainOk(s.db)).toBe(true);
  });

  it('an ingredient that already has a history gets no starting price', async () => {
    const s = await shop();
    expect(s.r.seedPriceHistoryOnce(s.db, DEV)).toEqual({ written: 0, alreadyDone: false });
    expect(n(s.db, `SELECT COUNT(*) AS n FROM ingredient_costs WHERE source = 'seed'`)).toBe(0);
  });

  it("two tills seed while the link is down: the SAME rows by id, one per ingredient after syncing, nothing parked", async () => {
    const s = await shop();
    asBeforeHistory(s.db);
    const { db2, push } = await secondTill(s.db);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T09:00:00.000Z'));
    const a = s.r.seedPriceHistoryOnce(s.db, DEV);
    vi.setSystemTime(new Date('2026-09-27T09:05:00.000Z'));
    const b = s.r.seedPriceHistoryOnce(db2, TILL_2);
    vi.useRealTimers();
    expect(a.written).toBeGreaterThan(0);
    expect(b.written).toBe(a.written);
    const ids = (db: AppDatabase) => (db.prepare(`SELECT id FROM ingredient_costs ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids(db2)).toEqual(ids(s.db));
    expect(await push(s.db, DEV, db2)).toMatchObject({ waiting: 0, dropped: 0 });
    expect(await push(db2, TILL_2, s.db)).toMatchObject({ waiting: 0, dropped: 0 });
    const rows = (db: AppDatabase) => db.prepare(`SELECT id, ingredient_id, effective_at, pack_size, pack_price_cents, version FROM ingredient_costs ORDER BY id`).all();
    for (const db of [s.db, db2]) {
      expect(n(db, `SELECT COUNT(*) AS n FROM ingredient_costs`)).toBe(a.written);
      expect(n(db, `SELECT COUNT(DISTINCT ingredient_id) AS n FROM ingredient_costs`)).toBe(a.written);
      expect(s.r.readParked(db)).toEqual([]);
    }
    // Settled by id, the same on both — and in force from the start, whichever till wrote it when.
    expect(rows(s.db)).toEqual(rows(db2));
    expect(n(s.db, `SELECT COUNT(*) AS n FROM ingredient_costs WHERE effective_at = ?`, s.r.SEED_EFFECTIVE_AT)).toBe(a.written);
  });

  it('a price typed on till 1 between the two tills\' seeding stays AFTER the starting price on both (never overtaken by a later seed)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-15T10:00:00.000Z'));
    const s = await shop();
    // An August order from before costing (no snapshot): 60 g of cheese among the rest.
    s.r.openShift(s.db, { openingCashCents: 0 }, MANAGER);
    const o = s.ring([['fajitaM', 1]]);
    s.r.sendOrderToKitchen(s.db, o, CASHIER);
    s.markPaid(o, new Date('2026-08-15T10:00:00.000Z'));
    s.db.prepare(`DELETE FROM order_item_costs WHERE order_id = ?`).run(o);
    s.db.prepare(`UPDATE stock_movements SET value_cents = NULL, unit_cost_mc = NULL, cost_basis = NULL WHERE ref_order_id = ?`).run(o);
    asBeforeHistory(s.db);
    const { db2, push } = await secondTill(s.db);
    // Till 1 upgrades at 09:00 (cheese Rs 1,200 / kg) and a manager types Rs 1,500 / kg at 09:30.
    vi.setSystemTime(new Date('2026-09-27T09:00:00.000Z'));
    s.r.seedPriceHistoryOnce(s.db, DEV);
    vi.setSystemTime(new Date('2026-09-27T09:30:00.000Z'));
    const typed = s.r.setTypedPrice(s.db, { ingredientId: s.ing.cheese, typed: { per: 'thousand', priceCents: 150_000 } }, MANAGER);
    // Till 2 is powered on at 12:00 and seeds from its own copy (Rs 1,200 / kg) before its first pull.
    vi.setSystemTime(new Date('2026-09-27T12:00:00.000Z'));
    s.r.seedPriceHistoryOnce(db2, TILL_2);
    expect(await push(s.db, DEV, db2)).toMatchObject({ waiting: 0, dropped: 0 });
    expect(await push(db2, TILL_2, s.db)).toMatchObject({ waiting: 0, dropped: 0 });
    vi.useRealTimers();
    for (const db of [s.db, db2]) {
      // Starting price first, then the typed one — on both tills.
      expect(historyOf(db, s.ing.cheese).map((r) => [r.source, r.pack_price_cents, r.effective_at])).toEqual([
        ['seed', 240_000, s.r.SEED_EFFECTIVE_AT],
        ['manual', 150_000, '2026-09-27T09:30:00.000Z'],
      ]);
      expect(historyOf(db, s.ing.cheese)[1]!.id).toBe(typed.entryId);
      // The Ingredients list's newest entry is the typed price, not the starting one.
      expect(s.r.latestPriceTags(db).get(s.ing.cheese)).toMatchObject({ source: 'manual', unitCostMc: 150_000, prevUnitCostMc: 120_000 });
      expect(s.r.readParked(db)).toEqual([]);
    }
    // Last month's estimate stays at the starting Rs 1,200 / kg (never the Rs 1,500 typed later).
    const { getBusinessReport } = await import('../services/business-report.js');
    const august = { sinceIso: '2026-08-01T00:00:00.000Z', untilIso: '2026-09-01T00:00:00.000Z' };
    expect(getBusinessReport(s.db, august).foodCost).toMatchObject({ estimatedOrders: 1, estimatedCostCents: 17_641 });
  });

  it('a take from before the history began is priced at the starting price, not at a later one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-15T10:00:00.000Z'));
    const s = await shop();
    s.r.openShift(s.db, { openingCashCents: 0 }, MANAGER);
    const o = s.ring([['fajitaM', 1]]);
    s.r.sendOrderToKitchen(s.db, o, CASHIER);
    s.markPaid(o, new Date('2026-08-15T10:00:00.000Z'));
    // An order from before costing: no cost kept, its rows carry no value — and no history yet.
    s.db.prepare(`DELETE FROM order_item_costs WHERE order_id = ?`).run(o);
    s.db.prepare(`UPDATE stock_movements SET value_cents = NULL, unit_cost_mc = NULL, cost_basis = NULL WHERE ref_order_id = ?`).run(o);
    asBeforeHistory(s.db);
    // Cheese went up before the history began (no record of when): Rs 1,500 / kg.
    s.db.prepare(`UPDATE ingredients SET pack_price_cents = 300000, cost_per_unit_cents = 150 WHERE id = ?`).run(s.ing.cheese);
    vi.setSystemTime(new Date('2026-09-27T05:00:00.000Z'));
    s.r.seedPriceHistoryOnce(s.db, DEV);
    // …and again once it had: Rs 2,000 / kg.
    vi.setSystemTime(new Date('2026-09-28T10:00:00.000Z'));
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.cheese, typed: { per: 'thousand', priceCents: 200_000 } }, MANAGER);
    const { getBusinessReport } = await import('../services/business-report.js');
    const f = getBusinessReport(s.db, { sinceIso: '2026-08-01T00:00:00.000Z', untilIso: '2026-09-01T00:00:00.000Z' }).foodCost!;
    // 17,641 at the old Rs 1,200 / kg; 60 g of cheese at the starting Rs 1,500 / kg is 1,800 more — never Rs 2,000's 4,800.
    expect(f).toMatchObject({ estimatedOrders: 1, estimatedCostCents: 17_641 + 1_800 });
  });

  it('an ingredient with NO price when the history began, priced later: older takes are costed at that first price, not "not priced" for good', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-15T10:00:00.000Z'));
    const s = await shop();
    s.r.openShift(s.db, { openingCashCents: 0 }, MANAGER);
    // A pizza and a cola from before costing: the 345 ml bottle has no price yet.
    const o = s.ring([['fajitaM', 1], ['cola', 1]]);
    s.r.sendOrderToKitchen(s.db, o, CASHIER);
    s.markPaid(o, new Date('2026-08-15T10:00:00.000Z'));
    s.db.prepare(`DELETE FROM order_item_costs WHERE order_id = ?`).run(o);
    s.db.prepare(`UPDATE stock_movements SET value_cents = NULL, unit_cost_mc = NULL, cost_basis = NULL WHERE ref_order_id = ?`).run(o);
    asBeforeHistory(s.db);
    vi.setSystemTime(new Date('2026-09-27T05:00:00.000Z'));
    s.r.seedPriceHistoryOnce(s.db, DEV);
    expect(historyOf(s.db, s.ing.bottle)).toEqual([expect.objectContaining({ source: 'seed', price_kind: 'unset' })]);
    const { getBusinessReport } = await import('../services/business-report.js');
    const august = { sinceIso: '2026-08-01T00:00:00.000Z', untilIso: '2026-09-01T00:00:00.000Z' };
    // Still no price: the order can't be costed, and says so.
    expect(getBusinessReport(s.db, august).foodCost).toMatchObject({ estimatedOrders: 1, coverageBps: 0, foodCostBps: null });
    // The owner fills the price in (Rs 60 a bottle, made up): August is costed, as it was before price history.
    vi.setSystemTime(new Date('2026-10-05T10:00:00.000Z'));
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.bottle, typed: { per: 'piece', priceCents: 6_000 } }, MANAGER);
    const costed = getBusinessReport(s.db, august).foodCost!;
    expect(costed).toMatchObject({ estimatedOrders: 1, estimatedCostCents: 17_641 + 6_000, coverageBps: 10_000, missingSalesCents: 0 });
    expect(costed.foodCostBps).not.toBeNull();
    // …and a price change after that never moves it.
    vi.setSystemTime(new Date('2026-10-20T10:00:00.000Z'));
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.bottle, typed: { per: 'piece', priceCents: 7_500 } }, MANAGER);
    expect(getBusinessReport(s.db, august).foodCost).toMatchObject({ estimatedOrders: 1, estimatedCostCents: 17_641 + 6_000 });
  });
});

// ---------------------------------------------------------------------------
// The menu file on both tills
// ---------------------------------------------------------------------------

live('the menu import on both tills', () => {
  it('one "import" row per ingredient per file (and one rolled-up batch row), settled by id', async () => {
    const s = await shop();
    const { db2, push } = await secondTill(s.db);
    const file = menuFile([
      { name: 'Test chili', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 55_000 },
      { name: 'Test tomato', unit: 'g', costPerUnitCents: 0, packSize: 5000, packPriceCents: 65_000 },
      { name: 'Test onion', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 15_000 }, // as it is: nothing to write
    ]);
    const sha = s.r.menuFileSha256(file);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T09:00:00.000Z'));
    s.r.applyMenuImport(s.db, file, 'menu.json', OWNER);
    vi.setSystemTime(new Date('2026-09-27T09:02:00.000Z'));
    s.r.applyMenuImport(db2, file, 'menu.json', TILL2_MANAGER);
    vi.useRealTimers();
    const imported = (db: AppDatabase) =>
      (db.prepare(`SELECT id, ingredient_id AS ing FROM ingredient_costs WHERE source = 'import' ORDER BY id`).all() as Array<{ id: string; ing: string }>);
    const expected = [s.r.importPriceRowId(s.ing.chili, sha), s.r.importPriceRowId(s.ing.tomato, sha)].sort();
    expect(imported(s.db).map((r) => r.id)).toEqual(expected);
    expect(imported(db2).map((r) => r.id)).toEqual(expected);
    const sauceRow = s.r.batchPriceRowId(s.ing.sauce, s.r.importPriceRowId(s.ing.tomato, sha));
    expect(await push(s.db, DEV, db2)).toMatchObject({ waiting: 0, dropped: 0 });
    expect(await push(db2, TILL_2, s.db)).toMatchObject({ waiting: 0, dropped: 0 });
    for (const db of [s.db, db2]) {
      expect(imported(db).map((r) => r.id)).toEqual(expected);
      expect(n(db, `SELECT COUNT(*) AS n FROM ingredient_costs WHERE source = 'import' AND ingredient_id = ?`, s.ing.chili)).toBe(1);
      expect(n(db, `SELECT COUNT(*) AS n FROM ingredient_costs WHERE ingredient_id = ? AND source = 'batch' AND id = ?`, s.ing.sauce, sauceRow)).toBe(1);
      expect(n(db, `SELECT COUNT(*) AS n FROM ingredient_costs WHERE ingredient_id = ?`, s.ing.onion)).toBe(1); // its first price only
      expect(s.r.readParked(db)).toEqual([]);
    }
    // The same file again: the prices are already its prices, nothing new.
    const rows = n(s.db, `SELECT COUNT(*) AS n FROM ingredient_costs`);
    s.r.applyMenuImport(s.db, file, 'menu.json', OWNER);
    expect(n(s.db, `SELECT COUNT(*) AS n FROM ingredient_costs`)).toBe(rows);
  });

  it('the same file again after a price was typed by hand: a NEW row after it (the same one on both tills); the first stays as it was', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T09:00:00.000Z'));
    const s = await shop();
    const { db2, push } = await secondTill(s.db);
    const file = menuFile([{ name: 'Test chili', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 55_000 }]);
    const sha = s.r.menuFileSha256(file);
    vi.setSystemTime(new Date('2026-09-27T09:10:00.000Z'));
    s.r.applyMenuImport(s.db, file, 'menu.json', OWNER);
    vi.setSystemTime(new Date('2026-09-27T09:20:00.000Z'));
    const typed = s.r.setTypedPrice(s.db, { ingredientId: s.ing.chili, typed: { per: 'thousand', priceCents: 60_000 } }, MANAGER);
    expect(await push(s.db, DEV, db2)).toMatchObject({ waiting: 0, dropped: 0 });
    // Both tills import the same file again, from the same history.
    vi.setSystemTime(new Date('2026-09-27T09:30:00.000Z'));
    s.r.applyMenuImport(s.db, file, 'menu.json', OWNER);
    vi.setSystemTime(new Date('2026-09-27T09:31:00.000Z'));
    s.r.applyMenuImport(db2, file, 'menu.json', TILL2_MANAGER);
    vi.useRealTimers();
    const first = s.r.importPriceRowId(s.ing.chili, sha);
    const again = s.r.priceRowIdAfter(s.ing.chili, first, typed.entryId);
    expect(await push(s.db, DEV, db2)).toMatchObject({ waiting: 0, dropped: 0 });
    expect(await push(db2, TILL_2, s.db)).toMatchObject({ waiting: 0, dropped: 0 });
    for (const db of [s.db, db2]) {
      // Nothing rewritten: 500 → Sheet 550 (09:10) → Typed 600 (▲ from 550) → Sheet 550 (▼ from 600).
      expect(historyOf(db, s.ing.chili).map((r) => [r.id, r.source, r.pack_price_cents, r.prev_unit_cost_mc, r.effective_at])).toEqual([
        [expect.any(String), 'manual', 50_000, null, '2026-09-27T09:00:00.000Z'],
        [first, 'import', 55_000, 50_000, '2026-09-27T09:10:00.000Z'],
        [typed.entryId, 'manual', 60_000, 55_000, '2026-09-27T09:20:00.000Z'],
        [again, 'import', 55_000, 60_000, expect.stringMatching(/^2026-09-27T09:3/)],
      ]);
      expect(priceOf(db, s.ing.chili)).toMatchObject({ pack_price_cents: 55_000 });
      expect(s.r.readParked(db)).toEqual([]);
      // No history row was ever edited: every one is at its first version, with one 'create' in the trail.
      expect(n(db, `SELECT COUNT(*) AS n FROM ingredient_costs WHERE version <> 1`)).toBe(0);
    }
    expect(n(s.db, `SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'ingredient_costs' AND action <> 'create'`)).toBe(0);
    // The price in force between the first import and the typed price is the file's.
    expect(s.r.loadPriceHistory(s.db).priceAt(s.ing.chili, '2026-09-27T09:15:00.000Z')?.pack).toEqual({ size: 1000, priceCents: 55_000 });
    expect(chainOk(s.db)).toBe(true);
  });

  it("a batch whose inputs all have a price keeps its roll-up: the sheet's figure for it is only a reference", async () => {
    const s = await shop();
    const sauceBefore = priceOf(s.db, s.ing.sauce);
    const rowsBefore = historyOf(s.db, s.ing.sauce);
    expect(sauceBefore).toMatchObject({ pack_size: 2000, pack_price_cents: 35_625 }); // its roll-up
    // The workbook lists the sauce at its own (made-up) Rs 300 a batch, with the same recipe.
    const file = menuFile([
      { name: 'Test tomato', unit: 'g', costPerUnitCents: 0, packSize: 5000, packPriceCents: 60_000 },
      { name: 'Test garlic', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 45_000 },
      {
        name: 'Test sauce',
        unit: 'g',
        costPerUnitCents: 0,
        packSize: 2000,
        packPriceCents: 30_000,
        batch: { yield: 2000, method: 'Blend and simmer', lines: [{ ingredient: 'Test tomato', qty: 2500 }, { ingredient: 'Test garlic', qty: 125 }] },
      },
    ]);
    s.r.applyMenuImport(s.db, file, 'menu.json', OWNER);
    expect(priceOf(s.db, s.ing.sauce)).toEqual(sauceBefore);
    expect(historyOf(s.db, s.ing.sauce)).toEqual(rowsBefore);
    // Again, and with the sheet's tomatoes dearer: the sauce follows its recipe, never the sheet's Rs 300.
    const dearer = menuFile([
      { name: 'Test tomato', unit: 'g', costPerUnitCents: 0, packSize: 5000, packPriceCents: 70_000 },
      { name: 'Test garlic', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 45_000 },
      {
        name: 'Test sauce',
        unit: 'g',
        costPerUnitCents: 0,
        packSize: 2000,
        packPriceCents: 30_000,
        batch: { yield: 2000, method: 'Blend and simmer', lines: [{ ingredient: 'Test tomato', qty: 2500 }, { ingredient: 'Test garlic', qty: 125 }] },
      },
    ]);
    s.r.applyMenuImport(s.db, dearer, 'menu.json', OWNER);
    expect(priceOf(s.db, s.ing.sauce)).toMatchObject({ pack_size: 2000, pack_price_cents: 40_625 });
    const rows = historyOf(s.db, s.ing.sauce);
    expect(rows.filter((r) => r.source === 'import')).toEqual([]);
    expect(rows.at(-1)).toMatchObject({ source: 'batch', pack_price_cents: 40_625, prev_unit_cost_mc: 17_813 });
  });

  it("a batch with an input still unpriced takes the sheet's price, as before", async () => {
    const s = await shop();
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.garlic, typed: { per: 'thousand', priceCents: 0 } }, MANAGER); // no price
    expect(priceOf(s.db, s.ing.garlic)).toMatchObject({ price_kind: 'unset' });
    const file = menuFile([
      { name: 'Test sauce', unit: 'g', costPerUnitCents: 0, packSize: 2000, packPriceCents: 30_000 },
    ]);
    s.r.applyMenuImport(s.db, file, 'menu.json', OWNER);
    expect(priceOf(s.db, s.ing.sauce)).toMatchObject({ pack_size: 2000, pack_price_cents: 30_000 });
    expect(historyOf(s.db, s.ing.sauce).at(-1)).toMatchObject({ source: 'import', pack_price_cents: 30_000 });
  });
});

// ---------------------------------------------------------------------------
// Batches roll up
// ---------------------------------------------------------------------------

/** Cheese Mix (cheese + garlic) and a pizza topping made of Cheese Mix and sauce. Made-up amounts. */
async function withNestedBatches(s: Awaited<ReturnType<typeof shop>>) {
  const mix = s.r.createIngredient(s.db, { name: 'Test cheese mix', unit: 'g' }, MANAGER).id;
  const topping = s.r.createIngredient(s.db, { name: 'Test pizza topping', unit: 'g' }, MANAGER).id;
  s.r.setBatchRecipe(s.db, { ingredientId: mix, batchYield: 1000, lines: [{ inputIngredientId: s.ing.cheese, qty: 900 }, { inputIngredientId: s.ing.garlic, qty: 100 }] }, MANAGER);
  s.r.setBatchRecipe(s.db, { ingredientId: topping, batchYield: 1000, lines: [{ inputIngredientId: mix, qty: 500 }, { inputIngredientId: s.ing.sauce, qty: 500 }] }, MANAGER);
  return { mix, topping };
}

live('batches roll up: bottom-up, once, only where the price was written', () => {
  it('saving a batch recipe writes its rolled-up price, and its parents', async () => {
    const s = await shop();
    const { mix, topping } = await withNestedBatches(s);
    // 900 g at Rs 1,200 / kg + 100 g at Rs 450 / kg = Rs 1,125 a kilo of mix.
    expect(historyOf(s.db, mix).at(-1)).toMatchObject({ source: 'batch', pack_size: 1000, pack_price_cents: 112_500 });
    // 500 g of mix (Rs 562.50) + 500 g of sauce (Rs 89.0625) = Rs 651.5625 → Rs 651.56.
    expect(historyOf(s.db, topping).at(-1)).toMatchObject({ source: 'batch', pack_size: 1000, pack_price_cents: 65_156 });
  });

  it('a mozzarella change updates Cheese Mix and the topping made with it, once each, and nothing else', async () => {
    const s = await shop();
    const { mix, topping } = await withNestedBatches(s);
    const counts = () => [mix, topping, s.ing.sauce].map((id) => historyOf(s.db, id).length);
    const [m0, t0, sauce0] = counts();
    const res = s.r.setTypedPrice(s.db, { ingredientId: s.ing.cheese, typed: { per: 'thousand', priceCents: 150_000 } }, MANAGER);
    expect(res.rolledUp).toEqual([mix, topping]);
    expect(counts()).toEqual([m0! + 1, t0! + 1, sauce0]);
    // 900 g at Rs 1,500 / kg + 100 g garlic = Rs 1,395 a kilo; the topping: Rs 697.50 + Rs 89.0625 = Rs 786.5625.
    expect(historyOf(s.db, mix).at(-1)).toMatchObject({ id: s.r.batchPriceRowId(mix, res.entryId!), pack_price_cents: 139_500, prev_unit_cost_mc: 112_500 });
    expect(historyOf(s.db, topping).at(-1)).toMatchObject({ id: s.r.batchPriceRowId(topping, res.entryId!), pack_price_cents: 78_656 });
    expect(priceOf(s.db, mix)).toMatchObject({ pack_size: 1000, pack_price_cents: 139_500, price_kind: 'set' });
    // Once: the same trigger again changes nothing.
    expect(s.r.rollUpBatches(s.db, [s.ing.cheese], res.entryId!, MANAGER)).toEqual([]);
    expect(counts()).toEqual([m0! + 1, t0! + 1, sauce0]);
    expect(chainOk(s.db)).toBe(true);
  });

  it("the ▲ / ▼ is against the history's price before (a batch's starting price is its roll-up, whatever its own columns held)", async () => {
    const s = await shop();
    asBeforeHistory(s.db);
    // The sauce's own columns hold the costing sheet's Rs 300 a batch; costing (and its starting price) use the roll-up.
    s.db.prepare(`UPDATE ingredients SET pack_size = 2000, pack_price_cents = 30000, cost_per_unit_cents = 15, price_kind = 'set' WHERE id = ?`).run(s.ing.sauce);
    s.r.seedPriceHistoryOnce(s.db, DEV);
    expect(historyOf(s.db, s.ing.sauce)).toEqual([expect.objectContaining({ source: 'seed', pack_price_cents: 35_625, unit_cost_mc: 17_813 })]);
    // Tomatoes dearer (Rs 140 / kg): the sauce is Rs 406.25 a batch — 14% up on its starting Rs 356.25, not 35% on the sheet's Rs 300.
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.tomato, typed: { per: 'pack', priceCents: 70_000, packSize: 5000 } }, MANAGER);
    const row = historyOf(s.db, s.ing.sauce).at(-1)!;
    expect(row).toMatchObject({ source: 'batch', pack_price_cents: 40_625, unit_cost_mc: 20_313, prev_unit_cost_mc: 17_813 });
    const { priceChangeBps } = await import('@cheeseoclock/pos-domain');
    expect(priceChangeBps(row.prev_unit_cost_mc, row.unit_cost_mc)).toBe(1_403);
  });

  it('"Set price" on a batch costed from its recipe is refused in plain words; one with an input unpriced takes it', async () => {
    const s = await shop();
    const rows = historyOf(s.db, s.ing.sauce).length;
    expect(() => s.r.setTypedPrice(s.db, { ingredientId: s.ing.sauce, typed: { per: 'thousand', priceCents: 90_000 } }, MANAGER)).toThrow(
      /Test sauce is made here, so its price is worked out from its batch recipe\. To change it, change the price of what goes into it, or its recipe\./,
    );
    expect(historyOf(s.db, s.ing.sauce)).toHaveLength(rows);
    expect(priceOf(s.db, s.ing.sauce)).toMatchObject({ pack_price_cents: 35_625 });
    // Garlic loses its price: the sauce can't be rolled up, and a typed price stands in.
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.garlic, typed: { per: 'thousand', priceCents: 0 } }, MANAGER);
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.sauce, typed: { per: 'thousand', priceCents: 20_000 }, priceKind: 'estimate' }, MANAGER);
    expect(priceOf(s.db, s.ing.sauce)).toMatchObject({ pack_size: 1000, pack_price_cents: 20_000, price_kind: 'estimate' });
  });

  it('an input with no price leaves the batch at its own price (Missing costs lists it)', async () => {
    const s = await shop();
    const { mix } = await withNestedBatches(s);
    const before = historyOf(s.db, mix).length;
    const res = s.r.setTypedPrice(s.db, { ingredientId: s.ing.garlic, typed: { per: 'thousand', priceCents: 0 } }, MANAGER);
    expect(priceOf(s.db, s.ing.garlic)).toMatchObject({ price_kind: 'unset' });
    expect(res.rolledUp).not.toContain(mix);
    expect(historyOf(s.db, mix)).toHaveLength(before);
  });

  it('arriving on the other till it does NOT roll up again: the rows arrive as rows, nothing is queued', async () => {
    const s = await shop();
    const { mix, topping } = await withNestedBatches(s);
    const { db2 } = await secondTill(s.db);
    const { listPendingSync, pendingToChange, applyRemoteBatch, markSyncedIds } = await repos();
    const res = s.r.setTypedPrice(s.db, { ingredientId: s.ing.cheese, typed: { per: 'thousand', priceCents: 150_000 } }, MANAGER);
    const pending = listPendingSync(s.db, 1_000_000);
    const queuedOn2 = n(db2, `SELECT COUNT(*) AS n FROM sync_queue`);
    const batchRowsOn2 = () => n(db2, `SELECT COUNT(*) AS n FROM ingredient_costs WHERE source = 'batch'`);
    const batch0 = batchRowsOn2();
    // Only the cheese's own price arrives first (its row and its history row).
    const cheeseOnly = pending.filter((p) => p.entityId === s.ing.cheese || p.entityId === res.entryId);
    expect(cheeseOnly.length).toBeGreaterThanOrEqual(2);
    const r1 = await applyRemoteBatch(db2, cheeseOnly.map((p) => pendingToChange(p, DEV)), { pause: async () => {} });
    expect(r1).toMatchObject({ waiting: 0, dropped: 0 });
    expect(priceOf(db2, s.ing.cheese)).toMatchObject({ pack_size: 1000, pack_price_cents: 150_000 });
    // Cheese Mix and the topping are NOT rolled up here: no batch rows, their price as before, nothing queued.
    expect(batchRowsOn2()).toBe(batch0);
    expect(priceOf(db2, mix)).toMatchObject({ pack_price_cents: 112_500 });
    expect(n(db2, `SELECT COUNT(*) AS n FROM sync_queue`)).toBe(queuedOn2);
    // Then the rest: till 1's own batch rows, the same ones, once.
    const r2 = await applyRemoteBatch(db2, pending.map((p) => pendingToChange(p, DEV)), { pause: async () => {} });
    markSyncedIds(s.db, pending.map((p) => p.id));
    expect(r2).toMatchObject({ waiting: 0, dropped: 0 });
    expect(batchRowsOn2()).toBe(batch0 + 2);
    for (const id of [mix, topping]) {
      expect(n(db2, `SELECT COUNT(*) AS n FROM ingredient_costs WHERE id = ?`, s.r.batchPriceRowId(id, res.entryId!))).toBe(1);
      expect(priceOf(db2, id)).toEqual(priceOf(s.db, id));
    }
    expect(n(db2, `SELECT COUNT(*) AS n FROM sync_queue`)).toBe(queuedOn2);
    expect(s.r.readParked(db2)).toEqual([]);
  });

  it('the cycle guard: a loop (A needs B needs A) is never followed round, and never rolled up', async () => {
    const s = await shop();
    const a = s.r.createIngredient(s.db, { name: 'Test loop A', unit: 'g' }, MANAGER).id;
    const b = s.r.createIngredient(s.db, { name: 'Test loop B', unit: 'g' }, MANAGER).id;
    // setBatchRecipe refuses a loop; bad data could still hold one.
    const line = s.db.prepare(
      `INSERT INTO batch_recipe_lines (id, ingredient_id, input_ingredient_id, qty, sort_order, created_at, updated_at, device_id)
       VALUES (?, ?, ?, ?, 0, 'x', 'x', ?)`,
    );
    line.run('loop-1', a, b, 10, DEV);
    line.run('loop-2', b, a, 10, DEV);
    line.run('loop-3', a, s.ing.cheese, 10, DEV);
    s.db.prepare(`UPDATE ingredients SET batch_yield = 100 WHERE id IN (?, ?)`).run(a, b);
    const res = s.r.setTypedPrice(s.db, { ingredientId: s.ing.cheese, typed: { per: 'thousand', priceCents: 130_000 } }, MANAGER);
    expect(res.rolledUp).toEqual([]);
    expect(n(s.db, `SELECT COUNT(*) AS n FROM ingredient_costs WHERE ingredient_id IN (?, ?) AND source = 'batch'`, a, b)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reports: the price in force when the stock was taken
// ---------------------------------------------------------------------------

live('effective-dated estimates', () => {
  it('sell (an order that kept no cost), change the price: the estimate stays at the old price; a put-back nets to Rs 0', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-10T10:00:00.000Z'));
    const s = await shop();
    s.r.openShift(s.db, { openingCashCents: 0 }, MANAGER);
    const lines: Line[] = [['fajitaM', 1]];
    const o = s.ring(lines);
    s.r.sendOrderToKitchen(s.db, o, CASHIER);
    s.markPaid(o, new Date('2026-09-10T10:00:00.000Z'));
    s.db.prepare(`DELETE FROM order_item_costs WHERE order_id = ?`).run(o);
    s.db.prepare(`UPDATE stock_movements SET value_cents = NULL, unit_cost_mc = NULL, cost_basis = NULL WHERE ref_order_id = ?`).run(o);
    const { getBusinessReport } = await import('../services/business-report.js');
    const week = { sinceIso: '2026-09-07T00:00:00.000Z', untilIso: '2026-09-14T00:00:00.000Z' };
    expect(getBusinessReport(s.db, week).foodCost).toMatchObject({ estimatedOrders: 1, estimatedCostCents: 17_641 });
    vi.setSystemTime(new Date('2026-09-12T10:00:00.000Z'));
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.cheese, typed: { per: 'thousand', priceCents: 240_000 } }, MANAGER);
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.dough, typed: { per: 'thousand', priceCents: 20_000 } }, MANAGER);
    // Still at the prices of 10 Sep, whatever cheese and dough cost now.
    expect(getBusinessReport(s.db, week).foodCost).toMatchObject({ estimatedOrders: 1, estimatedCostCents: 17_641 });
    // A put-back booked later against that take (a row from before costing too) is worth the take's price, so the two net out.
    s.db
      .prepare(
        `INSERT INTO stock_movements (id, ingredient_id, delta_qty, reason, ref_order_id, notes, actor_user_id, occurred_at, resulting_qty, unit, created_at, updated_at, device_id)
         VALUES ('putback-1', ?, 60, 'sale', ?, 'Put back', ?, '2026-09-12T11:00:00.000Z', 0, 'g', 'x', 'x', ?)`,
      )
      .run(s.ing.cheese, o, MANAGER.userId, DEV);
    // 60 g of cheese back, at the 10 Sep Rs 1,200 / kg: Rs 72 off the estimate.
    expect(getBusinessReport(s.db, week).foodCost).toMatchObject({ estimatedOrders: 1, estimatedCostCents: 17_641 - 7_200 });
  });
});
