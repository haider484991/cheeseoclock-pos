/**
 * Edit order (v0.7.36) in the checkout store: an order the kitchen has is
 * changed at Checkout while the counter's own cart waits.
 *  - Start: the till's preview says it may be changed; the open cart (its
 *    order, type and the customer typed in) is put aside; refused, nothing
 *    moves.
 *  - The cart's taps become the edit's changes, previewed by the till
 *    (orders:previewEdit) — never the counter's own calls; a discount needs
 *    no PIN here (Save asks); Pay, Send and the order type are refused or
 *    left alone.
 *  - Undo one line; an order changed meanwhile is said, and nothing moves.
 *  - Cancel and Save: the cart comes back as it was; Save sends the change
 *    with its answers.
 * Nothing calls the till: the IPC client is a stand-in that keeps the orders
 * in memory and records the calls. Ids, names and numbers are made up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrderEditOp } from '@cheeseoclock/shared-types';

interface Line {
  id: string;
  menuItemId: string;
  menuItemName: string;
  quantity: number;
  modifiers: never[];
  notes: string | null;
  lineTotalCents: number;
}

const till = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  /** The order the kitchen has (o9) and the cart (o1). */
  kitchen: [] as Line[],
  cart: [] as Line[],
  baseKey: 'key-1',
  refuse: null as string | null,
  refuseSave: null as string | null,
}));

vi.mock('../ipc/client', () => {
  const snap = (id: string, status: string, mode: string, items: Line[], discounts: unknown[] = []) => ({
    order: { id, orderNumber: `20261003-00${id.slice(1)}`, status, mode, source: 'pos', tableId: null, totalCents: items.reduce((n, l) => n + l.lineTotalCents, 0) },
    items: items.map((l) => ({ ...l })),
    discounts,
    customerName: null,
    customerPhone: null,
  });
  /** The ops replayed on the kitchen's order, roughly as the till does. */
  const replay = (ops: OrderEditOp[]) => {
    let items = till.kitchen.map((l) => ({ ...l }));
    let discounts: unknown[] = [];
    for (const op of ops) {
      if (op.op === 'add') items.push({ id: op.lineId, menuItemId: op.menuItemId, menuItemName: op.menuItemId, quantity: op.quantity, modifiers: [], notes: op.notes ?? null, lineTotalCents: 50_000 * op.quantity });
      if (op.op === 'qty') items = items.flatMap((l) => (l.id !== op.orderItemId ? [l] : op.quantity > 0 ? [{ ...l, quantity: op.quantity }] : []));
      if (op.op === 'remove') items = items.filter((l) => l.id !== op.orderItemId);
      if (op.op === 'discount') discounts = [{ discountType: op.discountType, value: op.value, reason: op.reason ?? null, freeOrder: op.free === true }];
      if (op.op === 'clearDiscount') discounts = [];
    }
    const removed = till.kitchen.filter((b) => (items.find((i) => i.id === b.id)?.quantity ?? 0) < b.quantity);
    const added = items.filter((i) => !till.kitchen.some((b) => b.id === i.id));
    return {
      snapshot: snap('o9', 'preparing', 'delivery', items, discounts),
      diff: {
        added: added.map((l) => ({ lineId: l.id, menuItemName: l.menuItemName, quantity: l.quantity, modifiers: [], notes: null, fee: false })),
        removed: removed.map((l) => ({ lineId: l.id, menuItemName: l.menuItemName, quantity: 1, modifiers: [], notes: null, fee: false })),
        discountChanged: ops.some((o) => o.op === 'discount' || o.op === 'clearDiscount'),
        freeOrder: ops.some((o) => o.op === 'discount' && o.free === true),
        totalBeforeCents: 150_000,
        totalAfterCents: items.reduce((n, l) => n + l.lineTotalCents, 0),
      },
      needs: removed.length > 0 ? { pin: true, why: ['An item the kitchen has comes off'], reason: true } : { pin: false, why: [], reason: false },
      baseKey: till.baseKey,
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
        get: record('orders.get', (id) => snap(String(id), 'open', 'takeaway', till.cart)),
        create: record('orders.create'),
        addItem: record('orders.addItem'),
        updateItemQuantity: record('orders.updateItemQuantity'),
        removeItem: record('orders.removeItem'),
        applyDiscount: record('orders.applyDiscount'),
        clearDiscount: record('orders.clearDiscount'),
        setMode: record('orders.setMode'),
        tender: record('orders.tender'),
        sendToKitchen: record('orders.sendToKitchen'),
        previewEdit: record('orders.previewEdit', (input) => {
          if (till.refuse) throw new Error(till.refuse);
          return replay((input as { ops: OrderEditOp[] }).ops);
        }),
        saveEdit: record('orders.saveEdit', (input) => {
          if (till.refuseSave) throw new Error(till.refuseSave);
          const r = replay((input as { ops: OrderEditOp[] }).ops);
          return { snapshot: r.snapshot, diff: r.diff };
        }),
      },
    },
  };
});

import type { OrderSnapshot } from '@cheeseoclock/shared-types';
import { ipc } from '../ipc/client';
import { EDIT_CHANGED_MEANWHILE, EDIT_IN_PROGRESS, useCheckoutStore } from './checkoutStore';
import { getCustomerFormSnapshot, resetCustomerForm, setCustomerForm } from '../features/checkout/useCustomerForm';
import { makeEmptyCustomerForm } from '../features/checkout/CustomerInlinePanel';

const store = () => useCheckoutStore.getState();
const made = (name: string) => till.calls.filter(([n]) => n === name).map(([, input]) => input);
const lastOps = () => (made('orders.previewEdit').at(-1) as { ops: OrderEditOp[] }).ops;
const line = (id: string, menuItemId: string, quantity: number): Line => ({ id, menuItemId, menuItemName: menuItemId, quantity, modifiers: [], notes: null, lineTotalCents: 50_000 * quantity });

/** The kitchen has o9 (2 pizzas, a cola); the counter is ringing up o1 (a cola) for a typed-in customer. */
async function counterAndKitchen(): Promise<OrderSnapshot> {
  till.kitchen = [line('k1', 'm_pizza', 2), line('k2', 'm_cola', 1)];
  till.cart = [line('c1', 'm_cola', 1)];
  const cart = (await ipc.orders.get('o1')) as OrderSnapshot;
  useCheckoutStore.setState({ snapshot: cart, mode: 'takeaway', tableId: null, cameBy: 'phone' });
  setCustomerForm({ ...makeEmptyCustomerForm(), name: 'Test Walk-in', phone: '03001234567' });
  till.calls.length = 0;
  return cart;
}

afterEach(async () => {
  store().reset();
  await Promise.resolve();
  resetCustomerForm();
  till.calls.length = 0;
  till.baseKey = 'key-1';
  till.refuse = null;
  till.refuseSave = null;
});

describe('starting a change', () => {
  it('puts the counter’s cart aside and shows the order the kitchen has', async () => {
    const cart = await counterAndKitchen();
    await store().startEdit('o9', '/orders');
    const e = store().edit!;
    expect(e.orderId).toBe('o9');
    expect(e.returnTo).toBe('/orders');
    expect(e.ops).toEqual([]);
    expect(e.parked.snapshot).toBe(cart);
    expect(e.parked.mode).toBe('takeaway');
    expect(e.parked.cameBy).toBe('phone');
    expect(e.parked.form.name).toBe('Test Walk-in');
    expect(store().snapshot?.order.id).toBe('o9');
    expect(store().mode).toBe('delivery');
    // The customer form is the change's (empty), not the cart's.
    expect(getCustomerFormSnapshot().name).toBe('');
  });

  it('refused by the till (paid, out…): said, and nothing moves', async () => {
    const cart = await counterAndKitchen();
    till.refuse = 'This order is paid. Take an item off with Refund, or ring extra items as a new order.';
    await expect(store().startEdit('o9', '/orders')).rejects.toThrow(/This order is paid/);
    expect(store().edit).toBeNull();
    expect(store().snapshot).toBe(cart);
    expect(getCustomerFormSnapshot().name).toBe('Test Walk-in');
  });

  it('one change at a time', async () => {
    await counterAndKitchen();
    await store().startEdit('o9', '/orders');
    await expect(store().startEdit('o8', '/orders')).rejects.toThrow(EDIT_IN_PROGRESS);
  });
});

describe('while changing', () => {
  it('the cart’s taps are the change’s, previewed by the till — never the counter’s own calls', async () => {
    await counterAndKitchen();
    await store().startEdit('o9', '/orders');
    await store().addItem('m_wings');
    const add = lastOps()[0] as Extract<OrderEditOp, { op: 'add' }>;
    expect(add).toMatchObject({ op: 'add', menuItemId: 'm_wings', quantity: 1, modifierIds: [], notes: null });
    expect(add.lineId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(store().snapshot?.items.map((i) => i.id)).toContain(add.lineId);
    expect(store().lastTouch?.lineId).toBe(add.lineId);

    await store().bumpItemQty(add.lineId, 1);
    await store().bumpItemQty('k1', -1);
    await store().removeItem('k2');
    expect(lastOps()).toEqual([
      { ...add, quantity: 2 },
      { op: 'qty', orderItemId: 'k1', quantity: 1 },
      { op: 'remove', orderItemId: 'k2' },
    ]);
    expect(store().edit?.needs.pin).toBe(true);

    // A discount: no PIN here, Save asks for it.
    await store().applyDiscount('percent', 100, 'Staff meal', undefined, { free: true });
    expect(lastOps().at(-1)).toEqual({ op: 'discount', discountType: 'percent', value: 100, reason: 'Staff meal', free: true });
    await store().clearDiscount();
    expect(lastOps().some((o) => o.op === 'discount')).toBe(false);

    for (const counter of ['orders.addItem', 'orders.updateItemQuantity', 'orders.removeItem', 'orders.applyDiscount', 'orders.clearDiscount']) {
      expect(made(counter)).toEqual([]);
    }
  });

  it('Pay and Send are refused; the order type and the customer’s area are left alone', async () => {
    await counterAndKitchen();
    await store().startEdit('o9', '/orders');
    await expect(store().sendToKitchen()).rejects.toThrow(EDIT_IN_PROGRESS);
    await expect(store().tender([])).rejects.toThrow(EDIT_IN_PROGRESS);
    await expect(store().prepareToPay()).rejects.toThrow(EDIT_IN_PROGRESS);
    await store().setMode('takeaway');
    await store().setDeliveryArea('Test Area', { mayStartOrder: true });
    expect(store().mode).toBe('delivery');
    expect(made('orders.setMode')).toEqual([]);
    expect(made('orders.sendToKitchen')).toEqual([]);
  });

  it('undo one line: everything the change did to it, and nothing else', async () => {
    await counterAndKitchen();
    await store().startEdit('o9', '/orders');
    await store().addItem('m_wings');
    await store().removeItem('k2');
    await store().undoEditLine('k2');
    expect(store().edit?.ops.map((o) => o.op)).toEqual(['add']);
    expect(store().snapshot?.items.map((i) => i.id)).toContain('k2');
  });

  it('an order changed meanwhile (the other till): said, and the change stays as it was', async () => {
    await counterAndKitchen();
    await store().startEdit('o9', '/orders');
    await store().addItem('m_wings');
    const before = store().edit!.ops;
    till.baseKey = 'key-2';
    await expect(store().addItem('m_fries')).rejects.toThrow(EDIT_CHANGED_MEANWHILE);
    expect(store().edit?.ops).toBe(before);
  });
});

describe('leaving the change', () => {
  it('Cancel: the counter’s cart comes back as it was, and nothing is saved', async () => {
    const cart = await counterAndKitchen();
    await store().startEdit('o9', '/orders');
    await store().addItem('m_wings');
    await store().cancelEdit();
    expect(store().edit).toBeNull();
    expect(store().snapshot).toBe(cart);
    expect(store().mode).toBe('takeaway');
    expect(store().cameBy).toBe('phone');
    expect(getCustomerFormSnapshot().name).toBe('Test Walk-in');
    expect(made('orders.saveEdit')).toEqual([]);
  });

  it('Save: the change with its answers, then the cart comes back', async () => {
    const cart = await counterAndKitchen();
    await store().startEdit('o9', '/orders');
    await store().removeItem('k2');
    const saved = await store().saveEdit({ approverPin: 'Test-manager-7', reason: '  Customer changed order ', foodMade: { k2: 'not_made' } });
    expect(made('orders.saveEdit')).toEqual([
      {
        orderId: 'o9',
        baseKey: 'key-1',
        ops: [{ op: 'remove', orderItemId: 'k2' }],
        approverPin: 'Test-manager-7',
        reason: 'Customer changed order',
        foodMade: { k2: 'not_made' },
      },
    ]);
    expect(saved.snapshot.order.id).toBe('o9');
    expect(store().edit).toBeNull();
    expect(store().snapshot).toBe(cart);
    expect(getCustomerFormSnapshot().phone).toBe('03001234567');
  });

  it('Save refused by the till: the change stays open to try again', async () => {
    await counterAndKitchen();
    await store().startEdit('o9', '/orders');
    await store().removeItem('k2');
    till.refuseSave = "That is not a manager's PIN or password";
    await expect(store().saveEdit({ approverPin: 'Wrong-pin-1', reason: 'x' })).rejects.toThrow(/not a manager/);
    expect(store().edit?.ops).toEqual([{ op: 'remove', orderItemId: 'k2' }]);
    expect(store().snapshot?.order.id).toBe('o9');
  });
});
