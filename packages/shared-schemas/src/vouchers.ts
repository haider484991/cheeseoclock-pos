import { z } from 'zod';
import {
  VOUCHER_BATCH_MAX,
  type AddVoucherBatchRequest,
  type ApplyVoucherRequest,
  type CheckVoucherRequest,
  type UpdateVoucherBatchRequest,
} from '@cheeseoclock/shared-types';

/**
 * Vouchers (v0.7.48): what the Vouchers page and the till send. Codes are
 * stored in capitals with no spaces or dashes (pos-domain
 * normalizeVoucherCode does the same at the till).
 */

/** A real calendar date, YYYY-MM-DD (the last trading day a voucher can be used). */
const lastDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Pick the last day' })
  .refine((ymd) => {
    const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
    const t = Date.UTC(y, m - 1, d);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === ymd;
  }, { message: 'That is not a real date' });

const oneLine = (max: number, what: string) =>
  z
    .string()
    .transform((v) => v.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, { message: `Say ${what}` }).max(max, { message: `Keep ${what} to ${max} letters` }));

const voucherNumber = z
  .number({ invalid_type_error: 'Type the voucher number' })
  .int({ message: 'A voucher number is a whole number' })
  .min(1, { message: 'Voucher numbers start at 1' })
  .max(999_999, { message: 'That voucher number is too long' });

const voucherCode = z
  .string()
  .transform((v) => v.toUpperCase().replace(/[\s\-–—_.]/g, ''))
  .pipe(z.string().regex(/^[A-Z0-9]{3,12}$/, { message: 'A code is 3 to 12 letters and numbers' }));

const batchFields = {
  name: oneLine(40, 'who the vouchers are for'),
  gives: oneLine(80, 'what a voucher gets'),
  coversCents: z
    .number({ invalid_type_error: 'Say the most one voucher takes off' })
    .int()
    .min(100, { message: 'A voucher covers at least Rs 1' })
    .max(10_000_000, { message: 'That is more than a voucher can cover' }),
  goodUntil: lastDay.nullable(),
};

/** vouchers:addBatch — a list as printed, or the till makes the codes. */
export const addVoucherBatchInputSchema = z.discriminatedUnion('from', [
  z
    .object({
      ...batchFields,
      from: z.literal('list'),
      vouchers: z
        .array(z.object({ number: voucherNumber, code: voucherCode }).strict())
        .min(1, { message: 'Paste at least one voucher' })
        .max(VOUCHER_BATCH_MAX, { message: `At most ${VOUCHER_BATCH_MAX} vouchers at a time` }),
    })
    .strict(),
  z
    .object({
      ...batchFields,
      from: z.literal('make'),
      count: z
        .number({ invalid_type_error: 'Say how many vouchers' })
        .int()
        .min(1, { message: 'Make at least one voucher' })
        .max(VOUCHER_BATCH_MAX, { message: `At most ${VOUCHER_BATCH_MAX} vouchers at a time` }),
      firstNumber: voucherNumber,
    })
    .strict(),
]);

/** vouchers:updateBatch — the batch's words, what it covers and its last day. */
export const updateVoucherBatchInputSchema = z.object({ id: z.string().min(1).max(64), ...batchFields }).strict();

/** vouchers:getBatch / vouchers:removeBatch. */
export const voucherBatchIdInputSchema = z.object({ id: z.string().min(1).max(64) }).strict();

/** vouchers:check — a number and code as typed at the till. */
export const checkVoucherInputSchema = z
  .object({ number: voucherNumber, code: voucherCode, orderId: z.string().min(1).max(64).nullish() })
  .strict();

/** orders:applyVoucher — the voucher as typed, and the line it is for. */
export const applyVoucherInputSchema = z
  .object({
    orderId: z.string().min(1).max(64),
    number: voucherNumber,
    code: voucherCode,
    lineId: z.string().min(1, { message: 'Pick the item the voucher is for' }).max(64),
  })
  .strict();

// The IPC contract's types (shared-types) and these schemas must describe the
// same shape: tsc fails here the moment one changes without the other.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _addShape: Same<z.infer<typeof addVoucherBatchInputSchema>, AddVoucherBatchRequest> = true;
const _updateShape: Same<z.infer<typeof updateVoucherBatchInputSchema>, UpdateVoucherBatchRequest> = true;
const _checkShape: Same<z.infer<typeof checkVoucherInputSchema>, CheckVoucherRequest> = true;
const _applyShape: Same<z.infer<typeof applyVoucherInputSchema>, ApplyVoucherRequest> = true;
