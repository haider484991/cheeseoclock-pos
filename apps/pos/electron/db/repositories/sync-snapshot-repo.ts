/**
 * Queue writes for "send everything once" (services/sync-snapshot.ts): the
 * steps that clear what the full send replaces, queue row images, and close
 * the build. Only sync_queue and sync_state (both pure-local) are written,
 * the queue rows through enqueueSync and the record through writeAudit.
 */
import { v7 as uuidv7 } from 'uuid';
import type { RowImage } from '@cheeseoclock/sync-core';
import type { AppDatabase } from '../connection.js';
import { writeAudit } from './audit-repo.js';
import {
  SYNC_SNAPSHOT_KEYS,
  deleteSyncState,
  enqueueSync,
  readSnapshotMarker,
  setSyncState,
} from './sync-repo.js';

/**
 * Delete, in one rowid window, the unsent entries the full send replaces:
 * every entry in the queue at the moment the build reads, i.e. up to the
 * queue's last rowid (`lastRowid`) and newest unsent stamp (`newestAtMoment`)
 * at that moment, both read in the same turn as the moment is pinned. Their
 * rows go out as they are now. Not "stamped before the moment": the queue
 * clock runs a little ahead of the PC clock during a burst of writes (one
 * stamp per millisecond at most), and far ahead after the PC clock was set
 * wrong (QUEUE_CLOCK_ERROR_MS), and such entries are just as old.
 * Entries written during the build get a later rowid, and a stamp past the
 * newest one then (nextQueueTime); either keeps them out.
 */
export function supersedeWindow(
  db: AppDatabase,
  fromRowid: number,
  toRowid: number,
  lastRowid: number,
  newestAtMoment: string,
): number {
  return Number(
    db
      .prepare(
        `DELETE FROM sync_queue
          WHERE rowid >= ? AND rowid < ? AND rowid <= ? AND synced_at IS NULL AND created_at <= ?`,
      )
      .run(fromRowid, toRowid, lastRowid, newestAtMoment).changes,
  );
}

/**
 * Queue one step's row images, all stamped with the build's moment, in one
 * transaction. A soft-deleted row goes as a 'delete' (as the repositories
 * send a live soft delete): a till still on the previous version turns an
 * 'upsert' of it back into a live row.
 */
export function enqueueImages(
  db: AppDatabase,
  table: string,
  images: RowImage[],
  createdAt: string,
): void {
  db.transaction(() => {
    for (const image of images) {
      const op = image['deletedAt'] !== null && image['deletedAt'] !== undefined ? 'delete' : 'upsert';
      enqueueSync(db, { entityType: table, entityId: image.id, op, payload: image, createdAt });
    }
  })();
}

/**
 * The build is queued. Clears the marker it started from and records the
 * result (and one audit row). If the marker changed while the build ran (a
 * manager asked again, the link was pointed elsewhere), it is left set and a
 * new build follows. Returns whether the marker was cleared.
 */
export function finishFullSend(
  db: AppDatabase,
  gen: string,
  result: { rows: number; tables: number; startedAt: string },
): boolean {
  const tx = db.transaction((): boolean => {
    const marker = readSnapshotMarker(db);
    if (marker && marker.gen !== gen) return false;
    deleteSyncState(db, SYNC_SNAPSHOT_KEYS.needed);
    setSyncState(db, SYNC_SNAPSHOT_KEYS.lastDoneAt, new Date().toISOString());
    setSyncState(db, SYNC_SNAPSHOT_KEYS.lastRows, String(result.rows));
    writeAudit(db, {
      entityType: 'sync',
      entityId: uuidv7(),
      action: 'full_send_queued',
      actorUserId: null,
      before: null,
      after: { ...result, reason: marker?.reason ?? null },
    });
    return true;
  });
  return tx();
}
