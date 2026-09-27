import { describe, expect, it } from 'vitest';
import { menuImportFileSchema, type MenuImportFile } from '@cheeseoclock/shared-schemas';
import { DEFAULT_MENU_IMPORT_POLICY, type MenuImportPolicy } from '@cheeseoclock/shared-types';
import { keptOnTillLine, planMenuImport, type MenuSnapshot } from './menu-import-plan.js';

/**
 * What a menu file import may change on what the till already has
 * (Settings → Kitchen & stock, 'menu.importPolicy'): the released rule is
 * TODAY's behaviour — the file wins on item prices, choices, recipes and
 * tax, ingredient prices stay the till's (v0.7.14) — and each "keep the
 * till's" leaves that alone and says so in the preview ("kept on the
 * till"). New things always come in. Every name and price is made up.
 */

const DIPS = {
  name: 'Choose your dip',
  selectionType: 'single',
  minSelect: 1,
  maxSelect: 1,
  required: true,
  options: [
    { name: 'Ranch', priceDeltaCents: 7_000 },
    { name: 'Sriracha', priceDeltaCents: 5_000 },
  ],
};

/** A file where every rule has something to decide: a new price, a dearer dip, a new recipe, a new tax, a new batch recipe. */
function theFile(): MenuImportFile {
  return menuImportFileSchema.parse({
    format: 'cheeseoclock-menu-import',
    version: 1,
    source: 'test',
    tax: { name: 'Test tax', rateBps: 1_500 },
    categories: [{ name: 'Pizza' }],
    modifierGroups: [DIPS],
    ingredients: [
      { name: 'Test dough', unit: 'g', costPerUnitCents: 30 },
      { name: 'Test mayo', unit: 'g', costPerUnitCents: 100 },
      { name: 'Test yogurt', unit: 'g', costPerUnitCents: 50 },
      {
        name: 'Test ranch',
        unit: 'g',
        costPerUnitCents: 80,
        batch: { yield: 150, method: 'Mix', lines: [{ ingredient: 'Test mayo', qty: 100 }, { ingredient: 'Test yogurt', qty: 50 }] },
      },
    ],
    items: [
      {
        name: 'Test Pizza',
        category: 'Pizza',
        priceCents: 130_000,
        modifierGroups: ['Choose your dip'],
        recipe: [{ ingredient: 'Test dough', qty: 300 }],
      },
      { name: 'Test Wings', category: 'Pizza', priceCents: 90_000, recipe: [{ ingredient: 'Test dough', qty: 50 }] },
    ],
  });
}

const sheet = (cents: number) => ({ packSize: 1, packPriceCents: cents, priceKind: 'set' as const });
const ing = (id: string, name: string, cost: number, extra: Partial<MenuSnapshot['ingredients'][number]> = {}): MenuSnapshot['ingredients'][number] => ({
  id,
  name,
  unit: 'g',
  costPerUnitCents: cost,
  packSize: null,
  packPriceCents: null,
  batchYield: null,
  batchMethod: null,
  notes: 'n',
  sheet: sheet(cost),
  ...extra,
});

/** The till: the pizza at Rs 1,200 on the old tax with its own recipe; the dip Rs 50 / Rs 50, choose 1–2; the ranch its own batch. Wings are new. */
function theTill(): MenuSnapshot {
  return {
    categories: [{ id: 'cat', name: 'Pizza', displayOrder: 0 }],
    items: [{ id: 'pz', name: 'Test Pizza', categoryId: 'cat', basePriceCents: 120_000, description: 'x', isActive: true, taxCategoryId: 'tax-old' }],
    ingredients: [
      ing('d', 'Test dough', 30),
      ing('m', 'Test mayo', 100),
      ing('y', 'Test yogurt', 50),
      ing('r', 'Test ranch', 80, { batchYield: 200, batchMethod: 'Our way' }),
    ],
    recipes: new Map([['pz', [{ ingredientId: 'd', qtyPerUnit: 280, modifierId: null }]]]),
    taxCategories: [
      { id: 'tax-old', name: 'Old tax', rateBps: 1_300 },
      { id: 'tax-new', name: 'Test tax', rateBps: 1_500 },
    ],
    modifierGroups: [
      {
        id: 'g',
        name: 'Choose your dip',
        selectionType: 'single',
        minSelect: 1,
        maxSelect: 2,
        isRequired: true,
        modifiers: [
          { id: 'ranch', name: 'Ranch', priceDeltaCents: 5_000, isDefault: false, sortOrder: 0 },
          { id: 'sri', name: 'Sriracha', priceDeltaCents: 5_000, isDefault: false, sortOrder: 1 },
        ],
      },
    ],
    itemGroups: new Map([['pz', [{ groupId: 'g', sortOrder: 0 }]]]),
    batchLines: new Map([['r', [{ inputId: 'm', qty: 120 }, { inputId: 'y', qty: 80 }]]]),
  };
}

const policy = (over: Partial<MenuImportPolicy>): MenuImportPolicy => ({ ...DEFAULT_MENU_IMPORT_POLICY, ...over });
const pizzaOf = (plan: ReturnType<typeof planMenuImport>) => plan.preview.items.find((i) => i.name === 'Test Pizza')!;
const opOf = (plan: ReturnType<typeof planMenuImport>) => plan.ops.items.find((o) => o.existingId === 'pz');

describe('the released rule is today’s behaviour', () => {
  it('no rule given and the default rule plan the same import: the file wins, nothing is kept on the till', () => {
    const today = planMenuImport(theFile(), theTill());
    expect(planMenuImport(theFile(), theTill(), DEFAULT_MENU_IMPORT_POLICY)).toEqual(today);
    const pizza = pizzaOf(today);
    expect(pizza.changes).toEqual(['price Rs 1,200 → Rs 1,300', 'tax 13% → 15%', 'recipe replaced (1 → 1 lines)']);
    expect(pizza.keptOnTill).toBeUndefined();
    expect(opOf(today)?.update).toEqual({ basePriceCents: 130_000, useImportTax: true });
    expect(opOf(today)?.recipe).not.toBeNull();
    expect(today.preview.choiceGroups[0]).toMatchObject({ action: 'update', changes: ['choose 1, required', '"Ranch" Rs 50 → Rs 70'] });
    expect(today.preview.choiceGroups[0]?.keptOnTill).toBeUndefined();
    expect(today.ops.batches).toHaveLength(1);
    expect(today.preview.summary).toMatchObject({
      priceChanges: 1,
      taxChanges: 1,
      recipesSet: 2,
      batchRecipesSet: 1,
      keptOnTill: { prices: 0, choices: 0, recipes: 0, taxes: 0 },
      keptLine: null,
    });
    // Ingredient prices stay the till's whatever the rule (v0.7.14).
    expect(today.preview.summary.priceLine).toBe('Prices: 3 kept as they are, 1 worked out from their batch recipe, 0 new from the sheet, 0 unpriced.');
  });
});

describe('each “keep the till’s”', () => {
  it('item prices: the till keeps Rs 1,200, the preview says what the file had; a new item still comes in at the file’s', () => {
    const plan = planMenuImport(theFile(), theTill(), policy({ itemPrices: 'till' }));
    const pizza = pizzaOf(plan);
    expect(pizza.keptOnTill).toEqual(['price Rs 1,200 (the file says Rs 1,300)']);
    expect(pizza.changes).not.toContain('price Rs 1,200 → Rs 1,300');
    expect(opOf(plan)?.update).toEqual({ useImportTax: true });
    expect(plan.ops.items.find((o) => o.create?.name === 'Test Wings')?.create?.basePriceCents).toBe(90_000);
    expect(plan.preview.summary).toMatchObject({ priceChanges: 0, keptOnTill: { prices: 1, choices: 0, recipes: 0, taxes: 0 } });
    expect(plan.preview.summary.keptLine).toBe('Kept on the till: 1 price (Settings → Kitchen & stock).');
  });

  it('choices: the till keeps its charges and how many to pick; a new option still comes in', () => {
    const till = theTill();
    till.modifierGroups[0]!.modifiers = till.modifierGroups[0]!.modifiers.filter((m) => m.id !== 'sri');
    const plan = planMenuImport(theFile(), till, policy({ choices: 'till' }));
    const group = plan.preview.choiceGroups[0]!;
    expect(group.keptOnTill).toEqual(['choose 1–2, required (the file says choose 1, required)', '"Ranch" Rs 50 (the file says Rs 70)']);
    expect(group.changes).toEqual(['"Sriracha" added']);
    const op = plan.ops.modifierGroups[0]!;
    expect(op.update).toBeNull();
    expect(op.options.find((o) => o.existingId === 'ranch')?.update).toBeNull();
    expect(op.options.find((o) => o.create?.name === 'Sriracha')?.create?.priceDeltaCents).toBe(5_000);
    expect(plan.preview.summary.keptOnTill).toMatchObject({ choices: 1 });
  });

  it('choices: a new option the file picks first comes in NOT picked, so a “pick 1” group never starts with two (and the preview says so)', () => {
    // The till's "Size" (pick 1) starts on Small; the file adds Medium and starts on it instead.
    const file = theFile();
    file.modifierGroups = [
      {
        ...file.modifierGroups[0]!,
        name: 'Test size',
        options: [
          { name: 'Small', aliases: [], priceDeltaCents: 0, isDefault: false, removes: null },
          { name: 'Medium', aliases: [], priceDeltaCents: 20_000, isDefault: true, removes: null },
        ],
      },
    ];
    file.items = file.items.map((i) => ({ ...i, modifierGroups: i.name === 'Test Pizza' ? ['Test size'] : i.modifierGroups }));
    const till = theTill();
    till.modifierGroups = [
      {
        id: 'size',
        name: 'Test size',
        selectionType: 'single',
        minSelect: 1,
        maxSelect: 1,
        isRequired: true,
        modifiers: [{ id: 'small', name: 'Small', priceDeltaCents: 0, isDefault: true, sortOrder: 0 }],
      },
    ];
    till.itemGroups = new Map([['pz', [{ groupId: 'size', sortOrder: 0 }]]]);
    /** Which options start picked once the plan is applied: the till's kept ones and the new ones. */
    const pickedAfter = (plan: ReturnType<typeof planMenuImport>) => {
      const op = plan.ops.modifierGroups.find((g) => g.existingId === 'size')!;
      return [
        ...till.modifierGroups[0]!.modifiers
          .filter((m) => op.options.find((o) => o.existingId === m.id)?.update?.isDefault ?? m.isDefault)
          .map((m) => m.name),
        ...op.options.filter((o) => o.create?.isDefault).map((o) => o.create!.name),
      ];
    };

    // Today (the file wins): Medium alone starts picked.
    expect(pickedAfter(planMenuImport(file, till))).toEqual(['Medium']);
    // Keep the till's: Small alone, and the preview lists Medium as kept not picked.
    const kept = planMenuImport(file, till, policy({ choices: 'till' }));
    expect(pickedAfter(kept)).toEqual(['Small']);
    const group = kept.preview.choiceGroups.find((g) => g.name === 'Test size')!;
    expect(group.changes).toEqual(['"Medium" added']);
    expect(group.keptOnTill).toEqual(['"Small" picked to start with', '"Medium" not picked to start with (the file picks it first)']);
    expect(kept.preview.summary.keptOnTill).toMatchObject({ choices: 1 });
  });

  it('recipes: the till keeps the pizza’s recipe and the ranch batch; the new wings still get the file’s', () => {
    const plan = planMenuImport(theFile(), theTill(), policy({ recipes: 'till' }));
    const pizza = pizzaOf(plan);
    expect(pizza.recipeChange).toBe('kept');
    expect(pizza.keptOnTill).toEqual(['recipe (1 line; the file has 1)']);
    expect(opOf(plan)?.recipe).toBeNull();
    expect(plan.ops.items.find((o) => o.create?.name === 'Test Wings')?.recipe).toHaveLength(1);
    expect(plan.ops.batches).toEqual([]);
    expect(plan.preview.ingredients.find((i) => i.name === 'Test ranch')?.keptOnTill).toEqual([
      'batch recipe: 2 inputs, makes 200 g (the file has 2 inputs, makes 150 g)',
    ]);
    expect(plan.preview.summary).toMatchObject({ recipesSet: 1, batchRecipesSet: 0, keptOnTill: { recipes: 2 } });
    expect(plan.preview.summary.keptLine).toBe('Kept on the till: 2 recipes (Settings → Kitchen & stock).');
  });

  it('tax: the pizza stays on its tax; new items take the file’s', () => {
    const plan = planMenuImport(theFile(), theTill(), policy({ tax: 'till' }));
    expect(pizzaOf(plan).keptOnTill).toEqual(['tax 13% (the file says 15%)']);
    expect(opOf(plan)?.update).toEqual({ basePriceCents: 130_000 });
    expect(plan.ops.taxCategoryId).toBe('tax-new');
    expect(plan.preview.summary).toMatchObject({ taxChanges: 0, keptOnTill: { taxes: 1 } });
  });

  it('everything kept: one line says it all; an item with nothing left to change is still shown for what it kept', () => {
    const plan = planMenuImport(theFile(), theTill(), policy({ itemPrices: 'till', choices: 'till', recipes: 'till', tax: 'till' }));
    const pizza = pizzaOf(plan);
    expect(pizza.action).toBe('same');
    expect(pizza.keptOnTill).toHaveLength(3);
    expect(opOf(plan)).toBeUndefined();
    expect(plan.preview.summary.keptLine).toBe('Kept on the till: 1 price, 1 choice group, 2 recipes, the tax of 1 item (Settings → Kitchen & stock).');
  });

  it('a fresh start: nothing is on the till to keep, whatever the rule', () => {
    const empty: MenuSnapshot = { ...theTill(), items: [], ingredients: [], recipes: new Map(), modifierGroups: [], itemGroups: new Map(), batchLines: new Map() };
    const plan = planMenuImport(theFile(), empty, policy({ itemPrices: 'till', choices: 'till', recipes: 'till', tax: 'till' }));
    expect(plan.preview.summary.keptLine).toBeNull();
    expect(plan.preview.summary.newItems).toBe(2);
  });
});

describe('the kept line', () => {
  it('counts in words, one or many', () => {
    expect(keptOnTillLine({ prices: 0, choices: 0, recipes: 0, taxes: 0 })).toBeNull();
    expect(keptOnTillLine({ prices: 3, choices: 2, recipes: 1, taxes: 2 })).toBe(
      'Kept on the till: 3 prices, 2 choice groups, 1 recipe, the tax of 2 items (Settings → Kitchen & stock).',
    );
  });
});
