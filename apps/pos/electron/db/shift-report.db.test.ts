/**
 * The shift report frozen at Close shift (owner, 2 Oct 2026: "while closing
 * there should full sales from printer"), in shifts.close_report_json
 * (migration 0051), on real databases built from every migration, driven
 * through the repositories.
 *
 * The close's side (final plan step 19d-2), with a made-up maker standing in
 * for the service's makeShiftReport (19d-3):
 *   - closeShift hands the maker its own figures, once, inside its
 *     transaction, after every check that can refuse it and before the shift
 *     is written: the shift as it was, the close's moment, who closed it and
 *     how, the drawer (the float, cash sales and refunds, the breakdown of
 *     cash in and out, expected, counted, over / short) exactly as stored,
 *     the note count as stored, the orders carried over and the reason;
 *   - the column stores what the maker made; the audit row keeps its version
 *     and SHA-256, and the sync entry the text;
 *   - a maker that throws never stops the close: the column is NULL, the log
 *     says why, one sync row and one audit row as ever, the chain whole. A
 *     maker that gives null, or none at all, is no report;
 *   - a refused close never calls the maker and writes nothing;
 *   - getShiftCloseReport reads the stored text back; the shift lists never
 *     carry it;
 *   - two tills: the report travels with the shift; a till without the
 *     column applies the shift with nothing waiting; an image without the
 *     key leaves a stored report alone.
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for
 * Electron); skipped where it is missing. Every name, number and amount is
 * made up (the repository is public).
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CashCount, Shift } from '@cheeseoclock/shared-types';
import { parseCashCountJson } from '@cheeseoclock/shared-schemas';
import type { SyncChange } from '@cheeseoclock/sync-core';
import type { AppDatabase } from './connection.js';
import { DatabaseSync, openMigrated } from './costing-shop.fixture.js';
import { TEST_USERS, iAm, openTill } from './two-tills.fixture.js';
import { verifyAuditChain, type AuditChainRow } from './audit-chain.js';
import type { CloseShiftInput, ShiftCloseContext, ShiftCloseReport } from './repositories/shift-repo.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const h = vi.hoisted(() => ({
  infos: [] as Array<[string, Record<string, unknown>]>,
  errors: [] as Array<[string, unknown]>,
}));
vi.mock('electron-log/main', () => ({
  default: {
    info: (message: string, data: Record<string, unknown>) => {
      h.infos.push([message, data]);
    },
    warn: () => {},
    error: (message: string, data: unknown) => {
      h.errors.push([message, data]);
    },
    debug: () => {},
  },
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '', getVersion: () => '0.0.0-test' },
  dialog: {},
  safeStorage: { isEncryptionAvailable: () => false },
  Notification: class {
    static isSupported() {
      return false;
    }
  },
}));
// No printer, no FBR and no alert window here.
vi.mock('../services/print-spooler.js', () => ({
  printSpooler: new Proxy({}, { get: () => () => undefined }),
  drawerFailureText: () => '',
}));
vi.mock('../services/fbr-worker.js', () => ({ fbrWorker: { kick: () => {}, resetAdapter: () => {} } }));
vi.mock('../services/order-alerts-hub.js', () => ({ orderAlerts: { orderReceived: () => {}, importFailed: () => {} } }));

beforeEach(() => {
  h.infos.length = 0;
  h.errors.length = 0;
});

const live = describe.skipIf(!DatabaseSync);

const TILL_A = 'till-a';
const A = {
  cashier: { userId: TEST_USERS.cashier.userId, deviceId: TILL_A },
  manager: { userId: TEST_USERS.manager.userId, deviceId: TILL_A },
};
/** The float: Rs 5,000. */
const FLOAT = 500_000;
/** Rs 200, the area's delivery charge as sold (before its tax): what an outside rider keeps. */
const KEEP = 20_000;

/** 5,000 × 2, 1,000 × 3, 500 × 1, 100 × 7, 10 × 4 and Rs 35 in coins: Rs 14,275. */
const COUNT: CashCount = {
  notes: [
    { faceCents: 500_000, count: 2 },
    { faceCents: 100_000, count: 3 },
    { faceCents: 50_000, count: 1 },
    { faceCents: 10_000, count: 7 },
    { faceCents: 5_000, count: 0 },
    { faceCents: 2_000, count: 0 },
    { faceCents: 1_000, count: 4 },
  ],
  otherCents: 3_500,
};
const COUNT_CENTS = 1_427_500;

type Row = Record<string, unknown>;
const orderRepo = () => import('./repositories/order-repo.js');
const shiftRepo = () => import('./repositories/shift-repo.js');

interface Menu {
  /** 'Test Zinger Burger', Rs 1,000 at 15%. */
  burger: string;
  /** 'Delivery Charge (Rs 200)' at 15%. */
  charge: string;
}

/** The made-up menu on `db`: a 15% tax, a burger and the area's delivery charge. */
async function menuOn(db: AppDatabase, actor: { userId: string; deviceId: string }): Promise<Menu> {
  const { createTaxCategory } = await import('./repositories/tax-category-repo.js');
  const { createCategory } = await import('./repositories/category-repo.js');
  const { createMenuItem } = await import('./repositories/menu-item-repo.js');
  const tax = createTaxCategory(db, { name: 'Test GST', rateBps: 1_500 }, actor);
  const food = createCategory(db, { name: 'Test Burgers', displayOrder: 1, colorHex: '#aa5500' }, actor);
  const fees = createCategory(db, { name: 'Delivery Charges', displayOrder: 2, colorHex: '#555555' }, actor);
  const item = (categoryId: string, name: string, basePriceCents: number) =>
    createMenuItem(db, { categoryId, name, basePriceCents, taxCategoryId: tax.id }, actor).id;
  return {
    burger: item(food.id, 'Test Zinger Burger', 100_000),
    charge: item(fees.id, 'Delivery Charge (Rs 200)', KEEP),
  };
}

/** Till A: the users, the menu, and a shift opened by the cashier on the float. */
async function till(): Promise<{ db: AppDatabase; menu: Menu; shiftId: string }> {
  const { openShift } = await shiftRepo();
  const db = openTill(TILL_A);
  const menu = await menuOn(db, A.manager);
  const shiftId = openShift(db, { openingCashCents: FLOAT }, A.cashier).id;
  return { db, menu, shiftId };
}

/** A counter takeaway with `qty` burgers, sent to the kitchen and ready, not paid. */
async function readyTakeaway(db: AppDatabase, menu: Menu, qty = 1): Promise<{ id: string; total: number }> {
  const r = await orderRepo();
  const o = r.createOrder(db, { mode: 'takeaway' }, A.cashier);
  r.addOrderItem(db, { orderId: o.id, menuItemId: menu.burger, quantity: qty, modifierIds: [] }, A.cashier);
  r.sendOrderToKitchen(db, o.id, A.cashier);
  r.markOrderReady(db, o.id, A.cashier);
  return { id: o.id, total: r.findOrder(db, o.id)!.totalCents };
}

/** A counter takeaway with one burger, paid up front (Pay now) by `method`. */
async function paidTakeaway(db: AppDatabase, menu: Menu, method: 'cash' | 'card'): Promise<{ id: string; total: number }> {
  const r = await orderRepo();
  const o = r.createOrder(db, { mode: 'takeaway' }, A.cashier);
  r.addOrderItem(db, { orderId: o.id, menuItemId: menu.burger, quantity: 1, modifierIds: [] }, A.cashier);
  const total = r.findOrder(db, o.id)!.totalCents;
  r.tenderOrder(db, { orderId: o.id, payments: [{ method, amountCents: total, tenderedCents: method === 'cash' ? total : null }] }, A.cashier);
  return { id: o.id, total };
}

/** A counter delivery with a burger and the Rs 200 charge, sent out with an outside rider. */
async function sentOut(db: AppDatabase, menu: Menu): Promise<{ id: string; total: number }> {
  const r = await orderRepo();
  const o = r.createOrder(db, { mode: 'delivery' }, A.cashier);
  r.addOrderItem(db, { orderId: o.id, menuItemId: menu.burger, quantity: 1, modifierIds: [] }, A.cashier);
  r.addOrderItem(db, { orderId: o.id, menuItemId: menu.charge, quantity: 1, modifierIds: [] }, A.cashier);
  r.sendOrderToKitchen(db, o.id, A.cashier);
  r.markOrderReady(db, o.id, A.cashier);
  const out = r.sendOutOrder(db, o.id, A.cashier);
  expect(out.riderKeepsCents).toBe(KEEP);
  return { id: o.id, total: out.totalCents };
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** A made-up report maker: what it was handed (copied), and a text of a few of those figures. */
function stubMaker(db: AppDatabase): {
  calls: ShiftCloseContext[];
  /** What the database held while it ran: the shift's row, and how many sync and audit rows there were. */
  seen: Row[];
  made: ShiftCloseReport[];
  makeReport: (c: ShiftCloseContext) => ShiftCloseReport;
} {
  const calls: ShiftCloseContext[] = [];
  const seen: Row[] = [];
  const made: ShiftCloseReport[] = [];
  return {
    calls,
    seen,
    made,
    makeReport: (c) => {
      calls.push(structuredClone(c));
      seen.push({
        ...(db.prepare(`SELECT closed_at, counted_cash_cents, close_report_json FROM shifts WHERE id = ?`).get(c.shift.id) as Row),
        sync: count(db, 'sync_queue'),
        audit: count(db, 'audit_log'),
      });
      const json = JSON.stringify({ v: 1, test: 'made up', shiftId: c.shift.id, expectedCents: c.drawer.expectedCents, closedAt: c.closedAt });
      const report = { json, sha256: sha256(json) };
      made.push(report);
      return report;
    },
  };
}

const count = (db: AppDatabase, table: 'sync_queue' | 'audit_log') => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row)['n']);

const storedShift = (db: AppDatabase, shiftId: string) =>
  db
    .prepare(
      `SELECT closed_at, closed_by_user_id, opening_cash_cents, counted_cash_cents, expected_cash_cents, variance_cents,
              carried_unpaid_count, carry_over_reason, counted_notes_json, close_report_json
         FROM shifts WHERE id = ?`,
    )
    .get(shiftId) as Row;

function auditRows(db: AppDatabase): AuditChainRow[] {
  return db
    .prepare(
      `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action,
              actor_user_id AS actorUserId, before_json AS beforeJson, after_json AS afterJson,
              ip, created_at AS createdAt, prev_hash AS prevHash, row_hash AS rowHash
         FROM audit_log ORDER BY rowid`,
    )
    .all() as unknown as AuditChainRow[];
}

/** The shift_close audit rows of a shift, their after-images read. */
function closeAudits(db: AppDatabase, shiftId: string): Row[] {
  return (db.prepare(`SELECT after_json FROM audit_log WHERE entity_id = ? AND action = 'shift_close' ORDER BY rowid`).all(shiftId) as Row[]).map(
    (r) => JSON.parse(String(r['after_json'])) as Row,
  );
}

/** The sync entries queued for a shift, their payloads read. */
function shiftSyncPayloads(db: AppDatabase, shiftId: string): Row[] {
  return (
    db.prepare(`SELECT payload_json FROM sync_queue WHERE entity_type = 'shifts' AND entity_id = ? ORDER BY created_at, rowid`).all(shiftId) as Row[]
  ).map((r) => JSON.parse(String(r['payload_json'])) as Row);
}

/** The 'Shift closed' log lines. */
const closedLogs = () => h.infos.filter(([m]) => m === 'Shift closed').map(([, d]) => d);

/** The close's ordinary input: counted to the rupee on `countedCashCents`. */
const plainClose = (shiftId: string, countedCashCents: number): CloseShiftInput => ({ shiftId, countedCashCents });

live('closeShift makes the shift report inside the close (shifts.close_report_json, migration 0051)', () => {
  it('hands the maker the close’s own figures, once, before the shift is written; the column stores what it made', async () => {
    const { db, menu, shiftId } = await till();
    const r = await orderRepo();
    const repo = await shiftRepo();
    // A busy little shift: cash and card sales, a cash refund, cash in and
    // out of every kind, an outside rider who kept his charge and one paid
    // for a wasted trip, and an order still unpaid.
    const cash = await paidTakeaway(db, menu, 'cash');
    await paidTakeaway(db, menu, 'card');
    const refunded = await paidTakeaway(db, menu, 'cash');
    r.refundOrder(db, { orderId: refunded.id, reason: 'Test wrong order', approverUserId: A.manager.userId, foodMade: 'not_made' }, A.manager);
    repo.recordCashMovement(db, { type: 'payin', amountCents: 100_000, reason: 'Test change from the bank' }, A.manager);
    repo.recordCashMovement(db, { type: 'payout', amountCents: 30_000, reason: 'Test gas cylinder' }, A.manager);
    repo.recordCashMovement(db, { type: 'tip_out', amountCents: 5_000, reason: 'Test rider tip' }, A.manager);
    const kept = await sentOut(db, menu);
    r.takeRiderPayment(db, { orderId: kept.id, method: 'cash', riderKeepsCents: KEEP }, A.cashier);
    const wasted = await sentOut(db, menu);
    r.voidOrder(db, { orderId: wasted.id, reason: 'Test refused at the door', approverUserId: A.manager.userId, payRiderForTrip: true }, A.manager);
    const unpaid = await readyTakeaway(db, menu, 2);

    const summary = repo.getShiftSummary(db, shiftId);
    expect(summary.cashRefundsCents).toBe(refunded.total);
    const moves = repo.cashMovementTotals(db, shiftId);
    const shiftBefore = repo.findShift(db, shiftId)!;
    const unpaidBefore = repo.listUnpaidForClose(db, TILL_A);
    expect(unpaidBefore.map((o) => o.orderId)).toEqual([unpaid.id]);
    const before = { sync: count(db, 'sync_queue'), audit: count(db, 'audit_log') };

    // Closed with a manager's PIN on the cashier's login, counted by note.
    const approval = { via: 'manager_pin' as const, tillSignedInUserId: A.cashier.userId };
    const maker = stubMaker(db);
    const closed = repo.closeShift(
      db,
      {
        shiftId,
        countedCashCents: COUNT_CENTS,
        countedNotes: COUNT,
        notes: 'Test close',
        carryOverReason: '  Test customer pays tomorrow ',
        carryOverOrderIds: [unpaid.id],
      },
      A.manager,
      approval,
      { makeReport: maker.makeReport },
    );

    expect(maker.calls).toHaveLength(1);
    const ctx = maker.calls[0]!;
    const row = storedShift(db, shiftId);
    // The close's own figures, as the shift row has them.
    expect(ctx.closedAt).toBe(row['closed_at']);
    expect(ctx.closedAt).toBe(closed.closedAt);
    expect(ctx.closedByUserId).toBe(row['closed_by_user_id']);
    expect(ctx.closedByUserId).toBe(A.manager.userId);
    expect(ctx.approval).toEqual(approval);
    expect(ctx.shift).toEqual(shiftBefore);
    expect(ctx.shift.closedAt).toBeNull();
    expect({ expected: ctx.drawer.expectedCents, counted: ctx.drawer.countedCents, variance: ctx.drawer.varianceCents }).toEqual({
      expected: row['expected_cash_cents'],
      counted: row['counted_cash_cents'],
      variance: row['variance_cents'],
    });
    // The drawer: the float, the shift's cash sales and refunds, and the breakdown of cash in and out.
    expect(ctx.drawer).toEqual({
      openingCents: FLOAT,
      cashSalesCents: summary.cashSalesCents,
      cashRefundsCents: summary.cashRefundsCents,
      cashIn: { count: 1, cents: 100_000 },
      payouts: { count: 1, cents: 30_000 },
      tips: { count: 1, cents: 5_000 },
      riderKept: { count: 2, cents: 2 * KEEP, tripCount: 1 },
      expectedCents: summary.expectedCashCents,
      countedCents: COUNT_CENTS,
      varianceCents: COUNT_CENTS - summary.expectedCashCents,
    });
    expect(ctx.drawer.cashSalesCents).toBe(cash.total + refunded.total + kept.total);
    expect(moves).toMatchObject({ inCount: 1, payoutCount: 1, tipCount: 1, riderCount: 2, riderTripCount: 1 });
    // It adds up to the expected cash: nothing is left for 'other'.
    const d = ctx.drawer;
    expect(d.openingCents + d.cashSalesCents - d.cashRefundsCents + d.cashIn.cents - d.payouts.cents - d.tips.cents - d.riderKept.cents).toBe(
      d.expectedCents,
    );
    // The note count as stored (0050's text read back), the orders carried over and the reason as stored.
    expect(ctx.countedNotes).toEqual(COUNT);
    expect(ctx.countedNotes).toEqual(parseCashCountJson(String(row['counted_notes_json'])));
    expect(ctx.unpaid).toEqual(unpaidBefore);
    expect(ctx.carryOverReason).toBe('Test customer pays tomorrow');
    expect(ctx.carryOverReason).toBe(row['carry_over_reason']);

    // Called before the shift was written: still open, no sync or audit row of the close yet.
    expect(maker.seen).toEqual([{ closed_at: null, counted_cash_cents: null, close_report_json: null, ...before }]);
    // The column stores what it made, as made.
    expect(row['close_report_json']).toBe(maker.made[0]!.json);
    expect(closedLogs()).toEqual([expect.objectContaining({ id: shiftId, reportMade: true })]);
    expect(h.errors).toEqual([]);
  });

  it('a close with nothing carried over, typed as one figure by the manager signed in: no orders, no reason, no count, no approval', async () => {
    const { db, menu, shiftId } = await till();
    const repo = await shiftRepo();
    const cash = await paidTakeaway(db, menu, 'cash');
    const maker = stubMaker(db);
    repo.closeShift(db, plainClose(shiftId, FLOAT + cash.total - 10_000), A.manager, null, { makeReport: maker.makeReport });

    expect(maker.calls).toHaveLength(1);
    expect(maker.calls[0]).toMatchObject({
      closedByUserId: A.manager.userId,
      approval: null,
      countedNotes: null,
      unpaid: [],
      carryOverReason: null,
      drawer: {
        openingCents: FLOAT,
        cashSalesCents: cash.total,
        cashRefundsCents: 0,
        cashIn: { count: 0, cents: 0 },
        payouts: { count: 0, cents: 0 },
        tips: { count: 0, cents: 0 },
        riderKept: { count: 0, cents: 0, tripCount: 0 },
        expectedCents: FLOAT + cash.total,
        countedCents: FLOAT + cash.total - 10_000,
        varianceCents: -10_000,
      },
    });
    expect(storedShift(db, shiftId)).toMatchObject({ carry_over_reason: null, counted_notes_json: null, close_report_json: maker.made[0]!.json });
  });

  it('the maker throws: the shift still closes with the column NULL and the log says why; one sync row and one audit row, closeReport null; the chain is whole', async () => {
    const { db, menu, shiftId } = await till();
    const repo = await shiftRepo();
    const cash = await paidTakeaway(db, menu, 'cash');
    const before = { sync: shiftSyncPayloads(db, shiftId).length, audits: closeAudits(db, shiftId).length };
    let calls = 0;
    const closed = repo.closeShift(db, { ...plainClose(shiftId, FLOAT + cash.total), countedNotes: null }, A.manager, null, {
      makeReport: () => {
        calls += 1;
        throw new Error('Test: the report broke');
      },
    });

    expect(calls).toBe(1);
    expect(closed).toMatchObject({ id: shiftId, countedCashCents: FLOAT + cash.total, expectedCashCents: FLOAT + cash.total, varianceCents: 0 });
    expect(closed.closedAt).not.toBeNull();
    expect(storedShift(db, shiftId)).toMatchObject({ closed_at: closed.closedAt, close_report_json: null });
    expect(h.errors).toEqual([['Shift report not made', { shiftId, error: 'Test: the report broke' }]]);
    expect(closedLogs()).toEqual([expect.objectContaining({ id: shiftId, reportMade: false })]);
    // Exactly one sync row and one shift_close audit row for the close, as for any close.
    const payloads = shiftSyncPayloads(db, shiftId);
    expect(payloads).toHaveLength(before.sync + 1);
    expect(payloads.at(-1)).toMatchObject({ id: shiftId, closedAt: closed.closedAt, closeReportJson: null });
    const audits = closeAudits(db, shiftId);
    expect(before.audits).toBe(0);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ id: shiftId, closedAt: closed.closedAt, closeReport: null });
    expect(verifyAuditChain(auditRows(db))).toMatchObject({ ok: true, brokenAt: null });
  });

  it('a maker that gives null (another till’s shift), or no maker at all (today’s callers): the column is NULL, the audit says closeReport null, nothing logged as an error', async () => {
    const repo = await shiftRepo();
    for (const opts of [{ makeReport: () => null }, {}, undefined]) {
      const { db, shiftId } = await till();
      h.infos.length = 0;
      repo.closeShift(db, plainClose(shiftId, FLOAT), A.manager, null, opts);
      expect(storedShift(db, shiftId)).toMatchObject({ close_report_json: null, expected_cash_cents: FLOAT, variance_cents: 0 });
      expect(closeAudits(db, shiftId)).toEqual([expect.objectContaining({ closeReport: null })]);
      expect(repo.getShiftCloseReport(db, shiftId)).toBeNull();
      expect(closedLogs()).toEqual([expect.objectContaining({ reportMade: false })]);
      expect(verifyAuditChain(auditRows(db)).ok).toBe(true);
    }
    expect(h.errors).toEqual([]);
  });

  it('a refused close never calls the maker and writes nothing: an order came in while counting, no reason, notes that do not add up, counted below 0, already closed', async () => {
    const { db, menu, shiftId } = await till();
    const repo = await shiftRepo();
    const unpaid = await readyTakeaway(db, menu);
    const maker = stubMaker(db);
    const snapshot = () => ({ sync: count(db, 'sync_queue'), audit: count(db, 'audit_log'), row: storedShift(db, shiftId) });
    const before = snapshot();
    const refused = (input: Partial<CloseShiftInput>) => () =>
      repo.closeShift(db, { ...plainClose(shiftId, FLOAT), ...input }, A.manager, null, { makeReport: maker.makeReport });

    // The box showed no unpaid order, and one came in while they counted.
    expect(refused({ carryOverReason: 'Test pays later', carryOverOrderIds: [] })).toThrow(/came in unpaid while you were counting/);
    // An unpaid order and no reason for it.
    expect(refused({})).toThrow(/not paid yet/);
    // Notes that do not add up to the counted cash (19a): checked before anything else.
    expect(refused({ countedCashCents: COUNT_CENTS - 100_000, countedNotes: COUNT, carryOverReason: 'Test pays later' })).toThrow(
      new Error('The notes counted add up to Rs 14,275, not Rs 13,275. Count the drawer again.'),
    );
    expect(refused({ countedCashCents: -1, carryOverReason: 'Test pays later' })).toThrow(new Error('Counted cash cannot be negative'));

    expect(maker.calls).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(before.row).toMatchObject({ closed_at: null, close_report_json: null });

    // Closed with the reason: the maker runs once. Closed again: refused, and not called again.
    repo.closeShift(db, { ...plainClose(shiftId, FLOAT), carryOverReason: 'Test pays later', carryOverOrderIds: [unpaid.id] }, A.manager, null, {
      makeReport: maker.makeReport,
    });
    expect(maker.calls).toHaveLength(1);
    const closedOnce = snapshot();
    expect(refused({ carryOverReason: 'Test pays later' })).toThrow(new Error('Shift is already closed'));
    expect(maker.calls).toHaveLength(1);
    expect(snapshot()).toEqual(closedOnce);
  });

  it('the sync entry carries the stored text; the audit row its version and SHA-256 (the maker’s, and the stored text’s); the chain is whole', async () => {
    const { db, menu, shiftId } = await till();
    const repo = await shiftRepo();
    const cash = await paidTakeaway(db, menu, 'cash');
    const maker = stubMaker(db);
    const approval = { via: 'manager_pin' as const, tillSignedInUserId: A.cashier.userId };
    repo.closeShift(db, plainClose(shiftId, FLOAT + cash.total), A.manager, approval, { makeReport: maker.makeReport });

    const stored = String(storedShift(db, shiftId)['close_report_json']);
    expect(stored).toBe(maker.made[0]!.json);
    const payload = shiftSyncPayloads(db, shiftId).at(-1)!;
    expect(payload['__rowImage']).toBe(1);
    expect(payload['closeReportJson']).toBe(stored);

    const [audit] = closeAudits(db, shiftId);
    expect(audit).toMatchObject({ id: shiftId, approval, closeReport: { v: 1, sha256: maker.made[0]!.sha256 } });
    expect(audit!['closeReport']).toEqual({ v: 1, sha256: sha256(stored) });
    // The text itself stays in the column: the audit row and the shift's own image carry no copy of it.
    expect(JSON.stringify(audit)).not.toContain('made up');
    expect(audit).not.toHaveProperty('closeReportJson');
    expect(verifyAuditChain(auditRows(db))).toMatchObject({ ok: true, brokenAt: null });
  });

  it('the database itself ends the transaction inside the maker (a disk error): the close fails and nothing is written', async () => {
    const { db, shiftId } = await till();
    const repo = await shiftRepo();
    // better-sqlite3 says whether a transaction is still open (node:sqlite's stand-in does not): here it
    // ends, as SQLite does when an error rolls the whole transaction back.
    let inTransaction = true;
    const tillDb = new Proxy(db, { get: (t, k) => (k === 'inTransaction' ? inTransaction : Reflect.get(t, k)) });
    const before = { sync: count(db, 'sync_queue'), audit: count(db, 'audit_log'), row: storedShift(db, shiftId) };
    expect(() =>
      repo.closeShift(tillDb, plainClose(shiftId, FLOAT), A.manager, null, {
        makeReport: () => {
          inTransaction = false;
          throw new Error('Test: disk I/O error');
        },
      }),
    ).toThrow(new Error('Test: disk I/O error'));
    expect({ sync: count(db, 'sync_queue'), audit: count(db, 'audit_log'), row: storedShift(db, shiftId) }).toEqual(before);
    expect(before.row).toMatchObject({ closed_at: null });
    expect(closedLogs()).toEqual([]);

    // While the transaction is still open, a throw is only logged and the shift closes.
    inTransaction = true;
    const closed = repo.closeShift(tillDb, plainClose(shiftId, FLOAT), A.manager, null, {
      makeReport: () => {
        throw new Error('Test: the report broke');
      },
    });
    expect(closed.closedAt).not.toBeNull();
    expect(h.errors).toEqual([['Shift report not made', { shiftId, error: 'Test: the report broke' }]]);
  });
});

live('getShiftCloseReport: the saved report, read on its own', () => {
  it('gives the stored text with the till and the close time; the shift lists never carry it', async () => {
    const { db, shiftId } = await till();
    const repo = await shiftRepo();
    const maker = stubMaker(db);
    const closed = repo.closeShift(db, plainClose(shiftId, FLOAT), A.manager, null, { makeReport: maker.makeReport });
    expect(repo.getShiftCloseReport(db, shiftId)).toEqual({ json: maker.made[0]!.json, deviceId: TILL_A, closedAt: closed.closedAt });

    // Not in SHIFT_SELECT nor the Shift type: the close's reply, findShift, the lists and the top bar's shift.
    const next = repo.openShift(db, { openingCashCents: FLOAT }, A.manager);
    const shifts: Shift[] = [closed, repo.findShift(db, shiftId)!, ...repo.listShifts(db, {}), repo.getCurrentShift(db, TILL_A)!];
    for (const s of shifts) {
      expect(Object.keys(s).filter((k) => /report/i.test(k))).toEqual([]);
    }
    expect(JSON.stringify(shifts)).not.toContain('made up');
    expect(repo.getShiftCloseReport(db, next.id)).toBeNull();
  });

  it('null for a shift still open, one closed with no report, an unknown id, a deleted shift, and empty text', async () => {
    const { db, shiftId } = await till();
    const repo = await shiftRepo();
    expect(repo.getShiftCloseReport(db, shiftId)).toBeNull();
    repo.closeShift(db, plainClose(shiftId, FLOAT), A.manager);
    expect(repo.getShiftCloseReport(db, shiftId)).toBeNull();
    expect(repo.getShiftCloseReport(db, 's_unknown')).toBeNull();

    const other = repo.openShift(db, { openingCashCents: FLOAT }, A.manager).id;
    repo.closeShift(db, plainClose(other, FLOAT), A.manager, null, { makeReport: stubMaker(db).makeReport });
    expect(repo.getShiftCloseReport(db, other)).not.toBeNull();
    db.prepare(`UPDATE shifts SET close_report_json = '' WHERE id = ?`).run(other);
    expect(repo.getShiftCloseReport(db, other)).toBeNull();
    db.prepare(`UPDATE shifts SET close_report_json = '{"v":1}', deleted_at = '2026-10-02T20:00:00.000Z' WHERE id = ?`).run(other);
    expect(repo.getShiftCloseReport(db, other)).toBeNull();
  });
});

// ------------------------------------------------------------- two tills

/** Everything `from` has queued, as the link sends it (not marked sent: it can go to more than one till). */
async function queued(from: AppDatabase, fromDevice: string): Promise<SyncChange[]> {
  const sync = await import('./repositories/sync-repo.js');
  return sync.listPendingSync(from, 1_000_000).map((p) => sync.pendingToChange(p, fromDevice));
}

/** Applied on `to` as the sync worker does: everything written, nothing left waiting for a later pull. */
async function applyAll(to: AppDatabase, changes: SyncChange[]): Promise<void> {
  const { applyRemoteBatch } = await import('./repositories/apply-remote.js');
  const { readParked } = await import('./repositories/sync-repo.js');
  expect(await applyRemoteBatch(to, changes, { pause: async () => {} })).toMatchObject({ applied: changes.length, waiting: 0, dropped: 0 });
  expect(readParked(to)).toEqual([]);
}

/** A till still on an older version: its migrations up to `stopBefore`, the same made-up users, its own device id. */
function olderTill(stopBefore: string, deviceId: string): AppDatabase {
  const db = openMigrated({ stopBefore }) as unknown as AppDatabase;
  const user = db.prepare(`INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, 'x', 'x', ?)`);
  for (const u of Object.values(TEST_USERS)) user.run(u.userId, u.name, u.role, TILL_A);
  iAm(db, deviceId);
  return db;
}

const withoutReport = (c: SyncChange): SyncChange =>
  c.entityType === 'shifts'
    ? ({ ...c, payload: Object.fromEntries(Object.entries(c.payload as Row).filter(([k]) => k !== 'closeReportJson')) } as SyncChange)
    : c;

/** Till A: a shift opened on the float and closed counted by note, its report made. */
async function closedOnA(): Promise<{ a: AppDatabase; shiftId: string; json: string }> {
  const repo = await shiftRepo();
  const a = openTill(TILL_A);
  const shiftId = repo.openShift(a, { openingCashCents: FLOAT }, A.cashier).id;
  const maker = stubMaker(a);
  repo.closeShift(a, { shiftId, countedCashCents: COUNT_CENTS, countedNotes: COUNT, notes: 'Test close' }, A.manager, null, {
    makeReport: maker.makeReport,
  });
  return { a, shiftId, json: maker.made[0]!.json };
}

live('two tills: the report travels with the shift', () => {
  it('the other till on this version gets the stored text, and reads it back with till A’s name on it', async () => {
    const repo = await shiftRepo();
    const { a, shiftId, json } = await closedOnA();
    const b = openTill('till-b', { usersFrom: TILL_A });
    await applyAll(b, await queued(a, TILL_A));
    expect(b.prepare(`SELECT * FROM shifts WHERE id = ?`).get(shiftId)).toEqual(a.prepare(`SELECT * FROM shifts WHERE id = ?`).get(shiftId));
    expect(repo.getShiftCloseReport(b, shiftId)).toEqual({ json, deviceId: TILL_A, closedAt: repo.findShift(a, shiftId)!.closedAt });
  });

  for (const [version, stopBefore, missing] of [
    ['on the step before (no close_report_json)', '0051', ['close_report_json']],
    ['still on v0.7.34 (no counted_notes_json, no close_report_json)', '0050', ['counted_notes_json', 'close_report_json']],
  ] as const) {
    it(`a till ${version} applies the shift with nothing waiting, every column it has written`, async () => {
      const { a, shiftId, json } = await closedOnA();
      const old = olderTill(stopBefore, 'till-old');
      const cols = (old.prepare(`PRAGMA table_info(shifts)`).all() as Row[]).map((c) => c['name']);
      for (const col of missing) expect(cols).not.toContain(col);
      const changes = await queued(a, TILL_A);
      expect(changes.filter((c) => c.entityType === 'shifts').at(-1)?.payload).toMatchObject({ closeReportJson: json });
      await applyAll(old, changes);
      const asOnA = a.prepare(`SELECT * FROM shifts WHERE id = ?`).get(shiftId) as Row;
      const asOnOld = Object.fromEntries(Object.entries(asOnA).filter(([k]) => !(missing as readonly string[]).includes(k)));
      expect(old.prepare(`SELECT * FROM shifts WHERE id = ?`).get(shiftId)).toEqual(asOnOld);
    });
  }

  it('an image without the key (an older till’s) gives NULL on a new row, and leaves a stored report alone', async () => {
    const repo = await shiftRepo();
    const { a, shiftId, json } = await closedOnA();
    const changes = await queued(a, TILL_A);

    // A till on this version that hears of the shift only from an older till: no report, the rest as closed.
    const c = openTill('till-c', { usersFrom: TILL_A });
    await applyAll(c, changes.map(withoutReport));
    expect(c.prepare(`SELECT close_report_json FROM shifts WHERE id = ?`).get(shiftId)).toEqual({ close_report_json: null });
    expect(repo.findShift(c, shiftId)).toMatchObject({ countedCashCents: COUNT_CENTS, countedNotes: COUNT, closeNotes: 'Test close' });
    expect(repo.getShiftCloseReport(c, shiftId)).toBeNull();

    // A till that has the report, then a later image of the shift without the key: the report stays.
    const b = openTill('till-b', { usersFrom: TILL_A });
    await applyAll(b, changes);
    const { readRowImage } = await import('./replicable-schema.js');
    const later = withoutReport({
      entityType: 'shifts',
      entityId: shiftId,
      op: 'upsert',
      payload: { ...readRowImage(a, 'shifts', shiftId)!, version: 9, updatedAt: '2026-10-02T20:00:00.000Z', closeNotes: 'Test close, checked' },
      updatedAt: '2026-10-02T20:00:00.000Z',
      deviceId: TILL_A,
      version: 9,
    } as SyncChange);
    expect(later.payload).not.toHaveProperty('closeReportJson');
    await applyAll(b, [later]);
    expect(b.prepare(`SELECT version, close_notes, close_report_json FROM shifts WHERE id = ?`).get(shiftId)).toEqual({
      version: 9,
      close_notes: 'Test close, checked',
      close_report_json: json,
    });
  });
});
