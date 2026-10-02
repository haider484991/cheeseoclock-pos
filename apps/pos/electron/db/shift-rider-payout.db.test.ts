/**
 * A payout to an outside rider, linked to the order (migration 0049
 * cash_movements.order_id; the owner, 2 Oct 2026: "Third-party rider keeps
 * the delivery charge: the drawer expects the food total from the rider";
 * "pay the rider's fee if they went"), on a real database built from every
 * migration, driven through the shift repository:
 *   - recordDeliveryChargeToRider writes ONE cash payout with the order on
 *     it and the exact reason — a kept charge or a wasted trip — one sync row
 *     whose image carries the order, one audit row 'delivery_charge_to_rider'
 *     (never 'cash_payout') with why, and NO drawer row (its caller writes
 *     that); with no shift open nothing is written;
 *   - the shift's figures: riderCents / riderCount count only payouts linked
 *     to an order, outCents still holds them, so the expected cash is the
 *     float less the payout by the same formula as before — and a close
 *     counting exactly that is not short; riderTripCount says how many of
 *     them were trips (by the payout's own words), and the summary carries
 *     the float, so the close result's rows add up (e2e, 2 Oct 2026);
 *   - the cash list says which order a payout was for; the drawer payouts
 *     that can become a purchase leave it out, and turning it into a purchase
 *     is refused, directly and through procurement-repo;
 *   - cash out typed by hand (the 'shifts:recordCashMovement' handler) is
 *     never linked to an order, even when asked, and is audited 'cash_payout'.
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for
 * Electron); skipped where it is missing. Every name, number and amount is
 * made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, UUID } from '@cheeseoclock/shared-types';
import type { AppDatabase } from './connection.js';
import { DatabaseSync } from './costing-shop.fixture.js';
import { openTill } from './two-tills.fixture.js';
import { verifyAuditChain, type AuditChainRow } from './audit-chain.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => Promise<unknown>>(),
  session: null as AuthenticatedUser | null,
  kicks: [] as string[],
}));

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
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
// The shifts handlers, captured instead of registered with Electron.
vi.mock('../ipc/registry.js', () => {
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
    defineHandler: (channel: string, _ctx: unknown, fn: (ctx: unknown, payload: unknown) => Promise<unknown>) => {
      h.handlers.set(channel, async (ctx, payload) => fn(ctx, payload));
    },
  };
});
// Who is signed in: auth-service's job, stood in for here.
vi.mock('../services/auth-service.js', () => ({
  getCurrentSession: () => h.session,
  verifyManagerPin: async () => {
    throw new Error("That is not a manager's PIN or password");
  },
}));
// No printer here: the drawer pulses are only noted.
vi.mock('../services/print-spooler.js', () => ({
  printSpooler: new Proxy(
    {},
    {
      get:
        (_t, method) =>
        (...args: unknown[]) => {
          if (method === 'kickDrawerSoon') h.kicks.push(String(args[0]));
          return undefined;
        },
    },
  ),
  drawerFailureText: () => '',
}));
vi.mock('../services/fbr-worker.js', () => ({ fbrWorker: { kick: () => {}, resetAdapter: () => {} } }));
vi.mock('../services/order-alerts-hub.js', () => ({ orderAlerts: { orderReceived: () => {}, importFailed: () => {} } }));

const live = describe.skipIf(!DatabaseSync);

const TILL = 'till-a';
const CASHIER = { userId: 'u_cash', deviceId: TILL };
const MANAGER = { userId: 'u_mgr', deviceId: TILL };
/** The float: Rs 5,000. */
const FLOAT = 500_000;
/** Rs 200, the area's delivery charge as sold (before its tax). */
const KEEP = 20_000;
const KEPT_WORDS = "A delivery charge kept by a rider can't be turned into a purchase";

/** Evening times in Pakistan (UTC+5), as instants. */
const PK = {
  '18:00': '2026-10-02T13:00:00.000Z',
  '19:00': '2026-10-02T14:00:00.000Z',
  '19:30': '2026-10-02T14:30:00.000Z',
  '19:45': '2026-10-02T14:45:00.000Z',
  '19:50': '2026-10-02T14:50:00.000Z',
  '20:00': '2026-10-02T15:00:00.000Z',
  '20:10': '2026-10-02T15:10:00.000Z',
} as const;
type Clock = keyof typeof PK;
const at = (t: Clock) => vi.setSystemTime(new Date(PK[t]));

type Row = Record<string, unknown>;
const shiftRepo = () => import('./repositories/shift-repo.js');
const orderRepo = () => import('./repositories/order-repo.js');

interface Shop {
  db: AppDatabase;
  shiftId: string;
  pizza: string;
  charge: string;
}

/**
 * A till: the made-up users, a 15% tax, a Rs 3,900 pizza, the area's
 * 'Delivery Charge (Rs 200)' at 15%, and a shift opened at 18:00 on a
 * Rs 5,000 float (or none).
 */
async function till(opts: { shift?: boolean } = {}): Promise<Shop> {
  const db = openTill(TILL);
  const { createTaxCategory } = await import('./repositories/tax-category-repo.js');
  const { createCategory } = await import('./repositories/category-repo.js');
  const { createMenuItem } = await import('./repositories/menu-item-repo.js');
  const { openShift } = await shiftRepo();
  at('18:00');
  const tax = createTaxCategory(db, { name: 'Test GST', rateBps: 1_500 }, MANAGER);
  const food = createCategory(db, { name: 'Test Pizzas', displayOrder: 1, colorHex: '#aa5500' }, MANAGER);
  const fees = createCategory(db, { name: 'Delivery Charges', displayOrder: 2, colorHex: '#555555' }, MANAGER);
  const pizza = createMenuItem(db, { categoryId: food.id, name: 'Test Family Pizza', basePriceCents: 390_000, taxCategoryId: tax.id }, MANAGER).id;
  const charge = createMenuItem(db, { categoryId: fees.id, name: 'Delivery Charge (Rs 200)', basePriceCents: KEEP, taxCategoryId: tax.id }, MANAGER).id;
  const shiftId = opts.shift === false ? '' : openShift(db, { openingCashCents: FLOAT }, MANAGER).id;
  return { db, shiftId, pizza, charge };
}

/** A counter delivery with the pizza and the delivery charge: sent 19:30, ready 19:45, sent out 19:50. */
async function sentOut(shop: Shop): Promise<{ id: string; orderNumber: string }> {
  const r = await orderRepo();
  at('19:00');
  const o = r.createOrder(shop.db, { mode: 'delivery' }, CASHIER);
  r.addOrderItem(shop.db, { orderId: o.id, menuItemId: shop.pizza, quantity: 1, modifierIds: [] }, CASHIER);
  r.addOrderItem(shop.db, { orderId: o.id, menuItemId: shop.charge, quantity: 1, modifierIds: [] }, CASHIER);
  at('19:30');
  r.sendOrderToKitchen(shop.db, o.id, CASHIER);
  at('19:45');
  r.markOrderReady(shop.db, o.id, CASHIER);
  at('19:50');
  const out = r.sendOutOrder(shop.db, o.id, CASHIER);
  expect(out.riderKeepsCents).toBe(KEEP);
  return { id: o.id, orderNumber: out.orderNumber };
}

const count = (db: AppDatabase, table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
/** Everything a write can leave behind. */
const ledger = (db: AppDatabase) => ({
  movements: count(db, 'cash_movements'),
  drawer: count(db, 'drawer_opens'),
  sync: count(db, 'sync_queue'),
  audit: count(db, 'audit_log'),
  purchases: count(db, 'purchase_orders'),
  stock: count(db, 'stock_movements'),
});
/** The sync images and audit rows written after `sinceSync` / `sinceAudit` rows. */
function writtenAfter(db: AppDatabase, sinceSync: number, sinceAudit: number) {
  const sync = (db.prepare(`SELECT entity_type, entity_id, payload_json FROM sync_queue ORDER BY rowid`).all() as Row[]).slice(sinceSync).map((q) => ({
    entityType: q['entity_type'],
    entityId: q['entity_id'],
    image: JSON.parse(String(q['payload_json'])) as Row,
  }));
  const audit = (db.prepare(`SELECT entity_type, entity_id, action, actor_user_id, after_json FROM audit_log ORDER BY rowid`).all() as Row[])
    .slice(sinceAudit)
    .map((a) => ({
      entityType: a['entity_type'],
      entityId: a['entity_id'],
      action: a['action'],
      actor: a['actor_user_id'],
      after: JSON.parse(String(a['after_json'])) as Row,
    }));
  return { sync, audit };
}
const movementRow = (db: AppDatabase, id: string) =>
  db.prepare(`SELECT shift_id, type, amount_cents, reason, user_id, approved_by_user_id, order_id, ref_purchase_order_id FROM cash_movements WHERE id = ?`).get(id) as
    | Row
    | undefined;

function chainOk(db: AppDatabase): boolean {
  const rows = (
    db
      .prepare(
        `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action, actor_user_id AS actorUserId,
                before_json AS beforeJson, after_json AS afterJson, ip, created_at AS createdAt,
                prev_hash AS prevHash, row_hash AS rowHash
           FROM audit_log ORDER BY rowid`,
      )
      .all() as unknown as AuditChainRow[]
  ).map((r) => ({ ...r, rowid: Number(r.rowid) }));
  return verifyAuditChain(rows).ok;
}

beforeEach(() => {
  h.handlers.clear();
  h.session = null;
  h.kicks.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

live('recordDeliveryChargeToRider: one payout, linked to the order', () => {
  it('kept: one payout of Rs 200 with the order on it and the exact reason; one sync row whose image carries the order; one audit row delivery_charge_to_rider with why kept; no drawer row', async () => {
    const shop = await till();
    const { recordDeliveryChargeToRider } = await shiftRepo();
    const order = await sentOut(shop);
    expect(order.orderNumber).toBe('20261002-0001');
    const before = ledger(shop.db);

    at('20:00');
    const id = recordDeliveryChargeToRider(shop.db, { orderId: order.id, orderNumber: order.orderNumber, amountCents: KEEP, why: 'kept' }, CASHIER);

    expect(movementRow(shop.db, id)).toEqual({
      shift_id: shop.shiftId,
      type: 'payout',
      amount_cents: KEEP,
      reason: 'Delivery charge kept by the outside rider — Order #0001',
      user_id: CASHIER.userId,
      approved_by_user_id: null,
      order_id: order.id,
      ref_purchase_order_id: null,
    });
    // One row, its sync and its audit: the caller writes the drawer row.
    expect(ledger(shop.db)).toEqual({ ...before, movements: before.movements + 1, sync: before.sync + 1, audit: before.audit + 1 });
    const { sync, audit } = writtenAfter(shop.db, before.sync, before.audit);
    expect(sync).toEqual([{ entityType: 'cash_movements', entityId: id, image: expect.objectContaining({ id, orderId: order.id, type: 'payout', amountCents: KEEP }) }]);
    expect(audit).toEqual([
      {
        entityType: 'cash_movements',
        entityId: id,
        action: 'delivery_charge_to_rider',
        actor: CASHIER.userId,
        after: expect.objectContaining({ id, orderId: order.id, why: 'kept', amountCents: KEEP, reason: 'Delivery charge kept by the outside rider — Order #0001' }),
      },
    ]);
    expect(count(shop.db, 'drawer_opens')).toBe(before.drawer);
    expect(shop.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'cash_payout'`).get()).toEqual({ n: 0 });
    expect(chainOk(shop.db)).toBe(true);
  });

  it("trip: 'Trip paid to the outside rider — Order #0001 cancelled', why trip, and the manager who approved it", async () => {
    const shop = await till();
    const { recordDeliveryChargeToRider } = await shiftRepo();
    const order = await sentOut(shop);
    const before = ledger(shop.db);

    at('20:10');
    const id = recordDeliveryChargeToRider(
      shop.db,
      { orderId: order.id, orderNumber: order.orderNumber, amountCents: KEEP, why: 'trip', approvedByUserId: MANAGER.userId },
      CASHIER,
    );

    expect(movementRow(shop.db, id)).toMatchObject({
      type: 'payout',
      amount_cents: KEEP,
      reason: 'Trip paid to the outside rider — Order #0001 cancelled',
      approved_by_user_id: MANAGER.userId,
      order_id: order.id,
    });
    const { sync, audit } = writtenAfter(shop.db, before.sync, before.audit);
    expect(sync).toHaveLength(1);
    expect(sync[0]?.image).toMatchObject({ id, orderId: order.id });
    expect(audit).toEqual([expect.objectContaining({ action: 'delivery_charge_to_rider', after: expect.objectContaining({ why: 'trip', orderId: order.id }) })]);
    expect(count(shop.db, 'drawer_opens')).toBe(before.drawer);
  });

  it('with no shift open on this till it is refused and nothing is written', async () => {
    const shop = await till({ shift: false });
    const { recordDeliveryChargeToRider } = await shiftRepo();
    const order = await sentOut(shop);
    const before = ledger(shop.db);
    for (const why of ['kept', 'trip'] as const) {
      expect(() =>
        recordDeliveryChargeToRider(shop.db, { orderId: order.id, orderNumber: order.orderNumber, amountCents: KEEP, why }, CASHIER),
      ).toThrow('No shift is open on this till');
    }
    expect(ledger(shop.db)).toEqual(before);
  });

  it('in a caller\'s transaction that then fails, the payout goes with it', async () => {
    const shop = await till();
    const { recordDeliveryChargeToRider } = await shiftRepo();
    const order = await sentOut(shop);
    const before = ledger(shop.db);
    expect(() =>
      shop.db.transaction(() => {
        recordDeliveryChargeToRider(shop.db, { orderId: order.id, orderNumber: order.orderNumber, amountCents: KEEP, why: 'kept' }, CASHIER);
        throw new Error('the payment failed');
      })(),
    ).toThrow('the payment failed');
    expect(ledger(shop.db)).toEqual(before);
  });
});

live("the shift's figures: the riders' payouts are a part of the cash taken out", () => {
  it('cashMovementTotals counts only payouts linked to an order (live) in riderCents / riderCount; outCents still holds them', async () => {
    const shop = await till();
    const { cashMovementTotals, recordCashMovement, recordDeliveryChargeToRider } = await shiftRepo();
    const order = await sentOut(shop);
    at('20:00');
    recordCashMovement(shop.db, { type: 'payin', amountCents: 100_000, reason: 'Change from the bank' }, MANAGER);
    // Today's workaround, typed by hand (v0.7.33): a plain payout, not a rider's.
    recordCashMovement(shop.db, { type: 'payout', amountCents: 20_000, reason: 'Delivery fee kept by rider - order #0001' }, MANAGER);
    recordCashMovement(shop.db, { type: 'tip_out', amountCents: 5_000, reason: 'Test rider tip' }, MANAGER);
    const linked = recordDeliveryChargeToRider(shop.db, { orderId: order.id, orderNumber: order.orderNumber, amountCents: KEEP, why: 'kept' }, CASHIER);

    // With the breakdown of step 19d-1 (the hand-typed payout, the tip, the trips).
    expect(cashMovementTotals(shop.db, shop.shiftId)).toEqual({
      inCents: 100_000,
      inCount: 1,
      outCents: 20_000 + 5_000 + KEEP,
      payoutCents: 20_000,
      payoutCount: 1,
      tipCents: 5_000,
      tipCount: 1,
      riderCents: KEEP,
      riderCount: 1,
      riderTripCount: 0,
    });
    // A deleted payout (a test order deleted, step 18-3) no longer counts.
    shop.db.prepare(`UPDATE cash_movements SET deleted_at = ? WHERE id = ?`).run(PK['20:10'], linked);
    expect(cashMovementTotals(shop.db, shop.shiftId)).toEqual({
      inCents: 100_000,
      inCount: 1,
      outCents: 25_000,
      payoutCents: 20_000,
      payoutCount: 1,
      tipCents: 5_000,
      tipCount: 1,
      riderCents: 0,
      riderCount: 0,
      riderTripCount: 0,
    });
  });

  it('getShiftSummary: riderChargesCents Rs 200, riderChargeCount 1, expected = Rs 5,000 − Rs 200 by the same formula; a close counting exactly that is not short', async () => {
    const shop = await till();
    const { closeShift, getShiftSummary, recordDeliveryChargeToRider } = await shiftRepo();
    const order = await sentOut(shop);
    expect(getShiftSummary(shop.db, shop.shiftId)).toMatchObject({ cashOutCents: 0, riderChargesCents: 0, riderChargeCount: 0, expectedCashCents: FLOAT });

    at('20:00');
    recordDeliveryChargeToRider(shop.db, { orderId: order.id, orderNumber: order.orderNumber, amountCents: KEEP, why: 'kept' }, CASHIER);
    const s = getShiftSummary(shop.db, shop.shiftId);
    expect(s).toMatchObject({ cashOutCents: KEEP, riderChargesCents: KEEP, riderChargeCount: 1, expectedCashCents: FLOAT - KEEP });
    // The formula is unchanged: the riders' share is never taken out twice.
    expect(s.expectedCashCents).toBe(FLOAT + s.cashSalesCents - s.cashRefundsCents + s.cashInCents - s.cashOutCents);

    // The order is still out (unpaid), so the close carries it over.
    at('20:10');
    const closed = closeShift(shop.db, { shiftId: shop.shiftId, countedCashCents: FLOAT - KEEP, carryOverReason: 'Test rider still out' }, MANAGER);
    expect(closed).toMatchObject({ expectedCashCents: FLOAT - KEEP, varianceCents: 0 });
  });

  it('getShiftSummary tells the kept charges from the trips (riderTripCount, by the payout’s own words) and carries the float, so the close result’s rows add up to Expected (e2e, 2 Oct 2026)', async () => {
    const shop = await till();
    const { getShiftSummary, recordCashMovement, recordDeliveryChargeToRider, TRIP_PAYOUT_REASON_START } = await shiftRepo();
    const kept = await sentOut(shop);
    const cancelled = await sentOut(shop);
    const alone = await sentOut(shop);
    expect(getShiftSummary(shop.db, shop.shiftId)).toMatchObject({ riderChargeCount: 0, riderTripCount: 0, openingCashCents: FLOAT });

    at('20:00');
    recordDeliveryChargeToRider(shop.db, { orderId: kept.id, orderNumber: kept.orderNumber, amountCents: KEEP, why: 'kept' }, CASHIER);
    const trip = recordDeliveryChargeToRider(shop.db, { orderId: cancelled.id, orderNumber: cancelled.orderNumber, amountCents: KEEP, why: 'trip' }, CASHIER);
    recordDeliveryChargeToRider(shop.db, { orderId: alone.id, orderNumber: alone.orderNumber, amountCents: KEEP, why: 'trip', tripWhy: 'went_alone' }, CASHIER);
    // Typed by hand, whatever its words: never a rider's payout, never a trip.
    recordCashMovement(shop.db, { type: 'payout', amountCents: 25_000, reason: `${TRIP_PAYOUT_REASON_START} — typed by hand` }, MANAGER);

    const s = getShiftSummary(shop.db, shop.shiftId);
    expect(s).toMatchObject({
      cashOutCents: 3 * KEEP + 25_000,
      riderChargesCents: 3 * KEEP,
      riderChargeCount: 3,
      riderTripCount: 2,
      openingCashCents: FLOAT,
      expectedCashCents: FLOAT - 3 * KEEP - 25_000,
    });
    // The close result's rows: float + cash sales − refunds + put in − taken out − paid to riders = Expected.
    const takenOut = s.cashOutCents - s.riderChargesCents;
    expect(s.openingCashCents + s.cashSalesCents - s.cashRefundsCents + s.cashInCents - takenOut - s.riderChargesCents).toBe(s.expectedCashCents);
    // The words the payouts were written with are the ones counted.
    const reasons = (shop.db.prepare(`SELECT reason FROM cash_movements WHERE order_id IS NOT NULL ORDER BY rowid`).all() as Array<{ reason: string }>).map((m) => m.reason);
    expect(reasons).toEqual([
      `Delivery charge kept by the outside rider — Order #${kept.orderNumber.split('-').pop()}`,
      `${TRIP_PAYOUT_REASON_START} — Order #${cancelled.orderNumber.split('-').pop()} cancelled`,
      `${TRIP_PAYOUT_REASON_START} — Order #${alone.orderNumber.split('-').pop()} went alone`,
    ]);
    // A deleted trip payout (a test order deleted) no longer counts.
    shop.db.prepare(`UPDATE cash_movements SET deleted_at = ? WHERE id = ?`).run(PK['20:10'], trip);
    expect(getShiftSummary(shop.db, shop.shiftId)).toMatchObject({ riderChargeCount: 2, riderTripCount: 1 });
  });
});

live('the cash lists: which order a payout was for; never a purchase', () => {
  it('listCashMovements and findCashMovement carry the order id and number; cash typed by hand has none', async () => {
    const shop = await till();
    const { findCashMovement, listCashMovements, recordCashMovement, recordDeliveryChargeToRider } = await shiftRepo();
    const order = await sentOut(shop);
    at('20:00');
    const manual = recordCashMovement(shop.db, { type: 'payout', amountCents: 30_000, reason: 'Test gas cylinder' }, MANAGER);
    expect(manual).toMatchObject({ orderId: null, orderNumber: null });
    const linked = recordDeliveryChargeToRider(shop.db, { orderId: order.id, orderNumber: order.orderNumber, amountCents: KEEP, why: 'kept' }, CASHIER);

    expect(listCashMovements(shop.db, shop.shiftId)).toEqual([
      expect.objectContaining({ id: manual.id, reason: 'Test gas cylinder', orderId: null, orderNumber: null }),
      expect.objectContaining({
        id: linked,
        type: 'payout',
        amountCents: KEEP,
        reason: 'Delivery charge kept by the outside rider — Order #0001',
        userName: 'Test Cashier',
        orderId: order.id,
        orderNumber: '20261002-0001',
        refPurchaseOrderId: null,
      }),
    ]);
    expect(findCashMovement(shop.db, linked)).toMatchObject({ orderId: order.id, orderNumber: '20261002-0001' });
  });

  it("listDrawerPayouts leaves the rider's payout out; linkPayoutToPurchase and payoutToPurchase refuse it in the exact words and write nothing", async () => {
    const shop = await till();
    const { createIngredient } = await import('./repositories/ingredient-repo.js');
    const { payoutToPurchase } = await import('./repositories/procurement-repo.js');
    const { linkPayoutToPurchase, listDrawerPayouts, recordCashMovement, recordDeliveryChargeToRider } = await shiftRepo();
    const onion = createIngredient(shop.db, { name: 'Test Onion', unit: 'g' }, MANAGER);
    const order = await sentOut(shop);
    at('20:00');
    const manual = recordCashMovement(shop.db, { type: 'payout', amountCents: 30_000, reason: 'Test veg from the market' }, MANAGER);
    const linked = recordDeliveryChargeToRider(shop.db, { orderId: order.id, orderNumber: order.orderNumber, amountCents: KEEP, why: 'kept' }, CASHIER);

    expect(listDrawerPayouts(shop.db, TILL).map((p) => p.id)).toEqual([manual.id]);

    const before = ledger(shop.db);
    expect(() => linkPayoutToPurchase(shop.db, linked, 'some-purchase', MANAGER)).toThrow(KEPT_WORDS);
    expect(() =>
      payoutToPurchase(shop.db, { cashMovementId: linked, lines: [{ ingredientId: onion.id, qty: 1_000, billCents: KEEP }] }, MANAGER),
    ).toThrow(KEPT_WORDS);
    // Nothing: no purchase, no stock, no link, no sync, no audit.
    expect(ledger(shop.db)).toEqual(before);
    expect(movementRow(shop.db, linked)).toMatchObject({ ref_purchase_order_id: null, order_id: order.id });

    // The manual payout still can.
    const res = payoutToPurchase(shop.db, { cashMovementId: manual.id, lines: [{ ingredientId: onion.id, qty: 2_000, billCents: 30_000 }] }, MANAGER);
    expect(res.alreadyLinked).toBe(false);
    expect(movementRow(shop.db, manual.id)).toMatchObject({ ref_purchase_order_id: res.purchase.id, order_id: null });
    expect(chainOk(shop.db)).toBe(true);
  });
});

live("cash out typed by hand ('shifts:recordCashMovement') is never linked to an order", () => {
  it('a payload carrying orderId stores order_id NULL and is audited cash_payout, as before', async () => {
    const shop = await till();
    const order = await sentOut(shop);
    const { registerShiftsHandlers } = await import('../ipc/handlers/shifts-handlers.js');
    registerShiftsHandlers({ db: shop.db, deviceId: TILL } as never);
    h.session = { id: MANAGER.userId as UUID, fullName: 'Test Manager', role: 'manager', sessionId: 'sess' as UUID };
    const handler = h.handlers.get('shifts:recordCashMovement');
    expect(handler).toBeDefined();
    const before = ledger(shop.db);

    at('20:00');
    const res = (await handler!(
      { db: shop.db, deviceId: TILL },
      { type: 'payout', amountCents: KEEP, reason: 'Delivery fee kept by rider - order #0001', orderId: order.id },
    )) as { ok: boolean; data: { id: string; orderId: string | null } };

    expect(res.ok).toBe(true);
    expect(res.data.orderId).toBeNull();
    expect(movementRow(shop.db, res.data.id)).toMatchObject({ type: 'payout', amount_cents: KEEP, order_id: null });
    const cashAudit = writtenAfter(shop.db, before.sync, before.audit).audit.filter((a) => a.entityType === 'cash_movements');
    expect(cashAudit.map((a) => a.action)).toEqual(['cash_payout']);
    expect(cashAudit[0]?.after).not.toHaveProperty('orderId');
    expect(cashAudit[0]?.after).not.toHaveProperty('why');
    // Typed by hand, the drawer opens for it as before (its own drawer row).
    expect(count(shop.db, 'drawer_opens')).toBe(before.drawer + 1);
    expect(h.kicks).toHaveLength(1);
  });
});
