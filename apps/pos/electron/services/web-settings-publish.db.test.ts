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
/** How the website answers a menu PUT (default: a website that takes the block). */
let answerMenu: (body: Row) => { status: number; json: unknown } = storedAnswer;

function storedAnswer(body: Row) {
  const settings = body['settings'] as PublishedSettings | undefined;
  return {
    status: 200,
    json: {
      ok: true,
      data: {
        categories: 1,
        items: 1,
        settings: settings ? 'stored' : 'none',
        settingsAt: settings?.settingsAt ?? null,
        settingsRev: settings?.settingsRev ?? null,
      },
    },
  };
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Row) : null;
      sent.push({ method, path: u.pathname, body });
      if (u.pathname === '/api/bridge/menu' && method === 'PUT') {
        const a = answerMenu(body ?? {});
        return new Response(JSON.stringify(a.json), {
          status: a.status,
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
        },
      },
    });
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(1);
    expect(publishStatus()).toMatchObject({ state: 'published' });
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
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(2);
    expect(menus()[0]).toHaveProperty('settings');
    expect(menus()[1]).not.toHaveProperty('settings');
    expect(publishStatus()).toEqual({
      state: 'refused',
      at: null,
      message: 'DHA Phase 8: its delivery charge item is not on the menu',
    });
  });

  it('a fee item an older till hid: the till checks first and sends the menu without the block, saying which area', async () => {
    const db = await till();
    zonesRepo.saveDeliveryZones(db as AppDatabase, { zones: zones() }, OWNER);
    db.prepare(`UPDATE menu_items SET is_active = 0 WHERE id = ?`).run(items.d250);
    await bridge().maybePublishSettings();
    expect(menus()).toHaveLength(1);
    expect(menus()[0]).not.toHaveProperty('settings');
    expect(publishStatus()).toMatchObject({
      state: 'refused',
      message: expect.stringMatching(/DHA Phase 8|Emaar|Creek|Clifton/),
    });
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
    const beats = sent.filter((s) => s.path === '/api/bridge/status');
    for (const b of beats) expect(b.body).toMatchObject({ pickupDiscountPercent: 10 });
  });
});
