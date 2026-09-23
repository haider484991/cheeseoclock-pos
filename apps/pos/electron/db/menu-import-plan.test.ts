import { describe, expect, it } from 'vitest';
import { menuImportFileSchema, type MenuImportFile } from '@cheeseoclock/shared-schemas';
import { normalizeName, planMenuImport, type MenuSnapshot } from './menu-import-plan.js';

function file(partial: Partial<Record<'categories' | 'ingredients' | 'items', unknown[]>>): MenuImportFile {
  return menuImportFileSchema.parse({
    format: 'cheeseoclock-menu-import',
    version: 1,
    source: 'test',
    categories: partial.categories ?? [{ name: 'Pizza', aliases: ['Regular Pizzas'] }],
    ingredients: partial.ingredients ?? [
      { name: 'Pan Pizza Dough', unit: 'g', costPerUnitCents: 23 },
      { name: 'Pizza Box Medium', aliases: ['Pizza box medium'], unit: 'pcs', costPerUnitCents: 5300 },
    ],
    items: partial.items ?? [
      {
        name: 'Fajita Pizza — Medium',
        aliases: ['Fajita — Medium'],
        category: 'Pizza',
        priceCents: 150000,
        description: 'Smoky fajita chicken.',
        recipe: [
          { ingredient: 'Pan Pizza Dough', qty: 300 },
          { ingredient: 'Pizza Box Medium', qty: 1 },
        ],
      },
    ],
  });
}

function shop(partial: Partial<MenuSnapshot> = {}): MenuSnapshot {
  return {
    categories: [{ id: 'cat-pizza', name: 'Pizza', displayOrder: 0 }],
    items: [],
    ingredients: [],
    recipes: new Map(),
    taxCategories: [
      { id: 'tax-a', name: 'A', rateBps: 1300 },
      { id: 'tax-sindh', name: 'Sindh', rateBps: 1700 },
    ],
    ...partial,
  };
}

const item = (id: string, name: string, extra: Partial<MenuSnapshot['items'][number]> = {}) => ({
  id,
  name,
  categoryId: 'cat-pizza',
  basePriceCents: 170000,
  description: null,
  isActive: true,
  taxCategoryId: 'tax-sindh',
  ...extra,
});

describe('normalizeName', () => {
  it('ignores case, accents, spaces and dashes', () => {
    expect(normalizeName('Fajita — Medium')).toBe(normalizeName('fajita medium'));
    expect(normalizeName('Jalapeño')).toBe('jalapeno');
    expect(normalizeName('Fries & Sides')).toBe('friesandsides');
  });
});

const ing = (
  id: string,
  name: string,
  unit: string,
  costPerUnitCents: number,
  extra: Partial<MenuSnapshot['ingredients'][number]> = {},
): MenuSnapshot['ingredients'][number] => ({
  id,
  name,
  unit,
  costPerUnitCents,
  packSize: null,
  packPriceCents: null,
  notes: null,
  ...extra,
});

describe('planMenuImport', () => {
  it('updates the shop item it finds by alias: price, empty description, recipe', () => {
    const plan = planMenuImport(file({}), shop({ items: [item('fm', 'Fajita — Medium')] }));
    const row = plan.preview.items[0]!;
    expect(row.action).toBe('update');
    expect(row.existingName).toBe('Fajita — Medium');
    expect(row.changes).toContain('price Rs 1,700 → Rs 1,500');
    expect(row.changes).toContain('description added');
    expect(row.recipeChange).toBe('set');
    expect(plan.ops.items[0]).toMatchObject({
      existingId: 'fm',
      update: { basePriceCents: 150000, description: 'Smoky fajita chicken.' },
    });
    expect(plan.ops.items[0]?.recipe).toHaveLength(2);
    expect(plan.preview.summary).toMatchObject({ newItems: 0, updatedItems: 1, priceChanges: 1, recipesSet: 1, newIngredients: 2 });
  });

  it('never overwrites a description the shop already wrote', () => {
    const plan = planMenuImport(
      file({}),
      shop({ items: [item('fm', 'Fajita — Medium', { basePriceCents: 150000, description: 'Our own words' })] }),
    );
    expect(plan.preview.items[0]?.changes).not.toContain('description added');
    expect(plan.ops.items[0]?.update).toBeNull();
  });

  it('skips an item when two shop items could be it, instead of guessing', () => {
    const f = file({
      items: [{ name: 'Fries — Regular', aliases: ['Regular Fries', 'Fries (Reg)'], category: 'Pizza', priceCents: 30000 }],
    });
    const plan = planMenuImport(f, shop({ items: [item('a', 'Regular Fries'), item('b', 'Fries (Reg)')] }));
    expect(plan.preview.items[0]).toMatchObject({ action: 'skip' });
    expect(plan.preview.items[0]?.reason).toContain('Regular Fries');
    expect(plan.ops.items).toHaveLength(0);
  });

  it('skips both file items when they would land on the same shop item', () => {
    const f = file({
      items: [
        { name: 'Cheesy Star', aliases: ['Star Crust'], category: 'Pizza', priceCents: 220000 },
        { name: 'Star Special', aliases: ['Star Crust'], category: 'Pizza', priceCents: 250000 },
      ],
    });
    const plan = planMenuImport(f, shop({ items: [item('s', 'Star Crust')] }));
    expect(plan.preview.items.map((i) => i.action)).toEqual(['skip', 'skip']);
  });

  it('prefers a shop item with the exact name over one reached by alias', () => {
    const f = file({
      items: [{ name: 'Fries', aliases: ['Regular Fries'], category: 'Pizza', priceCents: 30000 }],
    });
    const plan = planMenuImport(f, shop({ items: [item('a', 'Fries'), item('b', 'Regular Fries')] }));
    expect(plan.ops.items[0]?.existingId).toBe('a');
    expect(plan.preview.untouchedItems).toEqual(['Regular Fries']);
  });

  it('leaves an ingredient counted in an unrelated unit alone, and the recipes that use it', () => {
    const plan = planMenuImport(
      file({}),
      shop({
        items: [item('fm', 'Fajita — Medium')],
        ingredients: [ing('dough', 'Pan pizza dough', 'pcs', 23000)],
      }),
    );
    expect(plan.preview.ingredients[0]).toMatchObject({ action: 'skip' });
    expect(plan.preview.items[0]?.recipeChange).toBe('skip');
    expect(plan.preview.items[0]?.reason).toContain('Pan Pizza Dough');
    expect(plan.ops.items[0]?.recipe).toBeNull();
    expect(plan.ops.ingredients.find((o) => o.existingId === 'dough')).toBeUndefined();
  });

  it('updates cost and fills empty notes, but keeps the shop name and stock', () => {
    const f = file({
      ingredients: [{ name: 'Pan Pizza Dough', aliases: ['Dough'], unit: 'grams', costPerUnitCents: 23, notes: 'Batch recipe…' }],
      items: [],
    });
    const plan = planMenuImport(
      f,
      shop({ ingredients: [ing('d', 'Dough', 'g', 20, { notes: '' })] }),
    );
    expect(plan.preview.ingredients[0]).toMatchObject({ action: 'update', existingName: 'Dough' });
    expect(plan.ops.ingredients[0]?.update).toEqual({ costPerUnitCents: 23, notes: 'Batch recipe…' });
    expect(plan.ops.ingredients[0]?.update).not.toHaveProperty('name');
  });

  it('converts an ingredient kept in kg to grams, and scales the recipe it is compared with', () => {
    const f = file({
      ingredients: [
        { name: 'Flour', unit: 'g', costPerUnitCents: 19, packSize: 10000, packPriceCents: 190000 },
      ],
      items: [{ name: 'Dough Ball', category: 'Pizza', priceCents: 100, recipe: [{ ingredient: 'Flour', qty: 1000 }] }],
    });
    const plan = planMenuImport(
      f,
      shop({
        items: [item('db', 'Dough Ball', { basePriceCents: 100, description: 'x' })],
        ingredients: [ing('fl', 'Flour', 'kg', 19000, { notes: 'n' })],
        recipes: new Map([['db', [{ ingredientId: 'fl', qtyPerUnit: 1 }]]]),
      }),
    );
    expect(plan.preview.ingredients[0]).toMatchObject({ action: 'update' });
    expect(plan.preview.ingredients[0]?.changes).toContain('counted in kg → g (stock and recipes ×1000)');
    expect(plan.preview.ingredients[0]?.changes).toContain('bought as 10,000 g for Rs 1,900');
    // Rs 190 per kg is Rs 0.19 per g — the cost itself does not change.
    expect(plan.preview.ingredients[0]?.changes.some((c) => c.startsWith('cost'))).toBe(false);
    expect(plan.ops.ingredients[0]).toMatchObject({
      convert: true,
      update: { packSize: 10000, packPriceCents: 190000 },
    });
    // 1 kg per dough ball = 1,000 g: the recipe is already right once converted.
    expect(plan.preview.items[0]).toMatchObject({ action: 'same', recipeChange: 'same' });
  });

  it('shows the per-gram cost change a new pack price brings', () => {
    const f = file({
      ingredients: [{ name: 'Ketchup', unit: 'g', costPerUnitCents: 38, packSize: 4000, packPriceCents: 150000 }],
      items: [],
    });
    const plan = planMenuImport(f, shop({ ingredients: [ing('k', 'Ketchup', 'Gram', 30, { notes: 'n' })] }));
    expect(plan.preview.ingredients[0]?.changes).toEqual([
      'bought as 4,000 Gram for Rs 1,500',
      'cost Rs 0.30 / Gram → Rs 0.375 / Gram',
    ]);
    expect(plan.ops.ingredients[0]?.convert).toBe(false);
  });

  it('reports no change when price and recipe already match', () => {
    const plan = planMenuImport(
      file({}),
      shop({
        items: [item('fm', 'Fajita Pizza — Medium', { basePriceCents: 150000, description: 'x' })],
        ingredients: [
          ing('d', 'Pan Pizza Dough', 'g', 23, { notes: 'n' }),
          ing('b', 'Pizza Box Medium', 'pcs', 5300, { notes: 'n' }),
        ],
        recipes: new Map([
          ['fm', [{ ingredientId: 'b', qtyPerUnit: 1 }, { ingredientId: 'd', qtyPerUnit: 300 }]],
        ]),
      }),
    );
    expect(plan.preview.items[0]).toMatchObject({ action: 'same', recipeChange: 'same' });
    expect(plan.ops.items).toHaveLength(0);
    expect(plan.preview.summary.updatedItems).toBe(0);
  });

  it('creates new items in the matching category with the most-used tax, and nothing else', () => {
    const f = file({
      categories: [
        { name: 'Pizza', aliases: [] },
        { name: 'Burgers', aliases: ['Burger'] },
        { name: 'Drinks', aliases: [] },
      ],
      items: [{ name: 'Classic Crispy Chicken', category: 'Burgers', priceCents: 70000 }],
    });
    const plan = planMenuImport(
      f,
      shop({
        categories: [
          { id: 'cat-pizza', name: 'Pizza', displayOrder: 0 },
          { id: 'cat-burger', name: 'Burger', displayOrder: 1 },
        ],
        items: [item('x', 'Star Crust')],
      }),
    );
    expect(plan.preview.items[0]).toMatchObject({ action: 'create', categoryName: 'Burger' });
    expect(plan.ops.taxCategoryId).toBe('tax-sindh');
    // "Drinks" has no new item to hold, so it is not created.
    expect(plan.ops.categories.some((c) => c.create)).toBe(false);
    expect(plan.preview.untouchedItems).toEqual(['Star Crust']);
  });

  it('names a new size after the size the shop already has, so the checkout groups them', () => {
    const f = file({
      items: [
        { name: 'Fajita Pizza — Medium', aliases: ['Fajita — Medium'], category: 'Pizza', priceCents: 150000 },
        { name: 'Fajita Pizza — Large', aliases: ['Fajita — Large'], category: 'Pizza', priceCents: 200000 },
        { name: 'Malai Supreme — Large', category: 'Pizza', priceCents: 200000 },
      ],
    });
    const plan = planMenuImport(f, shop({ items: [item('fm', 'Fajita — Medium')] }));
    expect(plan.ops.items.map((o) => o.create?.name ?? o.existingId)).toEqual([
      'fm',
      'Fajita — Large',
      'Malai Supreme — Large',
    ]);
    expect(plan.preview.items[1]).toMatchObject({ name: 'Fajita — Large', action: 'create' });
  });

  it('moves every file item onto the file tax rate, creating that tax category when missing', () => {
    const f = menuImportFileSchema.parse({
      ...file({}),
      tax: { name: 'Sales Tax', rateBps: 1500 },
      items: [
        { name: 'Fajita Pizza — Medium', aliases: ['Fajita — Medium'], category: 'Pizza', priceCents: 170000 },
        { name: 'Fajita Pizza — Large', category: 'Pizza', priceCents: 220000 },
      ],
    });
    const plan = planMenuImport(f, shop({ items: [item('fm', 'Fajita — Medium'), item('d', 'Drink')] }));
    expect(plan.ops.createTaxCategory).toEqual({ name: 'Sales Tax', rateBps: 1500 });
    expect(plan.preview).toMatchObject({ taxCategoryName: 'Sales Tax (15%)', taxCategoryIsNew: true });
    expect(plan.preview.items[0]?.changes).toEqual(['tax 17% → 15%']);
    expect(plan.ops.items[0]?.update).toEqual({ useImportTax: true });
    expect(plan.preview.summary.taxChanges).toBe(1);
    // "Drink" is not in the file: its tax is left alone.
    expect(plan.ops.items.some((o) => o.existingId === 'd')).toBe(false);
  });

  it('reuses a tax category already at the file rate and leaves items on it alone', () => {
    const f = menuImportFileSchema.parse({
      ...file({}),
      tax: { name: 'Sales Tax', rateBps: 1700 },
      items: [{ name: 'Fajita — Medium', category: 'Pizza', priceCents: 170000 }],
    });
    const plan = planMenuImport(f, shop({ items: [item('fm', 'Fajita — Medium')] }));
    expect(plan.ops.createTaxCategory).toBeNull();
    expect(plan.ops.taxCategoryId).toBe('tax-sindh');
    expect(plan.preview.items[0]?.action).toBe('same');
  });

  it('cannot create items without a tax category, and says so', () => {
    const plan = planMenuImport(file({}), shop({ taxCategories: [] }));
    expect(plan.preview.items[0]).toMatchObject({ action: 'skip' });
    expect(plan.preview.warnings[0]).toContain('tax category');
  });
});

describe('menuImportFileSchema', () => {
  it('rejects fractional recipe quantities and unknown ingredients', () => {
    const base = {
      format: 'cheeseoclock-menu-import',
      version: 1,
      categories: [{ name: 'Pizza' }],
      ingredients: [{ name: 'Cheetos Crumb', unit: 'g', costPerUnitCents: 130 }],
    };
    const fractional = menuImportFileSchema.safeParse({
      ...base,
      items: [{ name: 'Cheetos', category: 'Pizza', priceCents: 1, recipe: [{ ingredient: 'Cheetos Crumb', qty: 11.5 }] }],
    });
    expect(fractional.success).toBe(false);
    const unknown = menuImportFileSchema.safeParse({
      ...base,
      items: [{ name: 'Cheetos', category: 'Pizza', priceCents: 1, recipe: [{ ingredient: 'Cheese', qty: 10 }] }],
    });
    expect(unknown.success).toBe(false);
  });
});
