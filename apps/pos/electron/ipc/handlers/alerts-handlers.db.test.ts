/**
 * Settings → Sounds and the pending order alerts through the real `alerts:*`
 * handlers, against a real SQLite database built from every migration:
 *   - anyone (the PIN screen too) can read the sounds and the pending list;
 *   - only the owner can change the sounds or send the test notice, and a
 *     change is audited: a cashier cannot mute the till, and a manager no
 *     longer has Settings (printer.manage; owner, 2026-09-27: "managers
 *     can't see the reports and settings");
 *   - a "did not come in" card is closed only by someone logged in: logged
 *     out, Seen silences it and the card stays on screen;
 *   - while nobody is signed in, the pending list carries no phone number
 *     (the PIN screen); signed in, it does;
 *   - Seen and a closed "website cancelled" card are saved, so a restart
 *     (fresh modules, the same database) brings back only the website
 *     orders still New and unseen from the last 12 hours, and the "website
 *     cancelled" cards nobody signed in has closed;
 *   - an order leaves the pending list (stops ringing) once it has moved past
 *     New or been deleted — the stillWaiting query in order-alerts-hub.ts;
 *   - anyone (the PIN screen too) can read the watch, which says when website
 *     orders are paused on this till and carries no website address or
 *     password; a part that cannot be read comes back empty.
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
import {
  DEFAULT_ALERT_SOUND_SETTINGS,
  EMPTY_ALERT_WATCH,
  type AlertWatch,
  type AuthenticatedUser,
  type UUID,
} from '@cheeseoclock/shared-types';

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
  // No OS keychain in a test: the website password is stored as typed.
  safeStorage: { isEncryptionAvailable: () => false },
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
const OWNER = session('u_admin', 'admin');
/** What alerts-handlers.ts says to a login without printer.manage (shown as it is). */
const SOUNDS_REFUSED = 'Only the owner can change the order sounds.';

let db: ReturnType<typeof openMigrated>;

const call = (channel: string, payload?: unknown) => {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  return fn({ db, deviceId: DEV }, payload);
};
/** The guard's error code, or null when the call went through. */
function refusal(channel: string, payload?: unknown): string | null {
  return refusalWords(channel, payload)?.code ?? null;
}
/** The guard's error code and words, or null when the call went through. */
function refusalWords(channel: string, payload?: unknown): { code: string; message: string } | null {
  try {
    call(channel, payload);
    return null;
  } catch (e) {
    return (e as { apiError?: { code: string; message: string } }).apiError ?? { code: 'threw', message: String(e) };
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
  user.run('u_admin', 'Test Owner', 'admin', T0, T0, DEV);
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

  it('a manager cannot either (Settings are the owner\'s since 2026-09-27): refused in plain words; nothing is written', () => {
    const mute = { ...DEFAULT_ALERT_SOUND_SETTINGS, enabled: false };
    h.session = MANAGER;
    expect(refusalWords('alerts:setSounds', mute)).toEqual({ code: 'forbidden', message: SOUNDS_REFUSED });
    expect(refusalWords('alerts:testNotice')).toEqual({ code: 'forbidden', message: SOUNDS_REFUSED });
    expect(count(`SELECT COUNT(*) AS n FROM settings WHERE key = 'alerts.sounds'`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = 'alerts.sounds'`)).toBe(0);
    // Reading them needs no login, so a manager still hears (and sees) the standard ones.
    expect(call('alerts:getSounds')).toEqual({ ok: true, data: DEFAULT_ALERT_SOUND_SETTINGS });
  });

  it('the owner can: saved checked, kept for this till, and the audit trail says who', () => {
    h.session = OWNER;
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
    expect(audit).toEqual([{ action: 'settings_change', actor_user_id: 'u_admin' }]);
  });

  it('the owner can send the test notice (none shows here: no window, no notices)', () => {
    h.session = OWNER;
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

  it('signed out, no card carries a phone number (getPending or acknowledge); signed in, they do', async () => {
    const { orderAlerts } = await import('../../services/order-alerts-hub.js');
    orderAlerts.importFailed({
      webOrderId: 'w-phone-1',
      customerName: 'Sara',
      customerPhone: '0300-1111111',
      message: 'gave up after 5 attempts',
      final: true,
      reason: 'gave_up',
    });
    orderAlerts.importFailed({
      webOrderId: 'w-phone-2',
      customerName: 'Ali',
      customerPhone: '0300-2222222',
      orderNumber: 'CO-20260926-0042',
      message: 'cancelled on the website while the kitchen had it',
      final: true,
      reason: 'cancelled_on_site',
    });
    type Failures = { data: { failures: Array<{ webOrderId: string; customerPhone: string | null }> } };
    const phones = (r: unknown) =>
      Object.fromEntries(
        (r as Failures).data.failures
          .filter((f) => f.webOrderId.startsWith('w-phone-'))
          .map((f) => [f.webOrderId, f.customerPhone]),
      );

    h.session = null;
    const signedOut = call('alerts:getPending') as Failures;
    expect(signedOut.data.failures.length).toBeGreaterThanOrEqual(2);
    expect(signedOut.data.failures.every((f) => f.customerPhone === null)).toBe(true);
    expect(JSON.stringify(signedOut)).not.toMatch(/0300-/);
    // Seen on the PIN screen answers with the list too: no phone in it either.
    const ack = call('alerts:acknowledge', { silenceFailureIds: ['w-phone-1'] });
    expect(phones(ack)).toEqual({ 'w-phone-1': null, 'w-phone-2': null });

    // The hub still has them: the first read after a sign-in brings them back.
    h.session = CASHIER;
    expect(phones(call('alerts:getPending'))).toEqual({ 'w-phone-1': '0300-1111111', 'w-phone-2': '0300-2222222' });
  });
});

describe.skipIf(!Sqlite)('pending order alerts across a restart', () => {
  const isoAgo = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

  /** A website order the bridge imported: its POS order and its import row (made-up customer). */
  function webOrder(
    n: number,
    o: {
      status?: string;
      deleted?: boolean;
      importedMin: number;
      seenMin?: number;
      siteCancelledMin?: number;
      cancelNotedMin?: number;
      webTotalCents?: number | null;
    },
  ): void {
    const id = `o${n}`;
    const created = isoAgo(o.importedMin + 1);
    db.prepare(
      `INSERT INTO orders (id, order_number, mode, status, cashier_id, source, customer_name_snapshot,
                           customer_phone_snapshot, total_cents, created_at, updated_at, deleted_at, device_id)
       VALUES (?, ?, 'delivery', ?, 'u_cash', 'web', 'Test Customer', '0300-7654321', 150000, ?, ?, ?, ?)`,
    ).run(id, `CO-20261001-00${n}`, o.status ?? 'sent_to_kitchen', created, created, o.deleted ? isoAgo(1) : null, DEV);
    const imported = isoAgo(o.importedMin);
    db.prepare(
      `INSERT INTO web_order_imports (web_order_id, pos_order_id, status, attempts, last_pushed_status, imported_at,
                                      created_at, updated_at, web_total_cents, acked_at, alert_seen_at,
                                      site_cancelled_at, cancel_noted_at)
       VALUES (?, ?, 'imported', 1, 'accepted', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `w${n}`,
      id,
      imported,
      imported,
      imported,
      o.webTotalCents === undefined ? 150000 : o.webTotalCents,
      imported,
      o.seenMin === undefined ? null : isoAgo(o.seenMin),
      o.siteCancelledMin === undefined ? null : isoAgo(o.siteCancelledMin),
      o.cancelNotedMin === undefined ? null : isoAgo(o.cancelNotedMin),
    );
  }

  /** The till restarts on the same database: fresh modules, the handlers registered again. */
  async function restart(): Promise<void> {
    vi.resetModules();
    h.handlers.clear();
    const { registerAlertsHandlers } = await import('./alerts-handlers.js');
    registerAlertsHandlers({ db, deviceId: DEV } as never);
  }

  type Pending = {
    data: {
      orders: Array<{ orderId: string; receivedAt: string; totalMismatch: unknown }>;
      failures: Array<{
        webOrderId: string;
        reason: string;
        silenced: boolean;
        orderNumber?: string | null;
        customerPhone: string | null;
      }>;
    };
  };
  const pending = () => call('alerts:getPending') as Pending;
  const importRow = (n: number) =>
    db.prepare(`SELECT alert_seen_at, cancel_noted_at FROM web_order_imports WHERE web_order_id = ?`).get(`w${n}`);

  it('Seen sets alert_seen_at, signed out too; the first time is kept', () => {
    webOrder(41, { importedMin: 5 });
    h.session = null;
    call('alerts:acknowledge', { orderIds: ['o41'] });
    const first = importRow(41)?.['alert_seen_at'];
    expect(typeof first).toBe('string');
    call('alerts:acknowledge', { orderIds: ['o41'] });
    expect(importRow(41)?.['alert_seen_at']).toBe(first);
  });

  it('only unseen website orders still New from the last 12 hours ring again; seen, started, deleted or older ones do not', async () => {
    webOrder(41, { importedMin: 120, webTotalCents: 140000 }); // unseen, New, 2 h ago — the total changed
    webOrder(42, { importedMin: 120, seenMin: 110 }); // seen
    webOrder(43, { importedMin: 120, status: 'preparing' }); // started
    webOrder(44, { importedMin: 13 * 60 }); // 13 hours ago
    webOrder(45, { importedMin: 30, deleted: true }); // deleted
    webOrder(46, { importedMin: 20, webTotalCents: null }); // unseen, imported before 0046 kept a website total
    await restart();

    const p = pending().data;
    expect(p.orders.map((o) => o.orderId)).toEqual(['o41', 'o46']);
    const importedAt = db.prepare(`SELECT imported_at FROM web_order_imports WHERE web_order_id = 'w41'`).get()?.['imported_at'];
    // It keeps the time it came in, and the changed total is shown again.
    expect(p.orders[0]).toMatchObject({
      receivedAt: importedAt,
      totalMismatch: { webTotalCents: 140000, tillTotalCents: 150000 },
    });
    expect(p.orders[1]!.totalMismatch).toBeNull();

    // Seen on the PIN screen, then another restart: nothing rings.
    h.session = null;
    call('alerts:acknowledge', { orderIds: ['o41', 'o46'] });
    await restart();
    expect(pending().data.orders).toEqual([]);
  });

  it('a "website cancelled" card nobody closed comes back loud; signed out it stays (no phone), signed in it is closed for good', async () => {
    webOrder(51, { importedMin: 90, status: 'preparing', seenMin: 85, siteCancelledMin: 30 }); // open
    webOrder(52, { importedMin: 90, status: 'preparing', seenMin: 85, siteCancelledMin: 30, cancelNotedMin: 20 }); // closed
    webOrder(53, { importedMin: 14 * 60, status: 'preparing', seenMin: 14 * 60, siteCancelledMin: 13 * 60 }); // too old
    await restart();

    h.session = null;
    expect(pending().data.failures).toEqual([
      expect.objectContaining({
        webOrderId: 'w51',
        reason: 'cancelled_on_site',
        silenced: false,
        orderNumber: 'CO-20261001-0051',
        customerPhone: null,
      }),
    ]);
    h.session = CASHIER;
    expect(pending().data.failures[0]).toMatchObject({ webOrderId: 'w51', customerPhone: '0300-7654321' });

    // Signed out, the card cannot be closed: it is not marked, and the next restart brings it back.
    h.session = null;
    call('alerts:acknowledge', { closeFailureIds: ['w51'], silenceFailureIds: ['w51'] });
    expect(importRow(51)?.['cancel_noted_at']).toBeNull();
    await restart();
    expect(pending().data.failures.map((f) => [f.webOrderId, f.silenced])).toEqual([['w51', false]]);

    // Signed in, closing it marks it, and it never comes back.
    h.session = CASHIER;
    call('alerts:acknowledge', { closeFailureIds: ['w51'] });
    expect(typeof importRow(51)?.['cancel_noted_at']).toBe('string');
    await restart();
    expect(pending().data.failures).toEqual([]);
  });
});

describe.skipIf(!Sqlite)('the watch through alerts:getWatch (the PIN screen)', () => {
  const SITE = 'https://shop.example.test';
  const SECRET = 'made-up-secret';
  const watch = () => call('alerts:getWatch') as { ok: true; data: AlertWatch };

  /** The owner has linked the website and switched orders on; the last shift on this till closed at T0. */
  async function pausedWithLink(): Promise<void> {
    const cfg = await import('../../services/web-bridge-config.js');
    cfg.setWebBridgeConfig(
      db as never,
      { enabled: true, siteUrl: SITE, bridgeSecret: SECRET, pollIntervalMs: 20_000, cloudBackupFrequency: 'off' },
      'u_admin',
    );
    cfg.setWebOrdersShiftPause(db as never, { reason: 'shift_closed', since: T0 }, 'u_mgr');
  }

  it('a fresh till, nobody signed in: nothing paused, no website link, nothing else to show', () => {
    expect(watch()).toEqual({
      ok: true,
      data: expect.objectContaining({ webOrders: { paused: false, websiteLinkSet: false } }),
    });
    expect(watch().data).toEqual(EMPTY_ALERT_WATCH);
  });

  it('paused on this till: says so and since when, in six parts, with no website address or password', async () => {
    await pausedWithLink();
    const r = watch();
    expect(r.ok).toBe(true);
    expect(r.data.webOrders).toStrictEqual({ paused: true, since: T0, websiteLinkSet: true });
    expect(Object.keys(r.data).sort()).toEqual([
      'orders',
      'shiftOpen',
      'ticketsNotPrinted',
      'timing',
      'unconfirmed',
      'webOrders',
    ]);
    const text = JSON.stringify(r.data);
    expect(text).not.toContain('shop.example.test');
    expect(text).not.toContain(SECRET);
  });

  it('the same answer for every login, and never "unauthenticated"', async () => {
    await pausedWithLink();
    h.session = null;
    expect(refusal('alerts:getWatch')).toBeNull();
    const signedOut = watch();
    for (const s of [CASHIER, MANAGER, OWNER]) {
      h.session = s;
      expect(refusal('alerts:getWatch')).toBeNull();
      expect(watch()).toEqual(signedOut);
    }
  });

  it('a part that cannot be read comes back empty, and the read never throws', async () => {
    const { readAlertWatch } = await import('../../services/alert-watch.js');
    const broken = {
      prepare: () => {
        throw new Error('SQLITE_IOERR: disk I/O error');
      },
    } as never;
    expect(readAlertWatch(broken, Date.now(), DEV)).toEqual(EMPTY_ALERT_WATCH);
  });

  it('whether a shift is open on this till: only yes or no, the same for every login', () => {
    const shift = (id: string, device: string, closedAt: string | null) =>
      db.prepare(
        `INSERT INTO shifts (id, device_id, opened_by_user_id, opened_at, closed_by_user_id, closed_at, created_at, updated_at)
         VALUES (?, ?, 'u_cash', ?, ?, ?, ?, ?)`,
      ).run(id, device, T0, closedAt ? 'u_cash' : null, closedAt, T0, T0);
    expect(watch().data.shiftOpen).toBe(false);
    // Closed here, or open on the other till: this till's shop is closed.
    shift('sh-closed', DEV, '2026-09-26T17:00:00.000Z');
    shift('sh-other', 'till-2', null);
    expect(watch().data.shiftOpen).toBe(false);
    // Open on this till.
    shift('sh-open', DEV, null);
    for (const s of [null, CASHIER, MANAGER, OWNER]) {
      h.session = s;
      expect(watch().data.shiftOpen).toBe(true);
      // Not who opened it, nor when.
      const text = JSON.stringify(watch().data);
      expect(text).not.toContain('Test Cashier');
      expect(text).not.toContain('u_cash');
      expect(text).not.toContain(T0);
    }
  });
});

describe.skipIf(!Sqlite)('the watch: kitchen orders, tickets not printed and website orders not confirmed (no customer)', () => {
  // Made up, and on every seeded order: none of it may leave in the watch.
  const NAME = 'Zarnigar Testcustomer';
  const PHONE = '0300-5550142';
  const ADDRESS = 'House 7, Street 9, Madeup Town';
  /** A little past `min` minutes ago, so the till's whole minutes come out as `min`. */
  const ago = (min: number) => new Date(Date.now() - min * 60_000 - 5_000).toISOString();
  const watch = () => (call('alerts:getWatch') as { ok: true; data: AlertWatch }).data;

  function kitchenOrder(
    n: number,
    o: { status?: string; source?: 'web' | 'pos'; minutes: number; deleted?: boolean },
  ): void {
    const created = ago(o.minutes);
    db.prepare(
      `INSERT INTO orders (id, order_number, mode, status, cashier_id, source, customer_name_snapshot,
                           customer_phone_snapshot, delivery_address_snapshot, total_cents, created_at, updated_at,
                           deleted_at, device_id)
       VALUES (?, ?, 'delivery', ?, 'u_cash', ?, ?, ?, ?, 150000, ?, ?, ?, ?)`,
    ).run(
      `o${n}`,
      `CO-20261001-00${n}`,
      o.status ?? 'sent_to_kitchen',
      o.source ?? 'web',
      NAME,
      PHONE,
      ADDRESS,
      created,
      created,
      o.deleted ? created : null,
      DEV,
    );
  }

  /** The website order behind o<n>, imported `importedMin` minutes ago; acked or not. */
  function imported(n: number, o: { importedMin: number; webCreatedMin: number | null; acked: boolean }): void {
    const at = ago(o.importedMin);
    db.prepare(
      `INSERT INTO web_order_imports (web_order_id, pos_order_id, status, attempts, last_pushed_status, imported_at,
                                      created_at, updated_at, web_created_at, web_total_cents, acked_at)
       VALUES (?, ?, 'imported', 1, 'accepted', ?, ?, ?, ?, 150000, ?)`,
    ).run(`w${n}`, `o${n}`, at, at, at, o.webCreatedMin === null ? null : ago(o.webCreatedMin), o.acked ? at : null);
  }

  async function seed(): Promise<void> {
    kitchenOrder(61, { minutes: 12 }); // a website order in New for 12 minutes
    imported(61, { importedMin: 12, webCreatedMin: 13, acked: true });
    kitchenOrder(62, { minutes: 40, status: 'preparing', source: 'pos' }); // a counter order being made
    kitchenOrder(63, { minutes: 20, deleted: true });
    kitchenOrder(64, { minutes: 30, status: 'out_for_delivery' });
    kitchenOrder(65, { minutes: 4 * 60 }); // four hours old
    kitchenOrder(66, { minutes: 50, status: 'delivered' });
    kitchenOrder(67, { minutes: 6 }); // not confirmed for 6 minutes
    imported(67, { importedMin: 6, webCreatedMin: 7, acked: false });
    kitchenOrder(68, { minutes: 3 }); // not confirmed for 3 minutes: too soon to warn
    imported(68, { importedMin: 3, webCreatedMin: 4, acked: false });
    kitchenOrder(69, { minutes: 10 }); // not confirmed, imported before 0046 kept the website's time
    imported(69, { importedMin: 10, webCreatedMin: null, acked: false });

    const { setBusinessSetting } = await import('../../db/repositories/business-settings-repo.js');
    setBusinessSetting(
      db as never,
      'kitchen.timing',
      { v: 1, amberMin: 5, redMin: 10, notStartedMin: 5, notDoneMin: 20 },
      { userId: 'u_admin', deviceId: DEV },
    );
    const { enqueuePrintJob, markJobFailedPermanently } = await import('../../db/repositories/print-queue-repo.js');
    const job = enqueuePrintJob(db as never, { kind: 'kitchen', orderId: 'o61', reprint: false });
    markJobFailedPermanently(db as never, job.id, 'Printer offline');
    // An order forgotten in New since yesterday whose ticket (a Reprint) was given up on just now.
    kitchenOrder(70, { minutes: 20 * 60 });
    const old = enqueuePrintJob(db as never, { kind: 'kitchen', orderId: 'o70', reprint: true });
    markJobFailedPermanently(db as never, old.id, 'Printer offline');
  }

  it('lists what the kitchen still has, oldest first, in whole minutes, with the owner’s timing', async () => {
    await seed();
    const w = watch();
    expect(w.orders).toEqual([
      { orderId: 'o62', orderNumber: 'CO-20261001-0062', status: 'preparing', source: 'pos', minutes: 40 },
      { orderId: 'o61', orderNumber: 'CO-20261001-0061', status: 'sent_to_kitchen', source: 'web', minutes: 12 },
      { orderId: 'o69', orderNumber: 'CO-20261001-0069', status: 'sent_to_kitchen', source: 'web', minutes: 10 },
      { orderId: 'o67', orderNumber: 'CO-20261001-0067', status: 'sent_to_kitchen', source: 'web', minutes: 6 },
      { orderId: 'o68', orderNumber: 'CO-20261001-0068', status: 'sent_to_kitchen', source: 'web', minutes: 3 },
    ]);
    // Deleted, out for delivery, delivered and four-hour-old orders are left out; no time leaves, only minutes.
    expect(w.timing).toEqual({ notStartedMin: 5, notDoneMin: 20 });
  });

  it('kitchen tickets this till gave up on, and website orders not confirmed for 5 minutes with when the website cancels them', async () => {
    await seed();
    const w = watch();
    // Only for orders up to 3 hours old: the PIN screen does not beep all night for yesterday's.
    expect(w.ticketsNotPrinted).toEqual([{ orderId: 'o61', orderNumber: 'CO-20261001-0061', failedAt: expect.any(String) }]);

    const created67 = db.prepare(`SELECT web_created_at FROM web_order_imports WHERE web_order_id = 'w67'`).get()?.[
      'web_created_at'
    ] as string;
    expect(w.unconfirmed).toEqual([
      { orderId: 'o69', orderNumber: 'CO-20261001-0069', minutes: 10, cancelsAt: null },
      {
        orderId: 'o67',
        orderNumber: 'CO-20261001-0067',
        minutes: 6,
        cancelsAt: new Date(Date.parse(created67) + 45 * 60_000).toISOString(),
      },
    ]);
    // Once the website confirms it, the note has nothing to say.
    db.prepare(`UPDATE web_order_imports SET acked_at = ? WHERE web_order_id = 'w67'`).run(new Date().toISOString());
    expect(watch().unconfirmed.map((u) => u.orderId)).toEqual(['o69']);
  });

  it('carries no customer name, phone or address, for anyone (the PIN screen reads it)', async () => {
    await seed();
    for (const s of [null, CASHIER, OWNER]) {
      h.session = s;
      const text = JSON.stringify(watch());
      for (const secret of [NAME, 'Zarnigar', PHONE, '5550142', ADDRESS, 'Madeup']) expect(text).not.toContain(secret);
      expect(text).not.toMatch(/created_?at/i);
    }
  });
});
