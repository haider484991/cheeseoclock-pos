import type { AppDatabase } from './connection.js';
import { parseVoucherRule, voucherEnded, voucherNumberText } from '@cheeseoclock/pos-domain';
import {
  paperDateTime,
  type VoucherBatch,
  type VoucherBatchSummary,
  type VoucherCheck,
  type VoucherRow,
  type VoucherState,
  type VoucherUse,
} from '@cheeseoclock/shared-types';

/**
 * Vouchers as the Vouchers page, the till's check and the order's own
 * guard read them (migration 0056). Reads only — no write imports, so a
 * Reports worker may load it too.
 *
 * A voucher is used while a live discount row names it (voucher_id) on an
 * order that is not cancelled ('void') or deleted. Nothing else is kept:
 * cancelling the order, deleting it as a test, or taking the voucher off
 * frees it — every path that undoes an order already does one of those. An
 * order refunded after it was paid keeps its voucher (the pizza was eaten).
 */

interface BatchRow {
  id: string;
  name: string;
  gives: string;
  covers_cents: number;
  good_until: string | null;
  created_by_user_id: string | null;
  created_at: string;
  created_by_name: string | null;
}

const BATCH_SELECT = `SELECT b.id, b.name, b.gives, b.covers_cents, b.good_until, b.created_by_user_id, b.created_at,
                             u.full_name AS created_by_name
                        FROM voucher_batches b
                        LEFT JOIN users u ON u.id = b.created_by_user_id`;

function batchOf(r: BatchRow): VoucherBatch {
  return {
    id: r.id,
    name: r.name,
    gives: r.gives,
    coversCents: r.covers_cents,
    goodUntil: r.good_until,
    createdAt: r.created_at,
    createdByName: r.created_by_name,
  };
}

/** A live batch, or null. */
export function findVoucherBatch(db: AppDatabase, id: string): (VoucherBatch & { createdByUserId: string | null }) | null {
  const r = db.prepare(`${BATCH_SELECT} WHERE b.id = ? AND b.deleted_at IS NULL`).get(id) as BatchRow | undefined;
  return r ? { ...batchOf(r), createdByUserId: r.created_by_user_id } : null;
}

interface VoucherDbRow {
  id: string;
  batch_id: string;
  number: number;
  code: string;
}

interface UseRow {
  voucherId: string;
  at: string;
  amountCents: number;
  ruleJson: string | null;
  orderId: string;
  orderNumber: string;
  paidAt: string | null;
  status: string;
  customerName: string | null;
  customerPhone: string | null;
  staffName: string | null;
}

/**
 * The live orders these vouchers are on (`where` picks the vouchers: a
 * batch's, or one voucher), each voucher's paid order first, then the
 * oldest. Inside or outside a transaction.
 */
function usesWhere(db: AppDatabase, where: 'batch' | 'voucher', id: string): Map<string, VoucherUse[]> {
  const pick = where === 'batch' ? `d.voucher_id IN (SELECT id FROM vouchers WHERE batch_id = ?)` : `d.voucher_id = ?`;
  const rows = db
    .prepare(
      `SELECT d.voucher_id AS voucherId, d.created_at AS at, d.amount_cents AS amountCents, d.rule_json AS ruleJson,
              o.id AS orderId, o.order_number AS orderNumber, o.paid_at AS paidAt, o.status AS status,
              o.customer_name_snapshot AS customerName, o.customer_phone_snapshot AS customerPhone,
              u.full_name AS staffName
         FROM order_discounts d
         JOIN orders o ON o.id = d.order_id
         LEFT JOIN users u ON u.id = d.applied_by_user_id
        WHERE ${pick} AND d.deleted_at IS NULL AND d.source = 'voucher'
          AND o.deleted_at IS NULL AND o.status != 'void'
        ORDER BY (o.paid_at IS NULL), d.created_at, d.id`,
    )
    .all(id) as UseRow[];
  const out = new Map<string, VoucherUse[]>();
  for (const r of rows) {
    const list = out.get(r.voucherId) ?? [];
    list.push({
      orderId: r.orderId,
      orderNumber: r.orderNumber,
      at: r.at,
      paidAt: r.paidAt,
      refunded: r.status === 'refunded',
      item: itemOf(db, parseVoucherRule(r.ruleJson)?.voucher.lineId ?? null),
      amountCents: r.amountCents,
      staffName: r.staffName,
      customerName: r.customerName,
      customerPhone: r.customerPhone,
    });
    out.set(r.voucherId, list);
  }
  return out;
}

/** What a voucher was used on: its line's name and choices ("Fajita Pizza — Large · Extra cheese"); null when gone. */
function itemOf(db: AppDatabase, lineId: string | null): string | null {
  if (!lineId) return null;
  const line = db.prepare(`SELECT menu_item_name FROM order_items WHERE id = ? AND deleted_at IS NULL`).get(lineId) as
    | { menu_item_name: string }
    | undefined;
  if (!line) return null;
  const mods = db
    .prepare(`SELECT modifier_name FROM order_item_modifiers WHERE order_item_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at, id`)
    .all(lineId) as Array<{ modifier_name: string }>;
  return [line.menu_item_name, ...mods.map((m) => m.modifier_name)].join(' · ');
}

function stateOf(uses: readonly VoucherUse[]): VoucherState {
  if (uses.length === 0) return 'not_used';
  return uses[0]!.paidAt !== null ? 'used' : 'on_order';
}

/** A batch's vouchers in number order, each with where it stands. */
export function listVouchersOfBatch(db: AppDatabase, batchId: string): VoucherRow[] {
  const vouchers = db
    .prepare(`SELECT id, batch_id, number, code FROM vouchers WHERE batch_id = ? AND deleted_at IS NULL ORDER BY number, id`)
    .all(batchId) as VoucherDbRow[];
  const uses = usesWhere(db, 'batch', batchId);
  return vouchers.map((v) => {
    const on = uses.get(v.id) ?? [];
    return { id: v.id, number: v.number, code: v.code, state: stateOf(on), use: on[0] ?? null, alsoOn: on.slice(1) };
  });
}

function summaryOf(batch: VoucherBatch, rows: readonly VoucherRow[]): VoucherBatchSummary {
  const numbers = rows.map((r) => r.number);
  return {
    ...batch,
    count: rows.length,
    used: rows.filter((r) => r.state === 'used').length,
    onOrder: rows.filter((r) => r.state === 'on_order').length,
    notUsed: rows.filter((r) => r.state === 'not_used').length,
    firstNumber: numbers.length > 0 ? Math.min(...numbers) : null,
    lastNumber: numbers.length > 0 ? Math.max(...numbers) : null,
  };
}

/** One batch with its counts; null when it is gone. */
export function voucherBatchSummary(db: AppDatabase, batchId: string): VoucherBatchSummary | null {
  const batch = findVoucherBatch(db, batchId);
  return batch ? summaryOf(batch, listVouchersOfBatch(db, batchId)) : null;
}

/** Every live batch, the newest first, with its counts. */
export function listVoucherBatchSummaries(db: AppDatabase): VoucherBatchSummary[] {
  const batches = db.prepare(`${BATCH_SELECT} WHERE b.deleted_at IS NULL ORDER BY b.created_at DESC, b.id DESC`).all() as BatchRow[];
  return batches.map((b) => summaryOf(batchOf(b), listVouchersOfBatch(db, b.id)));
}

/** Every live voucher's code (the codes a new batch may not repeat), with whose it is. */
export function liveVoucherCodes(db: AppDatabase): Map<string, { number: number; batchName: string }> {
  const rows = db
    .prepare(
      `SELECT v.code, v.number, b.name AS batchName
         FROM vouchers v JOIN voucher_batches b ON b.id = v.batch_id
        WHERE v.deleted_at IS NULL AND b.deleted_at IS NULL`,
    )
    .all() as Array<{ code: string; number: number; batchName: string }>;
  return new Map(rows.map((r) => [r.code, { number: r.number, batchName: r.batchName }]));
}

/** "#0012 on 14/10/2026 15:05" — an order as the cashier's words name it. */
function orderWords(use: VoucherUse): string {
  return `order #${use.orderNumber.split('-').pop()} on ${paperDateTime(use.paidAt ?? use.at)}`;
}

/** "2026-12-31" → "31/12/2026", the way the papers write a day. */
function dayWords(ymd: string): string {
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y}`;
}

/** A live voucher by its number and code, with its batch; null when none matches both. */
export function findVoucherByNumberAndCode(
  db: AppDatabase,
  number: number,
  code: string,
): { id: string; number: number; code: string; batch: VoucherBatch & { createdByUserId: string | null } } | null {
  const row = db
    .prepare(
      `SELECT v.id, v.batch_id, v.number, v.code
         FROM vouchers v JOIN voucher_batches b ON b.id = v.batch_id
        WHERE v.code = ? AND v.number = ? AND v.deleted_at IS NULL AND b.deleted_at IS NULL
        ORDER BY b.created_at, v.id LIMIT 1`,
    )
    .get(code, number) as VoucherDbRow | undefined;
  if (!row) return null;
  const batch = findVoucherBatch(db, row.batch_id);
  return batch ? { id: row.id, number: row.number, code: row.code, batch } : null;
}

/**
 * What the till says about a number and code (vouchers:check, and again
 * inside orders:applyVoucher): usable, or why not in the cashier's words —
 * no such voucher, used (on which order), on another order not paid yet,
 * already on this order, or past its last day. `tradingDay` is today's
 * (YYYY-MM-DD, pos-domain tradingDayOfInstant).
 */
export function checkVoucher(
  db: AppDatabase,
  input: { number: number; code: string; orderId?: string | null },
  tradingDay: string,
): VoucherCheck {
  const no = voucherNumberText(input.number);
  const found = findVoucherByNumberAndCode(db, input.number, input.code);
  if (!found) {
    return {
      ok: false,
      problem: 'not_found',
      message: `No voucher No. ${no} with the code ${input.code}. Check the number and the code on the voucher.`,
    };
  }
  const uses = usesWhere(db, 'voucher', found.id).get(found.id) ?? [];
  const here = input.orderId ? uses.find((u) => u.orderId === input.orderId) : undefined;
  if (here) return { ok: false, problem: 'on_this_order', message: `Voucher No. ${no} is already on this order.`, use: here };
  const use = uses[0];
  if (use && use.paidAt !== null) {
    return { ok: false, problem: 'used', message: `Voucher No. ${no} was already used: ${orderWords(use)}.`, use };
  }
  if (use) {
    return {
      ok: false,
      problem: 'on_order',
      message: `Voucher No. ${no} is on ${orderWords(use)}, not paid yet. Cancel that order or take the voucher off it first.`,
      use,
    };
  }
  if (voucherEnded(found.batch.goodUntil, tradingDay)) {
    return { ok: false, problem: 'ended', message: `Voucher No. ${no} could be used until ${dayWords(found.batch.goodUntil!)}. It has ended.` };
  }
  const { createdByUserId: _by, ...batch } = found.batch;
  void _by;
  return { ok: true, voucherId: found.id, number: found.number, code: found.code, batch };
}

/** Is any voucher of this batch on a live order? (A batch with one is never deleted.) */
export function batchHasUses(db: AppDatabase, batchId: string): boolean {
  return usesWhere(db, 'batch', batchId).size > 0;
}
