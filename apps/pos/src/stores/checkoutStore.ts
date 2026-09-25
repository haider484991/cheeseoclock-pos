import { create } from 'zustand';
import type { OrderSnapshot, OrderMode, PaymentMethod } from '@cheeseoclock/shared-types';
import { ipc } from '../ipc/client';

interface CheckoutState {
  /** The current in-progress order on this register, if any. */
  snapshot: OrderSnapshot | null;
  /** Active order mode for the next-created order. */
  mode: OrderMode;
  /** Optional dine-in table selection. */
  tableId: string | null;
  /** Mutation in flight (disables UI). */
  busy: boolean;

  /** Set the mode; persists to the open order so the saved order, board and
   *  reports agree with the on-screen choice. Rejects if the write fails. */
  setMode: (mode: OrderMode) => Promise<void>;
  setTableId: (id: string | null) => void;

  /**
   * After a restart: pick the unfinished order back up from the database so
   * it isn't orphaned as an 'open' row nobody can see. No-op when an order is
   * already in hand. Resolves with the draft, or null if there was none.
   */
  resumeDraft: () => Promise<OrderSnapshot | null>;
  /**
   * Drop the current open draft entirely — nothing has been sent or charged,
   * so no approval is needed. Clears the screen for the next order.
   */
  discardDraft: () => Promise<void>;
  /** Begin a new order with the current mode/table. Idempotent if one exists. */
  ensureOrder: () => Promise<OrderSnapshot>;
  addItem: (menuItemId: string, quantity?: number, modifierIds?: string[]) => Promise<void>;
  updateItemQty: (orderItemId: string, quantity: number) => Promise<void>;
  removeItem: (orderItemId: string) => Promise<void>;
  applyDiscount: (
    discountType: 'percent' | 'flat',
    value: number,
    reason?: string,
    approverPin?: string,
  ) => Promise<void>;
  clearDiscount: () => Promise<void>;
  tender: (
    payments: Array<{
      method: PaymentMethod;
      amountCents: number;
      tenderedCents?: number | null;
      referenceNo?: string | null;
    }>,
  ) => Promise<OrderSnapshot>;
  /**
   * Commit the order without tendering — for the COD entry path on delivery
   * (and takeaway) orders. Validates the customer/address inline, calls
   * sendToKitchen, returns the snapshot. After this the order shows on the
   * Live Orders board.
   */
  sendToKitchen: () => Promise<OrderSnapshot>;
  voidCurrent: (reason: string, approverPin: string) => Promise<void>;
  /** Refetch the current order snapshot — used after side mutations like attachCustomer. */
  refreshSnapshot: () => Promise<void>;
  /** Discard the local pointer to the snapshot — used after tender to start fresh. */
  reset: () => void;
}

export const useCheckoutStore = create<CheckoutState>((set, get) => ({
  snapshot: null,
  mode: 'takeaway',
  tableId: null,
  busy: false,

  async setMode(mode) {
    const snap = get().snapshot;
    // Reflect the choice immediately for the mode-bar highlight.
    set({ mode, tableId: mode === 'dine_in' ? get().tableId : null });
    if (snap && snap.order.status === 'open') {
      try {
        const next = await ipc.orders.setMode({ orderId: snap.order.id, mode });
        set({ snapshot: next, mode: next.order.mode, tableId: next.order.tableId });
      } catch (e) {
        // Persist failed — snap the UI back to the order's real mode so the
        // screen and the saved order can't disagree (that divergence was the
        // bug where "Delivery" never reached the order and it stayed dine-in).
        set({ mode: snap.order.mode, tableId: snap.order.tableId });
        throw e;
      }
    }
  },
  setTableId(id) {
    set({ tableId: id });
  },

  async resumeDraft() {
    const existing = get().snapshot;
    if (existing) return existing;
    const snap = await ipc.orders.resumeDraft();
    if (snap) set({ snapshot: snap, mode: snap.order.mode, tableId: snap.order.tableId });
    return snap;
  },

  async discardDraft() {
    const snap = get().snapshot;
    if (!snap) return;
    set({ busy: true });
    try {
      await ipc.orders.discardDraft(snap.order.id);
    } finally {
      set({ busy: false });
    }
    get().reset();
  },

  async ensureOrder() {
    const existing = get().snapshot;
    if (existing && existing.order.status === 'open') return existing;

    set({ busy: true });
    try {
      const order = await ipc.orders.create({
        mode: get().mode,
        tableId: get().tableId,
      });
      const snap = await ipc.orders.get(order.id);
      if (!snap) throw new Error('Order vanished after create');
      set({ snapshot: snap });
      return snap;
    } finally {
      set({ busy: false });
    }
  },

  async addItem(menuItemId, quantity = 1, modifierIds = []) {
    set({ busy: true });
    try {
      const order = await get().ensureOrder();
      const snap = await ipc.orders.addItem({
        orderId: order.order.id,
        menuItemId,
        quantity,
        modifierIds,
      });
      set({ snapshot: snap });
    } finally {
      set({ busy: false });
    }
  },

  async updateItemQty(orderItemId, quantity) {
    const snap = get().snapshot;
    if (!snap) return;
    set({ busy: true });
    try {
      const next = await ipc.orders.updateItemQuantity({
        orderId: snap.order.id,
        orderItemId,
        quantity,
      });
      set({ snapshot: next });
    } finally {
      set({ busy: false });
    }
  },

  async removeItem(orderItemId) {
    const snap = get().snapshot;
    if (!snap) return;
    set({ busy: true });
    try {
      const next = await ipc.orders.removeItem({
        orderId: snap.order.id,
        orderItemId,
      });
      set({ snapshot: next });
    } finally {
      set({ busy: false });
    }
  },

  async applyDiscount(discountType, value, reason, approverPin) {
    const snap = get().snapshot;
    if (!snap) return;
    set({ busy: true });
    try {
      const next = await ipc.orders.applyDiscount({
        orderId: snap.order.id,
        discountType,
        value,
        reason: reason ?? null,
        ...(approverPin ? { approverPin } : {}),
      });
      set({ snapshot: next });
    } finally {
      set({ busy: false });
    }
  },

  async clearDiscount() {
    const snap = get().snapshot;
    if (!snap) return;
    set({ busy: true });
    try {
      const next = await ipc.orders.clearDiscount(snap.order.id);
      set({ snapshot: next });
    } finally {
      set({ busy: false });
    }
  },

  async tender(payments) {
    const snap = get().snapshot;
    if (!snap) throw new Error('No open order to tender');
    set({ busy: true });
    try {
      // Commit any inline customer fields onto the order BEFORE tender.
      // Lazy-imported to avoid a circular dep with the checkout feature.
      const { commitCustomerToOrder } = await import('../features/checkout/CustomerInlinePanel');
      const { getCustomerFormSnapshot } = await import('../features/checkout/useCustomerForm');
      try {
        await commitCustomerToOrder(snap.order.id, get().mode, getCustomerFormSnapshot());
      } catch (e) {
        // Don't block the sale on customer-write failure — surface via log.
         
        console.warn('Customer commit failed (proceeding with tender):', e);
      }
      const next = await ipc.orders.tender({
        orderId: snap.order.id,
        payments,
      });
      set({ snapshot: next });
      return next;
    } finally {
      set({ busy: false });
    }
  },

  async sendToKitchen() {
    const snap = get().snapshot;
    if (!snap) throw new Error('No open order to send');
    set({ busy: true });
    try {
      // Commit any inline customer fields onto the order BEFORE handing off.
      const { commitCustomerToOrder } = await import('../features/checkout/CustomerInlinePanel');
      const { getCustomerFormSnapshot } = await import('../features/checkout/useCustomerForm');
      try {
        await commitCustomerToOrder(snap.order.id, get().mode, getCustomerFormSnapshot());
      } catch (e) {
         
        console.warn('Customer commit failed (proceeding with send to kitchen):', e);
      }
      const next = await ipc.orders.sendToKitchen(snap.order.id);
      set({ snapshot: next });
      return next;
    } finally {
      set({ busy: false });
    }
  },

  async voidCurrent(reason, approverPin) {
    const snap = get().snapshot;
    if (!snap) return;
    set({ busy: true });
    try {
      const next = await ipc.orders.void({
        orderId: snap.order.id,
        reason,
        approverPin,
      });
      set({ snapshot: next });
    } finally {
      set({ busy: false });
    }
  },

  async refreshSnapshot() {
    const snap = get().snapshot;
    if (!snap) return;
    const next = await ipc.orders.get(snap.order.id);
    if (next) set({ snapshot: next });
  },

  reset() {
    // Clear inline customer form alongside the order pointer.
    void import('../features/checkout/useCustomerForm').then(({ resetCustomerForm }) =>
      resetCustomerForm(),
    );
    set({ snapshot: null, tableId: null });
  },
}));
