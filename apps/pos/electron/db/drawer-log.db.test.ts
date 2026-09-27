/**
 * The cash drawer log (owner, 27 Sep 2026: "I don't see the logs who drawers
 * used"; migration 0042) on a real database built from every migration,
 * foreign keys on, through the real repositories:
 *  - EXACTLY one drawer_opens row per event that opens the drawer, written in
 *    the SAME transaction as the cash: a cash sale (the cash part only), cash
 *    collected at the table or from the rider, a cash refund (negative; who
 *    pressed and the manager who allowed it), the float (Rs 0 too), cash in /
 *    out / a rider's tip, a purchase paid from the drawer — and none for card;
 *  - a failed tender writes no row;
 *  - each row with its sync and audit rows, the chain verifying;
 *  - Reports' "opened by hand" figures and no-sale counts unchanged by the new
 *    kinds; the owner's log paged and grouped.
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for Electron
 * here); skipped where it is missing. Every name and amount is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentMethod } from '@cheeseoclock/shared-types';
import { verifyAuditChain, type AuditChainRow } from './audit-chain.js';
import { CASHIER, DEV, DatabaseSync, MANAGER, OWNER, openCostingShop, openMigrated } from './costing-shop.fixture.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => '' } }));

const repos = async () => ({
  ...(await import('./repositories/order-repo.js')),
  ...(await import('./repositories/shift-repo.js')),
  ...(await import('./repositories/drawer-open-repo.js')),
  ...(await import('./repositories/procurement-repo.js')),
});

type Row = Record<string, unknown>;

async function till() {
  const db = openMigrated();
  const shop = await openCostingShop(db);
  const r = await repos();
  const opens = (): Row[] =>
    db
      .prepare(
        `SELECT kind, amount_cents AS amount, order_id AS orderId, cash_movement_id AS movementId, user_id AS userId,
                approved_by_user_id AS approver, reason, outcome, shift_id AS shiftId
           FROM drawer_opens ORDER BY created_at, rowid`,
      )
      .all() as Row[];
  const ring = () => shop.ring([['fajitaM', 1]]);
  const total = (o: string) => r.findOrder(db, o)!.totalCents;
  const auditRows = () =>
    db
      .prepare(
        `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action,
                actor_user_id AS actorUserId, before_json AS beforeJson, after_json AS afterJson,
                ip, created_at AS createdAt, prev_hash AS prevHash, row_hash AS rowHash
           FROM audit_log ORDER BY rowid`,
      )
      .all() as unknown as AuditChainRow[];
  return { db, shop, r, opens, ring, total, auditRows };
}
type Till = Awaited<ReturnType<typeof till>>;

let t: Till;
beforeEach(async () => {
  if (!DatabaseSync) return;
  t = await till();
});

describe.skipIf(!DatabaseSync)('one row per drawer opening, in the same transaction as the cash', () => {
  it('the float at shift open — Rs 0 too, because the drawer pops', () => {
    const s1 = t.r.openShift(t.db, { openingCashCents: 500_000 }, MANAGER);
    expect(s1.drawerOpenId).toBeTruthy();
    expect(t.opens()).toEqual([expect.objectContaining({ kind: 'float', amount: 500_000, userId: MANAGER.userId, shiftId: s1.id, outcome: null })]);
    t.r.closeShift(t.db, { shiftId: s1.id, countedCashCents: 500_000 }, MANAGER);
    const s2 = t.r.openShift(t.db, { openingCashCents: 0 }, MANAGER);
    expect(t.opens().at(-1)).toMatchObject({ kind: 'float', amount: 0, shiftId: s2.id });
  });

  it('a cash sale: the cash part only (split cash + card); card alone: no row', () => {
    t.r.openShift(t.db, { openingCashCents: 0 }, MANAGER);
    const before = t.opens().length;
    const tender = (o: string, payments: Array<{ method: PaymentMethod; amountCents: number }>) =>
      t.r.tenderOrder(t.db, { orderId: o, payments: payments.map((p) => ({ ...p, tenderedCents: p.method === 'cash' ? p.amountCents : null })) }, CASHIER);

    const cash = t.ring();
    expect(tender(cash, [{ method: 'cash', amountCents: t.total(cash) }]).drawerOpenId).toBeTruthy();
    const split = t.ring();
    const splitDone = tender(split, [
      { method: 'cash', amountCents: 50_000 },
      { method: 'card', amountCents: t.total(split) - 50_000 },
    ]);
    const card = t.ring();
    expect(tender(card, [{ method: 'card', amountCents: t.total(card) }]).drawerOpenId).toBeNull();

    const sales = t.opens().slice(before);
    expect(sales).toEqual([
      expect.objectContaining({ kind: 'sale', amount: 120_000, orderId: cash, userId: CASHIER.userId, approver: null }),
      expect.objectContaining({ kind: 'sale', amount: 50_000, orderId: split }),
    ]);
    expect(splitDone.drawerOpenId).toBeTruthy();
  });

  it('a failed tender writes no row (it all rolls back)', () => {
    t.r.openShift(t.db, { openingCashCents: 0 }, MANAGER);
    const before = t.opens().length;
    const o = t.ring();
    // Short of the total: refused.
    expect(() => t.r.tenderOrder(t.db, { orderId: o, payments: [{ method: 'cash', amountCents: 1_000, tenderedCents: 1_000 }] }, CASHIER)).toThrow();
    expect(t.opens()).toHaveLength(before);
  });

  it('cash collected at the table and from the rider: a cash sale each; collected by card: none', () => {
    t.r.openShift(t.db, { openingCashCents: 0 }, MANAGER);
    const before = t.opens().length;
    const table = t.ring();
    t.r.sendOrderToKitchen(t.db, table, CASHIER);
    t.r.markOrderPreparing(t.db, table, CASHIER);
    t.r.markOrderReady(t.db, table, CASHIER);
    const served = t.r.markOrderServed(t.db, { orderId: table, payment: { method: 'cash', amountCents: t.total(table), tenderedCents: 200_000 } }, CASHIER);
    expect(served.drawerOpenId).toBeTruthy();

    const byCard = t.ring();
    t.r.sendOrderToKitchen(t.db, byCard, CASHIER);
    t.r.markOrderPreparing(t.db, byCard, CASHIER);
    t.r.markOrderReady(t.db, byCard, CASHIER);
    expect(t.r.markOrderServed(t.db, { orderId: byCard, payment: { method: 'card', amountCents: t.total(byCard), tenderedCents: null } }, CASHIER).drawerOpenId).toBeNull();

    expect(t.opens().slice(before)).toEqual([expect.objectContaining({ kind: 'sale', amount: 120_000, orderId: table })]);
  });

  it('a cash refund: negative, who pressed Refund and the manager who allowed it; a card refund: no row', () => {
    t.r.openShift(t.db, { openingCashCents: 0 }, MANAGER);
    const o = t.ring();
    t.r.tenderOrder(t.db, { orderId: o, payments: [{ method: 'cash', amountCents: t.total(o), tenderedCents: t.total(o) }] }, CASHIER);
    const part = t.r.refundOrder(t.db, { orderId: o, reason: 'Test refund', approverUserId: MANAGER.userId, amountCents: 20_000 }, CASHIER);
    expect(part.drawerOpenId).toBeTruthy();
    expect(t.opens().at(-1)).toMatchObject({ kind: 'refund', amount: -20_000, orderId: o, userId: CASHIER.userId, approver: MANAGER.userId });

    const c = t.ring();
    t.r.tenderOrder(t.db, { orderId: c, payments: [{ method: 'card', amountCents: t.total(c), tenderedCents: null }] }, CASHIER);
    const before = t.opens().length;
    const full = t.r.refundOrder(t.db, { orderId: c, reason: 'Test refund', approverUserId: MANAGER.userId, foodMade: 'not_made' }, CASHIER);
    expect(full.drawerOpenId).toBeNull();
    expect(t.opens()).toHaveLength(before);
  });

  it('cash in, cash out and a rider tip: kind, signed amount, reason, approver and the movement', () => {
    t.r.openShift(t.db, { openingCashCents: 0 }, MANAGER);
    const before = t.opens().length;
    const pin = t.r.recordCashMovement(t.db, { type: 'payin', amountCents: 10_000, reason: 'Change', approvedByUserId: MANAGER.userId }, CASHIER);
    const pout = t.r.recordCashMovement(t.db, { type: 'payout', amountCents: 5_000, reason: 'Ice' }, MANAGER);
    const tip = t.r.recordCashMovement(t.db, { type: 'tip_out', amountCents: 2_000, reason: 'Test Rider' }, MANAGER);
    expect(t.opens().slice(before)).toEqual([
      expect.objectContaining({ kind: 'payin', amount: 10_000, reason: 'Change', approver: MANAGER.userId, movementId: pin.id, userId: CASHIER.userId }),
      expect.objectContaining({ kind: 'payout', amount: -5_000, reason: 'Ice', movementId: pout.id }),
      expect.objectContaining({ kind: 'tip_out', amount: -2_000, reason: 'Test Rider', movementId: tip.id }),
    ]);
    expect([pin.drawerOpenId, pout.drawerOpenId, tip.drawerOpenId].every(Boolean)).toBe(true);
  });

  it('a purchase paid from the drawer: one payout row, handed back for the pulse; not paid from it: none', () => {
    t.r.openShift(t.db, { openingCashCents: 500_000 }, MANAGER);
    const before = t.opens().length;
    const paid = t.r.recordPurchase(t.db, { paidFromDrawer: true, lines: [{ ingredientId: t.shop.ing.onion, qty: 2_000, billCents: 31_000 }] }, MANAGER);
    expect(paid.payoutDrawerOpenId).toBeTruthy();
    expect(t.opens().slice(before)).toEqual([expect.objectContaining({ kind: 'payout', amount: -31_000 })]);
    const notPaid = t.r.recordPurchase(t.db, { lines: [{ ingredientId: t.shop.ing.onion, qty: 2_000, billCents: 31_000 }] }, MANAGER);
    expect(notPaid.payoutDrawerOpenId).toBeNull();
    expect(t.opens()).toHaveLength(before + 1);
  });

  it('every row with its sync entry and audit row (drawer_<kind>); the audit chain verifies', () => {
    t.r.openShift(t.db, { openingCashCents: 0 }, MANAGER);
    const o = t.ring();
    t.r.tenderOrder(t.db, { orderId: o, payments: [{ method: 'cash', amountCents: t.total(o), tenderedCents: t.total(o) }] }, CASHIER);
    t.r.recordDrawerOpen(t.db, { kind: 'no_sale', reason: 'Change' }, OWNER);
    const ids = (t.db.prepare(`SELECT id, kind FROM drawer_opens`).all() as Array<{ id: string; kind: string }>);
    for (const { id, kind } of ids) {
      expect((t.db.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'drawer_opens' AND entity_id = ?`).get(id) as { n: number }).n).toBe(1);
      expect((t.db.prepare(`SELECT action FROM audit_log WHERE entity_id = ?`).get(id) as { action: string }).action).toBe(`drawer_${kind}`);
    }
    expect(ids.map((x) => x.kind).sort()).toEqual(['float', 'no_sale', 'sale']);
    expect(verifyAuditChain(t.auditRows()).ok).toBe(true);
  });

  it('the new kinds are accepted, an unknown one refused; an amount is whole paisa', () => {
    for (const kind of ['sale', 'refund', 'float', 'payin', 'payout', 'tip_out', 'no_sale', 'count', 'test'] as const) {
      expect(t.r.recordDrawerOpen(t.db, { kind }, MANAGER).kind).toBe(kind === 'count' ? 'no_sale' : kind);
    }
    expect(() => t.r.recordDrawerOpen(t.db, { kind: 'mystery' as never }, MANAGER)).toThrow('Unknown drawer open');
    expect(() => t.r.recordDrawerOpen(t.db, { kind: 'sale', amountCents: 10.5 }, MANAGER)).toThrow('whole paisa');
  });
});

describe.skipIf(!DatabaseSync)("Reports and the owner's log", () => {
  it('"opened by hand" and the no-sale counts are unchanged by the new kinds; a shift says how often the drawer was used', async () => {
    const shift = t.r.openShift(t.db, { openingCashCents: 0 }, MANAGER);
    const o = t.ring();
    t.r.tenderOrder(t.db, { orderId: o, payments: [{ method: 'cash', amountCents: t.total(o), tenderedCents: t.total(o) }] }, CASHIER);
    t.r.recordCashMovement(t.db, { type: 'payout', amountCents: 5_000, reason: 'Ice' }, MANAGER);
    t.r.recordDrawerOpen(t.db, { kind: 'no_sale', reason: 'Change', approvedByUserId: MANAGER.userId }, CASHIER);
    t.r.recordDrawerOpen(t.db, { kind: 'test' }, OWNER);
    t.r.recordDrawerOpen(t.db, { kind: 'count' }, MANAGER);
    const { getBusinessReport } = await import('../services/business-report.js');
    const range = { sinceIso: '2000-01-01T00:00:00.000Z', untilIso: '2100-01-01T00:00:00.000Z' };
    const report = getBusinessReport(t.db, range);
    // By hand: the no sale, the test and the count — not the float, the sale or the payout.
    expect(report.drawerOpenCount).toBe(3);
    expect(report.drawerOpens.map((d) => d.kind).sort()).toEqual(['count', 'no_sale', 'test']);
    expect(report.shifts.find((x) => x.id === shift.id)).toMatchObject({ noSaleOpens: 2, drawerOpenCount: 6 });
    const cashier = report.staff.find((x) => x.key === CASHIER.userId)!;
    expect(cashier).toMatchObject({ noSaleOpens: 1, drawerOpens: 2 });
  });

  it('the log: newest first, 50 at a time with a cursor, grouped, with counts, and whose till', () => {
    t.r.openShift(t.db, { openingCashCents: 0 }, MANAGER);
    for (let i = 0; i < 60; i += 1) t.r.recordDrawerOpen(t.db, { kind: 'no_sale', reason: `Change ${i}` }, CASHIER);
    const o = t.ring();
    t.r.tenderOrder(t.db, { orderId: o, payments: [{ method: 'cash', amountCents: t.total(o), tenderedCents: t.total(o) }] }, CASHIER);
    const sale = t.db.prepare(`SELECT id FROM drawer_opens WHERE kind = 'sale'`).get() as { id: string };
    t.r.settleDrawerOpen(t.db, sale.id, 'not_opened', 'The printer is off');
    // One from the other till.
    t.db.prepare(`UPDATE drawer_opens SET device_id = 'till-2' WHERE reason = 'Change 0'`).run();
    const range = { sinceIso: '2000-01-01T00:00:00.000Z', untilIso: '2100-01-01T00:00:00.000Z' };

    const first = t.r.listDrawerLog(t.db, { ...range }, DEV);
    expect(first.rows).toHaveLength(50);
    expect(first.counts).toMatchObject({ total: 62, byKind: { no_sale: 60, float: 1, sale: 1 }, byOutcome: { not_opened: 1, unknown: 61 } });
    expect(first.rows[0]).toMatchObject({ kind: 'sale', orderNumber: t.r.findOrder(t.db, o)!.orderNumber, amountCents: 120_000, outcome: 'not_opened', outcomeNote: 'The printer is off', openedBy: 'Test Cashier', till: 'this', orderDeletedAsTest: false });
    expect(first.nextCursor).not.toBeNull();
    const second = t.r.listDrawerLog(t.db, { ...range, cursor: first.nextCursor! }, DEV);
    expect(second.rows).toHaveLength(12);
    expect(second.nextCursor).toBeNull();
    const ids = new Set([...first.rows, ...second.rows].map((x) => x.id));
    expect(ids.size).toBe(62);
    expect(second.rows.find((x) => x.reason === 'Change 0')?.till).toBe('other');
    expect(t.r.listDrawerLog(t.db, { ...range, group: 'sales' }, DEV).rows.map((x) => x.kind)).toEqual(['sale']);
    expect(t.r.listDrawerLog(t.db, { ...range, group: 'cash' }, DEV).rows.map((x) => x.kind)).toEqual(['float']);
    expect(t.r.listDrawerLog(t.db, { ...range, group: 'problems' }, DEV).rows.map((x) => x.kind)).toEqual(['sale']);
    expect(t.r.listDrawerLog(t.db, { ...range, group: 'nosale', limit: 200 }, DEV).rows).toHaveLength(60);
    expect(t.r.drawerLogSince(t.db)).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("a settle writes its own sync and audit rows (drawer_result, before/after); the first result wins", () => {
    const open = t.r.recordDrawerOpen(t.db, { kind: 'no_sale' }, MANAGER);
    expect(t.r.settleDrawerOpen(t.db, open.id, 'opened')).toBe(true);
    expect(t.r.settleDrawerOpen(t.db, open.id, 'unsure', 'late')).toBe(false);
    const row = t.db.prepare(`SELECT outcome, version, settled_at IS NOT NULL AS settled FROM drawer_opens WHERE id = ?`).get(open.id);
    expect(row).toEqual({ outcome: 'opened', version: 2, settled: 1 });
    const audit = t.db.prepare(`SELECT action, before_json AS b, after_json AS a FROM audit_log WHERE entity_id = ? ORDER BY rowid`).all(open.id) as Row[];
    expect(audit.map((x) => x['action'])).toEqual(['drawer_no_sale', 'drawer_result']);
    expect(JSON.parse(String(audit[1]!['b']))).toMatchObject({ outcome: null });
    expect(JSON.parse(String(audit[1]!['a']))).toMatchObject({ outcome: 'opened' });
    expect((t.db.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_id = ?`).get(open.id) as { n: number }).n).toBe(2);
    expect(verifyAuditChain(t.auditRows()).ok).toBe(true);
  });
});
