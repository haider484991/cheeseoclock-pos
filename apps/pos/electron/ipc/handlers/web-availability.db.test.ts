/**
 * Selling on the website, per item and per category (Settings sweep B5 + M2;
 * migration 0045; shared-types web-bridge.ts, SELLING ON THE WEBSITE).
 * Through the real IPC handlers, repositories, sync applier, menu file
 * import and publish on a real SQLite database built from every migration:
 *   - with every item and category at the default the published menu is
 *     byte-for-byte what v0.7.29 published (its code, kept below);
 *   - 'off' items and every item of a category off the website are left
 *     out, 'pickup_only' ones go with `pickupOnly: true`; a delivery charge
 *     always goes; an item photo too big for the website is named;
 *   - only whoever may edit the menu changes it (not a cashier), a value
 *     outside the three is refused, and a delivery charge stays on;
 *   - an edit of anything else, a menu file import, and a row image from a
 *     v0.7.29 till (without the columns) leave the flags as they are; a new
 *     row from such a till is on the website;
 *   - a fresh start says what it resets.
 *
 * Only `defineHandler` (captured), the signed-in session, the printer
 * spooler and the FBR worker are stood in for. node's own `node:sqlite`
 * stands in for better-sqlite3 (built for Electron); skipped where it is
 * missing. Every name, id and amount is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DELIVERY_ZONES,
  PUBLISHED_IMAGE_MAX_CHARS,
  type AuthenticatedUser,
  type Category,
  type MenuItem,
  type PublishedMenu,
  type PublishedMenuCategory,
  type UUID,
} from '@cheeseoclock/shared-types';
import { menuImportFileSchema } from '@cheeseoclock/shared-schemas';
import type { AppDatabase } from '../../db/connection.js';
import { DatabaseSync, openMigrated } from '../../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Handler = (ctx: unknown, payload: unknown) => unknown;
const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => unknown>(),
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
vi.mock('electron-log/main', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '', getVersion: () => '0.0.0-test' },
  dialog: {},
  safeStorage: { isEncryptionAvailable: () => false },
  Notification: class {
    static isSupported() {
      return false;
    }
  },
}));
vi.mock('../../services/auth-service.js', () => ({
  getCurrentSession: () => h.session,
  verifyManagerPin: async () => {
    throw new Error("That is not a manager's PIN or password");
  },
}));
vi.mock('../../services/print-spooler.js', () => ({
  printSpooler: new Proxy({}, { get: () => () => undefined }),
}));
vi.mock('../../services/fbr-worker.js', () => ({
  fbrWorker: { kick: () => {}, resetAdapter: () => {} },
}));

const live = describe.skipIf(!DatabaseSync);

const DEV = 'dev-till-1';
const T0 = '2026-01-01T00:00:00.000Z';
const session = (id: string, role: AuthenticatedUser['role']): AuthenticatedUser => ({
  id: id as UUID,
  fullName: id,
  role,
  sessionId: 'sess' as UUID,
});
const CASHIER = session('u_cash', 'cashier');
const MANAGER = session('u_mgr', 'manager');
const OWNER = session('u_admin', 'admin');
const OWNER_ACTOR = { userId: 'u_admin', deviceId: DEV };

type Db = ReturnType<typeof openMigrated>;
let db: Db;
let menu: {
  pizza: string;
  burger: string;
  side: string;
  drink: string;
  d200: string;
  d250: string;
  food: string;
  drinks: string;
  fees: string;
  tax: string;
  group: string;
};

type Outcome = { ok: true; data: unknown } | { ok: false; code: string; message: string };

async function call(channel: string, payload?: unknown): Promise<Outcome> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  try {
    const r = (await fn({ db, deviceId: DEV }, payload)) as
      | { ok: true; data: unknown }
      | { ok: false; error: { code: string; message: string } };
    return r.ok ? { ok: true, data: r.data } : { ok: false, code: r.error.code, message: r.error.message };
  } catch (e) {
    const api = (e as { apiError?: { code: string; message: string } }).apiError;
    if (api) return { ok: false, code: api.code, message: api.message };
    return { ok: false, code: 'threw', message: e instanceof Error ? e.message : String(e) };
  }
}
async function data<T = unknown>(channel: string, payload?: unknown): Promise<T> {
  const o = await call(channel, payload);
  if (!o.ok) throw new Error(`${channel} refused: ${o.code} ${o.message}`);
  return o.data as T;
}

/** Users, a tax, food with a choice group, drinks, and the two delivery charges — as a menu file import makes them. */
async function seedTill(d: Db): Promise<typeof menu> {
  const user = d.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_admin', 'Test Owner', 'admin', T0, T0, DEV);
  user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
  user.run('u_mgr', 'Test Manager', 'manager', T0, T0, DEV);
  const x = d as never;
  const mgr = { userId: 'u_mgr', deviceId: DEV };
  const { createTaxCategory } = await import('../../db/repositories/tax-category-repo.js');
  const { createCategory } = await import('../../db/repositories/category-repo.js');
  const { createMenuItem } = await import('../../db/repositories/menu-item-repo.js');
  const mods = await import('../../db/repositories/modifier-repo.js');
  const tax = createTaxCategory(x, { name: 'Test GST', rateBps: 1_600 }, mgr);
  const food = createCategory(x, { name: 'Test food', displayOrder: 1, colorHex: '#aa5500' }, mgr);
  const drinks = createCategory(x, { name: 'Test drinks', displayOrder: 2, colorHex: '#0055aa' }, mgr);
  const fees = createCategory(x, { name: 'Delivery Charges', displayOrder: 3, colorHex: '#555555' }, mgr);
  const item = (categoryId: string, name: string, cents: number, description: string | null = null, sortOrder = 0) =>
    createMenuItem(x, { categoryId, name, basePriceCents: cents, taxCategoryId: tax.id, description, sortOrder }, mgr).id;
  const pizza = item(food.id, 'Test Pizza', 100_000, 'A made-up pizza', 1);
  const group = mods.createModifierGroup(
    x,
    { name: 'Test size', selectionType: 'single', minSelect: 1, maxSelect: 1, isRequired: true },
    mgr,
  );
  mods.createModifier(x, { modifierGroupId: group.id, name: 'Large', priceDeltaCents: 30_000, isDefault: false, sortOrder: 1 }, mgr);
  mods.setItemModifierGroups(x, pizza, [{ modifierGroupId: group.id, sortOrder: 0 }], mgr);
  return {
    pizza,
    burger: item(food.id, 'Test Burger', 60_000, null, 2),
    side: item(food.id, 'Test Side', 30_000, null, 3),
    drink: item(drinks.id, 'Test Drink', 15_000, null, 1),
    d200: item(fees.id, 'Delivery Charge (Rs 200)', 20_000),
    d250: item(fees.id, 'Delivery Charge (Rs 250)', 25_000),
    food: food.id,
    drinks: drinks.id,
    fees: fees.id,
    tax: tax.id,
    group: group.id,
  };
}

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.session = null;
  db = openMigrated({});
  menu = await seedTill(db);
  const ctx = { db, deviceId: DEV } as never;
  (await import('./settings-handlers.js')).registerSettingsHandlers(ctx);
  (await import('./menu-handlers.js')).registerMenuHandlers(ctx);
});

const itemRow = (d: Db, id: string) =>
  d.prepare(`SELECT web_availability, base_price_cents, version FROM menu_items WHERE id = ?`).get(id);
const categoryRow = (d: Db, id: string) => d.prepare(`SELECT is_on_website, name, version FROM categories WHERE id = ?`).get(id);
const published = async (d: Db = db) => (await import('../../services/web-orders-bridge.js')).buildPublishedMenuReport(d as AppDatabase);
const names = (m: PublishedMenu) => m.categories.map((c) => [c.name, c.items.map((i) => i.name)]);

// ---------------------------------------------------------------------------
// What v0.7.29 published (web-orders-bridge.ts buildPublishedMenu at 4201067),
// kept here word for word but for its name: the default must equal it.
// ---------------------------------------------------------------------------
function v0729PublishedMenu(
  db: AppDatabase,
  getReceiptBranding: (db: AppDatabase) => { storeName: string; phoneLine?: string | null; branchLine?: string | null; storeTagline?: string | null },
): PublishedMenu {
  const MAX_IMAGE_CHARS = 300_000;
  const branding = getReceiptBranding(db);

  const categories = db
    .prepare(
      `SELECT id, name, display_order FROM categories
        WHERE deleted_at IS NULL AND is_active = 1
        ORDER BY display_order`,
    )
    .all() as Array<{ id: string; name: string; display_order: number }>;

  const items = db
    .prepare(
      `SELECT mi.id, mi.category_id, mi.name, mi.description, mi.base_price_cents,
              mi.image_url, mi.sort_order, IFNULL(tc.rate_bps, 0) AS rate_bps
         FROM menu_items mi
         LEFT JOIN tax_categories tc ON tc.id = mi.tax_category_id AND tc.deleted_at IS NULL
        WHERE mi.deleted_at IS NULL AND mi.is_active = 1
        ORDER BY mi.sort_order`,
    )
    .all() as Array<{
    id: string;
    category_id: string;
    name: string;
    description: string | null;
    base_price_cents: number;
    image_url: string | null;
    sort_order: number;
    rate_bps: number;
  }>;

  const itemGroups = db
    .prepare(
      `SELECT mig.menu_item_id, mig.sort_order AS group_sort,
              mg.id AS group_id, mg.name AS group_name, mg.selection_type,
              mg.min_select, mg.max_select, mg.is_required
         FROM menu_item_modifier_groups mig
         JOIN modifier_groups mg ON mg.id = mig.modifier_group_id AND mg.deleted_at IS NULL
        WHERE mig.deleted_at IS NULL
        ORDER BY mig.sort_order`,
    )
    .all() as Array<{
    menu_item_id: string;
    group_sort: number;
    group_id: string;
    group_name: string;
    selection_type: 'single' | 'multi';
    min_select: number;
    max_select: number;
    is_required: number;
  }>;

  const modifiers = db
    .prepare(
      `SELECT id, modifier_group_id, name, price_delta_cents, is_default, sort_order
         FROM modifiers WHERE deleted_at IS NULL ORDER BY sort_order`,
    )
    .all() as Array<{
    id: string;
    modifier_group_id: string;
    name: string;
    price_delta_cents: number;
    is_default: number;
    sort_order: number;
  }>;

  const modsByGroup = new Map<string, typeof modifiers>();
  for (const m of modifiers) {
    const arr = modsByGroup.get(m.modifier_group_id) ?? [];
    arr.push(m);
    modsByGroup.set(m.modifier_group_id, arr);
  }
  const groupsByItem = new Map<string, typeof itemGroups>();
  for (const g of itemGroups) {
    const arr = groupsByItem.get(g.menu_item_id) ?? [];
    arr.push(g);
    groupsByItem.set(g.menu_item_id, arr);
  }

  const publishedCategories: PublishedMenuCategory[] = categories
    .map((c) => ({
      posCategoryId: c.id,
      name: c.name,
      displayOrder: c.display_order,
      items: items
        .filter((i) => i.category_id === c.id)
        .map((i) => ({
          posItemId: i.id,
          name: i.name,
          description: i.description,
          basePriceCents: i.base_price_cents,
          taxRateBps: i.rate_bps,
          imageUrl:
            i.image_url && i.image_url.length <= MAX_IMAGE_CHARS ? i.image_url : null,
          sortOrder: i.sort_order,
          modifierGroups: (groupsByItem.get(i.id) ?? []).map((g) => ({
            posGroupId: g.group_id,
            name: g.group_name,
            selectionType: g.selection_type,
            minSelect: g.min_select,
            maxSelect: g.max_select,
            isRequired: g.is_required === 1,
            sortOrder: g.group_sort,
            modifiers: (modsByGroup.get(g.group_id) ?? []).map((m) => ({
              posModifierId: m.id,
              name: m.name,
              priceDeltaCents: m.price_delta_cents,
              isDefault: m.is_default === 1,
              sortOrder: m.sort_order,
            })),
          })),
        })),
    }))
    .filter((c) => c.items.length > 0);

  return {
    categories: publishedCategories,
    publishedAt: new Date().toISOString(),
    store: {
      name: branding.storeName,
      phone: branding.phoneLine ?? null,
      whatsapp: null,
      addressLine: branding.branchLine ?? null,
      tagline: branding.storeTagline ?? null,
    },
  };
}

live('the defaults: the website gets exactly the menu it got before', () => {
  it('0045 leaves every item on the website and every category on it; the publish is byte-for-byte v0.7.29’s — no new key on any item', async () => {
    expect(db.prepare(`SELECT DISTINCT web_availability AS w FROM menu_items`).all()).toEqual([{ w: 'on' }]);
    expect(db.prepare(`SELECT DISTINCT is_on_website AS w FROM categories`).all()).toEqual([{ w: 1 }]);
    const { getReceiptBranding } = await import('../../services/printer-config.js');
    const { menu: now, photosLeftOut } = await published();
    const then = v0729PublishedMenu(db as AppDatabase, getReceiptBranding);
    expect(JSON.stringify({ ...now, publishedAt: 'x' })).toBe(JSON.stringify({ ...then, publishedAt: 'x' }));
    expect(photosLeftOut).toEqual([]);
    for (const c of now.categories) for (const i of c.items) expect(i).not.toHaveProperty('pickupOnly');
  });

  it('the menu the Menu editor lists says so: every item on the website, every category on it', async () => {
    h.session = CASHIER;
    const items = await data<MenuItem[]>('menu:listItems');
    const cats = await data<Category[]>('menu:listCategories');
    expect(new Set(items.map((i) => i.webAvailability))).toEqual(new Set(['on']));
    expect(new Set(cats.map((c) => c.isOnWebsite))).toEqual(new Set([true]));
  });
});

live('Menu → On the website: what goes to the website', () => {
  it('“Not on the website” and a category off the website are left out; “Pick-up only” goes with the flag; the till still sells them all', async () => {
    h.session = MANAGER;
    await data('menu:updateItem', { id: menu.side, webAvailability: 'off' });
    await data('menu:updateItem', { id: menu.burger, webAvailability: 'pickup_only' });
    await data('menu:updateCategory', { id: menu.drinks, isOnWebsite: false });
    const { menu: m } = await published();
    expect(names(m)).toEqual([
      ['Test food', ['Test Pizza', 'Test Burger']],
      ['Delivery Charges', ['Delivery Charge (Rs 200)', 'Delivery Charge (Rs 250)']],
    ]);
    const burger = m.categories[0]!.items.find((i) => i.name === 'Test Burger')!;
    expect(burger.pickupOnly).toBe(true);
    // Only the flagged item carries the key.
    expect(m.categories[0]!.items.find((i) => i.name === 'Test Pizza')).not.toHaveProperty('pickupOnly');
    // The till still sells them: nothing changed on the till.
    h.session = CASHIER;
    const onTill = (await data<MenuItem[]>('menu:listItems', { activeOnly: true })).map((i) => i.name);
    expect(onTill).toEqual(expect.arrayContaining(['Test Side', 'Test Drink', 'Test Burger']));
    // Back on: back on the website, the flag gone.
    h.session = MANAGER;
    await data('menu:updateItem', { id: menu.side, webAvailability: 'on' });
    await data('menu:updateItem', { id: menu.burger, webAvailability: 'on' });
    await data('menu:updateCategory', { id: menu.drinks, isOnWebsite: true });
    const { getReceiptBranding } = await import('../../services/printer-config.js');
    expect(JSON.stringify({ ...(await published()).menu, publishedAt: 'x' })).toBe(
      JSON.stringify({ ...v0729PublishedMenu(db as AppDatabase, getReceiptBranding), publishedAt: 'x' }),
    );
  });

  it('a delivery charge always goes — its category off the website, or its row set off by an older till — so the settings block still finds it', async () => {
    const { saveDeliveryZones } = await import('../../db/repositories/delivery-zones-repo.js');
    saveDeliveryZones(db as never, { zones: DEFAULT_DELIVERY_ZONES.zones.map((z) => ({ ...z, aliases: [...z.aliases], hints: [...z.hints] })) }, OWNER_ACTOR);
    h.session = MANAGER;
    await data('menu:updateCategory', { id: menu.fees, isOnWebsite: false });
    db.prepare(`UPDATE menu_items SET web_availability = 'off' WHERE id = ?`).run(menu.d250);
    const { menu: m } = await published();
    const fees = m.categories.find((c) => c.name === 'Delivery Charges')!;
    expect(fees.items.map((i) => [i.name, 'pickupOnly' in i])).toEqual([
      ['Delivery Charge (Rs 200)', false],
      ['Delivery Charge (Rs 250)', false],
    ]);
    // The block the till would send with this menu passes its own check.
    const { settingsBlockFor } = await import('../../services/website-settings-block.js');
    expect(settingsBlockFor(db as AppDatabase, m, DEV)).toMatchObject({ problem: null, block: expect.any(Object) });
  });

  it('a delivery charge whose row says pick-up only (an older or newer till, a hand edit) is published WITHOUT pickupOnly: the website adds the fee to deliveries', async () => {
    db.prepare(`UPDATE menu_items SET web_availability = 'pickup_only' WHERE id = ?`).run(menu.d200);
    const { menu: m } = await published();
    const fees = m.categories.find((c) => c.name === 'Delivery Charges')!;
    expect(fees.items.map((i) => [i.name, 'pickupOnly' in i])).toEqual([
      ['Delivery Charge (Rs 200)', false],
      ['Delivery Charge (Rs 250)', false],
    ]);
  });

  it('a value this version does not know (a newer till’s) reads — and publishes — as on the website', async () => {
    db.prepare(`UPDATE menu_items SET web_availability = 'dine_in_only' WHERE id = ?`).run(menu.side);
    db.prepare(`UPDATE categories SET is_on_website = 7 WHERE id = ?`).run(menu.drinks);
    h.session = CASHIER;
    const side = (await data<MenuItem[]>('menu:listItems')).find((i) => i.id === menu.side)!;
    expect(side.webAvailability).toBe('on');
    expect((await data<Category[]>('menu:listCategories')).find((c) => c.id === menu.drinks)!.isOnWebsite).toBe(true);
    expect(names((await published()).menu).flatMap(([, i]) => i)).toEqual(expect.arrayContaining(['Test Side', 'Test Drink']));
    // An edit of something else leaves the newer till's value in the row.
    h.session = MANAGER;
    await data('menu:updateItem', { id: menu.side, basePriceCents: 31_000 });
    expect(itemRow(db, menu.side)).toMatchObject({ web_availability: 'dine_in_only', base_price_cents: 31_000 });
  });

  it('a category edit of anything else leaves a value this version does not know as it is (7 stays 7), and off stays off', async () => {
    db.prepare(`UPDATE categories SET is_on_website = 7 WHERE id = ?`).run(menu.food);
    h.session = MANAGER;
    await data('menu:updateCategory', { id: menu.drinks, isOnWebsite: false });
    await data('menu:updateCategory', { id: menu.food, name: 'Test hot food' });
    await data('menu:updateCategory', { id: menu.drinks, name: 'Test cold drinks' });
    expect(categoryRow(db, menu.food)).toMatchObject({ is_on_website: 7, name: 'Test hot food' });
    expect(categoryRow(db, menu.drinks)).toMatchObject({ is_on_website: 0, name: 'Test cold drinks' });
  });

  it('a photo too big for the website is named (the item goes with no picture); a hidden item’s is not; a normal photo goes', async () => {
    const big = `data:image/jpeg;base64,${'A'.repeat(PUBLISHED_IMAGE_MAX_CHARS)}`;
    const small = `data:image/jpeg;base64,${'B'.repeat(1_000)}`;
    h.session = MANAGER;
    await data('menu:updateItem', { id: menu.pizza, imageUrl: big });
    await data('menu:updateItem', { id: menu.burger, imageUrl: small });
    await data('menu:updateItem', { id: menu.side, imageUrl: big, webAvailability: 'off' });
    const { menu: m, photosLeftOut } = await published();
    expect(photosLeftOut).toEqual([{ id: menu.pizza, name: 'Test Pizza' }]);
    const food = m.categories.find((c) => c.name === 'Test food')!;
    expect(food.items.find((i) => i.name === 'Test Pizza')!.imageUrl).toBeNull();
    expect(food.items.find((i) => i.name === 'Test Burger')!.imageUrl).toBe(small);
    // Exactly at the limit still goes.
    await data('menu:updateItem', { id: menu.pizza, imageUrl: big.slice(0, PUBLISHED_IMAGE_MAX_CHARS) });
    expect((await published()).photosLeftOut).toEqual([]);
  });
});

live('Menu → On the website: who may change it, and what is refused', () => {
  it('a manager and the owner may (whoever may edit the menu); a cashier may not — nothing is written', async () => {
    h.session = CASHIER;
    const before = itemRow(db, menu.side);
    expect(await call('menu:updateItem', { id: menu.side, webAvailability: 'off' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await call('menu:updateCategory', { id: menu.drinks, isOnWebsite: false })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(itemRow(db, menu.side)).toEqual(before);
    expect(categoryRow(db, menu.drinks)).toMatchObject({ is_on_website: 1 });
    h.session = MANAGER;
    expect((await call('menu:updateItem', { id: menu.side, webAvailability: 'off' })).ok).toBe(true);
    h.session = OWNER;
    expect((await call('menu:updateCategory', { id: menu.drinks, isOnWebsite: false })).ok).toBe(true);
    expect(itemRow(db, menu.side)).toMatchObject({ web_availability: 'off' });
    expect(categoryRow(db, menu.drinks)).toMatchObject({ is_on_website: 0 });
  });

  it('a value outside the three, or a category answer that is not yes/no, is refused before anything is written', async () => {
    h.session = OWNER;
    const before = { side: itemRow(db, menu.side), drinks: categoryRow(db, menu.drinks) };
    for (const [channel, payload] of [
      ['menu:updateItem', { id: menu.side, webAvailability: 'dine_in' }],
      ['menu:updateItem', { id: menu.side, webAvailability: 1 }],
      ['menu:updateCategory', { id: menu.drinks, isOnWebsite: 'no' }],
      ['menu:createItem', { categoryId: menu.food, name: 'Test New', basePriceCents: 1_000, taxCategoryId: menu.tax, webAvailability: 'hidden' }],
      ['menu:createCategory', { name: 'Test New Cat', displayOrder: 9, colorHex: '#111111', isOnWebsite: 0 }],
    ] as const) {
      expect({ channel, o: await call(channel, payload) }).toMatchObject({ channel, o: { ok: false, code: 'validation_failed' } });
    }
    expect({ side: itemRow(db, menu.side), drinks: categoryRow(db, menu.drinks) }).toEqual(before);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM menu_items WHERE name = 'Test New'`).get()).toEqual({ n: 0 });
  });

  it('a new item or category can be made off the website, or pick-up only, from the start', async () => {
    h.session = MANAGER;
    const item = await data<MenuItem>('menu:createItem', {
      categoryId: menu.food,
      name: 'Test Special',
      basePriceCents: 50_000,
      taxCategoryId: menu.tax,
      webAvailability: 'pickup_only',
    });
    const cat = await data<Category>('menu:createCategory', { name: 'Test Secret', displayOrder: 8, colorHex: '#123456', isOnWebsite: false });
    expect(item.webAvailability).toBe('pickup_only');
    expect(cat.isOnWebsite).toBe(false);
    expect(itemRow(db, item.id)).toMatchObject({ web_availability: 'pickup_only' });
    expect(categoryRow(db, cat.id)).toMatchObject({ is_on_website: 0 });
    // Without the field: on the website, as every item before.
    const plain = await data<MenuItem>('menu:createItem', { categoryId: menu.food, name: 'Test Plain', basePriceCents: 1_000, taxCategoryId: menu.tax });
    expect(plain.webAvailability).toBe('on');
  });

  it('a delivery charge can’t be made pick-up only or taken off the website (it is always on it); the dialog’s unchanged “on” is fine', async () => {
    const { saveDeliveryZones } = await import('../../db/repositories/delivery-zones-repo.js');
    const { FEE_ITEM_ALWAYS_ON_WEBSITE } = await import('../../services/delivery-fee-items.js');
    saveDeliveryZones(db as never, { zones: DEFAULT_DELIVERY_ZONES.zones.map((z) => ({ ...z, aliases: [...z.aliases], hints: [...z.hints] })) }, OWNER_ACTOR);
    h.session = OWNER;
    for (const w of ['off', 'pickup_only'] as const) {
      expect(await call('menu:updateItem', { id: menu.d200, webAvailability: w })).toEqual({
        ok: false,
        code: 'precondition_failed',
        message: FEE_ITEM_ALWAYS_ON_WEBSITE,
      });
    }
    expect(itemRow(db, menu.d200)).toMatchObject({ web_availability: 'on' });
    expect((await call('menu:updateItem', { id: menu.d200, webAvailability: 'on', description: 'Test note' })).ok).toBe(true);
  });

  it('each change is the repositories’: the row, its sync entry (the row image carries the flag) and an audit row, in one go', async () => {
    h.session = MANAGER;
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const before = { audit: count('audit_log'), sync: count('sync_queue') };
    await data('menu:updateItem', { id: menu.burger, webAvailability: 'pickup_only' });
    await data('menu:updateCategory', { id: menu.drinks, isOnWebsite: false });
    expect({ audit: count('audit_log'), sync: count('sync_queue') }).toEqual({ audit: before.audit + 2, sync: before.sync + 2 });
    const images = (db.prepare(`SELECT entity_type, payload_json FROM sync_queue ORDER BY rowid DESC LIMIT 2`).all() as Array<{
      entity_type: string;
      payload_json: string;
    }>).map((r) => [r.entity_type, JSON.parse(r.payload_json) as Record<string, unknown>] as const);
    expect(images.find(([t]) => t === 'menu_items')?.[1]).toMatchObject({ id: menu.burger, webAvailability: 'pickup_only' });
    expect(images.find(([t]) => t === 'categories')?.[1]).toMatchObject({ id: menu.drinks, isOnWebsite: 0 });
    const audit = db
      .prepare(`SELECT before_json, after_json FROM audit_log WHERE entity_type = 'menu_items' AND entity_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(menu.burger) as { before_json: string; after_json: string };
    expect(JSON.parse(audit.before_json)).toMatchObject({ webAvailability: 'on' });
    expect(JSON.parse(audit.after_json)).toMatchObject({ webAvailability: 'pickup_only' });
  });

  it('an edit of anything else leaves the flag as it is (the item dialog sends every field, the import only some)', async () => {
    h.session = MANAGER;
    await data('menu:updateItem', { id: menu.burger, webAvailability: 'off' });
    await data('menu:updateCategory', { id: menu.drinks, isOnWebsite: false });
    await data('menu:updateItem', { id: menu.burger, basePriceCents: 65_000, description: 'Test' });
    await data('menu:updateCategory', { id: menu.drinks, name: 'Test cold drinks', isActive: true });
    expect(itemRow(db, menu.burger)).toMatchObject({ web_availability: 'off', base_price_cents: 65_000 });
    expect(categoryRow(db, menu.drinks)).toMatchObject({ is_on_website: 0, name: 'Test cold drinks' });
  });
});

live('the other till: row images with and without the website columns', () => {
  async function secondTill(): Promise<Db> {
    const b = openMigrated({});
    const user = b.prepare(
      `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
    );
    user.run('u_admin', 'Test Owner', 'admin', T0, T0, DEV);
    user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
    user.run('u_mgr', 'Test Manager', 'manager', T0, T0, DEV);
    await push(db, b, DEV);
    return b;
  }
  /** Send every unsent change `from` → `to`; `older` strips the 0045 columns, as a v0.7.29 till's images are. */
  async function push(from: Db, to: Db, fromDevice: string, older = false): Promise<void> {
    const sync = await import('../../db/repositories/sync-repo.js');
    const { applyRemoteBatch } = await import('../../db/repositories/apply-remote.js');
    const pending = sync.listPendingSync(from as never, 5_000);
    const changes = pending.map((p) => {
      const c = sync.pendingToChange(p, fromDevice);
      if (!older) return c;
      const { webAvailability: _w, isOnWebsite: _o, ...image } = c.payload as Record<string, unknown>;
      return { ...c, payload: image };
    });
    const r = await applyRemoteBatch(to as never, changes, { pause: async () => {} });
    expect(r.waiting).toBe(0);
    sync.markSyncedIds(from as never, pending.map((p) => p.id));
  }

  it('this version’s change reaches the other till with the flag', async () => {
    const b = await secondTill();
    h.session = MANAGER;
    await data('menu:updateItem', { id: menu.burger, webAvailability: 'pickup_only' });
    await data('menu:updateCategory', { id: menu.drinks, isOnWebsite: false });
    await push(db, b, DEV);
    expect(itemRow(b, menu.burger)).toMatchObject({ web_availability: 'pickup_only' });
    expect(categoryRow(b, menu.drinks)).toMatchObject({ is_on_website: 0 });
  });

  it('a v0.7.29 till’s later change to the same rows (its image has no website columns) never puts the flags back on', async () => {
    const b = await secondTill();
    h.session = MANAGER;
    await data('menu:updateItem', { id: menu.burger, webAvailability: 'off' });
    await data('menu:updateCategory', { id: menu.drinks, isOnWebsite: false });
    await push(db, b, DEV);
    // Till B (on v0.7.29) re-prices the burger and renames the drinks: its images carry no 0045 column.
    const { updateMenuItem } = await import('../../db/repositories/menu-item-repo.js');
    const { updateCategory } = await import('../../db/repositories/category-repo.js');
    const tillB = { userId: 'u_mgr', deviceId: 'dev-till-2' };
    updateMenuItem(b as never, { id: menu.burger, basePriceCents: 70_000 }, tillB);
    updateCategory(b as never, { id: menu.drinks, name: 'Test soft drinks' }, tillB);
    await push(b, db, 'dev-till-2', true);
    expect(itemRow(db, menu.burger)).toMatchObject({ web_availability: 'off', base_price_cents: 70_000 });
    expect(categoryRow(db, menu.drinks)).toMatchObject({ is_on_website: 0, name: 'Test soft drinks' });
    expect(names((await published()).menu)).toEqual([
      ['Test food', ['Test Pizza', 'Test Side']],
      ['Delivery Charges', ['Delivery Charge (Rs 200)', 'Delivery Charge (Rs 250)']],
    ]);
  });

  it('a new item or category made on a v0.7.29 till arrives on the website (the default)', async () => {
    const b = await secondTill();
    const { createMenuItem } = await import('../../db/repositories/menu-item-repo.js');
    const { createCategory } = await import('../../db/repositories/category-repo.js');
    const tillB = { userId: 'u_mgr', deviceId: 'dev-till-2' };
    const cat = createCategory(b as never, { name: 'Test desserts', displayOrder: 4, colorHex: '#aa00aa' }, tillB);
    const item = createMenuItem(b as never, { categoryId: cat.id, name: 'Test Brownie', basePriceCents: 25_000, taxCategoryId: menu.tax }, tillB);
    await push(b, db, 'dev-till-2', true);
    expect(itemRow(db, item.id)).toMatchObject({ web_availability: 'on' });
    expect(categoryRow(db, cat.id)).toMatchObject({ is_on_website: 1 });
  });
});

live('a menu file import keeps where things sell on the website ("kept on the till")', () => {
  const file = (items: unknown[]) =>
    menuImportFileSchema.parse({
      format: 'cheeseoclock-menu-import',
      version: 1,
      source: 'test',
      categories: [{ name: 'Test food' }, { name: 'Test drinks' }],
      ingredients: [],
      items,
    });

  it('an update of the item’s price and description leaves its flag and its category’s; a new item is on the website', async () => {
    h.session = MANAGER;
    await data('menu:updateItem', { id: menu.burger, webAvailability: 'pickup_only' });
    await data('menu:updateItem', { id: menu.side, webAvailability: 'off' });
    await data('menu:updateCategory', { id: menu.drinks, isOnWebsite: false });
    const { applyMenuImport } = await import('../../db/repositories/menu-import-repo.js');
    applyMenuImport(
      db as never,
      file([
        { name: 'Test Burger', category: 'Test food', priceCents: 64_000, description: 'Test new words', recipe: [] },
        { name: 'Test Side', category: 'Test food', priceCents: 33_000, recipe: [] },
        { name: 'Test Drink', category: 'Test drinks', priceCents: 16_000, recipe: [] },
        { name: 'Test Wrap', category: 'Test food', priceCents: 45_000, recipe: [] },
      ]),
      'test.json',
      OWNER_ACTOR,
    );
    expect(itemRow(db, menu.burger)).toMatchObject({ web_availability: 'pickup_only', base_price_cents: 64_000 });
    expect(itemRow(db, menu.side)).toMatchObject({ web_availability: 'off', base_price_cents: 33_000 });
    expect(categoryRow(db, menu.drinks)).toMatchObject({ is_on_website: 0 });
    const wrap = db.prepare(`SELECT web_availability FROM menu_items WHERE name = 'Test Wrap' AND deleted_at IS NULL`).get();
    expect(wrap).toEqual({ web_availability: 'on' });
  });

  it('a fresh start keeps each website setting for the file’s item or category of the SAME name — the menu it publishes at once keeps them; one brought back under another name is on the website, and the preview counted it', async () => {
    h.session = MANAGER;
    await data('menu:updateItem', { id: menu.burger, webAvailability: 'pickup_only' });
    await data('menu:updateItem', { id: menu.side, webAvailability: 'off' });
    await data('menu:updateCategory', { id: menu.drinks, isOnWebsite: false });
    const { applyMenuImport, planMenuImportFromDb } = await import('../../db/repositories/menu-import-repo.js');
    // The same names (another case and spacing — the import's matching), but the side comes back as "Test Chips".
    const f = file([
      { name: 'Test Pizza', category: 'Test food', priceCents: 90_000, recipe: [] },
      { name: 'test  BURGER', category: 'Test food', priceCents: 61_000, recipe: [] },
      { name: 'Test Chips', category: 'Test food', priceCents: 31_000, recipe: [] },
      { name: 'Test Drink', category: 'Test drinks', priceCents: 15_000, recipe: [] },
    ]);
    expect(planMenuImportFromDb(db as never, f, { fresh: true }).preview.fresh).toMatchObject({ websiteSettingsLost: 1 });
    applyMenuImport(db as never, f, 'test.json', OWNER_ACTOR, { fresh: true });
    const row = (name: string) =>
      db.prepare(`SELECT id, web_availability FROM menu_items WHERE name = ? AND deleted_at IS NULL`).get(name) as { id: string; web_availability: string };
    expect(row('test  BURGER').web_availability).toBe('pickup_only');
    expect(row('test  BURGER').id).not.toBe(menu.burger);
    expect(row('Test Chips').web_availability).toBe('on');
    expect(row('Test Pizza').web_availability).toBe('on');
    expect(db.prepare(`SELECT is_on_website FROM categories WHERE name = 'Test drinks' AND deleted_at IS NULL`).get()).toEqual({ is_on_website: 0 });
    expect(db.prepare(`SELECT is_on_website FROM categories WHERE name = 'Test food' AND deleted_at IS NULL`).get()).toEqual({ is_on_website: 1 });
    // What the import publishes straight away: the burger pick-up only, the drinks' category left out.
    const { menu: m } = await published();
    expect(new Map(m.categories.map((c) => [c.name, c.items.map((i) => i.name)]))).toEqual(
      new Map([
        ['Test food', ['Test Pizza', 'test  BURGER', 'Test Chips']],
        ['Delivery Charges', ['Delivery Charge (Rs 200)', 'Delivery Charge (Rs 250)']],
      ]),
    );
    const food = m.categories.find((c) => c.name === 'Test food')!;
    expect(food.items.find((i) => i.name === 'test  BURGER')!.pickupOnly).toBe(true);
    expect(food.items.find((i) => i.name === 'Test Chips')).not.toHaveProperty('pickupOnly');
    // Each carried setting is the repositories' (the new row's sync image carries it).
    const image = db
      .prepare(`SELECT payload_json FROM sync_queue WHERE entity_type = 'menu_items' AND entity_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(row('test  BURGER').id) as { payload_json: string };
    expect(JSON.parse(image.payload_json)).toMatchObject({ webAvailability: 'pickup_only' });
  });

  it('two removed items of one name set differently carry nothing (never guessed) — and the preview counts that name as lost', async () => {
    h.session = MANAGER;
    await data('menu:updateItem', { id: menu.burger, webAvailability: 'pickup_only' });
    const twin = await data<MenuItem>('menu:createItem', { categoryId: menu.drinks, name: 'Test Burger', basePriceCents: 1_000, taxCategoryId: menu.tax, webAvailability: 'off' });
    expect(twin.webAvailability).toBe('off');
    const { applyMenuImport, planMenuImportFromDb } = await import('../../db/repositories/menu-import-repo.js');
    // The file brings the name back, yet neither setting can be kept: the new row is on the website.
    const f = file([{ name: 'Test Burger', category: 'Test food', priceCents: 61_000, recipe: [] }]);
    expect(planMenuImportFromDb(db as never, f, { fresh: true }).preview.fresh).toMatchObject({ websiteSettingsLost: 1 });
    applyMenuImport(db as never, f, 'test.json', OWNER_ACTOR, { fresh: true });
    expect(db.prepare(`SELECT web_availability FROM menu_items WHERE name = 'Test Burger' AND deleted_at IS NULL`).all()).toEqual([
      { web_availability: 'on' },
    ]);
  });

  it('one of two namesakes set and the other left on the website: nothing carried, counted as lost — an item and a category', async () => {
    h.session = MANAGER;
    await data('menu:updateItem', { id: menu.side, webAvailability: 'off' });
    await data('menu:createItem', { categoryId: menu.drinks, name: 'test side', basePriceCents: 1_000, taxCategoryId: menu.tax });
    await data('menu:updateCategory', { id: menu.drinks, isOnWebsite: false });
    await data('menu:createCategory', { name: 'TEST DRINKS', displayOrder: 4, colorHex: '#123456' });
    const { applyMenuImport, planMenuImportFromDb } = await import('../../db/repositories/menu-import-repo.js');
    const f = file([{ name: 'Test Side', category: 'Test drinks', priceCents: 31_000, recipe: [] }]);
    expect(planMenuImportFromDb(db as never, f, { fresh: true }).preview.fresh).toMatchObject({ websiteSettingsLost: 2 });
    applyMenuImport(db as never, f, 'test.json', OWNER_ACTOR, { fresh: true });
    expect(db.prepare(`SELECT web_availability FROM menu_items WHERE name = 'Test Side' AND deleted_at IS NULL`).all()).toEqual([
      { web_availability: 'on' },
    ]);
    expect(db.prepare(`SELECT is_on_website FROM categories WHERE name = 'Test drinks' AND deleted_at IS NULL`).all()).toEqual([
      { is_on_website: 1 },
    ]);
  });

  it('a fresh start says how many website settings it resets (the file carries none); the delivery charges stay and are skipped', async () => {
    h.session = MANAGER;
    await data('menu:updateItem', { id: menu.burger, webAvailability: 'pickup_only' });
    await data('menu:updateItem', { id: menu.side, webAvailability: 'off' });
    await data('menu:updateCategory', { id: menu.drinks, isOnWebsite: false });
    const { planMenuImportFromDb } = await import('../../db/repositories/menu-import-repo.js');
    const f = file([{ name: 'Test Pizza', category: 'Test food', priceCents: 90_000, recipe: [] }]);
    expect(planMenuImportFromDb(db as never, f, { fresh: true }).preview.fresh).toMatchObject({ websiteSettingsLost: 3 });
    // Nothing set off the website: nothing to say.
    await data('menu:updateItem', { id: menu.burger, webAvailability: 'on' });
    await data('menu:updateItem', { id: menu.side, webAvailability: 'on' });
    await data('menu:updateCategory', { id: menu.drinks, isOnWebsite: true });
    expect(planMenuImportFromDb(db as never, f, { fresh: true }).preview.fresh).toMatchObject({ websiteSettingsLost: 0 });
  });
});

