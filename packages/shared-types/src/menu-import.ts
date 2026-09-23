/**
 * Menu import (Menu → Import): what loading a menu file WOULD change, shown
 * to the manager before anything is written. The file format itself is the
 * Zod schema `menuImportFileSchema` in @cheeseoclock/shared-schemas.
 */

/** create = new row; update = existing row changes; same = nothing to do; skip = left alone (see reason). */
export type MenuImportAction = 'create' | 'update' | 'same' | 'skip';

export interface MenuImportCategoryPlan {
  name: string;
  action: 'create' | 'same';
  /** The shop's own category this one maps onto, when it already exists. */
  existingName: string | null;
}

export interface MenuImportIngredientPlan {
  name: string;
  unit: string;
  costPerUnitCents: number;
  packSize: number | null;
  packPriceCents: number | null;
  action: MenuImportAction;
  existingName: string | null;
  /** Human-readable field changes, e.g. "cost Rs 0.50 → Rs 0.53 per g". */
  changes: string[];
  reason: string | null;
}

export type MenuImportRecipeChange = 'none' | 'same' | 'set' | 'replace' | 'skip';

export interface MenuImportItemPlan {
  name: string;
  /** Category the item is (or will be) in on this POS. */
  categoryName: string;
  priceCents: number;
  action: MenuImportAction;
  existingName: string | null;
  changes: string[];
  recipeLines: number;
  recipeChange: MenuImportRecipeChange;
  reason: string | null;
}

export interface MenuImportSummary {
  newItems: number;
  updatedItems: number;
  priceChanges: number;
  /** Items moved onto the file's tax rate. */
  taxChanges: number;
  recipesSet: number;
  newIngredients: number;
  updatedIngredients: number;
  newCategories: number;
  skipped: number;
}

export interface MenuImportPreview {
  fileName: string;
  source: string | null;
  /** Tax category the file's items are charged, e.g. "Sales Tax (15%)". */
  taxCategoryName: string | null;
  /** True when the import creates that tax category. */
  taxCategoryIsNew: boolean;
  /** True when the file sets the tax; false = new items get the tax most of the menu uses. */
  taxFromFile: boolean;
  categories: MenuImportCategoryPlan[];
  ingredients: MenuImportIngredientPlan[];
  items: MenuImportItemPlan[];
  /** Items on this POS that the file does not mention — left exactly as they are. */
  untouchedItems: string[];
  warnings: string[];
  summary: MenuImportSummary;
}
