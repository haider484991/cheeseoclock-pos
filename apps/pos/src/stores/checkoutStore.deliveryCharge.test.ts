/**
 * The owner, 28 Sep 2026: "if delivery area selected the delivery fee should
 * be automatically added". The customer panel asks the main process a moment
 * after the area last changed (DeliveryChargeRow, 250 ms), so Send, Pay
 * opening (v0.7.28's early customer save) and the payment put a pending
 * charge on THEMSELVES before the order is handed off — a quick F2 or Pay
 * never sends a delivery with its area and no charge. What the panel already
 * asked is never asked again (a charge taken off by hand stays off), and the
 * panel's late ask neither asks twice nor starts a new order once the order
 * has been sent. Nothing calls the till: the IPC client is a stand-in that
 * records the calls. Order ids and areas are made up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrderSnapshot } from '@cheeseoclock/shared-types';

const calls = vi.hoisted(() => ({ list: [] as Array<[string, unknown]>, failNext: null as string | null }));
vi.mock('../ipc/client', () => {
  const order = (status: string) => ({
    order: { id: 'o1', status, mode: 'delivery', source: 'pos', tableId: null },
    items: [],
    discounts: [],
  });
  const record =
    (name: string, reply: (input: unknown) => unknown = () => ({})) =>
    async (input: unknown) => {
      calls.list.push([name, input]);
      if (calls.failNext === name) {
        calls.failNext = null;
        throw new Error('Test refusal');
      }
      return reply(input);
    };
  return {
    ipc: {
      orders: {
        create: record('orders.create', () => ({ id: 'o2' })),
        setNote: record('orders.setNote'),
        get: record('orders.get', () => order('open')),
        setDeliveryArea: record('orders.setDeliveryArea', () => order('open')),
        sendToKitchen: record('orders.sendToKitchen', () => order('sent')),
        tender: record('orders.tender', () => order('paid')),
      },
      customers: {},
    },
  };
});

import { useCheckoutStore } from './checkoutStore';
import { resetCustomerForm, setCustomerForm } from '../features/checkout/useCustomerForm';
import { makeEmptyCustomerForm } from '../features/checkout/CustomerInlinePanel';
import { forgetDeliveryChargeAsked, noteDeliveryChargeAsked, type DeliveryChargeAskState } from '../features/checkout/deliveryChargeAsk';

const names = () => calls.list.map(([n]) => n);
const made = (name: string) => calls.list.filter(([n]) => n === name).map(([, input]) => input);
const openOrder = (mode: 'delivery' | 'takeaway') =>
  ({ order: { id: 'o1', status: 'open', mode, source: 'pos', tableId: null }, items: [], discounts: [] }) as unknown as OrderSnapshot;

/** A delivery on screen with this area typed or picked on the customer panel (nothing else typed). */
function deliveryWithArea(area: string, mode: 'delivery' | 'takeaway' = 'delivery'): void {
  useCheckoutStore.setState({ snapshot: openOrder(mode), mode });
  setCustomerForm({ ...makeEmptyCustomerForm(), area });
}
/** What the panel's row asks with (its effect's key) for the open order. */
const panelAsk = (area: string): DeliveryChargeAskState => ({ orderId: 'o1', mode: 'delivery', area, wouldAdd: true });

afterEach(async () => {
  calls.list.length = 0;
  calls.failNext = null;
  useCheckoutStore.getState().reset();
  await Promise.resolve();
  resetCustomerForm();
  forgetDeliveryChargeAsked();
});

describe('Send and Pay put the picked area’s delivery charge on before the order leaves', () => {
  it('F2 before the panel asked: the charge goes on, THEN the order is sent; the panel’s late ask asks nothing and starts no order', async () => {
    deliveryWithArea('DHA Phase 6');
    await useCheckoutStore.getState().sendToKitchen();
    expect(made('orders.setDeliveryArea')).toEqual([{ orderId: 'o1', area: 'DHA Phase 6' }]);
    expect(names().indexOf('orders.setDeliveryArea')).toBeLessThan(names().indexOf('orders.sendToKitchen'));

    // The panel's 250 ms ask fires after Send (the screen not cleared yet).
    await useCheckoutStore.getState().setDeliveryArea('DHA Phase 6', { mayStartOrder: true, ask: panelAsk('DHA Phase 6') });
    // Any other ask that lands before the screen clears: the sent order is not replaced by a new one.
    await useCheckoutStore.getState().setDeliveryArea('DHA Phase 8', { mayStartOrder: true });
    expect(made('orders.setDeliveryArea')).toHaveLength(1);
    expect(made('orders.create')).toEqual([]);
  });

  it('Pay: the early customer save puts the charge on before Pay opens (the bill Pay shows is final); the payment does not ask again', async () => {
    deliveryWithArea('DHA Phase 8');
    await useCheckoutStore.getState().prepareToPay();
    expect(names()).toEqual(['orders.setNote', 'orders.setDeliveryArea', 'orders.get']);
    expect(made('orders.setDeliveryArea')).toEqual([{ orderId: 'o1', area: 'DHA Phase 8' }]);
    // The panel's ask for the same area, queued behind Pay: nothing.
    await useCheckoutStore.getState().setDeliveryArea('DHA Phase 8', { mayStartOrder: true, ask: panelAsk('DHA Phase 8') });
    await useCheckoutStore.getState().tender([]);
    expect(made('orders.setDeliveryArea')).toHaveLength(1);
    expect(made('orders.tender')).toHaveLength(1);
  });

  it('the panel asked first: Send does not ask again — a charge the cashier then took off by hand stays off', async () => {
    deliveryWithArea('DHA Phase 6');
    await useCheckoutStore.getState().setDeliveryArea('DHA Phase 6', { mayStartOrder: true, ask: panelAsk('DHA Phase 6') });
    expect(made('orders.setDeliveryArea')).toHaveLength(1);
    // (the × on the charge line, on "Review order")
    await useCheckoutStore.getState().sendToKitchen();
    expect(made('orders.setDeliveryArea')).toHaveLength(1);
    expect(made('orders.sendToKitchen')).toHaveLength(1);
  });

  it('the area cleared after one was asked about: Send takes the charge off; an area that was never there asks nothing', async () => {
    noteDeliveryChargeAsked(panelAsk('DHA Phase 6'));
    deliveryWithArea('');
    await useCheckoutStore.getState().sendToKitchen();
    expect(made('orders.setDeliveryArea')).toEqual([{ orderId: 'o1', area: null }]);

    calls.list.length = 0;
    forgetDeliveryChargeAsked();
    deliveryWithArea('');
    await useCheckoutStore.getState().sendToKitchen();
    expect(made('orders.setDeliveryArea')).toEqual([]);
  });

  it('a takeaway never asks (the main process took any charge off with the type)', async () => {
    deliveryWithArea('DHA Phase 6', 'takeaway');
    await useCheckoutStore.getState().sendToKitchen();
    await useCheckoutStore.getState().prepareToPay();
    expect(made('orders.setDeliveryArea')).toEqual([]);
  });

  it('the till refuses the charge: Send stops with the reason and nothing is sent; the next Send asks again', async () => {
    deliveryWithArea('DHA Phase 6');
    calls.failNext = 'orders.setDeliveryArea';
    await expect(useCheckoutStore.getState().sendToKitchen()).rejects.toThrow('Could not put the delivery charge on: Test refusal');
    expect(made('orders.sendToKitchen')).toEqual([]);
    await useCheckoutStore.getState().sendToKitchen();
    expect(made('orders.setDeliveryArea')).toHaveLength(2);
    expect(made('orders.sendToKitchen')).toHaveLength(1);
  });
});
