/**
 * Menu import (Menu → Import): what loading a menu file WOULD change, shown
 * to the manager before anything is written. The file format itself is the
 * Zod schema `menuImportFileSchema` in @cheeseoclock/shared-schemas.
 */

import type { PriceKind, PriceSource } from './inventory.js';

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
  /** The sheet's price as the file gives it (a pack wins over the cost per unit). */
  costPerUnitCents: number;
  packSize: number | null;
  packPriceCents: number | null;
  /**
   * What the price kind will be after the import. A price the till keeps
   * keeps its kind; one the sheet gives follows the file: Rs 0 is 'unset'
   * (not priced yet), a guess is 'estimate'.
   */
  priceKind: PriceKind;
  action: MenuImportAction;
  existingName: string | null;
  /** Human-readable field changes, e.g. "counted in kg → g", "sheet's price noted". */
  changes: string[];
  reason: string | null;
  /**
   * What happens to its price (costing spec Phase 6, section 8): the till
   * owns ingredient prices, so the sheet only prices a new ingredient or one
   * with none; every other keeps the till's price. Null when skipped.
   */
  price: MenuImportPriceOutcome | null;
  /** The price on the till now (before the import), in the file's unit; null for a new ingredient. */
  tillPrice: { unitCostMc: number; priceKind: PriceKind; source: PriceSource | null } | null;
  /** The sheet's price, one base unit in millicents (the reference stored on every import). */
  sheetUnitCostMc: number;
  /** The till keeps a price that differs from the sheet's ("Use the sheet's price" is in Inventory). */
  sheetDiffers: boolean;
  /**
   * What the till keeps although the file has something else, by the
   * owner's import rules (Settings → Kitchen & stock): its batch recipe.
   * Absent: nothing kept.
   */
  keptOnTill?: string[];
}

/**
 * What the menu file does to an ingredient's price (costing spec Phase 6):
 *  - 'new_from_sheet': a new ingredient, or one with no price yet: the sheet's price;
 *  - 'kept_delivery':  the till keeps its price from a delivery or purchase bill;
 *  - 'kept_typed':     the till keeps the price typed on it;
 *  - 'kept':           the till keeps its price (from an earlier sheet, or from before price history);
 *  - 'kept_free':      it was marked free, and stays free;
 *  - 'made_here':      a batch made here whose recipe prices it (every input has a
 *                      price once the file is in): its price is worked out from it;
 *  - 'batch_kept':     a batch made here whose recipe can't price it (something in it
 *                      has no price): it keeps the price it has, and Costing → Alerts
 *                      says so (with no price of its own it is 'new_from_sheet' or
 *                      'unpriced', like any other ingredient);
 *  - 'unpriced':       no price on the till and none in the sheet (Rs 0).
 */
export type MenuImportPriceOutcome =
  | 'new_from_sheet'
  | 'kept_delivery'
  | 'kept_typed'
  | 'kept'
  | 'kept_free'
  | 'made_here'
  | 'batch_kept'
  | 'unpriced';

/** The ingredient prices of a menu file, counted (the preview's one summary line). */
export interface MenuImportPriceSummary {
  keptFromDeliveries: number;
  keptTyped: number;
  /** Kept as they are: from an earlier sheet, from before price history, or marked free. */
  keptOther: number;
  /** Batches made here, priced from their recipe. */
  madeHere: number;
  /** Batches made here that keep their price: something in their recipe has no price. */
  batchKept: number;
  newFromSheet: number;
  unpriced: number;
  /** Kept prices that differ from the sheet's (each shown beside the till's in Inventory). */
  sheetDiffers: number;
}

/** … 'kept': the item has a recipe and the owner's import rules keep the till's. */
export type MenuImportRecipeChange = 'none' | 'same' | 'set' | 'replace' | 'skip' | 'kept';

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
  /**
   * What the till keeps although the file says otherwise, by the owner's
   * import rules (Settings → Kitchen & stock): "price Rs 1,200 (the file
   * says Rs 1,300)", its recipe, its tax. Absent: nothing kept.
   */
  keptOnTill?: string[];
}

/** How many things the till kept against the file, by the owner's import rules (Settings → Kitchen & stock). */
export interface MenuImportKept {
  /** Menu items' selling prices. */
  prices: number;
  /** Choice groups whose charges or rules the till kept. */
  choices: number;
  /** Dish and batch recipes. */
  recipes: number;
  /** Items left on their own tax. */
  taxes: number;
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
  /** Choice groups ("Choose your dip") created or given new options. */
  choiceGroupsChanged: number;
  batchRecipesSet: number;
  skipped: number;
  /** Fresh start only: menu items removed before loading the file (0 otherwise). */
  removedItems: number;
  /** Ingredient prices: what the till keeps and what comes from the sheet (costing Phase 6). */
  prices: MenuImportPriceSummary;
  /** Those counts as ONE plain line: "Prices: 12 kept from deliveries, 3 new from the sheet, 0 unpriced." */
  priceLine: string;
  /** What the till kept against the file (the owner's import rules). */
  keptOnTill: MenuImportKept;
  /** Those counts as one line — "Kept on the till: 3 prices, 1 recipe (Settings → Kitchen & stock)." — or null when nothing was kept. */
  keptLine: string | null;
}

export interface MenuImportChoiceGroupPlan {
  name: string;
  action: MenuImportAction;
  existingName: string | null;
  options: string[];
  changes: string[];
  /** What the till keeps of the group although the file says otherwise (the owner's import rules). Absent: nothing kept. */
  keptOnTill?: string[];
}

/**
 * "Start fresh": what is on this POS now and would be removed before the file
 * is loaded — every menu item, category, combo, choice group and ingredient
 * (with their recipes). Sales history, customers, users, settings and tax
 * categories stay.
 */
export interface MenuImportFreshStart {
  items: string[];
  categories: number;
  combos: number;
  choiceGroups: number;
  ingredients: number;
  /** Unpaid orders still in progress — a fresh start waits until there are none. */
  openOrders: number;
  /**
   * Items set "Pick-up only" or "Not on the website", and categories off the
   * website, whose setting the fresh start can't keep, by name: the file does
   * NOT bring the name back, or two removed rows of that name were set
   * differently (nothing is carried for it). The fresh start gives each of
   * the file's items and categories the website setting of the removed one
   * of the same name (the file carries none); what comes back under another
   * name is on the website, and the import publishes the menu at once. 0 =
   * every setting is kept (the preview says nothing about them).
   */
  websiteSettingsLost: number;
}

export interface MenuImportPreview {
  fileName: string;
  /** Set when the preview is for a fresh start (the file planned against an empty menu). */
  fresh: MenuImportFreshStart | null;
  source: string | null;
  /** Tax category the file's items are charged, e.g. "Sales Tax (15%)". */
  taxCategoryName: string | null;
  /** True when the import creates that tax category. */
  taxCategoryIsNew: boolean;
  /** True when the file sets the tax; false = new items get the tax most of the menu uses. */
  taxFromFile: boolean;
  categories: MenuImportCategoryPlan[];
  choiceGroups: MenuImportChoiceGroupPlan[];
  ingredients: MenuImportIngredientPlan[];
  items: MenuImportItemPlan[];
  /** Items on this POS that the file does not mention — left exactly as they are. */
  untouchedItems: string[];
  warnings: string[];
  summary: MenuImportSummary;
}
