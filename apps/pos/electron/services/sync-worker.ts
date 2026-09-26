import log from 'electron-log/main';
import { BrowserWindow } from 'electron';
import Database from 'better-sqlite3';
import type { AppDatabase } from '../db/connection.js';
import {
  listPendingBatch,
  markSyncedIds,
  markSyncFailed,
  getPendingCount,
  getSyncState,
  setSyncState,
  pendingToChange,
  noteSyncDestination,
  readSnapshotMarker,
  isSnapshotNeeded,
  notSavedCount,
} from '../db/repositories/sync-repo.js';
import { applyRemoteBatch } from '../db/repositories/apply-remote.js';
import { destinationSeal, getSyncConfig, readSyncSwitch, syncDestinationKey } from './sync-config.js';
import { sendEverythingOnce, type SnapshotReader } from './sync-snapshot.js';
import { makeSyncAdapter } from '../adapters/sync/factory.js';
import type { SyncAdapter, SyncChange, SyncCursor } from '@cheeseoclock/sync-core';

/**
 * Sync worker. Polls every config.pollIntervalMs while mode != off + !paused:
 *   0. Note where the link points; the first place ever, or a new place,
 *      means everything is sent once (noteSyncDestination).
 *   1. If everything is owed (sync_state "snapshot.needed": unsent entries
 *      were cleared while the link was off, the link points somewhere for the
 *      first time or somewhere new, or a manager asked), first check the other
 *      side answers (one pull), wait out the first minutes after start if it
 *      was found owed at start, then
 *      queue an image of every row (services/sync-snapshot.ts). Nothing is
 *      pushed until that is queued: the old entries it replaces are deleted
 *      by its first step.
 *   2. Drain sync_queue (rows where synced_at IS NULL) → adapter.push, oldest
 *      first, capped by rows and by bytes. While a backlog drains the next
 *      tick comes after FAST_DRAIN_MS instead of the poll interval.
 *   3. adapter.pull(since cursor) → apply the changes (each on its own; one
 *      that cannot be saved is kept, retried and counted, never blocking the
 *      rest). Update cursors + counters.
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

const PUSH_BATCH = 500;
/** A body-limited server refuses a push of several MB of menu photos. */
const PUSH_MAX_BYTES = 1_000_000;
/** Gap between pushes while a backlog drains (not the whole poll interval). */
const FAST_DRAIN_MS = 2_000;
/** While draining, the status card is told at most this often (each tell recounts the queue). */
const DRAIN_BROADCAST_MS = 10_000;
/**
 * A full send found owed at start (left unfinished before a restart, or
 * noticed by the first checks after start, such as the first link after an
 * update) waits this long after start: out of the way of the first sales and
 * of the 30 s and 2 min jobs at boot. One a person causes later in the
 * session (switching the link on, "Send everything again") starts at once.
 */
export const RESUME_QUIET_MS = 4 * 60_000;
/** Markers made this soon after start came from the boot checks, not a person. */
const BOOT_CHECKS_MS = 30_000;

export class SyncWorker {
  private db: AppDatabase | null = null;
  private deviceId: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private adapterCache: { adapter: SyncAdapter; key: string } | null = null;
  private startedAt = Date.now();
  /** The destination a pull has answered from in this session. */
  private linkOkFor: string | null = null;
  /** The destination already noted in this session (saves unsealing it every tick). */
  private notedDestination: string | null = null;
  private lastBroadcastAt = 0;
  private lastWaiting = 0;

  init(db: AppDatabase, deviceId: string): void {
    this.db = db;
    this.deviceId = deviceId;
    this.startedAt = Date.now();
    this.notedDestination = null;
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

  /** Pull and apply. True when the other side answered (the cursor moved). */
  private async pullAndApply(db: AppDatabase, adapter: SyncAdapter): Promise<boolean> {
    const before = this.cursor();
    const pull = await adapter.pullChanges(before);
    await this.applyPulled(db, pull.changes);
    this.setCursor(pull.newCursor);
    return !!pull.newCursor.lastPulledAt && pull.newCursor.lastPulledAt !== before.lastPulledAt;
  }

  private async applyPulled(db: AppDatabase, changes: SyncChange[]): Promise<void> {
    const r = await applyRemoteBatch(db, changes);
    if (r.applied > 0) incrementCounter(db, STATE_KEYS.eventsPulled, r.applied);
    if (r.waiting !== this.lastWaiting || r.dropped > 0) {
      if (r.waiting > 0 || r.dropped > 0) {
        log.warn('Sync: changes from the other till not saved here (kept and retried)', {
          waiting: r.waiting,
          dropped: r.dropped,
        });
      }
      this.lastWaiting = r.waiting;
    }
  }

  /** One pass. The timer runs it (kick() schedules one now); tests call it directly. */
  async tick(): Promise<void> {
    if (!this.db || this.busy) {
      this.scheduleNext(15_000);
      return;
    }
    this.busy = true;
    const db = this.db;
    let backlog = false;
    try {
      const cfg = getSyncConfig(db);
      const destination = syncDestinationKey(cfg);
      // Before the idle check, so a paused link still records a new server.
      // Never while Off: a till with the link off sends nowhere.
      if (cfg.mode !== 'off' && destination !== this.notedDestination) {
        noteSyncDestination(db, destination, destinationSeal);
        this.notedDestination = destination;
      }
      if (cfg.mode === 'off' || cfg.paused) {
        // Idle but keep polling so a config change resumes quickly.
        this.scheduleNext(Math.max(5_000, cfg.pollIntervalMs));
        return;
      }

      setSyncState(db, STATE_KEYS.lastAttempt, new Date().toISOString());
      const adapter = this.getAdapter();

      // --- Send everything once, when owed ---
      const marker = readSnapshotMarker(db);
      if (marker) {
        if (this.linkOkFor !== destination) {
          // Only build once the other side answers: a link set up wrong must
          // not fill the queue with a copy of the whole shop for nothing.
          if (await this.pullAndApply(db, adapter)) {
            this.linkOkFor = destination;
            setSyncState(db, STATE_KEYS.consecutiveFails, '0');
            setSyncState(db, STATE_KEYS.lastError, '');
            this.scheduleNext(1_000);
          } else {
            incrementCounter(db, STATE_KEYS.consecutiveFails, 1);
            setSyncState(db, STATE_KEYS.lastError, 'The sync server did not answer');
            this.scheduleNext(cfg.pollIntervalMs);
          }
          broadcastSyncChanged();
          return;
        }
        const markedAt = Date.parse(marker.at);
        const sinceStart = Date.now() - this.startedAt;
        const causedByPerson = markedAt >= this.startedAt + BOOT_CHECKS_MS;
        if (!causedByPerson && sinceStart < RESUME_QUIET_MS) {
          this.scheduleNext(Math.min(cfg.pollIntervalMs, RESUME_QUIET_MS - sinceStart + 1_000));
          return;
        }
        const r = await sendEverythingOnce(db, {
          openReader: () => openReadOnly(db),
          shouldContinue: () => {
            const s = readSyncSwitch(db);
            return s.mode !== 'off' && !s.paused;
          },
        });
        broadcastSyncChanged();
        this.scheduleNext(r === 'done' ? 1_000 : 5_000);
        return;
      }

      let hadError = false;

      // --- Push ---
      const batch = listPendingBatch(db, PUSH_BATCH, PUSH_MAX_BYTES);
      const pending = batch.rows;
      if (pending.length > 0) {
        const changes: SyncChange[] = pending.map((p) => pendingToChange(p, this.deviceId ?? 'unknown'));
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
      backlog = batch.more;

      // --- Pull ---
      if (await this.pullAndApply(db, adapter)) this.linkOkFor = destination;

      if (hadError) {
        incrementCounter(db, STATE_KEYS.consecutiveFails, 1);
        setSyncState(db, STATE_KEYS.lastError, 'Some events rejected; see sync_queue');
      } else {
        setSyncState(db, STATE_KEYS.consecutiveFails, '0');
        setSyncState(db, STATE_KEYS.lastError, '');
      }
      // A backlog (a full send, or days of sales after a pause) drains in
      // minutes, not at one batch per poll interval.
      this.scheduleNext(backlog && !hadError ? FAST_DRAIN_MS : cfg.pollIntervalMs);
      if (!backlog || Date.now() - this.lastBroadcastAt >= DRAIN_BROADCAST_MS) {
        this.lastBroadcastAt = Date.now();
        broadcastSyncChanged();
      }
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
    sendingEverything: boolean;
    notSaved: number;
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
        sendingEverything: false,
        notSaved: 0,
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
      sendingEverything: isSnapshotNeeded(this.db),
      notSaved: notSavedCount(this.db),
    };
  }
}

/** A second, read-only connection to the till's database file (the full send reads through it). */
function openReadOnly(db: AppDatabase): SnapshotReader {
  return new Database(db.name, { readonly: true, fileMustExist: true });
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

export const syncWorker = new SyncWorker();
