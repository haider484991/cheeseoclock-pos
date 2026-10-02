/**
 * Pay saves the customer typed in on the counter BEFORE it opens (so an
 * automatic offer that needs the phone is on the bill Pay shows). Closing
 * Pay and changing the form (the order note, say) saves it again at the next
 * Pay or Send — and that second save must reuse the customer and address
 * the first one made:
 *   - a typed delivery address is not added to the customer a second time;
 *   - a customer with a name and no phone is not created a second time
 *     (the first left orphaned).
 * With nothing changed nothing is saved again — except at Pay and Send while
 * the cart says a live order holds the once-a-day offer (order-edit #12), or
 * that the delivery goes with the same customer's #0042 (the add-on rule is
 * settled again: #0042 may have gone out since; review fixes C).
 *
 * Send to kitchen with only the phone typed (review fixes C): the save at
 * Send answers with the order, and when that phone's live order holds
 * today's once-a-day offer — which the cart could not say before the phone
 * was saved — nothing is sent: the cart now says 'Cancel #0001 first to keep
 * the offer' and Send rejects with OfferHeldBack. Send again goes (without
 * the offer, or with it once #0001 was cancelled).
 * Review, 28 Sep 2026 (screens). Nothing calls the till: the IPC client is a
 * stand-in that records the calls. Every name and address is made up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrderSnapshot } from '@cheeseoclock/shared-types';

const calls = vi.hoisted(() => ({
  list: [] as Array<[string, unknown]>,
  seq: 0,
  /** What customers:attachToOrder answers (the order as the till has it after the save); null: {}. */
  attachReply: null as unknown,
}));
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
      orders: {
        setNote: record('orders.setNote'),
        get: record('orders.get', () => snap),
        tender: record('orders.tender', () => snap),
        sendToKitchen: record('orders.sendToKitchen', () => snap),
      },
      customers: {
        get: record('customers.get', (id) => ({ id, name: 'Test Customer', addresses: [] })),
        findByPhone: record('customers.findByPhone', () => null),
        create: record('customers.create', () => ({ id: `c_${++calls.seq}` })),
        createAddress: record('customers.createAddress', () => ({ id: `a_${++calls.seq}` })),
        attachToOrder: record('customers.attachToOrder', () => calls.attachReply ?? {}),
      },
    },
  };
});

import { OfferHeldBack, useCheckoutStore } from './checkoutStore';
import { getCustomerFormSnapshot, resetCustomerForm, setCustomerForm } from '../features/checkout/useCustomerForm';
import { makeEmptyCustomerForm } from '../features/checkout/CustomerInlinePanel';

const made = (name: string) => calls.list.filter(([n]) => n === name).map(([, input]) => input);
const openOrder = (mode: 'delivery' | 'takeaway') =>
  ({ order: { id: 'o1', status: 'open', mode, source: 'pos', tableId: null }, items: [], discounts: [] }) as unknown as OrderSnapshot;

afterEach(async () => {
  calls.list.length = 0;
  calls.attachReply = null;
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

  it('the cart said a live order holds the once-a-day offer: Pay and Send save the customer again with nothing changed, so the offer can go on; the payment itself never does (order-edit #12)', async () => {
    const held = () =>
      ({ ...openOrder('takeaway'), offerHeldBy: { orderId: 'o0', orderNumber: '20261002-0042', paid: false } }) as unknown as OrderSnapshot;
    useCheckoutStore.setState({ snapshot: openOrder('takeaway'), mode: 'takeaway' });
    setCustomerForm({ ...makeEmptyCustomerForm(), name: 'Test Customer', phone: '03001234567' });
    await useCheckoutStore.getState().prepareToPay();
    await useCheckoutStore.getState().prepareToPay();
    expect(made('customers.attachToOrder')).toHaveLength(1);

    // #0042 may have been cancelled since: Pay saves again (the save works the offer out again).
    useCheckoutStore.setState({ snapshot: held() });
    await useCheckoutStore.getState().prepareToPay();
    expect(made('customers.attachToOrder')).toHaveLength(2);
    // The payment: the bill Pay showed must not move, so no second save there.
    useCheckoutStore.setState({ snapshot: held() });
    await useCheckoutStore.getState().tender([{ method: 'cash', amountCents: 100_000, tenderedCents: 100_000 }]);
    expect(made('customers.attachToOrder')).toHaveLength(2);
    expect(made('orders.tender')).toHaveLength(1);
    // Send saves again too, before it sends.
    useCheckoutStore.setState({ snapshot: held() });
    await useCheckoutStore.getState().sendToKitchen();
    expect(made('customers.attachToOrder')).toHaveLength(3);
    expect(calls.list.map(([n]) => n).slice(-2)).toEqual(['customers.attachToOrder', 'orders.sendToKitchen']);
    // One customer the whole time.
    expect(made('customers.create')).toHaveLength(1);
    expect(new Set((made('customers.attachToOrder') as Array<{ customerId: string }>).map((a) => a.customerId)).size).toBe(1);
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

describe('Send to kitchen with only the phone typed: the once-a-day offer held by a live order of that phone (review fixes C)', () => {
  /** #0001, sent to the kitchen today for the same made-up phone with the owner's offer on it. */
  const HELD = { orderId: 'o0', orderNumber: '20261002-0001', paid: false };
  const heldBy = (held: typeof HELD) => ({ ...openOrder('takeaway'), offerHeldBy: held }) as unknown as OrderSnapshot;

  it('the phone Send saves shows #0001 holds the offer: nothing is sent, the cart says so; Send again goes', async () => {
    useCheckoutStore.setState({ snapshot: openOrder('takeaway'), mode: 'takeaway' });
    setCustomerForm({ ...makeEmptyCustomerForm(), phone: '03001234567' });
    // The till answers the save with the order as it now is: the phone on it, #0001 holding the offer.
    calls.attachReply = heldBy(HELD);

    const first = useCheckoutStore.getState().sendToKitchen();
    await expect(first).rejects.toBeInstanceOf(OfferHeldBack);
    await expect(first).rejects.toMatchObject({ held: HELD });
    // The customer was saved; the order was NOT sent (its lines would be locked at full price).
    expect(calls.list.map(([n]) => n)).toEqual(['customers.findByPhone', 'customers.create', 'customers.attachToOrder']);
    expect(made('orders.sendToKitchen')).toHaveLength(0);
    // The cart reads the order the save answered with: 'Cancel #0001 first to keep the offer'.
    expect(useCheckoutStore.getState().snapshot?.offerHeldBy).toEqual(HELD);

    // Send again: the cart already says it. The save runs once more (#0001 may have been cancelled), then it goes.
    await useCheckoutStore.getState().sendToKitchen();
    expect(calls.list.map(([n]) => n).slice(-2)).toEqual(['customers.attachToOrder', 'orders.sendToKitchen']);
    expect(made('orders.sendToKitchen')).toHaveLength(1);
    expect(made('customers.create')).toHaveLength(1);
  });

  it('the cart already said it (Pay was opened first): Send goes straight on; another holder than the one shown stops it again', async () => {
    useCheckoutStore.setState({ snapshot: heldBy(HELD), mode: 'takeaway' });
    setCustomerForm({ ...makeEmptyCustomerForm(), phone: '03001234567' });
    calls.attachReply = heldBy(HELD);
    await useCheckoutStore.getState().sendToKitchen();
    expect(made('orders.sendToKitchen')).toHaveLength(1);

    calls.list.length = 0;
    useCheckoutStore.setState({ snapshot: heldBy(HELD) });
    const other = { orderId: 'o9', orderNumber: '20261002-0009', paid: true };
    calls.attachReply = heldBy(other);
    await expect(useCheckoutStore.getState().sendToKitchen()).rejects.toMatchObject({ held: other });
    expect(made('orders.sendToKitchen')).toHaveLength(0);
  });

  it('no live order holds it (the reply says none): sent at once, as before', async () => {
    useCheckoutStore.setState({ snapshot: openOrder('takeaway'), mode: 'takeaway' });
    setCustomerForm({ ...makeEmptyCustomerForm(), phone: '03001234567' });
    calls.attachReply = { ...openOrder('takeaway'), offerHeldBy: null };
    await useCheckoutStore.getState().sendToKitchen();
    expect(calls.list.map(([n]) => n)).toEqual(['customers.findByPhone', 'customers.create', 'customers.attachToOrder', 'orders.sendToKitchen']);
  });
});

describe('the add-on rule is settled again at Pay and Send with nothing changed (review fixes C)', () => {
  /** The cart said it goes with #0042, so its delivery charge was left off. */
  const goesWith42 = () =>
    ({ ...openOrder('delivery'), addOnTo: { orderId: 'o42', orderNumber: '20261002-0042' } }) as unknown as OrderSnapshot;

  it('Pay opened and closed, then Send: the customer is saved again before the order is sent (#0042 may have gone out)', async () => {
    useCheckoutStore.setState({ snapshot: openOrder('delivery'), mode: 'delivery' });
    setCustomerForm({ ...makeEmptyCustomerForm(), name: 'Test Customer', phone: '03001234567', addressLine: 'House 1, Test Street', area: 'Test Area' });
    await useCheckoutStore.getState().prepareToPay();
    expect(made('customers.attachToOrder')).toHaveLength(1);
    // Nothing changed and no add-on on the cart: nothing saved again.
    await useCheckoutStore.getState().prepareToPay();
    expect(made('customers.attachToOrder')).toHaveLength(1);

    // The cart goes with #0042: Pay saves again (the bill Pay shows is then settled)…
    useCheckoutStore.setState({ snapshot: goesWith42() });
    await useCheckoutStore.getState().prepareToPay();
    expect(made('customers.attachToOrder')).toHaveLength(2);
    // …and so does Send, right before it sends.
    useCheckoutStore.setState({ snapshot: goesWith42() });
    await useCheckoutStore.getState().sendToKitchen();
    expect(made('customers.attachToOrder')).toHaveLength(3);
    expect(calls.list.map(([n]) => n).slice(-2)).toEqual(['customers.attachToOrder', 'orders.sendToKitchen']);
    // One customer, one address the whole time.
    expect(made('customers.create')).toHaveLength(1);
    expect(made('customers.createAddress')).toHaveLength(1);
  });

  it('the payment itself never saves again: the bill Pay showed must not move', async () => {
    useCheckoutStore.setState({ snapshot: openOrder('delivery'), mode: 'delivery' });
    setCustomerForm({ ...makeEmptyCustomerForm(), name: 'Test Customer', phone: '03001234567' });
    await useCheckoutStore.getState().prepareToPay();
    useCheckoutStore.setState({ snapshot: goesWith42() });
    await useCheckoutStore.getState().tender([{ method: 'cash', amountCents: 100_000, tenderedCents: 100_000 }]);
    expect(made('customers.attachToOrder')).toHaveLength(1);
    expect(made('orders.tender')).toHaveLength(1);
  });
});
