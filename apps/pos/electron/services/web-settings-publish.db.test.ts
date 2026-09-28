/**
 * The website gets the owner's settings (Settings step 3: the delivery
 * areas and fees, the pick-up offer) in ONE stamped block (shared-types
 * web-bridge.ts, THE SETTINGS BLOCK):
 *   - nothing saved: the menu goes exactly as before, with no block;
 *   - once saved, the owner's Publish sends the block with the menu — every
 *     area in order, each one that is on naming its fee item IN THAT SAME
 *     MENU at its fee — and it passes the website's own schema and check;
 *   - a Save sends the block ALONE (PUT /api/bridge/settings) with only the
 *     fee items its areas charge: never the till's unpublished menu changes;
 *   - the bridge sends it when this till's stamp is NEWER than what the
 *     website last confirmed — a Save here or one synced from the other
 *     till (the sync worker's word) — and only then; a website holding a
 *     newer block is left alone;
 *   - an older website, a refusal, or a fee item hidden by an older till:
 *     nothing more by itself, the owner's Publish still sends the menu
 *     without the block, and Settings says why;
 *   - "Publish the menu by itself" (off by default) sends it 5 s after a change.
 *
 * A real database built from every migration (node:sqlite; skipped where it
 * is missing), the real repositories and the real bridge, with `fetch`
 * stubbed so every request is recorded and answered as the test says. The
 * site, secret, names and figures are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../db/connection.js';
import { DatabaseSync, openMigrated } from '../db/costing-shop.fixture.js';
import {
  DEFAULT_DELIVERY_ZONES,
  compareSettingsStamp,
  feeItemsProblem,
  settingsBlockProblem,
  type DeliveryZoneSetting,
  type PublishSettingsBody,
  type PublishedMenu,
  type PublishedSettings,
} from '@cheeseoclock/shared-types';
import { ROW_IMAGE_KEY, type SyncChange } from '@cheeseoclock/sync-core';
import { publishedSettingsSchema } from '@cheeseoclock/shared-schemas';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', getPath: () => '' },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('./print-spooler.js', () => ({ printSpooler: { onOrderEvent: () => {} } }));
vi.mock('./order-alerts-hub.js', () => ({
  orderAlerts: { orderReceived: () => {}, importFailed: () => {} },
}));
// The sync worker (its settings hook, Q3) loads these; nothing here opens a real link.
vi.mock('better-sqlite3', () => ({ default: class {} }));
vi.mock('../adapters/sync/factory.js', () => ({ makeSyncAdapter: () => ({}) }));

const live = describe.skipIf(!DatabaseSync);

const DEV = 'till-1';
const OWNER = { userId: 'u_owner', deviceId: DEV };
const SITE = 'https://shop.example.test';

type Db = ReturnType<typeof openMigrated>;
type Row = Record<string, unknown>;

interface Sent {
  method: string;
  path: string;
  body: Row | null;
}
let sent: Sent[] = [];
/** While set, menu PUTs wait on it (a publish still on its way). */
let menuGate: Promise<void> | null = null;
/** How the website answers a menu PUT (default: a website that takes the block). */
let answerMenu: (body: Row) => { status: number; json: unknown } = storedAnswer;
/** How the website answers the block alone, PUT /api/bridge/settings (default: it takes it by the same rule). */
let answerSettings: (body: Row) => { status: number; json: unknown } = storedAnswer;

/** A website that takes the block and holds it (what it held before is kept for a publish without one). */
let websiteHolds: PublishedSettings | null = null;
function storedAnswer(body: Row) {
  const settings = body['settings'] as PublishedSettings | undefined;
  // The website's rule (apps/web lib/publish-settings): newer or equal, or the same till's later Save.
  const takes =
    !!settings &&
    (!websiteHolds ||
      compareSettingsStamp(settings, websiteHolds) >= 0 ||
      (settings.deviceId === websiteHolds.deviceId &&
        Date.parse(settings.settingsAt) > Date.parse(websiteHolds.settingsAt)));
  if (settings && takes) websiteHolds = settings;
  return {
    status: 200,
    json: {
      ok: true,
      data: {
        categories: 1,
        items: 1,
        settings: settings ? (takes ? 'stored' : 'ignored_older') : websiteHolds ? 'kept' : 'none',
        ...heldFields(websiteHolds),
        settingsProblem: null,
        // A website of this version keeps the messages and "Pick-up only" (olderWebsiteAnswer drops the word).
        websiteMessages: true,
      },
    },
  };
}
/** A website older than v0.7.30: takes the block by the same rule, but says nothing of the messages (it dropped them). */
function olderWebsiteAnswer(body: Row) {
  const a = storedAnswer(body);
  const { websiteMessages: _dropped, ...data } = (a.json as { data: Row }).data;
  return { status: a.status, json: { ok: true, data } };
}
function heldFields(b: PublishedSettings | null) {
  return {
    settingsAt: b?.settingsAt ?? null,
    settingsRev: b?.settingsRev ?? null,
    settingsTie: b?.settingsTie ?? null,
    settingsDeviceId: b?.deviceId ?? null,
  };
}
/** How the website answers GET /api/bridge/status (default: an older website that says nothing about settings). */
let answerStatus: () => unknown = () => ({ ok: true, data: null });

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Row) : null;
      sent.push({ method, path: u.pathname, body });
      if ((u.pathname === '/api/bridge/menu' || u.pathname === '/api/bridge/settings') && method === 'PUT') {
        if (menuGate) await menuGate;
        const a = (u.pathname === '/api/bridge/menu' ? answerMenu : answerSettings)(body ?? {});
        return new Response(JSON.stringify(a.json), {
          status: a.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.pathname === '/api/bridge/status' && method === 'GET') {
        return new Response(JSON.stringify(answerStatus()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ ok: true, data: u.pathname === '/api/bridge/orders' ? [] : null }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }),
  );
}

/** Every menu the bridge has sent, oldest first. */
const menus = (): Array<PublishedMenu & { settings?: PublishedSettings }> =>
  sent
    .filter((s) => s.method === 'PUT' && s.path === '/api/bridge/menu')
    .map((s) => s.body as unknown as PublishedMenu & { settings?: PublishedSettings });

/** Every settings block the bridge has sent ALONE (PUT /api/bridge/settings), oldest first. */
const settingsPuts = (): PublishSettingsBody[] =>
  sent.filter((s) => s.method === 'PUT' && s.path === '/api/bridge/settings').map((s) => s.body as unknown as PublishSettingsBody);
/** The fee items of a block alone, as the menu the website checks it against. */
const asMenu = (b: PublishSettingsBody): Pick<PublishedMenu, 'categories'> => ({
  categories: [{ posCategoryId: 'fees', name: 'Delivery Charges', displayOrder: 0, items: b.feeItems.map((f) => f.item) }],
});

let cfgMod: typeof import('./web-bridge-config.js');
let bridgeMod: typeof import('./web-orders-bridge.js');
let zonesRepo: typeof import('../db/repositories/delivery-zones-repo.js');
let settingsRepo: typeof import('../db/repositories/business-settings-repo.js');
let menuRepo: typeof import('../db/repositories/menu-item-repo.js');
let items: { pizza: string; d200: string; d250: string };

beforeEach(async () => {
  if (!DatabaseSync) return;
  sent = [];
  answerMenu = storedAnswer;
  answerSettings = storedAnswer;
  websiteHolds = null;
  answerStatus = () => ({ ok: true, data: null });
  menuGate = null;
  stubFetch();
  vi.resetModules();
  cfgMod = await import('./web-bridge-config.js');
  bridgeMod = await import('./web-orders-bridge.js');
  zonesRepo = await import('../db/repositories/delivery-zones-repo.js');
  settingsRepo = await import('../db/repositories/business-settings-repo.js');
  menuRepo = await import('../db/repositories/menu-item-repo.js');
});

afterEach(() => {
  vi.useRealTimers();
  bridgeMod?.webOrdersBridge.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A till with the website linked ("Accept online orders" off: no polling loop), today's menu, the bridge started. */
async function till(opts: { linked?: boolean } = {}): Promise<Db> {
  const db = openMigrated();
  const T0 = '2026-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, 'Test Owner', 'x', 'admin', ?, ?, ?)`,
  ).run('u_owner', T0, T0, DEV);
  const d = db as AppDatabase;
  const { createTaxCategory } = await import('../db/repositories/tax-category-repo.js');
  const { createCategory } = await import('../db/repositories/category-repo.js');
  const tax = createTaxCategory(d, { name: 'Test GST', rateBps: 1_600 }, OWNER);
  const food = createCategory(
    d,
    { name: 'Test food', displayOrder: 1, colorHex: '#aa5500' },
    OWNER,
  );
  const fees = createCategory(
    d,
    { name: 'Delivery Charges', displayOrder: 2, colorHex: '#555555' },
    OWNER,
  );
  const item = (categoryId: string, name: string, cents: number) =>
    menuRepo.createMenuItem(
      d,
      { categoryId, name, basePriceCents: cents, taxCategoryId: tax.id },
      OWNER,
    ).id;
  items = {
    pizza: item(food.id, 'Test Pizza', 100_000),
    d200: item(fees.id, 'Delivery Charge (Rs 200)', 20_000),
    d250: item(fees.id, 'Delivery Charge (Rs 250)', 25_000),
  };
  cfgMod.setWebBridgeConfig(
    d,
    {
      enabled: false,
      siteUrl: opts.linked === false ? undefined : SITE,
      bridgeSecret: opts.linked === false ? undefined : 'made-up-secret',
      pollIntervalMs: 20_000,
      cloudBackupFrequency: 'off',
    },
    OWNER.userId,
  );
  bridgeMod.webOrdersBridge.init(d, DEV);
  return db;
}

const zones = (change: (z: DeliveryZoneSetting) => DeliveryZoneSetting = (z) => z) =>
  DEFAULT_DELIVERY_ZONES.zones.map((z) =>
    change({ ...z, aliases: [...z.aliases], hints: [...z.hints] }),
  );
const bridge = () => bridgeMod.webOrdersBridge;
const publishStatus = () => bridge().status().settingsPublish;

live('a Save sends the areas ALONE — never the till’s unpublished menu changes (owner’s Save ≠ Publish)', () => {
  it('the block goes with only the fee items its areas charge; a price changed on the till and not published stays off the website', async () => {
    const db = await till();
    // The website has the menu (the owner's Publish); the owner then changes a price and does not publish.
    await bridge().publishMenu();
    db.prepare(`UPDATE menu_items SET base_price_cents = 123400 WHERE id = ?`).run(items.pizza);
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones((z) => (z.id === 'dha-8' ? { ...z, feeCents: 30_000 } : z)) }, OWNER);
    await bridge().maybePublishSettings();
    // No menu went: only the owner's own Publish.
    expect(menus()).toHaveLength(1);
    expect(settingsPuts()).toHaveLength(1);
    const body = settingsPuts()[0]!;
    expect(JSON.stringify(body)).not.toMatch(/123400|Test Pizza/);
    expect(body.feeItems.map((f) => [f.item.name, f.item.basePriceCents, f.category.name])).toEqual([
      ['Delivery Charge (Rs 200)', 20_000, 'Delivery Charges'],
      ['Delivery Charge (Rs 250)', 25_000, 'Delivery Charges'],
      ['Delivery Charge (Rs 300)', 30_000, 'Delivery Charges'],
    ]);
    expect(settingsBlockProblem(body.settings, asMenu(body))).toBeNull();
    expect(feeItemsProblem(body.settings, body.feeItems)).toBeNull();
    expect(publishStatus()).toMatchObject({ state: 'published' });
  });

  it('a website older than the block alone (404): nothing more is sent by itself — never the menu — and Settings says the website needs its update', async () => {
    const db = await till();
    answerSettings = () => ({ status: 404, json: { ok: false, error: 'not_found' } });
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(1);
    expect(menus()).toHaveLength(0);
    expect(publishStatus()).toMatchObject({ state: 'unsupported', message: expect.stringMatching(/needs its update/) });
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(1);
    expect(menus()).toHaveLength(0);
  });

  it('a website with no menu yet (409): nothing more by itself; Settings says to press Publish', async () => {
    const db = await till();
    answerSettings = () => ({ status: 409, json: { ok: false, error: 'menu_not_published', message: 'The website has no menu yet.' } });
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    await bridge().maybePublishSettings();
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(1);
    expect(menus()).toHaveLength(0);
    expect(publishStatus()).toMatchObject({ state: 'refused', message: expect.stringMatching(/press Publish/) });
  });
});

live('the settings block of the menu publish', () => {
  it('nothing saved: the menu goes exactly as before — no block — and nothing is sent by itself', async () => {
    await till();
    await bridge().maybePublishSettings();
    expect([...menus(), ...settingsPuts()]).toHaveLength(0);
    await bridge().publishMenu();
    expect(menus()).toHaveLength(1);
    expect(menus()[0]).not.toHaveProperty('settings');
    expect(settingsPuts()).toHaveLength(0);
    expect(publishStatus()).toMatchObject({ state: 'none' });
  });

  it('after a Save the block goes: every area in order, each on one naming its item at its fee — it passes the website’s schema and check; the owner’s Publish sends it IN the menu', async () => {
    const db = await till();
    zonesRepo.saveDeliveryZones(
      db as AppDatabase,
      {
        zones: zones((z) =>
          z.id === 'dha-8'
            ? { ...z, feeCents: 30_000 }
            : z.id === 'emaar'
              ? { ...z, active: false }
              : z,
        ),
      },
      OWNER,
    );
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(1);
    const alone = settingsPuts()[0]!;
    const block = alone.settings;
    expect(publishedSettingsSchema.safeParse(block).success).toBe(true);
    expect(settingsBlockProblem(block, asMenu(alone))).toBeNull();
    expect(block.zones.map((z) => z.id)).toEqual(DEFAULT_DELIVERY_ZONES.zones.map((z) => z.id));
    expect(block.zones.find((z) => z.id === 'emaar')).toMatchObject({ active: false });
    const dha8 = block.zones.find((z) => z.id === 'dha-8')!;
    expect(alone.feeItems.find((f) => f.item.posItemId === dha8.feeItemId)?.item).toMatchObject({
      name: 'Delivery Charge (Rs 300)',
      basePriceCents: 30_000,
    });
    expect(block.pickup).toEqual({ offered: true, percent: 10 });
    expect(block.settingsRev).toBe(1);
    expect(publishStatus()).toMatchObject({ state: 'published', message: null });
    // Confirmed: nothing more goes until something newer.
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(1);
    expect(menus()).toHaveLength(0);
    // The owner's Publish: the same block inside the menu, checked against that menu.
    await bridge().publishMenu();
    const menu = menus()[0]!;
    expect(menu.settings).toEqual(block);
    expect(settingsBlockProblem(menu.settings!, menu)).toBeNull();
  });

  it('the bridge sends the block only when it is NEWER — a Save here, one synced from the other till, or the Save event', async () => {
    const db = await till();
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(1);
    // A Save of the pick-up offer here: newer.
    settingsRepo.setBusinessSetting(
      db as AppDatabase,
      'discounts.websitePickup',
      { v: 1, offered: true, percent: 15 },
      OWNER,
    );
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(2);
    expect(settingsPuts()[1]!.settings).toMatchObject({
      settingsRev: 2,
      pickup: { offered: true, percent: 15 },
    });
    // The other till's Save arrives through the link (its row image: a higher version, its own time).
    db.prepare(
      `UPDATE business_settings SET version = version + 1, updated_at = ?, value_json = ? WHERE key = 'discounts.websitePickup'`,
    ).run('2026-09-28T10:00:00.000Z', JSON.stringify({ v: 1, offered: false, percent: 15 }));
    // The word to the bridge (website-settings-events): published a moment later.
    const { websiteSettingsChanged } = await import('./website-settings-events.js');
    websiteSettingsChanged();
    await vi.waitFor(() => expect(settingsPuts()).toHaveLength(3), { timeout: 8_000 });
    expect(settingsPuts()[2]!.settings).toMatchObject({ settingsRev: 3, pickup: { offered: false } });
    // Nothing newer: nothing sent.
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(3);
    expect(menus()).toHaveLength(0);
  });

  it('the sync worker tells the bridge when a change pulled from the other till is a setting: the block goes alone a moment later', async () => {
    const db = await till();
    settingsRepo.setBusinessSetting(db as AppDatabase, 'discounts.websitePickup', { v: 1, offered: true, percent: 10 }, OWNER);
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(1);
    // The other till's Save of the pick-up offer, as the link pulls it (a newer version of the same row).
    const { businessSettingId } = await import('../db/repositories/business-settings-repo.js');
    const id = businessSettingId('discounts.websitePickup');
    const at = new Date(Date.now() + 60_000).toISOString();
    const change: SyncChange = {
      entityType: 'business_settings',
      entityId: id,
      op: 'upsert',
      payload: {
        [ROW_IMAGE_KEY]: 1,
        id,
        key: 'discounts.websitePickup',
        valueJson: JSON.stringify({ v: 1, offered: true, percent: 20 }),
        updatedByUserId: 'u_owner',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: at,
        deletedAt: null,
        deviceId: 'till-2',
        version: 2,
      },
      updatedAt: at,
      deviceId: 'till-2',
      version: 2,
    };
    const { SyncWorker } = await import('./sync-worker.js');
    const worker = new SyncWorker() as unknown as { applyPulled: (db: AppDatabase, changes: SyncChange[]) => Promise<void> };
    await worker.applyPulled(db as AppDatabase, [change]);
    await vi.waitFor(() => expect(settingsPuts()).toHaveLength(2), { timeout: 8_000 });
    expect(settingsPuts()[1]!.settings).toMatchObject({ settingsRev: 2, pickup: { percent: 20 } });
    // A pull with no setting in it says nothing to the bridge.
    await worker.applyPulled(db as AppDatabase, []);
    await new Promise((r) => setTimeout(r, 3_600));
    expect(settingsPuts()).toHaveLength(2);
  });

  it('the website holds a newer block (the other till’s): the till does not send its older one again', async () => {
    const db = await till();
    answerSettings = (body) => ({
      status: 200,
      json: {
        ok: true,
        data: {
          categories: 1,
          items: 1,
          settings: body['settings'] ? 'ignored_older' : 'kept',
          settingsAt: '2026-09-28T11:00:00.000Z',
          settingsRev: 9,
          settingsTie: 3_000,
          settingsDeviceId: 'till-2',
          settingsProblem: null,
        },
      },
    });
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(1);
    // Not "website updated": the website holds the other till's newer block, which the link brings here.
    expect(publishStatus()).toMatchObject({ state: 'waiting', message: expect.stringMatching(/other till/) });
    settingsRepo.setBusinessSetting(
      db as AppDatabase,
      'discounts.websitePickup',
      { v: 1, offered: true, percent: 12 },
      OWNER,
    );
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(1);
  });

  it('an older website publishing the menu (no word about settings): the menu is stored, Settings says the website needs its update, and the till does not loop', async () => {
    const db = await till();
    answerMenu = () => ({ status: 200, json: { ok: true, data: { categories: 1, items: 1 } } });
    answerSettings = () => ({ status: 404, json: { ok: false } });
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    await bridge().publishMenu();
    expect(menus()).toHaveLength(1);
    expect(publishStatus()).toMatchObject({
      state: 'unsupported',
      message: expect.stringMatching(/update/i),
    });
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(1);
    expect(settingsPuts()).toHaveLength(0);
  });

  it('the website refuses the block: nothing more by itself; the owner’s Publish sends the menu again without it, and Settings says why', async () => {
    const db = await till();
    const refusal = {
      status: 400,
      json: { ok: false, error: 'settings_invalid', message: 'DHA Phase 8: its delivery charge item is not on the menu' },
    };
    answerSettings = () => refusal;
    answerMenu = (body) => (body['settings'] ? refusal : storedAnswer(body));
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    // The till's own sending of its block: refused, nothing stored — and nothing more sent by itself.
    await bridge().maybePublishSettings();
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(1);
    expect(menus()).toHaveLength(0);
    expect(publishStatus()).toEqual({
      state: 'refused',
      at: null,
      message: 'DHA Phase 8: its delivery charge item is not on the menu',
    });
    // The owner's Publish: the menu with the block (refused), then the menu without it.
    await bridge().publishMenu();
    expect(menus()).toHaveLength(2);
    expect(menus()[0]).toHaveProperty('settings');
    expect(menus()[1]).not.toHaveProperty('settings');
    expect(publishStatus()).toMatchObject({
      state: 'refused',
      message: 'DHA Phase 8: its delivery charge item is not on the menu',
    });
  });

  it('a fee item an older till hid: the till checks first — nothing goes by itself, the owner’s Publish sends the menu without the block — saying which area', async () => {
    const db = await till();
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    db.prepare(`UPDATE menu_items SET is_active = 0 WHERE id = ?`).run(items.d250);
    await bridge().maybePublishSettings();
    expect([...menus(), ...settingsPuts()]).toHaveLength(0);
    expect(publishStatus()).toMatchObject({
      state: 'refused',
      message: expect.stringMatching(/DHA Phase 8|Emaar|Creek|Clifton/),
    });
    await bridge().publishMenu();
    expect(menus()).toHaveLength(1);
    expect(menus()[0]).not.toHaveProperty('settings');
  });

  it('a till without the website link sends nothing and says so; the other till publishes', async () => {
    const db = await till({ linked: false });
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    await bridge().maybePublishSettings();
    expect(sent).toHaveLength(0);
    expect(publishStatus()).toMatchObject({
      state: 'waiting',
      message: expect.stringMatching(/no website link/i),
    });
    // Only an updated till sends the areas: a 0.7.28 one never does (review of f55e3f0), so it says when.
    expect(publishStatus()?.message).toBe(
      'This till has no website link: the other till sends the areas once it has this update (each till’s Settings → About shows its version), or connect this one.',
    );
  });

  it('“Publish the menu by itself”: off (the default) nothing goes after a menu change — not even well past its 5 s wait; on, the menu goes 5 s after the last change', async () => {
    const db = await till();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    bridge().menuChanged();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(menus()).toHaveLength(0);
    settingsRepo.setBusinessSetting(
      db as AppDatabase,
      'online.options',
      {
        v: 2,
        autoPublishMenu: true,
        closedNotice: { text: '', until: null },
        announcement: { on: false, text: '' },
        minDeliveryOrderCents: 0,
      },
      OWNER,
    );
    bridge().menuChanged();
    await vi.advanceTimersByTimeAsync(3_000);
    // Another change restarts the wait.
    bridge().menuChanged();
    await vi.advanceTimersByTimeAsync(4_900);
    expect(menus()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    vi.useRealTimers();
    await vi.waitFor(() => expect(menus()).toHaveLength(1), { timeout: 5_000 });
    expect(settingsPuts()).toHaveLength(0);
  });

  it('the heartbeat is unchanged: pick-up’s % never rides it (both tills beat into one row)', async () => {
    const db = await till();
    settingsRepo.setBusinessSetting(
      db as AppDatabase,
      'discounts.websitePickup',
      { v: 1, offered: false, percent: 25 },
      OWNER,
    );
    const beats = sent.filter((s) => s.path === '/api/bridge/status' && s.method === 'PUT');
    for (const b of beats) expect(b.body).toMatchObject({ pickupDiscountPercent: 10 });
  });
});

/** Set a carried key's row as the till link would leave it (version, time, value). */
function syncedRow(db: Db, key: string, over: { version?: number; updatedAt?: string; value?: unknown }) {
  const row = db.prepare(`SELECT value_json, version FROM business_settings WHERE key = ?`).get(key) as
    | { value_json: string; version: number }
    | undefined;
  if (!row) throw new Error(`${key} is not saved`);
  db.prepare(`UPDATE business_settings SET version = ?, updated_at = COALESCE(?, updated_at), value_json = ? WHERE key = ?`).run(
    over.version ?? row.version,
    over.updatedAt ?? null,
    over.value === undefined ? row.value_json : JSON.stringify(over.value),
    key,
  );
}
const zonesValue = (db: Db) =>
  JSON.parse(
    String((db.prepare(`SELECT value_json FROM business_settings WHERE key = 'delivery.zones'`).get() as { value_json: string }).value_json),
  ) as { v: number; zones: DeliveryZoneSetting[] };

live('the settings block reaches the website, and stays right, when the tills and the website disagree', () => {
  it('two area lists saved offline at the same versions: the list the tills settle on goes to the website, although its version sum and newest time are the same', async () => {
    const db = await till();
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    settingsRepo.setBusinessSetting(db as AppDatabase, 'discounts.websitePickup', { v: 1, offered: true, percent: 10 }, OWNER);
    // This till: areas at 10:00, pick-up at 10:05 (both version 1).
    syncedRow(db, 'delivery.zones', { updatedAt: '2026-09-28T10:00:00.000Z' });
    syncedRow(db, 'discounts.websitePickup', { updatedAt: '2026-09-28T10:05:00.000Z' });
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(1);
    expect(settingsPuts()[0]!.settings).toMatchObject({ settingsRev: 2, settingsAt: '2026-09-28T10:05:00.000Z' });
    // The other till's areas, saved offline at 10:02 at the same version, win the link: Emaar off.
    const other = zonesValue(db);
    other.zones = other.zones.map((z) => (z.id === 'emaar' ? { ...z, active: false } : z));
    syncedRow(db, 'delivery.zones', { updatedAt: '2026-09-28T10:02:00.000Z', value: other });
    const { websiteSettingsChanged } = await import('./website-settings-events.js');
    websiteSettingsChanged();
    await vi.waitFor(() => expect(settingsPuts()).toHaveLength(2), { timeout: 8_000 });
    const sentNow = settingsPuts()[1]!.settings;
    expect(sentNow).toMatchObject({ settingsRev: 2, settingsAt: '2026-09-28T10:05:00.000Z' });
    expect(sentNow.zones.find((z) => z.id === 'emaar')).toMatchObject({ active: false });
    expect(websiteHolds?.zones.find((z) => z.id === 'emaar')).toMatchObject({ active: false });
    expect(publishStatus()).toMatchObject({ state: 'published' });
  });

  it('a till behind on the link publishes: the website keeps the other till’s newer block but says its menu lacks the fee item — this till sends the block and its fee items (not its menu) once the link catches it up', async () => {
    const db = await till();
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    // What the other till saved (Phase 8 at Rs 300, its new item): version 4 of the areas at 09:00.
    const aStamp = { settingsRev: 4, settingsAt: '2026-09-28T09:00:00.000Z', settingsTie: Date.parse('2026-09-28T09:00:00.000Z') };
    const problem = 'DHA Phase 8: its "Delivery Charge (Rs 300)" item is not on the menu (hidden or removed?)';
    answerMenu = (body) => ({
      status: 200,
      json: {
        ok: true,
        data: {
          categories: 1,
          items: 1,
          settings: body['settings'] ? 'ignored_older' : 'kept',
          ...aStamp,
          settingsDeviceId: 'till-2',
          settingsProblem: problem,
        },
      },
    });
    // A manager presses Publish here while the link is down: the website keeps the other till's areas, with THIS menu.
    await bridge().publishMenu();
    expect(menus()).toHaveLength(1);
    expect(publishStatus()).toMatchObject({ state: 'waiting', message: expect.stringMatching(/other till/) });
    // Behind: nothing by itself.
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(0);
    // The link comes back: the other till's Save arrives here (its item first, then the areas).
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones((z) => (z.id === 'dha-8' ? { ...z, feeCents: 30_000 } : z)) }, OWNER);
    syncedRow(db, 'delivery.zones', { version: 4, updatedAt: '2026-09-28T09:00:00.000Z' });
    // The website holds that same block and says its menu lacks the item: this till sends the item with the block.
    websiteHolds = settingsPuts()[0]?.settings ?? null;
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(1);
    expect(menus()).toHaveLength(1);
    const alone = settingsPuts()[0]!;
    expect(alone.settings).toMatchObject(aStamp);
    const dha8 = alone.settings.zones.find((z) => z.id === 'dha-8')!;
    expect(alone.feeItems.find((f) => f.item.posItemId === dha8.feeItemId)?.item).toMatchObject({ basePriceCents: 30_000 });
    expect(publishStatus()).toMatchObject({ state: 'published' });
  });

  it('a block that did not go is not sent again by itself: not after an unrelated setting syncs in, not after a restart — a new Save or the owner’s Publish sends it', async () => {
    const db = await till();
    answerSettings = () => ({ status: 400, json: { ok: false, error: 'settings_invalid', message: 'The till’s clock is ahead of the website’s.' } });
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(1);
    // The other till's kitchen timing arrives: the sync worker tells the bridge a setting changed.
    const { websiteSettingsChanged } = await import('./website-settings-events.js');
    websiteSettingsChanged();
    await new Promise((r) => setTimeout(r, 3_600));
    expect(settingsPuts()).toHaveLength(1);
    // A restart: still nothing by itself.
    bridge().stop();
    bridge().init(db as AppDatabase, DEV);
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(1);
    expect(menus()).toHaveLength(0);
    expect(publishStatus()).toMatchObject({ state: 'refused', message: expect.stringMatching(/clock/) });
    // A new Save: a new stamp, sent (and here taken).
    answerSettings = storedAnswer;
    settingsRepo.setBusinessSetting(db as AppDatabase, 'discounts.websitePickup', { v: 1, offered: true, percent: 12 }, OWNER);
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(2);
    expect(publishStatus()).toMatchObject({ state: 'published' });
  });

  it('a till restored from an older backup: the website’s newer block is its own — the status says so, and the owner’s next Save replaces it', async () => {
    const db = await till();
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    // Restored: the areas' row is back at version 1 from August; the website holds this till's version 5 from 1 September.
    syncedRow(db, 'delivery.zones', { updatedAt: '2026-08-01T00:00:00.000Z' });
    websiteHolds = {
      v: 1,
      pickup: { offered: true, percent: 10 },
      zones: [],
      settingsRev: 5,
      settingsAt: '2026-09-01T00:00:00.000Z',
      settingsTie: Date.parse('2026-09-01T00:00:00.000Z'),
      deviceId: DEV,
    } as PublishedSettings;
    answerStatus = () => ({ ok: true, data: { acceptingOrders: false, settings: { ...heldFields(websiteHolds), settingsProblem: null } } });
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(0);
    expect(publishStatus()).toMatchObject({ state: 'waiting', message: expect.stringMatching(/restored/) });
    // The owner saves the areas again, now.
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones((z) => (z.id === 'emaar' ? { ...z, active: false } : z)) }, OWNER);
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(1);
    expect(websiteHolds?.zones.find((z) => z.id === 'emaar')).toMatchObject({ active: false });
    expect(publishStatus()).toMatchObject({ state: 'published' });
  });

  it('a website that lost its block (a database rollback) gets it again at the till’s next start', async () => {
    const db = await till();
    answerStatus = () => ({ ok: true, data: { acceptingOrders: false, settings: websiteHolds ? { ...heldFields(websiteHolds), settingsProblem: null } : null } });
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(1);
    expect(publishStatus()).toMatchObject({ state: 'published' });
    websiteHolds = null;
    bridge().stop();
    bridge().init(db as AppDatabase, DEV);
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(2);
    expect(menus()).toHaveLength(0);
  });

  it('a Save while a sending is still on its way is sent when that one ends', async () => {
    const db = await till();
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    let release!: () => void;
    menuGate = new Promise<void>((r) => (release = r));
    const first = bridge().maybePublishSettings();
    await vi.waitFor(() => expect(settingsPuts()).toHaveLength(1));
    // The second Save's word arrives while the first is on its way.
    settingsRepo.setBusinessSetting(db as AppDatabase, 'discounts.websitePickup', { v: 1, offered: true, percent: 15 }, OWNER);
    await bridge().maybePublishSettings();
    menuGate = null;
    release();
    await first;
    await vi.waitFor(() => expect(settingsPuts()).toHaveLength(2), { timeout: 8_000 });
    expect(settingsPuts()[1]!.settings).toMatchObject({ pickup: { percent: 15 } });
    expect(publishStatus()).toMatchObject({ state: 'published' });
  });

  it('a carried setting saved by a newer version of the app: no block goes from this till (its defaults would replace the right one); Publish still sends the menu', async () => {
    const db = await till();
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    settingsRepo.setBusinessSetting(db as AppDatabase, 'discounts.websitePickup', { v: 1, offered: true, percent: 12 }, OWNER);
    // The other till, on a newer version, saved the pick-up offer in a newer format.
    syncedRow(db, 'discounts.websitePickup', { version: 2, value: { v: 9, offered: true, percent: 20, days: ['fri'] } });
    await bridge().maybePublishSettings();
    expect([...menus(), ...settingsPuts()]).toHaveLength(0);
    expect(publishStatus()).toMatchObject({ state: 'refused', message: expect.stringMatching(/newer version/) });
    await bridge().publishMenu();
    expect(menus()).toHaveLength(1);
    expect(menus()[0]).not.toHaveProperty('settings');
  });
});

// ---------------------------------------------------------------------------
// v0.7.30: the website's messages and smallest delivery order ('online.options'
// format 2) travel in the block (shared-types web-bridge.ts, WEBSITE MESSAGES).
// ---------------------------------------------------------------------------

const messages = {
  v: 2,
  autoPublishMenu: false,
  closedNotice: { text: 'Closed for a made-up holiday', until: '2026-10-03' },
  announcement: { on: true, text: 'New: a made-up pizza' },
  minDeliveryOrderCents: 100_000,
};
const noMessages = {
  closedNotice: { text: '', until: null },
  announcement: { on: false, text: '' },
  minDeliveryOrderCents: 0,
};

live('the website messages reach the website in the block, alone', () => {
  it('a Save of the messages alone changes the stamp and sends the block ALONE — never the menu — with the owner’s words and minimum; the owner’s Publish carries them too', async () => {
    const db = await till();
    await bridge().publishMenu();
    expect(menus()).toHaveLength(1);
    expect(menus()[0]).not.toHaveProperty('settings');
    db.prepare(`UPDATE menu_items SET base_price_cents = 123400 WHERE id = ?`).run(items.pizza);
    settingsRepo.setBusinessSetting(db as AppDatabase, 'online.options', messages, OWNER);
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(1);
    expect(settingsPuts()).toHaveLength(1);
    const alone = settingsPuts()[0]!;
    expect(JSON.stringify(alone)).not.toMatch(/123400|Test Pizza/);
    expect(alone.settings).toMatchObject({
      settingsRev: 1,
      closedNotice: messages.closedNotice,
      announcement: messages.announcement,
      minDeliveryOrderCents: 100_000,
    });
    // Today's areas and pick-up with it (nothing else saved), naming today's charge items.
    expect(alone.settings.zones.map((z) => z.id)).toEqual(DEFAULT_DELIVERY_ZONES.zones.map((z) => z.id));
    expect(alone.settings.pickup).toEqual({ offered: true, percent: 10 });
    expect(publishedSettingsSchema.safeParse(alone.settings).success).toBe(true);
    expect(settingsBlockProblem(alone.settings, asMenu(alone))).toBeNull();
    expect(publishStatus()).toMatchObject({ state: 'published' });
    // Nothing newer: nothing more.
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(1);
    // The owner's Publish: the same block inside the menu.
    await bridge().publishMenu();
    expect(menus()[1]!.settings).toEqual(alone.settings);
  });

  it('once any carried key is saved the block always carries all three messages, at their defaults too (sent at the default = cleared on the website)', async () => {
    const db = await till();
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    await bridge().maybePublishSettings();
    expect(settingsPuts()[0]!.settings).toMatchObject(noMessages);
    // Words saved, then cleared: the clearing goes too.
    settingsRepo.setBusinessSetting(db as AppDatabase, 'online.options', messages, OWNER);
    await bridge().maybePublishSettings();
    expect(settingsPuts()[1]!.settings).toMatchObject({ settingsRev: 2, announcement: { on: true } });
    settingsRepo.setBusinessSetting(db as AppDatabase, 'online.options', { ...messages, ...noMessages }, OWNER);
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(3);
    expect(settingsPuts()[2]!.settings).toMatchObject({ settingsRev: 3, ...noMessages });
  });

  it('a till upgraded from v0.7.29 with only “Publish by itself” saved (format 1): its block goes by itself, built from today’s defaults, and passes the fee check — the website as today', async () => {
    const db = await till();
    const { businessSettingId } = await import('../db/repositories/business-settings-repo.js');
    db.prepare(
      `INSERT INTO business_settings (id, key, value_json, updated_by_user_id, created_at, updated_at, device_id, version)
       VALUES (?, 'online.options', ?, 'u_owner', ?, ?, ?, 1)`,
    ).run(businessSettingId('online.options'), JSON.stringify({ v: 1, autoPublishMenu: true }), '2026-09-20T10:00:00.000Z', '2026-09-20T10:00:00.000Z', DEV);
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(0);
    expect(settingsPuts()).toHaveLength(1);
    const block = settingsPuts()[0]!.settings;
    expect(block).toMatchObject({ settingsRev: 1, settingsAt: '2026-09-20T10:00:00.000Z', pickup: { offered: true, percent: 10 }, ...noMessages });
    expect(block.zones.map((z) => [z.id, z.feeCents, z.active])).toEqual(
      DEFAULT_DELIVERY_ZONES.zones.map((z) => [z.id, z.feeCents, true]),
    );
    expect(settingsBlockProblem(block, asMenu(settingsPuts()[0]!))).toBeNull();
    expect(publishStatus()).toMatchObject({ state: 'published' });
  });

  it('the messages saved by a newer version of the app: no block goes from this till, and Settings says which (the website keeps what it has)', async () => {
    const db = await till();
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    settingsRepo.setBusinessSetting(db as AppDatabase, 'online.options', messages, OWNER);
    syncedRow(db, 'online.options', { version: 2, value: { ...messages, v: 3, openingHours: [] } });
    await bridge().maybePublishSettings();
    expect([...menus(), ...settingsPuts()]).toHaveLength(0);
    expect(publishStatus()).toMatchObject({ state: 'refused', message: expect.stringMatching(/website messages were saved by a newer version/) });
  });
});

live('a website older than the tills (its deploy failed or was rolled back): the till says so', () => {
  it('a Save of the messages: the older website stores the block but drops them — Settings says it needs its update, and the till sends it no more by itself', async () => {
    const db = await till();
    await bridge().publishMenu();
    answerSettings = olderWebsiteAnswer;
    settingsRepo.setBusinessSetting(db as AppDatabase, 'online.options', messages, OWNER);
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(1);
    expect(publishStatus()).toMatchObject({ state: 'unsupported', message: bridgeMod.OLDER_WEBSITE_DROPS });
    await bridge().maybePublishSettings();
    expect(settingsPuts()).toHaveLength(1);
    // The website updated: the owner's Publish sends them again, and the website says it keeps them.
    answerMenu = storedAnswer;
    const r = await bridge().publishMenu();
    expect(r).not.toHaveProperty('olderWebsite');
    expect(menus().at(-1)!.settings).toMatchObject({ announcement: messages.announcement });
    expect(publishStatus()).toMatchObject({ state: 'published' });
  });

  it('a Publish with an item "Pick-up only": the publish says the website is older (the toast), and so does Settings', async () => {
    const db = await till();
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    db.prepare(`UPDATE menu_items SET web_availability = 'pickup_only' WHERE id = ?`).run(items.pizza);
    answerMenu = olderWebsiteAnswer;
    const r = await bridge().publishMenu();
    expect(r.olderWebsite).toBe(true);
    expect(menus()[0]!.categories.flatMap((c) => c.items).find((i) => i.posItemId === items.pizza)?.pickupOnly).toBe(true);
    expect(publishStatus()).toMatchObject({ state: 'unsupported', message: bridgeMod.OLDER_WEBSITE_DROPS });
  });

  it('nothing only v0.7.30 keeps (every item on the website, the messages at their defaults): an older website loses nothing, and nothing is said', async () => {
    const db = await till();
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    settingsRepo.setBusinessSetting(db as AppDatabase, 'online.options', { ...messages, ...noMessages }, OWNER);
    answerMenu = olderWebsiteAnswer;
    answerSettings = olderWebsiteAnswer;
    const r = await bridge().publishMenu();
    expect(r).not.toHaveProperty('olderWebsite');
    expect(publishStatus()).toMatchObject({ state: 'published' });
  });

  it('what only v0.7.30 keeps: a notice with words, the announcement on, a minimum, an item "Pick-up only" — nothing else', () => {
    const { carriesWebsiteMessages } = bridgeMod;
    const none = { closedNotice: { text: '', until: null }, announcement: { on: false, text: 'Made-up, switched off' }, minDeliveryOrderCents: 0 };
    const menuWith = (pickupOnly?: boolean) => ({
      categories: [{ posCategoryId: 'c', name: 'Test', displayOrder: 0, items: [{ posItemId: 'i', name: 'Test', description: null, basePriceCents: 100, taxRateBps: 0, imageUrl: null, sortOrder: 0, modifierGroups: [], ...(pickupOnly === undefined ? {} : { pickupOnly }) }] }],
    });
    expect(carriesWebsiteMessages(null, null)).toBe(false);
    expect(carriesWebsiteMessages(none, menuWith())).toBe(false);
    expect(carriesWebsiteMessages({}, menuWith(false))).toBe(false);
    expect(carriesWebsiteMessages({ ...none, closedNotice: { text: 'Closed', until: null } }, null)).toBe(true);
    expect(carriesWebsiteMessages({ ...none, announcement: { on: true, text: 'New' } }, null)).toBe(true);
    expect(carriesWebsiteMessages({ ...none, minDeliveryOrderCents: 100 }, null)).toBe(true);
    expect(carriesWebsiteMessages(none, menuWith(true))).toBe(true);
  });
});
