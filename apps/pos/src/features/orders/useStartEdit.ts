import { useCallback } from 'react';
import { orderEditBlock } from '@cheeseoclock/pos-domain';
import type { Order } from '@cheeseoclock/shared-types';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { useToast } from '../../components/toast/ToastProvider';
import { currentPath, goTo } from '../../navigation';

/** The Edit order button shows only on an order the till would let you change (pos-domain orderEditBlock). */
export function offersEdit(order: Pick<Order, 'status' | 'paidAt' | 'mode'> & { readonly riderKeepsCents?: number | null }): boolean {
  return orderEditBlock(order) === null;
}

const short = (orderNumber: string) => orderNumber.split('-').pop() ?? orderNumber;

/**
 * Edit order (v0.7.36) from Live Orders or an order panel: the order opens at
 * Checkout to be changed, and the screen it was started from comes back
 * after Save or Cancel. The counter's own cart waits meanwhile (said when it
 * has items). One change at a time: another one still open is shown instead.
 * Refused in the till's words (paid, out, foodpanda…).
 */
export function useStartEdit(): (order: Pick<Order, 'id' | 'orderNumber'>) => Promise<void> {
  const { toast } = useToast();
  return useCallback(
    async (order) => {
      const store = useCheckoutStore.getState();
      if (store.edit) {
        if (store.edit.orderId !== order.id) {
          toast({
            title: `#${short(store.edit.base.order.orderNumber)} is still being changed`,
            description: 'Save or cancel that change first.',
            variant: 'warning',
          });
        }
        await goTo('/checkout');
        return;
      }
      try {
        await store.startEdit(order.id, currentPath('/orders'));
      } catch (e) {
        toast({ title: `#${short(order.orderNumber)} can’t be changed`, description: e instanceof Error ? e.message : 'Unknown error', variant: 'error' });
        return;
      }
      const parked = useCheckoutStore.getState().edit?.parked.snapshot ?? null;
      if (parked && parked.items.length > 0) {
        toast({ title: `#${short(parked.order.orderNumber)} is put aside`, description: 'The order you were ringing up comes back after this change.' });
      }
      await goTo('/checkout');
    },
    [toast],
  );
}
