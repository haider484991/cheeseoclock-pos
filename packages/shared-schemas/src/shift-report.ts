import { z } from 'zod';
import { SHIFT_REPORT_VERSION } from '@cheeseoclock/shared-types';
import type { ShiftReport } from '@cheeseoclock/shared-types';
import { cashCountSchema } from './cash-count.js';

/**
 * The shift report saved at Close shift (shared-types shift-report.ts
 * ShiftReport; stored in shifts.close_report_json, migration 0051), READ
 * side only: pos-domain shiftReportJson is the one writer of the text.
 *
 * Lenient: unknown keys are dropped (zod's default strip), so a newer till's
 * extra figure never wipes the paper; every cents and count must be a whole
 * number; every list holds at most 5,000 rows. A report of a newer shape
 * (v above SHIFT_REPORT_VERSION) is not read at all: the till says so
 * instead of printing figures it may not understand.
 */

/** At most this many rows in any one list of a saved report. */
export const SHIFT_REPORT_MAX_ROWS = 5_000;

const cents = z.number().int();
const count = z.number().int().min(0);
const list = <T extends z.ZodTypeAny>(row: T) => z.array(row).max(SHIFT_REPORT_MAX_ROWS);

const channelSchema = z.enum(['takeaway', 'delivery', 'foodpanda', 'web_delivery', 'web_pickup', 'dine_in', 'online']);

const ordersCentsSchema = z.object({ orderCount: count, cents });
const countCentsSchema = z.object({ count, cents });

const moneyLineSchema = z.object({ method: z.string(), orderCount: count, cents });

const salesSchema = z.object({
  orderCount: count,
  foodCents: cents,
  delivery: ordersCentsSchema,
  discounts: list(
    z.object({
      kind: z.enum(['foodpanda', 'staff', 'website', 'offer']),
      orderCount: count,
      cents,
    }),
  ),
  taxCents: cents,
  taxRateBps: z.number().int().min(0).nullable(),
  billedCents: cents,
  refunds: ordersCentsSchema,
  netCents: cents,
  averageCents: cents,
});

const drawerSchema = z.object({
  openingCents: cents,
  cashSalesCents: cents,
  cashRefundsCents: cents,
  cashIn: countCentsSchema,
  cashOut: countCentsSchema,
  riderTips: countCentsSchema,
  riderKept: z.object({ count, cents, tripCount: count }),
  otherCents: cents,
  expectedCents: cents,
  countedCents: cents,
  varianceCents: cents,
  countedNotes: cashCountSchema.nullable(),
});

/** What a saved shift report may hold (see the file header). */
export const shiftReportSchema = z.object({
  v: z.literal(SHIFT_REPORT_VERSION),
  shiftId: z.string(),
  deviceId: z.string(),
  tillName: z.string(),
  shopName: z.string(),
  openedAt: z.string(),
  closedAt: z.string(),
  openedBy: z.string(),
  closedBy: z.string(),
  pinOnLoginOf: z.string().nullable(),
  sales: salesSchema,
  payments: list(moneyLineSchema),
  paymentRefunds: list(moneyLineSchema),
  moneyTakenCents: cents,
  partPaymentsCents: cents,
  channels: list(
    z.object({
      channel: channelSchema,
      orderCount: count,
      billedCents: cents,
      outside: z.object({ orderCount: count, billedCents: cents }).nullable(),
    }),
  ),
  cancelled: list(
    z.object({
      orderNumber: z.string(),
      at: z.string(),
      cents,
      made: z.enum(['made', 'not_made']).nullable(),
      reason: z.string().nullable(),
    }),
  ),
  refunds: list(
    z.object({
      orderNumber: z.string(),
      at: z.string(),
      method: z.string(),
      cents,
      full: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
  drawer: drawerSchema,
  unpaid: z.object({
    orders: list(z.object({ orderNumber: z.string(), at: z.string(), takenBy: z.string(), cents })),
    reason: z.string().nullable(),
  }),
  items: list(
    z.object({
      category: z.string(),
      quantity: count,
      cents,
      items: list(z.object({ name: z.string(), quantity: count, cents })),
    }),
  ),
  orders: list(
    z.object({
      orderNumber: z.string(),
      paidAt: z.string(),
      channel: channelSchema,
      outside: z.boolean(),
      methods: list(z.string()),
      totalCents: cents,
      refunded: z.enum(['no', 'part', 'full']),
    }),
  ),
});

/** A saved report that reads, or one made by a newer till (a shape this till does not know). */
export type ParsedShiftReport = { report: ShiftReport } | { newer: true };

/**
 * A stored close_report_json as the report, `{ newer: true }` when a newer
 * till made it (v above SHIFT_REPORT_VERSION), or null when there is none or
 * it cannot be read (empty, not JSON, a shape the schema refuses). Never
 * throws.
 */
export function parseShiftReportJson(text: string | null | undefined): ParsedShiftReport | null {
  if (typeof text !== 'string' || text === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const v: unknown = (raw as { v?: unknown }).v;
  if (typeof v === 'number' && Number.isInteger(v) && v > SHIFT_REPORT_VERSION) return { newer: true };
  const parsed = shiftReportSchema.safeParse(raw);
  return parsed.success ? { report: parsed.data } : null;
}

// The type (shared-types) and this schema must describe the same shape.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _shiftReportShape: Same<z.infer<typeof shiftReportSchema>, ShiftReport> = true;
