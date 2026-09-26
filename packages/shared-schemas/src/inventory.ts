import { z } from 'zod';
import { INGREDIENT_CATEGORY_IDS } from '@cheeseoclock/shared-types';
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
/** A shelf from the fixed list; null = guess it from the name. */
const ingredientCategorySchema = z.enum(INGREDIENT_CATEGORY_IDS).nullable().optional();

export const createIngredientInputSchema = z.object({
  name: z.string().trim().min(1, { message: 'Give the ingredient a name' }),
  category: ingredientCategorySchema,
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
  name: z.string().trim().min(1, { message: 'Give the ingredient a name' }).optional(),
  category: ingredientCategorySchema,
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

/**
 * A batch recipe is a yield AND at least one input — or neither (no yield, no
 * inputs = bought in again). A yield with nothing in it is not a recipe.
 */
export const setBatchRecipeInputSchema = z
  .object({
    ingredientId: idSchema,
    batchYield: wholeUnits.positive({ message: 'A batch must make at least 1 unit' }).nullable(),
    batchMethod: z.string().max(4000).nullable().optional(),
    lines: z.array(z.object({ inputIngredientId: idSchema, qty: lineQtySchema })).max(100),
  })
  .refine((r) => (r.batchYield === null) === (r.lines.length === 0), {
    message: 'A batch recipe needs both how much it makes and at least one ingredient',
    path: ['lines'],
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

/** The movement history screen's filters; the repository clamps the page size too. */
export const searchMovementsInputSchema = z.object({
  search: z.string().max(200).optional(),
  reason: z.enum(['sale', 'delivery', 'waste', 'count', 'transfer', 'adjustment']).optional(),
  ingredientId: idSchema.optional(),
  sinceIso: z.string().max(40).optional(),
  untilIso: z.string().max(40).optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(200).optional(),
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

export const setPurchaseOrderStatusInputSchema = z.object({
  id: idSchema,
  status: z.enum(['draft', 'ordered', 'partial', 'received', 'cancelled']),
});

const supplierFields = {
  contactPerson: nullableText,
  phone: nullableText,
  email: nullableText,
  address: nullableText,
  notes: nullableText,
};

export const createSupplierInputSchema = z.object({
  name: z.string().trim().min(1, { message: 'Give the supplier a name' }),
  ...supplierFields,
});

export const updateSupplierInputSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1, { message: 'Give the supplier a name' }).optional(),
  ...supplierFields,
  isActive: z.boolean().optional(),
});
