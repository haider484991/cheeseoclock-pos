/**
 * Settings polish (owner, 2026-09-27: "everything should be editable for
 * admin"), through the real IPC handlers and repositories, on a real SQLite
 * database built from every migration:
 *   - this till's own settings (settings:getTill / settings:setTill): the
 *     receipt's extra lines and the opening float — the owner's alone (a
 *     cashier and a manager are refused, nothing is written), audited,
 *     never synced, their bounds refused in the main process;
 *   - the extra lines are kept in the receipt branding, and a Shop details
 *     save that does not send them keeps them;
 *   - the opening float: the last count by default (a first shift has
 *     none), a fixed amount when the owner sets one — whatever the last
 *     count — and any login that opens a shift reads it;
 *   - the reason buttons ('orders.reasons', synced): today's by default on
 *     the counter, the owner's once saved; any reason can still be typed;
 *     what is saved is the words, so a renamed button leaves old rows in
 *     Team & leakage exactly as they were; a "not made" answer never gets
 *     past the food having left the shop;
 *   - "probably made" follows the owner's amber minute ('kitchen.timing').
 *
 * Only `defineHandler` (captured), the signed-in session and the manager
 * check, the printer spooler and the FBR worker are stood in for. node's own
 * `node:sqlite` stands in for better-sqlite3 (built for Electron); skipped
 * where it is missing. Every name and amount is made up.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ORDER_REASONS,
  type AuthenticatedUser,
  type CheckoutRules,
  type OpeningFloatPrefill,
  type TillSettingCard,
  type UUID,
} from '@cheeseoclock/shared-types';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Handler = (ctx: unknown, payload: unknown) => unknown;
const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => unknown>(),
  session: null as unknown,
}));

const PIN = 'Test-manager-7';

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
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '' },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('../../services/auth-service.js', () => ({
  getCurrentSession: () => h.session,
  verifyManagerPin: async (_db: unknown, pin: string) => {
    if (pin === 'Test-manager-7') return { approverUserId: 'u_mgr', approverName: 'Test Manager' };
    throw new Error("That is not a manager's PIN or password");
  },
}));
vi.mock('../../services/print-spooler.js', () => ({
  printSpooler: new Proxy({}, { get: () => () => undefined }),
}));
vi.mock('../../services/fbr-worker.js', () => ({ fbrWorker: { kick: () => {}, resetAdapter: () => {} } }));

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
    return (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => RawDb }).DatabaseSync;
  } catch {
    return null;
  }
})();
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

function openMigrated() {
  const raw = new Sqlite!(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
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
const MGR_ACTOR = { userId: 'u_mgr', deviceId: DEV };

let db: ReturnType<typeof openMigrated>;
let REFUSED: Record<string, string>;
let menu: { pizza: string };
let shiftId: string;

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
async function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  const before = h.session;
  h.session = OWNER;
  try {
    return await fn();
  } finally {
    h.session = before;
  }
}

/** How many rows each table that a save writes holds: a refusal changes none. */
const writtenRows = () =>
  Object.fromEntries(
    ['audit_log', 'sync_queue', 'settings', 'business_settings'].map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.['n']]),
  );
const storedBranding = () => {
  const row = db.prepare(`SELECT value_json FROM settings WHERE key = 'receipt.branding'`).get();
  return row ? (JSON.parse(String(row['value_json'])) as Record<string, unknown>) : null;
};

/** A takeaway with one pizza (which takes 100 g of cheese), rung up and sent by the cashier. */
async function sentOrder(): Promise<string> {
  h.session = CASHIER;
  const order = await data<{ id: string }>('orders:create', { mode: 'takeaway' });
  await data('orders:addItem', { orderId: order.id, menuItemId: menu.pizza, quantity: 1 });
  await data('orders:sendToKitchen', { orderId: order.id });
  return order.id;
}

beforeEach(async () => {
  if (!Sqlite) return;
  h.handlers.clear();
  h.session = null;
  db = openMigrated();
  ({ REFUSED } = (await import('../guards.js')) as unknown as { REFUSED: Record<string, string> });
  const user = db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
  user.run('u_mgr', 'Test Manager', 'manager', T0, T0, DEV);
  user.run('u_admin', 'Test Owner', 'admin', T0, T0, DEV);
  const d = db as never;
  const { openShift } = await import('../../db/repositories/shift-repo.js');
  const { createTaxCategory } = await import('../../db/repositories/tax-category-repo.js');
  const { createCategory } = await import('../../db/repositories/category-repo.js');
  const { createMenuItem } = await import('../../db/repositories/menu-item-repo.js');
  const { createIngredient, setRecipeForItem } = await import('../../db/repositories/ingredient-repo.js');
  shiftId = openShift(d, { openingCashCents: 0, notes: null }, MGR_ACTOR).id;
  const tax = createTaxCategory(d, { name: 'Test GST', rateBps: 1_600 }, MGR_ACTOR);
  const cat = createCategory(d, { name: 'Test food', displayOrder: 1, colorHex: '#aa5500' }, MGR_ACTOR);
  menu = { pizza: createMenuItem(d, { categoryId: cat.id, name: 'Test Pizza', basePriceCents: 100_000, taxCategoryId: tax.id }, MGR_ACTOR).id };
  const cheese = createIngredient(d, { name: 'Test Cheese', unit: 'g', currentQty: 10_000, costPerUnitCents: 2 }, MGR_ACTOR);
  setRecipeForItem(d, menu.pizza, [{ ingredientId: cheese.id, qtyPerUnit: 100 }], MGR_ACTOR);
  const ctx = { db, deviceId: DEV } as never;
  (await import('./orders-handlers.js')).registerOrdersHandlers(ctx);
  (await import('./settings-handlers.js')).registerSettingsHandlers(ctx);
  (await import('./shifts-handlers.js')).registerShiftsHandlers(ctx);
  (await import('./printer-handlers.js')).registerPrinterHandlers(ctx);
});

const TILL_SAVES = (): unknown[] => [
  { key: 'receipt.extraLines', value: ['Insta @test.example'] },
  { key: 'drawer.openingFloat', value: { mode: 'fixed', fixedCents: 500_000 } },
  { key: 'receipt.extraLines', useDefault: true },
  { key: 'drawer.openingFloat', useDefault: true },
];

// ---------------------------------------------------------------------------

describe.skipIf(!Sqlite)("this till's own settings: the owner's alone, audited, never synced", () => {
  it('a cashier and a manager are refused every read and save, in plain words, and nothing is written', async () => {
    const before = writtenRows();
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      for (const key of ['receipt.extraLines', 'drawer.openingFloat']) {
        expect({ who: who.role, key, o: await call('settings:getTill', { key }) }).toEqual({
          who: who.role,
          key,
          o: { ok: false, code: 'forbidden', message: REFUSED['settings'] },
        });
      }
      for (const payload of TILL_SAVES()) {
        expect({ who: who.role, payload, o: await call('settings:setTill', payload) }).toEqual({
          who: who.role,
          payload,
          o: { ok: false, code: 'forbidden', message: REFUSED['settings'] },
        });
      }
      // …nor may they put lines on the receipt through Shop details (printers are the owner's too).
      expect(await call('printer:setBranding', { storeName: 'Test', extraLines: ['Test'] })).toMatchObject({ ok: false, code: 'forbidden' });
    }
    h.session = null;
    expect(await call('settings:setTill', TILL_SAVES()[0])).toMatchObject({ ok: false, code: 'unauthenticated' });
    expect(await call('settings:getTill', { key: 'drawer.openingFloat' })).toMatchObject({ ok: false, code: 'unauthenticated' });
    expect(writtenRows()).toEqual(before);
  });

  it('the owner reads today’s defaults, saves each (audited, this till only) and puts the default back', async () => {
    h.session = OWNER;
    expect(await data('settings:getTill', { key: 'receipt.extraLines' })).toMatchObject({
      key: 'receipt.extraLines',
      value: [],
      defaultValue: [],
      isDefault: true,
      readOnly: false,
      lastChanged: null,
      notOnOtherTillYet: false,
      history: [],
    });
    expect(await data('settings:getTill', { key: 'drawer.openingFloat' })).toMatchObject({
      value: { mode: 'lastCount', fixedCents: 0 },
      isDefault: true,
    });
    const syncedBefore = writtenRows()['sync_queue'];
    for (const payload of TILL_SAVES()) {
      const card = await data<TillSettingCard>('settings:setTill', payload);
      const putBack = 'useDefault' in (payload as object);
      expect({ payload, isDefault: card.isDefault, by: card.lastChanged?.byName }).toEqual({ payload, isDefault: putBack, by: 'Test Owner' });
    }
    // Four saves, four audit rows; nothing for the other till.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'settings'`).get()?.['n']).toBe(4);
    expect(writtenRows()['sync_queue']).toBe(syncedBefore);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM business_settings`).get()?.['n']).toBe(0);
    const card = await data<TillSettingCard<'receipt.extraLines'>>('settings:getTill', { key: 'receipt.extraLines' });
    expect(card.history.map((x) => x.value)).toEqual([[], ['Insta @test.example']]);
  });
});

describe.skipIf(!Sqlite)('receipt extra lines', () => {
  it('none to three lines of up to 64 letters; a control character is refused; nothing is written when refused', async () => {
    h.session = OWNER;
    const before = writtenRows();
    const long = 'x'.repeat(65);
    for (const value of [['One', 'Two', 'Three', 'Four'], [long], ['Tab\there'], ['Bell\u0007'], [''], ['   '], 'Insta', [42], null]) {
      const o = await call('settings:setTill', { key: 'receipt.extraLines', value });
      expect({ value, code: o.ok ? 'ok' : o.code }).toEqual({ value, code: 'validation_failed' });
    }
    expect(await call('settings:setTill', { key: 'receipt.extraLines', value: [long] })).toMatchObject({
      message: 'Keep each extra line to 64 letters',
    });
    expect(writtenRows()).toEqual(before);
    // The ends of the bounds are taken: three lines, 64 letters each, trimmed.
    const ok = await data<TillSettingCard<'receipt.extraLines'>>('settings:setTill', {
      key: 'receipt.extraLines',
      value: ['x'.repeat(64), '  Wi-Fi: TestShop  ', 'Three'],
    });
    expect(ok.value).toEqual(['x'.repeat(64), 'Wi-Fi: TestShop', 'Three']);
  });

  it('a letter the printer has no glyph for is saved (the card warns: it prints as "?")', async () => {
    h.session = OWNER;
    const card = await data<TillSettingCard<'receipt.extraLines'>>('settings:setTill', { key: 'receipt.extraLines', value: ['شکریہ Thank you'] });
    expect(card.value).toEqual(['شکریہ Thank you']);
  });

  it('kept in the receipt branding (what prints); a Shop details save keeps them; the printer settings read them', async () => {
    h.session = OWNER;
    await data('printer:setBranding', { storeName: 'Test Shop', footerLine: 'Test thanks' });
    const before = storedBranding();
    expect(before).not.toHaveProperty('extraLines');
    await data('settings:setTill', { key: 'receipt.extraLines', value: ['Insta @test.example', 'Wi-Fi: TestShop'] });
    // Every other field exactly as it was stored (a website never set stays unset: the shop's own site).
    expect(storedBranding()).toEqual({ ...before, extraLines: ['Insta @test.example', 'Wi-Fi: TestShop'] });
    // Shop details saved again without them: kept.
    await data('printer:setBranding', { storeName: 'Test Shop 2', footerLine: 'Test thanks' });
    expect(storedBranding()).toMatchObject({ storeName: 'Test Shop 2', extraLines: ['Insta @test.example', 'Wi-Fi: TestShop'] });
    const cfg = await data<{ branding: { extraLines?: string[] } }>('printer:getConfig');
    expect(cfg.branding.extraLines).toEqual(['Insta @test.example', 'Wi-Fi: TestShop']);
    // The card's History has the one save of the lines, not the Shop details saves.
    const card = await data<TillSettingCard<'receipt.extraLines'>>('settings:getTill', { key: 'receipt.extraLines' });
    expect(card.history.map((x) => x.value)).toEqual([['Insta @test.example', 'Wi-Fi: TestShop']]);
  });

  it('a stored line that no longer passes the check prints nothing — the name, address and thank-you still print', async () => {
    const { getReceiptBranding } = await import('../../services/printer-config.js');
    db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES ('receipt.branding', ?, ?)`).run(
      JSON.stringify({ storeName: 'Test Shop', branchLine: 'Test Road', footerLine: 'Test thanks', extraLines: ['x'.repeat(200)] }),
      T0,
    );
    const b = getReceiptBranding(db as never);
    expect(b).toMatchObject({ storeName: 'Test Shop', branchLine: 'Test Road', footerLine: 'Test thanks' });
    expect(b.extraLines).toBeUndefined();
  });
});

describe.skipIf(!Sqlite)('the opening float, per till', () => {
  const closeWith = async (cents: number) => {
    const { closeShift, openShift } = await import('../../db/repositories/shift-repo.js');
    closeShift(db as never, { shiftId, countedCashCents: cents }, MGR_ACTOR);
    return openShift;
  };

  it('by default: a first shift starts at nothing (0), and later shifts on the last count (today)', async () => {
    h.session = CASHIER;
    expect(await data<OpeningFloatPrefill>('shifts:openingFloat')).toEqual({ prefillCents: null, from: 'none', lastCount: null });
    await closeWith(1_234_500);
    expect(await data<OpeningFloatPrefill>('shifts:openingFloat')).toMatchObject({
      prefillCents: 1_234_500,
      from: 'last_count',
      lastCount: { countedCashCents: 1_234_500 },
    });
  });

  it('fixed: the owner’s amount, even when a last count exists — and on a first shift; any login opening a shift reads it', async () => {
    await asOwner(() => data('settings:setTill', { key: 'drawer.openingFloat', value: { mode: 'fixed', fixedCents: 500_000 } }));
    for (const who of [CASHIER, MANAGER, OWNER]) {
      h.session = who;
      expect(await data<OpeningFloatPrefill>('shifts:openingFloat')).toEqual({ prefillCents: 500_000, from: 'fixed', lastCount: null });
    }
    await closeWith(1_234_500);
    h.session = CASHIER;
    expect(await data<OpeningFloatPrefill>('shifts:openingFloat')).toMatchObject({ prefillCents: 500_000, from: 'fixed' });
    // Only where the box starts: the shift opens on whatever is counted and typed.
    const opened = await data<{ openingCashCents: number }>('shifts:open', { openingCashCents: 480_000 });
    expect(opened.openingCashCents).toBe(480_000);
  });

  it('back to the last count is the default again: no fixed amount is kept, the card says Default', async () => {
    h.session = OWNER;
    await data('settings:setTill', { key: 'drawer.openingFloat', value: { mode: 'fixed', fixedCents: 500_000 } });
    // A last-count value that still carries an amount (it does nothing) is saved as the default itself.
    const card = await data<TillSettingCard<'drawer.openingFloat'>>('settings:setTill', {
      key: 'drawer.openingFloat',
      value: { mode: 'lastCount', fixedCents: 500_000 },
    });
    expect(card).toMatchObject({ value: { mode: 'lastCount', fixedCents: 0 }, isDefault: true });
    expect(db.prepare(`SELECT value_json FROM settings WHERE key = 'drawer.openingFloat'`).get()?.['value_json']).toBe(
      JSON.stringify({ mode: 'lastCount', fixedCents: 0 }),
    );
    expect(card.history.map((x) => x.value)).toEqual([
      { mode: 'lastCount', fixedCents: 0 },
      { mode: 'fixed', fixedCents: 500_000 },
    ]);
  });

  it('whole rupees from Rs 0 to Rs 100,000; nothing written when refused; stored on this till only', async () => {
    h.session = OWNER;
    const before = writtenRows();
    for (const value of [
      { mode: 'fixed', fixedCents: 10_000_100 },
      { mode: 'fixed', fixedCents: 5_050 },
      { mode: 'fixed', fixedCents: -100 },
      { mode: 'drawer', fixedCents: 0 },
      { mode: 'fixed' },
      { mode: 'fixed', fixedCents: 0, extra: true },
    ]) {
      const o = await call('settings:setTill', { key: 'drawer.openingFloat', value });
      expect({ value, code: o.ok ? 'ok' : o.code }).toEqual({ value, code: 'validation_failed' });
    }
    expect(writtenRows()).toEqual(before);
    await data('settings:setTill', { key: 'drawer.openingFloat', value: { mode: 'fixed', fixedCents: 10_000_000 } });
    expect(db.prepare(`SELECT value_json FROM settings WHERE key = 'drawer.openingFloat'`).get()?.['value_json']).toBe(
      JSON.stringify({ mode: 'fixed', fixedCents: 10_000_000 }),
    );
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_id LIKE '%openingFloat%'`).get()?.['n']).toBe(0);
  });
});

describe.skipIf(!Sqlite)('reason buttons (orders.reasons)', () => {
  const custom = {
    v: 1,
    cancel: [
      { id: 'customer_cancelled', label: 'Customer changed mind', food: 'ask' },
      { id: 'rider_lost', label: 'Rider could not find it', food: 'made' },
    ],
    refund: [{ id: 'missing_item', label: 'Missing item', food: 'ask' }],
    cashOut: ['Test gas cylinder', 'Test vegetables'],
  };

  it('the counter gets today’s buttons until the owner saves, then the owner’s (synced and audited)', async () => {
    h.session = CASHIER;
    const rules = await data<CheckoutRules>('checkout:getRules');
    expect(rules.reasons).toEqual({ cancel: DEFAULT_ORDER_REASONS.cancel, refund: DEFAULT_ORDER_REASONS.refund, cashOut: [] });
    const before = writtenRows();
    await asOwner(() => data('settings:setBusiness', { key: 'orders.reasons', value: custom }));
    const after = writtenRows();
    expect([Number(after['audit_log']) - Number(before['audit_log']), Number(after['sync_queue']) - Number(before['sync_queue'])]).toEqual([1, 1]);
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      expect((await data<CheckoutRules>('checkout:getRules')).reasons).toEqual({ cancel: custom.cancel, refund: custom.refund, cashOut: custom.cashOut });
    }
  });

  it('a cashier and a manager are refused; the bounds are refused in the main process, nothing written', async () => {
    const before = writtenRows();
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      expect(await call('settings:setBusiness', { key: 'orders.reasons', value: custom })).toEqual({
        ok: false,
        code: 'forbidden',
        message: REFUSED['settings'],
      });
    }
    h.session = OWNER;
    const button = (label: string, id = 'test', food = 'ask') => ({ id, label, food });
    const nine = Array.from({ length: 9 }, (_, i) => button(`Test ${i}`, `t${i}`));
    for (const value of [
      { ...custom, cancel: [] },
      { ...custom, cancel: nine },
      { ...custom, refund: [button('x'.repeat(31))] },
      { ...custom, refund: [button('Same', 'a'), button('same', 'b')] },
      { ...custom, refund: [button('One', 'a'), button('Two', 'a')] },
      { ...custom, refund: [button(' Padded')] },
      { ...custom, refund: [button('Line\nbreak')] },
      { ...custom, refund: [button('Test', 'Bad Id')] },
      { ...custom, refund: [button('Test', 'test', 'maybe')] },
      { ...custom, cashOut: Array.from({ length: 9 }, (_, i) => `Test ${i}`) },
      { ...custom, cashOut: ['Gas', 'gas'] },
      { ...custom, v: 2 },
    ]) {
      const o = await call('settings:setBusiness', { key: 'orders.reasons', value });
      expect({ value, code: o.ok ? 'ok' : o.code }).toEqual({ value, code: 'validation_failed' });
    }
    expect(writtenRows()).toEqual(before);
  });

  it('any reason can still be typed, a reason and the manager’s PIN are still needed, and the words are what is saved', async () => {
    await asOwner(() => data('settings:setBusiness', { key: 'orders.reasons', value: custom }));
    const o1 = await sentOrder();
    h.session = CASHIER;
    expect(await call('orders:void', { orderId: o1, reason: '   ', approverPin: PIN, foodMade: 'not_made' })).toMatchObject({ ok: false });
    expect(await call('orders:void', { orderId: o1, reason: 'Typed by hand', foodMade: 'not_made' })).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    await data('orders:void', { orderId: o1, reason: 'Typed by hand, not a button', approverPin: PIN, foodMade: 'not_made' });
    expect(db.prepare(`SELECT void_reason FROM orders WHERE id = ?`).get(o1)?.['void_reason']).toBe('Typed by hand, not a button');
  });

  it('a renamed button leaves old rows as they were: Team & leakage lists each by the words it was saved with', async () => {
    // Cancelled with today's button…
    const old = await sentOrder();
    h.session = CASHIER;
    await data('orders:void', { orderId: old, reason: 'Customer cancelled', approverPin: PIN, foodMade: 'not_made' });
    // …the owner renames it (same id)…
    await asOwner(() => data('settings:setBusiness', { key: 'orders.reasons', value: custom }));
    // …and the next cancel taps the new words.
    const now = await sentOrder();
    h.session = CASHIER;
    await data('orders:void', { orderId: now, reason: 'Customer changed mind', approverPin: PIN, foodMade: 'not_made' });
    const { buildTeamTab } = await import('../../services/business-report.js');
    const team = buildTeamTab(db as never, {
      sinceIso: new Date(Date.now() - 3_600_000).toISOString(),
      untilIso: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const byOrder = Object.fromEntries(team.voids.map((v) => [v.orderId, v.reason]));
    expect(byOrder).toEqual({ [old]: 'Customer cancelled', [now]: 'Customer changed mind' });
  });

  it('a button’s "not made" never gets past the food having left the shop (FOOD_LEFT_SHOP): refused, and without an answer it counts as waste', async () => {
    await asOwner(() =>
      data('settings:setBusiness', {
        key: 'orders.reasons',
        value: { ...custom, cancel: [{ id: 'out_of_stock', label: 'Out of stock', food: 'not_made' }] },
      }),
    );
    const served = await sentOrder();
    h.session = CASHIER;
    await data('orders:markPreparing', { orderId: served });
    await data('orders:markReady', { orderId: served });
    await data('orders:markServed', { orderId: served });
    const { FOOD_LEFT_THE_SHOP } = await import('../../db/repositories/order-stock-repo.js');
    expect(
      await call('orders:void', { orderId: served, reason: 'Out of stock', approverPin: PIN, foodMade: 'not_made', expectStatus: 'served' }),
    ).toMatchObject({ ok: false, message: FOOD_LEFT_THE_SHOP });
    expect(db.prepare(`SELECT status FROM orders WHERE id = ?`).get(served)?.['status']).toBe('served');
    const done = await data<{ stock: { outcome: string } | null }>('orders:void', {
      orderId: served,
      reason: 'Out of stock',
      approverPin: PIN,
      expectStatus: 'served',
    });
    expect(done.stock?.outcome).toBe('made');
  });
});

describe.skipIf(!Sqlite)('"probably made" follows the owner’s amber minute', () => {
  it('an order sent 10 minutes ago: no lean at amber 15 (today), "probably made" once amber is 8', async () => {
    const orderId = await sentOrder();
    const { getOrderStockStatus } = await import('../../db/repositories/order-stock-repo.js');
    const tenMinutesOn = Date.now() + 10 * 60_000;
    expect(getOrderStockStatus(db as never, orderId, DEV, tenMinutesOn)?.question).toMatchObject({
      ask: 'choose',
      preselect: null,
      lean: null,
    });
    await asOwner(() => data('settings:setBusiness', { key: 'kitchen.timing', value: { v: 1, amberMin: 8, redMin: 30, notStartedMin: 10, notDoneMin: 30 } }));
    expect(getOrderStockStatus(db as never, orderId, DEV, tenMinutesOn)?.question).toMatchObject({
      ask: 'choose',
      preselect: null,
      lean: 'made',
      hint: expect.stringMatching(/probably made$/),
    });
  });
});
