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

// ------------------------------------------------------------ price alerts --

/**
 * What the Costing page's Alerts tab tells the owner (costing spec Phase 6,
 * migration 0036 cost_alerts.kind):
 *  - 'price_jump':           a key ingredient's price moved more than the
 *                            alert threshold, or a price change costs at
 *                            least the weekly threshold at this till's sales;
 *  - 'weekly_digest':        Monday's list of dishes that price changes moved
 *                            across their target;
 *  - 'batch_unpriced_input': a sauce or mix made here kept its old price,
 *                            because something that goes into it has none.
 * Worked out only on the till that wrote the price; name-based ids, so the
 * same alert on both tills is one row.
 */
export const COST_ALERT_KINDS = ['price_jump', 'weekly_digest', 'batch_unpriced_input'] as const;
export type CostAlertKind = (typeof COST_ALERT_KINDS)[number];

/** business_settings 'costing.alerts' (shared-schemas costingAlertsSchema): the alert thresholds. */
export interface CostAlertSettings {
  /**
   * A key ingredient's price moving more than this (basis points: 1,000 =
   * 10%) is an alert. The same figure is D1's purchase guard: a bill this
   * far from the usual price asks before it becomes the price.
   */
  jumpBps: number;
  /** Any price change costing at least this much a week (paisa) at this till's sales is an alert. */
  impactWeekCents: number;
  /**
   * LEGACY (Phase 6 kept the key ingredients here). Since Phase 8 the key
   * items are ONE list on the ingredients (ingredients.count_weekly);
   * migration 0038 moved this list there once. Read by nothing else, never
   * written again.
   */
  keyIngredientIds?: string[];
}

export interface KeyIngredientChoice {
  ingredientId: string;
  name: string;
  /** A key item now (ingredients.count_weekly). */
  key: boolean;
  /** The till suggests it by its name (cheese, chicken, patties, dough, flour, oil, boxes). */
  suggested: boolean;
}

export interface CostAlertSettingsView {
  jumpBps: number;
  impactWeekCents: number;
  ingredients: KeyIngredientChoice[];
  /** Nothing saved yet: the key ingredients are the till's suggestions. */
  keysSuggested: boolean;
  /** When the thresholds were last saved (ISO); null = never. */
  savedAt: string | null;
}

/**
 * What the Targets tab saves (costing:setAlertSettings): the thresholds
 * (business setting 'costing.alerts') and the key items, which are written
 * onto the ingredients (count_weekly) in the same transaction.
 */
export interface SetCostAlertSettingsRequest {
  jumpBps: number;
  impactWeekCents: number;
  keyIngredientIds: string[];
}

/** One dish a price change moved, and what that costs per week at this till's sales. */
export interface CostAlertItemMove {
  menuItemId: string;
  name: string;
  /** The typical price (as on Menu costs). */
  priceCents: number;
  costBeforeCents: number;
  costAfterCents: number;
  foodCostBeforeBps: number | null;
  foodCostAfterBps: number | null;
  /** Units sold in the 28 days the week's figure comes from (a week is a quarter of it). */
  soldLast28: number;
  /** (cost after − cost before) × a week's units: above 0 costs you, below 0 saves. */
  impactWeekCents: number;
  /** The weekly digest only: its band before and after (green / amber / red). */
  flagBefore?: FoodCostFlag;
  flagAfter?: FoodCostFlag;
  targetBps?: number;
}

/** A price as an alert shows it: one base unit, in millicents (per gram, it reads as paisa per kg). */
export interface CostAlertPrice {
  unitCostMc: number;
  priceKind: PriceKind;
}

/** 'price_jump': which ingredient moved, by how much, and which dishes it moved. */
export interface PriceJumpAlert {
  kind: 'price_jump';
  ingredientId: string;
  ingredientName: string;
  unit: string;
  before: CostAlertPrice;
  after: CostAlertPrice;
  /** After against before, basis points (+1,800 = 18% dearer); null when there was nothing to compare with. */
  changeBps: number | null;
  /** Where the new price came from ('delivery', 'manual'…). */
  source: string;
  /** It is a key ingredient, or a key batch made from it moved (the jump rule fired). */
  key: boolean;
  /** Key batches made from it that moved with it (Cheese Mix after mozzarella). */
  keyBatches: Array<{ ingredientId: string; name: string; unit: string; before: CostAlertPrice; after: CostAlertPrice; changeBps: number | null }>;
  /** The dishes it moved, most per week first (at most 25). */
  items: CostAlertItemMove[];
  /** How many dishes it moved in all. */
  itemsMoved: number;
}

/** 'batch_unpriced_input': a batch made here kept its old price. */
export interface BatchUnpricedAlert {
  kind: 'batch_unpriced_input';
  ingredientId: string;
  ingredientName: string;
  unit: string;
  unpricedInputs: Array<{ ingredientId: string; name: string }>;
  /** The price it kept (its own stored price); null when it has none. */
  kept: CostAlertPrice | null;
  /** What set it off: the menu file, or a price change of something in it. */
  because: 'import' | 'price';
  /** The ingredient whose price changed, for 'price'. */
  changedName: string | null;
}

/** 'weekly_digest': dishes whose food cost moved across their target this week because of prices. */
export interface WeeklyDigestAlert {
  kind: 'weekly_digest';
  /** The Monday (trading day, YYYY-MM-DD) the digest is for. */
  weekOf: string;
  /** The Monday of the digest it compares with; null for the first. */
  sinceWeekOf: string | null;
  changes: CostAlertItemMove[];
}

export type CostAlertDetail = PriceJumpAlert | BatchUnpricedAlert | WeeklyDigestAlert;

export interface CostAlert {
  id: string;
  kind: CostAlertKind;
  createdAt: string;
  seenAt: string | null;
  seenByName: string | null;
  /** What it costs per week at this till's sales (below 0 saves); 0 when not known. */
  impactWeekCents: number;
  /** Null when the alert was written by a newer till in a shape this one can't read. */
  detail: CostAlertDetail | null;
}

export interface CostAlertsView {
  /** Not seen yet first, then seen; newest first within each. */
  alerts: CostAlert[];
  unseen: number;
}
