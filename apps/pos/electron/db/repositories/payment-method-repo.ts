import type { AppDatabase } from '../connection.js';
import { nowIso, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import { findOrder } from './order-repo.js';
import { findShift } from './shift-repo.js';
import { isDigitalPayment } from '@cheeseoclock/pos-domain';
import {
  CHANGEABLE_PAYMENT_METHODS,
  type ChangeablePaymentMethod,
  type PaymentMethod,
  type PaymentMethodChanged,
} from '@cheeseoclock/shared-types';

/**
 * The owner changes how a paid order was paid (v0.7.42; the owner, 8 Oct
 * 2026: "admin be able to change payment method after the order have done so
 * this issues can be resolve after at closing"). A payment typed in as Cash
 * that came by JazzCash leaves the drawer short by it at the close; put
 * right, the drawer's expected cash follows:
 *
 *  - the payment row's method (and nothing else: its amount is what was
 *    paid, the bill stays as it was printed). A cash "given" (for the
 *    change) means nothing on a card and is not known for cash that was a
 *    card, so it goes;
 *  - while its shift is open, nothing more: the shift's figures are worked
 *    out from the payments at the close;
 *  - a shift already closed, when cash moved: its "should be in the drawer"
 *    and difference are put right (counted stays what was counted). The
 *    shift report printed at the close stays as printed.
 *
 * Every row goes through here with its sync entry and an audit row (the
 * payment's method before and after; the shift's figures before and after).
 * Never foodpanda: it settles its own orders. On an order whose bill depends
 * on how it was paid (a card tax rate, orders.digital_total_cents) cash and
 * card cannot be swapped: the bill would be the other method's.
 */

export const PAYMENT_METHOD_FOODPANDA = 'foodpanda settles its own orders: how they were paid stays as it is.';
export const PAYMENT_METHOD_CARD_RATE =
  'This order’s bill depends on how it was paid (the card tax rate), so cash and card can’t be swapped on it. Refund it and ring it up again with the right payment.';
export const PAYMENT_METHOD_NOT_ON_ORDER = 'That payment is not on this order.';
export const PAYMENT_METHOD_PICK = 'Pick Cash, Card, EasyPaisa, JazzCash or Bank transfer.';

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

export function changePaymentMethod(
  db: AppDatabase,
  input: { orderId: string; paymentId: string; method: ChangeablePaymentMethod },
  actor: Actor & { userId: string },
): PaymentMethodChange {
  let result!: PaymentMethodChange;
  db.transaction(() => {
    const order = findOrder(db, input.orderId);
    if (!order) throw new Error('Order not found');
    if (order.mode === 'foodpanda') throw new Error(PAYMENT_METHOD_FOODPANDA);
    if (!(CHANGEABLE_PAYMENT_METHODS as readonly string[]).includes(input.method)) throw new Error(PAYMENT_METHOD_PICK);
    const row = db
      .prepare(
        `SELECT id, order_id, method, amount_cents, tendered_cents, reference_no, received_by_user_id, paid_at, shift_id, deleted_at
           FROM payments WHERE id = ? AND order_id = ?`,
      )
      .get(input.paymentId, input.orderId) as PaymentRow | undefined;
    if (!row || row.deleted_at) throw new Error(PAYMENT_METHOD_NOT_ON_ORDER);
    if (row.method === 'foodpanda') throw new Error(PAYMENT_METHOD_FOODPANDA);
    if (row.method === input.method) {
      result = { from: row.method, to: row.method, unchanged: true, closedShift: null };
      return;
    }
    if (typeof order.digitalTotalCents === 'number' && isDigitalPayment(row.method) !== isDigitalPayment(input.method)) {
      throw new Error(PAYMENT_METHOD_CARD_RATE);
    }

    const now = nowIso();
    db.prepare(`UPDATE payments SET method = ?, tendered_cents = NULL, updated_at = ?, version = version + 1 WHERE id = ?`).run(
      input.method,
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
        amountCents: row.amount_cents,
        tenderedCents: null,
        referenceNo: row.reference_no,
        paidAt: row.paid_at,
        receivedByUserId: row.received_by_user_id,
        shiftId: row.shift_id,
      },
    });
    writeAudit(db, {
      entityType: 'payments',
      entityId: row.id,
      action: 'change_method',
      actorUserId: actor.userId,
      before: { method: row.method, tenderedCents: row.tendered_cents },
      after: { method: input.method, tenderedCents: null, orderId: row.order_id, orderNumber: order.orderNumber, amountCents: row.amount_cents },
    });

    // The shift that took the money (as the close counts it: the payment's own, else the order's).
    let closedShift: PaymentMethodChange['closedShift'] = null;
    const cashOf = (method: PaymentMethod) => (method === 'cash' ? row.amount_cents : 0);
    const moved = cashOf(input.method) - cashOf(row.method);
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
    }
    result = { from: row.method, to: input.method, unchanged: false, closedShift };
  })();
  return result;
}
