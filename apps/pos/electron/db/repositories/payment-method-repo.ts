import type { AppDatabase } from '../connection.js';
import { nowIso, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import { findOrder, orderBillQuote, orderHasPaymentRates } from './order-repo.js';
import { findShift } from './shift-repo.js';
import { recordDrawerOpen } from './drawer-open-repo.js';
import { getFbrRowByOrder } from './fbr-queue-repo.js';
import { movedLegAmount, settleLegs } from '@cheeseoclock/pos-domain';
import {
  billByMethod,
  CHANGEABLE_PAYMENT_METHODS,
  isRatedPaymentMethod,
  paysOwnRate,
  RATED_METHOD_LABEL,
  type ChangeablePaymentMethod,
  type Order,
  type PaymentChangeOption,
  type PaymentMethod,
  type PaymentMethodChanged,
} from '@cheeseoclock/shared-types';

/**
 * Change how a paid order was paid (v0.7.42; the owner, 8 Oct 2026: "admin be
 * able to change payment method after the order have done so this issues can
 * be resolve after at closing"). A payment typed in as Cash that came by
 * JazzCash leaves the drawer short by it at the close; put right, the
 * drawer's expected cash follows:
 *
 *  - the payment row's method. A cash "given" (for the change) means nothing
 *    on a card and is not known for cash that was a card, so it goes;
 *  - while its shift is open, nothing more: the shift's figures are worked
 *    out from the payments at the close;
 *  - a shift already closed, when cash moved: its "should be in the drawer"
 *    and difference are put right (counted stays what was counted). The
 *    shift report printed at the close stays as printed.
 *
 * Since 0.7.45 (the owner, 12 Oct 2026: "first the cashier thought it will
 * paid cash then customer decided to pay on card") a bill that depends on
 * how it is paid — a card rate (0052), a way of paying with a rate of its
 * own (0054) — is worked out again for the new way instead of being refused:
 * the payment keeps the share of the bill it paid and pays it at the new
 * way's prices (pos-domain movedLegAmount), so Rs 1,150 in cash becomes
 * Rs 1,080 on the card, and the order's total and tax follow (settleLegs, the
 * rule Pay applies). The money given back or taken opens the drawer while
 * its shift is open (a drawer_opens row in this transaction). Refused, in
 * plain words: an order with a refund on it, a bill that does not come out
 * as it was settled (the order is not what it was), and a bill whose invoice
 * FBR already took in production mode.
 *
 * Every row goes through here with its sync entry and an audit row (the
 * payment's method and amount before and after; the order's totals; the
 * shift's figures before and after). Never foodpanda: it settles its own
 * orders. Who may do it is the handler's (orders:changePaymentMethod).
 */

export const PAYMENT_METHOD_FOODPANDA = 'foodpanda settles its own orders: how they were paid stays as it is.';
export const PAYMENT_METHOD_HAS_REFUND =
  'This order has a refund on it, so its bill can’t be worked out again for another way of paying. Refund the rest and ring it up again with the right payment.';
export const PAYMENT_METHOD_CANT_REWORK =
  'This order’s bill no longer comes out as it was paid, so it can’t be worked out again here. Refund it and ring it up again with the right payment.';
export const PAYMENT_METHOD_FBR_SENT =
  'This bill already went to FBR with its tax, so the tax can’t change now. Refund it and ring it up again with the right payment.';
export const PAYMENT_METHOD_NOT_ON_ORDER = 'That payment is not on this order.';
export const PAYMENT_METHOD_PICK = 'Pick Cash, Card, EasyPaisa, JazzCash or Bank transfer.';

/** Why the drawer opened when a payment's cash went back or came in (the drawer log). */
export const PAYMENT_CHANGED_DRAWER_REASON = 'Payment changed';

interface PaymentRow {
  id: string;
  order_id: string;
  method: PaymentMethod;
  amount_cents: number;
  tendered_cents: number | null;
  reference_no: string | null;
  received_by_user_id: string;
  paid_at: string;
  shift_id: string | null;
  deleted_at: string | null;
}

/** What the change did (the IPC answer adds the order's snapshot). */
export type PaymentMethodChange = Omit<PaymentMethodChanged, 'snapshot'> & {
  from: PaymentMethod;
  to: PaymentMethod;
  /** Nothing to do: the payment was already that method. */
  unchanged: boolean;
};

/** The order's bill and the payment as they were and are, when the bill was worked out again (0.7.45). */
export interface PaymentRebilled {
  /** The payment's amount before and after. */
  amountBeforeCents: number;
  amountAfterCents: number;
  /** The order's total before and after. */
  totalBeforeCents: number;
  totalAfterCents: number;
}

/** The change, and the drawer row written for the cash that moved (the handler pulses it). */
export type PaymentMethodChangeDone = PaymentMethodChange & {
  /** The bill worked out again for the new way of paying; null = the amount stayed. */
  rebilled: PaymentRebilled | null;
  /** The drawer_opens row for the cash given back or taken, while the shift is open; null = none. */
  drawerOpenId: string | null;
};

/** "Cash", "Card", "JazzCash": a way of paying as the drawer log names it. */
function methodLabel(method: PaymentMethod): string {
  return isRatedPaymentMethod(method) ? RATED_METHOD_LABEL[method] : method === 'cash' ? 'Cash' : method;
}

const PAYMENT_SELECT = `id, order_id, method, amount_cents, tendered_cents, reference_no, received_by_user_id, paid_at, shift_id, deleted_at`;

/**
 * The shift that took a payment, as the close counts it: the payment's own,
 * else the order's. `found` false: no such live payment on this order (the
 * change itself then says so); a shift id of null: taken with no shift open.
 */
export function paymentShiftOf(db: AppDatabase, orderId: string, paymentId: string): { found: boolean; shiftId: string | null } {
  const row = db
    .prepare(
      `SELECT p.shift_id AS shiftId, o.shift_id AS orderShiftId FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE p.id = ? AND p.order_id = ? AND p.deleted_at IS NULL`,
    )
    .get(paymentId, orderId) as { shiftId: string | null; orderShiftId: string | null } | undefined;
  return row ? { found: true, shiftId: row.shiftId ?? row.orderShiftId ?? null } : { found: false, shiftId: null };
}

/** The bill as the payments settle it, written on the order when a change works it out again. */
interface SettledBill {
  totalCents: number;
  taxCents: number;
  digitalNetCents: number;
  digitalTaxCents: number;
}

/** What moving one payment to another way would do: its amount then, and the bill when that changes. */
interface PaymentChangePlan {
  order: Order;
  row: PaymentRow;
  /** The payment's amount after the change. */
  amountCents: number;
  /** The order's bill after it; null = it stays as it is (only the method changes). */
  settled: SettledBill | null;
}

/**
 * Work out a change without writing anything: the order and the payment as
 * they are, the payment's amount at the new way, and the bill after it when
 * that changes — or the refusal, thrown in plain words. `unchanged` (null):
 * the payment is already paid that way.
 */
function planPaymentChange(db: AppDatabase, input: { orderId: string; paymentId: string; method: ChangeablePaymentMethod }): PaymentChangePlan | null {
  const order = findOrder(db, input.orderId);
  if (!order) throw new Error('Order not found');
  if (order.mode === 'foodpanda') throw new Error(PAYMENT_METHOD_FOODPANDA);
  if (!(CHANGEABLE_PAYMENT_METHODS as readonly string[]).includes(input.method)) throw new Error(PAYMENT_METHOD_PICK);
  const row = db.prepare(`SELECT ${PAYMENT_SELECT} FROM payments WHERE id = ? AND order_id = ?`).get(input.paymentId, input.orderId) as
    | PaymentRow
    | undefined;
  if (!row || row.deleted_at) throw new Error(PAYMENT_METHOD_NOT_ON_ORDER);
  if (row.method === 'foodpanda') throw new Error(PAYMENT_METHOD_FOODPANDA);
  if (row.method === input.method) return null;
  if (!orderHasPaymentRates(order)) return { order, row, amountCents: row.amount_cents, settled: null };

  // The bill by each way of paying: the new amount and the new totals.
  const quote = orderBillQuote(db, order.id);
  if (!quote) throw new Error('Order not found');
  // The old and the new way pay the same bill: the amount stays (card to JazzCash at one card rate).
  const sameBill =
    billByMethod(quote, row.method) === billByMethod(quote, input.method) && paysOwnRate(quote, row.method) === paysOwnRate(quote, input.method);
  if (sameBill) return { order, row, amountCents: row.amount_cents, settled: null };
  const legs = db
    .prepare(`SELECT id, method, amount_cents AS amountCents FROM payments WHERE order_id = ? AND deleted_at IS NULL ORDER BY paid_at, id`)
    .all(order.id) as Array<{ id: string; method: PaymentMethod; amountCents: number }>;
  if (row.amount_cents < 0 || legs.some((l) => l.amountCents < 0)) throw new Error(PAYMENT_METHOD_HAS_REFUND);
  const cashPaid = (ls: ReadonlyArray<{ method: string; amountCents: number }>) =>
    ls.filter((l) => !isRatedPaymentMethod(l.method)).reduce((n, l) => n + l.amountCents, 0);
  // The legs must settle the bill exactly as it was stored: else the order is not what it was.
  const asPaid = settleLegs(quote, legs);
  if (!asPaid.ok || asPaid.totalCents !== order.totalCents || asPaid.cashDueCents !== cashPaid(legs)) throw new Error(PAYMENT_METHOD_CANT_REWORK);
  const index = legs.findIndex((l) => l.id === row.id);
  const moved = movedLegAmount(quote, legs, index, input.method);
  if (moved === null) throw new Error(PAYMENT_METHOD_CANT_REWORK);
  const next = settleLegs(
    quote,
    legs.map((l, i) => (i === index ? { method: input.method, amountCents: moved } : l)),
  );
  if (!next.ok) throw new Error(PAYMENT_METHOD_CANT_REWORK);
  // A tax FBR already took (production) is never changed behind its back.
  const fbr = getFbrRowByOrder(db, order.id);
  if (fbr && fbr.status === 'sent' && fbr.modeAtEnqueue === 'production' && (next.totalCents !== order.totalCents || next.taxCents !== order.taxCents)) {
    throw new Error(PAYMENT_METHOD_FBR_SENT);
  }
  const settled = { totalCents: next.totalCents, taxCents: next.taxCents, digitalNetCents: next.digitalNetCents, digitalTaxCents: next.digitalTaxCents };
  return { order, row, amountCents: moved, settled };
}

/**
 * What each other way of paying would make of one payment, before anything
 * is saved (Change payment shows it on its buttons): its amount and the
 * order's total that way, or why it can't be. Writes nothing.
 */
export function previewPaymentMethodChange(db: AppDatabase, orderId: string, paymentId: string): PaymentChangeOption[] {
  const out: PaymentChangeOption[] = [];
  for (const method of CHANGEABLE_PAYMENT_METHODS) {
    try {
      const plan = planPaymentChange(db, { orderId, paymentId, method });
      if (plan === null) continue;
      out.push({ method, amountCents: plan.amountCents, totalCents: plan.settled ? plan.settled.totalCents : plan.order.totalCents });
    } catch (e) {
      // A payment that is not there: nothing to offer at all.
      if (e instanceof Error && (e.message === PAYMENT_METHOD_NOT_ON_ORDER || e.message === 'Order not found')) throw e;
      out.push({ method, refusal: e instanceof Error ? e.message : 'Can’t change to this' });
    }
  }
  return out;
}

export function changePaymentMethod(
  db: AppDatabase,
  input: { orderId: string; paymentId: string; method: ChangeablePaymentMethod },
  actor: Actor & { userId: string },
  opts: { approverUserId?: string | null } = {},
): PaymentMethodChangeDone {
  let result!: PaymentMethodChangeDone;
  db.transaction(() => {
    const plan = planPaymentChange(db, input);
    if (plan === null) {
      const method = input.method as PaymentMethod;
      result = { from: method, to: method, unchanged: true, closedShift: null, rebilled: null, drawerOpenId: null };
      return;
    }
    const { order, row } = plan;
    const amount = plan.amountCents;
    const settled = plan.settled;

    const now = nowIso();
    db.prepare(`UPDATE payments SET method = ?, amount_cents = ?, tendered_cents = NULL, updated_at = ?, version = version + 1 WHERE id = ?`).run(
      input.method,
      amount,
      now,
      row.id,
    );
    enqueueSync(db, {
      entityType: 'payments',
      entityId: row.id,
      op: 'upsert',
      payload: {
        id: row.id,
        orderId: row.order_id,
        method: input.method,
        amountCents: amount,
        tenderedCents: null,
        referenceNo: row.reference_no,
        paidAt: row.paid_at,
        receivedByUserId: row.received_by_user_id,
        shiftId: row.shift_id,
      },
    });
    const approver = opts.approverUserId ? { approvedByUserId: opts.approverUserId } : {};
    writeAudit(db, {
      entityType: 'payments',
      entityId: row.id,
      action: 'change_method',
      actorUserId: actor.userId,
      before: { method: row.method, tenderedCents: row.tendered_cents, ...(amount !== row.amount_cents ? { amountCents: row.amount_cents } : {}) },
      after: { method: input.method, tenderedCents: null, orderId: row.order_id, orderNumber: order.orderNumber, amountCents: amount, ...approver },
    });

    // The order's bill as the payments settle it now (0.7.45): its total, its tax and the part at a rate of its own.
    let rebilled: PaymentRebilled | null = null;
    if (settled) {
      db.prepare(
        `UPDATE orders SET tax_cents = ?, total_cents = ?, digital_net_cents = ?, digital_tax_cents = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(settled.taxCents, settled.totalCents, settled.digitalNetCents, settled.digitalTaxCents, now, order.id);
      const after = findOrder(db, order.id)!;
      enqueueSync(db, { entityType: 'orders', entityId: order.id, op: 'upsert', payload: after });
      writeAudit(db, {
        entityType: 'orders',
        entityId: order.id,
        action: 'rebill_payment_method',
        actorUserId: actor.userId,
        before: { totalCents: order.totalCents, taxCents: order.taxCents, digitalNetCents: order.digitalNetCents ?? 0, digitalTaxCents: order.digitalTaxCents ?? 0 },
        after: {
          totalCents: settled.totalCents,
          taxCents: settled.taxCents,
          digitalNetCents: settled.digitalNetCents,
          digitalTaxCents: settled.digitalTaxCents,
          paymentId: row.id,
          from: row.method,
          to: input.method,
          ...approver,
        },
      });
      rebilled = { amountBeforeCents: row.amount_cents, amountAfterCents: amount, totalBeforeCents: order.totalCents, totalAfterCents: settled.totalCents };
    }

    // The shift that took the money (as the close counts it: the payment's own, else the order's).
    let closedShift: PaymentMethodChange['closedShift'] = null;
    let drawerOpenId: string | null = null;
    const cashIn = (method: PaymentMethod, cents: number) => (method === 'cash' ? cents : 0);
    const moved = cashIn(input.method, amount) - cashIn(row.method, row.amount_cents);
    const shiftId = row.shift_id ?? order.shiftId ?? null;
    const shift = shiftId ? findShift(db, shiftId) : null;
    if (moved !== 0 && shift && shift.closedAt && shift.expectedCashCents !== null && shift.countedCashCents !== null) {
      const expected = shift.expectedCashCents + moved;
      const variance = shift.countedCashCents - expected;
      db.prepare(
        `UPDATE shifts SET expected_cash_cents = ?, variance_cents = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(expected, variance, now, shift.id);
      enqueueSync(db, { entityType: 'shifts', entityId: shift.id, op: 'upsert', payload: findShift(db, shift.id) });
      writeAudit(db, {
        entityType: 'shifts',
        entityId: shift.id,
        action: 'drawer_corrected',
        actorUserId: actor.userId,
        before: { expectedCashCents: shift.expectedCashCents, varianceCents: shift.varianceCents },
        after: {
          expectedCashCents: expected,
          varianceCents: variance,
          paymentId: row.id,
          orderNumber: order.orderNumber,
          from: row.method,
          to: input.method,
        },
      });
      closedShift = {
        shiftId: shift.id,
        openedAt: shift.openedAt,
        expectedCashCents: expected,
        varianceCents: variance,
        previousVarianceCents: shift.varianceCents ?? 0,
      };
    } else if (moved !== 0 && shift && !shift.closedAt && shift.deviceId === actor.deviceId) {
      // The shift is open on this till: the cash goes back to the customer, or comes in, through the drawer now.
      drawerOpenId = recordDrawerOpen(
        db,
        {
          kind: moved > 0 ? 'sale' : 'refund',
          orderId: order.id,
          // Signed, as the drawer log keeps it: + into the drawer, − given back.
          amountCents: moved,
          reason: `${PAYMENT_CHANGED_DRAWER_REASON}: ${methodLabel(row.method)} to ${methodLabel(input.method)}`,
          ...(opts.approverUserId ? { approvedByUserId: opts.approverUserId } : {}),
        },
        actor,
      ).id;
    }
    result = { from: row.method, to: input.method, unchanged: false, closedShift, rebilled, drawerOpenId };
  })();
  return result;
}
