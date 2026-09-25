import { v7 as uuidv7 } from 'uuid';
import log from 'electron-log/main';
import type { AppDatabase } from '../connection.js';
import { writeWithSync, nowIso, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import type { Shift, ShiftSummary, UUID } from '@cheeseoclock/shared-types';

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
}

const SHIFT_SELECT = `
  s.id, s.device_id, s.opened_by_user_id,
  uo.full_name AS opened_by_name,
  s.closed_by_user_id,
  uc.full_name AS closed_by_name,
  s.opened_at, s.closed_at,
  s.opening_cash_cents, s.counted_cash_cents,
  s.expected_cash_cents, s.variance_cents, s.notes
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
  };
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

export function openShift(
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
  notes?: string | null;
}

export function closeShift(
  db: AppDatabase,
  input: CloseShiftInput,
  actor: Actor & { userId: string },
): Shift {
  let result!: Shift;
  const tx = db.transaction(() => {
    const before = findShift(db, input.shiftId);
    if (!before) throw new Error('Shift not found');
    if (before.closedAt) throw new Error('Shift is already closed');
    if (input.countedCashCents < 0) throw new Error('Counted cash cannot be negative');

    // Money still to come in (a rider still out, an order not yet paid) must be
    // taken while this shift is open — once it closes, its expected cash is
    // frozen and a payment has no shift to go to (audit 2026-09-25).
    const unpaid = db
      .prepare(
        `SELECT order_number FROM orders
          WHERE device_id = ? AND deleted_at IS NULL AND paid_at IS NULL
            AND status IN ('sent_to_kitchen', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'served')
          ORDER BY created_at LIMIT 6`,
      )
      .all(before.deviceId) as Array<{ order_number: string }>;
    if (unpaid.length > 0) {
      const list = unpaid
        .slice(0, 5)
        .map((o) => `#${o.order_number.split('-').pop()}`)
        .join(', ');
      throw new Error(
        `Collect payment for ${list}${unpaid.length > 5 ? ' and more' : ''} before closing the shift ` +
          `(Live Orders or Order History) — or cancel them with a manager PIN.`,
      );
    }

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
         WHERE COALESCE(p.shift_id, o.shift_id) = ? AND p.method = 'cash' AND p.deleted_at IS NULL`,
      )
      .get(input.shiftId) as { sales: number; refunds: number };
    const expected = before.openingCashCents + cashRow.sales - cashRow.refunds;
    const counted = Math.round(input.countedCashCents);
    const variance = counted - expected;
    const now = nowIso();

    db.prepare(
      `UPDATE shifts
          SET closed_by_user_id = ?, closed_at = ?, counted_cash_cents = ?,
              expected_cash_cents = ?, variance_cents = ?,
              notes = COALESCE(NULLIF(?, ''), notes),
              updated_at = ?, version = version + 1
        WHERE id = ? AND closed_at IS NULL`,
    ).run(
      actor.userId,
      now,
      counted,
      expected,
      variance,
      input.notes?.trim() ?? '',
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
    writeAudit(db, {
      entityType: 'shifts',
      entityId: input.shiftId,
      action: 'shift_close',
      actorUserId: actor.userId,
      before,
      after,
    });

    result = after;
  });
  tx();
  log.info('Shift closed', {
    id: input.shiftId,
    counted: result.countedCashCents,
    variance: result.varianceCents,
  });
  return result;
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
        WHERE COALESCE(p.shift_id, o.shift_id) = ? AND p.deleted_at IS NULL
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
  const expectedCashCents =
    shift.openingCashCents + cashSalesCents - cashRefundsCents;

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
    expectedCashCents: expectedCashCents as ShiftSummary['expectedCashCents'],
    byMethod,
  };
}
