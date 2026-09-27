/**
 * Costing, Phase 1, against a real database built from every migration:
 *   - expandRecipe (pos-domain) takes exactly what decrementForOrder's stock
 *     SQL takes, order by order (the choice of dip, 5 of 7 veggies, a
 *     two-pizza deal, a leave-out on a free choice vs on a paid extra, a
 *     paid extra, an item with no recipe) — the parity the spec asks for
 *     before Phase 2 wires it into the sale;
 *   - business_settings: Zod refuses bad values, a write syncs and audits,
 *     and two tills writing the same key offline converge on ONE row by its
 *     name-based id, with nothing parked;
 *   - migration 0032's fill, the price kinds the ingredient repository and
 *     the menu import write, the rolled-up batch price, and "Make this
 *     amount" (a batch of any size) moving exactly the scaled stock.
 *
 * node:sqlite behind better-sqlite3's shape (costing-shop.fixture.ts); skips
 * where node:sqlite is missing. Every name and price is made up.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expandRecipe, totalsByIngredient, type PickedChoice, type RecipeLine } from '@cheeseoclock/pos-domain';
import { menuImportFileSchema } from '@cheeseoclock/shared-schemas';
import type { AppDatabase } from './connection.js';
import { DatabaseSync, MANAGER, MIGRATIONS, OWNER, openCostingShop, openMigrated, type Line } from './costing-shop.fixture.js';
import { verifyAuditChain, type AuditChainRow } from './audit-chain.js';

// Builds a real database from every migration per test: seconds on a slow CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const live = describe.skipIf(!DatabaseSync);

const n = (db: AppDatabase, sql: string, ...p: unknown[]) =>
  Number((db.prepare(sql).get(...p) as { n: number } | undefined)?.n ?? 0);

/** The hash-chained audit trail still verifies from its first row. */
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

// ---------------------------------------------------------------------------
// expandRecipe parity with the stock SQL
// ---------------------------------------------------------------------------

/** What the pure function says an order takes, per ingredient, from the order's own rows. */
function expectedTake(db: AppDatabase, orderId: string): Map<string, number> {
  const recipe = db.prepare(
    `SELECT r.ingredient_id, r.qty_per_unit, r.modifier_id FROM recipes r
       JOIN ingredients i ON i.id = r.ingredient_id AND i.deleted_at IS NULL
      WHERE r.menu_item_id = ? AND r.deleted_at IS NULL`,
  );
  const picks = db.prepare(
    `SELECT oim.modifier_id, oim.price_delta_cents, m.removes_ingredient_id
       FROM order_item_modifiers oim JOIN modifiers m ON m.id = oim.modifier_id
      WHERE oim.order_item_id = ? AND oim.deleted_at IS NULL`,
  );
  const total = new Map<string, number>();
  for (const line of db
    .prepare(`SELECT id, menu_item_id, quantity FROM order_items WHERE order_id = ? AND deleted_at IS NULL`)
    .all(orderId) as Array<{ id: string; menu_item_id: string; quantity: number }>) {
    const lines: RecipeLine[] = (
      recipe.all(line.menu_item_id) as Array<{ ingredient_id: string; qty_per_unit: number; modifier_id: string | null }>
    ).map((r) => ({ ingredientId: r.ingredient_id, qtyPerUnit: r.qty_per_unit, modifierId: r.modifier_id }));
    const picked: PickedChoice[] = (
      picks.all(line.id) as Array<{ modifier_id: string; price_delta_cents: number; removes_ingredient_id: string | null }>
    ).map((p) => ({ modifierId: p.modifier_id, priceDeltaCents: p.price_delta_cents, removesIngredientId: p.removes_ingredient_id }));
    for (const [id, q] of totalsByIngredient(expandRecipe(lines, picked, line.quantity))) total.set(id, (total.get(id) ?? 0) + q);
  }
  return total;
}

/** What decrementForOrder actually took, per ingredient (positive). */
function actualTake(db: AppDatabase, orderId: string): Map<string, number> {
  const rows = db
    .prepare(`SELECT ingredient_id, SUM(delta_qty) AS d FROM stock_movements WHERE ref_order_id = ? GROUP BY ingredient_id`)
    .all(orderId) as Array<{ ingredient_id: string; d: number }>;
  return new Map(rows.map((r) => [r.ingredient_id, -Number(r.d)]));
}

live('expandRecipe takes exactly what the stock SQL takes', () => {
  const ORDERS: Record<string, Line[]> = {
    'a dip of your choice, and 5 of 7 veggies on a quantity-2 line': [
      ['veggieL', 2, ['pickOnion', 'pickPepper', 'pickOlive', 'pickMushroom', 'pickCorn', 'dipChili']],
    ],
    'a two-pizza deal with its own "No onion" (a leave-out on free choices) and a paid dip': [
      ['deal', 1, ['d1Fajita', 'd2Fajita', 'dealNoOnion', 'sideRanch']],
    ],
    '"No onion" beside a paid "Extra onion": the paid extra is still taken': [
      ['fajitaM', 1, ['noOnion', 'extraOnion', 'extraCheese']],
    ],
    '"No onion" on Veggie Lovers with onion picked free: none taken': [
      ['veggieL', 1, ['pickOnion', 'pickJalapeno', 'dipRanch', 'noOnion', 'extraCheese']],
    ],
    'plain pizzas, a drink with no price and an item with no recipe': [
      ['fajitaM', 3],
      ['cola', 2],
      ['bakedWings', 1],
    ],
  };

  for (const [label, lines] of Object.entries(ORDERS)) {
    it(label, async () => {
      const db = openMigrated();
      const s = await openCostingShop(db);
      const orderId = s.ring(lines);
      s.r.decrementForOrder(db, orderId, MANAGER);
      const expected = expectedTake(db, orderId);
      expect(expected.size).toBeGreaterThan(0);
      expect(actualTake(db, orderId)).toEqual(expected);
    });
  }

  it('the leave-out cases take what the rule says, in grams', async () => {
    const db = openMigrated();
    const s = await openCostingShop(db);
    const orderId = s.ring([['fajitaM', 1, ['noOnion', 'extraOnion']]]);
    s.r.decrementForOrder(db, orderId, MANAGER);
    expect(actualTake(db, orderId).get(s.ing.onion)).toBe(10); // the paid 10 g, not the base 10 g
    const deal = s.ring([['deal', 1, ['d1Fajita', 'd2Veggie', 'dealNoOnion']]]);
    s.r.decrementForOrder(db, deal, MANAGER);
    expect(actualTake(db, deal).get(s.ing.onion)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// business_settings
// ---------------------------------------------------------------------------

async function settings() {
  return {
    ...(await import('./repositories/business-settings-repo.js')),
    ...(await import('./repositories/sync-repo.js')),
    ...(await import('./repositories/apply-remote.js')),
  };
}

const TARGETS = {
  defaultBps: 3000,
  amberBps: 500,
  perCategory: { 'cat-pizza': { bps: 2800, confirmed: true } },
  nonFoodCategoryIds: ['cat-fees'],
};

function withUsers(db: AppDatabase) {
  const user = db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, 'x', 'x', ?)`,
  );
  user.run(OWNER.userId, 'Test Owner', 'admin', 'till-1');
  return db;
}

live('business_settings (migration 0032)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses a value that does not fit its key, and writes nothing', async () => {
    const { setBusinessSetting } = await settings();
    const db = withUsers(openMigrated());
    expect(() => setBusinessSetting(db, 'costing.targets', { ...TARGETS, amberBps: 9000 }, OWNER)).toThrow(/at most 50 points/);
    expect(() => setBusinessSetting(db, 'costing.targets', { ...TARGETS, defaultBps: 0 }, OWNER)).toThrow(/above 0%/);
    expect(() =>
      setBusinessSetting(db, 'costing.targets', { ...TARGETS, perCategory: { x: { bps: 3000.5, confirmed: true } } }, OWNER),
    ).toThrow(/whole number/);
    expect(() => setBusinessSetting(db, 'costing.priceStep', 5, OWNER)).toThrow(/at least Rs 1/);
    expect(() => setBusinessSetting(db, 'no.such.key' as 'costing.priceStep', 1000, OWNER)).toThrow(/Unknown setting/);
    expect(n(db, `SELECT COUNT(*) AS n FROM business_settings`)).toBe(0);
    expect(n(db, `SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'business_settings'`)).toBe(0);
  });

  it('a write is one row with a name-based id, synced (as the row) and audited with before and after', async () => {
    const { setBusinessSetting, getBusinessSetting, businessSettingId } = await settings();
    const db = withUsers(openMigrated());
    setBusinessSetting(db, 'costing.targets', TARGETS, OWNER);
    const id = businessSettingId('costing.targets');
    expect(id).toBe(businessSettingId('costing.targets'));
    expect(id).not.toBe(businessSettingId('costing.priceStep'));
    expect(getBusinessSetting(db, 'costing.targets')).toMatchObject({ value: TARGETS, updatedByUserId: OWNER.userId });

    setBusinessSetting(db, 'costing.targets', { ...TARGETS, amberBps: 300 }, OWNER);
    expect(n(db, `SELECT COUNT(*) AS n FROM business_settings`)).toBe(1);
    expect(db.prepare(`SELECT id, version FROM business_settings`).get()).toEqual({ id, version: 2 });
    const queued = db
      .prepare(`SELECT payload_json FROM sync_queue WHERE entity_type = 'business_settings' ORDER BY rowid`)
      .all() as Array<{ payload_json: string }>;
    expect(queued).toHaveLength(2);
    expect(JSON.parse(queued[1]!.payload_json)).toMatchObject({ id, key: 'costing.targets', version: 2 });
    const audits = db
      .prepare(`SELECT action, before_json, after_json FROM audit_log WHERE entity_type = 'business_settings' ORDER BY rowid`)
      .all() as Array<{ action: string; before_json: string | null; after_json: string }>;
    expect(audits.map((a) => a.action)).toEqual(['create', 'update']);
    expect(JSON.parse(audits[1]!.before_json!)).toMatchObject({ value: { amberBps: 500 } });
    expect(JSON.parse(audits[1]!.after_json)).toMatchObject({ value: { amberBps: 300 } });
    expect(chainOk(db)).toBe(true);
  });

  it('a stored value that no longer fits reads as "not set", never trusted', async () => {
    const { setBusinessSetting, getBusinessSetting } = await settings();
    const db = withUsers(openMigrated());
    setBusinessSetting(db, 'costing.priceStep', 1000, OWNER);
    db.prepare(`UPDATE business_settings SET value_json = '"ten rupees"'`).run();
    expect(getBusinessSetting(db, 'costing.priceStep')).toBeNull();
  });

  it('two tills, link down, the same key written on both: one row by id on each, the later write, nothing parked', async () => {
    const { setBusinessSetting, getBusinessSetting, listPendingSync, pendingToChange, markSyncedIds, applyRemoteBatch } = await settings();
    const a = withUsers(openMigrated());
    const b = withUsers(openMigrated());
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T09:00:00.000Z'));
    setBusinessSetting(a, 'costing.targets', TARGETS, { userId: OWNER.userId, deviceId: 'till-1' });
    vi.setSystemTime(new Date('2026-09-27T09:05:00.000Z'));
    setBusinessSetting(b, 'costing.targets', { ...TARGETS, amberBps: 700 }, { userId: OWNER.userId, deviceId: 'till-2' });
    vi.useRealTimers();

    const push = async (from: AppDatabase, fromDevice: string, to: AppDatabase) => {
      const pending = listPendingSync(from, 1000);
      const r = await applyRemoteBatch(to, pending.map((p) => pendingToChange(p, fromDevice)), { pause: async () => {} });
      markSyncedIds(from, pending.map((p) => p.id));
      return r;
    };
    const ab = await push(a, 'till-1', b);
    const ba = await push(b, 'till-2', a);
    expect(ab).toMatchObject({ waiting: 0, dropped: 0, stale: 1 }); // the earlier write loses on B
    expect(ba).toMatchObject({ waiting: 0, dropped: 0, applied: 1 }); // the later one wins on A
    for (const db of [a, b]) {
      expect(n(db, `SELECT COUNT(*) AS n FROM business_settings`)).toBe(1);
      expect(getBusinessSetting(db, 'costing.targets')?.value.amberBps).toBe(700);
    }
  });
});

// ---------------------------------------------------------------------------
// Price kinds
// ---------------------------------------------------------------------------

live('price kinds', () => {
  it('0032 fills Rs 0 with no pack price as "unset"; a priced one stays "set"', async () => {
    const db = openMigrated({ stopBefore: '0032' });
    const ins = db.prepare(
      `INSERT INTO ingredients (id, name, unit, cost_per_unit_cents, pack_size, pack_price_cents, created_at, updated_at, device_id)
       VALUES (?, ?, 'g', ?, ?, ?, 'x', 'x', 'd')`,
    );
    ins.run('zero', 'Never priced', 0, null, null);
    ins.run('zero-pack', 'Pack at Rs 0', 0, 1000, 0);
    ins.run('priced', 'Priced', 5, null, null);
    ins.run('tiny', 'A tiny pack price', 0, 1000, 40); // 0.04 paisa / g rounds to 0, but it is priced
    db.exec(readFileSync(join(MIGRATIONS, '0032_costing_foundation.sql'), 'utf8'));
    const kinds = Object.fromEntries(
      (db.prepare(`SELECT id, price_kind FROM ingredients`).all() as Array<{ id: string; price_kind: string }>).map((r) => [r.id, r.price_kind]),
    );
    expect(kinds).toEqual({ zero: 'unset', 'zero-pack': 'unset', priced: 'set', tiny: 'set' });
  });

  it('the ingredient repository: Rs 0 is unset, "free" clears the price, a guess stays a guess, a new price is set', async () => {
    const { createIngredient, updateIngredient, findIngredient } = await import('./repositories/ingredient-repo.js');
    const db = withUsers(openMigrated());
    const cup = createIngredient(db, { name: 'Test Cup', unit: 'pcs' }, OWNER);
    expect(cup.priceKind).toBe('unset');
    const free = updateIngredient(db, { id: cup.id, priceKind: 'free', packSize: 100, packPriceCents: 500 }, OWNER);
    expect(free).toMatchObject({ priceKind: 'free', costPerUnitCents: 0, packSize: null, packPriceCents: null });
    // a rename leaves the price and its kind alone
    expect(updateIngredient(db, { id: cup.id, name: 'Test Dip Cup' }, OWNER).priceKind).toBe('free');
    const guess = updateIngredient(db, { id: cup.id, priceKind: 'estimate', costPerUnitCents: 7 }, OWNER);
    expect(guess).toMatchObject({ priceKind: 'estimate', costPerUnitCents: 7 });
    expect(updateIngredient(db, { id: cup.id, costPerUnitCents: 8 }, OWNER).priceKind).toBe('estimate');
    expect(updateIngredient(db, { id: cup.id, priceKind: 'set', costPerUnitCents: 8 }, OWNER).priceKind).toBe('set');
    expect(updateIngredient(db, { id: cup.id, costPerUnitCents: 0 }, OWNER).priceKind).toBe('unset');
    expect(findIngredient(db, cup.id)?.priceKind).toBe('unset');
    expect(db.prepare(`SELECT price_kind FROM ingredients WHERE id = ?`).get(cup.id)).toEqual({ price_kind: 'unset' });
  });

  it('the menu import: Rs 0 is unset, a "free" is never overwritten, a guess is an estimate', async () => {
    const { createIngredient, updateIngredient, findIngredient, listIngredients } = await import('./repositories/ingredient-repo.js');
    const { applyMenuImport } = await import('./repositories/menu-import-repo.js');
    const db = withUsers(openMigrated());
    const salt = createIngredient(db, { name: 'Test Salt', unit: 'g' }, OWNER);
    updateIngredient(db, { id: salt.id, priceKind: 'free' }, OWNER);
    const oil = createIngredient(db, { name: 'Test Oil', unit: 'ml', packSize: 1000, packPriceCents: 50_000 }, OWNER);
    const file = menuImportFileSchema.parse({
      format: 'cheeseoclock-menu-import',
      version: 1,
      source: 'test',
      categories: [{ name: 'Test' }],
      ingredients: [
        { name: 'Test Salt', unit: 'g', costPerUnitCents: 0 },
        { name: 'Test Oil', unit: 'ml', costPerUnitCents: 0, packSize: 1000, packPriceCents: 50_000, priceIsEstimate: true },
        { name: 'Test Bottle', unit: 'pcs', costPerUnitCents: 0 },
        { name: 'Test Breading', unit: 'g', costPerUnitCents: 15, priceIsEstimate: true },
        { name: 'Test Flour', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 12_000 },
      ],
      items: [],
    });
    applyMenuImport(db, file, 'test.json', OWNER);
    const kind = (name: string) => listIngredients(db).find((i) => i.name === name)?.priceKind;
    expect(findIngredient(db, salt.id)?.priceKind).toBe('free');
    expect(findIngredient(db, oil.id)).toMatchObject({ priceKind: 'estimate', packPriceCents: 50_000 });
    expect(kind('Test Bottle')).toBe('unset');
    expect(kind('Test Breading')).toBe('estimate');
    expect(kind('Test Flour')).toBe('set');
  });
});

// ---------------------------------------------------------------------------
// Batches: the rolled-up price, and "Make this amount"
// ---------------------------------------------------------------------------

live('batch recipes', () => {
  it('shows the batch price rolled up from its inputs now, beside the price stored on it', async () => {
    const db = openMigrated();
    const s = await openCostingShop(db);
    const r = s.r.getBatchRecipe(db, s.ing.sauce);
    // 2,500 g tomato at Rs 120 / kg + 125 g garlic at Rs 450 / kg = Rs 300 + Rs 56.25 — written back
    // to the sauce as its own price when the recipe was saved (costing Phase 4: batches roll up).
    expect(r).toMatchObject({ batchYield: 2000, batchCostCents: 35_625, complete: true, unpricedInputs: [], storedBatchCostCents: 35_625 });
    expect(r.lines.map((l) => [l.name, l.priceKind, l.madeInHouse])).toEqual([
      ['Test tomato', 'set', false],
      ['Test garlic', 'set', false],
    ]);
    // a stored price (the sheet's) is shown beside it, not used
    s.r.updateIngredient(db, { id: s.ing.sauce, packSize: 2000, packPriceCents: 30_000 }, MANAGER);
    expect(s.r.getBatchRecipe(db, s.ing.sauce)).toMatchObject({ batchCostCents: 35_625, storedBatchCostCents: 30_000 });
    // an unpriced input: incomplete, and named
    s.r.updateIngredient(db, { id: s.ing.garlic, costPerUnitCents: 0, packSize: null, packPriceCents: null }, MANAGER);
    expect(s.r.getBatchRecipe(db, s.ing.sauce)).toMatchObject({ batchCostCents: 30_000, complete: false, unpricedInputs: ['Test garlic'] });
  });

  it('"Make this amount": 1.5 kg of a 2 kg batch takes exactly the scaled inputs, in one audited transaction', async () => {
    const db = openMigrated();
    const s = await openCostingShop(db);
    const before = { tomato: s.stockOf('tomato'), garlic: s.stockOf('garlic'), sauce: s.stockOf('sauce') };
    const auditsBefore = n(db, `SELECT COUNT(*) AS n FROM audit_log`);
    const res = s.r.makeBatch(db, { ingredientId: s.ing.sauce, amount: 1500 }, MANAGER);
    expect(res).toEqual({ made: 1500, resultingQty: before.sauce + 1500 });
    // 2,500 × 0.75 = 1,875 g tomato; 125 × 0.75 = 93.75 → 94 g garlic (whole grams, half up)
    expect(s.stockOf('tomato')).toBe(before.tomato - 1875);
    expect(s.stockOf('garlic')).toBe(before.garlic - 94);
    expect(s.stockOf('sauce')).toBe(before.sauce + 1500);
    const moves = db
      .prepare(`SELECT ingredient_id, delta_qty, reason, notes FROM stock_movements ORDER BY rowid`)
      .all() as Array<{ ingredient_id: string; delta_qty: number; reason: string; notes: string }>;
    expect(moves.map((m) => [m.ingredient_id, m.delta_qty, m.reason])).toEqual([
      [s.ing.tomato, -1875, 'adjustment'],
      [s.ing.garlic, -94, 'adjustment'],
      [s.ing.sauce, 1500, 'adjustment'],
    ]);
    expect(moves[0]!.notes).toBe('Used to make 1,500 g of Test sauce (0.75 of a batch)');
    expect(moves[2]!.notes).toBe('Made 1,500 g (0.75 of a batch; one batch makes 2,000 g)');
    // three movement rows + one "what was made from what"
    expect(n(db, `SELECT COUNT(*) AS n FROM audit_log`)).toBe(auditsBefore + 4);
    const made = db.prepare(`SELECT after_json FROM audit_log WHERE action = 'make_batch'`).get() as { after_json: string };
    expect(JSON.parse(made.after_json)).toMatchObject({
      made: 1500,
      batchYield: 2000,
      batches: null,
      inputs: [
        { ingredientId: s.ing.tomato, qty: 1875 },
        { ingredientId: s.ing.garlic, qty: 94 },
      ],
    });
    expect(chainOk(db)).toBe(true);
  });

  it('whole batches work as before; an input too small to take a whole gram is left alone', async () => {
    const db = openMigrated();
    const s = await openCostingShop(db);
    const t0 = s.stockOf('tomato');
    s.r.makeBatch(db, { ingredientId: s.ing.sauce, batches: 2 }, MANAGER);
    expect(s.stockOf('tomato')).toBe(t0 - 5000);
    expect(
      (db.prepare(`SELECT notes FROM stock_movements WHERE ingredient_id = ?`).get(s.ing.sauce) as { notes: string }).notes,
    ).toBe('Made 2 batches');
    // 4 g of sauce: 5 g tomato, 0.25 g garlic → none taken
    const g0 = s.stockOf('garlic');
    s.r.makeBatch(db, { ingredientId: s.ing.sauce, amount: 4 }, MANAGER);
    expect(s.stockOf('tomato')).toBe(t0 - 5000 - 5);
    expect(s.stockOf('garlic')).toBe(g0);
  });

  it('refuses more than 100 batches at once, both ways of asking, or none', async () => {
    const db = openMigrated();
    const s = await openCostingShop(db);
    expect(() => s.r.makeBatch(db, { ingredientId: s.ing.sauce, amount: 200_001 }, MANAGER)).toThrow(/more than 100 batches/);
    expect(() => s.r.makeBatch(db, { ingredientId: s.ing.sauce, amount: 10, batches: 1 }, MANAGER)).toThrow(/how many batches, or how much/);
    expect(() => s.r.makeBatch(db, { ingredientId: s.ing.sauce }, MANAGER)).toThrow(/how many batches, or how much/);
    expect(() => s.r.makeBatch(db, { ingredientId: s.ing.tomato, amount: 10 }, MANAGER)).toThrow(/no batch recipe/);
    expect(n(db, `SELECT COUNT(*) AS n FROM stock_movements`)).toBe(0);
  });
});
