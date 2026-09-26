/**
 * Who may print a customer paper again without a manager, and which orders
 * count as "the one in front of you now". Pure (the clock is passed in), so
 * it is tested on its own; the main process applies it (reprint-service.ts)
 * and the spooler uses isCurrentOrder for the "Printed later" line.
 *
 * The research behind it (2026-09-27): a reprinted receipt is how an old
 * customer's paid bill is handed to a new customer, and how a cashier who
 * pocketed cash shows "proof of payment". Oracle Simphony gives staff a few
 * prints of a check and then asks for a manager; Loyverse without "View all
 * receipts" limits reprints to the last few. So:
 *  - a manager or the owner never needs anyone's approval;
 *  - a bill (NOT PAID) and a cancelled-order slip carry no money: free for
 *    anyone, still logged and stamped DUPLICATE;
 *  - a PAID receipt: the cashier gets ONE paper by hand for a current order
 *    (the customer lost it, the post-payment Reprint with the FBR number);
 *    anything more, any order that is not current, a refunded order and the
 *    shop copy need a manager's PIN or password;
 *  - the first paper that carries the FBR number, after the receipt printed
 *    without it, does not use up that one paper.
 * Every paper is in the print log either way (document_prints).
 */
import { hasCapability, type OrderStatus, type PrintedDocument, type ReceiptCopy, type Role } from '@cheeseoclock/shared-types';

/** How long after the sale an order still counts as current (paid_at, or created_at while unpaid). */
export const REPRINT_FREE_WINDOW_MS = 30 * 60_000;

/** Papers a cashier may print by hand for one paid receipt of a current order. */
export const FREE_CASHIER_REPRINTS = 1;

/** The Live Orders board: an order that is still being made or delivered is current, however old. */
export const CURRENT_STATUSES: readonly OrderStatus[] = ['sent_to_kitchen', 'preparing', 'ready', 'out_for_delivery'];

/** Kitchen tickets are printed again only while the kitchen still has the order. */
export const KITCHEN_REPRINT_STATUSES: readonly OrderStatus[] = ['sent_to_kitchen', 'preparing', 'ready'];

/**
 * The capability that lets someone reprint any paper of any order without
 * approval: Order History's ("opening or reprinting an old order") — managers
 * and the owner. Not 'order.refund': if cashiers ever get refunds (with a PIN
 * inside that flow) they must not silently lose the reprint check too.
 */
export const REPRINT_ANY_CAPABILITY = 'order.history' as const;

/** Still the order in front of the counter: on the board, or paid / taken within the window. */
export function isCurrentOrder(status: OrderStatus, lastActivityAt: string, nowMs: number): boolean {
  if (status === 'void' || status === 'refunded') return false;
  if (CURRENT_STATUSES.includes(status)) return true;
  const age = nowMs - Date.parse(lastActivityAt);
  return Number.isFinite(age) && age <= REPRINT_FREE_WINDOW_MS;
}

export interface ReprintApprovalInput {
  role: Role;
  /** The paper the press would print: what the order is now. */
  document: PrintedDocument;
  copy: ReceiptCopy;
  status: OrderStatus;
  /** paid_at, or created_at while unpaid. */
  lastActivityAt: string;
  nowMs: number;
  /** Papers of this series already printed by hand (the FBR copy not counted). */
  priorManual: number;
  /** All papers of this series so far (0: this would be the original). */
  priorAll: number;
  /** This press prints the first paper carrying the FBR number. */
  fbrCopy: boolean;
  /** "Order #0042" — for the message. */
  orderLabel: string;
}

export interface ReprintApproval {
  /** A manager's PIN or password is needed. */
  approval: boolean;
  /** Why, in words shown to the cashier (empty when no approval is needed). */
  why: string;
}

const FREE: ReprintApproval = { approval: false, why: '' };
const NEED = "A manager's PIN or password is needed";

export function reprintApproval(i: ReprintApprovalInput): ReprintApproval {
  if (hasCapability(i.role, REPRINT_ANY_CAPABILITY)) return FREE;
  // Nothing of cash value on it: a bill says NOT PAID, a cancelled order NOTHING TO PAY.
  if (i.document === 'bill' || i.document === 'void' || i.document === 'kitchen' || i.document === 'kitchen_cancel') {
    return FREE;
  }
  const paper = i.document === 'refund' ? 'refund slip' : 'receipt';
  if (i.copy === 'shop') {
    return { approval: true, why: `${NEED} to print the shop copy of ${i.orderLabel} again.` };
  }
  if (i.status === 'refunded') {
    return { approval: true, why: `${i.orderLabel} was refunded. ${NEED} to print its ${paper} again.` };
  }
  if (!isCurrentOrder(i.status, i.lastActivityAt, i.nowMs)) {
    return {
      approval: true,
      why: `${i.orderLabel} was paid more than ${REPRINT_FREE_WINDOW_MS / 60_000} minutes ago. ${NEED} to print its ${paper} now.`,
    };
  }
  if (i.fbrCopy) return FREE;
  if (i.priorManual >= FREE_CASHIER_REPRINTS) {
    const times = i.priorAll === 1 ? 'once' : `${i.priorAll} times`;
    return {
      approval: true,
      why: `${i.orderLabel}'s ${paper} was already printed ${times}. ${NEED} for another copy.`,
    };
  }
  return FREE;
}
