import type { Cents } from './money.js';
import type { UUID, OrderNumber } from './ids.js';
import type { DiscountSource, FoodpandaDealShare, OfferShare, OrderCameBy } from './shop-settings.js';

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
  /**
   * When the order first left open (orders.sent_at, migration 0048): Send to
   * kitchen, Pay now or a website order's import. Stamped once, never moved.
   * Absent before 0.7.34 and on an order never sent: read createdAt then.
   */
  sentAt?: string | null;
  paidAt: string | null;
  voidedAt: string | null;
  voidedBy: UUID | null;
  voidReason: string | null;
  // Delivery tracking (set only when applicable):
  assignedRiderId: UUID | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  /**
   * What an outside rider keeps of this order (orders.rider_keeps_cents,
   * migration 0049), frozen when it was sent out: its delivery-charge lines
   * as sold, never more than the total; 0 = sent out with no charge to keep.
   * Absent = one of the shop's own riders (Assign rider), not out yet, or an
   * order from before 0.7.34. Read it through isOutsideRiderOrder.
   */
  riderKeepsCents?: Cents | null;
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
  /**
   * How the order came in (orders.came_by, migration 0044): the counter's
   * Walk-in / Phone / WhatsApp chip, or 'website' / 'foodpanda', filled in
   * by the order itself. Absent = not asked, or an order from before 0044.
   * Locked when the order is sent: a change after that needs a manager's PIN
   * and is audited (order-repo setOrderCameBy).
   */
  cameBy?: OrderCameBy | null;
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
  /**
   * Never discounted (migration 0047 order_items.no_discount): a snapshot
   * taken when the line was added — its category's answer then
   * (categoryNeverDiscounted), or the website's own flag on a web line; never
   * on a delivery charge. A later change to the category leaves it as it is.
   * Absent / false on every line sold before 0.7.34.
   */
  noDiscount?: boolean;
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
  /**
   * Where it came from (migration 0040): 'foodpanda' = the shop's standing
   * foodpanda deal, put on automatically; 'offer' = one of the owner's
   * automatic offers (Money & discounts); null/absent = typed by staff (F3).
   */
  source?: DiscountSource | null;
  /** A foodpanda deal's figures on this order (the whole deal, foodpanda's part). */
  foodpanda?: FoodpandaDealShare | null;
  /** One of the owner's automatic offers (source 'offer'): its name and frozen terms, and whether the cashier took it off. */
  offer?: OfferShare | null;
  /**
   * Whether this discount also came off the order's delivery charge, as
   * FROZEN on its row when it was given (order_discounts.rule_json; pos-domain
   * discountRuleAlsoOffDeliveryCharge), never the live setting. false = worked
   * on and split over the food only: the delivery charge takes none of it
   * (the tax split and the FBR invoice follow). true = over every line, as
   * every discount before the rule existed (a row with no rule reads true).
   */
  alsoOffDeliveryCharge?: boolean;
  /**
   * Whether this discount left the value deals alone (the order lines marked
   * noDiscount), as FROZEN on its row (pos-domain discountRuleScope) and, on
   * the order's newest row, read against the stored bill (storedDiscountScope:
   * false when a till older than the rule re-worked it over the deals too).
   * true = not worked on them, not split over them (the tax split and the FBR
   * invoice follow). false / absent = over them too, as every discount before
   * 0.7.34, the foodpanda deal and a manager's discount on a foodpanda order.
   */
  skipsNoDiscountLines?: boolean;
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
  /**
   * What the drawer paid the outside rider for this order (migration 0049: a
   * live cash payout with cash_movements.order_id): the delivery charge he
   * kept when the money was settled ('kept': Rider paid, Delivered + Pay, or
   * a prepaid order sent out), or a trip he went on for an order then
   * cancelled ('trip'). amountCents is the payout, `at` when it was paid.
   * Null on an outside-rider order (isOutsideRiderOrder) nothing has been
   * paid out for yet; absent on every other order with no such payout. A
   * refund never takes it back. Read from the oldest live payout: two meet
   * only through a two-till race.
   */
  deliveryChargeToRider?: { amountCents: Cents; at: string; why: 'kept' | 'trip' } | null;
  /**
   * One trip, one fee (the owner, 2 Oct 2026: an order refunded and sent
   * again on the same trip pays the rider one Rs 200, not two): another
   * delivery of this customer's phone, started today, that an outside rider
   * took out and that was refunded in full WHILE STILL ON ITS TRIP (sent
   * out, never delivered) — the drawer already paid him its charge
   * (amountCents, the live payout). Send out then defaults to no delivery
   * charge for him on this order ('Charge again' puts it back). Filled on a
   * delivery still in the kitchen or Ready that has a phone (null when there
   * is none); absent on every other order. An order delivered and refunded
   * later, or a cancelled one paid for a wasted trip, never counts.
   */
  riderPaidEarlier?: { orderId: UUID; orderNumber: OrderNumber; amountCents: Cents } | null;
  /**
   * Only on orders:listActive, from this till's print queue: the kitchen
   * ticket did not print and nothing has printed it since (Live Orders'
   * "Ticket not printed"). Absent everywhere else.
   */
  kitchenTicketNotPrinted?: boolean;
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

/** Who a website order was taken by, on paper. */
export const WEBSITE_CASHIER_NAME = 'Website';

/**
 * Who took the order, as the papers print it: "Cashier: …" on a bill, a
 * receipt or a refund slip, and the name on a kitchen ticket. A website
 * order says "Website". The till files a website order under its first
 * owner login (web-orders-bridge resolveActor), because orders.cashier_id
 * must name a user; that stays as it is for the audit trail, and only the
 * paper says where the order came from. It is decided from the order
 * itself, so a reprint of an old website order says "Website" too.
 */
export function paperCashierName(s: { order: Pick<Order, 'source'>; cashierName: string }): string {
  return s.order.source === 'web' ? WEBSITE_CASHIER_NAME : s.cashierName;
}

/**
 * The order went out with an outside rider (Send out): it carries what he
 * keeps (Order.riderKeepsCents, 0 included). False for one of the shop's own
 * riders (Assign rider: he brings back the full bill), an order not out yet,
 * and every order from before 0.7.34.
 */
export function isOutsideRiderOrder(o: { readonly riderKeepsCents?: number | null }): boolean {
  return typeof o.riderKeepsCents === 'number';
}
