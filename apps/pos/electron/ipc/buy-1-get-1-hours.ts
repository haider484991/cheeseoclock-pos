import { buy1Get1AllowedOn, buy1Get1ClosedMessage, isBuy1Get1Category } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import { readBuy1Get1Rules } from '../db/business-settings-read.js';
import { IpcGuardError } from './registry.js';

/**
 * Buy 1 Get 1 deals are sold only while the owner's rules say so (Settings → Money & discounts → "Buy 1 Get 1
 * deals": on, every day 1 PM to 7 PM until changed; shared-types buy-1-get-1.ts): a counter add or an edit that puts
 * one on an order while they are off, or outside their hours, is refused in the cashier's words — unless the order
 * was started inside the hours. The rules are read on every call, so a Save here or on the other till counts at
 * once. Website orders are not checked here: the website refused them already, and an order placed at 6:59 PM must
 * still go in when the till fetches it at 7:01.
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
  const rules = readBuy1Get1Rules(db);
  const order = db.prepare('SELECT created_at FROM orders WHERE id = ?').get(orderId) as { created_at: string } | undefined;
  if (buy1Get1AllowedOn(nowMs, order?.created_at, rules)) return;
  throw new IpcGuardError({ code: 'precondition_failed', message: buy1Get1ClosedMessage(rules) });
}
