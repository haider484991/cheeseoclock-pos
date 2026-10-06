import { BUY_1_GET_1_CLOSED_MESSAGE, buy1Get1AllowedOn, isBuy1Get1Category } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import { IpcGuardError } from './registry.js';

/**
 * Buy 1 Get 1 deals are sold from 1 PM to 7 PM (shared-types buy-1-get-1.ts): a counter add or an edit that puts one
 * on an order outside those hours is refused, in the cashier's words, unless the order was started inside them.
 * Website orders are not checked here — the website refused them outside the hours already, and an order placed at
 * 6:59 PM must still go in when the till fetches it at 7:01.
 */
export function assertBuy1Get1Hours(
  db: AppDatabase,
  orderId: string,
  menuItemIds: readonly string[],
  nowMs: number = Date.now(),
): void {
  if (menuItemIds.length === 0) return;
  const categoryOf = db.prepare(
    'SELECT c.name AS name FROM menu_items mi JOIN categories c ON c.id = mi.category_id WHERE mi.id = ?',
  );
  const anyDeal = menuItemIds.some((id) => {
    const row = categoryOf.get(id) as { name: string } | undefined;
    return row !== undefined && isBuy1Get1Category(row.name);
  });
  if (!anyDeal) return;
  const order = db.prepare('SELECT created_at FROM orders WHERE id = ?').get(orderId) as { created_at: string } | undefined;
  if (buy1Get1AllowedOn(nowMs, order?.created_at)) return;
  throw new IpcGuardError({ code: 'precondition_failed', message: BUY_1_GET_1_CLOSED_MESSAGE });
}
