import log from 'electron-log/main';
import { BrowserWindow } from 'electron';
import type { AppDatabase } from '../db/connection.js';
import {
  listPendingSync,
  markSyncedIds,
  markSyncFailed,
  getPendingCount,
  getSyncState,
  setSyncState,
} from '../db/repositories/sync-repo.js';
import { applyRemoteChange } from '../db/repositories/apply-remote.js';
import { getSyncConfig } from './sync-config.js';
import { makeSyncAdapter } from '../adapters/sync/factory.js';
import type { SyncAdapter, SyncChange, SyncCursor } from '@cheeseoclock/sync-core';

/**
 * Sync worker. Polls every config.pollIntervalMs while mode != off + !paused:
 *   1. Drain sync_queue (rows where synced_at IS NULL) → adapter.push
 *   2. adapter.pull(since cursor) → apply each remote change locally
 *   3. Update cursors + counters
 *
 * The worker never throws — failures land in sync_state for the UI to surface.
 */

const STATE_KEYS = {
  pushedAt: 'push.last_pushed_at',
  pulledAt: 'pull.last_pulled_at',
  lastAttempt: 'sync.last_attempt',
  lastError: 'sync.last_error',
  eventsPushed: 'sync.events_pushed',
  eventsPulled: 'sync.events_pulled',
  consecutiveFails: 'sync.consecutive_fails',
} as const;

class SyncWorker {
  private db: AppDatabase | null = null;
  private deviceId: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private adapterCache: { adapter: SyncAdapter; key: string } | null = null;

  init(db: AppDatabase, deviceId: string): void {
    this.db = db;
    this.deviceId = deviceId;
    this.scheduleNext(3_000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  resetAdapter(): void {
    this.adapterCache = null;
  }

  kick(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), 50);
  }

  private scheduleNext(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private getAdapter(): SyncAdapter {
    if (!this.db || !this.deviceId) throw new Error('SyncWorker not initialized');
    const cfg = getSyncConfig(this.db);
    const key = JSON.stringify({
      mode: cfg.mode,
      baseUrl: cfg.baseUrl,
      deviceSecret: cfg.deviceSecret,
    });
    if (this.adapterCache && this.adapterCache.key === key) return this.adapterCache.adapter;
    const adapter = makeSyncAdapter({
      mode: cfg.mode,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      ...(cfg.deviceSecret ? { deviceSecret: cfg.deviceSecret } : {}),
      deviceId: this.deviceId,
    });
    this.adapterCache = { adapter, key };
    return adapter;
  }

  private cursor(): SyncCursor {
    if (!this.db) return { lastPulledAt: null, lastPushedAt: null };
    return {
      lastPulledAt: getSyncState(this.db, STATE_KEYS.pulledAt),
      lastPushedAt: getSyncState(this.db, STATE_KEYS.pushedAt),
    };
  }

  private setCursor(cursor: SyncCursor): void {
    if (!this.db) return;
    if (cursor.lastPushedAt) setSyncState(this.db, STATE_KEYS.pushedAt, cursor.lastPushedAt);
    if (cursor.lastPulledAt) setSyncState(this.db, STATE_KEYS.pulledAt, cursor.lastPulledAt);
  }

  private async tick(): Promise<void> {
    if (!this.db || this.busy) {
      this.scheduleNext(15_000);
      return;
    }
    this.busy = true;
    const db = this.db;
    try {
      const cfg = getSyncConfig(db);
      if (cfg.mode === 'off' || cfg.paused) {
        // Idle but keep polling so a config change resumes quickly.
        this.scheduleNext(Math.max(5_000, cfg.pollIntervalMs));
        return;
      }

      setSyncState(db, STATE_KEYS.lastAttempt, new Date().toISOString());
      const adapter = this.getAdapter();
      let hadError = false;

      // --- Push ---
      const pending = listPendingSync(db, 500);
      if (pending.length > 0) {
        const changes: SyncChange[] = pending.map((p) => ({
          entityType: p.entityType,
          entityId: p.entityId,
          op: p.op,
          payload: p.payload,
          updatedAt: extractUpdatedAt(p.payload) ?? p.createdAt,
          deviceId: this.deviceId ?? 'unknown',
          version: extractVersion(p.payload) ?? 1,
        }));
        const cursor = this.cursor();
        const result = await adapter.pushChanges(changes, cursor);
        if (result.accepted.length > 0) {
          // accepted is by entityId; find the queue id per change.
          const accepted = new Set(result.accepted);
          const ids: string[] = [];
          for (const p of pending) if (accepted.has(p.entityId)) ids.push(p.id);
          markSyncedIds(db, ids);
          incrementCounter(db, STATE_KEYS.eventsPushed, ids.length);
        }
        if (result.rejected.length > 0) {
          hadError = true;
          const rejected = new Set(result.rejected.map((r) => r.id));
          const ids: string[] = [];
          for (const p of pending) if (rejected.has(p.entityId)) ids.push(p.id);
          const firstReason = result.rejected[0]?.reason ?? 'rejected';
          markSyncFailed(db, ids, firstReason);
        }
        this.setCursor(result.newCursor);
      }

      // --- Pull ---
      const pullCursor = this.cursor();
      const pull = await adapter.pullChanges(pullCursor);
      if (pull.changes.length > 0) {
        let applied = 0;
        for (const change of pull.changes) {
          const r = applyRemoteChange(db, change);
          if (r.applied) applied++;
          else if (r.reason === 'unknown_entity') {
            log.warn('Skipped remote change for unknown entity_type', {
              entityType: change.entityType,
            });
          }
        }
        incrementCounter(db, STATE_KEYS.eventsPulled, applied);
      }
      this.setCursor(pull.newCursor);

      if (hadError) {
        incrementCounter(db, STATE_KEYS.consecutiveFails, 1);
        setSyncState(db, STATE_KEYS.lastError, 'Some events rejected; see sync_queue');
      } else {
        setSyncState(db, STATE_KEYS.consecutiveFails, '0');
        setSyncState(db, STATE_KEYS.lastError, '');
      }
      this.scheduleNext(cfg.pollIntervalMs);
      broadcastSyncChanged();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn('Sync worker exception', { msg });
      if (db) {
        setSyncState(db, STATE_KEYS.lastError, msg);
        incrementCounter(db, STATE_KEYS.consecutiveFails, 1);
      }
      broadcastSyncChanged();
      // Back off on failure.
      const fails = parseInt(getSyncState(db, STATE_KEYS.consecutiveFails) ?? '0', 10);
      const wait = Math.min(60_000, 5_000 * Math.pow(2, Math.min(fails, 4)));
      this.scheduleNext(wait);
    } finally {
      this.busy = false;
    }
  }

  /** Snapshot for the dashboard/settings card. */
  status(): {
    pending: number;
    pushedAt: string | null;
    pulledAt: string | null;
    lastAttempt: string | null;
    lastError: string | null;
    eventsPushed: number;
    eventsPulled: number;
    consecutiveFails: number;
  } {
    if (!this.db) {
      return {
        pending: 0,
        pushedAt: null,
        pulledAt: null,
        lastAttempt: null,
        lastError: null,
        eventsPushed: 0,
        eventsPulled: 0,
        consecutiveFails: 0,
      };
    }
    return {
      pending: getPendingCount(this.db),
      pushedAt: getSyncState(this.db, STATE_KEYS.pushedAt),
      pulledAt: getSyncState(this.db, STATE_KEYS.pulledAt),
      lastAttempt: getSyncState(this.db, STATE_KEYS.lastAttempt),
      lastError: getSyncState(this.db, STATE_KEYS.lastError) || null,
      eventsPushed: parseInt(getSyncState(this.db, STATE_KEYS.eventsPushed) ?? '0', 10),
      eventsPulled: parseInt(getSyncState(this.db, STATE_KEYS.eventsPulled) ?? '0', 10),
      consecutiveFails: parseInt(
        getSyncState(this.db, STATE_KEYS.consecutiveFails) ?? '0',
        10,
      ),
    };
  }
}

function broadcastSyncChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('sync:status-changed');
  }
}

function incrementCounter(db: AppDatabase, key: string, by: number): void {
  const cur = parseInt(getSyncState(db, key) ?? '0', 10);
  setSyncState(db, key, String(cur + by));
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

export const syncWorker = new SyncWorker();
