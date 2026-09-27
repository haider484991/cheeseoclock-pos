import type { PurchaseOrder } from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { mergePurchaseLists } from './purchase-view';

/** One cache for the purchase list: the Purchases tab, the tab bar's count and the Suppliers tab share it. */
export const PO_LIST_KEY = ['inventory', 'pos', 'list'] as const;

/** How many of the newest purchases the list holds (every open order comes on top of these). */
export const PO_RECENT_LIMIT = 2000;

/**
 * The Purchases list (costing spec Phase 5): the newest purchases, and every
 * order still open fetched on its own — market runs and drawer payouts are
 * purchases too now, so a list capped at the newest would otherwise, in a
 * busy year, drop an order still to be received.
 */
export async function fetchPurchaseList(): Promise<PurchaseOrder[]> {
  const [newest, open] = await Promise.all([
    ipc.inventory.listPurchaseOrders({ limit: PO_RECENT_LIMIT }),
    ipc.inventory.listPurchaseOrders({ open: true, limit: PO_RECENT_LIMIT }),
  ]);
  return mergePurchaseLists(newest, open);
}
