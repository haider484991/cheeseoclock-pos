/**
 * Stock takes and "used vs should have used" through the real IPC handlers
 * (costing spec Phase 8), against a real database built from every
 * migration and a made-up shop:
 *   - a cashier is refused every stock-take channel and the variance in the
 *     main process, in plain words, and nothing is written;
 *   - a manager counts the key items over IPC; a fraction is refused;
 *     finishing twice writes nothing;
 *   - the finish says when "expected" may be short of the other till's rows:
 *     two tills taking orders with the link off, or the link on but paused —
 *     and says nothing for one till with the link off (the shop as it runs);
 *   - a stock take is no longer booked as a plain stock row;
 *   - the variance is Reports (report.view), so the owner's since
 *     2026-09-27: a manager still counts, and is refused the variance in
 *     plain words;
 *   - without the Reports worker, the variance is worked out here for 31
 *     days or less, and refused in plain words beyond.
 *
 * Only `defineHandler` (captured), the signed-in session and the worker are
 * stood in for. node:sqlite; skips where it is missing. Every name, price
 * and quantity is made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, ReportVariance, StockCountDetail, StockCountFinish, UUID } from '@cheeseoclock/shared-types';
import { DatabaseSync, DEV, OWNER as OWNER_ACTOR, openCostingShop, openMigrated } from '../../db/costing-shop.fixture.js';

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
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => '' }, safeStorage: { isEncryptionAvailable: () => false } }));
vi.mock('../../services/auth-service.js', () => ({ getCurrentSession: () => h.session }));

const session = (id: string, role: AuthenticatedUser['role']): AuthenticatedUser => ({ id: id as UUID, fullName: id, role, sessionId: 'sess' as UUID });
const CASHIER = session('u_cash', 'cashier');
const MANAGER = session('u_mgr', 'manager');
const OWNER = session('u_admin', 'admin');

let db: ReturnType<typeof openMigrated>;
let s: Awaited<ReturnType<typeof openCostingShop>>;

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
    return { ok: false, code: 'precondition_failed', message: e instanceof Error ? e.message : String(e) };
  }
}
async function data<T>(channel: string, payload?: unknown): Promise<T> {
  const o = await call(channel, payload);
  if (!o.ok) throw new Error(`${channel} refused: ${o.code} ${o.message}`);
  return o.data as T;
}
const count = (sql: string, ...p: unknown[]) => Number((db.prepare(sql).get(...p) as { n: number }).n);
const clock = (iso: string) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
};

const live = describe.skipIf(!DatabaseSync);

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.session = null;
  db = openMigrated();
  s = await openCostingShop(db);
  const ctx = { db, deviceId: DEV } as never;
  (await import('./inventory-handlers.js')).registerInventoryHandlers(ctx);
  (await import('./costing-handlers.js')).registerCostingHandlers(ctx);
  // No Reports worker: the main process works the variance out itself (31 days at most).
  (await import('./reports-handlers.js')).registerReportsHandlers(ctx, { worker: () => null });
});

afterEach(() => {
  vi.useRealTimers();
});

/** A stock take of the key items over IPC, every line counted at the till's count less `short` of cheese-like items. */
async function countKeyItems(adjust: (id: string, till: number) => number = (_id, till) => till): Promise<StockCountFinish> {
  const started = await data<StockCountDetail>('inventory:stockCountStart', { scope: 'key_items' });
  const till = (id: string) => Number((db.prepare(`SELECT current_qty AS q FROM ingredients WHERE id = ?`).get(id) as { q: number }).q);
  await data('inventory:stockCountSave', { countId: started.id, lines: started.lines.map((l) => ({ ingredientId: l.ingredientId, countedQty: adjust(l.ingredientId, till(l.ingredientId)) })) });
  return data<StockCountFinish>('inventory:stockCountFinish', { countId: started.id });
}

live('stock takes over IPC (costing Phase 8)', () => {
  it('a cashier is refused every stock-take channel and the variance, in plain words; nothing is written', async () => {
    h.session = CASHIER;
    const channels: Record<string, unknown> = {
      'inventory:stockCountList': undefined,
      'inventory:stockCountGet': { countId: 'x' },
      'inventory:stockCountStart': { scope: 'full' },
      'inventory:stockCountSave': { countId: 'x', lines: [{ ingredientId: s.ing.cheese, countedQty: 1 }] },
      'inventory:stockCountFinish': { countId: 'x' },
      'inventory:stockCountCancel': { countId: 'x' },
      'inventory:stockCountOne': { ingredientId: s.ing.cheese, countedQty: 1 },
    };
    expect(Object.keys(channels).sort()).toEqual([...h.handlers.keys()].filter((c) => c.startsWith('inventory:stockCount')).sort());
    for (const [channel, payload] of Object.entries(channels)) {
      expect({ channel, o: await call(channel, payload) }).toEqual({
        channel,
        o: { ok: false, code: 'forbidden', message: 'Only a manager or the owner can do a stock take or see what went missing.' },
      });
    }
    expect(await call('reports:variance', {})).toEqual({ ok: false, code: 'forbidden', message: 'Only the owner can see reports.' });
    expect(await call('costing:getTills')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(count(`SELECT COUNT(*) AS n FROM stock_counts`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM stock_movements WHERE reason = 'count'`)).toBe(0);
    // Nobody signed in: "not logged in".
    h.session = null;
    expect(await call('inventory:stockCountStart', { scope: 'full' })).toMatchObject({ ok: false, code: 'unauthenticated' });
  });

  it('a manager counts the key items; a fraction is refused; finishing twice writes nothing; one till with the link off says nothing more', async () => {
    h.session = MANAGER;
    const started = await data<StockCountDetail>('inventory:stockCountStart', { scope: 'key_items' });
    expect(started.lines.map((l) => l.name).sort()).toEqual(['Test box', 'Test chicken', 'Test dough']);
    expect(await call('inventory:stockCountSave', { countId: started.id, lines: [{ ingredientId: s.ing.dough, countedQty: 12.5 }] })).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
    expect(await data('inventory:stockCountSave', { countId: started.id, lines: [{ ingredientId: s.ing.dough, countedQty: 99_000 }] })).toEqual({ lineCount: 3, countedCount: 1 });
    const done = await data<StockCountFinish>('inventory:stockCountFinish', { countId: started.id });
    expect(done).toMatchObject({ alreadyFinished: false, expectedNote: null });
    expect(done.count.lines.find((l) => l.ingredientId === s.ing.dough)).toMatchObject({ differenceQty: -1_000, expectedFrom: 'till' });
    const again = await data<StockCountFinish>('inventory:stockCountFinish', { countId: started.id });
    expect(again.alreadyFinished).toBe(true);
    expect(count(`SELECT COUNT(*) AS n FROM stock_movements WHERE reason = 'count'`)).toBe(1);
    const list = await data<Array<{ id: string; status: string }>>('inventory:stockCountList');
    expect(list.map((c) => [c.id, c.status])).toEqual([[started.id, 'done']]);
  });

  it('the finish says when "expected" may be short of the other till: two tills with the link off, or the link paused', async () => {
    h.session = MANAGER;
    const { saveTillsSetting } = await import('../../services/costing-settings.js');
    const { setSetting } = await import('../../db/repositories/settings-repo.js');
    saveTillsSetting(db, { sellingTills: 2 }, OWNER_ACTOR, { on: false, stale: false, lastHeardAt: null });
    const off = await data<StockCountFinish>('inventory:stockCountOne', { ingredientId: s.ing.cheese, countedQty: 100_000 });
    expect(off.expectedNote).toMatch(/^The other till's sales aren't on this till/);
    expect(await data('costing:getTills')).toMatchObject({ sellingTills: 2, link: { on: false, stale: false } });
    // The link switched on but paused: the other till's latest rows may be missing.
    setSetting(db, 'sync.config', { mode: 'mock', paused: true });
    const paused = await data<StockCountFinish>('inventory:stockCountOne', { ingredientId: s.ing.cheese, countedQty: 100_000 });
    expect(paused.expectedNote).toMatch(/link to the other till hasn't worked lately/);
  });

  it('a stock take is no longer booked as a plain stock row', async () => {
    h.session = MANAGER;
    expect(await call('inventory:recordMovement', { ingredientId: s.ing.cheese, deltaQty: -5, reason: 'count' })).toEqual({
      ok: false,
      code: 'validation_failed',
      message: 'Count stock with a stock take (the Stock button, or Inventory → Stock takes).',
    });
    expect(count(`SELECT COUNT(*) AS n FROM stock_movements WHERE reason = 'count'`)).toBe(0);
  });

  it('a manager counts, but "used vs should have used" is Reports: refused in plain words, and the owner reads it', async () => {
    h.session = MANAGER;
    clock('2026-08-01T06:00:00.000Z');
    const first = await countKeyItems();
    clock('2026-08-20T06:00:00.000Z');
    const second = await countKeyItems((id, till) => (id === s.ing.chicken ? till - 400 : till));
    const refused = { ok: false, code: 'forbidden', message: 'Only the owner can see reports.' };
    expect(await call('reports:variance', {})).toEqual(refused);
    expect(await call('reports:variance', { fromCountId: first.count.id, toCountId: second.count.id })).toEqual(refused);
    // The owner reads what the manager's counts found.
    h.session = OWNER;
    const v = await data<ReportVariance>('reports:variance', { fromCountId: first.count.id, toCountId: second.count.id });
    expect(v).toMatchObject({ state: 'ok' });
    expect(v.lines.find((l) => l.ingredientId === s.ing.chicken)).toMatchObject({ unexplained: 400 });
  });

  it('without the Reports worker the variance is worked out here for 31 days or less, and refused in plain words beyond', async () => {
    // The owner reads it (report.view); the manager does the counting (stock takes stay theirs).
    h.session = OWNER;
    expect(await data<ReportVariance>('reports:variance', {})).toMatchObject({ state: 'no_counts', staleSync: false });
    h.session = MANAGER;
    clock('2026-08-01T06:00:00.000Z');
    await countKeyItems();
    clock('2026-08-20T06:00:00.000Z');
    await countKeyItems((id, till) => (id === s.ing.chicken ? till - 400 : till));
    h.session = OWNER;
    const v = await data<ReportVariance>('reports:variance', {});
    expect(v).toMatchObject({ state: 'ok', staleSync: false, link: { on: false } });
    expect(v.lines.find((l) => l.ingredientId === s.ing.chicken)).toMatchObject({ unexplained: 400, unexplainedCents: 36_000 });
    h.session = MANAGER;
    clock('2026-09-25T06:00:00.000Z');
    const last = await countKeyItems();
    h.session = OWNER;
    const longer = await call('reports:variance', { toCountId: last.count.id, fromCountId: v.from!.id });
    expect(longer).toMatchObject({ ok: false, code: 'precondition_failed' });
    expect(longer.ok ? '' : longer.message).toMatch(/^Reports over 31 days are worked out in the background/);
  });
});
