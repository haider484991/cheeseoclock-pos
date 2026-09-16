import { z } from 'zod';
import { centsSchema } from './common.js';

/**
 * Inventory quantities are whole numbers of the ingredient's base unit
 * (g / ml / pcs) and money is cents — both `INTEGER` columns. A fractional
 * value would reach SQLite as REAL and quietly corrupt stock math, so every
 * quantity or cents field that crosses IPC is checked here first.
 */
const wholeUnits = z
  .number()
  .int({ message: 'Quantity must be a whole number of base units (g / ml / pcs)' });

/** Stock on hand or a reorder threshold: zero or more whole units. */
export const stockQtySchema = wholeUnits.nonnegative({ message: 'Quantity cannot be negative' });
/** A line quantity (ordered, received, per recipe): at least one whole unit. */
export const lineQtySchema = wholeUnits.positive({ message: 'Quantity must be at least 1' });
/** A signed stock movement in whole units. */
export const movementQtySchema = wholeUnits;

const idSchema = z.string().min(1);
const nullableText = z.string().nullable().optional();

export const createIngredientInputSchema = z.object({
  name: z.string().min(1),
  unit: z.string().min(1),
  currentQty: stockQtySchema.optional(),
  lowThreshold: stockQtySchema.optional(),
  costPerUnitCents: centsSchema.optional(),
  defaultSupplierId: nullableText,
  sku: nullableText,
  notes: nullableText,
});

export const updateIngredientInputSchema = z.object({
  id: idSchema,
  name: z.string().min(1).optional(),
  unit: z.string().min(1).optional(),
  lowThreshold: stockQtySchema.optional(),
  costPerUnitCents: centsSchema.optional(),
  defaultSupplierId: nullableText,
  sku: nullableText,
  notes: nullableText,
  isActive: z.boolean().optional(),
});

export const setRecipeInputSchema = z.object({
  menuItemId: idSchema,
  lines: z.array(z.object({ ingredientId: idSchema, qtyPerUnit: lineQtySchema })),
});

export const recordMovementInputSchema = z.object({
  ingredientId: idSchema,
  deltaQty: movementQtySchema,
  reason: z.enum(['delivery', 'waste', 'count', 'adjustment']),
  notes: nullableText,
});

export const createPurchaseOrderInputSchema = z.object({
  supplierId: idSchema,
  referenceNo: nullableText,
  expectedAt: nullableText,
  notes: nullableText,
  items: z
    .array(
      z.object({
        ingredientId: idSchema,
        qtyOrdered: lineQtySchema,
        unitCostCents: centsSchema,
        notes: nullableText,
      }),
    )
    .min(1, { message: 'Purchase order needs at least one line item' }),
});

export const receiveDeliveryInputSchema = z.object({
  purchaseOrderId: idSchema,
  receipts: z.array(
    z.object({ purchaseOrderItemId: idSchema, qtyReceivedNow: lineQtySchema }),
  ),
  updateCosts: z.boolean().optional(),
});
