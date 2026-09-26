/**
 * Settings → Sounds and the pending order alerts through the real `alerts:*`
 * handlers, against a real SQLite database built from every migration:
 *   - anyone (the PIN screen too) can read the sounds and the pending list;
 *   - only a manager or the owner can change the sounds (a cashier cannot
 *     mute the till) or send the test notice, and a change is audited;
 *   - a "did not come in" card is closed only by someone logged in: logged
 *     out, Seen silences it and the phone number stays on screen;
 *   - an order leaves the pending list (stops ringing) once it has moved past
 *     New or been deleted — the stillWaiting query in order-alerts-hub.ts.
 *
 * Only `defineHandler`, Electron and the signed-in session are stood in for;
 * the handlers, the settings repository, the audit chain and the hub are the
 * real ones. better-sqlite3 is built for Electron's ABI, so this uses
 * `node:sqlite` with a small `transaction()` shim and skips itself where
 * node:sqlite is missing. Every name and number is made up.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ALERT_SOUND_SETTINGS, type AuthenticatedUser, type UUID } from '@cheeseoclock/shared-types';

type Handler = (ctx: unknown, payload: unknown) => unknown;
const h = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  session: null as unknown,
}));

vi.mock('../registry.js', () => {
  class IpcGuardError extends Error {
    readonly apiError: { code: string; message: string };
    constructor(apiError: { code: string; message: string }) {
      super(apiError.message);
      this.apiError = apiError;
      this.name = 'IpcGuardError';
    }
  }
  return {
    IpcGuardError,
    defineHandler: (channel: string, _ctx: unknown, fn: Handler) => {
      h.handlers.set(channel, fn);
    },
  };
});
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
// No till window and no Windows notices here: showAttention has nothing to show.
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {
    static isSupported() {
      return false;
    }
  },
}));
// Who is signed in: auth-service's job, stood in for here.
vi.mock('../../services/auth-service.js', () => ({ getCurrentSession: () => h.session }));

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

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');
const DEV = 'dev-till-1';
const T0 = '2026-09-26T09:00:00.000Z';

function openMigrated() {
  const raw = new Sqlite!(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  raw.exec('PRAGMA foreign_keys = ON');
  let depth = 0;
  return {
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
  };
}

const session = (id: string, role: AuthenticatedUser['role']): AuthenticatedUser => ({
  id: id as UUID,
  fullName: id,
  role,
  sessionId: 'sess' as UUID,
});
const CASHIER = session('u_cash', 'cashier');
const MANAGER = session('u_mgr', 'manager');

let db: ReturnType<typeof openMigrated>;

const call = (channel: string, payload?: unknown) => {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  return fn({ db, deviceId: DEV }, payload);
};
/** The guard's error code, or null when the call went through. */
function refusal(channel: string, payload?: unknown): string | null {
  try {
    call(channel, payload);
    return null;
  } catch (e) {
    return (e as { apiError?: { code: string } }).apiError?.code ?? 'threw';
  }
}
const count = (sql: string, ...p: unknown[]) => Number(db.prepare(sql).get(...p)?.['n'] ?? 0);

function addOrder(id: string, status: string, deletedAt: string | null = null): void {
  db.prepare(
    `INSERT INTO orders (id, order_number, mode, status, cashier_id, source, created_at, updated_at, deleted_at, device_id)
     VALUES (?, ?, 'online', ?, 'u_cash', 'web', ?, ?, ?, ?)`,
  ).run(id, `CO-20260926-${id}`, status, T0, T0, deletedAt, DEV);
}

beforeEach(async () => {
  if (!Sqlite) return;
  h.handlers.clear();
  h.session = null;
  db = openMigrated();
  const user = db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
  user.run('u_mgr', 'Test Manager', 'manager', T0, T0, DEV);
  const { registerAlertsHandlers } = await import('./alerts-handlers.js');
  registerAlertsHandlers({ db, deviceId: DEV } as never);
});

describe.skipIf(!Sqlite)('Settings → Sounds through alerts:*', () => {
  it('anyone can read them — the PIN screen rings too — and a fresh till has the standard ones', () => {
    expect(call('alerts:getSounds')).toEqual({ ok: true, data: DEFAULT_ALERT_SOUND_SETTINGS });
  });

  it('nobody logged in, or a cashier, cannot change them (nor send the test notice); nothing is written', () => {
    const mute = { ...DEFAULT_ALERT_SOUND_SETTINGS, enabled: false };
    expect(refusal('alerts:setSounds', mute)).toBe('unauthenticated');
    expect(refusal('alerts:testNotice')).toBe('unauthenticated');
    h.session = CASHIER;
    expect(refusal('alerts:setSounds', mute)).toBe('forbidden');
    expect(refusal('alerts:testNotice')).toBe('forbidden');
    expect(count(`SELECT COUNT(*) AS n FROM settings WHERE key = 'alerts.sounds'`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = 'alerts.sounds'`)).toBe(0);
    expect(call('alerts:getSounds')).toEqual({ ok: true, data: DEFAULT_ALERT_SOUND_SETTINGS });
  });

  it('a manager can: saved checked, kept for this till, and the audit trail says who', () => {
    h.session = MANAGER;
    const r = call('alerts:setSounds', { ...DEFAULT_ALERT_SOUND_SETTINGS, enabled: false, volume: 150, junk: 1 }) as {
      ok: true;
      data: typeof DEFAULT_ALERT_SOUND_SETTINGS;
    };
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ ...DEFAULT_ALERT_SOUND_SETTINGS, enabled: false, volume: 100 });
    // After logging out, the PIN screen reads what was saved.
    h.session = null;
    expect(call('alerts:getSounds')).toEqual({ ok: true, data: r.data });
    const audit = db
      .prepare(`SELECT action, actor_user_id FROM audit_log WHERE entity_type = 'settings' AND entity_id = 'alerts.sounds'`)
      .all();
    expect(audit).toEqual([{ action: 'settings_change', actor_user_id: 'u_mgr' }]);
  });

  it('a manager can send the test notice (none shows here: no window, no notices)', () => {
    h.session = MANAGER;
    expect(call('alerts:testNotice')).toEqual({ ok: true, data: { shown: false } });
  });
});

describe.skipIf(!Sqlite)('pending order alerts through alerts:*', () => {
  it('an order stops ringing once it has moved past New or was deleted (stillWaiting)', async () => {
    const { orderAlerts } = await import('../../services/order-alerts-hub.js');
    addOrder('a-new', 'sent_to_kitchen');
    addOrder('a-started', 'preparing');
    addOrder('a-deleted', 'sent_to_kitchen', T0);
    for (const id of ['a-new', 'a-started', 'a-deleted', 'a-missing']) {
      orderAlerts.orderReceived({ orderId: id, orderNumber: `CO-20260926-${id}`, customerName: 'Ali' });
    }
    const ids = () =>
      (call('alerts:getPending') as { data: { orders: Array<{ orderId: string }> } }).data.orders.map((o) => o.orderId);
    expect(ids()).toEqual(['a-new']);
    db.prepare(`UPDATE orders SET status = 'preparing' WHERE id = 'a-new'`).run();
    expect(ids()).toEqual([]);
  });

  it('logged out, Seen silences a "did not come in" card but cannot close it; logged in, it can', async () => {
    const { orderAlerts } = await import('../../services/order-alerts-hub.js');
    orderAlerts.importFailed({
      webOrderId: 'w-card',
      customerName: 'Sara',
      customerPhone: '0300-0000000',
      message: 'gave up after 5 attempts',
      final: true,
      reason: 'gave_up',
    });
    const cards = (r: unknown) =>
      (r as { data: { failures: Array<{ webOrderId: string; silenced: boolean }> } }).data.failures.filter(
        (f) => f.webOrderId === 'w-card',
      );
    const req = { closeFailureIds: ['w-card'], silenceFailureIds: ['w-card'] };
    expect(cards(call('alerts:acknowledge', req))).toEqual([expect.objectContaining({ silenced: true })]);
    expect(cards(call('alerts:getPending'))).toHaveLength(1);
    h.session = CASHIER;
    expect(cards(call('alerts:acknowledge', req))).toEqual([]);
  });
});
