import { create } from 'zustand';
import { v7 as uuidv7 } from 'uuid';
import type {
  CameBy,
  FoodMade,
  FoodpandaTenderCheck,
  OrderEditDiff,
  OrderEditNeeds,
  OrderEditOp,
  OrderEditSaved,
  OrderSnapshot,
  OrderMode,
  PaymentMethod,
} from '@cheeseoclock/shared-types';
import { isCameBy } from '@cheeseoclock/shared-types';
import { ipc } from '../ipc/client';
import { addedLineId, createSerialQueue, findMergeableLine } from '../features/checkout/cartLines';
import { customersChanged } from '../features/checkout/customerLookups';
import { appendEditOp, withoutLine } from '../features/checkout/editOps';
import type { CustomerFormState } from '../features/checkout/CustomerInlinePanel';

/**
 * Edit order (v0.7.36): an order the kitchen has, being changed at Checkout.
 * The ticket shows the order as Save will leave it — the till's own preview
 * (orders:previewEdit), nothing written until Save — and the cart's taps
 * become the edit's changes (editOps). The counter's own cart is put aside
 * meanwhile and comes back after Save or Cancel.
 */
export interface EditSession {
  orderId: string;
  /** The order as the kitchen has it: the ticket's NEW and "was" marks read it. */
  base: OrderSnapshot;
  /** What the edit is worked on (Save is refused if the order changed since). */
  baseKey: string;
  ops: OrderEditOp[];
  /** What changes, and what Save will ask for (a manager's PIN, a reason), for the changes so far. */
  diff: OrderEditDiff;
  needs: OrderEditNeeds;
  /** Where the edit was started from (Live Orders, Recent Orders…): the screen goes back there after. */
  returnTo: string;
  /** The counter's own cart, put aside while the edit runs. */
  parked: ParkedCart;
}

interface ParkedCart {
  snapshot: OrderSnapshot | null;
  mode: OrderMode;
  tableId: string | null;
  cameBy: CameBy | null;
  form: CustomerFormState;
  committed: string | null;
}

/** Save's answers: the manager's PIN or password, the reason, and "Was the food made?" per item taken off. */
export interface EditAnswers {
  approverPin?: string;
  reason?: string | null;
  foodMade?: Record<string, FoodMade>;
}

/** The till answered a change for an order that changed meanwhile (the other till, another edit). */
export const EDIT_CHANGED_MEANWHILE = 'This order was changed somewhere else while you were changing it. Cancel, then start the change again.';
/** Pay, Send and the order type are the counter's: not while an order the kitchen has is being changed. */
export const EDIT_IN_PROGRESS = 'Save or cancel the change to the order first.';

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
  /**
   * How the order came in (Walk-in · Phone · WhatsApp), as the chips show it:
   * the open order's, or the one tapped before the first item (it goes on the
   * order when it is created). Null = not said.
   */
  cameBy: CameBy | null;
  /** A change to the order is still on its way to the till (Pay / Send wait for it). */
  busy: boolean;
  lastTouch: LineTouch | null;

  /** Set the mode; persists to the open order so the saved order, board and
   *  reports agree with the on-screen choice. Rejects if the write fails. */
  setMode: (mode: OrderMode) => Promise<void>;
  setTableId: (id: string | null) => void;
  /**
   * Tap a came-by chip (tap it again: not said). Saved on the open order in
   * turn with the other taps; the owner's automatic offers follow it there.
   * Rejects when the till refuses it.
   */
  setCameBy: (cameBy: CameBy | null) => Promise<void>;

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
  /**
   * The delivery area on the customer panel changed: the main process puts
   * that area's delivery charge on the open order when the area CHANGED
   * (swaps a wrong one, takes it off when the area is cleared) and leaves a
   * charge taken off by hand alone otherwise (order-repo
   * deliveryChargeForArea). The customer save at Send and Pay does the same
   * with the saved address, in the main process: nothing here has to run
   * before the order leaves. `mayStartOrder`: with no order yet, start one
   * to carry the charge (only when there is a charge to put on).
   * `forOrderId`: the order the panel asked about — a late ask for an order
   * that has since been sent (or cleared) does nothing, and never starts a
   * new order. `putBack`: the row's "Put it back". `phone`: the phone typed
   * on the panel, for the add-on rule (no second delivery charge while the
   * same customer's delivery is still in the shop; OrderSnapshot.addOnTo):
   * sent as it is, null for none; left out, the request carries none.
   */
  setDeliveryArea: (
    area: string,
    opts?: { mayStartOrder?: boolean; forOrderId?: string | null; putBack?: boolean; phone?: string | null },
  ) => Promise<void>;
  /**
   * "Custom charge" on the delivery-charge row (owner, 10 Oct 2026: "custom
   * delivery charges"): a fee typed in whole rupees goes on in place of the
   * bill's delivery charges (orders:setDeliveryCharge). Only on an open
   * order, never while an order the kitchen has is being changed.
   */
  setDeliveryCharge: (feeCents: number) => Promise<void>;
  /**
   * `opts.free`: a Free order (v0.7.36) — 100% off everything, value deals
   * and the delivery charge too, with a reason and a manager's PIN or
   * password. While an order the kitchen has is being changed, the PIN is
   * asked at Save, not here.
   */
  applyDiscount: (
    discountType: 'percent' | 'flat',
    value: number,
    reason?: string,
    approverPin?: string,
    opts?: { free?: boolean },
  ) => Promise<void>;
  /**
   * Taking the shop's foodpanda deal off needs a manager's PIN or password.
   * The × on one of the owner's automatic offers takes it off this order
   * (it stays off); clearing that again puts the offers back.
   */
  clearDiscount: (approverPin?: string) => Promise<void>;
  /**
   * Before Pay opens: the customer typed in is saved on the order, so the
   * bill Pay shows is final — an automatic offer that needs the customer's
   * phone goes on NOW, not inside the payment (which would then no longer
   * match the bill). Resolves with the order as it is.
   */
  prepareToPay: () => Promise<OrderSnapshot | null>;
  tender: (
    payments: Array<{
      method: PaymentMethod;
      amountCents: number;
      tenderedCents?: number | null;
      referenceNo?: string | null;
    }>,
    /** A foodpanda order: the total the tablet shows. */
    foodpanda?: FoodpandaTenderCheck,
  ) => Promise<OrderSnapshot>;
  /**
   * Commit the order without tendering — for the COD entry path on delivery
   * (and takeaway) orders. Validates the customer/address inline, calls
   * sendToKitchen, returns the snapshot. After this the order shows on the
   * Live Orders board.
   *
   * Once a day per phone (order-edit #12): when the phone Send just saved
   * shows that a live order of this customer holds today's offer, and the
   * cart was not already saying so, nothing is sent: the cart now says
   * 'Cancel #0042 first to keep the offer' and this rejects with
   * OfferHeldBack. Send again goes without the offer (or with it, once #0042
   * was cancelled or refunded).
   */
  sendToKitchen: () => Promise<OrderSnapshot>;
  /** Refetch the current order snapshot — used after side mutations like attachCustomer. */
  refreshSnapshot: () => Promise<void>;
  /** Discard the local pointer to the snapshot — used after tender to start fresh. */
  reset: () => void;

  /** The order the kitchen has that is being changed (Edit order, v0.7.36), or null at the counter. */
  edit: EditSession | null;
  /**
   * Start changing an order the kitchen has: the till says whether it may
   * be changed (refused in its words: paid, out, foodpanda…). The counter's
   * own cart is put aside. `returnTo`: the screen to go back to after.
   */
  startEdit: (orderId: string, returnTo: string) => Promise<void>;
  /** Undo everything the edit did to one line (one added: gone; one the kitchen has: as it was). */
  undoEditLine: (lineId: string) => Promise<void>;
  /** Leave the order as the kitchen has it; the counter's cart comes back. */
  cancelEdit: () => Promise<void>;
  /** Save the change (the till asks again for anything missing); the counter's cart comes back. */
  saveEdit: (answers: EditAnswers) => Promise<OrderEditSaved>;
}

let touchSeq = 0;
function touch(lineId: string | null | undefined): LineTouch | null {
  return lineId ? { lineId, seq: ++touchSeq } : null;
}

/**
 * The cart said a live order of this phone holds the once-a-day offer
 * ('Cancel #0042 first to keep the offer'). That order may have been
 * cancelled or refunded since, with no cart change after it to put the offer
 * on: Pay and Send save the customer again, and the save works the offer out
 * again. Not at the payment itself: the bill Pay showed must not move.
 */
function heldOfferMayBeFree(snap: OrderSnapshot): boolean {
  return snap.order.status === 'open' && !!snap.offerHeldBy;
}

/**
 * The cart said this delivery goes with the same customer's #0042, so its
 * delivery charge was left off ('Goes with #0042: no second delivery
 * charge'). #0042 may have gone out, or been cancelled, since: Pay and Send
 * save the customer again even with nothing changed, and the save settles
 * the add-on rule again (a first delivery gone out means a new trip, charged)
 * before the order is sent or paid. Not at the payment itself.
 */
function addOnMayHaveGone(snap: OrderSnapshot): boolean {
  return snap.order.status === 'open' && !!snap.addOnTo;
}

/** Pay's and Send's customer save runs again with nothing changed while the cart's words may be out of date. */
function savesAgain(snap: OrderSnapshot): boolean {
  return heldOfferMayBeFree(snap) || addOnMayHaveGone(snap);
}

/**
 * Send stopped before the kitchen: the phone it just saved shows that a live
 * order of this customer holds today's once-a-day offer, which the cart was
 * not saying yet. The cart says it now; `held` is that order.
 */
export class OfferHeldBack extends Error {
  readonly held: NonNullable<OrderSnapshot['offerHeldBy']>;
  constructor(held: NonNullable<OrderSnapshot['offerHeldBy']>) {
    super(`#${held.orderNumber.split('-').pop()} has this customer's offer today`);
    this.name = 'OfferHeldBack';
    this.held = held;
  }
}

/** The chip an order shows: its own came-by when it is one of the counter's three. */
function chipOf(snap: OrderSnapshot | null | undefined): CameBy | null {
  const c = snap?.order.cameBy;
  return isCameBy(c) ? c : null;
}

export const useCheckoutStore = create<CheckoutState>((set, get) => {
  // Every change to the order goes through this one queue, in tap order.
  // Side by side, two quick first taps each created an order (one orphaned),
  // and a Pay could read the order before the last item had landed.
  const run = createSerialQueue((busy) => set({ busy }));

  /**
   * What the customer form last saved on which order: Pay saves it before it
   * opens (prepareToPay), so the payment does not save it a second time (a
   * typed address would be added twice). Any change to the form saves again.
   */
  let committed: string | null = null;

  /**
   * The open order, created if there is none. Only call inside `run`.
   *
   * An emptied cart (every line taken off) is not reused: the next customer
   * would get its start time and its number (owner 2026-10-02). orders:create
   * drops it. A delivery started by its area is kept: it is this customer's,
   * and a delivery charge taken off by hand stays off.
   */
  async function ensureOrderNow(): Promise<OrderSnapshot> {
    const existing = get().snapshot;
    if (existing && existing.order.status === 'open') {
      if (existing.items.length > 0) return existing;
      const { getCustomerFormSnapshot } = await import('../features/checkout/useCustomerForm');
      if (existing.order.mode === 'delivery' && getCustomerFormSnapshot().area.trim() !== '') return existing;
    }
    const mode = get().mode;
    const cameBy = mode === 'takeaway' || mode === 'delivery' ? get().cameBy : null;
    const order = await ipc.orders.create({
      mode,
      tableId: get().tableId,
      ...(cameBy ? { cameBy } : {}),
    });
    const snap = await ipc.orders.get(order.id);
    if (!snap) throw new Error('Order vanished after create');
    set({ snapshot: snap });
    return snap;
  }

  /**
   * Commit any inline customer fields onto the order before it is handed off.
   * Runs inside a queued job: nothing it calls may itself wait on `run`.
   * `again`: save it even when nothing changed since the last save, so the
   * main process works the owner's offer and the add-on rule out again (each
   * save does). Resolves with the order as the till answered the save, or
   * null when nothing was saved (or the save failed).
   */
  async function commitCustomer(
    orderId: string,
    purpose: string,
    opts: { again?: boolean } = {},
  ): Promise<OrderSnapshot | null> {
    // Lazy-imported to avoid a circular dep with the checkout feature.
    const { commitCustomerToOrder, formAfterCommit } = await import('../features/checkout/CustomerInlinePanel');
    const { getCustomerFormSnapshot, setCustomerForm } = await import('../features/checkout/useCustomerForm');
    const form = getCustomerFormSnapshot();
    const mode = get().mode;
    const sig = JSON.stringify({ orderId, mode, form });
    if (sig === committed && !opts.again) return null;
    try {
      const saved = await commitCustomerToOrder(orderId, mode, form);
      // The form now points at the customer and address it saved, so a later
      // save (the note changed after Pay was closed) reuses them instead of
      // adding the address — or a nameless customer — a second time. Only
      // when nothing was typed meanwhile.
      if (saved && getCustomerFormSnapshot() === form) {
        const next = formAfterCommit(form, saved);
        setCustomerForm(next);
        committed = JSON.stringify({ orderId, mode, form: next });
      } else {
        committed = sig;
      }
      return saved?.snapshot ?? null;
    } catch (e) {
      // Don't block the sale on customer-write failure — surface via log.
      console.warn(`Customer commit failed (proceeding with ${purpose}):`, e);
      return null;
    }
  }

  /**
   * Inside `run`, while an order is being changed: these changes as the
   * till works them out (nothing written), and the ticket shows the result.
   * Refused in the till's words: nothing changes on screen.
   */
  async function previewEditNow(ops: OrderEditOp[], touchLine: string | null = null): Promise<void> {
    const e = get().edit;
    if (!e) return;
    const p = await ipc.orders.previewEdit({ orderId: e.orderId, ops });
    if (p.baseKey !== e.baseKey) throw new Error(EDIT_CHANGED_MEANWHILE);
    set({ edit: { ...e, ops, diff: p.diff, needs: p.needs }, snapshot: p.snapshot, ...(touchLine ? { lastTouch: touch(touchLine) } : {}) });
  }

  /** Inside `run`: one or more taps folded into the edit's changes (editOps), then previewed. */
  async function editWith(more: OrderEditOp | OrderEditOp[], touchLine: string | null = null): Promise<void> {
    const e = get().edit;
    if (!e) return;
    let ops = e.ops;
    for (const op of Array.isArray(more) ? more : [more]) ops = appendEditOp(ops, op, e.base);
    await previewEditNow(ops, touchLine);
  }

  /** Inside `run`: back to the counter's own cart, as it was put aside. */
  async function leaveEdit(e: EditSession): Promise<void> {
    const { setCustomerForm } = await import('../features/checkout/useCustomerForm');
    const p = e.parked;
    setCustomerForm(p.form);
    committed = p.committed;
    set({ edit: null, snapshot: p.snapshot, mode: p.mode, tableId: p.tableId, cameBy: p.cameBy, lastTouch: null });
  }

  /** The counter's own actions (Pay, Send, the order type…) are refused while an order is being changed. */
  function notWhileEditing(): void {
    if (get().edit) throw new Error(EDIT_IN_PROGRESS);
  }

  return {
    snapshot: null,
    mode: 'takeaway',
    tableId: null,
    cameBy: null,
    busy: false,
    lastTouch: null,
    edit: null,

    async setMode(mode) {
      // The order the kitchen has keeps its type: nothing to switch while it is being changed.
      if (get().edit) return;
      // Reflect the choice immediately for the mode-bar highlight.
      set({ mode, tableId: mode === 'dine_in' ? get().tableId : null });
      await run(async () => {
        const snap = get().snapshot;
        if (!snap || snap.order.status !== 'open') return;
        try {
          // Only a delivery pays the delivery charge: the main process takes its line off when
          // the order leaves Delivery, and puts the area's back when it returns (setOrderMode).
          const next = await ipc.orders.setMode({ orderId: snap.order.id, mode });
          set({ snapshot: next, mode: next.order.mode, tableId: next.order.tableId, cameBy: chipOf(next) });
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

    async setCameBy(cameBy) {
      if (get().edit) return;
      const was = get().cameBy;
      // The chip lights at once; the order follows in turn with the taps.
      set({ cameBy });
      await run(async () => {
        const snap = get().snapshot;
        if (!snap || snap.order.status !== 'open') return;
        try {
          const next = await ipc.orders.setCameBy({ orderId: snap.order.id, cameBy });
          set({ snapshot: next, cameBy: chipOf(next) });
        } catch (e) {
          set({ cameBy: was });
          throw e;
        }
      });
    },

    resumeDraft() {
      return run(async () => {
        const existing = get().snapshot;
        if (existing) return existing;
        const snap = await ipc.orders.resumeDraft();
        if (snap) set({ snapshot: snap, mode: snap.order.mode, tableId: snap.order.tableId, cameBy: chipOf(snap) });
        return snap;
      });
    },

    async discardDraft() {
      await run(async () => {
        const snap = get().snapshot;
        if (!snap || get().edit) return;
        await ipc.orders.discardDraft(snap.order.id);
        get().reset();
      });
    },

    ensureOrder() {
      return run(ensureOrderNow);
    },

    addItem(menuItemId, quantity = 1, modifierIds = [], notes = null) {
      return run(async () => {
        if (get().edit) {
          // The same plain item again is one more on that line, as at the counter (the kitchen's
          // slip says ADD either way); anything else is a new line with its own id.
          const same = findMergeableLine(get().snapshot?.items ?? [], menuItemId, modifierIds, notes);
          if (same) return editWith({ op: 'qty', orderItemId: same.id, quantity: same.quantity + quantity }, same.id);
          const lineId = uuidv7();
          return editWith({ op: 'add', lineId, menuItemId, quantity, modifierIds, notes }, lineId);
        }
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
        if (get().edit) return editWith({ op: 'options', orderItemId, modifierIds, notes }, orderItemId);
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
        if (get().edit) {
          // One of a line of several, changed: a new line of one with the choices, one less on the old.
          const lineId = uuidv7();
          return editWith(
            [
              { op: 'add', lineId, menuItemId: line.menuItemId, quantity: 1, modifierIds, notes },
              { op: 'qty', orderItemId, quantity: line.quantity - 1 },
            ],
            lineId,
          );
        }
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
        if (get().edit) return editWith({ op: 'qty', orderItemId, quantity }, quantity > 0 ? orderItemId : null);
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
        if (get().edit) return editWith({ op: 'qty', orderItemId, quantity }, quantity > 0 ? orderItemId : null);
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
        if (get().edit) return editWith({ op: 'remove', orderItemId });
        const snap = get().snapshot;
        if (!snap) return;
        const next = await ipc.orders.removeItem({
          orderId: snap.order.id,
          orderItemId,
        });
        set({ snapshot: next });
      });
    },

    setDeliveryArea(area, opts = {}) {
      return run(async () => {
        // The order the kitchen has keeps its customer and its delivery charge as they are.
        if (get().edit) return;
        const snap = get().snapshot;
        // The order was just sent or paid (the screen not cleared yet): a late ask is not a new order.
        if (snap && snap.order.status !== 'open') return;
        // Asked about an order that has left the screen since (sent, then cleared): nothing to do.
        if (opts.forOrderId && snap?.order.id !== opts.forOrderId) return;
        let orderId = snap ? snap.order.id : null;
        if (!orderId) {
          // No order: nothing to take off; start one only to carry a charge.
          if (!opts.mayStartOrder || get().mode !== 'delivery' || !area.trim()) return;
          orderId = (await ensureOrderNow()).order.id;
        }
        const next = await ipc.orders.setDeliveryArea({
          orderId,
          area: area.trim() || null,
          ...(opts.putBack ? { putBack: true } : {}),
          // The panel's phone (null: none typed): the main process matches it while the order has none of its own.
          ...(opts.phone !== undefined ? { phone: opts.phone } : {}),
        });
        if (get().snapshot?.order.id === next.order.id) set({ snapshot: next });
      });
    },

    setDeliveryCharge(feeCents) {
      return run(async () => {
        if (get().edit) return;
        const snap = get().snapshot;
        if (!snap || snap.order.status !== 'open') return;
        const next = await ipc.orders.setDeliveryCharge({ orderId: snap.order.id, feeCents });
        if (get().snapshot?.order.id === next.order.id) set({ snapshot: next });
      });
    },

    applyDiscount(discountType, value, reason, approverPin, opts = {}) {
      return run(async () => {
        // Changing an order the kitchen has: a manager's PIN, when it needs one, is asked at Save.
        if (get().edit) {
          return editWith({ op: 'discount', discountType, value, reason: reason ?? null, ...(opts.free ? { free: true } : {}) });
        }
        const snap = get().snapshot;
        if (!snap) return;
        const next = await ipc.orders.applyDiscount({
          orderId: snap.order.id,
          discountType,
          value,
          reason: reason ?? null,
          ...(approverPin ? { approverPin } : {}),
          ...(opts.free ? { free: true } : {}),
        });
        set({ snapshot: next });
      });
    },

    clearDiscount(approverPin) {
      return run(async () => {
        if (get().edit) return editWith({ op: 'clearDiscount' });
        const snap = get().snapshot;
        if (!snap) return;
        const next = await ipc.orders.clearDiscount(snap.order.id, approverPin);
        set({ snapshot: next });
      });
    },

    prepareToPay() {
      return run(async () => {
        notWhileEditing();
        const snap = get().snapshot;
        if (!snap || snap.order.status !== 'open') return snap;
        // The saved address brings its area's delivery charge with it (the main process, in the
        // same transaction): Pay shows the final bill.
        await commitCustomer(snap.order.id, 'pay', { again: savesAgain(snap) });
        const next = await ipc.orders.get(snap.order.id);
        if (next) set({ snapshot: next });
        return next ?? snap;
      });
    },

    tender(payments, foodpanda) {
      return run(async () => {
        notWhileEditing();
        const snap = get().snapshot;
        if (!snap) throw new Error('No open order to tender');
        await commitCustomer(snap.order.id, 'tender');
        const next = await ipc.orders.tender({
          orderId: snap.order.id,
          payments,
          ...(foodpanda ? { foodpanda } : {}),
        });
        set({ snapshot: next });
        return next;
      });
    },

    sendToKitchen() {
      return run(async () => {
        notWhileEditing();
        const snap = get().snapshot;
        if (!snap) throw new Error('No open order to send');
        const saved = await commitCustomer(snap.order.id, 'send to kitchen', { again: savesAgain(snap) });
        // The phone just saved shows a live order of this customer holding today's offer, and the
        // cart was not saying so (it only knew the phone saved before): stop here, so the cart says
        // 'Cancel #0042 first to keep the offer' before the order is locked at full price. Send
        // again goes without it; the cart already saying it (the same order) goes too.
        const held = saved && saved.order.id === snap.order.id && saved.order.status === 'open' ? (saved.offerHeldBy ?? null) : null;
        if (held && held.orderId !== snap.offerHeldBy?.orderId) {
          if (get().snapshot?.order.id === saved?.order.id) set({ snapshot: saved });
          throw new OfferHeldBack(held);
        }
        const next = await ipc.orders.sendToKitchen(snap.order.id);
        set({ snapshot: next });
        // The customer's lists (their past orders, the phone search) are asked again.
        customersChanged();
        return next;
      });
    },

    // Not queued: the customer panel may call this from inside a queued
    // tender/send (while committing the customer), and waiting on the queue
    // there would wait on itself.
    async refreshSnapshot() {
      const snap = get().snapshot;
      // While an order is being changed the ticket is the till's preview, not the stored order.
      if (!snap || get().edit) return;
      const next = await ipc.orders.get(snap.order.id);
      if (next && get().snapshot?.order.id === next.order.id) set({ snapshot: next });
    },

    reset() {
      // Clear inline customer form alongside the order pointer.
      void import('../features/checkout/useCustomerForm').then(({ resetCustomerForm }) =>
        resetCustomerForm(),
      );
      committed = null;
      // A change not saved is dropped (sign-out); the counter's cart put aside is still 'open'
      // in the till and comes back with "Unfinished order restored".
      set({ snapshot: null, tableId: null, lastTouch: null, cameBy: null, edit: null });
    },

    startEdit(orderId, returnTo) {
      return run(async () => {
        if (get().edit) throw new Error(EDIT_IN_PROGRESS);
        // The till says whether it may be changed, in its own words, before anything moves.
        const p = await ipc.orders.previewEdit({ orderId, ops: [] });
        const { getCustomerFormSnapshot, resetCustomerForm } = await import('../features/checkout/useCustomerForm');
        const st = get();
        const parked: ParkedCart = {
          snapshot: st.snapshot,
          mode: st.mode,
          tableId: st.tableId,
          cameBy: st.cameBy,
          form: getCustomerFormSnapshot(),
          committed,
        };
        resetCustomerForm();
        committed = null;
        set({
          edit: { orderId, base: p.snapshot, baseKey: p.baseKey, ops: [], diff: p.diff, needs: p.needs, returnTo, parked },
          snapshot: p.snapshot,
          mode: p.snapshot.order.mode,
          tableId: p.snapshot.order.tableId,
          cameBy: chipOf(p.snapshot),
          lastTouch: null,
        });
      });
    },

    undoEditLine(lineId) {
      return run(async () => {
        const e = get().edit;
        if (!e) return;
        await previewEditNow(withoutLine(e.ops, lineId));
      });
    },

    cancelEdit() {
      return run(async () => {
        const e = get().edit;
        if (e) await leaveEdit(e);
      });
    },

    saveEdit(answers) {
      return run(async () => {
        const e = get().edit;
        if (!e) throw new Error('Nothing is being changed');
        const saved = await ipc.orders.saveEdit({
          orderId: e.orderId,
          baseKey: e.baseKey,
          ops: e.ops,
          ...(answers.approverPin ? { approverPin: answers.approverPin } : {}),
          ...(answers.reason?.trim() ? { reason: answers.reason.trim() } : {}),
          ...(answers.foodMade && Object.keys(answers.foodMade).length > 0 ? { foodMade: answers.foodMade } : {}),
        });
        await leaveEdit(e);
        return saved;
      });
    },
  };
});
