import log from 'electron-log/main';
import type { AppDatabase } from './connection.js';
import { createTaxCategory } from './repositories/tax-category-repo.js';
import { createCategory } from './repositories/category-repo.js';
import { createMenuItem } from './repositories/menu-item-repo.js';
import {
  createModifierGroup,
  createModifier,
  setItemModifierGroups,
} from './repositories/modifier-repo.js';
import { createFloorSection, createTable } from './repositories/table-repo.js';
import { createIngredient, setRecipeForItem } from './repositories/ingredient-repo.js';
import { createSupplier } from './repositories/procurement-repo.js';

/**
 * Seed a realistic dev menu (Cheese O Clock — a Pakistani pizza/cafe) so the
 * cashier checkout flow has data to work with on first launch. Idempotent —
 * skips if any menu items already exist.
 */
export function ensureSeedMenu(db: AppDatabase, deviceId: string): void {
  const existing = db.prepare(`SELECT COUNT(*) AS n FROM menu_items`).get() as { n: number };
  if (existing.n > 0) {
    // Menu already seeded — but ingredients/recipes may not be (older DB before Phase 5).
    ensureSeedInventory(db, deviceId);
    return;
  }

  log.info('Seeding sample pizza menu (dev only)');
  const actor = { userId: null, deviceId };

  // Tax categories
  const standardTax = createTaxCategory(db, { name: 'Standard 16%', rateBps: 1600 }, actor);
  const beverageTax = createTaxCategory(db, { name: 'Beverages 13%', rateBps: 1300 }, actor);

  // Categories
  const catPizza = createCategory(
    db,
    { name: 'Pizza', displayOrder: 1, colorHex: '#dc2626' },
    actor,
  );
  const catSides = createCategory(
    db,
    { name: 'Sides', displayOrder: 2, colorHex: '#f59e0b' },
    actor,
  );
  const catDrinks = createCategory(
    db,
    { name: 'Drinks', displayOrder: 3, colorHex: '#2563eb' },
    actor,
  );
  const catDesserts = createCategory(
    db,
    { name: 'Desserts', displayOrder: 4, colorHex: '#db2777' },
    actor,
  );
  const catDeals = createCategory(
    db,
    { name: 'Deals', displayOrder: 5, colorHex: '#16a34a' },
    actor,
  );

  // Pizza modifier groups
  const sizeGroup = createModifierGroup(
    db,
    { name: 'Size', selectionType: 'single', minSelect: 1, maxSelect: 1, isRequired: true },
    actor,
  );
  createModifier(db, { modifierGroupId: sizeGroup.id, name: 'Small (9")', priceDeltaCents: 0, isDefault: true, sortOrder: 0 }, actor);
  createModifier(db, { modifierGroupId: sizeGroup.id, name: 'Medium (12")', priceDeltaCents: 30000, sortOrder: 1 }, actor);
  createModifier(db, { modifierGroupId: sizeGroup.id, name: 'Large (15")', priceDeltaCents: 60000, sortOrder: 2 }, actor);

  const crustGroup = createModifierGroup(
    db,
    { name: 'Crust', selectionType: 'single', minSelect: 1, maxSelect: 1, isRequired: true },
    actor,
  );
  createModifier(db, { modifierGroupId: crustGroup.id, name: 'Thin Crust', priceDeltaCents: 0, isDefault: true, sortOrder: 0 }, actor);
  createModifier(db, { modifierGroupId: crustGroup.id, name: 'Regular Crust', priceDeltaCents: 0, sortOrder: 1 }, actor);
  createModifier(db, { modifierGroupId: crustGroup.id, name: 'Stuffed Crust', priceDeltaCents: 20000, sortOrder: 2 }, actor);

  const toppingsGroup = createModifierGroup(
    db,
    { name: 'Extra Toppings', selectionType: 'multi', minSelect: 0, maxSelect: 5, isRequired: false },
    actor,
  );
  for (const [name, delta] of [
    ['Extra Cheese', 15000],
    ['Pepperoni', 18000],
    ['Mushrooms', 12000],
    ['Olives', 10000],
    ['Bell Peppers', 8000],
    ['Onions', 5000],
    ['Jalapeños', 10000],
  ] as const) {
    createModifier(
      db,
      { modifierGroupId: toppingsGroup.id, name, priceDeltaCents: delta, sortOrder: 0 },
      actor,
    );
  }

  // Sides modifier groups (just size)
  const sidesSizeGroup = createModifierGroup(
    db,
    { name: 'Side Size', selectionType: 'single', minSelect: 1, maxSelect: 1, isRequired: true },
    actor,
  );
  createModifier(db, { modifierGroupId: sidesSizeGroup.id, name: 'Regular', priceDeltaCents: 0, isDefault: true, sortOrder: 0 }, actor);
  createModifier(db, { modifierGroupId: sidesSizeGroup.id, name: 'Large', priceDeltaCents: 15000, sortOrder: 1 }, actor);

  // Track pizza items + their recipes for inventory linking later
  const pizzaItemIds: string[] = [];

  // Pizza items
  const pizzaItems = [
    { name: 'Margherita', desc: 'Tomato, mozzarella, basil', price: 79900 },
    { name: 'Pepperoni', desc: 'Classic pepperoni & mozzarella', price: 99900 },
    { name: 'Chicken Tikka', desc: 'Spiced chicken tikka, onions, peppers', price: 109900 },
    { name: 'BBQ Chicken', desc: 'BBQ sauce, chicken, onions, coriander', price: 109900 },
    { name: 'Hawaiian', desc: 'Ham, pineapple, mozzarella', price: 99900 },
    { name: 'Four Cheese', desc: 'Mozzarella, cheddar, parmesan, feta', price: 119900 },
    { name: 'Veggie Supreme', desc: 'Mushrooms, peppers, onions, olives, corn', price: 89900 },
  ];
  for (let i = 0; i < pizzaItems.length; i++) {
    const p = pizzaItems[i]!;
    const item = createMenuItem(
      db,
      {
        categoryId: catPizza.id,
        name: p.name,
        description: p.desc,
        basePriceCents: p.price,
        prepStation: 'kitchen',
        taxCategoryId: standardTax.id,
        sortOrder: i,
      },
      actor,
    );
    setItemModifierGroups(
      db,
      item.id,
      [
        { modifierGroupId: sizeGroup.id, sortOrder: 0 },
        { modifierGroupId: crustGroup.id, sortOrder: 1 },
        { modifierGroupId: toppingsGroup.id, sortOrder: 2 },
      ],
      actor,
    );
    pizzaItemIds.push(item.id);
  }

  // Sides
  const sideItems = [
    { name: 'Garlic Bread', price: 39900, station: 'kitchen' as const },
    { name: 'Cheese Sticks', price: 49900, station: 'kitchen' as const },
    { name: 'Chicken Wings (6 pc)', price: 69900, station: 'kitchen' as const },
    { name: 'French Fries', price: 29900, station: 'kitchen' as const },
  ];
  for (let i = 0; i < sideItems.length; i++) {
    const s = sideItems[i]!;
    const item = createMenuItem(
      db,
      {
        categoryId: catSides.id,
        name: s.name,
        basePriceCents: s.price,
        prepStation: s.station,
        taxCategoryId: standardTax.id,
        sortOrder: i,
      },
      actor,
    );
    setItemModifierGroups(db, item.id, [{ modifierGroupId: sidesSizeGroup.id, sortOrder: 0 }], actor);
  }

  // Drinks (no modifiers)
  const drinkItems = [
    { name: 'Coke 500ml', price: 17900 },
    { name: 'Sprite 500ml', price: 17900 },
    { name: 'Mineral Water', price: 9900 },
    { name: 'Fresh Lime', price: 22900 },
    { name: 'Iced Tea', price: 19900 },
  ];
  for (let i = 0; i < drinkItems.length; i++) {
    const d = drinkItems[i]!;
    createMenuItem(
      db,
      {
        categoryId: catDrinks.id,
        name: d.name,
        basePriceCents: d.price,
        prepStation: 'bar',
        taxCategoryId: beverageTax.id,
        sortOrder: i,
      },
      actor,
    );
  }

  // Desserts
  const dessertItems = [
    { name: 'Chocolate Lava Cake', price: 44900 },
    { name: 'Tiramisu', price: 49900 },
    { name: 'Vanilla Ice Cream', price: 24900 },
  ];
  for (let i = 0; i < dessertItems.length; i++) {
    const d = dessertItems[i]!;
    createMenuItem(
      db,
      {
        categoryId: catDesserts.id,
        name: d.name,
        basePriceCents: d.price,
        prepStation: 'cold',
        taxCategoryId: standardTax.id,
        sortOrder: i,
      },
      actor,
    );
  }

  // Deals (combo items represented as menu items at fixed price for Phase 2 —
  // proper combo structure lands in Phase 2.5)
  createMenuItem(
    db,
    {
      categoryId: catDeals.id,
      name: 'Family Deal — 2 Pizzas + 4 Drinks',
      description: '2 Large Pizzas, 4 Drinks, 1 Garlic Bread',
      basePriceCents: 299900,
      prepStation: 'kitchen',
      taxCategoryId: standardTax.id,
      sortOrder: 0,
    },
    actor,
  );
  createMenuItem(
    db,
    {
      categoryId: catDeals.id,
      name: 'Lunch Box — Pizza + Drink',
      description: 'Small Pizza + 1 Drink',
      basePriceCents: 89900,
      prepStation: 'kitchen',
      taxCategoryId: standardTax.id,
      sortOrder: 1,
    },
    actor,
  );

  // Sample floor section + tables
  const indoor = createFloorSection(db, { name: 'Indoor', sortOrder: 0 }, actor);
  for (let i = 1; i <= 8; i++) {
    createTable(db, { floorSectionId: indoor.id, label: `T-${i}`, capacity: 4 }, actor);
  }
  const patio = createFloorSection(db, { name: 'Patio', sortOrder: 1 }, actor);
  for (let i = 1; i <= 4; i++) {
    createTable(db, { floorSectionId: patio.id, label: `P-${i}`, capacity: 2 }, actor);
  }

  log.info('Seed menu inserted');

  ensureSeedInventory(db, deviceId);
}

/**
 * Idempotent inventory seed — runs even if the menu was seeded earlier (before
 * Phase 5 existed). Only inserts ingredients/recipes if none exist yet.
 */
export function ensureSeedInventory(db: AppDatabase, deviceId: string): void {
  const exists = db.prepare(`SELECT COUNT(*) AS n FROM ingredients`).get() as { n: number };
  if (exists.n > 0) return;

  log.info('Seeding sample ingredients + recipes (dev only)');
  const actor = { userId: null, deviceId };

  // Look up the Pizza category so we can wire pizza recipes regardless of whether
  // we're seeding fresh or back-filling on an existing menu.
  const pizzaCat = db
    .prepare(`SELECT id FROM categories WHERE name = 'Pizza' AND deleted_at IS NULL`)
    .get() as { id: string } | undefined;

  // Sample suppliers
  const grocers = createSupplier(
    db,
    {
      name: 'Metro Cash & Carry',
      contactPerson: 'Ahmed Khan',
      phone: '+92 51 111 222 333',
      email: 'orders@metro.pk',
      address: 'I-9 Sector, Islamabad',
    },
    actor,
  );
  const beverages = createSupplier(
    db,
    {
      name: 'Coca-Cola Beverages Pakistan',
      contactPerson: 'Sales desk',
      phone: '+92 51 222 333 444',
      address: 'F-11 Markaz, Islamabad',
    },
    actor,
  );

  // Sample ingredients (grams / ml / pieces)
  const flour = createIngredient(
    db,
    { name: 'Pizza dough', unit: 'g', currentQty: 50_000, lowThreshold: 5_000, costPerUnitCents: 12, defaultSupplierId: grocers.id },
    actor,
  );
  const cheese = createIngredient(
    db,
    { name: 'Mozzarella cheese', unit: 'g', currentQty: 20_000, lowThreshold: 3_000, costPerUnitCents: 80, defaultSupplierId: grocers.id },
    actor,
  );
  const sauce = createIngredient(
    db,
    { name: 'Pizza sauce', unit: 'g', currentQty: 15_000, lowThreshold: 2_000, costPerUnitCents: 25, defaultSupplierId: grocers.id },
    actor,
  );
  const pepperoni = createIngredient(
    db,
    { name: 'Pepperoni', unit: 'g', currentQty: 8_000, lowThreshold: 1_000, costPerUnitCents: 140, defaultSupplierId: grocers.id },
    actor,
  );
  const coke500 = createIngredient(
    db,
    { name: 'Coke 500ml bottles', unit: 'pcs', currentQty: 120, lowThreshold: 24, costPerUnitCents: 8500, defaultSupplierId: beverages.id },
    actor,
  );

  // Wire base recipes: every pizza uses dough + cheese + sauce. Pepperoni-named pizzas also use pepperoni.
  if (pizzaCat) {
    const pizzaItemRows = db
      .prepare(`SELECT id, name FROM menu_items WHERE category_id = ? AND deleted_at IS NULL`)
      .all(pizzaCat.id) as Array<{ id: string; name: string }>;

    for (const p of pizzaItemRows) {
      const baseRecipe = [
        { ingredientId: flour.id, qtyPerUnit: 150 }, // 150g dough
        { ingredientId: cheese.id, qtyPerUnit: 120 }, // 120g cheese
        { ingredientId: sauce.id, qtyPerUnit: 60 }, // 60g sauce
      ];
      if (p.name.toLowerCase().includes('pepperoni')) {
        baseRecipe.push({ ingredientId: pepperoni.id, qtyPerUnit: 40 });
      }
      setRecipeForItem(db, p.id, baseRecipe, actor);
    }
  }

  // Coke 500ml → 1 bottle per sale
  const cokeRow = db
    .prepare(`SELECT id FROM menu_items WHERE name = 'Coke 500ml' AND deleted_at IS NULL`)
    .get() as { id: string } | undefined;
  if (cokeRow) {
    setRecipeForItem(db, cokeRow.id, [{ ingredientId: coke500.id, qtyPerUnit: 1 }], actor);
  }

  log.info('Inventory seed complete');
}
