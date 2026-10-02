import { v7 as uuidv7 } from 'uuid';
import log from 'electron-log/main';
import type { AppDatabase } from '../connection.js';
import { writeWithSync, nowIso, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import { recordDrawerOpen } from './drawer-open-repo.js';
import { shortOrderNumber } from '@cheeseoclock/shared-types';
import { cashCountInputSchema, parseCashCountJson } from '@cheeseoclock/shared-schemas';
import { cashCountJson, cashCountTotalCents, formatCents } from '@cheeseoclock/pos-domain';
import type {
  CashCount,
  CashMovement,
  CashMovementType,
  DrawerPayout,
  Shift,
  ShiftSummary,
  UnpaidOrderAtClose,
  UUID,
} from '@cheeseoclock/shared-types';

/**
 * Shifts repo. Open/close cash-drawer reconciliation per device.
 *
 * Schema in migrations/0011_shifts.sql. Sync columns are present so HQ rolls
 * up multi-device end-of-day reports. The partial UNIQUE index on device_id
 * (WHERE closed_at IS NULL) enforces exactly-one-open-shift-per-device.
 */

interface ShiftRow {
  id: string;
  device_id: string;
  opened_by_user_id: string;
  opened_by_name: string | null;
  closed_by_user_id: string | null;
  closed_by_name: string | null;
  opened_at: string;
  closed_at: string | null;
  opening_cash_cents: number;
  counted_cash_cents: number | null;
  expected_cash_cents: number | null;
  variance_cents: number | null;
  notes: string | null;
  close_notes: string | null;
  carried_unpaid_count: number | null;
  carry_over_reason: string | null;
  /** The note-by-note count at close (migration 0050): cashCountJson's text, or NULL. */
  counted_notes_json: string | null;
}

const SHIFT_SELECT = `
  s.id, s.device_id, s.opened_by_user_id,
  uo.full_name AS opened_by_name,
  s.closed_by_user_id,
  uc.full_name AS closed_by_name,
  s.opened_at, s.closed_at,
  s.opening_cash_cents, s.counted_cash_cents,
  s.expected_cash_cents, s.variance_cents, s.notes, s.close_notes,
  s.carried_unpaid_count, s.carry_over_reason,
  s.counted_notes_json
`;

function rowToShift(r: ShiftRow): Shift {
  return {
    id: r.id as Shift['id'],
    deviceId: r.device_id,
    openedByUserId: r.opened_by_user_id as Shift['openedByUserId'],
    openedByName: r.opened_by_name ?? 'Unknown',
    closedByUserId: r.closed_by_user_id as Shift['closedByUserId'],
    closedByName: r.closed_by_name,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    openingCashCents: r.opening_cash_cents as Shift['openingCashCents'],
    countedCashCents: r.counted_cash_cents as Shift['countedCashCents'],
    expectedCashCents: r.expected_cash_cents as Shift['expectedCashCents'],
    varianceCents: r.variance_cents as Shift['varianceCents'],
    notes: r.notes,
    closeNotes: r.close_notes ?? null,
    carriedUnpaidCount: Number(r.carried_unpaid_count ?? 0),
    carryOverReason: r.carry_over_reason ?? null,
    countedNotes: countedNotesOf(r),
  };
}

/**
 * The note-by-note count of a closed shift, or null. Read leniently
 * (cashCountSchema): a newer till's extra key, row or paisa still reads.
 * Text that cannot be read at all is null and noted in the log; the shift
 * itself always reads (counted_cash_cents is the truth).
 */
function countedNotesOf(r: ShiftRow): CashCount | null {
  const text = r.counted_notes_json;
  const notes = parseCashCountJson(text);
  if (notes === null && typeof text === 'string' && text !== '') {
    log.warn('Shift: the note count could not be read; showing none', { id: r.id });
  }
  return notes;
}

/**
 * Currently-open shift on this device, or null if none.
 * Picks the most-recent if (somehow) more than one exists.
 */
export function getCurrentShift(db: AppDatabase, deviceId: string): Shift | null {
  const row = db
    .prepare(
      `SELECT ${SHIFT_SELECT}
         FROM shifts s
         LEFT JOIN users uo ON uo.id = s.opened_by_user_id
         LEFT JOIN users uc ON uc.id = s.closed_by_user_id
        WHERE s.device_id = ? AND s.closed_at IS NULL AND s.deleted_at IS NULL
        ORDER BY s.opened_at DESC LIMIT 1`,
    )
    .get(deviceId) as ShiftRow | undefined;
  return row ? rowToShift(row) : null;
}

export function findShift(db: AppDatabase, id: string): Shift | null {
  const row = db
    .prepare(
      `SELECT ${SHIFT_SELECT}
         FROM shifts s
         LEFT JOIN users uo ON uo.id = s.opened_by_user_id
         LEFT JOIN users uc ON uc.id = s.closed_by_user_id
        WHERE s.id = ? AND s.deleted_at IS NULL`,
    )
    .get(id) as ShiftRow | undefined;
  return row ? rowToShift(row) : null;
}

export function listShifts(
  db: AppDatabase,
  opts?: { deviceId?: string; sinceIso?: string; limit?: number },
): Shift[] {
  const conditions: string[] = ['s.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (opts?.deviceId) {
    conditions.push('s.device_id = ?');
    params.push(opts.deviceId);
  }
  if (opts?.sinceIso) {
    conditions.push('s.opened_at >= ?');
    params.push(opts.sinceIso);
  }
  const limit = opts?.limit ?? 100;
  const rows = db
    .prepare(
      `SELECT ${SHIFT_SELECT}
         FROM shifts s
         LEFT JOIN users uo ON uo.id = s.opened_by_user_id
         LEFT JOIN users uc ON uc.id = s.closed_by_user_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY s.opened_at DESC LIMIT ?`,
    )
    .all(...params, limit) as ShiftRow[];
  return rows.map(rowToShift);
}

export interface OpenShiftInput {
  openingCashCents: number;
  notes?: string | null;
}

/** A shift just opened, and the drawer_opens row its float pulse is for. */
export type OpenedShift = Shift & { drawerOpenId: string };

/**
 * Open a shift on this till. The drawer pops to put the float in — even a
 * Rs 0 float — so its drawer_opens row ('float', the opening cash) is written
 * in the same transaction; the handler pulses the drawer for that row only.
 */
export function openShift(
  db: AppDatabase,
  input: OpenShiftInput,
  actor: Actor & { userId: string },
): OpenedShift {
  return db.transaction((): OpenedShift => {
    const shift = openShiftRow(db, input, actor);
    const drawer = recordDrawerOpen(
      db,
      { kind: 'float', amountCents: shift.openingCashCents },
      actor,
    );
    return { ...shift, drawerOpenId: drawer.id };
  })();
}

function openShiftRow(
  db: AppDatabase,
  input: OpenShiftInput,
  actor: Actor & { userId: string },
): Shift {
  // Defense-in-depth: enforce no-existing-open-shift in code even though the
  // UNIQUE index would also catch it. Better error message this way.
  const existing = getCurrentShift(db, actor.deviceId);
  if (existing) {
    throw new Error(
      `A shift is already open on this device (opened ${new Date(existing.openedAt).toLocaleString()}). Close it first.`,
    );
  }
  if (input.openingCashCents < 0) throw new Error('Opening cash cannot be negative');

  const id = uuidv7();
  const now = nowIso();
  const shift: Shift = {
    id: id as Shift['id'],
    deviceId: actor.deviceId,
    openedByUserId: actor.userId as Shift['openedByUserId'],
    openedByName: '', // filled by SELECT join below
    closedByUserId: null,
    closedByName: null,
    openedAt: now,
    closedAt: null,
    openingCashCents: Math.round(input.openingCashCents) as Shift['openingCashCents'],
    countedCashCents: null,
    expectedCashCents: null,
    varianceCents: null,
    notes: input.notes?.trim() || null,
    closeNotes: null,
    carriedUnpaidCount: 0,
    carryOverReason: null,
    countedNotes: null,
  };
  writeWithSync({
    db,
    entityType: 'shifts',
    entityId: id,
    op: 'upsert',
    action: 'shift_open',
    actor,
    before: null,
    after: shift,
    writeRow: () => {
      db.prepare(
        `INSERT INTO shifts
           (id, device_id, opened_by_user_id, opened_at, opening_cash_cents,
            notes, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        id,
        actor.deviceId,
        actor.userId,
        now,
        shift.openingCashCents,
        shift.notes,
        now,
        now,
      );
    },
  });
  log.info('Shift opened', { id, deviceId: actor.deviceId, openingCash: shift.openingCashCents });
  return findShift(db, id)!;
}

export interface CloseShiftInput {
  shiftId: string;
  countedCashCents: number;
  /**
   * The closing note ("Rs 100 short, change given wrong"). Saved on its own
   * (close_notes, migration 0039): the note typed at opening stays as it was.
   */
  notes?: string | null;
  /**
   * Why the unpaid orders still on this till are carried over to the next
   * shift (one reason for all of them). Required when there are any: without
   * it the close is refused, as before.
   */
  carryOverReason?: string | null;
  /**
   * The unpaid orders the manager was shown in the close box (their ids),
   * which the reason is for. When given, a close that would carry over an
   * order NOT on that list is refused: a website order imported, or an order
   * sent, while they counted must not be carried over — and put on record as
   * approved by them — for a reason they gave for other orders. One paid off
   * meanwhile simply is not carried. Omitted: no such check (direct callers).
   */
  carryOverOrderIds?: readonly string[] | null;
  /**
   * The drawer counted note by note (Close shift's note counter). When it is
   * given it must be exactly the owner's seven note rows and 'Coins and
   * other' (cashCountInputSchema), and add up to countedCashCents, or the
   * close is refused; it is stored as counted_notes_json (migration 0050).
   * Omitted or null: the shift closes on the total alone, the column NULL.
   */
  countedNotes?: CashCount | null;
}

/**
 * How the close was approved, for its audit row: by the manager signed in on
 * the till (null), or by a manager's PIN or password typed on a cashier's
 * login (owner, 2026-09-27) — then who was signed in.
 */
export interface CloseApproval {
  via: 'manager_pin';
  /** The cashier signed in on the till when the manager typed their PIN. */
  tillSignedInUserId: string;
}

/** The statuses of an order that has gone to the kitchen and is still waiting to be paid. */
const UNPAID_STATUSES = `('sent_to_kitchen', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'served')`;

/**
 * Orders on this till still waiting to be paid, from any day, oldest first:
 * the ones a close carries over to the next shift (with a manager's reason).
 * Money that comes in for them later goes to whichever shift takes it
 * (payments.shift_id), as it always did.
 */
export function listUnpaidForClose(db: AppDatabase, deviceId: string): UnpaidOrderAtClose[] {
  const rows = db
    .prepare(
      `SELECT o.id, o.order_number, o.created_at, o.total_cents, o.source, u.full_name AS taken_by
         FROM orders o
         LEFT JOIN users u ON u.id = o.cashier_id
        WHERE o.device_id = ? AND o.deleted_at IS NULL AND o.paid_at IS NULL
          AND o.status IN ${UNPAID_STATUSES}
        ORDER BY o.created_at, o.id`,
    )
    .all(deviceId) as Array<{
    id: string;
    order_number: string;
    created_at: string;
    total_cents: number;
    source: string;
    taken_by: string | null;
  }>;
  return rows.map((r) => ({
    orderId: r.id as UUID,
    orderNumber: r.order_number,
    createdAt: r.created_at,
    totalCents: Number(r.total_cents) as UnpaidOrderAtClose['totalCents'],
    takenBy: r.source === 'web' ? 'Website' : (r.taken_by ?? 'Unknown'),
  }));
}

/** "#0042, #0043 and 3 more" */
function orderList(orders: readonly UnpaidOrderAtClose[]): string {
  const shown = orders.slice(0, 5).map((o) => `#${o.orderNumber.split('-').pop()}`).join(', ');
  return orders.length > 5 ? `${shown} and ${orders.length - 5} more` : shown;
}

export function closeShift(
  db: AppDatabase,
  input: CloseShiftInput,
  actor: Actor & { userId: string },
  approval: CloseApproval | null = null,
): Shift {
  let result!: Shift;
  const tx = db.transaction(() => {
    const before = findShift(db, input.shiftId);
    if (!before) throw new Error('Shift not found');
    if (before.closedAt) throw new Error('Shift is already closed');
    if (input.countedCashCents < 0) throw new Error('Counted cash cannot be negative');

    // The note-by-note count, checked before anything else is looked at or
    // written. This is the one strict gate (the handler only passes it on):
    // the owner's rows in his order, whole numbers of notes, coins in whole
    // rupees, and a sum that is the counted cash. The stored text is always
    // written by cashCountJson, never taken as sent.
    const countedNotesJson = countedNotesToStore(input.countedNotes, input.countedCashCents);

    // Money still to come in (a rider still out, an order not yet paid). It
    // used to block the close outright (audit 2026-09-25), and one forgotten
    // old order blocked every close. Now the manager closing says why they
    // are carried over, once for all of them, and the shift closes; the
    // orders stay unpaid and their money goes to whichever shift takes it
    // (owner, 2026-09-27). Without a reason the close is refused, as before.
    const unpaid = listUnpaidForClose(db, before.deviceId);
    const carryOverReason = input.carryOverReason?.trim() ?? '';
    if (input.carryOverOrderIds) {
      const seen = new Set(input.carryOverOrderIds);
      const unseen = unpaid.filter((o) => !seen.has(o.orderId));
      if (unseen.length > 0) {
        throw new Error(
          `${unseen.length === 1 ? 'An order' : `${unseen.length} orders`} came in unpaid while you were counting ` +
            `(${orderList(unseen)}). Check the list of unpaid orders, then close the shift again.`,
        );
      }
    }
    if (unpaid.length > 0 && !carryOverReason) {
      throw new Error(
        `${unpaid.length === 1 ? '1 order on this till is' : `${unpaid.length} orders on this till are`} not paid yet ` +
          `(${orderList(unpaid)}). Give a reason to carry ${unpaid.length === 1 ? 'it' : 'them'} over to the next shift, ` +
          `or collect the money first (Live Orders or Order History).`,
      );
    }
    if (carryOverReason.length > 300) throw new Error('Keep the reason under 300 characters');

    // Compute expected cash from the payments ledger for this shift window.
    // Cash sales (positive cash payments) minus cash refunds (negative cash
    // payments). A payment is credited to the shift that took the money
    // (payments.shift_id, migration 0016); rows from before that column fall
    // back to the shift the order was created in.
    const cashRow = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN p.amount_cents > 0 THEN p.amount_cents ELSE 0 END), 0) AS sales,
           COALESCE(SUM(CASE WHEN p.amount_cents < 0 THEN -p.amount_cents ELSE 0 END), 0) AS refunds
          FROM payments p
          JOIN orders o ON o.id = p.order_id
         WHERE COALESCE(p.shift_id, o.shift_id) = ? AND p.method = 'cash' AND p.deleted_at IS NULL
           AND o.deleted_at IS NULL`,
      )
      .get(input.shiftId) as { sales: number; refunds: number };
    const moves = cashMovementTotals(db, input.shiftId);
    const expected =
      before.openingCashCents + cashRow.sales - cashRow.refunds + moves.inCents - moves.outCents;
    const counted = Math.round(input.countedCashCents);
    const variance = counted - expected;
    const now = nowIso();

    // The closing note goes in its own column: it used to be written over
    // the note typed when the shift was opened (audit 2026-09-27).
    db.prepare(
      `UPDATE shifts
          SET closed_by_user_id = ?, closed_at = ?, counted_cash_cents = ?,
              expected_cash_cents = ?, variance_cents = ?,
              close_notes = ?, carried_unpaid_count = ?, carry_over_reason = ?,
              counted_notes_json = ?,
              updated_at = ?, version = version + 1
        WHERE id = ? AND closed_at IS NULL`,
    ).run(
      actor.userId,
      now,
      counted,
      expected,
      variance,
      input.notes?.trim() || null,
      unpaid.length,
      unpaid.length > 0 ? carryOverReason : null,
      countedNotesJson,
      now,
      input.shiftId,
    );

    const after = findShift(db, input.shiftId)!;
    // Sync + audit for the close event, through the shared writers: the sync
    // row carries the post-image and the audit row joins the hash chain. A
    // raw INSERT into audit_log leaves row_hash NULL, and the verifier then
    // reports the chain broken from that row on — which is what every shift
    // close used to do.
    enqueueSync(db, {
      entityType: 'shifts',
      entityId: input.shiftId,
      op: 'upsert',
      payload: after,
    });
    // The actor is the manager who closed it. On a cashier's login the
    // audit row also says so: approved by the manager's PIN, on whose till.
    writeAudit(db, {
      entityType: 'shifts',
      entityId: input.shiftId,
      action: 'shift_close',
      actorUserId: actor.userId,
      before,
      after: approval ? { ...after, approval } : after,
    });
    // One row per carried order: which order, why, who approved, which shift.
    for (const o of unpaid) {
      writeAudit(db, {
        entityType: 'orders',
        entityId: o.orderId,
        action: 'carried_over_unpaid',
        actorUserId: actor.userId,
        before: null,
        after: {
          orderId: o.orderId,
          orderNumber: o.orderNumber,
          totalCents: o.totalCents,
          reason: carryOverReason,
          approvedByUserId: actor.userId,
          shiftId: input.shiftId,
          ...(approval ? { approval } : {}),
        },
      });
    }

    result = after;
  });
  tx();
  log.info('Shift closed', {
    id: input.shiftId,
    counted: result.countedCashCents,
    variance: result.varianceCents,
    carriedUnpaid: result.carriedUnpaidCount,
    viaManagerPin: approval !== null,
    byNote: result.countedNotes != null,
  });
  return result;
}

/**
 * The text to store for a close's note-by-note count (cashCountJson), or
 * null when it was not counted by note. Throws, in the till's own words,
 * when the count is not one a close may save (cashCountInputSchema: the
 * first problem found), or when the notes do not add up to the counted cash.
 */
function countedNotesToStore(countedNotes: CashCount | null | undefined, countedCashCents: number): string | null {
  if (countedNotes === null || countedNotes === undefined) return null;
  const parsed = cashCountInputSchema.safeParse(countedNotes);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'The note count could not be read');
  const sum = cashCountTotalCents(parsed.data);
  const counted = Math.round(countedCashCents);
  if (sum !== counted) {
    throw new Error(`The notes counted add up to ${formatCents(sum)}, not ${formatCents(counted)}. Count the drawer again.`);
  }
  return cashCountJson(parsed.data);
}

/**
 * Live summary for a shift — used by the Close Shift dialog so the manager
 * can see expected cash + counts before entering the drawer count.
 */
export function getShiftSummary(db: AppDatabase, shiftId: string): ShiftSummary {
  const shift = findShift(db, shiftId);
  if (!shift) throw new Error('Shift not found');

  const counts = db
    .prepare(
      `SELECT
         COUNT(*) AS orderCount,
         SUM(CASE WHEN paid_at IS NOT NULL AND status NOT IN ('void', 'refunded') THEN 1 ELSE 0 END) AS paidOrderCount,
         SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) AS refundedOrderCount,
         SUM(CASE WHEN status = 'void' THEN 1 ELSE 0 END) AS voidedOrderCount
        FROM orders
       WHERE shift_id = ? AND deleted_at IS NULL`,
    )
    .get(shiftId) as {
    orderCount: number;
    paidOrderCount: number;
    refundedOrderCount: number;
    voidedOrderCount: number;
  };

  const byMethodRows = db
    .prepare(
      `SELECT p.method,
              COALESCE(SUM(CASE WHEN p.amount_cents > 0 THEN p.amount_cents ELSE 0 END), 0) AS sales,
              COALESCE(SUM(CASE WHEN p.amount_cents < 0 THEN -p.amount_cents ELSE 0 END), 0) AS refunds
         FROM payments p
         JOIN orders o ON o.id = p.order_id
        WHERE COALESCE(p.shift_id, o.shift_id) = ? AND p.deleted_at IS NULL AND o.deleted_at IS NULL
        GROUP BY p.method
        ORDER BY SUM(ABS(p.amount_cents)) DESC`,
    )
    .all(shiftId) as Array<{ method: string; sales: number; refunds: number }>;
  const byMethod = byMethodRows.map((r) => ({
    method: r.method,
    salesCents: r.sales as ShiftSummary['byMethod'][number]['salesCents'],
    refundCents: r.refunds as ShiftSummary['byMethod'][number]['refundCents'],
    netCents: (r.sales - r.refunds) as ShiftSummary['byMethod'][number]['netCents'],
  }));
  const totalRevenueCents = byMethod.reduce((s, m) => s + m.salesCents, 0);
  const totalRefundsCents = byMethod.reduce((s, m) => s + m.refundCents, 0);
  const cashLine = byMethod.find((m) => m.method === 'cash');
  const cashSalesCents = cashLine?.salesCents ?? 0;
  const cashRefundsCents = cashLine?.refundCents ?? 0;
  const moves = cashMovementTotals(db, shiftId);
  // The outside riders' payouts are already in outCents: the formula is the
  // one closeShift uses, unchanged; riderChargesCents only says how much of
  // the cash taken out went to them.
  const expectedCashCents =
    shift.openingCashCents + cashSalesCents - cashRefundsCents + moves.inCents - moves.outCents;
  // Of the riders' payouts, the trips paid (the rest are delivery charges kept).
  const trips = db
    .prepare(
      `SELECT COUNT(*) AS n FROM cash_movements
        WHERE shift_id = ? AND deleted_at IS NULL AND type = 'payout' AND order_id IS NOT NULL
          AND substr(reason, 1, ?) = ?`,
    )
    .get(shiftId, TRIP_PAYOUT_REASON_START.length, TRIP_PAYOUT_REASON_START) as { n: number };

  return {
    shiftId: shiftId as UUID,
    orderCount: counts.orderCount,
    paidOrderCount: counts.paidOrderCount ?? 0,
    refundedOrderCount: counts.refundedOrderCount ?? 0,
    voidedOrderCount: counts.voidedOrderCount ?? 0,
    totalRevenueCents: totalRevenueCents as ShiftSummary['totalRevenueCents'],
    totalRefundsCents: totalRefundsCents as ShiftSummary['totalRefundsCents'],
    netRevenueCents: (totalRevenueCents -
      totalRefundsCents) as ShiftSummary['netRevenueCents'],
    cashSalesCents: cashSalesCents as ShiftSummary['cashSalesCents'],
    cashRefundsCents: cashRefundsCents as ShiftSummary['cashRefundsCents'],
    cashInCents: moves.inCents as ShiftSummary['cashInCents'],
    cashOutCents: moves.outCents as ShiftSummary['cashOutCents'],
    riderChargesCents: moves.riderCents as ShiftSummary['riderChargesCents'],
    riderChargeCount: moves.riderCount,
    riderTripCount: Number(trips.n),
    openingCashCents: shift.openingCashCents as ShiftSummary['openingCashCents'],
    expectedCashCents: expectedCashCents as ShiftSummary['expectedCashCents'],
    byMethod,
  };
}

// -----------------------------------------------------------------------------
// Cash in / out of the drawer (not sales) — migrations/0021_cash_movements.sql
// -----------------------------------------------------------------------------

/**
 * Pay-ins and pay-outs (tip-outs count as out) recorded against a shift.
 * riderCents / riderCount: the payouts linked to an order (migration 0049) —
 * a delivery charge an outside rider kept, or a trip paid for an order then
 * cancelled. They are a part of outCents, which stays ALL the cash taken out,
 * so the expected-cash formulas built on in / out do not change.
 */
export function cashMovementTotals(
  db: AppDatabase,
  shiftId: string,
): { inCents: number; outCents: number; riderCents: number; riderCount: number } {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'payin' THEN amount_cents ELSE 0 END), 0) AS inCents,
         COALESCE(SUM(CASE WHEN type IN ('payout', 'tip_out') THEN amount_cents ELSE 0 END), 0) AS outCents,
         COALESCE(SUM(CASE WHEN type = 'payout' AND order_id IS NOT NULL THEN amount_cents ELSE 0 END), 0) AS riderCents,
         COALESCE(SUM(CASE WHEN type = 'payout' AND order_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS riderCount
        FROM cash_movements WHERE shift_id = ? AND deleted_at IS NULL`,
    )
    .get(shiftId) as { inCents: number; outCents: number; riderCents: number; riderCount: number };
  return {
    inCents: Number(row.inCents),
    outCents: Number(row.outCents),
    riderCents: Number(row.riderCents),
    riderCount: Number(row.riderCount),
  };
}

interface CashMovementRow {
  id: string;
  shift_id: string;
  type: CashMovementType;
  amount_cents: number;
  reason: string;
  user_id: string;
  user_name: string | null;
  approved_by_user_id: string | null;
  created_at: string;
  ref_purchase_order_id: string | null;
  order_id: string | null;
  order_number: string | null;
}

function rowToCashMovement(r: CashMovementRow): CashMovement {
  return {
    id: r.id as CashMovement['id'],
    shiftId: r.shift_id as CashMovement['shiftId'],
    type: r.type,
    amountCents: r.amount_cents as CashMovement['amountCents'],
    reason: r.reason,
    userId: r.user_id as CashMovement['userId'],
    userName: r.user_name,
    approvedByUserId: r.approved_by_user_id as CashMovement['approvedByUserId'],
    createdAt: r.created_at,
    refPurchaseOrderId: (r.ref_purchase_order_id ?? null) as CashMovement['refPurchaseOrderId'],
    orderId: (r.order_id ?? null) as CashMovement['orderId'],
    orderNumber: r.order_id ? (r.order_number ?? null) : null,
  };
}

/** Read with `FROM cash_movements m LEFT JOIN users u … LEFT JOIN orders o ON o.id = m.order_id`. */
const CASH_MOVEMENT_SELECT = `
  m.id, m.shift_id, m.type, m.amount_cents, m.reason, m.user_id,
  u.full_name AS user_name, m.approved_by_user_id, m.created_at, m.ref_purchase_order_id,
  m.order_id, o.order_number
`;

export function listCashMovements(db: AppDatabase, shiftId: string): CashMovement[] {
  const rows = db
    .prepare(
      `SELECT ${CASH_MOVEMENT_SELECT}
         FROM cash_movements m
         LEFT JOIN users u ON u.id = m.user_id
         LEFT JOIN orders o ON o.id = m.order_id
        WHERE m.shift_id = ? AND m.deleted_at IS NULL
        ORDER BY m.created_at`,
    )
    .all(shiftId) as CashMovementRow[];
  return rows.map(rowToCashMovement);
}

/** One cash movement by id, or null. */
export function findCashMovement(db: AppDatabase, id: string): CashMovement | null {
  const row = db
    .prepare(
      `SELECT ${CASH_MOVEMENT_SELECT}
         FROM cash_movements m
         LEFT JOIN users u ON u.id = m.user_id
         LEFT JOIN orders o ON o.id = m.order_id
        WHERE m.id = ? AND m.deleted_at IS NULL`,
    )
    .get(id) as CashMovementRow | undefined;
  return row ? rowToCashMovement(row) : null;
}

/**
 * Cash paid out of THIS till's drawer (payouts; not cash in, not rider
 * tips), newest first, with the purchase each is linked to — for "Turn this
 * payout into a purchase" (costing spec Phase 5). The shifts' own history on
 * this till: the other till's payouts are its own. A payout to an outside
 * rider for an order (migration 0049) is not on the list: it bought nothing.
 */
export function listDrawerPayouts(
  db: AppDatabase,
  deviceId: string,
  opts: { sinceIso?: string; limit?: number } = {},
): DrawerPayout[] {
  const since = opts.sinceIso ?? new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = db
    .prepare(
      `SELECT m.id, m.shift_id, m.amount_cents, m.reason, m.created_at, m.ref_purchase_order_id,
              u.full_name AS user_name, a.full_name AS approved_by_name
         FROM cash_movements m
         JOIN shifts s ON s.id = m.shift_id
         LEFT JOIN users u ON u.id = m.user_id
         LEFT JOIN users a ON a.id = m.approved_by_user_id
        WHERE m.type = 'payout' AND m.deleted_at IS NULL AND m.order_id IS NULL
          AND s.device_id = ? AND m.created_at >= ?
        ORDER BY m.created_at DESC LIMIT ?`,
    )
    .all(deviceId, since, limit) as Array<{
    id: string;
    shift_id: string;
    amount_cents: number;
    reason: string;
    created_at: string;
    ref_purchase_order_id: string | null;
    user_name: string | null;
    approved_by_name: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id as UUID,
    shiftId: r.shift_id as UUID,
    amountCents: Number(r.amount_cents),
    reason: r.reason,
    createdAt: r.created_at,
    userName: r.user_name,
    approvedByName: r.approved_by_name,
    refPurchaseOrderId: (r.ref_purchase_order_id ?? null) as UUID | null,
  }));
}

/** Why a payout to an outside rider can't become a purchase. */
export const RIDER_PAYOUT_NOT_A_PURCHASE = "A delivery charge kept by a rider can't be turned into a purchase";

/**
 * Link a free-text payout to the purchase it paid for ("Turn this payout
 * into a purchase", costing spec Phase 5): ONCE — a payout already linked
 * is refused. Only the link changes: the amount, and so the shift's expected
 * cash, stays exactly as it was. Synced and audited, in the caller's
 * transaction when there is one. A payout to an outside rider for an order
 * (migration 0049) is refused: it bought nothing. procurement-repo's
 * payoutToPurchase links through here, so it is refused there too, and the
 * purchase it was writing goes with the refusal.
 */
export function linkPayoutToPurchase(
  db: AppDatabase,
  cashMovementId: string,
  purchaseOrderId: string,
  actor: Actor,
): CashMovement {
  return db.transaction((): CashMovement => {
    const before = findCashMovement(db, cashMovementId);
    if (!before) throw new Error('That cash payout was not found');
    if (before.type !== 'payout') throw new Error('Only cash taken out of the drawer can be turned into a purchase');
    if (before.orderId) throw new Error(RIDER_PAYOUT_NOT_A_PURCHASE);
    if (before.refPurchaseOrderId) throw new Error('That payout is already a purchase');
    const now = nowIso();
    db.prepare(
      `UPDATE cash_movements SET ref_purchase_order_id = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND ref_purchase_order_id IS NULL AND order_id IS NULL`,
    ).run(purchaseOrderId, now, cashMovementId);
    const after = findCashMovement(db, cashMovementId)!;
    enqueueSync(db, { entityType: 'cash_movements', entityId: cashMovementId, op: 'upsert', payload: after });
    writeAudit(db, {
      entityType: 'cash_movements',
      entityId: cashMovementId,
      action: 'link_purchase',
      actorUserId: actor.userId,
      before,
      after,
    });
    return after;
  })();
}

export interface RecordCashMovementInput {
  type: CashMovementType;
  amountCents: number;
  reason: string;
  approvedByUserId?: string | null;
  /** The purchase this payout pays for (a purchase "Paid from the drawer", costing spec Phase 5). */
  refPurchaseOrderId?: string | null;
}

/** A cash movement just recorded, and the drawer_opens row its pulse is for. */
export type RecordedCashMovement = CashMovement & { drawerOpenId: string };

/**
 * Record cash into or out of this till's open drawer. It belongs to the shift
 * open on this device now — there is no drawer to put it in otherwise. The
 * drawer opens for the notes, so its drawer_opens row (kind = the movement
 * type, the amount signed: + cash in, − cash out or a tip) is written in the
 * same transaction — also inside a caller's (a purchase paid from the drawer).
 */
export function recordCashMovement(
  db: AppDatabase,
  input: RecordCashMovementInput,
  actor: Actor & { userId: string },
): RecordedCashMovement {
  return db.transaction((): RecordedCashMovement => {
    const movement = recordCashMovementRow(db, input, actor);
    const drawer = recordDrawerOpen(
      db,
      {
        kind: movement.type,
        reason: movement.reason,
        approvedByUserId: movement.approvedByUserId,
        cashMovementId: movement.id,
        amountCents: movement.type === 'payin' ? movement.amountCents : -movement.amountCents,
      },
      actor,
    );
    return { ...movement, drawerOpenId: drawer.id };
  })();
}

/**
 * What only this file passes to recordCashMovementRow — never the
 * 'shifts:recordCashMovement' path, so cash typed by hand is never linked to
 * an order and is always audited `cash_<type>`.
 */
interface CashMovementRowOptions {
  /** The order an outside rider is paid for (cash_movements.order_id, migration 0049). */
  orderId?: string | null;
  /** The audit action in place of `cash_<type>`. */
  auditAction?: string;
  /** Said in the audit after-image as well (never in the row). */
  auditExtra?: Readonly<Record<string, unknown>>;
}

function recordCashMovementRow(
  db: AppDatabase,
  input: RecordCashMovementInput,
  actor: Actor & { userId: string },
  opts: CashMovementRowOptions = {},
): CashMovement {
  const amount = Math.round(input.amountCents);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter an amount above zero');
  if (amount > 10_000_000_00) throw new Error('That amount is too large for the drawer');
  if (input.type !== 'payin' && input.type !== 'payout' && input.type !== 'tip_out') {
    throw new Error('Unknown cash movement type');
  }
  const reason = input.reason.trim();
  if (!reason) throw new Error('Say what the cash was for (e.g. "Gas cylinder", "Change from bank")');
  const shift = getCurrentShift(db, actor.deviceId);
  if (!shift) throw new Error('No shift is open on this till — open a shift first');

  const orderId = opts.orderId ?? null;
  const id = uuidv7();
  const now = nowIso();
  const after = {
    id,
    shiftId: shift.id,
    type: input.type,
    amountCents: amount,
    reason,
    userId: actor.userId,
    approvedByUserId: input.approvedByUserId ?? null,
    createdAt: now,
    refPurchaseOrderId: input.type === 'payout' ? (input.refPurchaseOrderId ?? null) : null,
    // Cash typed by hand keeps the after-image it always had.
    ...(orderId !== null ? { orderId } : {}),
    ...(opts.auditExtra ?? {}),
  };
  writeWithSync({
    db,
    entityType: 'cash_movements',
    entityId: id,
    op: 'upsert',
    action: opts.auditAction ?? `cash_${input.type}`,
    actor,
    before: null,
    after,
    writeRow: () => {
      db.prepare(
        `INSERT INTO cash_movements
           (id, shift_id, type, amount_cents, reason, user_id, approved_by_user_id, ref_purchase_order_id,
            order_id, created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        id,
        shift.id,
        input.type,
        amount,
        reason,
        actor.userId,
        input.approvedByUserId ?? null,
        after.refPurchaseOrderId,
        orderId,
        now,
        now,
        actor.deviceId,
      );
    },
  });
  log.info('Cash movement', { id, type: input.type, amount, shiftId: shift.id, ...(orderId !== null ? { orderId } : {}) });
  return listCashMovements(db, shift.id).find((m) => m.id === id)!;
}

/**
 * How a trip paid to an outside rider is worded ("Trip paid to the outside
 * rider — Order #0042 cancelled" / "… went alone"); a kept delivery charge
 * says "Delivery charge kept by the outside rider — Order #0042". The row has
 * no column for which it is, and the reason travels with it to the other
 * till, so the two are told apart by these words (the close result, the
 * order's snapshot).
 */
export const TRIP_PAYOUT_REASON_START = 'Trip paid to the outside rider';

/** What an outside rider is paid from the drawer for one order. */
export interface DeliveryChargeToRiderInput {
  /** The order he was sent out with (cash_movements.order_id). */
  orderId: string;
  /** Its number ("20261002-0042"): the payout's reason says "Order #0042". */
  orderNumber: string;
  /** What he is paid, in paisa: the order's frozen rider_keeps_cents (above zero). */
  amountCents: number;
  /**
   * kept: he kept the delivery charge out of the customer's money (the
   * owner, 2 Oct 2026: "the drawer expects the food total from the rider");
   * trip: he went, and the order was then cancelled or refused at the door
   * ("pay the rider's fee if they went").
   */
  why: 'kept' | 'trip';
  /**
   * Which trip, for why 'trip': 'cancelled' (the default: the order was then
   * cancelled or refused at the door), or 'went_alone' (an add-on delivery
   * whose charge was left off for the same customer's first delivery, which
   * is no longer here: it went out alone, OrderSnapshot.goesAlone).
   */
  tripWhy?: 'cancelled' | 'went_alone';
  /** The manager whose PIN let a cashier do it (a cancel, a trip paid at Send out); null when the actor is a manager. */
  approvedByUserId?: string | null;
}

/**
 * Pay an outside rider his delivery charge for one order: ONE cash payout
 * linked to the order (migration 0049), in this till's open shift, synced and
 * audited 'delivery_charge_to_rider' (never 'cash_payout') with `why` in the
 * after-image. It writes NO drawer row: the caller writes that event's one
 * drawer row (the cash sale less his fee, or the payout itself) and points it
 * at this movement. With no shift open on this till it is refused and
 * nothing is written — callers check first and refuse in their own words.
 * In the caller's transaction when there is one. Returns the movement's id.
 *
 * The payout is a part of the shift's cash taken out (cashMovementTotals
 * outCents), so the expected cash is the food total he hands over, and the
 * close box can say how much of the cash out went to riders (riderCents).
 */
export function recordDeliveryChargeToRider(
  db: AppDatabase,
  input: DeliveryChargeToRiderInput,
  actor: Actor & { userId: string },
): string {
  return db.transaction((): string => {
    if (!input.orderId) throw new Error('Say which order the rider is paid for');
    if (input.why !== 'kept' && input.why !== 'trip') throw new Error('Say why the rider is paid');
    if (!getCurrentShift(db, actor.deviceId)) throw new Error('No shift is open on this till — open a shift first');
    const order = shortOrderNumber(input.orderNumber);
    const alone = input.why === 'trip' && input.tripWhy === 'went_alone';
    const reason =
      input.why === 'kept'
        ? `Delivery charge kept by the outside rider — Order ${order}`
        : alone
          ? `${TRIP_PAYOUT_REASON_START} — Order ${order} went alone`
          : `${TRIP_PAYOUT_REASON_START} — Order ${order} cancelled`;
    const movement = recordCashMovementRow(
      db,
      {
        type: 'payout',
        amountCents: input.amountCents,
        reason,
        approvedByUserId: input.approvedByUserId ?? null,
      },
      actor,
      { orderId: input.orderId, auditAction: 'delivery_charge_to_rider', auditExtra: { why: input.why, ...(alone ? { tripWhy: 'went_alone' } : {}) } },
    );
    return movement.id;
  })();
}

/** The drawer count this till's last closed shift ended on — tonight's float. */
export function getLastCount(
  db: AppDatabase,
  deviceId: string,
): { countedCashCents: number; closedAt: string } | null {
  const row = db
    .prepare(
      `SELECT counted_cash_cents, closed_at FROM shifts
        WHERE device_id = ? AND closed_at IS NOT NULL AND counted_cash_cents IS NOT NULL
          AND deleted_at IS NULL
        ORDER BY closed_at DESC LIMIT 1`,
    )
    .get(deviceId) as { counted_cash_cents: number; closed_at: string } | undefined;
  return row ? { countedCashCents: row.counted_cash_cents, closedAt: row.closed_at } : null;
}
