/**
 * Settings → Delivery areas & fees → "Tax on the delivery charge" (owner,
 * 10 Oct 2026: "i want to setting to set delivery tax in settings").
 * Through the real IPC handlers and repositories on a real SQLite database
 * built from every migration:
 *   - reading the card writes nothing, and a till as today reads "the same
 *     as the food" — nothing changes until the owner saves;
 *   - Save moves every "Delivery Charge (Rs N)" item (switched-off ones too)
 *     onto the food's tax, no tax, or a rate of its own on ONE "Delivery
 *     charge tax" (made once, re-rated after) — synced and audited, in one
 *     transaction; the next delivery bill carries it, an open one keeps
 *     the tax its charge was sold at;
 *   - with the areas saved, the areas go again as they are (the website
 *     gets the charges with them); never saved, nothing is written to them;
 *   - a "Delivery charge tax" food is on too is never re-rated;
 *   - the owner alone: a cashier and a manager are refused both channels.
 *
 * Only `defineHandler` (captured), the signed-in session, the printer
 * spooler and the FBR worker are stood in for. node's own `node:sqlite`
 * stands in for better-sqlite3 (built for Electron); skipped where it is
 * missing. Every name, id and amount is made up.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DELIVERY_ZONES,
  type AuthenticatedUser,
  type DeliveryChargeTaxSaved,
  type DeliveryChargeTaxView,
  type DeliveryZoneSetting,
  type UUID,
} from '@cheeseoclock/shared-types';

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
// The website's word: counted, never sent anywhere here.
const website = vi.hoisted(() => ({ told: 0 }));
vi.mock('../../services/website-settings-events.js', () => ({
  websiteSettingsChanged: () => {
    website.told += 1;
  },
  onWebsiteSettingsChanged: () => () => {},
}));

interface Stmt {
  run(...p: unknown[]): unknown;
  all(...p: unknown[]): Array<Record<string, unknown>>;
  get(...p: unknown[]): Record<string, unknown> | undefined;
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
}
const Sqlite = (() => {
  try {
    return (
      createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => RawDb }
    ).DatabaseSync;
  } catch {
    return null;
  }
})();
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'db', 'migrations');

function openMigrated() {
  const raw = new Sqlite!(':memory:');
  for (const f of readdirSync(MIGRATIONS)
    .filter((x) => x.endsWith('.sql'))
    .sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  raw.exec('PRAGMA foreign_keys = ON');
  let depth = 0;
  return {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction:
      <A extends unknown[], R>(fn: (...args: A) => R) =>
      (...args: A): R => {
        const sp = `sp_${depth}`;
        raw.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
        depth += 1;
        try {
          const out = fn(...args);
          depth -= 1;
          raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
          return out;
        } catch (e) {
          depth -= 1;
          if (depth === 0) raw.exec('ROLLBACK');
          else raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
          throw e;
        }
      },
  };
}

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
/** Today's menu: food at 16% (8% by card) and the menu file's two delivery charges on the same tax. */
let menu: { pizza: string; side: string; fees: string; tax: string; d200: string; d250: string };

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

async function seedTill(d: Db): Promise<typeof menu> {
  const user = d.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_admin', 'Test Owner', 'admin', T0, T0, DEV);
  user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
  user.run('u_mgr', 'Test Manager', 'manager', T0, T0, DEV);
  const x = d as never;
  const mgr = { userId: 'u_mgr', deviceId: DEV };
  const { openShift } = await import('../../db/repositories/shift-repo.js');
  const { createTaxCategory } = await import('../../db/repositories/tax-category-repo.js');
  const { createCategory } = await import('../../db/repositories/category-repo.js');
  const { createMenuItem } = await import('../../db/repositories/menu-item-repo.js');
  openShift(x, { openingCashCents: 0, notes: null }, mgr);
  const tax = createTaxCategory(x, { name: 'Test GST', rateBps: 1_600, digitalRateBps: 800 }, mgr);
  const food = createCategory(x, { name: 'Test food', displayOrder: 1, colorHex: '#aa5500' }, mgr);
  const fees = createCategory(x, { name: 'Delivery Charges', displayOrder: 2, colorHex: '#555555' }, mgr);
  const item = (categoryId: string, name: string, cents: number) =>
    createMenuItem(x, { categoryId, name, basePriceCents: cents, taxCategoryId: tax.id }, mgr).id;
  return {
    pizza: item(food.id, 'Test Pizza', 100_000),
    side: item(food.id, 'Test Side', 50_000),
    d200: item(fees.id, 'Delivery Charge (Rs 200)', 20_000),
    d250: item(fees.id, 'Delivery Charge (Rs 250)', 25_000),
    fees: fees.id,
    tax: tax.id,
  };
}

beforeEach(async () => {
  if (!Sqlite) return;
  h.handlers.clear();
  h.session = null;
  website.told = 0;
  db = openMigrated();
  menu = await seedTill(db);
  const ctx = { db, deviceId: DEV } as never;
  (await import('./orders-handlers.js')).registerOrdersHandlers(ctx);
  (await import('./settings-handlers.js')).registerSettingsHandlers(ctx);
  (await import('./menu-handlers.js')).registerMenuHandlers(ctx);
  (await import('./customers-handlers.js')).registerCustomersHandlers(ctx);
});

const read = () => {
  h.session = OWNER;
  return data<DeliveryChargeTaxView>('settings:deliveryChargeTax');
};
const saveTax = (choice: unknown) => {
  h.session = OWNER;
  return call('settings:saveDeliveryChargeTax', { choice });
};
const saved = async (choice: unknown): Promise<DeliveryChargeTaxSaved> => {
  const o = await saveTax(choice);
  if (!o.ok) throw new Error(`refused: ${o.code} ${o.message}`);
  return o.data as DeliveryChargeTaxSaved;
};
const taxOf = (itemId: string) =>
  db
    .prepare(
      `SELECT tc.name, tc.rate_bps, tc.digital_rate_bps FROM menu_items mi JOIN tax_categories tc ON tc.id = mi.tax_category_id WHERE mi.id = ?`,
    )
    .get(itemId);
const chargeTaxes = () =>
  db
    .prepare(`SELECT id, name, rate_bps, digital_rate_bps FROM tax_categories WHERE deleted_at IS NULL AND name = 'Delivery charge tax'`)
    .all();
const writtenRows = () =>
  Object.fromEntries(
    ['audit_log', 'sync_queue', 'business_settings', 'menu_items', 'tax_categories'].map((t) => [
      t,
      db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.['n'],
    ]),
  );
const zonesRow = () =>
  db.prepare(`SELECT version, value_json FROM business_settings WHERE key = 'delivery.zones' AND deleted_at IS NULL`).get();
const allZones = (): DeliveryZoneSetting[] =>
  DEFAULT_DELIVERY_ZONES.zones.map((z) => ({ ...z, aliases: [...z.aliases], hints: [...z.hints] }));

/** A delivery to DHA Phase 6 (the Rs 200 charge) with a Rs 1,000 pizza: its subtotal and tax. */
async function phase6Order(): Promise<{ id: string; totals: () => Record<string, unknown> | undefined }> {
  h.session = CASHIER;
  const order = await data<{ id: string }>('orders:create', { mode: 'delivery' });
  await data('orders:addItem', { orderId: order.id, menuItemId: menu.pizza, quantity: 1 });
  await data('orders:setDeliveryArea', { orderId: order.id, area: 'DHA Phase 6' });
  return {
    id: order.id,
    totals: () => db.prepare(`SELECT subtotal_cents, tax_cents FROM orders WHERE id = ?`).get(order.id),
  };
}

// ---------------------------------------------------------------------------

describe.skipIf(!Sqlite)('Tax on the delivery charge: what the card reads', () => {
  it('a till as today reads “the same as the food” — both charges on the food’s 16% (8% by card); reading writes nothing', async () => {
    const before = writtenRows();
    const v = await read();
    expect(v.now).toEqual({ kind: 'food' });
    expect(v.food).toEqual({ id: menu.tax, name: 'Test GST', rateBps: 1_600, digitalRateBps: 800 });
    expect(v.charges.map((c) => [c.name, c.feeCents, c.isActive, c.tax.id])).toEqual([
      ['Delivery Charge (Rs 200)', 20_000, true, menu.tax],
      ['Delivery Charge (Rs 250)', 25_000, true, menu.tax],
    ]);
    // The areas were never saved here: the website takes a change with the next Publish.
    expect(v.website).toBe('publish');
    expect(writtenRows()).toEqual(before);
  });

  it('charges put on different taxes in Menu: no one choice (the owner picks); a switched-off old fee does not count', async () => {
    const { createTaxCategory } = await import('../../db/repositories/tax-category-repo.js');
    const zero = createTaxCategory(db as never, { name: 'Test zero', rateBps: 0 }, OWNER_ACTOR);
    db.prepare(`UPDATE menu_items SET tax_category_id = ? WHERE id = ?`).run(zero.id, menu.d250);
    expect((await read()).now).toBeNull();
    db.prepare(`UPDATE menu_items SET is_active = 0 WHERE id = ?`).run(menu.d250);
    expect((await read()).now).toEqual({ kind: 'food' });
  });
});

describe.skipIf(!Sqlite)('Tax on the delivery charge: Save', () => {
  it('“No tax”: both charges move to “Delivery charge tax” at 0% — made once, synced (the tax before the items) and audited; the next delivery bill has no tax on its charge', async () => {
    const s = await saved({ kind: 'none' });
    expect(s).toMatchObject({ changed: true, itemsChanged: 2, sentToWebsite: false, view: { now: { kind: 'none' }, website: 'publish' } });
    const [own] = chargeTaxes();
    expect(own).toMatchObject({ rate_bps: 0, digital_rate_bps: null });
    for (const id of [menu.d200, menu.d250]) expect(taxOf(id)).toEqual({ name: 'Delivery charge tax', rate_bps: 0, digital_rate_bps: null });
    // The food keeps its tax.
    expect(taxOf(menu.pizza)).toMatchObject({ name: 'Test GST', rate_bps: 1_600 });
    // Synced: the new tax first, then the two items; audited the same.
    const queued = db
      .prepare(`SELECT entity_type, entity_id FROM sync_queue ORDER BY rowid DESC LIMIT 3`)
      .all()
      .reverse()
      .map((r) => [r['entity_type'], r['entity_id']]);
    expect(queued).toEqual([
      ['tax_categories', own!['id']],
      ['menu_items', menu.d200],
      ['menu_items', menu.d250],
    ]);
    const audited = db
      .prepare(`SELECT entity_type, action, actor_user_id FROM audit_log ORDER BY rowid DESC LIMIT 3`)
      .all()
      .reverse();
    expect(audited).toEqual([
      { entity_type: 'tax_categories', action: 'create', actor_user_id: 'u_admin' },
      { entity_type: 'menu_items', action: 'update', actor_user_id: 'u_admin' },
      { entity_type: 'menu_items', action: 'update', actor_user_id: 'u_admin' },
    ]);
    // Never saved areas: nothing written to them, the website not told (the next Publish takes it).
    expect(zonesRow()).toBeUndefined();
    expect(website.told).toBe(0);
    // Rs 1,000 pizza + Rs 200 charge: 16% of the food only.
    const o = await phase6Order();
    expect(o.totals()).toEqual({ subtotal_cents: 120_000, tax_cents: 16_000 });
  });

  it('a rate of its own, then another: the SAME “Delivery charge tax” re-rated (never a second one); the bill follows', async () => {
    await saved({ kind: 'none' });
    const s = await saved({ kind: 'rate', rateBps: 500, digitalRateBps: null });
    expect(s).toMatchObject({ changed: true, itemsChanged: 0, view: { now: { kind: 'rate', rateBps: 500, digitalRateBps: null } } });
    expect(chargeTaxes()).toHaveLength(1);
    expect(taxOf(menu.d200)).toEqual({ name: 'Delivery charge tax', rate_bps: 500, digital_rate_bps: null });
    // Rs 1,000 at 16% + Rs 200 at 5%.
    expect((await phase6Order()).totals()).toEqual({ subtotal_cents: 120_000, tax_cents: 17_000 });
    // With a card rate: kept; the same as the rate is "none".
    await saved({ kind: 'rate', rateBps: 1_000, digitalRateBps: 300 });
    expect(chargeTaxes()).toEqual([expect.objectContaining({ rate_bps: 1_000, digital_rate_bps: 300 })]);
    expect((await read()).now).toEqual({ kind: 'rate', rateBps: 1_000, digitalRateBps: 300 });
    await saved({ kind: 'rate', rateBps: 1_000, digitalRateBps: 1_000 });
    expect(chargeTaxes()).toEqual([expect.objectContaining({ rate_bps: 1_000, digital_rate_bps: null })]);
  });

  it('back to “the same as the food”: the charges on the food’s tax again; nothing changed when they already are', async () => {
    await saved({ kind: 'rate', rateBps: 500, digitalRateBps: null });
    const s = await saved({ kind: 'food' });
    expect(s).toMatchObject({ changed: true, itemsChanged: 2, view: { now: { kind: 'food' } } });
    expect(taxOf(menu.d250)).toMatchObject({ name: 'Test GST', rate_bps: 1_600, digital_rate_bps: 800 });
    // Rs 1,000 + Rs 200, both at 16%.
    expect((await phase6Order()).totals()).toEqual({ subtotal_cents: 120_000, tax_cents: 19_200 });
    const before = writtenRows();
    expect(await saved({ kind: 'food' })).toMatchObject({ changed: false, itemsChanged: 0, sentToWebsite: false });
    expect(writtenRows()).toEqual(before);
  });

  it('an order already open keeps the tax its charge was sold at; the next one takes the new tax', async () => {
    const open = await phase6Order();
    expect(open.totals()).toEqual({ subtotal_cents: 120_000, tax_cents: 19_200 });
    await saved({ kind: 'none' });
    // Another item on the open bill: the charge line still carries its 16%.
    h.session = CASHIER;
    await data('orders:addItem', { orderId: open.id, menuItemId: menu.side, quantity: 1 });
    expect(open.totals()).toEqual({ subtotal_cents: 170_000, tax_cents: 27_200 });
    expect((await phase6Order()).totals()).toEqual({ subtotal_cents: 120_000, tax_cents: 16_000 });
  });

  it('every charge item moves, a switched-off old fee too', async () => {
    db.prepare(`UPDATE menu_items SET is_active = 0 WHERE id = ?`).run(menu.d250);
    expect(await saved({ kind: 'none' })).toMatchObject({ itemsChanged: 2 });
    expect(taxOf(menu.d250)).toMatchObject({ rate_bps: 0 });
  });

  it('with the areas saved: they go again AS THEY ARE (the website gets the charges with them), in the same transaction', async () => {
    h.session = OWNER;
    await data('settings:saveDeliveryZones', { zones: allZones() });
    const before = zonesRow()!;
    website.told = 0;
    const s = await saved({ kind: 'rate', rateBps: 500, digitalRateBps: null });
    expect(s).toMatchObject({ changed: true, itemsChanged: 2, sentToWebsite: true, view: { website: 'itself' } });
    const after = zonesRow()!;
    expect(after['version']).toBe(Number(before['version']) + 1);
    expect(JSON.parse(String(after['value_json']))).toEqual(JSON.parse(String(before['value_json'])));
    expect(website.told).toBe(1);
    // The charges stay the areas' (on, at their fees) and carry the new tax.
    for (const id of [menu.d200, menu.d250]) {
      expect(db.prepare(`SELECT is_active FROM menu_items WHERE id = ?`).get(id)).toEqual({ is_active: 1 });
      expect(taxOf(id)).toMatchObject({ rate_bps: 500 });
    }
    // Nothing changed: the areas are not saved again.
    website.told = 0;
    expect(await saved({ kind: 'rate', rateBps: 500, digitalRateBps: null })).toMatchObject({ changed: false, sentToWebsite: false });
    expect(zonesRow()!['version']).toBe(after['version']);
    expect(website.told).toBe(0);
  });

  it('a new fee saved afterwards: its new charge item copies the charges’ tax, not the food’s', async () => {
    h.session = OWNER;
    await data('settings:saveDeliveryZones', { zones: allZones() });
    await saved({ kind: 'none' });
    h.session = OWNER;
    await data('settings:saveDeliveryZones', {
      zones: allZones().map((z) => (z.id === 'dha-8' ? { ...z, feeCents: 30_000 } : z)),
    });
    const v = await read();
    expect(v.charges.map((c) => [c.feeCents, c.tax.rateBps])).toEqual([
      [20_000, 0],
      [25_000, 0],
      [30_000, 0],
    ]);
    expect(v.now).toEqual({ kind: 'none' });
  });

  it('a “Delivery charge tax” that food is on too is never re-rated: refused at other rates, used as it is at the same', async () => {
    const { createTaxCategory } = await import('../../db/repositories/tax-category-repo.js');
    const theirs = createTaxCategory(db as never, { name: 'Delivery charge tax', rateBps: 300 }, OWNER_ACTOR);
    db.prepare(`UPDATE menu_items SET tax_category_id = ? WHERE id = ?`).run(theirs.id, menu.side);
    const before = writtenRows();
    expect(await saveTax({ kind: 'none' })).toEqual({
      ok: false,
      code: 'validation_failed',
      message:
        'Menu items other than the delivery charges are on the tax “Delivery charge tax” — put them on another tax in Menu first, or pick “The same as the food”.',
    });
    expect(writtenRows()).toEqual(before);
    expect(await saved({ kind: 'rate', rateBps: 300, digitalRateBps: null })).toMatchObject({ changed: true, itemsChanged: 2 });
    expect(chargeTaxes()).toEqual([expect.objectContaining({ id: theirs.id, rate_bps: 300 })]);
  });

  it('no charge item at all: nothing to do, nothing written', async () => {
    db.prepare(`UPDATE menu_items SET deleted_at = ? WHERE id IN (?, ?)`).run(T0, menu.d200, menu.d250);
    const before = writtenRows();
    expect(await saved({ kind: 'none' })).toMatchObject({ changed: false, itemsChanged: 0, view: { now: null, charges: [] } });
    expect(writtenRows()).toEqual(before);
  });

  it('a value the card would never send is refused in the schema’s words, nothing written', async () => {
    const before = writtenRows();
    expect(await saveTax({ kind: 'rate', rateBps: 15_000, digitalRateBps: null })).toEqual({
      ok: false,
      code: 'validation_failed',
      message: 'The tax on the delivery charge cannot be above 100%',
    });
    expect(await saveTax({ kind: 'half' })).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(await call('settings:saveDeliveryChargeTax', { choice: { kind: 'none' }, extra: 1 })).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
    expect(writtenRows()).toEqual(before);
  });

  it('the owner alone: a cashier and a manager are refused both channels, and nothing is written', async () => {
    const before = writtenRows();
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      expect(await call('settings:deliveryChargeTax')).toMatchObject({ ok: false, code: 'forbidden' });
      expect(await call('settings:saveDeliveryChargeTax', { choice: { kind: 'none' } })).toMatchObject({ ok: false, code: 'forbidden' });
    }
    h.session = null;
    expect(await call('settings:deliveryChargeTax')).toMatchObject({ ok: false, code: 'unauthenticated' });
    expect(writtenRows()).toEqual(before);
  });
});
