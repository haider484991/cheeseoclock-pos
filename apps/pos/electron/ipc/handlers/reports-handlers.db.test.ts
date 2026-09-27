/**
 * The Reports channels after costing Phase 2, through the real IPC handlers
 * against a real database built from every migration (a made-up shop,
 * db/costing-shop.fixture.ts):
 *   - the older one-figure channels (salesSummary, cogs…) are no longer
 *     registered: only the page (reports:business) and low stock remain;
 *   - a cashier is refused both in the main process; a manager's report
 *     carries the food cost, with the cost each sale kept;
 *   - stock rows carry their values for a login that may see costs, and
 *     "Make this amount" answers with none.
 *
 * Only `defineHandler` (captured) and the signed-in session are stood in
 * for. node:sqlite behind better-sqlite3's shape; skips where it is
 * missing. Every name and price is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, BusinessReport, StockMovementPage, UUID } from '@cheeseoclock/shared-types';
import { CASHIER as CASHIER_ACTOR, DatabaseSync, DEV, MANAGER as MANAGER_ACTOR, openCostingShop, openMigrated } from '../../db/costing-shop.fixture.js';

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
    return { ok: false, code: 'precondition_failed', message: e instanceof Error ? e.message : String(e) };
  }
}

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.session = null;
  db = openMigrated();
  s = await openCostingShop(db);
  const ctx = { db, deviceId: DEV } as never;
  (await import('./reports-handlers.js')).registerReportsHandlers(ctx);
  (await import('./inventory-handlers.js')).registerInventoryHandlers(ctx);
});

const live = describe.skipIf(!DatabaseSync);
const AROUND_NOW = () => ({
  sinceIso: new Date(Date.now() - 3_600_000).toISOString(),
  untilIso: new Date(Date.now() + 3_600_000).toISOString(),
});

live('Reports channels', () => {
  it('the older one-figure channels are retired: only the page and low stock are registered', () => {
    expect([...h.handlers.keys()].filter((c) => c.startsWith('reports:')).sort()).toEqual(['reports:business', 'reports:lowStock']);
  });

  it('a cashier is refused the report and low stock in the main process', async () => {
    h.session = CASHIER;
    for (const [channel, payload] of [
      ['reports:business', AROUND_NOW()],
      ['reports:lowStock', undefined],
    ] as const) {
      expect(await call(channel, payload)).toMatchObject({ ok: false, code: 'forbidden' });
    }
  });

  it('a manager gets the food cost, from the cost each sale kept', async () => {
    const o = s.ring([['fajitaM', 1]]);
    s.r.decrementForOrder(db, o, CASHIER_ACTOR);
    s.markPaid(o);
    h.session = MANAGER;
    const r = await call('reports:business', AROUND_NOW());
    expect(r.ok).toBe(true);
    const report = (r as { data: BusinessReport }).data;
    expect(report.foodCost).toMatchObject({ costOfSalesCents: 17_641, knownSalesCents: 120_000, foodCostBps: 1_470, coverageBps: 10_000 });
  });
});

live('stock rows and their values', () => {
  it('a manager\'s stock history carries what each row was worth; "Make this amount" answers with no costs', async () => {
    h.session = MANAGER;
    s.r.recordStockMovement(db, { ingredientId: s.ing.cheese, deltaQty: -10, reason: 'waste', wasteReason: 'dropped' }, MANAGER_ACTOR);
    const page = (await call('inventory:searchMovements', { reason: 'waste' })) as { ok: true; data: StockMovementPage };
    expect(page.data.rows.map((m) => [m.detail, m.valueCents, m.unitCostMc, m.costBasis])).toEqual([['waste:dropped', -1_200, 120_000, 'price']]);

    const made = await call('inventory:makeBatch', { ingredientId: s.ing.sauce, amount: 200 });
    expect(made).toEqual({ ok: true, data: { made: 200, resultingQty: s.stockOf('sauce') } });

    h.session = CASHIER;
    expect(await call('inventory:searchMovements', {})).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('waste by hand says why; a reason on anything but waste is refused', async () => {
    h.session = MANAGER;
    const ok = await call('inventory:recordMovement', { ingredientId: s.ing.dough, deltaQty: -50, reason: 'waste', wasteReason: 'burnt' });
    expect(ok.ok).toBe(true);
    expect(db.prepare(`SELECT detail FROM stock_movements WHERE ingredient_id = ?`).get(s.ing.dough)).toEqual({ detail: 'waste:burnt' });
    expect(await call('inventory:recordMovement', { ingredientId: s.ing.dough, deltaQty: 5, reason: 'delivery', wasteReason: 'burnt' })).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
    expect(await call('inventory:recordMovement', { ingredientId: s.ing.dough, deltaQty: -5, reason: 'waste', wasteReason: 'eaten' })).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
  });
});
