/**
 * Costing (costing spec, Phase 1): what each dish costs to make, whether its
 * food cost is on target, what is still missing a price, and the batch
 * calculator. Read-only figures worked out on the till from today's prices;
 * nothing here is stored with a sale yet (that is Phase 2).
 *
 * Money is paisa ("cents"); unit costs are millicents (mc = 1/1000 paisa),
 * so a price per gram in mc reads as paisa per kilogram. Percentages are
 * basis points (3000 = 30%). Only logins with COST_CAPABILITY get any of it.
 */

import type { PriceKind } from './inventory.js';

/** Where a dish's food cost % sits against its category's target. */
export type FoodCostFlag =
  /** At or under the target. */
  | 'green'
  /** Over the target by no more than the "close" width. */
  | 'amber'
  /** Further over. */
  | 'red'
  /** Can't cost it yet: an ingredient has no price, or it has no recipe. */
  | 'grey'
  /** The category's target is still a suggestion: the % is shown, uncoloured. */
  | 'neutral'
  /** Not food (delivery charges): left out of food cost. */
  | 'nonfood';

/** How an ingredient line's price is known, or 'missing' (no price, or the ingredient is gone). */
export type CostLineKind = PriceKind | 'missing';

// ---------------------------------------------------------------- targets --

export interface CategoryTarget {
  bps: number;
  /** False while it is only the suggestion (neutral, no colours). */
  confirmed: boolean;
}

/** business_settings 'costing.targets' (shared-schemas costingTargetsSchema). */
export interface CostingTargets {
  /** For a category with nothing saved and no suggestion by its name. */
  defaultBps: number;
  /** How far over the target still counts as "close" (amber). */
  amberBps: number;
  perCategory: Record<string, CategoryTarget>;
  /** Categories that are not food (delivery charges): no food cost. */
  nonFoodCategoryIds: string[];
}

export interface CategoryTargetView {
  categoryId: string;
  name: string;
  /** The target in force: the saved one, or the suggestion while none is saved. */
  bps: number;
  /** What the till suggests for a category of this name. */
  suggestedBps: number;
  confirmed: boolean;
  nonFood: boolean;
  itemCount: number;
}

export interface CostingTargetsView {
  defaultBps: number;
  amberBps: number;
  /** Prices are suggested in steps of this much (Rs 10 = 1,000). */
  priceStepCents: number;
  categories: CategoryTargetView[];
  /** A food category is still on a suggestion ("Use these" not tapped yet). */
  anyUnconfirmed: boolean;
  /** When the targets were last saved (ISO); null = never, all suggestions. */
  savedAt: string | null;
}

export interface SetCostingTargetsRequest {
  defaultBps: number;
  amberBps: number;
  perCategory: Record<string, CategoryTarget>;
  nonFoodCategoryIds: string[];
  priceStepCents: number;
}

// ---------------------------------------------------------- batch figures --

/** One input of a batch, scaled to the amount asked for. */
export interface BatchCalcLine {
  inputId: string;
  name: string;
  unit: string;
  /** How much ONE batch uses. */
  perBatchQty: number;
  /** The exact scaled amount, in hundredths of a base unit (1250 = 12.5 g). */
  scaledHundredths: number;
  /** Whole base units the stock movement takes out ("Make this amount"). */
  stockQty: number;
  /** Price of one base unit in millicents (per gram = paisa per kg); null when unpriced. */
  unitCostMc: number | null;
  /** Cost of the exact scaled amount, millicents. */
  costMc: number;
  costCents: number;
  /** Share of the batch's cost, basis points; null when the batch costs nothing known. */
  shareBps: number | null;
  priceKind: CostLineKind;
  madeInHouse: boolean;
  /** What this input is made of, scaled the same way (Costing page); null when bought in. */
  madeOf: BatchCalc | null;
}

/** A batch recipe worked out for any amount (the batch calculator). */
export interface BatchCalc {
  ingredientId: string;
  name: string;
  unit: string;
  batchYield: number;
  /** The amount asked for, in base units of the batch item. */
  amount: number;
  lines: BatchCalcLine[];
  totalCostMc: number;
  totalCostCents: number;
  /** Cost of one base unit (g / ml / piece), millicents: per gram it is also paisa per kg. */
  perUnitMc: number;
  /** Every input has a price. */
  complete: boolean;
  unpricedInputs: string[];
  /** Inputs priced with a guess. */
  estimateInputs: string[];
  /** Inputs too small at this amount to take a whole unit from stock. */
  roundedAway: string[];
  /** Stock of the batch item on this till now. */
  inStock: number;
  /** The most "Make this amount" takes in one go (100 batches). */
  maxAmount: number;
}

// -------------------------------------------------------------- the plate --

/** One ingredient line of a dish, costed. */
export interface CostLineView {
  ingredientId: string;
  name: string;
  unit: string;
  qty: number;
  unitCostMc: number | null;
  costMc: number;
  costCents: number;
  /**
   * Share of the cost, basis points: for "Always in it", of the typical
   * plate (choices included); for a choice or a paid extra, of that choice.
   */
  shareBps: number | null;
  priceKind: CostLineKind;
  /** A sauce or dough made in-house: what this amount of it is made of. */
  madeOf: BatchCalc | null;
}

export interface ChoiceCostView {
  modifierId: string;
  name: string;
  priceDeltaCents: number;
  costCents: number;
  missingLines: number;
  estimateLines: number;
  /** Of the item's units sold in the last 28 days, how many had it (bps); null = too few sold. */
  pickedShareBps: number | null;
  lines: CostLineView[];
}

/** A choice the customer must make ("Choose your dip", a deal's pizza, "Choose 5 veggies"). */
export interface RequiredGroupView {
  groupId: string;
  name: string;
  /** At least this many picked… */
  kMin: number;
  /** …and at most this many. */
  kMax: number;
  /** 'observed': weighted by the last 28 days' picks; 'usual': not enough sales, so kMax × the average option. */
  basis: 'observed' | 'usual';
  options: ChoiceCostView[];
  typicalCostCents: number;
  cheapestCostCents: number;
  dearestCostCents: number;
  typicalPriceCents: number;
}

export interface PaidExtraView {
  modifierId: string;
  name: string;
  groupName: string;
  priceDeltaCents: number;
  costCents: number;
  marginCents: number;
  foodCostBps: number | null;
  flag: FoodCostFlag;
  missingLines: number;
  lines: CostLineView[];
}

export interface LeaveOutView {
  modifierId: string;
  name: string;
  ingredientName: string;
  /** What leaving it out saves on a typical plate. */
  savingCents: number;
  /** Unpriced lines it takes off (they count as Rs 0): above 0, the saving is only "at least", or not known. */
  missingLines: number;
}

/** One menu item (each size is its own item) on the Menu costs table. */
export interface MenuCostRow {
  menuItemId: string;
  name: string;
  categoryId: string;
  categoryName: string;
  isActive: boolean;
  basePriceCents: number;
  /** The typical price: the item's price plus its usual paid picks (ex-tax, as on the menu). */
  priceCents: number;
  /** What a typical plate costs to make. */
  costCents: number;
  /** Cheapest and dearest plate, from the picks the customer makes. */
  minCostCents: number;
  maxCostCents: number;
  /** What you keep per sale at menu price: price − cost. */
  profitCents: number;
  /** Cost ÷ price, basis points; null when the price is 0. */
  foodCostBps: number | null;
  targetBps: number;
  targetConfirmed: boolean;
  flag: FoodCostFlag;
  hasRecipe: boolean;
  /** Recipe lines (plate or required picks) with no price. */
  missingLines: number;
  /** The ingredients behind those lines, by name, each once (one sauce in eight deal pizzas is one). */
  missingIngredients: string[];
  /** Lines priced with a guess. */
  estimateLines: number;
  /** Units counted in the last 28 days, on this till. */
  soldLast28: number;
}

/**
 * The summary counts only the items on the menu: on the till, or hidden but
 * sold in the last 28 days. A dish hidden and not sold since (retired) is
 * still in the table, tagged, but counts nowhere — so Missing costs can
 * reach zero without writing a recipe for a dish nobody sells.
 */
export interface MenuCostsSummary {
  items: number;
  onTarget: number;
  close: number;
  over: number;
  cantCost: number;
  /** Food items whose category target is still a suggestion. */
  notConfirmed: number;
}

export interface MenuCostsView {
  rows: MenuCostRow[];
  summary: MenuCostsSummary;
  amberBps: number;
  /** Rows on Missing costs (the tab's badge). */
  missingCount: number;
}

export interface ItemCostSheet {
  row: MenuCostRow;
  /** "Always in it": the lines used on every sale. */
  always: CostLineView[];
  alwaysCostCents: number;
  groups: RequiredGroupView[];
  paidExtras: PaidExtraView[];
  leaveOuts: LeaveOutView[];
}

/** The recipe editor's live footer: the recipe as typed, not yet saved. */
export interface RecipeCostPreview {
  hasRecipe: boolean;
  costCents: number;
  priceCents: number;
  foodCostBps: number | null;
  missingLines: number;
  /** The unpriced ingredients by name, each once. */
  missingIngredients: string[];
  estimateLines: number;
  targetBps: number;
  targetConfirmed: boolean;
  flag: FoodCostFlag;
}

// ---------------------------------------------------------- missing costs --

export interface MissingPriceRow {
  ingredientId: string;
  name: string;
  unit: string;
  /** Menu items using it (directly or through a batch), by name. */
  items: string[];
  /** Share of the last 28 days' item sales those items make, bps; null when nothing sold. */
  salesShareBps: number | null;
  costPerUnitCents: number;
}

export interface MissingRecipeRow {
  menuItemId: string;
  name: string;
  categoryName: string;
  soldLast28: number;
}

/** An input of a batch with no price: "Set price" opens it, unless it was deleted (fix the batch recipe). */
export interface UnpricedInput {
  ingredientId: string;
  name: string;
  /** Deleted since (only through the other till): nothing to price, the batch recipe needs editing. */
  gone: boolean;
}

export interface MissingBatchRow {
  ingredientId: string;
  name: string;
  unpricedInputs: UnpricedInput[];
  /** The loop the batch is in, when its inputs lead back to it. */
  loop: boolean;
}

export interface MissingCosts {
  /** (a) used in recipes, no price yet. */
  unpriced: MissingPriceRow[];
  /** (b) food items with no recipe. */
  noRecipe: MissingRecipeRow[];
  /** (c) prices that are a guess. */
  guessed: MissingPriceRow[];
  /** (d) a price per gram / ml rounded to whole paisa: re-enter it per kg (as a pack of 1,000). */
  roundedPerGram: MissingPriceRow[];
  /** (e) batches with inputs that have no price. */
  batches: MissingBatchRow[];
  total: number;
}

// ------------------------------------------------ the cost kept with a sale --

/**
 * What a sale's cost row says (costing spec 0033, order_item_costs.status):
 *  - 'full':    every ingredient had a price (a guessed price counts);
 *  - 'partial': some ingredient had no price (it added Rs 0);
 *  - 'none':    the item has no recipe at all (Baked Wings, a delivery charge);
 *  - 'failed':  working the cost out went wrong (the stock was still taken).
 */
export const ORDER_ITEM_COST_STATUSES = ['full', 'partial', 'none', 'failed'] as const;
export type OrderItemCostStatus = (typeof ORDER_ITEM_COST_STATUSES)[number];
