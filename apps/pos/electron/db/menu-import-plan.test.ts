import { describe, expect, it } from 'vitest';
import { menuImportFileSchema, setBatchRecipeInputSchema, type MenuImportFile } from '@cheeseoclock/shared-schemas';
import {
  countPrices,
  importedPriceKind,
  normalizeName,
  planMenuImport,
  priceSummaryLine,
  sheetPriceOf,
  type MenuSnapshot,
} from './menu-import-plan.js';

function file(partial: Partial<Record<'categories' | 'ingredients' | 'items', unknown[]>>): MenuImportFile {
  return menuImportFileSchema.parse({
    format: 'cheeseoclock-menu-import',
    version: 1,
    source: 'test',
    categories: partial.categories ?? [{ name: 'Pizza', aliases: ['Regular Pizzas'] }],
    ingredients: partial.ingredients ?? [
      { name: 'Pan Pizza Dough', unit: 'g', costPerUnitCents: 31 },
      { name: 'Pizza Box Medium', aliases: ['Pizza box medium'], unit: 'pcs', costPerUnitCents: 6000 },
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
    modifierGroups: [],
    itemGroups: new Map(),
    batchLines: new Map(),
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
  batchYield: null,
  batchMethod: null,
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

  it("keeps the till's price and fills empty notes, but keeps the shop name and stock (costing Phase 6)", () => {
    const f = file({
      ingredients: [{ name: 'Pan Pizza Dough', aliases: ['Dough'], unit: 'grams', costPerUnitCents: 31, notes: 'Batch recipe…' }],
      items: [],
    });
    const plan = planMenuImport(
      f,
      shop({ ingredients: [ing('d', 'Dough', 'g', 20, { notes: '' })] }),
    );
    expect(plan.preview.ingredients[0]).toMatchObject({ action: 'update', existingName: 'Dough', price: 'kept', sheetDiffers: true });
    // No price in the update: the till owns it. The sheet's is kept as the reference.
    expect(plan.ops.ingredients[0]?.update).toEqual({ notes: 'Batch recipe…' });
    expect(plan.ops.ingredients[0]?.sheet).toEqual({ packSize: 1, packPriceCents: 31, priceKind: 'set' });
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
        recipes: new Map([['db', [{ ingredientId: 'fl', qtyPerUnit: 1, modifierId: null }]]]),
      }),
    );
    expect(plan.preview.ingredients[0]).toMatchObject({ action: 'update' });
    expect(plan.preview.ingredients[0]?.changes).toContain('counted in kg → g (stock and recipes ×1000)');
    // The till keeps its Rs 190 / kg (the same as the sheet's, now per gram); the sheet's is noted.
    expect(plan.preview.ingredients[0]?.changes).toContain('the sheet says Rs 190 / kg (kept for reference)');
    expect(plan.preview.ingredients[0]).toMatchObject({ price: 'kept', sheetDiffers: false, tillPrice: { unitCostMc: 19_000 } });
    expect(plan.ops.ingredients[0]).toMatchObject({
      convert: true,
      update: null,
      sheet: { packSize: 10000, packPriceCents: 190000, priceKind: 'set' },
    });
    // 1 kg per dough ball = 1,000 g: the recipe is already right once converted.
    expect(plan.preview.items[0]).toMatchObject({ action: 'same', recipeChange: 'same' });
  });

  it("shows the sheet's price beside the till's, and keeps the till's (costing Phase 6)", () => {
    const f = file({
      ingredients: [{ name: 'Ketchup', unit: 'g', costPerUnitCents: 44, packSize: 5000, packPriceCents: 220000 }],
      items: [],
    });
    const plan = planMenuImport(f, shop({ ingredients: [ing('k', 'Ketchup', 'Gram', 30, { notes: 'n', priceSource: 'delivery' })] }));
    expect(plan.preview.ingredients[0]?.changes).toEqual(['the sheet says Rs 440 / kg (kept for reference)']);
    expect(plan.preview.ingredients[0]).toMatchObject({
      price: 'kept_delivery',
      sheetDiffers: true,
      sheetUnitCostMc: 44_000,
      tillPrice: { unitCostMc: 30_000, priceKind: 'set', source: 'delivery' },
    });
    expect(plan.ops.ingredients[0]?.convert).toBe(false);
    expect(plan.ops.ingredients[0]?.update).toBeNull();
  });

  it('reports no change when price and recipe already match', () => {
    const plan = planMenuImport(
      file({}),
      shop({
        items: [item('fm', 'Fajita Pizza — Medium', { basePriceCents: 150000, description: 'x' })],
        ingredients: [
          ing('d', 'Pan Pizza Dough', 'g', 31, { notes: 'n' }),
          ing('b', 'Pizza Box Medium', 'pcs', 6000, { notes: 'n' }),
        ],
        recipes: new Map([
          ['fm', [{ ingredientId: 'b', qtyPerUnit: 1, modifierId: null }, { ingredientId: 'd', qtyPerUnit: 300, modifierId: null }]],
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

describe('choices at the till', () => {
  const dips = {
    name: 'Choose your dip',
    aliases: ['Dip'],
    selectionType: 'single',
    minSelect: 1,
    maxSelect: 1,
    required: true,
    options: [{ name: 'Ranch' }, { name: 'Sriracha' }],
  };
  const withDips = (extra: Partial<Record<string, unknown>> = {}) =>
    menuImportFileSchema.parse({
      format: 'cheeseoclock-menu-import',
      version: 1,
      categories: [{ name: 'Pizza' }],
      modifierGroups: [dips],
      ingredients: [
        { name: 'Ranch Sauce', unit: 'g', costPerUnitCents: 70 },
        { name: 'Sriracha Sauce', unit: 'ml', costPerUnitCents: 110 },
        { name: 'Pan Pizza Dough', unit: 'g', costPerUnitCents: 31 },
      ],
      items: [
        {
          name: 'Nuggets',
          category: 'Pizza',
          priceCents: 67000,
          modifierGroups: ['Choose your dip'],
          recipe: [
            { ingredient: 'Pan Pizza Dough', qty: 10 },
            { ingredient: 'Ranch Sauce', qty: 25, when: 'Ranch' },
            { ingredient: 'Sriracha Sauce', qty: 25, when: 'Sriracha' },
          ],
        },
      ],
      ...extra,
    });

  it('creates the group, attaches it, and ties each dip line to its option', () => {
    const plan = planMenuImport(withDips(), shop());
    expect(plan.preview.choiceGroups[0]).toMatchObject({ name: 'Choose your dip', action: 'create' });
    expect(plan.ops.modifierGroups[0]?.options.map((o) => o.create?.name)).toEqual(['Ranch', 'Sriracha']);
    const op = plan.ops.items[0]!;
    expect(op.attach).toEqual([{ groupKey: 'choose your dip' }]);
    expect(op.recipe?.map((l) => l.modifier)).toEqual([
      null,
      { groupKey: 'choose your dip', optionKey: 'ranch' },
      { groupKey: 'choose your dip', optionKey: 'sriracha' },
    ]);
    expect(plan.preview.items[0]?.changes).toContain('asks: Choose your dip');
  });

  it('reuses a group the shop has (by alias), adds only missing options, and does not attach it twice', () => {
    const live = shop({
      items: [item('n', 'Nuggets', { basePriceCents: 67000, description: 'x' })],
      ingredients: [ing('r', 'Ranch Sauce', 'g', 70), ing('s', 'Sriracha Sauce', 'ml', 110), ing('d', 'Pan Pizza Dough', 'g', 31)],
      modifierGroups: [
        {
          id: 'g1',
          name: 'Dip',
          selectionType: 'single',
          minSelect: 1,
          maxSelect: 1,
          isRequired: true,
          modifiers: [{ id: 'm-ranch', name: 'Ranch', priceDeltaCents: 0, isDefault: false, sortOrder: 0 }],
        },
      ],
      itemGroups: new Map([['n', [{ groupId: 'g1', sortOrder: 0 }]]]),
    });
    const plan = planMenuImport(withDips(), live);
    expect(plan.preview.choiceGroups[0]).toMatchObject({ action: 'update', existingName: 'Dip', changes: ['"Sriracha" added'] });
    expect(plan.ops.items[0]?.attach).toEqual([]);
    expect(plan.ops.items[0]?.recipe?.[1]?.modifier).toEqual({ existingId: 'm-ranch' });
  });

  it('sees a recipe with the same choice lines as unchanged', () => {
    const live = shop({
      items: [item('n', 'Nuggets', { basePriceCents: 67000, description: 'x' })],
      ingredients: [ing('r', 'Ranch Sauce', 'g', 70, { notes: 'n' }), ing('s', 'Sriracha Sauce', 'ml', 110, { notes: 'n' }), ing('d', 'Pan Pizza Dough', 'g', 31, { notes: 'n' })],
      modifierGroups: [
        {
          id: 'g1', name: 'Choose your dip', selectionType: 'single', minSelect: 1, maxSelect: 1, isRequired: true,
          modifiers: [
            { id: 'm-r', name: 'Ranch', priceDeltaCents: 0, isDefault: false, sortOrder: 0 },
            { id: 'm-s', name: 'Sriracha', priceDeltaCents: 0, isDefault: false, sortOrder: 1 },
          ],
        },
      ],
      itemGroups: new Map([['n', [{ groupId: 'g1', sortOrder: 0 }]]]),
      recipes: new Map([
        ['n', [
          { ingredientId: 'd', qtyPerUnit: 10, modifierId: null },
          { ingredientId: 'r', qtyPerUnit: 25, modifierId: 'm-r' },
          { ingredientId: 's', qtyPerUnit: 25, modifierId: 'm-s' },
        ]],
      ]),
    });
    const plan = planMenuImport(withDips(), live);
    expect(plan.preview.items[0]).toMatchObject({ action: 'same', recipeChange: 'same' });
  });

  describe('leave-out choices', () => {
    const leaveOut = {
      name: 'Leave out · Nuggets',
      selectionType: 'multi',
      minSelect: 0,
      maxSelect: 1,
      required: false,
      options: [{ name: 'No ranch', removes: 'Ranch Sauce' }],
    };
    const withLeaveOut = () =>
      menuImportFileSchema.parse({
        format: 'cheeseoclock-menu-import',
        version: 3,
        categories: [{ name: 'Pizza' }],
        modifierGroups: [leaveOut],
        ingredients: [
          { name: 'Ranch Sauce', unit: 'g', costPerUnitCents: 70 },
          { name: 'Pan Pizza Dough', unit: 'g', costPerUnitCents: 31 },
        ],
        items: [
          {
            name: 'Nuggets',
            category: 'Pizza',
            priceCents: 67000,
            modifierGroups: ['Leave out · Nuggets'],
            recipe: [
              { ingredient: 'Pan Pizza Dough', qty: 10 },
              { ingredient: 'Ranch Sauce', qty: 25 },
            ],
          },
        ],
      });

    it('creates the option with the ingredient it leaves out', () => {
      const plan = planMenuImport(withLeaveOut(), shop());
      expect(plan.ops.modifierGroups[0]?.options[0]?.create).toMatchObject({
        name: 'No ranch',
        removes: { fileKey: 'ranch sauce' },
      });
    });

    it('points an existing option at the ingredient, and then sees it as unchanged', () => {
      const live = (removesIngredientId: string | null) =>
        shop({
          items: [item('n', 'Nuggets', { basePriceCents: 67000, description: 'x' })],
          ingredients: [ing('r', 'Ranch Sauce', 'g', 70, { notes: 'n' }), ing('d', 'Pan Pizza Dough', 'g', 31, { notes: 'n' })],
          modifierGroups: [
            {
              id: 'g1', name: 'Leave out · Nuggets', selectionType: 'multi', minSelect: 0, maxSelect: 1, isRequired: false,
              modifiers: [{ id: 'm-nr', name: 'No ranch', priceDeltaCents: 0, isDefault: false, sortOrder: 0, removesIngredientId }],
            },
          ],
          itemGroups: new Map([['n', [{ groupId: 'g1', sortOrder: 0 }]]]),
        });
      const before = planMenuImport(withLeaveOut(), live(null));
      expect(before.ops.modifierGroups[0]?.options[0]?.update).toEqual({ removes: { existingId: 'r' } });
      expect(before.preview.choiceGroups[0]?.changes).toContain('"No ranch" leaves out Ranch Sauce');
      const after = planMenuImport(withLeaveOut(), live('r'));
      expect(after.ops.modifierGroups[0]?.options[0]?.update).toBeNull();
    });

    it('refuses a leave-out of an ingredient the file does not have', () => {
      const bad = menuImportFileSchema.safeParse({
        format: 'cheeseoclock-menu-import',
        version: 3,
        categories: [],
        ingredients: [],
        items: [],
        modifierGroups: [{ ...leaveOut, options: [{ name: 'No ranch', removes: 'Ranch Sauce' }] }],
      });
      expect(bad.success).toBe(false);
    });
  });

  it('refuses a line for a choice the item does not offer', () => {
    const bad = menuImportFileSchema.safeParse({
      format: 'cheeseoclock-menu-import',
      version: 1,
      categories: [{ name: 'Pizza' }],
      ingredients: [{ name: 'Ranch Sauce', unit: 'g', costPerUnitCents: 70 }],
      items: [{ name: 'X', category: 'Pizza', priceCents: 1, recipe: [{ ingredient: 'Ranch Sauce', qty: 25, when: 'Ranch' }] }],
    });
    expect(bad.success).toBe(false);
  });
});

describe('batch recipes', () => {
  const file2 = (batch: unknown) =>
    menuImportFileSchema.parse({
      format: 'cheeseoclock-menu-import',
      version: 1,
      categories: [{ name: 'Pizza' }],
      ingredients: [
        { name: 'Mayonnaise', unit: 'g', costPerUnitCents: 100 },
        { name: 'Yogurt', unit: 'g', costPerUnitCents: 50 },
        { name: 'Ranch Sauce', unit: 'g', costPerUnitCents: 80, batch },
      ],
      items: [],
    });
  const ranch = { yield: 150, method: 'Mix well', lines: [{ ingredient: 'Mayonnaise', qty: 100 }, { ingredient: 'Yogurt', qty: 50 }] };

  it('sets the batch recipe of a new made-in-house ingredient', () => {
    const plan = planMenuImport(file2(ranch), shop());
    expect(plan.ops.batches).toEqual([
      {
        ingredient: { fileKey: 'ranch sauce' },
        batchYield: 150,
        batchMethod: 'Mix well',
        lines: [
          { ingredient: { fileKey: 'mayonnaise' }, qty: 100 },
          { ingredient: { fileKey: 'yogurt' }, qty: 50 },
        ],
      },
    ]);
    expect(plan.preview.summary.batchRecipesSet).toBe(1);
  });

  it('leaves an identical batch recipe alone, and keeps the shop\'s own method', () => {
    // The sheet's prices are already noted from an earlier import.
    const sheet = (cents: number) => ({ packSize: 1, packPriceCents: cents, priceKind: 'set' as const });
    const live = shop({
      ingredients: [
        ing('m', 'Mayonnaise', 'g', 100, { notes: 'n', sheet: sheet(100) }),
        ing('y', 'Yogurt', 'g', 50, { notes: 'n', sheet: sheet(50) }),
        ing('r', 'Ranch Sauce', 'g', 80, { notes: 'n', batchYield: 150, batchMethod: 'Our way', sheet: sheet(80) }),
      ],
      batchLines: new Map([['r', [{ inputId: 'm', qty: 100 }, { inputId: 'y', qty: 50 }]]]),
    });
    const plan = planMenuImport(file2(ranch), live);
    expect(plan.ops.batches).toEqual([]);
    expect(plan.preview.ingredients.find((i) => i.name === 'Ranch Sauce')?.action).toBe('same');
  });

  it('refuses a batch that uses itself', () => {
    const bad = menuImportFileSchema.safeParse({
      format: 'cheeseoclock-menu-import',
      version: 1,
      categories: [],
      ingredients: [{ name: 'Ranch Sauce', unit: 'g', costPerUnitCents: 1, batch: { yield: 10, lines: [{ ingredient: 'Ranch Sauce', qty: 5 }] } }],
      items: [],
    });
    expect(bad.success).toBe(false);
  });
});

describe('setBatchRecipeInputSchema', () => {
  const id = '01900000-0000-7000-8000-000000000001';
  const input = '01900000-0000-7000-8000-000000000002';
  const parse = (batchYield: number | null, lines: Array<{ inputIngredientId: string; qty: number }>) =>
    setBatchRecipeInputSchema.safeParse({ ingredientId: id, batchYield, lines }).success;

  it('needs a yield and at least one ingredient together — or neither (bought in again)', () => {
    expect(parse(100, [{ inputIngredientId: input, qty: 50 }])).toBe(true);
    expect(parse(null, [])).toBe(true);
    // The empty "Baking Powder: makes 100 g" recipe a till saved by mistake.
    expect(parse(100, [])).toBe(false);
    expect(parse(null, [{ inputIngredientId: input, qty: 50 }])).toBe(false);
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

  it('a fresh start (empty menu) keeps the tax the old menu used, not the first by name', () => {
    const f = menuImportFileSchema.parse({
      format: 'cheeseoclock-menu-import',
      version: 2,
      categories: [{ name: 'Pizza' }],
      ingredients: [],
      items: [{ name: 'Fajita Pizza — Medium', category: 'Pizza', priceCents: 150000 }],
    });
    const empty = shop({ categories: [], items: [], taxUse: new Map([['tax-sindh', 12]]) });
    const plan = planMenuImport(f, empty);
    expect(plan.ops.taxCategoryId).toBe('tax-sindh');
    expect(plan.preview.items[0]).toMatchObject({ action: 'create' });
    // Without the old menu's tax use, the first by name would win.
    expect(planMenuImport(f, shop({ categories: [], items: [] })).ops.taxCategoryId).toBe('tax-a');
  });

  it('puts a new category where the file puts it, never moving the shop\'s own', () => {
    const cats = (names: string[]) => names.map((name) => ({ name }));
    const dip = [{ name: 'Ranch Dip', category: 'Dips', priceCents: 10000, recipe: [] }];
    const f = file({ categories: cats(['Fries & Sides', 'Dips', 'Value Deals', 'Drinks']), ingredients: [], items: dip });
    const shopCats = (orders: Record<string, number>) =>
      shop({ categories: Object.entries(orders).map(([name, displayOrder], i) => ({ id: `c${i}`, name, displayOrder })) });
    const orderOf = (plan: ReturnType<typeof planMenuImport>, key: string) =>
      plan.ops.categories.find((c) => c.fileKey === key)?.create?.displayOrder;
    // No room between neighbours: level with the next one (the till then sorts "Dips" before "Value Deals").
    const tight = planMenuImport(f, shopCats({ 'Fries & Sides': 3, 'Value Deals': 4, Drinks: 5, 'Delivery Charges': 6 }));
    expect(orderOf(tight, 'dips')).toBe(4);
    expect(tight.ops.categories.filter((c) => c.create).length).toBe(1);
    // Room between them: in the gap.
    const roomy = planMenuImport(f, shopCats({ 'Fries & Sides': 3, 'Value Deals': 6, Drinks: 7 }));
    expect(orderOf(roomy, 'dips')).toBe(4);
    // Nothing after it: at the end, as before.
    const last = planMenuImport(file({ categories: cats(['Drinks', 'Dips']), ingredients: [], items: dip }), shopCats({ Drinks: 5, Pizza: 1 }));
    expect(orderOf(last, 'dips')).toBe(6);
  });

  it('reads versions 1 to 4 only (4: the Buy 1 Get 1 deals, v0.7.39)', () => {
    const file = (version: number) =>
      menuImportFileSchema.safeParse({ format: 'cheeseoclock-menu-import', version, categories: [], ingredients: [], items: [] });
    expect(file(1).success).toBe(true);
    expect(file(2).success).toBe(true);
    expect(file(3).success).toBe(true);
    expect(file(4).success).toBe(true);
    expect(file(5).success).toBe(false);
  });
});

describe('price kinds from the menu file (costing, Phase 1)', () => {
  const ingredients = [
    { name: 'Test Salt', unit: 'g', costPerUnitCents: 0 },
    { name: 'Test Bottle', unit: 'pcs', costPerUnitCents: 0 },
    { name: 'Test Breading', unit: 'g', costPerUnitCents: 15, priceIsEstimate: true },
    { name: 'Test Oil', unit: 'ml', costPerUnitCents: 0, packSize: 1000, packPriceCents: 50_000 },
  ];

  it('importedPriceKind: Rs 0 is "not priced yet" unless the shop marked it free; a guess is an estimate', () => {
    expect(importedPriceKind(false, false, null)).toBe('unset');
    expect(importedPriceKind(false, true, 'set')).toBe('unset');
    expect(importedPriceKind(false, false, 'free')).toBe('free');
    expect(importedPriceKind(true, false, 'free')).toBe('set');
    expect(importedPriceKind(true, true, 'set')).toBe('estimate');
  });

  it('new ingredients: Rs 0 → unset, a guess → estimate, a pack price → set', () => {
    const plan = planMenuImport(file({ ingredients, items: [] }), shop());
    expect(Object.fromEntries(plan.preview.ingredients.map((i) => [i.name, i.priceKind]))).toEqual({
      'Test Salt': 'unset',
      'Test Bottle': 'unset',
      'Test Breading': 'estimate',
      'Test Oil': 'set',
    });
    expect(plan.ops.ingredients.map((o) => o.create?.priceKind)).toEqual(['unset', 'unset', 'estimate', 'set']);
  });

  it('a "free" ingredient is never overwritten by the file\'s Rs 0; a till price stays as it is, the sheet\'s guess is its reference', () => {
    const plan = planMenuImport(
      file({ ingredients, items: [] }),
      shop({
        ingredients: [
          ing('salt', 'Test Salt', 'g', 0, { priceKind: 'free', sheet: { packSize: 1, packPriceCents: 0, priceKind: 'unset' } }),
          ing('breading', 'Test Breading', 'g', 15, { priceKind: 'set' }),
        ],
      }),
    );
    const salt = plan.preview.ingredients.find((i) => i.name === 'Test Salt')!;
    expect(salt).toMatchObject({ action: 'same', priceKind: 'free', changes: [], price: 'kept_free' });
    // Costing Phase 6: the till owns its prices, their kind included; the sheet's "guess" is noted beside it.
    const breading = plan.preview.ingredients.find((i) => i.name === 'Test Breading')!;
    expect(breading).toMatchObject({ action: 'update', priceKind: 'set', price: 'kept', sheetDiffers: false });
    expect(plan.ops.ingredients.find((o) => o.existingId === 'breading')).toMatchObject({
      update: null,
      sheet: { packSize: 1, packPriceCents: 15, priceKind: 'estimate' },
    });
  });
});

// ---------------------------------------------------------------------------
// Costing Phase 6: the till owns ingredient prices (spec section 8)
// ---------------------------------------------------------------------------

describe('who owns the price: the import matrix (costing Phase 6)', () => {
  // Made-up prices (costing spec D11).
  const sheetFile = () =>
    file({
      ingredients: [
        { name: 'Test Flour', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 12_000 }, // new
        { name: 'Test Cup', unit: 'pcs', costPerUnitCents: 500 }, // unset on the till
        { name: 'Test Salt', unit: 'g', costPerUnitCents: 2 }, // free on the till
        { name: 'Test Cheese', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 150_000 }, // a delivery's price on the till
        { name: 'Test Oil', unit: 'ml', costPerUnitCents: 0, packSize: 1000, packPriceCents: 40_000 }, // typed on the till
        { name: 'Test Box', unit: 'pcs', costPerUnitCents: 4_500 }, // from an earlier sheet
        { name: 'Test Bottle', unit: 'pcs', costPerUnitCents: 0 }, // unset, and the sheet has none either
      ],
      items: [],
    });
  const till = () =>
    shop({
      ingredients: [
        ing('cup', 'Test Cup', 'pcs', 0, { priceKind: 'unset' }),
        ing('salt', 'Test Salt', 'g', 0, { priceKind: 'free' }),
        ing('cheese', 'Test Cheese', 'g', 0, { packSize: 1000, packPriceCents: 177_000, priceSource: 'delivery' }),
        ing('oil', 'Test Oil', 'ml', 0, { packSize: 1000, packPriceCents: 45_000, priceSource: 'manual' }),
        ing('box', 'Test Box', 'pcs', 4_000, { priceSource: 'import' }),
        ing('bottle', 'Test Bottle', 'pcs', 0, { priceKind: 'unset' }),
      ],
    });
  const byName = (plan: ReturnType<typeof planMenuImport>) => new Map(plan.preview.ingredients.map((i) => [i.name, i]));
  const opOf = (plan: ReturnType<typeof planMenuImport>, id: string) => plan.ops.ingredients.find((o) => o.existingId === id);

  it('a new ingredient and an unpriced one take the sheet; free, delivered, typed and earlier-sheet prices stay', () => {
    const plan = planMenuImport(sheetFile(), till());
    const p = byName(plan);
    expect(p.get('Test Flour')).toMatchObject({ action: 'create', price: 'new_from_sheet', priceKind: 'set' });
    expect(p.get('Test Cup')).toMatchObject({ price: 'new_from_sheet', priceKind: 'set', changes: ["no price yet: the sheet's Rs 5 / pcs"] });
    expect(opOf(plan, 'cup')?.update).toEqual({ costPerUnitCents: 500, priceKind: 'set' });
    expect(p.get('Test Salt')).toMatchObject({ price: 'kept_free', priceKind: 'free' });
    expect(opOf(plan, 'salt')?.update).toBeNull();
    expect(p.get('Test Cheese')).toMatchObject({ price: 'kept_delivery', sheetDiffers: true });
    expect(opOf(plan, 'cheese')?.update).toBeNull();
    expect(p.get('Test Oil')).toMatchObject({ price: 'kept_typed', sheetDiffers: true });
    expect(opOf(plan, 'oil')?.update).toBeNull();
    expect(p.get('Test Box')).toMatchObject({ price: 'kept', sheetDiffers: true });
    expect(opOf(plan, 'box')?.update).toBeNull();
    expect(p.get('Test Bottle')).toMatchObject({ price: 'unpriced', priceKind: 'unset' });
    expect(opOf(plan, 'bottle')?.update).toBeNull();
  });

  it('the sheet reference is always planned, exactly as the file gives it (Rs 0 as "no price")', () => {
    const plan = planMenuImport(sheetFile(), till());
    expect(Object.fromEntries(plan.ops.ingredients.map((o) => [o.fileKey, o.sheet]))).toEqual({
      'test flour': { packSize: 1000, packPriceCents: 12_000, priceKind: 'set' },
      'test cup': { packSize: 1, packPriceCents: 500, priceKind: 'set' },
      'test salt': { packSize: 1, packPriceCents: 2, priceKind: 'set' },
      'test cheese': { packSize: 1000, packPriceCents: 150_000, priceKind: 'set' },
      'test oil': { packSize: 1000, packPriceCents: 40_000, priceKind: 'set' },
      'test box': { packSize: 1, packPriceCents: 4_500, priceKind: 'set' },
      'test bottle': { packSize: 1, packPriceCents: 0, priceKind: 'unset' },
    });
  });

  it('ONE summary line: what is kept, where from, what the sheet fills in, what is still unpriced', () => {
    const plan = planMenuImport(sheetFile(), till());
    expect(plan.preview.summary.prices).toEqual({
      keptFromDeliveries: 1,
      keptTyped: 1,
      keptOther: 2,
      madeHere: 0,
      batchKept: 0,
      newFromSheet: 2,
      unpriced: 1,
      sheetDiffers: 3,
    });
    expect(plan.preview.summary.priceLine).toBe(
      'Prices: 1 kept from deliveries, 1 kept as typed, 2 kept as they are, 2 new from the sheet, 1 unpriced.',
    );
    // The spec's own example, and the counts' words when nothing is kept.
    expect(
      priceSummaryLine({ keptFromDeliveries: 12, keptTyped: 0, keptOther: 0, madeHere: 0, batchKept: 0, newFromSheet: 3, unpriced: 0, sheetDiffers: 0 }),
    ).toBe('Prices: 12 kept from deliveries, 3 new from the sheet, 0 unpriced.');
    expect(priceSummaryLine(countPrices([]))).toBe('Prices: 0 new from the sheet, 0 unpriced.');
  });

  it('a batch made here is costed from its recipe: the sheet is only its reference (and fills it only when it has no price)', () => {
    const f = file({
      ingredients: [
        { name: 'Test Tomato', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 12_000 },
        { name: 'Test Sauce', unit: 'g', costPerUnitCents: 0, packSize: 2000, packPriceCents: 30_000, batch: { yield: 2000, lines: [{ ingredient: 'Test Tomato', qty: 2500 }] } },
        { name: 'Test Mix', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 90_000 },
      ],
      items: [],
    });
    const plan = planMenuImport(
      f,
      shop({
        ingredients: [
          ing('tomato', 'Test Tomato', 'g', 0, { packSize: 1000, packPriceCents: 12_000 }),
          ing('sauce', 'Test Sauce', 'g', 0, { packSize: 2000, packPriceCents: 35_000, batchYield: 2000 }),
          ing('mix', 'Test Mix', 'g', 0, { priceKind: 'unset', batchYield: 1000 }),
        ],
        batchLines: new Map([
          ['sauce', [{ inputId: 'tomato', qty: 2500 }]],
          ['mix', [{ inputId: 'tomato', qty: 1000 }]],
        ]),
      }),
    );
    const p = byName(plan);
    expect(p.get('Test Sauce')).toMatchObject({ price: 'made_here', sheetDiffers: false });
    expect(opOf(plan, 'sauce')?.update).toBeNull();
    expect(opOf(plan, 'sauce')?.sheet).toEqual({ packSize: 2000, packPriceCents: 30_000, priceKind: 'set' });
    // No price on the till: the sheet's is planned, for the repository to use only if its recipe can't price it.
    expect(p.get('Test Mix')).toMatchObject({ price: 'made_here' });
    expect(p.get('Test Mix')?.changes).toEqual(["no price yet: worked out from its batch recipe (the sheet's Rs 900 / kg is only a reference)"]);
    expect(opOf(plan, 'mix')?.update).toEqual({ packSize: 1000, packPriceCents: 90_000, priceKind: 'set' });
    expect(plan.preview.summary.prices.madeHere).toBe(2);
  });

  it('a batch its recipe cannot price (something in it has no price) is counted as what really happens to it, not "worked out"', () => {
    // Made-up prices (costing spec D11). Test Pepper is new and Rs 0 in the sheet: every batch using it is incomplete.
    const f = file({
      ingredients: [
        { name: 'Test Tomato', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 12_000 },
        { name: 'Test Pepper', unit: 'g', costPerUnitCents: 0 },
        // New, Rs 0 in the sheet: no price anywhere.
        { name: 'Test Dip', unit: 'g', costPerUnitCents: 0, batch: { yield: 1000, lines: [{ ingredient: 'Test Pepper', qty: 100 }] } },
        // New, priced in the sheet: it takes the sheet's.
        { name: 'Test Rub', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 50_000, batch: { yield: 1000, lines: [{ ingredient: 'Test Pepper', qty: 100 }] } },
        // On the till with a price: it keeps it (and the sheet's differs).
        { name: 'Test Sauce', unit: 'g', costPerUnitCents: 0, packSize: 2000, packPriceCents: 30_000, batch: { yield: 2000, lines: [{ ingredient: 'Test Tomato', qty: 2500 }, { ingredient: 'Test Pepper', qty: 10 }] } },
        // On the till with no price, sheet priced: the sheet's, since its recipe can't price it.
        { name: 'Test Mix', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 90_000, batch: { yield: 1000, lines: [{ ingredient: 'Test Pepper', qty: 5 }] } },
        // Complete after the file: worked out from its recipe.
        { name: 'Test Paste', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 20_000, batch: { yield: 1000, lines: [{ ingredient: 'Test Tomato', qty: 1500 }] } },
      ],
      items: [],
    });
    const plan = planMenuImport(
      f,
      shop({
        ingredients: [
          ing('tomato', 'Test Tomato', 'g', 0, { packSize: 1000, packPriceCents: 12_000, priceSource: 'delivery' }),
          ing('sauce', 'Test Sauce', 'g', 0, { packSize: 2000, packPriceCents: 35_000, batchYield: 2000, priceSource: 'batch' }),
          ing('mix', 'Test Mix', 'g', 0, { priceKind: 'unset', batchYield: 1000 }),
        ],
        batchLines: new Map([
          ['sauce', [{ inputId: 'tomato', qty: 2500 }]],
          ['mix', [{ inputId: 'tomato', qty: 1000 }]],
        ]),
      }),
    );
    const p = byName(plan);
    expect(p.get('Test Pepper')).toMatchObject({ price: 'unpriced' });
    expect(p.get('Test Dip')).toMatchObject({ price: 'unpriced' });
    expect(p.get('Test Rub')).toMatchObject({ price: 'new_from_sheet' });
    expect(p.get('Test Sauce')).toMatchObject({ price: 'batch_kept', sheetDiffers: true });
    expect(p.get('Test Mix')).toMatchObject({ price: 'new_from_sheet' });
    expect(p.get('Test Mix')?.changes).toContain("no price yet: the sheet's Rs 900 / kg");
    expect(p.get('Test Paste')).toMatchObject({ price: 'made_here', sheetDiffers: false });
    expect(plan.preview.summary.prices).toMatchObject({ madeHere: 1, batchKept: 1, newFromSheet: 2, unpriced: 2, keptFromDeliveries: 1 });
    expect(plan.preview.summary.priceLine).toBe(
      'Prices: 1 kept from deliveries, 1 worked out from their batch recipe, 1 batch keeps its price (something in it has no price), 2 new from the sheet, 2 unpriced.',
    );
    expect(priceSummaryLine({ ...countPrices([]), batchKept: 3 })).toBe(
      'Prices: 3 batches keep their price (something in them has no price), 0 new from the sheet, 0 unpriced.',
    );
  });

  it("sheetPriceOf: the file's pack exactly, or (1, its cost per unit); Rs 0 is 'unset', a guess 'estimate'", () => {
    expect(sheetPriceOf({ costPerUnitCents: 0, packSize: 6000, packPriceCents: 225_000, priceIsEstimate: false })).toEqual({
      packSize: 6000,
      packPriceCents: 225_000,
      priceKind: 'set',
    });
    expect(sheetPriceOf({ costPerUnitCents: 15, packSize: null, packPriceCents: null, priceIsEstimate: true })).toEqual({
      packSize: 1,
      packPriceCents: 15,
      priceKind: 'estimate',
    });
    expect(sheetPriceOf({ costPerUnitCents: 0, packSize: null, packPriceCents: null, priceIsEstimate: false }).priceKind).toBe('unset');
  });

  it('a fresh start: every ingredient is new, so every priced one comes from the sheet', () => {
    const plan = planMenuImport(sheetFile(), shop());
    expect(plan.preview.summary.prices).toMatchObject({ newFromSheet: 6, unpriced: 1, keptFromDeliveries: 0, keptTyped: 0, keptOther: 0 });
  });
});
