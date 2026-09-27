import { formatCents } from '@cheeseoclock/pos-domain';
import type {
  DeletedTestOrderRow,
  OrderStatus,
  Role,
  TestDeletePreview,
  TestDeleteResult,
  TestDeleteStockState,
} from '@cheeseoclock/shared-types';
import { PAYMENT_LABELS, shortOrderNumber } from './historyFilters';

/**
 * The words of "Delete test order" (the owner only, migration 0043): the
 * dialog, the toast after it and the owner's list of deleted test orders.
 * Pure, so they are tested on their own. The main process decides what may
 * be deleted and does it (order-repo deleteTestOrder); these only say it.
 */

/**
 * Whether the order panel offers "Delete test order…": the owner (admin)
 * login only, and never for a cart still being rung up. The main process
 * checks again, and asks for the owner's PIN or password.
 */
export function mayDeleteTestOrder(role: Role | null | undefined, status: OrderStatus | null | undefined): boolean {
  return role === 'admin' && !!status && status !== 'open';
}

export const TEST_DELETE_INTRO =
  'Only for orders made to test the till. The order disappears from sales, reports, the shift’s cash and the customer’s history. It stays in the owner’s list of deleted test orders and cannot be brought back.';

export const TEST_DELETE_REAL_ORDER = 'A real order? Close this and use Cancel or Refund.';

export const TEST_DELETE_STOCK_QUESTION = 'Put the stock back?';
export const TEST_DELETE_PUT_BACK = 'Yes — put it back (the food was not made)';
export const TEST_DELETE_WASTE = 'No — count it as waste (the food was made)';

/** When the order holds no stock to settle: why the question is not asked. */
export function testDeleteStockLine(state: TestDeleteStockState): string | null {
  switch (state) {
    case 'none':
      return 'This order took no stock.';
    case 'returned_before':
      return 'Its stock was already put back when it was cancelled.';
    case 'wasted_before':
      return 'Its food was already counted as waste when it was cancelled.';
    default:
      return null;
  }
}

/** "Paid — Cash Rs 1,250 + Card Rs 500", or "Not paid". */
export function testDeletePaidLine(paid: TestDeletePreview['paid']): string {
  const parts = paid.filter((p) => p.netCents !== 0).map((p) => `${PAYMENT_LABELS[p.method]} ${formatCents(p.netCents)}`);
  return parts.length > 0 ? `Paid — ${parts.join(' + ')}` : 'Not paid';
}

/** What deleting does to money: one line per shift for cash, one per other method. */
export function testDeleteCashLines(preview: Pick<TestDeletePreview, 'cash' | 'paid'>): string[] {
  const lines: string[] = [];
  for (const c of preview.cash) {
    if (c.netCents === 0) continue;
    const rs = formatCents(Math.abs(c.netCents));
    if (c.open) {
      lines.push(
        c.netCents > 0
          ? `This shift’s expected cash goes down by ${rs}. If no real money went into the drawer for this test, the count will now match. If real money did go in, take it out.`
          : `This shift’s expected cash goes up by ${rs} (more was handed back than taken).`,
      );
    } else {
      lines.push(
        `The shift that took this money is already closed. Its saved count and short/over do not change; Reports will note ${rs} of deleted test orders on that shift.`,
      );
    }
  }
  for (const p of preview.paid) {
    if (p.method === 'cash' || p.netCents === 0) continue;
    const label = PAYMENT_LABELS[p.method];
    if (p.method === 'foodpanda') {
      // foodpanda pays foodpanda, never the drawer: nothing to take out of it.
      lines.push(
        `${label} ${formatCents(p.netCents)} comes off the ${label.toLowerCase()} total, and the order leaves foodpanda’s figures on Reports → Channels (what foodpanda keeps, the payout expected, the orders to check). No cash went into the drawer for it.`,
      );
      continue;
    }
    lines.push(`${label} ${formatCents(p.netCents)} comes off the ${label.toLowerCase()} total.`);
  }
  if (lines.length === 0) lines.push('No money is left on this order, so no cash or card total changes.');
  return lines;
}

/** The other things deleting does, when they apply. */
export function testDeleteAlsoLines(preview: Pick<TestDeletePreview, 'kitchenSlip' | 'web'>): string[] {
  const out: string[] = [];
  if (preview.kitchenSlip) out.push('The kitchen gets a CANCELLED slip.');
  if (preview.web) out.push('The website will show the order as cancelled.');
  return out;
}

/** Why the Delete button is still greyed out (null when everything is filled in). */
export function testDeleteMissing(input: {
  holdsStock: boolean;
  restock: boolean | null;
  reason: string;
  secret: string;
}): string | null {
  if (input.holdsStock && input.restock === null) return 'Choose whether to put the stock back.';
  if (!input.reason.trim()) return 'Write why this was a test order.';
  if (!input.secret) return 'Type your owner PIN or password.';
  return null;
}

/** The toast after deleting: "Order #0042 deleted as a test order. Stock put back. …" */
export function testDeleteToast(r: Pick<TestDeleteResult, 'orderNumber' | 'deleteStock' | 'cash'>): string {
  let text = `Order ${shortOrderNumber(r.orderNumber)} deleted as a test order.`;
  if (r.deleteStock === 'put_back') text += ' Stock put back.';
  else if (r.deleteStock === 'waste') text += ' Its food is counted as waste.';
  const openCash = r.cash.filter((c) => c.open).reduce((n, c) => n + c.netCents, 0);
  if (openCash > 0) text += ` This shift’s expected cash is now ${formatCents(openCash)} lower.`;
  return text;
}

/** The Stock column of the owner's list. */
export function deletedStockWords(row: Pick<DeletedTestOrderRow, 'deleteStock' | 'wasteCents'>): string {
  switch (row.deleteStock) {
    case 'put_back':
      return 'Put back';
    case 'waste':
      return row.wasteCents > 0 ? `Waste ${formatCents(row.wasteCents)}` : 'Waste';
    case 'none':
      return 'No stock';
    case 'settled_before':
      return 'Dealt with when cancelled';
    default:
      return '—';
  }
}

/** The Paid column of the owner's list. */
export function deletedPaidWords(row: Pick<DeletedTestOrderRow, 'paidCents' | 'paidMethods'>): string {
  if (row.paidCents === 0 && row.paidMethods.length === 0) return 'Not paid';
  const how = row.paidMethods.map((m) => PAYMENT_LABELS[m] ?? m).join(' + ');
  return `${formatCents(row.paidCents)}${how ? ` ${how}` : ''}`;
}
