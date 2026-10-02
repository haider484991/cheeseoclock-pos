import { v5 as uuidv5, v7 as uuidv7 } from 'uuid';
import log from 'electron-log/main';
import type { AppDatabase } from '../connection.js';
import { nowIso, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import { decrementForOrder } from './stock-movement-repo.js';
import { getOrderStockStatus, settleOrderStock } from './order-stock-repo.js';
import { recordDrawerOpen } from './drawer-open-repo.js';
import { findCashMovement, getCurrentShift, recordDeliveryChargeToRider } from './shift-repo.js';
import { skipFbrForOrder, touchedFbrProduction } from './fbr-queue-repo.js';
import { listModifierGroupsForItem, listModifiersByGroup } from './modifier-repo.js';
import { noDiscountOf } from './category-repo.js';
import {
  buildOrderHistoryWhere,
  historyPage,
  methodsFromLegs,
  IS_NOT_PAID_SQL,
  IS_SALE_SQL,
  NET_TOTAL_SQL,
} from '../order-history-query.js';
import { kitchenHearsOfClose } from '@cheeseoclock/pos-domain';
import {
  activeFoodpandaDeal,
  computeDiscountCents,
  dealAmount,
  dealMinTillCents,
  formatCents,
  deliveryAreas,
  deliveryChargeTarget,
  discountBaseCents,
  planDeliveryChargeOnAreaChange,
  sameDeliveryArea,
  type DeliveryChargeTarget,
  type DiscountScope,
  discountRuleScope,
  storedDiscountAlsoOffDeliveryCharge,
  storedDiscountScope,
  foodpandaDealRule,
  foodpandaTerms,
  matchOffer,
  mostOffWithoutManagerCents,
  normalizePhone,
  offerAmount,
  offerCanApplyTo,
  parseDiscountBaseRule,
  parseFoodpandaDealRule,
  parseOfferRule,
  declinedOfferRule,
  taxAfterDiscount,
  tillDiscountRule,
  tradingDayOfInstant,
  validateOrderForTender,
  validateVoid,
  validateDiscountInput,
  requiresManagerApproval,
  discountReasonMissing,
  DISCOUNT_REASON_REQUIRED,
  NOTHING_TO_DISCOUNT,
} from '@cheeseoclock/pos-domain';
import {
  readApprovalLimits,
  readDeliveryFeeItemIds,
  readDeliveryZones,
  readDiscountAlsoOffDeliveryCharge,
  readDiscountReasonRequired,
  readShopSetting,
} from '../business-settings-read.js';
import {
  COC_ID_NAMESPACE,
  FOODPANDA_ORDER_CODE_MAX,
  categoryNeverDiscounted,
  deliveryChargeItemName,
  deliveryChargeLinesCents,
  isDeliveryChargeLine,
  isDeliveryChargeMenuItem,
  isOutsideRiderOrder,
} from '@cheeseoclock/shared-types';
import type {
  CameBy,
  DiscountBaseRule,
  FoodpandaTenderCheck,
  OfferRule,
  OrderCameBy,
  Order,
  OrderItem,
  OrderItemModifier,
  OrderMode,
  OrderStatus,
  Payment,
  PaymentMethod,
  OrderSnapshot,
  OrderStockAnswer,
  PrepStation,
  StockSettlement,
  TestDeleteStock,
  UUID,
  DeletedTestsPage,
  OrderStockStatus,
  TestDeletePreview,
  TestDeleteResult,
  TestDeleteShiftCash,
  TestDeleteStockState,
} from '@cheeseoclock/shared-types';
import type {
  OrderHistoryFilter,
  OrderHistoryPage,
  OrderHistoryRow,
} from '@cheeseoclock/shared-types';
import { orderChoiceGroups } from '@cheeseoclock/shared-types';

interface OrderRow {
  id: string;
  order_number: string;
  mode: OrderMode;
  status: OrderStatus;
  table_id: string | null;
  customer_id: string | null;
  cashier_id: string;
  shift_id: string | null;
  source: 'pos' | 'web';
  notes: string | null;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  total_cents: number;
  paid_at: string | null;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  customer_name_snapshot: string | null;
  customer_phone_snapshot: string | null;
  delivery_address_snapshot: string | null;
  delivery_notes: string | null;
  assigned_rider_id: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
  device_id: string;
  version: number;
  deleted_at?: string | null;
  deleted_by?: string | null;
  delete_reason?: string | null;
  delete_kind?: string | null;
  delete_stock?: string | null;
  /** How it came in (0044): 'walk_in' | 'phone' | 'whatsapp' | 'website' | 'foodpanda'; null = not asked. */
  came_by?: string | null;
  /** When it first left 'open' (0048); null = before 0.7.34, or never sent. */
  sent_at?: string | null;
  /** What an outside rider keeps, frozen at Send out (0049); null = own rider, not out, or before 0.7.34. */
  rider_keeps_cents?: number | null;
}

const ORDER_CAME_BY: readonly string[] = ['walk_in', 'phone', 'whatsapp', 'website', 'foodpanda'];
function isOrderCameBy(v: unknown): v is OrderCameBy {
  return typeof v === 'string' && ORDER_CAME_BY.includes(v);
}

/**
 * Where an order is, in words for the screen. These refusals now reach the
 * cashier as written ("…a sent_to_kitchen order" read like a fault).
 */
const STATUS_WORDS: Record<OrderStatus, string> = {
  open: 'still open',
  sent_to_kitchen: 'already with the kitchen',
  preparing: 'being cooked',
  ready: 'ready',
  out_for_delivery: 'out for delivery',
  delivered: 'delivered',
  served: 'served',
  paid: 'paid and closed',
  void: 'cancelled',
  refunded: 'refunded',
};
const said = (s: OrderStatus): string => STATUS_WORDS[s] ?? s;

function rowToOrder(row: OrderRow): Order {
  return {
    id: row.id as Order['id'],
    orderNumber: row.order_number as Order['orderNumber'],
    mode: row.mode,
    status: row.status,
    tableId: (row.table_id ?? null) as Order['tableId'],
    customerId: (row.customer_id ?? null) as Order['customerId'],
    cashierId: row.cashier_id as Order['cashierId'],
    shiftId: (row.shift_id ?? '') as Order['shiftId'],
    source: row.source,
    notes: row.notes,
    subtotalCents: row.subtotal_cents as Order['subtotalCents'],
    discountCents: row.discount_cents as Order['discountCents'],
    taxCents: row.tax_cents as Order['taxCents'],
    totalCents: row.total_cents as Order['totalCents'],
    createdAt: row.created_at,
    // When it was sent (0048), only once it was: an order never sent, or one
    // from before 0.7.34, reads exactly as before (every reader falls back to
    // createdAt).
    ...(row.sent_at ? { sentAt: row.sent_at } : {}),
    paidAt: row.paid_at,
    voidedAt: row.voided_at,
    voidedBy: row.voided_by as Order['voidedBy'],
    voidReason: row.void_reason,
    assignedRiderId: (row.assigned_rider_id ?? null) as Order['assignedRiderId'],
    dispatchedAt: row.dispatched_at,
    deliveredAt: row.delivered_at,
    // What an outside rider keeps (0049), only on an order sent out with one
    // (0 included): one of the shop's own riders, an order not out yet and
    // any order from before 0.7.34 read exactly as before.
    ...(typeof row.rider_keeps_cents === 'number' ? { riderKeepsCents: row.rider_keeps_cents as Order['totalCents'] } : {}),
    // How it came in (0044), only when it was said: an order nobody asked
    // about reads exactly as before.
    ...(isOrderCameBy(row.came_by) ? { cameBy: row.came_by } : {}),
    // Only a deleted order (read with includeDeleted) carries these: a live
    // order's images and audit rows stay exactly as they were.
    ...(row.deleted_at
      ? {
          deletedAt: row.deleted_at,
          deletedBy: (row.deleted_by ?? null) as Order['voidedBy'],
          deleteReason: row.delete_reason ?? null,
          deleteKind: row.delete_kind === 'test' ? ('test' as const) : null,
          deleteStock: isTestDeleteStock(row.delete_stock) ? row.delete_stock : null,
        }
      : {}),
  };
}

function isTestDeleteStock(v: unknown): v is TestDeleteStock {
  return v === 'put_back' || v === 'waste' || v === 'none' || v === 'settled_before';
}

const ORDER_SELECT = `
  id, order_number, mode, status, table_id, customer_id, cashier_id, shift_id, source, notes,
  subtotal_cents, discount_cents, tax_cents, total_cents, paid_at, voided_at, voided_by, void_reason,
  customer_name_snapshot, customer_phone_snapshot, delivery_address_snapshot, delivery_notes,
  assigned_rider_id, dispatched_at, delivered_at,
  created_at, updated_at, device_id, version,
  deleted_at, deleted_by, delete_reason, delete_kind, delete_stock, came_by, sent_at, rider_keeps_cents
`;

/**
 * The Live Orders clock in SQL (the owner, 2 Oct 2026: count the card from
 * when the order is sent): when the order was sent, or when it was started
 * for one from before 0.7.34. Written exactly like the expression of
 * idx_orders_status_sent (migration 0048), so a query that filters or sorts
 * on it can use that index.
 */
export const ORDER_CLOCK_SQL = 'COALESCE(sent_at, created_at)';

export function findOrder(db: AppDatabase, id: string): Order | null {
  const row = db
    .prepare(`SELECT ${ORDER_SELECT} FROM orders WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as OrderRow | undefined;
  return row ? rowToOrder(row) : null;
}

export function listOrders(
  db: AppDatabase,
  opts?: { status?: OrderStatus; sinceIso?: string; limit?: number },
): Order[] {
  const conditions: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  if (opts?.status) {
    conditions.push('status = ?');
    params.push(opts.status);
  }
  if (opts?.sinceIso) {
    conditions.push('created_at >= ?');
    params.push(opts.sinceIso);
  }
  const limit = opts?.limit ?? 200;
  const rows = db
    .prepare(
      `SELECT ${ORDER_SELECT} FROM orders WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params, limit) as OrderRow[];
  return rows.map(rowToOrder);
}

/**
 * Order History page: one page of PLACED orders (never a cart still being
 * rung up — see PLACED_ORDER_SQL) plus totals across every page, all under
 * the same filters. Filter/search rules live in ../order-history-query.ts.
 */
export function listOrderHistory(
  db: AppDatabase,
  filter?: OrderHistoryFilter,
): OrderHistoryPage {
  const where = buildOrderHistoryWhere(filter);
  const { limit, offset } = historyPage(filter);

  const rows = db
    .prepare(
      `SELECT
         o.id, o.order_number, o.mode, o.source, o.status,
         o.customer_name_snapshot, o.customer_phone_snapshot,
         o.total_cents, o.paid_at, o.created_at,
         u.full_name AS cashier_name,
         t.label AS table_label,
         r.name AS rider_name,
         o.rider_keeps_cents IS NOT NULL AS outside_rider,
         (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi
            WHERE oi.order_id = o.id AND oi.deleted_at IS NULL
              AND oi.parent_order_item_id IS NULL) AS item_count,
         (SELECT COALESCE(-SUM(rp.amount_cents), 0) FROM payments rp
            WHERE rp.order_id = o.id AND rp.deleted_at IS NULL AND rp.amount_cents < 0) AS refunded_cents,
         (SELECT group_concat(lp.method || ':' || lp.amount_cents, ',') FROM payments lp
            WHERE lp.order_id = o.id AND lp.deleted_at IS NULL AND lp.amount_cents > 0) AS pay_legs
        FROM orders o
        LEFT JOIN users u ON u.id = o.cashier_id
        LEFT JOIN tables t ON t.id = o.table_id
        LEFT JOIN riders r ON r.id = o.assigned_rider_id
       WHERE ${where.sql}
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...where.params, limit, offset) as Array<{
    id: string;
    order_number: string;
    mode: OrderMode;
    source: 'pos' | 'web';
    status: OrderStatus;
    customer_name_snapshot: string | null;
    customer_phone_snapshot: string | null;
    total_cents: number;
    paid_at: string | null;
    created_at: string;
    cashier_name: string | null;
    table_label: string | null;
    rider_name: string | null;
    outside_rider: number;
    item_count: number;
    refunded_cents: number;
    pay_legs: string | null;
  }>;

  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS orderCount,
         COALESCE(SUM(CASE WHEN ${IS_SALE_SQL} THEN 1 ELSE 0 END), 0) AS paidCount,
         COALESCE(SUM(CASE WHEN ${IS_SALE_SQL} THEN ${NET_TOTAL_SQL} ELSE 0 END), 0) AS salesCents,
         COALESCE(SUM(CASE WHEN ${IS_NOT_PAID_SQL} THEN 1 ELSE 0 END), 0) AS notPaidCount,
         COALESCE(SUM(CASE WHEN ${IS_NOT_PAID_SQL} THEN o.total_cents ELSE 0 END), 0) AS notPaidCents,
         COALESCE(SUM(CASE WHEN o.status = 'void' THEN 1 ELSE 0 END), 0) AS cancelledCount,
         COALESCE(SUM(CASE WHEN o.status = 'void' THEN o.total_cents ELSE 0 END), 0) AS cancelledCents
        FROM orders o
       WHERE ${where.sql}`,
    )
    .get(...where.params) as {
    orderCount: number;
    paidCount: number;
    salesCents: number;
    notPaidCount: number;
    notPaidCents: number;
    cancelledCount: number;
    cancelledCents: number;
  };

  const refunds = db
    .prepare(
      `SELECT COUNT(DISTINCT p.order_id) AS refundCount,
              COALESCE(-SUM(p.amount_cents), 0) AS refundedCents
         FROM payments p
         JOIN orders o ON o.id = p.order_id
        WHERE p.deleted_at IS NULL AND p.amount_cents < 0
          AND ${where.sql}`,
    )
    .get(...where.params) as { refundCount: number; refundedCents: number };

  const byMethod = db
    .prepare(
      `SELECT p.method AS method, SUM(p.amount_cents) AS netCents
         FROM payments p
         JOIN orders o ON o.id = p.order_id
        WHERE p.deleted_at IS NULL
          AND ${where.sql}
        GROUP BY p.method
        ORDER BY netCents DESC`,
    )
    .all(...where.params) as Array<{ method: PaymentMethod; netCents: number }>;

  const pageRows: OrderHistoryRow[] = rows.map((r) => ({
    id: r.id,
    orderNumber: r.order_number,
    mode: r.mode,
    source: r.source,
    status: r.status,
    customerName: r.customer_name_snapshot,
    customerPhone: r.customer_phone_snapshot,
    tableLabel: r.table_label,
    cashierName: r.cashier_name ?? 'Unknown',
    riderName: r.rider_name,
    // Sent out with an outside rider (0049): only then, so every other row reads as before.
    ...(r.outside_rider === 1 ? { outsideRider: true } : {}),
    itemCount: r.item_count,
    totalCents: r.total_cents,
    refundedCents: r.refunded_cents,
    paidAt: r.paid_at,
    createdAt: r.created_at,
    paymentMethods: methodsFromLegs(r.pay_legs),
  }));

  return {
    rows: pageRows,
    total: totals.orderCount,
    summary: {
      ...totals,
      refundCount: refunds.refundCount,
      refundedCents: refunds.refundedCents,
      byMethod: byMethod.filter((m) => m.netCents !== 0),
    },
  };
}

// -----------------------------------------------------------------------------
// Daily order number — pure-local counter, format YYYYMMDD-NNNN.
// -----------------------------------------------------------------------------

/**
 * The shift credited with money changing hands *now*: the shift open on this
 * device. Orders are linked to the shift they were created in, but a COD
 * delivery is often paid after that shift closed — stamping the payment
 * separately keeps the drawer reconciliation honest.
 *
 * There is no fallback any more. Falling back to the order's own shift put
 * cash taken after a close into a shift whose expected cash was already
 * frozen, and with no shift at all into no reconciliation (audit 2026-09-25):
 * money only changes hands while a shift is open.
 */
function shiftForPayment(db: AppDatabase, deviceId: string): string {
  const row = db
    .prepare(
      `SELECT id FROM shifts
        WHERE device_id = ? AND closed_at IS NULL AND deleted_at IS NULL
        ORDER BY opened_at DESC LIMIT 1`,
    )
    .get(deviceId) as { id: string } | undefined;
  if (!row) {
    throw new Error('No shift is open on this till — open a shift before taking or returning money');
  }
  return row.id;
}

/**
 * Every payment and refund row gets its sync entry AND an audit entry with its
 * amount and method (CLAUDE.md: row + sync + audit). The audit log used to
 * hold only order images, so a partial refund's amount and method were in no
 * tamper-evident record at all (audit 2026-09-25).
 */
function enqueuePaymentSyncAndAudit(
  db: AppDatabase,
  entry: Parameters<typeof enqueueSync>[1],
  actorUserId: string,
): void {
  enqueueSync(db, entry);
  const amount = (entry.payload as { amountCents?: number } | null)?.amountCents ?? 0;
  writeAudit(db, {
    entityType: 'payments',
    entityId: entry.entityId,
    action: amount < 0 ? 'refund' : 'create',
    actorUserId,
    before: null,
    after: entry.payload,
  });
}

/**
 * Foodpanda settles its own orders (migration 0020): its method belongs to
 * foodpanda orders alone, and a foodpanda order is paid with nothing else —
 * recorded as the dialog's default Cash it inflated the drawer's expected
 * cash every night (audit 2026-09-25).
 */
function assertMethodFitsOrder(mode: OrderMode, method: PaymentMethod, what: 'pay' | 'refund' = 'pay'): void {
  if ((mode === 'foodpanda') === (method === 'foodpanda')) return;
  if (what === 'refund') {
    throw new Error(
      mode === 'foodpanda'
        ? 'Foodpanda orders are refunded through Foodpanda, never from the drawer — choose Foodpanda as the method'
        : 'Foodpanda is only for foodpanda orders',
    );
  }
  throw new Error(
    mode === 'foodpanda'
      ? 'Foodpanda orders are paid through Foodpanda — choose Foodpanda as the method'
      : 'Foodpanda is only for foodpanda orders',
  );
}

function nextOrderNumber(db: AppDatabase): string {
  const today = new Date();
  const ymd = `${today.getUTCFullYear()}${String(today.getUTCMonth() + 1).padStart(2, '0')}${String(
    today.getUTCDate(),
  ).padStart(2, '0')}`;
  const existing = db
    .prepare(`SELECT next_value FROM order_number_counter WHERE day_ymd = ?`)
    .get(ymd) as { next_value: number } | undefined;
  let next: number;
  if (!existing) {
    db.prepare(`INSERT INTO order_number_counter (day_ymd, next_value) VALUES (?, 2)`).run(ymd);
    next = 1;
  } else {
    next = existing.next_value;
    db.prepare(`UPDATE order_number_counter SET next_value = next_value + 1 WHERE day_ymd = ?`).run(
      ymd,
    );
  }
  return `${ymd}-${String(next).padStart(4, '0')}`;
}

// -----------------------------------------------------------------------------
// Create order
// -----------------------------------------------------------------------------

export interface CreateOrderInput {
  mode: OrderMode;
  tableId?: string | null;
  customerId?: string | null;
  notes?: string | null;
  source?: 'pos' | 'web';
  /** A counter order: how it came in (the chip the cashier tapped before the first item). */
  cameBy?: CameBy | null;
}

/**
 * How a new order came in (orders.came_by, 0044): a website order and a
 * foodpanda order fill it in themselves; a counter order takes the chip the
 * cashier tapped, or nothing (not asked).
 */
function cameByOfNewOrder(input: CreateOrderInput): OrderCameBy | null {
  if ((input.source ?? 'pos') === 'web') return 'website';
  if (input.mode === 'foodpanda') return 'foodpanda';
  return input.cameBy ?? null;
}

export function createOrder(
  db: AppDatabase,
  input: CreateOrderInput,
  actor: Actor & { userId: string },
): Order {
  const id = uuidv7();
  const now = nowIso();

  let order!: Order;
  const tx = db.transaction(() => {
    const orderNumber = nextOrderNumber(db);
    // Link to the currently-open shift on this device, if any. Orders taken
    // outside an open shift get null shift_id (managers can run the POS
    // without shift discipline if they want — opening a shift is opt-in).
    const openShift = db
      .prepare(
        `SELECT id FROM shifts
          WHERE device_id = ? AND closed_at IS NULL AND deleted_at IS NULL
          ORDER BY opened_at DESC LIMIT 1`,
      )
      .get(actor.deviceId) as { id: string } | undefined;
    const shiftId = openShift?.id ?? null;
    const cameBy = cameByOfNewOrder(input);
    order = {
      id: id as Order['id'],
      orderNumber: orderNumber as Order['orderNumber'],
      mode: input.mode,
      status: 'open',
      tableId: (input.tableId ?? null) as Order['tableId'],
      customerId: (input.customerId ?? null) as Order['customerId'],
      cashierId: actor.userId as Order['cashierId'],
      shiftId: (shiftId ?? '') as Order['shiftId'],
      source: input.source ?? 'pos',
      notes: input.notes ?? null,
      subtotalCents: 0 as Order['subtotalCents'],
      discountCents: 0 as Order['discountCents'],
      taxCents: 0 as Order['taxCents'],
      totalCents: 0 as Order['totalCents'],
      createdAt: now,
      paidAt: null,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      assignedRiderId: null,
      dispatchedAt: null,
      deliveredAt: null,
      ...(cameBy ? { cameBy } : {}),
    };

    db.prepare(
      `INSERT INTO orders
         (id, order_number, mode, status, table_id, customer_id, cashier_id, shift_id, source,
          notes, subtotal_cents, discount_cents, tax_cents, total_cents,
          created_at, updated_at, device_id, version, came_by)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, 1, ?)`,
    ).run(
      id,
      orderNumber,
      input.mode,
      input.tableId ?? null,
      input.customerId ?? null,
      actor.userId,
      shiftId, // null if no shift open on this device
      input.source ?? 'pos',
      input.notes ?? null,
      now,
      now,
      actor.deviceId,
      cameBy,
    );

    enqueueSync(db, {
      entityType: 'orders',
      entityId: id,
      op: 'upsert',
      payload: order,
    });
    writeAudit(db, {
      entityType: 'orders',
      entityId: id,
      action: 'create',
      actorUserId: actor.userId,
      before: null,
      after: order,
    });
    // A foodpanda order gets the shop's standing foodpanda deal now, frozen
    // onto it (nothing in it yet, so its rupees are Rs 0 until items land).
    if (input.mode === 'foodpanda' && (input.source ?? 'pos') === 'pos') putOnFoodpandaDeal(db, order, actor);
  });
  tx();
  log.info('Order created', { id, mode: input.mode });
  return order;
}

// -----------------------------------------------------------------------------
// The foodpanda deal (Settings -> foodpanda; shared-types shop-settings.ts)
// -----------------------------------------------------------------------------

/**
 * Who approved an automatic discount — the foodpanda deal or one of the
 * owner's automatic offers: the owner who last saved it
 * (business_settings.updated_by_user_id, the web pick-up pattern), or the
 * first active admin (the bridge's system actor) when that user is not on
 * this till. Being approved, it is never auto-cleared by the approval
 * re-check in recomputeOrderTotals.
 */
function foodpandaDealApprover(db: AppDatabase, savedByUserId: string | null): string | null {
  if (savedByUserId) {
    const u = db.prepare(`SELECT id FROM users WHERE id = ?`).get(savedByUserId) as { id: string } | undefined;
    if (u) return u.id;
  }
  const admin = db
    .prepare(
      `SELECT id FROM users
        WHERE is_active = 1 AND deleted_at IS NULL
        ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, created_at
        LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  return admin?.id ?? null;
}

/**
 * Put the shop's foodpanda deal on an order that has just become foodpanda
 * (createOrder, setOrderMode). One discount row, source 'foodpanda', with
 * the deal's terms FROZEN in rule_json: the rupees are re-worked from them on
 * every cart change (recomputeOrderTotals), never from the live setting, so
 * a Save while this order is open, or one still on its way from the other
 * till, can't move it. The row replaces any other discount (one discount per
 * order), audited. No deal today (0%, or outside its dates): nothing is
 * touched, exactly as before the setting existed. Returns whether a row was
 * put on. Call inside the caller's transaction.
 */
function putOnFoodpandaDeal(db: AppDatabase, order: Order, actor: Actor & { userId: string }): boolean {
  const setting = readShopSetting(db, 'foodpanda.deal');
  const deal = activeFoodpandaDeal(setting.value, order.createdAt);
  if (!deal) return false;
  // Frozen with how much dearer the listing is now (foodpanda's minimum and
  // most-off are in its prices), and whether a discount comes off the
  // delivery charge now (Settings → Money & discounts: by default no — the
  // deal, its minimum and its most-off are worked on the food).
  const rule = foodpandaDealRule(
    deal,
    setting.savedAt,
    readShopSetting(db, 'foodpanda.fees').value.upliftBps,
    readDiscountAlsoOffDeliveryCharge(db),
  );
  const now = nowIso();

  const replaced = db
    .prepare(
      `SELECT id, discount_type, value, reason, amount_cents, source FROM order_discounts
        WHERE order_id = ? AND deleted_at IS NULL`,
    )
    .all(order.id) as Array<{ id: string; discount_type: string; value: number; reason: string | null; amount_cents: number; source: string | null }>;
  for (const r of replaced) {
    db.prepare(
      `UPDATE order_discounts SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    ).run(now, now, r.id);
    enqueueSync(db, { entityType: 'order_discounts', entityId: r.id, op: 'delete', payload: { id: r.id, deletedAt: now } });
  }
  if (replaced.length > 0) {
    writeAudit(db, {
      entityType: 'order_discounts',
      entityId: order.id,
      action: 'replaced_by_foodpanda_deal',
      actorUserId: actor.userId,
      before: replaced,
      after: null,
    });
  }

  const approver = foodpandaDealApprover(db, setting.savedByUserId);
  const discountId = uuidv7();
  db.prepare(
    `INSERT INTO order_discounts
       (id, order_id, discount_type, value, reason, applied_by_user_id, approved_by_user_id,
        amount_cents, source, rule_json, created_at, updated_at, device_id, version)
     VALUES (?, ?, 'percent', ?, ?, ?, ?, 0, 'foodpanda', ?, ?, ?, ?, 1)`,
  ).run(discountId, order.id, rule.shopPercent, rule.label, actor.userId, approver, JSON.stringify(rule), now, now, actor.deviceId);
  enqueueSync(db, {
    entityType: 'order_discounts',
    entityId: discountId,
    op: 'upsert',
    payload: { id: discountId, orderId: order.id, source: 'foodpanda', rule },
  });
  writeAudit(db, {
    entityType: 'order_discounts',
    entityId: discountId,
    action: 'apply_foodpanda_deal',
    actorUserId: actor.userId,
    before: null,
    after: { orderId: order.id, source: 'foodpanda', rule, approverUserId: approver },
  });
  return true;
}

/**
 * Take the foodpanda deal off an order that stopped being foodpanda: the
 * deal exists only on foodpanda orders. Returns whether anything came off.
 * Call inside the caller's transaction.
 */
function takeOffFoodpandaDeal(db: AppDatabase, orderId: string, actor: Actor & { userId: string }): boolean {
  const rows = db
    .prepare(
      `SELECT id, value, reason, amount_cents, rule_json FROM order_discounts
        WHERE order_id = ? AND source = 'foodpanda' AND deleted_at IS NULL`,
    )
    .all(orderId) as Array<{ id: string; value: number; reason: string | null; amount_cents: number; rule_json: string | null }>;
  if (rows.length === 0) return false;
  const now = nowIso();
  for (const r of rows) {
    db.prepare(
      `UPDATE order_discounts SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    ).run(now, now, r.id);
    enqueueSync(db, { entityType: 'order_discounts', entityId: r.id, op: 'delete', payload: { id: r.id, deletedAt: now } });
    writeAudit(db, {
      entityType: 'order_discounts',
      entityId: r.id,
      action: 'remove_foodpanda_deal',
      actorUserId: actor.userId,
      before: r,
      after: null,
    });
  }
  return true;
}

/** The audit action when an order stops being foodpanda and its till discount stops coming off the value deals. */
const LEAVE_VALUE_DEALS_OUT_ACTION = 'leave_value_deals_out';

/**
 * An order that stopped being foodpanda (setOrderMode): a till discount
 * given on it — a cashier's, or a manager's matching the tablet in place of
 * the deal — was frozen covering the value deals, as foodpanda's tablet
 * does. A counter order never discounts them (owner, 2 Oct 2026: value
 * deals never get any discount; no override, even a manager's), so its rule
 * is frozen again leaving them out (skipsNoDiscountLines), everything else
 * kept as it was given: its delivery-charge answer, its reason, who gave
 * and who approved it. Its rupees are then worked again by the caller
 * (recomputeOrderTotals) on the food without the deals. Only a till's own
 * rule is touched: not the website's, an automatic offer's (they already
 * skip), the foodpanda deal's (taken off by takeOffFoodpandaDeal) or a row
 * with no rule (an older till's).
 *
 * The approval limit: a % (every F3 preset) needs the same answer on any
 * base, and a manager's discount is never checked again. A rupee amount a
 * cashier gave without a PIN was within the limit on the food WITH the
 * deals; on the smaller base it may be more than the % limit, and the
 * cart-change re-check would then take it off, asking for a manager after
 * the fact. Instead it is lowered here, in the same audited change, to the
 * most a cashier may give without one on that base
 * (mostOffWithoutManagerCents): it stays on, nothing asks for a PIN, and the
 * order never carries more off than a cashier may give. One already over
 * the limit before the switch (the owner lowered it since) is left to the
 * re-check, as on any cart change. Returns whether a row changed. Inside
 * the caller's transaction.
 */
function leaveValueDealsOut(db: AppDatabase, orderId: string, actor: Actor & { userId: string }): boolean {
  const rows = db
    .prepare(
      `SELECT id, discount_type, value, reason, amount_cents, approved_by_user_id, rule_json FROM order_discounts
        WHERE order_id = ? AND source IS NULL AND deleted_at IS NULL
        ORDER BY created_at, id`,
    )
    .all(orderId) as Array<{
    id: string;
    discount_type: 'percent' | 'flat';
    value: number;
    reason: string | null;
    amount_cents: number;
    approved_by_user_id: string | null;
    rule_json: string | null;
  }>;
  let changed = false;
  for (const r of rows) {
    const rule = parseDiscountBaseRule(r.rule_json);
    if (!rule || rule.from !== 'till' || rule.skipsNoDiscountLines === true) continue;
    const refrozen = tillDiscountRule(rule.alsoOffDeliveryCharge, true);
    let value = r.value;
    if (r.discount_type === 'flat' && !r.approved_by_user_id) {
      const lines = discountLinesOf(db, orderId);
      // The one rule with the live limit (Settings → Money & discounts), on each base.
      const needsManager = (skipsNoDiscountLines: boolean): boolean =>
        requiresManagerApproval(
          { type: 'flat', value: r.value },
          discountBaseCents(lines, { alsoOffDeliveryCharge: rule.alsoOffDeliveryCharge, skipsNoDiscountLines }),
          readApprovalLimits(db),
        );
      if (!needsManager(false) && needsManager(true)) {
        const base = discountBaseCents(lines, { alsoOffDeliveryCharge: rule.alsoOffDeliveryCharge, skipsNoDiscountLines: true });
        value = Math.min(r.value, mostOffWithoutManagerCents(readApprovalLimits(db), base));
      }
    }
    const now = nowIso();
    db.prepare(
      `UPDATE order_discounts SET rule_json = ?, value = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    ).run(JSON.stringify(refrozen), value, now, r.id);
    enqueueSync(db, {
      entityType: 'order_discounts',
      entityId: r.id,
      op: 'upsert',
      payload: { id: r.id, rule: refrozen, value },
    });
    writeAudit(db, {
      entityType: 'order_discounts',
      entityId: r.id,
      action: LEAVE_VALUE_DEALS_OUT_ACTION,
      actorUserId: actor.userId,
      before: { orderId, discountType: r.discount_type, value: r.value, reason: r.reason, amountCents: r.amount_cents, rule },
      after: { orderId, discountType: r.discount_type, value, reason: r.reason, rule: refrozen },
    });
    changed = true;
  }
  return changed;
}

// -----------------------------------------------------------------------------
// The owner's automatic offers (Settings → Money & discounts, 'discounts.offers')
// -----------------------------------------------------------------------------

/** A live discount row as the offer step reads it. */
interface LiveDiscountRow {
  id: string;
  source: string | null;
  rule_json: string | null;
  discount_type: string;
  value: number;
  reason: string | null;
  amount_cents: number;
}

function liveDiscountRows(db: AppDatabase, orderId: string): LiveDiscountRow[] {
  return db
    .prepare(
      `SELECT id, source, rule_json, discount_type, value, reason, amount_cents FROM order_discounts
        WHERE order_id = ? AND deleted_at IS NULL
        ORDER BY created_at, id`,
    )
    .all(orderId) as LiveDiscountRow[];
}

/** Soft-delete offer rows (synced), one audit row each with why. Inside the caller's transaction. */
function takeOffOfferRows(db: AppDatabase, rows: ReadonlyArray<LiveDiscountRow>, actor: Actor, action: string): void {
  const now = nowIso();
  for (const r of rows) {
    db.prepare(`UPDATE order_discounts SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(now, now, r.id);
    enqueueSync(db, { entityType: 'order_discounts', entityId: r.id, op: 'delete', payload: { id: r.id, deletedAt: now } });
    writeAudit(db, { entityType: 'order_discounts', entityId: r.id, action, actorUserId: actor.userId ?? null, before: r, after: null });
  }
}

/**
 * Put an automatic offer's row on an order: source 'offer', the offer's name
 * as its reason (it prints on the bill), approved by the owner who saved the
 * offers, its terms FROZEN in rule_json. `declined`: the cashier took it off
 * (Rs 0, "flat 0", so no till ever works rupees out of it). Its rupees are
 * worked by recomputeOrderTotals. Inside the caller's transaction.
 */
function insertOfferRow(
  db: AppDatabase,
  orderId: string,
  rule: OfferRule,
  approverUserId: string | null,
  actor: Actor,
  action: 'apply_offer' | 'decline_offer',
): string {
  const now = nowIso();
  const id = uuidv7();
  const appliedBy = actor.userId ?? approverUserId;
  const declined = rule.offer.declined === true;
  db.prepare(
    `INSERT INTO order_discounts
       (id, order_id, discount_type, value, reason, applied_by_user_id, approved_by_user_id,
        amount_cents, source, rule_json, created_at, updated_at, device_id, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'offer', ?, ?, ?, ?, 1)`,
  ).run(
    id,
    orderId,
    declined ? 'flat' : rule.offer.type,
    declined ? 0 : rule.offer.value,
    rule.offer.name,
    appliedBy,
    approverUserId,
    JSON.stringify(rule),
    now,
    now,
    actor.deviceId,
  );
  enqueueSync(db, { entityType: 'order_discounts', entityId: id, op: 'upsert', payload: { id, orderId, source: 'offer', rule } });
  writeAudit(db, {
    entityType: 'order_discounts',
    entityId: id,
    action,
    actorUserId: actor.userId ?? null,
    before: null,
    after: { orderId, source: 'offer', rule, approverUserId },
  });
  return id;
}

/**
 * The ids of the automatic offers this customer's phone already had today
 * (the trading day the order was started in) on ANOTHER order that is not
 * cancelled or deleted: "once per customer per day". Only this till's
 * orders, and the other till's that have arrived (with the link down it can
 * repeat once there, which Reports → Team & leakage lists).
 *
 * Which order keeps it: one already sent or paid always counts; of two
 * still being rung up (the link came back with both on screen), the one
 * started first keeps it and only the later one loses it — each till seeing
 * the other's used to take it off both. `phones`: the phone as normalised
 * and as it was typed (an older customer row may hold either).
 */
function offersUsedToday(
  db: AppDatabase,
  order: { id: string; createdAt: string },
  phones: readonly [string, string],
): Set<string> {
  const day = tradingDayOfInstant(order.createdAt);
  if (!day) return new Set();
  const from = `${day}T00:00:00.000Z`;
  const until = new Date(Date.parse(from) + 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT DISTINCT json_extract(d.rule_json, '$.offer.id') AS offerId
         FROM orders o
         JOIN order_discounts d ON d.order_id = o.id
        WHERE o.created_at >= ? AND o.created_at < ? AND o.id != ?
          AND o.deleted_at IS NULL AND o.status != 'void'
          AND o.customer_phone_snapshot IN (?, ?)
          AND (o.status != 'open' OR o.created_at < ? OR (o.created_at = ? AND o.id < ?))
          AND d.deleted_at IS NULL AND d.source = 'offer' AND d.amount_cents > 0
          AND json_valid(d.rule_json)`,
    )
    .all(from, until, order.id, phones[0], phones[1], order.createdAt, order.createdAt, order.id) as Array<{ offerId: unknown }>;
  return new Set(rows.map((r) => r.offerId).filter((x): x is string => typeof x === 'string'));
}

/**
 * THE offer step: put the owner's automatic offer on an open counter order,
 * keep it, swap it for a bigger one or take it off — pos-domain matchOffer
 * with the live setting, the order's frozen offer (if any) competing on its
 * own terms. Runs at every cart change (recomputeOrderTotals calls it
 * first), when the order type or how it came in changes, and when its
 * customer's phone is saved or taken off. Returns whether a row changed.
 *
 *  - Only a counter order still being rung up (source 'pos', status 'open');
 *    a website order never, and a foodpanda order loses any offer row.
 *  - One discount per order: a staff (F3) or website discount, or the
 *    foodpanda deal, is never replaced by an offer.
 *  - An offer the cashier took off (the declined row) stays off until "Put
 *    it back".
 *  - The approval limit does not apply: the offer is the owner's own rule,
 *    approved by the owner who saved it.
 *  - Fails closed: offers saved by a newer version of the app (a field this
 *    version does not know, say "only on these items") are never put on
 *    here — this till would take them off every order. The one already on
 *    the order keeps its frozen terms.
 *  - "The customer's phone" is a Pakistani number (pos-domain
 *    normalizePhone), not any text typed into the box.
 *
 * Inside the caller's transaction.
 */
function applyOfferStep(db: AppDatabase, orderId: string, actor: Actor): boolean {
  const order = findOrder(db, orderId);
  if (!order || order.status !== 'open' || order.source !== 'pos') return false;
  if (!offerCanApplyTo(order)) {
    const stray = liveDiscountRows(db, orderId).filter((r) => r.source === 'offer');
    if (stray.length === 0) return false;
    takeOffOfferRows(db, stray, actor, 'remove_offer');
    return true;
  }
  const rows = liveDiscountRows(db, orderId);
  // One discount per order: never over a staff, website or foodpanda row.
  if (rows.some((r) => r.source !== 'offer')) return false;
  const offerRows = rows;
  const latest = offerRows[offerRows.length - 1] ?? null;
  const current = latest ? parseOfferRule(latest.rule_json) : null;
  // An offer row this version can't read (a newer till's): left exactly as it is.
  if (latest && !current) return false;
  if (current?.offer.declined) return false;
  const setting = readShopSetting(db, 'discounts.offers');
  // Saved by a newer version of the app: none of its offers is put on here.
  const liveOffers = setting.newerFormat ? [] : setting.value.offers;
  if (!current && liveOffers.length === 0) return false;

  const lines = discountLinesOf(db, orderId);
  const phoneRow = db.prepare(`SELECT customer_phone_snapshot AS phone FROM orders WHERE id = ?`).get(orderId) as
    | { phone: string | null }
    | undefined;
  const typedPhone = phoneRow?.phone?.trim() || null;
  // A Pakistani number, not any text: "1" is no phone (a made-up one each time
  // would get round Phone / WhatsApp and "once a customer a day").
  const phone = normalizePhone(typedPhone);
  const onceAny = liveOffers.some((o) => o.oncePerCustomerPerDay) || current?.offer.oncePerCustomerPerDay === true;
  const pick = matchOffer(
    {
      source: order.source,
      mode: order.mode,
      cameBy: order.cameBy ?? null,
      hasPhone: phone !== null,
      createdAt: order.createdAt,
      // What an offer may come off: never the value deals (an offer's rule
      // skips them), the delivery charge only when the owner's switch says so.
      foodCents: discountBaseCents(lines, { alsoOffDeliveryCharge: false, skipsNoDiscountLines: true }),
      subtotalCents: discountBaseCents(lines, { alsoOffDeliveryCharge: true, skipsNoDiscountLines: true }),
    },
    liveOffers,
    {
      alsoOffDeliveryCharge: readDiscountAlsoOffDeliveryCharge(db),
      settingsAt: setting.savedAt,
      usedToday:
        phone && onceAny ? offersUsedToday(db, { id: orderId, createdAt: order.createdAt }, [phone, typedPhone ?? phone]) : new Set(),
      current,
    },
  );
  if (pick?.isCurrent) return false;
  if (offerRows.length > 0) takeOffOfferRows(db, offerRows, actor, pick ? 'replaced_by_offer' : 'offer_off');
  if (!pick) return offerRows.length > 0;
  insertOfferRow(db, orderId, pick.rule, foodpandaDealApprover(db, setting.savedByUserId), actor, 'apply_offer');
  return true;
}

/**
 * Work an open order's automatic offer out again and, when it changed, its
 * totals: its customer's phone was saved or taken off (customer-repo). Call
 * inside the caller's transaction.
 */
export function refreshOrderOffer(db: AppDatabase, orderId: string, actor: Actor): boolean {
  if (!applyOfferStep(db, orderId, actor)) return false;
  recomputeOrderTotals(db, orderId, actor);
  return true;
}

/** What a cashier hears when they try to change how a sent order came in without a manager. */
export const CAME_BY_LOCKED =
  "This order has been sent, so how it came in is locked. A manager's PIN or password changes it.";

/**
 * How a counter order came in (Walk-in · Phone · WhatsApp; null = not said).
 * While the order is being rung up it is the cashier's to set, and the
 * owner's automatic offers are worked out again. Once the order is sent it
 * is LOCKED: a change needs a manager (`approverUserId`, checked by the
 * caller) and leaves its own audit row, and the discount on the order does
 * not move (the bill may be paid). A website or foodpanda order says how it
 * came in by itself. Row, sync and audit in one transaction.
 */
export function setOrderCameBy(
  db: AppDatabase,
  orderId: string,
  cameBy: CameBy | null,
  actor: Actor & { userId: string },
  opts: { approverUserId?: string | null } = {},
): Order {
  let result!: Order;
  const tx = db.transaction(() => {
    const order = findOrder(db, orderId);
    if (!order) throw new Error('Order not found');
    if (order.source !== 'pos' || order.mode === 'foodpanda') {
      throw new Error('A website or foodpanda order says how it came in by itself');
    }
    const was = order.cameBy ?? null;
    if (was === cameBy) {
      result = order;
      return;
    }
    const open = order.status === 'open';
    if (!open && !opts.approverUserId) throw new Error(CAME_BY_LOCKED);
    if (!open && cameBy === null) throw new Error('Pick how the order came in: Walk-in, Phone or WhatsApp');
    db.prepare(`UPDATE orders SET came_by = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(cameBy, nowIso(), orderId);
    const after = findOrder(db, orderId)!;
    enqueueSync(db, { entityType: 'orders', entityId: orderId, op: 'upsert', payload: after });
    writeAudit(db, {
      entityType: 'orders',
      entityId: orderId,
      action: open ? 'set_came_by' : 'change_came_by',
      actorUserId: actor.userId,
      before: { cameBy: was, status: order.status },
      after: { cameBy, status: order.status, ...(open ? {} : { approverUserId: opts.approverUserId }) },
    });
    // Still being rung up: the offers follow. Sent: the bill stands.
    if (open) refreshOrderOffer(db, orderId, actor);
    result = findOrder(db, orderId) ?? after;
  });
  tx();
  return result;
}

/**
 * Change the mode of an OPEN order (e.g. the cashier picked Takeaway, then
 * switched to Delivery after adding items). Without this the mode was fixed at
 * creation and a later switch only changed the on-screen selection, so the
 * saved order — and therefore the kitchen ticket, the Live Orders board and
 * the reports — kept the original mode. Leaving dine-in clears any table hold.
 */
export function setOrderMode(
  db: AppDatabase,
  orderId: string,
  mode: OrderMode,
  actor: Actor & { userId: string },
): Order {
  let result!: Order;
  const tx = db.transaction(() => {
    const order = findOrder(db, orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'open') throw new Error(`This order is ${said(order.status)} — its type can't be changed now`);

    const tableId = mode === 'dine_in' ? order.tableId : null;
    // How it came in follows the order type: a foodpanda order says so itself;
    // one that stops being foodpanda has not been asked yet.
    const wasCameBy = order.cameBy ?? null;
    const cameBy: OrderCameBy | null =
      order.source !== 'pos' ? wasCameBy : mode === 'foodpanda' ? 'foodpanda' : wasCameBy === 'foodpanda' ? null : wasCameBy;
    const now = nowIso();
    db.prepare(
      `UPDATE orders SET mode = ?, table_id = ?, came_by = ?, updated_at = ?, version = version + 1
        WHERE id = ?`,
    ).run(mode, tableId, cameBy, now, orderId);

    const { cameBy: _was, ...rest } = order;
    void _was;
    const updated: Order = { ...rest, mode, tableId: tableId as Order['tableId'], ...(cameBy ? { cameBy } : {}) };
    enqueueSync(db, {
      entityType: 'orders',
      entityId: orderId,
      op: 'upsert',
      payload: updated,
    });
    writeAudit(db, {
      entityType: 'orders',
      entityId: orderId,
      action: 'update',
      actorUserId: actor.userId,
      before: order,
      after: updated,
    });

    // The foodpanda deal follows the order type: put on when it becomes
    // foodpanda (the terms of NOW, frozen), taken off when it leaves — and a
    // till discount given on it stops coming off the value deals then.
    const wasFoodpanda = order.mode === 'foodpanda';
    const isFoodpanda = mode === 'foodpanda';
    let discountChanged = false;
    if (wasFoodpanda && !isFoodpanda) {
      discountChanged = takeOffFoodpandaDeal(db, orderId, actor);
      if (leaveValueDealsOut(db, orderId, actor)) discountChanged = true;
    } else if (!wasFoodpanda && isFoodpanda && order.source === 'pos') discountChanged = putOnFoodpandaDeal(db, updated, actor);
    // The owner's automatic offers depend on the order type: worked out again
    // on every change (a foodpanda order never carries one).
    if (applyOfferStep(db, orderId, actor)) discountChanged = true;
    if (discountChanged) recomputeOrderTotals(db, orderId, actor);
    // Only a delivery pays the delivery charge: leaving Delivery takes its line off here, in the
    // main process, whoever asks (the till's screen used to do it on its own); becoming a delivery
    // puts on the charge of the area the order already has (deliveryChargeForArea, 'mode').
    let chargesChanged = false;
    if (mode !== 'delivery') chargesChanged = removeDeliveryChargeLines(db, orderId, actor) > 0;
    else if (order.mode !== 'delivery') {
      const r = deliveryChargeForArea(db, orderId, null, 'mode', actor);
      chargesChanged = r.added !== null || r.removed > 0;
    }
    result = discountChanged || chargesChanged ? (findOrder(db, orderId) ?? updated) : updated;
  });
  tx();
  return result;
}

/** The delivery charge lines on an order (sold under a delivery-charge name, or of an area's fee item). */
function deliveryChargeLinesOf(
  db: AppDatabase,
  orderId: string,
): Array<{ id: string; menuItemId: string | null; unitPriceCents: number; quantity: number }> {
  const feeItemIds = readDeliveryFeeItemIds(db);
  const rows = db
    .prepare(
      `SELECT id, menu_item_id, menu_item_name, unit_price_cents, quantity FROM order_items
        WHERE order_id = ? AND deleted_at IS NULL AND parent_order_item_id IS NULL
        ORDER BY created_at, id`,
    )
    .all(orderId) as Array<{
    id: string;
    menu_item_id: string | null;
    menu_item_name: string;
    unit_price_cents: number;
    quantity: number;
  }>;
  return rows
    .filter((r) => isDeliveryChargeLine({ menuItemName: r.menu_item_name, menuItemId: r.menu_item_id }, feeItemIds))
    .map((r) => ({ id: r.id, menuItemId: r.menu_item_id, unitPriceCents: r.unit_price_cents, quantity: r.quantity }));
}

/** Take every delivery charge line off an open order (each removal synced and audited). */
function removeDeliveryChargeLines(db: AppDatabase, orderId: string, actor: Actor & { userId: string }): number {
  const lines = deliveryChargeLinesOf(db, orderId);
  for (const l of lines) removeOrderItem(db, orderId, l.id, actor);
  return lines.length;
}

/**
 * The audit action recording the area an order's delivery charge follows
 * (deliveryChargeForArea): before/after { area }, and what the till did.
 * It is the till's memory of the area it last brought the charge to, so a
 * save that does not CHANGE the area never puts back a charge taken off by
 * hand.
 */
export const DELIVERY_AREA_ACTION = 'delivery_area';

/** What brought the till to the delivery charge (deliveryChargeForArea). */
export type DeliveryAreaEvent =
  /** The area was set or changed: the customer panel, an address saved on the order, the customer taken off. */
  | 'area'
  /** The order became a delivery (setOrderMode): the area it has decides the charge again. */
  | 'mode'
  /** "Put it back" on the till's delivery-charge row: the area's charge, whatever was taken off by hand. */
  | 'put_back';

/** The area as recorded: trimmed, inner spaces collapsed, at most 200 characters; null for none. */
function cleanArea(area: string | null | undefined): string | null {
  const a = (area ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
  return a || null;
}

/** The area the order's charge last followed (its last DELIVERY_AREA_ACTION row), or null when it never had one. */
function recordedDeliveryArea(db: AppDatabase, orderId: string): { area: string | null } | null {
  const row = db
    .prepare(
      `SELECT after_json FROM audit_log
        WHERE entity_type = 'orders' AND entity_id = ? AND action = ?
        ORDER BY rowid DESC LIMIT 1`,
    )
    .get(orderId, DELIVERY_AREA_ACTION) as { after_json: string | null } | undefined;
  if (!row) return null;
  try {
    const after = JSON.parse(row.after_json ?? 'null') as { area?: unknown } | null;
    return { area: typeof after?.area === 'string' ? after.area : null };
  } catch {
    return { area: null };
  }
}

/** The area of the address saved on the order (delivery_address_snapshot), or null. */
function snapshotArea(db: AppDatabase, orderId: string): string | null {
  const row = db.prepare(`SELECT delivery_address_snapshot AS a FROM orders WHERE id = ?`).get(orderId) as
    | { a: string | null }
    | undefined;
  if (!row?.a) return null;
  try {
    const a = JSON.parse(row.a) as { area?: unknown };
    return typeof a.area === 'string' ? cleanArea(a.area) : null;
  } catch {
    return null;
  }
}

/**
 * The owner's rule of 28 Sep 2026 — "if delivery area selected the delivery
 * fee should be automatically added" — in the main process, INSIDE the
 * caller's transaction, for every path that gives a counter order its area:
 * the customer panel (orders:setDeliveryArea), an address saved on the
 * order (snapshotCustomerOntoOrder: Send's and Pay's customer save, an
 * address change), the customer taken off (detachCustomerFromOrder), and
 * the order becoming a delivery (setOrderMode). On an OPEN counter delivery:
 *  - an area the shop delivers to: its fee item (Settings → Delivery areas:
 *    its feeItemId, else today's by name and price) goes on; a charge at
 *    another fee is swapped for it; one at the right fee is never doubled;
 *  - the area cleared, a free area, an area switched off: the charge comes off;
 *  - an area the till can't pin to one fee (not on the list, a road across
 *    phases): after an area it charged, that charge comes off (changing the
 *    area swaps it); otherwise the bill is left as it is.
 * Only on an area CHANGE ('area': compared with the area recorded last, in
 * DELIVERY_AREA_ACTION, as a place — pos-domain sameDeliveryArea: "Phase 6,
 * DHA" is not a change from "DHA Phase 6"), the order becoming a delivery ('mode') or "Put it
 * back" ('put_back'): a charge the cashier took off by hand — the removal
 * audited like any line — stays off through saves that do not change the
 * area (Pay's early save, Send, the panel asking again). A takeaway only
 * records the area (its charge goes on if it becomes a delivery). Never a
 * website order (it arrives with the fee the customer paid) or a foodpanda
 * one (foodpanda delivers it). Each line change is synced and audited
 * (addOrderItem / removeOrderItem), and the event is audited on the order.
 * `area` for 'mode' is ignored: the recorded area, else the saved address's.
 */
export function deliveryChargeForArea(
  db: AppDatabase,
  orderId: string,
  area: string | null,
  event: DeliveryAreaEvent,
  actor: Actor,
): { added: string | null; removed: number } {
  const none = { added: null, removed: 0 };
  const order = findOrder(db, orderId);
  // Only the till's own order that is still being built: a website order carries its own fee.
  if (!order || order.status !== 'open' || order.source !== 'pos' || !actor.userId) return none;
  const who = { ...actor, userId: actor.userId };
  const recorded = recordedDeliveryArea(db, orderId);
  const was = recorded ? recorded.area : null;
  const now = event === 'mode' ? (recorded ? recorded.area : snapshotArea(db, orderId)) : cleanArea(area);
  const areas = deliveryAreas(readDeliveryZones(db));
  // Not a change: nothing (a charge taken off by hand stays off) — the same words, or the same
  // place in other words ("DHA Phase 6" / "Phase 6, DHA": a customer's two saved addresses).
  if (event === 'area' && sameDeliveryArea(areas, was, now)) return none;
  if (event !== 'area' && order.mode !== 'delivery') return none;

  let out: { added: string | null; removed: number } = none;
  let target: DeliveryChargeTarget | null = null;
  if (order.mode === 'delivery') {
    const items = (
      db
        .prepare(`SELECT id, name, base_price_cents FROM menu_items WHERE deleted_at IS NULL AND is_active = 1`)
        .all() as Array<{ id: string; name: string; base_price_cents: number }>
    ).map((i) => ({ id: i.id, name: i.name, basePriceCents: i.base_price_cents }));
    target = deliveryChargeTarget(areas, order.mode, now, items);
    const previous = event === 'area' && was ? deliveryChargeTarget(areas, 'delivery', was, items) : null;
    const plan = planDeliveryChargeOnAreaChange(previous, target, deliveryChargeLinesOf(db, orderId));
    for (const id of plan.remove) removeOrderItem(db, orderId, id, who);
    if (plan.add) addOrderItem(db, { orderId, menuItemId: plan.add, quantity: 1, modifierIds: [] }, who);
    out = { added: plan.add, removed: plan.remove.length };
  }
  writeAudit(db, {
    entityType: 'orders',
    entityId: orderId,
    action: DELIVERY_AREA_ACTION,
    actorUserId: actor.userId,
    before: { area: was },
    after: {
      area: now,
      event,
      mode: order.mode,
      target: target ? (target.kind === 'fee' ? 'fee' : target.reason) : null,
      feeCents: target?.kind === 'fee' ? target.feeCents : null,
      added: out.added,
      removed: out.removed,
    },
  });
  return out;
}

/**
 * orders:setDeliveryArea — the customer panel's area, or its "Put it back",
 * on an open counter order, in one transaction (deliveryChargeForArea).
 */
export function syncOrderDeliveryCharge(
  db: AppDatabase,
  orderId: string,
  area: string | null,
  actor: Actor & { userId: string },
  opts: { putBack?: boolean } = {},
): { added: boolean; removed: number } {
  let out = { added: false, removed: 0 };
  const tx = db.transaction(() => {
    if (!findOrder(db, orderId)) throw new Error('Order not found');
    const r = deliveryChargeForArea(db, orderId, area, opts.putBack ? 'put_back' : 'area', actor);
    out = { added: r.added !== null, removed: r.removed };
  });
  tx();
  return out;
}

/**
 * The newest unfinished POS order with something in it — the cart a cashier
 * was building when the app last closed. Without this, a restart orphaned the
 * draft: still 'open' in the database, gone from the screen.
 */
export function findResumableDraft(db: AppDatabase, deviceId: string): OrderSnapshot | null {
  // Scoped to this till: a draft another device is building (arrived via
  // sync) belongs to that cashier's screen, not this one.
  const row = db
    .prepare(
      `SELECT o.id FROM orders o
        WHERE o.status = 'open' AND o.source = 'pos' AND o.device_id = ?
          AND o.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM order_items oi
                       WHERE oi.order_id = o.id AND oi.deleted_at IS NULL)
        ORDER BY o.created_at DESC LIMIT 1`,
    )
    .get(deviceId) as { id: string } | undefined;
  return row ? getOrderSnapshot(db, row.id) : null;
}

/**
 * Soft-delete open POS orders that have no items left — a product tapped and
 * removed again, or a shell whose first add-item failed. Nothing of value is
 * lost; left alone they sit in history as empty "open" orders forever. Called
 * when the checkout resumes after a restart, so a draft the cashier is
 * actively building is never touched, and when the counter starts a new cart
 * (orders:create): the emptied cart it replaces is dropped, never reused. Only
 * this till's own counter carts; never from createOrder, which the website
 * bridge calls on the same till.
 */
export function discardEmptyDrafts(db: AppDatabase, actor: Actor & { userId: string }): number {
  let count = 0;
  const tx = db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT o.id FROM orders o
          WHERE o.status = 'open' AND o.source = 'pos' AND o.device_id = ?
            AND o.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM order_items oi
                             WHERE oi.order_id = o.id AND oi.deleted_at IS NULL)`,
      )
      .all(actor.deviceId) as Array<{ id: string }>;
    const now = nowIso();
    for (const { id } of rows) {
      const before = findOrder(db, id);
      if (!before) continue;
      db.prepare(
        `UPDATE orders SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(now, now, id);
      enqueueSync(db, {
        entityType: 'orders',
        entityId: id,
        op: 'delete',
        payload: { id, deletedAt: now },
      });
      writeAudit(db, {
        entityType: 'orders',
        entityId: id,
        action: 'discard_empty_draft',
        actorUserId: actor.userId,
        before,
        after: null,
      });
      count += 1;
    }
  });
  tx();
  return count;
}

/**
 * Drop an open till draft entirely. Nothing has been sent to the kitchen or
 * charged, so this is a cart being abandoned, not a void — which is why it
 * needs no manager PIN. Anything past 'open' is refused: that is a void or a
 * refund, with their approvals. Recorded as a soft delete with the full order
 * image in the audit row.
 */
export function discardDraft(
  db: AppDatabase,
  orderId: string,
  actor: Actor & { userId: string },
): void {
  const tx = db.transaction(() => {
    const before = getOrderSnapshot(db, orderId);
    if (!before) throw new Error('Order not found');
    if (before.order.status !== 'open') {
      throw new Error(`Cannot discard a ${before.order.status} order`);
    }
    if (before.order.source !== 'pos') throw new Error('Only till orders can be discarded');
    if (before.payments.length > 0) throw new Error('Order has payments; refund it instead');
    const now = nowIso();
    db.prepare(
      `UPDATE orders SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    ).run(now, now, orderId);
    enqueueSync(db, {
      entityType: 'orders',
      entityId: orderId,
      op: 'delete',
      payload: { id: orderId, deletedAt: now },
    });
    writeAudit(db, {
      entityType: 'orders',
      entityId: orderId,
      action: 'discard_draft',
      actorUserId: actor.userId,
      before,
      after: null,
    });
  });
  tx();
}

// -----------------------------------------------------------------------------
// Add / remove / update items
// -----------------------------------------------------------------------------

export interface AddItemInput {
  orderId: string;
  menuItemId: string;
  quantity: number;
  modifierIds: string[];
  notes?: string | null;
  /** For combo expansion — the parent combo order_item id. */
  parentOrderItemId?: string | null;
  /** Override base price (used by combo expansion). Otherwise menu_item.base_price. */
  unitPriceOverrideCents?: number;
  /**
   * A delivery charge item that has since been switched off still goes on
   * (the web bridge: a website order placed at a fee Settings → Delivery
   * areas has just moved carries the old fee's item). Food never does.
   */
  allowSwitchedOffDeliveryCharge?: boolean;
  /**
   * BRIDGE-ONLY, like allowSwitchedOffDeliveryCharge: the website's own
   * "never discounted" flag on this line, which wins over the till's
   * category (the customer was priced by it). Absent = the category's answer
   * now. A delivery charge ignores it (always 0). orders:addItem never
   * passes it, so the renderer can't set it.
   */
  noDiscount?: boolean;
}

/**
 * A line's chosen choices in the order the choices popup asks them (owner
 * 2026-09-27): required ones, dips on the side, extras, drinks, leave-outs,
 * anything else — shared-types `orderChoiceGroups` over the item's groups,
 * each group's options in their menu order (exactly the lists the popup
 * shows, menu-handlers `menu:listModifierGroupsForItem`). Stored as
 * order_item_modifiers.sort_order and read back by it, so the cart line, the
 * kitchen ticket and the receipt list them as they were asked. The kitchen
 * ticket still pulls the leave-outs to the top, in capitals.
 *
 * A choice that is not on one of this item's groups (the item's groups
 * changed since it was picked) keeps the order it was sent in, after the rest.
 */
function inAskedOrder<M extends { id: string }>(
  db: AppDatabase,
  menuItemId: string,
  chosen: readonly M[],
  requested: readonly string[],
): M[] {
  const groups = listModifierGroupsForItem(db, menuItemId).map((g) => ({
    ...g,
    modifiers: listModifiersByGroup(db, g.id),
  }));
  const asked = new Map<string, number>();
  for (const g of orderChoiceGroups(groups)) {
    for (const m of g.modifiers) if (!asked.has(m.id)) asked.set(m.id, asked.size);
  }
  const sent = (id: string) => {
    const i = requested.indexOf(id);
    return i < 0 ? requested.length : i;
  };
  return chosen
    .map((m) => ({ m, asked: asked.get(m.id) ?? Number.MAX_SAFE_INTEGER, sent: sent(m.id) }))
    .sort((a, b) => a.asked - b.asked || a.sent - b.sent)
    .map((x) => x.m);
}

export function addOrderItem(
  db: AppDatabase,
  input: AddItemInput,
  actor: Actor & { userId: string },
): OrderItem {
  let inserted!: OrderItem;
  const tx = db.transaction(() => {
    const order = findOrder(db, input.orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'open') throw new Error(`This order is ${said(order.status)} — items can't be added now`);
    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 999) {
      throw new Error('Quantity must be a whole number between 1 and 999');
    }

    const itemRow = db
      .prepare(
        `SELECT mi.id, mi.name, mi.base_price_cents, mi.prep_station, mi.tax_category_id, mi.is_active,
                c.name AS category_name, c.no_discount AS category_no_discount
           FROM menu_items mi
      LEFT JOIN categories c ON c.id = mi.category_id
          WHERE mi.id = ? AND mi.deleted_at IS NULL`,
      )
      .get(input.menuItemId) as
      | {
          id: string;
          name: string;
          base_price_cents: number;
          prep_station: PrepStation;
          tax_category_id: string;
          is_active: number;
          category_name: string | null;
          category_no_discount: unknown;
        }
      | undefined;
    // A delivery charge (an area's fee item, or named like one: Settings → Delivery areas).
    const isFee = !!itemRow && isDeliveryChargeMenuItem(itemRow, readDeliveryFeeItemIds(db));
    if (!itemRow || (itemRow.is_active !== 1 && !(isFee && input.allowSwitchedOffDeliveryCharge))) {
      throw new Error('Menu item not found or inactive');
    }
    // foodpanda delivers foodpanda's orders and charges for it: never the shop's delivery charge.
    if (isFee && order.mode === 'foodpanda') {
      throw new Error('A foodpanda order never carries the shop’s delivery charge');
    }
    // A fee item's line is always sold under a delivery-charge name — the one test every reader of a
    // stored order uses (isDeliveryChargeLine): an item an older till renamed still reads as a charge.
    const soldAs =
      isFee && !isDeliveryChargeLine({ menuItemName: itemRow.name }) ? deliveryChargeItemName(itemRow.base_price_cents) : itemRow.name;
    // Never discounted (0047), frozen on the line like its price: the category's answer now (what the
    // owner set, else its name), or the website's own flag (bridge only). A delivery charge never is:
    // whether a discount comes off it is the discount's own rule (alsoOffDeliveryCharge).
    const noDiscount = isFee
      ? false
      : (input.noDiscount ??
        categoryNeverDiscounted({ name: itemRow.category_name ?? '', noDiscount: noDiscountOf(itemRow.category_no_discount) }));

    const taxRow = db
      .prepare(`SELECT rate_bps FROM tax_categories WHERE id = ? AND deleted_at IS NULL`)
      .get(itemRow.tax_category_id) as { rate_bps: number } | undefined;
    const rateBps = taxRow?.rate_bps ?? 0;

    const unitPrice = input.unitPriceOverrideCents ?? itemRow.base_price_cents;

    // Load selected modifiers (snapshot name + price_delta at insert time).
    const modPlaceholders = input.modifierIds.map(() => '?').join(',') || 'NULL';
    const found = input.modifierIds.length
      ? (db
          .prepare(
            `SELECT id, name, price_delta_cents FROM modifiers
              WHERE id IN (${modPlaceholders}) AND deleted_at IS NULL`,
          )
          .all(...input.modifierIds) as Array<{
          id: string;
          name: string;
          price_delta_cents: number;
        }>)
      : [];
    // Every requested choice must still exist. A deleted one used to be dropped
    // silently — a website order for a deal or a pizza with a choice arrived
    // without it, and the kitchen ticket, bill and stock all left it out
    // (audit 2026-09-25). Failing here sends a web order down the usual
    // retry → "couldn't import, call the customer" path instead.
    if (found.length !== new Set(input.modifierIds).size) {
      throw new Error('One of the chosen options is no longer on the menu — publish the menu again');
    }
    // The order they were asked in (the SELECT hands them back in id order).
    const modRows = inAskedOrder(db, input.menuItemId, found, input.modifierIds);

    const modSum = modRows.reduce((sum, m) => sum + m.price_delta_cents, 0);
    const lineTotal = (unitPrice + modSum) * input.quantity;

    const now = nowIso();
    const itemId = uuidv7();

    const newItem: OrderItem = {
      id: itemId as OrderItem['id'],
      orderId: input.orderId as OrderItem['orderId'],
      menuItemId: input.menuItemId as OrderItem['menuItemId'],
      comboId: null,
      parentOrderItemId: (input.parentOrderItemId ?? null) as OrderItem['parentOrderItemId'],
      quantity: input.quantity,
      unitPriceCents: unitPrice as OrderItem['unitPriceCents'],
      lineTotalCents: lineTotal as OrderItem['lineTotalCents'],
      taxCategoryId: itemRow.tax_category_id as OrderItem['taxCategoryId'],
      notes: input.notes ?? null,
      kitchenStatus: 'pending',
      noDiscount,
    };

    db.prepare(
      `INSERT INTO order_items
         (id, order_id, menu_item_id, menu_item_name, combo_id, parent_order_item_id,
          quantity, unit_price_cents, line_total_cents, tax_category_id, tax_rate_bps_snapshot,
          prep_station_snapshot, notes, kitchen_status, no_discount,
          created_at, updated_at, device_id, version)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, 1)`,
    ).run(
      itemId,
      input.orderId,
      input.menuItemId,
      soldAs,
      input.parentOrderItemId ?? null,
      input.quantity,
      unitPrice,
      lineTotal,
      itemRow.tax_category_id,
      rateBps,
      itemRow.prep_station,
      input.notes ?? null,
      noDiscount ? 1 : 0,
      now,
      now,
      actor.deviceId,
    );

    enqueueSync(db, { entityType: 'order_items', entityId: itemId, op: 'upsert', payload: newItem });

    // Insert modifier snapshots, each with its place in the asked order.
    for (const [position, mr] of modRows.entries()) {
      const modOrderId = uuidv7();
      db.prepare(
        `INSERT INTO order_item_modifiers
           (id, order_item_id, modifier_id, modifier_name, price_delta_cents, sort_order,
            created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(modOrderId, itemId, mr.id, mr.name, mr.price_delta_cents, position, now, now, actor.deviceId);
      enqueueSync(db, {
        entityType: 'order_item_modifiers',
        entityId: modOrderId,
        op: 'upsert',
        payload: {
          id: modOrderId,
          orderItemId: itemId,
          modifierId: mr.id,
          modifierName: mr.name,
          priceDeltaCents: mr.price_delta_cents,
          sortOrder: position,
        },
      });
    }

    // The audit trail must show what was added at what price — the void /
    // refund before-images only carry order totals, not lines.
    writeAudit(db, {
      entityType: 'order_items',
      entityId: itemId,
      action: 'create',
      actorUserId: actor.userId,
      before: null,
      after: {
        ...newItem,
        menuItemName: soldAs,
        taxRateBps: rateBps,
        modifiers: modRows.map((m) => ({
          modifierId: m.id,
          modifierName: m.name,
          priceDeltaCents: m.price_delta_cents,
        })),
      },
    });

    recomputeOrderTotals(db, input.orderId, actor);
    inserted = newItem;
  });
  tx();
  return inserted;
}

/**
 * Change a line's choices and its note after it is in the cart: "Customize" on
 * the till (owner 2026-09-26 — leave-outs for allergic customers, extras, and
 * an "allergy / special request" note that prints on the kitchen ticket).
 * Open orders only. The chosen choices replace the line's old ones; the line
 * total is re-priced from their snapshots, the same way addOrderItem prices it.
 */
export function updateOrderItemOptions(
  db: AppDatabase,
  input: { orderId: string; orderItemId: string; modifierIds: string[]; notes: string | null },
  actor: Actor & { userId: string },
): void {
  const tx = db.transaction(() => {
    const order = findOrder(db, input.orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'open') throw new Error(`This order is ${said(order.status)} — items can't be changed now`);
    const line = db
      .prepare(
        `SELECT id, menu_item_id, unit_price_cents, quantity, notes FROM order_items
          WHERE id = ? AND order_id = ? AND deleted_at IS NULL`,
      )
      .get(input.orderItemId, input.orderId) as
      | { id: string; menu_item_id: string | null; unit_price_cents: number; quantity: number; notes: string | null }
      | undefined;
    if (!line) throw new Error('Order item not found');

    const ids = [...new Set(input.modifierIds)];
    const found = ids.length
      ? (db
          .prepare(
            `SELECT id, name, price_delta_cents FROM modifiers
              WHERE id IN (${ids.map(() => '?').join(',')}) AND deleted_at IS NULL`,
          )
          .all(...ids) as Array<{ id: string; name: string; price_delta_cents: number }>)
      : [];
    if (found.length !== ids.length) {
      throw new Error('One of the chosen options is no longer on the menu — publish the menu again');
    }
    // The order they were asked in, as addOrderItem stores them.
    const modRows = inAskedOrder(db, line.menu_item_id ?? '', found, ids);
    const notes = input.notes?.trim().slice(0, 300) || null;

    const before = db
      .prepare(
        `SELECT id, modifier_id, modifier_name, price_delta_cents FROM order_item_modifiers
          WHERE order_item_id = ? AND deleted_at IS NULL
          ORDER BY sort_order, created_at, id`,
      )
      .all(input.orderItemId) as Array<{ id: string; modifier_id: string; modifier_name: string; price_delta_cents: number }>;

    const now = nowIso();
    for (const old of before) {
      db.prepare(
        `UPDATE order_item_modifiers SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(now, now, old.id);
      enqueueSync(db, { entityType: 'order_item_modifiers', entityId: old.id, op: 'delete', payload: { id: old.id, deletedAt: now } });
    }
    for (const [position, mr] of modRows.entries()) {
      const modOrderId = uuidv7();
      db.prepare(
        `INSERT INTO order_item_modifiers
           (id, order_item_id, modifier_id, modifier_name, price_delta_cents, sort_order,
            created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(modOrderId, input.orderItemId, mr.id, mr.name, mr.price_delta_cents, position, now, now, actor.deviceId);
      enqueueSync(db, {
        entityType: 'order_item_modifiers',
        entityId: modOrderId,
        op: 'upsert',
        payload: {
          id: modOrderId,
          orderItemId: input.orderItemId,
          modifierId: mr.id,
          modifierName: mr.name,
          priceDeltaCents: mr.price_delta_cents,
          sortOrder: position,
        },
      });
    }

    const modSum = modRows.reduce((sum, m) => sum + m.price_delta_cents, 0);
    const lineTotal = (line.unit_price_cents + modSum) * line.quantity;
    db.prepare(
      `UPDATE order_items SET line_total_cents = ?, notes = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    ).run(lineTotal, notes, now, input.orderItemId);
    enqueueSync(db, {
      entityType: 'order_items',
      entityId: input.orderItemId,
      op: 'upsert',
      payload: { id: input.orderItemId, lineTotalCents: lineTotal, notes },
    });
    writeAudit(db, {
      entityType: 'order_items',
      entityId: input.orderItemId,
      action: 'update_options',
      actorUserId: actor.userId,
      before: {
        notes: line.notes,
        modifiers: before.map((m) => ({ modifierId: m.modifier_id, modifierName: m.modifier_name, priceDeltaCents: m.price_delta_cents })),
      },
      after: {
        notes,
        lineTotalCents: lineTotal,
        modifiers: modRows.map((m) => ({ modifierId: m.id, modifierName: m.name, priceDeltaCents: m.price_delta_cents })),
      },
    });

    recomputeOrderTotals(db, input.orderId, actor);
  });
  tx();
}

export function removeOrderItem(
  db: AppDatabase,
  orderId: string,
  orderItemId: string,
  actor: Actor & { userId: string },
): void {
  const tx = db.transaction(() => {
    const order = findOrder(db, orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'open') throw new Error(`This order is ${said(order.status)} — items can't be removed now`);

    const item = db
      .prepare(`SELECT id FROM order_items WHERE id = ? AND order_id = ? AND deleted_at IS NULL`)
      .get(orderItemId, orderId) as { id: string } | undefined;
    if (!item) throw new Error('Order item not found');

    const now = nowIso();
    // Every row this soft-deletes goes to sync, not only the line itself: the
    // cloud copy kept a deal's children and a line's options alive.
    const childIds = (
      db
        .prepare(
          `SELECT id FROM order_items WHERE parent_order_item_id = ? AND deleted_at IS NULL`,
        )
        .all(orderItemId) as Array<{ id: string }>
    ).map((r) => r.id);
    const modifierRowIds = (
      db
        .prepare(
          `SELECT id FROM order_item_modifiers
            WHERE order_item_id IN (SELECT id FROM order_items WHERE id = ? OR parent_order_item_id = ?)
              AND deleted_at IS NULL`,
        )
        .all(orderItemId, orderItemId) as Array<{ id: string }>
    ).map((r) => r.id);

    // Soft-delete child items (combo children share parent_order_item_id)
    db.prepare(
      `UPDATE order_items SET deleted_at = ?, updated_at = ?, version = version + 1
        WHERE (id = ? OR parent_order_item_id = ?) AND deleted_at IS NULL`,
    ).run(now, now, orderItemId, orderItemId);

    // Soft-delete modifiers for the removed item
    db.prepare(
      `UPDATE order_item_modifiers SET deleted_at = ?, updated_at = ?, version = version + 1
        WHERE order_item_id IN (SELECT id FROM order_items WHERE id = ? OR parent_order_item_id = ?)
          AND deleted_at IS NULL`,
    ).run(now, now, orderItemId, orderItemId);

    for (const id of [orderItemId, ...childIds]) {
      enqueueSync(db, {
        entityType: 'order_items',
        entityId: id,
        op: 'delete',
        payload: { id, deletedAt: now },
      });
    }
    for (const id of modifierRowIds) {
      enqueueSync(db, {
        entityType: 'order_item_modifiers',
        entityId: id,
        op: 'delete',
        payload: { id, deletedAt: now },
      });
    }
    writeAudit(db, {
      entityType: 'order_items',
      entityId: orderItemId,
      action: 'delete',
      actorUserId: actor.userId,
      before: { id: orderItemId },
      after: null,
    });

    recomputeOrderTotals(db, orderId, actor);
  });
  tx();
}

export function updateOrderItemQuantity(
  db: AppDatabase,
  orderId: string,
  orderItemId: string,
  quantity: number,
  actor: Actor & { userId: string },
): void {
  if (quantity <= 0) {
    removeOrderItem(db, orderId, orderItemId, actor);
    return;
  }
  if (!Number.isInteger(quantity) || quantity > 999) {
    throw new Error('Quantity must be a whole number between 1 and 999');
  }
  const tx = db.transaction(() => {
    // Same gate as add/remove: only a draft can change shape. Without this a
    // paid order's totals could be rewritten after the money was taken.
    const order = findOrder(db, orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'open') throw new Error(`This order is ${said(order.status)} — items can't be changed now`);
    const row = db
      .prepare(
        `SELECT unit_price_cents, quantity FROM order_items
          WHERE id = ? AND order_id = ? AND deleted_at IS NULL`,
      )
      .get(orderItemId, orderId) as { unit_price_cents: number; quantity: number } | undefined;
    if (!row) throw new Error('Order item not found');

    const modSumRow = db
      .prepare(
        `SELECT COALESCE(SUM(price_delta_cents), 0) AS s
           FROM order_item_modifiers WHERE order_item_id = ? AND deleted_at IS NULL`,
      )
      .get(orderItemId) as { s: number };

    const newLineTotal = (row.unit_price_cents + modSumRow.s) * quantity;
    const now = nowIso();

    db.prepare(
      `UPDATE order_items SET quantity = ?, line_total_cents = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND order_id = ?`,
    ).run(quantity, newLineTotal, now, orderItemId, orderId);

    enqueueSync(db, {
      entityType: 'order_items',
      entityId: orderItemId,
      op: 'upsert',
      payload: { id: orderItemId, quantity, lineTotalCents: newLineTotal },
    });
    writeAudit(db, {
      entityType: 'order_items',
      entityId: orderItemId,
      action: 'update',
      actorUserId: actor.userId,
      before: { quantity: row.quantity },
      after: { quantity, lineTotalCents: newLineTotal },
    });

    recomputeOrderTotals(db, orderId, actor);
  });
  tx();
}

// -----------------------------------------------------------------------------
// Discounts
// -----------------------------------------------------------------------------

export interface ApplyDiscountInput {
  orderId: string;
  discountType: 'percent' | 'flat';
  value: number;
  reason?: string | null;
  approverUserId?: string | null;
}

/**
 * Repository-only options of applyDiscount (never through the IPC contract:
 * the screen can't choose the rule).
 */
export interface ApplyDiscountOptions {
  /**
   * The rule to freeze on the discount instead of the till's Settings switch
   * ('discounts.delivery'): the web bridge passes the website's own
   * (pos-domain websiteDiscountRule), so a web order keeps exactly what the
   * customer was shown.
   */
  rule?: DiscountBaseRule;
}

/**
 * An order's live lines as the discount maths sees them (pos-domain
 * discount-base.ts): what each came to, the name it was sold under, its tax
 * rate and its never-discounted mark (0047 order_items.no_discount, frozen
 * when the line was added), in the till's order ((created_at, id)) — the
 * order the discount is split in, here, on the F3 screen and on the FBR
 * invoice.
 */
function discountLinesOf(
  db: AppDatabase,
  orderId: string,
): Array<{ lineTotalCents: number; menuItemName: string; taxRateBps: number; noDiscount: boolean }> {
  const rows = db
    .prepare(
      `SELECT line_total_cents, menu_item_name, tax_rate_bps_snapshot, no_discount
         FROM order_items WHERE order_id = ? AND deleted_at IS NULL
        ORDER BY created_at, id`,
    )
    .all(orderId) as Array<{ line_total_cents: number; menu_item_name: string; tax_rate_bps_snapshot: number; no_discount: number }>;
  return rows.map((r) => ({
    lineTotalCents: r.line_total_cents,
    menuItemName: r.menu_item_name,
    taxRateBps: r.tax_rate_bps_snapshot,
    noDiscount: r.no_discount === 1,
  }));
}

export function applyDiscount(
  db: AppDatabase,
  input: ApplyDiscountInput,
  actor: Actor & { userId: string },
  opts: ApplyDiscountOptions = {},
): void {
  const tx = db.transaction(() => {
    const order = findOrder(db, input.orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'open') throw new Error(`This order is ${said(order.status)} — a discount can't be added now`);

    // Validate the discount input shape (percent 0-100, value >= 0).
    const v = validateDiscountInput({ discountType: input.discountType, value: input.value });
    if (!v.ok) throw new Error(v.missing.join('; '));

    // The rule this discount is given under, FROZEN on its row below: does it
    // also come off the delivery charge, and does it leave the value deals
    // alone? The till's switch as it is now (Settings → Money & discounts),
    // and never on a value deal (owner, 2 Oct 2026) — except on a foodpanda
    // order, where a manager's discount must match the tablet, which covers
    // them; or the website's own for a web order. Everything after — each
    // cart change, the tax, the FBR invoice, profit, a reprint — follows the
    // row, never the live setting.
    const rule = opts.rule ?? tillDiscountRule(readDiscountAlsoOffDeliveryCharge(db), order.mode !== 'foodpanda');
    // The owner's "a discount needs a reason" (Settings → Money & discounts), read live —
    // defense in depth behind the IPC handler. Every discount the till gives by hand; not the
    // website's pick-up % (its rule is the website's and it carries its own name), and never
    // the automatic offers or the foodpanda deal (their own paths, their own names).
    if (rule.from === 'till' && readDiscountReasonRequired(db) && discountReasonMissing(input.reason)) {
      throw new Error(DISCOUNT_REASON_REQUIRED);
    }
    // What it is worked on: the lines its rule lets it come off — the food
    // only, unless it says every line; never the value deals when it skips them.
    const lines = discountLinesOf(db, input.orderId);
    const base = discountBaseCents(lines, {
      alsoOffDeliveryCharge: rule.alsoOffDeliveryCharge,
      skipsNoDiscountLines: rule.skipsNoDiscountLines === true,
    });
    // Nothing it may come off: every line it could is a value deal. A till
    // discount is refused (the IPC handler refuses first, before any PIN is
    // checked). The website's pick-up % writes nothing — the customer was
    // shown no discount — and never throws: a refusal inside the web import
    // would retry it until the order is cancelled.
    if (base === 0 && rule.skipsNoDiscountLines === true && lines.some((l) => l.noDiscount)) {
      if (rule.from === 'website') return;
      throw new Error(NOTHING_TO_DISCOUNT);
    }

    // Repo-level approval guard — defense in depth even if a future caller
    // bypasses the IPC handler (which already enforces it via verifyManagerPin).
    // The live limit (Settings → Money & discounts), the same rule as the screen
    // and the handler, on the same base as the amount.
    if (
      requiresManagerApproval({ type: input.discountType, value: input.value }, base, readApprovalLimits(db)) &&
      !input.approverUserId
    ) {
      throw new Error('Manager approval is required for this discount');
    }
    // The shop's foodpanda deal on this order: a cashier can't change it. A
    // manager can, for one order (to match the tablet); it is then a manual
    // discount with that manager as approver.
    if (hasFoodpandaDeal(db, input.orderId) && !input.approverUserId) {
      throw new Error(FOODPANDA_DEAL_NEEDS_MANAGER);
    }

    // A % of the base; a rupee amount capped at it (100% off the food leaves
    // the delivery charge to pay).
    const amount = computeDiscountCents(base, {
      type: input.discountType,
      value: input.value,
    });

    // Remove prior discounts on this order (single-discount model for Phase 2).
    // Each one replaced goes to sync as a delete — without it the cloud copy
    // kept both discounts and summed them.
    const now = nowIso();
    const replaced = db
      .prepare(`SELECT id, source, reason, amount_cents, rule_json FROM order_discounts WHERE order_id = ? AND deleted_at IS NULL`)
      .all(input.orderId) as Array<{ id: string; source: string | null; reason: string | null; amount_cents: number; rule_json: string | null }>;
    db.prepare(
      `UPDATE order_discounts SET deleted_at = ?, updated_at = ?, version = version + 1
        WHERE order_id = ? AND deleted_at IS NULL`,
    ).run(now, now, input.orderId);
    for (const r of replaced) {
      enqueueSync(db, {
        entityType: 'order_discounts',
        entityId: r.id,
        op: 'delete',
        payload: { id: r.id, deletedAt: now },
      });
    }
    // An automatic offer this discount replaces (under the normal PIN rule): on record.
    const offersReplaced = replaced.filter((r) => r.source === 'offer');
    if (offersReplaced.length > 0) {
      writeAudit(db, {
        entityType: 'order_discounts',
        entityId: input.orderId,
        action: 'replaced_offer',
        actorUserId: actor.userId,
        before: offersReplaced,
        after: null,
      });
    }

    // source stays NULL (a staff or website discount: Reports group by it),
    // and the rule goes in rule_json (migration 0040; synced with the row).
    const discountId = uuidv7();
    db.prepare(
      `INSERT INTO order_discounts
         (id, order_id, discount_type, value, reason, applied_by_user_id, approved_by_user_id,
          amount_cents, rule_json, created_at, updated_at, device_id, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      discountId,
      input.orderId,
      input.discountType,
      input.value,
      input.reason ?? null,
      actor.userId,
      input.approverUserId ?? null,
      amount,
      JSON.stringify(rule),
      now,
      now,
      actor.deviceId,
    );

    enqueueSync(db, {
      entityType: 'order_discounts',
      entityId: discountId,
      op: 'upsert',
      payload: { ...input, id: discountId, amountCents: amount, rule },
    });
    writeAudit(db, {
      entityType: 'order_discounts',
      entityId: discountId,
      action: 'create',
      actorUserId: actor.userId,
      before: null,
      after: { ...input, amountCents: amount, approverUserId: input.approverUserId, rule },
    });

    recomputeOrderTotals(db, input.orderId, actor);
  });
  tx();
}

/** The order carries the shop's foodpanda deal (a live source 'foodpanda' discount row). */
export function hasFoodpandaDeal(db: AppDatabase, orderId: string): boolean {
  return (
    db
      .prepare(`SELECT 1 AS x FROM order_discounts WHERE order_id = ? AND source = 'foodpanda' AND deleted_at IS NULL LIMIT 1`)
      .get(orderId) !== undefined
  );
}

/** The order carries one of the owner's automatic offers (a live source 'offer' row taking something off). */
export function hasAutomaticOffer(db: AppDatabase, orderId: string): boolean {
  return (
    db
      .prepare(`SELECT 1 AS x FROM order_discounts WHERE order_id = ? AND source = 'offer' AND amount_cents > 0 AND deleted_at IS NULL LIMIT 1`)
      .get(orderId) !== undefined
  );
}

/** What a cashier hears when they try to change a foodpanda order's deal. */
export const FOODPANDA_DEAL_NEEDS_MANAGER =
  "The foodpanda deal is set by the owner. Only a manager can change it on this order, with their PIN or password.";

export function clearDiscount(
  db: AppDatabase,
  orderId: string,
  actor: Actor & { userId: string },
  opts: { approverUserId?: string | null } = {},
): void {
  const tx = db.transaction(() => {
    // Same gate as applying one: taking a discount off a paid order would
    // rewrite a total the customer has already paid.
    const order = findOrder(db, orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'open') throw new Error(`This order is ${said(order.status)} — its discount can't be changed now`);
    const now = nowIso();
    const existing = db
      .prepare(
        `SELECT id, discount_type, value, amount_cents, source, rule_json
           FROM order_discounts WHERE order_id = ? AND deleted_at IS NULL
          ORDER BY created_at, id`,
      )
      .all(orderId) as Array<{
      id: string;
      discount_type: string;
      value: number;
      amount_cents: number;
      source: string | null;
      rule_json: string | null;
    }>;
    if (existing.length === 0) return; // nothing to clear, no audit noise
    // Taking the foodpanda deal off is changing it: a manager's, like applyDiscount.
    if (existing.some((d) => d.source === 'foodpanda') && !opts.approverUserId) throw new Error(FOODPANDA_DEAL_NEEDS_MANAGER);
    // The × on the owner's automatic offer: it comes off THIS order and stays
    // off (a Rs 0 row, so the next cart change does not put it straight back).
    // It only raises the bill, so no PIN; audited. Clearing that row ("Put it
    // back") lets the offers match again.
    const latest = existing[existing.length - 1]!;
    const offerOn = latest.source === 'offer' ? parseOfferRule(latest.rule_json) : null;
    if (offerOn && !offerOn.offer.declined) {
      for (const row of existing) {
        db.prepare(`UPDATE order_discounts SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(now, now, row.id);
        enqueueSync(db, { entityType: 'order_discounts', entityId: row.id, op: 'delete', payload: { id: row.id, deletedAt: now } });
      }
      writeAudit(db, {
        entityType: 'order_discounts',
        entityId: orderId,
        action: 'clear',
        actorUserId: actor.userId,
        before: existing,
        after: null,
      });
      insertOfferRow(db, orderId, declinedOfferRule(offerOn), null, actor, 'decline_offer');
      recomputeOrderTotals(db, orderId, actor);
      return;
    }
    db.prepare(
      `UPDATE order_discounts SET deleted_at = ?, updated_at = ?, version = version + 1
        WHERE order_id = ? AND deleted_at IS NULL`,
    ).run(now, now, orderId);
    for (const row of existing) {
      enqueueSync(db, {
        entityType: 'order_discounts',
        entityId: row.id,
        op: 'delete',
        payload: { id: row.id, deletedAt: now },
      });
    }
    writeAudit(db, {
      entityType: 'order_discounts',
      entityId: orderId,
      action: 'clear',
      actorUserId: actor.userId,
      before: existing,
      after: opts.approverUserId ? { approverUserId: opts.approverUserId } : null,
    });
    recomputeOrderTotals(db, orderId, actor);
  });
  tx();
}

// -----------------------------------------------------------------------------
// Recompute totals (subtotal, discount, tax, total) — called after every mutation
// -----------------------------------------------------------------------------

function recomputeOrderTotals(
  db: AppDatabase,
  orderId: string,
  actor: Actor,
): void {
  // The owner's automatic offers first: put on, kept, swapped or taken off
  // for the cart as it is now (a counter order being rung up only).
  applyOfferStep(db, orderId, actor);

  // Subtotal = sum of line_total_cents over non-deleted items
  const subtotalRow = db
    .prepare(
      `SELECT COALESCE(SUM(line_total_cents), 0) AS s
         FROM order_items WHERE order_id = ? AND deleted_at IS NULL`,
    )
    .get(orderId) as { s: number };
  const subtotal = subtotalRow.s;

  // Discount = single most recent (we enforce one discount per order in Phase 2),
  // re-worked from its type and value against the subtotal as it is NOW. It was
  // frozen at the rupee amount from when it was applied, so 10% of a big cart
  // became 100% once items were taken off (no PIN), and items added later got
  // nothing (audit 2026-09-25).
  const discountRow = db
    .prepare(
      `SELECT id, discount_type, value, amount_cents, approved_by_user_id, source, rule_json FROM order_discounts
         WHERE order_id = ? AND deleted_at IS NULL
         ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(orderId) as
    | {
        id: string;
        discount_type: 'percent' | 'flat';
        value: number;
        amount_cents: number;
        approved_by_user_id: string | null;
        source: string | null;
        rule_json: string | null;
      }
    | undefined;
  // The lines in the till's order: what the discount is worked on and split over.
  const lines = discountLinesOf(db, orderId);
  // Does the discount also come off the delivery charge, and does it leave
  // the value deals alone? The rule FROZEN on its row when it was given —
  // never the live setting. A row with no rule (given before 0.7.26, or on
  // an older till) covers every line, as then; one from before 0.7.34, and
  // the foodpanda deal, cover the value deals.
  const scope: DiscountScope = discountRow
    ? discountRuleScope(discountRow.rule_json)
    : { alsoOffDeliveryCharge: true, skipsNoDiscountLines: false };
  // What it is worked on: the food only, or every line (the subtotal); the
  // value deals left out when the rule skips them. A staff discount whose
  // lines are all value deals now (the pizza taken off) stays on at Rs 0,
  // and works again when food is added.
  const base = discountBaseCents(lines, scope);
  let discount = 0;
  if (discountRow) {
    const d = { type: discountRow.discount_type, value: discountRow.value };
    const now = nowIso();
    // The shop's foodpanda deal: re-worked from the terms frozen on the row
    // (the minimum, the most off, the delivery charge), never from the live
    // setting — and never cleared by the approval re-check (the owner set
    // it). A rule this version can't read is worked as its type and value on
    // the whole subtotal, as an older till does.
    const dealRule = discountRow.source === 'foodpanda' ? parseFoodpandaDealRule(discountRow.rule_json) : null;
    // One of the owner's automatic offers: re-worked from the terms frozen on
    // the row (its %/rupees, most-off; the minimum on the food, without the
    // value deals when its rule skips them; the delivery charge as its rule
    // says), never from the live setting; never cleared by the approval
    // re-check (the owner's own rule). Taken off by the cashier: Rs 0. A rule
    // this version can't read: its type and value on the base.
    const offerRule = discountRow.source === 'offer' ? parseOfferRule(discountRow.rule_json) : null;
    if (discountRow.source === 'offer') {
      discount = offerRule
        ? offerRule.offer.declined
          ? 0
          : offerAmount(
              offerRule.offer,
              base,
              discountBaseCents(lines, { alsoOffDeliveryCharge: false, skipsNoDiscountLines: scope.skipsNoDiscountLines }),
            )
        : computeDiscountCents(base, d);
      if (discount !== discountRow.amount_cents) {
        db.prepare(
          `UPDATE order_discounts SET amount_cents = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
        ).run(discount, now, discountRow.id);
        enqueueSync(db, {
          entityType: 'order_discounts',
          entityId: discountRow.id,
          op: 'upsert',
          payload: { id: discountRow.id, amountCents: discount },
        });
      }
    } else if (discountRow.source === 'foodpanda') {
      discount = dealRule ? dealAmount(dealRule, base).shopCents : computeDiscountCents(subtotal, d);
      if (discount !== discountRow.amount_cents) {
        db.prepare(
          `UPDATE order_discounts SET amount_cents = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
        ).run(discount, now, discountRow.id);
        enqueueSync(db, {
          entityType: 'order_discounts',
          entityId: discountRow.id,
          op: 'upsert',
          payload: { id: discountRow.id, amountCents: discount },
        });
      }
    } else if (!discountRow.approved_by_user_id && requiresManagerApproval(d, base, readApprovalLimits(db))) {
      // Unapproved, and now over the limit: a flat discount that has become
      // more than the % limit of a shrunken cart, or any discount over a
      // limit the owner has lowered since (Settings → Money & discounts, read
      // live here, at the order's next cart change). Take it off; the cashier
      // re-applies it with a manager's PIN.
      db.prepare(
        `UPDATE order_discounts SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(now, now, discountRow.id);
      enqueueSync(db, { entityType: 'order_discounts', entityId: discountRow.id, op: 'delete', payload: { id: discountRow.id, deletedAt: now } });
      writeAudit(db, {
        entityType: 'order_discounts',
        entityId: discountRow.id,
        action: 'auto_clear_needs_approval',
        actorUserId: actor.userId ?? null,
        before: discountRow,
        after: null,
      });
      // The cashier's discount is gone: the owner's automatic offer may fit
      // the order again, in this same step — else Pay would charge the full
      // price until the next cart change. (The offer step ran first, above,
      // and saw this discount there.)
      if (applyOfferStep(db, orderId, actor)) {
        recomputeOrderTotals(db, orderId, actor);
        return;
      }
    } else {
      discount = computeDiscountCents(base, d);
      if (discount !== discountRow.amount_cents) {
        db.prepare(
          `UPDATE order_discounts SET amount_cents = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
        ).run(discount, now, discountRow.id);
        enqueueSync(db, {
          entityType: 'order_discounts',
          entityId: discountRow.id,
          op: 'upsert',
          payload: { id: discountRow.id, amountCents: discount },
        });
      }
    }
  }

  // Tax = per-line tax on (line_total - its share of the discount) * rate.
  // The discount is split over the lines by weight in whole paisa that add up
  // to it exactly (pos-domain taxAfterDiscount → allocateDiscount), a
  // delivery charge or a value deal the rule leaves alone weighing 0; the F3
  // preview, the FBR mapper and the website's estimate split it the same
  // way. Lines in insertion order so they all agree.
  const tax = subtotal > 0 ? taxAfterDiscount(lines, discount, scope).taxCents : 0;

  const total = subtotal - discount + tax;
  const now = nowIso();

  db.prepare(
    `UPDATE orders SET
       subtotal_cents = ?, discount_cents = ?, tax_cents = ?, total_cents = ?,
       updated_at = ?, version = version + 1
     WHERE id = ?`,
  ).run(subtotal, discount, tax, total, now, orderId);

  enqueueSync(db, {
    entityType: 'orders',
    entityId: orderId,
    op: 'upsert',
    payload: { id: orderId, subtotalCents: subtotal, discountCents: discount, taxCents: tax, totalCents: total },
  });
  // Note: no audit_log for total recomputes — they're a side-effect, not a user action
  void actor; // (reserved for future per-recompute audit if needed)
}

// -----------------------------------------------------------------------------
// Tender (finalize)
// -----------------------------------------------------------------------------

export interface TenderInputItem {
  method: PaymentMethod;
  amountCents: number;
  tenderedCents?: number | null;
  referenceNo?: string | null;
}

/**
 * An order after money changed hands, and the drawer_opens row (0042) its
 * drawer pulse is for — written in the same transaction as the cash, only
 * when cash moved (null for card, wallet or Foodpanda). The handler passes
 * the id to the spooler: no row, no pulse.
 */
export type OrderWithDrawer = Order & { drawerOpenId: string | null };

/**
 * The drawer_opens row for cash taken on an order: one per payment event,
 * for the CASH part only (a split cash + card payment opens it for the cash).
 * Null when no cash moved. Inside the caller's transaction.
 */
function recordCashSale(
  db: AppDatabase,
  orderId: string,
  payments: ReadonlyArray<{ method: PaymentMethod; amountCents: number }>,
  actor: Actor & { userId: string },
): string | null {
  const cash = payments.filter((p) => p.method === 'cash').reduce((n, p) => n + p.amountCents, 0);
  if (cash <= 0) return null;
  return recordDrawerOpen(db, { kind: 'sale', orderId, amountCents: cash }, actor).id;
}

export function tenderOrder(
  db: AppDatabase,
  input: { orderId: string; payments: TenderInputItem[]; foodpanda?: FoodpandaTenderCheck | null },
  actor: Actor & { userId: string },
): OrderWithDrawer {
  let result!: OrderWithDrawer;
  const tx = db.transaction(() => {
    const order = findOrder(db, input.orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'open') throw new Error(`This order is ${said(order.status)} — it can't be paid again here`);

    // Snapshot the order again to pick up customer/address fields written by attachCustomer.
    const orderRow = db
      .prepare(`SELECT ${ORDER_SELECT} FROM orders WHERE id = ? AND deleted_at IS NULL`)
      .get(input.orderId) as OrderRow | undefined;
    const itemCount = (
      db.prepare(
        `SELECT COUNT(*) AS n FROM order_items WHERE order_id = ? AND deleted_at IS NULL`,
      ).get(input.orderId) as { n: number }
    ).n;

    // Defense in depth: world-standard POS rules — checked here in addition to the UI.
    const validation = validateOrderForTender({
      mode: order.mode,
      itemCount,
      subtotalCents: order.subtotalCents,
      tableId: order.tableId,
      customerName: orderRow?.customer_name_snapshot ?? null,
      customerPhone: orderRow?.customer_phone_snapshot ?? null,
      deliveryAddress: orderRow?.delivery_address_snapshot ?? null,
    });
    if (!validation.ok) {
      throw new Error(`Cannot tender: ${validation.missing.join('; ')}`);
    }

    // A fully discounted order (total 0) has nothing to collect: an empty
    // payments array is valid and inserts no payment rows (payments has a
    // CHECK (amount_cents != 0)). The order is still stamped paid below.
    const nothingToPay = order.totalCents === 0 && input.payments.length === 0;
    if (!nothingToPay) {
      // The payments ARE the sale: they must add up to the bill exactly. More
      // than the bill was accepted (a Rs 5,000 card charge on a Rs 2,000 order
      // went into the books as Rs 5,000 of sales). Cash change lives in
      // tendered_cents, never in the amount.
      const sum = input.payments.reduce((s, p) => s + p.amountCents, 0);
      if (sum !== order.totalCents) {
        throw new Error(
          `Payments (Rs ${sum / 100}) must equal the order total (Rs ${order.totalCents / 100})`,
        );
      }
    }
    // Cash legs must satisfy tendered >= leg amount (UI enforces, server confirms).
    for (const p of input.payments) {
      if (p.amountCents <= 0) throw new Error('Payment amounts must be positive');
      assertMethodFitsOrder(order.mode, p.method);
      if (p.method === 'cash' && p.tenderedCents != null && p.tenderedCents < p.amountCents) {
        throw new Error('Cash tendered cannot be less than the cash amount');
      }
    }

    // The foodpanda deal exists only on foodpanda orders.
    if (order.mode !== 'foodpanda' && hasFoodpandaDeal(db, input.orderId)) {
      throw new Error('This order still has the foodpanda deal but is not a foodpanda order — make it foodpanda again, or take the deal off');
    }
    // …and the owner's automatic offers only on counter orders: never a website or foodpanda order.
    if (!offerCanApplyTo(order) && hasAutomaticOffer(db, input.orderId)) {
      throw new Error("This order has one of the shop's automatic offers, but offers are for counter orders only — take it off");
    }
    // foodpanda's order number (on the payment) and the tablet's total, as the owner's checks ask.
    let payments = input.payments;
    let tabletTotalCents: number | null = null;
    if (order.mode === 'foodpanda') {
      const checks = readShopSetting(db, 'foodpanda.checks').value;
      payments = input.payments.map((p) => ({ ...p, referenceNo: foodpandaOrderCode(p.referenceNo) }));
      const code = payments.find((p) => p.method === 'foodpanda')?.referenceNo ?? null;
      if (checks.orderCode === 'required' && payments.length > 0 && code === null) {
        throw new Error("Type foodpanda's order number — the owner has made it required");
      }
      const typed = input.foodpanda?.tabletTotalCents;
      tabletTotalCents = typeof typed === 'number' && Number.isInteger(typed) && typed >= 0 ? typed : null;
      if (checks.tabletTotal === 'required' && tabletTotalCents === null) {
        throw new Error('Type the total on the foodpanda tablet — the owner has made it required');
      }
    }

    const now = nowIso();
    const shiftId = payments.length > 0 ? shiftForPayment(db, actor.deviceId) : null;
    for (const p of payments) {
      const pid = uuidv7();
      db.prepare(
        `INSERT INTO payments
           (id, order_id, method, amount_cents, tendered_cents, reference_no,
            received_by_user_id, paid_at, created_at, updated_at, device_id, version, shift_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      ).run(
        pid,
        input.orderId,
        p.method,
        p.amountCents,
        p.tenderedCents ?? null,
        p.referenceNo ?? null,
        actor.userId,
        now,
        now,
        now,
        actor.deviceId,
        shiftId,
      );
      enqueuePaymentSyncAndAudit(db, {
        entityType: 'payments',
        entityId: pid,
        op: 'upsert',
        payload: { id: pid, orderId: input.orderId, ...p, paidAt: now, receivedByUserId: actor.userId },
      }, actor.userId);
    }

    // Paying is not the end of the order's life: the kitchen still has to
    // cook it and someone has to hand it over. A prepaid order therefore goes
    // to the Live Orders board as `sent_to_kitchen` with `paid_at` set, and
    // only becomes `paid` (terminal) when it is marked picked up / delivered.
    // `paid` straight from tender used to make prepaid deliveries vanish from
    // the board with no way to assign a rider.
    const nextStatus: OrderStatus = 'sent_to_kitchen';
    // Paid and sent in one step (Pay now, foodpanda's pay-and-send): sent now
    // too (0048), stamped once like Send to kitchen.
    db.prepare(
      `UPDATE orders SET status = ?, paid_at = ?, sent_at = COALESCE(sent_at, ?), updated_at = ?, version = version + 1
        WHERE id = ?`,
    ).run(nextStatus, now, now, now, input.orderId);

    const finalized = { ...order, status: nextStatus, paidAt: now, sentAt: order.sentAt ?? now };
    enqueueSync(db, {
      entityType: 'orders',
      entityId: input.orderId,
      op: 'upsert',
      payload: finalized,
    });
    writeAudit(db, {
      entityType: 'orders',
      entityId: input.orderId,
      action: 'tender',
      actorUserId: actor.userId,
      before: order,
      after: finalized,
    });

    // A foodpanda order's economics, frozen now: next month's terms never rewrite it.
    if (order.mode === 'foodpanda') writeFoodpandaTerms(db, order, tabletTotalCents, actor);

    // Cash in the drawer: its open on record with the sale (the cash part).
    // foodpanda pays foodpanda, never the drawer: no cash leg, no row, no pulse.
    const drawerOpenId = recordCashSale(db, input.orderId, payments, actor);
    result = { ...finalized, drawerOpenId };
  });
  tx();
  log.info('Order tendered', { id: input.orderId, total: result.totalCents });
  return result;
}

/** foodpanda's order number as typed: trimmed, no leading '#', at most FOODPANDA_ORDER_CODE_MAX letters; empty = null. */
export function foodpandaOrderCode(raw: string | null | undefined): string | null {
  const t = (raw ?? '').replace(/\s+/g, ' ').trim().replace(/^#\s*/, '').slice(0, FOODPANDA_ORDER_CODE_MAX).trim();
  return t === '' ? null : t;
}

/** The one channel-terms row of an order: the same id on both tills. */
export function orderChannelTermsId(orderId: string): string {
  return uuidv5(`order_channel_terms:${orderId}`, COC_ID_NAMESPACE);
}

/**
 * A foodpanda order's economics at payment (order_channel_terms, migration
 * 0040), in the tender's transaction: the deal as frozen on the order, the
 * shop's part and foodpanda's, the fees in force now and what they come to
 * (pos-domain foodpandaTerms, at foodpanda's prices when its menu is dearer:
 * the uplift in force is kept too, and foodpanda's % of the total, 0041),
 * what foodpanda should pay, and the tablet's total with its difference from
 * the one expected. Reports read it back through foodpandaOrderMoney.
 * Insert-only (a second tender of the same order never happens; the row is
 * never rewritten), and it never bumps orders.version.
 */
function writeFoodpandaTerms(db: AppDatabase, order: Order, tabletTotalCents: number | null, actor: Actor & { userId: string }): void {
  const id = orderChannelTermsId(order.id);
  if (db.prepare(`SELECT 1 AS x FROM order_channel_terms WHERE id = ?`).get(id) !== undefined) return;
  const dealRow = db
    .prepare(
      `SELECT discount_type, value, rule_json FROM order_discounts
        WHERE order_id = ? AND source = 'foodpanda' AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(order.id) as { discount_type: 'percent' | 'flat'; value: number; rule_json: string | null } | undefined;
  const rule = parseFoodpandaDealRule(dealRow?.rule_json);
  // On what the deal was worked: the food, when its frozen rule left the
  // delivery charge alone — read against the stored bill (an older till
  // re-works it over every line: pos-domain storedDiscountAlsoOffDeliveryCharge,
  // by the deal's own terms first, then the tax).
  // The value deals always count: the deal matches the tablet, which covers them.
  const lines = discountLinesOf(db, order.id);
  const share =
    rule && dealRow
      ? dealAmount(
          rule,
          discountBaseCents(lines, {
            alsoOffDeliveryCharge: storedDiscountAlsoOffDeliveryCharge(
              rule.alsoOffDeliveryCharge !== false,
              lines,
              order.discountCents,
              order.taxCents,
              { discountType: dealRow.discount_type, value: dealRow.value, source: 'foodpanda', ruleJson: dealRow.rule_json },
            ),
            skipsNoDiscountLines: false,
          }),
        )
      : null;
  const fees = readShopSetting(db, 'foodpanda.fees');
  const t = foodpandaTerms(
    { subtotalCents: order.subtotalCents, shopDiscountCents: order.discountCents, totalCents: order.totalCents },
    fees.value,
  );
  const now = nowIso();
  const terms = {
    id,
    orderId: order.id,
    channel: 'foodpanda',
    dealLabel: rule?.label ?? null,
    dealBps: rule ? rule.dealPercent * 100 : null,
    shopBps: rule ? rule.shopPercent * 100 : null,
    shopDiscountCents: order.discountCents as number,
    platformFundedCents: share?.platformCents ?? 0,
    commissionBps: fees.value.commissionBps,
    commissionBase: fees.value.base,
    commissionConfirmed: fees.value.confirmed,
    commissionCents: t.commissionCents,
    fixedFeeCents: t.fixedFeeCents,
    commissionTaxCents: t.commissionTaxCents,
    paymentFeeCents: t.paymentFeeCents,
    upliftBps: fees.value.upliftBps,
    expectedPayoutCents: t.expectedPayoutCents,
    tabletTotalCents,
    // Against what the tablet should show: the till's total at foodpanda's prices (Settings → foodpanda).
    tabletDiffCents: tabletTotalCents === null ? null : tabletTotalCents - t.expectedTabletCents,
    settingsAt: fees.savedAt,
  };
  db.prepare(
    `INSERT INTO order_channel_terms
       (id, order_id, channel, deal_label, deal_bps, shop_bps, shop_discount_cents, platform_funded_cents,
        commission_bps, commission_base, commission_confirmed, commission_cents, fixed_fee_cents,
        commission_tax_cents, payment_fee_cents, uplift_bps, expected_payout_cents, tablet_total_cents,
        tablet_diff_cents, settings_at, created_at, updated_at, device_id, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    terms.id,
    terms.orderId,
    terms.channel,
    terms.dealLabel,
    terms.dealBps,
    terms.shopBps,
    terms.shopDiscountCents,
    terms.platformFundedCents,
    terms.commissionBps,
    terms.commissionBase,
    terms.commissionConfirmed ? 1 : 0,
    terms.commissionCents,
    terms.fixedFeeCents,
    terms.commissionTaxCents,
    terms.paymentFeeCents,
    terms.upliftBps,
    terms.expectedPayoutCents,
    terms.tabletTotalCents,
    terms.tabletDiffCents,
    terms.settingsAt,
    now,
    now,
    actor.deviceId,
  );
  enqueueSync(db, { entityType: 'order_channel_terms', entityId: id, op: 'upsert', payload: terms });
  writeAudit(db, {
    entityType: 'order_channel_terms',
    entityId: id,
    action: 'create',
    actorUserId: actor.userId,
    before: null,
    after: terms,
  });
}

// -----------------------------------------------------------------------------
// Void
// -----------------------------------------------------------------------------

/** What a cancel or refund did: the order after it, and to its stock. */
export interface OrderCloseResult {
  order: Order;
  /** Null when the order held no stock here (or a part refund left money on it). */
  stock: StockSettlement | null;
  /** The status it had just before (the kitchen gets a CANCELLED slip while it was cooking). */
  statusBefore: OrderStatus;
  /**
   * The drawer_opens row (0042) for cash handed back by THIS refund, written
   * in the same transaction; null when no cash went back (a card refund, a
   * cancel of an unpaid order).
   */
  drawerOpenId: string | null;
}

/** The dialog showed one status; the order has moved on since (the kitchen tapped a button). */
function checkExpectedStatus(order: Order, expected: OrderStatus | undefined): void {
  if (expected !== undefined && order.status !== expected) {
    throw new Error(`This order is now ${said(order.status)} — close this and check again`);
  }
}

export function voidOrder(
  db: AppDatabase,
  input: { orderId: string; reason: string; approverUserId: string } & OrderStockAnswer,
  actor: Actor & { userId: string },
): OrderCloseResult {
  let result!: OrderCloseResult;
  const tx = db.transaction(() => {
    const order = findOrder(db, input.orderId);
    if (!order) throw new Error('Order not found');
    checkExpectedStatus(order, input.expectStatus);

    const v = validateVoid({ status: order.status, paidAt: order.paidAt, reason: input.reason });
    if (!v.ok) throw new Error(v.missing.join('; '));

    const now = nowIso();
    db.prepare(
      `UPDATE orders SET status = 'void', voided_at = ?, voided_by = ?, void_reason = ?,
                          updated_at = ?, version = version + 1
        WHERE id = ?`,
    ).run(now, input.approverUserId, input.reason, now, input.orderId);

    // Stock left when the kitchen got the order. Whatever it still holds is
    // put back or booked as waste, per "Was the food made?" — at any status
    // (order-stock-repo.ts). A refusal there (no answer; "not made" for food
    // that left the shop) rolls the whole cancel back.
    const stock = settleOrderStock(
      db,
      {
        orderId: input.orderId,
        how: 'cancelled',
        statusBefore: order.status,
        approverUserId: input.approverUserId,
        ...(input.foodMade !== undefined ? { foodMade: input.foodMade } : {}),
        ...(input.putBack !== undefined ? { putBack: input.putBack } : {}),
      },
      actor,
    );

    const voided = {
      ...order,
      status: 'void' as OrderStatus,
      voidedAt: now,
      voidedBy: input.approverUserId as Order['voidedBy'],
      voidReason: input.reason,
    };
    enqueueSync(db, {
      entityType: 'orders',
      entityId: input.orderId,
      op: 'upsert',
      payload: voided,
    });
    writeAudit(db, {
      entityType: 'orders',
      entityId: input.orderId,
      action: 'void',
      actorUserId: actor.userId,
      before: order,
      after: voided,
    });
    // Nothing was paid on a cancelled order: no cash moves, the drawer stays shut.
    result = { order: voided, stock, statusBefore: order.status, drawerOpenId: null };
  });
  tx();
  return result;
}

// -----------------------------------------------------------------------------
// Refund (full or partial)
// -----------------------------------------------------------------------------

/**
 * Refund a paid order. Supports two modes:
 *   1. Full refund (no `amountCents` given) — inserts one negative payment
 *      per original positive payment so the books mirror perfectly (or, after
 *      an earlier part refund, one refund of what is left). Status moves to
 *      'refunded'.
 *   2. Partial refund (`amountCents` provided) — inserts a single negative
 *      payment with the supplied method (or the dominant payment method on
 *      the order if not specified). The status is left as it is (an order
 *      still in the kitchen stays there; a closed one stays paid) until the
 *      refunds add up to everything paid, when it flips to 'refunded'.
 *
 * Partial-refund accumulation is computed from the payments ledger, so
 * multiple partials add up correctly. Refund amount can't exceed the
 * remaining refundable balance.
 *
 * Stock: money only, until the order is refunded in full. Then whatever it
 * still holds is put back or booked as waste, per "Was the food made?"
 * (order-stock-repo.ts) — a part refund can't say which item it was for.
 */
export function refundOrder(
  db: AppDatabase,
  input: {
    orderId: string;
    reason: string;
    approverUserId: string;
    amountCents?: number;
    method?: PaymentMethod;
  } & OrderStockAnswer,
  actor: Actor & { userId: string },
): OrderCloseResult {
  let result!: OrderCloseResult;
  // Cash handed back by THIS refund opens the drawer: its row, with who
  // pressed Refund and the manager who allowed it (null when they are the
  // same person), amount negative (cash out). Null when no cash went back.
  const cashBack = (rows: ReadonlyArray<{ method: PaymentMethod; amountCents: number }>): string | null => {
    const cash = rows.filter((r) => r.method === 'cash').reduce((n, r) => n + r.amountCents, 0);
    if (cash <= 0) return null;
    return recordDrawerOpen(
      db,
      {
        kind: 'refund',
        orderId: input.orderId,
        amountCents: -cash,
        approvedByUserId: input.approverUserId === actor.userId ? null : input.approverUserId,
      },
      actor,
    ).id;
  };
  const settle = (statusBefore: OrderStatus): StockSettlement | null =>
    settleOrderStock(
      db,
      {
        orderId: input.orderId,
        how: 'refunded',
        statusBefore,
        approverUserId: input.approverUserId,
        ...(input.foodMade !== undefined ? { foodMade: input.foodMade } : {}),
        ...(input.putBack !== undefined ? { putBack: input.putBack } : {}),
      },
      actor,
    );
  const tx = db.transaction(() => {
    const order = findOrder(db, input.orderId);
    if (!order) throw new Error('Order not found');
    checkExpectedStatus(order, input.expectStatus);
    if (order.status === 'refunded') throw new Error('Order already fully refunded');
    if (order.status === 'void') throw new Error('Cannot refund a voided order');
    if (order.paidAt === null) {
      throw new Error(`Nothing has been paid on this order yet (it is ${said(order.status)}) — cancel it instead`);
    }
    if (!input.reason.trim()) throw new Error('Refund reason is required');
    // A method the refund screen chose must fit the order: foodpanda's money
    // goes back through foodpanda, never out of the drawer (so no drawer row
    // and no pulse), and no other order's through foodpanda. The screen offers
    // only that; the main process holds to it. Left to itself the refund
    // reverses what was paid, in the way it was paid.
    if (input.method !== undefined) assertMethodFitsOrder(order.mode, input.method, 'refund');

    const now = nowIso();
    const shiftId = shiftForPayment(db, actor.deviceId);
    const payments = db
      .prepare(
        `SELECT id, method, amount_cents FROM payments
          WHERE order_id = ? AND deleted_at IS NULL`,
      )
      .all(input.orderId) as Array<{
      id: string;
      method: PaymentMethod;
      amount_cents: number;
    }>;
    const positivePayments = payments.filter((p) => p.amount_cents > 0);
    if (positivePayments.length === 0) {
      throw new Error('No positive payments to refund against');
    }
    // Net amount paid so far (positive - already-refunded).
    const netPaidCents = payments.reduce((s, p) => s + p.amount_cents, 0);
    if (netPaidCents <= 0) {
      throw new Error('Order has no refundable balance left');
    }

    // ---- PARTIAL REFUND PATH ----------------------------------------
    if (input.amountCents !== undefined) {
      const requested = Math.round(input.amountCents);
      if (requested <= 0) throw new Error('Refund amount must be positive');
      if (requested > netPaidCents) {
        throw new Error(
          `Refund (Rs ${requested / 100}) exceeds remaining balance (Rs ${
            netPaidCents / 100
          })`,
        );
      }
      // Pick the method: caller's, else the largest positive payment's.
      const dominant = positivePayments
        .slice()
        .sort((a, b) => b.amount_cents - a.amount_cents)[0]!;
      const method: PaymentMethod = input.method ?? dominant.method;
      const refundId = uuidv7();
      db.prepare(
        `INSERT INTO payments
           (id, order_id, method, amount_cents, tendered_cents, reference_no,
            received_by_user_id, paid_at, created_at, updated_at, device_id, version, shift_id)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 1, ?)`,
      ).run(
        refundId,
        input.orderId,
        method,
        -requested,
        `partial-refund: ${input.reason.trim()}`,
        input.approverUserId,
        now,
        now,
        now,
        actor.deviceId,
        shiftId,
      );
      enqueuePaymentSyncAndAudit(db, {
        entityType: 'payments',
        entityId: refundId,
        op: 'upsert',
        payload: {
          id: refundId,
          orderId: input.orderId,
          method,
          amountCents: -requested,
          referenceNo: `partial-refund: ${input.reason.trim()}`,
          receivedByUserId: input.approverUserId,
          paidAt: now,
        },
      }, actor.userId);

      // Status flips to 'refunded' only when cumulative refunds hit total.
      const remaining = netPaidCents - requested;
      const fullyRefunded = remaining === 0;
      const statusUpdate = fullyRefunded
        ? `, status = 'refunded', voided_at = ?, voided_by = ?, void_reason = ?`
        : '';
      const statusParams = fullyRefunded
        ? [now, input.approverUserId, input.reason.trim()]
        : [];
      db.prepare(
        `UPDATE orders SET updated_at = ?, version = version + 1${statusUpdate}
          WHERE id = ?`,
      ).run(now, ...statusParams, input.orderId);
      // The last of the money back: the order ends, and so does its hold on stock.
      const stock = fullyRefunded ? settle(order.status) : null;

      const after = findOrder(db, input.orderId)!;
      enqueueSync(db, {
        entityType: 'orders',
        entityId: input.orderId,
        op: 'upsert',
        payload: after,
      });
      writeAudit(db, {
        entityType: 'orders',
        entityId: input.orderId,
        action: fullyRefunded ? 'refund_partial_final' : 'refund_partial',
        actorUserId: actor.userId,
        before: order,
        after,
      });
      const drawerOpenId = cashBack([{ method, amountCents: requested }]);
      result = { order: after, stock, statusBefore: order.status, drawerOpenId };
      return;
    }

    // ---- FULL REFUND PATH ----------------------------------------------
    // After a partial refund only the rest is still paid. Reversing every
    // original payment again paid out more than the customer ever paid
    // (Rs 1,000 order, Rs 300 back, then "full refund" wrote −Rs 1,000:
    // Rs 1,300 in all — audit 2026-09-25). So: one refund of what is left.
    const positiveTotal = positivePayments.reduce((s, p) => s + p.amount_cents, 0);
    const alreadyRefunded = positiveTotal !== netPaidCents;
    const dominantMethod = positivePayments
      .slice()
      .sort((a, b) => b.amount_cents - a.amount_cents)[0]!.method;
    const reversals: Array<{ method: PaymentMethod; amountCents: number; ref: string }> = alreadyRefunded
      ? [{ method: input.method ?? dominantMethod, amountCents: netPaidCents, ref: `refund-rest: ${input.reason.trim()}` }]
      : positivePayments.map((p) => ({ method: p.method, amountCents: p.amount_cents, ref: `refund-of:${p.id}` }));
    for (const p of reversals) {
      const refundId = uuidv7();
      db.prepare(
        `INSERT INTO payments
           (id, order_id, method, amount_cents, tendered_cents, reference_no,
            received_by_user_id, paid_at, created_at, updated_at, device_id, version, shift_id)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 1, ?)`,
      ).run(
        refundId,
        input.orderId,
        p.method,
        -p.amountCents,
        p.ref,
        input.approverUserId,
        now,
        now,
        now,
        actor.deviceId,
        shiftId,
      );
      enqueuePaymentSyncAndAudit(db, {
        entityType: 'payments',
        entityId: refundId,
        op: 'upsert',
        payload: {
          id: refundId,
          orderId: input.orderId,
          method: p.method,
          amountCents: -p.amountCents,
          referenceNo: p.ref,
          receivedByUserId: input.approverUserId,
          paidAt: now,
        },
      }, actor.userId);
    }

    db.prepare(
      `UPDATE orders SET status = 'refunded', voided_at = ?, voided_by = ?, void_reason = ?,
                          updated_at = ?, version = version + 1
        WHERE id = ?`,
    ).run(now, input.approverUserId, input.reason.trim(), now, input.orderId);
    // Refunded in full: whatever it still holds is put back or wasted.
    const stock = settle(order.status);

    const after = findOrder(db, input.orderId)!;
    enqueueSync(db, {
      entityType: 'orders',
      entityId: input.orderId,
      op: 'upsert',
      payload: after,
    });
    writeAudit(db, {
      entityType: 'orders',
      entityId: input.orderId,
      action: 'refund',
      actorUserId: actor.userId,
      before: order,
      after,
    });
    const drawerOpenId = cashBack(reversals);
    result = { order: after, stock, statusBefore: order.status, drawerOpenId };
  });
  tx();
  log.info('Order refunded', { id: input.orderId });
  return result;
}

// -----------------------------------------------------------------------------
// Snapshot (for receipt + reports)
// -----------------------------------------------------------------------------

/**
 * One order in full. A deleted order is not found — unless `includeDeleted`
 * (the owner's list of deleted test orders, the kitchen's CANCELLED slip for
 * one, the audit's before-image): then its delete columns are on the order and
 * its deleted payments are in, each marked with its deletedAt.
 */
export function getOrderSnapshot(
  db: AppDatabase,
  orderId: string,
  opts: { includeDeleted?: boolean } = {},
): OrderSnapshot | null {
  const withDeleted = opts.includeDeleted === true;
  const orderRow = db
    .prepare(`SELECT ${ORDER_SELECT} FROM orders WHERE id = ?${withDeleted ? '' : ' AND deleted_at IS NULL'}`)
    .get(orderId) as OrderRow | undefined;
  if (!orderRow) return null;

  const order = rowToOrder(orderRow);

  const itemRows = db
    .prepare(
      `SELECT oi.id, oi.order_id, oi.menu_item_id, oi.menu_item_name, oi.combo_id,
              oi.parent_order_item_id, oi.quantity, oi.unit_price_cents, oi.line_total_cents,
              oi.tax_category_id, oi.tax_rate_bps_snapshot, oi.prep_station_snapshot,
              oi.notes, oi.kitchen_status, oi.no_discount, oi.created_at, oi.updated_at, oi.device_id, oi.version,
              c.name AS category_name
         FROM order_items oi
    LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
    LEFT JOIN categories c ON c.id = mi.category_id
        WHERE oi.order_id = ? AND oi.deleted_at IS NULL
        ORDER BY oi.created_at, oi.id`,
    )
    .all(orderId) as Array<{
    id: string;
    menu_item_id: string | null;
    menu_item_name: string;
    combo_id: string | null;
    parent_order_item_id: string | null;
    quantity: number;
    unit_price_cents: number;
    line_total_cents: number;
    tax_category_id: string;
    tax_rate_bps_snapshot: number | null;
    prep_station_snapshot: PrepStation;
    notes: string | null;
    kitchen_status: OrderItem['kitchenStatus'];
    no_discount: number;
    category_name: string | null;
  }>;

  // Fetch modifiers for all items in one query, each line's in the order they
  // were asked (sort_order, written by addOrderItem / updateOrderItemOptions).
  // Rows from before 0031 all carry 0: they keep the order they were written in.
  const modRows = itemRows.length
    ? (db
        .prepare(
          `SELECT id, order_item_id, modifier_id, modifier_name, price_delta_cents
             FROM order_item_modifiers
            WHERE order_item_id IN (${itemRows.map(() => '?').join(',')}) AND deleted_at IS NULL
            ORDER BY order_item_id, sort_order, created_at, id`,
        )
        .all(...itemRows.map((r) => r.id)) as Array<{
        id: string;
        order_item_id: string;
        modifier_id: string | null;
        modifier_name: string;
        price_delta_cents: number;
      }>)
    : [];

  const modsByItem = new Map<string, OrderItemModifier[]>();
  for (const m of modRows) {
    const arr = modsByItem.get(m.order_item_id) ?? [];
    arr.push({
      id: m.id as OrderItemModifier['id'],
      orderItemId: m.order_item_id as OrderItemModifier['orderItemId'],
      modifierId: (m.modifier_id ?? '') as OrderItemModifier['modifierId'],
      modifierName: m.modifier_name,
      priceDeltaCents: m.price_delta_cents as OrderItemModifier['priceDeltaCents'],
    });
    modsByItem.set(m.order_item_id, arr);
  }

  const items: OrderSnapshot['items'] = itemRows.map((r) => ({
    id: r.id as OrderItem['id'],
    orderId: orderId as OrderItem['orderId'],
    menuItemId: r.menu_item_id as OrderItem['menuItemId'],
    comboId: r.combo_id as OrderItem['comboId'],
    parentOrderItemId: r.parent_order_item_id as OrderItem['parentOrderItemId'],
    quantity: r.quantity,
    unitPriceCents: r.unit_price_cents as OrderItem['unitPriceCents'],
    lineTotalCents: r.line_total_cents as OrderItem['lineTotalCents'],
    taxCategoryId: r.tax_category_id as OrderItem['taxCategoryId'],
    taxRateBps: r.tax_rate_bps_snapshot ?? 0,
    notes: r.notes,
    kitchenStatus: r.kitchen_status,
    // The line's own snapshot (0047), never worked out again from the category it is in today.
    noDiscount: r.no_discount === 1,
    menuItemName: r.menu_item_name,
    categoryName: r.category_name ?? '',
    prepStation: r.prep_station_snapshot,
    modifiers: modsByItem.get(r.id) ?? [],
  }));

  const paymentRows = db
    .prepare(
      `SELECT id, order_id, method, amount_cents, tendered_cents, reference_no,
              received_by_user_id, paid_at, deleted_at
         FROM payments WHERE order_id = ?${withDeleted ? '' : ' AND deleted_at IS NULL'} ORDER BY paid_at`,
    )
    .all(orderId) as Array<{
    id: string;
    method: PaymentMethod;
    amount_cents: number;
    tendered_cents: number | null;
    reference_no: string | null;
    received_by_user_id: string;
    paid_at: string;
    deleted_at: string | null;
  }>;

  const payments: Payment[] = paymentRows.map((p) => ({
    id: p.id as Payment['id'],
    orderId: orderId as Payment['orderId'],
    method: p.method,
    amountCents: p.amount_cents as Payment['amountCents'],
    tenderedCents: p.tendered_cents as Payment['tenderedCents'],
    referenceNo: p.reference_no,
    receivedByUserId: p.received_by_user_id as Payment['receivedByUserId'],
    paidAt: p.paid_at,
    ...(p.deleted_at ? { deletedAt: p.deleted_at } : {}),
  }));

  const discountRows = db
    .prepare(
      `SELECT id, order_id, discount_type, value, reason, applied_by_user_id,
              approved_by_user_id, amount_cents, source, rule_json
         FROM order_discounts WHERE order_id = ? AND deleted_at IS NULL
        ORDER BY created_at, id`,
    )
    .all(orderId) as Array<{
    id: string;
    discount_type: 'percent' | 'flat';
    value: number;
    reason: string | null;
    applied_by_user_id: string;
    approved_by_user_id: string | null;
    amount_cents: number;
    source: string | null;
    rule_json: string | null;
  }>;

  const discounts: OrderSnapshot['discounts'] = discountRows.map((d, i) => {
    // Which lines it came off: whether it also came off the delivery charge
    // (none = yes, as every discount before 0.7.26) and whether it left the
    // value deals alone (none = no, as every discount before 0.7.34), from
    // the rule FROZEN on the row, with each line's own never-discounted mark.
    // The FBR mapper, the receipt and the screens read both from here, never
    // from the setting or the category a line is in today. The order's
    // discount (its newest row, the one its totals are worked from) is read
    // against the STORED bill: one a till older than the rule re-worked over
    // more lines reads that way, so the invoice, the debit note and the words
    // add up to what was stored. Read by the row's own terms first (its type
    // and value, the deal's or the offer's frozen terms: the amount each
    // scope gives), then the tax — one tax rate can't tell the splits apart.
    const frozen = discountRuleScope(d.rule_json);
    const { alsoOffDeliveryCharge, skipsNoDiscountLines } =
      i === discountRows.length - 1
        ? storedDiscountScope(frozen, items, order.discountCents, order.taxCents, {
            discountType: d.discount_type,
            value: d.value,
            source: d.source,
            ruleJson: d.rule_json,
          })
        : frozen;
    // The foodpanda deal's figures on this order, from its frozen terms and
    // the lines it was worked on (the food, when it left the delivery charge
    // alone; else the stored subtotal): the whole deal, and foodpanda's part
    // (the bill says "foodpanda pays another Rs …" when it is shared).
    const rule = d.source === 'foodpanda' ? parseFoodpandaDealRule(d.rule_json) : null;
    const dealBase = rule
      ? alsoOffDeliveryCharge
        ? order.subtotalCents
        : discountBaseCents(items, { alsoOffDeliveryCharge: false, skipsNoDiscountLines: false })
      : 0;
    const share = rule ? dealAmount(rule, dealBase) : null;
    // An automatic offer: its name and frozen terms (the cart, Pay and the bill say it).
    const offer = d.source === 'offer' ? parseOfferRule(d.rule_json) : null;
    return {
      id: d.id as OrderSnapshot['discounts'][number]['id'],
      orderId: orderId as OrderSnapshot['discounts'][number]['orderId'],
      discountType: d.discount_type,
      value: d.value,
      reason: d.reason,
      appliedByUserId: d.applied_by_user_id as OrderSnapshot['discounts'][number]['appliedByUserId'],
      approvedByUserId: (d.approved_by_user_id ?? null) as OrderSnapshot['discounts'][number]['approvedByUserId'],
      amountCents: d.amount_cents as OrderSnapshot['discounts'][number]['amountCents'],
      source: d.source === 'foodpanda' ? 'foodpanda' : d.source === 'offer' ? 'offer' : null,
      foodpanda:
        rule && share
          ? {
              dealPercent: rule.dealPercent,
              shopPercent: rule.shopPercent,
              dealCents: share.dealCents,
              platformCents: share.platformCents,
              // At till prices, like the food it is compared with.
              minOrderCents: dealMinTillCents(rule),
              baseCents: dealBase,
            }
          : null,
      ...(offer
        ? {
            offer: {
              id: offer.offer.id,
              name: offer.offer.name,
              type: offer.offer.type,
              value: offer.offer.value,
              minOrderCents: offer.offer.minOrderCents,
              maxOffCents: offer.offer.maxOffCents,
              declined: offer.offer.declined === true,
            },
          }
        : {}),
      alsoOffDeliveryCharge,
      skipsNoDiscountLines,
    };
  });

  const cashier = db
    .prepare(`SELECT full_name FROM users WHERE id = ?`)
    .get(order.cashierId) as { full_name: string } | undefined;
  const tableRow = order.tableId
    ? (db.prepare(`SELECT label FROM tables WHERE id = ?`).get(order.tableId) as
        | { label: string }
        | undefined)
    : undefined;

  // Resolve delivery address from the snapshotted JSON if present.
  let deliveryAddress: string | null = null;
  if (orderRow.delivery_address_snapshot) {
    try {
      const a = JSON.parse(orderRow.delivery_address_snapshot) as {
        label?: string;
        addressLine?: string;
        area?: string | null;
        city?: string | null;
        notes?: string | null;
      };
      const parts = [a.addressLine, a.area, a.city].filter(Boolean);
      deliveryAddress = parts.join(', ');
    } catch {
      deliveryAddress = null;
    }
  }

  // Resolve assigned rider (if any). We join soft-deleted riders too because
  // an order assigned to a now-deactivated rider should still show who's
  // holding it.
  let rider: OrderSnapshot['rider'] = null;
  if (orderRow.assigned_rider_id) {
    const r = db
      .prepare(`SELECT id, name, phone FROM riders WHERE id = ?`)
      .get(orderRow.assigned_rider_id) as
      | { id: string; name: string; phone: string }
      | undefined;
    if (r) {
      rider = { id: r.id as UUID, name: r.name, phone: r.phone };
    }
  }

  // What the drawer paid an outside rider for this order (0049): only on an
  // order that has such a payout, or that went out with one (null until it
  // is paid), so every other snapshot reads exactly as before.
  const riderPayout = deliveryChargeToRiderOf(db, orderId);

  return {
    order,
    items,
    discounts,
    payments,
    cashierName: cashier?.full_name ?? 'Unknown',
    tableLabel: tableRow?.label ?? null,
    customerName: orderRow.customer_name_snapshot,
    customerPhone: orderRow.customer_phone_snapshot,
    deliveryAddress,
    // The counter's "Order notes" box: printed and shown with the order's
    // own note (orderNotesOf), not left in the row unread.
    deliveryNotes: orderRow.delivery_notes?.trim() || null,
    rider,
    ...(riderPayout
      ? { deliveryChargeToRider: riderPayout }
      : isOutsideRiderOrder(order)
        ? { deliveryChargeToRider: null }
        : {}),
  };
}

// -----------------------------------------------------------------------------
// Live order tracking — status transitions for the Live Orders board.
//
// State machine (legal transitions enforced here, in addition to UI):
//   open                     → sent_to_kitchen (sendOrderToKitchen; or tenderOrder,
//                              which pays and sends in one step). Stock leaves here.
//   sent_to_kitchen          → preparing | ready | out_for_delivery (a rider pre-assigned)
//   preparing                → ready | out_for_delivery
//   ready                    → out_for_delivery (delivery)  | served / paid (takeaway, dine-in)
//   out_for_delivery         → ready (rider un-assigned) | delivered / paid (markOrderDelivered)
//                              An outside rider who pays the shop while out
//                              (takeRiderPayment) leaves it out_for_delivery
//                              with paid_at set; Delivered then closes it.
//   served / delivered       → paid (markOrderServed / markOrderDelivered with a payment)
//   unpaid, not void         → void (voidOrder); paid → refunded (refundOrder).
//                              Either way the stock it holds is settled
//                              ("Was the food made?", order-stock-repo.ts).
//
// Nothing moves an order forward from 'open' but sending it: preparing, ready
// or a rider straight from a draft skipped the stock (found 2026-09-26).
//
// Each transition uses writeWithSync so sync + audit get the change.
// -----------------------------------------------------------------------------

// 'open' is deliberately absent: an open order is a checkout draft still being
// built at the till (web orders are committed with sendOrderToKitchen at
// import). Drafts are not kitchen work and must not appear on the board.
const ACTIVE_STATUSES: OrderStatus[] = [
  'sent_to_kitchen',
  'preparing',
  'ready',
  'out_for_delivery',
];

/**
 * Active orders for the Live Orders board: anything that isn't done, voided,
 * or refunded, the one sent longest ago first (ORDER_CLOCK_SQL: started,
 * for an order from before 0.7.34). Returned as full snapshots so the UI
 * doesn't need a second round-trip per card.
 */
export function listActiveOrders(
  db: AppDatabase,
  opts?: { mode?: OrderMode },
): OrderSnapshot[] {
  const conditions: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  conditions.push(`status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`);
  params.push(...ACTIVE_STATUSES);
  if (opts?.mode) {
    conditions.push('mode = ?');
    params.push(opts.mode);
  }
  const rows = db
    .prepare(
      `SELECT id FROM orders WHERE ${conditions.join(' AND ')}
        ORDER BY ${ORDER_CLOCK_SQL} ASC, created_at ASC LIMIT 200`,
    )
    .all(...params) as Array<{ id: string }>;
  // Reuse getOrderSnapshot so the rider join + delivery address logic is
  // identical to single-order reads.
  const snaps: OrderSnapshot[] = [];
  for (const r of rows) {
    const s = getOrderSnapshot(db, r.id);
    if (s) snaps.push(s);
  }
  return snaps;
}

function setOrderStatus(
  db: AppDatabase,
  orderId: string,
  next: OrderStatus,
  legalFrom: OrderStatus[],
  extraSet: { col: string; value: string | number | null }[],
  actor: Actor & { userId: string },
  action: string,
): Order {
  let result!: Order;
  const tx = db.transaction(() => {
    const order = findOrder(db, orderId);
    if (!order) throw new Error('Order not found');
    if (!legalFrom.includes(order.status)) {
      throw new Error(`This order is ${said(order.status)} — it can't be marked ${said(next)} from there`);
    }
    const now = nowIso();
    const setParts = ['status = ?', 'updated_at = ?', 'version = version + 1'];
    const setParams: unknown[] = [next, now];
    for (const e of extraSet) {
      setParts.push(`${e.col} = ?`);
      setParams.push(e.value);
    }
    // The first time the order leaves 'open' (Send to kitchen, a website
    // order's import) is when it was sent (0048): stamped once, never moved
    // by a second Send or any later status.
    if (order.status === 'open' && next !== 'open') {
      setParts.push('sent_at = COALESCE(sent_at, ?)');
      setParams.push(now);
    }
    // Race-safe UPDATE: gate on the *current* status matching one of the
    // legalFrom values. If two dispatchers click the same action within ms,
    // the first wins and the second gets changes === 0 — we surface that as
    // a precondition error and skip the audit/sync writes that would
    // otherwise double-emit.
    const placeholders = legalFrom.map(() => '?').join(',');
    const upd = db
      .prepare(
        `UPDATE orders SET ${setParts.join(', ')}
          WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(...setParams, orderId, ...legalFrom);
    if (upd.changes === 0) {
      throw new Error(
        `Order changed state before this action could complete. Refresh and try again.`,
      );
    }
    // Re-read for the after-image (includes any column we set).
    const after = findOrder(db, orderId)!;
    enqueueSync(db, {
      entityType: 'orders',
      entityId: orderId,
      op: 'upsert',
      payload: after,
    });
    writeAudit(db, {
      entityType: 'orders',
      entityId: orderId,
      action,
      actorUserId: actor.userId,
      before: order,
      after,
    });
    result = after;
  });
  tx();
  return result;
}

/**
 * Cashier in Checkout clicks "Send to kitchen" — commits the order without
 * tendering. Used primarily for delivery/COD where payment happens on
 * delivery. Moves status `open` → `sent_to_kitchen`. The order then appears
 * on the Live Orders board for the kitchen + dispatcher to drive forward.
 */
export function sendOrderToKitchen(
  db: AppDatabase,
  orderId: string,
  actor: Actor & { userId: string },
): Order {
  // A foodpanda order is recorded as paid and sent in one step. Sent unpaid (F2)
  // it reached Ready with only a 'Served' button, closed as served-unpaid and
  // left the board: no sale, no FBR invoice, no stock taken (audit 2026-09-25).
  const order = findOrder(db, orderId);
  if (order && order.mode === 'foodpanda' && order.paidAt === null) {
    throw new Error('Foodpanda orders are paid and sent in one step — use Pay (F1)');
  }
  const sent = setOrderStatus(
    db,
    orderId,
    'sent_to_kitchen',
    ['open', 'sent_to_kitchen'], // idempotent — re-sending is a no-op transition
    [],
    actor,
    'send_to_kitchen',
  );
  // The kitchen is about to use the ingredients: take them off stock now, not
  // at payment. Unpaid orders (cash on delivery, served then paid later, web
  // orders) used to take nothing until the money came in, and a served-unpaid
  // order never did. Idempotent; a failure never blocks the order.
  try {
    decrementForOrder(db, orderId, actor);
  } catch (e) {
    log.warn('Stock decrement on send failed (order not affected)', { orderId, error: String(e) });
  }
  return sent;
}

export function markOrderPreparing(
  db: AppDatabase,
  orderId: string,
  actor: Actor & { userId: string },
): Order {
  return setOrderStatus(
    db,
    orderId,
    'preparing',
    ['sent_to_kitchen'],
    [],
    actor,
    'mark_preparing',
  );
}

export function markOrderReady(
  db: AppDatabase,
  orderId: string,
  actor: Actor & { userId: string },
): Order {
  return setOrderStatus(
    db,
    orderId,
    'ready',
    ['sent_to_kitchen', 'preparing'],
    [],
    actor,
    'mark_ready',
  );
}

/**
 * Send out (the owner, 2 Oct 2026: "Ready delivery -> Send out"; "Third-party
 * rider keeps the delivery charge: the drawer expects the food total from the
 * rider"): a delivery order the kitchen has goes out with an outside rider.
 * Moves it to `out_for_delivery` with no rider named, stamps `dispatched_at`
 * and freezes what the rider keeps (orders.rider_keeps_cents, 0049): the
 * order's delivery-charge lines as sold, before tax, never more than the
 * total (deliveryChargeLinesCents; 0 with no charge line). Everything after
 * reads the frozen value, never the lines again. Allowed from the kitchen's
 * states (`sent_to_kitchen`, `preparing`, `ready`) on a delivery only: never
 * a takeaway or a foodpanda order, never a cart that was not sent (it would
 * skip the stock), never twice. No money moves here.
 *
 * One transaction: the order is read, the charge worked out from its lines
 * and the status moved together, so a line can't change in between (a sent
 * order's lines are locked anyway: addOrderItem and the discounts refuse
 * anything past 'open'). One sync row (the image carries riderKeepsCents) and
 * one audit row 'send_out'.
 *
 * An order the customer already paid the shop for (prepaid at the counter;
 * the owner's Q2, 2 Oct 2026: "pay the rider's fee AT SEND OUT, drawer
 * opens"): the drawer pays the rider what he keeps, in this same transaction
 * (settleOutsideRider with no payment): one payout linked to the order and
 * one drawer 'payout' row for it. Only while a shift is open on this till —
 * with none it is refused in its own words and nothing is written. Nothing
 * is paid out when he keeps 0. Returns the order with that drawer row's id
 * (the caller opens the drawer after the commit), null when no money moved.
 */
export function sendOutOrder(
  db: AppDatabase,
  orderId: string,
  actor: Actor & { userId: string },
): OrderWithDrawer {
  let result!: OrderWithDrawer;
  const from: OrderStatus[] = ['sent_to_kitchen', 'preparing', 'ready'];
  const tx = db.transaction(() => {
    const order = findOrder(db, orderId);
    if (!order) throw new Error('Order not found');
    if (order.mode !== 'delivery') throw new Error('Only delivery orders can be sent out');
    if (order.status === 'out_for_delivery') throw new Error('This order is already out for delivery');
    const snapshot = getOrderSnapshot(db, orderId);
    if (!snapshot) throw new Error('Order not found');
    // What the rider keeps: the charge as sold (Rs 200, not Rs 230: the
    // owner's Q1, the charge keeps its 15% tax, and that tax is in the FOOD
    // TOTAL he hands over), and never more than the customer pays.
    const keeps = Math.min(deliveryChargeLinesCents(snapshot), order.totalCents);
    // Prepaid: the drawer pays his fee now, so a shift must be open here.
    // Checked before anything is written; an order Send out can't take at
    // all (cancelled, refunded, closed) gets setOrderStatus's own words.
    const prepaid = order.paidAt !== null;
    if (prepaid && keeps > 0 && from.includes(order.status) && getCurrentShift(db, actor.deviceId) === null) {
      throw new Error(`No shift is open on this till — open a shift to give the rider his ${formatCents(keeps)} delivery charge`);
    }
    const sent = setOrderStatus(
      db,
      orderId,
      'out_for_delivery',
      from,
      [
        { col: 'assigned_rider_id', value: null },
        { col: 'dispatched_at', value: nowIso() },
        { col: 'rider_keeps_cents', value: keeps },
      ],
      actor,
      'send_out',
    );
    // settleOutsideRider reads the frozen keep from the order as it is now.
    const drawerOpenId = prepaid ? settleOutsideRider(db, sent, null, actor) : null;
    result = { ...sent, drawerOpenId };
  });
  tx();
  return result;
}

/**
 * Assign one of the shop's own riders to a delivery order (owner, 2 Oct 2026,
 * Q3: he brings back the full bill). Moves the status to `out_for_delivery`
 * and stamps `dispatched_at`. Allowed from `ready` (the usual path), but also
 * from earlier kitchen states if the dispatcher wants to pre-assign — never
 * from a draft that was not sent (it would skip the stock).
 *
 * It clears what an outside rider would keep (rider_keeps_cents): the order
 * is now an own rider's. On an order already sent out (out for delivery, no
 * rider named) it keeps `dispatched_at`: the food left when it was sent out.
 * From Ready, or from one own rider to another, exactly as v0.7.33 did.
 * Refused once the outside rider's money is settled (RIDER_MONEY_SETTLED).
 */
export function assignRiderToOrder(
  db: AppDatabase,
  orderId: string,
  riderId: string,
  actor: Actor & { userId: string },
): Order {
  let result!: Order;
  const tx = db.transaction(() => {
    // Verify the rider exists + is active.
    const rider = db
      .prepare(
        `SELECT id, is_active FROM riders WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(riderId) as { id: string; is_active: number } | undefined;
    if (!rider) throw new Error('Rider not found');
    if (rider.is_active !== 1) throw new Error('Rider is inactive');

    const order = findOrder(db, orderId);
    if (!order) throw new Error('Order not found');
    if (order.mode !== 'delivery') {
      throw new Error('Only delivery orders can be assigned to a rider');
    }
    if (outsideRiderMoneySettled(db, order)) throw new Error(RIDER_MONEY_SETTLED);
    const alreadySentOut =
      order.status === 'out_for_delivery' && order.assignedRiderId === null && order.dispatchedAt !== null;
    result = setOrderStatus(
      db,
      orderId,
      'out_for_delivery',
      ['sent_to_kitchen', 'preparing', 'ready', 'out_for_delivery'],
      [
        { col: 'assigned_rider_id', value: riderId },
        ...(alreadySentOut ? [] : [{ col: 'dispatched_at', value: nowIso() }]),
        { col: 'rider_keeps_cents', value: null },
      ],
      actor,
      'assign_rider',
    );
  });
  tx();
  return result;
}

/**
 * Back to Ready: take an order that is out for delivery off its rider
 * (mistakes happen), or bring back one that was sent out with an outside
 * rider who has not left. Reverts to `ready` with no rider and nothing kept
 * (rider_keeps_cents NULL), so it can be sent out or assigned again. Audited
 * 'undo_send_out' when no rider was named (it was sent out), 'unassign_rider'
 * otherwise, as before. Does not clear `dispatched_at` — that's a historical
 * fact even if it gets re-set. Refused once the outside rider's money is
 * settled (RIDER_MONEY_SETTLED).
 */
export function unassignRiderFromOrder(
  db: AppDatabase,
  orderId: string,
  actor: Actor & { userId: string },
): Order {
  let result!: Order;
  const tx = db.transaction(() => {
    const order = findOrder(db, orderId);
    if (!order) throw new Error('Order not found');
    if (outsideRiderMoneySettled(db, order)) throw new Error(RIDER_MONEY_SETTLED);
    if (order.status !== 'out_for_delivery') {
      throw new Error('Only out-for-delivery orders can be taken off a rider or brought back');
    }
    result = setOrderStatus(
      db,
      orderId,
      'ready',
      ['out_for_delivery'],
      [
        { col: 'assigned_rider_id', value: null },
        { col: 'rider_keeps_cents', value: null },
      ],
      actor,
      order.assignedRiderId === null ? 'undo_send_out' : 'unassign_rider',
    );
  });
  tx();
  return result;
}

/**
 * Mark a takeaway or dine-in order served (i.e. handed to the customer).
 * Optional payment param mirrors `markOrderDelivered` — for takeaway COD
 * we capture cash + close the order in one step.
 *
 *  takeaway / dine_in:
 *    ready                → served    (no payment)
 *    ready                → paid      (with payment, COD-at-pickup)
 *    served               → paid      (split flow: served first, paid later)
 *
 * Delivery uses `markOrderDelivered` instead — that path also sets
 * `delivered_at` and gates on `out_for_delivery`.
 */
export function markOrderServed(
  db: AppDatabase,
  input: {
    orderId: string;
    payment?: {
      method: PaymentMethod;
      amountCents: number;
      tenderedCents?: number | null;
      referenceNo?: string | null;
    };
  },
  actor: Actor & { userId: string },
): OrderWithDrawer {
  let result!: OrderWithDrawer;
  const tx = db.transaction(() => {
    const order = findOrder(db, input.orderId);
    if (!order) throw new Error('Order not found');
    if (order.mode === 'delivery') {
      throw new Error(
        'Use markOrderDelivered for delivery orders (it stamps delivered_at + handles rider state).',
      );
    }
    if (order.status !== 'ready' && order.status !== 'served') {
      throw new Error(`This order is ${said(order.status)} — it can't be marked served`);
    }
    // Prepaid (tendered at the till): handing it over closes the order. A
    // second payment must not be recorded against it.
    const alreadyPaid = order.paidAt !== null;
    if (alreadyPaid && input.payment) throw new Error('Order is already paid');

    const now = nowIso();
    const shiftId = input.payment ? shiftForPayment(db, actor.deviceId) : null;
    let finalStatus: OrderStatus = alreadyPaid ? 'paid' : 'served';

    if (input.payment) {
      const p = input.payment;
      assertMethodFitsOrder(order.mode, p.method);
      if (p.amountCents <= 0) throw new Error('Payment amount must be positive');
      if (p.amountCents !== order.totalCents) {
        throw new Error(
          `Payment (Rs ${p.amountCents / 100}) must equal the total (Rs ${
            order.totalCents / 100
          })`,
        );
      }
      if (p.method === 'cash' && p.tenderedCents != null && p.tenderedCents < p.amountCents) {
        throw new Error('Cash tendered cannot be less than the cash amount');
      }
      const pid = uuidv7();
      db.prepare(
        `INSERT INTO payments
           (id, order_id, method, amount_cents, tendered_cents, reference_no,
            received_by_user_id, paid_at, created_at, updated_at, device_id, version, shift_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      ).run(
        pid,
        input.orderId,
        p.method,
        p.amountCents,
        p.tenderedCents ?? null,
        p.referenceNo ?? null,
        actor.userId,
        now,
        now,
        now,
        actor.deviceId,
        shiftId,
      );
      enqueuePaymentSyncAndAudit(db, {
        entityType: 'payments',
        entityId: pid,
        op: 'upsert',
        payload: {
          id: pid,
          orderId: input.orderId,
          ...p,
          paidAt: now,
          receivedByUserId: actor.userId,
        },
      }, actor.userId);
      finalStatus = 'paid';
    }

    db.prepare(
      `UPDATE orders SET status = ?,
                          ${input.payment ? 'paid_at = ?,' : ''}
                          updated_at = ?, version = version + 1
        WHERE id = ?`,
    ).run(
      ...(input.payment
        ? [finalStatus, now, now, input.orderId]
        : [finalStatus, now, input.orderId]),
    );

    const after = findOrder(db, input.orderId)!;
    enqueueSync(db, {
      entityType: 'orders',
      entityId: input.orderId,
      op: 'upsert',
      payload: after,
    });
    writeAudit(db, {
      entityType: 'orders',
      entityId: input.orderId,
      action: input.payment ? 'mark_served_with_payment' : 'mark_served',
      actorUserId: actor.userId,
      before: order,
      after,
    });
    // Cash collected at the table / counter: a cash sale's drawer open.
    const drawerOpenId = input.payment ? recordCashSale(db, input.orderId, [input.payment], actor) : null;
    result = { ...after, drawerOpenId };
  });
  tx();
  log.info('Order served', { id: input.orderId, withPayment: !!input.payment });
  return result;
}

// -----------------------------------------------------------------------------
// An outside rider's money (migration 0049; the owner, 2 Oct 2026: "Third-party
// rider keeps the delivery charge: the drawer expects the food total from the
// rider"; "some pay in advance some dont" -> ask at Send out; Q4: a rider who
// pays by EasyPaisa / JazzCash sends the FOOD TOTAL and keeps his fee from the
// customer's cash).
//
// The sale stays the full total: the payments add up to it, so Reports, the
// refunds and FBR read it as before. What the rider keeps (the order's frozen
// rider_keeps_cents) is a cash payout linked to the order, written in the same
// transaction as the money, and each event writes exactly one drawer row (or
// none, when no cash reaches the drawer), so the shift's expected cash is what
// the rider really hands in.
// -----------------------------------------------------------------------------

/** The outside rider pays the shop in cash or by wallet — never by card (the words the screens show). */
export const OUTSIDE_RIDER_NO_CARD = "An outside rider can't take a card: choose Cash, EasyPaisa or JazzCash.";

/**
 * The window's riderKeepsCents is not what the order says now (the other
 * till sent it out again, assigned one of the shop's own riders, or brought
 * it back): what the rider hands in may have changed, so nothing is taken.
 */
export const RIDER_WINDOW_CHANGED = 'This order changed since this window opened — close it and open the order again.';

/** How shift-repo's recordDeliveryChargeToRider words a wasted trip's payout (its 'kept' one says "Delivery charge kept…"). */
const TRIP_PAYOUT_REASON_START = 'Trip paid to the outside rider';

/** The oldest live payout to an outside rider for this order (cash_movements.order_id, idx_cash_movements_order). */
function liveRiderPayout(
  db: AppDatabase,
  orderId: string,
): { id: string; amount_cents: number; created_at: string; reason: string | null } | null {
  const row = db
    .prepare(
      `SELECT id, amount_cents, created_at, reason FROM cash_movements
        WHERE order_id = ? AND type = 'payout' AND deleted_at IS NULL
        ORDER BY created_at, id LIMIT 1`,
    )
    .get(orderId) as { id: string; amount_cents: number; created_at: string; reason: string | null } | undefined;
  return row ?? null;
}

/** Assign rider and Back to Ready, once the outside rider's money is settled (the words the screens show). */
export const RIDER_MONEY_SETTLED =
  "Money has already been settled with the outside rider for this order — its rider can't be changed now.";

/**
 * The outside rider's money for this order is settled: the drawer paid him
 * (a live payout linked to the order: a prepaid order sent out, Rider paid,
 * Delivered + Pay, a wasted trip), or he paid the shop for it after it left
 * (paid_at at or after dispatched_at; any status, a closed order included).
 * Changing its rider then would leave that money wrong, so Assign rider and
 * Back to Ready refuse (RIDER_MONEY_SETTLED).
 */
function outsideRiderMoneySettled(db: AppDatabase, order: Order): boolean {
  if (liveRiderPayout(db, order.id) !== null) return true;
  if (!isOutsideRiderOrder(order) || !order.paidAt || !order.dispatchedAt) return false;
  const paid = Date.parse(order.paidAt);
  const left = Date.parse(order.dispatchedAt);
  return Number.isFinite(paid) && Number.isFinite(left) && paid >= left;
}

/**
 * OrderSnapshot.deliveryChargeToRider: the live payout to the outside rider
 * for this order, or null. Kept or trip is read from its reason (the row has
 * no column for it, and the reason travels to the other till with the row).
 */
function deliveryChargeToRiderOf(db: AppDatabase, orderId: string): NonNullable<OrderSnapshot['deliveryChargeToRider']> | null {
  const p = liveRiderPayout(db, orderId);
  if (!p) return null;
  return {
    amountCents: Number(p.amount_cents) as Order['totalCents'],
    at: p.created_at,
    why: (p.reason ?? '').startsWith(TRIP_PAYOUT_REASON_START) ? 'trip' : 'kept',
  };
}

/** How the outside rider settles: Cash, EasyPaisa or JazzCash (Card is refused); null = the customer paid the shop before. */
interface OutsideRiderPay {
  method: PaymentMethod;
  referenceNo?: string | null;
}

/** One payment leg of a rider's settlement: row + sync + audit, like every payment (tendered_cents NULL). */
function insertRiderPayment(
  db: AppDatabase,
  orderId: string,
  leg: { method: PaymentMethod; amountCents: number; referenceNo: string | null },
  shiftId: string,
  now: string,
  actor: Actor & { userId: string },
): void {
  const pid = uuidv7();
  db.prepare(
    `INSERT INTO payments
       (id, order_id, method, amount_cents, tendered_cents, reference_no,
        received_by_user_id, paid_at, created_at, updated_at, device_id, version, shift_id)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(pid, orderId, leg.method, leg.amountCents, leg.referenceNo, actor.userId, now, now, now, actor.deviceId, shiftId);
  enqueuePaymentSyncAndAudit(db, {
    entityType: 'payments',
    entityId: pid,
    op: 'upsert',
    payload: {
      id: pid,
      orderId,
      method: leg.method,
      amountCents: leg.amountCents,
      tenderedCents: null,
      referenceNo: leg.referenceNo,
      paidAt: now,
      receivedByUserId: actor.userId,
    },
  }, actor.userId);
}

/**
 * Settle an order sent out with an outside rider, INSIDE the caller's
 * transaction (Rider paid, Delivered + Pay; a prepaid order at Send out, step
 * 18-3). keep = the order's frozen riderKeepsCents. The payout of `keep` to
 * the rider is written once (recordDeliveryChargeToRider, why 'kept'):
 * skipped when keep is 0 or a live payout for this order already exists.
 *  - cash: ONE payment of the total (tendered_cents NULL: the dialog works out
 *    the rider's change itself) and ONE drawer 'sale' row for what he hands
 *    in, total − keep, pointing at the payout, reason 'Rider kept Rs 200
 *    delivery charge' (none when he keeps nothing);
 *  - easypaisa / jazzcash: he sends the FOOD TOTAL and keeps his fee from the
 *    customer's cash (owner Q4): the wallet for total − keep and cash for
 *    keep (only when he keeps something); NO drawer row — no cash comes in;
 *  - null (the customer paid the shop before): no payment; the drawer pays
 *    his fee: one drawer 'payout' row −keep for the payout written now;
 *  - card, or anything else: refused (OUTSIDE_RIDER_NO_CARD).
 * Money only changes hands while a shift is open on this till
 * (shiftForPayment's refusal). Returns the drawer row's id (its pulse), or
 * null when no drawer row was written.
 */
function settleOutsideRider(
  db: AppDatabase,
  order: Order,
  pay: OutsideRiderPay | null,
  actor: Actor & { userId: string },
  now: string = nowIso(),
): string | null {
  const keep = order.riderKeepsCents;
  if (typeof keep !== 'number' || !Number.isInteger(keep) || keep < 0) {
    throw new Error('This order did not go out with an outside rider');
  }
  if (pay && pay.method !== 'cash' && pay.method !== 'easypaisa' && pay.method !== 'jazzcash') {
    throw new Error(OUTSIDE_RIDER_NO_CARD);
  }
  const total = order.totalCents as number;
  const handedIn = total - keep;

  if (pay) {
    const shiftId = shiftForPayment(db, actor.deviceId);
    if (pay.method === 'cash') {
      if (total > 0) insertRiderPayment(db, order.id, { method: 'cash', amountCents: total, referenceNo: null }, shiftId, now, actor);
    } else {
      const referenceNo = pay.referenceNo?.trim() || null;
      if (handedIn > 0) insertRiderPayment(db, order.id, { method: pay.method, amountCents: handedIn, referenceNo }, shiftId, now, actor);
      if (keep > 0) insertRiderPayment(db, order.id, { method: 'cash', amountCents: keep, referenceNo: null }, shiftId, now, actor);
    }
  }

  // His fee, once per order.
  const payoutId =
    keep > 0 && liveRiderPayout(db, order.id) === null
      ? recordDeliveryChargeToRider(db, { orderId: order.id, orderNumber: order.orderNumber, amountCents: keep, why: 'kept' }, actor)
      : null;

  if (pay === null) {
    // The customer paid the shop before: the drawer opens to pay his fee.
    if (payoutId === null) return null;
    return recordDrawerOpen(
      db,
      {
        kind: 'payout',
        reason: findCashMovement(db, payoutId)?.reason ?? null,
        orderId: order.id,
        cashMovementId: payoutId,
        amountCents: -keep,
      },
      actor,
    ).id;
  }
  if (pay.method !== 'cash' || handedIn <= 0) return null;
  return recordDrawerOpen(
    db,
    {
      kind: 'sale',
      reason: keep > 0 ? `Rider kept ${formatCents(keep)} delivery charge` : null,
      orderId: order.id,
      cashMovementId: payoutId,
      amountCents: handedIn,
    },
    actor,
  ).id;
}

export interface TakeRiderPaymentInput {
  orderId: string;
  /** Cash, EasyPaisa or JazzCash (a card is refused). */
  method: PaymentMethod;
  /** The wallet's transaction number, when there is one. */
  referenceNo?: string | null;
  /** What the window showed the rider keeps: it must still be the order's frozen riderKeepsCents. */
  riderKeepsCents: number;
}

/**
 * Rider paid (Send out's "Has the rider paid the shop?" -> Paid now; the
 * owner's shortage report of 2 Oct 2026: riders who pay in advance hand over
 * the bill less their fee): the outside rider pays the shop while he is
 * still out. Only for an order out for delivery with an outside rider, not
 * paid yet, with a shift open on this till, and only while the order still
 * keeps what the window showed (else RIDER_WINDOW_CHANGED; an order now with
 * one of the shop's own riders keeps nothing, so it is refused the same way).
 * Settles (settleOutsideRider) and stamps paid_at — never before it left, so
 * the paper reads it as paid while out (riderSettledWhileOut) — and leaves the
 * status out for delivery: the customer still pays the rider at the door,
 * and Delivered closes it with no payment and no second payout. One
 * transaction; the order's sync row and audit 'rider_paid'. Returns the
 * order with its drawer row (null when no cash came in).
 */
export function takeRiderPayment(
  db: AppDatabase,
  input: TakeRiderPaymentInput,
  actor: Actor & { userId: string },
): OrderWithDrawer {
  let result!: OrderWithDrawer;
  const tx = db.transaction(() => {
    const order = findOrder(db, input.orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'out_for_delivery') {
      throw new Error(`This order is ${said(order.status)} — the rider pays the shop only while it is out for delivery`);
    }
    if (order.paidAt !== null) throw new Error('Order is already paid');
    if (!isOutsideRiderOrder(order) || input.riderKeepsCents !== order.riderKeepsCents) {
      throw new Error(RIDER_WINDOW_CHANGED);
    }
    if (!(order.totalCents > 0)) throw new Error('This order has nothing to pay');

    const now = nowIso();
    const drawerOpenId = settleOutsideRider(db, order, { method: input.method, referenceNo: input.referenceNo ?? null }, actor, now);

    // Paid while out: never stamped before the food left (a clock set back).
    const paidAt = order.dispatchedAt !== null && order.dispatchedAt > now ? order.dispatchedAt : now;
    const upd = db
      .prepare(
        `UPDATE orders SET paid_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND status = 'out_for_delivery' AND paid_at IS NULL AND rider_keeps_cents = ?
            AND deleted_at IS NULL`,
      )
      .run(paidAt, now, order.id, order.riderKeepsCents);
    if (upd.changes === 0) {
      throw new Error('Order changed state before this action could complete. Refresh and try again.');
    }
    const after = findOrder(db, order.id)!;
    enqueueSync(db, { entityType: 'orders', entityId: order.id, op: 'upsert', payload: after });
    writeAudit(db, {
      entityType: 'orders',
      entityId: order.id,
      action: 'rider_paid',
      actorUserId: actor.userId,
      before: order,
      after,
    });
    result = { ...after, drawerOpenId };
  });
  tx();
  log.info('Outside rider paid the shop', { id: input.orderId, method: input.method, total: result.totalCents });
  return result;
}

/**
 * Mark a delivery order delivered. Optionally records a COD payment in the
 * same transaction — when `payment` is provided we transition straight from
 * `out_for_delivery` (or `ready`) through `delivered` to `paid`.
 *
 * An order sent out with an outside rider (Send out, 0049) is settled the
 * outside rider's way (settleOutsideRider): `riderKeepsCents` is what the
 * window showed he keeps and must still be the order's frozen value (a
 * missing one on an outside order is a change too: RIDER_WINDOW_CHANGED).
 * One he already paid for while out (Rider paid) closes with no payment and
 * no second payout. One of the shop's own riders, a takeaway or a foodpanda
 * order goes exactly the v0.7.33 way.
 */
export function markOrderDelivered(
  db: AppDatabase,
  input: {
    orderId: string;
    payment?: {
      method: PaymentMethod;
      amountCents: number;
      tenderedCents?: number | null;
      referenceNo?: string | null;
    };
    /** What the window showed an outside rider keeps (Order.riderKeepsCents); absent for one of the shop's own riders. */
    riderKeepsCents?: number | null;
  },
  actor: Actor & { userId: string },
): OrderWithDrawer {
  let result!: OrderWithDrawer;
  const tx = db.transaction(() => {
    const order = findOrder(db, input.orderId);
    if (!order) throw new Error('Order not found');
    if (order.mode !== 'delivery') {
      throw new Error('Only delivery orders can be marked delivered');
    }
    if (
      order.status !== 'ready' &&
      order.status !== 'out_for_delivery' &&
      order.status !== 'delivered'
    ) {
      throw new Error(`This delivery is ${said(order.status)} — it can't be marked delivered`);
    }

    // Prepaid (tendered at the till): delivering it closes the order. A
    // second payment must not be recorded against it.
    const alreadyPaid = order.paidAt !== null;
    if (alreadyPaid && input.payment) throw new Error('Order is already paid');

    const now = nowIso();
    const shiftId = input.payment ? shiftForPayment(db, actor.deviceId) : null;

    // If a payment was supplied, insert it and bump to `paid`. Otherwise just
    // mark `delivered` and leave tendering for later.
    let finalStatus: OrderStatus = alreadyPaid ? 'paid' : 'delivered';
    // An outside rider's money (0049): settled his way, in this transaction.
    // A window that says he keeps something on an order that keeps nothing
    // now (one of the shop's own riders) is a change as well.
    const outside = input.payment !== undefined && (isOutsideRiderOrder(order) || typeof input.riderKeepsCents === 'number');
    let outsideDrawerOpenId: string | null = null;
    if (outside && input.payment) {
      const p = input.payment;
      if (!isOutsideRiderOrder(order) || input.riderKeepsCents !== order.riderKeepsCents) {
        throw new Error(RIDER_WINDOW_CHANGED);
      }
      if (p.amountCents <= 0) throw new Error('Payment amount must be positive');
      if (p.amountCents !== order.totalCents) {
        throw new Error(
          `COD payment (Rs ${p.amountCents / 100}) must equal the total (Rs ${
            order.totalCents / 100
          })`,
        );
      }
      outsideDrawerOpenId = settleOutsideRider(db, order, { method: p.method, referenceNo: p.referenceNo ?? null }, actor, now);
      finalStatus = 'paid';
    } else if (input.payment) {
      const p = input.payment;
      assertMethodFitsOrder(order.mode, p.method);
      if (p.amountCents <= 0) throw new Error('Payment amount must be positive');
      if (p.amountCents !== order.totalCents) {
        throw new Error(
          `COD payment (Rs ${p.amountCents / 100}) must equal the total (Rs ${
            order.totalCents / 100
          })`,
        );
      }
      if (p.method === 'cash' && p.tenderedCents != null && p.tenderedCents < p.amountCents) {
        throw new Error('Cash tendered cannot be less than the cash amount');
      }
      const pid = uuidv7();
      db.prepare(
        `INSERT INTO payments
           (id, order_id, method, amount_cents, tendered_cents, reference_no,
            received_by_user_id, paid_at, created_at, updated_at, device_id, version, shift_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      ).run(
        pid,
        input.orderId,
        p.method,
        p.amountCents,
        p.tenderedCents ?? null,
        p.referenceNo ?? null,
        actor.userId,
        now,
        now,
        now,
        actor.deviceId,
        shiftId,
      );
      enqueuePaymentSyncAndAudit(db, {
        entityType: 'payments',
        entityId: pid,
        op: 'upsert',
        payload: {
          id: pid,
          orderId: input.orderId,
          ...p,
          paidAt: now,
          receivedByUserId: actor.userId,
        },
      }, actor.userId);
      finalStatus = 'paid';
    }

    db.prepare(
      `UPDATE orders SET status = ?, delivered_at = ?,
                          ${input.payment ? 'paid_at = ?,' : ''}
                          updated_at = ?, version = version + 1
        WHERE id = ?`,
    ).run(
      ...(input.payment
        ? [finalStatus, now, now, now, input.orderId]
        : [finalStatus, now, now, input.orderId]),
    );

    const after = findOrder(db, input.orderId)!;
    enqueueSync(db, {
      entityType: 'orders',
      entityId: input.orderId,
      op: 'upsert',
      payload: after,
    });
    writeAudit(db, {
      entityType: 'orders',
      entityId: input.orderId,
      action: input.payment ? 'mark_delivered_with_payment' : 'mark_delivered',
      actorUserId: actor.userId,
      before: order,
      after,
    });
    // Cash on delivery brought back by the rider: a cash sale's drawer open
    // (an outside rider's was written when he settled).
    const drawerOpenId = outside
      ? outsideDrawerOpenId
      : input.payment
        ? recordCashSale(db, input.orderId, [input.payment], actor)
        : null;
    result = { ...after, drawerOpenId };
  });
  tx();
  log.info('Order delivered', {
    id: input.orderId,
    withPayment: !!input.payment,
  });
  return result;
}

// -----------------------------------------------------------------------------
// Deleting a test order — the owner only (migration 0043)
// -----------------------------------------------------------------------------

/** The owner's refusals, word for word (the dialog shows them as they are). */
export const TEST_DELETE_REFUSED = {
  gone: "This order is already deleted or can't be found.",
  open: 'This order is still being rung up. Use Discard at Checkout instead.',
  changed: 'This order changed while the window was open. Close it and check the order again.',
  otherTillOrder: 'This order was taken on the other till. Delete it on that till.',
  otherTillPayment: "Part of this order was paid on the other till, so it can't be deleted here. Cancel or refund it instead.",
  fbr: "This sale was sent to FBR, so it can't be deleted. Refund it instead.",
  restock: 'Choose whether to put the stock back.',
  reason: 'Write why this was a test order.',
} as const;

/** What deleting would touch, read in one place so the preview and the delete can't drift. */
export interface TestDeleteFacts {
  order: Order;
  snapshot: OrderSnapshot;
  statusBefore: OrderStatus;
  /** Live payment rows (sales and refunds). */
  payments: Array<{ id: string; method: PaymentMethod; amountCents: number; shiftId: string | null }>;
  /** Live payouts to its outside rider (cash_movements.order_id, 0049): cash that left the drawer for it. */
  payouts: Array<{ id: string; amountCents: number; shiftId: string }>;
  paid: TestDeletePreview['paid'];
  stockStatus: OrderStockStatus | null;
  stockState: TestDeleteStockState;
  cash: TestDeleteShiftCash[];
  web: boolean;
  kitchenSlip: boolean;
}

export type TestDeleteCheck = { ok: false; refusal: string; facts: TestDeleteFacts | null } | { ok: true; facts: TestDeleteFacts };

/**
 * Whether this order may be deleted as a test on this till, and what that
 * would touch. Pure read. The refusals that don't depend on what the owner
 * typed, in order: gone, still a cart, taken on the other till, paid (in
 * part) on the other till — or its outside rider paid from the other till's
 * drawer — sent to FBR in production (any status, or a paper that printed a
 * production number). Same till only: its FBR queue, website import, print
 * jobs and shift cash are all on this till. The cash per shift is net of
 * what the drawer paid its outside rider (the payouts go with the order).
 */
export function checkTestDelete(db: AppDatabase, orderId: string, deviceId: string, nowMs: number = Date.now()): TestDeleteCheck {
  const snapshot = getOrderSnapshot(db, orderId);
  if (!snapshot) return { ok: false, refusal: TEST_DELETE_REFUSED.gone, facts: null };
  const order = snapshot.order;
  const row = db.prepare(`SELECT device_id FROM orders WHERE id = ?`).get(orderId) as { device_id: string };

  const payments = (
    db
      .prepare(
        `SELECT p.id, p.method, p.amount_cents, COALESCE(p.shift_id, o.shift_id) AS shift_id, p.device_id
           FROM payments p JOIN orders o ON o.id = p.order_id
          WHERE p.order_id = ? AND p.deleted_at IS NULL
          ORDER BY p.paid_at, p.id`,
      )
      .all(orderId) as Array<{ id: string; method: PaymentMethod; amount_cents: number; shift_id: string | null; device_id: string }>
  ).map((p) => ({ id: p.id, method: p.method, amountCents: Number(p.amount_cents), shiftId: p.shift_id, deviceId: p.device_id }));

  const paidBy = new Map<PaymentMethod, number>();
  for (const p of payments) paidBy.set(p.method, (paidBy.get(p.method) ?? 0) + p.amountCents);
  const paid = [...paidBy].filter(([, n]) => n !== 0).map(([method, netCents]) => ({ method, netCents }));

  // What the drawer paid its outside rider (a kept charge or a wasted trip),
  // and on which till's shift (cash_movements.shift_id is always set).
  const payoutRows = (
    db
      .prepare(
        `SELECT m.id, m.amount_cents, m.shift_id, COALESCE(s.device_id, m.device_id) AS device_id
           FROM cash_movements m LEFT JOIN shifts s ON s.id = m.shift_id
          WHERE m.order_id = ? AND m.type = 'payout' AND m.deleted_at IS NULL
          ORDER BY m.created_at, m.id`,
      )
      .all(orderId) as Array<{ id: string; amount_cents: number; shift_id: string; device_id: string }>
  ).map((m) => ({ id: m.id, amountCents: Number(m.amount_cents), shiftId: m.shift_id, deviceId: m.device_id }));

  const cashBy = new Map<string, number>();
  for (const p of payments) {
    if (p.method !== 'cash' || !p.shiftId) continue;
    cashBy.set(p.shiftId, (cashBy.get(p.shiftId) ?? 0) + p.amountCents);
  }
  for (const m of payoutRows) cashBy.set(m.shiftId, (cashBy.get(m.shiftId) ?? 0) - m.amountCents);
  const cash: TestDeleteShiftCash[] = [...cashBy]
    .filter(([, n]) => n !== 0)
    .map(([shiftId, netCents]) => {
      const s = db.prepare(`SELECT closed_at FROM shifts WHERE id = ?`).get(shiftId) as { closed_at: string | null } | undefined;
      return { shiftId, open: s !== undefined && s.closed_at === null, netCents };
    });

  const stockStatus = order.status === 'open' ? null : getOrderStockStatus(db, orderId, deviceId, nowMs);
  const stockState: TestDeleteStockState =
    stockStatus === null || stockStatus.state === 'none'
      ? 'none'
      : stockStatus.state === 'out' || stockStatus.state === 'kept'
        ? 'holds'
        : stockStatus.state === 'wasted'
          ? 'wasted_before'
          : 'returned_before';

  const web =
    order.source === 'web' ||
    db.prepare(`SELECT 1 AS x FROM web_order_imports WHERE pos_order_id = ? LIMIT 1`).get(orderId) !== undefined;
  // The kitchen hears of it when the food had not been handed over, the order
  // was not already cancelled (that slip printed then), and a ticket printed
  // or may have (the print log), or is printing now.
  const ticket =
    db
      .prepare(`SELECT 1 AS x FROM document_prints WHERE order_id = ? AND doc_key = 'kitchen' AND copy = 'kitchen' AND deleted_at IS NULL LIMIT 1`)
      .get(orderId) !== undefined ||
    db
      .prepare(
        `SELECT 1 AS x FROM print_queue WHERE order_id = ? AND job_kind = 'kitchen' AND status = 'in_flight'
            AND COALESCE(json_extract(payload_json, '$.cancelled'), 0) = 0 LIMIT 1`,
      )
      .get(orderId) !== undefined;
  const kitchenSlip =
    ticket && order.status !== 'void' && order.status !== 'refunded' && kitchenHearsOfClose(order.status);

  const facts: TestDeleteFacts = {
    order,
    snapshot,
    statusBefore: order.status,
    payments: payments.map(({ deviceId: _d, ...p }) => p),
    payouts: payoutRows.map(({ deviceId: _d, ...m }) => m),
    paid,
    stockStatus,
    stockState,
    cash,
    web,
    kitchenSlip,
  };
  if (order.status === 'open') return { ok: false, refusal: TEST_DELETE_REFUSED.open, facts };
  if (row.device_id !== deviceId) return { ok: false, refusal: TEST_DELETE_REFUSED.otherTillOrder, facts };
  if (payments.some((p) => p.deviceId !== deviceId) || payoutRows.some((m) => m.deviceId !== deviceId)) {
    return { ok: false, refusal: TEST_DELETE_REFUSED.otherTillPayment, facts };
  }
  if (touchedFbrProduction(db, orderId)) return { ok: false, refusal: TEST_DELETE_REFUSED.fbr, facts };
  return { ok: true, facts };
}

/** What the delete dialog shows (orders:testDeletePreview). Throws the "gone" refusal for no such order. */
export function testDeletePreview(db: AppDatabase, orderId: string, deviceId: string, nowMs: number = Date.now()): TestDeletePreview {
  const check = checkTestDelete(db, orderId, deviceId, nowMs);
  const f = check.facts;
  if (!f) throw new Error(TEST_DELETE_REFUSED.gone);
  const s = f.snapshot;
  return {
    orderId,
    orderNumber: s.order.orderNumber,
    status: s.order.status,
    mode: s.order.mode,
    totalCents: s.order.totalCents,
    takenAt: s.order.createdAt,
    takenBy: s.cashierName,
    items: s.items.filter((i) => !i.parentOrderItemId).map((i) => ({ name: i.menuItemName, quantity: i.quantity })),
    paid: f.paid,
    refusal: check.ok ? null : check.refusal,
    stock: { state: f.stockState, lines: f.stockState === 'holds' ? (f.stockStatus?.lines ?? []) : [] },
    cash: f.cash,
    kitchenSlip: f.kitchenSlip,
    web: f.web,
  };
}

export interface DeleteTestOrderInput {
  orderId: string;
  reason: string;
  /** "Put the stock back?" — true yes (not made), false no (made: waste), null when it holds none. */
  restock: boolean | null;
  /** The status the dialog showed. */
  expectStatus: OrderStatus;
  /** The owner whose PIN or password confirmed it (deleted_by). */
  ownerUserId: string;
}

/**
 * Soft-delete an order's live foodpanda terms (order_channel_terms, one live
 * row per order at most), each synced as its row image and audited with the
 * row as it was, action 'delete_test_order'. Inside the caller's
 * transaction. Returns the ids deleted (none for a non-foodpanda order, or
 * one paid before the terms were kept).
 */
function softDeleteChannelTerms(db: AppDatabase, orderId: string, now: string, actorUserId: string): string[] {
  const rows = db
    .prepare(`SELECT * FROM order_channel_terms WHERE order_id = ? AND deleted_at IS NULL ORDER BY id`)
    .all(orderId) as Array<Record<string, unknown> & { id: string }>;
  for (const row of rows) {
    db.prepare(
      `UPDATE order_channel_terms SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL`,
    ).run(now, now, row.id);
    enqueueSync(db, { entityType: 'order_channel_terms', entityId: row.id, op: 'delete', payload: { id: row.id, deletedAt: now } });
    writeAudit(db, {
      entityType: 'order_channel_terms',
      entityId: row.id,
      action: 'delete_test_order',
      actorUserId,
      before: row,
      after: { deletedAt: now },
    });
  }
  return rows.map((r) => r.id);
}

/**
 * Delete a TEST order, for the owner. One transaction — or nothing:
 *  a. the checks above, then the status the dialog showed, the stock answer
 *     and the reason;
 *  b. stock: what it still holds is settled per the answer ("put it back" =
 *     not made, even after a hand-over that never really happened; "don't"
 *     = made, ALWAYS booked as waste — never left as sale rows, which would
 *     count as food sold with no money). Stock already dealt with at a cancel
 *     or refund stays as it is ('settled_before');
 *  c. every live payment (sales and refunds) soft-deleted, synced and audited;
 *     so is a foodpanda order's kept terms row (order_channel_terms), and
 *     every payout the drawer made to its outside rider (cash_movements);
 *  d. the order soft-deleted with who, why, how and what it did to stock —
 *     its status, lines, discounts, costs, papers and stock rows untouched —
 *     synced, and audited with the full order before;
 *  e. its FBR submissions still waiting (noop / sandbox) skipped.
 * A refusal throws its words and writes nothing.
 */
export function deleteTestOrder(
  db: AppDatabase,
  input: DeleteTestOrderInput,
  actor: Actor & { userId: string },
): TestDeleteResult {
  return db.transaction((): TestDeleteResult => {
    // The refusals in the owner's order: gone, still a cart, moved on since
    // the dialog read it, then the till / FBR checks, then the answers.
    const current = findOrder(db, input.orderId);
    if (!current) throw new Error(TEST_DELETE_REFUSED.gone);
    if (current.status === 'open') throw new Error(TEST_DELETE_REFUSED.open);
    if (current.status !== input.expectStatus) throw new Error(TEST_DELETE_REFUSED.changed);
    const check = checkTestDelete(db, input.orderId, actor.deviceId);
    if (!check.ok) throw new Error(check.refusal);
    const f = check.facts;
    if (f.stockState === 'holds' && typeof input.restock !== 'boolean') throw new Error(TEST_DELETE_REFUSED.restock);
    const reason = (input.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!reason) throw new Error(TEST_DELETE_REFUSED.reason);
    const before = getOrderSnapshot(db, input.orderId)!;
    const now = nowIso();

    // b. Stock
    let stock: StockSettlement | null = null;
    let deleteStock: TestDeleteStock;
    if (f.stockState === 'holds') {
      stock = settleOrderStock(
        db,
        {
          orderId: input.orderId,
          how: 'test_deleted',
          statusBefore: f.statusBefore,
          foodMade: input.restock === true ? 'not_made' : 'made',
          // One answer for everything, sealed drinks included.
          putBack: [],
          approverUserId: input.ownerUserId,
        },
        actor,
      );
      deleteStock = input.restock === true ? 'put_back' : 'waste';
    } else {
      deleteStock = f.stockState === 'none' ? 'none' : 'settled_before';
    }

    // c. Payments
    for (const p of f.payments) {
      const row = db.prepare(`SELECT * FROM payments WHERE id = ?`).get(p.id) as Record<string, unknown>;
      db.prepare(`UPDATE payments SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL`).run(
        now,
        now,
        p.id,
      );
      enqueueSync(db, { entityType: 'payments', entityId: p.id, op: 'delete', payload: { id: p.id, deletedAt: now } });
      writeAudit(db, {
        entityType: 'payments',
        entityId: p.id,
        action: 'delete_test_order',
        actorUserId: actor.userId,
        before: row,
        after: { deletedAt: now },
      });
    }

    // c2. A foodpanda order's terms kept at payment (order_channel_terms,
    // 0040): its commission and expected payout are money of their own, like
    // its payments, so they go with them — soft-deleted, synced and audited —
    // and nothing that reads the table by itself can count a test.
    const channelTermsIds = softDeleteChannelTerms(db, input.orderId, now, actor.userId);

    // c3. What the drawer paid its outside rider (0049: a kept charge, a
    // wasted trip) is money of the order too: soft-deleted, synced and
    // audited, so the shift's expected cash no longer takes it out. Its
    // drawer row stays: the drawer log has no delete.
    const cashMovementIds: string[] = [];
    for (const m of f.payouts) {
      const row = db.prepare(`SELECT * FROM cash_movements WHERE id = ?`).get(m.id) as Record<string, unknown>;
      const upd = db
        .prepare(`UPDATE cash_movements SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL`)
        .run(now, now, m.id);
      if (Number(upd.changes) === 0) continue;
      enqueueSync(db, { entityType: 'cash_movements', entityId: m.id, op: 'delete', payload: { id: m.id, deletedAt: now } });
      writeAudit(db, {
        entityType: 'cash_movements',
        entityId: m.id,
        action: 'delete_test_order',
        actorUserId: actor.userId,
        before: row,
        after: { deletedAt: now },
      });
      cashMovementIds.push(m.id);
    }

    // e. FBR (pure-local): noop / sandbox submissions still waiting are never sent.
    const fbrSkippedIds = skipFbrForOrder(db, input.orderId);

    // d. The order
    const upd = db
      .prepare(
        `UPDATE orders
            SET deleted_at = ?, deleted_by = ?, delete_reason = ?, delete_kind = 'test', delete_stock = ?,
                updated_at = ?, version = version + 1
          WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(now, input.ownerUserId, reason, deleteStock, now, input.orderId);
    if (Number(upd.changes) === 0) throw new Error(TEST_DELETE_REFUSED.gone);
    enqueueSync(db, { entityType: 'orders', entityId: input.orderId, op: 'delete', payload: { id: input.orderId, deletedAt: now } });
    writeAudit(db, {
      entityType: 'orders',
      entityId: input.orderId,
      action: 'delete_test_order',
      actorUserId: actor.userId,
      before,
      after: {
        deletedAt: now,
        deletedBy: input.ownerUserId,
        reason,
        restock: input.restock,
        statusBefore: f.statusBefore,
        deleteStock,
        cashByShift: f.cash,
        paymentIds: f.payments.map((p) => p.id),
        channelTermsIds,
        cashMovementIds,
        fbrSkippedIds,
        web: f.web,
      },
    });
    log.info('Test order deleted', { id: input.orderId, deleteStock, payments: f.payments.length });
    return {
      orderId: input.orderId,
      orderNumber: f.order.orderNumber,
      statusBefore: f.statusBefore,
      deleteStock,
      stock,
      cash: f.cash,
      kitchenSlip: f.kitchenSlip,
      web: f.web,
    };
  })();
}

/**
 * The owner's list of deleted test orders, by when the order was taken,
 * newest deletion first. Read-only; nothing here can bring one back.
 */
export function listDeletedTests(
  db: AppDatabase,
  q: { sinceIso: string; untilIso: string; limit?: number | undefined; offset?: number | undefined },
): DeletedTestsPage {
  const limit = Math.min(Math.max(Math.floor(q.limit ?? 100), 1), 500);
  const offset = Math.max(Math.floor(q.offset ?? 0), 0);
  const where = `o.deleted_at IS NOT NULL AND o.delete_kind = 'test' AND o.created_at >= ? AND o.created_at < ?`;
  const rows = db
    .prepare(
      `SELECT o.id, o.order_number, o.mode, o.status, o.total_cents, o.created_at, o.deleted_at,
              o.delete_reason, o.delete_stock,
              COALESCE(uc.full_name, 'Unknown') AS taken_by, COALESCE(ud.full_name, 'Unknown') AS deleted_by,
              (SELECT COALESCE(SUM(p.amount_cents), 0) FROM payments p WHERE p.order_id = o.id) AS paid_cents,
              (SELECT group_concat(DISTINCT p.method) FROM payments p WHERE p.order_id = o.id AND p.amount_cents > 0) AS methods,
              (SELECT COALESCE(-SUM(m.value_cents), 0) FROM stock_movements m
                WHERE m.ref_order_id = o.id AND m.reason = 'waste' AND m.deleted_at IS NULL) AS waste_cents,
              (SELECT group_concat(oi.quantity || '× ' || oi.menu_item_name, ', ') FROM order_items oi
                WHERE oi.order_id = o.id AND oi.deleted_at IS NULL AND oi.parent_order_item_id IS NULL) AS items
         FROM orders o
         LEFT JOIN users uc ON uc.id = o.cashier_id
         LEFT JOIN users ud ON ud.id = o.deleted_by
        WHERE ${where}
        ORDER BY o.deleted_at DESC, o.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(q.sinceIso, q.untilIso, limit, offset) as Array<{
    id: string;
    order_number: string;
    mode: OrderMode;
    status: OrderStatus;
    total_cents: number;
    created_at: string;
    deleted_at: string;
    delete_reason: string | null;
    delete_stock: string | null;
    taken_by: string;
    deleted_by: string;
    paid_cents: number;
    methods: string | null;
    waste_cents: number;
    items: string | null;
  }>;
  const totals = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(o.total_cents), 0) AS cents FROM orders o WHERE ${where}`)
    .get(q.sinceIso, q.untilIso) as { n: number; cents: number };
  return {
    rows: rows.map((r) => ({
      orderId: r.id,
      orderNumber: r.order_number,
      mode: r.mode,
      status: r.status,
      totalCents: Number(r.total_cents),
      takenAt: r.created_at,
      takenBy: r.taken_by,
      deletedAt: r.deleted_at,
      deletedBy: r.deleted_by,
      reason: r.delete_reason,
      paidCents: Number(r.paid_cents),
      paidMethods: (r.methods ? r.methods.split(',') : []) as PaymentMethod[],
      deleteStock: isTestDeleteStock(r.delete_stock) ? r.delete_stock : null,
      wasteCents: Number(r.waste_cents),
      itemsSummary: r.items ?? '',
    })),
    total: Number(totals.n),
    totalCents: Number(totals.cents),
  };
}
