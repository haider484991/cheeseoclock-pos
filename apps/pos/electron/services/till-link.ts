/**
 * The second-till link as the stock figures need it (costing spec D14,
 * Phase 8): on or off (readSyncSwitch — the same switch housekeeping and the
 * sync worker read), and, while on, whether it has gone quiet (paused,
 * failing, or not tried for half an hour), so shop stock may be missing the
 * other till's latest rows. With the link off it is never "stale".
 *
 * Main process only (the sync settings are sealed with the OS keychain);
 * the Reports worker is handed the answer with each job.
 */
import type { TillLinkState } from '@cheeseoclock/shared-types';
import { tillLinkState } from '@cheeseoclock/pos-domain';
import type { AppDatabase } from '../db/connection.js';
import { readSyncSwitch } from './sync-config.js';

/** sync_state keys the sync worker keeps (services/sync-worker.ts STATE_KEYS). */
const LAST_ATTEMPT = 'sync.last_attempt';
const CONSECUTIVE_FAILS = 'sync.consecutive_fails';

function syncState(db: AppDatabase, key: string): string | null {
  const row = db.prepare(`SELECT value FROM sync_state WHERE key = ?`).get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

export function readTillLink(db: AppDatabase, now: Date = new Date()): TillLinkState {
  const sw = readSyncSwitch(db);
  if (sw.mode === 'off') return tillLinkState({ mode: 'off', paused: sw.paused, lastAttemptAt: null, consecutiveFails: 0 }, now.getTime());
  const fails = Number.parseInt(syncState(db, CONSECUTIVE_FAILS) ?? '0', 10);
  return tillLinkState(
    { mode: sw.mode, paused: sw.paused, lastAttemptAt: syncState(db, LAST_ATTEMPT) || null, consecutiveFails: Number.isFinite(fails) ? fails : 0 },
    now.getTime(),
  );
}
