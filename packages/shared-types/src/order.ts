import type { Cents } from './money.js';
import type { UUID, OrderNumber } from './ids.js';
import type { DiscountSource, FoodpandaDealShare } from './shop-settings.js';

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
}

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
  /**
   * Where it came from (migration 0039): 'foodpanda' = the shop's standing
   * foodpanda deal, put on automatically; null/absent = typed by staff (F3).
   */
  source?: DiscountSource | null;
  /** A foodpanda deal's figures on this order (the whole deal, foodpanda's part). */
  foodpanda?: FoodpandaDealShare | null;
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
  /** Rider snapshot for the order — null until a rider is assigned. */
  rider: { id: UUID; name: string; phone: string } | null;
}
