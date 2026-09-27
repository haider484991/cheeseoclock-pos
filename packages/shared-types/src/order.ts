import type { Cents } from './money.js';
import type { UUID, OrderNumber } from './ids.js';

// 'dine_in' is retained for historical orders; the POS no longer offers it.
export type OrderMode = 'dine_in' | 'takeaway' | 'delivery' | 'online' | 'foodpanda';
/**
 * Order lifecycle. The board groups these into 5 visible columns:
 *   New             → open, sent_to_kitchen
 *   Preparing       → preparing
 *   Ready           → ready
 *   Out for delivery→ out_for_delivery
 *   Done            → delivered, served, paid
 * void/refunded are hidden from the board (visible under filters).
 */
export type OrderStatus =
  | 'open'
  | 'sent_to_kitchen'
  | 'preparing'
  | 'ready'
  | 'out_for_delivery'
  | 'delivered'
  | 'served'
  | 'paid'
  | 'void'
  | 'refunded';
export type OrderSource = 'pos' | 'web';

/**
 * Delivery rider / driver. Lightweight roster managed in the Riders page.
 * Inactive riders are hidden from the assignment picker but kept for history.
 */
export interface Rider {
  id: UUID;
  name: string;
  phone: string;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PaymentMethod =
  | 'cash'
  | 'card'
  | 'easypaisa'
  | 'jazzcash'
  | 'bank_transfer'
  /** Settled by the platform (migration 0020) — never drawer cash. Only foodpanda orders use it. */
  | 'foodpanda';

export interface Order {
  id: UUID;
  orderNumber: OrderNumber;
  mode: OrderMode;
  status: OrderStatus;
  tableId: UUID | null;
  customerId: UUID | null;
  cashierId: UUID;
  shiftId: UUID;
  source: OrderSource;
  notes: string | null;
  subtotalCents: Cents;
  discountCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
  createdAt: string;
  paidAt: string | null;
  voidedAt: string | null;
  voidedBy: UUID | null;
  voidReason: string | null;
  // Delivery tracking (set only when applicable):
  assignedRiderId: UUID | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  /**
   * Set only on an order read with its deleted ones (getOrderSnapshot
   * includeDeleted): when and by whom it was deleted, why, and how
   * (migration 0043: 'test' — deleted by the owner as a test order; a
   * discarded draft carries no kind). Deleted orders never reach a screen.
   */
  deletedAt?: string | null;
  deletedBy?: UUID | null;
  deleteReason?: string | null;
  deleteKind?: OrderDeleteKind | null;
  /** What deleting it as a test did to its stock. */
  deleteStock?: TestDeleteStock | null;
}

/** How an order was deleted: 'test' — the owner deleted it as a test order (0043). */
export type OrderDeleteKind = 'test';

/**
 * What deleting a test order did to its stock:
 *  - put_back: "Yes — put it back": the food was not made, back on the shelf;
 *  - waste: "No — count it as waste": the food was made, booked as waste;
 *  - none: it took no stock (no recipes, or nothing sent);
 *  - settled_before: already put back or wasted when it was cancelled or
 *    refunded — that answer stands.
 */
export type TestDeleteStock = 'put_back' | 'waste' | 'none' | 'settled_before';

export type KitchenStatus = 'pending' | 'preparing' | 'ready' | 'served';

export interface OrderItem {
  id: UUID;
  orderId: UUID;
  menuItemId: UUID | null;
  comboId: UUID | null;
  parentOrderItemId: UUID | null;
  quantity: number;
  unitPriceCents: Cents;
  lineTotalCents: Cents;
  taxCategoryId: UUID;
  notes: string | null;
  kitchenStatus: KitchenStatus;
}

export interface OrderItemModifier {
  id: UUID;
  orderItemId: UUID;
  modifierId: UUID;
  modifierName: string;
  priceDeltaCents: Cents;
}

export interface OrderDiscount {
  id: UUID;
  orderId: UUID;
  discountType: 'percent' | 'flat';
  value: number;
  reason: string | null;
  appliedByUserId: UUID;
  approvedByUserId: UUID | null;
  amountCents: Cents;
}

export interface Payment {
  id: UUID;
  orderId: UUID;
  method: PaymentMethod;
  amountCents: Cents;
  tenderedCents: Cents | null;
  referenceNo: string | null;
  receivedByUserId: UUID;
  paidAt: string;
  /** Only on a snapshot read with its deleted rows: this payment was deleted (with its test order). */
  deletedAt?: string | null;
}

/**
 * OrderSnapshot is the read-model handed to print templates, FBR mappers, and
 * report exporters. It carries all the data needed to render an order without
 * doing additional lookups.
 */
export interface OrderSnapshot {
  order: Order;
  items: Array<
    OrderItem & {
      menuItemName: string;
      categoryName: string;
      prepStation: 'kitchen' | 'bar' | 'cold';
      /** Tax rate snapshotted on the line at order time (basis points). */
      taxRateBps?: number;
      modifiers: OrderItemModifier[];
    }
  >;
  discounts: OrderDiscount[];
  payments: Payment[];
  cashierName: string;
  tableLabel: string | null;
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress: string | null;
  /**
   * The counter's "Order notes" box (orders.delivery_notes): "ring upper
   * bell", "collect by 7pm". Printed on the kitchen ticket and the bill, and
   * shown on the Live Orders card, with the website customer's own note —
   * see orderNotesOf. Absent from a snapshot made before it was read.
   */
  deliveryNotes?: string | null;
  /** Rider snapshot for the order — null until a rider is assigned. */
  rider: { id: UUID; name: string; phone: string } | null;
}

/**
 * The till's tag in front of a website customer's note, as the web bridge
 * stores it in orders.notes: "[web] …" / "[web pick-up] …", or the tag alone
 * when the customer wrote nothing ("[web order]", "[web pick-up order]").
 */
const WEB_NOTE_TAG = /^\[web(?: pick-up)?(?: order)?\]\s*/i;

/**
 * What was written for the WHOLE order — not one item (each line's allergy /
 * special-request note stays on its line) — for the kitchen ticket, the bill
 * and receipt, and the Live Orders card, the same way for every order:
 *  - the order's own note (orders.notes). For a website order that is the
 *    customer's "Directions for the rider" / "Notes for the counter", without
 *    the till's "[web]" tag; the tag alone is not a note (the card's Web
 *    badge and the kitchen ticket's WEBSITE line say where it came from);
 *  - the counter's "Order notes" box (orders.delivery_notes).
 * Trimmed; empty ones left out; the same words never twice.
 */
export function orderNotesOf(s: {
  order: Pick<Order, 'notes' | 'source'>;
  deliveryNotes?: string | null;
}): string[] {
  const own = (s.order.notes ?? '').trim();
  const fromOrder = s.order.source === 'web' ? own.replace(WEB_NOTE_TAG, '').trim() : own;
  const fromCounter = (s.deliveryNotes ?? '').trim();
  const notes: string[] = [];
  if (fromOrder) notes.push(fromOrder);
  if (fromCounter && fromCounter !== fromOrder) notes.push(fromCounter);
  return notes;
}
