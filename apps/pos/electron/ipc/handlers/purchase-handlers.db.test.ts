/**
 * The purchase channels (costing spec Phase 5) through the real IPC
 * handlers, against a real database built from every migration and a
 * made-up shop (db/costing-shop.fixture.ts):
 *   - a cashier is refused "Record a purchase", "Turn this payout into a
 *     purchase" and the drawer's payouts in the main process, in plain
 *     words, and nothing is written;
 *   - a manager records a purchase paid from the drawer: the drawer opens
 *     for the notes, the shift's expected cash includes it, and the payout
 *     then shows as that purchase;
 *   - the counter's cash dialog list still works for a cashier and now says
 *     which payout is a purchase (an id, no figures of the purchase).
 *
 * Only `defineHandler` (captured), the signed-in session and the print
 * spooler are stood in for. node:sqlite behind better-sqlite3's shape;
 * skips where it is missing. Every name and price is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, CashMovement, DrawerPayout, RecordPurchaseResult, UUID } from '@cheeseoclock/shared-types';
import { DatabaseSync, DEV, openCostingShop, openMigrated } from '../../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Handler = (ctx: unknown, payload: unknown) => unknown;
const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => unknown>(),
  session: null as unknown,
  kicks: 0,
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
vi.mock('../../services/auth-service.js', () => ({
  getCurrentSession: () => h.session,
  verifyManagerPin: async () => ({ approverUserId: 'u_mgr' }),
}));
vi.mock('../../services/print-spooler.js', () => ({
  printSpooler: {
    kickDrawerSoon: () => {
      h.kicks += 1;
    },
  },
}));
vi.mock('../../services/drawer-service.js', () => ({
  DrawerOpenRefused: class extends Error {},
  openDrawerNoSale: async () => ({ opened: true }),
}));

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
const written = () =>
  ['purchase_orders', 'stock_movements', 'ingredient_costs', 'cash_movements', 'sync_queue', 'audit_log'].map((t) =>
    count(`SELECT COUNT(*) AS n FROM ${t}`),
  );

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.session = null;
  h.kicks = 0;
  db = openMigrated();
  s = await openCostingShop(db);
  const ctx = { db, deviceId: DEV } as never;
  (await import('./inventory-handlers.js')).registerInventoryHandlers(ctx);
  (await import('./shifts-handlers.js')).registerShiftsHandlers(ctx);
});

const live = describe.skipIf(!DatabaseSync);
const REFUSED = 'Only a manager or the owner can record purchases or see what was spent.';

live('purchases: a cashier is refused in the main process', () => {
  it('every purchase channel says no, in plain words, and nothing is written', async () => {
    h.session = MANAGER;
    await data('shifts:open', { openingCashCents: 100_000 });
    h.session = CASHIER;
    const payout = await data<CashMovement>('shifts:recordCashMovement', {
      type: 'payout',
      amountCents: 20_000,
      reason: 'Onions from the market',
      approverPin: '9999',
    });
    const before = written();
    const kicks = h.kicks; // the shift's float and the payout opened the drawer
    const line = [{ ingredientId: s.ing.onion, qty: 1_000, billCents: 15_000 }];
    expect(await call('inventory:recordPurchase', { lines: line, paidFromDrawer: true })).toEqual({ ok: false, code: 'forbidden', message: REFUSED });
    expect(await call('inventory:payoutToPurchase', { cashMovementId: payout.id, lines: line })).toEqual({ ok: false, code: 'forbidden', message: REFUSED });
    expect(await call('inventory:listDrawerPayouts')).toEqual({ ok: false, code: 'forbidden', message: REFUSED });
    expect(written()).toEqual(before);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.kicks).toBe(kicks); // no purchase, so no drawer
    // The counter's own list is unchanged for a cashier: its shift's cash in / out.
    const list = await data<CashMovement[]>('shifts:listCashMovements', { shiftId: payout.shiftId });
    expect(list).toEqual([expect.objectContaining({ id: payout.id, refPurchaseOrderId: null })]);
    h.session = null;
    expect(await call('inventory:recordPurchase', { lines: line })).toMatchObject({ ok: false, code: 'unauthenticated' });
  });
});

live('purchases: a manager', () => {
  it('records a purchase paid from the drawer: the drawer opens, the expected cash includes it', async () => {
    h.session = MANAGER;
    const shift = await data<{ id: string }>('shifts:open', { openingCashCents: 100_000 });
    const kicks = h.kicks; // the float went in
    const res = await data<RecordPurchaseResult>('inventory:recordPurchase', {
      paidFromDrawer: true,
      lines: [{ ingredientId: s.ing.onion, qty: 2_000, billCents: 31_000 }],
    });
    expect(res.purchase).toMatchObject({ kind: 'quick', totalCents: 31_000, payout: { amountCents: 31_000 } });
    expect(res.pricesUsed).toEqual([s.ing.onion]);
    await vi.waitFor(() => expect(h.kicks).toBe(kicks + 1));
    expect(await data('shifts:summary', { shiftId: shift.id })).toMatchObject({ cashOutCents: 31_000, expectedCashCents: 69_000 });
    // Validation happens before anything: a part of a gram is not stock.
    const bad = await call('inventory:recordPurchase', { lines: [{ ingredientId: s.ing.onion, qty: 1.5, billCents: 100 }] });
    expect(bad).toMatchObject({ ok: false, code: 'validation_failed' });
  });

  it('turns a payout into a purchase once; the payouts list says so', async () => {
    h.session = MANAGER;
    await data('shifts:open', { openingCashCents: 100_000 });
    h.session = CASHIER;
    const payout = await data<CashMovement>('shifts:recordCashMovement', {
      type: 'payout',
      amountCents: 45_000,
      reason: 'Veg run',
      approverPin: '9999',
    });
    h.session = MANAGER;
    const open = await data<DrawerPayout[]>('inventory:listDrawerPayouts');
    expect(open).toEqual([expect.objectContaining({ id: payout.id, amountCents: 45_000, reason: 'Veg run', refPurchaseOrderId: null })]);
    const lines = [{ ingredientId: s.ing.tomato, qty: 3_000, billCents: 45_000, usePrice: false }];
    const first = await data<RecordPurchaseResult & { alreadyLinked: boolean }>('inventory:payoutToPurchase', { cashMovementId: payout.id, lines });
    expect(first.alreadyLinked).toBe(false);
    const again = await data<RecordPurchaseResult & { alreadyLinked: boolean }>('inventory:payoutToPurchase', { cashMovementId: payout.id, lines });
    expect(again).toMatchObject({ alreadyLinked: true, purchase: { id: first.purchase.id } });
    expect(await data<DrawerPayout[]>('inventory:listDrawerPayouts')).toEqual([expect.objectContaining({ id: payout.id, refPurchaseOrderId: first.purchase.id })]);
    expect(count(`SELECT COUNT(*) AS n FROM purchase_orders`)).toBe(1);
  });
});
