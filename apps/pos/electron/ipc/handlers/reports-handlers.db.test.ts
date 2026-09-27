/**
 * The Reports channels (costing spec Phase 3: one per tab), through the
 * real IPC handlers against a real database built from every migration (a
 * made-up shop, db/costing-shop.fixture.ts):
 *   - one channel per tab, plus low stock; the whole-page reports:business
 *     and the older one-figure channels are no longer registered;
 *   - a cashier is refused every one in the main process; Food cost & stock
 *     is refused to a login without costs even though it may see reports,
 *     and its Team tab carries no waste rupees;
 *   - the figures come from the Reports worker when it is running; when it
 *     is not, the main process works out 31 days at most and says no, in
 *     plain words, to anything longer; superseded, timed-out, crashed and
 *     failed asks each get their own answer;
 *   - stock rows carry their values for a login that may see costs, and
 *     "Make this amount" answers with none.
 *
 * Only `defineHandler` (captured), the signed-in session and the worker are
 * stood in for. node:sqlite behind better-sqlite3's shape; skips where it is
 * missing. Every name and price is made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AuthenticatedUser,
  BusinessReportRequest,
  ReportTab,
  ReportTeamTab,
  StockMovementPage,
  UUID,
} from '@cheeseoclock/shared-types';
import { CASHIER as CASHIER_ACTOR, DatabaseSync, DEV, MANAGER as MANAGER_ACTOR, openCostingShop, openMigrated } from '../../db/costing-shop.fixture.js';
import type { AnalyticsWorkerState } from '../../services/analytics/worker-client.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Handler = (ctx: unknown, payload: unknown) => unknown;
const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => unknown>(),
  session: null as unknown,
  /** A login that may see reports but not costs (no role has that today; the rule must hold when one does). */
  noCosts: false,
  worker: null as unknown,
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
vi.mock('@cheeseoclock/shared-types', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@cheeseoclock/shared-types')>();
  return {
    ...orig,
    hasCapability: (role: Parameters<typeof orig.hasCapability>[0], cap: Parameters<typeof orig.hasCapability>[1]) =>
      h.noCosts && cap === orig.COST_CAPABILITY ? false : orig.hasCapability(role, cap),
  };
});

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
let TOO_LONG = '';
let REFUSED: Record<string, string> = {};

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
    return { ok: false, code: `threw ${(e as Error).name}`, message: e instanceof Error ? e.message : String(e) };
  }
}

/** A stand-in Reports worker: its state, and what it answers. */
function fakeWorker(state: AnalyticsWorkerState, run: (kind: ReportTab, req: BusinessReportRequest) => Promise<unknown>) {
  const asked: Array<[ReportTab, BusinessReportRequest]> = [];
  return {
    asked,
    settled: () => Promise.resolve(state),
    run: (kind: ReportTab, req: BusinessReportRequest) => {
      asked.push([kind, req]);
      return run(kind, req);
    },
  };
}

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.session = null;
  h.noCosts = false;
  h.worker = null;
  db = openMigrated();
  s = await openCostingShop(db);
  const ctx = { db, deviceId: DEV } as never;
  const reports = await import('./reports-handlers.js');
  TOO_LONG = reports.TOO_LONG_WITHOUT_WORKER;
  ({ REFUSED } = (await import('../guards.js')) as unknown as { REFUSED: Record<string, string> });
  reports.registerReportsHandlers(ctx, { worker: () => h.worker as never });
  (await import('./inventory-handlers.js')).registerInventoryHandlers(ctx);
});

const live = describe.skipIf(!DatabaseSync);
const AROUND_NOW = () => ({
  sinceIso: new Date(Date.now() - 3_600_000).toISOString(),
  untilIso: new Date(Date.now() + 3_600_000).toISOString(),
});
/** A year ending in an hour. */
const A_YEAR = () => ({ sinceIso: new Date(Date.now() - 365 * 86_400_000).toISOString(), untilIso: new Date(Date.now() + 3_600_000).toISOString() });
const TABS: ReportTab[] = ['overview', 'when', 'menu', 'channels', 'foodStock', 'team'];

/** A sale of one medium Fajita (made-up prices): stock taken, cost kept, paid now. */
function oneSale(): void {
  const o = s.ring([['fajitaM', 1]]);
  s.r.decrementForOrder(db, o, CASHIER_ACTOR);
  s.markPaid(o);
}

live('Reports channels', () => {
  it('one channel per tab, plus low stock, the owner’s week (Phase 7) and the stock-take variance (Phase 8); the whole-page and one-figure channels are gone', () => {
    expect([...h.handlers.keys()].filter((c) => c.startsWith('reports:')).sort()).toEqual([
      'reports:addDayNote',
      'reports:channels',
      'reports:foodStock',
      'reports:getDayparts',
      'reports:lowStock',
      'reports:menu',
      'reports:overview',
      'reports:ownerWeek',
      'reports:removeDayNote',
      'reports:setDayparts',
      'reports:team',
      'reports:trends',
      // Stock takes: used vs should have used (costing spec Phase 8).
      'reports:variance',
      'reports:when',
    ]);
  });

  it('a cashier is refused every tab and low stock in the main process; nobody signed in is "not logged in"', async () => {
    h.session = CASHIER;
    for (const channel of [...TABS.map((t) => `reports:${t}`), 'reports:lowStock']) {
      expect({ channel, ...(await call(channel, AROUND_NOW())) }).toEqual({ channel, ok: false, code: 'forbidden', message: REFUSED['reports'] });
    }
    h.session = null;
    for (const t of TABS) expect(await call(`reports:${t}`, AROUND_NOW())).toMatchObject({ ok: false, code: 'unauthenticated' });
  });

  it('a manager gets the food cost from Food cost & stock, from the cost each sale kept', async () => {
    oneSale();
    h.session = MANAGER;
    const r = await call('reports:foodStock', AROUND_NOW());
    expect(r.ok).toBe(true);
    const tab = (r as { data: { engine: string; foodCost: unknown } }).data;
    expect(tab.foodCost).toMatchObject({ costOfSalesCents: 17_641, knownSalesCents: 120_000, foodCostBps: 1_470, coverageBps: 10_000 });
    // No worker running here: worked out on the main process, and it says so.
    expect(tab.engine).toBe('main');
  });

  it('reports but no costs: Food cost & stock is refused, and Team carries no waste rupees', async () => {
    oneSale();
    h.session = MANAGER;
    h.noCosts = true;
    expect(await call('reports:foodStock', AROUND_NOW())).toEqual({ ok: false, code: 'forbidden', message: REFUSED['costs'] });
    const team = await call('reports:team', AROUND_NOW());
    expect(team.ok).toBe(true);
    expect((team as { data: ReportTeamTab }).data.foodCost).toBeNull();
    const overview = await call('reports:overview', AROUND_NOW());
    expect(overview).toMatchObject({ ok: true, data: { kpis: { orderCount: 1 } } });
  });

  it('checks the period like before: bad dates and over two years are refused', async () => {
    h.session = MANAGER;
    expect(await call('reports:menu', { sinceIso: 'x', untilIso: 'y' })).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(await call('reports:menu', { sinceIso: '2026-09-02T00:00:00.000Z', untilIso: '2026-09-01T00:00:00.000Z' })).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
    expect(await call('reports:menu', { sinceIso: '2020-01-01T00:00:00.000Z', untilIso: '2026-01-01T00:00:00.000Z' })).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
    expect(await call('reports:overview', { ...AROUND_NOW(), compareSinceIso: 'nope', compareUntilIso: 'nope' })).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
  });
});

live('where a tab is worked out', () => {
  it('the worker, when it is running: its figures, marked as worked out there', async () => {
    oneSale();
    h.session = MANAGER;
    const { buildReportTab } = await import('../../services/analytics/report-tabs.js');
    const w = fakeWorker('ready', async (kind, req) => buildReportTab(db, kind, req));
    h.worker = w;
    for (const t of TABS) {
      const r = await call(`reports:${t}`, A_YEAR());
      expect({ t, ok: r.ok, engine: (r as { data?: { engine?: string } }).data?.engine }).toEqual({ t, ok: true, engine: 'worker' });
    }
    expect(w.asked.map(([k]) => k)).toEqual(TABS);
    // The Overview is asked with its comparison, as sent.
    const cmp = { ...AROUND_NOW(), compareSinceIso: '2026-01-01T00:00:00.000Z', compareUntilIso: '2026-01-02T00:00:00.000Z' };
    await call('reports:overview', cmp);
    expect(w.asked.at(-1)).toEqual(['overview', cmp]);
  });

  it('no worker (it failed to start): a month on the main process, anything longer refused in plain words', async () => {
    oneSale();
    h.session = MANAGER;
    const w = fakeWorker('unavailable', () => Promise.reject(new Error('never asked')));
    h.worker = w;
    const month = { sinceIso: new Date(Date.now() - 30 * 86_400_000).toISOString(), untilIso: new Date(Date.now() + 3_600_000).toISOString() };
    const r = await call('reports:overview', month);
    expect(r).toMatchObject({ ok: true, data: { engine: 'main', kpis: { orderCount: 1 } } });
    expect(await call('reports:menu', A_YEAR())).toEqual({ ok: false, code: 'precondition_failed', message: TOO_LONG });
    expect(TOO_LONG).toBe(
      'Reports over 31 days are worked out in the background, and that part of the till is not running. Pick 31 days or fewer, or restart the till.',
    );
    expect(w.asked).toEqual([]);
  });

  it('asked again with other dates, too slow, crashed, failed: each gets its own answer', async () => {
    h.session = MANAGER;
    const { WorkerRunError } = await import('../../services/analytics/worker-client.js');
    const answer = (code: 'superseded' | 'timeout' | 'crashed' | 'failed', message = 'x') =>
      fakeWorker('ready', () => Promise.reject(new WorkerRunError(code, message)));

    h.worker = answer('superseded');
    expect(await call('reports:when', A_YEAR())).toMatchObject({ ok: false, code: 'conflict', message: 'A newer report was asked for.' });

    h.worker = answer('timeout');
    expect(await call('reports:when', A_YEAR())).toMatchObject({
      ok: false,
      code: 'precondition_failed',
      message: 'The report took longer than 30 seconds. Pick a shorter period and try again.',
    });

    // The worker stopped part-way (it restarts): a short period is worked out here instead…
    h.worker = answer('crashed', 'The report stopped part-way. Please try again.');
    expect(await call('reports:when', AROUND_NOW())).toMatchObject({ ok: true, data: { engine: 'main' } });
    // …a long one is to be tried again.
    expect(await call('reports:when', A_YEAR())).toEqual({
      ok: false,
      code: 'precondition_failed',
      message: 'The report stopped part-way. Please try again.',
    });

    // A failure inside the worker is not the owner's to read: logged with a reference by defineHandler.
    h.worker = answer('failed', 'no such column: o.nope');
    expect(await call('reports:when', AROUND_NOW())).toMatchObject({ ok: false, code: 'threw ReportWorkerFailure' });
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

// ---------------------------------------------------------------------------
// The owner's week (costing spec Phase 7)
// ---------------------------------------------------------------------------

const OWNER = session('u_admin', 'admin');
/** The clock (Date only) for these: Wednesday 30 Sep 2026, 3 pm in Karachi. */
const WED_3PM = new Date('2026-09-30T10:00:00.000Z');
const TODAY = () => new Date().toISOString().slice(0, 10);

/** A sale of one medium Fajita an hour ago (made-up prices): stock taken, cost kept, paid. */
function saleThisWeek(): void {
  const o = s.ring([['fajitaM', 1]]);
  s.r.decrementForOrder(db, o, CASHIER_ACTOR);
  s.markPaid(o, new Date(WED_3PM.getTime() - 3_600_000));
}

live("the owner's week channels (costing Phase 7)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(WED_3PM);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a cashier is refused the card, the trends, day notes and the parts of the day, and nothing is written', async () => {
    h.session = CASHIER;
    const asks: Array<[string, unknown]> = [
      ['reports:ownerWeek', { week: 'this' }],
      ['reports:trends', undefined],
      ['reports:addDayNote', { day: TODAY(), tag: 'rain' }],
      ['reports:removeDayNote', { id: 'no-such-note' }],
      ['reports:getDayparts', undefined],
      ['reports:setDayparts', { dayparts: [{ name: 'Lunch', fromHour: 12, toHour: 15 }] }],
    ];
    for (const [channel, payload] of asks) {
      expect({ channel, ...(await call(channel, payload)) }).toEqual({ channel, ok: false, code: 'forbidden', message: REFUSED['reports'] });
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM day_notes`).get()).toEqual({ n: 0 });
    h.session = null;
    for (const [channel, payload] of asks) expect(await call(channel, payload)).toMatchObject({ ok: false, code: 'unauthenticated' });
  });

  it('a manager gets food cost, waste and the cost lines; a login without costs gets none of them — and nobody gets profit', async () => {
    saleThisWeek();
    h.session = MANAGER;
    const withCosts = await call('reports:ownerWeek', { week: 'this' });
    expect(withCosts).toMatchObject({ ok: true, data: { week: 'this', engine: 'main', current: { orderCount: 1, netSalesCents: 120_000 } } });
    const week = (withCosts as { data: import('@cheeseoclock/shared-types').OwnerWeek }).data;
    expect(week.costs).toMatchObject({ hasCosts: true });
    // The Dashboard card does not ask for the printed sheet's lines, so it does not wait for them.
    expect(week.sheet).toBeNull();
    expect(JSON.stringify(week)).not.toMatch(/profit/i);
    // The sheet asks for them.
    const sheet = (await call('reports:ownerWeek', { week: 'this', sheet: true })) as { ok: true; data: import('@cheeseoclock/shared-types').OwnerWeek };
    expect(sheet.data.sheet).not.toBeNull();
    expect(sheet.data.sheet!.previousCosts).toBeNull(); // no orders a week earlier on this till
    expect(JSON.stringify(sheet.data)).not.toMatch(/profit/i);

    h.noCosts = true;
    const without = (await call('reports:ownerWeek', { week: 'last', sheet: true })) as { ok: true; data: import('@cheeseoclock/shared-types').OwnerWeek };
    expect(without.ok).toBe(true);
    expect(without.data.week).toBe('last');
    expect(without.data.costs).toBeNull();
    expect(without.data.sheet).toBeNull();
    expect(without.data.doThis.every((i) => !i.cost)).toBe(true);
  });

  it('the trends from the worker: each month’s food cost only for a login with costs', async () => {
    saleThisWeek();
    const { buildAnalytics } = await import('../../services/analytics/report-tabs.js');
    const worker = fakeWorker('ready', (kind, req) => Promise.resolve(buildAnalytics(db, kind, req, new Date())));
    h.worker = worker;
    h.session = MANAGER;
    const r = (await call('reports:trends')) as { ok: true; data: import('@cheeseoclock/shared-types').ReportTrends };
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ engine: 'worker', partial: false });
    expect(r.data.months).toHaveLength(12);
    expect(r.data.monthCosts).toHaveLength(12);
    expect(worker.asked.at(-1)).toEqual(['trends', { withCosts: true }]);

    h.noCosts = true;
    const lean = (await call('reports:trends')) as { ok: true; data: import('@cheeseoclock/shared-types').ReportTrends };
    expect(lean.data.monthCosts).toBeNull();
    // The cost figures were not even worked out for this login.
    expect(worker.asked.at(-1)).toEqual(['trends', { withCosts: false }]);
  });

  it('without the worker the trends leave out every stretch over 31 days; the card is whole', async () => {
    saleThisWeek();
    h.session = MANAGER;
    const t = (await call('reports:trends')) as { ok: true; data: import('@cheeseoclock/shared-types').ReportTrends };
    expect(t.data).toMatchObject({ engine: 'main', partial: true, months: [] });
    expect(t.data.lines.map((l) => l.period)).toEqual(['today', 'week', 'month']);
    expect(await call('reports:ownerWeek', undefined)).toMatchObject({ ok: true, data: { week: 'this', engine: 'main' } });
  });

  it('day notes: report.view adds and takes them off, checked in plain words', async () => {
    h.session = MANAGER;
    const added = (await call('reports:addDayNote', { day: TODAY(), tag: 'load_shedding', note: 'No power 7 to 9' })) as { ok: true; data: { id: string } };
    expect(added).toMatchObject({ ok: true, data: { day: TODAY(), tag: 'load_shedding', note: 'No power 7 to 9', addedBy: 'Test Manager' } });
    expect(await call('reports:addDayNote', { day: '2026-02-30', tag: 'rain' })).toMatchObject({ ok: false, code: 'validation_failed', message: 'That is not a real date' });
    expect(await call('reports:addDayNote', { day: TODAY(), tag: 'party' })).toMatchObject({ ok: false, code: 'validation_failed', message: 'Pick what the day was' });
    expect(await call('reports:addDayNote', { day: '2099-01-01', tag: 'closed' })).toMatchObject({ ok: false, code: 'validation_failed', message: 'Pick a day within the next year.' });
    expect(await call('reports:removeDayNote', { id: added.data.id })).toEqual({ ok: true, data: { removed: true } });
    expect(await call('reports:removeDayNote', { id: added.data.id })).toEqual({ ok: true, data: { removed: false } });
  });

  it('the parts of the day: everyone with reports reads them; only the owner changes them, and overlaps are refused', async () => {
    h.session = MANAGER;
    expect(await call('reports:getDayparts')).toMatchObject({ ok: true, data: { isDefault: true, savedAt: null } });
    const mine = { dayparts: [{ name: 'Day', fromHour: 11, toHour: 18 }, { name: 'Night', fromHour: 19, toHour: 2 }] };
    expect(await call('reports:setDayparts', mine)).toEqual({ ok: false, code: 'forbidden', message: 'Only the owner can change the parts of the day.' });
    h.session = OWNER;
    expect(
      await call('reports:setDayparts', { dayparts: [{ name: 'Lunch', fromHour: 12, toHour: 16 }, { name: 'Tea', fromHour: 16, toHour: 18 }] }),
    ).toMatchObject({ ok: false, code: 'validation_failed', message: '"Lunch" and "Tea" both take the hour from 16:00' });
    expect(await call('reports:setDayparts', mine)).toMatchObject({ ok: true, data: { isDefault: false, dayparts: mine.dayparts } });
    h.session = MANAGER;
    expect(await call('reports:getDayparts')).toMatchObject({ ok: true, data: { isDefault: false, dayparts: mine.dayparts } });
    // Saved like every shop-wide setting: synced and audited.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'business_settings'`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'business_settings'`).get()).toEqual({ n: 1 });
  });
});
