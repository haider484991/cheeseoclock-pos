/**
 * Two tills on the link, for the tests (copied from price-history.db.test.ts's
 * secondTill / push): each a real database from every migration, the same
 * made-up users, their own device ids, and `push` — everything one till has
 * queued, applied on the other exactly as the sync worker does
 * (applyRemoteBatch), then marked sent.
 *
 * Not a test file: imported by *.db.test.ts (which mock electron and
 * electron-log first). Every name is made up.
 */
import type { AppDatabase } from './connection.js';
import { openMigrated } from './costing-shop.fixture.js';

export const TEST_USERS = {
  owner: { userId: 'u_admin', name: 'Test Owner', role: 'admin' },
  manager: { userId: 'u_mgr', name: 'Test Manager', role: 'manager' },
  cashier: { userId: 'u_cash', name: 'Test Cashier', role: 'cashier' },
} as const;

/** This database is `deviceId`'s (device_info). */
export function iAm(db: AppDatabase, deviceId: string, displayName = deviceId): void {
  db.prepare(`INSERT INTO device_info (id, device_id, display_name, registered_at) VALUES ('singleton', ?, ?, ?)`).run(
    deviceId,
    displayName,
    new Date().toISOString(),
  );
}

/** A till: every migration, the made-up users (created on `usersFrom`, as the link would bring them), its device id. */
export function openTill(deviceId: string, opts: { usersFrom?: string; displayName?: string } = {}): AppDatabase {
  const db = openMigrated() as unknown as AppDatabase;
  const user = db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, 'x', 'x', ?)`,
  );
  for (const u of Object.values(TEST_USERS)) user.run(u.userId, u.name, u.role, opts.usersFrom ?? deviceId);
  iAm(db, deviceId, opts.displayName ?? deviceId);
  return db;
}

/** Everything `a` has queued, applied on `b` (as the sync worker does), then marked sent on `a`. */
export async function push(
  a: AppDatabase,
  aDevice: string,
  b: AppDatabase,
): Promise<{ applied: number; stale: number; waiting: number; dropped: number; settingsChanged: boolean }> {
  const { listPendingSync, pendingToChange, markSyncedIds } = await import('./repositories/sync-repo.js');
  const { applyRemoteBatch } = await import('./repositories/apply-remote.js');
  const pending = listPendingSync(a, 1_000_000);
  const res = await applyRemoteBatch(
    b,
    pending.map((p) => pendingToChange(p, aDevice)),
    { pause: async () => {} },
  );
  markSyncedIds(
    a,
    pending.map((p) => p.id),
  );
  return res;
}

/** The link switched on and working, as the sync worker leaves it (Settings → Sync; its last pass `atMs`). */
export function linkOn(db: AppDatabase, atMs: number, opts: { paused?: boolean } = {}): void {
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES ('sync.config', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(JSON.stringify({ mode: 'mock', paused: opts.paused === true }), new Date(atMs).toISOString());
  lastSyncPass(db, atMs);
}

/** The sync worker's last pass (sync_state), and no failures. */
export function lastSyncPass(db: AppDatabase, atMs: number): void {
  const set = db.prepare(
    `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const at = new Date(atMs).toISOString();
  set.run('sync.last_attempt', at, at);
  set.run('sync.consecutive_fails', '0', at);
}
