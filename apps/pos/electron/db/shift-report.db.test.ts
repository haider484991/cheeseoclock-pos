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
 * The report itself (step 19d-3), closed the way 'shifts:close' closes, with
 * the service's makeShiftReport:
 *   (1) every section saved, the header as at the close (this till's name
 *       less ' (win32)', the shop's, who opened, closed and whose login the
 *       PIN was on), the drawer and the note count as the shift row has them;
 *   (2) in each money flow and all of them at once: the drawer adds up to
 *       the stored expected cash with nothing unknown, Cash taken out is the
 *       close result's and Shift history's 'Taken out', (10) the close box's
 *       Paid orders and Refunds are the paper's, NET SALES is the money taken;
 *   (3) the orders settled here: carried over and paid in the next shift,
 *       taken on the other till, a website delivery sent out, discounts by
 *       kind with an offer taken off left out;
 *   (4) frozen: nothing after the close changes the saved text; the cash of
 *       test orders deleted after it is noted on its own;
 *   (5) test orders deleted before the close are nowhere on it;
 *   (9) another till's shift gets no report;
 *   (11) the close reads no food cost;
 *   (12) and reads by index;
 *   (13) each refund row says what it did (v0.7.35 review): ', part' on a
 *       row of less than the order's total, so two parts of one order both
 *       say part; one refund of the whole order does not, even when it went
 *       back through each method the customer paid (cash + card);
 *   (14) two orders that share a number (one from each till) are two
 *       refunded orders on the paper, as SALES counts them.
 *
 * Every try at printing it (step 19f-1): one chained 'shift_report_printed'
 * audit row per try, failed ones too, nothing synced and the shift
 * untouched; shiftReportPrintHistory counts this till's original tries, if
 * one came out, and the highest reprint number used; till B never counts
 * till A's; a try that cannot be is refused; the history reads by index.
 *
 * Shift history (step 19g-2): each line says only whether its close saved a
 * report (hasCloseReport), through the Reports worker too; a shift closed
 * on the other till with its report has it there, one heard of only from
 * an older till does not.
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for
 * Electron); skipped where it is missing. Every name, number and amount is
 * made up (the repository is public).
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CashCount, ChannelOffer, ReportShiftLine, Shift, ShiftReport, ShiftReportSection } from '@cheeseoclock/shared-types';
import { SHIFT_REPORT_SECTIONS, shortOrderNumber as shortNumber } from '@cheeseoclock/shared-types';
import { parseCashCountJson, parseShiftReportJson } from '@cheeseoclock/shared-schemas';
import { shiftReportDrawerAddsUp, shiftReportJson } from '@cheeseoclock/pos-domain';
import { escPosToText, renderShiftReport } from '@cheeseoclock/printer-core';
import type { SyncChange } from '@cheeseoclock/sync-core';
import type { AppDatabase } from './connection.js';
import { DatabaseSync, openMigrated } from './costing-shop.fixture.js';
import { TEST_USERS, iAm, openTill, push } from './two-tills.fixture.js';
import { verifyAuditChain, type AuditChainRow } from './audit-chain.js';
import type { CloseApproval, CloseShiftInput, ShiftCloseContext, ShiftCloseReport, ShiftReportPrintInput } from './repositories/shift-repo.js';
import type { TenderInputItem } from './repositories/order-repo.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const h = vi.hoisted(() => ({
  infos: [] as Array<[string, Record<string, unknown>]>,
  warns: [] as Array<[string, unknown]>,
  errors: [] as Array<[string, unknown]>,
}));
vi.mock('electron-log/main', () => ({
  default: {
    info: (message: string, data: Record<string, unknown>) => {
      h.infos.push([message, data]);
    },
    warn: (message: string, data: unknown) => {
      h.warns.push([message, data]);
    },
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
  h.warns.length = 0;
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

/** Till A (its device named `displayName`): the users, the menu, and a shift opened by the cashier on the float. */
async function till(displayName?: string): Promise<{ db: AppDatabase; menu: Menu; shiftId: string }> {
  const { openShift } = await shiftRepo();
  const db = openTill(TILL_A, displayName === undefined ? {} : { displayName });
  const menu = await menuOn(db, A.manager);
  const shiftId = openShift(db, { openingCashCents: FLOAT }, A.cashier).id;
  return { db, menu, shiftId };
}

/** A counter takeaway with `qty` burgers, sent to the kitchen and ready, not paid. */
async function readyTakeaway(db: AppDatabase, menu: Menu, qty = 1, actor = A.cashier): Promise<{ id: string; total: number }> {
  const r = await orderRepo();
  const o = r.createOrder(db, { mode: 'takeaway' }, actor);
  r.addOrderItem(db, { orderId: o.id, menuItemId: menu.burger, quantity: qty, modifierIds: [] }, actor);
  r.sendOrderToKitchen(db, o.id, actor);
  r.markOrderReady(db, o.id, actor);
  return { id: o.id, total: r.findOrder(db, o.id)!.totalCents };
}

/** A counter takeaway with one burger, paid up front (Pay now) by `method`. */
async function paidTakeaway(db: AppDatabase, menu: Menu, method: 'cash' | 'card', actor = A.cashier): Promise<{ id: string; total: number }> {
  const r = await orderRepo();
  const o = r.createOrder(db, { mode: 'takeaway' }, actor);
  r.addOrderItem(db, { orderId: o.id, menuItemId: menu.burger, quantity: 1, modifierIds: [] }, actor);
  const total = r.findOrder(db, o.id)!.totalCents;
  r.tenderOrder(db, { orderId: o.id, payments: [{ method, amountCents: total, tenderedCents: method === 'cash' ? total : null }] }, actor);
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

// ------------------------------------------- the report itself (step 19d-3)

const service = () => import('../services/shift-report-service.js');

const TILL_B = 'till-b';
const B = {
  cashier: { userId: TEST_USERS.cashier.userId, deviceId: TILL_B },
  manager: { userId: TEST_USERS.manager.userId, deviceId: TILL_B },
};
const OWNER = { userId: TEST_USERS.owner.userId, deviceId: TILL_A };
/** Every section of the paper on (the owner's default). */
const ALL_SECTIONS_ON = Object.fromEntries(SHIFT_REPORT_SECTIONS.map((s) => [s.key, true])) as Record<ShiftReportSection, boolean>;
/** Every shift there is: Shift history's period in these tests. */
const ALL_TIME = { sinceIso: '2000-01-01T00:00:00.000Z', untilIso: '2100-01-01T00:00:00.000Z' };

interface Reported {
  row: Row;
  json: string;
  report: ShiftReport;
}

/**
 * Closes the shift as 'shifts:close' does — this till's makeShiftReport
 * handed to closeShift — and reads back what was saved (the read side's
 * parseShiftReportJson).
 */
async function closeReported(
  db: AppDatabase,
  input: CloseShiftInput,
  opts: { actor?: { userId: string; deviceId: string }; approval?: CloseApproval | null; deviceId?: string } = {},
): Promise<Reported> {
  const repo = await shiftRepo();
  const { makeShiftReport } = await service();
  repo.closeShift(db, input, opts.actor ?? A.manager, opts.approval ?? null, { makeReport: makeShiftReport(db, opts.deviceId ?? TILL_A) });
  const row = storedShift(db, input.shiftId);
  const json = String(row['close_report_json']);
  const parsed = parseShiftReportJson(json);
  if (parsed === null || !('report' in parsed)) throw new Error(`No report was saved: ${json}`);
  return { row, json, report: parsed.report };
}

/** Closed counting exactly the expected cash; anything unpaid carried over with a reason. */
async function closeEvenReported(db: AppDatabase, shiftId: string, opts: Parameters<typeof closeReported>[2] = {}): Promise<Reported> {
  const { getShiftSummary } = await shiftRepo();
  const countedCashCents = getShiftSummary(db, shiftId).expectedCashCents;
  return closeReported(db, { shiftId, countedCashCents, carryOverReason: 'Test customer pays later' }, opts);
}

const numberOf = async (db: AppDatabase, orderId: string): Promise<string> => (await orderRepo()).findOrder(db, orderId)!.orderNumber;

/** The shift's line in Shift history (Reports → Team & leakage). */
async function historyLine(db: AppDatabase, shiftId: string) {
  const { buildTeamTab } = await import('../services/business-report.js');
  const line = buildTeamTab(db, ALL_TIME).shifts.find((s) => s.id === shiftId);
  if (!line) throw new Error('The shift is not in Shift history');
  return line;
}

const total = (xs: ReadonlyArray<{ cents: number }>) => xs.reduce((n, x) => n + x.cents, 0);

/**
 * What every saved report says of its shift, whatever happened in it: the
 * drawer is the close's own and adds up, with nothing unknown; Cash taken
 * out is the close result's and Shift history's 'Taken out'; the close
 * box's counts are the paper's; NET SALES is the money taken; ORDERS is the
 * set settled here, adding up to TOTAL (with tax); ITEMS SOLD adds up to
 * Food; the text is the one writer's and the audit keeps its SHA-256.
 */
async function expectWhole(db: AppDatabase, shiftId: string, { row, json, report }: Reported): Promise<void> {
  const repo = await shiftRepo();
  const s = repo.getShiftSummary(db, shiftId);
  const d = report.drawer;
  expect({ opening: d.openingCents, expected: d.expectedCents, counted: d.countedCents, variance: d.varianceCents }).toEqual({
    opening: row['opening_cash_cents'],
    expected: row['expected_cash_cents'],
    counted: row['counted_cash_cents'],
    variance: row['variance_cents'],
  });
  expect(d.otherCents).toBe(0);
  expect(shiftReportDrawerAddsUp(report)).toBe(true);
  expect({ sales: d.cashSalesCents, refunds: d.cashRefundsCents, in: d.cashIn.cents }).toEqual({
    sales: s.cashSalesCents,
    refunds: s.cashRefundsCents,
    in: s.cashInCents,
  });
  const history = await historyLine(db, shiftId);
  expect(d.cashOut.cents).toBe(s.cashOutCents - s.riderChargesCents);
  expect(history.riderChargesCents).toBeTypeOf('number');
  expect(d.cashOut.cents).toBe(history.cashOutCents - (history.riderChargesCents ?? 0));
  expect(d.riderKept).toEqual({ count: s.riderChargeCount, cents: s.riderChargesCents, tripCount: s.riderTripCount });
  expect(d.riderKept.cents).toBe(history.riderChargesCents);

  // (10) The close box's Paid orders and Refunds are the paper's.
  expect({ paid: report.sales.orderCount, refunded: report.sales.refunds.orderCount }).toEqual({
    paid: s.paidOrderCount,
    refunded: s.refundedOrderCount,
  });
  // NET SALES is the money taken, in every flow; no part payments.
  expect(report.sales.netCents).toBe(report.moneyTakenCents);
  expect(report.partPaymentsCents).toBe(0);
  expect(report.moneyTakenCents).toBe(s.netRevenueCents);
  expect(report.sales.refunds.cents).toBe(s.totalRefundsCents);
  expect(total(report.payments) - total(report.paymentRefunds)).toBe(report.moneyTakenCents);
  expect(total(report.refunds)).toBe(report.sales.refunds.cents);

  // ORDERS: the orders settled here (SETTLED_IN_SHIFT_SQL), each once, adding up to TOTAL (with tax).
  const settledIds = (db.prepare(repo.SETTLED_IN_SHIFT_SQL).all({ shiftId }) as Row[]).map((r) => String(r['id']));
  const settledNumbers = await Promise.all(settledIds.map((id) => numberOf(db, id)));
  expect(report.orders.map((o) => o.orderNumber).sort()).toEqual(settledNumbers.sort());
  expect(report.orders).toHaveLength(report.sales.orderCount);
  expect(report.orders.reduce((n, o) => n + o.totalCents, 0)).toBe(report.sales.billedCents);
  // BY CHANNEL adds up to it too; ITEMS SOLD to Food; TOTAL = Food + delivery − discounts + tax.
  expect(report.channels.reduce((n, c) => n + c.billedCents, 0)).toBe(report.sales.billedCents);
  expect(report.channels.reduce((n, c) => n + c.orderCount, 0)).toBe(report.sales.orderCount);
  expect(total(report.items)).toBe(report.sales.foodCents);
  expect(report.sales.foodCents + report.sales.delivery.cents - total(report.sales.discounts) + report.sales.taxCents).toBe(
    report.sales.billedCents,
  );

  // The one writer's text, its SHA-256 in the close's audit row.
  expect(json).toBe(shiftReportJson(report));
  expect(closeAudits(db, shiftId).at(-1)?.['closeReport']).toEqual({ v: 1, sha256: sha256(json) });
}

/** A counter takeaway with one burger, Pay now with the payments `pays` gives for its total. */
async function paidBy(db: AppDatabase, menu: Menu, pays: (total: number) => TenderInputItem[]): Promise<{ id: string; total: number }> {
  const r = await orderRepo();
  const o = r.createOrder(db, { mode: 'takeaway' }, A.cashier);
  r.addOrderItem(db, { orderId: o.id, menuItemId: menu.burger, quantity: 1, modifierIds: [] }, A.cashier);
  const t = r.findOrder(db, o.id)!.totalCents;
  r.tenderOrder(db, { orderId: o.id, payments: pays(t) }, A.cashier);
  return { id: o.id, total: t };
}

/** A counter delivery with a burger and the charge, paid at the counter in cash and ready: not sent out yet. */
async function prepaidDelivery(db: AppDatabase, menu: Menu): Promise<{ id: string; total: number }> {
  const r = await orderRepo();
  const c = await import('./repositories/customer-repo.js');
  const o = r.createOrder(db, { mode: 'delivery' }, A.cashier);
  // Paid at the counter: a delivery needs the customer's name, phone and address to take money.
  const customer = c.createCustomer(db, { name: 'Test Prepaid Customer', phone: '03005550101' }, A.cashier);
  const address = c.createAddress(db, { customerId: customer.id, addressLine: 'House 7, Test Street', area: 'Test Block' }, A.cashier);
  c.snapshotCustomerOntoOrder(db, { orderId: o.id, customerId: customer.id, addressId: address.id }, A.cashier);
  r.addOrderItem(db, { orderId: o.id, menuItemId: menu.burger, quantity: 1, modifierIds: [] }, A.cashier);
  r.addOrderItem(db, { orderId: o.id, menuItemId: menu.charge, quantity: 1, modifierIds: [] }, A.cashier);
  const t = r.findOrder(db, o.id)!.totalCents;
  r.tenderOrder(db, { orderId: o.id, payments: [{ method: 'cash', amountCents: t, tenderedCents: t }] }, A.cashier);
  r.markOrderReady(db, o.id, A.cashier);
  return { id: o.id, total: t };
}

/**
 * The burger's recipe (one made-up bun), so its stock leaves at the kitchen
 * and a cancel settles it: what the cancel's "Was the food made?" answer is
 * read from.
 */
async function burgerRecipe(db: AppDatabase, menu: Menu): Promise<void> {
  const { createIngredient, setRecipeForItem } = await import('./repositories/ingredient-repo.js');
  const bun = createIngredient(db, { name: 'Test Bun', unit: 'pcs', currentQty: 100, costPerUnitCents: 0 }, A.manager).id;
  setRecipeForItem(db, menu.burger, [{ ingredientId: bun, qtyPerUnit: 1, modifierId: null }], A.manager);
}

/** A test order deleted by the owner (Order History → Delete test order), as it stands. */
async function deleteAsTest(db: AppDatabase, orderId: string): Promise<void> {
  const r = await orderRepo();
  const expectStatus = r.findOrder(db, orderId)!.status;
  r.deleteTestOrder(db, { orderId, reason: 'Test printer test', restock: null, expectStatus, ownerUserId: OWNER.userId }, OWNER);
}

type Shop = Awaited<ReturnType<typeof till>>;
/** The burger at Rs 1,000 + 15%. */
const BURGER_TOTAL = 115_000;
/** The burger and the Rs 200 charge, each + 15%. */
const DELIVERY_TOTAL = 138_000;

/** Each scenario: what happens in the shift, and what the paper must say of it beyond expectWhole's rules. */
const SCENARIOS: ReadonlyArray<readonly [string, (s: Shop) => Promise<void>, (r: ShiftReport) => void]> = [
  [
    'a cash sale',
    async ({ db, menu }) => void (await paidTakeaway(db, menu, 'cash')),
    (r) => {
      expect(r.payments).toEqual([{ method: 'cash', orderCount: 1, cents: BURGER_TOTAL }]);
      expect(r.orders).toEqual([expect.objectContaining({ channel: 'takeaway', outside: false, methods: ['cash'], refunded: 'no' })]);
    },
  ],
  [
    'a card sale',
    async ({ db, menu }) => void (await paidTakeaway(db, menu, 'card')),
    (r) => {
      expect(r.payments).toEqual([{ method: 'card', orderCount: 1, cents: BURGER_TOTAL }]);
      expect(r.drawer.cashSalesCents).toBe(0);
    },
  ],
  [
    'an EasyPaisa sale',
    async ({ db, menu }) => void (await paidBy(db, menu, (t) => [{ method: 'easypaisa', amountCents: t, referenceNo: 'TEST-EP-0001' }])),
    (r) => {
      expect(r.payments).toEqual([{ method: 'easypaisa', orderCount: 1, cents: BURGER_TOTAL }]);
      expect(r.orders[0]?.methods).toEqual(['easypaisa']);
    },
  ],
  [
    'a full cash refund',
    async ({ db, menu }) => {
      const r = await orderRepo();
      const o = await paidTakeaway(db, menu, 'cash');
      r.refundOrder(db, { orderId: o.id, reason: 'Test wrong order', approverUserId: A.manager.userId, foodMade: 'not_made' }, A.manager);
    },
    (r) => {
      expect(r.sales).toMatchObject({ orderCount: 1, billedCents: BURGER_TOTAL, refunds: { orderCount: 1, cents: BURGER_TOTAL }, netCents: 0 });
      expect(r.refunds).toEqual([expect.objectContaining({ method: 'cash', cents: BURGER_TOTAL, full: true, reason: 'Test wrong order' })]);
      expect(r.paymentRefunds).toEqual([{ method: 'cash', orderCount: 1, cents: BURGER_TOTAL }]);
      expect(r.orders).toEqual([expect.objectContaining({ refunded: 'full', totalCents: BURGER_TOTAL })]);
      expect(r.drawer.cashRefundsCents).toBe(BURGER_TOTAL);
    },
  ],
  [
    'a part card refund',
    async ({ db, menu }) => {
      const r = await orderRepo();
      const o = await paidTakeaway(db, menu, 'card');
      r.refundOrder(db, { orderId: o.id, reason: 'Test cold fries', approverUserId: A.manager.userId, amountCents: 10_000 }, A.manager);
    },
    (r) => {
      expect(r.refunds).toEqual([expect.objectContaining({ method: 'card', cents: 10_000, full: false, reason: 'Test cold fries' })]);
      expect(r.orders).toEqual([expect.objectContaining({ refunded: 'part', methods: ['card'] })]);
      expect(r.drawer.cashRefundsCents).toBe(0);
    },
  ],
  [
    'cash put in',
    async ({ db }) =>
      void (await shiftRepo()).recordCashMovement(db, { type: 'payin', amountCents: 100_000, reason: 'Test change from the bank' }, A.manager),
    (r) => expect(r.drawer.cashIn).toEqual({ count: 1, cents: 100_000 }),
  ],
  [
    'a payout typed by hand',
    async ({ db }) => void (await shiftRepo()).recordCashMovement(db, { type: 'payout', amountCents: 30_000, reason: 'Test gas cylinder' }, A.manager),
    (r) => expect(r.drawer).toMatchObject({ cashOut: { count: 1, cents: 30_000 }, riderTips: { count: 0, cents: 0 } }),
  ],
  [
    'a rider tip',
    async ({ db }) => void (await shiftRepo()).recordCashMovement(db, { type: 'tip_out', amountCents: 5_000, reason: 'Test rider tip' }, A.manager),
    (r) => expect(r.drawer).toMatchObject({ cashOut: { count: 1, cents: 5_000 }, riderTips: { count: 1, cents: 5_000 } }),
  ],
  [
    'an outside rider who paid cash while out',
    async ({ db, menu }) => {
      const o = await sentOut(db, menu);
      (await orderRepo()).takeRiderPayment(db, { orderId: o.id, method: 'cash', riderKeepsCents: KEEP }, A.cashier);
    },
    (r) => {
      expect(r.drawer.riderKept).toEqual({ count: 1, cents: KEEP, tripCount: 0 });
      expect(r.channels).toEqual([
        { channel: 'delivery', orderCount: 1, billedCents: DELIVERY_TOTAL, outside: { orderCount: 1, billedCents: DELIVERY_TOTAL } },
      ]);
      expect(r.sales).toMatchObject({ foodCents: 100_000, delivery: { orderCount: 1, cents: KEEP } });
      expect(r.orders).toEqual([expect.objectContaining({ channel: 'delivery', outside: true, methods: ['cash'] })]);
    },
  ],
  [
    'an outside rider who paid by EasyPaisa (his charge in cash)',
    async ({ db, menu }) => {
      const o = await sentOut(db, menu);
      (await orderRepo()).takeRiderPayment(
        db,
        { orderId: o.id, method: 'easypaisa', referenceNo: 'TEST-EP-0002', riderKeepsCents: KEEP },
        A.cashier,
      );
    },
    (r) => {
      expect(r.payments).toEqual([
        { method: 'cash', orderCount: 1, cents: KEEP },
        { method: 'easypaisa', orderCount: 1, cents: DELIVERY_TOTAL - KEEP },
      ]);
      expect(r.orders).toEqual([expect.objectContaining({ outside: true, methods: ['easypaisa', 'cash'] })]);
      expect(r.drawer.riderKept).toEqual({ count: 1, cents: KEEP, tripCount: 0 });
    },
  ],
  [
    'a prepaid order sent out (the drawer pays him at Send out)',
    async ({ db, menu }) => {
      const o = await prepaidDelivery(db, menu);
      (await orderRepo()).sendOutOrder(db, o.id, A.cashier);
    },
    (r) => {
      expect(r.drawer.riderKept).toEqual({ count: 1, cents: KEEP, tripCount: 0 });
      expect(r.orders).toEqual([expect.objectContaining({ channel: 'delivery', outside: true, methods: ['cash'] })]);
    },
  ],
  [
    'a wasted trip paid (sent out, then cancelled at the door)',
    async ({ db, menu }) => {
      const o = await sentOut(db, menu);
      (await orderRepo()).voidOrder(
        db,
        { orderId: o.id, reason: 'Test refused at the door', approverUserId: A.manager.userId, payRiderForTrip: true },
        A.manager,
      );
    },
    (r) => {
      expect(r.drawer.riderKept).toEqual({ count: 1, cents: KEEP, tripCount: 1 });
      expect(r.sales.orderCount).toBe(0);
      expect(r.cancelled).toEqual([expect.objectContaining({ cents: DELIVERY_TOTAL, reason: 'Test refused at the door' })]);
    },
  ],
  [
    'a split cash + card sale',
    async ({ db, menu }) =>
      void (await paidBy(db, menu, (t) => [
        { method: 'cash', amountCents: 50_000, tenderedCents: 50_000 },
        { method: 'card', amountCents: t - 50_000 },
      ])),
    (r) => {
      expect(r.payments).toEqual([
        { method: 'cash', orderCount: 1, cents: 50_000 },
        { method: 'card', orderCount: 1, cents: BURGER_TOTAL - 50_000 },
      ]);
      // Biggest first, as the receipt shows them.
      expect(r.orders).toEqual([expect.objectContaining({ methods: ['card', 'cash'] })]);
    },
  ],
];

live('the shift report made at the close (shift-report-service, step 19d-3)', () => {
  it('(1) a close saves every section, the header as at the close, and the drawer exactly as the shift row has it', async () => {
    const { db, menu, shiftId } = await till('TEST-TILL-1 (win32)');
    await burgerRecipe(db, menu);
    const { setReceiptBranding } = await import('../services/printer-config.js');
    setReceiptBranding(db, { storeName: 'Test Cheese Shop' }, A.manager.userId);
    const r = await orderRepo();
    const repo = await shiftRepo();
    const cash = await paidTakeaway(db, menu, 'cash');
    const card = await paidTakeaway(db, menu, 'card');
    r.refundOrder(db, { orderId: card.id, reason: 'Test cold burger', approverUserId: A.manager.userId, amountCents: 20_000 }, A.manager);
    const cancelled = await readyTakeaway(db, menu);
    r.voidOrder(db, { orderId: cancelled.id, reason: 'Test customer left', approverUserId: A.manager.userId, foodMade: 'made' }, A.manager);
    repo.recordCashMovement(db, { type: 'payin', amountCents: 100_000, reason: 'Test change from the bank' }, A.manager);
    const unpaid = await readyTakeaway(db, menu, 2);
    const shiftBefore = repo.findShift(db, shiftId)!;

    // Closed by the manager's PIN on the cashier's login, counted by note.
    const reported = await closeReported(
      db,
      {
        shiftId,
        countedCashCents: COUNT_CENTS,
        countedNotes: COUNT,
        carryOverReason: 'Test pays tomorrow',
        carryOverOrderIds: [unpaid.id],
      },
      { approval: { via: 'manager_pin', tillSignedInUserId: A.cashier.userId } },
    );
    const { report, row } = reported;
    await expectWhole(db, shiftId, reported);

    // Every section is there, in the paper's order, whatever the print settings will say.
    expect(Object.keys(report)).toEqual([
      'v',
      'shiftId',
      'deviceId',
      'tillName',
      'shopName',
      'openedAt',
      'closedAt',
      'openedBy',
      'closedBy',
      'pinOnLoginOf',
      'sales',
      'payments',
      'paymentRefunds',
      'moneyTakenCents',
      'partPaymentsCents',
      'channels',
      'cancelled',
      'refunds',
      'drawer',
      'unpaid',
      'items',
      'orders',
    ]);
    // The header: this till's name less ' (win32)', the shop's name, who opened, who closed, and whose login the PIN was on.
    expect(report).toMatchObject({
      v: 1,
      shiftId,
      deviceId: TILL_A,
      tillName: 'TEST-TILL-1',
      shopName: 'Test Cheese Shop',
      openedAt: shiftBefore.openedAt,
      closedAt: row['closed_at'],
      openedBy: 'Test Cashier',
      closedBy: 'Test Manager',
      pinOnLoginOf: 'Test Cashier',
    });
    // SALES and MONEY TAKEN.
    expect(report.sales).toEqual({
      orderCount: 2,
      foodCents: 200_000,
      delivery: { orderCount: 0, cents: 0 },
      discounts: [],
      taxCents: 30_000,
      taxRateBps: 1_500,
      billedCents: 2 * BURGER_TOTAL,
      refunds: { orderCount: 1, cents: 20_000 },
      netCents: 2 * BURGER_TOTAL - 20_000,
      averageCents: BURGER_TOTAL,
    });
    expect(report.payments).toEqual([
      { method: 'cash', orderCount: 1, cents: cash.total },
      { method: 'card', orderCount: 1, cents: card.total },
    ]);
    expect(report.paymentRefunds).toEqual([{ method: 'card', orderCount: 1, cents: 20_000 }]);
    expect(report.channels).toEqual([{ channel: 'takeaway', orderCount: 2, billedCents: 2 * BURGER_TOTAL, outside: null }]);
    // CANCELLED AND REFUNDED: this till's cancel with the kitchen's answer; the refund with its reason.
    expect(report.cancelled).toEqual([
      {
        orderNumber: await numberOf(db, cancelled.id),
        at: r.findOrder(db, cancelled.id)!.voidedAt,
        cents: BURGER_TOTAL,
        made: 'made',
        reason: 'Test customer left',
      },
    ]);
    expect(report.refunds).toEqual([
      { orderNumber: await numberOf(db, card.id), at: expect.any(String), method: 'card', cents: 20_000, full: false, reason: 'Test cold burger' },
    ]);
    // CASH DRAWER and CASH COUNTED: the close's own, the note count as 0050 stored it.
    expect(report.drawer).toMatchObject({ openingCents: FLOAT, cashSalesCents: cash.total, cashIn: { count: 1, cents: 100_000 } });
    expect(report.drawer.countedNotes).toEqual(COUNT);
    expect(report.drawer.countedNotes).toEqual(parseCashCountJson(String(row['counted_notes_json'])));
    // UNPAID - CARRIED OVER: the close's list and its reason.
    expect(report.unpaid).toEqual({
      orders: [
        { orderNumber: await numberOf(db, unpaid.id), at: r.findOrder(db, unpaid.id)!.createdAt, takenBy: 'Test Cashier', cents: unpaid.total },
      ],
      reason: 'Test pays tomorrow',
    });
    // ITEMS SOLD and ORDERS.
    expect(report.items).toEqual([
      { category: 'Test Burgers', quantity: 2, cents: 200_000, items: [{ name: 'Test Zinger Burger', quantity: 2, cents: 200_000 }] },
    ]);
    expect(report.orders).toEqual([
      expect.objectContaining({ orderNumber: await numberOf(db, cash.id), methods: ['cash'], refunded: 'no' }),
      expect.objectContaining({ orderNumber: await numberOf(db, card.id), methods: ['card'], refunded: 'part' }),
    ]);
    // No food cost, waste rupees, commission or profit anywhere in it.
    expect(reported.json).not.toMatch(/cost|waste|commission|profit|margin/i);
    expect(closedLogs()).toEqual([expect.objectContaining({ id: shiftId, reportMade: true })]);
    expect(h.errors).toEqual([]);
    expect(h.warns).toEqual([]);
  });

  for (const [name, happen, says] of SCENARIOS) {
    it(`(2) ${name}: the drawer adds up to the stored expected cash with nothing unknown; the close box counts the same orders`, async () => {
      const shop = await till();
      await happen(shop);
      const reported = await closeEvenReported(shop.db, shop.shiftId);
      await expectWhole(shop.db, shop.shiftId, reported);
      says(reported.report);
    });
  }

  it('(2) all of them in one shift: the same rules hold', async () => {
    const shop = await till();
    for (const [, happen] of SCENARIOS) await happen(shop);
    const reported = await closeEvenReported(shop.db, shop.shiftId);
    await expectWhole(shop.db, shop.shiftId, reported);
    const { report } = reported;
    expect(report.drawer).toMatchObject({
      cashIn: { count: 1, cents: 100_000 },
      cashOut: { count: 2, cents: 35_000 },
      riderTips: { count: 1, cents: 5_000 },
      riderKept: { count: 4, cents: 4 * KEEP, tripCount: 1 },
      otherCents: 0,
    });
    expect(report.sales.refunds).toEqual({ orderCount: 2, cents: BURGER_TOTAL + 10_000 });
    expect(report.cancelled).toHaveLength(1);
  });

  it('(3) an order started in one shift, carried over unpaid and paid in the next is on the next one’s paper, and on the first one’s unpaid list', async () => {
    const { db, menu, shiftId: first } = await till();
    const r = await orderRepo();
    const repo = await shiftRepo();
    const carried = await readyTakeaway(db, menu, 2);
    const paidHere = await paidTakeaway(db, menu, 'cash');
    const a = await closeEvenReported(db, first);
    const second = repo.openShift(db, { openingCashCents: FLOAT }, A.manager).id;
    r.markOrderServed(db, { orderId: carried.id, payment: { method: 'cash', amountCents: carried.total, tenderedCents: carried.total } }, A.cashier);
    const b = await closeEvenReported(db, second);
    await expectWhole(db, first, a);
    await expectWhole(db, second, b);

    expect(a.report.unpaid.orders.map((o) => o.orderNumber)).toEqual([await numberOf(db, carried.id)]);
    expect(a.report.orders.map((o) => o.orderNumber)).toEqual([await numberOf(db, paidHere.id)]);
    expect(a.report.items).toEqual([expect.objectContaining({ quantity: 1, cents: 100_000 })]);
    expect(a.report.channels).toEqual([{ channel: 'takeaway', orderCount: 1, billedCents: paidHere.total, outside: null }]);

    expect(b.report.orders.map((o) => o.orderNumber)).toEqual([await numberOf(db, carried.id)]);
    expect(b.report.items).toEqual([
      { category: 'Test Burgers', quantity: 2, cents: 200_000, items: [{ name: 'Test Zinger Burger', quantity: 2, cents: 200_000 }] },
    ]);
    expect(b.report.channels).toEqual([{ channel: 'takeaway', orderCount: 1, billedCents: carried.total, outside: null }]);
    expect(b.report.payments).toEqual([{ method: 'cash', orderCount: 1, cents: carried.total }]);
    expect(b.report.unpaid).toEqual({ orders: [], reason: null });
  });

  it('(3) an order taken on till B and paid on till A is on A’s paper only; B’s own payment and B’s cancel are never on A’s', async () => {
    const repo = await shiftRepo();
    const r = await orderRepo();
    const a = openTill(TILL_A);
    const b = openTill(TILL_B, { usersFrom: TILL_A });
    const menu = await menuOn(a, A.manager);
    const shiftA = repo.openShift(a, { openingCashCents: FLOAT }, A.manager).id;
    expect(await push(a, TILL_A, b)).toMatchObject({ waiting: 0, dropped: 0 });
    const shiftB = repo.openShift(b, { openingCashCents: FLOAT }, B.manager).id;
    const taken = await readyTakeaway(b, menu, 1, B.cashier);
    const own = await paidTakeaway(b, menu, 'card', B.cashier);
    const cancelledOnB = await readyTakeaway(b, menu, 1, B.cashier);
    r.voidOrder(b, { orderId: cancelledOnB.id, reason: 'Test customer left', approverUserId: B.manager.userId, foodMade: 'not_made' }, B.manager);
    expect(await push(b, TILL_B, a)).toMatchObject({ waiting: 0, dropped: 0 });
    r.markOrderServed(a, { orderId: taken.id, payment: { method: 'cash', amountCents: taken.total, tenderedCents: taken.total } }, A.cashier);
    expect(await push(a, TILL_A, b)).toMatchObject({ waiting: 0, dropped: 0 });

    const onA = await closeEvenReported(a, shiftA);
    const onB = await closeEvenReported(b, shiftB, { actor: B.manager, deviceId: TILL_B });
    await expectWhole(a, shiftA, onA);
    await expectWhole(b, shiftB, onB);
    expect(onA.report.orders.map((o) => o.orderNumber)).toEqual([await numberOf(a, taken.id)]);
    expect(onA.report.payments).toEqual([{ method: 'cash', orderCount: 1, cents: taken.total }]);
    expect(onA.report).toMatchObject({ deviceId: TILL_A, tillName: TILL_A });
    expect(onB.report.orders.map((o) => o.orderNumber)).toEqual([await numberOf(b, own.id)]);
    expect(onB.report.payments).toEqual([{ method: 'card', orderCount: 1, cents: own.total }]);
    expect(onB.report).toMatchObject({ deviceId: TILL_B, tillName: TILL_B });
    // A cancel is on the paper of the till whose order it was, though both tills have it.
    expect(a.prepare(`SELECT status FROM orders WHERE id = ?`).get(cancelledOnB.id)).toEqual({ status: 'void' });
    expect(onA.report.cancelled).toEqual([]);
    expect(onB.report.cancelled.map((c) => c.orderNumber)).toEqual([await numberOf(b, cancelledOnB.id)]);
  });

  it('(3) a website delivery sent out with an outside rider is a Website delivery, outside; a website pick-up is a pick-up', async () => {
    const { db, menu, shiftId } = await till();
    const r = await orderRepo();
    const web = r.createOrder(db, { mode: 'delivery', source: 'web' }, A.cashier);
    r.addOrderItem(db, { orderId: web.id, menuItemId: menu.burger, quantity: 1, modifierIds: [] }, A.cashier);
    r.addOrderItem(db, { orderId: web.id, menuItemId: menu.charge, quantity: 1, modifierIds: [] }, A.cashier);
    r.sendOrderToKitchen(db, web.id, A.cashier);
    r.markOrderReady(db, web.id, A.cashier);
    expect(r.sendOutOrder(db, web.id, A.cashier).riderKeepsCents).toBe(KEEP);
    r.takeRiderPayment(db, { orderId: web.id, method: 'cash', riderKeepsCents: KEEP }, A.cashier);
    const pickUp = r.createOrder(db, { mode: 'takeaway', source: 'web' }, A.cashier);
    r.addOrderItem(db, { orderId: pickUp.id, menuItemId: menu.burger, quantity: 1, modifierIds: [] }, A.cashier);
    r.tenderOrder(db, { orderId: pickUp.id, payments: [{ method: 'card', amountCents: BURGER_TOTAL }] }, A.cashier);

    const reported = await closeEvenReported(db, shiftId);
    await expectWhole(db, shiftId, reported);
    expect(reported.report.channels).toEqual([
      { channel: 'web_pickup', orderCount: 1, billedCents: BURGER_TOTAL, outside: null },
      { channel: 'web_delivery', orderCount: 1, billedCents: DELIVERY_TOTAL, outside: { orderCount: 1, billedCents: DELIVERY_TOTAL } },
    ]);
    expect(reported.report.orders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ orderNumber: web.orderNumber, channel: 'web_delivery', outside: true }),
        expect.objectContaining({ orderNumber: pickUp.orderNumber, channel: 'web_pickup', outside: false }),
      ]),
    );
    expect(reported.report.sales.delivery).toEqual({ orderCount: 1, cents: KEEP });
  });

  it('(13) each refund row says what it did: two parts of one order both say part; one refund of the whole order does not, nor a part refund of all of it', async () => {
    const { db, menu, shiftId } = await till();
    const r = await orderRepo();
    const approverUserId = A.manager.userId;
    // Rs 500 back, then the rest (Rs 650) in the same shift: the order ends refunded in full.
    const twoParts = await paidTakeaway(db, menu, 'card');
    r.refundOrder(db, { orderId: twoParts.id, reason: 'Test one part', approverUserId, amountCents: 50_000 }, A.manager);
    r.refundOrder(db, { orderId: twoParts.id, reason: 'Test rest of it', approverUserId, foodMade: 'not_made' }, A.manager);
    // All of it at once.
    const whole = await paidTakeaway(db, menu, 'cash');
    r.refundOrder(db, { orderId: whole.id, reason: 'Test wrong order', approverUserId, foodMade: 'not_made' }, A.manager);
    // 'Part of it' typed as the whole bill.
    const partOfAll = await paidTakeaway(db, menu, 'card');
    r.refundOrder(db, { orderId: partOfAll.id, reason: 'Test all of it', approverUserId, amountCents: partOfAll.total, foodMade: 'not_made' }, A.manager);
    // Paid Rs 500 cash + the rest by card, all of it back in one refund: a row per method, each less
    // than the bill, but together the whole order, so neither says part.
    const split = await paidBy(db, menu, (t) => [
      { method: 'cash', amountCents: 50_000, tenderedCents: 50_000 },
      { method: 'card', amountCents: t - 50_000 },
    ]);
    r.refundOrder(db, { orderId: split.id, reason: 'Test split back', approverUserId, foodMade: 'not_made' }, A.manager);

    const reported = await closeEvenReported(db, shiftId);
    await expectWhole(db, shiftId, reported);
    const { report } = reported;
    const rowsOf = async (orderId: string) => {
      const n = await numberOf(db, orderId);
      return report.refunds.filter((x) => x.orderNumber === n).map((x) => ({ method: x.method, cents: x.cents, full: x.full }));
    };
    expect(await rowsOf(twoParts.id)).toEqual([
      { method: 'card', cents: 50_000, full: false },
      { method: 'card', cents: BURGER_TOTAL - 50_000, full: false },
    ]);
    expect(await rowsOf(whole.id)).toEqual([{ method: 'cash', cents: BURGER_TOTAL, full: true }]);
    expect(await rowsOf(partOfAll.id)).toEqual([{ method: 'card', cents: BURGER_TOTAL, full: true }]);
    expect(await rowsOf(split.id)).toEqual([
      { method: 'cash', cents: 50_000, full: true },
      { method: 'card', cents: BURGER_TOTAL - 50_000, full: true },
    ]);
    // Every one of them ended refunded in full (ORDERS says so); the money is unchanged.
    expect(report.orders.map((o) => o.refunded)).toEqual(['full', 'full', 'full', 'full']);
    expect(report.sales.refunds).toEqual({ orderCount: 4, cents: 4 * BURGER_TOTAL });

    // On paper: ', part' on both rows of the order refunded in two parts.
    const paper = escPosToText(
      renderShiftReport(report, { width: 48, sections: ALL_SECTIONS_ON, items: 'items', printedAt: report.closedAt, printedByName: 'Test Manager' }),
    ).split('\n');
    const short = shortNumber(await numberOf(db, twoParts.id));
    expect(paper.filter((x) => x.startsWith(`  ${short} `))).toEqual([
      expect.stringMatching(new RegExp(`^  ${short} \\d\\d:\\d\\d card, part: Test one part +500\\.00$`)),
      expect.stringMatching(new RegExp(`^  ${short} \\d\\d:\\d\\d card, part: Test rest of it +650\\.00$`)),
    ]);
    // The split order refunded whole in one go: no ', part' on either method's row.
    const splitShort = shortNumber(await numberOf(db, split.id));
    const splitRows = paper.filter((x) => x.startsWith(`  ${splitShort} `));
    expect(splitRows).toHaveLength(2);
    expect(splitRows.every((x) => !x.includes(', part'))).toBe(true);
    expect(paper).toContain('Refunded (4)                            4,600.00');
  });

  it('(14) two orders with one number (one from each till) refunded on one till: Refunded (2), as SALES says Refunds (2)', async () => {
    const repo = await shiftRepo();
    const r = await orderRepo();
    const a = openTill(TILL_A);
    const b = openTill(TILL_B, { usersFrom: TILL_A });
    const menu = await menuOn(a, A.manager);
    repo.openShift(a, { openingCashCents: FLOAT }, A.manager);
    // Till A's first order of the day, paid in cash there; then till B's own first order: the same number.
    const fromA = await paidTakeaway(a, menu, 'cash');
    expect(await push(a, TILL_A, b)).toMatchObject({ waiting: 0, dropped: 0 });
    const shiftB = repo.openShift(b, { openingCashCents: FLOAT }, B.manager).id;
    const ownB = await paidTakeaway(b, menu, 'card', B.cashier);
    expect(await numberOf(b, ownB.id)).toBe(await numberOf(b, fromA.id));
    // Till B gives part refunds on both.
    r.refundOrder(b, { orderId: fromA.id, reason: 'Test cold', approverUserId: B.manager.userId, amountCents: 10_000 }, B.manager);
    r.refundOrder(b, { orderId: ownB.id, reason: 'Test late', approverUserId: B.manager.userId, amountCents: 20_000 }, B.manager);

    const onB = await closeEvenReported(b, shiftB, { actor: B.manager, deviceId: TILL_B });
    await expectWhole(b, shiftB, onB);
    expect(onB.report.sales.refunds).toEqual({ orderCount: 2, cents: 30_000 });
    expect(new Set(onB.report.refunds.map((x) => x.orderNumber)).size).toBe(1);
    for (const width of [48, 32] as const) {
      const paper = escPosToText(
        renderShiftReport(onB.report, { width, sections: ALL_SECTIONS_ON, items: 'items', printedAt: onB.report.closedAt, printedByName: 'Test Manager' }),
      ).split('\n');
      expect(paper.find((x) => x.startsWith('Refunds ('))?.replace(/ +/g, ' ')).toBe('Refunds (2) -300.00');
      expect(paper.find((x) => x.startsWith('Refunded ('))?.replace(/ +/g, ' ')).toBe('Refunded (2) 300.00');
    }
  });

  it('(3) discounts by kind: a staff discount, the website’s, an automatic offer; an offer taken off (Rs 0) does not count', async () => {
    const { db, menu, shiftId } = await till();
    const r = await orderRepo();
    const pay = (orderId: string) => {
      const t = r.findOrder(db, orderId)!.totalCents;
      r.tenderOrder(db, { orderId, payments: [{ method: 'card', amountCents: t }] }, A.cashier);
    };
    const ring = (source: 'pos' | 'web') => {
      const o = r.createOrder(db, { mode: 'takeaway', source }, A.cashier);
      r.addOrderItem(db, { orderId: o.id, menuItemId: menu.burger, quantity: 1, modifierIds: [] }, A.cashier);
      return o.id;
    };
    const staff = ring('pos');
    r.applyDiscount(db, { orderId: staff, discountType: 'percent', value: 10, reason: 'Test regular', approverUserId: A.manager.userId }, A.manager);
    pay(staff);
    const website = ring('web');
    r.applyDiscount(db, { orderId: website, discountType: 'percent', value: 10, reason: 'Test pick-up' }, A.manager);
    pay(website);
    // The owner's automatic offer: on one order, taken off another (its row stays, at Rs 0).
    const { setBusinessSetting } = await import('./repositories/business-settings-repo.js');
    const offer: ChannelOffer = {
      id: 'test-offer',
      name: 'Test 5% off',
      on: true,
      cameBy: 'any',
      orderTypes: ['takeaway'],
      type: 'percent',
      value: 5,
      minOrderCents: null,
      maxOffCents: null,
      days: [0, 1, 2, 3, 4, 5, 6],
      hours: null,
      startsOn: null,
      endsOn: null,
      oncePerCustomerPerDay: false,
    };
    setBusinessSetting(db, 'discounts.offers', { v: 1, askCameBy: false, offers: [offer] }, OWNER);
    const kept = ring('pos');
    expect(r.findOrder(db, kept)!.discountCents).toBe(5_000);
    pay(kept);
    const declined = ring('pos');
    r.clearDiscount(db, declined, A.cashier);
    expect(r.findOrder(db, declined)!.discountCents).toBe(0);
    expect(db.prepare(`SELECT source, amount_cents FROM order_discounts WHERE order_id = ? AND deleted_at IS NULL`).all(declined)).toEqual([
      { source: 'offer', amount_cents: 0 },
    ]);
    pay(declined);

    const reported = await closeEvenReported(db, shiftId);
    await expectWhole(db, shiftId, reported);
    expect(reported.report.sales.orderCount).toBe(4);
    expect(reported.report.sales.discounts).toEqual([
      { kind: 'staff', orderCount: 1, cents: 10_000 },
      { kind: 'website', orderCount: 1, cents: 10_000 },
      { kind: 'offer', orderCount: 1, cents: 5_000 },
    ]);
  });

  it('(4) frozen: a later refund, test orders deleted after the close, paying a carried order and renaming the item and its category change nothing', async () => {
    const { db, menu, shiftId } = await till();
    const r = await orderRepo();
    const repo = await shiftRepo();
    const { testDeletedSinceClose } = await service();
    const refundedLater = await paidTakeaway(db, menu, 'cash');
    const test = await paidTakeaway(db, menu, 'cash');
    const testOut = await sentOut(db, menu);
    r.takeRiderPayment(db, { orderId: testOut.id, method: 'cash', riderKeepsCents: KEEP }, A.cashier);
    const carried = await readyTakeaway(db, menu);
    const { json } = await closeEvenReported(db, shiftId);
    expect(testDeletedSinceClose(db, shiftId)).toBe(0);

    const next = repo.openShift(db, { openingCashCents: FLOAT }, A.manager).id;
    r.refundOrder(db, { orderId: refundedLater.id, reason: 'Test came back', approverUserId: A.manager.userId, foodMade: 'not_made' }, A.manager);
    await deleteAsTest(db, test.id);
    await deleteAsTest(db, testOut.id);
    r.markOrderServed(db, { orderId: carried.id, payment: { method: 'card', amountCents: carried.total, tenderedCents: null } }, A.cashier);
    const { updateMenuItem } = await import('./repositories/menu-item-repo.js');
    const { updateCategory } = await import('./repositories/category-repo.js');
    const categoryId = String((db.prepare(`SELECT category_id FROM menu_items WHERE id = ?`).get(menu.burger) as Row)['category_id']);
    updateMenuItem(db, { id: menu.burger, name: 'Test Renamed Burger' }, A.manager);
    updateCategory(db, { id: categoryId, name: 'Test Renamed Category' }, A.manager);

    expect(storedShift(db, shiftId)['close_report_json']).toBe(json);
    expect(repo.getShiftCloseReport(db, shiftId)?.json).toBe(json);
    expect(json).toContain('Test Zinger Burger');
    expect(json).not.toContain('Renamed');
    // The reprint's note: the deleted test orders' cash, less what the drawer paid their outside rider — Shift history's figure.
    expect(testDeletedSinceClose(db, shiftId)).toBe(test.total + testOut.total - KEEP);
    expect(testDeletedSinceClose(db, shiftId)).toBe((await historyLine(db, shiftId)).testDeletedCashCents);
    expect(testDeletedSinceClose(db, next)).toBe(0);
    expect(testDeletedSinceClose(db, 's_unknown')).toBe(0);
  });

  /**
   * A shift with a real card sale and four test orders — a cash sale, an
   * outside rider's, a cancel and a part refund — the tests deleted before
   * the close when `deleteThem`.
   */
  async function withTests(deleteThem: boolean): Promise<{ real: string; report: ShiftReport }> {
    const shop = await till();
    const { db, menu } = shop;
    const r = await orderRepo();
    const real = await paidTakeaway(db, menu, 'card');
    const cash = await paidTakeaway(db, menu, 'cash');
    const out = await sentOut(db, menu);
    r.takeRiderPayment(db, { orderId: out.id, method: 'cash', riderKeepsCents: KEEP }, A.cashier);
    const cancel = await readyTakeaway(db, menu);
    r.voidOrder(db, { orderId: cancel.id, reason: 'Test customer left', approverUserId: A.manager.userId, foodMade: 'not_made' }, A.manager);
    const part = await paidTakeaway(db, menu, 'cash');
    r.refundOrder(db, { orderId: part.id, reason: 'Test cold', approverUserId: A.manager.userId, amountCents: 10_000 }, A.manager);
    if (deleteThem) for (const id of [cash.id, out.id, cancel.id, part.id]) await deleteAsTest(db, id);
    const reported = await closeEvenReported(db, shop.shiftId);
    await expectWhole(db, shop.shiftId, reported);
    return { real: await numberOf(db, real.id), report: reported.report };
  }

  it('(5) test orders deleted before the close are left out everywhere: sales, money, items, orders, cancels, refunds and the drawer', async () => {
    const { real, report } = await withTests(true);
    expect(report.orders.map((o) => o.orderNumber)).toEqual([real]);
    expect(report.sales).toMatchObject({ orderCount: 1, billedCents: BURGER_TOTAL, refunds: { orderCount: 0, cents: 0 } });
    expect(report.payments).toEqual([{ method: 'card', orderCount: 1, cents: BURGER_TOTAL }]);
    expect(report.paymentRefunds).toEqual([]);
    expect(report.items).toEqual([expect.objectContaining({ quantity: 1, cents: 100_000 })]);
    expect(report.cancelled).toEqual([]);
    expect(report.refunds).toEqual([]);
    expect(report.channels).toEqual([{ channel: 'takeaway', orderCount: 1, billedCents: BURGER_TOTAL, outside: null }]);
    expect(report.drawer).toMatchObject({
      cashSalesCents: 0,
      cashRefundsCents: 0,
      riderKept: { count: 0, cents: 0, tripCount: 0 },
      expectedCents: FLOAT,
    });
  });

  it('(5) not deleted, the same test orders count', async () => {
    const { report } = await withTests(false);
    expect(report.orders).toHaveLength(4);
    expect(report.sales.refunds).toEqual({ orderCount: 1, cents: 10_000 });
    expect(report.cancelled).toHaveLength(1);
    expect(report.refunds).toHaveLength(1);
    expect(report.drawer.riderKept).toEqual({ count: 1, cents: KEEP, tripCount: 0 });
    expect(report.items).toEqual([expect.objectContaining({ quantity: 4, cents: 400_000 })]);
  });

  it('(9) another till’s shift: no report (the paper would carry this till’s name), the log says why, the shift closes', async () => {
    const repo = await shiftRepo();
    const { makeShiftReport } = await service();
    const a = openTill(TILL_A);
    const b = openTill(TILL_B, { usersFrom: TILL_A });
    const onB = repo.openShift(b, { openingCashCents: FLOAT }, B.manager).id;
    expect(await push(b, TILL_B, a)).toMatchObject({ waiting: 0, dropped: 0 });
    const closed = repo.closeShift(a, plainClose(onB, FLOAT), A.manager, null, { makeReport: makeShiftReport(a, TILL_A) });
    expect(closed.closedAt).not.toBeNull();
    expect(storedShift(a, onB)).toMatchObject({ close_report_json: null, expected_cash_cents: FLOAT });
    expect(closeAudits(a, onB)).toEqual([expect.objectContaining({ closeReport: null })]);
    expect(h.warns).toEqual([['Shift report not made: the shift is on another till', { shiftId: onB, shiftDeviceId: TILL_B, deviceId: TILL_A }]]);
    expect(h.errors).toEqual([]);
    expect(closedLogs()).toEqual([expect.objectContaining({ id: onB, reportMade: false })]);
  });

  it('(11) the close reads no food cost — no ingredient, recipe, price or cost table — and the cancel’s answer comes from its stock rows', async () => {
    const { db, menu, shiftId } = await till();
    const r = await orderRepo();
    const repo = await shiftRepo();
    const { makeShiftReport } = await service();
    await burgerRecipe(db, menu);
    await paidTakeaway(db, menu, 'cash');
    const part = await paidTakeaway(db, menu, 'card');
    r.refundOrder(db, { orderId: part.id, reason: 'Test cold', approverUserId: A.manager.userId, amountCents: 10_000 }, A.manager);
    const cancel = await readyTakeaway(db, menu);
    r.voidOrder(db, { orderId: cancel.id, reason: 'Test customer left', approverUserId: A.manager.userId, foodMade: 'made' }, A.manager);
    const wasted = await sentOut(db, menu);
    r.voidOrder(db, { orderId: wasted.id, reason: 'Test refused at the door', approverUserId: A.manager.userId, payRiderForTrip: true }, A.manager);
    const expected = repo.getShiftSummary(db, shiftId).expectedCashCents;

    const read: string[] = [];
    const watched = new Proxy(db, {
      get: (t, k) => (k === 'prepare' ? (sql: string) => (read.push(sql), t.prepare(sql)) : Reflect.get(t, k)),
    });
    repo.closeShift(watched, plainClose(shiftId, expected), A.manager, null, { makeReport: makeShiftReport(watched, TILL_A) });

    const parsed = parseShiftReportJson(String(storedShift(db, shiftId)['close_report_json']));
    expect(parsed).toMatchObject({ report: { cancelled: expect.arrayContaining([expect.objectContaining({ made: 'made' })]) } });
    expect(read.some((sql) => /FROM stock_movements/.test(sql))).toBe(true);
    // Rows read: none from a costing table, no price or cost column. (The PRAGMAs are the sync image's look at
    // the tables' columns, made again for this wrapped connection: no rows.)
    const pragmas = read.filter((sql) => /^\s*PRAGMA /i.test(sql));
    for (const sql of pragmas) expect(sql).toMatch(/^\s*PRAGMA (schema_version|table_info\("\w+"\)|foreign_key_list\("\w+"\))\s*$/);
    const rowsRead = read.filter((sql) => !pragmas.includes(sql));
    expect(rowsRead.length).toBeGreaterThan(10);
    for (const sql of rowsRead) expect(sql).not.toMatch(/ingredient|recipe|price|cost|value_cents|purchase|channel_terms|commission/i);
    expect(h.errors).toEqual([]);
  });

  it('(12) the maker reads by index — never a scan of orders, their lines, payments, stock rows or the audit trail', async () => {
    const { db, menu, shiftId } = await till();
    const r = await orderRepo();
    const repo = await shiftRepo();
    const { makeShiftReport } = await service();
    await burgerRecipe(db, menu);
    await paidTakeaway(db, menu, 'cash');
    const cancel = await readyTakeaway(db, menu);
    r.voidOrder(db, { orderId: cancel.id, reason: 'Test customer left', approverUserId: A.manager.userId, foodMade: 'made' }, A.manager);
    const read: string[] = [];
    const watched = new Proxy(db, {
      get: (t, k) => (k === 'prepare' ? (sql: string) => (read.push(sql), t.prepare(sql)) : Reflect.get(t, k)),
    });
    const maker = makeShiftReport(watched, TILL_A);
    repo.closeShift(db, plainClose(shiftId, repo.getShiftSummary(db, shiftId).expectedCashCents), A.manager, null, { makeReport: (c) => maker(c) });
    expect(storedShift(db, shiftId)['close_report_json']).not.toBeNull();
    expect(read.length).toBeGreaterThan(8);
    for (const sql of read) {
      // Any made-up value will do for a plan: a JSON list fits json_each and an id alike.
      const named = [...new Set([...sql.matchAll(/@(\w+)/g)].map((m) => m[1]!))];
      const params = named.length > 0 ? [Object.fromEntries(named.map((n) => [n, '["x"]']))] : Array((sql.match(/\?/g) ?? []).length).fill('["x"]');
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as [])) as Row[]).map((p) => String(p['detail']));
      for (const step of plan.filter((p) => /\bSCAN\b/.test(p))) expect(step).toMatch(/^SCAN (json_each VIRTUAL TABLE|categories USING INDEX)/);
    }
  });

  it('tillNameForPaper: the device name less the platform its first start added', async () => {
    const { tillNameForPaper } = await service();
    expect(tillNameForPaper('DESKTOP-7Q2M1KD (win32)')).toBe('DESKTOP-7Q2M1KD');
    expect(tillNameForPaper('Counter PC (linux)')).toBe('Counter PC');
    expect(tillNameForPaper('Front till')).toBe('Front till');
    expect(tillNameForPaper('Till (2)')).toBe('Till (2)');
    expect(tillNameForPaper(' (win32)')).toBe('');
  });
});

// -------------------------------- every print of it on record (step 19f-1)

/** Every section of the paper, in its order. */
const EVERY_SECTION = ['sales', 'moneyTaken', 'channels', 'cancelsRefunds', 'drawer', 'counted', 'unpaid', 'items', 'orders'] as const;

/** One try at printing `shiftId`'s report, as the printing code puts it on record: the manager's, at 80 mm, every section, unless said. */
const tryPrint = (
  shiftId: string,
  more: Partial<ShiftReportPrintInput> = {},
): ShiftReportPrintInput => ({
  shiftId,
  copy: 'original',
  reprintNo: 0,
  sections: EVERY_SECTION,
  items: 'items',
  width: 48,
  outcome: 'ok',
  errorCode: null,
  byUserId: A.manager.userId,
  approvedByUserId: null,
  ...more,
});

/** The 'shift_report_printed' audit rows of a shift, oldest first, their after-images read. */
function printAudits(db: AppDatabase, shiftId: string): Row[] {
  return (
    db
      .prepare(
        `SELECT entity_type, actor_user_id, before_json, after_json FROM audit_log
          WHERE entity_id = ? AND action = 'shift_report_printed' ORDER BY rowid`,
      )
      .all(shiftId) as Row[]
  ).map((r) => ({ ...r, after_json: JSON.parse(String(r['after_json'])) as Row }));
}

live('every try at printing the shift report goes on record (audit only, this till)', () => {
  it('one chained audit row per try — a failed one too — and nothing else: the shift untouched, nothing synced; the chain is whole', async () => {
    const { db, menu, shiftId } = await till();
    const repo = await shiftRepo();
    await paidTakeaway(db, menu, 'cash');
    await closeEvenReported(db, shiftId);
    const shiftBefore = storedShift(db, shiftId);
    const before = { sync: count(db, 'sync_queue'), audit: count(db, 'audit_log') };

    repo.recordShiftReportPrint(db, tryPrint(shiftId, { outcome: 'failed', errorCode: 'printer_offline' }));
    repo.recordShiftReportPrint(db, tryPrint(shiftId));
    repo.recordShiftReportPrint(
      db,
      tryPrint(shiftId, {
        copy: 'reprint',
        reprintNo: 1,
        sections: ['orders', 'sales', 'drawer', 'sales'],
        items: 'categories',
        width: 32,
        outcome: 'maybe',
        errorCode: 'timeout',
        byUserId: A.cashier.userId,
        approvedByUserId: A.manager.userId,
      }),
    );

    expect({ sync: count(db, 'sync_queue'), audit: count(db, 'audit_log') }).toEqual({ sync: before.sync, audit: before.audit + 3 });
    expect(storedShift(db, shiftId)).toEqual(shiftBefore);
    const at = { shiftId, items: 'items', width: 48, byUserId: A.manager.userId, approvedByUserId: null };
    expect(printAudits(db, shiftId)).toEqual([
      {
        entity_type: 'shifts',
        actor_user_id: A.manager.userId,
        before_json: null,
        after_json: { ...at, copy: 'original', reprintNo: 0, sections: [...EVERY_SECTION], outcome: 'failed', errorCode: 'printer_offline' },
      },
      {
        entity_type: 'shifts',
        actor_user_id: A.manager.userId,
        before_json: null,
        after_json: { ...at, copy: 'original', reprintNo: 0, sections: [...EVERY_SECTION], outcome: 'ok', errorCode: null },
      },
      {
        entity_type: 'shifts',
        actor_user_id: A.cashier.userId,
        before_json: null,
        // The sections in the paper's order, each once.
        after_json: {
          ...at,
          copy: 'reprint',
          reprintNo: 1,
          sections: ['sales', 'drawer', 'orders'],
          items: 'categories',
          width: 32,
          outcome: 'maybe',
          errorCode: 'timeout',
          byUserId: A.cashier.userId,
          approvedByUserId: A.manager.userId,
        },
      },
    ]);
    expect(verifyAuditChain(auditRows(db))).toMatchObject({ ok: true, brokenAt: null });
  });

  it('an ok try keeps no error code', async () => {
    const { db, shiftId } = await till();
    const repo = await shiftRepo();
    await closeEvenReported(db, shiftId);
    repo.recordShiftReportPrint(db, tryPrint(shiftId, { errorCode: 'left over' }));
    expect(printAudits(db, shiftId).map((r) => (r['after_json'] as Row)['errorCode'])).toEqual([null]);
  });

  it('shiftReportPrintHistory: the original tried and whether it came out; the highest reprint that came out or may have', async () => {
    const { db, shiftId } = await till();
    const repo = await shiftRepo();
    await closeEvenReported(db, shiftId);
    const history = () => repo.shiftReportPrintHistory(db, shiftId);
    expect(history()).toEqual({ originalTries: 0, originalPrinted: false, reprints: 0 });

    repo.recordShiftReportPrint(db, tryPrint(shiftId, { outcome: 'failed', errorCode: 'printer_offline' }));
    expect(history()).toEqual({ originalTries: 1, originalPrinted: false, reprints: 0 });
    repo.recordShiftReportPrint(db, tryPrint(shiftId, { outcome: 'maybe', errorCode: 'timeout' }));
    expect(history()).toEqual({ originalTries: 2, originalPrinted: true, reprints: 0 });
    repo.recordShiftReportPrint(db, tryPrint(shiftId));
    expect(history()).toEqual({ originalTries: 3, originalPrinted: true, reprints: 0 });

    // A reprint that surely did not print leaves its number to the next.
    repo.recordShiftReportPrint(db, tryPrint(shiftId, { copy: 'reprint', reprintNo: 1, outcome: 'failed', errorCode: 'printer_offline' }));
    expect(history().reprints).toBe(0);
    repo.recordShiftReportPrint(db, tryPrint(shiftId, { copy: 'reprint', reprintNo: 1 }));
    expect(history().reprints).toBe(1);
    repo.recordShiftReportPrint(db, tryPrint(shiftId, { copy: 'reprint', reprintNo: 2, outcome: 'maybe', errorCode: 'timeout' }));
    expect(history()).toEqual({ originalTries: 3, originalPrinted: true, reprints: 2 });
    // A DUPLICATE whose number could not be worked out (0) is on record, and uses no number.
    repo.recordShiftReportPrint(db, tryPrint(shiftId, { copy: 'reprint', reprintNo: 0 }));
    expect(history()).toEqual({ originalTries: 3, originalPrinted: true, reprints: 2 });
    expect(printAudits(db, shiftId).at(-1)?.['after_json']).toMatchObject({ copy: 'reprint', reprintNo: 0, outcome: 'ok' });

    // Another shift's prints, the close's own audit row and a row that is not a print's are not counted.
    const other = repo.openShift(db, { openingCashCents: FLOAT }, A.cashier).id;
    repo.recordShiftReportPrint(db, tryPrint(other, { copy: 'reprint', reprintNo: 7 }));
    const { writeAudit } = await import('./repositories/audit-repo.js');
    writeAudit(db, {
      entityType: 'shifts',
      entityId: shiftId,
      action: 'shift_report_printed',
      actorUserId: null,
      before: null,
      after: { copy: 'reprint', reprintNo: 'nine', outcome: 'ok' },
    });
    writeAudit(db, { entityType: 'shifts', entityId: shiftId, action: 'shift_report_printed', actorUserId: null, before: null, after: null });
    expect(history()).toEqual({ originalTries: 3, originalPrinted: true, reprints: 2 });
    expect(repo.shiftReportPrintHistory(db, other)).toEqual({ originalTries: 0, originalPrinted: false, reprints: 7 });
    expect(repo.shiftReportPrintHistory(db, 'no-such-shift')).toEqual({ originalTries: 0, originalPrinted: false, reprints: 0 });
    expect(verifyAuditChain(auditRows(db))).toMatchObject({ ok: true, brokenAt: null });
  });

  it('per till: till B never counts till A’s prints of the same shift (the audit trail is not synced)', async () => {
    const repo = await shiftRepo();
    const { a, shiftId } = await closedOnA();
    repo.recordShiftReportPrint(a, tryPrint(shiftId));
    repo.recordShiftReportPrint(a, tryPrint(shiftId, { copy: 'reprint', reprintNo: 1 }));
    const b = openTill(TILL_B, { usersFrom: TILL_A });
    await applyAll(b, await queued(a, TILL_A));
    expect(repo.findShift(b, shiftId)?.closedAt).not.toBeNull();
    expect(repo.shiftReportPrintHistory(b, shiftId)).toEqual({ originalTries: 0, originalPrinted: false, reprints: 0 });
    expect(repo.shiftReportPrintHistory(a, shiftId)).toEqual({ originalTries: 1, originalPrinted: true, reprints: 1 });
  });

  it('a try that cannot be is refused and writes nothing', async () => {
    const { db, shiftId } = await till();
    const repo = await shiftRepo();
    await closeEvenReported(db, shiftId);
    const audit = count(db, 'audit_log');
    for (const more of [
      { copy: 'original', reprintNo: 1 },
      { copy: 'reprint', reprintNo: -1 },
      { copy: 'reprint', reprintNo: 1.5 },
      { copy: 'copy' },
      { outcome: 'printed' },
      { sections: ['sales', 'tips'] },
      { items: 'none' },
      { width: 40 },
    ] as Array<Partial<ShiftReportPrintInput>>) {
      expect(() => repo.recordShiftReportPrint(db, tryPrint(shiftId, more))).toThrow(/^Shift report print: /);
    }
    expect(count(db, 'audit_log')).toBe(audit);
  });

  it('the history reads by the audit trail’s entity index, never a scan', async () => {
    const { db, shiftId } = await till();
    const repo = await shiftRepo();
    await closeEvenReported(db, shiftId);
    const read: string[] = [];
    const watched = new Proxy(db, {
      get: (t, k) => (k === 'prepare' ? (sql: string) => (read.push(sql), t.prepare(sql)) : Reflect.get(t, k)),
    });
    repo.shiftReportPrintHistory(watched, shiftId);
    expect(read).toHaveLength(1);
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${read[0]!}`).all(shiftId) as Row[]).map((p) => String(p['detail']));
    expect(plan.some((p) => /USING INDEX idx_audit_entity/.test(p))).toBe(true);
    expect(plan.filter((p) => /\bSCAN\b/.test(p))).toEqual([]);
  });
});

// ------------------------------------- Shift history's "Print shift report" (step 19g-2)

/** The shift history's lines as the Reports worker hands them over (copied, as from its thread). */
async function historyLinesViaWorker(db: AppDatabase): Promise<Map<string, ReportShiftLine>> {
  const worker = await import('../services/analytics/worker.js');
  const reply = worker.handleRunRequest(db, { type: 'run', id: 1, kind: 'team', request: ALL_TIME, nowIso: new Date().toISOString() });
  if (reply.type !== 'result' || !reply.ok) throw new Error(`worker said no: ${JSON.stringify(reply)}`);
  return new Map(structuredClone(reply.data as { shifts: ReportShiftLine[] }).shifts.map((s) => [s.id, s]));
}

live('Shift history says which shifts saved a shift report (hasCloseReport, step 19g-2)', () => {
  it('true for a close that saved one; false for a close that saved none and a shift still open; the same through the Reports worker; the report itself never leaves', async () => {
    const repo = await shiftRepo();
    const { db, shiftId: reported } = await till();
    await closeEvenReported(db, reported);
    // Closed with no report made (no maker: as a close before 0.7.35 left the column NULL).
    const none = repo.openShift(db, { openingCashCents: FLOAT }, A.cashier).id;
    repo.closeShift(db, plainClose(none, FLOAT), A.manager);
    expect(storedShift(db, none)).toMatchObject({ close_report_json: null });
    const open = repo.openShift(db, { openingCashCents: FLOAT }, A.cashier).id;

    expect(await historyLine(db, reported)).toMatchObject({ hasCloseReport: true });
    expect(await historyLine(db, none)).toMatchObject({ hasCloseReport: false });
    expect(await historyLine(db, open)).toMatchObject({ closedAt: null, hasCloseReport: false });
    const viaWorker = await historyLinesViaWorker(db);
    expect([reported, none, open].map((id) => viaWorker.get(id)?.hasCloseReport)).toEqual([true, false, false]);
    for (const line of viaWorker.values()) {
      expect(line).not.toHaveProperty('closeReportJson');
      expect(line).not.toHaveProperty('close_report_json');
      expect(JSON.stringify(line)).not.toContain('SHIFT REPORT');
    }
  });

  it('the other till: a shift closed on till A with its report shows it on till B; heard of only from an older till (no report), it does not', async () => {
    const { a, shiftId } = await closedOnA();
    const changes = await queued(a, TILL_A);
    const b = openTill('till-b', { usersFrom: TILL_A });
    await applyAll(b, changes);
    expect(await historyLine(b, shiftId)).toMatchObject({ hasCloseReport: true });
    const c = openTill('till-c', { usersFrom: TILL_A });
    await applyAll(c, changes.map(withoutReport));
    expect(await historyLine(c, shiftId)).toMatchObject({ hasCloseReport: false });
    expect((await historyLine(c, shiftId)).closedAt).not.toBeNull();
  });
});
