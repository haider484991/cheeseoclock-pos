import { v7 as uuidv7 } from 'uuid';
import log from 'electron-log/main';
import type { AppDatabase } from '../connection.js';
import { writeWithSync, nowIso, type Actor } from './base.js';
import { getCurrentShift } from './shift-repo.js';
import type { DrawerOpen, DrawerOpenKind, UUID } from '@cheeseoclock/shared-types';

/**
 * Manual cash-drawer opens (migrations/0028_drawer_opens.sql): the Open
 * drawer button, "Open drawer to count" at close, and Test drawer. Each one
 * is a synced row plus a hash-chained audit entry (action drawer_no_sale /
 * drawer_count / drawer_test), written BEFORE the drawer is pulsed so an
 * open is on record even if the printer then fails.
 */

const KINDS: ReadonlySet<string> = new Set<DrawerOpenKind>(['no_sale', 'count', 'test']);

/** Longest reason kept — the quick chips are one or two words. */
export const DRAWER_REASON_MAX = 80;

export interface RecordDrawerOpenInput {
  kind: DrawerOpenKind;
  reason?: string | null;
  /** The manager whose PIN let a cashier open it; null/absent when a manager did it. */
  approvedByUserId?: string | null;
}

interface DrawerOpenRow {
  id: string;
  shift_id: string | null;
  kind: string;
  reason: string | null;
  user_id: string;
  approved_by_user_id: string | null;
  created_at: string;
}

function rowToDrawerOpen(r: DrawerOpenRow): DrawerOpen {
  return {
    id: r.id as UUID,
    shiftId: r.shift_id as UUID | null,
    kind: r.kind as DrawerOpenKind,
    reason: r.reason,
    userId: r.user_id as UUID,
    approvedByUserId: r.approved_by_user_id as UUID | null,
    createdAt: r.created_at,
  };
}

/** Trimmed, one line, at most DRAWER_REASON_MAX characters; null when empty. */
export function cleanDrawerReason(reason: string | null | undefined): string | null {
  const text = (reason ?? '').replace(/\s+/g, ' ').trim().slice(0, DRAWER_REASON_MAX).trim();
  return text === '' ? null : text;
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
 * Record one manual drawer open against the shift open on this till (none →
 * shift_id NULL: an open with no shift is still on record, under the person's
 * name). A shift gets one "count" open; any later one is recorded as a
 * no-sale open, so pressing "Open drawer to count" again and again can't
 * hide opens from the no-sale figures.
 */
export function recordDrawerOpen(
  db: AppDatabase,
  input: RecordDrawerOpenInput,
  actor: Actor & { userId: string },
): DrawerOpen {
  if (!KINDS.has(input.kind)) throw new Error('Unknown drawer open');
  const shift = getCurrentShift(db, actor.deviceId);
  const shiftId = shift?.id ?? null;
  let kind: DrawerOpenKind = input.kind;
  let reason = cleanDrawerReason(input.reason);
  if (kind === 'count' && (shiftId === null || shiftHasCount(db, shiftId))) {
    kind = 'no_sale';
    reason = reason ?? 'Opened again to count';
  }
  const id = uuidv7();
  const now = nowIso();
  const approvedByUserId = input.approvedByUserId ?? null;
  const after = {
    id,
    shiftId,
    kind,
    reason,
    userId: actor.userId,
    approvedByUserId,
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
           (id, shift_id, kind, reason, user_id, approved_by_user_id,
            created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(id, shiftId, kind, reason, actor.userId, approvedByUserId, now, now, actor.deviceId);
    },
  });
  log.info('Cash drawer opened by hand', { id, kind, shiftId, approved: approvedByUserId !== null });
  return rowToDrawerOpen({
    id,
    shift_id: shiftId,
    kind,
    reason,
    user_id: actor.userId,
    approved_by_user_id: approvedByUserId,
    created_at: now,
  });
}

/** The manual opens on one shift, oldest first. */
export function listDrawerOpens(db: AppDatabase, shiftId: string): DrawerOpen[] {
  const rows = db
    .prepare(
      `SELECT id, shift_id, kind, reason, user_id, approved_by_user_id, created_at
         FROM drawer_opens
        WHERE shift_id = ? AND deleted_at IS NULL
        ORDER BY created_at, id`,
    )
    .all(shiftId) as DrawerOpenRow[];
  return rows.map(rowToDrawerOpen);
}
