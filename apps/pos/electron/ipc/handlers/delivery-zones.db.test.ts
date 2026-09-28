/**
 * Settings step 3 — the delivery areas and fees are the owner's
 * (Settings → Delivery areas, 'delivery.zones'), and the owner, 28 Sep 2026:
 * "if delvery area selected the delivery fee should be autoamtcally added
 * also the delvery fee should be editable in settings". Through the real
 * IPC handlers and repositories on a real SQLite database built from every
 * migration:
 *   - Save (settings:saveDeliveryZones): the setting AND its fee items in
 *     one transaction — today's Rs 200 and Rs 250 items adopted (ids kept),
 *     a new fee's item made with a name-based id (the same row on two tills
 *     saving offline), an item no area charges switched off, never deleted;
 *     an area is never removed; a rename keeps the old name;
 *   - Menu can't change what makes an item a fee, nor hide its category;
 *     the menu file import leaves the charges alone, a fresh start too;
 *   - the delivery charge follows the area on the till, in the main
 *     process: added, swapped, taken off, never twice; never on foodpanda
 *     or a website order; nothing for an area switched off;
 *   - a fee line is still told apart for the v0.7.26 rule (a discount never
 *     comes off it), by the name it was sold under — even an item an older
 *     till renamed is sold under a delivery-charge name.
 *
 * Only `defineHandler` (captured), the signed-in session, the printer
 * spooler and the FBR worker are stood in for. node's own `node:sqlite`
 * stands in for better-sqlite3 (built for Electron); skipped where it is
 * missing. Every name, id and amount is made up.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { v5 as uuidv5 } from 'uuid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COC_ID_NAMESPACE,
  DEFAULT_DELIVERY_ZONES,
  DELIVERY_ZONES,
  FEE_ITEM_LOCKED_NOTE,
  isDeliveryChargeName,
  type AuthenticatedUser,
  type CheckoutRules,
  type DeliveryZoneSetting,
  type OrderSnapshot,
  type UUID,
  type WebOrder,
} from '@cheeseoclock/shared-types';
import { menuImportFileSchema } from '@cheeseoclock/shared-schemas';

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
/** Today's menu, as the menu file import made it: food and the two delivery charges. */
let menu: {
  pizza: string;
  side: string;
  fees: string;
  food: string;
  tax: string;
  d200: string;
  d250: string;
};

type Outcome = { ok: true; data: unknown } | { ok: false; code: string; message: string };

async function call(channel: string, payload?: unknown): Promise<Outcome> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  try {
    const r = (await fn({ db, deviceId: DEV }, payload)) as
      | { ok: true; data: unknown }
      | { ok: false; error: { code: string; message: string } };
    return r.ok
      ? { ok: true, data: r.data }
      : { ok: false, code: r.error.code, message: r.error.message };
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

/** Seed a till as today: users, a shift, the tax, food and the menu file's two delivery charges. */
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
  const tax = createTaxCategory(x, { name: 'Test GST', rateBps: 1_600 }, mgr);
  const food = createCategory(x, { name: 'Test food', displayOrder: 1, colorHex: '#aa5500' }, mgr);
  const fees = createCategory(
    x,
    { name: 'Delivery Charges', displayOrder: 2, colorHex: '#555555' },
    mgr,
  );
  const item = (
    categoryId: string,
    name: string,
    cents: number,
    description: string | null = null,
  ) =>
    createMenuItem(
      x,
      { categoryId, name, basePriceCents: cents, taxCategoryId: tax.id, description },
      mgr,
    ).id;
  return {
    pizza: item(food.id, 'Test Pizza', 100_000),
    side: item(food.id, 'Test Side', 50_000),
    d200: item(fees.id, 'Delivery Charge (Rs 200)', 20_000, 'Made-up areas at the lower fee.'),
    d250: item(fees.id, 'Delivery Charge (Rs 250)', 25_000, 'Made-up areas at the higher fee.'),
    fees: fees.id,
    food: food.id,
    tax: tax.id,
  };
}

beforeEach(async () => {
  if (!Sqlite) return;
  h.handlers.clear();
  h.session = null;
  db = openMigrated();
  menu = await seedTill(db);
  const ctx = { db, deviceId: DEV } as never;
  (await import('./orders-handlers.js')).registerOrdersHandlers(ctx);
  (await import('./settings-handlers.js')).registerSettingsHandlers(ctx);
  (await import('./menu-handlers.js')).registerMenuHandlers(ctx);
});

/** The released areas as the owner's screen sends them, changed where asked. */
const zones = (change: (z: DeliveryZoneSetting) => DeliveryZoneSetting = (z) => z) =>
  DEFAULT_DELIVERY_ZONES.zones.map((z) =>
    change({ ...z, aliases: [...z.aliases], hints: [...z.hints] }),
  );
async function save(list: DeliveryZoneSetting[]): Promise<Outcome> {
  h.session = OWNER;
  return call('settings:saveDeliveryZones', { zones: list });
}
const savedZones = (): DeliveryZoneSetting[] => {
  const row = db
    .prepare(
      `SELECT value_json FROM business_settings WHERE key = 'delivery.zones' AND deleted_at IS NULL`,
    )
    .get();
  return row
    ? (JSON.parse(String(row['value_json'])) as { zones: DeliveryZoneSetting[] }).zones
    : [];
};
const itemRow = (id: string) =>
  db
    .prepare(
      `SELECT id, name, base_price_cents, is_active, deleted_at, category_id, tax_category_id FROM menu_items WHERE id = ?`,
    )
    .get(id);
const fee300 = () => uuidv5('delivery-charge:30000', COC_ID_NAMESPACE);
const writtenRows = () =>
  Object.fromEntries(
    ['audit_log', 'sync_queue', 'business_settings', 'menu_items', 'categories'].map((t) => [
      t,
      db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.['n'],
    ]),
  );

// ---------------------------------------------------------------------------

describe.skipIf(!Sqlite)('Settings → Delivery areas: what a till with nothing saved uses', () => {
  it('today’s 21 areas and fees exactly — DHA Phase 8 at Rs 250 — for the counter too; nothing is written', async () => {
    const before = writtenRows();
    h.session = CASHIER;
    const rules = await data<CheckoutRules>('checkout:getRules');
    expect(rules.delivery?.zones).toEqual(DEFAULT_DELIVERY_ZONES.zones);
    expect(rules.delivery?.zones.map((z) => [z.id, z.feeCents])).toEqual(
      DELIVERY_ZONES.map((z) => [z.id, z.feeCents]),
    );
    expect(rules.delivery?.zones.find((z) => z.id === 'dha-8')?.feeCents).toBe(25_000);
    expect(writtenRows()).toEqual(before);
  });
});

describe.skipIf(!Sqlite)('Settings → Delivery areas: Save', () => {
  it('the first Save adopts today’s Rs 200 and Rs 250 items (their ids kept) and points every area at one — in ONE transaction, synced (items before the setting) and audited', async () => {
    const o = await save(zones());
    expect(o).toMatchObject({ ok: true, data: { key: 'delivery.zones' } });
    const saved = savedZones();
    expect(saved.map((z) => z.id)).toEqual(DELIVERY_ZONES.map((z) => z.id));
    for (const z of saved)
      expect({ id: z.id, item: z.feeItemId }).toEqual({
        id: z.id,
        item: z.feeCents === 20_000 ? menu.d200 : menu.d250,
      });
    // The items: the same rows, on, at their fees, under their names — no new item.
    expect(itemRow(menu.d200)).toMatchObject({
      name: 'Delivery Charge (Rs 200)',
      base_price_cents: 20_000,
      is_active: 1,
      deleted_at: null,
    });
    expect(itemRow(menu.d250)).toMatchObject({
      name: 'Delivery Charge (Rs 250)',
      base_price_cents: 25_000,
      is_active: 1,
      deleted_at: null,
    });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM menu_items WHERE deleted_at IS NULL`).get()?.['n'],
    ).toBe(4);
    // Synced: the adopted items (their description now says where fees live) go before the setting that points at them.
    const queue = db
      .prepare(`SELECT entity_type, entity_id FROM sync_queue ORDER BY created_at, rowid`)
      .all();
    const settingAt = queue.findIndex((q) => q['entity_type'] === 'business_settings');
    const itemsAt = queue
      .map((q, i) =>
        q['entity_type'] === 'menu_items' && [menu.d200, menu.d250].includes(String(q['entity_id']))
          ? i
          : -1,
      )
      .filter((i) => i >= 0);
    expect(settingAt).toBeGreaterThan(Math.max(...itemsAt));
    // Audited, with the owner as the actor.
    expect(
      db
        .prepare(
          `SELECT actor_user_id FROM audit_log WHERE entity_type = 'business_settings' ORDER BY rowid DESC LIMIT 1`,
        )
        .get(),
    ).toEqual({ actor_user_id: 'u_admin' });
    // The counter now names each area's item.
    h.session = CASHIER;
    const rules = await data<CheckoutRules>('checkout:getRules');
    expect(rules.delivery?.zones.find((z) => z.id === 'dha-8')?.feeItemId).toBe(menu.d250);
  });

  it('a new fee makes “Delivery Charge (Rs 300)” with the fee’s name-based id; the Rs 250 item stays on (Emaar, Creek Vista, Clifton 1–2 still charge it)', async () => {
    const o = await save(zones((z) => (z.id === 'dha-8' ? { ...z, feeCents: 30_000 } : z)));
    expect(o.ok).toBe(true);
    expect(itemRow(fee300())).toMatchObject({
      name: 'Delivery Charge (Rs 300)',
      base_price_cents: 30_000,
      is_active: 1,
      deleted_at: null,
      category_id: menu.fees,
      tax_category_id: menu.tax,
    });
    expect(savedZones().find((z) => z.id === 'dha-8')?.feeItemId).toBe(fee300());
    expect(itemRow(menu.d250)).toMatchObject({ is_active: 1 });
    expect(savedZones().find((z) => z.id === 'emaar')?.feeItemId).toBe(menu.d250);
  });

  it('two tills saving offline make the SAME Rs 300 row (the link settles it by last write, never two items)', async () => {
    const { saveDeliveryZones, deliveryChargeItemId } =
      await import('../../db/repositories/delivery-zones-repo.js');
    const tillB = openMigrated();
    await seedTill(tillB);
    const list = zones((z) => (z.id === 'dha-8' ? { ...z, feeCents: 30_000 } : z));
    saveDeliveryZones(db as never, { zones: list }, OWNER_ACTOR);
    saveDeliveryZones(
      tillB as never,
      { zones: list },
      { userId: 'u_admin', deviceId: 'dev-till-2' },
    );
    expect(deliveryChargeItemId(30_000)).toBe(fee300());
    for (const d of [db, tillB]) {
      expect(
        d
          .prepare(
            `SELECT id FROM menu_items WHERE name = 'Delivery Charge (Rs 300)' AND deleted_at IS NULL`,
          )
          .all(),
      ).toEqual([{ id: fee300() }]);
      expect(
        d
          .prepare(
            `SELECT entity_id FROM sync_queue WHERE entity_type = 'menu_items' AND entity_id = ?`,
          )
          .get(fee300()),
      ).toBeTruthy();
    }
  });

  it('an item no area charges any more is switched off, never deleted — and a website order placed at that fee still imports', async () => {
    await save(zones());
    const o = await save(zones((z) => (z.feeCents === 25_000 ? { ...z, feeCents: 30_000 } : z)));
    expect(o.ok).toBe(true);
    expect(itemRow(menu.d250)).toMatchObject({ is_active: 0, deleted_at: null });
    // The audit says who switched it off.
    expect(
      db
        .prepare(
          `SELECT actor_user_id, action FROM audit_log WHERE entity_type = 'menu_items' AND entity_id = ? ORDER BY rowid DESC LIMIT 1`,
        )
        .get(menu.d250),
    ).toEqual({ actor_user_id: 'u_admin', action: 'update' });
    // A web order the customer placed at Rs 250 a moment before the Save: the till still takes it in.
    const orderId = await importWebOrder(
      webOrder('web-old-fee', [
        [menu.pizza, 1, 100_000],
        [menu.d250, 1, 25_000],
      ]),
    );
    const lines = (await snap(orderId)).items.map((i) => [i.menuItemName, i.unitPriceCents]);
    expect(lines).toEqual([
      ['Test Pizza', 100_000],
      ['Delivery Charge (Rs 250)', 25_000],
    ]);
  });

  it('an area is never removed: a Save that leaves one out is refused and writes nothing (not the setting, not an item)', async () => {
    await save(zones());
    const before = writtenRows();
    const o = await save(zones().filter((z) => z.id !== 'dha-8'));
    expect(o).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(o.ok ? '' : o.message).toMatch(/DHA Phase 8/);
    // …nor one the owner added and saved.
    const pechs: DeliveryZoneSetting = {
      id: 'pechs-6',
      name: 'PECHS Block 6',
      shortName: 'Block 6',
      group: 'PECHS',
      feeCents: 30_000,
      feeItemId: null,
      active: true,
      aliases: ['pechs 6'],
      hints: [],
    };
    expect((await save([...zones(), pechs])).ok).toBe(true);
    const mid = writtenRows();
    expect((await save(zones())).ok).toBe(false);
    expect(writtenRows()).toEqual(mid);
    expect(before['menu_items']).toBeLessThanOrEqual(Number(mid['menu_items']));
  });

  it('a rename keeps the old name as a spelling: an address saved under it is still that area (Customers’ filter, the till’s reader)', async () => {
    const { createCustomer, createAddress, pageCustomers } =
      await import('../../db/repositories/customer-repo.js');
    const c = createCustomer(
      db as never,
      { name: 'Test Regular', phone: '03001112233' },
      OWNER_ACTOR,
    );
    createAddress(
      db as never,
      { customerId: c.id, label: 'Home', addressLine: 'Villa 1', area: 'Emaar Crescent Bay (DHA)' },
      OWNER_ACTOR,
    );
    const o = await save(
      zones((z) =>
        z.id === 'emaar'
          ? { ...z, name: 'Emaar Oceanfront', aliases: [...z.aliases, 'Emaar Crescent Bay (DHA)'] }
          : z,
      ),
    );
    expect(o.ok).toBe(true);
    expect(savedZones().find((z) => z.id === 'emaar')).toMatchObject({
      id: 'emaar',
      name: 'Emaar Oceanfront',
    });
    expect(pageCustomers(db as never, { zoneIds: ['emaar'] }).rows.map((r) => r.name)).toEqual([
      'Test Regular',
    ]);
    // The till's charge follows it too.
    h.session = CASHIER;
    const order = await data<{ id: string }>('orders:create', { mode: 'delivery' });
    const s = await data<OrderSnapshot>('orders:setDeliveryArea', {
      orderId: order.id,
      area: 'Emaar Crescent Bay (DHA)',
    });
    expect(s.items.map((i) => i.menuItemId)).toEqual([menu.d250]);
  });

  it('“Put back the default”: today’s 21 areas and fees; an area the owner added stays, switched off', async () => {
    const pechs: DeliveryZoneSetting = {
      id: 'pechs-6',
      name: 'PECHS Block 6',
      shortName: 'Block 6',
      group: 'PECHS',
      feeCents: 30_000,
      feeItemId: null,
      active: true,
      aliases: [],
      hints: [],
    };
    expect(
      (await save([...zones((z) => (z.id === 'dha-8' ? { ...z, feeCents: 40_000 } : z)), pechs]))
        .ok,
    ).toBe(true);
    h.session = OWNER;
    const o = await call('settings:saveDeliveryZones', { useDefault: true });
    // The card reads "Default" again: what "Put back" writes (the added area kept, off) is the default now.
    expect(o).toMatchObject({ ok: true, data: { isDefault: true } });
    const saved = savedZones();
    expect(saved.slice(0, 21).map((z) => [z.id, z.feeCents, z.active])).toEqual(
      DELIVERY_ZONES.map((z) => [z.id, z.feeCents, true]),
    );
    expect(saved[21]).toMatchObject({ id: 'pechs-6', active: false });
  });

  it('a cashier and a manager are refused, and nothing is written (the setting AND the menu)', async () => {
    const before = writtenRows();
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      for (const payload of [
        { zones: zones((z) => ({ ...z, feeCents: 99_900 })) },
        { useDefault: true },
      ]) {
        expect(await call('settings:saveDeliveryZones', payload)).toMatchObject({
          ok: false,
          code: 'forbidden',
        });
      }
    }
    expect(writtenRows()).toEqual(before);
  });
});

describe.skipIf(!Sqlite)('Settings → Delivery areas: Save, the fee items it leaves behind', () => {
  it('the FIRST Save that moves every Rs 250 area to Rs 300 switches today’s Rs 250 item off — no stale charge left for a cashier to tap on beside the Rs 300', async () => {
    // Nothing saved yet: the areas charge today's items by name and price.
    const o = await save(zones((z) => (z.feeCents === 25_000 ? { ...z, feeCents: 30_000 } : z)));
    expect(o.ok).toBe(true);
    expect(itemRow(menu.d250)).toMatchObject({ is_active: 0, deleted_at: null });
    expect(itemRow(menu.d200)).toMatchObject({ is_active: 1 });
    expect(itemRow(fee300())).toMatchObject({ is_active: 1, base_price_cents: 30_000 });
    // At the counter: Phase 8 puts Rs 300 on by itself, and the old Rs 250 can't be tapped on too.
    h.session = CASHIER;
    const order = await data<{ id: string }>('orders:create', { mode: 'delivery' });
    await data('orders:addItem', { orderId: order.id, menuItemId: menu.pizza, quantity: 1 });
    const s = await data<OrderSnapshot>('orders:setDeliveryArea', { orderId: order.id, area: 'DHA Phase 8' });
    expect(s.items.map((i) => [i.menuItemId, i.unitPriceCents])).toEqual([
      [menu.pizza, 100_000],
      [fee300(), 30_000],
    ]);
    expect(await call('orders:addItem', { orderId: order.id, menuItemId: menu.d250, quantity: 1 })).toMatchObject({ ok: false });
    // A second Save leaves it off (and never deletes it).
    expect((await save(savedZones())).ok).toBe(true);
    expect(itemRow(menu.d250)).toMatchObject({ is_active: 0, deleted_at: null });
  });

  it('every fee raised at once: the new items keep the tax the delivery charges had, not the food’s', async () => {
    const { createTaxCategory } = await import('../../db/repositories/tax-category-repo.js');
    const zero = createTaxCategory(db as never, { name: 'Test no tax', rateBps: 0 }, OWNER_ACTOR);
    // The owner had put the charges on their own tax in Menu (an item's tax is not locked).
    db.prepare(`UPDATE menu_items SET tax_category_id = ? WHERE id IN (?, ?)`).run(zero.id, menu.d200, menu.d250);
    const o = await save(
      zones((z) => ({ ...z, feeCents: z.feeCents === 20_000 ? 22_000 : z.feeCents === 25_000 ? 27_000 : z.feeCents })),
    );
    expect(o.ok).toBe(true);
    const made = savedZones().map((z) => z.feeItemId);
    const ids = [...new Set(made)];
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(itemRow(String(id))).toMatchObject({ tax_category_id: zero.id, category_id: menu.fees, is_active: 1 });
    }
    expect(itemRow(menu.d200)).toMatchObject({ is_active: 0 });
    expect(itemRow(menu.d250)).toMatchObject({ is_active: 0 });
    // A Phase 6 order with Rs 1,000 of food: the Rs 220 charge carries no tax (16% of the food only).
    h.session = CASHIER;
    const order = await data<{ id: string }>('orders:create', { mode: 'delivery' });
    await data('orders:addItem', { orderId: order.id, menuItemId: menu.pizza, quantity: 1 });
    await data('orders:setDeliveryArea', { orderId: order.id, area: 'DHA Phase 6' });
    expect(db.prepare(`SELECT subtotal_cents, tax_cents FROM orders WHERE id = ?`).get(order.id)).toEqual({
      subtotal_cents: 122_000,
      tax_cents: 16_000,
    });
  });

  it('two Saves offline — A moves every Rs 250 area to Rs 300, B later puts Phase 7 at Rs 250 — settle so every area B saved points at an item that is ON, on both tills', async () => {
    const sync = await import('../../db/repositories/sync-repo.js');
    const { applyRemoteBatch } = await import('../../db/repositories/apply-remote.js');
    const { saveDeliveryZones } = await import('../../db/repositories/delivery-zones-repo.js');
    const TILL_B = 'dev-till-2';
    const b = openMigrated();
    const user = b.prepare(
      `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
    );
    user.run('u_admin', 'Test Owner', 'admin', T0, T0, DEV);
    user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
    user.run('u_mgr', 'Test Manager', 'manager', T0, T0, DEV);
    const push = async (from: Db, to: Db, fromDevice: string) => {
      const pending = sync.listPendingSync(from as never, 5_000);
      await applyRemoteBatch(to as never, pending.map((p) => sync.pendingToChange(p, fromDevice)), { pause: async () => {} });
      sync.markSyncedIds(from as never, pending.map((p) => p.id));
    };
    // B starts as a copy of A's menu.
    await push(db, b, DEV);
    expect(b.prepare(`SELECT is_active FROM menu_items WHERE id = ?`).get(menu.d250)).toEqual({ is_active: 1 });

    // A (the owner at the counter): every Rs 250 area to Rs 300 — the Rs 250 item goes off.
    expect((await save(zones((z) => (z.feeCents === 25_000 ? { ...z, feeCents: 30_000 } : z)))).ok).toBe(true);
    expect(itemRow(menu.d250)).toMatchObject({ is_active: 0 });
    await new Promise((r) => setTimeout(r, 5));
    // B, offline, a moment later: Phase 7 to Rs 250 (the rest as today).
    saveDeliveryZones(
      b as never,
      { zones: zones((z) => (z.id === 'dha-7' ? { ...z, feeCents: 25_000 } : z)) },
      { userId: 'u_admin', deviceId: TILL_B },
    );
    // The link comes back, both ways.
    await push(db, b, DEV);
    await push(b, db, TILL_B);
    for (const d of [db, b]) {
      const row = d.prepare(`SELECT value_json FROM business_settings WHERE key = 'delivery.zones'`).get();
      const list = (JSON.parse(String(row?.['value_json'])) as { zones: DeliveryZoneSetting[] }).zones;
      // B's Save is the later one: its areas everywhere.
      expect(list.find((z) => z.id === 'dha-7')).toMatchObject({ feeCents: 25_000, feeItemId: menu.d250 });
      for (const z of list.filter((x) => x.active && x.feeCents > 0)) {
        expect({ area: z.id, on: d.prepare(`SELECT is_active FROM menu_items WHERE id = ?`).get(z.feeItemId) }).toEqual({
          area: z.id,
          on: { is_active: 1 },
        });
      }
    }
  });
});

describe.skipIf(!Sqlite)('Menu: a delivery charge is Settings → Delivery areas’', () => {
  it('its price, name, on/off, category and delete are refused in the main process — for the owner too; a note or a photo is fine', async () => {
    await save(zones());
    h.session = OWNER;
    const before = itemRow(menu.d200);
    for (const [channel, payload] of [
      ['menu:updateItem', { id: menu.d200, basePriceCents: 30_000 }],
      ['menu:updateItem', { id: menu.d200, name: 'Rider fee' }],
      ['menu:updateItem', { id: menu.d200, isActive: false }],
      ['menu:updateItem', { id: menu.d200, categoryId: menu.food }],
      ['menu:deleteItem', { id: menu.d200 }],
    ] as const) {
      expect({ channel, payload, o: await call(channel, payload) }).toEqual({
        channel,
        payload,
        o: { ok: false, code: 'precondition_failed', message: FEE_ITEM_LOCKED_NOTE },
      });
    }
    expect(itemRow(menu.d200)).toEqual(before);
    // The item dialog sends every field back: unchanged ones are fine.
    expect(
      (
        await call('menu:updateItem', {
          id: menu.d200,
          name: 'Delivery Charge (Rs 200)',
          basePriceCents: 20_000,
          isActive: true,
          description: 'Test note',
        })
      ).ok,
    ).toBe(true);
    // A manager is refused in the same words (they can't open Settings: "ask the owner").
    h.session = MANAGER;
    expect(await call('menu:updateItem', { id: menu.d200, basePriceCents: 1 })).toMatchObject({
      ok: false,
      message: FEE_ITEM_LOCKED_NOTE,
    });
  });

  it('the category holding the charges can’t be hidden or deleted; no other item may take a delivery-charge name', async () => {
    await save(zones());
    h.session = OWNER;
    expect(await call('menu:updateCategory', { id: menu.fees, isActive: false })).toMatchObject({
      ok: false,
      code: 'precondition_failed',
    });
    expect(await call('menu:deleteCategory', { id: menu.fees })).toMatchObject({
      ok: false,
      code: 'precondition_failed',
    });
    expect((await call('menu:updateCategory', { id: menu.fees, name: 'Delivery' })).ok).toBe(true);
    expect(
      await call('menu:createItem', {
        categoryId: menu.food,
        name: 'Delivery charge (Rs 150)',
        basePriceCents: 15_000,
        taxCategoryId: menu.tax,
      }),
    ).toMatchObject({
      ok: false,
      code: 'precondition_failed',
    });
    expect(
      await call('menu:updateItem', { id: menu.side, name: 'Delivery Charge extra' }),
    ).toMatchObject({ ok: false, code: 'precondition_failed' });
    // A caller's id is never used for a new item (name-based ids are Save's).
    const made = await data<{ id: string }>('menu:createItem', {
      id: fee300(),
      categoryId: menu.food,
      name: 'Test Dip',
      basePriceCents: 5_000,
      taxCategoryId: menu.tax,
    });
    expect(made.id).not.toBe(fee300());
  });
});

describe.skipIf(!Sqlite)('the menu file import leaves the delivery charges alone', () => {
  const file = (items: unknown[]) =>
    menuImportFileSchema.parse({
      format: 'cheeseoclock-menu-import',
      version: 1,
      source: 'test',
      categories: [{ name: 'Test food' }, { name: 'Delivery Charges' }],
      ingredients: [],
      items,
    });

  it('a file’s delivery charge never creates, re-prices or changes one — the preview says the fee is set in Settings', async () => {
    await save(zones((z) => (z.id === 'dha-8' ? { ...z, feeCents: 30_000 } : z)));
    const { planMenuImportFromDb } = await import('../../db/repositories/menu-import-repo.js');
    const { FEE_SET_IN_SETTINGS } = await import('../../db/menu-import-plan.js');
    const plan = planMenuImportFromDb(
      db as never,
      file([
        { name: 'Test Pizza', category: 'Test food', priceCents: 110_000, recipe: [] },
        {
          name: 'Delivery Charge (Rs 200)',
          aliases: ['Delivery 200'],
          category: 'Delivery Charges',
          priceCents: 22_000,
          recipe: [],
        },
        {
          name: 'Delivery Charge (Rs 350)',
          category: 'Delivery Charges',
          priceCents: 35_000,
          recipe: [],
        },
      ]),
    );
    const byName = new Map(plan.preview.items.map((i) => [i.name, i]));
    expect(byName.get('Delivery Charge (Rs 200)')).toMatchObject({
      action: 'same',
      keptOnTill: [FEE_SET_IN_SETTINGS],
    });
    expect(byName.get('Delivery Charge (Rs 350)')).toMatchObject({
      action: 'same',
      keptOnTill: [FEE_SET_IN_SETTINGS],
    });
    expect(byName.get('Test Pizza')).toMatchObject({ action: 'update' });
    expect(plan.ops.items.map((o) => o.existingId)).toEqual([menu.pizza]);
    expect(plan.preview.summary.skipped).toBe(0);
    // The v5 Rs 300 item is neither in the file nor touched: left as it is.
    expect(plan.preview.untouchedItems).toContain('Delivery Charge (Rs 300)');
  });

  it('a fresh start keeps the charges and their category (same ids, on); everything else goes', async () => {
    await save(zones((z) => (z.id === 'dha-8' ? { ...z, feeCents: 30_000 } : z)));
    const { applyMenuImport, planMenuImportFromDb } =
      await import('../../db/repositories/menu-import-repo.js');
    // No unpaid order open: a fresh start refuses otherwise.
    const f = file([
      { name: 'New Test Pizza', category: 'Test food', priceCents: 90_000, recipe: [] },
    ]);
    const preview = planMenuImportFromDb(db as never, f, { fresh: true }).preview;
    expect(preview.fresh?.items).toEqual(['Test Pizza', 'Test Side']);
    applyMenuImport(db as never, f, 'test.json', OWNER_ACTOR, { fresh: true });
    for (const id of [menu.d200, menu.d250, fee300()])
      expect(itemRow(id)).toMatchObject({ deleted_at: null, is_active: 1, category_id: menu.fees });
    expect(itemRow(menu.pizza)).toMatchObject({ deleted_at: expect.any(String) });
    expect(
      db.prepare(`SELECT deleted_at, is_active FROM categories WHERE id = ?`).get(menu.fees),
    ).toEqual({ deleted_at: null, is_active: 1 });
  });
});

describe.skipIf(!Sqlite)(
  'the delivery charge follows the area (owner, 28 Sep 2026: added automatically)',
  () => {
    const charges = (s: OrderSnapshot) =>
      s.items
        .filter((i) => isDeliveryChargeName(i.menuItemName))
        .map((i) => [i.menuItemId, i.unitPriceCents, i.quantity]);
    async function deliveryOrder(): Promise<string> {
      h.session = CASHIER;
      const order = await data<{ id: string }>('orders:create', { mode: 'delivery' });
      await data('orders:addItem', { orderId: order.id, menuItemId: menu.pizza, quantity: 1 });
      return order.id;
    }
    const area = (orderId: string, a: string | null) =>
      data<OrderSnapshot>('orders:setDeliveryArea', { orderId, area: a });

    it('picking an area puts its fee on; the same area again never doubles it', async () => {
      const orderId = await deliveryOrder();
      expect(charges(await area(orderId, 'DHA Phase 6'))).toEqual([[menu.d200, 20_000, 1]]);
      expect(charges(await area(orderId, 'Rahat Commercial, DHA Phase 6'))).toEqual([
        [menu.d200, 20_000, 1],
      ]);
      // The totals carry it.
      expect(db.prepare(`SELECT subtotal_cents FROM orders WHERE id = ?`).get(orderId)).toEqual({
        subtotal_cents: 120_000,
      });
    });

    it('another area swaps it; clearing the area, or leaving Delivery, takes it off — in the main process', async () => {
      const orderId = await deliveryOrder();
      await area(orderId, 'DHA Phase 6');
      expect(charges(await area(orderId, 'DHA Phase 8'))).toEqual([[menu.d250, 25_000, 1]]);
      expect(charges(await area(orderId, null))).toEqual([]);
      await area(orderId, 'Clifton Block 5');
      const s = await data<OrderSnapshot>('orders:setMode', { orderId, mode: 'takeaway' });
      expect(charges(s)).toEqual([]);
      expect(s.order.subtotalCents).toBe(100_000);
    });

    it('a road across phases waits for the phase; an area not on the list leaves the bill alone', async () => {
      const orderId = await deliveryOrder();
      expect(charges(await area(orderId, 'Khayaban-e-Shahbaz, DHA'))).toEqual([]);
      await area(orderId, 'DHA Phase 6');
      expect(charges(await area(orderId, 'Gulshan Block 13'))).toEqual([[menu.d200, 20_000, 1]]);
    });

    it('an area switched off in Settings adds nothing (and takes a charge from the last area off)', async () => {
      await save(zones((z) => (z.id === 'dha-8' ? { ...z, active: false } : z)));
      const orderId = await deliveryOrder();
      await area(orderId, 'DHA Phase 6');
      expect(charges(await area(orderId, 'DHA Phase 8'))).toEqual([]);
      // A road across Phase 8 and a phase still on: the customer may be in Phase 8, so no other
      // phase's fee goes on by itself — the till asks which phase.
      expect(charges(await area(orderId, 'Khayaban-e-Shahbaz, DHA'))).toEqual([]);
    });

    it('after a Save the area’s own fee item goes on (Rs 300, name-based id)', async () => {
      await save(zones((z) => (z.id === 'dha-8' ? { ...z, feeCents: 30_000 } : z)));
      const orderId = await deliveryOrder();
      expect(charges(await area(orderId, 'DHA Phase 8'))).toEqual([[fee300(), 30_000, 1]]);
    });

    it('a cashier may take it off by hand — audited like any line — and it stays off until the area is picked again', async () => {
      const orderId = await deliveryOrder();
      const s = await area(orderId, 'DHA Phase 6');
      const line = s.items.find((i) => i.menuItemId === menu.d200)!;
      h.session = CASHIER;
      const after = await data<OrderSnapshot>('orders:removeItem', {
        orderId,
        orderItemId: line.id,
      });
      expect(charges(after)).toEqual([]);
      expect(
        db
          .prepare(
            `SELECT actor_user_id, action FROM audit_log WHERE entity_type = 'order_items' AND entity_id = ? ORDER BY rowid DESC LIMIT 1`,
          )
          .get(line.id),
      ).toEqual({
        actor_user_id: 'u_cash',
        action: 'delete',
      });
      // Nothing puts it back by itself (the screen asks only when the area changes)…
      await data('orders:addItem', { orderId, menuItemId: menu.side, quantity: 1 });
      expect(charges(await snap(orderId))).toEqual([]);
      // …picking the area again does.
      expect(charges(await area(orderId, 'DHA Phase 6'))).toEqual([[menu.d200, 20_000, 1]]);
    });

    it('foodpanda never gets the shop’s delivery charge: not by the area, not by hand, and a delivery that becomes foodpanda loses it', async () => {
      h.session = CASHIER;
      const fp = await data<{ id: string }>('orders:create', { mode: 'foodpanda' });
      await data('orders:addItem', { orderId: fp.id, menuItemId: menu.pizza, quantity: 1 });
      expect(charges(await area(fp.id, 'DHA Phase 6'))).toEqual([]);
      expect(
        await call('orders:addItem', { orderId: fp.id, menuItemId: menu.d200, quantity: 1 }),
      ).toMatchObject({ ok: false });
      const orderId = await deliveryOrder();
      await area(orderId, 'DHA Phase 6');
      expect(
        charges(await data<OrderSnapshot>('orders:setMode', { orderId, mode: 'foodpanda' })),
      ).toEqual([]);
    });

    it('a website delivery order keeps the one fee it came with: the import adds no second, and the till’s area never touches it', async () => {
      const orderId = await importWebOrder(
        webOrder('web-1', [
          [menu.pizza, 1, 100_000],
          [menu.d200, 1, 20_000],
        ]),
      );
      expect(charges(await snap(orderId))).toEqual([[menu.d200, 20_000, 1]]);
      h.session = CASHIER;
      expect(charges(await area(orderId, 'DHA Phase 8'))).toEqual([[menu.d200, 20_000, 1]]);
      expect(charges(await area(orderId, null))).toEqual([[menu.d200, 20_000, 1]]);
    });

    it('a website order charged with a fee item the link has not brought here yet (the owner saved Rs 300 on the other till) imports WITH its charge — the item made here with the same id', async () => {
      // This till has saved nothing: no Rs 300 item here.
      expect(itemRow(fee300())).toBeUndefined();
      const orderId = await importWebOrder(
        webOrder('web-new-fee', [
          [menu.pizza, 1, 100_000],
          [fee300(), 1, 30_000, 'Delivery Charge (Rs 300)'],
        ]),
      );
      expect(charges(await snap(orderId))).toEqual([[fee300(), 30_000, 1]]);
      // Made as a Save makes it: the fee's name and price, the charges' category and tax, on; synced and audited.
      expect(itemRow(fee300())).toMatchObject({
        name: 'Delivery Charge (Rs 300)',
        base_price_cents: 30_000,
        is_active: 1,
        category_id: menu.fees,
        tax_category_id: menu.tax,
      });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'menu_items' AND entity_id = ?`).get(fee300())).toEqual({ n: 1 });
      // Food, or a line that only claims to be a charge, is never made up this way: that import still fails.
      const { webOrdersBridge } = await import('../../services/web-orders-bridge.js');
      const bridge = webOrdersBridge as unknown as { importOne: (cfg: unknown, web: WebOrder) => Promise<void> };
      await bridge.importOne({}, webOrder('web-made-up', [[uuidv5('delivery-charge:45000', COC_ID_NAMESPACE), 1, 40_000, 'Delivery Charge (Rs 400)']]));
      expect(db.prepare(`SELECT pos_order_id FROM web_order_imports WHERE web_order_id = 'web-made-up'`).get()).toEqual({ pos_order_id: null });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM menu_items WHERE base_price_cents IN (40000, 45000)`).get()).toEqual({ n: 0 });
    });

    it('orders:setDeliveryArea: an order that is not there is "not found"; a database error is never shown to the cashier as it is', async () => {
      h.session = CASHIER;
      expect(await call('orders:setDeliveryArea', { orderId: 'no-such-order', area: 'DHA Phase 6' })).toMatchObject({
        ok: false,
        code: 'not_found',
      });
      const orderId = await deliveryOrder();
      // A broken database (a table gone): the handler leaves it to defineHandler, which hides it behind a reference.
      db.exec(`ALTER TABLE order_items RENAME TO order_items_gone`);
      try {
        const o = await call('orders:setDeliveryArea', { orderId, area: 'DHA Phase 6' });
        expect(o).toMatchObject({ ok: false, code: 'threw' });
      } finally {
        db.exec(`ALTER TABLE order_items_gone RENAME TO order_items`);
      }
    });

    it('the v0.7.26 rule holds: a discount never comes off the charge — even of an item an older till renamed (sold under its delivery-charge name)', async () => {
      await save(zones());
      // An older till (no Menu lock) renamed the Rs 200 item; its line is still sold as a delivery charge.
      db.prepare(`UPDATE menu_items SET name = 'Rider fee' WHERE id = ?`).run(menu.d200);
      const orderId = await deliveryOrder();
      const s = await area(orderId, 'DHA Phase 6');
      expect(s.items.find((i) => i.menuItemId === menu.d200)?.menuItemName).toBe(
        'Delivery Charge (Rs 200)',
      );
      h.session = CASHIER;
      await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 10 });
      // 10% of the Rs 1,000 pizza only.
      expect(
        db.prepare(`SELECT subtotal_cents, discount_cents FROM orders WHERE id = ?`).get(orderId),
      ).toEqual({ subtotal_cents: 120_000, discount_cents: 10_000 });
    });
  },
);

describe('the till reads the areas from the setting, never the compiled list', () => {
  it('no screen or main-process file calls the compiled list’s helpers (a new call site must take the zones)', () => {
    const APP = join(HERE, '..', '..', '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name === 'node_modules' || name === 'out' || name === 'dist') continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/fixture/.test(name))
          files.push(p);
      }
    };
    walk(join(APP, 'src'));
    walk(join(APP, 'electron'));
    const hits: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      // A bare call (not a method of the zone list's helpers: "areas.findZone(").
      for (const m of src.matchAll(
        /(^|[^.\w$])(DELIVERY_ZONES|FEE_SUMMARY|findZone\(|feeForZones\(|feeRangeForZones\(|findDeliveryChargeItem\()/gm,
      )) {
        hits.push(`${relative(APP, file).replace(/\\/g, '/')}: ${m[2]}`);
      }
    }
    // Reports' rider cost only: the rider service's rate card stays the compiled list until costing
    // Phase 9 copies rider pay onto each order (a new charge must not rewrite past profit).
    expect(hits.sort()).toEqual([
      'electron/services/analytics/delivery-areas.ts: feeForZones(',
      'electron/services/analytics/delivery-areas.ts: findZone(',
    ]);
  });
});

// ---------------------------------------------------------------------------

async function snap(orderId: string): Promise<OrderSnapshot> {
  return (await import('../../db/repositories/order-repo.js')).getOrderSnapshot(
    db as never,
    orderId,
  )!;
}

async function importWebOrder(web: WebOrder): Promise<string> {
  const { webOrdersBridge } = await import('../../services/web-orders-bridge.js');
  const bridge = webOrdersBridge as unknown as {
    db: unknown;
    deviceId: string;
    systemUserId: string | null;
    api: (...a: unknown[]) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
    importOne: (cfg: unknown, web: WebOrder) => Promise<void>;
  };
  bridge.db = db;
  bridge.deviceId = DEV;
  bridge.systemUserId = null;
  bridge.api = async () => ({ ok: true, json: async () => ({ data: {} }) });
  await bridge.importOne({}, web);
  const row = db
    .prepare(`SELECT pos_order_id FROM web_order_imports WHERE web_order_id = ?`)
    .get(web.id);
  expect(row?.['pos_order_id']).toBeTruthy();
  return String(row!['pos_order_id']);
}

function webOrder(id: string, lines: Array<[string, number, number, string?]>): WebOrder {
  const subtotal = lines.reduce((s, [, q, p]) => s + q * p, 0);
  return {
    id,
    status: 'new',
    customerName: 'Web Customer',
    customerPhone: '03111234567',
    addressLine: 'Flat 2, Web Road',
    area: 'DHA Phase 6',
    notes: null,
    fulfilment: 'delivery',
    items: lines.map(([posItemId, quantity, unitPriceCents, name]) => ({
      posItemId,
      name: name ?? 'Test',
      quantity,
      unitPriceCents,
      modifiers: [],
      notes: null,
    })),
    subtotalCents: subtotal,
    discountCents: 0,
    taxCents: 0,
    totalCents: 0,
    paymentMethod: 'cod',
    createdAt: new Date().toISOString(),
    posOrderId: null,
    posOrderNumber: null,
  } as WebOrder;
}
