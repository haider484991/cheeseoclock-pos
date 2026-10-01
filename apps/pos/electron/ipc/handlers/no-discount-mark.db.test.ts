/**
 * Never discounted, per category (migration 0047; the owner, 2026-10-02:
 * "there is no discount on combos"; shared-types categoryNeverDiscounted).
 * Through the real IPC handlers, repositories and menu file import on a real
 * SQLite database built from every migration:
 *   - with nothing set, a category goes by its name (Value Deals never, the
 *     rest discounted), and reads null;
 *   - only the owner (settings.manage) changes what a category does; a
 *     manager is refused in plain words and nothing is written, but may
 *     rename it, recolour it, or send the answer it already has;
 *   - each change is the repositories': the row, its sync image and an audit
 *     row; a rename never changes discounts (Value Deals → Bundles stays
 *     never discounted, now set);
 *   - a value that is not yes / no is refused before anything is written;
 *   - an ordinary menu file import never touches a category's mark; a fresh
 *     start carries a set mark by name, carries nothing for namesakes that
 *     answer differently, and its preview counts what it can't keep.
 *
 * Only `defineHandler` (captured), the signed-in session, the printer
 * spooler and the FBR worker are stood in for. node's own `node:sqlite`
 * stands in for better-sqlite3 (built for Electron); skipped where it is
 * missing. Every name, id and amount is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { categoryNeverDiscounted, type AuthenticatedUser, type Category, type UUID } from '@cheeseoclock/shared-types';
import { menuImportFileSchema } from '@cheeseoclock/shared-schemas';
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
const OWNER_ONLY = 'Only the owner can change which items are never discounted.';

type Db = ReturnType<typeof openMigrated>;
let db: Db;
let menu: { food: string; drinks: string; deals: string; fees: string; tax: string };

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

/** Users, a tax, food, drinks, the value deals, and the two delivery charges — as a menu file import makes them. */
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
  const tax = createTaxCategory(x, { name: 'Test GST', rateBps: 1_500 }, mgr);
  const food = createCategory(x, { name: 'Test food', displayOrder: 1, colorHex: '#aa5500' }, mgr);
  const drinks = createCategory(x, { name: 'Test drinks', displayOrder: 2, colorHex: '#0055aa' }, mgr);
  const deals = createCategory(x, { name: 'Test Value Deals', displayOrder: 3, colorHex: '#aa0055' }, mgr);
  const fees = createCategory(x, { name: 'Delivery Charges', displayOrder: 4, colorHex: '#555555' }, mgr);
  const item = (categoryId: string, name: string, cents: number) =>
    createMenuItem(x, { categoryId, name, basePriceCents: cents, taxCategoryId: tax.id }, mgr).id;
  item(food.id, 'Test Pizza', 150_000);
  item(drinks.id, 'Test Drink', 15_000);
  item(deals.id, 'Test Big Deal', 360_000);
  item(fees.id, 'Delivery Charge (Rs 200)', 20_000);
  return { food: food.id, drinks: drinks.id, deals: deals.id, fees: fees.id, tax: tax.id };
}

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.session = null;
  db = openMigrated({});
  menu = await seedTill(db);
  (await import('./menu-handlers.js')).registerMenuHandlers({ db, deviceId: DEV } as never);
});

const categoryRow = (id: string) => db.prepare(`SELECT name, color_hex, no_discount, version FROM categories WHERE id = ?`).get(id);
const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
const ledgers = () => ({ sync: count('sync_queue'), audit: count('audit_log') });
const lastImage = (id: string) =>
  JSON.parse(
    (db.prepare(`SELECT payload_json FROM sync_queue WHERE entity_type = 'categories' AND entity_id = ? ORDER BY rowid DESC LIMIT 1`).get(id) as {
      payload_json: string;
    }).payload_json,
  ) as Record<string, unknown>;
const lastAudit = (id: string) => {
  const r = db
    .prepare(`SELECT before_json, after_json FROM audit_log WHERE entity_type = 'categories' AND entity_id = ? ORDER BY rowid DESC LIMIT 1`)
    .get(id) as { before_json: string | null; after_json: string };
  return { before: r.before_json === null ? null : (JSON.parse(r.before_json) as Record<string, unknown>), after: JSON.parse(r.after_json) as Record<string, unknown> };
};
const byName = async () => {
  const { listCategories } = await import('../../db/repositories/category-repo.js');
  return new Map(listCategories(db as never).map((c) => [c.name, { noDiscount: c.noDiscount, never: categoryNeverDiscounted(c) }]));
};

live('Menu → Categories → Never discounted: by its name until the owner sets it', () => {
  it('with nothing set: the value deals are never discounted, the rest are; every category reads null (by its name)', async () => {
    h.session = MANAGER;
    const cats = await data<Category[]>('menu:listCategories');
    expect(cats.map((c) => [c.name, c.noDiscount, categoryNeverDiscounted(c)])).toEqual([
      ['Test food', null, false],
      ['Test drinks', null, false],
      ['Test Value Deals', null, true],
      ['Delivery Charges', null, false],
    ]);
    expect(db.prepare(`SELECT DISTINCT no_discount AS v FROM categories`).all()).toEqual([{ v: null }]);
  });

  it('the owner’s change is the repositories’: the row, its sync image (with noDiscount) and an audit row, in one go', async () => {
    h.session = OWNER;
    const before = ledgers();
    const drinks = await data<Category>('menu:updateCategory', { id: menu.drinks, noDiscount: true });
    const deals = await data<Category>('menu:updateCategory', { id: menu.deals, noDiscount: false });
    expect([drinks.noDiscount, deals.noDiscount]).toEqual([true, false]);
    expect(ledgers()).toEqual({ sync: before.sync + 2, audit: before.audit + 2 });
    expect(categoryRow(menu.drinks)).toMatchObject({ no_discount: 1, version: 2 });
    expect(categoryRow(menu.deals)).toMatchObject({ no_discount: 0, version: 2 });
    expect(lastImage(menu.drinks)).toMatchObject({ id: menu.drinks, noDiscount: 1 });
    expect(lastImage(menu.deals)).toMatchObject({ id: menu.deals, noDiscount: 0 });
    expect(lastAudit(menu.drinks)).toMatchObject({ before: { noDiscount: null }, after: { noDiscount: true } });
    expect(lastAudit(menu.deals)).toMatchObject({ before: { noDiscount: null }, after: { noDiscount: false } });
    // What the set value says wins over the name, both ways.
    const after = await byName();
    expect([after.get('Test drinks'), after.get('Test Value Deals')]).toEqual([
      { noDiscount: true, never: true },
      { noDiscount: false, never: false },
    ]);
    // The owner may make a new one either way from the start.
    const made = await data<Category>('menu:createCategory', { name: 'Test Sweets', displayOrder: 5, colorHex: '#123456', noDiscount: true });
    expect(categoryRow(made.id)).toMatchObject({ no_discount: 1 });
  });

  it('a manager’s change is refused with the exact words, and nothing is written — an update either way, or a new category set against its name', async () => {
    h.session = MANAGER;
    const before = { drinks: categoryRow(menu.drinks), deals: categoryRow(menu.deals), cats: count('categories'), ...ledgers() };
    for (const [channel, payload] of [
      ['menu:updateCategory', { id: menu.drinks, noDiscount: true }],
      ['menu:updateCategory', { id: menu.deals, noDiscount: false }],
      ['menu:updateCategory', { id: menu.deals, name: 'Test Bundles', noDiscount: false }],
      ['menu:createCategory', { name: 'Test Sweets', displayOrder: 5, colorHex: '#123456', noDiscount: true }],
      ['menu:createCategory', { name: 'Test Combos', displayOrder: 6, colorHex: '#123456', noDiscount: false }],
    ] as const) {
      expect({ channel, payload, o: await call(channel, payload) }).toEqual({
        channel,
        payload,
        o: { ok: false, code: 'forbidden', message: OWNER_ONLY },
      });
    }
    expect({ drinks: categoryRow(menu.drinks), deals: categoryRow(menu.deals), cats: count('categories'), ...ledgers() }).toEqual(before);
  });

  it('a manager may rename or recolour a category, and may send the answer it already has (the dialog’s box left as it was)', async () => {
    h.session = MANAGER;
    await data('menu:updateCategory', { id: menu.drinks, name: 'Test cold drinks', colorHex: '#00aaaa', isActive: true });
    expect(categoryRow(menu.drinks)).toMatchObject({ name: 'Test cold drinks', color_hex: '#00aaaa', no_discount: null });
    // The same answer as now: Value Deals never, Drinks discounted — written as set, nothing changes what they do.
    await data('menu:updateCategory', { id: menu.deals, noDiscount: true, colorHex: '#aa00aa' });
    await data('menu:updateCategory', { id: menu.drinks, noDiscount: false });
    expect(categoryRow(menu.deals)).toMatchObject({ no_discount: 1, color_hex: '#aa00aa' });
    expect(categoryRow(menu.drinks)).toMatchObject({ no_discount: 0 });
    // A new one with its name's answer.
    const combos = await data<Category>('menu:createCategory', { name: 'Test Combos', displayOrder: 6, colorHex: '#123456', noDiscount: true });
    const plain = await data<Category>('menu:createCategory', { name: 'Test Wraps', displayOrder: 7, colorHex: '#123456' });
    expect([categoryRow(combos.id), categoryRow(plain.id)]).toEqual([
      expect.objectContaining({ no_discount: 1 }),
      expect.objectContaining({ no_discount: null }),
    ]);
    expect(categoryNeverDiscounted(plain)).toBe(false);
  });

  it('a cashier changes nothing about a category (Menu is a manager’s)', async () => {
    h.session = CASHIER;
    expect(await call('menu:updateCategory', { id: menu.deals, noDiscount: false })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(categoryRow(menu.deals)).toMatchObject({ no_discount: null, version: 1 });
  });

  it('a value that is not yes / no is refused before anything is written, the owner’s too', async () => {
    h.session = OWNER;
    const before = { deals: categoryRow(menu.deals), cats: count('categories'), ...ledgers() };
    for (const [channel, payload] of [
      ['menu:updateCategory', { id: menu.deals, noDiscount: 'no' }],
      ['menu:updateCategory', { id: menu.deals, noDiscount: 0 }],
      ['menu:updateCategory', { id: menu.deals, noDiscount: null }],
      ['menu:createCategory', { name: 'Test Sweets', displayOrder: 5, colorHex: '#123456', noDiscount: 1 }],
    ] as const) {
      expect({ channel, payload, o: await call(channel, payload) }).toEqual({
        channel,
        payload,
        o: { ok: false, code: 'validation_failed', message: 'Say whether its items are never discounted: yes or no' },
      });
    }
    expect({ deals: categoryRow(menu.deals), cats: count('categories'), ...ledgers() }).toEqual(before);
  });
});

live('a rename never changes discounts', () => {
  it('Value Deals renamed Bundles (by a manager) stays never discounted: the old answer is stored, synced and audited in the same write', async () => {
    h.session = MANAGER;
    const before = ledgers();
    const out = await data<Category>('menu:updateCategory', { id: menu.deals, name: 'Test Bundles' });
    expect(out.noDiscount).toBe(true);
    expect(categoryNeverDiscounted(out)).toBe(true);
    expect(categoryRow(menu.deals)).toMatchObject({ name: 'Test Bundles', no_discount: 1, version: 2 });
    expect(ledgers()).toEqual({ sync: before.sync + 1, audit: before.audit + 1 });
    expect(lastImage(menu.deals)).toMatchObject({ name: 'Test Bundles', noDiscount: 1 });
    expect(lastAudit(menu.deals)).toMatchObject({
      before: { name: 'Test Value Deals', noDiscount: null },
      after: { name: 'Test Bundles', noDiscount: true },
    });
  });

  it('the other way too: Test food renamed Test food deals keeps taking discounts (0 stored)', async () => {
    h.session = MANAGER;
    const out = await data<Category>('menu:updateCategory', { id: menu.food, name: 'Test food deals' });
    expect([out.noDiscount, categoryNeverDiscounted(out)]).toEqual([false, false]);
    expect(categoryRow(menu.food)).toMatchObject({ no_discount: 0 });
  });

  it('a rename the name answers alike for (Value Deals → Combo Deals) stores nothing: the name still decides', async () => {
    h.session = MANAGER;
    await data('menu:updateCategory', { id: menu.deals, name: 'Test Combo Deals' });
    await data('menu:updateCategory', { id: menu.drinks, name: 'Test soft drinks' });
    expect(categoryRow(menu.deals)).toMatchObject({ name: 'Test Combo Deals', no_discount: null });
    expect(categoryRow(menu.drinks)).toMatchObject({ name: 'Test soft drinks', no_discount: null });
  });

  it('a set value stays through any rename', async () => {
    h.session = OWNER;
    await data('menu:updateCategory', { id: menu.deals, noDiscount: false });
    h.session = MANAGER;
    await data('menu:updateCategory', { id: menu.deals, name: 'Test Deal of the Day' });
    expect(categoryRow(menu.deals)).toMatchObject({ name: 'Test Deal of the Day', no_discount: 0 });
  });
});

live('a menu file import and a fresh start', () => {
  const fileOf = (categories: Array<{ name: string }>, items: unknown[]) =>
    menuImportFileSchema.parse({ format: 'cheeseoclock-menu-import', version: 1, source: 'test', categories, ingredients: [], items });
  const deal = { name: 'Test Big Deal', category: 'Test Value Deals', priceCents: 360_000, recipe: [] };
  const pizza = { name: 'Test Pizza', category: 'Test food', priceCents: 150_000, recipe: [] };
  const drink = { name: 'Test Drink', category: 'Test drinks', priceCents: 15_000, recipe: [] };
  const allThree = [{ name: 'Test food' }, { name: 'Test drinks' }, { name: 'Test Value Deals' }];

  it('an ordinary import never changes a category’s mark (it never updates a category it has)', async () => {
    h.session = OWNER;
    await data('menu:updateCategory', { id: menu.deals, noDiscount: false });
    await data('menu:updateCategory', { id: menu.drinks, noDiscount: true });
    const rows = { food: categoryRow(menu.food), drinks: categoryRow(menu.drinks), deals: categoryRow(menu.deals) };
    const { applyMenuImport } = await import('../../db/repositories/menu-import-repo.js');
    applyMenuImport(
      db as never,
      fileOf(allThree, [
        { ...deal, priceCents: 370_000 },
        { ...pizza, priceCents: 155_000 },
        drink,
        { name: 'Test Wrap', category: 'Test food', priceCents: 45_000, recipe: [] },
      ]),
      'test.json',
      OWNER_ACTOR,
    );
    expect({ food: categoryRow(menu.food), drinks: categoryRow(menu.drinks), deals: categoryRow(menu.deals) }).toEqual(rows);
  });

  it('a fresh start: an explicit 0 on Value Deals and an explicit 1 on Drinks survive by name (another case, too), synced; the rest go by their names; the preview counts nothing', async () => {
    h.session = OWNER;
    await data('menu:updateCategory', { id: menu.deals, noDiscount: false });
    await data('menu:updateCategory', { id: menu.drinks, noDiscount: true });
    const { applyMenuImport, planMenuImportFromDb } = await import('../../db/repositories/menu-import-repo.js');
    const f = fileOf(
      [{ name: 'Test food' }, { name: 'TEST  DRINKS' }, { name: 'test value deals' }, { name: 'Test Combos' }],
      [
        pizza,
        { ...drink, category: 'TEST  DRINKS' },
        { ...deal, category: 'test value deals' },
        { name: 'Test Combo Box', category: 'Test Combos', priceCents: 260_000, recipe: [] },
      ],
    );
    expect(planMenuImportFromDb(db as never, f, { fresh: true }).preview.fresh).toMatchObject({ noDiscountSettingsLost: 0, websiteSettingsLost: 0 });
    applyMenuImport(db as never, f, 'test.json', OWNER_ACTOR, { fresh: true });
    const after = await byName();
    expect(after.get('test value deals')).toEqual({ noDiscount: false, never: false });
    expect(after.get('TEST  DRINKS')).toEqual({ noDiscount: true, never: true });
    expect(after.get('Test food')).toEqual({ noDiscount: null, never: false });
    expect(after.get('Test Combos')).toEqual({ noDiscount: null, never: true });
    // The removed rows are gone, and the carried value is the repositories' (the new row's sync image carries it).
    expect(db.prepare(`SELECT COUNT(*) AS n FROM categories WHERE id IN (?, ?) AND deleted_at IS NULL`).get(menu.deals, menu.drinks)).toEqual({ n: 0 });
    const newDrinks = db.prepare(`SELECT id FROM categories WHERE name = 'TEST  DRINKS' AND deleted_at IS NULL`).get() as { id: string };
    expect(lastImage(newDrinks.id)).toMatchObject({ noDiscount: 1 });
  });

  it('a fresh start with nothing set: the re-created Value Deals has nothing stored and reads never discounted (its name)', async () => {
    const { applyMenuImport, planMenuImportFromDb } = await import('../../db/repositories/menu-import-repo.js');
    const f = fileOf(allThree, [deal, pizza, drink]);
    expect(planMenuImportFromDb(db as never, f, { fresh: true }).preview.fresh).toMatchObject({ noDiscountSettingsLost: 0 });
    applyMenuImport(db as never, f, 'test.json', OWNER_ACTOR, { fresh: true });
    const row = db.prepare(`SELECT id, no_discount FROM categories WHERE name = 'Test Value Deals' AND deleted_at IS NULL`).get() as {
      id: string;
      no_discount: number | null;
    };
    expect(row.id).not.toBe(menu.deals);
    expect(row.no_discount).toBeNull();
    expect((await byName()).get('Test Value Deals')).toEqual({ noDiscount: null, never: true });
  });

  it('namesakes that answer differently carry nothing (never guessed) and the preview counts them; so does a set name the file does not bring back; namesakes that answer alike carry the set answer', async () => {
    h.session = OWNER;
    // Two "test drinks": one set never discounted, one going by its name (discounted) — they differ.
    await data('menu:updateCategory', { id: menu.drinks, noDiscount: true });
    await data('menu:createCategory', { name: 'TEST DRINKS', displayOrder: 5, colorHex: '#123456' });
    // Two "test value deals": one set never discounted, one by its name (never) — they agree.
    await data('menu:createCategory', { name: 'TEST VALUE DEALS', displayOrder: 6, colorHex: '#123456', noDiscount: true });
    // A set category the file does not bring back.
    await data('menu:createCategory', { name: 'Test Sweets', displayOrder: 7, colorHex: '#123456', noDiscount: true });
    const { applyMenuImport, planMenuImportFromDb } = await import('../../db/repositories/menu-import-repo.js');
    const f = fileOf(allThree, [deal, pizza, drink]);
    expect(planMenuImportFromDb(db as never, f, { fresh: true }).preview.fresh).toMatchObject({ noDiscountSettingsLost: 2, websiteSettingsLost: 0 });
    applyMenuImport(db as never, f, 'test.json', OWNER_ACTOR, { fresh: true });
    const after = await byName();
    expect(after.get('Test drinks')).toEqual({ noDiscount: null, never: false });
    expect(after.get('Test Value Deals')).toEqual({ noDiscount: true, never: true });
    expect(after.has('Test Sweets')).toBe(false);
    // The delivery charges' category stays as it was (a fresh start never removes it).
    expect(categoryRow(menu.fees)).toMatchObject({ no_discount: null, version: 1 });
  });
});
