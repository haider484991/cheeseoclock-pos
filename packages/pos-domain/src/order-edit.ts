/**
 * Edit order (v0.7.36): which orders the kitchen already has may still be
 * changed, and what an edit changes, as the kitchen slip and Save need it.
 *
 * The owner, 2 Oct 2026: same order number; the kitchen gets a slip with
 * only the ADDED or REMOVED items; adding is any cashier's, taking off needs
 * a manager's PIN, with "Was the food made?" for that item only; not once the
 * bill is with the rider or the order is paid (Refund then). The user, 3 Oct
 * 2026: a discount forgotten at the counter goes on until the order is paid,
 * and a Free order (100% off, value deals and delivery charge included) needs
 * a manager's PIN and a reason.
 *
 * Pure: the main process (order-edit-repo.ts) and the screens apply it.
 */
import { isDeliveryChargeLine } from '@cheeseoclock/shared-types';
import type { Order, OrderEditBlock, OrderEditChangeLine, OrderEditDiff, OrderEditNeeds, OrderStatus } from '@cheeseoclock/shared-types';

/** The kitchen's states in which an order it has may still be changed. */
export const EDITABLE_STATUSES: readonly OrderStatus[] = ['sent_to_kitchen', 'preparing', 'ready'];

/**
 * Why this order can't be changed now, or null when it can:
 *   not_sent  — still being rung up: it is changed on the Checkout screen;
 *   paid      — the customer (or the rider) paid: Refund, or a new order;
 *   out       — the food left (a rider took it, or an outside rider's
 *               charge is frozen on it): Refund, or a new order;
 *   closed    — handed over, cancelled or refunded;
 *   foodpanda — foodpanda's orders are paid and changed on the tablet.
 */
export function orderEditBlock(
  order: Pick<Order, 'status' | 'paidAt' | 'mode'> & { readonly riderKeepsCents?: number | null },
): OrderEditBlock | null {
  if (order.mode === 'foodpanda') return 'foodpanda';
  if (order.status === 'open') return 'not_sent';
  if (order.paidAt !== null) return 'paid';
  if (order.status === 'out_for_delivery' || typeof order.riderKeepsCents === 'number') return 'out';
  if (!EDITABLE_STATUSES.includes(order.status)) return 'closed';
  return null;
}

/** What the screens and the main process say when an order can't be changed. */
export const ORDER_EDIT_REFUSED: Readonly<Record<OrderEditBlock, string>> = {
  not_sent: 'This order has not gone to the kitchen yet — change it on the Checkout screen.',
  paid: 'This order is paid. Take an item off with Refund, or ring extra items as a new order.',
  out: 'This order has left the shop. Take an item off with Refund, or ring extra items as a new order.',
  closed: 'This order is finished, so it can’t be changed.',
  foodpanda: 'A foodpanda order is changed on the foodpanda tablet.',
};

/** An order line as an edit compares it. */
export interface EditableLine {
  readonly id: string;
  readonly menuItemName: string;
  readonly menuItemId?: string | null;
  readonly quantity: number;
  readonly modifiers: ReadonlyArray<{ readonly modifierName: string }>;
  readonly notes: string | null;
}

function changeLine(line: EditableLine, quantity: number): OrderEditChangeLine {
  return {
    lineId: line.id,
    menuItemName: line.menuItemName,
    quantity,
    modifiers: line.modifiers.map((m) => m.modifierName),
    notes: line.notes,
    fee: isDeliveryChargeLine(line),
  };
}

/** Same choices, in the same order, and the same note. */
function sameMaking(a: EditableLine, b: EditableLine): boolean {
  if ((a.notes ?? null) !== (b.notes ?? null)) return false;
  if (a.modifiers.length !== b.modifiers.length) return false;
  return a.modifiers.every((m, i) => m.modifierName === b.modifiers[i]?.modifierName);
}

/**
 * What an edit changes, line by line (by line id): a line the order had that
 * now has more is ADDED the difference, one with fewer (or gone) is REMOVED
 * the difference; a new line is ADDED whole; a line whose choices or note
 * changed is REMOVED as it was and ADDED as it is. Added lines in the order
 * they are now on the order, removed ones in the order they were.
 */
export function diffOrderLines(
  before: ReadonlyArray<EditableLine>,
  after: ReadonlyArray<EditableLine>,
): { added: OrderEditChangeLine[]; removed: OrderEditChangeLine[] } {
  const was = new Map(before.map((l) => [l.id, l]));
  const now = new Map(after.map((l) => [l.id, l]));
  const added: OrderEditChangeLine[] = [];
  const removed: OrderEditChangeLine[] = [];
  for (const b of before) {
    const a = now.get(b.id);
    if (!a) {
      if (b.quantity > 0) removed.push(changeLine(b, b.quantity));
    } else if (!sameMaking(a, b)) {
      if (b.quantity > 0) removed.push(changeLine(b, b.quantity));
    } else if (a.quantity < b.quantity) {
      removed.push(changeLine(b, b.quantity - a.quantity));
    }
  }
  for (const a of after) {
    const b = was.get(a.id);
    if (!b || !sameMaking(a, b)) {
      if (a.quantity > 0) added.push(changeLine(a, a.quantity));
    } else if (a.quantity > b.quantity) {
      added.push(changeLine(a, a.quantity - b.quantity));
    }
  }
  return { added, removed };
}

/** An edit that changes nothing at all: nothing to save. */
export function editChangesNothing(diff: Pick<OrderEditDiff, 'added' | 'removed' | 'discountChanged'>): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && !diff.discountChanged;
}

/**
 * What Save asks for (OrderEditNeeds): a manager's PIN when food or the
 * delivery charge the order had comes off, when the discount is over the
 * signed-in login's limit (`discountNeedsApproval`, worked out with the
 * shop's limits by the caller), or for a Free order; a reason when something
 * comes off or for a Free order. Adding is anyone's, with nothing to type.
 */
export function editNeeds(
  diff: Pick<OrderEditDiff, 'removed' | 'freeOrder'>,
  discountNeedsApproval: boolean,
): OrderEditNeeds {
  const why: string[] = [];
  const food = diff.removed.filter((l) => !l.fee);
  if (food.length > 0) why.push(food.length === 1 ? 'An item the kitchen has comes off' : 'Items the kitchen has come off');
  if (diff.removed.some((l) => l.fee)) why.push('The delivery charge comes off');
  if (diff.freeOrder) why.push('A Free order');
  else if (discountNeedsApproval) why.push('The discount is over the limit');
  return {
    pin: why.length > 0,
    why,
    reason: diff.removed.length > 0 || diff.freeOrder,
  };
}
