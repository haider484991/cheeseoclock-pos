import { v7 as uuidv7 } from 'uuid';
import log from 'electron-log/main';
import type { AppDatabase } from '../connection.js';
import type { SyncOp } from '@cheeseoclock/shared-types';
import { isRowImage, type SyncChange } from '@cheeseoclock/sync-core';
import { readRowImage } from '../replicable-schema.js';
import { writeAudit } from './audit-repo.js';

export interface SyncEnqueue {
  entityType: string;
  entityId: string;
  op: SyncOp;
  /**
   * The repository's post-image. For a replicable table the queue stores the
   * row as written instead (see enqueueSync); this object is left untouched,
   * because the same object goes into the hash-chained audit row.
   */
  payload: unknown;
  /** Only the "send everything" build sets this; live writes get the queue clock. */
  createdAt?: string;
}

/**
 * Append an entry to sync_queue. MUST be called inside the same transaction
 * that mutates the business row, after the row is written.
 *
 * For a replicable table the payload stored is the row itself, read back by
 * id (a row image: every column, see replicable-schema.ts), not the
 * repository's domain object. The domain objects left out columns the other
 * till needs to rebuild the row (an order line's name and tax snapshot, a
 * user's timestamps), and most tables had no receiver for them at all.
 */
export function enqueueSync(db: AppDatabase, e: SyncEnqueue): void {
  const payload = isRowImage(e.payload) ? e.payload : liveImage(db, e);
  db.prepare(
    `INSERT INTO sync_queue
       (id, entity_type, entity_id, op, payload_json, created_at, attempts)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    uuidv7(),
    e.entityType,
    e.entityId,
    e.op,
    JSON.stringify(payload),
    e.createdAt ?? nextQueueTime(db),
  );
}

function liveImage(db: AppDatabase, e: SyncEnqueue): unknown {
  try {
    return readRowImage(db, e.entityType, e.entityId) ?? e.payload;
  } catch (err) {
    log.warn('Sync: row could not be read as an image; queued as given', {
      entityType: e.entityType,
      error: err instanceof Error ? err.message : String(err),
    });
    return e.payload;
  }
}

/**
 * The queue's clock: now, or just after the newest unsent entry if the PC
 * clock is behind it. The queue is sent in (created_at, rowid) order and the
 * other till applies it in that order, so a change must never sort before one
 * written earlier (a clock set back would otherwise put an order line ahead of
 * its order). One indexed lookup (idx_sync_queue_pending, read backwards).
 */
function nextQueueTime(db: AppDatabase): string {
  const now = new Date().toISOString();
  const last = newestUnsentAt(db);
  if (last === null || now > last) return now;
  const t = Date.parse(last);
  return Number.isFinite(t) ? new Date(t + 1).toISOString() : now;
}

/** The newest unsent entry's stamp (idx_sync_queue_pending, read backwards). */
export function newestUnsentAt(db: AppDatabase): string | null {
  const last = db
    .prepare(
      `SELECT created_at FROM sync_queue WHERE synced_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as { created_at: string } | undefined;
  return last?.created_at ?? null;
}

export interface PendingSyncRow {
  id: string;
  entityType: string;
  entityId: string;
  op: SyncOp;
  payload: unknown;
  createdAt: string;
  attempts: number;
}

interface PendingRow {
  id: string;
  entity_type: string;
  entity_id: string;
  op: SyncOp;
  payload_json: string;
  created_at: string;
  attempts: number;
}

/** The oldest unsent entries, in the order they were written (see listPendingBatch). */
export function listPendingSync(db: AppDatabase, limit = 500): PendingSyncRow[] {
  return listPendingBatch(db, limit, Infinity).rows;
}

/**
 * The next push: the oldest unsent entries in the order they were written,
 * up to `maxRows`, stopping once the payloads add up to `maxBytes` (always at
 * least one; menu items carry their photo, so 500 of them can be several MB).
 * `more` says whether anything was left behind for the next push.
 */
export function listPendingBatch(
  db: AppDatabase,
  maxRows: number,
  maxBytes: number,
): { rows: PendingSyncRow[]; more: boolean } {
  const rows = db
    .prepare(
      `SELECT id, entity_type, entity_id, op, payload_json, created_at, attempts
         FROM sync_queue WHERE synced_at IS NULL ORDER BY created_at, rowid LIMIT ?`,
    )
    .all(maxRows) as PendingRow[];
  const out: PendingSyncRow[] = [];
  let bytes = 0;
  for (const r of rows) {
    bytes += r.payload_json.length;
    if (out.length > 0 && bytes > maxBytes) return { rows: out, more: true };
    out.push({
      id: r.id,
      entityType: r.entity_type,
      entityId: r.entity_id,
      op: r.op,
      payload: safeParse(r.payload_json),
      createdAt: r.created_at,
      attempts: r.attempts,
    });
  }
  return { rows: out, more: rows.length === maxRows };
}

/** A queue entry as sent: the row's own version and updated_at travel with it. */
export function pendingToChange(p: PendingSyncRow, deviceId: string): SyncChange {
  return {
    entityType: p.entityType,
    entityId: p.entityId,
    op: p.op,
    payload: p.payload,
    updatedAt: extractUpdatedAt(p.payload) ?? p.createdAt,
    deviceId,
    version: extractVersion(p.payload) ?? 1,
  };
}

function extractUpdatedAt(payload: unknown): string | null {
  if (payload && typeof payload === 'object') {
    const v = (payload as Record<string, unknown>).updatedAt;
    if (typeof v === 'string') return v;
  }
  return null;
}

function extractVersion(payload: unknown): number | null {
  if (payload && typeof payload === 'object') {
    const v = (payload as Record<string, unknown>).version;
    if (typeof v === 'number') return v;
  }
  return null;
}

export function markSyncedIds(db: AppDatabase, ids: string[]): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `UPDATE sync_queue SET synced_at = ?, attempted_at = ?, last_error = NULL WHERE id = ?`,
  );
  const tx = db.transaction(() => {
    for (const id of ids) stmt.run(now, now, id);
  });
  tx();
}

export function markSyncFailed(db: AppDatabase, ids: string[], error: string): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `UPDATE sync_queue SET attempted_at = ?, attempts = attempts + 1, last_error = ? WHERE id = ?`,
  );
  const tx = db.transaction(() => {
    for (const id of ids) stmt.run(now, error, id);
  });
  tx();
}

export function getPendingCount(db: AppDatabase): number {
  const r = db
    .prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE synced_at IS NULL`)
    .get() as { n: number };
  return r.n;
}

// -----------------------------------------------------------------------------
// sync_state — key/value cursor + status
// -----------------------------------------------------------------------------

export function getSyncState(db: AppDatabase, key: string): string | null {
  const row = db.prepare(`SELECT value FROM sync_state WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSyncState(db: AppDatabase, key: string, value: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now);
}

export function deleteSyncState(db: AppDatabase, key: string): void {
  db.prepare(`DELETE FROM sync_state WHERE key = ?`).run(key);
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// "Send everything once": the marker that says the queue no longer holds
// everything the other till needs.
// -----------------------------------------------------------------------------

export const SYNC_SNAPSHOT_KEYS = {
  needed: 'snapshot.needed',
  lastDoneAt: 'snapshot.last_done_at',
  lastRows: 'snapshot.last_rows',
  destination: 'sync.destination',
} as const;

export type SnapshotReason =
  /** Unsent rows were cleared while the link was off (housekeeping). */
  | 'unsent_cleared'
  /** The link now points somewhere this till has not sent its data to. */
  | 'new_destination'
  /** The first place this till's link has pointed since row images (see noteSyncDestination). */
  | 'first_link'
  /** A manager asked for it in Settings. */
  | 'asked';

export interface SnapshotMarker {
  reason: string;
  at: string;
  /** Changes on every mark, so a build only clears the marker it started from. */
  gen: string;
}

export function readSnapshotMarker(db: AppDatabase): SnapshotMarker | null {
  const raw = getSyncState(db, SYNC_SNAPSHOT_KEYS.needed);
  if (raw === null) return null;
  const parsed = safeParse(raw) as Partial<SnapshotMarker> | null;
  // Unreadable still means "needed": a corrupt marker must not skip the send.
  return {
    reason: typeof parsed?.reason === 'string' ? parsed.reason : 'unknown',
    at: typeof parsed?.at === 'string' ? parsed.at : '',
    gen: typeof parsed?.gen === 'string' ? parsed.gen : raw,
  };
}

export function isSnapshotNeeded(db: AppDatabase): boolean {
  return getSyncState(db, SYNC_SNAPSHOT_KEYS.needed) !== null;
}

export function markSnapshotNeeded(db: AppDatabase, reason: SnapshotReason): void {
  setSyncState(
    db,
    SYNC_SNAPSHOT_KEYS.needed,
    JSON.stringify({ reason, at: new Date().toISOString(), gen: uuidv7() }),
  );
}

/**
 * How the destination is kept in sync_state. It carries a fingerprint of the
 * till's sync password, and sync_state travels in every backup and cloud
 * copy, so the app seals it with the OS keychain (sync-config.ts
 * destinationSeal); tests keep it plain.
 */
export interface DestinationCodec {
  seal(key: string): string;
  /** The stored value read back, or null when it cannot be read on this PC. */
  open(stored: string): string | null;
}

const PLAIN_DESTINATION: DestinationCodec = { seal: (k) => k, open: (s) => s };

/**
 * Remember where the link points. Returns true when that means everything is
 * owed to it once (and marks it):
 *   - the first place ever recorded ('first_link'). The queue cannot be
 *     trusted to hold everything: it may still hold months of entries in the
 *     shape tills wrote before row images (the other till could apply those
 *     for five tables only), and a till linked before this update never had
 *     its orders, shifts, users or stock received at all (the old receiver
 *     dropped them). One full send replaces all of it.
 *   - a place other than the last one sent to ('new_destination'), or one
 *     that cannot be read back on this PC (restored onto another computer).
 */
export function noteSyncDestination(
  db: AppDatabase,
  destination: string,
  codec: DestinationCodec = PLAIN_DESTINATION,
): boolean {
  const tx = db.transaction((): boolean => {
    const raw = getSyncState(db, SYNC_SNAPSHOT_KEYS.destination);
    const stored = raw === null ? null : codec.open(raw);
    if (stored !== null && stored === destination) return false;
    setSyncState(db, SYNC_SNAPSHOT_KEYS.destination, codec.seal(destination));
    if (raw === null) {
      // One already owed (the queue was cleared while off) covers this too.
      if (!isSnapshotNeeded(db)) markSnapshotNeeded(db, 'first_link');
      return true;
    }
    markSnapshotNeeded(db, 'new_destination');
    return true;
  });
  return tx();
}

// -----------------------------------------------------------------------------
// Tidying the queue in small steps (housekeeping)
// -----------------------------------------------------------------------------

/**
 * First and last rowid in the queue. Two statements on purpose: each is one
 * b-tree seek, while `SELECT MIN(rowid), MAX(rowid)` in one statement scans.
 */
export function queueRowidSpan(db: AppDatabase): { lo: number; hi: number } | null {
  const lo = db.prepare(`SELECT MIN(rowid) AS v FROM sync_queue`).get() as { v: number | null };
  const hi = db.prepare(`SELECT MAX(rowid) AS v FROM sync_queue`).get() as { v: number | null };
  if (lo.v === null || hi.v === null) return null;
  return { lo: Number(lo.v), hi: Number(hi.v) };
}

/**
 * A queue stamp further ahead of the PC clock than this was written while the
 * clock was wrong (set to next month by mistake, then put right). The queue
 * clock never goes backwards (nextQueueTime), so every entry after it carries
 * the wrong date too; clean-ups that go by age treat them as old, or they
 * would never be cleared until the calendar caught up.
 */
export const QUEUE_CLOCK_ERROR_MS = 24 * 60 * 60 * 1000;

/**
 * Delete unsent entries older than `createdBefore`, or stamped after
 * `createdAfter` (a clock error, see QUEUE_CLOCK_ERROR_MS), in one rowid
 * window. Any removal also marks that the other till needs everything sent
 * once, in the same transaction, so the two can never disagree.
 */
export function pruneUnsentWindow(
  db: AppDatabase,
  fromRowid: number,
  toRowid: number,
  createdBefore: string,
  createdAfter: string,
): number {
  const tx = db.transaction((): number => {
    const removed = db
      .prepare(
        `DELETE FROM sync_queue
          WHERE rowid >= ? AND rowid < ? AND synced_at IS NULL
            AND (created_at < ? OR created_at > ?)`,
      )
      .run(fromRowid, toRowid, createdBefore, createdAfter).changes;
    if (removed > 0) markSnapshotNeeded(db, 'unsent_cleared');
    return Number(removed);
  });
  return tx();
}

/** Delete up to `limit` delivered entries older than the cutoff (idx_sync_queue_synced). */
export function purgeSyncedBatch(db: AppDatabase, olderThanIso: string, limit: number): number {
  return Number(
    db
      .prepare(
        `DELETE FROM sync_queue WHERE rowid IN (
           SELECT rowid FROM sync_queue
            WHERE synced_at IS NOT NULL AND synced_at < ? LIMIT ?)`,
      )
      .run(olderThanIso, limit).changes,
  );
}

// -----------------------------------------------------------------------------
// Incoming changes that could not be saved here
// -----------------------------------------------------------------------------

/**
 * A change from the other till that did not apply (a missing parent row, a
 * clash with a row made here, an unreadable payload). It is kept, retried on
 * every pull and counted in Settings, instead of stopping the link or being
 * dropped unseen.
 */
export interface ParkedChange {
  change: SyncChange;
  reason: string;
  at: string;
  tries: number;
}

const PARKED_KEY = 'pull.parked';
/** Kept beside the list so the status card never parses the list itself. */
const PARKED_COUNT_KEY = 'pull.parked_count';
const PARKED_DROPPED_KEY = 'pull.parked_dropped';
/** Kept in one sync_state value, so bounded in count and in size. */
export const PARKED_MAX = 200;
export const PARKED_MAX_BYTES = 2_000_000;

export function readParked(db: AppDatabase): ParkedChange[] {
  const raw = getSyncState(db, PARKED_KEY);
  if (raw === null) return [];
  const parsed = safeParse(raw);
  return Array.isArray(parsed) ? (parsed as ParkedChange[]) : [];
}

/**
 * Store the list (oldest first), the NEWEST dropped past the caps (and
 * counted). Returns how many were dropped. The oldest are kept because they
 * are the parents: a full send arrives parents first, so when a parent cannot
 * be saved (a name or phone number already used here), everything after it
 * that points at it waits too. Keeping the children and dropping the parent
 * would leave nothing that could ever be saved; keeping the parent lets it,
 * and the children still kept, go in once the clash is sorted out, and "Send
 * everything again" on the other till brings the dropped ones back.
 */
export function writeParked(db: AppDatabase, list: ParkedChange[]): number {
  let kept = list.slice(0, PARKED_MAX);
  let json = JSON.stringify(kept);
  while (kept.length > 1 && json.length > PARKED_MAX_BYTES) {
    // Drop about a tenth at a time: re-serializing per item is quadratic.
    kept = kept.slice(0, Math.max(1, Math.floor(kept.length * 0.9)));
    json = JSON.stringify(kept);
  }
  const dropped = list.length - kept.length;
  if (kept.length === 0) {
    deleteSyncState(db, PARKED_KEY);
    deleteSyncState(db, PARKED_COUNT_KEY);
  } else {
    setSyncState(db, PARKED_KEY, json);
    setSyncState(db, PARKED_COUNT_KEY, String(kept.length));
  }
  if (dropped > 0) {
    const cur = parseInt(getSyncState(db, PARKED_DROPPED_KEY) ?? '0', 10) || 0;
    setSyncState(db, PARKED_DROPPED_KEY, String(cur + dropped));
  }
  return dropped;
}

/** Changes from the other till that are not saved here: waiting for a retry, or dropped past the cap. */
export function notSavedCount(db: AppDatabase): number {
  const waiting = parseInt(getSyncState(db, PARKED_COUNT_KEY) ?? '0', 10) || 0;
  const dropped = parseInt(getSyncState(db, PARKED_DROPPED_KEY) ?? '0', 10) || 0;
  return waiting + dropped;
}

/**
 * A manager's "Clear" after the other till sent everything again: forget the
 * count of changes dropped past the cap (the full send brought them back),
 * with an audit row naming who. Changes still waiting stay, are tried again
 * on the next pull and stay counted until they are saved. Returns how many
 * dropped ones were forgotten.
 */
export function clearDroppedCount(db: AppDatabase, actorUserId: string | null): number {
  const tx = db.transaction((): number => {
    const dropped = parseInt(getSyncState(db, PARKED_DROPPED_KEY) ?? '0', 10) || 0;
    deleteSyncState(db, PARKED_DROPPED_KEY);
    writeAudit(db, {
      entityType: 'sync',
      entityId: uuidv7(),
      action: 'not_saved_cleared',
      actorUserId,
      before: { dropped },
      after: { dropped: 0 },
    });
    return dropped;
  });
  return tx();
}
