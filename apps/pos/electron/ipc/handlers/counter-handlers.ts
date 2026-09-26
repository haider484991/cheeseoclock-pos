import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok, hasCapability } from '@cheeseoclock/shared-types';
import { getCurrentSession } from '../../services/auth-service.js';
import { listRecentCounterOrders } from '../../db/repositories/counter-orders-repo.js';

/**
 * The counter's Recent Orders (owner, 2026-09-26). A cashier no longer has
 * Order History, but a customer back at the counter a few minutes after
 * pickup ("my drink is missing", "the receipt didn't print") is served there
 * and then: this till's orders of the shift open now, opened with the usual
 * order drawer — reprint, and refund / cancel with a manager's PIN. Toast's
 * quick order mode (own previous checks) and Loyverse without "View all
 * receipts" (the last few receipts) do the same. Anything older is a
 * manager's, in Order History.
 */
export function registerCounterHandlers(ctx: HandlerContext): void {
  defineHandler('orders:recentAtCounter', ctx, (_ctx, payload) => {
    const s = getCurrentSession();
    if (!s) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
    if (!hasCapability(s.role, 'order.create')) {
      throw new IpcGuardError({ code: 'forbidden', message: 'Order creation not allowed' });
    }
    // One order by its whole number, in the same scope as the list (a busy
    // shift is past the newest 20 within the hour).
    const orderNumber = typeof payload?.orderNumber === 'string' ? payload.orderNumber : undefined;
    return ok(listRecentCounterOrders(ctx.db, ctx.deviceId, orderNumber === undefined ? {} : { orderNumber }));
  });
}
