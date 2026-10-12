import type { ZodError } from 'zod';
import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { REFUSED, requireCapability } from '../guards.js';
import { err, ok } from '@cheeseoclock/shared-types';
import {
  addVoucherBatchInputSchema,
  checkVoucherInputSchema,
  updateVoucherBatchInputSchema,
  voucherBatchIdInputSchema,
} from '@cheeseoclock/shared-schemas';
import { nowIso } from '../../db/repositories/base.js';
import {
  addVoucherBatch,
  listVoucherBatchSummaries,
  listVouchersOfBatch,
  removeVoucherBatch,
  updateVoucherBatch,
  voucherBatchSummary,
  VOUCHER_BATCH_GONE,
} from '../../db/repositories/voucher-repo.js';
import { checkVoucher } from '../../db/vouchers-read.js';
import { tradingDayOfInstant } from '@cheeseoclock/pos-domain';

/** The first problem, in the schema's own words. */
function validationFailed(error: ZodError) {
  const first = error.issues[0];
  return err({ code: 'validation_failed', message: first?.message ?? 'Invalid input', details: error.flatten() });
}

/**
 * Vouchers (v0.7.48). The Vouchers page — every client's vouchers with their
 * codes, and adding or changing them — is the owner's and the managers'
 * (vouchers.manage). The till's check of a typed number and code is any
 * login that takes orders: it says only whether THAT voucher can be used.
 */
export function registerVouchersHandlers(ctx: HandlerContext): void {
  defineHandler('vouchers:listBatches', ctx, () => {
    requireCapability('vouchers.manage', REFUSED.vouchers);
    return ok(listVoucherBatchSummaries(ctx.db));
  });

  defineHandler('vouchers:getBatch', ctx, (_ctx, payload) => {
    requireCapability('vouchers.manage', REFUSED.vouchers);
    const parsed = voucherBatchIdInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    const batch = voucherBatchSummary(ctx.db, parsed.data.id);
    if (!batch) throw new IpcGuardError({ code: 'not_found', message: VOUCHER_BATCH_GONE });
    return ok({ batch, vouchers: listVouchersOfBatch(ctx.db, parsed.data.id) });
  });

  defineHandler('vouchers:addBatch', ctx, (_ctx, payload) => {
    const s = requireCapability('vouchers.manage', REFUSED.vouchers);
    const parsed = addVoucherBatchInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(addVoucherBatch(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('vouchers:updateBatch', ctx, (_ctx, payload) => {
    const s = requireCapability('vouchers.manage', REFUSED.vouchers);
    const parsed = updateVoucherBatchInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(updateVoucherBatch(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('vouchers:removeBatch', ctx, (_ctx, payload) => {
    const s = requireCapability('vouchers.manage', REFUSED.vouchers);
    const parsed = voucherBatchIdInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    removeVoucherBatch(ctx.db, parsed.data.id, { userId: s.id, deviceId: ctx.deviceId });
    return ok({ id: parsed.data.id });
  });

  defineHandler('vouchers:check', ctx, (_ctx, payload) => {
    requireCapability('order.create', 'Only a till login can use vouchers.');
    const parsed = checkVoucherInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    const now = nowIso();
    return ok(checkVoucher(ctx.db, parsed.data, tradingDayOfInstant(now) ?? now.slice(0, 10)));
  });
}
