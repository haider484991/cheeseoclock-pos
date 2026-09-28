/**
 * The website gets the owner's settings (Settings step 3: the delivery
 * areas and fees, the pick-up offer) in ONE stamped block inside the menu
 * publish (shared-types web-bridge.ts, THE SETTINGS BLOCK):
 *   - nothing saved: the menu goes exactly as before, with no block;
 *   - once saved, the block goes with the menu — every area in order, each
 *     one that is on naming its fee item IN THAT SAME MENU at its fee — and
 *     it passes the website's own schema and check;
 *   - the bridge publishes when this till's stamp is NEWER than what the
 *     website last confirmed — a Save here or one synced from the other
 *     till — and only then; a website holding a newer block is left alone;
 *   - an older website, a refusal, or a fee item hidden by an older till:
 *     the menu still goes, without the block, and Settings says why;
 *   - "Publish the menu by itself" (off by default) sends it after a change.
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
  settingsBlockProblem,
  type DeliveryZoneSetting,
  type PublishedMenu,
  type PublishedSettings,
} from '@cheeseoclock/shared-types';
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
      },
    },
  };
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
      if (u.pathname === '/api/bridge/menu' && method === 'PUT') {
        if (menuGate) await menuGate;
        const a = answerMenu(body ?? {});
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

live('the settings block of the menu publish', () => {
  it('nothing saved: the menu goes exactly as before — no block — and nothing is sent by itself', async () => {
    await till();
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(0);
    await bridge().publishMenu();
    expect(menus()).toHaveLength(1);
    expect(menus()[0]).not.toHaveProperty('settings');
    expect(publishStatus()).toMatchObject({ state: 'none' });
  });

  it('after a Save the block goes with the menu: every area in order, each on one naming its item in the SAME menu at its fee — it passes the website’s schema and check', async () => {
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
    expect(menus()).toHaveLength(1);
    const menu = menus()[0]!;
    const block = menu.settings!;
    expect(publishedSettingsSchema.safeParse(block).success).toBe(true);
    expect(settingsBlockProblem(block, menu)).toBeNull();
    expect(block.zones.map((z) => z.id)).toEqual(DEFAULT_DELIVERY_ZONES.zones.map((z) => z.id));
    expect(block.zones.find((z) => z.id === 'emaar')).toMatchObject({ active: false });
    const dha8 = block.zones.find((z) => z.id === 'dha-8')!;
    const inMenu = menu.categories
      .flatMap((c) => c.items)
      .find((i) => i.posItemId === dha8.feeItemId);
    expect(inMenu).toMatchObject({ name: 'Delivery Charge (Rs 300)', basePriceCents: 30_000 });
    expect(block.pickup).toEqual({ offered: true, percent: 10 });
    expect(block.settingsRev).toBe(1);
    expect(publishStatus()).toMatchObject({ state: 'published', message: null });
    // Confirmed: nothing more goes until something newer.
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(1);
  });

  it('the bridge sends the block only when it is NEWER — a Save here, one synced from the other till, or the Save event', async () => {
    const db = await till();
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(1);
    // A Save of the pick-up offer here: newer.
    settingsRepo.setBusinessSetting(
      db as AppDatabase,
      'discounts.websitePickup',
      { v: 1, offered: true, percent: 15 },
      OWNER,
    );
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(2);
    expect(menus()[1]!.settings).toMatchObject({
      settingsRev: 2,
      pickup: { offered: true, percent: 15 },
    });
    // The other till's Save arrives through the link (its row image: a higher version, its own time).
    db.prepare(
      `UPDATE business_settings SET version = version + 1, updated_at = ?, value_json = ? WHERE key = 'discounts.websitePickup'`,
    ).run('2026-09-28T10:00:00.000Z', JSON.stringify({ v: 1, offered: false, percent: 15 }));
    // The sync worker's word to the bridge (website-settings-events): published a moment later.
    const { websiteSettingsChanged } = await import('./website-settings-events.js');
    websiteSettingsChanged();
    await vi.waitFor(() => expect(menus()).toHaveLength(3), { timeout: 8_000 });
    expect(menus()[2]!.settings).toMatchObject({ settingsRev: 3, pickup: { offered: false } });
    // Nothing newer: nothing sent.
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(3);
  });

  it('the website holds a newer block (the other till’s): the till does not send its older one again', async () => {
    const db = await till();
    answerMenu = (body) => ({
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
    expect(menus()).toHaveLength(1);
    // Not "website updated": the website holds the other till's newer block, which the link brings here.
    expect(publishStatus()).toMatchObject({ state: 'waiting', message: expect.stringMatching(/other till/) });
    settingsRepo.setBusinessSetting(
      db as AppDatabase,
      'discounts.websitePickup',
      { v: 1, offered: true, percent: 12 },
      OWNER,
    );
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(1);
  });

  it('an older website (no word about settings): the menu is stored, Settings says the website needs its update, and the till does not loop', async () => {
    const db = await till();
    answerMenu = () => ({ status: 200, json: { ok: true, data: { categories: 1, items: 1 } } });
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(1);
    expect(publishStatus()).toMatchObject({
      state: 'unsupported',
      message: expect.stringMatching(/update/i),
    });
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(1);
  });

  it('the website refuses the block: the menu goes again without it, and Settings says why', async () => {
    const db = await till();
    answerMenu = (body) =>
      body['settings']
        ? {
            status: 400,
            json: {
              ok: false,
              error: 'settings_invalid',
              message: 'DHA Phase 8: its delivery charge item is not on the menu',
            },
          }
        : storedAnswer(body);
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    // The till's own publish of its block: refused, nothing stored — and nothing more sent by itself
    // (the menu alone is the owner's to publish: "Publish the menu by itself" is off).
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(1);
    expect(menus()[0]).toHaveProperty('settings');
    expect(publishStatus()).toEqual({
      state: 'refused',
      at: null,
      message: 'DHA Phase 8: its delivery charge item is not on the menu',
    });
    // The owner's Publish: the menu goes again without the block.
    await bridge().publishMenu();
    expect(menus()).toHaveLength(3);
    expect(menus()[1]).toHaveProperty('settings');
    expect(menus()[2]).not.toHaveProperty('settings');
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
    expect(menus()).toHaveLength(0);
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
  });

  it('“Publish the menu by itself”: off (the default) nothing goes after a menu change; on, the menu goes a moment later', async () => {
    const db = await till();
    bridge().menuChanged();
    await new Promise((r) => setTimeout(r, 200));
    expect(menus()).toHaveLength(0);
    settingsRepo.setBusinessSetting(
      db as AppDatabase,
      'online.options',
      { v: 1, autoPublishMenu: true },
      OWNER,
    );
    bridge().menuChanged();
    await vi.waitFor(() => expect(menus()).toHaveLength(1), { timeout: 10_000 });
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
    expect(menus()).toHaveLength(1);
    expect(menus()[0]!.settings).toMatchObject({ settingsRev: 2, settingsAt: '2026-09-28T10:05:00.000Z' });
    // The other till's areas, saved offline at 10:02 at the same version, win the link: Emaar off.
    const other = zonesValue(db);
    other.zones = other.zones.map((z) => (z.id === 'emaar' ? { ...z, active: false } : z));
    syncedRow(db, 'delivery.zones', { updatedAt: '2026-09-28T10:02:00.000Z', value: other });
    const { websiteSettingsChanged } = await import('./website-settings-events.js');
    websiteSettingsChanged();
    await vi.waitFor(() => expect(menus()).toHaveLength(2), { timeout: 8_000 });
    const sentNow = menus()[1]!.settings!;
    expect(sentNow).toMatchObject({ settingsRev: 2, settingsAt: '2026-09-28T10:05:00.000Z' });
    expect(sentNow.zones.find((z) => z.id === 'emaar')).toMatchObject({ active: false });
    expect(websiteHolds?.zones.find((z) => z.id === 'emaar')).toMatchObject({ active: false });
    expect(publishStatus()).toMatchObject({ state: 'published' });
  });

  it('a till behind on the link publishes: the website keeps the other till’s newer block but says its menu lacks the fee item — this till sends its menu again once the link catches it up', async () => {
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
    expect(menus()).toHaveLength(1);
    // The link comes back: the other till's Save arrives here (its item first, then the areas).
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones((z) => (z.id === 'dha-8' ? { ...z, feeCents: 30_000 } : z)) }, OWNER);
    syncedRow(db, 'delivery.zones', { version: 4, updatedAt: '2026-09-28T09:00:00.000Z' });
    answerMenu = storedAnswer;
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(2);
    const menu = menus()[1]!;
    expect(menu.settings).toMatchObject(aStamp);
    const dha8 = menu.settings!.zones.find((z) => z.id === 'dha-8')!;
    expect(menu.categories.flatMap((c) => c.items).find((i) => i.posItemId === dha8.feeItemId)).toMatchObject({
      basePriceCents: 30_000,
    });
    expect(publishStatus()).toMatchObject({ state: 'published' });
  });

  it('a block that did not go is not sent again by itself: not after an unrelated setting syncs in, not after a restart — a new Save or the owner’s Publish sends it', async () => {
    const db = await till();
    answerMenu = (body) =>
      body['settings']
        ? { status: 400, json: { ok: false, error: 'settings_invalid', message: 'The till’s clock is ahead of the website’s.' } }
        : storedAnswer(body);
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(1);
    // The other till's kitchen timing arrives: the sync worker tells the bridge a setting changed.
    const { websiteSettingsChanged } = await import('./website-settings-events.js');
    websiteSettingsChanged();
    await new Promise((r) => setTimeout(r, 3_600));
    expect(menus()).toHaveLength(1);
    // A restart: still nothing by itself (the unpublished menu changes stay on the till).
    bridge().stop();
    bridge().init(db as AppDatabase, DEV);
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(1);
    expect(publishStatus()).toMatchObject({ state: 'refused', message: expect.stringMatching(/clock/) });
    // A new Save: a new stamp, sent (and here taken).
    answerMenu = storedAnswer;
    settingsRepo.setBusinessSetting(db as AppDatabase, 'discounts.websitePickup', { v: 1, offered: true, percent: 12 }, OWNER);
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(2);
    expect(publishStatus()).toMatchObject({ state: 'published' });
  });

  it('a till restored from an older backup: the website’s newer block is its own — the status says so, and the owner’s next Save replaces it', async () => {
    const db = await till();
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    // Restored: the areas' row is back at version 1 from August; the website holds this till's version 5 from 1 September.
    syncedRow(db, 'delivery.zones', { updatedAt: '2026-08-01T00:00:00.000Z' });
    websiteHolds = {
      ...(menus()[0]?.settings ?? {
        v: 1,
        pickup: { offered: true, percent: 10 },
        zones: [],
      }),
      settingsRev: 5,
      settingsAt: '2026-09-01T00:00:00.000Z',
      settingsTie: Date.parse('2026-09-01T00:00:00.000Z'),
      deviceId: DEV,
    } as PublishedSettings;
    answerStatus = () => ({ ok: true, data: { acceptingOrders: false, settings: { ...heldFields(websiteHolds), settingsProblem: null } } });
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(0);
    expect(publishStatus()).toMatchObject({ state: 'waiting', message: expect.stringMatching(/restored/) });
    // The owner saves the areas again, now.
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones((z) => (z.id === 'emaar' ? { ...z, active: false } : z)) }, OWNER);
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(1);
    expect(websiteHolds?.zones.find((z) => z.id === 'emaar')).toMatchObject({ active: false });
    expect(publishStatus()).toMatchObject({ state: 'published' });
  });

  it('a website that lost its block (a database rollback) gets it again at the till’s next start', async () => {
    const db = await till();
    answerStatus = () => ({ ok: true, data: { acceptingOrders: false, settings: websiteHolds ? { ...heldFields(websiteHolds), settingsProblem: null } : null } });
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(1);
    expect(publishStatus()).toMatchObject({ state: 'published' });
    websiteHolds = null;
    bridge().stop();
    bridge().init(db as AppDatabase, DEV);
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(2);
    expect(menus()[1]).toHaveProperty('settings');
  });

  it('a Save while a publish is still on its way is sent when that one ends', async () => {
    const db = await till();
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    let release!: () => void;
    menuGate = new Promise<void>((r) => (release = r));
    const first = bridge().maybePublishSettings();
    await vi.waitFor(() => expect(menus()).toHaveLength(1));
    // The second Save's word arrives while the first is on its way (big photos).
    settingsRepo.setBusinessSetting(db as AppDatabase, 'discounts.websitePickup', { v: 1, offered: true, percent: 15 }, OWNER);
    await bridge().maybePublishSettings();
    menuGate = null;
    release();
    await first;
    await vi.waitFor(() => expect(menus()).toHaveLength(2), { timeout: 8_000 });
    expect(menus()[1]!.settings).toMatchObject({ pickup: { percent: 15 } });
    expect(publishStatus()).toMatchObject({ state: 'published' });
  });

  it('a carried setting saved by a newer version of the app: no block goes from this till (its defaults would replace the right one); Publish still sends the menu', async () => {
    const db = await till();
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    settingsRepo.setBusinessSetting(db as AppDatabase, 'discounts.websitePickup', { v: 1, offered: true, percent: 12 }, OWNER);
    // The other till, on a newer version, saved the pick-up offer in a newer format.
    syncedRow(db, 'discounts.websitePickup', { version: 2, value: { v: 9, offered: true, percent: 20, days: ['fri'] } });
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(0);
    expect(publishStatus()).toMatchObject({ state: 'refused', message: expect.stringMatching(/newer version/) });
    await bridge().publishMenu();
    expect(menus()).toHaveLength(1);
    expect(menus()[0]).not.toHaveProperty('settings');
  });
});
