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
 *   - a fresh start says what it resets;
 *   - no discount on value deals (migration 0047): with every category set
 *     to discounted the publish is byte-for-byte v0.7.33's; with nothing set
 *     only the Value Deals items gain `noDiscount: true`; a delivery charge
 *     never carries it;
 *   - and on two tills: the owner's explicit answer (0 as well as 1) reaches
 *     the other till; an older till's row image without the key never resets
 *     it; a deal rung up on one till arrives on the other never discounted,
 *     and an older till's order-line image lands as 0 when new and leaves a
 *     stored answer alone.
 *
 * Only `defineHandler` (captured), the signed-in session, the printer
 * spooler and the FBR worker are stood in for. node's own `node:sqlite`
 * stands in for better-sqlite3 (built for Electron); skipped where it is
 * missing. Every name, id and amount is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  categoryNeverDiscounted,
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

/** The owner's Value Deals as a menu file import makes it: nothing set, so its name decides. */
async function addValueDeals(): Promise<string> {
  const x = db as never;
  const mgr = { userId: 'u_mgr', deviceId: DEV };
  const { createCategory } = await import('../../db/repositories/category-repo.js');
  const { createMenuItem } = await import('../../db/repositories/menu-item-repo.js');
  const deals = createCategory(x, { name: 'Value Deals', displayOrder: 4, colorHex: '#aa0055' }, mgr);
  const deal = (name: string, cents: number, sortOrder: number) =>
    createMenuItem(x, { categoryId: deals.id, name, basePriceCents: cents, taxCategoryId: menu.tax, sortOrder }, mgr);
  deal('Big Two', 360_000, 4);
  deal('Family Feast', 520_000, 5);
  deal('Perfect Pair', 240_000, 6);
  return deals.id;
}
const markedNames = (m: PublishedMenu) => m.categories.flatMap((c) => c.items.filter((i) => i.noDiscount === true).map((i) => i.name));

live('no discount on value deals: what the website gets (migration 0047; web-bridge.ts, NO DISCOUNT ON VALUE DEALS)', () => {
  it('every category set to discounted (an explicit 0, the owner’s): the publish is byte-for-byte v0.7.33’s (at the website defaults, v0.7.29’s above) — no noDiscount key anywhere', async () => {
    await addValueDeals();
    h.session = OWNER;
    for (const c of await data<Category[]>('menu:listCategories')) await data('menu:updateCategory', { id: c.id, noDiscount: false });
    expect(db.prepare(`SELECT DISTINCT no_discount AS n FROM categories`).all()).toEqual([{ n: 0 }]);
    const { getReceiptBranding } = await import('../../services/printer-config.js');
    const { menu: now } = await published();
    const then = v0729PublishedMenu(db as AppDatabase, getReceiptBranding);
    expect(JSON.stringify({ ...now, publishedAt: 'x' })).toBe(JSON.stringify({ ...then, publishedAt: 'x' }));
    expect(JSON.stringify(now)).not.toContain('noDiscount');
  });

  it('nothing set: Value Deals is never discounted by its name — only Big Two, Family Feast and Perfect Pair gain `noDiscount: true`, everything else byte-for-byte as before', async () => {
    const dealsId = await addValueDeals();
    expect(db.prepare(`SELECT DISTINCT no_discount AS n FROM categories`).all()).toEqual([{ n: null }]);
    const { getReceiptBranding } = await import('../../services/printer-config.js');
    const { menu: now } = await published();
    const then = v0729PublishedMenu(db as AppDatabase, getReceiptBranding);
    const marked: PublishedMenu = {
      ...then,
      categories: then.categories.map((c) => (c.posCategoryId === dealsId ? { ...c, items: c.items.map((i) => ({ ...i, noDiscount: true })) } : c)),
    };
    expect(JSON.stringify({ ...now, publishedAt: 'x' })).toBe(JSON.stringify({ ...marked, publishedAt: 'x' }));
    expect(markedNames(now)).toEqual(['Big Two', 'Family Feast', 'Perfect Pair']);
  });

  it('a delivery charge never carries it — in a category the owner made never discounted, or put among the deals; the owner’s mark on any other category does', async () => {
    const dealsId = await addValueDeals();
    const { createMenuItem } = await import('../../db/repositories/menu-item-repo.js');
    createMenuItem(
      db as never,
      { categoryId: dealsId, name: 'Delivery Charge (Rs 300)', basePriceCents: 30_000, taxCategoryId: menu.tax, sortOrder: 9 },
      { userId: 'u_mgr', deviceId: DEV },
    );
    h.session = OWNER;
    await data('menu:updateCategory', { id: menu.fees, noDiscount: true });
    await data('menu:updateCategory', { id: menu.drinks, noDiscount: true });
    const { menu: m } = await published();
    const charges = m.categories.flatMap((c) => c.items).filter((i) => /^Delivery Charge/.test(i.name));
    expect(charges.map((i) => [i.name, 'noDiscount' in i])).toEqual([
      ['Delivery Charge (Rs 200)', false],
      ['Delivery Charge (Rs 250)', false],
      ['Delivery Charge (Rs 300)', false],
    ]);
    expect(markedNames(m)).toEqual(['Test Drink', 'Big Two', 'Family Feast', 'Perfect Pair']);
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

live('the other till: row images with and without the website and never discounted columns', () => {
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
  /**
   * Send every unsent change `from` → `to`. `older` makes the row images an older till's: a v0.7.29
   * till's have neither the 0045 website columns nor 0047's never discounted; a v0.7.33 till's lack 0047's.
   */
  async function push(from: Db, to: Db, fromDevice: string, older: 'v0.7.29' | 'v0.7.33' | null = null): Promise<void> {
    const sync = await import('../../db/repositories/sync-repo.js');
    const { applyRemoteBatch } = await import('../../db/repositories/apply-remote.js');
    const pending = sync.listPendingSync(from as never, 5_000);
    const unknownThere = older === 'v0.7.29' ? ['webAvailability', 'isOnWebsite', 'noDiscount'] : older === 'v0.7.33' ? ['noDiscount'] : [];
    const changes = pending.map((p) => {
      const c = sync.pendingToChange(p, fromDevice);
      if (unknownThere.length === 0) return c;
      const image = Object.fromEntries(Object.entries(c.payload as Record<string, unknown>).filter(([k]) => !unknownThere.includes(k)));
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
    await push(b, db, 'dev-till-2', 'v0.7.29');
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
    await push(b, db, 'dev-till-2', 'v0.7.29');
    expect(itemRow(db, item.id)).toMatchObject({ web_availability: 'on' });
    expect(categoryRow(db, cat.id)).toMatchObject({ is_on_website: 1 });
  });

  // Never discounted on two tills (migration 0047; DEPLOY.md, No discount on value deals).
  const idOf = (d: Db, name: string) => (d.prepare(`SELECT id FROM menu_items WHERE name = ? AND deleted_at IS NULL`).get(name) as { id: string }).id;
  const markRow = (d: Db, id: string) => d.prepare(`SELECT name, color_hex, no_discount, version FROM categories WHERE id = ?`).get(id);
  /** [name sold under, no_discount] per line of the order, as this till stores it. */
  const soldLines = (d: Db, orderId: string) =>
    (
      d
        .prepare(`SELECT menu_item_name AS name, no_discount AS nd FROM order_items WHERE order_id = ? AND deleted_at IS NULL ORDER BY created_at, id`)
        .all(orderId) as Array<{ name: string; nd: number }>
    ).map((r) => [r.name, r.nd]);
  const orders = () => import('../../db/repositories/order-repo.js');
  const TILL_A = { userId: 'u_cash', deviceId: DEV };
  const TILL_B = { userId: 'u_cash', deviceId: 'dev-till-2' };

  it('the owner’s explicit answer reaches the other till — a 0 as well as a 1, never read there as nothing set: its publish and its new lines follow it', async () => {
    const dealsId = await addValueDeals();
    const b = await secondTill();
    expect(markRow(b, dealsId)).toMatchObject({ no_discount: null });
    h.session = OWNER;
    await data('menu:updateCategory', { id: dealsId, noDiscount: false });
    await data('menu:updateCategory', { id: menu.drinks, noDiscount: true });
    await push(db, b, DEV);
    expect(markRow(b, dealsId)).toEqual(markRow(db, dealsId));
    expect(markRow(b, dealsId)).toMatchObject({ name: 'Value Deals', no_discount: 0 });
    expect(markRow(b, menu.drinks)).toMatchObject({ no_discount: 1 });
    const { listCategories } = await import('../../db/repositories/category-repo.js');
    expect(listCategories(b as never).map((c) => [c.name, c.noDiscount, categoryNeverDiscounted(c)])).toEqual([
      ['Test food', null, false],
      ['Test drinks', true, true],
      ['Delivery Charges', null, false],
      ['Value Deals', false, false],
    ]);
    // Till B's publish: the drink marked, the deals not (the owner's 0).
    expect(markedNames((await published(b)).menu)).toEqual(['Test Drink']);
    // A Big Two rung up on till B now takes discounts; its drink never does.
    const r = await orders();
    const o = r.createOrder(b as never, { mode: 'takeaway' }, TILL_B).id;
    r.addOrderItem(b as never, { orderId: o, menuItemId: idOf(b, 'Big Two'), quantity: 1, modifierIds: [] }, TILL_B);
    r.addOrderItem(b as never, { orderId: o, menuItemId: menu.drink, quantity: 1, modifierIds: [] }, TILL_B);
    expect(soldLines(b, o)).toEqual([
      ['Big Two', 0],
      ['Test Drink', 1],
    ]);
  });

  it('an older till’s later change to the category (its image has no noDiscount) never resets the answer here — a v0.7.33 till’s, then a v0.7.29 till’s; a new category from one is decided by its name', async () => {
    const dealsId = await addValueDeals();
    const b = await secondTill();
    h.session = OWNER;
    await data('menu:updateCategory', { id: dealsId, noDiscount: false });
    await data('menu:updateCategory', { id: menu.drinks, noDiscount: true });
    await push(db, b, DEV);
    // Till B is older: it has no such column, so it never kept the answers (here: nothing set).
    b.prepare(`UPDATE categories SET no_discount = NULL`).run();
    const { createCategory, findCategory, updateCategory } = await import('../../db/repositories/category-repo.js');
    const tillB = { userId: 'u_mgr', deviceId: 'dev-till-2' };
    // Till B on v0.7.33 recolours the deals, renames the drinks and makes a combos category.
    updateCategory(b as never, { id: dealsId, colorHex: '#bb0066' }, tillB);
    updateCategory(b as never, { id: menu.drinks, name: 'Test soft drinks' }, tillB);
    const combos = createCategory(b as never, { name: 'Test Combos', displayOrder: 5, colorHex: '#00aa55' }, tillB);
    await push(b, db, 'dev-till-2', 'v0.7.33');
    expect(markRow(db, dealsId)).toEqual({ name: 'Value Deals', color_hex: '#bb0066', no_discount: 0, version: 3 });
    expect(markRow(db, menu.drinks)).toMatchObject({ name: 'Test soft drinks', no_discount: 1, version: 3 });
    // Till B, back on v0.7.29, recolours both again.
    updateCategory(b as never, { id: dealsId, colorHex: '#aa0055' }, tillB);
    updateCategory(b as never, { id: menu.drinks, colorHex: '#0066bb' }, tillB);
    await push(b, db, 'dev-till-2', 'v0.7.29');
    expect(markRow(db, dealsId)).toEqual({ name: 'Value Deals', color_hex: '#aa0055', no_discount: 0, version: 4 });
    expect(markRow(db, menu.drinks)).toMatchObject({ color_hex: '#0066bb', no_discount: 1, version: 4 });
    // The new category arrived with nothing set: its name decides (combos are never discounted).
    expect(markRow(db, combos.id)).toMatchObject({ no_discount: null });
    expect(categoryNeverDiscounted(findCategory(db as never, combos.id)!)).toBe(true);
    // What this till publishes still follows the owner's answers: the drink, not the deals.
    expect(markedNames((await published()).menu)).toEqual(['Test Drink']);
  });

  it('a deal rung up on this till arrives on the other never discounted (the burger discounted), whatever its category says there later: that till’s discount leaves it alone', async () => {
    const dealsId = await addValueDeals();
    const b = await secondTill();
    const r = await orders();
    const o = r.createOrder(db as never, { mode: 'takeaway' }, TILL_A).id;
    r.addOrderItem(db as never, { orderId: o, menuItemId: idOf(db, 'Big Two'), quantity: 1, modifierIds: [] }, TILL_A);
    r.addOrderItem(db as never, { orderId: o, menuItemId: menu.burger, quantity: 1, modifierIds: [] }, TILL_A);
    await push(db, b, DEV);
    expect(soldLines(b, o)).toEqual([
      ['Big Two', 1],
      ['Test Burger', 0],
    ]);
    expect(r.getOrderSnapshot(b as never, o)!.items.map((i) => [i.menuItemName, i.noDiscount])).toEqual([
      ['Big Two', true],
      ['Test Burger', false],
    ]);
    // The owner on till B lets the deals take discounts from now on; the line already sold keeps its answer.
    const { updateCategory } = await import('../../db/repositories/category-repo.js');
    updateCategory(b as never, { id: dealsId, noDiscount: false }, { userId: 'u_admin', deviceId: 'dev-till-2' });
    expect(soldLines(b, o)).toEqual([
      ['Big Two', 1],
      ['Test Burger', 0],
    ]);
    // Till B's 10% staff discount comes off the burger only.
    r.applyDiscount(b as never, { orderId: o, discountType: 'percent', value: 10, reason: 'Staff', approverUserId: 'u_mgr' }, TILL_B);
    expect(r.findOrder(b as never, o)!.discountCents).toBe(6_000);
  });

  it('an order-line image from a v0.7.33 till (no noDiscount): a new line lands as 0 (that till never knew), a change to a line sold here leaves its 1', async () => {
    await addValueDeals();
    const b = await secondTill();
    const r = await orders();
    const o = r.createOrder(db as never, { mode: 'takeaway' }, TILL_A).id;
    r.addOrderItem(db as never, { orderId: o, menuItemId: idOf(db, 'Big Two'), quantity: 1, modifierIds: [] }, TILL_A);
    await push(db, b, DEV);
    const soldHere = (db.prepare(`SELECT id FROM order_items WHERE order_id = ?`).get(o) as { id: string }).id;
    // Till B is older: it has no such column, so it never kept the line's answer (here: the default).
    b.prepare(`UPDATE order_items SET no_discount = 0`).run();
    // Till B, on v0.7.33, makes it two Big Twos and adds a Family Feast.
    r.updateOrderItemQuantity(b as never, o, soldHere, 2, TILL_B);
    r.addOrderItem(b as never, { orderId: o, menuItemId: idOf(b, 'Family Feast'), quantity: 1, modifierIds: [] }, TILL_B);
    await push(b, db, 'dev-till-2', 'v0.7.33');
    expect(soldLines(db, o)).toEqual([
      ['Big Two', 1],
      ['Family Feast', 0],
    ]);
    expect(db.prepare(`SELECT quantity, version FROM order_items WHERE id = ?`).get(soldHere)).toEqual({ quantity: 2, version: 2 });
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

  it('namesakes set differently are counted as lost file or not: the file that brings neither name back says so too — an item and a category', async () => {
    h.session = MANAGER;
    // Two "Test Burger"s (pick-up only, and off the website) and two "Test drinks" (off the website, and on it).
    await data('menu:updateItem', { id: menu.burger, webAvailability: 'pickup_only' });
    await data('menu:createItem', { categoryId: menu.drinks, name: 'test burger', basePriceCents: 1_000, taxCategoryId: menu.tax, webAvailability: 'off' });
    await data('menu:updateCategory', { id: menu.drinks, isOnWebsite: false });
    await data('menu:createCategory', { name: 'TEST DRINKS', displayOrder: 4, colorHex: '#123456' });
    const { applyMenuImport, planMenuImportFromDb } = await import('../../db/repositories/menu-import-repo.js');
    const pizza = { name: 'Test Pizza', category: 'Test food', priceCents: 90_000, recipe: [] };
    const fileOf = (categories: Array<{ name: string }>, items: unknown[]) =>
      menuImportFileSchema.parse({ format: 'cheeseoclock-menu-import', version: 1, source: 'test', categories, ingredients: [], items });
    // The file brings back neither name — no burger, no drinks category: both names are lost.
    const neither = fileOf([{ name: 'Test food' }], [pizza]);
    expect(planMenuImportFromDb(db as never, neither, { fresh: true }).preview.fresh).toMatchObject({ websiteSettingsLost: 2 });
    // The file brings both back: the same two (nothing is carried for either name).
    const both = fileOf(
      [{ name: 'Test food' }, { name: 'Test drinks' }],
      [pizza, { name: 'Test Burger', category: 'Test drinks', priceCents: 61_000, recipe: [] }],
    );
    expect(planMenuImportFromDb(db as never, both, { fresh: true }).preview.fresh).toMatchObject({ websiteSettingsLost: 2 });
    applyMenuImport(db as never, neither, 'test.json', OWNER_ACTOR, { fresh: true });
    expect(db.prepare(`SELECT name FROM menu_items WHERE deleted_at IS NULL AND name NOT LIKE 'Delivery Charge%'`).all()).toEqual([
      { name: 'Test Pizza' },
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

