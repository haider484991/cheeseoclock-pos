/**
 * Settings → Staff & kitchen timing ('staff.timing') in auth-service, on a
 * real database built from every migration: the owner's idle sign-out, the
 * longest login and the step-in hold, read on every check — login expiry,
 * restart recovery and the startup clean-up — the same on both tills (a
 * value from the other till counts at once). Cashiers are still never
 * signed out for being idle. With nothing saved, today's numbers: 15
 * minutes, 12 hours, 10 minutes.
 *
 * Real sign-ins (argon2id) on node's own `node:sqlite` (better-sqlite3 here
 * is built for Electron) — skipped where it is missing. Only the clock is
 * moved. Every name and secret is made up.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STAFF_TIMING, type StaffTiming } from '@cheeseoclock/shared-types';
import { ROW_IMAGE_KEY, type SyncChange } from '@cheeseoclock/sync-core';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false },
  app: { getPath: () => '' },
}));

interface Stmt {
  run(...p: unknown[]): unknown;
  all(...p: unknown[]): Array<Record<string, unknown>>;
  get(...p: unknown[]): Record<string, unknown> | undefined;
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
}
const Sqlite = (() => {
  try {
    return (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => RawDb }).DatabaseSync;
  } catch {
    return null;
  }
})();
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

function openMigrated() {
  const raw = new Sqlite!(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  let depth = 0;
  return {
    raw,
    db: {
      exec: (sql: string) => raw.exec(sql),
      prepare: (sql: string) => raw.prepare(sql),
      transaction:
        <A extends unknown[], R>(fn: (...args: A) => R) =>
        (...args: A): R => {
          const sp = `sp_${depth}`;
          raw.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
          depth += 1;
          try {
            const out = fn(...args);
            depth -= 1;
            raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
            return out;
          } catch (e) {
            depth -= 1;
            if (depth === 0) raw.exec('ROLLBACK');
            else raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
            throw e;
          }
        },
    } as never,
  };
}

const DEV = 'dev-till-1';
const OTHER_TILL = 'dev-till-2';
const MIN = 60_000;
const HOUR = 60 * MIN;
const START = Date.parse('2026-09-28T07:00:00.000Z');
const PIN = { cashier: '572913', manager: '839154', owner: '716208' } as const;

/** The owner's shorter timings (made-up numbers inside the bounds). */
const SHORT: StaffTiming = { v: 1, idleLogoutMin: 5, maxLoginHours: 8, stepInMin: 5, freeReprints: 0, reprintWindowMin: 60 };

const auth = () => import('./auth-service.js');
let till: ReturnType<typeof openMigrated>;
let ownerId: string;

/** The owner presses Save on the card (business-settings-repo: row, sync, audit). */
async function save(value: StaffTiming): Promise<void> {
  const { setBusinessSetting } = await import('../db/repositories/business-settings-repo.js');
  setBusinessSetting(till.db, 'staff.timing', value, { userId: ownerId, deviceId: DEV });
}

/** Move the till's clock, someone tapping the screen every minute on the way. */
async function busyFor(ms: number): Promise<void> {
  const { noteActivity } = await auth();
  const end = Date.now() + ms;
  while (Date.now() < end) {
    vi.setSystemTime(Math.min(end, Date.now() + MIN));
    noteActivity();
  }
}

function lastSessionAction(sessionId: string): unknown {
  return till.raw
    .prepare(`SELECT action FROM audit_log WHERE entity_type = 'user_sessions' AND entity_id = ? ORDER BY rowid DESC LIMIT 1`)
    .get(sessionId)?.['action'];
}

beforeAll(async () => {
  if (!Sqlite) return;
  till = openMigrated();
  const { createUser } = await import('../db/repositories/user-repo.js');
  const actor = { userId: null, deviceId: DEV };
  await createUser(till.db, { fullName: 'Counter Cashier', role: 'cashier', pin: PIN.cashier }, actor);
  await createUser(till.db, { fullName: 'Shift Manager', role: 'manager', pin: PIN.manager }, actor);
  await createUser(till.db, { fullName: 'Shop Owner', role: 'admin', pin: PIN.owner }, actor);
  ownerId = String(till.raw.prepare(`SELECT id FROM users WHERE role = 'admin'`).get()?.['id']);
});

beforeEach(async () => {
  if (!Sqlite) return;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  (await auth()).logout(till.db);
  till.raw.exec(`DELETE FROM user_sessions; DELETE FROM login_attempts; DELETE FROM business_settings;`);
});

afterEach(() => {
  vi.useRealTimers();
});

describe.skipIf(!Sqlite)('nothing saved: today’s numbers', () => {
  it('the defaults are 15 minutes idle, 12 hours a login, a 10-minute step-in', async () => {
    const { ELEVATED_IDLE_MS, SESSION_MAX_AGE_MS, STEP_IN_MAX_MS } = await auth();
    expect([ELEVATED_IDLE_MS, SESSION_MAX_AGE_MS, STEP_IN_MAX_MS]).toEqual([15 * MIN, 12 * HOUR, 10 * MIN]);
    expect([DEFAULT_STAFF_TIMING.idleLogoutMin, DEFAULT_STAFF_TIMING.maxLoginHours, DEFAULT_STAFF_TIMING.stepInMin]).toEqual([15, 12, 10]);
  });

  it('an owner idle 14 minutes is still in; a cashier ends only after 12 hours', async () => {
    const { login, logout, getCurrentSession } = await auth();
    await login(till.db, PIN.owner, DEV);
    vi.setSystemTime(Date.now() + 14 * MIN);
    expect(getCurrentSession()?.role).toBe('admin');
    logout(till.db);
    const cashier = await login(till.db, PIN.cashier, DEV);
    vi.setSystemTime(Date.now() + 11 * HOUR);
    expect(getCurrentSession()?.role).toBe('cashier');
    vi.setSystemTime(Date.now() + HOUR + MIN);
    expect(getCurrentSession()).toBeNull();
    expect(lastSessionAction(cashier.sessionId)).toBe('session_expired');
  });
});

describe.skipIf(!Sqlite)('the owner’s timings', () => {
  it('an idle owner or manager is signed out after the owner’s minutes — audited as before', async () => {
    await save(SHORT);
    const { login, logout, getCurrentSession } = await auth();
    for (const pin of [PIN.owner, PIN.manager]) {
      const who = await login(till.db, pin, DEV);
      vi.setSystemTime(Date.now() + 4 * MIN);
      expect(getCurrentSession()?.sessionId).toBe(who.sessionId);
      vi.setSystemTime(Date.now() + MIN + 1_000);
      expect(getCurrentSession()).toBeNull();
      expect(lastSessionAction(who.sessionId)).toBe('session_idle_timeout');
      logout(till.db);
    }
  });

  it('a cashier is still never signed out for being idle — only when the login is over the owner’s hours', async () => {
    await save(SHORT);
    const { login, getCurrentSession } = await auth();
    const cashier = await login(till.db, PIN.cashier, DEV);
    vi.setSystemTime(Date.now() + 7 * HOUR + 59 * MIN);
    expect(getCurrentSession()?.role).toBe('cashier');
    vi.setSystemTime(Date.now() + 2 * MIN);
    expect(getCurrentSession()).toBeNull();
    expect(lastSessionAction(cashier.sessionId)).toBe('session_expired');
  });

  it('a busy owner login ends at the owner’s longest login too', async () => {
    await save(SHORT);
    const { login, getCurrentSession } = await auth();
    const owner = await login(till.db, PIN.owner, DEV);
    await busyFor(8 * HOUR - MIN);
    expect(getCurrentSession()?.role).toBe('admin');
    await busyFor(2 * MIN);
    expect(getCurrentSession()).toBeNull();
    expect(lastSessionAction(owner.sessionId)).toBe('session_expired');
  });

  it('a manager stepping in is held after the owner’s minutes, and the login says how many', async () => {
    await save(SHORT);
    const { login, logout, getCurrentSession, getHeldStepIn } = await auth();
    await login(till.db, PIN.cashier, DEV);
    await busyFor(HOUR);
    logout(till.db);
    const manager = await login(till.db, PIN.manager, DEV);
    expect(manager.stepInEndsAt).toBe(new Date(Date.now() + 5 * MIN).toISOString());
    expect(manager.stepInMinutes).toBe(5);
    await busyFor(4 * MIN);
    expect(getCurrentSession()?.role).toBe('manager');
    await busyFor(MIN);
    expect(getCurrentSession()).toBeNull();
    expect(getHeldStepIn()).toMatchObject({ role: 'manager', stepInHeld: true, stepInMinutes: 5 });
  });

  it('with nothing saved a step-in gets 10 minutes, and says so', async () => {
    const { login, logout } = await auth();
    await login(till.db, PIN.cashier, DEV);
    logout(till.db);
    const owner = await login(till.db, PIN.owner, DEV);
    expect(owner.stepInEndsAt).toBe(new Date(Date.now() + 10 * MIN).toISOString());
    expect(owner.stepInMinutes).toBe(10);
  });

  it('restart recovery and the startup clean-up use the owner’s longest login', async () => {
    const { login, recoverSession, reapStaleSessions } = await auth();
    const open = (sessionId: string) => till.raw.prepare(`SELECT ended_at FROM user_sessions WHERE id = ?`).get(sessionId)?.['ended_at'];

    // Nothing saved: a login from 9 hours ago comes back after a restart (12 hours).
    const first = await login(till.db, PIN.cashier, DEV);
    vi.setSystemTime(Date.now() + 9 * HOUR);
    expect(recoverSession(till.db, DEV)?.sessionId).toBe(first.sessionId);

    // The owner saves 8 hours: the same restart does not bring it back, and the clean-up closes it.
    await save(SHORT);
    expect(recoverSession(till.db, DEV)).toBeNull();
    reapStaleSessions(till.db);
    expect(open(first.sessionId)).not.toBeNull();

    // A login from 7 hours ago still comes back, and the clean-up leaves it open.
    const second = await login(till.db, PIN.manager, DEV);
    vi.setSystemTime(Date.now() + 7 * HOUR);
    reapStaleSessions(till.db);
    expect(open(second.sessionId)).toBeNull();
    expect(recoverSession(till.db, DEV)?.sessionId).toBe(second.sessionId);
  });

  it('a value saved on the other till counts here at once; putting back the default brings back 15 minutes', async () => {
    const { businessSettingId } = await import('../db/repositories/business-settings-repo.js');
    const { applyRemoteBatch } = await import('../db/repositories/apply-remote.js');
    const id = businessSettingId('staff.timing');
    const at = new Date(Date.now() + 1_000).toISOString();
    const change: SyncChange = {
      entityType: 'business_settings',
      entityId: id,
      op: 'upsert',
      payload: {
        [ROW_IMAGE_KEY]: 1,
        id,
        key: 'staff.timing',
        valueJson: JSON.stringify(SHORT),
        updatedByUserId: ownerId,
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
        deviceId: OTHER_TILL,
        version: 1,
      },
      updatedAt: at,
      deviceId: OTHER_TILL,
      version: 1,
    };
    expect(await applyRemoteBatch(till.db, [change])).toMatchObject({ applied: 1, settingsChanged: true });

    const { login, logout, getCurrentSession } = await auth();
    const owner = await login(till.db, PIN.owner, DEV);
    vi.setSystemTime(Date.now() + 5 * MIN + 1_000);
    expect(getCurrentSession()).toBeNull();
    expect(lastSessionAction(owner.sessionId)).toBe('session_idle_timeout');

    // "Put back the default" writes 15 minutes: 6 idle minutes no longer end it.
    await save({ ...DEFAULT_STAFF_TIMING });
    logout(till.db);
    await login(till.db, PIN.owner, DEV);
    vi.setSystemTime(Date.now() + 6 * MIN);
    expect(getCurrentSession()?.role).toBe('admin');
  });
});

describe.skipIf(!Sqlite)('a till that stopped with a login still open', () => {
  const at = (iso: string) => Date.parse(iso);
  const endedAt = (sessionId: string) => till.raw.prepare(`SELECT ended_at FROM user_sessions WHERE id = ?`).get(sessionId)?.['ended_at'];

  /** The app starts again: a fresh auth-service (nobody signed in, as after any restart), then the startup clean-up. */
  async function restartAt(ms: number): Promise<Awaited<ReturnType<typeof auth>>> {
    vi.setSystemTime(ms);
    vi.resetModules();
    const fresh = await auth();
    fresh.reapStaleSessions(till.db);
    return fresh;
  }

  /** The cashier rings something up: its audit row, with the cashier as the actor. */
  async function cashierRingsUp(): Promise<void> {
    const { writeAudit } = await import('../db/repositories/audit-repo.js');
    const cashierId = String(till.raw.prepare(`SELECT id FROM users WHERE role = 'cashier'`).get()?.['id']);
    writeAudit(till.db, {
      entityType: 'orders',
      entityId: `test-order-${Date.now()}`,
      action: 'create',
      actorUserId: cashierId,
      before: null,
      after: { made: 'up' },
    });
  }

  it('raised to 24 hours: the owner the next morning is not stepping in for last night’s cashier', async () => {
    await save({ ...DEFAULT_STAFF_TIMING, maxLoginHours: 24 });
    vi.setSystemTime(at('2026-10-05T07:00:00.000Z')); // 12:00 in Karachi
    const cashier = await (await auth()).login(till.db, PIN.cashier, DEV);
    vi.setSystemTime(at('2026-10-05T17:45:00.000Z')); // 22:45: the last order of the night
    await cashierRingsUp();

    // 23:00: the till is shut with the cashier still signed in. 9:55 the next morning it starts again.
    const fresh = await restartAt(at('2026-10-06T04:55:00.000Z'));
    // 22 hours old, under the owner's 24: the clean-up leaves the row open…
    expect(endedAt(cashier.sessionId)).toBeNull();
    // …but the owner signing in at 10:00 is not held as a step-in.
    vi.setSystemTime(at('2026-10-06T05:00:00.000Z'));
    const owner = await fresh.login(till.db, PIN.owner, DEV);
    expect(owner.stepInEndsAt).toBeUndefined();
    await busyFor(30 * MIN);
    expect(fresh.getCurrentSession()?.role).toBe('admin');
    expect(fresh.getHeldStepIn()).toBeNull();
  });

  it('with nothing saved too: a cashier signed in at 8 PM and left on overnight does not hold the owner at 7 AM', async () => {
    vi.setSystemTime(at('2026-10-07T15:00:00.000Z')); // 20:00 in Karachi
    const cashier = await (await auth()).login(till.db, PIN.cashier, DEV);
    vi.setSystemTime(at('2026-10-07T17:50:00.000Z'));
    await cashierRingsUp();
    const fresh = await restartAt(at('2026-10-08T01:50:00.000Z')); // 6:50
    expect(endedAt(cashier.sessionId)).toBeNull(); // 11 hours: under 12, left open
    vi.setSystemTime(at('2026-10-08T02:00:00.000Z')); // 7:00
    expect((await fresh.login(till.db, PIN.owner, DEV)).stepInEndsAt).toBeUndefined();
  });

  it('restarted a few minutes after a sale, a manager signing in is still stepping in', async () => {
    vi.setSystemTime(at('2026-10-09T10:00:00.000Z'));
    await (await auth()).login(till.db, PIN.cashier, DEV);
    vi.setSystemTime(at('2026-10-09T12:58:00.000Z'));
    await cashierRingsUp();
    // 13:00 the till goes off; 13:02 it is back; 13:03 a manager signs in on it.
    const fresh = await restartAt(at('2026-10-09T13:02:00.000Z'));
    vi.setSystemTime(at('2026-10-09T13:03:00.000Z'));
    const manager = await fresh.login(till.db, PIN.manager, DEV);
    expect(manager.stepInEndsAt).toBe(new Date(at('2026-10-09T13:13:00.000Z')).toISOString());
  });

  it('a login brought back after a restart still ends the owner’s hours after it BEGAN, not after the restart', async () => {
    await save(SHORT); // 8 hours
    vi.setSystemTime(at('2026-10-10T07:00:00.000Z'));
    const cashier = await (await auth()).login(till.db, PIN.cashier, DEV);
    const fresh = await restartAt(at('2026-10-10T14:00:00.000Z')); // 7 hours in
    expect(fresh.recoverSession(till.db, DEV)?.sessionId).toBe(cashier.sessionId);
    vi.setSystemTime(at('2026-10-10T14:59:00.000Z'));
    expect(fresh.getCurrentSession()?.sessionId).toBe(cashier.sessionId);
    vi.setSystemTime(at('2026-10-10T15:01:00.000Z')); // 8 hours and a minute after the sign-in
    expect(fresh.getCurrentSession()).toBeNull();
    expect(lastSessionAction(cashier.sessionId)).toBe('session_expired');
  });

  it('lowering the longest login after a restart ends a brought-back login by its real age', async () => {
    vi.setSystemTime(at('2026-10-11T07:00:00.000Z'));
    const cashier = await (await auth()).login(till.db, PIN.cashier, DEV);
    const fresh = await restartAt(at('2026-10-11T16:00:00.000Z')); // 9 hours in: under today's 12
    expect(fresh.recoverSession(till.db, DEV)?.sessionId).toBe(cashier.sessionId);
    expect(fresh.getCurrentSession()?.role).toBe('cashier');
    await save(SHORT); // the owner lowers it to 8 hours
    expect(fresh.getCurrentSession()).toBeNull();
    expect(lastSessionAction(cashier.sessionId)).toBe('session_expired');
  });
});
