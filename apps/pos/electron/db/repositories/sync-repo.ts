import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import type { SyncOp } from '@cheeseoclock/shared-types';

export interface SyncEnqueue {
  entityType: string;
  entityId: string;
  op: SyncOp;
  payload: unknown;
}

/**
 * Append an entry to sync_queue. MUST be called inside the same transaction
 * that mutates the business row.
 */
export function enqueueSync(db: AppDatabase, e: SyncEnqueue): void {
  db.prepare(
    `INSERT INTO sync_queue
       (id, entity_type, entity_id, op, payload_json, created_at, attempts)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    uuidv7(),
    e.entityType,
    e.entityId,
    e.op,
    JSON.stringify(e.payload),
    new Date().toISOString(),
  );
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

export function listPendingSync(db: AppDatabase, limit = 500): PendingSyncRow[] {
  const rows = db
    .prepare(
      `SELECT id, entity_type, entity_id, op, payload_json, created_at, attempts
         FROM sync_queue WHERE synced_at IS NULL ORDER BY created_at LIMIT ?`,
    )
    .all(limit) as PendingRow[];
  return rows.map((r) => ({
    id: r.id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    op: r.op,
    payload: safeParse(r.payload_json),
    createdAt: r.created_at,
    attempts: r.attempts,
  }));
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

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
