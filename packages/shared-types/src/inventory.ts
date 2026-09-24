/**
 * Inventory domain types. Quantities are integers in the ingredient's declared
 * `unit` (e.g. unit='g' → qty 200 means 200 grams). No floats — exact arithmetic.
 */

import type { UUID } from './ids.js';

export interface Ingredient {
  id: UUID;
  name: string;
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
