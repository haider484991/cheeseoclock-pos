/**
 * The counter's "Order notes" box, as Pay and Send commit it to the order
 * (commitCustomerToOrder). What is in the box is what goes on the order —
 * and so what prints on the kitchen ticket and the bill:
 *
 *   - a note with no customer typed in is saved on the order by itself;
 *   - an emptied box takes the note off again (a Pay refused with no shift
 *     open had already saved it: it used to stay and print, although the box
 *     on screen was empty);
 *   - with a customer typed in, the note goes on with them, and an empty box
 *     clears it there too.
 *
 * Nothing calls the till: the IPC client is a stand-in that records the calls.
 * Names and notes are made up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ list: [] as Array<[string, unknown]> }));
vi.mock('../../ipc/client', () => {
  const record =
    (name: string, reply: (input: unknown) => unknown = () => ({})) =>
    async (input: unknown) => {
      calls.list.push([name, input]);
      return reply(input);
    };
  return {
    ipc: {
      orders: { setNote: record('orders.setNote') },
      customers: {
        get: record('customers.get', () => ({ id: 'c1', name: 'Sana', addresses: [] })),
        findByPhone: record('customers.findByPhone', () => null),
        create: record('customers.create', () => ({ id: 'c_new' })),
        createAddress: record('customers.createAddress', () => ({ id: 'a_new' })),
        attachToOrder: record('customers.attachToOrder'),
      },
    },
  };
});

import { commitCustomerToOrder, makeEmptyCustomerForm, type CustomerFormState } from './CustomerInlinePanel';

const form = (over: Partial<CustomerFormState> = {}): CustomerFormState => ({ ...makeEmptyCustomerForm(), ...over });
const made = (name: string) => calls.list.filter(([n]) => n === name).map(([, input]) => input);

afterEach(() => {
  calls.list.length = 0;
});

describe('the order note, as Pay or Send commit it', () => {
  it('no customer typed in: the note is saved on the order by itself, trimmed', async () => {
    await commitCustomerToOrder('o1', 'takeaway', form({ deliveryNotes: '  Collect by 7pm  ' }));
    expect(made('orders.setNote')).toEqual([{ orderId: 'o1', note: 'Collect by 7pm' }]);
    expect(made('customers.attachToOrder')).toEqual([]);
  });

  it('the box emptied after a refused Pay had saved a note: the note is taken off, so it does not print', async () => {
    // Pay with the note (saved), payment refused: no shift open.
    await commitCustomerToOrder('o1', 'takeaway', form({ deliveryNotes: 'Extra napkins, collect 7pm' }));
    // The customer says forget it; the box is cleared; Pay again.
    await commitCustomerToOrder('o1', 'takeaway', form({ deliveryNotes: '   ' }));
    expect(made('orders.setNote')).toEqual([
      { orderId: 'o1', note: 'Extra napkins, collect 7pm' },
      { orderId: 'o1', note: null },
    ]);
  });

  it('with a customer typed in: the note goes on with them, and an emptied box clears it there too', async () => {
    await commitCustomerToOrder('o2', 'delivery', form({ phone: '03001234567', name: 'Sana', matchedCustomerId: 'c1', deliveryNotes: 'Ring twice' }));
    await commitCustomerToOrder('o2', 'delivery', form({ phone: '03001234567', name: 'Sana', matchedCustomerId: 'c1', deliveryNotes: '' }));
    expect(made('customers.attachToOrder')).toEqual([
      expect.objectContaining({ orderId: 'o2', customerId: 'c1', deliveryNotes: 'Ring twice' }),
      expect.objectContaining({ orderId: 'o2', customerId: 'c1', deliveryNotes: null }),
    ]);
    expect(made('orders.setNote')).toEqual([]);
  });

  it('dine-in, website and Foodpanda orders: the counter box is not theirs, nothing is written', async () => {
    for (const mode of ['dine_in', 'online', 'foodpanda'] as const) {
      await commitCustomerToOrder('o3', mode, form({ deliveryNotes: 'Not for these' }));
    }
    expect(calls.list).toEqual([]);
  });
});
