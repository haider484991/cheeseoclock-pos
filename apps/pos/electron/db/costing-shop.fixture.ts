/**
 * A tiny made-up shop for the costing tests (costing.db.test.ts,
 * costing-handlers.db.test.ts): ingredients bought in packs, a pizza sauce
 * made in-house, a sized pizza with a leave-out, a paid extra and a paid dip
 * on the side, Veggie Lovers with required veggie and dip picks, a two-pizza
 * deal with its own leave-out, a drink whose bottle has no price yet, a
 * food item with no recipe, a guessed price and a delivery charge.
 *
 * EVERY PRICE HERE IS MADE UP (costing spec D11: the repo is public; the
 * shop's real costs never enter it).
 *
 * better-sqlite3 is built for Electron's ABI, so the database is node's own
 * `node:sqlite` behind a small better-sqlite3-shaped `transaction()` shim, as
 * in the other *.db.test.ts files. Not a test file itself: it is imported by
 * them (which mock electron and electron-log first).
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppDatabase } from './connection.js';

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

export const DatabaseSync: RawDbCtor | null = (() => {
  try {
    return (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: RawDbCtor }).DatabaseSync;
  } catch {
    return null;
  }
})();

export const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** A database built from the migrations (all of them, or those before `stopBefore`), foreign keys on. */
export function openMigrated(opts: { stopBefore?: string } = {}): AppDatabase & { raw: RawDb } {
  if (!DatabaseSync) throw new Error('node:sqlite unavailable');
  const raw = new DatabaseSync(':memory:');
  for (const f of migrationFiles()) {
    if (opts.stopBefore && f >= opts.stopBefore) break;
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  raw.exec('PRAGMA foreign_keys = ON');
  let depth = 0;
  return {
    raw,
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
  } as unknown as AppDatabase & { raw: RawDb };
}

export const DEV = 'till-1';
export const MANAGER = { userId: 'u_mgr', deviceId: DEV };
export const CASHIER = { userId: 'u_cash', deviceId: DEV };
export const OWNER = { userId: 'u_admin', deviceId: DEV };

/** Made-up ingredients: unit, and a pack [size, paisa] or a per-unit price, or a kind. */
export const ING = {
  dough: { unit: 'g', pack: [1000, 9_000] }, // Rs 9 / kg
  cheese: { unit: 'g', pack: [2000, 240_000] }, // Rs 1,200 / kg
  chicken: { unit: 'g', pack: [1000, 90_000] },
  onion: { unit: 'g', pack: [1000, 15_000] },
  pepper: { unit: 'g', pack: [1000, 30_000] },
  olive: { unit: 'g', pack: [1000, 120_000] },
  mushroom: { unit: 'g', pack: [1000, 80_000] },
  corn: { unit: 'g', pack: [1000, 40_000] },
  jalapeno: { unit: 'g', pack: [1000, 60_000] },
  tomato: { unit: 'g', pack: [5000, 60_000] }, // Rs 120 / kg
  garlic: { unit: 'g', pack: [1000, 45_000] },
  sauce: { unit: 'g', kind: 'unset' }, // made here: 2,500 g tomato + 125 g garlic → 2,000 g
  ranch: { unit: 'g', pack: [1000, 70_000] },
  chili: { unit: 'g', pack: [1000, 50_000] },
  cup: { unit: 'pcs', pack: [100, 500] },
  box: { unit: 'pcs', perUnit: 4_000 },
  bottle: { unit: 'pcs', kind: 'unset' }, // the 345 ml bottles: no price yet
  breading: { unit: 'g', pack: [1000, 20_000], kind: 'estimate' },
  salt: { unit: 'g', kind: 'free' },
} as const satisfies Record<string, { unit: string; pack?: readonly [number, number]; perUnit?: number; kind?: 'unset' | 'estimate' | 'free' }>;
export type Ing = keyof typeof ING;

type Group = 'leaveOut' | 'extras' | 'sideDips' | 'veg' | 'yourDip' | 'deal1' | 'deal2' | 'dealLeaveOut';
const GROUPS: Record<Group, { name: string; selectionType: 'single' | 'multi'; minSelect: number; maxSelect: number; isRequired: boolean }> = {
  leaveOut: { name: 'Leave out · Pizzas', selectionType: 'multi', minSelect: 0, maxSelect: 2, isRequired: false },
  extras: { name: 'Extra toppings', selectionType: 'multi', minSelect: 0, maxSelect: 2, isRequired: false },
  sideDips: { name: 'Dips on the side', selectionType: 'multi', minSelect: 0, maxSelect: 1, isRequired: false },
  veg: { name: 'Choose 5 veggies · Veggie Lovers', selectionType: 'multi', minSelect: 1, maxSelect: 5, isRequired: true },
  yourDip: { name: 'Choose your dip', selectionType: 'single', minSelect: 1, maxSelect: 1, isRequired: true },
  deal1: { name: 'Deal: Large pizza', selectionType: 'single', minSelect: 1, maxSelect: 1, isRequired: true },
  deal2: { name: 'Deal: 2nd Large pizza', selectionType: 'single', minSelect: 1, maxSelect: 1, isRequired: true },
  dealLeaveOut: { name: 'Leave out · Deals', selectionType: 'multi', minSelect: 0, maxSelect: 1, isRequired: false },
};

export type Choice =
  | 'noOnion'
  | 'extraCheese'
  | 'extraOnion'
  | 'sideRanch'
  | 'pickOnion'
  | 'pickPepper'
  | 'pickOlive'
  | 'pickMushroom'
  | 'pickCorn'
  | 'pickJalapeno'
  | 'pickPepperExtra'
  | 'dipRanch'
  | 'dipChili'
  | 'd1Fajita'
  | 'd1Veggie'
  | 'd2Fajita'
  | 'd2Veggie'
  | 'dealNoOnion';
const CHOICES: Record<Choice, { group: Group; name: string; price: number; removes?: Ing }> = {
  noOnion: { group: 'leaveOut', name: 'No onion', price: 0, removes: 'onion' },
  extraCheese: { group: 'extras', name: 'Extra cheese', price: 15_000 },
  extraOnion: { group: 'extras', name: 'Extra onion', price: 5_000 },
  sideRanch: { group: 'sideDips', name: 'Side of Ranch', price: 10_000 },
  pickOnion: { group: 'veg', name: 'Onion', price: 0 },
  pickPepper: { group: 'veg', name: 'Bell pepper', price: 0 },
  pickOlive: { group: 'veg', name: 'Olives', price: 0 },
  pickMushroom: { group: 'veg', name: 'Mushroom', price: 0 },
  pickCorn: { group: 'veg', name: 'Sweet corn', price: 0 },
  pickJalapeno: { group: 'veg', name: 'Jalapeño', price: 0 },
  pickPepperExtra: { group: 'veg', name: 'Green pepper', price: 0 },
  dipRanch: { group: 'yourDip', name: 'Ranch', price: 0 },
  dipChili: { group: 'yourDip', name: 'Chili garlic', price: 0 },
  d1Fajita: { group: 'deal1', name: 'Large: Fajita', price: 0 },
  d1Veggie: { group: 'deal1', name: 'Large: Veggie', price: 0 },
  d2Fajita: { group: 'deal2', name: '2nd Large: Fajita', price: 0 },
  d2Veggie: { group: 'deal2', name: '2nd Large: Veggie', price: 0 },
  dealNoOnion: { group: 'dealLeaveOut', name: 'No onion', price: 0, removes: 'onion' },
};

type RecipeLine = [Ing, number, Choice?];
const LARGE_FAJITA: Array<[Ing, number]> = [['dough', 300], ['sauce', 80], ['cheese', 90], ['chicken', 60], ['onion', 15], ['box', 1]];
const LARGE_VEGGIE: Array<[Ing, number]> = [['dough', 300], ['sauce', 80], ['cheese', 90], ['pepper', 15], ['mushroom', 15], ['box', 1]];
const slot = (c: Choice, lines: Array<[Ing, number]>): RecipeLine[] => lines.map(([i, q]) => [i, q, c]);

export type Item = 'fajitaM' | 'veggieL' | 'deal' | 'cola' | 'bakedWings' | 'crispyWings' | 'delivery';
const CATEGORIES = { pizza: 'Pizza', deals: 'Value Deals', drinks: 'Drinks', wings: 'Wings', fees: 'Delivery Charges' } as const;
const ITEMS: Record<Item, { name: string; category: keyof typeof CATEGORIES; price: number; groups: Group[]; recipe: RecipeLine[] }> = {
  fajitaM: {
    name: 'Fajita Pizza — Medium',
    category: 'pizza',
    price: 120_000,
    groups: ['leaveOut', 'extras', 'sideDips'],
    recipe: [
      ['dough', 200], ['sauce', 50], ['cheese', 60], ['chicken', 40], ['onion', 10], ['box', 1],
      ['cheese', 40, 'extraCheese'], ['onion', 10, 'extraOnion'],
      ['ranch', 25, 'sideRanch'], ['cup', 1, 'sideRanch'],
    ],
  },
  veggieL: {
    name: 'Veggie Lovers — Large',
    category: 'pizza',
    price: 150_000,
    groups: ['veg', 'yourDip', 'leaveOut', 'extras'],
    recipe: [
      ['dough', 300], ['sauce', 80], ['cheese', 90], ['box', 1],
      ['onion', 10, 'pickOnion'], ['pepper', 10, 'pickPepper'], ['olive', 10, 'pickOlive'],
      ['mushroom', 10, 'pickMushroom'], ['corn', 10, 'pickCorn'], ['jalapeno', 10, 'pickJalapeno'], ['pepper', 12, 'pickPepperExtra'],
      ['ranch', 25, 'dipRanch'], ['cup', 1, 'dipRanch'], ['chili', 25, 'dipChili'], ['cup', 1, 'dipChili'],
      ['cheese', 40, 'extraCheese'], ['onion', 10, 'extraOnion'],
    ],
  },
  deal: {
    name: 'Big Two Deal',
    category: 'deals',
    price: 300_000,
    groups: ['deal1', 'deal2', 'dealLeaveOut', 'sideDips'],
    recipe: [
      ...slot('d1Fajita', LARGE_FAJITA),
      ...slot('d1Veggie', LARGE_VEGGIE),
      ...slot('d2Fajita', LARGE_FAJITA),
      ...slot('d2Veggie', LARGE_VEGGIE),
      ['ranch', 25, 'sideRanch'], ['cup', 1, 'sideRanch'],
    ],
  },
  cola: { name: 'Cola 345 ml', category: 'drinks', price: 15_000, groups: [], recipe: [['bottle', 1]] },
  bakedWings: { name: 'Baked Wings', category: 'wings', price: 80_000, groups: [], recipe: [] },
  crispyWings: { name: 'Crispy Wings', category: 'wings', price: 90_000, groups: [], recipe: [['chicken', 150], ['breading', 50], ['salt', 2]] },
  delivery: { name: 'Delivery Charge', category: 'fees', price: 10_000, groups: [], recipe: [] },
};

/** An order line: item, quantity, choices picked. */
export type Line = [Item, number, Choice[]?];

async function repos() {
  return {
    ...(await import('./repositories/ingredient-repo.js')),
    ...(await import('./repositories/batch-recipe-repo.js')),
    ...(await import('./repositories/modifier-repo.js')),
    ...(await import('./repositories/menu-item-repo.js')),
    ...(await import('./repositories/category-repo.js')),
    ...(await import('./repositories/tax-category-repo.js')),
    ...(await import('./repositories/order-repo.js')),
    ...(await import('./repositories/stock-movement-repo.js')),
  };
}

/** Build the shop in `db` (users included) and hand back its ids and the till's calls. */
export async function openCostingShop(db: AppDatabase) {
  const user = db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, 'x', 'x', ?)`,
  );
  user.run(CASHIER.userId, 'Test Cashier', 'cashier', DEV);
  user.run(MANAGER.userId, 'Test Manager', 'manager', DEV);
  user.run(OWNER.userId, 'Test Owner', 'admin', DEV);
  const r = await repos();

  const ing = {} as Record<Ing, string>;
  for (const k of Object.keys(ING) as Ing[]) {
    const spec = ING[k] as { unit: string; pack?: readonly [number, number]; perUnit?: number; kind?: 'unset' | 'estimate' | 'free' };
    ing[k] = r.createIngredient(
      db,
      {
        name: `Test ${k}`,
        unit: spec.unit,
        currentQty: spec.unit === 'pcs' ? 1_000 : 100_000,
        costPerUnitCents: spec.perUnit ?? 0,
        packSize: spec.pack?.[0] ?? null,
        packPriceCents: spec.pack?.[1] ?? null,
        ...(spec.kind ? { priceKind: spec.kind } : {}),
      },
      MANAGER,
    ).id;
  }
  r.setBatchRecipe(
    db,
    {
      ingredientId: ing.sauce,
      batchYield: 2_000,
      batchMethod: 'Blend and simmer',
      lines: [
        { inputIngredientId: ing.tomato, qty: 2_500 },
        { inputIngredientId: ing.garlic, qty: 125 },
      ],
    },
    MANAGER,
  );

  const tax = r.createTaxCategory(db, { name: 'Test tax', rateBps: 0 }, MANAGER);
  const cat = {} as Record<keyof typeof CATEGORIES, string>;
  (Object.keys(CATEGORIES) as Array<keyof typeof CATEGORIES>).forEach((k, i) => {
    cat[k] = r.createCategory(db, { name: CATEGORIES[k], displayOrder: i, colorHex: '#aa5500' }, MANAGER).id;
  });
  const group = {} as Record<Group, string>;
  for (const g of Object.keys(GROUPS) as Group[]) group[g] = r.createModifierGroup(db, GROUPS[g], MANAGER).id;
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
  const item = {} as Record<Item, string>;
  for (const k of Object.keys(ITEMS) as Item[]) {
    const spec = ITEMS[k];
    item[k] = r.createMenuItem(db, { categoryId: cat[spec.category], name: spec.name, basePriceCents: spec.price, taxCategoryId: tax.id }, MANAGER).id;
    r.setItemModifierGroups(db, item[k], spec.groups.map((g, i) => ({ modifierGroupId: group[g], sortOrder: i })), MANAGER);
    r.setRecipeForItem(
      db,
      item[k],
      spec.recipe.map(([i, qty, c]) => ({ ingredientId: ing[i], qtyPerUnit: qty, modifierId: c ? choice[c] : null })),
      MANAGER,
    );
  }

  /** orders:create + orders:addItem per line, as the till does. */
  const ring = (lines: Line[]): string => {
    const o = r.createOrder(db, { mode: 'takeaway' }, CASHIER);
    for (const [it, quantity, picks = []] of lines) {
      r.addOrderItem(db, { orderId: o.id, menuItemId: item[it], quantity, modifierIds: picks.map((p) => choice[p]), notes: null }, CASHIER);
    }
    return o.id;
  };
  /** Test-only: the order paid at `at` (a counted sale), as Reports counts it. */
  const markPaid = (orderId: string, at = new Date()) =>
    db.prepare(`UPDATE orders SET status = 'paid', paid_at = ?, created_at = ? WHERE id = ?`).run(at.toISOString(), at.toISOString(), orderId);
  const stockOf = (k: Ing) => Number((db.prepare(`SELECT current_qty AS q FROM ingredients WHERE id = ?`).get(ing[k]) as { q: number }).q);

  return { r, ing, cat, group, choice, item, ring, markPaid, stockOf };
}
