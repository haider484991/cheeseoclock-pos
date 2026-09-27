/**
 * Inventory domain types. Quantities are integers in the ingredient's declared
 * `unit` (e.g. unit='g' → qty 200 means 200 grams). No floats — exact arithmetic.
 */

import type { UUID } from './ids.js';

/**
 * The shelves an ingredient sits on (owner 2026-09-26). Labels and the
 * name-based guess live in pos-domain (`ingredient-category.ts`).
 */
export const INGREDIENT_CATEGORY_IDS = [
  'dough',
  'cheese',
  'meat',
  'veg',
  'sauce',
  'spice',
  'dry',
  'drinks',
  'packaging',
  'other',
] as const;
export type IngredientCategory = (typeof INGREDIENT_CATEGORY_IDS)[number];

/**
 * What an ingredient's price is (costing spec D1, migration 0032):
 *  - 'set': a real price (typed, from a bill or the costing sheet);
 *  - 'estimate': a known guess ("breading, about Rs 15");
 *  - 'free': it really costs nothing (Rs 0 is its price, not a gap);
 *  - 'unset': nobody has priced it yet. The ONLY "missing price" marker:
 *    it is listed under Costing -> Missing costs, and the items using it
 *    show "can't cost yet".
 */
export const PRICE_KINDS = ['set', 'estimate', 'free', 'unset'] as const;
export type PriceKind = (typeof PRICE_KINDS)[number];

/**
 * Where a price in the price history came from (costing spec 0034,
 * ingredient_costs.source):
 *  - 'seed':     the price the ingredient had when price history started on
 *                this till (one row each, written once);
 *  - 'manual':   typed by a manager or the owner;
 *  - 'delivery': a purchase order received at its bill;
 *  - 'purchase': a purchase recorded on the spot (Phase 5);
 *  - 'import':   the costing sheet, through the menu file;
 *  - 'batch':    a sauce, dough or mix made here, rolled up from its inputs;
 *  - 'convert':  the same price, re-kept in grams / ml after a Convert.
 */
export const PRICE_SOURCES = ['seed', 'manual', 'delivery', 'purchase', 'import', 'batch', 'convert'] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

/**
 * How a price is typed on the "Set price" dialog (costing spec 4.1):
 *  - 'thousand': Rs X per kg (grams) or per litre (ml) → a pack of 1,000;
 *  - 'pack':     Rs X for a pack of N base units → a pack of N;
 *  - 'piece':    Rs X per piece (or slice, portion…) → a pack of 1.
 */
export const TYPED_PRICE_PERS = ['thousand', 'pack', 'piece'] as const;
export type TypedPricePer = (typeof TYPED_PRICE_PERS)[number];

/** One entry of an ingredient's price history (ingredient_costs), as the Price history drawer shows it. */
export interface PriceHistoryEntry {
  id: UUID;
  ingredientId: UUID;
  /**
   * When this price came in. A starting price ('seed') is in force from the
   * very start, so it carries the start of time (1970-01-01): it always
   * comes first, whichever till wrote it and when (see `recordedAt`).
   */
  effectiveAt: string;
  /** When this entry was written on this till (for a starting price: when price history began). */
  recordedAt: string;
  /** The ingredient's unit when it was written (a Convert adds a row in the new unit). */
  unit: string;
  /** Exactly as bought: `packSize` base units for `packPriceCents` paisa. */
  packSize: number;
  packPriceCents: number;
  priceKind: PriceKind;
  /** One base unit's price in millicents (per gram, it reads as paisa per kg). */
  unitCostMc: number;
  /** The price it replaced, per base unit of THIS entry's unit; null when there was none. */
  prevUnitCostMc: number | null;
  source: PriceSource;
  supplierId: UUID | null;
  supplierName: string | null;
  purchaseOrderId: UUID | null;
  purchaseOrderRef: string | null;
  actorUserId: UUID | null;
  actorName: string | null;
  notes: string | null;
}

/** The newest price history entry of an ingredient, for the Ingredients list's price column. */
export interface IngredientPriceTag {
  source: PriceSource;
  effectiveAt: string;
  unit: string;
  packSize: number;
  packPriceCents: number;
  priceKind: PriceKind;
  unitCostMc: number;
  prevUnitCostMc: number | null;
}

export interface Ingredient {
  id: UUID;
  name: string;
  /** The category chosen by a manager, or — when `categoryAuto` — guessed from the name. */
  category: IngredientCategory;
  /** True while nobody has picked a category: it follows the name (a rename re-guesses). */
  categoryAuto: boolean;
  unit: string;
  currentQty: number;
  lowThreshold: number;
  costPerUnitCents: number;
  /** Bought as a pack of this many base units (null = cost entered per unit). */
  packSize: number | null;
  /** Price of one such pack, in paisa. */
  packPriceCents: number | null;
  /** Whether that price is real, a guess, a true Rs 0, or not known yet. */
  priceKind: PriceKind;
  /** Made in-house: one batch yields this many base units (null = bought in). */
  batchYield: number | null;
  /** How to make a batch (free text). */
  batchMethod: string | null;
  defaultSupplierId: UUID | null;
  sku: string | null;
  notes: string | null;
  isActive: boolean;
  /**
   * The newest entry of its price history (where the price came from, and
   * the price before it). Only on the Ingredients list
   * (inventory:listIngredients, costs: COST_CAPABILITY); null when it has
   * no history yet.
   */
  latestPrice?: IngredientPriceTag | null;
  /**
   * Made here and every input has a price: its price is worked out from its
   * batch recipe (costing spec D4), so "Set price" does not apply to it.
   * Only on the Ingredients list, like `latestPrice`.
   */
  priceFromRecipe?: boolean;
  /**
   * What the costing sheet (the menu file) says it costs — a reference only,
   * never used for costing unless "Use the sheet's price" is tapped (costing
   * spec Phase 6, D4). Only on the Ingredients list, like `latestPrice`;
   * null when no menu file has named it.
   */
  sheetPrice?: SheetPrice | null;
}

/**
 * The costing sheet's price for an ingredient, exactly as the menu file gave
 * it (ingredients.sheet_*, migration 0036): `packSize` base units for
 * `packPriceCents` paisa ((1, its cost per unit) when the file gave no pack).
 */
export interface SheetPrice {
  packSize: number;
  packPriceCents: number;
  /** 'set', 'estimate' (the sheet says it is a guess) or 'unset' (the sheet says Rs 0). */
  priceKind: PriceKind;
  /** One base unit, millicents. */
  unitCostMc: number;
  /** When this figure came in (the import that brought it). */
  at: string;
}

export interface Recipe {
  id: UUID;
  menuItemId: UUID;
  ingredientId: UUID;
  qtyPerUnit: number;
  /** Only used when this modifier (a choice at the till) is on the order line; null = always. */
  modifierId: UUID | null;
}

/** One input of a batch recipe, with what it costs now. */
export interface BatchRecipeLine {
  inputIngredientId: UUID;
  name: string;
  unit: string;
  qty: number;
  costPerUnitCents: number;
  /** The input's price as costing uses it (rolled up when it is made in-house too). */
  priceKind: PriceKind;
  /** The input is itself made in-house: its price is rolled up from its own inputs. */
  madeInHouse: boolean;
}

export interface BatchRecipe {
  ingredientId: UUID;
  batchYield: number | null;
  batchMethod: string | null;
  lines: BatchRecipeLine[];
  /**
   * What one batch costs at today's input prices, in paisa, rolled up
   * through inputs that are made in-house too (costing spec 4.1). An input
   * with no price adds nothing: see `complete`.
   */
  batchCostCents: number;
  /** Every input has a price (none 'unset'): the rolled-up cost is the batch's price. */
  complete: boolean;
  /** Inputs with no price yet (names): they keep the roll-up from being complete. */
  unpricedInputs: string[];
  /**
   * The price stored on the ingredient itself for one batch (typed, or the
   * costing sheet's figure from the menu import), shown beside the roll-up.
   * Null when nothing is stored.
   */
  storedBatchCostCents: number | null;
}

export interface Supplier {
  id: UUID;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
}

export type StockMovementReason =
  | 'sale'
  | 'delivery'
  | 'waste'
  | 'count'
  | 'transfer'
  | 'adjustment';

/**
 * How a stock row was valued when it was written (costing spec 0033,
 * stock_movements.cost_basis):
 *  - 'price': the ingredient's price at the time (a batch item at its
 *    rolled-up price);
 *  - 'bill':  a delivery, at its purchase order line's price;
 *  - 'take':  copied from what the order took (a put-back or cancelled-food
 *    row settles at the ORIGINAL cost, whatever the price is now);
 *  - 'batch': what a batch made, valued at the inputs it used;
 *  - 'count': a stock take, at the price at the time;
 *  - 'none':  the ingredient had no price (the value is Rs 0).
 * A row written before costing started has no basis and no value.
 */
export const COST_BASES = ['price', 'bill', 'take', 'batch', 'count', 'none'] as const;
export type CostBasis = (typeof COST_BASES)[number];

/** Why food was thrown away, as the owner picks it on the Waste screen. */
export const WASTE_REASONS = ['burnt', 'dropped', 'expired', 'wrong_order', 'returned', 'staff_meal', 'other'] as const;
export type WasteReason = (typeof WASTE_REASONS)[number];

/**
 * What a stock row stands for beyond its reason (stock_movements.detail,
 * checked here rather than by a table CHECK, costing spec D9):
 *  - batch_in / batch_out: an input used by a batch, and what the batch made;
 *  - waste:<reason>: waste booked by hand, with why;
 *  - cancel_made: a cancelled / refunded order's food that was made (its
 *    sale undone and booked as waste);
 *  - cancel_put_back: a cancelled / refunded order's stock put back;
 *  - stock_take / correction: counted on the shelf, or a fix by hand.
 */
export const MOVEMENT_DETAILS = [
  'batch_in',
  'batch_out',
  'waste:burnt',
  'waste:dropped',
  'waste:expired',
  'waste:wrong_order',
  'waste:returned',
  'waste:staff_meal',
  'waste:other',
  'cancel_made',
  'cancel_put_back',
  'stock_take',
  'correction',
] as const;
export type MovementDetail = (typeof MOVEMENT_DETAILS)[number];

export interface StockMovement {
  id: UUID;
  ingredientId: UUID;
  deltaQty: number;
  reason: StockMovementReason;
  refOrderId: UUID | null;
  refPurchaseOrderId: UUID | null;
  notes: string | null;
  actorUserId: UUID | null;
  occurredAt: string;
  resultingQty: number;
  /** What the row stands for beyond its reason (a waste reason, a batch…); null when plain. */
  detail?: MovementDetail | null;
  /**
   * What the row was worth when written, SIGNED like deltaQty (paisa), the
   * price of one unit (millicents) and how it was valued. Null on rows from
   * before costing started. Costs: left out altogether for a login without
   * COST_CAPABILITY.
   */
  valueCents?: number | null;
  unitCostMc?: number | null;
  costBasis?: CostBasis | null;
}

/** A movement as the history screen shows it: names resolved, even for a deleted ingredient. */
export interface StockMovementEntry extends StockMovement {
  ingredientName: string;
  unit: string;
  /** Who recorded it (null for the till's own sales bookkeeping when no one was signed in). */
  actorName: string | null;
  /** The order's number when the movement came from a sale. */
  orderNumber: string | null;
  /** The purchase order's reference when the movement came from a delivery. */
  purchaseOrderRef: string | null;
}

/** Filters for the movement history. Every field optional; `offset`/`limit` page it. */
export interface StockMovementSearch {
  /** Words to find in the ingredient name or the note. */
  search?: string;
  reason?: StockMovementReason;
  ingredientId?: string;
  sinceIso?: string;
  untilIso?: string;
  offset?: number;
  limit?: number;
}

export interface StockMovementPage {
  rows: StockMovementEntry[];
  /** Matches for every filter, before paging. */
  total: number;
  /** Matches per reason for the same filters except `reason` (for the filter chip counts). */
  reasonCounts: Partial<Record<StockMovementReason, number>>;
}

export type PurchaseOrderStatus =
  | 'draft'
  | 'ordered'
  | 'partial'
  | 'received'
  | 'cancelled';

/**
 * What a purchase is (costing spec Phase 5, migration 0035):
 *  - 'order': a purchase order placed with a supplier, received later;
 *  - 'quick': a purchase recorded on the spot ("Record a purchase": a market
 *    run, a bill paid at the door, a drawer payout turned into a purchase),
 *    received as it is written.
 */
export const PURCHASE_KINDS = ['order', 'quick'] as const;
export type PurchaseKind = (typeof PURCHASE_KINDS)[number];

export interface PurchaseOrder {
  id: UUID;
  /** Null for a purchase with no supplier on file (a market run). */
  supplierId: UUID | null;
  referenceNo: string | null;
  status: PurchaseOrderStatus;
  orderedAt: string | null;
  expectedAt: string | null;
  receivedAt: string | null;
  totalCents: number;
  notes: string | null;
  createdByUserId: UUID;
  receivedByUserId: UUID | null;
  /** The supplier's bill number, when one was typed. */
  invoiceNo: string | null;
  kind: PurchaseKind;
  /**
   * What its bills came to so far: the lines' received value, paisa. For a
   * quick purchase it is its total; for a purchase order it is what was
   * billed for what came, which may differ from what was ordered
   * (`totalCents`). 0 while nothing has come in.
   */
  billedCents: number;
}

export interface PurchaseOrderItem {
  id: UUID;
  purchaseOrderId: UUID;
  ingredientId: UUID;
  qtyOrdered: number;
  qtyReceived: number;
  /** Whole paisa per base unit, for older screens only: the exact price is the ordered pack. */
  unitCostCents: number;
  lineTotalCents: number;
  notes: string | null;
  /**
   * The price the line was ordered at, exactly as typed: `orderedPackSize`
   * base units for `orderedPackPriceCents` ("1,000 g for Rs 375"). Null on
   * lines written before costing Phase 5: they are priced per unit at
   * `unitCostCents`.
   */
  orderedPackSize: number | null;
  orderedPackPriceCents: number | null;
  /** What the bills said for everything received on this line so far, paisa. */
  receivedValueCents: number;
}

/** A drawer payout linked to a purchase: the cash that paid for it. */
export interface PurchasePayout {
  cashMovementId: UUID;
  shiftId: UUID;
  amountCents: number;
  reason: string;
  createdAt: string;
}

/** Convenience: a PO with its line items expanded. */
export interface PurchaseOrderWithItems extends PurchaseOrder {
  items: PurchaseOrderItem[];
  /** The drawer payout that paid for it, when it was paid from the drawer. */
  payout?: PurchasePayout | null;
}

/**
 * A purchase recorded (costing spec Phase 5): the purchase itself, whose
 * prices became the ingredients' prices (D1's guard), and the drawer payout
 * written with it, if any.
 */
export interface RecordPurchaseResult {
  purchase: PurchaseOrderWithItems;
  /** Ingredients whose price is now the one on this bill. */
  pricesUsed: UUID[];
  /** Ingredients whose price was kept although this bill's differs (the stock still came in at the bill). */
  pricesKept: UUID[];
}

/**
 * A cash payout from a drawer, for "Turn this payout into a purchase"
 * (costing spec Phase 5): recent payouts on this till, with the purchase each
 * is already linked to (null = still a free-text payout).
 */
export interface DrawerPayout {
  id: UUID;
  shiftId: UUID;
  amountCents: number;
  reason: string;
  createdAt: string;
  userName: string | null;
  approvedByName: string | null;
  refPurchaseOrderId: UUID | null;
}
