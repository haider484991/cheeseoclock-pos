/**
 * Inventory repositories against a real SQLite database built from every
 * migration (0024 included): ingredient categories, the stock history
 * search, recipe line counts and purchase order status rules.
 *
 * better-sqlite3 here is built for Electron's ABI and will not open under
 * plain node, so this uses node's own `node:sqlite` (Node 22.5+), with a
 * small `transaction()` shim in better-sqlite3's shape, and skips itself
 * where node:sqlite is missing. Every amount is made up.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

interface Stmt {
  run(...p: unknown[]): unknown;
  all(...p: unknown[]): Array<Record<string, unknown>>;
  get(...p: unknown[]): Record<string, unknown> | undefined;
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
}

function openSqlite(): RawDb | null {
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (path: string) => RawDb;
    };
    return new DatabaseSync(':memory:');
  } catch {
    return null;
  }
}

/** better-sqlite3's `db.transaction(fn)`: BEGIN at the outside, SAVEPOINTs inside. */
function withTransactions(raw: RawDb) {
  let depth = 0;
  return {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction:
      <A extends unknown[], R>(fn: (...args: A) => R) =>
      (...args: A): R => {
        const sp = `sp_${depth}`;
        raw.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
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
  };
}

const raw = openSqlite();
const db = (raw ? withTransactions(raw) : null) as never;
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const actor = { userId: 'u1', deviceId: 'd1' };

function count(sql: string, ...p: unknown[]): number {
  return Number(raw!.prepare(sql).get(...p)?.n ?? 0);
}

beforeAll(() => {
  if (!raw) return;
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  raw.exec('PRAGMA foreign_keys=OFF');
  raw
    .prepare(
      `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id)
       VALUES ('u1', 'Manager One', 'x', 'manager', 'x', 'x', 'd1')`,
    )
    .run();
});

const repos = async () => ({
  ...(await import('./repositories/ingredient-repo.js')),
  ...(await import('./repositories/stock-movement-repo.js')),
  ...(await import('./repositories/stock-movement-search.js')),
  ...(await import('./repositories/procurement-repo.js')),
});

describe.skipIf(!raw)('ingredient categories (migration 0024)', () => {
  it('guesses the category of a new ingredient and keeps it unset in the row', async () => {
    const { createIngredient } = await repos();
    const moz = createIngredient(db, { name: 'Mozzarella Test', unit: 'g' }, actor);
    expect(moz).toMatchObject({ category: 'cheese', categoryAuto: true });
    expect(raw!.prepare('SELECT category FROM ingredients WHERE id = ?').get(moz.id)?.category).toBeNull();
  });

  it('stores a category that was picked', async () => {
    const { createIngredient, findIngredient } = await repos();
    const mix = createIngredient(db, { name: 'House Mix', unit: 'g', category: 'sauce' }, actor);
    expect(mix).toMatchObject({ category: 'sauce', categoryAuto: false });
    expect(findIngredient(db, mix.id)).toMatchObject({ category: 'sauce', categoryAuto: false });
  });

  it('a guessed category follows a rename; a picked one stays', async () => {
    const { createIngredient, updateIngredient } = await repos();
    const onion = createIngredient(db, { name: 'Onion Test', unit: 'g' }, actor);
    expect(onion.category).toBe('veg');
    const renamed = updateIngredient(db, { id: onion.id, name: 'Onion Powder Test' }, actor);
    expect(renamed).toMatchObject({ category: 'spice', categoryAuto: true });

    const picked = updateIngredient(db, { id: onion.id, category: 'dry' }, actor);
    expect(picked).toMatchObject({ category: 'dry', categoryAuto: false });
    const renamedAgain = updateIngredient(db, { id: onion.id, name: 'Onion Flakes Test' }, actor);
    expect(renamedAgain).toMatchObject({ category: 'dry', categoryAuto: false });

    const back = updateIngredient(db, { id: onion.id, category: null }, actor);
    expect(back).toMatchObject({ category: 'spice', categoryAuto: true });
    expect(raw!.prepare('SELECT category FROM ingredients WHERE id = ?').get(onion.id)?.category).toBeNull();
  });

  it('writes a sync row and an audit row for every category change', async () => {
    const { createIngredient, updateIngredient } = await repos();
    const cup = createIngredient(db, { name: 'Dip Cup Test', unit: 'pcs' }, actor);
    const syncBefore = count(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_id = ?`, cup.id);
    const auditBefore = count(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ?`, cup.id);
    updateIngredient(db, { id: cup.id, category: 'packaging' }, actor);
    expect(count(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_id = ?`, cup.id)).toBe(syncBefore + 1);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ?`, cup.id)).toBe(auditBefore + 1);
    const payload = JSON.parse(
      String(
        raw!.prepare(`SELECT payload_json FROM sync_queue WHERE entity_id = ? ORDER BY rowid DESC LIMIT 1`).get(cup.id)
          ?.payload_json,
      ),
    );
    expect(payload).toMatchObject({ category: 'packaging', categoryAuto: false });
  });

  it('lists every ingredient with its category', async () => {
    const { listIngredients } = await repos();
    const byName = new Map(listIngredients(db).map((i) => [i.name, i.category]));
    expect(byName.get('Mozzarella Test')).toBe('cheese');
    expect(byName.get('House Mix')).toBe('sauce');
  });
});

describe.skipIf(!raw)('recipe line counts', () => {
  it('counts the lines of each menu item, leaving out deleted ingredients', async () => {
    const { createIngredient, deleteIngredient, setRecipeForItem, listRecipeLineCounts } = await repos();
    const a = createIngredient(db, { name: 'Recipe A', unit: 'g' }, actor);
    const b = createIngredient(db, { name: 'Recipe B', unit: 'g' }, actor);
    setRecipeForItem(db, 'menu-1', [{ ingredientId: a.id, qtyPerUnit: 10 }, { ingredientId: b.id, qtyPerUnit: 5 }], actor);
    setRecipeForItem(db, 'menu-2', [{ ingredientId: a.id, qtyPerUnit: 3 }], actor);
    let counts = new Map(listRecipeLineCounts(db).map((c) => [c.menuItemId, c.lineCount]));
    expect(counts.get('menu-1')).toBe(2);
    expect(counts.get('menu-2')).toBe(1);
    expect(counts.get('menu-3')).toBeUndefined();

    setRecipeForItem(db, 'menu-1', [{ ingredientId: b.id, qtyPerUnit: 5 }], actor);
    setRecipeForItem(db, 'menu-2', [], actor);
    counts = new Map(listRecipeLineCounts(db).map((c) => [c.menuItemId, c.lineCount]));
    expect(counts.get('menu-1')).toBe(1);
    expect(counts.get('menu-2')).toBeUndefined();

    // b is still in menu-1's recipe, so it cannot be deleted
    expect(() => deleteIngredient(db, b.id, actor)).toThrow(/used in 1 recipes/);
  });
});

describe.skipIf(!raw)('stock history search', () => {
  it('pages, filters, searches and counts per reason', async () => {
    const { createIngredient, recordStockMovement, deleteIngredient, searchMovements } = await repos();
    const cheese = createIngredient(db, { name: 'History Cheddar', unit: 'g', currentQty: 1000 }, actor);
    const box = createIngredient(db, { name: 'History Box', unit: 'pcs', currentQty: 50 }, actor);
    const t = (m: number) => `2026-09-2${m}T10:00:00.000Z`;
    recordStockMovement(db, { ingredientId: cheese.id, deltaQty: 5000, reason: 'delivery', occurredAtIso: t(1) }, actor);
    recordStockMovement(db, { ingredientId: cheese.id, deltaQty: -200, reason: 'waste', notes: 'dropped 100%', occurredAtIso: t(2) }, actor);
    recordStockMovement(db, { ingredientId: cheese.id, deltaQty: -300, reason: 'sale', occurredAtIso: t(3) }, actor);
    recordStockMovement(db, { ingredientId: box.id, deltaQty: -2, reason: 'sale', occurredAtIso: t(4) }, actor);
    recordStockMovement(db, { ingredientId: box.id, deltaQty: 100, reason: 'delivery', occurredAtIso: t(5) }, actor);

    const mine = { sinceIso: '2026-09-20T00:00:00.000Z', untilIso: '2026-09-26T00:00:00.000Z' };
    const all = searchMovements(db, mine);
    expect(all.total).toBe(5);
    expect(all.reasonCounts).toEqual({ delivery: 2, waste: 1, sale: 2 });
    // newest first, names and people resolved
    expect(all.rows[0]).toMatchObject({ ingredientName: 'History Box', unit: 'pcs', deltaQty: 100, actorName: 'Manager One' });

    const page2 = searchMovements(db, { ...mine, limit: 2, offset: 2 });
    expect(page2.rows.map((r) => r.occurredAt)).toEqual([t(3), t(2)]);
    expect(page2.total).toBe(5);

    const sales = searchMovements(db, { ...mine, reason: 'sale' });
    expect(sales.total).toBe(2);
    // the chips still count every reason
    expect(sales.reasonCounts.delivery).toBe(2);

    expect(searchMovements(db, { ...mine, search: 'hist chedd' }).total).toBe(3);
    expect(searchMovements(db, { ...mine, search: 'dropped' }).total).toBe(1);
    // LIKE wildcards are matched as plain text
    expect(searchMovements(db, { ...mine, search: '100%' }).total).toBe(1);
    expect(searchMovements(db, { ...mine, search: '_' }).total).toBe(0);
    expect(searchMovements(db, { ...mine, ingredientId: box.id }).total).toBe(2);
    expect(searchMovements(db, { ...mine, sinceIso: t(4) }).total).toBe(2);

    // a deleted ingredient's history keeps its name
    deleteIngredient(db, box.id, actor);
    expect(searchMovements(db, { ...mine, ingredientId: box.id }).rows[0]?.ingredientName).toBe('History Box');
  });

  it('clamps the page size', async () => {
    const { searchMovements } = await repos();
    expect(searchMovements(db, { limit: 100_000 }).rows.length).toBeLessThanOrEqual(200);
  });
});

describe.skipIf(!raw)('purchase order status', () => {
  async function newPo(unitCostCents = 30) {
    const { createSupplier, createIngredient, createPurchaseOrder } = await repos();
    const sup = createSupplier(db, { name: `Supplier ${Math.random()}` }, actor);
    const ing = createIngredient(
      db,
      { name: `PO Flour ${Math.random()}`, unit: 'g', packSize: 1000, packPriceCents: 30_000 },
      actor,
    );
    const po = createPurchaseOrder(
      db,
      { supplierId: sup.id, items: [{ ingredientId: ing.id, qtyOrdered: 2000, unitCostCents }] },
      actor,
    );
    return { po, ing };
  }

  it('moves draft → ordered, and audits before and after', async () => {
    const { setPurchaseOrderStatus, getPurchaseOrderWithItems } = await repos();
    const { po } = await newPo();
    setPurchaseOrderStatus(db, po.id, 'ordered', actor);
    const after = getPurchaseOrderWithItems(db, po.id)!;
    expect(after.status).toBe('ordered');
    expect(after.orderedAt).not.toBeNull();
    const audit = raw!
      .prepare(`SELECT before_json, after_json FROM audit_log WHERE entity_id = ? AND action = 'status:ordered'`)
      .get(po.id)!;
    expect(JSON.parse(String(audit.before_json))).toMatchObject({ status: 'draft' });
    expect(JSON.parse(String(audit.after_json))).toMatchObject({ status: 'ordered' });
  });

  it('refuses to mark goods received by hand, or to reopen a finished order', async () => {
    const { setPurchaseOrderStatus, receiveDelivery } = await repos();
    const { po } = await newPo();
    expect(() => setPurchaseOrderStatus(db, po.id, 'received', actor)).toThrow(/Receive/);
    expect(() => setPurchaseOrderStatus(db, po.id, 'partial', actor)).toThrow(/Receive/);
    receiveDelivery(db, { purchaseOrderId: po.id, receipts: [{ purchaseOrderItemId: po.items[0]!.id, qtyReceivedNow: 2000 }] }, actor);
    expect(() => setPurchaseOrderStatus(db, po.id, 'cancelled', actor)).toThrow(/received/);
    expect(() => setPurchaseOrderStatus(db, 'nope', 'cancelled', actor)).toThrow(/not found/);
  });

  it('keeps the exact pack price when a delivery comes in at the same unit cost', async () => {
    const { receiveDelivery, findIngredient } = await repos();
    const { po, ing } = await newPo(30); // same as 30,000 / 1,000
    receiveDelivery(
      db,
      { purchaseOrderId: po.id, updateCosts: true, receipts: [{ purchaseOrderItemId: po.items[0]!.id, qtyReceivedNow: 500 }] },
      actor,
    );
    expect(findIngredient(db, ing.id)).toMatchObject({ packSize: 1000, packPriceCents: 30_000, currentQty: 500 });
  });

  it('takes a changed price as the new cost, with an audit row', async () => {
    const { receiveDelivery, findIngredient } = await repos();
    const { po, ing } = await newPo(35);
    receiveDelivery(
      db,
      { purchaseOrderId: po.id, updateCosts: true, receipts: [{ purchaseOrderItemId: po.items[0]!.id, qtyReceivedNow: 2000 }] },
      actor,
    );
    expect(findIngredient(db, ing.id)).toMatchObject({ costPerUnitCents: 35, packSize: null, packPriceCents: null });
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ? AND action = 'cost_from_delivery'`, ing.id)).toBe(1);
  });
});
