/**
 * The price channels (costing spec Phase 4) through the real IPC handlers,
 * against a real database built from every migration and a made-up shop
 * (db/costing-shop.fixture.ts):
 *   - a cashier is refused "Set price" and the price history in the main
 *     process, and nothing is written;
 *   - a manager sets a price as it is bought (per kg, per pack of N, per
 *     piece, free), kept exactly, and reads the history back, newest first,
 *     with where each price came from and who set it;
 *   - the Ingredients list carries each ingredient's newest history entry
 *     (source and the price before) for the price column.
 *
 * Only `defineHandler` (captured) and the signed-in session are stood in
 * for. node:sqlite behind better-sqlite3's shape; skips where it is
 * missing. Every name and price is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, Ingredient, PriceHistoryEntry, UUID } from '@cheeseoclock/shared-types';
import { DatabaseSync, DEV, openCostingShop, openMigrated } from '../../db/costing-shop.fixture.js';

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
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => '' } }));
vi.mock('../../services/auth-service.js', () => ({ getCurrentSession: () => h.session }));

const session = (id: string, role: AuthenticatedUser['role']): AuthenticatedUser => ({
  id: id as UUID,
  fullName: id,
  role,
  sessionId: 'sess' as UUID,
});
const CASHIER = session('u_cash', 'cashier');
const MANAGER = session('u_mgr', 'manager');

let db: ReturnType<typeof openMigrated>;
let s: Awaited<ReturnType<typeof openCostingShop>>;

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
    // defineHandler turns a plain repository Error into precondition_failed.
    return { ok: false, code: 'precondition_failed', message: e instanceof Error ? e.message : String(e) };
  }
}
async function data<T>(channel: string, payload?: unknown): Promise<T> {
  const o = await call(channel, payload);
  if (!o.ok) throw new Error(`${channel} refused: ${o.code} ${o.message}`);
  return o.data as T;
}
const count = (sql: string, ...p: unknown[]) => Number((db.prepare(sql).get(...p) as { n: number }).n);

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.session = null;
  db = openMigrated();
  s = await openCostingShop(db);
  (await import('./inventory-handlers.js')).registerInventoryHandlers({ db, deviceId: DEV } as never);
});

const live = describe.skipIf(!DatabaseSync);

live('prices: a cashier is refused in the main process', () => {
  it('"Set price" and the price history say no, in plain words, and nothing is written', async () => {
    h.session = CASHIER;
    const rows = count(`SELECT COUNT(*) AS n FROM ingredient_costs`);
    const set = await call('inventory:setPrice', { ingredientId: s.ing.cheese, per: 'thousand', priceCents: 1 });
    expect(set).toEqual({ ok: false, code: 'forbidden', message: 'Only a manager or the owner can change prices.' });
    const history = await call('inventory:priceHistory', { ingredientId: s.ing.cheese });
    expect(history).toEqual({ ok: false, code: 'forbidden', message: 'Only a manager or the owner can see costs.' });
    expect(count(`SELECT COUNT(*) AS n FROM ingredient_costs`)).toBe(rows);
    expect(db.prepare(`SELECT pack_price_cents FROM ingredients WHERE id = ?`).get(s.ing.cheese)).toEqual({ pack_price_cents: 240_000 });
    h.session = null;
    expect(await call('inventory:priceHistory', { ingredientId: s.ing.cheese })).toMatchObject({ ok: false, code: 'unauthenticated' });
  });
});

live('prices: a manager', () => {
  it('sets a price as it is bought, kept exactly, and reads the history newest first', async () => {
    h.session = MANAGER;
    const perKg = await data<Ingredient>('inventory:setPrice', { ingredientId: s.ing.onion, per: 'thousand', priceCents: 15_500 });
    expect(perKg).toMatchObject({ packSize: 1000, packPriceCents: 15_500, costPerUnitCents: 16, priceKind: 'set' });
    const pack = await data<Ingredient>('inventory:setPrice', {
      ingredientId: s.ing.cup,
      per: 'pack',
      priceCents: 1_000,
      packSize: 12,
      priceKind: 'estimate',
      notes: 'Market run',
    });
    expect(pack).toMatchObject({ packSize: 12, packPriceCents: 1_000, priceKind: 'estimate' });
    const free = await data<Ingredient>('inventory:setPrice', { ingredientId: s.ing.box, per: 'piece', priceCents: 0, priceKind: 'free' });
    expect(free).toMatchObject({ priceKind: 'free', costPerUnitCents: 0, packSize: null });

    const history = await data<PriceHistoryEntry[]>('inventory:priceHistory', { ingredientId: s.ing.onion });
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ source: 'manual', unit: 'g', packSize: 1000, packPriceCents: 15_500, unitCostMc: 15_500, prevUnitCostMc: 15_000, actorName: 'Test Manager' });
    expect(history[1]).toMatchObject({ source: 'manual', packSize: 1000, packPriceCents: 15_000, prevUnitCostMc: null });
    expect((await data<PriceHistoryEntry[]>('inventory:priceHistory', { ingredientId: s.ing.cup }))[0]).toMatchObject({ notes: 'Market run' });
  });

  it('says what is wrong with a price that does not fit, and writes nothing', async () => {
    h.session = MANAGER;
    const rows = count(`SELECT COUNT(*) AS n FROM ingredient_costs`);
    expect(await call('inventory:setPrice', { ingredientId: s.ing.onion, per: 'pack', priceCents: 100 })).toMatchObject({
      ok: false,
      code: 'validation_failed',
      message: 'packSize: Say how much one pack holds',
    });
    expect(await call('inventory:setPrice', { ingredientId: s.ing.onion, per: 'piece', priceCents: 100 })).toMatchObject({
      ok: false,
      code: 'precondition_failed',
      message: expect.stringMatching(/^Per piece does not fit something counted in g/),
    });
    expect(await call('inventory:setPrice', { ingredientId: s.ing.onion, per: 'thousand', priceCents: 10.5 })).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
    expect(count(`SELECT COUNT(*) AS n FROM ingredient_costs`)).toBe(rows);
  });

  it('the Ingredients list carries where each price came from, and the price before', async () => {
    h.session = MANAGER;
    await data('inventory:setPrice', { ingredientId: s.ing.cheese, per: 'thousand', priceCents: 132_000 });
    const list = await data<Ingredient[]>('inventory:listIngredients');
    const cheese = list.find((i) => i.id === s.ing.cheese)!;
    // Rs 1,200 / kg → Rs 1,320 / kg: 10% dearer.
    expect(cheese.latestPrice).toMatchObject({ source: 'manual', unitCostMc: 132_000, prevUnitCostMc: 120_000, packSize: 1000 });
    const sauce = list.find((i) => i.id === s.ing.sauce)!;
    expect(sauce.latestPrice).toMatchObject({ source: 'batch', packSize: 2000, packPriceCents: 35_625 });
    expect(list.every((i) => i.latestPrice !== undefined)).toBe(true);
    // The sauce's price is worked out from its recipe (every input priced); a bought-in one's is not.
    expect(sauce.priceFromRecipe).toBe(true);
    expect(cheese.priceFromRecipe).toBe(false);
  });

  it('"Set price" on a batch costed from its recipe is refused in plain words, and nothing is written', async () => {
    h.session = MANAGER;
    const rows = count(`SELECT COUNT(*) AS n FROM ingredient_costs WHERE ingredient_id = ?`, s.ing.sauce);
    expect(await call('inventory:setPrice', { ingredientId: s.ing.sauce, per: 'thousand', priceCents: 90_000 })).toEqual({
      ok: false,
      code: 'precondition_failed',
      message: 'Test sauce is made here, so its price is worked out from its batch recipe. To change it, change the price of what goes into it, or its recipe.',
    });
    expect(count(`SELECT COUNT(*) AS n FROM ingredient_costs WHERE ingredient_id = ?`, s.ing.sauce)).toBe(rows);
    // With an input unpriced it can't be worked out: the list says so, and a typed price is taken.
    await data('inventory:setPrice', { ingredientId: s.ing.garlic, per: 'thousand', priceCents: 0 });
    const list = await data<Ingredient[]>('inventory:listIngredients');
    expect(list.find((i) => i.id === s.ing.sauce)!.priceFromRecipe).toBe(false);
    expect(await data<Ingredient>('inventory:setPrice', { ingredientId: s.ing.sauce, per: 'thousand', priceCents: 20_000, priceKind: 'estimate' })).toMatchObject({
      packSize: 1000,
      packPriceCents: 20_000,
      priceKind: 'estimate',
    });
  });
});
