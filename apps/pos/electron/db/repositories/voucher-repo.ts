import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { nowIso, writeWithSync, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import { makeVoucherCodes, voucherNumberText } from '@cheeseoclock/pos-domain';
import type {
  AddVoucherBatchRequest,
  UpdateVoucherBatchRequest,
  VoucherBatchSummary,
  VoucherNumberAndCode,
} from '@cheeseoclock/shared-types';
import {
  batchHasUses,
  findVoucherBatch,
  liveVoucherCodes,
  listVoucherBatchSummaries,
  listVouchersOfBatch,
  voucherBatchSummary,
} from '../vouchers-read.js';

export { listVoucherBatchSummaries, listVouchersOfBatch, voucherBatchSummary };

/**
 * A client's vouchers (migration 0056, v0.7.48; the owner, 12 Oct 2026: "we
 * are giving these vouchers to abhi company … add it to pos system so we can
 * track it"). A batch and its vouchers are written here, each row with its
 * sync entry and one audit row for the batch. Whether a voucher is used is
 * never written here: it is read from the orders (vouchers-read.ts).
 */

export const VOUCHER_NUMBER_TWICE = (numbers: readonly number[]) =>
  `${numbers.length === 1 ? 'Number' : 'Numbers'} ${listed(numbers.map(voucherNumberText))} ${numbers.length === 1 ? 'is' : 'are'} on the list twice.`;
export const VOUCHER_CODE_TWICE = (codes: readonly string[]) =>
  `${codes.length === 1 ? 'The code' : 'The codes'} ${listed(codes)} ${codes.length === 1 ? 'is' : 'are'} on the list twice: every voucher needs its own code.`;
export const VOUCHER_CODE_TAKEN = (clashes: ReadonlyArray<{ code: string; number: number; batchName: string }>) =>
  `${clashes.length === 1 ? 'This code is' : 'These codes are'} already on other vouchers: ${listed(
    clashes.map((c) => `${c.code} (No. ${voucherNumberText(c.number)} of ${c.batchName})`),
  )}. Every voucher needs its own code.`;
export const VOUCHER_BATCH_GONE = 'Those vouchers are no longer on this till.';
export const VOUCHER_BATCH_IN_USE =
  'Some of these vouchers are on orders, so the batch stays. Take them off those orders (or cancel the orders) first.';

/** "A, B and C", the first five and "… and 12 more". */
function listed(xs: readonly string[]): string {
  const shown = xs.slice(0, 5);
  const more = xs.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  return shown.length <= 1 ? (shown[0] ?? '') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

function repeated<T>(xs: readonly T[]): T[] {
  const seen = new Set<T>();
  const twice = new Set<T>();
  for (const x of xs) (seen.has(x) ? twice : seen).add(x);
  return [...twice];
}

/**
 * Add a client's vouchers: the batch and every voucher, in one transaction
 * — each row with its sync entry, one audit row for the lot. From a list as
 * printed (each number once, each code once, no code already on a live
 * voucher), or the till makes `count` codes numbered from `firstNumber`.
 * `random` is for tests (pos-domain makeVoucherCodes).
 */
export function addVoucherBatch(
  db: AppDatabase,
  input: AddVoucherBatchRequest,
  actor: Actor,
  random: () => number = Math.random,
): VoucherBatchSummary {
  let batchId = '';
  db.transaction(() => {
    const taken = liveVoucherCodes(db);
    let vouchers: VoucherNumberAndCode[];
    if (input.from === 'list') {
      vouchers = input.vouchers;
      const twiceNumbers = repeated(vouchers.map((v) => v.number));
      if (twiceNumbers.length > 0) throw new Error(VOUCHER_NUMBER_TWICE(twiceNumbers));
      const twiceCodes = repeated(vouchers.map((v) => v.code));
      if (twiceCodes.length > 0) throw new Error(VOUCHER_CODE_TWICE(twiceCodes));
      const clashes = vouchers.flatMap((v) => {
        const other = taken.get(v.code);
        return other ? [{ code: v.code, ...other }] : [];
      });
      if (clashes.length > 0) throw new Error(VOUCHER_CODE_TAKEN(clashes));
    } else {
      const codes = makeVoucherCodes(input.count, new Set(taken.keys()), random);
      vouchers = codes.map((code, i) => ({ number: input.firstNumber + i, code }));
    }

    const now = nowIso();
    batchId = uuidv7();
    db.prepare(
      `INSERT INTO voucher_batches
         (id, name, gives, covers_cents, good_until, created_by_user_id, created_at, updated_at, device_id, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(batchId, input.name, input.gives, input.coversCents, input.goodUntil, actor.userId, now, now, actor.deviceId);
    enqueueSync(db, { entityType: 'voucher_batches', entityId: batchId, op: 'upsert', payload: { id: batchId, name: input.name } });
    const insert = db.prepare(
      `INSERT INTO vouchers (id, batch_id, number, code, created_at, updated_at, device_id, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    for (const v of vouchers) {
      const id = uuidv7();
      insert.run(id, batchId, v.number, v.code, now, now, actor.deviceId);
      enqueueSync(db, { entityType: 'vouchers', entityId: id, op: 'upsert', payload: { id, batchId, number: v.number } });
    }
    const numbers = vouchers.map((v) => v.number);
    writeAudit(db, {
      entityType: 'voucher_batches',
      entityId: batchId,
      action: 'add_voucher_batch',
      actorUserId: actor.userId,
      before: null,
      after: {
        name: input.name,
        gives: input.gives,
        coversCents: input.coversCents,
        goodUntil: input.goodUntil,
        from: input.from,
        count: vouchers.length,
        firstNumber: Math.min(...numbers),
        lastNumber: Math.max(...numbers),
      },
    });
  })();
  return voucherBatchSummary(db, batchId)!;
}

/**
 * Change a batch's name, what it gives, what it covers and its last day. The
 * vouchers stay as printed; an order a voucher is already on keeps the terms
 * frozen on it.
 */
export function updateVoucherBatch(db: AppDatabase, input: UpdateVoucherBatchRequest, actor: Actor): VoucherBatchSummary {
  const before = findVoucherBatch(db, input.id);
  if (!before) throw new Error(VOUCHER_BATCH_GONE);
  const at = nowIso();
  const after = { ...before, name: input.name, gives: input.gives, coversCents: input.coversCents, goodUntil: input.goodUntil, updatedAt: at };
  writeWithSync({
    db,
    entityType: 'voucher_batches',
    entityId: input.id,
    op: 'upsert',
    action: 'update_voucher_batch',
    actor,
    before,
    after,
    writeRow: () => {
      db.prepare(
        `UPDATE voucher_batches SET name = ?, gives = ?, covers_cents = ?, good_until = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND deleted_at IS NULL`,
      ).run(input.name, input.gives, input.coversCents, input.goodUntil, at, input.id);
    },
  });
  return voucherBatchSummary(db, input.id)!;
}

/**
 * Delete a batch added by mistake, with its vouchers — only while none of
 * them is on an order (cancelled and deleted orders don't count). One
 * transaction, each row's sync entry, one audit row.
 */
export function removeVoucherBatch(db: AppDatabase, id: string, actor: Actor): void {
  db.transaction(() => {
    const batch = findVoucherBatch(db, id);
    if (!batch) throw new Error(VOUCHER_BATCH_GONE);
    if (batchHasUses(db, id)) throw new Error(VOUCHER_BATCH_IN_USE);
    const now = nowIso();
    const vouchers = db.prepare(`SELECT id FROM vouchers WHERE batch_id = ? AND deleted_at IS NULL`).all(id) as Array<{ id: string }>;
    for (const v of vouchers) {
      db.prepare(`UPDATE vouchers SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(now, now, v.id);
      enqueueSync(db, { entityType: 'vouchers', entityId: v.id, op: 'delete', payload: { id: v.id, deletedAt: now } });
    }
    db.prepare(`UPDATE voucher_batches SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(now, now, id);
    enqueueSync(db, { entityType: 'voucher_batches', entityId: id, op: 'delete', payload: { id, deletedAt: now } });
    writeAudit(db, {
      entityType: 'voucher_batches',
      entityId: id,
      action: 'remove_voucher_batch',
      actorUserId: actor.userId,
      before: { ...batch, count: vouchers.length },
      after: null,
    });
  })();
}
