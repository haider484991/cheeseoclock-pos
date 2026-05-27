/**
 * Sync contract — every replicable table carries these columns. The fields here
 * mirror the SQL columns defined in CLAUDE.md. The sync-core package enforces
 * the contract at runtime; here we only declare the shape.
 */

export interface ReplicableRow {
  id: string;
  createdAt: string;
  updatedAt: string;
  syncedAt: string | null;
  deletedAt: string | null;
  deviceId: string;
  version: number;
}

export type SyncOp = 'upsert' | 'delete';

export interface SyncQueueEntry {
  id: string;
  entityType: string;
  entityId: string;
  op: SyncOp;
  payload: unknown;
  createdAt: string;
  attemptedAt: string | null;
  attempts: number;
  lastError: string | null;
  syncedAt: string | null;
}
