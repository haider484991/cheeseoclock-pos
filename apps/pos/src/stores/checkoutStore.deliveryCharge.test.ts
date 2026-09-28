/**
 * The owner, 28 Sep 2026: "if delivery area selected the delivery fee should
 * be automatically added". The main process puts the charge on with the
 * area on every path (order-repo deliveryChargeForArea): the customer
 * panel's area, and the customer saved at Send and Pay, in the same
 * transaction as the address. So Send and Pay need nothing of their own
 * before the order leaves (no screen timer to wait for, no second ask), and
 * the panel's late ask for an order that has since been sent — or cleared
 * off the screen — neither asks nor starts a new order. "Put it back" says
 * so to the main process. Nothing calls the till: the IPC client is a
 * stand-in that records the calls. Order ids and areas are made up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrderSnapshot } from '@cheeseoclock/shared-types';

const calls = vi.hoisted(() => ({ list: [] as Array<[string, unknown]> }));
vi.mock('../ipc/client', () => {
  const order = (id: string, status: string) => ({
    order: { id, status, mode: 'delivery', source: 'pos', tableId: null },
    items: [],
    discounts: [],
  });
  const record =
    (name: string, reply: (input: unknown) => unknown = () => ({})) =>
    async (input: unknown) => {
      calls.list.push([name, input]);
      return reply(input);
    };
  return {
    ipc: {
      orders: {
        create: record('orders.create', () => ({ id: 'o2' })),
        setNote: record('orders.setNote'),
        get: record('orders.get', (id) => order(String(id), 'open')),
        setDeliveryArea: record('orders.setDeliveryArea', (input) => order((input as { orderId: string }).orderId, 'open')),
        sendToKitchen: record('orders.sendToKitchen', () => order('o1', 'sent_to_kitchen')),
        tender: record('orders.tender', () => order('o1', 'paid')),
      },
      customers: {},
    },
  };
});

import { useCheckoutStore } from './checkoutStore';
import { resetCustomerForm, setCustomerForm } from '../features/checkout/useCustomerForm';
import { makeEmptyCustomerForm } from '../features/checkout/CustomerInlinePanel';

const names = () => calls.list.map(([n]) => n);
const made = (name: string) => calls.list.filter(([n]) => n === name).map(([, input]) => input);
const openOrder = (mode: 'delivery' | 'takeaway') =>
  ({ order: { id: 'o1', status: 'open', mode, source: 'pos', tableId: null }, items: [], discounts: [] }) as unknown as OrderSnapshot;

/** A delivery on screen with this area typed or picked on the customer panel (nothing else typed). */
function deliveryWithArea(area: string, mode: 'delivery' | 'takeaway' = 'delivery'): void {
  useCheckoutStore.setState({ snapshot: openOrder(mode), mode });
  setCustomerForm({ ...makeEmptyCustomerForm(), area });
}

afterEach(async () => {
  calls.list.length = 0;
  useCheckoutStore.getState().reset();
  await Promise.resolve();
  resetCustomerForm();
});

describe('the area’s delivery charge needs nothing from Send or Pay (the main process puts it on with the saved address)', () => {
  it('F2 straight after picking the area: Send saves the customer and sends — no ask of its own, nothing to wait for', async () => {
    deliveryWithArea('DHA Phase 6');
    await useCheckoutStore.getState().sendToKitchen();
    expect(made('orders.setDeliveryArea')).toEqual([]);
    expect(names()).toContain('orders.sendToKitchen');
  });

  it('Pay opening and the payment: no ask of their own either', async () => {
    deliveryWithArea('DHA Phase 8');
    await useCheckoutStore.getState().prepareToPay();
    await useCheckoutStore.getState().tender([]);
    expect(made('orders.setDeliveryArea')).toEqual([]);
    expect(made('orders.tender')).toHaveLength(1);
  });

  it('the panel’s late ask for an order already sent does nothing — before the screen clears, and after (never a new order)', async () => {
    deliveryWithArea('DHA Phase 6');
    await useCheckoutStore.getState().sendToKitchen();
    // Before the screen clears: the sent order is still in hand.
    await useCheckoutStore.getState().setDeliveryArea('DHA Phase 6', { mayStartOrder: true, forOrderId: 'o1' });
    // After it clears (reset): the ask was for o1, which has left the screen.
    useCheckoutStore.getState().reset();
    await useCheckoutStore.getState().setDeliveryArea('DHA Phase 6', { mayStartOrder: true, forOrderId: 'o1' });
    expect(made('orders.setDeliveryArea')).toEqual([]);
    expect(made('orders.create')).toEqual([]);
    expect(useCheckoutStore.getState().snapshot).toBeNull();
  });

  it('the panel tells the main process the area (it decides whether it changed); “Put it back” says so', async () => {
    deliveryWithArea('DHA Phase 6');
    await useCheckoutStore.getState().setDeliveryArea(' DHA Phase 6 ', { mayStartOrder: true, forOrderId: 'o1' });
    await useCheckoutStore.getState().setDeliveryArea('DHA Phase 6', { putBack: true, forOrderId: 'o1' });
    await useCheckoutStore.getState().setDeliveryArea('', { forOrderId: 'o1' });
    expect(made('orders.setDeliveryArea')).toEqual([
      { orderId: 'o1', area: 'DHA Phase 6' },
      { orderId: 'o1', area: 'DHA Phase 6', putBack: true },
      { orderId: 'o1', area: null },
    ]);
  });

  it('no order yet: an area with a charge starts one to carry it; one without (or not a delivery) starts none', async () => {
    useCheckoutStore.setState({ snapshot: null, mode: 'delivery' });
    await useCheckoutStore.getState().setDeliveryArea('Gulshan Block 13', { mayStartOrder: false, forOrderId: null });
    useCheckoutStore.setState({ mode: 'takeaway' });
    await useCheckoutStore.getState().setDeliveryArea('DHA Phase 6', { mayStartOrder: true, forOrderId: null });
    expect(made('orders.create')).toEqual([]);
    useCheckoutStore.setState({ mode: 'delivery' });
    await useCheckoutStore.getState().setDeliveryArea('DHA Phase 6', { mayStartOrder: true, forOrderId: null });
    expect(made('orders.create')).toHaveLength(1);
    expect(made('orders.setDeliveryArea')).toEqual([{ orderId: 'o2', area: 'DHA Phase 6' }]);
  });
});
