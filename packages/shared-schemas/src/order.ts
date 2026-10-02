import { z } from 'zod';
import { uuidSchema, centsSchema } from './common.js';
import { signInSecretSchema } from './auth.js';

export const orderModeSchema = z.enum(['dine_in', 'takeaway', 'delivery', 'online', 'foodpanda']);
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
  'foodpanda',
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
  /** A manager's PIN or password (same rules as sign-in). */
  approverPin: signInSecretSchema.optional(),
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

/** "Was the food made?" when an order that took stock is cancelled or refunded in full. */
export const foodMadeSchema = z.enum(['made', 'not_made']);

/** An id the till stores (orders, menu items, choices): a short, plain string. */
const tillIdSchema = z.string().min(1).max(64);

/**
 * One change of an Edit order (v0.7.36; shared-types OrderEditOp). `lineId`
 * of a new line is made by the screen: a UUID.
 */
export const orderEditOpSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('add'),
      lineId: uuidSchema,
      menuItemId: tillIdSchema,
      quantity: z.number().int().min(1).max(999),
      modifierIds: z.array(tillIdSchema).max(60),
      notes: z.string().max(300).nullable().optional(),
    })
    .strict(),
  z.object({ op: z.literal('qty'), orderItemId: tillIdSchema, quantity: z.number().int().min(0).max(999) }).strict(),
  z.object({ op: z.literal('remove'), orderItemId: tillIdSchema }).strict(),
  z
    .object({
      op: z.literal('options'),
      orderItemId: tillIdSchema,
      modifierIds: z.array(tillIdSchema).max(60),
      notes: z.string().max(300).nullable(),
    })
    .strict(),
  z
    .object({
      op: z.literal('discount'),
      discountType: z.enum(['percent', 'flat']),
      value: z.number().min(0),
      reason: z.string().max(500).nullable().optional(),
      free: z.boolean().optional(),
    })
    .strict(),
  z.object({ op: z.literal('clearDiscount') }).strict(),
]);

/** orders:previewEdit — nothing is written. At most 200 changes in one edit. */
export const previewEditInputSchema = z.object({ orderId: tillIdSchema, ops: z.array(orderEditOpSchema).max(200) }).strict();

/** orders:saveEdit — the edit, the order it was worked on, and Save's answers. */
export const saveEditInputSchema = z
  .object({
    orderId: tillIdSchema,
    baseKey: z.string().min(1).max(100),
    ops: z.array(orderEditOpSchema).min(1).max(200),
    /** A manager's PIN or password (same rules as sign-in), when Save asks for one. */
    approverPin: signInSecretSchema.optional(),
    reason: z.string().max(500).nullable().optional(),
    foodMade: z.record(tillIdSchema, foodMadeSchema).optional(),
  })
  .strict();

/** Every order status, for "the status the dialog showed" (orderStatusSchema above predates the board's). */
export const liveOrderStatusSchema = z.enum([
  'open',
  'sent_to_kitchen',
  'preparing',
  'ready',
  'out_for_delivery',
  'delivered',
  'served',
  'paid',
  'void',
  'refunded',
]);

/**
 * The stock half of a cancel or a full refund (shared-types OrderStockAnswer):
 * the answer, the sealed drinks going back, and the status the dialog showed.
 */
export const orderStockAnswerSchema = z.object({
  foodMade: foodMadeSchema.optional(),
  putBack: z.array(z.string().min(1).max(64)).max(200).optional(),
  expectStatus: liveOrderStatusSchema.optional(),
});

export const voidOrderInputSchema = z
  .object({
    orderId: uuidSchema,
    reason: z.string().min(1).max(500),
    /** A manager's PIN or password (same rules as sign-in). */
    approverPin: signInSecretSchema,
  })
  .merge(orderStockAnswerSchema);

export type CreateOrderInput = z.infer<typeof createOrderInputSchema>;
export type AddOrderItemInput = z.infer<typeof addOrderItemInputSchema>;
export type ApplyDiscountInput = z.infer<typeof applyDiscountInputSchema>;
export type TenderInput = z.infer<typeof tenderInputSchema>;
export type VoidOrderInput = z.infer<typeof voidOrderInputSchema>;
