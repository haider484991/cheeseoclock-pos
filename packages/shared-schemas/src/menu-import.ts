import { z } from 'zod';
import { centsSchema } from './common.js';

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
});

export const menuImportRecipeLineSchema = z.object({
  ingredient: name,
  qty: z.number().int({ message: 'Recipe quantity must be a whole number' }).positive(),
});

export const menuImportItemSchema = z.object({
  name,
  aliases,
  category: name,
  priceCents: centsSchema,
  description: z.string().max(500).nullable().default(null),
  sortOrder: z.number().int().default(0),
  recipe: z.array(menuImportRecipeLineSchema).default([]),
});

export const menuImportFileSchema = z
  .object({
    format: z.literal('cheeseoclock-menu-import'),
    version: z.literal(1),
    source: z.string().max(300).nullable().default(null),
    categories: z.array(menuImportCategorySchema).max(100),
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

    const categories = new Set(file.categories.map((c) => c.name.toLowerCase()));
    const ingredients = new Set(file.ingredients.map((i) => i.name.toLowerCase()));
    file.items.forEach((item, i) => {
      if (!categories.has(item.category.toLowerCase())) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', i, 'category'],
          message: `"${item.name}" is in category "${item.category}", which the file does not list`,
        });
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
        if (used.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: ['items', i, 'recipe', j, 'ingredient'],
            message: `"${item.name}" lists "${line.ingredient}" twice`,
          });
        }
        used.add(key);
      });
    });
  });

export type MenuImportFile = z.infer<typeof menuImportFileSchema>;
export type MenuImportCategory = z.infer<typeof menuImportCategorySchema>;
export type MenuImportIngredient = z.infer<typeof menuImportIngredientSchema>;
export type MenuImportItem = z.infer<typeof menuImportItemSchema>;
