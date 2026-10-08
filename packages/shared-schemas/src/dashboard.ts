import { z } from 'zod';
import {
  DASH_DISPLAY_NAME_MAX,
  DASH_PUSH_MAX_ORDERS,
  DASH_PUSH_MAX_ROWS,
  DASH_ROLES,
  DASH_USERNAME_RE,
  type DashLoginAction,
  type DashPushBody,
} from '@cheeseoclock/shared-types';

/**
 * The wire of the owner's phone dashboard (shared-types dashboard.ts): what a
 * till sends the website (BRIDGE_SECRET) and what the dashboard's own pages
 * post. The website (package subpath `@cheeseoclock/shared-schemas/dashboard`)
 * and the till validate with these; nothing here but zod and shared-types.
 *
 * Sign-in requests are strict (an unknown field is refused). A push is not:
 * a newer till may carry fields an older website doesn't know, and the
 * website keeps what it knows rather than refusing the till's figures.
 * Every string and list has a ceiling, so one bad push can't fill the
 * database.
 */

const HEX64 = /^[0-9a-f]{64}$/;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const iso = z.string().datetime({ offset: true });
const id = z.string().min(1).max(64);
const text = (max: number) => z.string().max(max);
const optText = (max: number) => z.string().max(max).nullable();
const int = z.number().int();
const cents = int.min(-1_000_000_000).max(1_000_000_000);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Which till is asking (every till request carries these). */
export const dashDeviceFieldsSchema = z.object({
  deviceId: z.string().min(1).max(100),
  deviceName: z.string().max(200).nullable(),
  appVersion: z.string().max(40),
  /** The owner who pressed it on the till (for the website's history). */
  actorName: z.string().max(80).nullable(),
});

const displayName = z
  .string()
  .trim()
  .min(1)
  .max(DASH_DISPLAY_NAME_MAX)
  .refine((s) => !CONTROL_CHARS.test(s), { message: 'no control characters' });
const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(DASH_USERNAME_RE, '3–32 letters, numbers, dots, dashes or underscores');
const role = z.enum(DASH_ROLES);

const loginActionSchema: z.ZodType<DashLoginAction> = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), username, displayName, role, seesReports: z.boolean(), setupCodeHash: z.string().regex(HEX64) }).strict(),
  z.object({ action: z.literal('update'), id: z.string().uuid(), displayName, role, seesReports: z.boolean() }).strict(),
  z.object({ action: z.literal('newCode'), id: z.string().uuid(), setupCodeHash: z.string().regex(HEX64) }).strict(),
  z.object({ action: z.literal('signOutAll'), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('remove'), id: z.string().uuid() }).strict(),
]);

/** POST /api/bridge/dashboard/logins: one change to the list, and who made it. */
export const dashLoginsBodySchema = z
  .object({ change: loginActionSchema })
  .merge(dashDeviceFieldsSchema)
  .strict();
export type DashLoginsBody = z.infer<typeof dashLoginsBodySchema>;

const loginViewSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  role,
  seesReports: z.boolean(),
  hasPassword: z.boolean(),
  setupPending: z.boolean(),
  setupExpiresAt: z.string().nullable(),
  lastSignInAt: z.string().nullable(),
  signedInPhones: z.number().int(),
  createdAt: z.string(),
});

/** The website's answer to GET and POST /api/bridge/dashboard/logins (not strict: it may grow). */
export const dashLoginsResponseSchema = z.union([
  z.object({ ok: z.literal(true), data: z.object({ logins: z.array(loginViewSchema) }) }),
  z.object({ ok: z.literal(false), error: z.string(), message: z.string().optional() }),
]);

// ---------------------------------------------------------------------------
// The push
// ---------------------------------------------------------------------------

const status = z.enum([
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
const mode = z.enum(['dine_in', 'takeaway', 'delivery', 'online', 'foodpanda']);
const channel = z.enum(['takeaway', 'delivery', 'web_pickup', 'web_delivery', 'foodpanda', 'dine_in', 'online']);
const cameBy = z.enum(['walk_in', 'phone', 'whatsapp', 'website', 'foodpanda']);
const method = z.enum(['cash', 'card', 'easypaisa', 'jazzcash', 'bank_transfer', 'foodpanda']);

const lineSchema = z.object({
  id,
  name: text(200),
  category: optText(120),
  menuItemId: id.nullable(),
  qty: int.min(0).max(100_000),
  unitPriceCents: cents,
  lineTotalCents: cents,
  choices: z.array(z.object({ name: text(160), priceDeltaCents: cents })).max(60),
  note: optText(500),
  isFee: z.boolean(),
  costCents: cents.nullable(),
});

const orderSchema = z.object({
  id,
  deviceId: id,
  number: text(40),
  status,
  mode,
  source: z.enum(['pos', 'web']),
  channel,
  cameBy: cameBy.nullable(),
  createdAt: iso,
  sentAt: iso.nullable(),
  paidAt: iso.nullable(),
  dispatchedAt: iso.nullable(),
  deliveredAt: iso.nullable(),
  voidedAt: iso.nullable(),
  docUpdatedAt: iso,
  tradingDay: day,
  hour: int.min(0).max(23),
  counted: z.boolean(),
  deleted: z.enum(['test', 'discarded']).nullable(),
  subtotalCents: cents,
  discountCents: cents,
  taxCents: cents,
  totalCents: cents,
  refundedCents: cents,
  netCents: cents,
  digitalTotalCents: cents.nullable(),
  riderKeepsCents: cents.nullable(),
  customer: z
    .object({ name: optText(120), phone: optText(40), address: optText(400), area: optText(120) })
    .nullable(),
  notes: optText(1_000),
  cashier: optText(80),
  rider: optText(80),
  voidedBy: optText(80),
  voidReason: optText(300),
  deletedBy: optText(80),
  deleteReason: optText(300),
  shiftId: id.nullable(),
  lines: z.array(lineSchema).max(200),
  payments: z
    .array(
      z.object({
        id,
        method,
        amountCents: cents,
        tenderedCents: cents.nullable(),
        at: iso,
        by: optText(80),
        shiftId: id.nullable(),
      }),
    )
    .max(50),
  discounts: z
    .array(
      z.object({
        kind: text(20),
        value: z.number().finite(),
        amountCents: cents,
        reason: optText(300),
        source: optText(40),
        by: optText(80),
        approvedBy: optText(80),
        at: iso,
      }),
    )
    .max(20),
  foodpanda: z
    .object({ commissionCents: cents.nullable(), expectedPayoutCents: cents.nullable(), dealLabel: optText(120) })
    .nullable(),
});

const shiftSchema = z.object({
  id,
  deviceId: id,
  openedAt: iso,
  openedBy: optText(80),
  openingCashCents: cents,
  closedAt: iso.nullable(),
  closedBy: optText(80),
  expectedCashCents: cents.nullable(),
  countedCashCents: cents.nullable(),
  varianceCents: cents.nullable(),
  openNote: optText(1_000),
  closeNote: optText(1_000),
  carriedUnpaidCount: int.min(0).max(100_000),
  carryOverReason: optText(500),
  countedNotes: z.unknown(),
  closeReport: z.unknown(),
  updatedAt: iso,
});

const cashMoveSchema = z.object({
  id,
  shiftId: id,
  deviceId: id,
  type: z.enum(['payin', 'payout', 'tip_out']),
  amountCents: cents,
  reason: text(500),
  by: optText(80),
  approvedBy: optText(80),
  orderId: id.nullable(),
  purchase: z.boolean(),
  createdAt: iso,
  deleted: z.boolean(),
  updatedAt: iso,
});

const drawerOpenSchema = z.object({
  id,
  shiftId: id.nullable(),
  deviceId: id,
  kind: text(40),
  reason: optText(500),
  by: optText(80),
  approvedBy: optText(80),
  orderId: id.nullable(),
  amountCents: cents.nullable(),
  outcome: optText(40),
  createdAt: iso,
  updatedAt: iso,
});

const stockItemSchema = z.object({
  id,
  name: text(200),
  unit: text(20),
  category: optText(120),
  onHand: z.number().finite(),
  lowAt: z.number().finite().nullable(),
  pricePerThousandCents: cents.nullable(),
  priceKind: optText(20),
  keyItem: z.boolean(),
  batch: z.boolean(),
  active: z.boolean(),
});

const stockMoveSchema = z.object({
  id,
  deviceId: id,
  ingredientId: id,
  ingredient: text(200),
  delta: z.number().finite(),
  unit: text(20),
  reason: z.enum(['sale', 'delivery', 'waste', 'count', 'transfer', 'adjustment']),
  detail: optText(120),
  valueCents: cents.nullable(),
  orderId: id.nullable(),
  note: optText(500),
  by: optText(80),
  at: iso,
  deleted: z.boolean(),
  updatedAt: iso,
});

const menuSchema = z.object({
  categories: z
    .array(z.object({ id, name: text(120), displayOrder: int, active: z.boolean(), onWebsite: z.boolean() }))
    .max(200),
  items: z
    .array(
      z.object({
        id,
        categoryId: id.nullable(),
        name: text(200),
        priceCents: cents,
        active: z.boolean(),
        web: z.enum(['on', 'pickup_only', 'off']),
        taxRateBps: int.min(0).max(10_000).nullable(),
        sortOrder: int,
        costCents: cents.nullable(),
      }),
    )
    .max(2_000),
  updatedAt: iso,
});

const wasteLine = z.object({ reason: text(80), times: int.min(0), cents });
const dayFiguresSchema = z.object({
  day,
  shopWide: z.boolean(),
  food: z.object({
    foodSalesCents: cents,
    feeSalesCents: cents,
    costOfSalesCents: cents,
    knownSalesCents: cents,
    knownCostCents: cents,
    knownMenuSalesCents: cents,
    estimatedOrders: int.min(0),
    estimatedCostCents: cents,
    missingSalesCents: cents,
    wasteCents: cents,
    cancelledWasteCents: cents,
    wasteByReason: z.array(wasteLine).max(60),
  }),
  profit: z
    .object({
      profitCents: cents,
      steps: z.array(z.object({ key: text(40), cents })).max(40),
      unknownSalesCents: cents,
      estimatedOrders: int.min(0),
    })
    .nullable(),
  purchasesCents: cents,
  workedOutAt: iso,
});

const liveSchema = z.object({
  shift: z
    .object({
      id,
      openedAt: iso,
      openedBy: optText(80),
      openingCashCents: cents,
      cashSalesCents: cents,
      cashRefundsCents: cents,
      cashInCents: cents,
      cashOutCents: cents,
      expectedCashCents: cents,
    })
    .nullable(),
  board: z.object({
    kitchen: int.min(0),
    ready: int.min(0),
    out: int.min(0),
    unpaidHandedOver: int.min(0),
    oldestWaitingSince: iso.nullable(),
  }),
  web: z.object({ linked: z.boolean(), ordersOn: z.boolean(), accepting: z.boolean(), pausedByShift: z.boolean() }),
  notPrinted: int.min(0),
  lowStock: int.min(0),
});

const cursorsSchema = z.object({
  orders: iso.nullable(),
  shifts: iso.nullable(),
  cashMoves: iso.nullable(),
  drawerOpens: iso.nullable(),
  stockMoves: iso.nullable(),
  menu: iso.nullable(),
});

/** POST /api/bridge/dashboard/push. */
export const dashPushBodySchema = z.object({
  v: z.literal(1),
  till: z.object({ deviceId: z.string().min(1).max(100), deviceName: z.string().max(200).nullable(), appVersion: z.string().max(40), sentAt: iso }),
  live: liveSchema,
  orders: z.array(orderSchema).max(DASH_PUSH_MAX_ORDERS).optional(),
  shifts: z.array(shiftSchema).max(DASH_PUSH_MAX_ROWS).optional(),
  cashMoves: z.array(cashMoveSchema).max(DASH_PUSH_MAX_ROWS).optional(),
  drawerOpens: z.array(drawerOpenSchema).max(DASH_PUSH_MAX_ROWS).optional(),
  stockMoves: z.array(stockMoveSchema).max(DASH_PUSH_MAX_ROWS).optional(),
  stock: z.array(stockItemSchema).max(5_000).optional(),
  menu: menuSchema.optional(),
  days: z.array(dayFiguresSchema).max(400).optional(),
  cursors: cursorsSchema,
  caughtUp: z.boolean(),
}) satisfies z.ZodType<DashPushBody, z.ZodTypeDef, unknown>;

export const dashPushResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    data: z.object({
      cursors: cursorsSchema,
      stored: z.object({
        orders: z.number(),
        shifts: z.number(),
        cashMoves: z.number(),
        drawerOpens: z.number(),
        stockMoves: z.number(),
        days: z.number(),
      }),
      serverTime: z.string(),
    }),
  }),
  z.object({ ok: z.literal(false), error: z.string(), message: z.string().optional() }),
]);

export const dashPushStateResponseSchema = z.union([
  z.object({ ok: z.literal(true), data: z.object({ cursors: cursorsSchema.nullable(), daysKnown: z.array(z.string()).default([]) }) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
