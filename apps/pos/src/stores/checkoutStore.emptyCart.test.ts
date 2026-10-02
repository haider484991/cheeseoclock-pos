/**
 * The owner, 2 Oct 2026 (Live Orders timing): "discard an emptied cart
 * instead of reusing it". A cart whose every line was taken off is not the
 * next customer's: the next item starts a new order (orders:create drops the
 * emptied one in the main process), so the new order has its own number and
 * its own start time. Two carts stay as they are: one with a line on it, and
 * a Delivery whose details already have an area typed (it is this
 * customer's, and a delivery charge taken off by hand stays off). Send and
 * Pay then save the customer typed in on the NEW order. Nothing calls the
 * till: the IPC client is a stand-in that keeps the orders in memory and
 * records the calls. Ids, names and numbers are made up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Line {
  id: string;
  menuItemId: string;
  quantity: number;
  modifiers: never[];
  notes: null;
}
interface HeldOrder {
  mode: string;
  status: string;
  items: Line[];
}

const till = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  orders: new Map<string, HeldOrder>(),
  nextOrder: 2,
  nextLine: 1,
  nextCustomer: 1,
}));

vi.mock('../ipc/client', () => {
  const snapOf = (id: string) => {
    const o = till.orders.get(id);
    if (!o) throw new Error(`No order ${id}`);
    return {
      order: { id, status: o.status, mode: o.mode, source: 'pos', tableId: null },
      items: o.items.map((l) => ({ ...l })),
      discounts: [],
    };
  };
  const record =
    (name: string, reply: (input: unknown) => unknown = () => ({})) =>
    async (input: unknown) => {
      till.calls.push([name, input]);
      return reply(input);
    };
  return {
    ipc: {
      orders: {
        create: record('orders.create', (input) => {
          const id = `o${till.nextOrder++}`;
          till.orders.set(id, { mode: (input as { mode: string }).mode, status: 'open', items: [] });
          return { id };
        }),
        get: record('orders.get', (id) => snapOf(String(id))),
        addItem: record('orders.addItem', (input) => {
          const { orderId, menuItemId, quantity } = input as { orderId: string; menuItemId: string; quantity: number };
          till.orders.get(orderId)!.items.push({ id: `l${till.nextLine++}`, menuItemId, quantity, modifiers: [], notes: null });
          return snapOf(orderId);
        }),
        updateItemQuantity: record('orders.updateItemQuantity', (input) => {
          const { orderId, orderItemId, quantity } = input as { orderId: string; orderItemId: string; quantity: number };
          const o = till.orders.get(orderId)!;
          o.items = o.items.flatMap((l) => (l.id !== orderItemId ? [l] : quantity > 0 ? [{ ...l, quantity }] : []));
          return snapOf(orderId);
        }),
        removeItem: record('orders.removeItem', (input) => {
          const { orderId, orderItemId } = input as { orderId: string; orderItemId: string };
          const o = till.orders.get(orderId)!;
          o.items = o.items.filter((l) => l.id !== orderItemId);
          return snapOf(orderId);
        }),
        setNote: record('orders.setNote'),
        sendToKitchen: record('orders.sendToKitchen', (id) => {
          till.orders.get(String(id))!.status = 'sent_to_kitchen';
          return snapOf(String(id));
        }),
      },
      customers: {
        get: record('customers.get', (id) => ({ id, name: 'Test Customer', addresses: [] })),
        findByPhone: record('customers.findByPhone', () => null),
        create: record('customers.create', () => ({ id: `c_${till.nextCustomer++}` })),
        createAddress: record('customers.createAddress', () => ({ id: `a_${till.nextCustomer++}` })),
        attachToOrder: record('customers.attachToOrder'),
      },
    },
  };
});

import type { CameBy, OrderMode, OrderSnapshot } from '@cheeseoclock/shared-types';
import { ipc } from '../ipc/client';
import { useCheckoutStore } from './checkoutStore';
import { getCustomerFormSnapshot, resetCustomerForm, setCustomerForm } from '../features/checkout/useCustomerForm';
import { makeEmptyCustomerForm } from '../features/checkout/CustomerInlinePanel';

const made = (name: string) => till.calls.filter(([n]) => n === name).map(([, input]) => input);
const held = () => useCheckoutStore.getState().snapshot;

/** Order o1 on the screen, with these lines (menu item ids) on it. */
async function holdOrder(mode: OrderMode, menuItemIds: string[], cameBy: CameBy | null = null): Promise<OrderSnapshot> {
  till.orders.set('o1', {
    mode,
    status: 'open',
    items: menuItemIds.map((menuItemId) => ({ id: `l${till.nextLine++}`, menuItemId, quantity: 1, modifiers: [], notes: null })),
  });
  const snap = (await ipc.orders.get('o1')) as OrderSnapshot;
  useCheckoutStore.setState({ snapshot: snap, mode, tableId: null, cameBy });
  till.calls.length = 0;
  return snap;
}

afterEach(async () => {
  useCheckoutStore.getState().reset();
  await Promise.resolve();
  resetCustomerForm();
  till.calls.length = 0;
  till.orders.clear();
  till.nextOrder = 2;
  till.nextLine = 1;
  till.nextCustomer = 1;
});

describe('an emptied cart is not the next customer’s: the next item starts a new order', () => {
  it('every line taken off, then an item: orders.create (mode and came-by chip), and the item lands on the NEW order', async () => {
    const snap = await holdOrder('takeaway', ['m_cola'], 'phone');
    await useCheckoutStore.getState().removeItem(snap.items[0]!.id);
    expect(held()?.order.id).toBe('o1');
    expect(held()?.items).toEqual([]);

    await useCheckoutStore.getState().addItem('m_pizza');
    expect(made('orders.create')).toEqual([{ mode: 'takeaway', tableId: null, cameBy: 'phone' }]);
    expect(made('orders.addItem')).toEqual([
      { orderId: 'o2', menuItemId: 'm_pizza', quantity: 1, modifierIds: [], notes: null },
    ]);
    expect(held()?.order.id).toBe('o2');
    expect(held()?.items.map((l) => l.menuItemId)).toEqual(['m_pizza']);
    // Nothing more went on the emptied one.
    expect(till.orders.get('o1')?.items).toEqual([]);
  });

  it('emptied with − down to nothing: the same', async () => {
    const snap = await holdOrder('takeaway', ['m_cola']);
    await useCheckoutStore.getState().bumpItemQty(snap.items[0]!.id, -1);
    expect(held()?.items).toEqual([]);
    await useCheckoutStore.getState().addItem('m_pizza');
    expect(made('orders.create')).toHaveLength(1);
    expect(made('orders.addItem')).toEqual([expect.objectContaining({ orderId: 'o2', menuItemId: 'm_pizza' })]);
    expect(held()?.order.id).toBe('o2');
  });

  it('a cart with a line on it: no new order, the item goes on the same one', async () => {
    await holdOrder('takeaway', ['m_cola']);
    await useCheckoutStore.getState().addItem('m_pizza');
    expect(made('orders.create')).toEqual([]);
    expect(made('orders.addItem')).toEqual([expect.objectContaining({ orderId: 'o1', menuItemId: 'm_pizza' })]);
    expect(held()?.order.id).toBe('o1');
  });

  it('an emptied Delivery with an area typed is kept (the charge taken off by hand stays off); with no area it is not', async () => {
    // The delivery charge taken off by hand, every line gone, the area still in the details.
    await holdOrder('delivery', []);
    setCustomerForm({ ...makeEmptyCustomerForm(), area: 'Test Area' });
    await useCheckoutStore.getState().addItem('m_pizza');
    expect(made('orders.create')).toEqual([]);
    expect(made('orders.addItem')).toEqual([expect.objectContaining({ orderId: 'o1', menuItemId: 'm_pizza' })]);
    expect(held()?.order.id).toBe('o1');

    // The same with the area box empty (only spaces): a new delivery.
    await holdOrder('delivery', []);
    setCustomerForm({ ...makeEmptyCustomerForm(), area: '  ' });
    await useCheckoutStore.getState().addItem('m_pizza');
    expect(made('orders.create')).toEqual([{ mode: 'delivery', tableId: null }]);
    expect(held()?.order.id).toBe('o2');
  });

  it('Send saves the customer typed in on the NEW order (not on the emptied one Pay saved it on)', async () => {
    const snap = await holdOrder('takeaway', ['m_cola']);
    setCustomerForm({ ...makeEmptyCustomerForm(), name: 'Test Customer', phone: '03001234567' });
    // Pay opened on o1 (it saves the customer there), then closed; the cola taken off.
    await useCheckoutStore.getState().prepareToPay();
    expect(made('customers.attachToOrder')).toEqual([expect.objectContaining({ orderId: 'o1' })]);
    await useCheckoutStore.getState().removeItem(snap.items[0]!.id);

    await useCheckoutStore.getState().addItem('m_pizza');
    expect(held()?.order.id).toBe('o2');
    const sent = await useCheckoutStore.getState().sendToKitchen();
    expect(sent.order).toMatchObject({ id: 'o2', status: 'sent_to_kitchen' });
    expect(made('orders.sendToKitchen')).toEqual(['o2']);
    // Saved again, on o2, as the same customer (not made a second time).
    const attached = made('customers.attachToOrder') as Array<{ orderId: string; customerId: string }>;
    expect(attached.map((a) => a.orderId)).toEqual(['o1', 'o2']);
    expect(attached[1]?.customerId).toBe(attached[0]?.customerId);
    expect(made('customers.create')).toHaveLength(1);
    expect(getCustomerFormSnapshot().matchedCustomerId).toBe(attached[0]?.customerId);
  });
});
