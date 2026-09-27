/**
 * Website orders follow the shifts on the till (owner, 2026-09-27):
 *   - closing the LAST open shift on this till pauses them — the heartbeat
 *     goes out at once with acceptingOrders false and reason 'shift_closed';
 *   - opening a shift lifts the pause — the heartbeat says true again;
 *   - the owner's hand switch is never written by the pause or the resume:
 *     switched off by hand, ordering stays off after a shift opens;
 *   - a shift still open on THIS till keeps orders going (a shift closed on
 *     another till does not pause this one, and another till's open shift
 *     does not keep this one open);
 *   - orders already placed are still pulled in while paused;
 *   - followShiftForWebOrders never throws: not a broken database, not a
 *     bridge that throws, not a website that cannot be reached.
 *
 * A real database built from every migration (node:sqlite behind
 * better-sqlite3's shape — see costing-shop.fixture.ts; skips where it is
 * missing), the real shift repository and the real bridge, with `fetch`
 * stubbed so every request the bridge makes is recorded instead of sent.
 * The site address, secret and names are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../db/connection.js';
import { DatabaseSync, openMigrated } from '../db/costing-shop.fixture.js';
import { verifyAuditChain, type AuditChainRow } from '../db/audit-chain.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', getPath: () => '' },
  BrowserWindow: { getAllWindows: () => [] },
  // No OS keychain in a test: secrets are stored as typed.
  safeStorage: { isEncryptionAvailable: () => false },
}));
// Only the order import uses these, and no order is imported here.
vi.mock('./print-spooler.js', () => ({ printSpooler: { onOrderEvent: () => {} } }));
vi.mock('./order-alerts-hub.js', () => ({ orderAlerts: { orderReceived: () => {}, importFailed: () => {} } }));
vi.mock('../db/repositories/order-repo.js', () => ({}));
vi.mock('../db/repositories/customer-repo.js', () => ({}));

const live = describe.skipIf(!DatabaseSync);

const DEV = 'till-1';
const OTHER_TILL = 'till-2';
const CASHIER = { userId: 'u_ali', deviceId: DEV };
const MANAGER = { userId: 'u_sara', deviceId: DEV };
const SITE = 'https://shop.example.test';
const PAUSE_KEY = 'webBridge.shiftPause';

type Db = ReturnType<typeof openMigrated>;
type Row = Record<string, unknown>;

interface Sent {
  method: string;
  path: string;
  body: Row | null;
}

let sent: Sent[] = [];
/** Set to make every store-status push fail as if the Wi-Fi were down. */
let failStatusPushes = false;

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Row) : null;
      sent.push({ method, path: u.pathname, body });
      if (u.pathname === '/api/bridge/status' && failStatusPushes) throw new TypeError('fetch failed');
      const data = u.pathname === '/api/bridge/orders' ? [] : null;
      return new Response(JSON.stringify({ ok: true, data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

/** Every heartbeat the bridge has sent, oldest first. */
const beats = (): Row[] =>
  sent.filter((s) => s.method === 'PUT' && s.path === '/api/bridge/status').map((s) => s.body ?? {});

function seedUsers(db: Db): void {
  const T0 = '2026-01-01T00:00:00.000Z';
  const user = db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_ali', 'Ali', 'cashier', T0, T0, DEV);
  user.run('u_sara', 'Sara', 'manager', T0, T0, DEV);
}

function auditRows(db: Db): AuditChainRow[] {
  return db
    .prepare(
      `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action,
              actor_user_id AS actorUserId, before_json AS beforeJson, after_json AS afterJson,
              ip, created_at AS createdAt, prev_hash AS prevHash, row_hash AS rowHash
         FROM audit_log ORDER BY rowid`,
    )
    .all() as unknown as AuditChainRow[];
}

function pauseAudits(db: Db): Row[] {
  return db
    .prepare(
      `SELECT actor_user_id, before_json, after_json FROM audit_log
        WHERE entity_type = 'settings' AND entity_id = ? ORDER BY rowid`,
    )
    .all(PAUSE_KEY) as Row[];
}

/** The owner's saved config, exactly as stored. */
function storedConfigJson(db: Db): string {
  const row = db.prepare(`SELECT value_json FROM settings WHERE key = 'webBridge.config'`).get() as
    | { value_json: string }
    | undefined;
  return row?.value_json ?? '';
}

let cfgMod: typeof import('./web-bridge-config.js');
let pauseMod: typeof import('./web-orders-shift-pause.js');
let bridgeMod: typeof import('./web-orders-bridge.js');
let shifts: typeof import('../db/repositories/shift-repo.js');

beforeEach(async () => {
  if (!DatabaseSync) return;
  sent = [];
  failStatusPushes = false;
  stubFetch();
  // A fresh bridge singleton for every test (it keeps timers and state).
  vi.resetModules();
  cfgMod = await import('./web-bridge-config.js');
  pauseMod = await import('./web-orders-shift-pause.js');
  bridgeMod = await import('./web-orders-bridge.js');
  shifts = await import('../db/repositories/shift-repo.js');
});

afterEach(() => {
  bridgeMod?.webOrdersBridge.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A till with the website connected and "Accept online orders" as given, the bridge running. */
async function till(opts: { enabled: boolean }): Promise<Db> {
  const db = openMigrated();
  seedUsers(db);
  cfgMod.setWebBridgeConfig(
    db as AppDatabase,
    {
      enabled: opts.enabled,
      siteUrl: SITE,
      bridgeSecret: 'made-up-secret',
      pollIntervalMs: 20_000,
      cloudBackupFrequency: 'off',
    },
    MANAGER.userId,
  );
  bridgeMod.webOrdersBridge.init(db as AppDatabase, DEV);
  // Let the start-up push (and, when on, the first poll) finish.
  if (opts.enabled) {
    await vi.waitFor(() => expect(bridgeMod.webOrdersBridge.status().lastPollAt).not.toBeNull());
  } else {
    await vi.waitFor(() => expect(beats().length).toBe(1));
  }
  return db;
}

function openShiftOn(db: Db, deviceId: string) {
  return shifts.openShift(db as AppDatabase, { openingCashCents: 500_000 }, { userId: CASHIER.userId, deviceId });
}

function closeShiftOn(db: Db, shiftId: string, deviceId: string) {
  return shifts.closeShift(db as AppDatabase, { shiftId, countedCashCents: 500_000 }, { userId: MANAGER.userId, deviceId });
}

/** Wait for the next heartbeat after `before` of them had been sent, and return it. */
async function nextBeat(before: number): Promise<Row> {
  await vi.waitFor(() => expect(beats().length).toBeGreaterThan(before));
  return beats()[beats().length - 1]!;
}

// ---------------------------------------------------------------------------

describe('storeAcceptingOrders / storeHeartbeatBody (pure)', () => {
  it('says yes only with the owner switch on AND no shift pause', async () => {
    const m = await import('./web-bridge-config.js');
    const pause = { reason: 'shift_closed' as const, since: '2026-09-27T20:00:00.000Z' };
    expect(m.storeAcceptingOrders({ enabled: true }, null)).toBe(true);
    expect(m.storeAcceptingOrders({ enabled: true }, pause)).toBe(false);
    expect(m.storeAcceptingOrders({ enabled: false }, null)).toBe(false);
    expect(m.storeAcceptingOrders({ enabled: false }, pause)).toBe(false);
  });

  it('carries the reason only when the pause is what closes the shop', async () => {
    const m = await import('./web-bridge-config.js');
    const pause = { reason: 'shift_closed' as const, since: '2026-09-27T20:00:00.000Z' };
    expect(m.storeHeartbeatBody({ enabled: true }, pause, DEV)).toEqual({
      acceptingOrders: false,
      deviceId: DEV,
      features: ['pickup'],
      pickupDiscountPercent: expect.any(Number),
      reason: 'shift_closed',
    });
    expect(m.storeHeartbeatBody({ enabled: true }, null, DEV)).not.toHaveProperty('reason');
    // Switched off by hand: no reason, exactly as before this feature.
    expect(m.storeHeartbeatBody({ enabled: false }, pause, DEV)).not.toHaveProperty('reason');
    expect(m.storeHeartbeatBody({ enabled: false }, pause, DEV).acceptingOrders).toBe(false);
  });
});

live('website orders follow the shifts on this till', () => {
  it('closing the last open shift pauses website orders: the heartbeat goes out at once with accepting=false and the reason', async () => {
    const db = await till({ enabled: true });
    const shift = openShiftOn(db, DEV);
    expect(beats().at(-1)).toMatchObject({ acceptingOrders: true, deviceId: DEV });
    const configBefore = storedConfigJson(db);

    closeShiftOn(db, shift.id, DEV);
    const before = beats().length;
    pauseMod.followShiftForWebOrders(db as AppDatabase, DEV, 'closed', MANAGER.userId);

    const beat = await nextBeat(before);
    expect(beat).toMatchObject({ acceptingOrders: false, deviceId: DEV, reason: 'shift_closed' });
    expect(cfgMod.getWebOrdersShiftPause(db as AppDatabase)).toMatchObject({ reason: 'shift_closed' });
    // The owner's switch is untouched: still on, stored config byte for byte the same.
    expect(cfgMod.getWebBridgeConfig(db as AppDatabase).enabled).toBe(true);
    expect(storedConfigJson(db)).toBe(configBefore);
    // Settings → Online orders can say why.
    const status = bridgeMod.webOrdersBridge.status();
    expect(status.enabled).toBe(true);
    expect(status.shiftPause).toMatchObject({ reason: 'shift_closed' });
    expect(status.shiftPause?.message).toBe(
      'Website orders paused: shift closed — they start again when a shift is opened',
    );
    // Who closed the shift is on the audit row; the chain is whole; the pause is
    // this till's alone (settings are pure-local — nothing queued to sync).
    expect(pauseAudits(db)).toEqual([
      expect.objectContaining({ actor_user_id: MANAGER.userId, before_json: null }),
    ]);
    expect(verifyAuditChain(auditRows(db)).ok).toBe(true);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'settings'`).get(),
    ).toEqual({ n: 0 });
  });

  it('keeps pulling orders already placed while paused', async () => {
    const db = await till({ enabled: true });
    const shift = openShiftOn(db, DEV);
    closeShiftOn(db, shift.id, DEV);
    pauseMod.followShiftForWebOrders(db as AppDatabase, DEV, 'closed', MANAGER.userId);
    await vi.waitFor(() => expect(beats().at(-1)).toMatchObject({ acceptingOrders: false }));

    const pullsBefore = sent.filter((s) => s.path === '/api/bridge/orders').length;
    bridgeMod.webOrdersBridge.kick();
    await vi.waitFor(() =>
      expect(sent.filter((s) => s.path === '/api/bridge/orders').length).toBeGreaterThan(pullsBefore),
    );
    // …and the poll says nothing to the site: its last word stays "paused".
    expect(beats().at(-1)).toMatchObject({ acceptingOrders: false, reason: 'shift_closed' });
  });

  it('opening a shift resumes: the heartbeat says accepting=true again, with no reason', async () => {
    const db = await till({ enabled: true });
    const first = openShiftOn(db, DEV);
    closeShiftOn(db, first.id, DEV);
    pauseMod.followShiftForWebOrders(db as AppDatabase, DEV, 'closed', MANAGER.userId);
    await vi.waitFor(() => expect(beats().at(-1)).toMatchObject({ acceptingOrders: false }));

    openShiftOn(db, DEV);
    const before = beats().length;
    pauseMod.followShiftForWebOrders(db as AppDatabase, DEV, 'opened', CASHIER.userId);

    const beat = await nextBeat(before);
    expect(beat).toMatchObject({ acceptingOrders: true, deviceId: DEV });
    expect(beat).not.toHaveProperty('reason');
    expect(cfgMod.getWebOrdersShiftPause(db as AppDatabase)).toBeNull();
    expect(bridgeMod.webOrdersBridge.status().shiftPause).toBeNull();
    // Paused by the manager who closed, lifted by the cashier who opened.
    expect(pauseAudits(db).map((a) => a.actor_user_id)).toEqual([MANAGER.userId, CASHIER.userId]);
    expect(verifyAuditChain(auditRows(db)).ok).toBe(true);
  });

  it("the owner's hand switch stays off after a shift opens, and the pause never writes it", async () => {
    const db = await till({ enabled: false });
    const configBefore = storedConfigJson(db);
    const first = openShiftOn(db, DEV);
    closeShiftOn(db, first.id, DEV);
    pauseMod.followShiftForWebOrders(db as AppDatabase, DEV, 'closed', MANAGER.userId);
    expect(cfgMod.getWebOrdersShiftPause(db as AppDatabase)).not.toBeNull();

    openShiftOn(db, DEV);
    pauseMod.followShiftForWebOrders(db as AppDatabase, DEV, 'opened', CASHIER.userId);
    expect(cfgMod.getWebOrdersShiftPause(db as AppDatabase)).toBeNull();

    // Still off: the switch as stored is exactly what the owner saved…
    const cfg = cfgMod.getWebBridgeConfig(db as AppDatabase);
    expect(cfg.enabled).toBe(false);
    expect(storedConfigJson(db)).toBe(configBefore);
    // …what the heartbeat would say is "not accepting"…
    expect(
      cfgMod.storeHeartbeatBody(cfg, cfgMod.getWebOrdersShiftPause(db as AppDatabase), DEV).acceptingOrders,
    ).toBe(false);
    // …and nothing was sent to the site: with ordering off it is closed already.
    await new Promise((r) => setTimeout(r, 50));
    expect(beats()).toEqual([expect.objectContaining({ acceptingOrders: false })]); // the start-up push only
    expect(bridgeMod.webOrdersBridge.status()).toMatchObject({ enabled: false, shiftPause: null });
  });

  it('the owner switching ordering on while no shift is open does not open the site', async () => {
    const db = await till({ enabled: true });
    const shift = openShiftOn(db, DEV);
    closeShiftOn(db, shift.id, DEV);
    pauseMod.followShiftForWebOrders(db as AppDatabase, DEV, 'closed', MANAGER.userId);
    await vi.waitFor(() => expect(beats().at(-1)).toMatchObject({ acceptingOrders: false }));

    // Settings → Save (webBridge:setConfig) re-pushes the store status.
    const before = beats().length;
    bridgeMod.webOrdersBridge.reschedule();
    expect(await nextBeat(before)).toMatchObject({ acceptingOrders: false, reason: 'shift_closed' });
  });

  it('a shift still open on THIS till keeps website orders going; another till\'s shifts do not count', async () => {
    const db = await till({ enabled: true });
    // One open shift per till (idx_shifts_one_open_per_device), so "another
    // shift still open" means: this till has its own shift open when a shift
    // elsewhere (another till's, synced here) is closed.
    const mine = openShiftOn(db, DEV);
    const theirs = openShiftOn(db, OTHER_TILL);
    closeShiftOn(db, theirs.id, OTHER_TILL);
    const before = beats().length;
    pauseMod.followShiftForWebOrders(db as AppDatabase, DEV, 'closed', MANAGER.userId);
    expect(cfgMod.getWebOrdersShiftPause(db as AppDatabase)).toBeNull();
    expect(pauseAudits(db)).toEqual([]);
    await new Promise((r) => setTimeout(r, 50));
    expect(beats().length).toBe(before);

    // The other way round: another till's open shift does not keep this one going.
    openShiftOn(db, OTHER_TILL);
    closeShiftOn(db, mine.id, DEV);
    pauseMod.followShiftForWebOrders(db as AppDatabase, DEV, 'closed', MANAGER.userId);
    expect(cfgMod.getWebOrdersShiftPause(db as AppDatabase)).toMatchObject({ reason: 'shift_closed' });
    expect(await nextBeat(before)).toMatchObject({ acceptingOrders: false, reason: 'shift_closed' });
  });

  it('a repeat is a no-op: the pause keeps its start time and writes one audit row', async () => {
    const db = await till({ enabled: true });
    const shift = openShiftOn(db, DEV);
    closeShiftOn(db, shift.id, DEV);
    pauseMod.followShiftForWebOrders(db as AppDatabase, DEV, 'closed', MANAGER.userId);
    const first = cfgMod.getWebOrdersShiftPause(db as AppDatabase);
    await vi.waitFor(() => expect(beats().at(-1)).toMatchObject({ acceptingOrders: false }));
    const before = beats().length;

    await new Promise((r) => setTimeout(r, 5));
    pauseMod.followShiftForWebOrders(db as AppDatabase, DEV, 'closed', MANAGER.userId);
    expect(cfgMod.getWebOrdersShiftPause(db as AppDatabase)).toEqual(first);
    expect(pauseAudits(db)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(beats().length).toBe(before);
  });
});

live('followShiftForWebOrders never throws', () => {
  it('when the bridge throws: the pause is still recorded', async () => {
    const db = await till({ enabled: true });
    vi.spyOn(bridgeMod.webOrdersBridge, 'refreshStoreStatus').mockImplementation(() => {
      throw new Error('bridge exploded');
    });
    expect(() =>
      pauseMod.followShiftForWebOrders(db as AppDatabase, DEV, 'closed', MANAGER.userId),
    ).not.toThrow();
    expect(cfgMod.getWebOrdersShiftPause(db as AppDatabase)).toMatchObject({ reason: 'shift_closed' });
  });

  it('when the settings cannot be read or written: nothing is sent', async () => {
    await till({ enabled: true });
    const refresh = vi.spyOn(bridgeMod.webOrdersBridge, 'refreshStoreStatus');
    const broken = {
      prepare: () => {
        throw new Error('SQLITE_IOERR: disk I/O error');
      },
      transaction: () => () => {
        throw new Error('SQLITE_IOERR: disk I/O error');
      },
    } as unknown as AppDatabase;
    expect(() => pauseMod.followShiftForWebOrders(broken, DEV, 'closed', MANAGER.userId)).not.toThrow();
    expect(() => pauseMod.followShiftForWebOrders(broken, DEV, 'opened', CASHIER.userId)).not.toThrow();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('when the website cannot be reached: no throw, no unhandled rejection, and the next resume still goes out', async () => {
    const db = await till({ enabled: true });
    const shift = openShiftOn(db, DEV);
    closeShiftOn(db, shift.id, DEV);
    failStatusPushes = true;
    const before = beats().length;
    expect(() =>
      pauseMod.followShiftForWebOrders(db as AppDatabase, DEV, 'closed', MANAGER.userId),
    ).not.toThrow();
    await vi.waitFor(() => expect(beats().length).toBeGreaterThan(before)); // tried, and failed
    expect(cfgMod.getWebOrdersShiftPause(db as AppDatabase)).not.toBeNull();

    failStatusPushes = false;
    openShiftOn(db, DEV);
    const next = beats().length;
    pauseMod.followShiftForWebOrders(db as AppDatabase, DEV, 'opened', CASHIER.userId);
    expect(await nextBeat(next)).toMatchObject({ acceptingOrders: true });
  });

  it('when the website is not set up (or the bridge never started): the pause is only recorded', async () => {
    const db = openMigrated();
    seedUsers(db);
    // No init, no config: a till that has never been connected to a website.
    expect(() =>
      pauseMod.followShiftForWebOrders(db as AppDatabase, DEV, 'closed', MANAGER.userId),
    ).not.toThrow();
    expect(cfgMod.getWebOrdersShiftPause(db as AppDatabase)).toMatchObject({ reason: 'shift_closed' });

    // Started, but no website address or secret saved.
    bridgeMod.webOrdersBridge.init(db as AppDatabase, DEV);
    openShiftOn(db, DEV);
    expect(() =>
      pauseMod.followShiftForWebOrders(db as AppDatabase, DEV, 'opened', CASHIER.userId),
    ).not.toThrow();
    expect(cfgMod.getWebOrdersShiftPause(db as AppDatabase)).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual([]);
  });
});
