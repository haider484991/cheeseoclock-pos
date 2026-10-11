/**
 * Offers on some categories (the owner, 11 Oct 2026: "i want category
 * discounts in settings so i can add discounts category wise and separately
 * mentioned for each category on receipt like we have 10 percent offer on
 * entire menu and separate 20 percent off on regular pizzas so they don't
 * conflict and add separately each"). Through the real IPC handlers and
 * repositories on a real SQLite database built from every migration:
 *   - "20% off" on Regular Pizzas and "10% off" the whole menu: a pizza
 *     takes the 20% only, the burger the 10%, a value deal neither — each
 *     offer its own row, its own line on the receipt, its lines named;
 *   - the tax per line on what is left of it; the card total the same way;
 *   - the × on one offer takes only it off (its pizzas then take the 10%),
 *     "Put it back" brings it back; the F3 discount replaces both;
 *   - a till with no offer on a category: one offer row, as before (no
 *     line list written).
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
import { decodeEscPos, renderReceipt } from '@cheeseoclock/printer-core';
import type { AuthenticatedUser, ChannelOffer, OrderSnapshot, UUID } from '@cheeseoclock/shared-types';

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
const OWNER = session('u_admin', 'admin');

type Db = ReturnType<typeof openMigrated>;
let db: Db;
/** Today's menu: food at 16% (8% by card) and the menu file's two delivery charges on the same tax. */
let menu: { fajita: string; tikka: string; zinger: string; bigTwo: string; pizzas: string; burgers: string; deals: string };

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
  const pizzas = createCategory(x, { name: 'Regular Pizzas', displayOrder: 1, colorHex: '#aa5500' }, mgr);
  const burgers = createCategory(x, { name: 'Burgers', displayOrder: 2, colorHex: '#aa0055' }, mgr);
  // Never discounted by its name (0047): its lines are value deals.
  const deals = createCategory(x, { name: 'Value Deals', displayOrder: 3, colorHex: '#0055aa' }, mgr);
  const item = (categoryId: string, name: string, cents: number) =>
    createMenuItem(x, { categoryId, name, basePriceCents: cents, taxCategoryId: tax.id }, mgr).id;
  return {
    fajita: item(pizzas.id, 'Test Fajita Pizza', 150_000),
    tikka: item(pizzas.id, 'Test Tikka Pizza', 200_000),
    zinger: item(burgers.id, 'Test Zinger', 70_000),
    bigTwo: item(deals.id, 'Test Big Two', 399_900),
    pizzas: pizzas.id,
    burgers: burgers.id,
    deals: deals.id,
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

const offer = (o: Partial<ChannelOffer> & Pick<ChannelOffer, 'id' | 'name' | 'value'>): ChannelOffer => ({
  on: true,
  cameBy: 'any',
  orderTypes: ['takeaway', 'delivery'],
  type: 'percent',
  minOrderCents: null,
  maxOffCents: null,
  days: [0, 1, 2, 3, 4, 5, 6],
  hours: null,
  startsOn: null,
  endsOn: null,
  oncePerCustomerPerDay: false,
  ...o,
});
const MENU10 = () => offer({ id: 'menu10', name: 'Test 10% off', value: 10 });
const PIZZA20 = () => offer({ id: 'pizza20', name: 'Test 20% off pizzas', value: 20, categoryIds: [menu.pizzas] });

async function saveOffers(offers: ChannelOffer[]): Promise<void> {
  h.session = OWNER;
  await data('settings:setBusiness', { key: 'discounts.offers', value: { v: 1, askCameBy: false, offers } });
}
/** A takeaway with these items (one of each), rung up by the cashier: its snapshot. */
async function takeaway(...items: string[]): Promise<OrderSnapshot> {
  h.session = CASHIER;
  const order = await data<{ id: string }>('orders:create', { mode: 'takeaway' });
  for (const menuItemId of items) await data('orders:addItem', { orderId: order.id, menuItemId, quantity: 1 });
  return snap(order.id);
}
const snap = async (id: string) => {
  h.session = CASHIER;
  return (await data<OrderSnapshot | null>('orders:get', { id }))!;
};
const lineOf = (s: OrderSnapshot, menuItemId: string) => s.items.find((i) => i.menuItemId === menuItemId)!.id;
const offersOn = (s: OrderSnapshot) =>
  s.discounts.map((d) => ({
    name: d.reason,
    amount: d.amountCents,
    declined: d.offer?.declined ?? null,
    lines: d.lineIds ? [...d.lineIds].sort() : null,
  }));
const receiptRows = (s: OrderSnapshot) =>
  decodeEscPos(renderReceipt(s, { branding: { storeName: 'Test Shop' } })).map((r) => r.text.replace(/\s+/g, ' ').trim());

describe.skipIf(!Sqlite)('Offers on some categories: 20% off Regular Pizzas beside 10% off the whole menu', () => {
  it('a pizza takes the 20% only, the burger the 10%, the value deal neither — each offer its own row, over its own lines', async () => {
    await saveOffers([MENU10(), PIZZA20()]);
    const s = await takeaway(menu.fajita, menu.zinger, menu.bigTwo);
    expect(offersOn(s).sort((a, b) => a.name!.localeCompare(b.name!))).toEqual([
      { name: 'Test 10% off', amount: 7_000, declined: false, lines: [lineOf(s, menu.zinger)] },
      { name: 'Test 20% off pizzas', amount: 30_000, declined: false, lines: [lineOf(s, menu.fajita)] },
    ]);
    // Rs 1,500 + Rs 700 + Rs 3,999 = Rs 6,199; off Rs 370; 16% on (1,200 + 630 + 3,999) = Rs 932.64.
    expect(s.order).toMatchObject({ subtotalCents: 619_900, discountCents: 37_000, taxCents: 93_264, totalCents: 676_164 });
    // By card: 8% on the same lines = Rs 466.32.
    expect(s.order.digitalTotalCents).toBe(619_900 - 37_000 + 46_632);
    // The category offer names its category for the screens.
    expect(s.discounts.find((d) => d.offer?.id === 'pizza20')?.offer).toMatchObject({ categoryNames: ['Regular Pizzas'] });
  });

  it('the receipt says each offer on its own line, with what it took off', async () => {
    await saveOffers([MENU10(), PIZZA20()]);
    const rows = receiptRows(await takeaway(menu.fajita, menu.zinger));
    expect(rows).toContainEqual(expect.stringMatching(/^Test 20% off pizzas - 300\.00$/));
    expect(rows).toContainEqual(expect.stringMatching(/^Test 10% off - 70\.00$/));
    // With a value deal on the bill: the category offer still prints as its name alone.
    const withDeal = receiptRows(await takeaway(menu.fajita, menu.zinger, menu.bigTwo));
    expect(withDeal).toContainEqual(expect.stringMatching(/^Test 20% off pizzas - 300\.00$/));
    expect(withDeal).toContainEqual(expect.stringMatching(/^Test 10% off .*- 70\.00$/));
  });

  it('only pizzas: the 20% alone; only the burger: the 10% alone', async () => {
    await saveOffers([MENU10(), PIZZA20()]);
    const pizzas = await takeaway(menu.fajita, menu.tikka);
    expect(offersOn(pizzas).map((o) => [o.name, o.amount])).toEqual([['Test 20% off pizzas', 70_000]]);
    const burger = await takeaway(menu.zinger);
    expect(offersOn(burger).map((o) => [o.name, o.amount])).toEqual([['Test 10% off', 7_000]]);
  });

  it('a line taken off moves the offers with it: the burger gone, its 10% goes too', async () => {
    await saveOffers([MENU10(), PIZZA20()]);
    const s = await takeaway(menu.fajita, menu.zinger);
    h.session = CASHIER;
    const after = await data<OrderSnapshot>('orders:removeItem', { orderId: s.order.id, orderItemId: lineOf(s, menu.zinger) });
    expect(offersOn(after).map((o) => [o.name, o.amount])).toEqual([['Test 20% off pizzas', 30_000]]);
    expect(after.order.discountCents).toBe(30_000);
  });

  it('the × on the pizza offer takes only it off (its pizza then takes the 10%); “Put it back” brings it back', async () => {
    await saveOffers([MENU10(), PIZZA20()]);
    const s = await takeaway(menu.fajita, menu.zinger);
    const pizzaRow = s.discounts.find((d) => d.offer?.id === 'pizza20')!;
    h.session = CASHIER;
    const off = await data<OrderSnapshot>('orders:clearDiscount', { orderId: s.order.id, discountId: pizzaRow.id });
    expect(offersOn(off).sort((a, b) => a.name!.localeCompare(b.name!))).toEqual([
      { name: 'Test 10% off', amount: 22_000, declined: false, lines: [lineOf(s, menu.fajita), lineOf(s, menu.zinger)].sort() },
      { name: 'Test 20% off pizzas', amount: 0, declined: true, lines: null },
    ]);
    expect(off.order.discountCents).toBe(22_000);
    // Another item: the offer taken off stays off.
    const more = await data<OrderSnapshot>('orders:addItem', { orderId: s.order.id, menuItemId: menu.tikka, quantity: 1 });
    expect(more.discounts.find((d) => d.offer?.id === 'pizza20')?.offer?.declined).toBe(true);
    // Put back: the 20% on both pizzas, the 10% on the burger again.
    const declinedRow = more.discounts.find((d) => d.offer?.id === 'pizza20')!;
    const back = await data<OrderSnapshot>('orders:clearDiscount', { orderId: s.order.id, discountId: declinedRow.id });
    expect(offersOn(back).map((o) => [o.name, o.amount]).sort()).toEqual([
      ['Test 10% off', 7_000],
      ['Test 20% off pizzas', 70_000],
    ]);
  });

  it('the F3 discount replaces both offers (one discount per order, as always); “No discount” takes both off', async () => {
    await saveOffers([MENU10(), PIZZA20()]);
    const s = await takeaway(menu.fajita, menu.zinger);
    h.session = CASHIER;
    const none = await data<OrderSnapshot>('orders:clearDiscount', { orderId: s.order.id });
    expect(offersOn(none).every((o) => o.declined === true && o.amount === 0)).toBe(true);
    expect(none.order.discountCents).toBe(0);
    h.session = OWNER;
    const f3 = await data<OrderSnapshot>('orders:applyDiscount', { orderId: s.order.id, discountType: 'percent', value: 5, reason: 'Test regular' });
    expect(f3.discounts.map((d) => [d.source ?? 'staff', d.amountCents])).toEqual([['staff', 11_000]]);
  });

  it('a till whose offers are all on the whole menu: one offer row, as before — no line list written', async () => {
    await saveOffers([MENU10()]);
    const s = await takeaway(menu.fajita, menu.zinger);
    expect(offersOn(s)).toEqual([{ name: 'Test 10% off', amount: 22_000, declined: false, lines: null }]);
    const rule = db.prepare(`SELECT rule_json FROM order_discounts WHERE order_id = ? AND deleted_at IS NULL`).get(s.order.id);
    expect(JSON.parse(String(rule?.['rule_json']))).not.toHaveProperty('lines');
  });

  it('the setting: an offer keeps its categories (read back as saved); an empty list is refused in plain words', async () => {
    h.session = OWNER;
    expect(
      await call('settings:setBusiness', {
        key: 'discounts.offers',
        value: { v: 1, askCameBy: false, offers: [{ ...PIZZA20(), categoryIds: [] }] },
      }),
    ).toMatchObject({ ok: false, code: 'validation_failed', message: expect.stringMatching(/at least one category/) });
    await saveOffers([PIZZA20(), MENU10()]);
    const card = await data<{ value: { offers: ChannelOffer[] }; readOnly: boolean }>('settings:getBusiness', { key: 'discounts.offers' });
    expect(card.readOnly).toBe(false);
    expect(card.value.offers.map((o) => [o.id, o.categoryIds ?? null])).toEqual([
      ['pizza20', [menu.pizzas]],
      ['menu10', null],
    ]);
  });
});
