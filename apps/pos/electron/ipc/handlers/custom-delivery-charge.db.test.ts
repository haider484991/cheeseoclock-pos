/**
 * "Custom charge" on the till's delivery-charge row (owner, 10 Oct 2026: "i
 * want custom delivery charges entering option too so if we want to add
 * custom delivery fees"). Through the real IPC handlers and repositories on
 * a real SQLite database built from every migration:
 *   - orders:setDeliveryCharge puts ONE charge at the typed fee on an open
 *     counter delivery in place of the bill's charges — the shop's item at
 *     that fee, else one made with the fee's name-based id, SWITCHED OFF (no
 *     new tile on the till), on the charges' tax; synced and audited;
 *   - it is a charge put on by hand for the area's rule: the same area keeps
 *     it, another area swaps it for that area's, "Put it back" too;
 *   - never on a takeaway, foodpanda, a sent order; whole rupees only;
 *   - any login taking orders may (like the area's own charge).
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
import { v5 as uuidv5 } from 'uuid';
import {
  COC_ID_NAMESPACE,
  DEFAULT_DELIVERY_ZONES,
  isDeliveryChargeName,
  type AuthenticatedUser,
  type DeliveryZoneSetting,
  type OrderSnapshot,
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


const fee300 = () => uuidv5('delivery-charge:30000', COC_ID_NAMESPACE);
const charges = (s: OrderSnapshot) =>
  s.items.filter((i) => isDeliveryChargeName(i.menuItemName)).map((i) => [i.menuItemId, i.unitPriceCents, i.quantity]);
const itemRow = (id: string) =>
  db
    .prepare(
      `SELECT mi.name, mi.base_price_cents, mi.is_active, mi.deleted_at, mi.category_id, tc.name AS tax, tc.rate_bps
         FROM menu_items mi JOIN tax_categories tc ON tc.id = mi.tax_category_id WHERE mi.id = ?`,
    )
    .get(id);
const totals = (orderId: string) => db.prepare(`SELECT subtotal_cents, tax_cents FROM orders WHERE id = ?`).get(orderId);
const allZones = (): DeliveryZoneSetting[] =>
  DEFAULT_DELIVERY_ZONES.zones.map((z) => ({ ...z, aliases: [...z.aliases], hints: [...z.hints] }));

/** A delivery with a Rs 1,000 pizza, taken by the cashier; with an area when given. */
async function delivery(area?: string): Promise<string> {
  h.session = CASHIER;
  const order = await data<{ id: string }>('orders:create', { mode: 'delivery' });
  await data('orders:addItem', { orderId: order.id, menuItemId: menu.pizza, quantity: 1 });
  if (area) await data('orders:setDeliveryArea', { orderId: order.id, area });
  return order.id;
}
const custom = (orderId: string, feeCents: number) => {
  h.session = CASHIER;
  return call('orders:setDeliveryCharge', { orderId, feeCents });
};
const customSnap = async (orderId: string, feeCents: number) => {
  const o = await custom(orderId, feeCents);
  if (!o.ok) throw new Error(`refused: ${o.code} ${o.message}`);
  return o.data as OrderSnapshot;
};
const area = (orderId: string, a: string | null, opts: { putBack?: boolean } = {}) => {
  h.session = CASHIER;
  return data<OrderSnapshot>('orders:setDeliveryArea', { orderId, area: a, ...opts });
};

describe.skipIf(!Sqlite)('Custom charge: orders:setDeliveryCharge', () => {
  it('Phase 6 (Rs 200 on the bill) typed Rs 300: one Rs 300 charge instead — a new item with the fee’s name-based id, SWITCHED OFF, on the charges’ tax; synced and audited', async () => {
    const orderId = await delivery('DHA Phase 6');
    const s = await customSnap(orderId, 30_000);
    expect(charges(s)).toEqual([[fee300(), 30_000, 1]]);
    expect(itemRow(fee300())).toEqual({
      name: 'Delivery Charge (Rs 300)',
      base_price_cents: 30_000,
      is_active: 0,
      deleted_at: null,
      category_id: menu.fees,
      tax: 'Test GST',
      rate_bps: 1_600,
    });
    // Rs 1,000 + Rs 300, both at 16%.
    expect(totals(orderId)).toEqual({ subtotal_cents: 130_000, tax_cents: 20_800 });
    // The item, then the order's lines, all queued; the event on the order, by the cashier.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'menu_items' AND entity_id = ?`).get(fee300())).toEqual({ n: 2 });
    expect(
      db
        .prepare(`SELECT actor_user_id, after_json FROM audit_log WHERE entity_type = 'orders' AND entity_id = ? AND action = 'delivery_charge_typed'`)
        .all(orderId)
        .map((r) => [r['actor_user_id'], JSON.parse(String(r['after_json']))]),
    ).toEqual([['u_cash', { feeCents: 30_000, itemId: fee300() }]]);
  });

  it('a typed fee the shop has an item for uses it (no new item); the same fee again writes nothing', async () => {
    const orderId = await delivery('DHA Phase 6');
    const items = db.prepare(`SELECT COUNT(*) AS n FROM menu_items`).get();
    expect(charges(await customSnap(orderId, 25_000))).toEqual([[menu.d250, 25_000, 1]]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM menu_items`).get()).toEqual(items);
    const audits = db.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get();
    expect(charges(await customSnap(orderId, 25_000))).toEqual([[menu.d250, 25_000, 1]]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get()).toEqual(audits);
  });

  it('the area’s rule reads it as a charge put on by hand: the same area keeps it; another area swaps it for its own; “Put it back” puts the area’s back', async () => {
    const orderId = await delivery('DHA Phase 6');
    await customSnap(orderId, 30_000);
    // The panel telling the same place again (another spelling too): the typed fee stays.
    expect(charges(await area(orderId, 'DHA Phase 6'))).toEqual([[fee300(), 30_000, 1]]);
    expect(charges(await area(orderId, 'Phase 6, DHA'))).toEqual([[fee300(), 30_000, 1]]);
    // Another area: its own charge.
    expect(charges(await area(orderId, 'DHA Phase 8'))).toEqual([[menu.d250, 25_000, 1]]);
    // Typed again, then the row's "Change to Rs 250" (Put it back): the area's.
    await customSnap(orderId, 35_000);
    expect(charges(await area(orderId, 'DHA Phase 8', { putBack: true }))).toEqual([[menu.d250, 25_000, 1]]);
  });

  it('an area not on the list (no charge by itself): the typed fee goes on, and stays while the area does', async () => {
    const orderId = await delivery('Gulshan Block 13');
    expect(charges((await data<OrderSnapshot>('orders:get', { id: orderId })) as OrderSnapshot)).toEqual([]);
    expect(charges(await customSnap(orderId, 40_000))).toEqual([[uuidv5('delivery-charge:40000', COC_ID_NAMESPACE), 40_000, 1]]);
    expect(charges(await area(orderId, 'Gulshan Block 13'))).toHaveLength(1);
  });

  it('two charges on the bill (one tapped on by hand): both come off, the typed one goes on', async () => {
    const orderId = await delivery('DHA Phase 6');
    h.session = CASHIER;
    await data('orders:addItem', { orderId, menuItemId: menu.d250, quantity: 1 });
    expect(charges(await customSnap(orderId, 30_000))).toEqual([[fee300(), 30_000, 1]]);
  });

  it('the typed charge is no tile: the till’s menu (items that are on) leaves it out, and a cashier can’t ring it up by itself', async () => {
    const orderId = await delivery('DHA Phase 6');
    await customSnap(orderId, 30_000);
    h.session = CASHIER;
    const onTill = await data<Array<{ id: string }>>('menu:listItems', { activeOnly: true });
    expect(onTill.map((i) => i.id)).not.toContain(fee300());
    const other = await delivery();
    expect(await call('orders:addItem', { orderId: other, menuItemId: fee300(), quantity: 1 })).toMatchObject({
      ok: false,
      message: 'Menu item not found or inactive',
    });
  });

  it('the charges’ tax (Settings → Tax on the delivery charge): a new typed fee’s item is made on it', async () => {
    h.session = OWNER;
    expect((await call('settings:saveDeliveryChargeTax', { choice: { kind: 'none' } })).ok).toBe(true);
    const orderId = await delivery('DHA Phase 6');
    await customSnap(orderId, 30_000);
    expect(itemRow(fee300())).toMatchObject({ tax: 'Delivery charge tax', rate_bps: 0 });
    // Rs 1,000 at 16%, the Rs 300 at none.
    expect(totals(orderId)).toEqual({ subtotal_cents: 130_000, tax_cents: 16_000 });
  });

  it('a Save of the areas that later charges that fee turns the SAME row on (no second Rs 300)', async () => {
    const orderId = await delivery('DHA Phase 6');
    await customSnap(orderId, 30_000);
    h.session = OWNER;
    await data('settings:saveDeliveryZones', { zones: allZones().map((z) => (z.id === 'dha-8' ? { ...z, feeCents: 30_000 } : z)) });
    expect(itemRow(fee300())).toMatchObject({ is_active: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM menu_items WHERE name = 'Delivery Charge (Rs 300)' AND deleted_at IS NULL`).get()).toEqual({ n: 1 });
  });

  it('any login taking orders may: a manager and the owner too', async () => {
    for (const who of [MANAGER, OWNER]) {
      const orderId = await delivery('DHA Phase 6');
      h.session = who;
      const o = await call('orders:setDeliveryCharge', { orderId, feeCents: 30_000 });
      expect({ who: who.role, ok: o.ok }).toEqual({ who: who.role, ok: true });
    }
  });

  it('refused, nothing written: a takeaway, foodpanda, an order the kitchen has; never Rs 0, paisa or over the most an area may charge', async () => {
    h.session = CASHIER;
    const takeaway = await data<{ id: string }>('orders:create', { mode: 'takeaway' });
    await data('orders:addItem', { orderId: takeaway.id, menuItemId: menu.pizza, quantity: 1 });
    const fp = await data<{ id: string }>('orders:create', { mode: 'foodpanda' });
    await data('orders:addItem', { orderId: fp.id, menuItemId: menu.pizza, quantity: 1 });
    // An order the kitchen has (as Send leaves it; Send itself needs the customer's details).
    const sent = await delivery('DHA Phase 6');
    db.prepare(`UPDATE orders SET status = 'sent_to_kitchen' WHERE id = ?`).run(sent);
    const open = await delivery('DHA Phase 6');
    const before = db.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get();
    // The repository's own words (the app's registry answers them as 'precondition_failed').
    expect(await custom(takeaway.id, 30_000)).toMatchObject({ ok: false, message: 'Only a delivery order has a delivery charge' });
    expect(await custom(fp.id, 30_000)).toMatchObject({
      ok: false,
      message: 'A foodpanda order never carries the shop’s delivery charge',
    });
    expect(await custom(sent, 30_000)).toMatchObject({
      ok: false,
      message: 'Only an order still being taken can change its delivery charge',
    });
    expect(await custom(open, 0)).toEqual({
      ok: false,
      code: 'validation_failed',
      message: 'A delivery charge is at least Rs 1 (to take it off, use Take it off)',
    });
    expect(await custom(open, 25_050)).toMatchObject({ ok: false, code: 'validation_failed', message: 'A delivery charge is in whole rupees' });
    expect(await custom(open, 200_100)).toMatchObject({ ok: false, code: 'validation_failed', message: 'A delivery charge is at most Rs 2,000' });
    expect(await custom('no-such-order', 30_000)).toEqual({ ok: false, code: 'not_found', message: 'Order not found' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get()).toEqual(before);
    h.session = null;
    expect(await call('orders:setDeliveryCharge', { orderId: open, feeCents: 30_000 })).toMatchObject({ ok: false, code: 'unauthenticated' });
  });
});
