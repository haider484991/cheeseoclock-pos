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
/** How many base units one pack holds: a whole number, at least 1. */
const packSizeSchema = wholeUnits.positive({ message: 'Pack size must be at least 1' });
const nullableText = z.string().nullable().optional();

export const createIngredientInputSchema = z.object({
  name: z.string().min(1),
  unit: z.string().min(1),
  currentQty: stockQtySchema.optional(),
  lowThreshold: stockQtySchema.optional(),
  costPerUnitCents: centsSchema.optional(),
  packSize: packSizeSchema.nullable().optional(),
  packPriceCents: centsSchema.nullable().optional(),
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
  packSize: packSizeSchema.nullable().optional(),
  packPriceCents: centsSchema.nullable().optional(),
  defaultSupplierId: nullableText,
  sku: nullableText,
  notes: nullableText,
  isActive: z.boolean().optional(),
});

/** Switch an ingredient counted in kg / litres to grams / ml (stock and recipes ×1000). */
export const convertIngredientUnitInputSchema = z.object({ id: idSchema });

export const setRecipeInputSchema = z.object({
  menuItemId: idSchema,
  lines: z.array(
    z.object({ ingredientId: idSchema, qtyPerUnit: lineQtySchema, modifierId: idSchema.nullable().optional() }),
  ),
});

export const setBatchRecipeInputSchema = z.object({
  ingredientId: idSchema,
  batchYield: wholeUnits.positive({ message: 'A batch must make at least 1 unit' }).nullable(),
  batchMethod: z.string().max(4000).nullable().optional(),
  lines: z.array(z.object({ inputIngredientId: idSchema, qty: lineQtySchema })).max(100),
});

export const makeBatchInputSchema = z.object({
  ingredientId: idSchema,
  batches: z.number().int().min(1, { message: 'At least one batch' }).max(100),
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
