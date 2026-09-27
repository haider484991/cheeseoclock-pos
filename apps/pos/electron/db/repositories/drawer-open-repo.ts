import { v7 as uuidv7 } from 'uuid';
import log from 'electron-log/main';
import type { AppDatabase } from '../connection.js';
import { writeWithSync, nowIso, type Actor } from './base.js';
import { getSettingRaw } from './settings-repo.js';
import type {
  DrawerLogCounts,
  DrawerLogGroup,
  DrawerLogPage,
  DrawerOpen,
  DrawerOpenKind,
  DrawerOutcome,
  ReportDrawerLogLine,
  UUID,
} from '@cheeseoclock/shared-types';

/**
 * The cash drawer log (migrations/0028_drawer_opens.sql + 0040_drawer_log.sql):
 * one synced row plus a hash-chained audit entry (action drawer_<kind>) for
 * EVERY time the till opens the cash drawer:
 *  - by hand — Open drawer (no sale), "Open drawer to count" at close, Test
 *    drawer (drawer-service.ts): recorded first, then the pulse;
 *  - for cash — a cash sale or collection, a cash refund, the float at shift
 *    open, cash in / out, a rider's tip, a purchase paid from the drawer:
 *    recorded by the repository that moves the cash, INSIDE its transaction
 *    (order-repo, shift-repo, procurement-repo), so a row can't be written
 *    twice and a crash can't leave cash with no row.
 * "No row, no pulse": the spooler pulses the drawer only for a row
 * (kickDrawerNow / kickDrawerSoon / a drawer job carrying its id), and
 * settles the row's outcome once the printer answered (settleDrawerOpen,
 * audit action drawer_result). The log has no delete.
 */

const KINDS: ReadonlySet<string> = new Set<DrawerOpenKind>([
  'no_sale',
  'count',
  'test',
  'sale',
  'refund',
  'float',
  'payin',
  'payout',
  'tip_out',
]);

const OUTCOMES: ReadonlySet<string> = new Set<DrawerOutcome>(['opened', 'already_open', 'not_opened', 'unsure', 'no_printer']);

/** Longest reason kept — the quick chips are one or two words. */
export const DRAWER_REASON_MAX = 80;

/** Setting written by migration 0040: when the drawer log started on this till (ISO). */
export const DRAWER_LOG_SINCE_KEY = 'drawer.logSince';

/** The note on a row the till never settled because it stopped first (boot sweep). */
export const ABANDONED_NOTE = 'The till stopped before it knew whether the drawer opened';

export interface RecordDrawerOpenInput {
  kind: DrawerOpenKind;
  reason?: string | null;
  /** The manager whose PIN let a cashier open it (or allowed the refund); null/absent otherwise. */
  approvedByUserId?: string | null;
  /** The order the cash was for (sale, refund). */
  orderId?: string | null;
  /** The cash in / out it was for (payin, payout, tip_out). */
  cashMovementId?: string | null;
  /** Signed paisa: + into the drawer, − out. Null for no_sale / count / test. */
  amountCents?: number | null;
}

interface DrawerOpenRow {
  id: string;
  shift_id: string | null;
  kind: string;
  reason: string | null;
  user_id: string;
  approved_by_user_id: string | null;
  created_at: string;
  order_id: string | null;
  cash_movement_id: string | null;
  amount_cents: number | null;
  outcome: string | null;
  outcome_note: string | null;
  settled_at: string | null;
  device_id: string;
}

const ROW_SELECT = `id, shift_id, kind, reason, user_id, approved_by_user_id, created_at,
                    order_id, cash_movement_id, amount_cents, outcome, outcome_note, settled_at, device_id`;

function rowToDrawerOpen(r: DrawerOpenRow): DrawerOpen {
  return {
    id: r.id as UUID,
    shiftId: r.shift_id as UUID | null,
    kind: r.kind as DrawerOpenKind,
    reason: r.reason,
    userId: r.user_id as UUID,
    approvedByUserId: r.approved_by_user_id as UUID | null,
    createdAt: r.created_at,
    orderId: (r.order_id ?? null) as UUID | null,
    cashMovementId: (r.cash_movement_id ?? null) as UUID | null,
    amountCents: r.amount_cents === null || r.amount_cents === undefined ? null : Number(r.amount_cents),
    outcome: r.outcome !== null && OUTCOMES.has(r.outcome) ? (r.outcome as DrawerOutcome) : null,
    outcomeNote: r.outcome_note ?? null,
    settledAt: r.settled_at ?? null,
  };
}

/** Trimmed, one line, at most DRAWER_REASON_MAX characters; null when empty. */
export function cleanDrawerReason(reason: string | null | undefined): string | null {
  const text = (reason ?? '').replace(/\s+/g, ' ').trim().slice(0, DRAWER_REASON_MAX).trim();
  return text === '' ? null : text;
}

/**
 * The shift open on this till now (the same query as shift-repo's
 * getCurrentShift; read here because shift-repo writes drawer rows too).
 */
function currentShiftId(db: AppDatabase, deviceId: string): string | null {
  const row = db
    .prepare(
      `SELECT id FROM shifts
        WHERE device_id = ? AND closed_at IS NULL AND deleted_at IS NULL
        ORDER BY opened_at DESC LIMIT 1`,
    )
    .get(deviceId) as { id: string } | undefined;
  return row?.id ?? null;
}

/** Has this shift already had its "open to count"? */
function shiftHasCount(db: AppDatabase, shiftId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 AS hit FROM drawer_opens
          WHERE shift_id = ? AND kind = 'count' AND deleted_at IS NULL LIMIT 1`,
      )
      .get(shiftId) !== undefined
  );
}

/**
 * Record one drawer open against the shift open on this till (none →
 * shift_id NULL: an open with no shift is still on record, under the person's
 * name). A shift gets one "count" open; any later one is recorded as a
 * no-sale open, so pressing "Open drawer to count" again and again can't
 * hide opens from the no-sale figures.
 *
 * Row + sync + audit (drawer_<kind>) in one transaction — a savepoint when
 * called inside another repository's transaction, which is how the cash
 * kinds are written: in the same transaction as the cash.
 */
export function recordDrawerOpen(
  db: AppDatabase,
  input: RecordDrawerOpenInput,
  actor: Actor & { userId: string },
): DrawerOpen {
  if (!KINDS.has(input.kind)) throw new Error('Unknown drawer open');
  const amount = input.amountCents ?? null;
  if (amount !== null && (!Number.isInteger(amount) || !Number.isFinite(amount))) {
    throw new Error('A drawer amount is whole paisa');
  }
  const shiftId = currentShiftId(db, actor.deviceId);
  let kind: DrawerOpenKind = input.kind;
  let reason = cleanDrawerReason(input.reason);
  if (kind === 'count' && (shiftId === null || shiftHasCount(db, shiftId))) {
    kind = 'no_sale';
    reason = reason ?? 'Opened again to count';
  }
  const id = uuidv7();
  const now = nowIso();
  const approvedByUserId = input.approvedByUserId ?? null;
  const orderId = input.orderId ?? null;
  const cashMovementId = input.cashMovementId ?? null;
  const after = {
    id,
    shiftId,
    kind,
    reason,
    userId: actor.userId,
    approvedByUserId,
    orderId,
    cashMovementId,
    amountCents: amount,
    outcome: null,
    // audit_log has no device column; the shop may run two tills.
    deviceId: actor.deviceId,
    createdAt: now,
  };
  writeWithSync({
    db,
    // The sync entity type is the table name (row images are read by it).
    entityType: 'drawer_opens',
    entityId: id,
    op: 'upsert',
    action: `drawer_${kind}`,
    actor,
    before: null,
    after,
    writeRow: () => {
      db.prepare(
        `INSERT INTO drawer_opens
           (id, shift_id, kind, reason, user_id, approved_by_user_id, order_id, cash_movement_id,
            amount_cents, created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        id,
        shiftId,
        kind,
        reason,
        actor.userId,
        approvedByUserId,
        orderId,
        cashMovementId,
        amount,
        now,
        now,
        actor.deviceId,
      );
    },
  });
  log.info('Cash drawer open recorded', { id, kind, shiftId, approved: approvedByUserId !== null, orderId });
  return rowToDrawerOpen({
    id,
    shift_id: shiftId,
    kind,
    reason,
    user_id: actor.userId,
    approved_by_user_id: approvedByUserId,
    created_at: now,
    order_id: orderId,
    cash_movement_id: cashMovementId,
    amount_cents: amount,
    outcome: null,
    outcome_note: null,
    settled_at: null,
    device_id: actor.deviceId,
  });
}

/** One drawer open by id (any till), or null. */
export function findDrawerOpen(db: AppDatabase, id: string): DrawerOpen | null {
  const row = db.prepare(`SELECT ${ROW_SELECT} FROM drawer_opens WHERE id = ? AND deleted_at IS NULL`).get(id) as
    | DrawerOpenRow
    | undefined;
  return row ? rowToDrawerOpen(row) : null;
}

/**
 * What the pulse did for this open. The first settle wins: a row that already
 * has an outcome is left as it is (nothing written). Row + sync + audit
 * (action drawer_result, before/after) in one transaction. Returns whether it
 * was written. The spooler calls it inside a try/catch: a drawer's result is
 * never the reason a sale or a print fails.
 */
export function settleDrawerOpen(
  db: AppDatabase,
  id: string,
  outcome: DrawerOutcome,
  note: string | null = null,
): boolean {
  if (!OUTCOMES.has(outcome)) throw new Error('Unknown drawer result');
  return db.transaction((): boolean => {
    const row = db.prepare(`SELECT ${ROW_SELECT} FROM drawer_opens WHERE id = ?`).get(id) as DrawerOpenRow | undefined;
    if (!row || row.outcome !== null) return false;
    const before = rowToDrawerOpen(row);
    const now = nowIso();
    const outcomeNote = note === null ? null : note.replace(/\s+/g, ' ').trim().slice(0, 240) || null;
    const after: DrawerOpen & { deviceId: string } = {
      ...before,
      outcome,
      outcomeNote,
      settledAt: now,
      deviceId: row.device_id,
    };
    writeWithSync({
      db,
      entityType: 'drawer_opens',
      entityId: id,
      op: 'upsert',
      action: 'drawer_result',
      // Nobody pressed anything: the printer answered.
      actor: { userId: null, deviceId: row.device_id },
      before,
      after,
      writeRow: () => {
        db.prepare(
          `UPDATE drawer_opens
              SET outcome = ?, outcome_note = ?, settled_at = ?, updated_at = ?, version = version + 1
            WHERE id = ? AND outcome IS NULL`,
        ).run(outcome, outcomeNote, now, now, id);
      },
    });
    return true;
  })();
}

/** When the drawer log started on this till (null on a database that never ran 0040). */
export function drawerLogSince(db: AppDatabase): string | null {
  const v = getSettingRaw(db, DRAWER_LOG_SINCE_KEY);
  return typeof v === 'string' && v ? v : null;
}

/**
 * Once at boot (after the spooler recovered its jobs): this till's opens that
 * never got a result — the app stopped between the row and the answer — are
 * settled 'unsure'. Never a row from before the log started (0028's rows have
 * no result and never will), never the other till's, and never one a drawer
 * job still waiting will settle. Returns how many.
 */
export function settleAbandonedDrawerOpens(db: AppDatabase, deviceId: string): number {
  const since = drawerLogSince(db);
  if (since === null) return 0;
  const rows = db
    .prepare(
      `SELECT d.id FROM drawer_opens d
        WHERE d.outcome IS NULL AND d.device_id = ? AND d.created_at >= ? AND d.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM print_queue q
             WHERE q.job_kind = 'drawer' AND q.status = 'pending'
               AND json_extract(q.payload_json, '$.drawerOpenId') = d.id)
        ORDER BY d.created_at`,
    )
    .all(deviceId, since) as Array<{ id: string }>;
  let n = 0;
  for (const r of rows) {
    if (settleDrawerOpen(db, r.id, 'unsure', ABANDONED_NOTE)) n += 1;
  }
  return n;
}

/** The opens on one shift, oldest first. */
export function listDrawerOpens(db: AppDatabase, shiftId: string): DrawerOpen[] {
  const rows = db
    .prepare(
      `SELECT ${ROW_SELECT}
         FROM drawer_opens
        WHERE shift_id = ? AND deleted_at IS NULL
        ORDER BY created_at, id`,
    )
    .all(shiftId) as DrawerOpenRow[];
  return rows.map(rowToDrawerOpen);
}

// -----------------------------------------------------------------------------
// The owner's log (Reports → Team & leakage)
// -----------------------------------------------------------------------------

const GROUP_SQL: Record<DrawerLogGroup, string> = {
  all: '',
  sales: `AND d.kind IN ('sale', 'refund')`,
  cash: `AND d.kind IN ('payin', 'payout', 'tip_out', 'float')`,
  nosale: `AND d.kind IN ('no_sale', 'count', 'test')`,
  problems: `AND d.outcome IN ('not_opened', 'unsure')`,
};

export const DRAWER_LOG_MAX_LIMIT = 200;
export const DRAWER_LOG_DEFAULT_LIMIT = 50;

export interface DrawerLogQuery {
  sinceIso: string;
  untilIso: string;
  shiftId?: string | undefined;
  group?: DrawerLogGroup | undefined;
  /** "createdAt|id" of the last row of the previous page. */
  cursor?: string | undefined;
  limit?: number | undefined;
}

/** "createdAt|id" → its parts, or null when it is not one. */
function readCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (typeof cursor !== 'string') return null;
  const i = cursor.lastIndexOf('|');
  if (i <= 0 || i === cursor.length - 1) return null;
  return { at: cursor.slice(0, i), id: cursor.slice(i + 1) };
}

/**
 * The drawer log of a period (and optionally one shift), newest first, one
 * page at a time (keyset on created_at, id), with the counts per kind and
 * per result over the whole period. `deviceId`: this till (a row from the
 * other one says so).
 */
export function listDrawerLog(db: AppDatabase, q: DrawerLogQuery, deviceId: string): DrawerLogPage {
  const limit = Math.min(Math.max(Math.floor(q.limit ?? DRAWER_LOG_DEFAULT_LIMIT), 1), DRAWER_LOG_MAX_LIMIT);
  const group: DrawerLogGroup = q.group && q.group in GROUP_SQL ? q.group : 'all';
  const scope = `d.created_at >= ? AND d.created_at < ? AND d.deleted_at IS NULL${q.shiftId ? ' AND d.shift_id = ?' : ''}`;
  const scopeArgs: unknown[] = [q.sinceIso, q.untilIso, ...(q.shiftId ? [q.shiftId] : [])];
  const cursor = readCursor(q.cursor);
  const rows = db
    .prepare(
      `SELECT d.id, d.created_at AS createdAt, d.device_id AS deviceId, d.kind, d.reason,
              d.amount_cents AS amountCents, d.outcome, d.outcome_note AS outcomeNote,
              d.shift_id AS shiftId, d.approved_by_user_id AS approverId,
              COALESCE(u.full_name, 'Unknown') AS openedBy, ua.full_name AS approvedBy,
              o.order_number AS orderNumber, o.deleted_at AS orderDeletedAt, o.delete_kind AS orderDeleteKind
         FROM drawer_opens d
         LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN users ua ON ua.id = d.approved_by_user_id
         LEFT JOIN orders o ON o.id = d.order_id
        WHERE ${scope} ${GROUP_SQL[group]}
          ${cursor ? 'AND (d.created_at < ? OR (d.created_at = ? AND d.id < ?))' : ''}
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT ?`,
    )
    .all(...scopeArgs, ...(cursor ? [cursor.at, cursor.at, cursor.id] : []), limit + 1) as Array<{
    id: string;
    createdAt: string;
    deviceId: string;
    kind: string;
    reason: string | null;
    amountCents: number | null;
    outcome: string | null;
    outcomeNote: string | null;
    shiftId: string | null;
    approverId: string | null;
    openedBy: string;
    approvedBy: string | null;
    orderNumber: string | null;
    orderDeletedAt: string | null;
    orderDeleteKind: string | null;
  }>;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = rows.length > limit && last ? `${last.createdAt}|${last.id}` : null;

  const counts: DrawerLogCounts = { total: 0, byKind: {}, byOutcome: {} };
  const kindRows = db
    .prepare(`SELECT d.kind AS k, COUNT(*) AS n FROM drawer_opens d WHERE ${scope} GROUP BY d.kind`)
    .all(...scopeArgs) as Array<{ k: string; n: number }>;
  for (const r of kindRows) {
    counts.byKind[r.k] = Number(r.n);
    counts.total += Number(r.n);
  }
  const outcomeRows = db
    .prepare(
      `SELECT COALESCE(d.outcome, 'unknown') AS o, COUNT(*) AS n FROM drawer_opens d WHERE ${scope} GROUP BY COALESCE(d.outcome, 'unknown')`,
    )
    .all(...scopeArgs) as Array<{ o: string; n: number }>;
  for (const r of outcomeRows) counts.byOutcome[r.o] = Number(r.n);

  const lines: ReportDrawerLogLine[] = page.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    till: r.deviceId === deviceId ? 'this' : 'other',
    kind: r.kind,
    orderNumber: r.orderNumber ?? null,
    orderDeletedAsTest: r.orderDeletedAt !== null && r.orderDeletedAt !== undefined && r.orderDeleteKind === 'test',
    amountCents: r.amountCents === null || r.amountCents === undefined ? null : Number(r.amountCents),
    reason: r.reason,
    openedBy: r.openedBy,
    approvedBy: r.approverId === null ? null : (r.approvedBy ?? 'Unknown'),
    outcome: r.outcome,
    outcomeNote: r.outcomeNote,
    outsideShift: r.shiftId === null,
    shiftId: r.shiftId,
  }));
  return { rows: lines, nextCursor, counts, logSince: drawerLogSince(db) };
}
