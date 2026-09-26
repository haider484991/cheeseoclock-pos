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
  /** Made in-house: one batch yields this many base units (null = bought in). */
  batchYield: number | null;
  /** How to make a batch (free text). */
  batchMethod: string | null;
  defaultSupplierId: UUID | null;
  sku: string | null;
  notes: string | null;
  isActive: boolean;
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
}

export interface BatchRecipe {
  ingredientId: UUID;
  batchYield: number | null;
  batchMethod: string | null;
  lines: BatchRecipeLine[];
  /** What one batch costs at today's input costs, in paisa. */
  batchCostCents: number;
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

export interface PurchaseOrder {
  id: UUID;
  supplierId: UUID;
  referenceNo: string | null;
  status: PurchaseOrderStatus;
  orderedAt: string | null;
  expectedAt: string | null;
  receivedAt: string | null;
  totalCents: number;
  notes: string | null;
  createdByUserId: UUID;
  receivedByUserId: UUID | null;
}

export interface PurchaseOrderItem {
  id: UUID;
  purchaseOrderId: UUID;
  ingredientId: UUID;
  qtyOrdered: number;
  qtyReceived: number;
  unitCostCents: number;
  lineTotalCents: number;
  notes: string | null;
}

/** Convenience: a PO with its line items expanded. */
export interface PurchaseOrderWithItems extends PurchaseOrder {
  items: PurchaseOrderItem[];
}
