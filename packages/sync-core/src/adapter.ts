/**
 * SyncAdapter — pluggable backend for replicating local changes to a remote store.
 * v1 ships with `local-only` (no-op accept-all). v2+ can wire PowerSync, Supabase,
 * or cr-sqlite without changing the call sites.
 */

import type { SyncOp } from '@cheeseoclock/shared-types';

export interface SyncChange {
  entityType: string;
  entityId: string;
  op: SyncOp;
  payload: unknown;
  updatedAt: string;
  deviceId: string;
  version: number;
}

export interface SyncCursor {
  lastPulledAt: string | null;
  lastPushedAt: string | null;
}

export interface PushResult {
  accepted: string[];
  rejected: Array<{ id: string; reason: string }>;
  newCursor: SyncCursor;
}

export interface PullResult {
  changes: SyncChange[];
  newCursor: SyncCursor;
}

export interface SyncAdapter {
  readonly mode: 'local-only' | 'cloud';
  pushChanges(changes: SyncChange[], cursor: SyncCursor): Promise<PushResult>;
  pullChanges(cursor: SyncCursor): Promise<PullResult>;
  subscribeRemote(onChange: (change: SyncChange) => void): { unsubscribe: () => void };
}

/** No-op implementation used until cloud sync is wired up. Accepts everything. */
export class LocalOnlySyncAdapter implements SyncAdapter {
  readonly mode = 'local-only' as const;

  async pushChanges(changes: SyncChange[], cursor: SyncCursor): Promise<PushResult> {
    return {
      accepted: changes.map((c) => c.entityId),
      rejected: [],
      newCursor: { ...cursor, lastPushedAt: new Date().toISOString() },
    };
  }

  async pullChanges(cursor: SyncCursor): Promise<PullResult> {
    return {
      changes: [],
      newCursor: { ...cursor, lastPulledAt: new Date().toISOString() },
    };
  }

  subscribeRemote(_onChange: (change: SyncChange) => void): { unsubscribe: () => void } {
    return { unsubscribe: () => {} };
  }
}
