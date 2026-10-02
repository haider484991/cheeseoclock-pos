/**
 * The words for a refused item's part refund still owed (order-edit #5:
 * Delivered + Pay with "Customer refused an item" takes the rider's money for
 * the whole bill, and the part refund of the item settles what he did not
 * bring). Until that refund is done the drawer is short by the item; the
 * order and the Close shift box say so, in these words (OrderSnapshot
 * .refusedItem, RecentCounterOrder.refusedItemRefundOwed,
 * ShiftCloseCheck.refusedItemRefundsOwed).
 */

/** On the order (Recent Orders, Order History) while its refused item is not refunded yet. */
export const REFUSED_ITEM_OWED_TEXT = 'Customer refused an item - refund not done yet';

/** The short chip on a Recent Orders row. */
export const REFUSED_ITEM_OWED_CHIP = 'Refund not done';

/** One line of the Close shift box's list: "#0042: customer refused an item - refund not done yet". */
export function refusedItemOwedLine(orderNumber: string): string {
  return `#${orderNumber.split('-').pop() ?? orderNumber}: customer refused an item - refund not done yet`;
}
