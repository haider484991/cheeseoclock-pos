import { create } from 'zustand';
import type { OrderSnapshot, OrderMode, PaymentMethod } from '@cheeseoclock/shared-types';
import { isDeliveryChargeName } from '@cheeseoclock/shared-types';
import { ipc } from '../ipc/client';
import { addedLineId, createSerialQueue, findMergeableLine } from '../features/checkout/cartLines';

/** The ticket line the cashier last added to or changed — the ticket flashes it, and +/- keys act on it. */
export interface LineTouch {
  lineId: string;
  /** Goes up on every touch, so the same line touched twice flashes twice. */
  seq: number;
}

interface CheckoutState {
  /** The current in-progress order on this register, if any. */
  snapshot: OrderSnapshot | null;
  /** Active order mode for the next-created order. */
  mode: OrderMode;
  /** Optional dine-in table selection. */
  tableId: string | null;
  /** A change to the order is still on its way to the till (Pay / Send wait for it). */
  busy: boolean;
  lastTouch: LineTouch | null;

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
  /**
   * Add an item. A plain tap on an item already on the ticket as a plain line
   * adds one to that line (see findMergeableLine).
   */
  addItem: (menuItemId: string, quantity?: number, modifierIds?: string[], notes?: string | null) => Promise<void>;
  /** "Customize" a cart line: replace its choices and its note. */
  updateItemOptions: (orderItemId: string, modifierIds: string[], notes: string | null) => Promise<void>;
  /**
   * "Customize" just one of a line of several (2 × Fajita, one without
   * onion): the choices go on a new line of one, the old line keeps the rest.
   */
  customizeOneOf: (orderItemId: string, modifierIds: string[], notes: string | null) => Promise<void>;
  updateItemQty: (orderItemId: string, quantity: number) => Promise<void>;
  /**
   * One more / one less, worked out from the line as it is when the change
   * runs — three quick taps on + are three more, not one.
   */
  bumpItemQty: (orderItemId: string, delta: number) => Promise<void>;
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

let touchSeq = 0;
function touch(lineId: string | null | undefined): LineTouch | null {
  return lineId ? { lineId, seq: ++touchSeq } : null;
}

export const useCheckoutStore = create<CheckoutState>((set, get) => {
  // Every change to the order goes through this one queue, in tap order.
  // Side by side, two quick first taps each created an order (one orphaned),
  // and a Pay could read the order before the last item had landed.
  const run = createSerialQueue((busy) => set({ busy }));

  /** The open order, created if there is none. Only call inside `run`. */
  async function ensureOrderNow(): Promise<OrderSnapshot> {
    const existing = get().snapshot;
    if (existing && existing.order.status === 'open') return existing;
    const order = await ipc.orders.create({
      mode: get().mode,
      tableId: get().tableId,
    });
    const snap = await ipc.orders.get(order.id);
    if (!snap) throw new Error('Order vanished after create');
    set({ snapshot: snap });
    return snap;
  }

  /**
   * Commit any inline customer fields onto the order before it is handed off.
   * Runs inside a queued job: nothing it calls may itself wait on `run`.
   */
  async function commitCustomer(orderId: string, purpose: string): Promise<void> {
    // Lazy-imported to avoid a circular dep with the checkout feature.
    const { commitCustomerToOrder } = await import('../features/checkout/CustomerInlinePanel');
    const { getCustomerFormSnapshot } = await import('../features/checkout/useCustomerForm');
    try {
      await commitCustomerToOrder(orderId, get().mode, getCustomerFormSnapshot());
    } catch (e) {
      // Don't block the sale on customer-write failure — surface via log.
      console.warn(`Customer commit failed (proceeding with ${purpose}):`, e);
    }
  }

  return {
    snapshot: null,
    mode: 'takeaway',
    tableId: null,
    busy: false,
    lastTouch: null,

    async setMode(mode) {
      // Reflect the choice immediately for the mode-bar highlight.
      set({ mode, tableId: mode === 'dine_in' ? get().tableId : null });
      await run(async () => {
        const snap = get().snapshot;
        if (!snap || snap.order.status !== 'open') return;
        try {
          let next = await ipc.orders.setMode({ orderId: snap.order.id, mode });
          // Only a delivery pays the delivery charge: switching away takes the
          // "Delivery Charge (Rs N)" line off the bill (called directly — this
          // already runs inside the queue, so a queued action would wait on itself).
          if (mode !== 'delivery') {
            for (const line of next.items.filter((i) => isDeliveryChargeName(i.menuItemName))) {
              next = await ipc.orders.removeItem({ orderId: next.order.id, orderItemId: line.id });
            }
          }
          set({ snapshot: next, mode: next.order.mode, tableId: next.order.tableId });
        } catch (e) {
          // Persist failed — snap the UI back to the order's real mode so the
          // screen and the saved order can't disagree (that divergence was the
          // bug where "Delivery" never reached the order and it stayed dine-in).
          set({ mode: snap.order.mode, tableId: snap.order.tableId });
          throw e;
        }
      });
    },
    setTableId(id) {
      set({ tableId: id });
    },

    resumeDraft() {
      return run(async () => {
        const existing = get().snapshot;
        if (existing) return existing;
        const snap = await ipc.orders.resumeDraft();
        if (snap) set({ snapshot: snap, mode: snap.order.mode, tableId: snap.order.tableId });
        return snap;
      });
    },

    async discardDraft() {
      await run(async () => {
        const snap = get().snapshot;
        if (!snap) return;
        await ipc.orders.discardDraft(snap.order.id);
        get().reset();
      });
    },

    ensureOrder() {
      return run(ensureOrderNow);
    },

    addItem(menuItemId, quantity = 1, modifierIds = [], notes = null) {
      return run(async () => {
        const order = await ensureOrderNow();
        const same = findMergeableLine(order.items, menuItemId, modifierIds, notes);
        const snap = same
          ? await ipc.orders.updateItemQuantity({
              orderId: order.order.id,
              orderItemId: same.id,
              quantity: same.quantity + quantity,
            })
          : await ipc.orders.addItem({
              orderId: order.order.id,
              menuItemId,
              quantity,
              modifierIds,
              notes,
            });
        set({ snapshot: snap, lastTouch: touch(same?.id ?? addedLineId(order.items, snap.items)) });
      });
    },

    updateItemOptions(orderItemId, modifierIds, notes) {
      return run(async () => {
        const snap = get().snapshot;
        if (!snap) return;
        const next = await ipc.orders.updateItemOptions({
          orderId: snap.order.id,
          orderItemId,
          modifierIds,
          notes,
        });
        set({ snapshot: next, lastTouch: touch(orderItemId) });
      });
    },

    customizeOneOf(orderItemId, modifierIds, notes) {
      return run(async () => {
        const snap = get().snapshot;
        const line = snap?.items.find((i) => i.id === orderItemId);
        if (!snap || !line || !line.menuItemId) return;
        // Add the changed one first: if the second step fails the ticket shows
        // one item too many (easy to see) rather than one silently missing.
        const added = await ipc.orders.addItem({
          orderId: snap.order.id,
          menuItemId: line.menuItemId,
          quantity: 1,
          modifierIds,
          notes,
        });
        set({ snapshot: added, lastTouch: touch(addedLineId(snap.items, added.items)) });
        const next = await ipc.orders.updateItemQuantity({
          orderId: snap.order.id,
          orderItemId,
          quantity: line.quantity - 1,
        });
        set({ snapshot: next });
      });
    },

    updateItemQty(orderItemId, quantity) {
      return run(async () => {
        const snap = get().snapshot;
        if (!snap) return;
        const next = await ipc.orders.updateItemQuantity({
          orderId: snap.order.id,
          orderItemId,
          quantity,
        });
        set({ snapshot: next, ...(quantity > 0 ? { lastTouch: touch(orderItemId) } : {}) });
      });
    },

    bumpItemQty(orderItemId, delta) {
      return run(async () => {
        const snap = get().snapshot;
        const line = snap?.items.find((i) => i.id === orderItemId);
        if (!snap || !line) return;
        const quantity = line.quantity + delta;
        const next = await ipc.orders.updateItemQuantity({
          orderId: snap.order.id,
          orderItemId,
          quantity,
        });
        set({ snapshot: next, ...(quantity > 0 ? { lastTouch: touch(orderItemId) } : {}) });
      });
    },

    removeItem(orderItemId) {
      return run(async () => {
        const snap = get().snapshot;
        if (!snap) return;
        const next = await ipc.orders.removeItem({
          orderId: snap.order.id,
          orderItemId,
        });
        set({ snapshot: next });
      });
    },

    applyDiscount(discountType, value, reason, approverPin) {
      return run(async () => {
        const snap = get().snapshot;
        if (!snap) return;
        const next = await ipc.orders.applyDiscount({
          orderId: snap.order.id,
          discountType,
          value,
          reason: reason ?? null,
          ...(approverPin ? { approverPin } : {}),
        });
        set({ snapshot: next });
      });
    },

    clearDiscount() {
      return run(async () => {
        const snap = get().snapshot;
        if (!snap) return;
        const next = await ipc.orders.clearDiscount(snap.order.id);
        set({ snapshot: next });
      });
    },

    tender(payments) {
      return run(async () => {
        const snap = get().snapshot;
        if (!snap) throw new Error('No open order to tender');
        await commitCustomer(snap.order.id, 'tender');
        const next = await ipc.orders.tender({
          orderId: snap.order.id,
          payments,
        });
        set({ snapshot: next });
        return next;
      });
    },

    sendToKitchen() {
      return run(async () => {
        const snap = get().snapshot;
        if (!snap) throw new Error('No open order to send');
        await commitCustomer(snap.order.id, 'send to kitchen');
        const next = await ipc.orders.sendToKitchen(snap.order.id);
        set({ snapshot: next });
        return next;
      });
    },

    voidCurrent(reason, approverPin) {
      return run(async () => {
        const snap = get().snapshot;
        if (!snap) return;
        const next = await ipc.orders.void({
          orderId: snap.order.id,
          reason,
          approverPin,
        });
        set({ snapshot: next });
      });
    },

    // Not queued: the customer panel may call this from inside a queued
    // tender/send (while committing the customer), and waiting on the queue
    // there would wait on itself.
    async refreshSnapshot() {
      const snap = get().snapshot;
      if (!snap) return;
      const next = await ipc.orders.get(snap.order.id);
      if (next && get().snapshot?.order.id === next.order.id) set({ snapshot: next });
    },

    reset() {
      // Clear inline customer form alongside the order pointer.
      void import('../features/checkout/useCustomerForm').then(({ resetCustomerForm }) =>
        resetCustomerForm(),
      );
      set({ snapshot: null, tableId: null, lastTouch: null });
    },
  };
});
