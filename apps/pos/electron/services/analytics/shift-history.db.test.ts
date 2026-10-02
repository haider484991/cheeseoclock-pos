/**
 * Shift history on Reports → Team & leakage (the owner, 2026-09-27: "I can't
 * see the shift history"): every shift that was open at some time in the
 * period — opened before it ends, and still open or closed at or after it
 * starts — newest first, with the drawer figures saved at close. It used to
 * list only the shifts OPENED in the period, so Today (where Reports opens)
 * never showed last night's shift, still running or closed this morning.
 *
 * On a real database built from every migration, through the code the Team
 * tab runs: the tab builder (report-tabs.ts buildReportTab — the main
 * process's fallback builds with it on the till's own connection), the
 * Reports worker's handler (worker.ts handleRunRequest, the answer copied as
 * a thread would), and the whole page (getBusinessReport).
 *
 * node:sqlite behind better-sqlite3's shape (better-sqlite3 here is built
 * for Electron); skips where it is missing. Every name and amount is made up.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { BusinessReportRequest, ReportShiftLine } from '@cheeseoclock/shared-types';
import { DatabaseSync, openMigrated } from '../../db/costing-shop.fixture.js';
import type { RunRequest } from './worker-protocol.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const live = describe.skipIf(!DatabaseSync);

/** Today: the 26 Sep trading day (05:00 → 05:00 Pakistan time). */
const TODAY: BusinessReportRequest = { sinceIso: '2026-09-26T00:00:00.000Z', untilIso: '2026-09-27T00:00:00.000Z' };
const YESTERDAY: BusinessReportRequest = { sinceIso: '2026-09-25T00:00:00.000Z', untilIso: '2026-09-26T00:00:00.000Z' };
/** What the top bar's "Shift history" opens on: the last 7 trading days. */
const LAST_7: BusinessReportRequest = { sinceIso: '2026-09-20T00:00:00.000Z', untilIso: '2026-09-27T00:00:00.000Z' };
const NOW = new Date('2026-09-26T12:00:00.000Z');
const T0 = '2026-01-01T00:00:00.000Z';

let db: ReturnType<typeof openMigrated>;
let tabs: typeof import('./report-tabs.js');
let worker: typeof import('./worker.js');
let report: typeof import('../business-report.js');

interface ShiftSeed {
  id: string;
  device: string;
  by: string;
  openedAt: string;
  floatCents: number;
  closed?: { by: string; at: string; expected: number; counted: number };
  deletedAt?: string;
}

beforeAll(async () => {
  if (!DatabaseSync) return;
  db = openMigrated();
  const user = db.prepare(`INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, 'till-1')`);
  user.run('u_ali', 'Ali', 'cashier', T0, T0);
  user.run('u_sara', 'Sara', 'manager', T0, T0);
  user.run('u_owner', 'Owner', 'admin', T0, T0);

  const shift = db.prepare(
    `INSERT INTO shifts (id, device_id, opened_by_user_id, opened_at, opening_cash_cents, closed_by_user_id, closed_at,
       expected_cash_cents, counted_cash_cents, variance_cents, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const seed = (s: ShiftSeed) =>
    shift.run(
      s.id,
      s.device,
      s.by,
      s.openedAt,
      s.floatCents,
      s.closed?.by ?? null,
      s.closed?.at ?? null,
      s.closed?.expected ?? null,
      s.closed?.counted ?? null,
      s.closed ? s.closed.counted - s.closed.expected : null,
      T0,
      T0,
      s.deletedAt ?? null,
    );
  // Till 1, one shift after another.
  seed({ id: 's_before', device: 'till-1', by: 'u_ali', openedAt: '2026-09-23T07:00:00.000Z', floatCents: 400_000, closed: { by: 'u_sara', at: '2026-09-23T20:00:00.000Z', expected: 700_000, counted: 700_000 } });
  // Opened yesterday, closed today (after midnight): Rs 100 short.
  seed({ id: 's_yesterday', device: 'till-1', by: 'u_ali', openedAt: '2026-09-25T15:00:00.000Z', floatCents: 500_000, closed: { by: 'u_sara', at: '2026-09-26T01:30:00.000Z', expected: 600_000, counted: 590_000 } });
  // Inside today: Rs 50 over.
  seed({ id: 's_inside', device: 'till-1', by: 'u_sara', openedAt: '2026-09-26T07:00:00.000Z', floatCents: 590_000, closed: { by: 'u_owner', at: '2026-09-26T20:00:00.000Z', expected: 800_000, counted: 805_000 } });
  // Opened the moment today ends: tomorrow's.
  seed({ id: 's_after', device: 'till-1', by: 'u_ali', openedAt: '2026-09-27T00:00:00.000Z', floatCents: 805_000, closed: { by: 'u_sara', at: '2026-09-27T09:00:00.000Z', expected: 900_000, counted: 900_000 } });
  // Till 2: opened two days ago and never closed.
  seed({ id: 's_old_open', device: 'till-2', by: 'u_ali', openedAt: '2026-09-24T07:00:00.000Z', floatCents: 50_000 });
  // Till 3: closed the moment today starts (counts), and a millisecond before it (does not).
  seed({ id: 's_edge_before', device: 'till-3', by: 'u_sara', openedAt: '2026-09-24T06:00:00.000Z', floatCents: 0, closed: { by: 'u_sara', at: '2026-09-25T23:59:59.999Z', expected: 100_000, counted: 100_000 } });
  seed({ id: 's_edge_start', device: 'till-3', by: 'u_sara', openedAt: '2026-09-25T06:00:00.000Z', floatCents: 0, closed: { by: 'u_sara', at: '2026-09-26T00:00:00.000Z', expected: 200_000, counted: 200_000 } });
  // Deleted (a sync correction): never shows.
  seed({ id: 's_deleted', device: 'till-3', by: 'u_sara', openedAt: '2026-09-26T08:00:00.000Z', floatCents: 0, closed: { by: 'u_sara', at: '2026-09-26T09:00:00.000Z', expected: 0, counted: 0 }, deletedAt: '2026-09-26T09:30:00.000Z' });

  // What else opened the drawers: cash in and out, and no-sale opens (the count at close is not one).
  const move = db.prepare(
    `INSERT INTO cash_movements (id, shift_id, type, amount_cents, reason, user_id, created_at, updated_at, device_id) VALUES (?, ?, ?, ?, 'Test', 'u_sara', ?, ?, ?)`,
  );
  move.run('cm1', 's_old_open', 'payin', 10_000, '2026-09-24T09:00:00.000Z', T0, 'till-2');
  move.run('cm2', 's_old_open', 'payout', 3_000, '2026-09-26T09:00:00.000Z', T0, 'till-2');
  move.run('cm3', 's_yesterday', 'payout', 20_000, '2026-09-25T18:00:00.000Z', T0, 'till-1');
  const dopen = db.prepare(
    `INSERT INTO drawer_opens (id, shift_id, kind, reason, user_id, approved_by_user_id, created_at, updated_at, device_id) VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, ?)`,
  );
  dopen.run('do1', 's_old_open', 'no_sale', 'u_ali', '2026-09-26T10:00:00.000Z', T0, 'till-2');
  dopen.run('do2', 's_yesterday', 'no_sale', 'u_ali', '2026-09-25T19:00:00.000Z', T0, 'till-1');
  dopen.run('do3', 's_yesterday', 'count', 'u_sara', '2026-09-26T01:25:00.000Z', T0, 'till-1');

  tabs = await import('./report-tabs.js');
  worker = await import('./worker.js');
  report = await import('../business-report.js');
});

const ids = (shifts: readonly ReportShiftLine[]) => shifts.map((s) => s.id);

/** The Team tab's shifts as the Reports worker hands them over (a copy, as from its thread). */
function viaWorker(req: BusinessReportRequest): ReportShiftLine[] {
  const msg: RunRequest = { type: 'run', id: 1, kind: 'team', request: req, nowIso: NOW.toISOString() };
  const reply = worker.handleRunRequest(db, structuredClone(msg));
  if (reply.type !== 'result' || !reply.ok) throw new Error(`worker said no: ${JSON.stringify(reply)}`);
  return structuredClone(reply.data as { shifts: ReportShiftLine[] }).shifts;
}

live('shift history: every shift that overlaps the period', () => {
  it('Today: the shift still open from two days ago, the one closed this morning, today’s own and the one closed as the day began — newest first', () => {
    const shifts = tabs.buildReportTab(db, 'team', TODAY, NOW).shifts;
    expect(ids(shifts)).toEqual(['s_inside', 's_yesterday', 's_edge_start', 's_old_open']);
    // Not: closed before the day (s_before, s_edge_before), opened as it ends (s_after), deleted.
  });

  it('keeps every figure as saved at close; a shift still open has none yet', () => {
    const byId = new Map(tabs.buildReportTab(db, 'team', TODAY, NOW).shifts.map((s) => [s.id, s]));
    expect(byId.get('s_yesterday')).toEqual({
      id: 's_yesterday',
      openedAt: '2026-09-25T15:00:00.000Z',
      closedAt: '2026-09-26T01:30:00.000Z',
      openedBy: 'Ali',
      closedBy: 'Sara',
      openingCashCents: 500_000,
      expectedCashCents: 600_000,
      countedCashCents: 590_000,
      varianceCents: -10_000,
      cashInCents: 0,
      cashOutCents: 20_000,
      // Typed by hand: none of it went to an outside rider (v0.7.34).
      riderChargesCents: 0,
      cashMovementCount: 1,
      // The count at close is not a no-sale open.
      noSaleOpens: 1,
      // Every opening of the drawer on the shift (the drawer log, 0042): the no-sale and the count.
      drawerOpenCount: 2,
      // No test order of it was deleted after it closed (0043).
      testDeletedCashCents: 0,
      openingNote: null,
      closingNote: null,
      carriedUnpaidCount: 0,
      carryOverReason: null,
      carriedTestDeletedCount: 0,
    });
    expect(byId.get('s_old_open')).toEqual({
      id: 's_old_open',
      openedAt: '2026-09-24T07:00:00.000Z',
      closedAt: null,
      openedBy: 'Ali',
      closedBy: null,
      openingCashCents: 50_000,
      expectedCashCents: null,
      countedCashCents: null,
      varianceCents: null,
      // Every cash in / out on the shift, whenever it was, as before.
      cashInCents: 10_000,
      cashOutCents: 3_000,
      riderChargesCents: 0,
      cashMovementCount: 2,
      noSaleOpens: 1,
      drawerOpenCount: 1,
      testDeletedCashCents: 0,
      openingNote: null,
      closingNote: null,
      carriedUnpaidCount: 0,
      carryOverReason: null,
      carriedTestDeletedCount: 0,
    });
    expect(byId.get('s_inside')).toMatchObject({ closedBy: 'Owner', varianceCents: 5_000 });
  });

  it('Yesterday and the last 7 days: the shift still open shows in every period since it opened', () => {
    expect(ids(tabs.buildReportTab(db, 'team', YESTERDAY, NOW).shifts)).toEqual(['s_yesterday', 's_edge_start', 's_old_open', 's_edge_before']);
    expect(ids(tabs.buildReportTab(db, 'team', LAST_7, NOW).shifts)).toEqual([
      's_inside',
      's_yesterday',
      's_edge_start',
      's_old_open',
      's_edge_before',
      's_before',
    ]);
    // Before any shift: none.
    expect(tabs.buildReportTab(db, 'team', { sinceIso: '2026-09-01T00:00:00.000Z', untilIso: '2026-09-02T00:00:00.000Z' }, NOW).shifts).toEqual([]);
  });

  it('the Reports worker hands over exactly what the tab builder works out (the main process builds with it when the worker is not running)', () => {
    for (const req of [TODAY, YESTERDAY, LAST_7]) {
      expect(viaWorker(req)).toEqual(tabs.buildReportTab(db, 'team', req, NOW).shifts);
    }
    expect(ids(viaWorker(TODAY))).toEqual(['s_inside', 's_yesterday', 's_edge_start', 's_old_open']);
  });

  it('the whole page (the other tests’ reconciliations, the bench) lists the same shifts', () => {
    expect(report.getBusinessReport(db, TODAY, NOW).shifts).toEqual(tabs.buildReportTab(db, 'team', TODAY, NOW).shifts);
  });
});

/**
 * Outside riders in the shift history (v0.7.34, step 19-1): the payouts linked
 * to an order (cash_movements.order_id, 0049) — a delivery charge an outside
 * rider kept, or a trip paid for an order then cancelled — stay in the cash
 * taken out (the expected cash took them) and are also riderChargesCents, the
 * screen's and the file's "To riders". The cash in / out count is the entries
 * typed by hand only. A test order deleted after the close takes its payout
 * off the cash noted for it. Read from the payouts, never from the orders'
 * frozen keep: a cancelled order whose rider was not paid adds nothing. A
 * fresh database of its own; every name and amount is made up.
 */
live('shift history: what the drawer paid outside riders', () => {
  let rdb: ReturnType<typeof openMigrated>;
  const at = (hhmm: string) => `2026-09-26T${hhmm}:00.000Z`;
  let line: ReportShiftLine;
  let other: ReportShiftLine;

  beforeAll(() => {
    rdb = openMigrated();
    rdb.prepare(`INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES ('u_sara', 'Sara', 'x', 'manager', ?, ?, 'till-1')`).run(T0, T0);
    const shift = rdb.prepare(
      `INSERT INTO shifts (id, device_id, opened_by_user_id, opened_at, opening_cash_cents, closed_by_user_id, closed_at,
         expected_cash_cents, counted_cash_cents, variance_cents, created_at, updated_at)
       VALUES (?, ?, 'u_sara', ?, 500000, 'u_sara', ?, 900000, 900000, 0, ?, ?)`,
    );
    shift.run('s_riders', 'till-1', at('07:00'), at('20:00'), T0, T0);
    // The other till's shift (the race 18-13 lets through: money beats a cancel, so one trip was paid twice).
    shift.run('s_other', 'till-2', at('07:30'), at('20:30'), T0, T0);

    const order = rdb.prepare(
      `INSERT INTO orders (id, order_number, mode, status, cashier_id, source, subtotal_cents, tax_cents, total_cents, paid_at,
         rider_keeps_cents, dispatched_at, shift_id, deleted_at, delete_kind, created_at, updated_at, device_id)
       VALUES (?, ?, 'delivery', ?, 'u_sara', 'pos', 100000, 16000, 116000, ?, 20000, ?, 's_riders', ?, ?, ?, ?, 'till-1')`,
    );
    // Rider paid: he kept Rs 200 of a cash order.
    order.run('o_kept', '20260926-0001', 'paid', at('10:00'), at('09:30'), null, null, at('09:00'), at('09:00'));
    // Sent out, cancelled, the rider paid Rs 200 for the trip.
    order.run('o_trip', '20260926-0002', 'void', null, at('10:30'), null, null, at('10:00'), at('10:00'));
    // Sent out, cancelled, the rider NOT paid: its frozen keep moved no money.
    order.run('o_void_unpaid', '20260926-0003', 'void', null, at('11:30'), null, null, at('11:00'), at('11:00'));
    // A test order, deleted by the owner AFTER the shift closed, and one deleted before it closed.
    order.run('o_test_after', '20260926-0004', 'paid', at('12:30'), at('12:10'), at('21:00'), 'test', at('12:00'), at('12:00'));
    order.run('o_test_before', '20260926-0005', 'paid', at('13:30'), at('13:10'), at('19:00'), 'test', at('13:00'), at('13:00'));

    const pay = rdb.prepare(
      `INSERT INTO payments (id, order_id, method, amount_cents, received_by_user_id, paid_at, shift_id, deleted_at, created_at, updated_at, device_id)
       VALUES (?, ?, 'cash', ?, 'u_sara', ?, 's_riders', ?, ?, ?, 'till-1')`,
    );
    pay.run('p_kept', 'o_kept', 116000, at('10:00'), null, at('10:00'), at('10:00'));
    pay.run('p_test_after', 'o_test_after', 116000, at('12:30'), at('21:00'), at('12:30'), at('12:30'));
    pay.run('p_test_before', 'o_test_before', 116000, at('13:30'), at('19:00'), at('13:30'), at('13:30'));

    const move = rdb.prepare(
      `INSERT INTO cash_movements (id, shift_id, type, amount_cents, reason, user_id, order_id, deleted_at, created_at, updated_at, device_id)
       VALUES (?, ?, ?, ?, 'Test', 'u_sara', ?, ?, ?, ?, ?)`,
    );
    // Typed by hand: a cash out, a rider tip and a cash in.
    move.run('cm_gas', 's_riders', 'payout', 5_000, null, null, at('08:00'), at('08:00'), 'till-1');
    move.run('cm_tip', 's_riders', 'tip_out', 3_000, null, null, at('08:10'), at('08:10'), 'till-1');
    move.run('cm_in', 's_riders', 'payin', 10_000, null, null, at('08:20'), at('08:20'), 'till-1');
    // To outside riders: the kept charge and the trip.
    move.run('cm_kept', 's_riders', 'payout', 20_000, 'o_kept', null, at('10:00'), at('10:00'), 'till-1');
    move.run('cm_trip', 's_riders', 'payout', 20_000, 'o_trip', null, at('10:40'), at('10:40'), 'till-1');
    // The test orders' payouts, deleted with them (after the close, and before it).
    move.run('cm_test_after', 's_riders', 'payout', 20_000, 'o_test_after', at('21:00'), at('12:30'), at('21:00'), 'till-1');
    move.run('cm_test_before', 's_riders', 'payout', 20_000, 'o_test_before', at('19:00'), at('13:30'), at('19:00'), 'till-1');
    // The other till paid the rider for the same trip as o_kept (a cancel there raced Rider paid here).
    move.run('cm_other_trip', 's_other', 'payout', 20_000, 'o_kept', null, at('10:05'), at('10:05'), 'till-2');

    const byId = new Map(tabs.buildReportTab(rdb, 'team', TODAY, NOW).shifts.map((s) => [s.id, s]));
    line = byId.get('s_riders')!;
    other = byId.get('s_other')!;
  });

  it('the cash taken out keeps the riders’ payouts; To riders is that part of it (kept charge + trip)', () => {
    expect(line).toMatchObject({
      cashInCents: 10_000,
      // Rs 50 cash out + Rs 30 rider tip + Rs 200 kept + Rs 200 trip; the test orders' payouts are deleted.
      cashOutCents: 48_000,
      riderChargesCents: 40_000,
    });
  });

  it('the cash in / out count is the entries typed by hand only', () => {
    expect(line.cashMovementCount).toBe(3);
  });

  it('a test order deleted after the close takes its payout off the cash noted for it; one deleted before the close is not noted', () => {
    // Rs 1,160 taken for it, Rs 200 of that paid to the rider: Rs 960 of the saved expected cash was the test.
    expect(line.testDeletedCashCents).toBe(96_000);
  });

  it('each till’s shift counts its own payout: one trip paid twice shows on both', () => {
    expect(other).toMatchObject({ cashOutCents: 20_000, riderChargesCents: 20_000, cashMovementCount: 0, testDeletedCashCents: 0 });
  });

  it('the Reports worker and the whole page say the same', () => {
    const msg: RunRequest = { type: 'run', id: 2, kind: 'team', request: TODAY, nowIso: NOW.toISOString() };
    const reply = worker.handleRunRequest(rdb, structuredClone(msg));
    if (reply.type !== 'result' || !reply.ok) throw new Error(`worker said no: ${JSON.stringify(reply)}`);
    const viaThread = structuredClone(reply.data as { shifts: ReportShiftLine[] }).shifts;
    expect(viaThread).toEqual(tabs.buildReportTab(rdb, 'team', TODAY, NOW).shifts);
    expect(report.getBusinessReport(rdb, TODAY, NOW).shifts).toEqual(viaThread);
  });
});
