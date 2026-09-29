/**
 * The website gets the shop's details, opening hours, website words and home
 * lineup (sweep B2 + B4) in their OWN stamped block (shared-types
 * web-bridge.ts, THE SHOP BLOCK):
 *   - nothing saved: the menu publish is exactly as before — no `shop` key —
 *     and nothing is sent by itself;
 *   - a Save of one of the four keys sends the shop block ALONE (PUT
 *     /api/bridge/shop): never the menu, never the settings block — and
 *     only when the website needs it (a newer stamp);
 *   - once saved, every menu publish carries it next to the settings block,
 *     each by its own rule: a fee-item problem never holds the shop block
 *     back, and a refused shop block never holds the menu or the settings
 *     block back;
 *   - a key saved by a newer app version, an older website, a refusal:
 *     nothing more by itself, and Settings says why;
 *   - the website's homeMissing reaches the publish summary and the status.
 *
 * A real database built from every migration (node:sqlite; skipped where it
 * is missing), the real repositories and the real bridge, with `fetch`
 * stubbed as a website that follows the contract's store rule. The site,
 * secret, names, numbers and figures are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../db/connection.js';
import { DatabaseSync, openMigrated } from '../db/costing-shop.fixture.js';
import {
  DEFAULT_DELIVERY_ZONES,
  DEFAULT_SHOP_HOURS,
  DEFAULT_SHOP_PROFILE,
  DEFAULT_SHOP_WEBSITE,
  DEFAULT_WEBSITE_HOME,
  compareSettingsStamp,
  homeMissing,
  shopBlockTakes,
  type DeliveryZoneSetting,
  type PublishShopBody,
  type PublishedMenu,
  type PublishedSettings,
  type PublishedShop,
} from '@cheeseoclock/shared-types';
import { ROW_IMAGE_KEY, type SyncChange } from '@cheeseoclock/sync-core';
import { publishedShopSchema } from '@cheeseoclock/shared-schemas';

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
// The sync worker (its settings hook) loads these; nothing here opens a real link.
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

/** What the (made-up) website holds. */
let websiteSettings: PublishedSettings | null = null;
let websiteShop: PublishedShop | null = null;
let websiteMenu: Pick<PublishedMenu, 'categories'> = { categories: [] };

/** The shop fields a website with the shop block answers, from what it holds now. */
function shopFields() {
  return {
    shopRev: websiteShop?.shopRev ?? null,
    shopAt: websiteShop?.shopAt ?? null,
    shopTie: websiteShop?.shopTie ?? null,
    shopDeviceId: websiteShop?.deviceId ?? null,
    homeMissing: homeMissing(websiteShop?.home ?? DEFAULT_WEBSITE_HOME, websiteMenu),
  };
}

/** The shop block through the website's own check: its refusal, or null. */
function shopRefusal(shop: unknown): { status: number; json: unknown } | null {
  const r = publishedShopSchema.safeParse(shop);
  return r.success ? null : { status: 400, json: { ok: false, error: 'shop_invalid', message: r.error.issues[0]?.message ?? 'bad' } };
}

/** A website with the shop block (the contract's rule for both blocks, each apart). */
function newWebsiteMenu(body: Row): { status: number; json: unknown } {
  const shop = body['shop'] as PublishedShop | undefined;
  if (shop !== undefined) {
    const refused = shopRefusal(shop);
    if (refused) return refused;
  }
  const settings = body['settings'] as PublishedSettings | undefined;
  const takesSettings =
    !!settings &&
    (!websiteSettings ||
      compareSettingsStamp(settings, websiteSettings) >= 0 ||
      (settings.deviceId === websiteSettings.deviceId && Date.parse(settings.settingsAt) > Date.parse(websiteSettings.settingsAt)));
  if (settings && takesSettings) websiteSettings = settings;
  const takesShop = !!shop && shopBlockTakes(shop, websiteShop);
  if (shop && takesShop) websiteShop = shop;
  websiteMenu = { categories: body['categories'] as PublishedMenu['categories'] };
  return {
    status: 200,
    json: {
      ok: true,
      data: {
        categories: 1,
        items: 1,
        settings: settings ? (takesSettings ? 'stored' : 'ignored_older') : websiteSettings ? 'kept' : 'none',
        settingsAt: websiteSettings?.settingsAt ?? null,
        settingsRev: websiteSettings?.settingsRev ?? null,
        settingsTie: websiteSettings?.settingsTie ?? null,
        settingsDeviceId: websiteSettings?.deviceId ?? null,
        settingsProblem: null,
        websiteMessages: true,
        shop: shop ? (takesShop ? 'stored' : 'ignored_older') : websiteShop ? 'kept' : 'none',
        ...shopFields(),
      },
    },
  };
}

/** PUT /api/bridge/shop on a website with the block: the rule on `shop` alone. */
function newWebsiteShop(body: Row): { status: number; json: unknown } {
  if (websiteMenu.categories.length === 0) return { status: 409, json: { ok: false, error: 'menu_not_published' } };
  const shop = body['shop'] as PublishedShop;
  const refused = shopRefusal(shop);
  if (refused) return refused;
  const takes = shopBlockTakes(shop, websiteShop);
  if (takes) websiteShop = shop;
  return { status: 200, json: { ok: true, data: { shop: takes ? 'stored' : 'ignored_older', ...shopFields() } } };
}

/** A website of v0.7.30: it strips `shop` (MenuSchema is z.object), keeps the settings block, says nothing of the shop. */
function olderWebsiteMenu(body: Row): { status: number; json: unknown } {
  const { shop: _stripped, ...rest } = body;
  const a = newWebsiteMenu(rest);
  const data = { ...((a.json as { data: Row }).data) };
  for (const k of ['shop', 'shopRev', 'shopAt', 'shopTie', 'shopDeviceId', 'homeMissing']) delete data[k];
  return { status: a.status, json: { ok: true, data } };
}

let answerMenu: (body: Row) => { status: number; json: unknown } = newWebsiteMenu;
let answerShop: (body: Row) => { status: number; json: unknown } = newWebsiteShop;
let answerStatus: () => unknown = () => ({ ok: true, data: null });

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Row) : null;
      sent.push({ method, path: u.pathname, body });
      const json = (a: { status: number; json: unknown }) =>
        new Response(JSON.stringify(a.json), { status: a.status, headers: { 'Content-Type': 'application/json' } });
      if (u.pathname === '/api/bridge/menu' && method === 'PUT') {
        if (menuGate) await menuGate;
        return json(answerMenu(body ?? {}));
      }
      if (u.pathname === '/api/bridge/shop' && method === 'PUT') return json(answerShop(body ?? {}));
      if (u.pathname === '/api/bridge/settings' && method === 'PUT') return json({ status: 404, json: { ok: false } });
      if (u.pathname === '/api/bridge/status' && method === 'GET') return json({ status: 200, json: answerStatus() });
      return json({ status: 200, json: { ok: true, data: u.pathname === '/api/bridge/orders' ? [] : null } });
    }),
  );
}

const menus = (): Array<PublishedMenu & { settings?: PublishedSettings; shop?: PublishedShop }> =>
  sent.filter((s) => s.method === 'PUT' && s.path === '/api/bridge/menu').map((s) => s.body as never);
const shopPuts = (): PublishShopBody[] =>
  sent.filter((s) => s.method === 'PUT' && s.path === '/api/bridge/shop').map((s) => s.body as unknown as PublishShopBody);
const settingsPuts = () => sent.filter((s) => s.method === 'PUT' && s.path === '/api/bridge/settings');

let cfgMod: typeof import('./web-bridge-config.js');
let bridgeMod: typeof import('./web-orders-bridge.js');
let zonesRepo: typeof import('../db/repositories/delivery-zones-repo.js');
let settingsRepo: typeof import('../db/repositories/business-settings-repo.js');
let menuRepo: typeof import('../db/repositories/menu-item-repo.js');
let items: { pizza: string; d200: string; d250: string };

beforeEach(async () => {
  if (!DatabaseSync) return;
  sent = [];
  answerMenu = newWebsiteMenu;
  answerShop = newWebsiteShop;
  answerStatus = () => ({ ok: true, data: null });
  websiteSettings = null;
  websiteShop = null;
  websiteMenu = { categories: [] };
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

/** A till with the website linked ("Accept online orders" off: no polling loop), a made-up menu, the bridge started. */
async function till(opts: { menuOnWebsite?: boolean } = {}): Promise<Db> {
  const db = openMigrated();
  const T0 = '2026-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, 'Test Owner', 'x', 'admin', ?, ?, ?)`,
  ).run('u_owner', T0, T0, DEV);
  const d = db as AppDatabase;
  const { createTaxCategory } = await import('../db/repositories/tax-category-repo.js');
  const { createCategory } = await import('../db/repositories/category-repo.js');
  const tax = createTaxCategory(d, { name: 'Test GST', rateBps: 1_600 }, OWNER);
  const food = createCategory(d, { name: 'Test food', displayOrder: 1, colorHex: '#aa5500' }, OWNER);
  const fees = createCategory(d, { name: 'Delivery Charges', displayOrder: 2, colorHex: '#555555' }, OWNER);
  const item = (categoryId: string, name: string, cents: number) =>
    menuRepo.createMenuItem(d, { categoryId, name, basePriceCents: cents, taxCategoryId: tax.id }, OWNER).id;
  items = {
    pizza: item(food.id, 'Test Pizza — Large', 100_000),
    d200: item(fees.id, 'Delivery Charge (Rs 200)', 20_000),
    d250: item(fees.id, 'Delivery Charge (Rs 250)', 25_000),
  };
  cfgMod.setWebBridgeConfig(
    d,
    { enabled: false, siteUrl: SITE, bridgeSecret: 'made-up-secret', pollIntervalMs: 20_000, cloudBackupFrequency: 'off' },
    OWNER.userId,
  );
  // The website already has a menu (the owner published once before) unless told otherwise.
  if (opts.menuOnWebsite !== false) websiteMenu = { categories: [{ posCategoryId: 'c', name: 'Test food', displayOrder: 1, items: [] }] };
  bridgeMod.webOrdersBridge.init(d, DEV);
  return db;
}

const bridge = () => bridgeMod.webOrdersBridge;
const shopStatus = () => bridge().status().shopPublish;
const save = <K extends 'shop.profile' | 'shop.hours' | 'shop.website' | 'website.home'>(db: Db, key: K, value: unknown) =>
  settingsRepo.setBusinessSetting(db as AppDatabase, key, value as never, OWNER);
const hours = (opens: string, closes: string) => ({ ...structuredClone(DEFAULT_SHOP_HOURS), opens, closes });
const zones = (change: (z: DeliveryZoneSetting) => DeliveryZoneSetting = (z) => z) =>
  DEFAULT_DELIVERY_ZONES.zones.map((z) => change({ ...z, aliases: [...z.aliases], hints: [...z.hints] }));

/** Overwrite a saved row as the link would (another till's version, time or value). */
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

live('the shop block: nothing saved, nothing changes', () => {
  it('nothing saved: the publish body is exactly as before (no `shop` key), nothing goes by itself — and the website’s homeMissing reaches the summary and the status', async () => {
    await till();
    await bridge().maybePublishShop();
    expect([...menus(), ...shopPuts(), ...settingsPuts()]).toHaveLength(0);
    const summary = await bridge().publishMenu();
    expect(menus()).toHaveLength(1);
    expect(Object.keys(menus()[0]!)).toEqual(['categories', 'publishedAt', 'store']);
    expect(menus()[0]!.store).toMatchObject({ whatsapp: null });
    expect(shopPuts()).toHaveLength(0);
    // The default lineup against this made-up menu: none of today's featured items is on it.
    const todays = [...DEFAULT_WEBSITE_HOME.pizzas, DEFAULT_WEBSITE_HOME.burger!, ...DEFAULT_WEBSITE_HOME.deals].map((e) => e.itemRef.name);
    expect(summary.homeMissing).toEqual(todays);
    expect(summary).not.toHaveProperty('shopPublish');
    expect(shopStatus()).toMatchObject({ state: 'none' });
    expect(bridge().status().homeMissing).toEqual(todays);
    await bridge().maybePublishShop();
    expect(shopPuts()).toHaveLength(0);
  });

  it('an older website says nothing of the home page: no homeMissing in the summary, nothing noted', async () => {
    await till();
    answerMenu = olderWebsiteMenu;
    const summary = await bridge().publishMenu();
    expect(summary).not.toHaveProperty('homeMissing');
    expect(bridge().status()).toMatchObject({ homeMissing: null, shopPublish: { state: 'none' } });
  });
});

live('a Save sends the shop block ALONE — never the menu, never the settings block', () => {
  it('the block goes alone with every section (the saved one and the defaults), passes the website’s schema, and goes again only when newer', async () => {
    const db = await till();
    save(db, 'shop.hours', hours('11:00', '23:00'));
    await bridge().maybePublishShop();
    expect(shopPuts()).toHaveLength(1);
    expect(menus()).toHaveLength(0);
    expect(settingsPuts()).toHaveLength(0);
    const block = shopPuts()[0]!.shop;
    expect(publishedShopSchema.safeParse(block).success).toBe(true);
    expect(block).toMatchObject({ v: 1, shopRev: 1, deviceId: DEV, hours: { opens: '11:00', closes: '23:00' } });
    const { v: _v, ...profile } = DEFAULT_SHOP_PROFILE;
    expect(block.profile).toEqual(profile);
    expect(block.website.whatsappGreeting).toBe(DEFAULT_SHOP_WEBSITE.whatsappGreeting);
    expect(shopStatus()).toMatchObject({ state: 'published' });
    // Nothing newer: nothing sent.
    await bridge().maybePublishShop();
    expect(shopPuts()).toHaveLength(1);
    // Another card saved: newer.
    save(db, 'shop.profile', { ...structuredClone(DEFAULT_SHOP_PROFILE), name: 'Test Shop' });
    await bridge().maybePublishShop();
    expect(shopPuts()).toHaveLength(2);
    expect(shopPuts()[1]!.shop).toMatchObject({ shopRev: 2, profile: { name: 'Test Shop' }, hours: { opens: '11:00' } });
    expect(menus()).toHaveLength(0);
    expect(settingsPuts()).toHaveLength(0);
  });

  it('the Save’s word (website-settings-events) sends the shop block a moment later — and the settings block stays where it is', async () => {
    const db = await till();
    save(db, 'shop.website', { ...structuredClone(DEFAULT_SHOP_WEBSITE), doorPayments: ['cash', 'card'] });
    const { websiteSettingsChanged } = await import('./website-settings-events.js');
    websiteSettingsChanged();
    await vi.waitFor(() => expect(shopPuts()).toHaveLength(1), { timeout: 8_000 });
    expect(shopPuts()[0]!.shop.website.doorPayments).toEqual(['cash', 'card']);
    expect(settingsPuts()).toHaveLength(0);
    expect(menus()).toHaveLength(0);
  });

  it('a Save synced from the other till: the shop block goes alone a moment later (any till with the link sends it)', async () => {
    const db = await till();
    const { businessSettingId } = await import('../db/repositories/business-settings-repo.js');
    const id = businessSettingId('shop.profile');
    const at = new Date(Date.now() + 60_000).toISOString();
    const value = { ...structuredClone(DEFAULT_SHOP_PROFILE), name: 'Test Other Till Name' };
    const change: SyncChange = {
      entityType: 'business_settings',
      entityId: id,
      op: 'upsert',
      payload: {
        [ROW_IMAGE_KEY]: 1,
        id,
        key: 'shop.profile',
        valueJson: JSON.stringify(value),
        updatedByUserId: 'u_owner',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: at,
        deletedAt: null,
        deviceId: 'till-2',
        version: 1,
      },
      updatedAt: at,
      deviceId: 'till-2',
      version: 1,
    };
    const { SyncWorker } = await import('./sync-worker.js');
    const worker = new SyncWorker() as unknown as { applyPulled: (db: AppDatabase, changes: SyncChange[]) => Promise<void> };
    await worker.applyPulled(db as AppDatabase, [change]);
    await vi.waitFor(() => expect(shopPuts()).toHaveLength(1), { timeout: 8_000 });
    expect(shopPuts()[0]!.shop).toMatchObject({ shopRev: 1, shopAt: at, deviceId: DEV, profile: { name: 'Test Other Till Name' } });
    expect(menus()).toHaveLength(0);
  });

  it('the website holds a newer shop block (the other till’s): this till does not send its older one; Settings says the link brings it', async () => {
    const db = await till();
    answerStatus = () => ({
      ok: true,
      data: { settings: null, shop: { shopRev: 9, shopAt: '2026-09-28T11:00:00.000Z', shopTie: 3_000, shopDeviceId: 'till-2' }, homeMissing: [] },
    });
    save(db, 'shop.hours', hours('11:00', '23:00'));
    await bridge().maybePublishShop();
    expect(shopPuts()).toHaveLength(0);
    expect(shopStatus()).toMatchObject({ state: 'waiting', message: expect.stringMatching(/other till/) });
  });

  it('a website with no menu yet (409): nothing more by itself; Settings says to press Publish', async () => {
    const db = await till({ menuOnWebsite: false });
    save(db, 'shop.hours', hours('11:00', '23:00'));
    await bridge().maybePublishShop();
    await bridge().maybePublishShop();
    expect(shopPuts()).toHaveLength(1);
    expect(shopStatus()).toMatchObject({ state: 'refused', message: expect.stringMatching(/press Publish/) });
  });

  it('a Save while the menu is on its way: the shop block goes when that one ends', async () => {
    const db = await till();
    save(db, 'shop.hours', hours('11:00', '23:00'));
    let release!: () => void;
    menuGate = new Promise<void>((r) => (release = r));
    const first = bridge().publishMenu();
    await vi.waitFor(() => expect(menus()).toHaveLength(1));
    save(db, 'shop.hours', hours('12:00', '00:00'));
    await bridge().maybePublishShop();
    expect(shopPuts()).toHaveLength(0);
    menuGate = null;
    release();
    await first;
    await vi.waitFor(() => expect(shopPuts()).toHaveLength(1), { timeout: 8_000 });
    expect(shopPuts()[0]!.shop).toMatchObject({ shopRev: 2, hours: { opens: '12:00', closes: '00:00' } });
    expect(shopStatus()).toMatchObject({ state: 'published' });
  });
});

live('every menu publish carries the shop block, each block by its own rule', () => {
  it('the owner’s Publish sends the shop block IN the menu, next to the settings block', async () => {
    const db = await till();
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    save(db, 'website.home', {
      v: 1,
      pizzas: [{ itemRef: { posItemId: items.pizza, name: 'Test Pizza — Large' }, headline: 'Made-up hook' }],
      burger: null,
      deals: [],
    });
    const summary = await bridge().publishMenu();
    expect(menus()).toHaveLength(1);
    const body = menus()[0]!;
    expect(Object.keys(body)).toEqual(['categories', 'publishedAt', 'store', 'settings', 'shop']);
    expect(publishedShopSchema.safeParse(body.shop).success).toBe(true);
    expect(body.shop!.home.pizzas).toEqual([{ itemRef: { posItemId: items.pizza, name: 'Test Pizza — Large' }, headline: 'Made-up hook' }]);
    // The featured item is on the menu: nothing missing; the summary says where the shop details stand.
    expect(summary.homeMissing).toEqual([]);
    expect(summary.shopPublish).toMatchObject({ state: 'published' });
    expect(bridge().status().settingsPublish).toMatchObject({ state: 'published' });
    expect(shopStatus()).toMatchObject({ state: 'published' });
    // Both are on the website now: nothing more by itself.
    await bridge().maybePublishShop();
    expect(shopPuts()).toHaveLength(0);
  });

  it('homeMissing: a featured item the website can’t find reaches the summary and the status', async () => {
    const db = await till();
    save(db, 'website.home', {
      v: 1,
      pizzas: [{ itemRef: { posItemId: null, name: 'Test Pizza — Large' } }, { itemRef: { posItemId: null, name: 'Gone Pizza — Large' } }],
      burger: { itemRef: { posItemId: null, name: 'Gone Burger' } },
      deals: [],
    });
    const summary = await bridge().publishMenu();
    expect(summary.homeMissing).toEqual(['Gone Pizza — Large', 'Gone Burger']);
    expect(bridge().status().homeMissing).toEqual(['Gone Pizza — Large', 'Gone Burger']);
  });

  it('a fee item an older till hid stops the settings block — never the shop block', async () => {
    const db = await till();
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    save(db, 'shop.hours', hours('11:00', '23:00'));
    db.prepare(`UPDATE menu_items SET is_active = 0 WHERE id = ?`).run(items.d200);
    await bridge().publishMenu();
    expect(menus()).toHaveLength(1);
    expect(menus()[0]).not.toHaveProperty('settings');
    expect(menus()[0]!.shop).toMatchObject({ hours: { opens: '11:00' } });
    expect(bridge().status().settingsPublish).toMatchObject({ state: 'refused' });
    expect(shopStatus()).toMatchObject({ state: 'published' });
  });

  it('the website refuses the shop block (shop_invalid): the menu goes again WITH the settings block and without the shop; Settings says why, and it is not sent by itself', async () => {
    const db = await till();
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    save(db, 'shop.hours', hours('11:00', '23:00'));
    const refuse = (body: Row) =>
      body['shop'] ? { status: 400, json: { ok: false, error: 'shop_invalid', message: 'Test refusal: the hours do not fit' } } : newWebsiteMenu(body);
    answerMenu = refuse;
    answerShop = (body) => refuse({ shop: body['shop'] });
    const summary = await bridge().publishMenu();
    expect(menus()).toHaveLength(2);
    expect(menus()[0]).toHaveProperty('shop');
    expect(menus()[1]).not.toHaveProperty('shop');
    expect(menus()[1]).toHaveProperty('settings');
    expect(websiteSettings).not.toBeNull();
    expect(summary.shopPublish).toMatchObject({ state: 'refused', message: 'Test refusal: the hours do not fit' });
    expect(bridge().status().settingsPublish).toMatchObject({ state: 'published' });
    await bridge().maybePublishShop();
    expect(shopPuts()).toHaveLength(0);
  });

  it('refused one after the other: the settings block, then the shop block — the menu still goes (three sends at most)', async () => {
    const db = await till();
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    save(db, 'shop.hours', hours('11:00', '23:00'));
    answerMenu = (body) =>
      body['settings']
        ? { status: 400, json: { ok: false, error: 'settings_invalid', message: 'Test: an area' } }
        : body['shop']
          ? { status: 400, json: { ok: false, error: 'shop_invalid', message: 'Test: the shop' } }
          : newWebsiteMenu(body);
    await bridge().publishMenu();
    expect(menus().map((m) => [!!m.settings, !!m.shop])).toEqual([
      [true, true],
      [false, true],
      [false, false],
    ]);
    expect(bridge().status().settingsPublish).toMatchObject({ state: 'refused', message: 'Test: an area' });
    expect(shopStatus()).toMatchObject({ state: 'refused', message: 'Test: the shop' });
  });

  it('any other failure is a failed publish (retried), never taken for a refusal', async () => {
    const db = await till();
    save(db, 'shop.hours', hours('11:00', '23:00'));
    answerMenu = () => ({ status: 400, json: { ok: false, error: 'validation' } });
    await expect(bridge().publishMenu()).rejects.toThrow(/Publish failed: HTTP 400/);
    expect(menus()).toHaveLength(1);
  });
});

live('the website or this till can’t take the shop block', () => {
  it('a website older than the shop block: 404 from the block alone → “needs its update”, no loop; once updated, the next start sends it by itself', async () => {
    const db = await till();
    answerShop = () => ({ status: 404, json: { ok: false } });
    save(db, 'shop.hours', hours('11:00', '23:00'));
    await bridge().maybePublishShop();
    await bridge().maybePublishShop();
    expect(shopPuts()).toHaveLength(1);
    expect(shopStatus()).toMatchObject({ state: 'unsupported', message: expect.stringMatching(/needs its update/) });
    expect(menus()).toHaveLength(0);
    // The website is updated: its status now speaks of the shop block (none held). The next start sends it.
    answerShop = newWebsiteShop;
    answerStatus = () => ({ ok: true, data: { settings: null, shop: null, homeMissing: [] } });
    bridge().stop();
    bridge().init(db as AppDatabase, DEV);
    await bridge().maybePublishShop();
    expect(shopPuts()).toHaveLength(2);
    expect(shopStatus()).toMatchObject({ state: 'published' });
  });

  it('an older website publishing the menu drops `shop` (no word about it): Settings says it needs its update; the till does not loop', async () => {
    const db = await till();
    answerMenu = olderWebsiteMenu;
    answerShop = () => ({ status: 404, json: { ok: false } });
    save(db, 'shop.hours', hours('11:00', '23:00'));
    const summary = await bridge().publishMenu();
    expect(menus()[0]).toHaveProperty('shop');
    expect(summary.shopPublish).toMatchObject({ state: 'unsupported' });
    await bridge().maybePublishShop();
    expect(shopPuts()).toHaveLength(0);
    expect(menus()).toHaveLength(1);
  });

  it('a website that lost its shop block (rolled back, then updated again) gets it at the till’s next start', async () => {
    const db = await till();
    answerStatus = () => ({ ok: true, data: { settings: null, shop: websiteShop ? { shopRev: websiteShop.shopRev, shopAt: websiteShop.shopAt, shopTie: websiteShop.shopTie, shopDeviceId: websiteShop.deviceId } : null, homeMissing: [] } });
    save(db, 'shop.hours', hours('11:00', '23:00'));
    await bridge().maybePublishShop();
    expect(shopPuts()).toHaveLength(1);
    websiteShop = null;
    bridge().stop();
    bridge().init(db as AppDatabase, DEV);
    await bridge().maybePublishShop();
    expect(shopPuts()).toHaveLength(2);
  });

  it('a shop key saved by a newer version of the app: no shop block goes from this till (its default would replace the right one); Publish still sends the menu and the settings block', async () => {
    const db = await till();
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    save(db, 'shop.hours', hours('11:00', '23:00'));
    // The other till, on a newer version, saved the hours in a newer format.
    syncedRow(db, 'shop.hours', { version: 2, value: { v: 9, opens: '11:00', closes: '23:00', days: ['mon'], holidays: [] } });
    await bridge().maybePublishShop();
    expect(shopPuts()).toHaveLength(0);
    expect(shopStatus()).toMatchObject({ state: 'refused', message: expect.stringMatching(/opening hours were saved by a newer version/) });
    await bridge().publishMenu();
    expect(menus()).toHaveLength(1);
    expect(menus()[0]).not.toHaveProperty('shop');
    expect(menus()[0]).toHaveProperty('settings');
    // …and this till never saves over it (the card is read-only; the repository refuses).
    expect(() => save(db, 'shop.hours', hours('12:00', '01:00'))).toThrow(/newer version/);
  });
});
