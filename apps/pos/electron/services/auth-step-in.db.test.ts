/**
 * A manager or the owner stepping in on a cashier's till (owner, 2026-09-26):
 * the cashier no longer has the customer list, the order history or the
 * reports, so a manager signs in on the till to do those, and must not leave
 * that login behind. The idle timer can't end it (the cashier's own taps keep
 * it alive), so a login that follows a cashier's is HELD STEP_IN_MAX_MS after
 * it began, however busy the till is: every channel refuses it, but it is not
 * ended, so the screen keeps what was on it. That same person's PIN or
 * password makes it a normal login again; "Hand back" logs out; nobody
 * answering ends it by the idle rule. Only a cashier on the till in the last
 * STEP_IN_LOOKBACK_MS makes it a step-in: the owner the next morning, a
 * manager after a manager, and a cashier's own login are never held.
 *
 * Real sign-ins (argon2id hashes) against a real SQLite database built from
 * every migration, on node's own `node:sqlite` (better-sqlite3 here is built
 * for Electron) — skipped where that is missing. Only the clock is moved.
 * The auth IPC handlers are the real ones, captured instead of registered
 * with Electron. Every name and secret is made up.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => unknown>(),
}));

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false },
  app: { getPath: () => '' },
}));
// The auth handlers register through this; captured here instead of with Electron.
vi.mock('../ipc/registry.js', () => ({
  defineHandler: (channel: string, _ctx: unknown, fn: (ctx: unknown, payload: unknown) => unknown) => {
    h.handlers.set(channel, fn);
  },
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
    return (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => RawDb })
      .DatabaseSync;
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
const MIN = 60_000;
const START = Date.parse('2026-09-26T12:00:00.000Z');
const PIN = { cashier: '482913', manager: '739154', owner: '615208' } as const;

const auth = () => import('./auth-service.js');
let till: ReturnType<typeof openMigrated>;

/** Move the till's clock, with someone tapping the screen every minute on the way. */
async function busyFor(ms: number): Promise<void> {
  const { noteActivity } = await auth();
  const end = Date.now() + ms;
  while (Date.now() < end) {
    vi.setSystemTime(Math.min(end, Date.now() + MIN));
    noteActivity();
  }
}

/** The last thing the audit trail says happened to this session. */
function lastSessionAction(sessionId: string): unknown {
  return till.raw
    .prepare(`SELECT action FROM audit_log WHERE entity_type = 'user_sessions' AND entity_id = ? ORDER BY rowid DESC LIMIT 1`)
    .get(sessionId)?.['action'];
}

type Answer = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };
async function call(channel: string, payload?: unknown): Promise<Answer> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  return (await fn({ db: till.db, deviceId: DEV }, payload)) as Answer;
}

beforeAll(async () => {
  if (!Sqlite) return;
  till = openMigrated();
  const { createUser } = await import('../db/repositories/user-repo.js');
  const actor = { userId: null, deviceId: DEV };
  await createUser(till.db, { fullName: 'Counter Cashier', role: 'cashier', pin: PIN.cashier }, actor);
  await createUser(till.db, { fullName: 'Shift Manager', role: 'manager', pin: PIN.manager }, actor);
  await createUser(till.db, { fullName: 'Shop Owner', role: 'admin', pin: PIN.owner }, actor);
  (await import('../ipc/handlers/auth-handlers.js')).registerAuthHandlers({ db: till.db, deviceId: DEV });
});

beforeEach(async () => {
  if (!Sqlite) return;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  (await auth()).logout(till.db);
  till.raw.exec(`DELETE FROM user_sessions; DELETE FROM login_attempts;`);
});

afterEach(() => {
  vi.useRealTimers();
});

/** The cashier works the till for a while, then logs out for the manager. */
async function cashierHandsOver(): Promise<void> {
  const { login, logout } = await auth();
  await login(till.db, PIN.cashier, DEV);
  await busyFor(3 * 60 * MIN);
  logout(till.db);
  vi.setSystemTime(Date.now() + 30_000);
}

describe.skipIf(!Sqlite)('a manager stepping in on a cashier’s till', () => {
  it('is held ten minutes after it began, however busy the counter is — held, not ended', async () => {
    const { login, getCurrentSession, getHeldStepIn, STEP_IN_MAX_MS } = await auth();
    expect(STEP_IN_MAX_MS).toBe(10 * MIN);
    await cashierHandsOver();
    const manager = await login(till.db, PIN.manager, DEV);
    const signedInAt = Date.now();
    expect(manager.role).toBe('manager');
    expect(manager.stepInEndsAt).toBe(new Date(signedInAt + 10 * MIN).toISOString());

    await busyFor(9 * MIN);
    expect(getCurrentSession()?.role).toBe('manager');
    expect(getHeldStepIn()).toBeNull();
    await busyFor(MIN);
    // Every guard now refuses it…
    expect(getCurrentSession()).toBeNull();
    // …but it is still there, waiting for its PIN, and nothing was ended.
    expect(getHeldStepIn()).toMatchObject({ role: 'manager', stepInHeld: true, sessionId: manager.sessionId });
    expect(lastSessionAction(manager.sessionId)).toBe('login');
    const row = till.raw.prepare(`SELECT ended_at FROM user_sessions WHERE id = ?`).get(manager.sessionId);
    expect(row?.['ended_at']).toBeNull();
  });

  it('its own PIN makes it a normal login, with nothing lost; the next restart knows', async () => {
    const { login, keepStepIn, getCurrentSession, getHeldStepIn, recoverSession } = await auth();
    await cashierHandsOver();
    const manager = await login(till.db, PIN.manager, DEV);
    await busyFor(12 * MIN);
    expect(getCurrentSession()).toBeNull();

    const kept = await keepStepIn(till.db, PIN.manager);
    expect(kept).toEqual({ id: manager.id, fullName: 'Shift Manager', role: 'manager', sessionId: manager.sessionId });
    expect(lastSessionAction(manager.sessionId)).toBe('session_step_in_kept');
    await busyFor(2 * 60 * MIN);
    expect(getCurrentSession()).toMatchObject({ role: 'manager', sessionId: manager.sessionId });
    expect(getHeldStepIn()).toBeNull();

    // The app restarts: the same login comes back as the normal one it became.
    const recovered = recoverSession(till.db, DEV);
    expect(recovered?.sessionId).toBe(manager.sessionId);
    expect(recovered?.stepInEndsAt).toBeUndefined();
    await busyFor(30 * MIN);
    expect(getCurrentSession()?.role).toBe('manager');
  });

  it('can be kept early, before it is held', async () => {
    const { login, keepStepIn, getCurrentSession } = await auth();
    await cashierHandsOver();
    await login(till.db, PIN.owner, DEV);
    await busyFor(4 * MIN);
    expect((await keepStepIn(till.db, PIN.owner)).stepInEndsAt).toBeUndefined();
    await busyFor(60 * MIN);
    expect(getCurrentSession()?.role).toBe('admin');
  });

  it("only that person's own PIN: the cashier's, another manager's or a wrong one is refused and counted", async () => {
    const { login, keepStepIn, getCurrentSession, getHeldStepIn, notTheirSecret } = await auth();
    await cashierHandsOver();
    await login(till.db, PIN.manager, DEV);
    await busyFor(11 * MIN);
    for (const pin of [PIN.cashier, PIN.owner, '999999']) {
      await expect(keepStepIn(till.db, pin)).rejects.toThrow(notTheirSecret('Shift Manager'));
    }
    expect(getCurrentSession()).toBeNull();
    expect(getHeldStepIn()?.role).toBe('manager');
    const counted = till.raw.prepare(`SELECT COUNT(*) AS n FROM login_attempts`).get()?.['n'];
    expect(Number(counted)).toBeGreaterThan(0);
  });

  it('while held, the cashier tapping the screen does not keep it: nobody answering ends it by the idle rule', async () => {
    const { login, getCurrentSession, getHeldStepIn, ELEVATED_IDLE_MS } = await auth();
    await cashierHandsOver();
    const manager = await login(till.db, PIN.manager, DEV);
    await busyFor(10 * MIN);
    expect(getHeldStepIn()).not.toBeNull();
    await busyFor(ELEVATED_IDLE_MS + MIN);
    expect(getHeldStepIn()).toBeNull();
    expect(getCurrentSession()).toBeNull();
    expect(lastSessionAction(manager.sessionId)).toBe('session_idle_timeout');
  });

  it('handing back logs out at once, held or not; signing in again after is a normal login', async () => {
    const { login, logout, getHeldStepIn, getCurrentSession } = await auth();
    await cashierHandsOver();
    const manager = await login(till.db, PIN.manager, DEV);
    await busyFor(11 * MIN);
    expect(getHeldStepIn()).not.toBeNull();
    logout(till.db);
    expect(getHeldStepIn()).toBeNull();
    expect(lastSessionAction(manager.sessionId)).toBe('logout');

    const again = await login(till.db, PIN.manager, DEV);
    expect(again.stepInEndsAt).toBeUndefined();
    await busyFor(60 * MIN);
    expect(getCurrentSession()?.role).toBe('manager');
  });

  it('the owner stepping in is held to the same ten minutes', async () => {
    const { login } = await auth();
    await cashierHandsOver();
    expect((await login(till.db, PIN.owner, DEV)).stepInEndsAt).toBe(new Date(Date.now() + 10 * MIN).toISOString());
  });

  it('a restart does not give it a fresh ten minutes', async () => {
    const { login, recoverSession, getCurrentSession, getHeldStepIn } = await auth();
    await cashierHandsOver();
    const signedInAt = Date.now();
    await login(till.db, PIN.manager, DEV);
    vi.setSystemTime(signedInAt + 6 * MIN);
    const recovered = recoverSession(till.db, DEV);
    expect(recovered?.stepInEndsAt).toBe(new Date(signedInAt + 10 * MIN).toISOString());
    await busyFor(5 * MIN);
    expect(getCurrentSession()).toBeNull();
    expect(getHeldStepIn()?.role).toBe('manager');
  });

  it('a cashier still signed in (never logged out) was on the till until now', async () => {
    const { login } = await auth();
    await login(till.db, PIN.cashier, DEV);
    // Their session row is still open when the manager signs in two hours later.
    vi.setSystemTime(Date.now() + 2 * 60 * MIN);
    expect((await login(till.db, PIN.manager, DEV)).stepInEndsAt).toBeDefined();
  });
});

describe.skipIf(!Sqlite)('never held', () => {
  it('the first login of the day, and a manager after a manager', async () => {
    const { login, logout, getCurrentSession } = await auth();
    expect((await login(till.db, PIN.manager, DEV)).stepInEndsAt).toBeUndefined();
    logout(till.db);
    expect((await login(till.db, PIN.owner, DEV)).stepInEndsAt).toBeUndefined();
    await busyFor(60 * MIN);
    expect(getCurrentSession()?.role).toBe('admin');
  });

  it('the owner the morning after a cashier took late orders until 1:30 AM', async () => {
    const { login, logout, getCurrentSession } = await auth();
    vi.setSystemTime(Date.parse('2026-09-26T20:30:00.000Z')); // 1:30 AM in Karachi
    await login(till.db, PIN.cashier, DEV);
    await busyFor(20 * MIN);
    logout(till.db);
    vi.setSystemTime(Date.parse('2026-09-27T06:00:00.000Z')); // 11:00 AM
    const owner = await login(till.db, PIN.owner, DEV);
    expect(owner.stepInEndsAt).toBeUndefined();
    await busyFor(60 * MIN);
    expect(getCurrentSession()?.role).toBe('admin');
  });

  it('a manager arriving long after the cashier left; a cashier gone more than twelve hours', async () => {
    const { login, logout, STEP_IN_LOOKBACK_MS } = await auth();
    expect(STEP_IN_LOOKBACK_MS).toBe(15 * MIN);
    await login(till.db, PIN.cashier, DEV);
    logout(till.db);
    vi.setSystemTime(Date.now() + 20 * MIN);
    expect((await login(till.db, PIN.manager, DEV)).stepInEndsAt).toBeUndefined();
    logout(till.db);
    await login(till.db, PIN.cashier, DEV);
    logout(till.db);
    vi.setSystemTime(Date.now() + 13 * 60 * MIN);
    expect((await login(till.db, PIN.manager, DEV)).stepInEndsAt).toBeUndefined();
  });

  it("a cashier's own login, whoever was on the till before", async () => {
    const { login, logout, getCurrentSession } = await auth();
    await login(till.db, PIN.manager, DEV);
    logout(till.db);
    expect((await login(till.db, PIN.cashier, DEV)).stepInEndsAt).toBeUndefined();
    await busyFor(4 * 60 * MIN);
    expect(getCurrentSession()?.role).toBe('cashier');
  });

  it('the other till’s cashier does not count', async () => {
    const { login, logout } = await auth();
    await login(till.db, PIN.cashier, 'dev-till-2');
    logout(till.db);
    expect((await login(till.db, PIN.manager, DEV)).stepInEndsAt).toBeUndefined();
  });
});

describe.skipIf(!Sqlite)('what the screen is told (the real auth handlers)', () => {
  it('a held login: currentSession says so, keepStepIn with its own PIN brings it back', async () => {
    const { login } = await auth();
    await cashierHandsOver();
    const manager = await login(till.db, PIN.manager, DEV);
    await busyFor(11 * MIN);

    expect(await call('auth:currentSession')).toEqual({
      ok: true,
      data: expect.objectContaining({ id: manager.id, role: 'manager', stepInHeld: true }),
    });
    // Nothing else is allowed on it meanwhile, not even a manager approval.
    expect(await call('auth:verifyManagerPin', { pin: PIN.owner })).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
    expect(await call('auth:keepStepIn', { pin: PIN.cashier })).toEqual({
      ok: false,
      error: { code: 'forbidden', message: "That is not Shift Manager's PIN or password" },
    });
    expect(await call('auth:keepStepIn', { pin: '' })).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
    const kept = await call('auth:keepStepIn', { pin: PIN.manager });
    expect(kept).toMatchObject({ ok: true, data: { id: manager.id, role: 'manager' } });
    expect((kept as { data: Record<string, unknown> }).data['stepInEndsAt']).toBeUndefined();
    expect(await call('auth:currentSession')).toMatchObject({ ok: true, data: { role: 'manager' } });
  });

  it("every other channel's 'not logged in' carries details.stepIn while held, and only then", async () => {
    const { login, logout } = await auth();
    const { markHeldStepIn } = await import('../ipc/step-in-hold.js');
    const refused = { ok: false, error: { code: 'unauthenticated', message: 'Not logged in' } } as const;
    const other = { ok: false, error: { code: 'forbidden', message: 'Only a manager or the owner can open the customer list.' } } as const;

    // Nobody signed in: a plain "not logged in" (the screen goes to the PIN pad).
    expect(markHeldStepIn('customers:page', refused)).toEqual(refused);

    await cashierHandsOver();
    await login(till.db, PIN.manager, DEV);
    expect(markHeldStepIn('customers:page', refused)).toEqual(refused);
    await busyFor(11 * MIN);
    expect(markHeldStepIn('customers:page', refused)).toEqual({
      ok: false,
      error: { code: 'unauthenticated', message: 'Not logged in', details: { stepIn: 'held' } },
    });
    expect(markHeldStepIn('orders:history', await call('auth:verifyManagerPin', { pin: PIN.owner }))).toMatchObject({
      error: { details: { stepIn: 'held' } },
    });
    // Not a sign-in's own refusal, not any other refusal, not a success.
    expect(markHeldStepIn('auth:login', refused)).toEqual(refused);
    expect(markHeldStepIn('auth:keepStepIn', refused)).toEqual(refused);
    expect(markHeldStepIn('customers:page', other)).toEqual(other);
    expect(markHeldStepIn('customers:page', { ok: true, data: 1 })).toEqual({ ok: true, data: 1 });

    logout(till.db);
    expect(markHeldStepIn('customers:page', refused)).toEqual(refused);
  });

  it('nobody signed in: keepStepIn is "not logged in", never a PIN check', async () => {
    expect(await call('auth:keepStepIn', { pin: PIN.manager })).toEqual({
      ok: false,
      error: { code: 'unauthenticated', message: 'Not logged in' },
    });
    expect(till.raw.prepare(`SELECT COUNT(*) AS n FROM login_attempts`).get()?.['n']).toBe(0);
  });
});
