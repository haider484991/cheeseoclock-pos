import type { AppDatabase } from '../connection.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import type { SyncOp } from '@cheeseoclock/shared-types';

export interface Actor {
  userId: string | null;
  deviceId: string;
}

export interface ReplicableWriteOptions<TRow> {
  db: AppDatabase;
  entityType: string;
  entityId: string;
  op: SyncOp;
  action: string;
  actor: Actor;
  before: TRow | null;
  after: TRow | null;
  /** Synchronous row write — runs first inside the transaction. */
  writeRow: () => void;
}

/**
 * Single source of truth for the repository contract:
 *   1. mutate the business row
 *   2. append a sync_queue entry with the post-image
 *   3. append an audit_log entry with before/after
 * …all in one better-sqlite3 transaction.
 *
 * Every repository's write methods MUST go through here. Direct INSERT/UPDATE
 * from anywhere else is a contract violation.
 */
export function writeWithSync<TRow>(opts: ReplicableWriteOptions<TRow>): void {
  const tx = opts.db.transaction(() => {
    opts.writeRow();
    enqueueSync(opts.db, {
      entityType: opts.entityType,
      entityId: opts.entityId,
      op: opts.op,
      payload: opts.after ?? { id: opts.entityId, deletedAt: nowIso() },
    });
    writeAudit(opts.db, {
      entityType: opts.entityType,
      entityId: opts.entityId,
      action: opts.action,
      actorUserId: opts.actor.userId,
      before: opts.before,
      after: opts.after,
    });
  });
  tx();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function toBool(n: number): boolean {
  return n === 1;
}

export function fromBool(b: boolean): number {
  return b ? 1 : 0;
}
