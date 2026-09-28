/**
 * Pay saves the customer typed in on the counter BEFORE it opens (so an
 * automatic offer that needs the phone is on the bill Pay shows). Closing
 * Pay and changing the form (the order note, say) saves it again at the next
 * Pay or Send — and that second save must reuse the customer and address
 * the first one made:
 *   - a typed delivery address is not added to the customer a second time;
 *   - a customer with a name and no phone is not created a second time
 *     (the first left orphaned).
 * Review, 28 Sep 2026 (screens). Nothing calls the till: the IPC client is a
 * stand-in that records the calls. Every name and address is made up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrderSnapshot } from '@cheeseoclock/shared-types';

const calls = vi.hoisted(() => ({ list: [] as Array<[string, unknown]>, seq: 0 }));
vi.mock('../ipc/client', () => {
  const record =
    (name: string, reply: (input: unknown) => unknown = () => ({})) =>
    async (input: unknown) => {
      calls.list.push([name, input]);
      return reply(input);
    };
  const snap = { order: { id: 'o1', status: 'open', mode: 'delivery', source: 'pos', tableId: null }, items: [], discounts: [] };
  return {
    ipc: {
      orders: { setNote: record('orders.setNote'), get: record('orders.get', () => snap) },
      customers: {
        get: record('customers.get', (id) => ({ id, name: 'Test Customer', addresses: [] })),
        findByPhone: record('customers.findByPhone', () => null),
        create: record('customers.create', () => ({ id: `c_${++calls.seq}` })),
        createAddress: record('customers.createAddress', () => ({ id: `a_${++calls.seq}` })),
        attachToOrder: record('customers.attachToOrder'),
      },
    },
  };
});

import { useCheckoutStore } from './checkoutStore';
import { getCustomerFormSnapshot, resetCustomerForm, setCustomerForm } from '../features/checkout/useCustomerForm';
import { makeEmptyCustomerForm } from '../features/checkout/CustomerInlinePanel';

const made = (name: string) => calls.list.filter(([n]) => n === name).map(([, input]) => input);
const openOrder = (mode: 'delivery' | 'takeaway') =>
  ({ order: { id: 'o1', status: 'open', mode, source: 'pos', tableId: null }, items: [], discounts: [] }) as unknown as OrderSnapshot;

afterEach(async () => {
  calls.list.length = 0;
  useCheckoutStore.getState().reset();
  await Promise.resolve();
  resetCustomerForm();
});

describe('Pay saves the customer first; a second save reuses what the first made', () => {
  it('a delivery with a typed address: Pay, close, change the note, Pay again — one customer, one address, the note updated', async () => {
    useCheckoutStore.setState({ snapshot: openOrder('delivery'), mode: 'delivery' });
    setCustomerForm({ ...makeEmptyCustomerForm(), name: 'Test Customer', phone: '03001234567', addressLine: 'House 1, Test Street', area: 'Test Area' });
    await useCheckoutStore.getState().prepareToPay();
    expect(made('customers.create')).toHaveLength(1);
    expect(made('customers.createAddress')).toHaveLength(1);
    // The form now points at what was saved.
    const saved = made('customers.attachToOrder')[0] as { customerId: string; addressId: string };
    expect(getCustomerFormSnapshot()).toMatchObject({ matchedCustomerId: saved.customerId, matchedAddressId: saved.addressId });

    // Pay again with nothing changed: nothing is written.
    await useCheckoutStore.getState().prepareToPay();
    expect(made('customers.attachToOrder')).toHaveLength(1);

    // Pay closed; the note changed; Pay again.
    setCustomerForm({ ...getCustomerFormSnapshot(), deliveryNotes: 'Ring twice' });
    await useCheckoutStore.getState().prepareToPay();
    expect(made('customers.create')).toHaveLength(1);
    expect(made('customers.createAddress')).toHaveLength(1);
    expect(made('customers.attachToOrder')).toEqual([
      expect.objectContaining({ orderId: 'o1', customerId: saved.customerId, addressId: saved.addressId, deliveryNotes: null }),
      expect.objectContaining({ orderId: 'o1', customerId: saved.customerId, addressId: saved.addressId, deliveryNotes: 'Ring twice' }),
    ]);
  });

  it('a takeaway with a name and no phone: the second save does not create the customer again', async () => {
    useCheckoutStore.setState({ snapshot: openOrder('takeaway'), mode: 'takeaway' });
    setCustomerForm({ ...makeEmptyCustomerForm(), name: 'Test Walk-in' });
    await useCheckoutStore.getState().prepareToPay();
    setCustomerForm({ ...getCustomerFormSnapshot(), deliveryNotes: 'Extra napkins' });
    await useCheckoutStore.getState().prepareToPay();
    expect(made('customers.create')).toHaveLength(1);
    const [first, second] = made('customers.attachToOrder') as Array<{ customerId: string }>;
    expect(second?.customerId).toBe(first?.customerId);
  });

  it('a new phone typed after the first save is a new customer, as before', async () => {
    useCheckoutStore.setState({ snapshot: openOrder('takeaway'), mode: 'takeaway' });
    setCustomerForm({ ...makeEmptyCustomerForm(), name: 'Test One', phone: '03001234567' });
    await useCheckoutStore.getState().prepareToPay();
    // Typing in the phone box points the form at no one (CustomerInlinePanel's onChange).
    setCustomerForm({ ...getCustomerFormSnapshot(), phone: '03007654321', matchedCustomerId: null, matchedAddressId: null });
    await useCheckoutStore.getState().prepareToPay();
    expect(made('customers.create')).toHaveLength(2);
  });
});
