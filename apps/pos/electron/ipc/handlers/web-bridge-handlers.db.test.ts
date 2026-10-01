/**
 * The owner saves Settings → Online orders (webBridge:setConfig) and website
 * orders follow the shift from that moment (v0.7.33): saved with "Accept
 * online orders" on and the website link set while no shift is open on this
 * till, they are paused at once — as closing the last shift would have, with
 * the owner on the audit row — and the website's first word after the save
 * is "not accepting". With a shift open on this till, or the switch off,
 * nothing is paused. The first shift's open lifts it as before.
 *
 * Only `defineHandler` (captured), the signed-in session and what the order
 * import needs are stood in for: the real handler, settings, shift
 * repository, pause and bridge, on a database built from every migration
 * (node:sqlite behind better-sqlite3's shape; skipped where it is missing),
 * with `fetch` stubbed so every request the bridge makes is recorded instead
 * of sent. The site address, secret and names are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, UUID } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../../db/connection.js';
import { DatabaseSync, openMigrated } from '../../db/costing-shop.fixture.js';
import { verifyAuditChain, type AuditChainRow } from '../../db/audit-chain.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Handler = (ctx: unknown, payload: unknown) => unknown;

const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => unknown>(),
  session: null as AuthenticatedUser | null,
  /** Every channel sent to the one (made-up) till window, oldest first. */
  screen: [] as string[],
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
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', getPath: () => '' },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: (channel: string) => h.screen.push(channel) } },
    ],
  },
  // No OS keychain in a test: secrets are stored as typed.
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('../../services/auth-service.js', () => ({ getCurrentSession: () => h.session }));
// Only the order import uses these, and no order is imported here.
vi.mock('../../services/print-spooler.js', () => ({ printSpooler: { onOrderEvent: () => {} } }));
vi.mock('../../services/order-alerts-hub.js', () => ({ orderAlerts: { orderReceived: () => {}, importFailed: () => {} } }));
vi.mock('../../db/repositories/order-repo.js', () => ({}));
vi.mock('../../db/repositories/customer-repo.js', () => ({}));

const live = describe.skipIf(!DatabaseSync);

const DEV = 'till-1';
const OTHER_TILL = 'till-2';
const OWNER_ID = 'u_owner';
const CASHIER_ID = 'u_ali';
const SITE = 'https://shop.example.test';
const PAUSE_KEY = 'webBridge.shiftPause';
const OWNER_LOGIN: AuthenticatedUser = {
  id: OWNER_ID as UUID,
  fullName: 'Test Owner',
  role: 'admin',
  sessionId: 'sess_owner' as UUID,
};

type Db = ReturnType<typeof openMigrated>;
type Row = Record<string, unknown>;

let sent: Array<{ method: string; path: string; body: Row | null }> = [];

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Row) : null;
      sent.push({ method: init?.method ?? 'GET', path: u.pathname, body });
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
const watchEvents = (): number => h.screen.filter((c) => c === 'alerts:watch-changed').length;

let cfgMod: typeof import('../../services/web-bridge-config.js');
let pauseMod: typeof import('../../services/web-orders-shift-pause.js');
let bridgeMod: typeof import('../../services/web-orders-bridge.js');
let shifts: typeof import('../../db/repositories/shift-repo.js');
let db: Db;

beforeEach(async () => {
  if (!DatabaseSync) return;
  sent = [];
  h.screen = [];
  h.handlers.clear();
  h.session = OWNER_LOGIN;
  stubFetch();
  // A fresh bridge singleton for every test (it keeps timers and state); the
  // handler is registered against that same one.
  vi.resetModules();
  cfgMod = await import('../../services/web-bridge-config.js');
  pauseMod = await import('../../services/web-orders-shift-pause.js');
  bridgeMod = await import('../../services/web-orders-bridge.js');
  shifts = await import('../../db/repositories/shift-repo.js');
  const { registerWebBridgeHandlers } = await import('./web-bridge-handlers.js');

  // A fresh till, started: no website link saved yet, so the bridge says nothing.
  db = openMigrated();
  const T0 = '2026-01-01T00:00:00.000Z';
  const user = db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run(OWNER_ID, 'Test Owner', 'admin', T0, T0, DEV);
  user.run(CASHIER_ID, 'Ali', 'cashier', T0, T0, DEV);
  pauseMod.settleShiftPauseAtStart(db as AppDatabase, DEV);
  bridgeMod.webOrdersBridge.init(db as AppDatabase, DEV);
  registerWebBridgeHandlers({ db: db as AppDatabase, deviceId: DEV });
});

afterEach(() => {
  bridgeMod?.webOrdersBridge.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The owner presses Save on Settings → Online orders. */
async function save(enabled: boolean): Promise<void> {
  const fn = h.handlers.get('webBridge:setConfig');
  if (!fn) throw new Error('webBridge:setConfig is not registered');
  const r = (await fn(
    { db, deviceId: DEV },
    { enabled, siteUrl: SITE, bridgeSecret: 'made-up-secret', cloudBackupFrequency: 'off' },
  )) as { ok: boolean };
  expect(r.ok).toBe(true);
}

/** Let the save's reschedule finish its first round (heartbeat, then the first poll). */
async function settled(): Promise<void> {
  await vi.waitFor(() => expect(bridgeMod.webOrdersBridge.status().lastPollAt).not.toBeNull());
}

function openShiftOn(deviceId: string) {
  return shifts.openShift(db as AppDatabase, { openingCashCents: 500_000 }, { userId: CASHIER_ID, deviceId });
}

function pauseAudits(): Row[] {
  return db
    .prepare(
      `SELECT actor_user_id, before_json, after_json FROM audit_log
        WHERE entity_type = 'settings' AND entity_id = ? ORDER BY rowid`,
    )
    .all(PAUSE_KEY) as Row[];
}

function auditRows(): AuditChainRow[] {
  return db
    .prepare(
      `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action,
              actor_user_id AS actorUserId, before_json AS beforeJson, after_json AS afterJson,
              ip, created_at AS createdAt, prev_hash AS prevHash, row_hash AS rowHash
         FROM audit_log ORDER BY rowid`,
    )
    .all() as unknown as AuditChainRow[];
}

live('the owner saves "Accept online orders" with the link: website orders follow the shift', () => {
  it('no shift open on this till: paused at once, the owner on the audit row, and the website never hears "accepting"', async () => {
    expect(beats()).toEqual([]); // a fresh till: nothing said yet
    await save(true);
    await settled();

    expect(cfgMod.getWebOrdersShiftPause(db as AppDatabase)).toMatchObject({ reason: 'shift_closed' });
    expect(pauseAudits()).toEqual([expect.objectContaining({ actor_user_id: OWNER_ID, before_json: null })]);
    expect(verifyAuditChain(auditRows()).ok).toBe(true);
    // The switch is saved on, as the owner asked; the pause is apart from it.
    expect(cfgMod.getWebBridgeConfig(db as AppDatabase).enabled).toBe(true);
    // The first and only word to the website: "not accepting", with the reason.
    expect(beats()).toEqual([expect.objectContaining({ acceptingOrders: false, deviceId: DEV, reason: 'shift_closed' })]);
    // The screens (PIN screen notice, keeping this computer awake) were told once.
    expect(watchEvents()).toBe(1);
    expect(bridgeMod.webOrdersBridge.closeImpact().takingOrders).toBe(false);
  });

  it('a second save while paused writes no second pause row', async () => {
    await save(true);
    await settled();
    await save(true);
    expect(pauseAudits()).toHaveLength(1);
    await vi.waitFor(() => expect(beats().length).toBe(2));
    expect(beats().every((b) => b.acceptingOrders === false)).toBe(true);
  });

  it('with a shift open on this till: not paused, the website hears "accepting"', async () => {
    openShiftOn(DEV);
    await save(true);
    await settled();
    expect(cfgMod.getWebOrdersShiftPause(db as AppDatabase)).toBeNull();
    expect(pauseAudits()).toEqual([]);
    expect(beats()[0]).toMatchObject({ acceptingOrders: true, deviceId: DEV });
    expect(bridgeMod.webOrdersBridge.closeImpact().takingOrders).toBe(true);
  });

  it("only another till's shift open: this till is paused", async () => {
    openShiftOn(OTHER_TILL);
    await save(true);
    expect(cfgMod.getWebOrdersShiftPause(db as AppDatabase)).toMatchObject({ reason: 'shift_closed' });
  });

  it('with the switch off: no pause is set', async () => {
    await save(false);
    expect(cfgMod.getWebOrdersShiftPause(db as AppDatabase)).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM settings WHERE key = ?`).get(PAUSE_KEY)).toEqual({ n: 0 });
    expect(pauseAudits()).toEqual([]);
  });

  it('the first open after the save lifts it as today: "accepting" again', async () => {
    await save(true);
    await settled();
    openShiftOn(DEV);
    const before = beats().length;
    pauseMod.followShiftForWebOrders(db as AppDatabase, DEV, 'opened', CASHIER_ID);
    await vi.waitFor(() => expect(beats().length).toBeGreaterThan(before));
    expect(beats().at(-1)).toMatchObject({ acceptingOrders: true });
    expect(beats().at(-1)).not.toHaveProperty('reason');
    expect(cfgMod.getWebOrdersShiftPause(db as AppDatabase)).toBeNull();
    expect(pauseAudits().map((a) => a.actor_user_id)).toEqual([OWNER_ID, CASHIER_ID]);
    expect(verifyAuditChain(auditRows()).ok).toBe(true);
  });

  it('a manager or cashier cannot save, and nothing is paused', async () => {
    for (const role of ['manager', 'cashier'] as const) {
      h.session = { ...OWNER_LOGIN, id: CASHIER_ID as UUID, role };
      let refused: unknown = null;
      try {
        await h.handlers.get('webBridge:setConfig')!(
          { db, deviceId: DEV },
          { enabled: true, siteUrl: SITE, bridgeSecret: 'made-up-secret' },
        );
      } catch (e) {
        refused = e;
      }
      expect(refused).toMatchObject({ apiError: { code: 'forbidden' } });
    }
    expect(cfgMod.getWebOrdersShiftPause(db as AppDatabase)).toBeNull();
    expect(pauseAudits()).toEqual([]);
  });
});
