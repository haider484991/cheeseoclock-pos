/**
 * What closing the till window would stop, and the goodbye to the website
 * (v0.7.33, till-close.ts):
 *   - closeImpact says the website takes orders through this till only with
 *     the link ready (its password readable here), the owner's switch on and
 *     no shift pause — the same rule as keeping the computer awake;
 *   - it counts only website orders still live on Live Orders: one
 *     delivered, cancelled, deleted, voided or paid here, or whose last push
 *     to the website was final, is left out;
 *   - it never throws;
 *   - sayTillClosing sends exactly one "not accepting" (no reason: the
 *     owner's switch-off words) and stops the poll, so no later heartbeat
 *     reopens the website — nor a kick (the nudge after the computer
 *     wakes) until a restart or a Save; nothing with no link or the switch
 *     off; a website that cannot be reached does not make it throw; the next
 *     start says "accepting" again.
 *
 * A real database built from every migration (node:sqlite behind
 * better-sqlite3's shape — see costing-shop.fixture.ts; skips where it is
 * missing) and the real bridge, with `fetch` stubbed so every request the
 * bridge makes is recorded instead of sent. The site address, secret and
 * names are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../db/connection.js';
import { DatabaseSync, openMigrated } from '../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', getPath: () => '' },
  BrowserWindow: { getAllWindows: () => [] },
  // No OS keychain in a test: secrets are stored as typed, and a sealed one cannot be opened.
  safeStorage: { isEncryptionAvailable: () => false },
}));
// Only the order import uses these, and no order is imported here.
vi.mock('./print-spooler.js', () => ({ printSpooler: { onOrderEvent: () => {} } }));
vi.mock('./order-alerts-hub.js', () => ({ orderAlerts: { orderReceived: () => {}, importFailed: () => {} } }));
vi.mock('../db/repositories/order-repo.js', () => ({}));
vi.mock('../db/repositories/customer-repo.js', () => ({}));

const live = describe.skipIf(!DatabaseSync);

const DEV = 'till-1';
const MANAGER = 'u_sara';
const SITE = 'https://shop.example.test';

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
      if (u.pathname === '/api/bridge/status' && method === 'PUT' && failStatusPushes) throw new TypeError('fetch failed');
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
const polls = (): number => sent.filter((s) => s.method === 'GET' && s.path === '/api/bridge/orders').length;

let cfgMod: typeof import('./web-bridge-config.js');
let bridgeMod: typeof import('./web-orders-bridge.js');
let settingsRepo: typeof import('../db/repositories/settings-repo.js');

beforeEach(async () => {
  if (!DatabaseSync) return;
  sent = [];
  failStatusPushes = false;
  stubFetch();
  // A fresh bridge singleton for every test (it keeps timers and state).
  vi.resetModules();
  cfgMod = await import('./web-bridge-config.js');
  bridgeMod = await import('./web-orders-bridge.js');
  settingsRepo = await import('../db/repositories/settings-repo.js');
});

afterEach(() => {
  bridgeMod?.webOrdersBridge.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function seedUsers(db: Db): void {
  const T0 = '2026-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  ).run(MANAGER, 'Sara', 'manager', T0, T0, DEV);
}

/** A till; with `enabled` set, the website is connected and "Accept online orders" is as given, the bridge running. */
async function till(opts: { enabled?: boolean } = {}): Promise<Db> {
  const db = openMigrated();
  seedUsers(db);
  if (opts.enabled !== undefined) {
    cfgMod.setWebBridgeConfig(
      db as AppDatabase,
      { enabled: opts.enabled, siteUrl: SITE, bridgeSecret: 'made-up-secret', pollIntervalMs: 20_000, cloudBackupFrequency: 'off' },
      MANAGER,
    );
  }
  bridgeMod.webOrdersBridge.init(db as AppDatabase, DEV);
  // Let the start-up push (and, when on, the first poll) finish.
  if (opts.enabled === true) {
    await vi.waitFor(() => expect(bridgeMod.webOrdersBridge.status().lastPollAt).not.toBeNull());
  } else if (opts.enabled === false) {
    await vi.waitFor(() => expect(beats().length).toBe(1));
  }
  return db;
}

const NOW = '2026-10-01T18:00:00.000Z';

/** A website order on this till: the POS order in `status`, and its row in web_order_imports. */
function webOrder(
  db: Db,
  n: number,
  o: { status: string; deleted?: boolean; lastPushed?: string | null; importStatus?: 'imported' | 'failed'; noOrder?: boolean },
): void {
  const orderId = `order-${n}`;
  if (!o.noOrder) {
    db.prepare(
      `INSERT INTO orders (id, order_number, mode, status, cashier_id, source, created_at, updated_at, deleted_at, device_id)
       VALUES (?, ?, 'delivery', ?, ?, 'web', ?, ?, ?, ?)`,
    ).run(orderId, String(100 + n), o.status, MANAGER, NOW, NOW, o.deleted ? NOW : null, DEV);
  }
  db.prepare(
    `INSERT INTO web_order_imports (web_order_id, pos_order_id, status, last_pushed_status, imported_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(`web-${n}`, o.importStatus === 'failed' ? null : orderId, o.importStatus ?? 'imported', o.lastPushed ?? null, NOW, NOW, NOW);
}

live('closeImpact: is the website taking orders through this till, and what is on Live Orders', () => {
  it('no website link: nothing to lose', async () => {
    await till();
    expect(bridgeMod.webOrdersBridge.closeImpact()).toEqual({ takingOrders: false, openWebOrders: 0 });
  });

  it('the link set, the owner switch on, no shift pause: taking orders', async () => {
    await till({ enabled: true });
    expect(bridgeMod.webOrdersBridge.closeImpact()).toEqual({ takingOrders: true, openWebOrders: 0 });
  });

  it('a shift pause (no shift open on this till): not taking orders', async () => {
    const db = await till({ enabled: true });
    cfgMod.setWebOrdersShiftPause(db as AppDatabase, { reason: 'shift_closed', since: NOW }, MANAGER);
    expect(bridgeMod.webOrdersBridge.closeImpact()).toEqual({ takingOrders: false, openWebOrders: 0 });
  });

  it('the owner switched online orders off: not taking orders', async () => {
    await till({ enabled: false });
    expect(bridgeMod.webOrdersBridge.closeImpact()).toEqual({ takingOrders: false, openWebOrders: 0 });
  });

  it("a password sealed on another PC (it cannot be read here): not taking orders", async () => {
    const db = openMigrated();
    seedUsers(db);
    settingsRepo.setSetting(db as AppDatabase, cfgMod.WEB_BRIDGE_CONFIG_KEY, {
      enabled: true,
      siteUrl: SITE,
      bridgeSecret: 'enc1:c2VhbGVkIG9uIGFub3RoZXIgUEM=',
      pollIntervalMs: 20_000,
      cloudBackupFrequency: 'off',
    });
    bridgeMod.webOrdersBridge.init(db as AppDatabase, DEV);
    expect(cfgMod.getWebBridgeConfig(db as AppDatabase).secretUnreadable).toBe(true);
    expect(bridgeMod.webOrdersBridge.closeImpact()).toEqual({ takingOrders: false, openWebOrders: 0 });
  });

  it('counts only website orders still live on Live Orders', async () => {
    const db = await till({ enabled: true });
    // Counted: on the board, the customer not yet told delivered or cancelled.
    webOrder(db, 1, { status: 'sent_to_kitchen' });
    webOrder(db, 2, { status: 'preparing', lastPushed: 'preparing' });
    webOrder(db, 3, { status: 'ready', lastPushed: 'ready' });
    webOrder(db, 4, { status: 'out_for_delivery', lastPushed: 'ready' });
    // Left out: done or gone here, though the push to the website got stuck…
    webOrder(db, 5, { status: 'delivered', lastPushed: 'out_for_delivery' });
    webOrder(db, 6, { status: 'void', lastPushed: 'preparing' });
    webOrder(db, 7, { status: 'paid', lastPushed: 'ready' });
    webOrder(db, 8, { status: 'sent_to_kitchen', deleted: true });
    // …the website already told it is over…
    webOrder(db, 9, { status: 'preparing', lastPushed: 'cancelled' });
    webOrder(db, 10, { status: 'out_for_delivery', lastPushed: 'delivered' });
    // …never imported, or its order is not on this till.
    webOrder(db, 11, { status: 'sent_to_kitchen', importStatus: 'failed' });
    webOrder(db, 12, { status: 'sent_to_kitchen', noOrder: true });
    expect(bridgeMod.webOrdersBridge.closeImpact()).toEqual({ takingOrders: true, openWebOrders: 4 });
  });

  it('never throws: a database that fails says nothing to lose; a count that fails still says taking orders', async () => {
    const db = await till({ enabled: true });
    webOrder(db, 1, { status: 'preparing' });
    db.exec('DROP TABLE web_order_imports');
    expect(bridgeMod.webOrdersBridge.closeImpact()).toEqual({ takingOrders: true, openWebOrders: 0 });

    const inside = bridgeMod.webOrdersBridge as unknown as { db: unknown };
    inside.db = {
      prepare: () => {
        throw new Error('The database connection is not open');
      },
    };
    expect(bridgeMod.webOrdersBridge.closeImpact()).toEqual({ takingOrders: false, openWebOrders: 0 });
    inside.db = db;
  });
});

live('sayTillClosing: the website hears "not accepting" before the till closes', () => {
  it('exactly one push, acceptingOrders false with no reason (the owner switch-off words)', async () => {
    await till({ enabled: true });
    expect(beats().at(-1)).toMatchObject({ acceptingOrders: true });
    const before = beats().length;

    await bridgeMod.webOrdersBridge.sayTillClosing();

    expect(beats().slice(before)).toEqual([
      { acceptingOrders: false, deviceId: DEV, features: ['pickup'], pickupDiscountPercent: expect.any(Number) },
    ]);
    expect(beats().at(-1)).not.toHaveProperty('reason');
  });

  it('nothing with no website link, or with online orders switched off (the website is closed already)', async () => {
    await till();
    await bridgeMod.webOrdersBridge.sayTillClosing();
    expect(beats()).toEqual([]);

    await till({ enabled: false });
    const before = beats().length;
    await bridgeMod.webOrdersBridge.sayTillClosing();
    expect(beats()).toHaveLength(before);
  });

  it('a website that cannot be reached does not make it throw', async () => {
    await till({ enabled: true });
    failStatusPushes = true;
    const before = beats().length;
    await expect(bridgeMod.webOrdersBridge.sayTillClosing()).resolves.toBeUndefined();
    // It was tried once.
    expect(beats()).toHaveLength(before + 1);
  });

  it('the poll stops: no heartbeat and no look for orders follows, and the next start says accepting again', async () => {
    vi.useFakeTimers();
    const db = await till({ enabled: true });
    // While it runs, the poll looks for orders and beats once a minute…
    let before = beats().length;
    const pollsBefore = polls();
    await vi.advanceTimersByTimeAsync(70_000);
    expect(beats().length).toBeGreaterThan(before);
    expect(polls()).toBeGreaterThan(pollsBefore);

    // …and after the goodbye, nothing more.
    await bridgeMod.webOrdersBridge.sayTillClosing();
    expect(beats().at(-1)).toMatchObject({ acceptingOrders: false });
    before = beats().length;
    const pollsAfter = polls();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(beats()).toHaveLength(before);
    expect(polls()).toBe(pollsAfter);

    // A restart (init) tells the website it is open again.
    vi.useRealTimers();
    bridgeMod.webOrdersBridge.init(db as AppDatabase, DEV);
    await vi.waitFor(() => expect(beats().length).toBeGreaterThan(before));
    expect(beats()[before]).toMatchObject({ acceptingOrders: true, deviceId: DEV });
  });

  it('a kick after the goodbye (the nudge after the computer wakes) asks the website nothing; a Save runs the poll again', async () => {
    await till({ enabled: true });
    await bridgeMod.webOrdersBridge.sayTillClosing();
    expect(beats().at(-1)).toMatchObject({ acceptingOrders: false });
    // Asleep for longer than a heartbeat: a poll now would say "accepting" first.
    (bridgeMod.webOrdersBridge as unknown as { lastHeartbeatAt: number }).lastHeartbeatAt = 0;
    const before = sent.length;
    const pollsBefore = polls();

    bridgeMod.webOrdersBridge.kick();
    // Long enough for a poll the kick started to reach the website.
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toHaveLength(before);
    expect(beats().at(-1)).toMatchObject({ acceptingOrders: false });

    // Settings saved (reschedule): the poll runs again.
    bridgeMod.webOrdersBridge.reschedule();
    await vi.waitFor(() => expect(polls()).toBeGreaterThan(pollsBefore));
    await vi.waitFor(() => expect(beats().at(-1)).toMatchObject({ acceptingOrders: true }));
  });
});
