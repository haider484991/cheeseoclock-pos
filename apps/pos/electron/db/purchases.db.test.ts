/**
 * Costing, Phase 5 — purchases and receiving at the real bill (migration
 * 0035), against a real database built from every migration and the made-up
 * shop (costing-shop.fixture.ts):
 *
 *   - a purchase order typed in Rs per kg / per pack / per piece keeps the
 *     exact ordered pack, and what each line comes to is rounded once;
 *   - receiving at the bill: the price history keeps the bill EXACTLY as
 *     paid (q, B); the ingredient keeps its usual pack at round(B × S ÷ q)
 *     (per kg when it had none) and its pack is never cleared; the delivery
 *     row is worth exactly the bill; the line keeps what was billed;
 *   - D1's guard: a quick purchase 25% above the usual price is NOT used by
 *     default (the stock still comes in at the bill), and is when the screen
 *     says yes; a purchase order delivered within 10% is used; one 25% above
 *     is used by default and kept when the screen says no;
 *   - a quick purchase paid from the drawer: the payout is written with it,
 *     in ONE transaction (a failure writes none of it), the shift's expected
 *     cash includes it, and all of it is synced and audited (the chain holds);
 *   - "Turn this payout into a purchase": linked once (asked again it writes
 *     nothing), and the drawer's figures never change;
 *   - Reports: purchases by supplier and by ingredient each add up to the
 *     delivery rows' values in the period, with the latest price against the
 *     purchase before.
 *
 * node:sqlite behind better-sqlite3's shape; skips where node:sqlite is
 * missing. EVERY PRICE IS MADE UP (costing spec D11: the repo is public).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from './connection.js';
import { CASHIER, DatabaseSync, MANAGER, MIGRATIONS, openCostingShop, openMigrated } from './costing-shop.fixture.js';
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

async function shop() {
  const db = openMigrated();
  const s = await openCostingShop(db);
  const r = {
    ...s.r,
    ...(await import('./repositories/procurement-repo.js')),
    ...(await import('./repositories/shift-repo.js')),
  };
  const { getPurchases, buildFoodStockTab } = await import('../services/business-report.js');
  const price = (id: string) =>
    db.prepare(`SELECT cost_per_unit_cents AS cpu, pack_size AS size, pack_price_cents AS price, price_kind AS kind FROM ingredients WHERE id = ?`).get(id) as {
      cpu: number;
      size: number | null;
      price: number | null;
      kind: string;
    };
  const history = (id: string) =>
    db
      .prepare(
        `SELECT id, source, pack_size AS size, pack_price_cents AS price, unit_cost_mc AS mc, prev_unit_cost_mc AS prev,
                supplier_id AS supplierId, ref_purchase_order_id AS poId, ref_purchase_order_item_id AS itemId
           FROM ingredient_costs WHERE ingredient_id = ? ORDER BY effective_at, rowid`,
      )
      .all(id) as Array<{ id: string; source: string; size: number; price: number; mc: number; prev: number | null; supplierId: string | null; poId: string | null; itemId: string | null }>;
  const deliveries = (poId: string) =>
    db
      .prepare(
        `SELECT ingredient_id AS ingredientId, delta_qty AS qty, value_cents AS value, unit_cost_mc AS mc, cost_basis AS basis
           FROM stock_movements WHERE reason = 'delivery' AND ref_purchase_order_id = ? ORDER BY rowid`,
      )
      .all(poId) as Array<{ ingredientId: string; qty: number; value: number; mc: number; basis: string }>;
  /** How many rows of each ledger and business table there are: "nothing was written". */
  const counts = () =>
    Object.fromEntries(
      ['purchase_orders', 'purchase_order_items', 'stock_movements', 'ingredient_costs', 'cash_movements', 'sync_queue', 'audit_log'].map((t) => [
        t,
        n(db, `SELECT COUNT(*) AS n FROM ${t}`),
      ]),
    );
  const supplier = (name: string) => r.createSupplier(db, { name }, MANAGER);
  return { db, ...s, r, price, history, deliveries, counts, supplier, getPurchases, buildFoodStockTab };
}

// ---------------------------------------------------------------------------
// Migration 0035 on a till that already has purchase orders
// ---------------------------------------------------------------------------

live('0035 on a till that already has purchase orders', () => {
  it('keeps every order and everything pointing at it; a purchase may now have no supplier', () => {
    const db = openMigrated({ stopBefore: '0035' });
    const run = (sql: string, ...p: unknown[]) => db.prepare(sql).run(...p);
    run(`INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES ('u1', 'Test Owner', 'x', 'admin', 'x', 'x', 'd')`);
    run(`INSERT INTO suppliers (id, name, created_at, updated_at, device_id) VALUES ('s1', 'Test Dairy', 'x', 'x', 'd')`);
    run(`INSERT INTO ingredients (id, name, unit, cost_per_unit_cents, created_at, updated_at, device_id) VALUES ('i1', 'Test cheese', 'g', 120, 'x', 'x', 'd')`);
    run(
      `INSERT INTO purchase_orders (id, supplier_id, reference_no, status, total_cents, created_by_user_id, created_at, updated_at, device_id, version)
       VALUES ('po1', 's1', 'R-1', 'partial', 240000, 'u1', '2026-09-01T00:00:00.000Z', 'x', 'd', 3)`,
    );
    run(
      `INSERT INTO purchase_order_items (id, purchase_order_id, ingredient_id, qty_ordered, qty_received, unit_cost_cents, line_total_cents, created_at, updated_at, device_id)
       VALUES ('l1', 'po1', 'i1', 2000, 1000, 120, 240000, 'x', 'x', 'd')`,
    );
    run(
      `INSERT INTO purchase_order_items (id, purchase_order_id, ingredient_id, qty_ordered, qty_received, unit_cost_cents, line_total_cents, created_at, updated_at, device_id)
       VALUES ('l2', 'po1', 'i1', 500, 0, 120, 60000, 'x', 'x', 'd')`,
    );
    run(
      `INSERT INTO stock_movements (id, ingredient_id, delta_qty, reason, ref_purchase_order_id, occurred_at, resulting_qty, created_at, updated_at, device_id)
       VALUES ('m1', 'i1', 1000, 'delivery', 'po1', '2026-09-02T00:00:00.000Z', 1000, 'x', 'x', 'd')`,
    );
    run(
      `INSERT INTO ingredient_costs (id, ingredient_id, effective_at, unit, pack_size, pack_price_cents, price_kind, unit_cost_mc, source,
                                     supplier_id, ref_purchase_order_id, ref_purchase_order_item_id, created_at, updated_at, device_id)
       VALUES ('c1', 'i1', '2026-09-02T00:00:00.000Z', 'g', 1, 120, 'set', 120000, 'delivery', 's1', 'po1', 'l1', 'x', 'x', 'd')`,
    );
    run(`INSERT INTO shifts (id, device_id, opened_by_user_id, opened_at, created_at, updated_at) VALUES ('sh1', 'd', 'u1', 'x', 'x', 'x')`);
    run(
      `INSERT INTO cash_movements (id, shift_id, type, amount_cents, reason, user_id, created_at, updated_at, device_id)
       VALUES ('cm1', 'sh1', 'payout', 50000, 'Market', 'u1', 'x', 'x', 'd')`,
    );
    db.exec(readFileSync(join(MIGRATIONS, '0035_purchases.sql'), 'utf8'));

    expect(db.prepare(`SELECT id, supplier_id, reference_no, status, total_cents, version, kind, invoice_no FROM purchase_orders`).all()).toEqual([
      { id: 'po1', supplier_id: 's1', reference_no: 'R-1', status: 'partial', total_cents: 240000, version: 3, kind: 'order', invoice_no: null },
    ]);
    // A line already part received keeps what its delivery rows were worth (1,000 g at Rs 1.20 = Rs 1,200),
    // so its history never says "billed Rs 0".
    // A line with nothing received yet stays at Rs 0 billed.
    expect(
      db.prepare(`SELECT id, ordered_pack_size AS s, ordered_pack_price_cents AS p, received_value_cents AS v FROM purchase_order_items ORDER BY id`).all(),
    ).toEqual([
      { id: 'l1', s: null, p: null, v: 120_000 },
      { id: 'l2', s: null, p: null, v: 0 },
    ]);
    expect(db.prepare(`SELECT ref_purchase_order_id AS po FROM cash_movements`).get()).toEqual({ po: null });
    // Nothing points at a missing row; foreign keys are back on.
    expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    expect(db.prepare(`PRAGMA foreign_keys`).get()).toEqual({ foreign_keys: 1 });
    // The indexes the table had are there again.
    const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'purchase_orders'`).all() as Array<{ name: string }>).map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining(['idx_pos_supplier_status', 'idx_pos_status_ordered']));
    // A purchase with no supplier, and only the two kinds.
    run(
      `INSERT INTO purchase_orders (id, supplier_id, status, total_cents, created_by_user_id, kind, created_at, updated_at, device_id)
       VALUES ('po2', NULL, 'received', 100, 'u1', 'quick', 'x', 'x', 'd')`,
    );
    expect(() =>
      run(
        `INSERT INTO purchase_orders (id, supplier_id, status, total_cents, created_by_user_id, kind, created_at, updated_at, device_id)
         VALUES ('po3', NULL, 'received', 100, 'u1', 'gift', 'x', 'x', 'd')`,
      ),
    ).toThrow(/CHECK/);
    // A payout can point at a purchase; a purchase that is not there is refused.
    run(`UPDATE cash_movements SET ref_purchase_order_id = 'po2' WHERE id = 'cm1'`);
    expect(() => run(`UPDATE cash_movements SET ref_purchase_order_id = 'nope' WHERE id = 'cm1'`)).toThrow(/FOREIGN KEY/);
  });
});

// ---------------------------------------------------------------------------
// Purchase orders keep the price they were ordered at, exactly
// ---------------------------------------------------------------------------

live('a purchase order typed per kg, per pack or per piece', () => {
  it('stores the exact ordered pack; each line is rounded once; synced and audited', async () => {
    const s = await shop();
    const sup = s.supplier('Test Veg Co');
    const po = s.r.createPurchaseOrder(
      s.db,
      {
        supplierId: sup.id,
        items: [
          // Rs 155.50 a kg for 2.5 kg: Rs 388.75 exactly (per-gram whole paisa would say Rs 400).
          { ingredientId: s.ing.onion, qtyOrdered: 2_500, price: { per: 'thousand', priceCents: 15_550 } },
          // Rs 2,450 for a 2,000 g pack, 6 kg of it.
          { ingredientId: s.ing.cheese, qtyOrdered: 6_000, price: { per: 'pack', priceCents: 245_000, packSize: 2_000 } },
          // Rs 41 a box.
          { ingredientId: s.ing.box, qtyOrdered: 50, price: { per: 'piece', priceCents: 4_100 } },
        ],
      },
      MANAGER,
    );
    expect(po.kind).toBe('order');
    expect(po.items.map((i) => [i.orderedPackSize, i.orderedPackPriceCents, i.lineTotalCents, i.unitCostCents])).toEqual([
      [1_000, 15_550, 38_875, 16],
      [2_000, 245_000, 735_000, 123],
      [1, 4_100, 205_000, 4_100],
    ]);
    expect(po.totalCents).toBe(38_875 + 735_000 + 205_000);
    // The lines travel as themselves (row images, with the ordered pack) and the order is audited.
    const queued = s.db
      .prepare(`SELECT payload_json FROM sync_queue WHERE entity_type = 'purchase_order_items' AND entity_id = ?`)
      .get(po.items[0]!.id) as { payload_json: string };
    expect(JSON.parse(queued.payload_json)).toMatchObject({ orderedPackSize: 1_000, orderedPackPriceCents: 15_550 });
    expect(n(s.db, `SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'purchase_orders' AND entity_id = ? AND action = 'create'`, po.id)).toBe(1);
  });

  it('a price that does not fit the unit is refused in plain words, and nothing is written', async () => {
    const s = await shop();
    const sup = s.supplier('Test Veg Co');
    const before = s.counts();
    expect(() =>
      s.r.createPurchaseOrder(
        s.db,
        {
          supplierId: sup.id,
          items: [
            { ingredientId: s.ing.onion, qtyOrdered: 1_000, price: { per: 'thousand', priceCents: 15_000 } },
            { ingredientId: s.ing.cheese, qtyOrdered: 1_000, price: { per: 'piece', priceCents: 100 } },
          ],
        },
        MANAGER,
      ),
    ).toThrow(/Per piece does not fit something counted in g/);
    expect(s.counts()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Receiving at the bill
// ---------------------------------------------------------------------------

live('receiving a purchase order at its bill', () => {
  it('history row = the bill exactly; the ingredient keeps its usual pack at round(B × S ÷ q); the delivery row is worth the bill', async () => {
    const s = await shop();
    const sup = s.supplier('Test Dairy');
    // Cheese is kept as 2,000 g for Rs 2,400 (Rs 1,200 / kg, made up).
    expect(s.price(s.ing.cheese)).toMatchObject({ size: 2_000, price: 240_000 });
    const po = s.r.createPurchaseOrder(
      s.db,
      { supplierId: sup.id, items: [{ ingredientId: s.ing.cheese, qtyOrdered: 6_000, price: { per: 'thousand', priceCents: 125_000 } }] },
      MANAGER,
    );
    s.r.setPurchaseOrderStatus(s.db, po.id, 'ordered', MANAGER);
    const before = s.history(s.ing.cheese).length;
    // The bill says Rs 7,350 for the 6 kg (Rs 1,225 / kg: 2.1% above the usual, within 10%).
    const got = s.r.receiveDelivery(
      s.db,
      { purchaseOrderId: po.id, invoiceNo: ' INV-0042 ', receipts: [{ purchaseOrderItemId: po.items[0]!.id, qtyReceivedNow: 6_000, billCents: 735_000 }] },
      MANAGER,
    );
    expect(got).toMatchObject({ status: 'received', invoiceNo: 'INV-0042' });
    expect(got.items[0]).toMatchObject({ qtyReceived: 6_000, receivedValueCents: 735_000 });

    // The price history: one row, the bill exactly as paid, naming the supplier, the order and its line.
    const rows = s.history(s.ing.cheese);
    expect(rows).toHaveLength(before + 1);
    expect(rows[rows.length - 1]).toMatchObject({
      source: 'delivery',
      size: 6_000,
      price: 735_000,
      mc: 122_500,
      prev: 120_000,
      supplierId: sup.id,
      poId: po.id,
      itemId: po.items[0]!.id,
    });
    // The ingredient keeps its usual 2,000 g pack, at round(735,000 × 2,000 ÷ 6,000) = Rs 2,450: never cleared.
    expect(s.price(s.ing.cheese)).toEqual({ cpu: 123, size: 2_000, price: 245_000, kind: 'set' });
    // The stock came in worth exactly the bill.
    expect(s.deliveries(po.id)).toEqual([{ ingredientId: s.ing.cheese, qty: 6_000, value: 735_000, mc: 122_500, basis: 'bill' }]);
    expect(chainOk(s.db)).toBe(true);
  });

  it('with no bill typed, the bill is the ordered price for what came; a part delivery then the rest adds up', async () => {
    const s = await shop();
    const sup = s.supplier('Test Veg Co');
    const po = s.r.createPurchaseOrder(
      s.db,
      { supplierId: sup.id, items: [{ ingredientId: s.ing.onion, qtyOrdered: 3_000, price: { per: 'thousand', priceCents: 15_550 } }] },
      MANAGER,
    );
    const item = po.items[0]!.id;
    const part = s.r.receiveDelivery(s.db, { purchaseOrderId: po.id, receipts: [{ purchaseOrderItemId: item, qtyReceivedNow: 1_001 }] }, MANAGER);
    expect(part.status).toBe('partial');
    expect(part.items[0]).toMatchObject({ qtyReceived: 1_001, receivedValueCents: 15_566 }); // 1,001 g at Rs 155.50 / kg, rounded once
    const rest = s.r.receiveDelivery(s.db, { purchaseOrderId: po.id, receipts: [{ purchaseOrderItemId: item, qtyReceivedNow: 1_999 }] }, MANAGER);
    expect(rest.status).toBe('received');
    expect(rest.items[0]!.receivedValueCents).toBe(15_566 + 31_084);
    expect(s.deliveries(po.id).map((d) => d.value)).toEqual([15_566, 31_084]);
  });

  it('the list shows what was billed for what came; open orders are fetched on their own, however many purchases follow', async () => {
    const s = await shop();
    const sup = s.supplier('Test Dairy');
    // An order drafted first, still open…
    const draft = s.r.createPurchaseOrder(
      s.db,
      { supplierId: sup.id, items: [{ ingredientId: s.ing.cheese, qtyOrdered: 2_000, price: { per: 'thousand', priceCents: 125_000 } }] },
      MANAGER,
    );
    // …an order for 3 kg at Rs 1,250 / kg (Rs 3,750), part received at a bill of Rs 2,730 for 2 kg…
    const po = s.r.createPurchaseOrder(
      s.db,
      { supplierId: sup.id, items: [{ ingredientId: s.ing.cheese, qtyOrdered: 3_000, price: { per: 'thousand', priceCents: 125_000 } }] },
      MANAGER,
    );
    s.r.receiveDelivery(s.db, { purchaseOrderId: po.id, receipts: [{ purchaseOrderItemId: po.items[0]!.id, qtyReceivedNow: 2_000, billCents: 273_000 }] }, MANAGER);
    // …then the last 1 kg at Rs 1,370: billed Rs 4,100 in all, against Rs 3,750 ordered.
    s.r.receiveDelivery(s.db, { purchaseOrderId: po.id, receipts: [{ purchaseOrderItemId: po.items[0]!.id, qtyReceivedNow: 1_000, billCents: 137_000 }] }, MANAGER);
    // …and a market run.
    const quick = s.r.recordPurchase(s.db, { lines: [{ ingredientId: s.ing.onion, qty: 2_000, billCents: 31_000 }] }, MANAGER);

    const all = s.r.listPurchaseOrders(s.db, { limit: 50 });
    const of = (id: string) => all.find((x) => x.id === id)!;
    expect(of(po.id)).toMatchObject({ status: 'received', totalCents: 375_000, billedCents: 410_000 });
    expect(of(draft.id)).toMatchObject({ status: 'draft', totalCents: 250_000, billedCents: 0 });
    expect(of(quick.purchase.id)).toMatchObject({ kind: 'quick', totalCents: 31_000, billedCents: 31_000 });
    expect(s.r.getPurchaseOrderWithItems(s.db, po.id)).toMatchObject({ billedCents: 410_000 });

    // The newest purchase alone would push the draft off a list capped at 1; asked for what is open, it is there.
    expect(s.r.listPurchaseOrders(s.db, { limit: 1 }).map((x) => x.id)).toEqual([quick.purchase.id]);
    expect(s.r.listPurchaseOrders(s.db, { open: true }).map((x) => x.id)).toEqual([draft.id]);
  });

  it('an ingredient priced per gram the old way (no pack) is kept per kg from the bill', async () => {
    const s = await shop();
    const sup = s.supplier('Test Mill');
    const flour = s.r.createIngredient(s.db, { name: 'Test flour', unit: 'g', costPerUnitCents: 9 }, MANAGER);
    const po = s.r.createPurchaseOrder(s.db, { supplierId: sup.id, items: [{ ingredientId: flour.id, qtyOrdered: 5_000, unitCostCents: 9 }] }, MANAGER);
    // Rs 475 for 5 kg (Rs 95 / kg, 5.6% above Rs 90 / kg): used.
    s.r.receiveDelivery(s.db, { purchaseOrderId: po.id, receipts: [{ purchaseOrderItemId: po.items[0]!.id, qtyReceivedNow: 5_000, billCents: 47_500 }] }, MANAGER);
    expect(s.price(flour.id)).toEqual({ cpu: 10, size: 1_000, price: 9_500, kind: 'set' });
    expect(s.history(flour.id).at(-1)).toMatchObject({ source: 'delivery', size: 5_000, price: 47_500 });
  });
});

// ---------------------------------------------------------------------------
// D1's guard
// ---------------------------------------------------------------------------

live("D1's guard: when a bill's price becomes the ingredient's price", () => {
  it('a quick purchase 25% above the usual price is not used by default — the stock still comes in at the bill', async () => {
    const s = await shop();
    // Onion is Rs 150 / kg (made up); the market wanted Rs 375 for 2 kg (Rs 187.50 / kg).
    const before = { price: s.price(s.ing.onion), rows: s.history(s.ing.onion).length, stock: s.stockOf('onion') };
    const res = s.r.recordPurchase(s.db, { lines: [{ ingredientId: s.ing.onion, qty: 2_000, billCents: 37_500 }] }, MANAGER);
    expect(res.pricesUsed).toEqual([]);
    expect(res.pricesKept).toEqual([s.ing.onion]);
    expect(s.price(s.ing.onion)).toEqual(before.price);
    expect(s.history(s.ing.onion)).toHaveLength(before.rows);
    expect(s.stockOf('onion')).toBe(before.stock + 2_000);
    expect(s.deliveries(res.purchase.id)).toEqual([{ ingredientId: s.ing.onion, qty: 2_000, value: 37_500, mc: 18_750, basis: 'bill' }]);
    expect(res.purchase).toMatchObject({ kind: 'quick', status: 'received', supplierId: null, totalCents: 37_500 });
    expect(res.purchase.items[0]).toMatchObject({ qtyOrdered: 2_000, qtyReceived: 2_000, orderedPackSize: 2_000, orderedPackPriceCents: 37_500, receivedValueCents: 37_500 });
  });

  it('…and is used when the screen says yes (a "purchase" history row, the bill exactly)', async () => {
    const s = await shop();
    const res = s.r.recordPurchase(s.db, { lines: [{ ingredientId: s.ing.onion, qty: 2_000, billCents: 37_500, usePrice: true }] }, MANAGER);
    expect(res.pricesUsed).toEqual([s.ing.onion]);
    expect(s.price(s.ing.onion)).toEqual({ cpu: 19, size: 1_000, price: 18_750, kind: 'set' });
    expect(s.history(s.ing.onion).at(-1)).toMatchObject({ source: 'purchase', size: 2_000, price: 37_500, prev: 15_000, poId: res.purchase.id, supplierId: null });
  });

  it('a quick purchase within 10% is used without asking', async () => {
    const s = await shop();
    const res = s.r.recordPurchase(s.db, { lines: [{ ingredientId: s.ing.onion, qty: 4_000, billCents: 62_000 }] }, MANAGER); // Rs 155 / kg
    expect(res.pricesUsed).toEqual([s.ing.onion]);
    expect(s.price(s.ing.onion)).toMatchObject({ size: 1_000, price: 15_500 });
  });

  it('a purchase order delivered within 10% is used; 25% above is used by default, and kept when the screen says no', async () => {
    const s = await shop();
    const sup = s.supplier('Test Veg Co');
    const po = s.r.createPurchaseOrder(
      s.db,
      {
        supplierId: sup.id,
        items: [
          { ingredientId: s.ing.pepper, qtyOrdered: 1_000, price: { per: 'thousand', priceCents: 32_400 } }, // +8% on Rs 300 / kg
          { ingredientId: s.ing.olive, qtyOrdered: 1_000, price: { per: 'thousand', priceCents: 150_000 } }, // +25% on Rs 1,200 / kg
          { ingredientId: s.ing.corn, qtyOrdered: 1_000, price: { per: 'thousand', priceCents: 50_000 } }, // +25% on Rs 400 / kg
        ],
      },
      MANAGER,
    );
    s.r.receiveDelivery(
      s.db,
      {
        purchaseOrderId: po.id,
        receipts: [
          { purchaseOrderItemId: po.items[0]!.id, qtyReceivedNow: 1_000 },
          { purchaseOrderItemId: po.items[1]!.id, qtyReceivedNow: 1_000 },
          { purchaseOrderItemId: po.items[2]!.id, qtyReceivedNow: 1_000, usePrice: false },
        ],
      },
      MANAGER,
    );
    expect(s.price(s.ing.pepper)).toMatchObject({ size: 1_000, price: 32_400 });
    expect(s.price(s.ing.olive)).toMatchObject({ size: 1_000, price: 150_000 });
    expect(s.price(s.ing.corn)).toMatchObject({ size: 1_000, price: 40_000 });
    // Each line came in at its bill either way.
    expect(s.deliveries(po.id).map((d) => d.value)).toEqual([32_400, 150_000, 50_000]);
    // What the guard said, line by line, is in the audit trail.
    const audit = s.db.prepare(`SELECT after_json FROM audit_log WHERE entity_id = ? AND action = 'receive'`).get(po.id) as { after_json: string };
    expect(JSON.parse(audit.after_json).receipts.map((r: { why: string; used: boolean }) => [r.why, r.used])).toEqual([
      ['within', true],
      ['higher', true],
      ['higher', false],
    ]);
  });

  it('a batch made here keeps its price from its recipe; a bill of Rs 0 changes no price', async () => {
    const s = await shop();
    // Pizza sauce is made here from tomato and garlic (both priced): a bought jar is stock, not its price.
    const sauceBefore = s.price(s.ing.sauce);
    const r1 = s.r.recordPurchase(s.db, { lines: [{ ingredientId: s.ing.sauce, qty: 1_000, billCents: 90_000, usePrice: true }] }, MANAGER);
    expect(r1.pricesUsed).toEqual([]);
    expect(s.price(s.ing.sauce)).toEqual(sauceBefore);
    const garlicBefore = s.price(s.ing.garlic);
    const r2 = s.r.recordPurchase(s.db, { lines: [{ ingredientId: s.ing.garlic, qty: 500, billCents: 0 }] }, MANAGER);
    expect(r2.pricesUsed).toEqual([]);
    expect(s.price(s.ing.garlic)).toEqual(garlicBefore);
  });
});

// ---------------------------------------------------------------------------
// Paid from the drawer
// ---------------------------------------------------------------------------

live('a quick purchase paid from the drawer', () => {
  it("writes the payout with it: the shift's expected cash includes it; synced and audited; the chain holds", async () => {
    const s = await shop();
    const shift = s.r.openShift(s.db, { openingCashCents: 500_000 }, MANAGER);
    expect(s.r.getShiftSummary(s.db, shift.id)).toMatchObject({ cashOutCents: 0, expectedCashCents: 500_000 });
    const res = s.r.recordPurchase(
      s.db,
      {
        paidFromDrawer: true,
        invoiceNo: 'M-17',
        lines: [
          { ingredientId: s.ing.onion, qty: 5_000, billCents: 80_000 }, // Rs 160 / kg
          { ingredientId: s.ing.tomato, qty: 10_000, billCents: 130_000 }, // Rs 130 / kg
        ],
      },
      MANAGER,
    );
    expect(res.purchase.totalCents).toBe(210_000);
    expect(res.purchase.payout).toMatchObject({ shiftId: shift.id, amountCents: 210_000 });
    // The drawer's line says only that it bought stock (and the bill): what was bought, from whom and at what
    // price is purchase figures, and a cashier sees the drawer's cash in and out.
    expect(res.purchase.payout!.reason).toBe('Stock purchase · bill M-17');
    expect(s.r.listCashMovements(s.db, shift.id).map((m) => m.reason)).toEqual(['Stock purchase · bill M-17']);
    const m = s.db.prepare(`SELECT type, amount_cents AS amount, ref_purchase_order_id AS po FROM cash_movements WHERE shift_id = ?`).all(shift.id);
    expect(m).toEqual([{ type: 'payout', amount: 210_000, po: res.purchase.id }]);
    expect(s.r.getShiftSummary(s.db, shift.id)).toMatchObject({ cashOutCents: 210_000, expectedCashCents: 290_000 });

    // Synced (every row travels as itself) and audited.
    const synced = (type: string) => n(s.db, `SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = ?`, type);
    expect(synced('purchase_orders')).toBe(1);
    expect(synced('purchase_order_items')).toBe(2);
    expect(synced('cash_movements')).toBe(1);
    const queuedPayout = s.db.prepare(`SELECT payload_json FROM sync_queue WHERE entity_type = 'cash_movements'`).get() as { payload_json: string };
    expect(JSON.parse(queuedPayout.payload_json)).toMatchObject({ refPurchaseOrderId: res.purchase.id, amountCents: 210_000 });
    const audited = (action: string) => n(s.db, `SELECT COUNT(*) AS n FROM audit_log WHERE action = ?`, action);
    expect(audited('purchase')).toBe(1);
    expect(audited('cash_payout')).toBe(1);
    const trail = s.db.prepare(`SELECT after_json FROM audit_log WHERE action = 'purchase'`).get() as { after_json: string };
    expect(JSON.parse(trail.after_json)).toMatchObject({ paidFromDrawer: true, totalCents: 210_000, invoiceNo: 'M-17' });
    expect(chainOk(s.db)).toBe(true);

    // The shift closes on the same figure.
    const closed = s.r.closeShift(s.db, { shiftId: shift.id, countedCashCents: 290_000 }, MANAGER);
    expect(closed).toMatchObject({ expectedCashCents: 290_000, varianceCents: 0 });
  });

  it('one transaction: a failure anywhere writes nothing — no purchase, no stock, no price, no payout', async () => {
    const s = await shop();
    const shift = s.r.openShift(s.db, { openingCashCents: 100_000 }, MANAGER);
    const before = s.counts();
    const stock = s.stockOf('onion');
    const onion = s.price(s.ing.onion);
    // The purchase, its stock and its price are written, then the payout is refused (more than a drawer holds):
    // all of it is undone.
    expect(() =>
      s.r.recordPurchase(
        s.db,
        {
          paidFromDrawer: true,
          lines: [
            { ingredientId: s.ing.onion, qty: 1_000, billCents: 15_500, usePrice: true },
            { ingredientId: s.ing.tomato, qty: 1_000, billCents: 1_000_000_001 },
          ],
        },
        MANAGER,
      ),
    ).toThrow(/too large for the drawer/);
    // An ingredient no longer there: refused before anything is written.
    expect(() =>
      s.r.recordPurchase(
        s.db,
        {
          paidFromDrawer: true,
          lines: [
            { ingredientId: s.ing.onion, qty: 1_000, billCents: 15_000 },
            { ingredientId: 'no-such-ingredient', qty: 1_000, billCents: 15_000 },
          ],
        },
        MANAGER,
      ),
    ).toThrow(/no longer in Inventory/);
    expect(s.counts()).toEqual(before);
    expect(s.stockOf('onion')).toBe(stock);
    expect(s.price(s.ing.onion)).toEqual(onion);
    expect(s.r.getShiftSummary(s.db, shift.id).expectedCashCents).toBe(100_000);
    expect(chainOk(s.db)).toBe(true);
  });

  it('with no shift open it is refused in plain words, and nothing is written', async () => {
    const s = await shop();
    const before = s.counts();
    expect(() =>
      s.r.recordPurchase(s.db, { paidFromDrawer: true, lines: [{ ingredientId: s.ing.onion, qty: 1_000, billCents: 15_000 }] }, MANAGER),
    ).toThrow(/No shift is open on this till/);
    expect(s.counts()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Turn this payout into a purchase
// ---------------------------------------------------------------------------

live('"Turn this payout into a purchase"', () => {
  it("links once, never changes the cash; asked again it writes nothing", async () => {
    const s = await shop();
    const shift = s.r.openShift(s.db, { openingCashCents: 500_000 }, MANAGER);
    // A cashier paid the market run from the drawer, with a manager's PIN.
    const payout = s.r.recordCashMovement(
      s.db,
      { type: 'payout', amountCents: 300_000, reason: 'Veg from the market', approvedByUserId: MANAGER.userId },
      CASHIER,
    );
    const cash = () => {
      const { cashOutCents, expectedCashCents } = s.r.getShiftSummary(s.db, shift.id);
      return { cashOutCents, expectedCashCents, row: s.db.prepare(`SELECT amount_cents AS a, type FROM cash_movements WHERE id = ?`).get(payout.id) };
    };
    const drawer = cash();
    expect(drawer).toMatchObject({ cashOutCents: 300_000, expectedCashCents: 200_000 });

    const first = s.r.payoutToPurchase(
      s.db,
      {
        cashMovementId: payout.id,
        lines: [
          { ingredientId: s.ing.onion, qty: 10_000, billCents: 155_000 },
          { ingredientId: s.ing.pepper, qty: 4_000, billCents: 124_000 },
        ],
      },
      MANAGER,
    );
    expect(first.alreadyLinked).toBe(false);
    expect(first.purchase).toMatchObject({ kind: 'quick', totalCents: 279_000, notes: 'Veg from the market' });
    expect(first.purchase.payout).toMatchObject({ cashMovementId: payout.id, amountCents: 300_000 });
    expect(s.db.prepare(`SELECT ref_purchase_order_id AS po FROM cash_movements WHERE id = ?`).get(payout.id)).toEqual({ po: first.purchase.id });
    expect(cash()).toEqual(drawer);
    // The link is synced and audited.
    expect(n(s.db, `SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ? AND action = 'link_purchase'`, payout.id)).toBe(1);
    expect(n(s.db, `SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'cash_movements' AND entity_id = ?`, payout.id)).toBe(2);
    // The stock came in at what was paid; no drawer money moved a second time.
    expect(s.deliveries(first.purchase.id).map((d) => d.value)).toEqual([155_000, 124_000]);
    expect(n(s.db, `SELECT COUNT(*) AS n FROM cash_movements`)).toBe(1);

    // Asked again (a double tap, or the other screen): the same purchase, nothing written.
    const before = s.counts();
    const again = s.r.payoutToPurchase(s.db, { cashMovementId: payout.id, lines: [{ ingredientId: s.ing.corn, qty: 1_000, billCents: 1_000 }] }, MANAGER);
    expect(again).toMatchObject({ alreadyLinked: true, purchase: { id: first.purchase.id } });
    expect(s.counts()).toEqual(before);
    expect(cash()).toEqual(drawer);
    expect(chainOk(s.db)).toBe(true);

    // It shows as linked in the drawer's payouts.
    expect(s.r.listDrawerPayouts(s.db, MANAGER.deviceId)).toEqual([
      expect.objectContaining({ id: payout.id, amountCents: 300_000, refPurchaseOrderId: first.purchase.id, approvedByName: 'Test Manager' }),
    ]);
  });

  it("is dated when the cash went out, not when the paperwork is done: the spend lands in the payout's period", async () => {
    const s = await shop();
    s.r.openShift(s.db, { openingCashCents: 500_000 }, MANAGER);
    const payout = s.r.recordCashMovement(
      s.db,
      { type: 'payout', amountCents: 210_000, reason: 'Veg from the market', approvedByUserId: MANAGER.userId },
      CASHIER,
    );
    // The cash went out three days ago (the last evening of a month, say); the manager turns it into a purchase now.
    const paidAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
    s.db.prepare(`UPDATE cash_movements SET created_at = ? WHERE id = ?`).run(paidAt, payout.id);
    const res = s.r.payoutToPurchase(
      s.db,
      {
        cashMovementId: payout.id,
        lines: [
          { ingredientId: s.ing.onion, qty: 10_000, billCents: 155_000 }, // Rs 155 / kg: within 10%, used
          { ingredientId: s.ing.tomato, qty: 5_000, billCents: 55_000 },
        ],
      },
      MANAGER,
    );
    expect(res.purchase).toMatchObject({ orderedAt: paidAt, receivedAt: paidAt });
    const rows = s.db
      .prepare(`SELECT occurred_at AS at FROM stock_movements WHERE ref_purchase_order_id = ? ORDER BY rowid`)
      .all(res.purchase.id) as Array<{ at: string }>;
    expect(rows.map((r) => r.at)).toEqual([paidAt, paidAt]);
    // Reports put the spend with the payout, not with the paperwork.
    const around = (iso: string) => ({
      sinceIso: new Date(Date.parse(iso) - 3_600_000).toISOString(),
      untilIso: new Date(Date.parse(iso) + 3_600_000).toISOString(),
    });
    expect(s.getPurchases(s.db, around(paidAt)).spendCents).toBe(210_000);
    expect(s.getPurchases(s.db, around(new Date().toISOString())).spendCents).toBe(0);
    // A price the bill gives takes effect when it is decided (now), and the audit row says when the goods came.
    const priced = s.history(s.ing.onion).at(-1)!;
    expect(priced).toMatchObject({ source: 'purchase', poId: res.purchase.id });
    const effective = s.db.prepare(`SELECT effective_at AS at FROM ingredient_costs WHERE id = ?`).get(priced.id) as { at: string };
    expect(effective.at > paidAt).toBe(true);
    const audit = s.db.prepare(`SELECT after_json FROM audit_log WHERE action = 'purchase_from_payout'`).get() as { after_json: string };
    expect(JSON.parse(audit.after_json)).toMatchObject({ boughtAt: paidAt, cashMovementId: payout.id, payoutCents: 210_000 });
  });

  it('only cash taken out can be a purchase; an unknown payout is refused', async () => {
    const s = await shop();
    s.r.openShift(s.db, { openingCashCents: 0 }, MANAGER);
    const payin = s.r.recordCashMovement(s.db, { type: 'payin', amountCents: 50_000, reason: 'Change from the bank' }, MANAGER);
    const line = [{ ingredientId: s.ing.onion, qty: 1_000, billCents: 15_000 }];
    const before = s.counts();
    expect(() => s.r.payoutToPurchase(s.db, { cashMovementId: payin.id, lines: line }, MANAGER)).toThrow(/Only cash taken out of the drawer/);
    expect(() => s.r.payoutToPurchase(s.db, { cashMovementId: 'nope', lines: line }, MANAGER)).toThrow(/not found/);
    expect(s.counts()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Reports: purchases
// ---------------------------------------------------------------------------

live('Reports → Food cost & stock: purchases', () => {
  it('by supplier and by ingredient each add up to the delivery rows in the period; the latest price against the one before', async () => {
    const s = await shop();
    const dairy = s.supplier('Test Dairy');
    const veg = s.supplier('Test Veg Co');
    // Before the period: cheese at Rs 1,200 / kg (the purchase before).
    const early = s.r.recordPurchase(s.db, { supplierId: dairy.id, lines: [{ ingredientId: s.ing.cheese, qty: 2_000, billCents: 240_000 }] }, MANAGER);
    s.db.prepare(`UPDATE stock_movements SET occurred_at = '2026-01-10T10:00:00.000Z' WHERE ref_purchase_order_id = ?`).run(early.purchase.id);

    // In the period: a purchase order from the dairy, a market run with no supplier,
    // a purchase from the veg supplier, and stock booked in by hand (no bill).
    const po = s.r.createPurchaseOrder(
      s.db,
      { supplierId: dairy.id, items: [{ ingredientId: s.ing.cheese, qtyOrdered: 4_000, price: { per: 'thousand', priceCents: 126_000 } }] },
      MANAGER,
    );
    s.r.receiveDelivery(s.db, { purchaseOrderId: po.id, receipts: [{ purchaseOrderItemId: po.items[0]!.id, qtyReceivedNow: 4_000 }] }, MANAGER);
    s.r.recordPurchase(
      s.db,
      {
        lines: [
          { ingredientId: s.ing.onion, qty: 3_000, billCents: 45_000 },
          { ingredientId: s.ing.cheese, qty: 1_000, billCents: 130_000 },
        ],
      },
      MANAGER,
    );
    s.r.recordPurchase(s.db, { supplierId: veg.id, lines: [{ ingredientId: s.ing.onion, qty: 2_000, billCents: 32_000 }] }, MANAGER);
    // Two lots booked in by hand, with no bill: no bills, and no price paid.
    s.r.recordStockMovement(s.db, { ingredientId: s.ing.box, deltaQty: 20, reason: 'delivery', notes: 'Found in the back' }, MANAGER);
    s.r.recordStockMovement(s.db, { ingredientId: s.ing.box, deltaQty: 10, reason: 'delivery', notes: 'Found some more' }, MANAGER);
    // Last, the dairy sends 500 g of cheese free, as a sample: a bill of Rs 0 — a purchase, but not a price.
    s.r.recordPurchase(s.db, { supplierId: dairy.id, lines: [{ ingredientId: s.ing.cheese, qty: 500, billCents: 0 }] }, MANAGER);

    const range = { sinceIso: new Date(Date.now() - 3_600_000).toISOString(), untilIso: new Date(Date.now() + 3_600_000).toISOString() };
    const p = s.getPurchases(s.db, range);
    const inPeriod = n(
      s.db,
      `SELECT COALESCE(SUM(value_cents), 0) AS n FROM stock_movements WHERE reason = 'delivery' AND occurred_at >= ? AND occurred_at < ?`,
      range.sinceIso,
      range.untilIso,
    );
    expect(inPeriod).toBe(504_000 + 45_000 + 130_000 + 32_000 + 80_000 + 40_000 + 0);
    expect(p.spendCents).toBe(inPeriod);
    expect(p.bySupplier.reduce((t, l) => t + l.spendCents, 0)).toBe(inPeriod);
    expect(p.byIngredient.reduce((t, l) => t + l.spendCents, 0)).toBe(inPeriod);
    // 30 boxes at Rs 40 (the price then), booked in twice — and never counted as a bill.
    expect(p).toMatchObject({ byHandCents: 120_000, byHandEntries: 2 });
    expect(p.bySupplier.map((l) => [l.name, l.from, l.bills, l.spendCents])).toEqual([
      ['Test Dairy', 'supplier', 2, 504_000],
      ['No supplier named', 'no_supplier', 1, 175_000],
      ['Booked in by hand (no bill)', 'by_hand', 0, 120_000],
      ['Test Veg Co', 'supplier', 1, 32_000],
    ]);
    // The bills are the purchases: the dairy's order and its sample, the market run, the veg supplier's.
    expect(p.bills).toBe(4);
    const cheese = p.byIngredient.find((l) => l.ingredientId === s.ing.cheese)!;
    // Bought three times in the period (Rs 1,260 then Rs 1,300 / kg, then a free sample): the latest PRICE is the
    // Rs 1,300 one and the one before it Rs 1,260 — the Rs 0 sample is stock, not a price (never "▼ 100%").
    expect(cheese).toMatchObject({ qty: 5_500, times: 3, spendCents: 634_000, lastUnitCostMc: 130_000, prevUnitCostMc: 126_000 });
    // Stock booked in by hand has no price paid.
    expect(p.byIngredient.find((l) => l.ingredientId === s.ing.box)).toMatchObject({ qty: 30, times: 2, spendCents: 120_000, lastUnitCostMc: null, prevUnitCostMc: null });
    const onion = p.byIngredient.find((l) => l.ingredientId === s.ing.onion)!;
    expect(onion).toMatchObject({ qty: 5_000, times: 2, lastUnitCostMc: 16_000, prevUnitCostMc: 15_000 });
    // The period before holds only the early cheese; its "purchase before" is none.
    const jan = s.getPurchases(s.db, { sinceIso: '2026-01-10T00:00:00.000Z', untilIso: '2026-01-11T00:00:00.000Z' });
    expect(jan.byIngredient).toEqual([expect.objectContaining({ ingredientId: s.ing.cheese, spendCents: 240_000, lastUnitCostMc: 120_000, prevUnitCostMc: null })]);

    // The Food cost & stock tab carries them (the worker's builder).
    expect(s.buildFoodStockTab(s.db, range).purchases).toEqual(p);
  });

  it('a bill of Rs 0 is not a price: the next paid purchase is compared with the last PAID one', async () => {
    const s = await shop();
    const dairy = s.supplier('Test Dairy');
    const at = (id: string, iso: string) =>
      s.db.prepare(`UPDATE stock_movements SET occurred_at = ? WHERE ref_purchase_order_id = ?`).run(iso, id);
    const buy = (qty: number, billCents: number, iso: string) =>
      at(s.r.recordPurchase(s.db, { supplierId: dairy.id, lines: [{ ingredientId: s.ing.cheese, qty, billCents }] }, MANAGER).purchase.id, iso);
    buy(2_000, 240_000, '2026-08-05T10:00:00.000Z'); // Rs 1,200 / kg
    buy(500, 0, '2026-08-28T10:00:00.000Z'); // a free sample at the end of the month
    buy(2_000, 264_000, '2026-09-05T10:00:00.000Z'); // Rs 1,320 / kg: 10% up on the last price PAID
    const aug = s.getPurchases(s.db, { sinceIso: '2026-08-01T00:00:00.000Z', untilIso: '2026-09-01T00:00:00.000Z' });
    expect(aug.byIngredient).toEqual([
      expect.objectContaining({ ingredientId: s.ing.cheese, times: 2, spendCents: 240_000, lastUnitCostMc: 120_000, prevUnitCostMc: null }),
    ]);
    const sep = s.getPurchases(s.db, { sinceIso: '2026-09-01T00:00:00.000Z', untilIso: '2026-10-01T00:00:00.000Z' });
    expect(sep.byIngredient).toEqual([expect.objectContaining({ lastUnitCostMc: 132_000, prevUnitCostMc: 120_000 })]);
  });
});
