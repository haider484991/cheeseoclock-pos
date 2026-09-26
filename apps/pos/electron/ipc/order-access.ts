import type { AppDatabase } from '../db/connection.js';
import { hasCapability, type AuthenticatedUser, type Order } from '@cheeseoclock/shared-types';
import { counterOrderAccess, type CounterPurpose } from '@cheeseoclock/pos-domain';
import { findShift } from '../db/repositories/shift-repo.js';
import { findOrder } from '../db/repositories/order-repo.js';
import { listAddresses } from '../db/repositories/customer-repo.js';
import { IpcGuardError } from './registry.js';

/**
 * Which orders a counter login (no `order.history`) may open or print again,
 * checked in the main process. The rule itself is pure and tested in
 * @cheeseoclock/pos-domain (counter-access.ts); this reads the shift and says
 * no in plain words. Managers and the owner are never limited here.
 */

const EARLIER_SHIFT: Record<CounterPurpose, string> = {
  open: 'This order is from an earlier shift. Ask a manager to open it.',
  receipt: 'This order is from an earlier shift. Ask a manager to reprint it.',
  kitchen: 'This order is from an earlier shift. Ask a manager to reprint it.',
};

const TOO_OLD: Record<CounterPurpose, string> = {
  open: 'This order is more than a day old. Ask a manager to open it.',
  receipt: 'This order is more than a day old. Ask a manager to reprint it.',
  kitchen: 'This order is more than a day old. Ask a manager to reprint it.',
};

/**
 * The spooler refuses these for everyone (reprint-policy.ts
 * KITCHEN_REPRINT_STATUSES), so there is no manager to send the cashier to.
 */
export const KITCHEN_DONE = 'The kitchen is done with this order, so its ticket is not printed again';

export function assertCounterMaySee(
  db: AppDatabase,
  session: AuthenticatedUser,
  order: Pick<Order, 'status' | 'shiftId' | 'createdAt'>,
  purpose: CounterPurpose,
): void {
  if (hasCapability(session.role, 'order.history')) return;
  const shiftStillOpen = order.shiftId !== '' && findShift(db, order.shiftId)?.closedAt === null;
  const verdict = counterOrderAccess(order, purpose, shiftStillOpen, Date.now());
  switch (verdict) {
    case 'ok':
      return;
    case 'earlier_shift':
      throw new IpcGuardError({ code: 'forbidden', message: EARLIER_SHIFT[purpose] });
    case 'too_old':
      throw new IpcGuardError({ code: 'forbidden', message: TOO_OLD[purpose] });
    case 'left_kitchen':
      throw new IpcGuardError({ code: 'forbidden', message: KITCHEN_DONE });
    case 'not_sent':
      throw new IpcGuardError({
        code: 'precondition_failed',
        message:
          purpose === 'kitchen'
            ? 'This order has not gone to the kitchen yet'
            : 'This order has not been sent or paid yet — there is no bill to reprint',
      });
  }
}

/**
 * Printing a receipt or kitchen ticket again. A counter login may reprint only
 * what it may open (the board and this shift's orders; a kitchen ticket only
 * while the kitchen still has the order), so an old customer's bill can't be
 * handed to a new customer. Managers and the owner are not limited here (the
 * order is not even read for them).
 */
export function assertCounterMayReprint(
  db: AppDatabase,
  session: AuthenticatedUser,
  orderId: string,
  paper: 'receipt' | 'kitchen',
): void {
  if (hasCapability(session.role, 'order.history')) return;
  const order = findOrder(db, orderId);
  if (!order) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
  assertCounterMaySee(db, session, order, paper);
}

/**
 * The customer on an order is changed only while the order is still being
 * rung up. A bill that was sent, paid, cancelled or reported to FBR / SRB is
 * never quietly given another name, phone or address (for anyone: no screen
 * does it, and the website import writes through the repository directly).
 */
export function assertOrderStillBeingTaken(db: AppDatabase, orderId: string): void {
  const order = findOrder(db, orderId);
  if (!order) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
  if (order.status !== 'open') {
    throw new IpcGuardError({
      code: 'precondition_failed',
      message: 'The customer can only be changed while the order is still being taken',
    });
  }
}

/**
 * At the counter, the address put on an order is one of THAT customer's own
 * saved addresses (or none). Managers keep the house-number search, which can
 * pick another customer's saved house on purpose, so they are not limited.
 */
export function assertCounterAddress(
  db: AppDatabase,
  session: AuthenticatedUser,
  customerId: string,
  addressId: string | null | undefined,
): void {
  if (!addressId || hasCapability(session.role, 'customers.manage')) return;
  if (!listAddresses(db, customerId).some((a) => a.id === addressId)) {
    throw new IpcGuardError({
      code: 'precondition_failed',
      message: 'That address is not saved for this customer',
    });
  }
}
