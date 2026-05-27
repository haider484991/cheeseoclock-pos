import { z } from 'zod';
import { uuidSchema, centsSchema } from './common.js';

export const orderModeSchema = z.enum(['dine_in', 'takeaway', 'delivery', 'online']);
export const orderStatusSchema = z.enum([
  'open',
  'sent_to_kitchen',
  'ready',
  'served',
  'paid',
  'void',
  'refunded',
]);
export const paymentMethodSchema = z.enum([
  'cash',
  'card',
  'easypaisa',
  'jazzcash',
  'bank_transfer',
]);
export const kitchenStatusSchema = z.enum(['pending', 'preparing', 'ready', 'served']);

/** Input to start a new order on the POS. */
export const createOrderInputSchema = z.object({
  mode: orderModeSchema,
  tableId: uuidSchema.nullable().optional(),
  customerId: uuidSchema.nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

/** Adding a line item to an open order. Snapshots happen server-side. */
export const addOrderItemInputSchema = z.object({
  orderId: uuidSchema,
  menuItemId: uuidSchema.nullable(),
  comboId: uuidSchema.nullable(),
  parentOrderItemId: uuidSchema.nullable().optional(),
  quantity: z.number().int().min(1),
  modifierIds: z.array(uuidSchema).default([]),
  notes: z.string().max(500).nullable().optional(),
});

export const applyDiscountInputSchema = z.object({
  orderId: uuidSchema,
  discountType: z.enum(['percent', 'flat']),
  value: z.number().min(0),
  reason: z.string().max(500).nullable().optional(),
  approverPin: z.string().regex(/^\d{4,8}$/).optional(),
});

export const tenderInputSchema = z.object({
  orderId: uuidSchema,
  payments: z
    .array(
      z.object({
        method: paymentMethodSchema,
        amountCents: centsSchema,
        tenderedCents: centsSchema.nullable().optional(),
        referenceNo: z.string().max(80).nullable().optional(),
      }),
    )
    .min(1),
});

export const voidOrderInputSchema = z.object({
  orderId: uuidSchema,
  reason: z.string().min(1).max(500),
  approverPin: z.string().regex(/^\d{4,8}$/),
});

export type CreateOrderInput = z.infer<typeof createOrderInputSchema>;
export type AddOrderItemInput = z.infer<typeof addOrderItemInputSchema>;
export type ApplyDiscountInput = z.infer<typeof applyDiscountInputSchema>;
export type TenderInput = z.infer<typeof tenderInputSchema>;
export type VoidOrderInput = z.infer<typeof voidOrderInputSchema>;
