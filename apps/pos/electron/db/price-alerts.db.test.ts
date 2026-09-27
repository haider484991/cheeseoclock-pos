/**
 * Costing, Phase 6 — the costing sheet stops overwriting till prices; price
 * alerts (migration 0036), against a real database built from every
 * migration and the made-up shop (costing-shop.fixture.ts):
 *
 *   - the import matrix: a new ingredient and one with no price take the
 *     sheet's; 'free' stays free; a newer delivery price and a newer typed
 *     price are kept; the sheet's reference is always stored (and updated,
 *     synced and audited); "Use the sheet's price" writes a typed ('manual')
 *     line in the price history; the preview says it in ONE line;
 *   - a batch made here: the sheet's price for it is a reference only;
 *   - alerts: a key ingredient's jump alerts once; a small change to a minor
 *     one does not; one that costs the menu Rs N a week does; the same price
 *     arriving on the other till alerts nothing there (single writer, name-
 *     based ids: one row on both tills); a delivery's prices are looked at
 *     once, for the whole bill;
 *   - the Monday digest: an item crossing into red is listed once, and a
 *     wobble around the line does not fire again; a change in what customers
 *     pick, alone, never fires;
 *   - D1's purchase guard uses the owner's alert threshold.
 *
 * node:sqlite behind better-sqlite3's shape; skips where node:sqlite is
 * missing. EVERY PRICE IS MADE UP (costing spec D11: the repo is public).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { menuImportFileSchema } from '@cheeseoclock/shared-schemas';
import type { CostAlertsView, PriceJumpAlert, WeeklyDigestAlert } from '@cheeseoclock/shared-types';
import type { AppDatabase } from './connection.js';
import { CASHIER, DEV, DatabaseSync, MANAGER, OWNER, openCostingShop, openMigrated } from './costing-shop.fixture.js';
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

async function repos() {
  return {
    ...(await import('./repositories/ingredient-cost-repo.js')),
    ...(await import('./repositories/cost-alert-repo.js')),
    ...(await import('./repositories/procurement-repo.js')),
    ...(await import('./repositories/menu-import-repo.js')),
    ...(await import('./repositories/business-settings-repo.js')),
    ...(await import('./repositories/sync-repo.js')),
    ...(await import('./repositories/apply-remote.js')),
    ...(await import('../services/costing-service.js')),
  };
}

/** The made-up shop, with this file's repositories beside the fixture's. */
async function shop(db: AppDatabase = openMigrated()) {
  const s = await openCostingShop(db);
  const r = { ...s.r, ...(await repos()) };
  const price = (id: string) =>
    db.prepare(`SELECT pack_size AS size, pack_price_cents AS price, price_kind AS kind FROM ingredients WHERE id = ?`).get(id) as {
      size: number | null;
      price: number | null;
      kind: string;
    };
  const sheet = (id: string) =>
    db.prepare(`SELECT sheet_pack_size AS size, sheet_pack_price_cents AS price, sheet_price_kind AS kind FROM ingredients WHERE id = ?`).get(id) as {
      size: number | null;
      price: number | null;
      kind: string | null;
    };
  const history = (id: string) =>
    db
      .prepare(`SELECT id, source, pack_size AS size, pack_price_cents AS price, notes FROM ingredient_costs WHERE ingredient_id = ? ORDER BY effective_at, rowid`)
      .all(id) as Array<{ id: string; source: string; size: number; price: number; notes: string | null }>;
  const alerts = (kind?: string) =>
    (
      db
        .prepare(
          `SELECT id, kind, ingredient_id AS ingredientId, ingredient_cost_id AS costId, impact_week_cents AS impact,
                  seen_at AS seenAt, device_id AS deviceId, after_json AS afterJson
             FROM cost_alerts ${kind ? 'WHERE kind = ?' : ''} ORDER BY created_at, rowid`,
        )
        .all(...(kind ? [kind] : [])) as Array<{
        id: string;
        kind: string;
        ingredientId: string | null;
        costId: string | null;
        impact: number;
        seenAt: string | null;
        deviceId: string;
        afterJson: string;
      }>
    ).map((a) => ({ ...a, impact: Number(a.impact), detail: JSON.parse(a.afterJson) as Record<string, unknown> }));
  return { db, ...s, r, price, sheet, history, alerts };
}

/** The price alerts as the owner sets them (made-up thresholds). */
function alertSettings(s: Awaited<ReturnType<typeof shop>>, keys: string[], impactWeekCents = 100_000, jumpBps = 1_000) {
  s.r.setBusinessSetting(s.db, 'costing.alerts', { jumpBps, impactWeekCents, keyIngredientIds: keys }, OWNER);
}

/** A menu file (made-up prices). */
const menuFile = (ingredients: Array<Record<string, unknown>>) =>
  menuImportFileSchema.parse({ format: 'cheeseoclock-menu-import', version: 3, source: 'test', categories: [], ingredients, items: [] });

// ---------------------------------------------------------------------------
// Two tills
// ---------------------------------------------------------------------------

function iAm(db: AppDatabase, id: string) {
  db.prepare(`INSERT INTO device_info (id, device_id, display_name, registered_at) VALUES ('singleton', ?, ?, ?)`).run(id, id, new Date().toISOString());
}

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

// ---------------------------------------------------------------------------
// Who owns the price: the import matrix
// ---------------------------------------------------------------------------

live('the menu import keeps the till\'s prices (costing Phase 6)', () => {
  it('new → sheet; unset → sheet; free stays free; a newer delivery and a newer typed price are kept; the sheet is always the reference', async () => {
    const s = await shop();
    const sup = s.r.createSupplier(s.db, { name: 'Test Dairy' }, MANAGER);
    // A delivery at Rs 1,300 / kg (the fixture's Rs 1,200 / kg before it), and a price typed on the till.
    const po = s.r.createPurchaseOrder(s.db, { supplierId: sup.id, items: [{ ingredientId: s.ing.cheese, qtyOrdered: 2_000, price: { per: 'thousand', priceCents: 130_000 } }] }, MANAGER);
    s.r.receiveDelivery(s.db, { purchaseOrderId: po.id, receipts: [{ purchaseOrderItemId: po.items[0]!.id, qtyReceivedNow: 2_000 }] }, MANAGER);
    expect(s.price(s.ing.cheese)).toMatchObject({ size: 2_000, price: 260_000 });
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.olive, typed: { per: 'thousand', priceCents: 150_000 } }, MANAGER);
    const file = menuFile([
      { name: 'Test cheese', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 110_000 },
      { name: 'Test olive', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 100_000 },
      { name: 'Test salt', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 2_000 },
      { name: 'Test bottle', unit: 'pcs', costPerUnitCents: 4_000 },
      { name: 'Test basil', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 200_000 },
      { name: 'Test onion', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 15_000 },
    ]);
    const preview = s.r.planMenuImportFromDb(s.db, file).preview;
    expect(preview.summary.priceLine).toBe('Prices: 1 kept from deliveries, 2 kept as typed, 1 kept as they are, 2 new from the sheet, 0 unpriced.');
    expect(preview.summary.prices.sheetDiffers).toBe(2); // cheese and olive; onion's is the same

    const summary = s.r.applyMenuImport(s.db, file, 'menu.json', OWNER);
    expect(summary.priceLine).toBe(preview.summary.priceLine);
    const sha = s.r.menuFileSha256(file);
    // Kept: the delivery's cheese, the typed olive, the free salt.
    expect(s.price(s.ing.cheese)).toMatchObject({ size: 2_000, price: 260_000, kind: 'set' });
    expect(s.history(s.ing.cheese).at(-1)).toMatchObject({ source: 'delivery' });
    expect(s.price(s.ing.olive)).toMatchObject({ size: 1_000, price: 150_000 });
    expect(s.history(s.ing.olive).at(-1)).toMatchObject({ source: 'manual' });
    expect(s.price(s.ing.salt)).toMatchObject({ kind: 'free' });
    // The sheet's: the bottle had none, the basil is new — one 'import' row each, named after the file.
    expect(s.price(s.ing.bottle)).toMatchObject({ kind: 'set' });
    expect(s.history(s.ing.bottle).at(-1)).toMatchObject({ id: s.r.importPriceRowId(s.ing.bottle, sha), source: 'import', size: 1, price: 4_000 });
    const basil = s.r.listIngredients(s.db).find((i) => i.name === 'Test basil')!;
    expect(s.history(basil.id)).toEqual([expect.objectContaining({ id: s.r.importPriceRowId(basil.id, sha), source: 'import', size: 1000, price: 200_000 })]);
    // The sheet's price is the reference of every one of them, exactly as the file gives it.
    expect(s.sheet(s.ing.cheese)).toEqual({ size: 1000, price: 110_000, kind: 'set' });
    expect(s.sheet(s.ing.olive)).toEqual({ size: 1000, price: 100_000, kind: 'set' });
    expect(s.sheet(s.ing.salt)).toEqual({ size: 1000, price: 2_000, kind: 'set' });
    expect(s.sheet(s.ing.bottle)).toEqual({ size: 1, price: 4_000, kind: 'set' });
    expect(s.sheet(basil.id)).toEqual({ size: 1000, price: 200_000, kind: 'set' });
    expect(chainOk(s.db)).toBe(true);
  });

  it('the sheet reference is updated by the next file (synced and audited); the price stays', async () => {
    const s = await shop();
    const first = menuFile([{ name: 'Test cheese', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 110_000 }]);
    s.r.applyMenuImport(s.db, first, 'menu.json', OWNER);
    const refRows = () => n(s.db, `SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'ingredients' AND entity_id = ? AND action = 'set_sheet_price'`, s.ing.cheese);
    expect(refRows()).toBe(1);
    // The same file again: the reference is already that, nothing written.
    s.r.applyMenuImport(s.db, first, 'menu.json', OWNER);
    expect(refRows()).toBe(1);
    const queued = n(s.db, `SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'ingredients' AND entity_id = ?`, s.ing.cheese);
    s.r.applyMenuImport(s.db, menuFile([{ name: 'Test cheese', unit: 'g', costPerUnitCents: 0, packSize: 2000, packPriceCents: 230_000, priceIsEstimate: true }]), 'menu.json', OWNER);
    expect(s.sheet(s.ing.cheese)).toEqual({ size: 2000, price: 230_000, kind: 'estimate' });
    expect(refRows()).toBe(2);
    expect(n(s.db, `SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'ingredients' AND entity_id = ?`, s.ing.cheese)).toBe(queued + 1);
    // The row travels as itself, the reference with it.
    const image = JSON.parse(
      (s.db.prepare(`SELECT payload_json FROM sync_queue WHERE entity_type = 'ingredients' AND entity_id = ? ORDER BY rowid DESC LIMIT 1`).get(s.ing.cheese) as { payload_json: string }).payload_json,
    );
    expect(image).toMatchObject({ sheetPackSize: 2000, sheetPackPriceCents: 230_000, sheetPriceKind: 'estimate' });
    expect(s.price(s.ing.cheese)).toMatchObject({ size: 2000, price: 240_000, kind: 'set' }); // the fixture's own
  });

  it("\"Use the sheet's price\" writes a typed ('manual') line in the price history; refused where it can't apply", async () => {
    const s = await shop();
    s.r.applyMenuImport(
      s.db,
      menuFile([
        { name: 'Test cheese', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 110_000 },
        { name: 'Test tomato', unit: 'g', costPerUnitCents: 0, packSize: 5000, packPriceCents: 70_000 },
        { name: 'Test sauce', unit: 'g', costPerUnitCents: 0, packSize: 2000, packPriceCents: 30_000 },
        { name: 'Test bottle', unit: 'pcs', costPerUnitCents: 0 },
      ]),
      'menu.json',
      OWNER,
    );
    const before = s.history(s.ing.cheese).length;
    const res = s.r.useSheetPrice(s.db, s.ing.cheese, MANAGER);
    const rows = s.history(s.ing.cheese);
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({ id: res.entryId, source: 'manual', size: 1000, price: 110_000, notes: "The costing sheet's price" });
    expect(s.price(s.ing.cheese)).toMatchObject({ size: 1000, price: 110_000, kind: 'set' });
    expect(n(s.db, `SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'ingredient_costs' AND entity_id = ?`, res.entryId)).toBe(1);
    // A batch costed from its recipe: its sheet figure is only a reference.
    expect(() => s.r.useSheetPrice(s.db, s.ing.sauce, MANAGER)).toThrow(/made here/);
    // The sheet says Rs 0: nothing to use.
    expect(() => s.r.useSheetPrice(s.db, s.ing.bottle, MANAGER)).toThrow(/no price/);
    // No menu file has named it.
    expect(() => s.r.useSheetPrice(s.db, s.ing.garlic, MANAGER)).toThrow(/Import the menu file first/);
    expect(chainOk(s.db)).toBe(true);
  });

  it("Convert kg → g takes the sheet's reference with it: the same figure, never read per gram", async () => {
    const s = await shop();
    // Counted in kg on the till, Rs 1,200 / kg typed; the sheet says Rs 1,500 / kg (made-up).
    const paneer = s.r.createIngredient(s.db, { name: 'Test paneer', unit: 'kg', costPerUnitCents: 120_000 }, MANAGER).id;
    s.r.applyMenuImport(s.db, menuFile([{ name: 'Test paneer', unit: 'kg', costPerUnitCents: 150_000 }]), 'menu.json', OWNER);
    expect(s.sheet(paneer)).toEqual({ size: 1, price: 150_000, kind: 'set' });
    const at = (s.db.prepare(`SELECT sheet_price_at AS at FROM ingredients WHERE id = ?`).get(paneer) as { at: string }).at;
    const { readSheetPrices } = await import('./price-history-read.js');
    const perKgMc = readSheetPrices(s.db).get(paneer)!.unitCostMc;

    s.r.convertIngredientToBaseUnit(s.db, paneer, MANAGER);
    // Now in grams: 1,000 g for Rs 1,500 — the same money for the same amount, dated when the sheet said it.
    expect(s.sheet(paneer)).toEqual({ size: 1000, price: 150_000, kind: 'set' });
    expect((s.db.prepare(`SELECT sheet_price_at AS at FROM ingredients WHERE id = ?`).get(paneer) as { at: string }).at).toBe(at);
    expect(readSheetPrices(s.db).get(paneer)!.unitCostMc * 1000).toBe(perKgMc);
    const audit = s.db
      .prepare(`SELECT before_json AS b, after_json AS a FROM audit_log WHERE entity_id = ? AND action = 'set_sheet_price' ORDER BY rowid DESC LIMIT 1`)
      .get(paneer) as { b: string; a: string };
    expect(JSON.parse(audit.b)).toMatchObject({ unit: 'kg', sheetPrice: { packSize: 1, packPriceCents: 150_000 } });
    expect(JSON.parse(audit.a)).toMatchObject({ unit: 'g', sheetPrice: { packSize: 1000, packPriceCents: 150_000 } });
    expect(n(s.db, `SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'ingredients' AND entity_id = ?`, paneer)).toBeGreaterThan(0);

    // "Use the sheet's price" then gives Rs 1,500 / kg in grams — not Rs 1,500 a gram.
    s.r.useSheetPrice(s.db, paneer, MANAGER);
    expect(s.price(paneer)).toMatchObject({ size: 1000, price: 150_000, kind: 'set' });
    // The next file, in grams now, says the same thing: nothing new to note.
    const refRows = () => n(s.db, `SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ? AND action = 'set_sheet_price'`, paneer);
    const rows = refRows();
    s.r.applyMenuImport(s.db, menuFile([{ name: 'Test paneer', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 150_000 }]), 'menu.json', OWNER);
    expect(refRows()).toBe(rows);
    expect(chainOk(s.db)).toBe(true);
  });

  it("a batch's sheet price never overrides a complete roll-up (new from the file, or already here)", async () => {
    const s = await shop();
    const file = menuFile([
      { name: 'Test tomato', unit: 'g', costPerUnitCents: 0, packSize: 5000, packPriceCents: 60_000 },
      { name: 'Test garlic', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 45_000 },
      { name: 'Test sauce', unit: 'g', costPerUnitCents: 0, packSize: 2000, packPriceCents: 99_900, batch: { yield: 2000, lines: [{ ingredient: 'Test tomato', qty: 2500 }, { ingredient: 'Test garlic', qty: 125 }] } },
      { name: 'Test pesto', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 99_900, batch: { yield: 1000, lines: [{ ingredient: 'Test garlic', qty: 200 }] } },
    ]);
    s.r.applyMenuImport(s.db, file, 'menu.json', OWNER);
    // The sauce: 2,500 g tomato at Rs 120 / kg + 125 g garlic at Rs 450 / kg = Rs 356.25 for 2,000 g.
    expect(s.price(s.ing.sauce)).toMatchObject({ size: 2000, price: 35_625 });
    expect(s.sheet(s.ing.sauce)).toEqual({ size: 2000, price: 99_900, kind: 'set' });
    // The pesto is new: its first price is the sheet's, then its recipe's (200 g garlic = Rs 90 for 1,000 g).
    const pesto = s.r.listIngredients(s.db).find((i) => i.name === 'Test pesto')!;
    expect(s.price(pesto.id)).toMatchObject({ size: 1000, price: 9_000 });
    expect(s.history(pesto.id).map((r) => r.source)).toEqual(['import', 'batch']);
    expect(s.alerts('batch_unpriced_input')).toEqual([]);
  });

  it("the ONE line counts a batch its recipe can't price as what the import really does to it", async () => {
    const s = await shop();
    const tomato = { name: 'Test tomato', unit: 'g', costPerUnitCents: 0, packSize: 5000, packPriceCents: 60_000 };
    // A paste made here, priced from its recipe: 1,500 g tomato at Rs 120 / kg = Rs 180 for 1,000 g.
    s.r.applyMenuImport(
      s.db,
      menuFile([tomato, { name: 'Test paste', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 20_000, batch: { yield: 1000, lines: [{ ingredient: 'Test tomato', qty: 1500 }] } }]),
      'menu.json',
      OWNER,
    );
    const paste = s.r.listIngredients(s.db).find((i) => i.name === 'Test paste')!;
    expect(s.price(paste.id)).toMatchObject({ size: 1000, price: 18_000, kind: 'set' });

    const file = menuFile([
      tomato,
      { name: 'Test sumac', unit: 'g', costPerUnitCents: 0 }, // new, Rs 0 in the sheet
      // Now with the sumac in it: it can't be priced from its recipe, so it keeps its price.
      { name: 'Test paste', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 20_000, batch: { yield: 1000, lines: [{ ingredient: 'Test tomato', qty: 1500 }, { ingredient: 'Test sumac', qty: 10 }] } },
      // New, Rs 0 in the sheet, made from the sumac: no price anywhere.
      { name: 'Test dip', unit: 'g', costPerUnitCents: 0, batch: { yield: 1000, lines: [{ ingredient: 'Test sumac', qty: 100 }] } },
    ]);
    const preview = s.r.planMenuImportFromDb(s.db, file).preview;
    expect(preview.summary.prices).toMatchObject({ madeHere: 0, batchKept: 1, newFromSheet: 0, unpriced: 2 });
    expect(preview.summary.priceLine).toContain('1 batch keeps its price (something in it has no price)');
    expect(preview.summary.priceLine).not.toContain('worked out from their batch recipe');

    const summary = s.r.applyMenuImport(s.db, file, 'menu.json', OWNER);
    expect(summary.priceLine).toBe(preview.summary.priceLine);
    // What the line said is what happened: the paste kept its price, the dip has none, and Costing → Alerts says so for both.
    expect(s.price(paste.id)).toMatchObject({ size: 1000, price: 18_000, kind: 'set' });
    const dip = s.r.listIngredients(s.db).find((i) => i.name === 'Test dip')!;
    expect(s.price(dip.id)).toMatchObject({ kind: 'unset' });
    expect(s.alerts('batch_unpriced_input').map((a) => a.ingredientId).sort()).toEqual([paste.id, dip.id].sort());
  });
});

// ---------------------------------------------------------------------------
// Price alerts
// ---------------------------------------------------------------------------

/** Paid sales of a Fajita Medium in the last 28 days: `units` of them (made-up). */
function sellFajitas(s: Awaited<ReturnType<typeof shop>>, units: number, at = new Date(Date.now() - 86_400_000)) {
  s.markPaid(s.ring([['fajitaM', units]]), at);
}

live('price alerts (costing Phase 6)', () => {
  it('a key ingredient that jumps alerts once, with the dishes it moved', async () => {
    const s = await shop();
    alertSettings(s, [s.ing.cheese]);
    const res = s.r.setTypedPrice(s.db, { ingredientId: s.ing.cheese, typed: { per: 'thousand', priceCents: 150_000 } }, MANAGER); // Rs 1,200 → 1,500 / kg
    const jumps = s.alerts('price_jump');
    expect(jumps).toHaveLength(1);
    const a = jumps[0]!;
    expect(a).toMatchObject({ id: s.r.costAlertId('price_jump', s.ing.cheese, res.entryId!), ingredientId: s.ing.cheese, costId: res.entryId, seenAt: null, deviceId: DEV });
    const d = a.detail as unknown as PriceJumpAlert;
    expect(d).toMatchObject({ kind: 'price_jump', key: true, changeBps: 2_500, source: 'manual', before: { unitCostMc: 120_000 }, after: { unitCostMc: 150_000 } });
    // Fajita Medium (60 g), Veggie Lovers (90 g) and the deal's pizzas use it: each costs more.
    expect(d.items.map((i) => i.name).sort()).toEqual(['Big Two Deal', 'Fajita Pizza — Medium', 'Veggie Lovers — Large']);
    expect(d.items.find((i) => i.name === 'Fajita Pizza — Medium')).toMatchObject({ costBeforeCents: 17_641, costAfterCents: 19_441, soldLast28: 0, impactWeekCents: 0 });
    expect(n(s.db, `SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'cost_alerts' AND entity_id = ?`, a.id)).toBe(1);
    expect(n(s.db, `SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'cost_alerts' AND entity_id = ?`, a.id)).toBe(1);
    // Looked at again (the same write): the same alert, nothing new. The same price typed again: no change, no alert.
    s.r.evaluatePriceAlerts(s.db, [res.written!], MANAGER);
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.cheese, typed: { per: 'thousand', priceCents: 150_000 } }, MANAGER);
    expect(s.alerts('price_jump')).toHaveLength(1);
    // Listed on Costing → Alerts, not seen yet; "Seen" takes it off the top, synced and audited.
    const view: CostAlertsView = s.r.getCostAlerts(s.db);
    expect(view.unseen).toBe(1);
    expect(view.alerts[0]).toMatchObject({ id: a.id, kind: 'price_jump', impactWeekCents: 0, seenAt: null });
    expect(s.r.markCostAlertsSeen(s.db, [a.id], MANAGER)).toBe(1);
    expect(s.r.markCostAlertsSeen(s.db, [a.id], MANAGER)).toBe(0);
    expect(s.r.getCostAlerts(s.db)).toMatchObject({ unseen: 0, alerts: [{ id: a.id, seenByName: 'Test Manager' }] });
    expect(n(s.db, `SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'cost_alerts' AND action = 'seen'`)).toBe(1);
    expect(chainOk(s.db)).toBe(true);
  });

  it('a small change to an ingredient that is not key alerts nothing; nor a big one nobody buys', async () => {
    const s = await shop();
    alertSettings(s, [s.ing.cheese]);
    sellFajitas(s, 40);
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.onion, typed: { per: 'thousand', priceCents: 15_750 } }, MANAGER); // +5%, 10 g a pizza
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.olive, typed: { per: 'thousand', priceCents: 240_000 } }, MANAGER); // +100%, but no olive sold
    expect(s.alerts('price_jump')).toEqual([]);
  });

  it('a change that costs the menu at least the weekly amount alerts, key or not', async () => {
    const s = await shop();
    alertSettings(s, [s.ing.cheese], 50_000); // Rs 500 a week
    sellFajitas(s, 40); // 10 a week
    // Chicken Rs 900 → 2,200 / kg: 40 g a pizza is Rs 52 more, × 10 a week = Rs 520.
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.chicken, typed: { per: 'thousand', priceCents: 220_000 } }, MANAGER);
    const jumps = s.alerts('price_jump');
    expect(jumps).toHaveLength(1);
    expect(jumps[0]).toMatchObject({ ingredientId: s.ing.chicken, impact: 52_000 });
    expect(jumps[0]!.detail).toMatchObject({ key: false, itemsMoved: 3 });
    expect((jumps[0]!.detail as unknown as PriceJumpAlert).items[0]).toMatchObject({ name: 'Fajita Pizza — Medium', soldLast28: 40, impactWeekCents: 52_000 });
    // Rs 2,200 → 2,250 / kg: Rs 2 a pizza, Rs 20 a week — under the amount, and chicken is not key here.
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.chicken, typed: { per: 'thousand', priceCents: 225_000 } }, MANAGER);
    expect(s.alerts('price_jump')).toHaveLength(1);
  });

  it('the same price arriving on the other till alerts nothing there: one alert, the same row on both', async () => {
    const s = await shop();
    alertSettings(s, [s.ing.cheese]);
    const { db2, push } = await secondTill(s.db);
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.cheese, typed: { per: 'thousand', priceCents: 150_000 } }, MANAGER);
    const mine = s.alerts().map((a) => a.id);
    expect(mine).toHaveLength(1);
    expect(await push(s.db, DEV, db2)).toMatchObject({ waiting: 0, dropped: 0 });
    // The price and its history row arrived; no alert was worked out on till 2 — only till 1's arrived, as a row.
    expect((db2.prepare(`SELECT pack_price_cents AS p FROM ingredients WHERE id = ?`).get(s.ing.cheese) as { p: number }).p).toBe(150_000);
    const theirs = db2.prepare(`SELECT id, device_id AS d FROM cost_alerts`).all() as Array<{ id: string; d: string }>;
    expect(theirs).toEqual([{ id: mine[0], d: DEV }]);
    // Seen on till 2: the same row, back on till 1.
    s.r.markCostAlertsSeen(db2, mine, { userId: MANAGER.userId, deviceId: TILL_2 });
    expect(await push(db2, TILL_2, s.db)).toMatchObject({ waiting: 0, dropped: 0 });
    expect(s.alerts()[0]).toMatchObject({ id: mine[0] });
    expect(s.alerts()[0]!.seenAt).not.toBeNull();
    expect(s.r.readParked(db2)).toEqual([]);
    expect(s.r.readParked(s.db)).toEqual([]);
  });

  it("a delivery's prices are looked at once, for the whole bill, and say they came from a bill", async () => {
    const s = await shop();
    alertSettings(s, [s.ing.cheese]);
    const sup = s.r.createSupplier(s.db, { name: 'Test Dairy' }, MANAGER);
    const po = s.r.createPurchaseOrder(
      s.db,
      {
        supplierId: sup.id,
        items: [
          { ingredientId: s.ing.cheese, qtyOrdered: 2_000, price: { per: 'thousand', priceCents: 150_000 } },
          { ingredientId: s.ing.onion, qtyOrdered: 1_000, price: { per: 'thousand', priceCents: 15_300 } },
        ],
      },
      MANAGER,
    );
    s.r.receiveDelivery(s.db, { purchaseOrderId: po.id, receipts: po.items.map((i) => ({ purchaseOrderItemId: i.id, qtyReceivedNow: i.qtyOrdered })) }, MANAGER);
    const jumps = s.alerts('price_jump');
    expect(jumps).toHaveLength(1);
    expect(jumps[0]!.detail).toMatchObject({ ingredientName: 'Test cheese', source: 'delivery', key: true });
  });

  it('a batch that keeps its old price because something in it has none: one alert until it is seen', async () => {
    const s = await shop();
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.garlic, typed: { per: 'thousand', priceCents: 0 } }, MANAGER); // no price
    const first = s.alerts('batch_unpriced_input');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ ingredientId: s.ing.sauce });
    expect(first[0]!.detail).toMatchObject({ because: 'price', changedName: 'Test garlic', unpricedInputs: [{ name: 'Test garlic' }] });
    // The tomatoes change: the sauce still can't follow them — but it is already said.
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.tomato, typed: { per: 'thousand', priceCents: 14_000 } }, MANAGER);
    expect(s.alerts('batch_unpriced_input')).toHaveLength(1);
    s.r.markCostAlertsSeen(s.db, [first[0]!.id], MANAGER);
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.tomato, typed: { per: 'thousand', priceCents: 15_000 } }, MANAGER);
    expect(s.alerts('batch_unpriced_input')).toHaveLength(2);
    expect(s.alerts('batch_unpriced_input')[1]!.detail).toMatchObject({ changedName: 'Test tomato' });

    // A price typed on the sauce itself (its recipe can't price it, so that is allowed) is its price, not one it
    // "kept": no alert about it — nor from "Use the sheet's price" on it.
    s.r.markCostAlertsSeen(s.db, s.alerts('batch_unpriced_input').map((a) => a.id), MANAGER);
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.sauce, typed: { per: 'thousand', priceCents: 20_000 } }, MANAGER);
    expect(s.price(s.ing.sauce)).toMatchObject({ size: 1000, price: 20_000 });
    s.r.setSheetPrice(s.db, s.ing.sauce, { packSize: 2000, packPriceCents: 30_000, priceKind: 'set' }, OWNER);
    s.r.useSheetPrice(s.db, s.ing.sauce, MANAGER);
    expect(s.price(s.ing.sauce)).toMatchObject({ size: 2000, price: 30_000 });
    expect(s.alerts('batch_unpriced_input')).toHaveLength(2);
    // Something it is made from changing still says so (once the earlier ones are seen).
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.tomato, typed: { per: 'thousand', priceCents: 16_000 } }, MANAGER);
    expect(s.alerts('batch_unpriced_input')).toHaveLength(3);
    expect(s.alerts('batch_unpriced_input')[2]!.detail).toMatchObject({ ingredientId: s.ing.sauce, kept: { unitCostMc: 15_000 } });
  });

  it("D1's purchase guard uses the owner's alert threshold", async () => {
    const s = await shop();
    // Onion Rs 150 / kg; a market run at Rs 172.50 / kg is 15% dearer.
    const buy = () => s.r.recordPurchase(s.db, { lines: [{ ingredientId: s.ing.onion, qty: 1_000, billCents: 17_250 }] }, MANAGER);
    expect(buy()).toMatchObject({ pricesUsed: [], pricesKept: [s.ing.onion] }); // default 10%: asked, no by default
    expect(s.price(s.ing.onion)).toMatchObject({ price: 15_000 });
    alertSettings(s, [], 100_000, 2_000); // 20%
    expect(buy()).toMatchObject({ pricesUsed: [s.ing.onion], pricesKept: [] });
    expect(s.price(s.ing.onion)).toMatchObject({ size: 1000, price: 17_250 });
  });
});

// ---------------------------------------------------------------------------
// The Monday digest
// ---------------------------------------------------------------------------

/** The owner's targets: Pizza at `pizzaBps` confirmed, "close" 5 points; everything else a suggestion. */
function pizzaTarget(s: Awaited<ReturnType<typeof shop>>, pizzaBps: number) {
  s.r.saveCostingTargets(
    s.db,
    { defaultBps: 3000, amberBps: 500, perCategory: { [s.cat.pizza]: { bps: pizzaBps, confirmed: true } }, nonFoodCategoryIds: [s.cat.fees], priceStepCents: 1000 },
    OWNER,
  );
}

const MONDAY = (d: string) => new Date(`${d}T06:00:00.000Z`);
const SYSTEM = { userId: null, deviceId: DEV };

function digestOf(s: Awaited<ReturnType<typeof shop>>, id: string | null) {
  const row = s.alerts('weekly_digest').find((a) => a.id === id);
  return row ? { ...row, detail: row.detail as unknown as WeeklyDigestAlert & { state: { items: Record<string, { band: string | null }> } } } : undefined;
}

live('the Monday digest (costing Phase 6)', () => {
  it('trading weeks start on Monday at 05:00 PKT', async () => {
    const { tradingWeekOf } = await import('@cheeseoclock/pos-domain');
    expect(tradingWeekOf('2026-09-27T10:00:00.000Z')).toBe('2026-09-21'); // a Sunday
    expect(tradingWeekOf('2026-09-21T00:00:00.000Z')).toBe('2026-09-21'); // Monday, 05:00 PKT
    expect(tradingWeekOf('2026-09-20T23:59:59.999Z')).toBe('2026-09-14'); // Monday, 04:59 PKT: still last week
  });

  it('an item crossing into red is listed once; a wobble of under a point around the line never fires', async () => {
    const s = await shop();
    // Fajita Medium costs Rs 176.41 of Rs 1,200: 14.7%. Pizza target 10%, close to 15%: amber.
    pizzaTarget(s, 1_000);
    const week0 = s.r.runWeeklyDigestIfDue(s.db, SYSTEM, MONDAY('2026-09-07'));
    expect(week0).toBe(s.r.weeklyDigestId('2026-09-07'));
    // The first digest only notes where each dish stands: written seen, never listed.
    expect(digestOf(s, week0)).toMatchObject({ seenAt: expect.any(String), detail: { changes: [], sinceWeekOf: null } });
    expect(digestOf(s, week0)!.detail.state.items[s.item.fajitaM]).toMatchObject({ band: 'amber' });
    expect(s.r.getCostAlerts(s.db).alerts.filter((a) => a.kind === 'weekly_digest')).toEqual([]);
    // Looked for again in the same week: nothing.
    expect(s.r.runWeeklyDigestIfDue(s.db, SYSTEM, new Date('2026-09-09T12:00:00.000Z'))).toBeNull();

    // Just over the line: chicken Rs 900 → 1,050 / kg is Rs 6 a pizza, 15.2% — red, as Menu costs colours it: listed, once.
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.chicken, typed: { per: 'thousand', priceCents: 105_000 } }, MANAGER);
    expect(s.r.getMenuCosts(s.db).rows.find((r) => r.menuItemId === s.item.fajitaM)).toMatchObject({ flag: 'red' });
    const week1 = s.r.runWeeklyDigestIfDue(s.db, SYSTEM, MONDAY('2026-09-14'));
    const d1 = digestOf(s, week1)!;
    expect(d1.seenAt).toBeNull();
    expect(d1.detail).toMatchObject({ weekOf: '2026-09-14', sinceWeekOf: '2026-09-07' });
    expect(d1.detail.changes).toEqual([
      expect.objectContaining({
        menuItemId: s.item.fajitaM,
        flagBefore: 'amber',
        flagAfter: 'red',
        targetBps: 1_000,
        costBeforeCents: 17_641,
        costAfterCents: 18_241,
        foodCostAfterBps: 1_520,
      }),
    ]);
    expect(s.r.getCostAlerts(s.db).alerts.filter((a) => a.kind === 'weekly_digest').map((a) => a.id)).toEqual([week1]);

    // Then it wobbles half a point either side of the 15% line: 14.7% (Rs 900 / kg), 15.2%, 14.7%, and on up to
    // 16.2% (Rs 1,350 / kg) and back to 14.2% (Rs 750 / kg)… it stays red, nothing new.
    for (const [cents, monday] of [
      [90_000, '2026-09-21'],
      [105_000, '2026-09-28'],
      [90_000, '2026-10-05'],
      [135_000, '2026-10-12'],
      [75_000, '2026-10-19'],
    ] as const) {
      s.r.setTypedPrice(s.db, { ingredientId: s.ing.chicken, typed: { per: 'thousand', priceCents: cents } }, MANAGER);
      const id = s.r.runWeeklyDigestIfDue(s.db, SYSTEM, MONDAY(monday));
      expect({ monday, changes: digestOf(s, id)!.detail.changes }).toEqual({ monday, changes: [] });
    }
    expect(s.alerts('weekly_digest').filter((a) => a.seenAt === null)).toHaveLength(1);

    // A point back under the line (Rs 675 / kg: 13.95%): listed once, back to close.
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.chicken, typed: { per: 'thousand', priceCents: 67_500 } }, MANAGER);
    const back = digestOf(s, s.r.runWeeklyDigestIfDue(s.db, SYSTEM, MONDAY('2026-10-26')))!;
    expect(back.detail.changes).toEqual([expect.objectContaining({ menuItemId: s.item.fajitaM, flagBefore: 'red', flagAfter: 'amber' })]);
    expect(chainOk(s.db)).toBe(true);
  });

  it('a target the owner changes is not a price change: the digest never lists the dishes it moves', async () => {
    const s = await shop();
    // Fajita Medium 14.7% of its price. Pizza target 12%, close to 17%: amber.
    pizzaTarget(s, 1_200);
    s.r.runWeeklyDigestIfDue(s.db, SYSTEM, MONDAY('2026-09-07'));
    // The owner lowers the target to 9% (close to 14%): Menu costs shows it red now — but no price moved.
    pizzaTarget(s, 900);
    expect(s.r.getMenuCosts(s.db).rows.find((r) => r.menuItemId === s.item.fajitaM)).toMatchObject({ flag: 'red' });
    const week1 = digestOf(s, s.r.runWeeklyDigestIfDue(s.db, SYSTEM, MONDAY('2026-09-14')))!;
    expect(week1.detail.changes).toEqual([]);
    expect(week1.detail.state.items[s.item.fajitaM]).toMatchObject({ band: 'red' });
    // From there, prices count again, against the new target: chicken Rs 900 → 375 / kg is 12.95%, a point back under 14%.
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.chicken, typed: { per: 'thousand', priceCents: 37_500 } }, MANAGER);
    const week2 = digestOf(s, s.r.runWeeklyDigestIfDue(s.db, SYSTEM, MONDAY('2026-09-21')))!;
    expect(week2.detail.changes).toEqual([
      expect.objectContaining({ menuItemId: s.item.fajitaM, flagBefore: 'red', flagAfter: 'amber', targetBps: 900 }),
    ]);
    expect(s.r.getCostAlerts(s.db).alerts.filter((a) => a.kind === 'weekly_digest').map((a) => a.id)).toEqual([week2.id]);
  });

  it('a change in what customers pick, alone, never fires: the picks are frozen at the last digest', async () => {
    const s = await shop();
    const t0 = MONDAY('2026-08-03');
    const t1 = MONDAY('2026-09-07'); // five weeks on: the first picks are out of the 28 days
    // In the 28 days before t0 everyone picked one onion; before t1, five dear veggies.
    s.markPaid(s.ring([['veggieL', 12, ['pickOnion', 'dipRanch']]]), new Date(t0.getTime() - 86_400_000));
    s.markPaid(s.ring([['veggieL', 12, ['pickOlive', 'pickMushroom', 'pickJalapeno', 'pickPepperExtra', 'pickCorn', 'dipRanch']]]), new Date(t1.getTime() - 86_400_000));
    const fcAt = (at: Date) => s.r.getMenuCosts(s.db, at).rows.find((r) => r.menuItemId === s.item.veggieL)!.foodCostBps!;
    const cheap = fcAt(t0);
    const dear = fcAt(t1);
    expect(dear - cheap).toBeGreaterThan(150); // the picks alone move it more than a point and a half
    // The target just above the cheap picks: green on them, amber on the dear ones.
    pizzaTarget(s, cheap + 50);
    const w0 = s.r.runWeeklyDigestIfDue(s.db, SYSTEM, t0);
    expect(digestOf(s, w0)!.detail.state.items[s.item.veggieL]).toMatchObject({ band: 'green' });
    // No price changed: the digest at t1 prices last digest's picks and finds nothing — though today's picks are amber.
    const w1 = s.r.runWeeklyDigestIfDue(s.db, SYSTEM, t1);
    expect(digestOf(s, w1)!.detail.changes).toEqual([]);
    expect(digestOf(s, w1)!.detail.state.items[s.item.veggieL]).toMatchObject({ band: 'amber' });
    // And the week after, from those picks: still nothing.
    const w2 = s.r.runWeeklyDigestIfDue(s.db, SYSTEM, new Date(t1.getTime() + 7 * 86_400_000));
    expect(digestOf(s, w2)!.detail.changes).toEqual([]);
    expect(s.r.getCostAlerts(s.db).alerts.filter((a) => a.kind === 'weekly_digest')).toEqual([]);
  });

  it('the digest is one row per week on both tills (the same id)', async () => {
    const s = await shop();
    pizzaTarget(s, 1_000);
    const { db2, push } = await secondTill(s.db);
    const a = s.r.runWeeklyDigestIfDue(s.db, SYSTEM, MONDAY('2026-09-07'));
    const b = s.r.runWeeklyDigestIfDue(db2, { userId: null, deviceId: TILL_2 }, MONDAY('2026-09-07'));
    expect(a).toBe(b);
    expect(await push(s.db, DEV, db2)).toMatchObject({ waiting: 0, dropped: 0 });
    expect(await push(db2, TILL_2, s.db)).toMatchObject({ waiting: 0, dropped: 0 });
    for (const db of [s.db, db2]) {
      expect(n(db, `SELECT COUNT(*) AS n FROM cost_alerts WHERE kind = 'weekly_digest'`)).toBe(1);
      expect(s.r.readParked(db)).toEqual([]);
    }
  });
});
