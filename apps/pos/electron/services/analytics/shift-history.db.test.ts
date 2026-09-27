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
      cashMovementCount: 1,
      // The count at close is not a no-sale open.
      noSaleOpens: 1,
      // Every opening of the drawer on the shift (the drawer log, 0040): the no-sale and the count.
      drawerOpenCount: 2,
      // No test order of it was deleted after it closed (0041).
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
