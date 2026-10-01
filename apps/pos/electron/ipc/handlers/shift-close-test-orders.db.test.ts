/**
 * Closing the shift (0.7.21) meets the owner's "Delete test order" (0043)
 * and the drawer log (0042), through the real orders, shifts and reports IPC
 * handlers and the real repositories, on a database built from every
 * migration with the made-up costing shop:
 *
 *   R1 × closing the shift
 *   - the close box (shifts:closeCheck) never lists a test order the owner
 *     deleted, and the close never carries it over — nor does the stale-list
 *     check refuse a close because an order it was shown was deleted as a
 *     test while the manager counted;
 *   - a test order an earlier close carried over can still be deleted; the
 *     next close no longer sees it; the closed shift's saved row is never
 *     rewritten, and Shift history says the carried order was deleted;
 *   - a paid test order deleted after its shift closed: the saved figures
 *     stay, and Shift history (main thread and Reports worker alike) notes
 *     its cash on that shift.
 *   R2 × closing the shift
 *   - on a cashier's till the float at open and the count opened with the
 *     manager's PIN are both in the shift's drawer log, the count approved by
 *     that manager; the owner reads it (reports:drawerLog), a manager does not.
 *
 * Only `defineHandler` (captured), the signed-in session, the PIN checks, the
 * printer spooler, the FBR worker and the website's shift pause are stood in
 * for. node:sqlite behind better-sqlite3's shape; skipped where it is
 * missing. Every name, price and amount is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AuthenticatedUser,
  BusinessReportRequest,
  ReportShiftLine,
  Shift,
  ShiftCloseCheck,
  UUID,
} from '@cheeseoclock/shared-types';
import { CASHIER, DEV, DatabaseSync, MANAGER, OWNER, openCostingShop, openMigrated, type Line } from '../../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

type Handler = (ctx: unknown, payload: unknown) => unknown;

const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => unknown>(),
  session: null as AuthenticatedUser | null,
  spool: [] as Array<{ method: string; args: unknown[] }>,
  webOrders: [] as string[],
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
  Notification: class {
    static isSupported() {
      return false;
    }
  },
}));
// Who is signed in, and the secrets (auth-service owns them and their lockout).
vi.mock('../../services/auth-service.js', () => ({
  getCurrentSession: () => h.session,
  verifyManagerPin: async (_db: unknown, pin: string) => {
    if (pin === 'Manager-pass-7') return { approverUserId: 'u_mgr', approverName: 'Test Manager' };
    throw new Error("That is not a manager's PIN or password");
  },
  verifyOwnerSecret: async (_db: unknown, secret: string) => {
    if (secret === 'Owner-pass-9') return { ownerUserId: 'u_admin', ownerName: 'Test Owner' };
    throw new Error("That is not the owner's PIN or password.");
  },
}));
// The spooler records what it was asked and prints nothing (the drawer rows stay unsettled here).
vi.mock('../../services/print-spooler.js', () => ({
  printSpooler: new Proxy(
    {},
    {
      get:
        (_t, method) =>
        (...args: unknown[]) => {
          h.spool.push({ method: String(method), args });
          return method === 'kickDrawerNow' ? Promise.resolve({ ok: true, durationMs: 1 }) : undefined;
        },
    },
  ),
}));
vi.mock('../../services/fbr-worker.js', () => ({ fbrWorker: { kick: () => {}, resetAdapter: () => {} } }));
// Website orders follow the shift (web-orders-shift-pause.db.test.ts): recorded only.
vi.mock('../../services/web-orders-shift-pause.js', () => ({
  followShiftForWebOrders: (_db: unknown, _device: string, change: string) => {
    h.webOrders.push(change);
  },
  closeWouldPauseWebOrders: () => false,
}));

const live = describe.skipIf(!DatabaseSync);
const session = (id: string, fullName: string, role: AuthenticatedUser['role']): AuthenticatedUser => ({
  id: id as UUID,
  fullName,
  role,
  sessionId: `sess_${id}` as UUID,
});
const CASHIER_LOGIN = session(CASHIER.userId, 'Test Cashier', 'cashier');
const MANAGER_LOGIN = session(MANAGER.userId, 'Test Manager', 'manager');
const OWNER_LOGIN = session(OWNER.userId, 'Test Owner', 'admin');
const PIN = 'Manager-pass-7';
const OWNER_SECRET = 'Owner-pass-9';
const ALL_TIME: BusinessReportRequest = { sinceIso: '2000-01-01T00:00:00.000Z', untilIso: '2100-01-01T00:00:00.000Z' };

let db: ReturnType<typeof openMigrated>;
let shop: Awaited<ReturnType<typeof openCostingShop>>;

async function call<T>(channel: string, payload?: unknown): Promise<T> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  const r = (await fn({ db, deviceId: DEV }, payload)) as { ok: boolean; data: T };
  if (!r.ok) throw new Error(`${channel} said no: ${JSON.stringify(r)}`);
  return r.data;
}
async function refusal(channel: string, payload?: unknown): Promise<{ code: string; message: string } | undefined> {
  try {
    const r = (await h.handlers.get(channel)!({ db, deviceId: DEV }, payload)) as { ok: boolean; error?: { code: string; message: string } };
    if (r.ok) throw new Error(`${channel} was not refused`);
    return r.error;
  } catch (e) {
    return (e as { apiError?: { code: string; message: string } }).apiError;
  }
}
const row = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T;
const rows = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[];

async function openShiftAs(who: AuthenticatedUser, float = 500_000): Promise<Shift> {
  h.session = who;
  return call<Shift>('shifts:open', { openingCashCents: float, notes: 'Evening shift' });
}

/** An order rung on this till and sent to the kitchen, not paid: one the close would carry over. */
function unpaid(lines: Line[] = [['fajitaM', 1]]): string {
  const o = shop.ring(lines);
  shop.r.sendOrderToKitchen(db, o, CASHIER);
  return o;
}

/** A counter sale paid in cash in the shift open now (orders:tender), stock taken. */
async function paidInCash(lines: Line[] = [['fajitaM', 1]]): Promise<string> {
  const o = shop.ring(lines);
  const total = shop.r.findOrder(db, o)!.totalCents;
  shop.r.tenderOrder(db, { orderId: o, payments: [{ method: 'cash', amountCents: total, tenderedCents: total }] }, CASHIER);
  const { decrementForOrder } = await import('../../db/repositories/stock-movement-repo.js');
  decrementForOrder(db, o, CASHIER);
  return o;
}

/** The owner deletes it as a test (orders:deleteTest, their PIN typed again). The session is left as it was. */
async function deleteAsOwner(orderId: string, restock: boolean | null): Promise<{ deleteStock: string; statusBefore: string }> {
  const was = h.session;
  h.session = OWNER_LOGIN;
  try {
    const expectStatus = shop.r.findOrder(db, orderId)!.status;
    return await call('orders:deleteTest', { orderId, reason: 'Printer test', restock, ownerSecret: OWNER_SECRET, expectStatus });
  } finally {
    h.session = was;
  }
}

async function shiftLine(shiftId: string): Promise<ReportShiftLine | undefined> {
  const tabs = await import('../../services/analytics/report-tabs.js');
  return tabs.buildReportTab(db as never, 'team', ALL_TIME, new Date()).shifts.find((s) => s.id === shiftId);
}

/** The same line as the Reports worker hands it over (its own bundle, the same code). */
async function shiftLineViaWorker(shiftId: string): Promise<ReportShiftLine | undefined> {
  const worker = await import('../../services/analytics/worker.js');
  const reply = worker.handleRunRequest(db as never, { type: 'run', id: 1, kind: 'team', request: ALL_TIME, nowIso: new Date().toISOString() });
  if (reply.type !== 'result' || !reply.ok) throw new Error(`worker said no: ${JSON.stringify(reply)}`);
  return structuredClone(reply.data as { shifts: ReportShiftLine[] }).shifts.find((s) => s.id === shiftId);
}

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.session = null;
  h.spool.length = 0;
  h.webOrders.length = 0;
  db = openMigrated();
  shop = await openCostingShop(db);
  const ctx = { db, deviceId: DEV } as never;
  (await import('./orders-handlers.js')).registerOrdersHandlers(ctx);
  (await import('./shifts-handlers.js')).registerShiftsHandlers(ctx);
  (await import('./reports-handlers.js')).registerReportsHandlers(ctx);
});

live('R1 × closing the shift: a deleted test order is never carried over', () => {
  it('the close box drops it, and the stale-list check does not refuse a close for an order deleted as a test while counting', async () => {
    const shift = await openShiftAs(MANAGER_LOGIN);
    const keep = unpaid();
    const test = unpaid([['veggieL', 1, ['pickOnion', 'pickPepper', 'pickOlive', 'pickMushroom', 'pickCorn', 'dipChili']]]);
    const shown = (await call<ShiftCloseCheck>('shifts:closeCheck', { shiftId: shift.id })).unpaidOrders.map((o) => o.orderId);
    expect(shown).toEqual([keep, test]);

    // While the manager counts, the owner deletes the test order (its stock put back).
    expect(await deleteAsOwner(test, true)).toMatchObject({ deleteStock: 'put_back', statusBefore: 'sent_to_kitchen' });

    // The box asked again: only the real order.
    expect((await call<ShiftCloseCheck>('shifts:closeCheck', { shiftId: shift.id })).unpaidOrders.map((o) => o.orderId)).toEqual([keep]);
    // The close with the list the manager WAS shown goes through: an order
    // gone from the unpaid list is simply not carried (never "came in while
    // you were counting"), and it is not on record as carried over.
    const closed = await call<Shift>('shifts:close', {
      shiftId: shift.id,
      countedCashCents: 500_000,
      carryOverReason: 'Rider still out',
      carryOverOrderIds: shown,
    });
    expect(closed).toMatchObject({ carriedUnpaidCount: 1, carryOverReason: 'Rider still out' });
    expect(rows<{ entity_id: string }>(`SELECT entity_id FROM audit_log WHERE action = 'carried_over_unpaid'`)).toEqual([{ entity_id: keep }]);
  });

  it('the only unpaid order was a test the owner deleted: the close needs no reason and carries nothing', async () => {
    const shift = await openShiftAs(MANAGER_LOGIN);
    const test = unpaid();
    const shown = (await call<ShiftCloseCheck>('shifts:closeCheck', { shiftId: shift.id })).unpaidOrders.map((o) => o.orderId);
    expect(shown).toEqual([test]);
    await deleteAsOwner(test, false);
    const closed = await call<Shift>('shifts:close', { shiftId: shift.id, countedCashCents: 500_000, carryOverOrderIds: shown });
    expect(closed).toMatchObject({ carriedUnpaidCount: 0, carryOverReason: null, varianceCents: 0 });
    expect(rows(`SELECT 1 FROM audit_log WHERE action = 'carried_over_unpaid'`)).toHaveLength(0);
  });

  it('a test order an earlier close carried over can still be deleted; the next close does not see it; the closed shift keeps its saved row and Shift history says so', async () => {
    const first = await openShiftAs(MANAGER_LOGIN);
    const test = unpaid();
    await call('shifts:close', { shiftId: first.id, countedCashCents: 500_000, carryOverReason: 'Rider still out' });
    const saved = row(`SELECT * FROM shifts WHERE id = ?`, first.id);
    expect(saved).toMatchObject({ carried_unpaid_count: 1, carry_over_reason: 'Rider still out' });

    const next = await openShiftAs(MANAGER_LOGIN);
    expect((await call<ShiftCloseCheck>('shifts:closeCheck', { shiftId: next.id })).unpaidOrders.map((o) => o.orderId)).toEqual([test]);

    // The owner deletes it: nothing about the carry-over refuses it.
    h.session = OWNER_LOGIN;
    expect(await call('orders:testDeletePreview', { orderId: test })).toMatchObject({ orderId: test, refusal: null });
    expect(await deleteAsOwner(test, false)).toMatchObject({ deleteStock: 'waste', statusBefore: 'sent_to_kitchen' });
    expect(row(`SELECT delete_kind AS k, deleted_by AS by FROM orders WHERE id = ?`, test)).toEqual({ k: 'test', by: OWNER.userId });

    // The next close no longer sees it: no reason asked.
    h.session = MANAGER_LOGIN;
    expect((await call<ShiftCloseCheck>('shifts:closeCheck', { shiftId: next.id })).unpaidOrders).toEqual([]);
    expect(await call<Shift>('shifts:close', { shiftId: next.id, countedCashCents: 500_000 })).toMatchObject({ carriedUnpaidCount: 0 });

    // The first shift's saved row is untouched; Shift history keeps its count and says one was later deleted as a test.
    expect(row(`SELECT * FROM shifts WHERE id = ?`, first.id)).toEqual(saved);
    for (const line of [await shiftLine(first.id), await shiftLineViaWorker(first.id)]) {
      expect(line).toMatchObject({
        carriedUnpaidCount: 1,
        carryOverReason: 'Rider still out',
        carriedTestDeletedCount: 1,
        closedBy: 'Test Manager',
        expectedCashCents: 500_000,
        varianceCents: 0,
      });
    }
    expect(await shiftLine(next.id)).toMatchObject({ carriedUnpaidCount: 0, carriedTestDeletedCount: 0 });
  });

  it('a paid test order deleted after its shift closed: the saved figures stay, and Shift history notes its cash on that shift', async () => {
    const first = await openShiftAs(MANAGER_LOGIN);
    const test = await paidInCash();
    const total = shop.r.findOrder(db, test)!.totalCents;
    const closed = await call<Shift>('shifts:close', { shiftId: first.id, countedCashCents: 500_000 + total, notes: 'All good' });
    expect(closed).toMatchObject({ expectedCashCents: 500_000 + total, varianceCents: 0 });
    const saved = row(`SELECT * FROM shifts WHERE id = ?`, first.id);
    await openShiftAs(MANAGER_LOGIN);
    await deleteAsOwner(test, false);
    expect(row(`SELECT * FROM shifts WHERE id = ?`, first.id)).toEqual(saved);
    for (const line of [await shiftLine(first.id), await shiftLineViaWorker(first.id)]) {
      expect(line).toMatchObject({
        expectedCashCents: 500_000 + total,
        countedCashCents: 500_000 + total,
        varianceCents: 0,
        closingNote: 'All good',
        testDeletedCashCents: total,
      });
    }
  });
});

live('R2 × closing the shift: the drawer log of a PIN close', () => {
  it("on a cashier's till: the float at open and the count opened with the manager's PIN are the shift's drawer log, the count approved by that manager", async () => {
    const shift = await openShiftAs(CASHIER_LOGIN);
    h.session = CASHIER_LOGIN;
    await call('shifts:openDrawer', { kind: 'count', approverPin: PIN });
    await call('shifts:close', { shiftId: shift.id, countedCashCents: 500_000, approverPin: PIN });
    const { listDrawerLog } = await import('../../db/repositories/drawer-open-repo.js');
    const log = listDrawerLog(db as never, { ...ALL_TIME, shiftId: shift.id }, DEV);
    expect(log.rows.map((l) => [l.kind, l.openedBy, l.approvedBy, l.amountCents, l.shiftId])).toEqual([
      ['count', 'Test Cashier', 'Test Manager', null, shift.id],
      ['float', 'Test Cashier', null, 500_000, shift.id],
    ]);
    expect(log.counts).toMatchObject({ total: 2, byKind: { float: 1, count: 1 } });
    // Each pulse was for its row (no row, no pulse): the float's from shifts:open, the count's from openDrawer.
    const [count, float] = log.rows;
    const pulses = h.spool.filter((c) => c.method === 'kickDrawerSoon' || c.method === 'kickDrawerNow');
    expect(pulses.map((c) => [c.method, c.method === 'kickDrawerSoon' ? c.args[0] : (c.args[0] as { drawerOpenId: string }).drawerOpenId])).toEqual([
      ['kickDrawerSoon', float!.id],
      ['kickDrawerNow', count!.id],
    ]);
    // …and the website still followed the shift (0.7.21): resumed on open, paused on the close.
    expect(h.webOrders).toEqual(['opened', 'closed']);

    // The owner reads it in Reports; a manager does not (Reports are the owner's).
    h.session = OWNER_LOGIN;
    const owner = await call<{ rows: Array<{ kind: string; approvedBy: string | null }> }>('reports:drawerLog', { ...ALL_TIME, shiftId: shift.id });
    expect(owner.rows.map((l) => [l.kind, l.approvedBy])).toEqual([
      ['count', 'Test Manager'],
      ['float', null],
    ]);
    h.session = MANAGER_LOGIN;
    expect(await refusal('reports:drawerLog', { ...ALL_TIME, shiftId: shift.id })).toMatchObject({ code: 'forbidden' });

    // Shift history: closed by the manager, both openings counted, neither a no-sale.
    expect(await shiftLine(shift.id)).toMatchObject({ closedBy: 'Test Manager', drawerOpenCount: 2, noSaleOpens: 0, varianceCents: 0 });
  });
});
