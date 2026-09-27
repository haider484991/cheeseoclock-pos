/**
 * Settings phase 7 (Kitchen & stock) through the real IPC handlers and
 * repositories, on a real SQLite database built from every migration and a
 * made-up shop:
 *   - a till with nothing saved answers today's stock rules and import rule
 *     (3%, bands 2 / 3 / 5%, 6 days, no reminders, 3 ×, the seven waste
 *     reasons; the file wins), and writes nothing;
 *   - every bound is refused in the main process, with the reason, and
 *     nothing is written; the ends of each bound are taken;
 *   - a cashier and a manager are refused settings:setBusiness (and
 *     getBusiness) for both new keys, and nothing is written;
 *   - the counter reads the waste reasons, the multiple and the reminders
 *     (checkout:getRules) — never the variance's figures;
 *   - waste reasons keyed by their fixed id: a rename keeps old rows and
 *     Reports right; a reason the owner added works on the Waste screen and
 *     in Reports; one that rows use can be hidden but not removed (refused
 *     inside the save, nothing written), and once hidden it can't be picked;
 *     one no row uses can be removed; "Put back the default" keeps a used
 *     one, hidden;
 *   - a menu file import reads the owner's rule when it is previewed AND
 *     when it is applied (inside its transaction): the file's price by
 *     default (today), the till's kept — and said — when he asks.
 *
 * Only `defineHandler` (captured), the signed-in session (auth-service), the
 * printer spooler and the FBR worker are stood in for. node's own
 * `node:sqlite` stands in for better-sqlite3; skipped where it is missing.
 * Every name and amount is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MENU_IMPORT_POLICY,
  DEFAULT_STOCK_RULES,
  type AuthenticatedUser,
  type CheckoutRules,
  type StockRules,
  type UUID,
} from '@cheeseoclock/shared-types';
import { menuImportFileSchema } from '@cheeseoclock/shared-schemas';
import { DEV, DatabaseSync, OWNER as OWNER_ACTOR, openCostingShop, openMigrated } from '../../db/costing-shop.fixture.js';

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
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '' },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('../../services/auth-service.js', () => ({ getCurrentSession: () => h.session }));
vi.mock('../../services/print-spooler.js', () => ({ printSpooler: new Proxy({}, { get: () => () => undefined }) }));
vi.mock('../../services/fbr-worker.js', () => ({ fbrWorker: { kick: () => {}, resetAdapter: () => {} } }));

const session = (id: string, role: AuthenticatedUser['role']): AuthenticatedUser => ({ id: id as UUID, fullName: id, role, sessionId: 'sess' as UUID });
const CASHIER = session('u_cash', 'cashier');
const MANAGER = session('u_mgr', 'manager');
const OWNER = session('u_admin', 'admin');

let db: ReturnType<typeof openMigrated>;
let s: Awaited<ReturnType<typeof openCostingShop>>;
let REFUSED: Record<string, string>;

type Outcome = { ok: true; data: unknown } | { ok: false; code: string; message: string };
async function call(channel: string, payload?: unknown): Promise<Outcome> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  try {
    const r = (await fn({ db, deviceId: DEV }, payload)) as { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
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
async function as<T>(who: AuthenticatedUser, fn: () => Promise<T>): Promise<T> {
  const before = h.session;
  h.session = who;
  try {
    return await fn();
  } finally {
    h.session = before;
  }
}
const save = (key: string, value: unknown) => as(OWNER, () => call('settings:setBusiness', { key, value }));
/** One figure from the database. */
const one = (sql: string): unknown => Object.values((db.prepare(sql).get() as Record<string, unknown> | undefined) ?? {})[0];
/** The audit trail, the sync queue and both settings tables: a refusal changes none of them. */
const writtenRows = () =>
  Object.fromEntries(['audit_log', 'sync_queue', 'settings', 'business_settings', 'stock_movements'].map((t) => [t, one(`SELECT COUNT(*) AS n FROM ${t}`)]));

/** A copy of the released rules with changes (never the frozen default itself). */
const rules = (over: Partial<StockRules> = {}): StockRules => ({
  ...structuredClone(DEFAULT_STOCK_RULES as StockRules),
  ...over,
});
const withReasons = (edit: (r: StockRules['wasteReasons']) => StockRules['wasteReasons']) => rules({ wasteReasons: edit(rules().wasteReasons) });

/** Waste booked by hand on the Waste screen (inventory:recordMovement), as the manager. */
const waste = (reason: string, qty = 10) =>
  as(MANAGER, () => call('inventory:recordMovement', { ingredientId: s.ing.cheese, deltaQty: -qty, reason: 'waste', wasteReason: reason }));

const TODAY = () => ({ sinceIso: new Date(Date.now() - 3_600_000).toISOString(), untilIso: new Date(Date.now() + 3_600_000).toISOString() });
const report = async () => (await import('../../services/business-report.js')).getFoodCost(db as never, TODAY());

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.session = null;
  db = openMigrated();
  s = await openCostingShop(db);
  ({ REFUSED } = (await import('../guards.js')) as unknown as { REFUSED: Record<string, string> });
  const ctx = { db, deviceId: DEV } as never;
  (await import('./settings-handlers.js')).registerSettingsHandlers(ctx);
  (await import('./inventory-handlers.js')).registerInventoryHandlers(ctx);
});

const live = describe.skipIf(!DatabaseSync);
const NEW_KEYS = ['stock.rules', 'menu.importPolicy'] as const;

live('a till with nothing saved answers today’s rules', () => {
  it('the counter gets the seven waste reasons, a full bar at 3 × low and no reminders; nothing is written', async () => {
    const before = writtenRows();
    const r = await as(CASHIER, () => data<CheckoutRules>('checkout:getRules'));
    expect(r.stock).toEqual({
      reorderMultiple: 3,
      wasteReasons: DEFAULT_STOCK_RULES.wasteReasons,
      reminders: { keyItemsEveryDays: null, fullEveryDays: null },
    });
    // …never the variance's own figures.
    expect(JSON.stringify(r.stock)).not.toMatch(/varianceDoThis|bands|MinWindow/);
    expect(writtenRows()).toEqual(before);
  });

  it('each owner card reads its default, never changed, not read-only', async () => {
    for (const [key, value] of [
      ['stock.rules', DEFAULT_STOCK_RULES],
      ['menu.importPolicy', DEFAULT_MENU_IMPORT_POLICY],
    ] as const) {
      const card = await as(OWNER, () => data<Record<string, unknown>>('settings:getBusiness', { key }));
      expect({ key, card }).toMatchObject({ key, card: { key, value, defaultValue: value, isDefault: true, readOnly: false, lastChanged: null } });
    }
    expect(one(`SELECT COUNT(*) AS n FROM business_settings`)).toBe(0);
  });
});

live('bounds, in the main process', () => {
  it('every value out of bounds is refused with the reason, and nothing is written', async () => {
    const before = writtenRows();
    const bad: Array<[string, unknown]> = [
      ['"Do this" under 0.5%', rules({ varianceDoThisBps: 40 })],
      ['"Do this" over 20%', rules({ varianceDoThisBps: 2_010 })],
      ['"Do this" with two decimals', rules({ varianceDoThisBps: 305 })],
      ['bands out of order', rules({ bands: { goodUnderBps: 300, okUpToBps: 300, needsWorkUpToBps: 500 } })],
      ['a band over 20%', rules({ bands: { goodUnderBps: 200, okUpToBps: 300, needsWorkUpToBps: 2_100 } })],
      ['a stretch of 0 days', rules({ varianceMinWindowDays: 0 })],
      ['a stretch of 29 days', rules({ varianceMinWindowDays: 29 })],
      ['key items every 0 days', rules({ reminders: { keyItemsEveryDays: 0, fullEveryDays: null } })],
      ['key items every 32 days', rules({ reminders: { keyItemsEveryDays: 32, fullEveryDays: null } })],
      ['full every 6 days', rules({ reminders: { keyItemsEveryDays: null, fullEveryDays: 6 } })],
      ['full every 93 days', rules({ reminders: { keyItemsEveryDays: null, fullEveryDays: 93 } })],
      ['a full bar at 1 ×', rules({ reorderMultiple: 1 })],
      ['a full bar at 11 ×', rules({ reorderMultiple: 11 })],
      ['a full bar at 2.5 ×', rules({ reorderMultiple: 2.5 })],
      ['a built-in reason removed', withReasons((r) => r.filter((x) => x.id !== 'staff_meal'))],
      ['two reasons with one name', withReasons((r) => [...r, { id: 'burnt_again', label: 'BURNT', hidden: false }])],
      ['every reason hidden', withReasons((r) => r.map((x) => ({ ...x, hidden: true })))],
      ['an id that is not one', withReasons((r) => [...r, { id: 'Spilled Milk', label: 'Spilled milk', hidden: false }])],
      ['an id Reports keep', withReasons((r) => [...r, { id: 'test_order', label: 'Test', hidden: false }])],
      ['a name of 31 letters', withReasons((r) => [...r, { id: 'long', label: 'x'.repeat(31), hidden: false }])],
      ['a name on two lines', withReasons((r) => [...r, { id: 'two', label: 'Two\nlines', hidden: false }])],
      ['17 reasons', withReasons((r) => [...r, ...Array.from({ length: 10 }, (_, i) => ({ id: `extra_${i}`, label: `Extra ${i}`, hidden: false }))])],
      ['a field this version does not know', { ...rules(), colour: 'red' }],
      ['a newer format', { ...rules(), v: 2 }],
    ];
    for (const [why, value] of bad) {
      const o = await save('stock.rules', value);
      expect({ why, code: o.ok ? 'ok' : o.code }).toEqual({ why, code: 'validation_failed' });
    }
    for (const value of [
      { ...DEFAULT_MENU_IMPORT_POLICY, itemPrices: 'both' },
      { ...DEFAULT_MENU_IMPORT_POLICY, extra: 'file' },
      { v: 1, itemPrices: 'till' },
    ]) {
      const o = await save('menu.importPolicy', value);
      expect({ value, code: o.ok ? 'ok' : o.code }).toEqual({ value, code: 'validation_failed' });
    }
    // The reason is said in plain words.
    expect(await save('stock.rules', rules({ reorderMultiple: 11 }))).toMatchObject({ message: 'A full stock bar is at most 10 times the low level' });
    expect(await save('stock.rules', withReasons((r) => r.filter((x) => x.id !== 'staff_meal')))).toMatchObject({
      message: '"Staff meal" is one of the till\'s own reasons: hide it instead of removing it',
    });
    expect(writtenRows()).toEqual(before);
  });

  it('the ends of every bound are taken', async () => {
    for (const value of [
      rules({ varianceDoThisBps: 50, varianceMinWindowDays: 1, reorderMultiple: 2, reminders: { keyItemsEveryDays: 1, fullEveryDays: 7 } }),
      rules({
        varianceDoThisBps: 2_000,
        varianceMinWindowDays: 28,
        reorderMultiple: 10,
        reminders: { keyItemsEveryDays: 31, fullEveryDays: 92 },
        bands: { goodUnderBps: 50, okUpToBps: 1_990, needsWorkUpToBps: 2_000 },
      }),
      withReasons((r) => [...r, ...Array.from({ length: 9 }, (_, i) => ({ id: `extra_${i}`, label: `Extra ${i}`, hidden: false }))]),
      { ...DEFAULT_MENU_IMPORT_POLICY, itemPrices: 'till', choices: 'till', recipes: 'till', tax: 'till' },
    ]) {
      const key = 'itemPrices' in value ? 'menu.importPolicy' : 'stock.rules';
      const o = await save(key, value);
      expect({ value, ok: o.ok }).toEqual({ value, ok: true });
    }
  });
});

live('the owner’s alone', () => {
  it('a cashier and a manager are refused every save and every card of the new keys, and nothing is written', async () => {
    const before = writtenRows();
    for (const who of [CASHIER, MANAGER]) {
      for (const payload of [
        { key: 'stock.rules', value: rules({ reorderMultiple: 4 }) },
        { key: 'menu.importPolicy', value: { ...DEFAULT_MENU_IMPORT_POLICY, itemPrices: 'till' } },
        { key: 'stock.rules', useDefault: true },
        { key: 'menu.importPolicy', useDefault: true },
      ]) {
        const o = await as(who, () => call('settings:setBusiness', payload));
        expect({ who: who.role, payload, o }).toEqual({ who: who.role, payload, o: { ok: false, code: 'forbidden', message: REFUSED['settings'] } });
      }
      for (const key of NEW_KEYS) {
        expect({ who: who.role, key, o: await as(who, () => call('settings:getBusiness', { key })) }).toMatchObject({ who: who.role, key, o: { ok: false, code: 'forbidden' } });
      }
    }
    expect(writtenRows()).toEqual(before);
  });

  it('the owner saves (synced and audited); the counter then reads his reasons, multiple and reminders', async () => {
    const mine = withReasons((r) => [...r.slice(0, -1), { id: 'spilled', label: 'Spilled', hidden: false }, r[r.length - 1]!]);
    mine.reorderMultiple = 4;
    mine.reminders = { keyItemsEveryDays: 7, fullEveryDays: null };
    expect((await save('stock.rules', mine)).ok).toBe(true);
    expect((await save('menu.importPolicy', { ...DEFAULT_MENU_IMPORT_POLICY, itemPrices: 'till' })).ok).toBe(true);
    const audited = one(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'business_settings'`);
    const queued = one(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'business_settings'`);
    expect({ audited, queued }).toEqual({ audited: 2, queued: 2 });
    for (const who of [CASHIER, MANAGER]) {
      const r = await as(who, () => data<CheckoutRules>('checkout:getRules'));
      expect(r.stock).toEqual({ reorderMultiple: 4, wasteReasons: mine.wasteReasons, reminders: { keyItemsEveryDays: 7, fullEveryDays: null } });
    }
  });
});

live('waste reasons are keyed by a fixed id', () => {
  it('a rename keeps the old rows and Reports right: same reason, the new name', async () => {
    expect((await waste('burnt')).ok).toBe(true);
    expect((await report()).wasteByReason).toMatchObject([{ reason: 'burnt', times: 1 }]);
    expect((await report()).wasteLabels).toBeUndefined();
    expect((await save('stock.rules', withReasons((r) => r.map((x) => (x.id === 'burnt' ? { ...x, label: 'Burnt edges' } : x))))).ok).toBe(true);
    // The row is untouched; Reports count it under the same reason, with the owner's name for it.
    expect(db.prepare(`SELECT detail FROM stock_movements WHERE reason = 'waste'`).all()).toEqual([{ detail: 'waste:burnt' }]);
    const after = await report();
    expect(after.wasteByReason).toMatchObject([{ reason: 'burnt', times: 1 }]);
    expect(after.wasteLabels).toEqual({ burnt: 'Burnt edges' });
    // New waste under the renamed reason joins the same line.
    expect((await waste('burnt')).ok).toBe(true);
    expect((await report()).wasteByReason).toMatchObject([{ reason: 'burnt', times: 2 }]);
  });

  it('a reason the owner adds: on the Waste screen and in Reports; used, it can be hidden, not removed; hidden, it can’t be picked', async () => {
    const added = withReasons((r) => [...r.slice(0, -1), { id: 'spilled', label: 'Spilled', hidden: false }, r[r.length - 1]!]);
    expect((await save('stock.rules', added)).ok).toBe(true);
    expect((await waste('spilled')).ok).toBe(true);
    expect((await waste('dropped')).ok).toBe(true);
    const r1 = await report();
    // In the owner's order: his reason before Other, after the till's own.
    expect(r1.wasteByReason.map((w) => w.reason)).toEqual(['dropped', 'spilled']);
    expect(r1.wasteLabels).toEqual({ spilled: 'Spilled' });

    // Removing it now is refused inside the save, in plain words, and nothing is written.
    const before = writtenRows();
    const removed = await save('stock.rules', rules());
    expect(removed).toEqual({
      ok: false,
      code: 'validation_failed',
      message: '“Spilled” is on 1 waste entry, so it can\'t be removed: hide it instead (old entries keep its name).',
    });
    expect(writtenRows()).toEqual(before);

    // Hidden: off the Waste screen (refused there), still named in Reports.
    const hidden = { ...added, wasteReasons: added.wasteReasons.map((x) => (x.id === 'spilled' ? { ...x, hidden: true } : x)) };
    expect((await save('stock.rules', hidden)).ok).toBe(true);
    const beforePick = writtenRows();
    expect(await waste('spilled')).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(writtenRows()).toEqual(beforePick);
    expect((await report()).wasteLabels).toEqual({ spilled: 'Spilled' });
    // A reason nobody ever had is refused too, as before.
    expect(await waste('eaten')).toMatchObject({ ok: false, code: 'validation_failed' });
  });

  it('a reason no row uses can be removed', async () => {
    const added = withReasons((r) => [...r, { id: 'mice', label: 'Mice', hidden: false }]);
    expect((await save('stock.rules', added)).ok).toBe(true);
    expect((await save('stock.rules', rules())).ok).toBe(true);
    const card = await as(OWNER, () => data<{ value: StockRules; isDefault: boolean }>('settings:getBusiness', { key: 'stock.rules' }));
    expect(card).toMatchObject({ value: DEFAULT_STOCK_RULES, isDefault: true });
  });

  it('"Put back the default": today’s rules, and a reason the owner added that rows use stays, hidden', async () => {
    const mine = withReasons((r) => [
      ...r.map((x) => (x.id === 'burnt' ? { ...x, label: 'Burnt edges' } : x)),
      { id: 'spilled', label: 'Spilled', hidden: false },
      { id: 'mice', label: 'Mice', hidden: false },
    ]);
    mine.reorderMultiple = 5;
    expect((await save('stock.rules', mine)).ok).toBe(true);
    expect((await waste('spilled')).ok).toBe(true);
    const card = await as(OWNER, () => data<{ value: StockRules; isDefault: boolean }>('settings:setBusiness', { key: 'stock.rules', useDefault: true }));
    expect(card.value).toEqual({ ...DEFAULT_STOCK_RULES, wasteReasons: [...DEFAULT_STOCK_RULES.wasteReasons, { id: 'spilled', label: 'Spilled', hidden: true }] });
    expect(card.isDefault).toBe(false);
    // The old row still has its name.
    expect((await report()).wasteLabels).toEqual({ spilled: 'Spilled' });
  });
});

live('a menu file import follows the owner’s rule', () => {
  /** A file with the wings dearer than on the till (Rs 850 against Rs 800). */
  const menuFile = () =>
    menuImportFileSchema.parse({
      format: 'cheeseoclock-menu-import',
      version: 1,
      categories: [{ name: 'Wings' }],
      ingredients: [],
      items: [{ name: 'Baked Wings', category: 'Wings', priceCents: 85_000, recipe: [] }],
    });
  const wingsPrice = () => one(`SELECT base_price_cents AS p FROM menu_items WHERE name = 'Baked Wings'`);
  const repo = () => import('../../db/repositories/menu-import-repo.js');

  it('nothing saved: the file’s price comes in, as today', async () => {
    const r = await repo();
    const preview = r.planMenuImportFromDb(db as never, menuFile()).preview;
    expect(preview.items[0]).toMatchObject({ action: 'update', changes: ['price Rs 800 → Rs 850'] });
    expect(preview.summary.keptLine).toBeNull();
    r.applyMenuImport(db as never, menuFile(), 'test.json', OWNER_ACTOR);
    expect(wingsPrice()).toBe(85_000);
  });

  it('“keep the till’s”: the preview says it is kept on the till, and the import keeps it', async () => {
    expect((await save('menu.importPolicy', { ...DEFAULT_MENU_IMPORT_POLICY, itemPrices: 'till' })).ok).toBe(true);
    const r = await repo();
    const preview = r.planMenuImportFromDb(db as never, menuFile()).preview;
    expect(preview.items[0]).toMatchObject({ action: 'same', keptOnTill: ['price Rs 800 (the file says Rs 850)'] });
    expect(preview.summary.keptLine).toBe('Kept on the till: 1 price (Settings → Kitchen & stock).');
    const summary = r.applyMenuImport(db as never, menuFile(), 'test.json', OWNER_ACTOR);
    expect(summary).toMatchObject({ priceChanges: 0, keptOnTill: { prices: 1 } });
    expect(wingsPrice()).toBe(80_000);
  });

  it('a Save between the preview and Apply counts: Apply re-reads the rule inside its transaction', async () => {
    const r = await repo();
    expect(r.planMenuImportFromDb(db as never, menuFile()).preview.items[0]?.changes).toEqual(['price Rs 800 → Rs 850']);
    expect((await save('menu.importPolicy', { ...DEFAULT_MENU_IMPORT_POLICY, itemPrices: 'till' })).ok).toBe(true);
    r.applyMenuImport(db as never, menuFile(), 'test.json', OWNER_ACTOR);
    expect(wingsPrice()).toBe(80_000);
  });
});

live('the default food-cost target (costing.targets defaultBps, already stored): the new box on Costing → Targets', () => {
  it('saved from the box, it is what a category the till has no suggestion for starts at; out of bounds is refused', async () => {
    const { saveCostingTargets } = await import('../../services/costing-settings.js');
    const { getCostingTargets } = await import('../../services/costing-service.js');
    const { createCategory } = await import('../../db/repositories/category-repo.js');
    const wraps = createCategory(db as never, { name: 'Test Wraps', displayOrder: 9, colorHex: '#aa5500' }, OWNER_ACTOR).id;
    // Nothing saved: today's 30%.
    expect(getCostingTargets(db as never)).toMatchObject({ defaultBps: 3_000 });
    expect(getCostingTargets(db as never).categories.find((c) => c.categoryId === wraps)).toMatchObject({ bps: 3_000, suggestedBps: 3_000, confirmed: false });
    const view = saveCostingTargets(db as never, { defaultBps: 2_750, amberBps: 500, perCategory: {}, nonFoodCategoryIds: [], priceStepCents: 1_000 }, OWNER_ACTOR);
    expect(view.defaultBps).toBe(2_750);
    expect(view.categories.find((c) => c.categoryId === wraps)).toMatchObject({ bps: 2_750, suggestedBps: 2_750, confirmed: false });
    // A category the till knows by its name keeps its own suggestion (Pizza 30%).
    expect(view.categories.find((c) => c.name === 'Pizza')).toMatchObject({ suggestedBps: 3_000 });
    expect(() => saveCostingTargets(db as never, { defaultBps: 0, amberBps: 500, perCategory: {}, nonFoodCategoryIds: [], priceStepCents: 1_000 }, OWNER_ACTOR)).toThrow(/above 0%/);
    expect(() => saveCostingTargets(db as never, { defaultBps: 10_100, amberBps: 500, perCategory: {}, nonFoodCategoryIds: [], priceStepCents: 1_000 }, OWNER_ACTOR)).toThrow(/above 100%/);
    expect(getCostingTargets(db as never).defaultBps).toBe(2_750);
  });
});
