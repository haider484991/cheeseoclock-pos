import { z } from 'zod';
import { bpsSchema, centsSchema } from './common.js';

/**
 * A menu file: the shop's menu, prices, ingredients and recipes in one JSON
 * document, prepared outside the POS (from the costing spreadsheet) and loaded
 * through Menu → Import. The POS shows every change before saving anything,
 * and the import only adds and updates — it never deletes, renames or moves.
 *
 * Every name can carry aliases: other spellings the shop may already have typed
 * ("Cheesalious" for "Cheeselicious"), so a re-import updates rather than
 * duplicates. Recipe lines and items refer to ingredients and categories by
 * their name in this file.
 */

const name = z.string().trim().min(1).max(120);
const aliases = z.array(name).max(100).default([]);

export const menuImportCategorySchema = z.object({
  name,
  aliases,
  colorHex: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Invalid hex color')
    .default('#f59e0b'),
  displayOrder: z.number().int().default(0),
});

export const menuImportIngredientSchema = z.object({
  name,
  aliases,
  /** Base unit stock is counted in: g, ml, pcs, slice, portion… */
  unit: z.string().trim().min(1).max(20),
  /** Cost of ONE base unit, in paisa (whole number). Ignored when a pack is given. */
  costPerUnitCents: centsSchema,
  /** Bought as a pack of this many base units… */
  packSize: z.number().int().positive().nullable().default(null),
  /** …for this price, in paisa. The POS derives the per-unit cost from it. */
  packPriceCents: centsSchema.nullable().default(null),
  notes: z.string().max(2000).nullable().default(null),
  /** Made in-house: what one batch uses and how much it makes (see batch recipes in the POS). */
  batch: z
    .object({
      yield: z.number().int().positive(),
      method: z.string().max(4000).nullable().default(null),
      lines: z
        .array(z.object({ ingredient: name, qty: z.number().int({ message: 'Batch quantity must be a whole number' }).positive() }))
        .min(1)
        .max(100),
    })
    .nullable()
    .default(null),
});

export const menuImportRecipeLineSchema = z.object({
  ingredient: name,
  qty: z.number().int({ message: 'Recipe quantity must be a whole number' }).positive(),
  /** Only used when this choice (an option of one of the item's choice groups) is picked at the till. */
  when: name.nullable().default(null),
});

/** A choice asked for at the till ("Choose 5 veggies", "Choose your dip"). */
export const menuImportModifierGroupSchema = z
  .object({
    name,
    aliases,
    selectionType: z.enum(['single', 'multi']),
    minSelect: z.number().int().min(0),
    maxSelect: z.number().int().min(1),
    required: z.boolean(),
    options: z
      .array(
        z.object({
          name,
          aliases,
          priceDeltaCents: centsSchema.default(0),
          isDefault: z.boolean().default(false),
          /** A "leave out" choice: the ingredient (by name in this file) it takes off the dish. */
          removes: name.nullable().default(null),
        }),
      )
      .min(1)
      .max(50),
  })
  .refine((g) => g.maxSelect >= g.minSelect, { message: 'maxSelect must be at least minSelect' });

export const menuImportItemSchema = z.object({
  name,
  aliases,
  category: name,
  priceCents: centsSchema,
  description: z.string().max(500).nullable().default(null),
  sortOrder: z.number().int().default(0),
  /** Choice groups (by name in this file) asked for when this item is sold. */
  modifierGroups: z.array(name).max(10).default([]),
  recipe: z.array(menuImportRecipeLineSchema).default([]),
});

export const menuImportFileSchema = z
  .object({
    format: z.literal('cheeseoclock-menu-import'),
    /**
     * 2 = may carry till choices (`modifierGroups`, recipe `when`) and batch
     * recipes. Before 0.6.7 the POS read only version 1 and would have dropped
     * `when`, deducting every dip and veggie on every sale — so a file that
     * uses them says 2, and an older POS refuses it instead.
     * 3 = may carry "leave out" choices (option `removes`, POS 0.7.5): a POS
     * before that would import "No onion" and still deduct the onion.
     */
    version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    source: z.string().max(300).nullable().default(null),
    /**
     * The tax every item in the file is charged (added on top of the price —
     * the POS computes tax exclusive). Items are moved onto a tax category at
     * this rate, created if the POS has none. Null = leave tax as it is.
     */
    tax: z
      .object({ name: z.string().trim().min(1).max(80), rateBps: bpsSchema })
      .nullable()
      .default(null),
    categories: z.array(menuImportCategorySchema).max(100),
    modifierGroups: z.array(menuImportModifierGroupSchema).max(100).default([]),
    ingredients: z.array(menuImportIngredientSchema).max(1000),
    items: z.array(menuImportItemSchema).max(1000),
  })
  .superRefine((file, ctx) => {
    const unique = (list: Array<{ name: string }>, path: string) => {
      const seen = new Set<string>();
      list.forEach((entry, i) => {
        const key = entry.name.toLowerCase();
        if (seen.has(key)) {
          ctx.addIssue({ code: 'custom', path: [path, i, 'name'], message: `Duplicate name "${entry.name}"` });
        }
        seen.add(key);
      });
    };
    unique(file.categories, 'categories');
    unique(file.ingredients, 'ingredients');
    unique(file.items, 'items');
    unique(file.modifierGroups, 'modifierGroups');
    file.modifierGroups.forEach((g, gi) => unique(g.options, `modifierGroups.${gi}.options`));

    const categories = new Set(file.categories.map((c) => c.name.toLowerCase()));
    const ingredients = new Set(file.ingredients.map((i) => i.name.toLowerCase()));
    file.modifierGroups.forEach((g, gi) => {
      g.options.forEach((o, oi) => {
        if (o.removes && !ingredients.has(o.removes.toLowerCase())) {
          ctx.addIssue({
            code: 'custom',
            path: ['modifierGroups', gi, 'options', oi, 'removes'],
            message: `"${o.name}" leaves out "${o.removes}", which is not an ingredient in the file`,
          });
        }
      });
    });
    const groups = new Map(file.modifierGroups.map((g) => [g.name.toLowerCase(), g]));
    file.ingredients.forEach((ing, i) => {
      ing.batch?.lines.forEach((l, j) => {
        const key = l.ingredient.toLowerCase();
        if (!ingredients.has(key) || key === ing.name.toLowerCase()) {
          ctx.addIssue({
            code: 'custom',
            path: ['ingredients', i, 'batch', 'lines', j, 'ingredient'],
            message: `"${ing.name}" batch uses "${l.ingredient}", which is not another ingredient in the file`,
          });
        }
      });
    });
    file.items.forEach((item, i) => {
      if (!categories.has(item.category.toLowerCase())) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', i, 'category'],
          message: `"${item.name}" is in category "${item.category}", which the file does not list`,
        });
      }
      // The item's choices: option name → group. A name offered by two of its groups is ambiguous.
      const options = new Map<string, string>();
      for (const gName of item.modifierGroups) {
        const g = groups.get(gName.toLowerCase());
        if (!g) {
          ctx.addIssue({ code: 'custom', path: ['items', i, 'modifierGroups'], message: `"${item.name}" uses choice group "${gName}", which the file does not list` });
          continue;
        }
        for (const o of g.options) {
          const k = o.name.toLowerCase();
          if (options.has(k)) {
            ctx.addIssue({ code: 'custom', path: ['items', i, 'modifierGroups'], message: `"${item.name}": choice "${o.name}" is in two of its groups` });
          }
          options.set(k, g.name);
        }
      }
      const used = new Set<string>();
      item.recipe.forEach((line, j) => {
        const key = line.ingredient.toLowerCase();
        if (!ingredients.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: ['items', i, 'recipe', j, 'ingredient'],
            message: `"${item.name}" uses "${line.ingredient}", which the file does not list`,
          });
        }
        if (line.when && !options.has(line.when.toLowerCase())) {
          ctx.addIssue({
            code: 'custom',
            path: ['items', i, 'recipe', j, 'when'],
            message: `"${item.name}" has a line for choice "${line.when}", which none of its choice groups offer`,
          });
        }
        const lineKey = `${key}|${line.when?.toLowerCase() ?? ''}`;
        if (used.has(lineKey)) {
          ctx.addIssue({
            code: 'custom',
            path: ['items', i, 'recipe', j, 'ingredient'],
            message: `"${item.name}" lists "${line.ingredient}" twice`,
          });
        }
        used.add(lineKey);
      });
    });
  });

export type MenuImportFile = z.infer<typeof menuImportFileSchema>;
export type MenuImportCategory = z.infer<typeof menuImportCategorySchema>;
export type MenuImportIngredient = z.infer<typeof menuImportIngredientSchema>;
export type MenuImportItem = z.infer<typeof menuImportItemSchema>;
export type MenuImportModifierGroup = z.infer<typeof menuImportModifierGroupSchema>;
