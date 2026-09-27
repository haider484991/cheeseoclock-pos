/**
 * What happens to ingredient stock when an order is cancelled or refunded —
 * measured on a real database built from every migration, foreign keys on.
 *
 * Every test builds a fresh shop: a tiny menu with recipes (a "leave out"
 * choice, paid extras, a paid dip on the side, a free dip choice, Veggie Lovers
 * picks, a two-pizza deal with its own "leave out", a standalone dip, a
 * bottled drink), a sauce made in-house from tomatoes and a flour still
 * counted in kg. Orders are then driven through the repositories in the order
 * the IPC handlers call them (ipc/handlers/orders-handlers.ts; the website
 * import mirrors services/web-orders-bridge.ts) and the stock change per
 * ingredient is asserted.
 *
 * The rule under test (order-stock-repo.ts): whoever cancels or refunds in
 * full answers "Was the food made?". Not made → exactly what the order took
 * goes back (read from the ledger, never the recipe). Made → it stays off the
 * shelf and is booked as WASTE against the order, so the order's net 'sale'
 * is always 0 afterwards. The till never guesses: while the food is still in
 * the shop an answer is required; once it left the shop only "made" is taken.
 *
 * These tests were first written to measure the behaviour before the question
 * existed; the cases that were wrong then ("WRONG TODAY") now assert the fix.
 *
 * better-sqlite3 here is built for Electron's ABI, so this uses node's own
 * `node:sqlite` behind a small better-sqlite3-shaped shim and skips itself
 * where that is missing. Every name, price and amount is made up.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { validateOrderForTender, websiteDiscountRule } from '@cheeseoclock/pos-domain';
import type {
  FoodMade,
  OrderMode,
  OrderStatus,
  OrderStockAnswer,
  PaymentMethod,
  StockMovementReason,
} from '@cheeseoclock/shared-types';
import type { AppDatabase } from './connection.js';
import { verifyAuditChain, type AuditChainRow } from './audit-chain.js';

// Builds a real database from every migration per test and loads the
// repositories on first use: seconds on a slow CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

// ---------------------------------------------------------------------------
// node:sqlite behind better-sqlite3's shape
// ---------------------------------------------------------------------------

interface Stmt {
  run(...p: unknown[]): unknown;
  all(...p: unknown[]): Array<Record<string, unknown>>;
  get(...p: unknown[]): Record<string, unknown> | undefined;
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
}
type RawDbCtor = new (path: string) => RawDb;
let DatabaseSync: RawDbCtor | null = null;
try {
  DatabaseSync = (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: RawDbCtor }).DatabaseSync;
} catch {
  DatabaseSync = null;
}
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

function openMigrated(): AppDatabase {
  if (!DatabaseSync) throw new Error('node:sqlite unavailable');
  const raw = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  raw.exec('PRAGMA foreign_keys = ON');
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
  } as unknown as AppDatabase;
}

const DEV = 'till-1';
const CASHIER = { userId: 'u_cash', deviceId: DEV };
const MANAGER = { userId: 'u_mgr', deviceId: DEV };
/** The website bridge books imports under the shop's admin/manager (resolveActor). */
const BRIDGE = MANAGER;

const repos = async () => ({
  ...(await import('./repositories/order-repo.js')),
  ...(await import('./repositories/stock-movement-repo.js')),
  ...(await import('./repositories/order-stock-repo.js')),
  ...(await import('./repositories/stock-movement-search.js')),
  ...(await import('./repositories/ingredient-repo.js')),
  ...(await import('./repositories/batch-recipe-repo.js')),
  ...(await import('./repositories/modifier-repo.js')),
  ...(await import('./repositories/menu-item-repo.js')),
  ...(await import('./repositories/category-repo.js')),
  ...(await import('./repositories/tax-category-repo.js')),
  ...(await import('./repositories/customer-repo.js')),
  ...(await import('./repositories/shift-repo.js')),
  ...(await import('./repositories/rider-repo.js')),
  ...(await import('./repositories/table-repo.js')),
});

// ---------------------------------------------------------------------------
// The tiny menu
// ---------------------------------------------------------------------------

/** `cost`: made-up paisa per unit, on a few ingredients only (Reports tests). */
const ING = {
  dough: { name: 'Test Dough', unit: 'g', qty: 100_000, cost: 1 },
  cheese: { name: 'Test Cheese Mix', unit: 'g', qty: 100_000, cost: 2 },
  sauce: { name: 'Test Pizza Sauce', unit: 'g', qty: 100_000, cost: 0 }, // made in-house from tomato
  tomato: { name: 'Test Tomato', unit: 'g', qty: 100_000, cost: 0 },
  chicken: { name: 'Test Chicken Fajita', unit: 'g', qty: 100_000, cost: 3 },
  onion: { name: 'Test Onion', unit: 'g', qty: 100_000, cost: 0 },
  pepper: { name: 'Test Bell Pepper', unit: 'g', qty: 100_000, cost: 0 },
  olives: { name: 'Test Olives', unit: 'g', qty: 100_000, cost: 0 },
  mushroom: { name: 'Test Mushrooms', unit: 'g', qty: 100_000, cost: 0 },
  ranch: { name: 'Test Ranch Sauce', unit: 'g', qty: 100_000, cost: 0 },
  box: { name: 'Test Pizza Box', unit: 'pcs', qty: 1_000, cost: 0 },
  cup: { name: 'Test Dip Cup', unit: 'pcs', qty: 1_000, cost: 0 },
  cola: { name: 'Test Cola 1.5 L', unit: 'pcs', qty: 100, cost: 0 }, // the Drinks shelf (guessed from "cola")
  flour: { name: 'Test Flour', unit: 'kg', qty: 50, cost: 0 }, // still counted in kg
  coffee: { name: 'Test Coffee', unit: 'g', qty: 10_000, cost: 0 }, // the Drinks shelf too, but weighed: never "sealed"
} as const;
type Ing = keyof typeof ING;
/** Amounts per ingredient; only the ones that moved. */
type Take = Partial<Record<Ing, number>>;

type Group = 'leaveOut' | 'extras' | 'sideDips' | 'veg' | 'yourDip' | 'dealPizza' | 'dealPizza2' | 'dealLeaveOut';
const GROUPS: Record<Group, { name: string; selectionType: 'single' | 'multi'; maxSelect: number }> = {
  leaveOut: { name: 'Leave out · Pizzas', selectionType: 'multi', maxSelect: 2 },
  extras: { name: 'Extra toppings', selectionType: 'multi', maxSelect: 2 },
  sideDips: { name: 'Dips on the side', selectionType: 'multi', maxSelect: 1 },
  veg: { name: 'Veggie Lovers · choose veggies', selectionType: 'multi', maxSelect: 3 },
  yourDip: { name: 'Choose your dip', selectionType: 'single', maxSelect: 1 },
  dealPizza: { name: 'Deal: pizza', selectionType: 'single', maxSelect: 1 },
  dealPizza2: { name: 'Deal: 2nd pizza', selectionType: 'single', maxSelect: 1 },
  dealLeaveOut: { name: 'Leave out · Deals', selectionType: 'multi', maxSelect: 1 },
};

type Choice =
  | 'noOnion'
  | 'noCheese'
  | 'extraCheese'
  | 'extraOnion'
  | 'sideRanch'
  | 'pickOnion'
  | 'pickPepper'
  | 'pickOlives'
  | 'pickMushroom'
  | 'freeRanch'
  | 'dealFajita'
  | 'dealVeggie'
  | 'deal2Fajita'
  | 'deal2Veggie'
  | 'dealNoOnion';
const CHOICES: Record<Choice, { group: Group; name: string; price: number; removes?: Ing }> = {
  noOnion: { group: 'leaveOut', name: 'No onion', price: 0, removes: 'onion' },
  noCheese: { group: 'leaveOut', name: 'No cheese', price: 0, removes: 'cheese' },
  extraCheese: { group: 'extras', name: 'Extra cheese', price: 15_000 },
  extraOnion: { group: 'extras', name: 'Extra onion', price: 10_000 },
  sideRanch: { group: 'sideDips', name: 'Side of Ranch', price: 10_000 },
  pickOnion: { group: 'veg', name: 'Onion', price: 0 },
  pickPepper: { group: 'veg', name: 'Bell pepper', price: 0 },
  pickOlives: { group: 'veg', name: 'Olives', price: 0 },
  pickMushroom: { group: 'veg', name: 'Mushroom', price: 0 },
  freeRanch: { group: 'yourDip', name: 'Ranch', price: 0 },
  dealFajita: { group: 'dealPizza', name: 'Large: Fajita', price: 0 },
  dealVeggie: { group: 'dealPizza', name: 'Large: Veggie', price: 0 },
  deal2Fajita: { group: 'dealPizza2', name: '2nd Large: Fajita', price: 0 },
  deal2Veggie: { group: 'dealPizza2', name: '2nd Large: Veggie', price: 0 },
  dealNoOnion: { group: 'dealLeaveOut', name: 'No onion', price: 0, removes: 'onion' },
};

type RecipeLine = [Ing, number, Choice?];
const LARGE_FAJITA: Array<[Ing, number]> = [['dough', 450], ['sauce', 80], ['cheese', 160], ['chicken', 80], ['onion', 15], ['box', 1]];
const LARGE_VEGGIE: Array<[Ing, number]> = [['dough', 450], ['sauce', 80], ['cheese', 160], ['pepper', 15], ['mushroom', 15], ['box', 1]];
const slot = (choice: Choice, lines: Array<[Ing, number]>): RecipeLine[] => lines.map(([i, q]) => [i, q, choice]);

type Item = 'fajita' | 'veggie' | 'deal' | 'dip' | 'loaf' | 'drink' | 'latte';
const ITEMS: Record<Item, { name: string; price: number; groups: Group[]; recipe: RecipeLine[] }> = {
  fajita: {
    name: 'Fajita Pizza (test)',
    price: 100_000,
    groups: ['leaveOut', 'extras', 'sideDips'],
    recipe: [
      ['dough', 300], ['sauce', 50], ['cheese', 90], ['chicken', 60], ['onion', 15], ['box', 1],
      ['cheese', 40, 'extraCheese'], ['onion', 10, 'extraOnion'],
      ['ranch', 25, 'sideRanch'], ['cup', 1, 'sideRanch'],
    ],
  },
  veggie: {
    name: 'Veggie Lovers (test)',
    price: 90_000,
    groups: ['veg', 'yourDip', 'leaveOut', 'extras'],
    recipe: [
      ['dough', 300], ['sauce', 50], ['cheese', 90], ['box', 1],
      ['onion', 10, 'pickOnion'], ['pepper', 10, 'pickPepper'], ['olives', 10, 'pickOlives'], ['mushroom', 10, 'pickMushroom'],
      ['ranch', 25, 'freeRanch'], ['cup', 1, 'freeRanch'],
      ['cheese', 40, 'extraCheese'],
    ],
  },
  deal: {
    name: 'Big Two (test)',
    price: 300_000,
    groups: ['dealPizza', 'dealPizza2', 'dealLeaveOut', 'sideDips'],
    recipe: [
      ...slot('dealFajita', LARGE_FAJITA),
      ...slot('dealVeggie', LARGE_VEGGIE),
      ...slot('deal2Fajita', LARGE_FAJITA),
      ...slot('deal2Veggie', LARGE_VEGGIE),
      ['ranch', 25, 'sideRanch'], ['cup', 1, 'sideRanch'],
    ],
  },
  dip: { name: 'Ranch Dip (test)', price: 10_000, groups: [], recipe: [['ranch', 25], ['cup', 1]] },
  loaf: { name: 'Garlic Loaf (test)', price: 50_000, groups: [], recipe: [['flour', 1], ['cheese', 50]] },
  drink: { name: 'Cola 1.5 L (test)', price: 25_000, groups: [], recipe: [['cola', 1]] },
  latte: { name: 'Cafe Latte (test)', price: 40_000, groups: [], recipe: [['coffee', 18]] },
};

/** One plain Fajita pizza, as the kitchen uses it. */
const FAJITA_ONE: Take = { dough: 300, sauce: 50, cheese: 90, chicken: 60, onion: 15, box: 1 };
/** …and what it costs at the made-up prices above: 300×1 + 90×2 + 60×3. */
const FAJITA_ONE_COST = 660;

/** An order line: item, quantity, choices picked. */
type Line = [Item, number, Choice[]?];

const minus = (t: Take): Take =>
  Object.fromEntries(Object.entries(t).map(([k, v]) => [k, -(v ?? 0)])) as Take;
const sum = (...takes: Take[]): Take => {
  const out: Take = {};
  for (const t of takes) for (const [k, v] of Object.entries(t) as Array<[Ing, number]>) out[k] = (out[k] ?? 0) + v;
  return out;
};

// ---------------------------------------------------------------------------
// The shop: menu, shift, customer, rider, and the till's calls
// ---------------------------------------------------------------------------

async function openShop() {
  const db = openMigrated();
  const user = db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, 'x', 'x', ?)`,
  );
  user.run(CASHIER.userId, 'Test Cashier', 'cashier', DEV);
  user.run(MANAGER.userId, 'Test Manager', 'manager', DEV);
  const r = await repos();

  const ing = {} as Record<Ing, string>;
  for (const k of Object.keys(ING) as Ing[]) {
    ing[k] = r.createIngredient(
      db,
      { name: ING[k].name, unit: ING[k].unit, currentQty: ING[k].qty, costPerUnitCents: ING[k].cost },
      MANAGER,
    ).id;
  }
  const idToIng = new Map((Object.keys(ing) as Ing[]).map((k) => [ing[k], k]));
  // Pizza sauce is made here: one batch = 2,500 g tomato → 2,000 g sauce.
  r.setBatchRecipe(
    db,
    { ingredientId: ing.sauce, batchYield: 2_000, batchMethod: 'Blend and simmer', lines: [{ inputIngredientId: ing.tomato, qty: 2_500 }] },
    MANAGER,
  );

  const tax = r.createTaxCategory(db, { name: 'Test tax', rateBps: 0 }, MANAGER);
  const cat = r.createCategory(db, { name: 'Test menu', displayOrder: 1, colorHex: '#aa5500' }, MANAGER);
  const group = {} as Record<Group, string>;
  for (const g of Object.keys(GROUPS) as Group[]) {
    const spec = GROUPS[g];
    group[g] = r.createModifierGroup(
      db,
      { name: spec.name, selectionType: spec.selectionType, minSelect: 0, maxSelect: spec.maxSelect, isRequired: false },
      MANAGER,
    ).id;
  }
  const choice = {} as Record<Choice, string>;
  for (const c of Object.keys(CHOICES) as Choice[]) {
    const spec = CHOICES[c];
    choice[c] = r.createModifier(
      db,
      {
        modifierGroupId: group[spec.group],
        name: spec.name,
        priceDeltaCents: spec.price,
        removesIngredientId: spec.removes ? ing[spec.removes] : null,
      },
      MANAGER,
    ).id;
  }
  const recipeLines = (lines: RecipeLine[]) =>
    lines.map(([i, qty, c]) => ({ ingredientId: ing[i], qtyPerUnit: qty, modifierId: c ? choice[c] : null }));
  const item = {} as Record<Item, string>;
  for (const k of Object.keys(ITEMS) as Item[]) {
    const spec = ITEMS[k];
    item[k] = r.createMenuItem(db, { categoryId: cat.id, name: spec.name, basePriceCents: spec.price, taxCategoryId: tax.id }, MANAGER).id;
    r.setItemModifierGroups(db, item[k], spec.groups.map((g, i) => ({ modifierGroupId: group[g], sortOrder: i })), MANAGER);
    r.setRecipeForItem(db, item[k], recipeLines(spec.recipe), MANAGER);
  }

  r.openShift(db, { openingCashCents: 0 }, MANAGER);
  const customer = r.createCustomer(db, { name: 'Test Customer', phone: '03001234567' }, CASHIER);
  const address = r.createAddress(db, { customerId: customer.id, addressLine: 'House 1, Test Street', area: 'Test Area' }, CASHIER);
  const rider = r.createRider(db, { name: 'Test Rider', phone: '03009876543' }, MANAGER);

  // ---- stock readouts ------------------------------------------------------
  const stock = (): Record<Ing, number> => {
    const out = {} as Record<Ing, number>;
    for (const k of Object.keys(ING) as Ing[]) {
      out[k] = Number((db.prepare(`SELECT current_qty AS q FROM ingredients WHERE id = ?`).get(ing[k]) as { q: number }).q);
    }
    return out;
  };
  /** How stock moved since `from`, per ingredient; only the ones that moved. */
  const change = (from: Record<Ing, number>): Take => {
    const now = stock();
    const out: Take = {};
    for (const k of Object.keys(ING) as Ing[]) if (now[k] !== from[k]) out[k] = now[k] - from[k];
    return out;
  };
  /** Net stock movements booked against one order (optionally one reason), as written. */
  const ledger = (orderId: string, reason?: StockMovementReason): Take => {
    const rows = db
      .prepare(
        `SELECT ingredient_id AS ing, SUM(delta_qty) AS net FROM stock_movements
          WHERE ref_order_id = ? AND deleted_at IS NULL ${reason ? 'AND reason = ?' : ''}
          GROUP BY ingredient_id`,
      )
      .all(...(reason ? [orderId, reason] : [orderId])) as Array<{ ing: string; net: number }>;
    const out: Take = {};
    for (const row of rows) {
      const k = idToIng.get(row.ing);
      if (k && Number(row.net) !== 0) out[k] = Number(row.net);
    }
    return out;
  };
  /** Never more back than was taken: every ingredient's net for the order is ≤ 0. */
  const expectNoOverReturn = (orderId: string) => {
    for (const v of Object.values(ledger(orderId))) expect(v).toBeLessThanOrEqual(0);
  };
  /** Settled: nothing of this order is counted as food sold any more (I1). */
  const expectSettled = (orderId: string) => expect(ledger(orderId, 'sale')).toEqual({});
  const status = (orderId: string): OrderStatus => r.findOrder(db, orderId)!.status;
  /** The order-level "who decided what" rows. */
  const stockAudits = (orderId: string) =>
    (
      db
        .prepare(
          `SELECT action, actor_user_id AS actor, before_json AS b, after_json AS a FROM audit_log
            WHERE entity_type = 'orders' AND entity_id = ? AND action IN ('stock_put_back', 'stock_to_waste')
            ORDER BY rowid`,
        )
        .all(orderId) as Array<{ action: string; actor: string; b: string; a: string }>
    ).map((x) => ({ action: x.action, actor: x.actor, before: JSON.parse(x.b), after: JSON.parse(x.a) }));
  const movementCount = (orderId: string) =>
    Number((db.prepare(`SELECT COUNT(*) AS n FROM stock_movements WHERE ref_order_id = ?`).get(orderId) as { n: number }).n);
  /** What the dialog would read. */
  const stockStatus = (orderId: string, now = Date.now()) => r.getOrderStockStatus(db, orderId, DEV, now)!;
  /** Test-only: pretend the order took its stock `minutes` ago. */
  const backdate = (orderId: string, minutes: number) =>
    db
      .prepare(`UPDATE stock_movements SET occurred_at = ? WHERE ref_order_id = ? AND reason = 'sale' AND delta_qty < 0`)
      .run(new Date(Date.now() - minutes * 60_000).toISOString(), orderId);

  // ---- the till, in the order the IPC handlers call the repositories ------
  /** orders:create (+ attachCustomer) and orders:addItem per line. */
  const ring = (mode: OrderMode, lines: Line[]): string => {
    const o = r.createOrder(db, { mode }, CASHIER);
    if (mode === 'takeaway' || mode === 'delivery') {
      r.snapshotCustomerOntoOrder(
        db,
        { orderId: o.id, customerId: customer.id, addressId: mode === 'delivery' ? address.id : null },
        CASHIER,
      );
    }
    for (const [it, quantity, picks = []] of lines) {
      r.addOrderItem(
        db,
        { orderId: o.id, menuItemId: item[it], quantity, modifierIds: picks.map((p) => choice[p]), notes: null },
        CASHIER,
      );
    }
    return o.id;
  };
  /** orders:sendToKitchen — the handler's checks, then the repository (stock leaves here). */
  const send = (orderId: string, actor = CASHIER) => {
    const snap = r.getOrderSnapshot(db, orderId);
    if (!snap) throw new Error('Order not found');
    const v = validateOrderForTender({
      mode: snap.order.mode,
      itemCount: snap.items.reduce((n, i) => n + i.quantity, 0),
      subtotalCents: snap.order.subtotalCents,
      tableId: snap.order.tableId,
      customerName: snap.customerName,
      customerPhone: snap.customerPhone,
      deliveryAddress: snap.deliveryAddress,
    });
    if (!v.ok) throw new Error(v.missing.join('; '));
    r.sendOrderToKitchen(db, orderId, actor);
  };
  /** orders:tender — pay up front (the order goes to the board as sent_to_kitchen), then stock leaves. */
  const pay = (orderId: string, method: PaymentMethod = 'cash') => {
    const total = r.findOrder(db, orderId)!.totalCents;
    r.tenderOrder(
      db,
      { orderId, payments: [{ method, amountCents: total, tenderedCents: method === 'cash' ? total : null }] },
      CASHIER,
    );
    try {
      r.decrementForOrder(db, orderId, CASHIER);
    } catch {
      // the handler logs and goes on: the sale is not affected
    }
  };
  const preparing = (orderId: string) => r.markOrderPreparing(db, orderId, CASHIER);
  const ready = (orderId: string) => r.markOrderReady(db, orderId, CASHIER);
  const dispatch = (orderId: string) => r.assignRiderToOrder(db, orderId, rider.id, CASHIER);
  /** orders:markServed / orders:markDelivered, optionally collecting the bill (then stock is "taken" again — idempotent). */
  const handOver = (orderId: string, collect = false) => {
    const o = r.findOrder(db, orderId)!;
    const payment = collect ? { method: 'cash' as const, amountCents: o.totalCents, tenderedCents: o.totalCents } : undefined;
    if (o.mode === 'delivery') r.markOrderDelivered(db, { orderId, payment }, CASHIER);
    else r.markOrderServed(db, { orderId, payment }, CASHIER);
    if (payment) {
      try {
        r.decrementForOrder(db, orderId, CASHIER);
      } catch {
        // the handler logs and goes on: the sale is not affected
      }
    }
  };
  /** orders:void — "Cancel order" with a manager's approval, and the answer to "Was the food made?". */
  const cancel = (orderId: string, foodMade?: FoodMade, more: OrderStockAnswer = {}) =>
    r.voidOrder(
      db,
      { orderId, reason: 'Test cancel', approverUserId: MANAGER.userId, ...(foodMade ? { foodMade } : {}), ...more },
      CASHIER,
    );
  /** orders:refund — full when no amount is given. */
  const refund = (orderId: string, amountCents?: number, foodMade?: FoodMade, more: OrderStockAnswer = {}) =>
    r.refundOrder(
      db,
      {
        orderId,
        reason: 'Test refund',
        approverUserId: MANAGER.userId,
        ...(amountCents !== undefined ? { amountCents } : {}),
        ...(foodMade ? { foodMade } : {}),
        ...more,
      },
      CASHIER,
    );
  /** The website bridge's import (web-orders-bridge importOne): one transaction ending in sendOrderToKitchen. */
  const importWebOrder = (fulfilment: 'delivery' | 'pickup', lines: Line[]): string =>
    db.transaction(() => {
      const pickup = fulfilment === 'pickup';
      const shell = r.createOrder(
        db,
        { mode: pickup ? 'takeaway' : 'delivery', source: 'web', notes: pickup ? '[web pick-up order]' : '[web order]' },
        BRIDGE,
      );
      const c = r.createCustomer(db, { name: 'Web Customer', phone: '03111234567' }, BRIDGE);
      const a = pickup
        ? null
        : r.createAddress(db, { customerId: c.id, label: 'Web order', addressLine: 'Flat 2, Web Road', area: 'Test Area' }, BRIDGE);
      r.snapshotCustomerOntoOrder(db, { orderId: shell.id, customerId: c.id, addressId: a ? a.id : null }, BRIDGE);
      for (const [it, quantity, picks = []] of lines) {
        r.addOrderItem(
          db,
          { orderId: shell.id, menuItemId: item[it], quantity, modifierIds: picks.map((p) => choice[p]), notes: null },
          BRIDGE,
        );
      }
      if (pickup) {
        r.applyDiscount(
          db,
          { orderId: shell.id, discountType: 'percent', value: 10, reason: 'Website pick-up 10% off', approverUserId: BRIDGE.userId },
          BRIDGE,
          // The website's own rule, as the bridge freezes it (never the till's switch).
          { rule: websiteDiscountRule() },
        );
      }
      r.sendOrderToKitchen(db, shell.id, BRIDGE);
      return shell.id;
    })();

  return {
    db,
    r,
    ing,
    item,
    choice,
    recipeLines,
    stock,
    change,
    ledger,
    expectNoOverReturn,
    expectSettled,
    status,
    stockAudits,
    movementCount,
    stockStatus,
    backdate,
    ring,
    send,
    pay,
    preparing,
    ready,
    dispatch,
    handOver,
    cancel,
    refund,
    importWebOrder,
  };
}

const live = describe.skipIf(!DatabaseSync);
const SAY = /Say whether the food was made/;
const LEFT_SHOP = /The food left the shop/;

// ---------------------------------------------------------------------------
// 1. Never reached the kitchen
// ---------------------------------------------------------------------------

live('1. a cart that never reached the kitchen', () => {
  it('discarded draft: nothing was taken, nothing moves', async () => {
    const s = await openShop();
    const start = s.stock();
    const o = s.ring('takeaway', [['fajita', 1, ['extraCheese']]]);
    s.r.discardDraft(s.db, o, CASHIER);
    expect(s.change(start)).toEqual({});
    expect(s.ledger(o)).toEqual({});
  });

  it('cancelled while still a draft (Cancel order on an open cart): nothing moves, nothing is asked', async () => {
    const s = await openShop();
    const start = s.stock();
    const o = s.ring('takeaway', [['fajita', 2]]);
    expect(s.stockStatus(o)).toMatchObject({ state: 'none', question: null, lines: [] });
    const done = s.cancel(o); // no answer needed: it holds no stock
    expect(done.stock).toBeNull();
    expect(s.status(o)).toBe('void');
    expect(s.change(start)).toEqual({});
    expect(s.ledger(o)).toEqual({});
    expect(s.stockAudits(o)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2–5. Sent, not paid, cancelled
// ---------------------------------------------------------------------------

live('2–5. sent to the kitchen, not paid, then cancelled', () => {
  it('2. cancelled before anyone started on it, "Not made": everything goes back', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.send(o);
    expect(s.change(start)).toEqual(minus(FAJITA_ONE));
    const done = s.cancel(o, 'not_made');
    expect(done.stock).toMatchObject({ outcome: 'not_made', answered: 'staff', how: 'cancelled', wasteCents: 0, skipped: 0 });
    expect(s.change(start)).toEqual({});
    expect(s.ledger(o)).toEqual({});
    // put back as positive 'sale' rows, so cost of sales nets out
    s.expectSettled(o);
    expect(s.ledger(o, 'waste')).toEqual({});
    const notes = s.db
      .prepare(`SELECT DISTINCT notes FROM stock_movements WHERE ref_order_id = ? AND delta_qty > 0`)
      .all(o) as Array<{ notes: string }>;
    expect(notes.map((n) => n.notes)).toEqual(['Cancelled, not made — put back']);
  });

  it('2b. the till never guesses: with no answer the cancel is refused and nothing changes', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    s.send(o);
    const sent = s.stock();
    const before = s.movementCount(o);
    expect(() => s.cancel(o)).toThrow(SAY);
    expect(s.status(o)).toBe('sent_to_kitchen');
    expect(s.change(sent)).toEqual({});
    expect(s.movementCount(o)).toBe(before);
    expect(s.stockAudits(o)).toEqual([]);
  });

  it('3. "Start preparing" tapped, then cancelled as "Made": stays off the shelf, booked as waste', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.send(o);
    s.preparing(o);
    expect(s.stockStatus(o).question).toEqual({ ask: 'choose', preselect: 'made', lean: 'made', hint: "'Start preparing' was tapped" });
    s.cancel(o, 'made');
    expect(s.change(start)).toEqual(minus(FAJITA_ONE));
    s.expectSettled(o);
    expect(s.ledger(o, 'waste')).toEqual(minus(FAJITA_ONE));
    s.expectNoOverReturn(o);
  });

  it('3. "Start preparing" tapped by mistake: "Not made" puts everything back', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.send(o);
    s.preparing(o);
    s.cancel(o, 'not_made');
    expect(s.change(start)).toEqual({});
    expect(s.ledger(o)).toEqual({});
  });

  it('3b. a mis-tapped "Start preparing" still cannot be undone — the question makes it harmless', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    s.send(o);
    s.preparing(o);
    // No transition goes back to "sent to kitchen" (sendOrderToKitchen only accepts open/sent).
    expect(() => s.send(o)).toThrow(/can't be marked/);
    expect(s.status(o)).toBe('preparing');
  });

  it('4. food cooked but nobody tapped "Start preparing" (still "sent"), cancelled as "Made": booked as waste', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.send(o);
    // …the pizza is made and boxed; the board still says "sent to kitchen"…
    const done = s.cancel(o, 'made');
    // Was WRONG before the question: the ingredients went back on the shelf.
    expect(done.stock).toMatchObject({ outcome: 'made', answered: 'staff', wasteCents: FAJITA_ONE_COST });
    expect(s.change(start)).toEqual(minus(FAJITA_ONE));
    s.expectSettled(o);
    expect(s.ledger(o, 'waste')).toEqual(minus(FAJITA_ONE));
  });

  it('4c. while still "sent" nothing is tapped for them; the time since sending is only a hint', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    s.send(o);
    s.backdate(o, 3);
    expect(s.stockStatus(o).question).toEqual({
      ask: 'choose',
      preselect: null,
      lean: 'not_made',
      hint: "Sent to the kitchen 3 min ago · 'Start preparing' not tapped",
    });
    s.backdate(o, 8);
    expect(s.stockStatus(o).question).toMatchObject({ preselect: null, lean: null });
    s.backdate(o, 25);
    expect(s.stockStatus(o).question).toMatchObject({ preselect: null, lean: 'made', hint: 'Sent to the kitchen 25 min ago · probably made' });
    // …and still no answer means no cancel.
    expect(() => s.cancel(o)).toThrow(SAY);
  });

  it('5. ready and never collected (unpaid pick-up / walked out), "Made": waste', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1, ['sideRanch']]]);
    const start = s.stock();
    s.send(o);
    s.preparing(o);
    s.ready(o);
    expect(s.stockStatus(o).question).toMatchObject({ ask: 'choose', preselect: 'made' });
    s.cancel(o, 'made');
    const took = sum(FAJITA_ONE, { ranch: 25, cup: 1 });
    expect(s.change(start)).toEqual(minus(took));
    s.expectSettled(o);
    expect(s.ledger(o, 'waste')).toEqual(minus(took));
  });

  it('5b. "Ready" tapped straight from "sent" (no "Start preparing"), then cancelled as "Made": waste', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.send(o);
    s.ready(o);
    s.cancel(o, 'made');
    expect(s.change(start)).toEqual(minus(FAJITA_ONE));
    expect(s.ledger(o, 'waste')).toEqual(minus(FAJITA_ONE));
  });

  it('5c. handed over and eaten but never paid (served): nothing to ask — waste; "Not made" is refused', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.send(o);
    s.ready(o);
    s.handOver(o);
    expect(s.status(o)).toBe('served');
    expect(s.stockStatus(o).question).toEqual({ ask: 'made_only', preselect: 'made', lean: 'made', hint: 'It was handed over' });
    expect(() => s.cancel(o, 'not_made')).toThrow(LEFT_SHOP);
    expect(s.status(o)).toBe('served');
    const done = s.cancel(o);
    expect(done.stock).toMatchObject({ outcome: 'made', answered: 'forced' });
    expect(s.status(o)).toBe('void');
    expect(s.change(start)).toEqual(minus(FAJITA_ONE));
    s.expectSettled(o);
    expect(s.ledger(o, 'waste')).toEqual(minus(FAJITA_ONE));
  });
});

// ---------------------------------------------------------------------------
// 6. Delivery refused
// ---------------------------------------------------------------------------

live('6. delivery refused at the door', () => {
  it('cash on delivery refused, rider brings it back, order cancelled: waste (it left the shop)', async () => {
    const s = await openShop();
    const o = s.ring('delivery', [['deal', 1, ['dealFajita', 'deal2Veggie']]]);
    const start = s.stock();
    s.send(o);
    s.preparing(o);
    s.ready(o);
    s.dispatch(o);
    expect(s.status(o)).toBe('out_for_delivery');
    expect(() => s.cancel(o, 'not_made')).toThrow(LEFT_SHOP);
    s.cancel(o);
    const deal = sum(Object.fromEntries(LARGE_FAJITA) as Take, Object.fromEntries(LARGE_VEGGIE) as Take);
    expect(s.change(start)).toEqual(minus(deal));
    s.expectSettled(o);
    expect(s.ledger(o, 'waste')).toEqual(minus(deal));
  });

  it('rider un-assigned first (back to ready), then cancelled: asked again — "Made" is waste', async () => {
    const s = await openShop();
    const o = s.ring('delivery', [['fajita', 1]]);
    const start = s.stock();
    s.send(o);
    s.dispatch(o); // straight from "sent": pre-assigned, never marked preparing
    s.r.unassignRiderFromOrder(s.db, o, CASHIER);
    expect(s.status(o)).toBe('ready');
    expect(() => s.cancel(o)).toThrow(SAY);
    s.cancel(o, 'made');
    expect(s.change(start)).toEqual(minus(FAJITA_ONE));
    expect(s.ledger(o, 'waste')).toEqual(minus(FAJITA_ONE));
  });

  it('prepaid delivery refused at the door and refunded: waste', async () => {
    const s = await openShop();
    const o = s.ring('delivery', [['fajita', 1]]);
    const start = s.stock();
    s.pay(o);
    s.dispatch(o);
    const done = s.refund(o);
    expect(done.stock).toMatchObject({ outcome: 'made', answered: 'forced', how: 'refunded' });
    expect(s.status(o)).toBe('refunded');
    expect(s.change(start)).toEqual(minus(FAJITA_ONE));
    s.expectSettled(o);
    expect(s.ledger(o, 'waste')).toEqual(minus(FAJITA_ONE));
  });

  it('a sealed drink the rider brings back goes back in the fridge; the food is waste', async () => {
    const s = await openShop();
    const o = s.ring('delivery', [['fajita', 1], ['drink', 1]]);
    const start = s.stock();
    s.send(o);
    expect(s.change(start)).toEqual(minus(sum(FAJITA_ONE, { cola: 1 })));
    s.ready(o);
    s.dispatch(o);
    expect(s.stockStatus(o).lines.find((l) => l.ingredientId === s.ing.cola)).toMatchObject({ drink: true, qty: 1 });
    const done = s.cancel(o);
    expect(done.stock).toMatchObject({ outcome: 'made', drinksBack: 1 });
    expect(s.change(start)).toEqual(minus(FAJITA_ONE));
    s.expectSettled(o);
    expect(s.ledger(o, 'waste')).toEqual(minus(FAJITA_ONE));
    const drinkNotes = s.db
      .prepare(`SELECT notes FROM stock_movements WHERE ref_order_id = ? AND ingredient_id = ? AND delta_qty > 0`)
      .all(o, s.ing.cola) as Array<{ notes: string }>;
    expect(drinkNotes.map((n) => n.notes)).toEqual(['Cancelled — sealed drink put back']);
  });

  it('…unless the manager says the drink is gone too (putBack: [])', async () => {
    const s = await openShop();
    const o = s.ring('delivery', [['fajita', 1], ['drink', 1]]);
    const start = s.stock();
    s.send(o);
    s.ready(o);
    s.dispatch(o);
    s.cancel(o, undefined, { putBack: [] });
    expect(s.change(start)).toEqual(minus(sum(FAJITA_ONE, { cola: 1 })));
    expect(s.ledger(o, 'waste')).toEqual(minus(sum(FAJITA_ONE, { cola: 1 })));
  });

  it('a handed-over drink cannot go back, and only drinks can be put back under "Made"', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1], ['drink', 1]]);
    const start = s.stock();
    s.send(o);
    s.ready(o);
    s.handOver(o); // served, unpaid
    expect(() => s.cancel(o, undefined, { putBack: [s.ing.cola] })).toThrow(/handed over/);
    // By default a handed-over drink is waste too.
    s.cancel(o);
    expect(s.change(start)).toEqual(minus(sum(FAJITA_ONE, { cola: 1 })));
    expect(s.ledger(o, 'waste')).toEqual(minus(sum(FAJITA_ONE, { cola: 1 })));

    const o2 = s.ring('takeaway', [['fajita', 1], ['drink', 1]]);
    s.send(o2);
    s.preparing(o2);
    expect(() => s.cancel(o2, 'made', { putBack: [s.ing.cheese] })).toThrow(/Only sealed drinks/);
    expect(s.status(o2)).toBe('preparing');
  });
});

live('6b. drinks under "Made": sealed in a bag, or already at the table', () => {
  it('dine-in: the drinks went to the table, so "Made" counts them as waste by default', async () => {
    const s = await openShop();
    const section = s.r.createFloorSection(s.db, { name: 'Test hall', sortOrder: 1 }, MANAGER);
    const table = s.r.createTable(s.db, { floorSectionId: section.id, label: 'T1', capacity: 4 }, MANAGER);
    const o = s.r.createOrder(s.db, { mode: 'dine_in', tableId: table.id }, CASHIER).id;
    for (const [it, quantity] of [['fajita', 1], ['drink', 2]] as const) {
      s.r.addOrderItem(s.db, { orderId: o, menuItemId: s.item[it], quantity, modifierIds: [], notes: null }, CASHIER);
    }
    const start = s.stock();
    s.send(o);
    s.ready(o);
    const done = s.cancel(o, 'made');
    // Was: both colas went back on the shelf (+2) although they were drunk.
    expect(done.stock).toMatchObject({ outcome: 'made', drinksBack: 0 });
    expect(s.change(start)).toEqual(minus(sum(FAJITA_ONE, { cola: 2 })));
    expect(s.ledger(o, 'waste')).toEqual(minus(sum(FAJITA_ONE, { cola: 2 })));
    s.expectSettled(o);
  });

  it('dine-in: one tap puts an unopened bottle back', async () => {
    const s = await openShop();
    const section = s.r.createFloorSection(s.db, { name: 'Test hall', sortOrder: 1 }, MANAGER);
    const table = s.r.createTable(s.db, { floorSectionId: section.id, label: 'T2', capacity: 2 }, MANAGER);
    const o = s.r.createOrder(s.db, { mode: 'dine_in', tableId: table.id }, CASHIER).id;
    s.r.addOrderItem(s.db, { orderId: o, menuItemId: s.item.drink, quantity: 1, modifierIds: [], notes: null }, CASHIER);
    const start = s.stock();
    s.send(o);
    s.cancel(o, 'made', { putBack: [s.ing.cola] });
    expect(s.change(start)).toEqual({});
  });

  it('coffee is on the Drinks shelf but weighed: never "back in the fridge", it is waste with the food', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['latte', 1], ['drink', 1]]);
    const start = s.stock();
    s.send(o);
    s.ready(o);
    const lines = s.stockStatus(o).lines;
    expect(lines.find((l) => l.ingredientId === s.ing.coffee)).toMatchObject({ drink: false, qty: 18 });
    expect(lines.find((l) => l.ingredientId === s.ing.cola)).toMatchObject({ drink: true });
    expect(() => s.cancel(o, 'made', { putBack: [s.ing.coffee] })).toThrow(/Only sealed drinks/);
    s.cancel(o, 'made');
    // The bottled cola (a takeaway bag) goes back; the made latte is waste.
    expect(s.change(start)).toEqual({ coffee: -18 });
    expect(s.ledger(o, 'waste')).toEqual({ coffee: -18 });
  });
});

// ---------------------------------------------------------------------------
// Cooked, then cancelled: how it is booked
// ---------------------------------------------------------------------------

live('cooked food that is cancelled: sale or waste?', () => {
  it('booked as waste against the order — never left as a "sale" of a cancelled order', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.send(o);
    s.preparing(o);
    s.cancel(o, 'made');
    expect(s.change(start)).toEqual(minus(FAJITA_ONE));
    expect(s.ledger(o, 'sale')).toEqual({});
    expect(s.ledger(o, 'waste')).toEqual(minus(FAJITA_ONE));
    const notes = s.db
      .prepare(`SELECT reason, delta_qty > 0 AS up, notes FROM stock_movements WHERE ref_order_id = ? AND ingredient_id = ? ORDER BY rowid`)
      .all(o, s.ing.cheese) as Array<{ reason: string; up: number; notes: string | null }>;
    expect(notes.map((n) => [n.reason, Number(n.up), n.notes])).toEqual([
      ['sale', 0, null],
      ['sale', 1, 'Cancelled after cooking — moved to waste'],
      ['waste', 0, 'Cancelled after cooking — counted as waste'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 7. Paid first, refunded in full
// ---------------------------------------------------------------------------

live('7. paid first, then refunded in full', () => {
  it('before cooking (still "sent to kitchen"), "Not made": everything goes back', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1, ['noOnion']]]);
    const start = s.stock();
    s.pay(o);
    expect(s.status(o)).toBe('sent_to_kitchen');
    expect(s.change(start)).toEqual(minus({ dough: 300, sauce: 50, cheese: 90, chicken: 60, box: 1 }));
    expect(() => s.cancel(o, 'not_made')).toThrow(/refunded, not voided/);
    expect(() => s.refund(o)).toThrow(SAY);
    s.refund(o, undefined, 'not_made');
    expect(s.status(o)).toBe('refunded');
    expect(s.change(start)).toEqual({});
    expect(s.ledger(o)).toEqual({});
  });

  it('after "Start preparing", "Made": waste', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.pay(o);
    s.preparing(o);
    s.refund(o, undefined, 'made');
    expect(s.change(start)).toEqual(minus(FAJITA_ONE));
    s.expectSettled(o);
    expect(s.ledger(o, 'waste')).toEqual(minus(FAJITA_ONE));
  });

  it('after it was handed over (closed as paid): nothing to ask — waste; "Not made" is refused', async () => {
    const s = await openShop();
    const o = s.ring('delivery', [['fajita', 1]]);
    const start = s.stock();
    s.pay(o);
    s.preparing(o);
    s.ready(o);
    s.dispatch(o);
    s.handOver(o);
    expect(s.status(o)).toBe('paid');
    expect(() => s.refund(o, undefined, 'not_made')).toThrow(LEFT_SHOP);
    expect(s.status(o)).toBe('paid');
    s.refund(o);
    expect(s.change(start)).toEqual(minus(FAJITA_ONE));
    s.expectSettled(o);
    expect(s.ledger(o, 'waste')).toEqual(minus(FAJITA_ONE));
  });

  it('cooked but nobody tapped "Start preparing", refunded as "Made": waste (was WRONG: it all went back)', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.pay(o);
    s.refund(o, undefined, 'made');
    expect(s.change(start)).toEqual(minus(FAJITA_ONE));
    s.expectSettled(o);
    expect(s.ledger(o, 'waste')).toEqual(minus(FAJITA_ONE));
  });

  it('…and "Not made" on the same order puts it all back', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.pay(o);
    s.refund(o, undefined, 'not_made');
    expect(s.change(start)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 8. Partial refunds
// ---------------------------------------------------------------------------

live('8. partial refunds (money only)', () => {
  it('a partial refund moves no stock and asks nothing (an answer is ignored)', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.pay(o);
    const done = s.refund(o, 20_000, 'not_made');
    expect(done.stock).toBeNull();
    expect(s.status(o)).toBe('sent_to_kitchen');
    expect(s.change(start)).toEqual(minus(FAJITA_ONE));
    expect(s.stockAudits(o)).toEqual([]);
  });

  it('partial refunds that add up to the whole bill: the last one asks — "Not made" puts it all back, once', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.pay(o);
    const total = s.r.findOrder(s.db, o)!.totalCents;
    s.refund(o, 30_000);
    // The last of the money with no answer: refused, and no money moved either.
    expect(() => s.refund(o, total - 30_000)).toThrow(SAY);
    expect(s.status(o)).toBe('sent_to_kitchen');
    const refunded = () =>
      Number((s.db.prepare(`SELECT -SUM(amount_cents) AS n FROM payments WHERE order_id = ? AND amount_cents < 0`).get(o) as { n: number }).n);
    expect(refunded()).toBe(30_000);
    s.refund(o, total - 30_000, 'not_made');
    expect(s.status(o)).toBe('refunded');
    expect(s.change(start)).toEqual({});
    s.expectNoOverReturn(o);
  });

  it('a partial refund, then "refund the rest" before cooking, "Not made": all back, once', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 2]]);
    const start = s.stock();
    s.pay(o);
    s.refund(o, 20_000);
    s.refund(o, undefined, 'not_made');
    expect(s.status(o)).toBe('refunded');
    expect(s.change(start)).toEqual({});
    s.expectNoOverReturn(o);
  });

  it('a partial refund, then "refund the rest" as "Made": the two pizzas are waste', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 2]]);
    const start = s.stock();
    s.pay(o);
    s.refund(o, 20_000);
    s.refund(o, undefined, 'made');
    const two = sum(FAJITA_ONE, FAJITA_ONE);
    expect(s.change(start)).toEqual(minus(two));
    s.expectSettled(o);
    expect(s.ledger(o, 'waste')).toEqual(minus(two));
  });

  it('a partial refund, then the rest after cooking started, "Made": waste', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.pay(o);
    s.refund(o, 20_000);
    s.preparing(o);
    s.refund(o, undefined, 'made');
    expect(s.change(start)).toEqual(minus(FAJITA_ONE));
    expect(s.ledger(o, 'waste')).toEqual(minus(FAJITA_ONE));
  });
});

// ---------------------------------------------------------------------------
// 9. Website orders
// ---------------------------------------------------------------------------

live('9. website orders', () => {
  it('imported delivery (sent to the kitchen on import), cancelled at the till before cooking, "Not made": all back', async () => {
    const s = await openShop();
    const start = s.stock();
    const o = s.importWebOrder('delivery', [['fajita', 1, ['sideRanch']], ['dip', 1]]);
    expect(s.status(o)).toBe('sent_to_kitchen');
    expect(s.change(start)).toEqual(minus(sum(FAJITA_ONE, { ranch: 50, cup: 2 })));
    s.cancel(o, 'not_made');
    expect(s.change(start)).toEqual({});
  });

  it('website pick-up never collected (ready), cancelled as "Made": waste', async () => {
    const s = await openShop();
    const start = s.stock();
    const o = s.importWebOrder('pickup', [['veggie', 1, ['pickPepper', 'pickOlives']]]);
    s.preparing(o);
    s.ready(o);
    s.cancel(o, 'made');
    const took = { dough: 300, sauce: 50, cheese: 90, box: 1, pepper: 10, olives: 10 };
    expect(s.change(start)).toEqual(minus(took));
    expect(s.ledger(o, 'waste')).toEqual(minus(took));
  });
});

// ---------------------------------------------------------------------------
// 10. Foodpanda
// ---------------------------------------------------------------------------

live('10. foodpanda order cancelled by the platform', () => {
  it('cannot be sent unpaid; paid + sent in one step; "cancel" is refused, a full refund "Not made" puts it all back', async () => {
    const s = await openShop();
    const o = s.ring('foodpanda', [['fajita', 1, ['extraCheese']]]);
    const start = s.stock();
    expect(() => s.send(o)).toThrow(/paid and sent in one step/);
    s.pay(o, 'foodpanda');
    expect(s.change(start)).toEqual(minus(sum(FAJITA_ONE, { cheese: 40 })));
    expect(() => s.cancel(o, 'not_made')).toThrow(/refunded, not voided/);
    s.refund(o, undefined, 'not_made');
    expect(s.change(start)).toEqual({});
  });

  it('cancelled by foodpanda after "Start preparing", "Made": waste', async () => {
    const s = await openShop();
    const o = s.ring('foodpanda', [['fajita', 1]]);
    const start = s.stock();
    s.pay(o, 'foodpanda');
    s.preparing(o);
    s.refund(o, undefined, 'made');
    expect(s.change(start)).toEqual(minus(FAJITA_ONE));
    expect(s.ledger(o, 'waste')).toEqual(minus(FAJITA_ONE));
  });
});

// ---------------------------------------------------------------------------
// 11. The return mirrors what was taken
// ---------------------------------------------------------------------------

const MIRROR: Array<{ name: string; lines: Line[]; takes: Take }> = [
  { name: 'plain Fajita', lines: [['fajita', 1]], takes: FAJITA_ONE },
  {
    name: '"No onion" (leave-out)',
    lines: [['fajita', 1, ['noOnion']]],
    takes: { dough: 300, sauce: 50, cheese: 90, chicken: 60, box: 1 },
  },
  {
    name: '"No onion" with a paid "Extra onion" (the paid extra is still used)',
    lines: [['fajita', 1, ['noOnion', 'extraOnion']]],
    takes: { dough: 300, sauce: 50, cheese: 90, chicken: 60, box: 1, onion: 10 },
  },
  {
    name: 'paid "Extra cheese", two of them',
    lines: [['fajita', 2, ['extraCheese']]],
    takes: { dough: 600, sauce: 100, cheese: 260, chicken: 120, onion: 30, box: 2 },
  },
  {
    name: 'paid dip on the side',
    lines: [['fajita', 1, ['sideRanch']]],
    takes: sum(FAJITA_ONE, { ranch: 25, cup: 1 }),
  },
  {
    name: 'Veggie Lovers picks + a free dip',
    lines: [['veggie', 1, ['pickOnion', 'pickPepper', 'pickOlives', 'freeRanch']]],
    takes: { dough: 300, sauce: 50, cheese: 90, box: 1, onion: 10, pepper: 10, olives: 10, ranch: 25, cup: 1 },
  },
  {
    name: 'Veggie Lovers: "No onion" also drops the onion pick',
    lines: [['veggie', 1, ['pickOnion', 'pickMushroom', 'noOnion']]],
    takes: { dough: 300, sauce: 50, cheese: 90, box: 1, mushroom: 10 },
  },
  {
    name: 'Veggie Lovers: "No cheese" with a paid "Extra cheese"',
    lines: [['veggie', 1, ['noCheese', 'extraCheese', 'pickPepper']]],
    takes: { dough: 300, sauce: 50, cheese: 40, box: 1, pepper: 10 },
  },
  {
    name: 'deal: Fajita + Veggie, the deal\'s "No onion", a dip on the side',
    lines: [['deal', 1, ['dealFajita', 'deal2Veggie', 'dealNoOnion', 'sideRanch']]],
    takes: { dough: 900, sauce: 160, cheese: 320, chicken: 80, pepper: 15, mushroom: 15, box: 2, ranch: 25, cup: 1 },
  },
  {
    name: 'deal: the same pizza in both slots, two deals',
    lines: [['deal', 2, ['dealFajita', 'deal2Fajita']]],
    takes: { dough: 1800, sauce: 320, cheese: 640, chicken: 320, onion: 60, box: 4 },
  },
  { name: 'standalone dips, three', lines: [['dip', 3]], takes: { ranch: 75, cup: 3 } },
];

live('11. the return (or the waste) mirrors exactly what was taken', () => {
  it.each(MIRROR)('$name: taken at send, all of it back on "Not made"', async ({ lines, takes }) => {
    const s = await openShop();
    const o = s.ring('takeaway', lines);
    const start = s.stock();
    s.send(o);
    expect(s.change(start)).toEqual(minus(takes));
    s.cancel(o, 'not_made');
    expect(s.change(start)).toEqual({});
    expect(s.ledger(o)).toEqual({});
  });

  it.each(MIRROR)('$name: on "Made" exactly that is waste, and the shelf count does not move', async ({ lines, takes }) => {
    const s = await openShop();
    const o = s.ring('takeaway', lines);
    s.send(o);
    s.preparing(o);
    const sent = s.stock();
    s.cancel(o, 'made');
    expect(s.change(sent)).toEqual({});
    s.expectSettled(o);
    expect(s.ledger(o, 'waste')).toEqual(minus(takes));
  });

  it('every one of those lines on one order: taken at send, all of it back on a refund "Not made"', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', MIRROR.flatMap((m) => m.lines));
    const start = s.stock();
    s.pay(o);
    expect(s.change(start)).toEqual(minus(sum(...MIRROR.map((m) => m.takes))));
    s.refund(o, undefined, 'not_made');
    expect(s.change(start)).toEqual({});
    expect(s.ledger(o)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 12. The menu changed in between
// ---------------------------------------------------------------------------

live('12. the menu changed between sending and cancelling', () => {
  it('recipe changed (more cheese, a new topping): puts back what was taken, not the new recipe', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.send(o);
    s.r.setRecipeForItem(
      s.db,
      s.item.fajita,
      s.recipeLines([['dough', 300], ['sauce', 50], ['cheese', 150], ['chicken', 60], ['olives', 20], ['box', 1]]),
      MANAGER,
    );
    s.cancel(o, 'not_made');
    expect(s.change(start)).toEqual({});
  });

  it('the menu item and a deal choice deleted: still puts back what was taken', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['deal', 1, ['dealFajita', 'deal2Fajita']]]);
    const start = s.stock();
    s.send(o);
    s.r.deleteModifier(s.db, s.choice.dealFajita, MANAGER);
    s.r.deleteMenuItem(s.db, s.item.deal, MANAGER);
    s.cancel(o, 'not_made');
    expect(s.change(start)).toEqual({});
  });

  it('an ingredient taken off the recipe and deleted: it is skipped — and now on record — the rest goes back', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['veggie', 1, ['pickOlives', 'pickPepper']]]);
    const start = s.stock();
    s.send(o);
    s.r.setRecipeForItem(
      s.db,
      s.item.veggie,
      s.recipeLines(ITEMS.veggie.recipe.filter(([i]) => i !== 'olives')),
      MANAGER,
    );
    s.r.deleteIngredient(s.db, s.ing.olives, MANAGER);
    expect(s.stockStatus(s.ring('takeaway', [])).state).toBe('none');
    expect(s.stockStatus(o).lines.find((l) => l.ingredientId === s.ing.olives)).toMatchObject({ note: 'deleted', qty: 10 });
    const done = s.cancel(o, 'not_made');
    // The deleted ingredient keeps its reduced count; nothing is written for it…
    expect(s.change(start)).toEqual({ olives: -10 });
    expect(s.ledger(o)).toEqual({ olives: -10 });
    // …but it is no longer silent: the settlement and the audit row name it.
    expect(done.stock!.skipped).toBe(1);
    expect(done.stock!.lines.find((l) => l.ingredientId === s.ing.olives)).toMatchObject({ note: 'deleted', putBack: 0 });
    const audit = s.stockAudits(o);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after.skipped).toBe(1);
    expect(audit[0]!.after.lines).toContainEqual(expect.objectContaining({ ingredientId: s.ing.olives, note: 'deleted' }));
    // Settled, with the skipped line listed — not "stock stayed out".
    expect(s.stockStatus(o).state).toBe('returned');
  });

  it('every ingredient of the order deleted: nothing to write, but it still reads as settled, not "kept"', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['drink', 2]]);
    s.send(o);
    s.r.setRecipeForItem(s.db, s.item.drink, [], MANAGER);
    s.r.deleteIngredient(s.db, s.ing.cola, MANAGER);
    const done = s.cancel(o, 'made');
    expect(done.stock).toMatchObject({ outcome: 'made', skipped: 1, wasteCents: 0 });
    expect(s.stockAudits(o).map((a) => a.action)).toEqual(['stock_to_waste']);
    const st = s.stockStatus(o);
    expect(st.state).toBe('wasted');
    expect(st.lines).toEqual([expect.objectContaining({ ingredientId: s.ing.cola, note: 'deleted', qty: 2, wasted: 0 })]);
  });
});

// ---------------------------------------------------------------------------
// 13. Never twice
// ---------------------------------------------------------------------------

live('13. nothing goes back twice', () => {
  it('cancelling twice is refused; settling again writes nothing', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.send(o);
    s.cancel(o, 'not_made');
    expect(() => s.cancel(o, 'not_made')).toThrow(/already voided/);
    const rows = s.movementCount(o);
    for (const foodMade of ['not_made', 'made'] as const) {
      expect(
        s.r.settleOrderStock(s.db, { orderId: o, how: 'cancelled', statusBefore: 'sent_to_kitchen', foodMade, approverUserId: null }, CASHIER),
      ).toBeNull();
    }
    expect(s.movementCount(o)).toBe(rows);
    expect(s.stockAudits(o)).toHaveLength(1);
    expect(s.change(start)).toEqual({});
    s.expectNoOverReturn(o);
  });

  it('a refund after a cancel is refused', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.send(o);
    s.cancel(o, 'not_made');
    expect(() => s.refund(o, undefined, 'not_made')).toThrow(/voided/);
    expect(s.change(start)).toEqual({});
  });

  it('a second full refund is refused', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.pay(o);
    s.refund(o, undefined, 'not_made');
    expect(() => s.refund(o, undefined, 'not_made')).toThrow(/already fully refunded/);
    expect(s.change(start)).toEqual({});
    s.expectNoOverReturn(o);
  });

  it('a cancelled order cannot be sent again, and the stock is never taken again', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.send(o);
    s.cancel(o, 'not_made');
    expect(() => s.send(o)).toThrow();
    // decrementForOrder is guarded by "any movement for this order exists"
    expect(s.r.decrementForOrder(s.db, o, CASHIER)).toEqual([]);
    expect(s.change(start)).toEqual({});
  });

  it('paying at hand-over after sending does not take the stock a second time', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.send(o);
    s.ready(o);
    s.handOver(o, true);
    expect(s.status(o)).toBe('paid');
    expect(s.change(start)).toEqual(minus(FAJITA_ONE));
  });

  it('the dialog saw "sent", the kitchen tapped "Start preparing" meanwhile: refused, check again', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    s.send(o);
    const sent = s.stock();
    s.preparing(o);
    expect(() => s.cancel(o, 'not_made', { expectStatus: 'sent_to_kitchen' })).toThrow(/now being cooked — close this and check again/);
    expect(s.status(o)).toBe('preparing');
    expect(s.change(sent)).toEqual({});
    s.cancel(o, 'made', { expectStatus: 'preparing' });
    expect(s.status(o)).toBe('void');
  });
});

// ---------------------------------------------------------------------------
// 14. Editing after sending
// ---------------------------------------------------------------------------

live('14. items cannot change after sending', () => {
  it('add, remove, quantity, choices and discount are all refused — stock stays as sent', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 2]]);
    const start = s.stock();
    s.send(o);
    const lineId = s.r.getOrderSnapshot(s.db, o)!.items[0]!.id;
    expect(() =>
      s.r.addOrderItem(s.db, { orderId: o, menuItemId: s.item.dip, quantity: 1, modifierIds: [] }, CASHIER),
    ).toThrow(/can't be added/);
    expect(() => s.r.removeOrderItem(s.db, o, lineId, CASHIER)).toThrow(/can't be removed/);
    expect(() => s.r.updateOrderItemQuantity(s.db, o, lineId, 1, CASHIER)).toThrow(/can't be changed/);
    expect(() =>
      s.r.updateOrderItemOptions(s.db, { orderId: o, orderItemId: lineId, modifierIds: [s.choice.noOnion], notes: null }, CASHIER),
    ).toThrow(/can't be changed/);
    expect(s.change(start)).toEqual(minus({ dough: 600, sauce: 100, cheese: 180, chicken: 120, onion: 30, box: 2 }));
  });
});

// ---------------------------------------------------------------------------
// 15. Batches and units in between
// ---------------------------------------------------------------------------

live('15. made-in-house batches and unit changes in between', () => {
  it('a batch of sauce made in between: the sauce goes back, the tomatoes stay used by the batch', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.send(o);
    s.r.makeBatch(s.db, { ingredientId: s.ing.sauce, batches: 1 }, MANAGER);
    s.cancel(o, 'not_made');
    expect(s.change(start)).toEqual({ sauce: 2_000, tomato: -2_500 });
  });

  it('flour switched from kg to g in between, "Not made": 2,000 g goes back (was WRONG: 2 g)', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['loaf', 2]]);
    const start = s.stock();
    s.send(o);
    expect(s.change(start)).toEqual({ flour: -2, cheese: -100 });
    expect(s.stockStatus(o).lines.find((l) => l.ingredientId === s.ing.flour)).toMatchObject({ qty: 2, unit: 'kg' });
    s.r.convertIngredientToBaseUnit(s.db, s.ing.flour, MANAGER);
    expect(s.stock().flour).toBe(48_000);
    expect(s.stockStatus(o).lines.find((l) => l.ingredientId === s.ing.flour)).toMatchObject({ qty: 2_000, unit: 'g', note: null });
    s.cancel(o, 'not_made');
    expect(s.stock().flour).toBe(50_000);
    expect(s.stock().cheese).toBe(start.cheese);
  });

  it('flour switched from kg to g in between, "Made": 2,000 g of waste, the count stays', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['loaf', 2]]);
    s.send(o);
    s.r.convertIngredientToBaseUnit(s.db, s.ing.flour, MANAGER);
    const done = s.cancel(o, 'made');
    expect(s.stock().flour).toBe(48_000);
    expect(done.stock!.lines.find((l) => l.ingredientId === s.ing.flour)).toMatchObject({ wasted: 2_000, unit: 'g' });
    expect(s.ledger(s.r.findOrder(s.db, o)!.id, 'waste').flour).toBe(-2_000);
    const status = s.stockStatus(o);
    expect(status.state).toBe('wasted');
    expect(status.lines.find((l) => l.ingredientId === s.ing.flour)).toMatchObject({ wasted: 2_000, putBack: 0, qty: 2_000 });
  });
});

live('15c. rows already in the till when 0029 arrives get the unit they were written in', () => {
  it('before a Convert on this till: the old unit (from the Convert\'s audit row); otherwise the unit now', () => {
    const raw = new DatabaseSync!(':memory:');
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    const at = files.indexOf('0029_stock_movement_unit.sql');
    expect(at).toBeGreaterThan(0);
    for (const f of files.slice(0, at)) raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
    const T = (h: number) => `2026-09-20T${String(h).padStart(2, '0')}:00:00.000Z`;
    raw.exec(`INSERT INTO ingredients (id, name, unit, current_qty, created_at, updated_at, device_id)
              VALUES ('flour', 'Flour', 'g', 48000, '${T(1)}', '${T(1)}', 'till-1'),
                     ('cheese', 'Cheese', 'g', 9000, '${T(1)}', '${T(1)}', 'till-1')`);
    const mv = raw.prepare(
      `INSERT INTO stock_movements (id, ingredient_id, delta_qty, reason, occurred_at, resulting_qty, created_at, updated_at, device_id)
       VALUES (?, ?, ?, 'sale', ?, 0, ?, ?, 'till-1')`,
    );
    mv.run('m1', 'flour', -2, T(2), T(2), T(2)); // while flour was in kg
    mv.run('m2', 'cheese', -90, T(2), T(2), T(2));
    // Convert at 03:00 (its audit row says it was kg before)…
    raw
      .prepare(
        `INSERT INTO audit_log (id, entity_type, entity_id, action, actor_user_id, before_json, after_json, created_at)
         VALUES ('a1', 'ingredients', 'flour', 'convert_unit', NULL, ?, ?, ?)`,
      )
      .run(JSON.stringify({ unit: 'kg', currentQty: 48 }), JSON.stringify({ unit: 'g', currentQty: 48000 }), T(3));
    mv.run('m3', 'flour', -500, T(4), T(4), T(4)); // …and after it, in grams
    raw.exec(readFileSync(join(MIGRATIONS, files[at]!), 'utf8'));
    const units = raw.prepare(`SELECT id, unit FROM stock_movements ORDER BY id`).all() as Array<{ id: string; unit: string }>;
    expect(units.map((u) => [u.id, u.unit])).toEqual([
      ['m1', 'kg'],
      ['m2', 'g'],
      ['m3', 'g'],
    ]);
  });

  it('on the till that did NOT run the Convert (no audit row there): read from the counts the rows left', () => {
    const raw = new DatabaseSync!(':memory:');
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    const at = files.indexOf('0029_stock_movement_unit.sql');
    for (const f of files.slice(0, at)) raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
    const T = (h: number) => `2026-09-20T${String(h).padStart(2, '0')}:00:00.000Z`;
    // This is till 2. Till 1 converted flour and sugar kg → g at 03:00; till 2's
    // counts were rescaled when that arrived (×1000), and no audit row says so here.
    raw
      .prepare(`INSERT INTO device_info (id, device_id, display_name, registered_at) VALUES ('singleton', 'till-2', 'Test till 2', ?)`)
      .run(T(0));
    raw.exec(`INSERT INTO ingredients (id, name, unit, current_qty, created_at, updated_at, device_id)
              VALUES ('flour', 'Flour', 'g', 47500, '${T(1)}', '${T(1)}', 'till-1'),
                     ('sugar', 'Sugar', 'g', 9000, '${T(1)}', '${T(1)}', 'till-1'),
                     ('cheese', 'Cheese', 'g', 9820, '${T(1)}', '${T(1)}', 'till-1'),
                     ('box', 'Box', 'pcs', 98, '${T(1)}', '${T(1)}', 'till-1')`);
    const mv = raw.prepare(
      `INSERT INTO stock_movements (id, ingredient_id, delta_qty, reason, occurred_at, resulting_qty, created_at, updated_at, device_id)
       VALUES (?, ?, ?, 'sale', ?, ?, ?, ?, ?)`,
    );
    const row = (id: string, ing: string, delta: number, left: number, h: number, dev: string) => mv.run(id, ing, delta, T(h), left, T(h), T(h), dev);
    // Flour: till 2 took 2 kg (48 left), then, after the Convert arrived, 500 g.
    row('f1', 'flour', -2, 48, 2, 'till-2');
    row('f3', 'flour', -500, 47_500, 4, 'till-2');
    // …and till 1's own rows, synced here: 1 kg before its Convert, 300 g after.
    row('f2', 'flour', -1, 49, 2, 'till-1');
    row('f4', 'flour', -300, 48_700, 5, 'till-1');
    // Sugar: till 2 took 1 kg before the Convert and nothing since — its count now says so.
    row('s1', 'sugar', -1, 9, 2, 'till-2');
    // Till 1 took 1 kg of sugar before its Convert and has written nothing since:
    // nothing here can tell, so it reads as the unit now (the one case left).
    row('s2', 'sugar', -1, 19, 2, 'till-1');
    // Never converted: grams and pieces all along.
    row('c1', 'cheese', -90, 9_910, 2, 'till-2');
    row('c2', 'cheese', -90, 9_820, 4, 'till-2');
    row('b1', 'box', -2, 98, 2, 'till-2');
    raw.exec(readFileSync(join(MIGRATIONS, files[at]!), 'utf8'));
    const units = Object.fromEntries(
      (raw.prepare(`SELECT id, unit FROM stock_movements`).all() as Array<{ id: string; unit: string }>).map((u) => [u.id, u.unit]),
    );
    // Was: f1, f2 and s1 stamped 'g' — 2 kg read back as 2 g on this till.
    expect(units).toEqual({ f1: 'kg', f3: 'g', f2: 'kg', f4: 'g', s1: 'kg', s2: 'g', c1: 'g', c2: 'g', b1: 'pcs' });
    // No scratch tables left behind.
    expect(raw.prepare(`SELECT name FROM sqlite_temp_master WHERE name LIKE '_unit_%'`).all()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Found in the code
// ---------------------------------------------------------------------------

live('found in the code', () => {
  it('a draft can no longer be moved to preparing / ready / a rider without "Send" (it skipped the stock)', async () => {
    const s = await openShop();
    const o = s.ring('delivery', [['fajita', 1]]);
    const start = s.stock();
    expect(() => s.preparing(o)).toThrow(/can't be marked/);
    expect(() => s.ready(o)).toThrow(/can't be marked/);
    expect(() => s.dispatch(o)).toThrow(/can't be marked/);
    expect(s.status(o)).toBe('open');
    expect(s.change(start)).toEqual({});
  });

  it('a stock take between sending and "Not made": the counted level is not raised a second time', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.send(o);
    // Stock take: the cheese for this pizza was still on the shelf, so the
    // count is the starting amount (the Stock take dialog sends counted − current).
    const counted = start.cheese;
    s.r.recordStockMovement(s.db, { ingredientId: s.ing.cheese, deltaQty: counted - s.stock().cheese, reason: 'count' }, MANAGER);
    expect(s.stockStatus(o).lines.find((l) => l.ingredientId === s.ing.cheese)).toMatchObject({ note: 'counted_since' });
    const done = s.cancel(o, 'not_made');
    // Was: cheese ended 90 g above the start.
    expect(s.change(start)).toEqual({});
    expect(done.stock!.lines.find((l) => l.ingredientId === s.ing.cheese)).toMatchObject({ alreadyCounted: 90, putBack: 0 });
    s.expectSettled(o);
    expect(s.ledger(o, 'count')).toEqual({ cheese: -90 });
    const notes = s.db
      .prepare(`SELECT reason, notes FROM stock_movements WHERE ref_order_id = ? AND ingredient_id = ? AND notes IS NOT NULL ORDER BY rowid`)
      .all(o, s.ing.cheese) as Array<{ reason: string; notes: string }>;
    expect(notes).toEqual([
      { reason: 'sale', notes: 'Cancelled, not made — already in the stock take' },
      { reason: 'count', notes: 'Cancelled, not made — already in the stock take' },
    ]);
    // Stock history: the cancel's 'count' row is not a stock take anyone did —
    // it sits with the order's rows, not under the "Stock takes" chip.
    const takes = s.r.searchMovements(s.db, { reason: 'count', ingredientId: s.ing.cheese });
    expect(takes.rows.map((m) => m.refOrderId)).toEqual([null]);
    const page = s.r.searchMovements(s.db, { ingredientId: s.ing.cheese });
    expect(page.reasonCounts).toEqual({ sale: 3, count: 1 });
    expect(s.r.searchMovements(s.db, { reason: 'sale', ingredientId: s.ing.cheese }).total).toBe(3);
  });

  it('Stock history shows a row in the unit it was written in, after a Convert', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['loaf', 2]]);
    s.send(o);
    s.r.convertIngredientToBaseUnit(s.db, s.ing.flour, MANAGER);
    const rows = s.r.searchMovements(s.db, { ingredientId: s.ing.flour }).rows;
    expect(rows.map((m) => [m.deltaQty, m.unit])).toEqual([[-2, 'kg']]);
  });
});

// ---------------------------------------------------------------------------
// Two tills
// ---------------------------------------------------------------------------

const TILL_2 = 'till-2';
const TILL_2_MANAGER = { userId: MANAGER.userId, deviceId: TILL_2 };

/**
 * The second till: its own database, filled the way the sync link fills it
 * (every row till 1 queued, applied by apply-remote), each till knowing its
 * own id (device_info) as it does in the shop. `push` sends what one till
 * wrote since its last push to the other, as the link does.
 */
async function openSecondTill(s: Awaited<ReturnType<typeof openShop>>) {
  const { listPendingSync, pendingToChange, markSyncedIds } = await import('./repositories/sync-repo.js');
  const { applyRemoteBatch } = await import('./repositories/apply-remote.js');
  const db2 = openMigrated();
  const user = db2.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, 'x', 'x', ?)`,
  );
  user.run(CASHIER.userId, 'Test Cashier', 'cashier', DEV);
  user.run(MANAGER.userId, 'Test Manager', 'manager', DEV);
  const iAm = (db: AppDatabase, id: string) =>
    db
      .prepare(`INSERT INTO device_info (id, device_id, display_name, registered_at) VALUES ('singleton', ?, ?, ?)`)
      .run(id, `Test ${id}`, new Date().toISOString());
  iAm(s.db, DEV);
  iAm(db2, TILL_2);
  const push = async (from: AppDatabase, fromDevice: string, to: AppDatabase) => {
    const pending = listPendingSync(from, 1_000_000);
    const changes = pending.map((p) => pendingToChange(p, fromDevice));
    const r = await applyRemoteBatch(to, changes, { pause: async () => {} });
    markSyncedIds(from, pending.map((p) => p.id));
    expect(r.waiting).toBe(0);
    return changes;
  };
  await push(s.db, DEV, db2);
  const stock2 = (): Record<Ing, number> => {
    const out = {} as Record<Ing, number>;
    for (const k of Object.keys(ING) as Ing[]) {
      out[k] = Number((db2.prepare(`SELECT current_qty AS q FROM ingredients WHERE id = ?`).get(s.ing[k]) as { q: number }).q);
    }
    return out;
  };
  const ledgerOf = (db: AppDatabase, orderId: string, reason: StockMovementReason): number =>
    Number(
      (
        db
          .prepare(`SELECT COALESCE(SUM(delta_qty), 0) AS n FROM stock_movements WHERE ref_order_id = ? AND reason = ? AND deleted_at IS NULL`)
          .get(orderId, reason) as { n: number }
      ).n,
    );
  return { db2, push, stock2, ledgerOf };
}

live('two tills: stock goes back on the till that took it', () => {
  const report = async (db: AppDatabase) =>
    (await import('../services/business-report.js')).getBusinessReport(db, {
      sinceIso: new Date(Date.now() - 3_600_000).toISOString(),
      untilIso: new Date(Date.now() + 3_600_000).toISOString(),
    });

  it('sent on till 1, cancelled on till 2 as "Not made": till 1 gets it back when the tills sync (was: lost for good)', async () => {
    const s = await openShop();
    const t2 = await openSecondTill(s);
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.send(o);
    await t2.push(s.db, DEV, t2.db2);
    const start2 = t2.stock2();

    // Till 2 sees the order hold stock — the other till's — and asks.
    const before = s.r.getOrderStockStatus(t2.db2, o, TILL_2, Date.now())!;
    expect(before).toMatchObject({ state: 'out', otherTill: true });
    expect(before.lines.every((l) => l.note === 'other_till')).toBe(true);
    const done = s.r.voidOrder(
      t2.db2,
      { orderId: o, reason: 'Test cancel', approverUserId: MANAGER.userId, foodMade: 'not_made' },
      TILL_2_MANAGER,
    );
    expect(done.stock).toMatchObject({ outcome: 'not_made', skipped: 0, returnedLines: 6 });
    expect(done.stock!.lines.find((l) => l.ingredientId === s.ing.cheese)).toMatchObject({ putBack: 0, putBackThere: 90 });
    // Till 2's own count does not move (it never had this stock)…
    expect(t2.stock2()).toEqual(start2);
    // …but the order's ledger nets to 0 there at once.
    expect(t2.ledgerOf(t2.db2, o, 'sale')).toBe(0);
    expect(s.r.getOrderStockStatus(t2.db2, o, TILL_2, Date.now())).toMatchObject({ state: 'returned', answer: 'not_made' });

    // The rows reach till 1: its count comes back.
    const changes = await t2.push(t2.db2, TILL_2, s.db);
    expect(s.change(start)).toEqual({});
    s.expectSettled(o);
    s.expectNoOverReturn(o);
    const here = s.stockStatus(o);
    // Was: "Stock — not put back (cancelled before this was asked)".
    expect(here).toMatchObject({ status: 'void', state: 'returned', answer: 'not_made', settledByName: 'Test Manager' });
    expect(here.lines.find((l) => l.ingredientId === s.ing.cheese)).toMatchObject({ putBack: 90, putBackThere: 0 });
    // Till 1's own trail says why its count moved, and who decided on which till.
    const trail = s.db
      .prepare(`SELECT after_json AS a, actor_user_id AS actor FROM audit_log WHERE action = 'put_back_by_other_till' ORDER BY rowid`)
      .all() as Array<{ a: string; actor: string }>;
    expect(trail).toHaveLength(6);
    expect(trail.map((t) => t.actor)).toEqual(Array(6).fill(MANAGER.userId));
    expect(JSON.parse(trail[0]!.a)).toMatchObject({ orderId: o, fromDeviceId: TILL_2, alreadyCounted: false });

    // Sent again ("send everything once", a retry): never twice.
    const { applyRemoteBatch } = await import('./repositories/apply-remote.js');
    await applyRemoteBatch(s.db, changes, { pause: async () => {} });
    expect(s.change(start)).toEqual({});

    // Reports on both tills: nothing of it was food sold, nothing wasted.
    expect((await report(s.db)).foodCost).toMatchObject({ costOfSalesCents: 0, wasteCents: 0 });
    expect((await report(t2.db2)).foodCost).toMatchObject({ costOfSalesCents: 0, wasteCents: 0 });
  });

  it('cancelled on till 2 as "Made": waste on both tills, no count moves on either', async () => {
    const s = await openShop();
    const t2 = await openSecondTill(s);
    const o = s.ring('takeaway', [['fajita', 1]]);
    s.send(o);
    s.preparing(o);
    const sent = s.stock();
    await t2.push(s.db, DEV, t2.db2);
    const start2 = t2.stock2();
    s.r.voidOrder(t2.db2, { orderId: o, reason: 'Test cancel', approverUserId: MANAGER.userId, foodMade: 'made' }, TILL_2_MANAGER);
    expect(t2.stock2()).toEqual(start2);
    await t2.push(t2.db2, TILL_2, s.db);
    expect(s.change(sent)).toEqual({});
    s.expectSettled(o);
    expect(s.ledger(o, 'waste')).toEqual(minus(FAJITA_ONE));
    expect(s.stockStatus(o)).toMatchObject({ state: 'wasted', answer: 'made', wasteCents: FAJITA_ONE_COST });
    for (const db of [s.db, t2.db2]) {
      expect((await report(db)).foodCost).toMatchObject({
        costOfSalesCents: 0,
        wasteCents: FAJITA_ONE_COST,
        cancelledWasteCents: FAJITA_ONE_COST,
        cancelledOrderCount: 1,
      });
    }
  });

  it('a sealed drink the rider brings back, cancelled on till 2: back in till 1\'s fridge, the food is waste', async () => {
    const s = await openShop();
    const t2 = await openSecondTill(s);
    const o = s.ring('delivery', [['fajita', 1], ['drink', 1]]);
    const start = s.stock();
    s.send(o);
    s.ready(o);
    s.dispatch(o);
    await t2.push(s.db, DEV, t2.db2);
    const done = s.r.voidOrder(t2.db2, { orderId: o, reason: 'Refused at the door', approverUserId: MANAGER.userId }, TILL_2_MANAGER);
    expect(done.stock).toMatchObject({ outcome: 'made', answered: 'forced', drinksBack: 1 });
    await t2.push(t2.db2, TILL_2, s.db);
    expect(s.change(start)).toEqual(minus(FAJITA_ONE));
    s.expectSettled(o);
  });

  it('a stock take on till 1 after sending already counted it: the cancel on till 2 does not add it again', async () => {
    const s = await openShop();
    const t2 = await openSecondTill(s);
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.send(o);
    // The cheese for this pizza was still on the shelf when counted.
    s.r.recordStockMovement(s.db, { ingredientId: s.ing.cheese, deltaQty: start.cheese - s.stock().cheese, reason: 'count' }, MANAGER);
    await t2.push(s.db, DEV, t2.db2);
    s.r.voidOrder(t2.db2, { orderId: o, reason: 'Test cancel', approverUserId: MANAGER.userId, foodMade: 'not_made' }, TILL_2_MANAGER);
    await t2.push(t2.db2, TILL_2, s.db);
    expect(s.change(start)).toEqual({});
    const counted = s.db
      .prepare(`SELECT after_json AS a FROM audit_log WHERE action = 'put_back_by_other_till' AND entity_id = ?`)
      .get(s.ing.cheese) as { a: string };
    expect(JSON.parse(counted.a)).toMatchObject({ alreadyCounted: true, delta: 0 });
  });

  it('a row from a till that does not stamp units yet gets the unit it was written in; a Convert from the other till is on record here', async () => {
    const s = await openShop();
    const t2 = await openSecondTill(s);
    const o = s.ring('takeaway', [['loaf', 2]]);
    s.send(o);
    const { listPendingSync, pendingToChange, markSyncedIds } = await import('./repositories/sync-repo.js');
    const { applyRemoteBatch } = await import('./repositories/apply-remote.js');
    // As an older till sends it: the row image has no `unit`.
    const pending = listPendingSync(s.db, 1_000_000);
    const changes = pending.map((p) => {
      const c = pendingToChange(p, DEV);
      if (c.entityType !== 'stock_movements') return c;
      const { unit: _unit, ...older } = c.payload as Record<string, unknown>;
      return { ...c, payload: older };
    });
    await applyRemoteBatch(t2.db2, changes, { pause: async () => {} });
    markSyncedIds(s.db, pending.map((p) => p.id));
    const flourRow = () =>
      t2.db2.prepare(`SELECT unit FROM stock_movements WHERE ref_order_id = ? AND ingredient_id = ?`).get(o, s.ing.flour) as {
        unit: string | null;
      };
    expect(flourRow().unit).toBe('kg');
    // Till 1 converts flour; till 2's count is rescaled when it arrives, and its trail says so.
    s.r.convertIngredientToBaseUnit(s.db, s.ing.flour, MANAGER);
    await t2.push(s.db, DEV, t2.db2);
    expect(t2.stock2().flour).toBe(50_000);
    expect(flourRow().unit).toBe('kg');
    const converted = t2.db2
      .prepare(`SELECT before_json AS b, after_json AS a FROM audit_log WHERE action = 'convert_unit' AND entity_id = ?`)
      .get(s.ing.flour) as { b: string; a: string };
    expect(JSON.parse(converted.b)).toMatchObject({ unit: 'kg', currentQty: 50 });
    expect(JSON.parse(converted.a)).toMatchObject({ unit: 'g', currentQty: 50_000, fromDeviceId: DEV });
    // So cancelling it on till 2 books 2,000 g for till 1, not 2 g.
    s.r.voidOrder(t2.db2, { orderId: o, reason: 'Test cancel', approverUserId: MANAGER.userId, foodMade: 'not_made' }, TILL_2_MANAGER);
    await t2.push(t2.db2, TILL_2, s.db);
    expect(s.stock().flour).toBe(50_000);
  });

  it('cancelled on both tills while the link was down: the stock goes back once', async () => {
    const s = await openShop();
    const t2 = await openSecondTill(s);
    const o = s.ring('takeaway', [['fajita', 1]]);
    const start = s.stock();
    s.send(o);
    await t2.push(s.db, DEV, t2.db2);
    s.cancel(o, 'not_made');
    s.r.voidOrder(t2.db2, { orderId: o, reason: 'Test cancel', approverUserId: MANAGER.userId, foodMade: 'not_made' }, TILL_2_MANAGER);
    await t2.push(t2.db2, TILL_2, s.db);
    expect(s.change(start)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// The order's stock status, the audit trail, and Reports
// ---------------------------------------------------------------------------

live('what the dialog, Order History and the audit trail see', () => {
  it('out → returned, with who did it and who approved', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    expect(s.stockStatus(o).state).toBe('none');
    s.send(o);
    const out = s.stockStatus(o);
    expect(out).toMatchObject({ state: 'out', status: 'sent_to_kitchen', otherTill: false, estCostCents: FAJITA_ONE_COST, hasCosts: true });
    expect(out.lines.map((l) => [l.name, l.qty])).toContainEqual(['Test Cheese Mix', 90]);
    expect(out.question?.ask).toBe('choose');
    s.cancel(o, 'not_made');
    const back = s.stockStatus(o);
    expect(back).toMatchObject({
      state: 'returned',
      status: 'void',
      question: null,
      settledByName: 'Test Cashier',
      approvedByName: 'Test Manager',
      wasteCents: 0,
    });
    expect(back.settledAt).not.toBeNull();
    expect(back.lines.find((l) => l.name === 'Test Cheese Mix')).toMatchObject({ putBack: 90, wasted: 0 });
  });

  it('out → wasted, with its cost', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    s.send(o);
    s.preparing(o);
    s.cancel(o, 'made');
    expect(s.stockStatus(o)).toMatchObject({ state: 'wasted', wasteCents: FAJITA_ONE_COST });
  });

  it('"kept": cancelled by an older till, before the question existed — the stock stayed out as a sale', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    s.send(o);
    s.preparing(o);
    // What an older version's cancel left behind: the order void, its sale rows untouched.
    s.db.prepare(`UPDATE orders SET status = 'void' WHERE id = ?`).run(o);
    expect(s.stockStatus(o)).toMatchObject({ state: 'kept', question: null });
  });

  it('the kitchen ticket: only "did not print" is a hint worth showing', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    s.send(o);
    expect(s.stockStatus(o).kitchenTicket).toBe('none');
    const now = new Date().toISOString();
    s.db
      .prepare(
        `INSERT INTO print_queue (id, job_kind, order_id, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
         VALUES ('pq1', 'kitchen', ?, ?, 'pending', 1, ?, ?, ?)`,
      )
      .run(o, JSON.stringify({ kind: 'kitchen', orderId: o, reprint: false }), now, now, now);
    expect(s.stockStatus(o).kitchenTicket).toBe('not_printed');
    s.db.prepare(`UPDATE print_queue SET status = 'done' WHERE id = 'pq1'`).run();
    expect(s.stockStatus(o).kitchenTicket).toBe('printed');
  });

  it('one order-level audit row per settle says who decided what; the chain still verifies', async () => {
    const s = await openShop();
    const a = s.ring('takeaway', [['fajita', 1]]);
    s.send(a);
    s.preparing(a);
    s.cancel(a, 'not_made'); // against the hint: cooking had been marked
    const b = s.ring('delivery', [['fajita', 1]]);
    s.send(b);
    s.ready(b);
    s.dispatch(b);
    s.cancel(b); // forced

    const [ra] = s.stockAudits(a);
    expect(s.stockAudits(a)).toHaveLength(1);
    expect(ra).toMatchObject({
      action: 'stock_put_back',
      actor: CASHIER.userId,
      before: { status: 'preparing' },
      after: { outcome: 'not_made', answered: 'staff', how: 'cancelled', approverUserId: MANAGER.userId, againstHint: true },
    });
    const [rb] = s.stockAudits(b);
    expect(rb).toMatchObject({
      action: 'stock_to_waste',
      before: { status: 'out_for_delivery' },
      after: { outcome: 'made', answered: 'forced', againstHint: false, wasteCents: FAJITA_ONE_COST },
    });

    const rows = (
      s.db
        .prepare(
          `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action, actor_user_id AS actorUserId,
                  before_json AS beforeJson, after_json AS afterJson, ip, created_at AS createdAt,
                  prev_hash AS prevHash, row_hash AS rowHash
             FROM audit_log ORDER BY rowid`,
        )
        .all() as unknown as AuditChainRow[]
    ).map((r) => ({ ...r, rowid: Number(r.rowid) }));
    expect(verifyAuditChain(rows).ok).toBe(true);
  });
});

live('Reports: cancelled food is waste, on the day it was cooked', () => {
  const report = async (s: Awaited<ReturnType<typeof openShop>>, sinceIso: string, untilIso: string) =>
    (await import('../services/business-report.js')).getBusinessReport(s.db, { sinceIso, untilIso });
  const aroundNow = () => ({
    since: new Date(Date.now() - 3_600_000).toISOString(),
    until: new Date(Date.now() + 3_600_000).toISOString(),
  });

  it('a "Made" cancel shows as waste from a cancelled order, not as food used for sales', async () => {
    const s = await openShop();
    const sold = s.ring('takeaway', [['fajita', 1]]);
    s.pay(sold);
    const o = s.ring('takeaway', [['fajita', 1]]);
    s.send(o);
    s.preparing(o);
    s.cancel(o, 'made');
    const { since, until } = aroundNow();
    const r = await report(s, since, until);
    // Only the sold pizza is food sold (the cost it kept); the cancelled one is waste.
    expect(r.foodCost).toMatchObject({
      costOfSalesCents: FAJITA_ONE_COST,
      wasteCents: FAJITA_ONE_COST,
      cancelledWasteCents: FAJITA_ONE_COST,
      cancelledOrderCount: 1,
      putBackAfterCookingCount: 0,
    });
    expect(r.voids).toHaveLength(1);
    expect(r.voids[0]!.stock).toEqual({
      outcome: 'wasted',
      answer: 'made',
      wasteCents: FAJITA_ONE_COST,
      statusBefore: 'preparing',
      flagged: false,
    });
  });

  it('"Not made" after "Start preparing" is put back — and flagged for the owner', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    s.send(o);
    s.preparing(o);
    s.cancel(o, 'not_made');
    const { since, until } = aroundNow();
    const r = await report(s, since, until);
    expect(r.foodCost).toMatchObject({ costOfSalesCents: 0, wasteCents: 0, cancelledOrderCount: 0, putBackAfterCookingCount: 1 });
    expect(r.voids[0]!.stock).toEqual({ outcome: 'returned', answer: 'not_made', wasteCents: 0, statusBefore: 'preparing', flagged: true });
  });

  it('only a sealed drink, never collected (ready), cancelled as "Made": the drink goes back — no false alarm', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['drink', 2]]);
    const start = s.stock();
    s.send(o);
    s.ready(o);
    // The dialog starts on Made; the drinks default to back in the fridge (a takeaway bag, still sealed).
    const done = s.cancel(o, 'made');
    expect(done.stock).toMatchObject({ outcome: 'made', drinksBack: 1, returnedLines: 1, wastedLines: 0 });
    expect(s.change(start)).toEqual({});
    s.expectSettled(o);
    expect(s.stockStatus(o)).toMatchObject({ state: 'returned', answer: 'made' });
    const { since, until } = aroundNow();
    const r = await report(s, since, until);
    // Was: "Put back · was Ready" in amber and "1 cancelled order had stock put back after cooking was marked".
    expect(r.voids[0]!.stock).toEqual({ outcome: 'returned', answer: 'made', wasteCents: 0, statusBefore: 'ready', flagged: false });
    expect(r.foodCost).toMatchObject({ putBackAfterCookingCount: 0, cancelledOrderCount: 0, costOfSalesCents: 0, wasteCents: 0 });
  });

  it('a split cash + card order refunded in full as "Made": the waste is on one refund line only', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    const total = s.r.findOrder(s.db, o)!.totalCents;
    s.r.tenderOrder(
      s.db,
      {
        orderId: o,
        payments: [
          { method: 'cash', amountCents: 40_000, tenderedCents: 40_000 },
          { method: 'card', amountCents: total - 40_000, tenderedCents: null },
        ],
      },
      CASHIER,
    );
    s.r.decrementForOrder(s.db, o, CASHIER);
    s.preparing(o);
    s.refund(o, undefined, 'made');
    const { since, until } = aroundNow();
    const r = await report(s, since, until);
    expect(r.refunds).toHaveLength(2);
    expect(r.refunds.filter((x) => x.stock !== null)).toHaveLength(1);
    const lineWaste = r.refunds.reduce((n, x) => n + (x.stock?.wasteCents ?? 0), 0);
    expect(lineWaste).toBe(r.foodCost!.cancelledWasteCents);
    expect(lineWaste).toBe(FAJITA_ONE_COST);
  });

  it('sent on one day, refunded as "Made" on a later one: the first day shows the waste, the later day nothing', async () => {
    const s = await openShop();
    const o = s.ring('takeaway', [['fajita', 1]]);
    s.pay(o);
    // It was started, and took its stock, on 10 Jan…
    s.db.prepare(`UPDATE orders SET created_at = '2026-01-10T09:58:00.000Z' WHERE id = ?`).run(o);
    s.db
      .prepare(`UPDATE stock_movements SET occurred_at = '2026-01-10T10:00:00.000Z' WHERE ref_order_id = ?`)
      .run(o);
    // …and is refunded today, from Order History, once handed over.
    s.preparing(o);
    s.ready(o);
    s.handOver(o);
    s.refund(o);
    const day1 = await report(s, '2026-01-10T00:00:00.000Z', '2026-01-11T00:00:00.000Z');
    expect(day1.foodCost).toMatchObject({ costOfSalesCents: 0, wasteCents: FAJITA_ONE_COST, cancelledWasteCents: FAJITA_ONE_COST, cancelledOrderCount: 1 });
    // The settle rows say when the order first took stock, so a stock take between can place them.
    const settled = s.db
      .prepare(`SELECT DISTINCT ref_taken_at AS at FROM stock_movements WHERE ref_order_id = ? AND delta_qty > 0`)
      .all(o) as Array<{ at: string }>;
    expect(settled).toEqual([{ at: '2026-01-10T10:00:00.000Z' }]);
    const { since, until } = aroundNow();
    const today = await report(s, since, until);
    expect(today.foodCost).toMatchObject({ costOfSalesCents: 0, wasteCents: 0, cancelledWasteCents: 0, hasUsage: false });
  });

  it('an order from before costing, written in kg before a Convert, is estimated at the price of its take, in either unit', async () => {
    // Made-up clock steps, so no price change shares a millisecond with the take.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-27T09:00:00.000Z'));
      const s = await openShop();
      s.r.updateIngredient(s.db, { id: s.ing.flour, costPerUnitCents: 100 }, MANAGER); // Rs 1 / kg, made up
      vi.setSystemTime(new Date('2026-09-27T09:10:00.000Z'));
      const o = s.ring('takeaway', [['loaf', 2]]);
      s.pay(o); // 2 kg of flour out
      // As an order sent before costing started: no cost kept, its rows carry no value.
      s.db.prepare(`DELETE FROM order_item_costs WHERE order_id = ?`).run(o);
      s.db.prepare(`UPDATE stock_movements SET value_cents = NULL, unit_cost_mc = NULL, cost_basis = NULL WHERE ref_order_id = ?`).run(o);
      vi.setSystemTime(new Date('2026-09-27T09:20:00.000Z'));
      // Counted in grams from now on, the price kept exactly: 1,000 g for Rs 1, never 0.1 paisa a gram rounded to 0.
      s.r.convertIngredientToBaseUnit(s.db, s.ing.flour, MANAGER);
      expect(s.db.prepare(`SELECT unit, pack_size, pack_price_cents FROM ingredients WHERE id = ?`).get(s.ing.flour)).toEqual({
        unit: 'g',
        pack_size: 1000,
        pack_price_cents: 100,
      });
      vi.setSystemTime(new Date('2026-09-27T09:30:00.000Z'));
      s.r.updateIngredient(s.db, { id: s.ing.flour, packSize: 1000, packPriceCents: 500 }, MANAGER); // dearer since: Rs 5 / kg
      const { since, until } = aroundNow();
      // 2 kg at the Rs 1 / kg in force when it was taken (not today's Rs 5), plus 100 g of cheese at 2 paisa / g.
      expect((await report(s, since, until)).foodCost).toMatchObject({ estimatedOrders: 1, costOfSalesCents: 200 + 200, estimatedCostCents: 400 });
      // A till whose history began after the Convert: the first price known, kept in grams, prices the
      // kg rows — 2 kg is 2,000 g at Rs 1 per 1,000 g.
      s.db.prepare(`DELETE FROM ingredient_costs WHERE ingredient_id = ? AND unit = 'kg'`).run(s.ing.flour);
      expect((await report(s, since, until)).foodCost).toMatchObject({ estimatedOrders: 1, estimatedCostCents: 400 });
    } finally {
      vi.useRealTimers();
    }
  });
});
