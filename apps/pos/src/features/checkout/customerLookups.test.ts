/**
 * A customer saved by Send or Pay is found by the next phone typed (e2e
 * smoke bug 3, 2 Oct 2026). The counter panel keeps its phone search's
 * answer — ['customers', 'inlineSearch', phone] for a manager or the owner,
 * ['customers', 'byPhone', number] at the counter — for 30 seconds
 * (main.tsx). A delivery rung for a new phone cached "No match"; Send saved
 * the customer; the same phone typed again within 30 s still said "No
 * match", so the add-on rule ("Goes with #0009: no second delivery charge")
 * did not show. Now every customer save onto an order (commitCustomerToOrder:
 * Send's, Pay's, the payment's) and every Send marks the ['customers', …]
 * answers out of date, and the panel asks the till again.
 *
 * The app's QueryClient is made as main.tsx makes it (answers kept 30 s) and
 * wired the same way (staleCustomersOnSave). Nothing calls the till: the IPC
 * client is a stand-in with a made-up customer list. Every name and number is
 * made up.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { OrderSnapshot } from '@cheeseoclock/shared-types';

/** The till as the stand-in has it: its customers, the calls, and an attach that can fail. */
const till = vi.hoisted(() => ({
  customers: [] as Array<{ id: string; name: string; phone: string | null }>,
  calls: [] as string[],
  attachFails: false,
}));

vi.mock('../../ipc/client', () => {
  const snap = { order: { id: 'o1', status: 'open', mode: 'delivery', source: 'pos', tableId: null }, items: [], discounts: [] };
  const record =
    (name: string, reply: (input: unknown) => unknown = () => ({})) =>
    async (input: unknown) => {
      till.calls.push(name);
      return reply(input);
    };
  return {
    ipc: {
      orders: {
        setNote: record('orders.setNote'),
        get: record('orders.get', () => snap),
        tender: record('orders.tender', () => snap),
        sendToKitchen: record('orders.sendToKitchen', () => ({ ...snap, order: { ...snap.order, status: 'sent_to_kitchen' } })),
      },
      customers: {
        get: record('customers.get', (id) => ({ id, name: 'Test Customer Echo', addresses: [] })),
        findByPhone: record('customers.findByPhone', (phone) => till.customers.find((c) => c.phone === phone) ?? null),
        create: record('customers.create', (input) => {
          const c = { id: `c${till.customers.length + 1}`, ...(input as { name: string; phone: string | null }) };
          till.customers.push(c);
          return c;
        }),
        createAddress: record('customers.createAddress', () => ({ id: 'a1' })),
        attachToOrder: record('customers.attachToOrder', () => {
          if (till.attachFails) throw new Error('Test: the till could not attach');
          return snap;
        }),
      },
    },
  };
});

import { useCheckoutStore } from '../../stores/checkoutStore';
import { commitCustomerToOrder, makeEmptyCustomerForm } from './CustomerInlinePanel';
import { CUSTOMERS_QUERY_KEY, customersChanged, staleCustomersOnSave } from './customerLookups';
import { resetCustomerForm, setCustomerForm } from './useCustomerForm';

const PHONE = '03001110007';
/** The manager's and owner's type-ahead, and the counter's whole-number lookup, for that phone. */
const SEARCH = ['customers', 'inlineSearch', PHONE] as const;
const BY_PHONE = ['customers', 'byPhone', '+923001110007'] as const;

/** The app's QueryClient as main.tsx makes it: every answer kept 30 seconds. */
function appClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false, gcTime: 5 * 60_000 } } });
}

/** The panel showing its search for the phone: the kept answer while it is fresh, else the till's list now. */
function panelSearch(qc: QueryClient, key: readonly unknown[]) {
  const asked = vi.fn(async () => till.customers.filter((c) => c.phone === PHONE));
  return { asked, result: qc.fetchQuery({ queryKey: [...key], queryFn: asked }) };
}

const openDelivery = () =>
  ({ order: { id: 'o1', status: 'open', mode: 'delivery', source: 'pos', tableId: null }, items: [], discounts: [] }) as unknown as OrderSnapshot;

let undo: (() => void) | null = null;
let qc: QueryClient;

beforeEach(() => {
  till.customers.length = 0;
  till.calls.length = 0;
  till.attachFails = false;
  qc = appClient();
  undo = staleCustomersOnSave(qc);
  // The first delivery's panel looked the new phone up: "No match", kept for 30 s.
  qc.setQueryData([...SEARCH], []);
  qc.setQueryData([...BY_PHONE], null);
});

afterEach(async () => {
  undo?.();
  undo = null;
  useCheckoutStore.getState().reset();
  await Promise.resolve();
  resetCustomerForm();
  qc.clear();
});

describe('the phone search after Send or Pay saved its customer (e2e smoke bug 3)', () => {
  it('without a save, the kept "No match" is what the panel shows for 30 s (what the bug was)', async () => {
    const { asked, result } = panelSearch(qc, SEARCH);
    expect(await result).toEqual([]);
    expect(asked).not.toHaveBeenCalled();
  });

  it('Send saves the new customer: typed again at once, the panel asks the till again and finds her', async () => {
    useCheckoutStore.setState({ snapshot: openDelivery(), mode: 'delivery' });
    setCustomerForm({ ...makeEmptyCustomerForm(), phone: PHONE, name: 'Test Customer Echo', addressLine: 'House 21, Example Lane', area: 'DHA Phase 6' });
    await useCheckoutStore.getState().sendToKitchen();
    expect(till.calls).toContain('customers.create');
    expect(till.calls.at(-1)).toBe('orders.sendToKitchen');

    for (const key of [SEARCH, BY_PHONE]) expect(qc.getQueryState([...key])?.isInvalidated).toBe(true);
    const { asked, result } = panelSearch(qc, SEARCH);
    expect(await result).toEqual([{ id: 'c1', name: 'Test Customer Echo', phone: PHONE }]);
    expect(asked).toHaveBeenCalledTimes(1);
    // The counter's lookup by the whole number asks again too.
    const byPhone = vi.fn(async () => till.customers[0] ?? null);
    expect(await qc.fetchQuery({ queryKey: [...BY_PHONE], queryFn: byPhone })).toMatchObject({ id: 'c1' });
    expect(byPhone).toHaveBeenCalledTimes(1);
  });

  it("Pay's save does the same, before the payment", async () => {
    useCheckoutStore.setState({ snapshot: openDelivery(), mode: 'delivery' });
    setCustomerForm({ ...makeEmptyCustomerForm(), phone: PHONE, name: 'Test Customer Echo' });
    await useCheckoutStore.getState().prepareToPay();
    expect(till.calls).toContain('customers.attachToOrder');
    expect(till.calls).not.toContain('orders.tender');
    expect(qc.getQueryState([...SEARCH])?.isInvalidated).toBe(true);
    const { asked, result } = panelSearch(qc, SEARCH);
    expect(await result).toHaveLength(1);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('Send with nothing new to save (Pay saved it first) still marks them: the order was sent', async () => {
    useCheckoutStore.setState({ snapshot: openDelivery(), mode: 'delivery' });
    setCustomerForm({ ...makeEmptyCustomerForm(), phone: PHONE, name: 'Test Customer Echo' });
    await useCheckoutStore.getState().prepareToPay();
    // Looked up again since Pay (fresh again), then Send.
    qc.setQueryData([...SEARCH], []);
    expect(qc.getQueryState([...SEARCH])?.isInvalidated).toBe(false);
    const attaches = till.calls.filter((c) => c === 'customers.attachToOrder').length;
    await useCheckoutStore.getState().sendToKitchen();
    expect(till.calls.filter((c) => c === 'customers.attachToOrder').length).toBe(attaches);
    expect(qc.getQueryState([...SEARCH])?.isInvalidated).toBe(true);
  });

  it('every customer answer is marked (the picker, house numbers, a customer and her past orders), nothing else', async () => {
    const others = [
      ['customers', 'search', PHONE],
      ['customers', 'addressSearch', 'house 21'],
      ['customers', 'detail', 'c1'],
      ['customers', 'history', 'c1'],
    ];
    for (const key of others) qc.setQueryData(key, []);
    qc.setQueryData(['orders', 'active', 'all'], []);
    qc.setQueryData(['menu', 'categories'], []);
    await commitCustomerToOrder('o1', 'delivery', { ...makeEmptyCustomerForm(), phone: PHONE, name: 'Test Customer Echo' });
    for (const key of [SEARCH, BY_PHONE, ...others]) expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['orders', 'active', 'all'])?.isInvalidated).toBe(false);
    expect(qc.getQueryState(['menu', 'categories'])?.isInvalidated).toBe(false);
  });

  it('a save the till refused still marks them (the customer may already be made); the refusal reaches the caller as before', async () => {
    till.attachFails = true;
    await expect(
      commitCustomerToOrder('o1', 'delivery', { ...makeEmptyCustomerForm(), phone: PHONE, name: 'Test Customer Echo' }),
    ).rejects.toThrow('Test: the till could not attach');
    expect(till.customers).toHaveLength(1);
    expect(qc.getQueryState([...SEARCH])?.isInvalidated).toBe(true);
  });

  it('nothing typed (only an order note, or a dine-in): no customer saved, nothing marked', async () => {
    await commitCustomerToOrder('o1', 'takeaway', { ...makeEmptyCustomerForm(), deliveryNotes: 'Collect by 7pm' });
    await commitCustomerToOrder('o1', 'dine_in', { ...makeEmptyCustomerForm(), phone: PHONE });
    expect(till.calls).toEqual(['orders.setNote']);
    expect(qc.getQueryState([...SEARCH])?.isInvalidated).toBe(false);
  });

  it('the wiring: main.tsx marks them on the app QueryClient; undone, a save marks nothing; a failing listener never stops the save', async () => {
    const main = readFileSync(new URL('../../main.tsx', import.meta.url), 'utf8');
    expect(main).toContain("import { staleCustomersOnSave } from './features/checkout/customerLookups';");
    expect(main).toContain('staleCustomersOnSave(queryClient);');
    expect(CUSTOMERS_QUERY_KEY).toEqual(['customers']);

    undo?.();
    undo = null;
    customersChanged();
    expect(qc.getQueryState([...SEARCH])?.isInvalidated).toBe(false);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = { invalidateQueries: () => { throw new Error('Test: broken client'); } } as unknown as QueryClient;
    const undoBroken = staleCustomersOnSave(broken);
    undo = staleCustomersOnSave(qc);
    const saved = await commitCustomerToOrder('o1', 'takeaway', { ...makeEmptyCustomerForm(), phone: PHONE, name: 'Test Customer Echo' });
    expect(saved).toMatchObject({ customerId: 'c1' });
    expect(qc.getQueryState([...SEARCH])?.isInvalidated).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    undoBroken();
    warn.mockRestore();
  });
});
