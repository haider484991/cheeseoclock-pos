import { v5 as uuidv5, v7 as uuidv7 } from 'uuid';
import log from 'electron-log/main';
import type { AppDatabase } from '../connection.js';
import { nowIso, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import { decrementForOrder } from './stock-movement-repo.js';
import { getOrderStockStatus, settleOrderStock } from './order-stock-repo.js';
import { recordDrawerOpen } from './drawer-open-repo.js';
import { skipFbrForOrder, touchedFbrProduction } from './fbr-queue-repo.js';
import { listModifierGroupsForItem, listModifiersByGroup } from './modifier-repo.js';
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
  discountBaseCents,
  discountRuleAlsoOffDeliveryCharge,
  foodpandaDealRule,
  foodpandaTerms,
  parseFoodpandaDealRule,
  taxAfterDiscount,
  tillDiscountRule,
  validateOrderForTender,
  validateVoid,
  validateDiscountInput,
  requiresManagerApproval,
} from '@cheeseoclock/pos-domain';
import { readApprovalLimits, readDiscountAlsoOffDeliveryCharge, readShopSetting } from '../business-settings-read.js';
import { COC_ID_NAMESPACE, FOODPANDA_ORDER_CODE_MAX } from '@cheeseoclock/shared-types';
import type {
  DiscountBaseRule,
  FoodpandaTenderCheck,
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
    paidAt: row.paid_at,
    voidedAt: row.voided_at,
    voidedBy: row.voided_by as Order['voidedBy'],
    voidReason: row.void_reason,
    assignedRiderId: (row.assigned_rider_id ?? null) as Order['assignedRiderId'],
    dispatchedAt: row.dispatched_at,
    deliveredAt: row.delivered_at,
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
  deleted_at, deleted_by, delete_reason, delete_kind, delete_stock
`;

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
    };

    db.prepare(
      `INSERT INTO orders
         (id, order_number, mode, status, table_id, customer_id, cashier_id, shift_id, source,
          notes, subtotal_cents, discount_cents, tax_cents, total_cents,
          created_at, updated_at, device_id, version)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, 1)`,
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
 * Who approved the automatic foodpanda deal: the owner who last saved it
 * (business_settings.updated_by_user_id, the web pick-up pattern), or the
 * first active admin (the bridge's system actor) when that user is not on
 * this till. Being approved, the deal is never auto-cleared by the approval
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
    const now = nowIso();
    db.prepare(
      `UPDATE orders SET mode = ?, table_id = ?, updated_at = ?, version = version + 1
        WHERE id = ?`,
    ).run(mode, tableId, now, orderId);

    const updated: Order = { ...order, mode, tableId: tableId as Order['tableId'] };
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
    // foodpanda (the terms of NOW, frozen), taken off when it leaves.
    const wasFoodpanda = order.mode === 'foodpanda';
    const isFoodpanda = mode === 'foodpanda';
    let discountChanged = false;
    if (wasFoodpanda && !isFoodpanda) discountChanged = takeOffFoodpandaDeal(db, orderId, actor);
    else if (!wasFoodpanda && isFoodpanda && order.source === 'pos') discountChanged = putOnFoodpandaDeal(db, updated, actor);
    if (discountChanged) recomputeOrderTotals(db, orderId, actor);
    result = discountChanged ? (findOrder(db, orderId) ?? updated) : updated;
  });
  tx();
  return result;
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
 * actively building is never touched.
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
        `SELECT id, name, base_price_cents, prep_station, tax_category_id
           FROM menu_items WHERE id = ? AND deleted_at IS NULL AND is_active = 1`,
      )
      .get(input.menuItemId) as
      | {
          id: string;
          name: string;
          base_price_cents: number;
          prep_station: PrepStation;
          tax_category_id: string;
        }
      | undefined;
    if (!itemRow) throw new Error('Menu item not found or inactive');

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
    };

    db.prepare(
      `INSERT INTO order_items
         (id, order_id, menu_item_id, menu_item_name, combo_id, parent_order_item_id,
          quantity, unit_price_cents, line_total_cents, tax_category_id, tax_rate_bps_snapshot,
          prep_station_snapshot, notes, kitchen_status,
          created_at, updated_at, device_id, version)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 1)`,
    ).run(
      itemId,
      input.orderId,
      input.menuItemId,
      itemRow.name,
      input.parentOrderItemId ?? null,
      input.quantity,
      unitPrice,
      lineTotal,
      itemRow.tax_category_id,
      rateBps,
      itemRow.prep_station,
      input.notes ?? null,
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
        menuItemName: itemRow.name,
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
 * discount-base.ts): what each came to, the name it was sold under and its
 * tax rate, in the till's order ((created_at, id)) — the order the discount
 * is split in, here, on the F3 screen and on the FBR invoice.
 */
function discountLinesOf(db: AppDatabase, orderId: string): Array<{ lineTotalCents: number; menuItemName: string; taxRateBps: number }> {
  const rows = db
    .prepare(
      `SELECT line_total_cents, menu_item_name, tax_rate_bps_snapshot
         FROM order_items WHERE order_id = ? AND deleted_at IS NULL
        ORDER BY created_at, id`,
    )
    .all(orderId) as Array<{ line_total_cents: number; menu_item_name: string; tax_rate_bps_snapshot: number }>;
  return rows.map((r) => ({ lineTotalCents: r.line_total_cents, menuItemName: r.menu_item_name, taxRateBps: r.tax_rate_bps_snapshot }));
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
    // also come off the delivery charge? The till's switch as it is now
    // (Settings → Money & discounts), or the website's own for a web order.
    // Everything after — each cart change, the tax, the FBR invoice, profit,
    // a reprint — follows the row, never the live setting.
    const rule = opts.rule ?? tillDiscountRule(readDiscountAlsoOffDeliveryCharge(db));
    // What it is worked on: the food only, unless the rule says every line.
    const base = discountBaseCents(discountLinesOf(db, input.orderId), rule.alsoOffDeliveryCharge);

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
      .prepare(`SELECT id FROM order_discounts WHERE order_id = ? AND deleted_at IS NULL`)
      .all(input.orderId) as Array<{ id: string }>;
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
        `SELECT id, discount_type, value, amount_cents, source
           FROM order_discounts WHERE order_id = ? AND deleted_at IS NULL`,
      )
      .all(orderId) as Array<{
      id: string;
      discount_type: string;
      value: number;
      amount_cents: number;
      source: string | null;
    }>;
    if (existing.length === 0) return; // nothing to clear, no audit noise
    // Taking the foodpanda deal off is changing it: a manager's, like applyDiscount.
    if (existing.some((d) => d.source === 'foodpanda') && !opts.approverUserId) throw new Error(FOODPANDA_DEAL_NEEDS_MANAGER);
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
  // Does the discount also come off the delivery charge? The rule FROZEN on
  // its row when it was given — never the live setting. A row with no rule
  // (given before 0.7.25, or on a 0.7.24 till) covers every line, as then.
  const alsoOffDeliveryCharge = discountRow ? discountRuleAlsoOffDeliveryCharge(discountRow.rule_json) : true;
  // What it is worked on: the food only, or every line (the subtotal).
  const base = discountBaseCents(lines, alsoOffDeliveryCharge);
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
    if (discountRow.source === 'foodpanda') {
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
  // delivery charge the rule leaves alone weighing 0; the F3 preview, the FBR
  // mapper and the website's estimate split it the same way. Lines in
  // insertion order so they all agree.
  const tax = subtotal > 0 ? taxAfterDiscount(lines, discount, alsoOffDeliveryCharge).taxCents : 0;

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
    db.prepare(
      `UPDATE orders SET status = ?, paid_at = ?, updated_at = ?, version = version + 1
        WHERE id = ?`,
    ).run(nextStatus, now, now, input.orderId);

    const finalized = { ...order, status: nextStatus, paidAt: now };
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
      `SELECT rule_json FROM order_discounts
        WHERE order_id = ? AND source = 'foodpanda' AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(order.id) as { rule_json: string | null } | undefined;
  const rule = parseFoodpandaDealRule(dealRow?.rule_json);
  // On what the deal was worked: the food, when its frozen rule left the delivery charge alone.
  const share = rule
    ? dealAmount(rule, discountBaseCents(discountLinesOf(db, order.id), rule.alsoOffDeliveryCharge !== false))
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
              oi.notes, oi.kitchen_status, oi.created_at, oi.updated_at, oi.device_id, oi.version,
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

  const discounts: OrderSnapshot['discounts'] = discountRows.map((d) => {
    // Whether it also came off the delivery charge: the rule FROZEN on the
    // row (none = yes, as every discount before 0.7.25). The FBR mapper, the
    // receipt and the screens read it from here, never from the setting.
    const alsoOffDeliveryCharge = discountRuleAlsoOffDeliveryCharge(d.rule_json);
    // The foodpanda deal's figures on this order, from its frozen terms and
    // the lines it was worked on (the food, when it left the delivery charge
    // alone; else the stored subtotal): the whole deal, and foodpanda's part
    // (the bill says "foodpanda pays another Rs …" when it is shared).
    const rule = d.source === 'foodpanda' ? parseFoodpandaDealRule(d.rule_json) : null;
    const dealBase = rule ? (alsoOffDeliveryCharge ? order.subtotalCents : discountBaseCents(items, false)) : 0;
    const share = rule ? dealAmount(rule, dealBase) : null;
    return {
      id: d.id as OrderSnapshot['discounts'][number]['id'],
      orderId: orderId as OrderSnapshot['discounts'][number]['orderId'],
      discountType: d.discount_type,
      value: d.value,
      reason: d.reason,
      appliedByUserId: d.applied_by_user_id as OrderSnapshot['discounts'][number]['appliedByUserId'],
      approvedByUserId: (d.approved_by_user_id ?? null) as OrderSnapshot['discounts'][number]['approvedByUserId'],
      amountCents: d.amount_cents as OrderSnapshot['discounts'][number]['amountCents'],
      source: d.source === 'foodpanda' ? 'foodpanda' : null,
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
      alsoOffDeliveryCharge,
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
 * or refunded. Returned as full snapshots so the UI doesn't need a second
 * round-trip per card.
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
        ORDER BY created_at ASC LIMIT 200`,
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
  extraSet: { col: string; value: string | null }[],
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
 * Assign a rider to a delivery order. Moves the status to `out_for_delivery`
 * and stamps `dispatched_at`. Allowed from `ready` (the usual path), but also
 * from earlier kitchen states if the dispatcher wants to pre-assign — never
 * from a draft that was not sent (it would skip the stock).
 */
export function assignRiderToOrder(
  db: AppDatabase,
  orderId: string,
  riderId: string,
  actor: Actor & { userId: string },
): Order {
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
  return setOrderStatus(
    db,
    orderId,
    'out_for_delivery',
    ['sent_to_kitchen', 'preparing', 'ready', 'out_for_delivery'],
    [
      { col: 'assigned_rider_id', value: riderId },
      { col: 'dispatched_at', value: nowIso() },
    ],
    actor,
    'assign_rider',
  );
}

/**
 * Clear a rider assignment (mistakes happen). Reverts to `ready` so the
 * dispatcher can re-assign. Does not clear `dispatched_at` — that's a
 * historical fact even if it gets re-set.
 */
export function unassignRiderFromOrder(
  db: AppDatabase,
  orderId: string,
  actor: Actor & { userId: string },
): Order {
  const order = findOrder(db, orderId);
  if (!order) throw new Error('Order not found');
  if (order.status !== 'out_for_delivery') {
    throw new Error('Only out-for-delivery orders can be unassigned');
  }
  return setOrderStatus(
    db,
    orderId,
    'ready',
    ['out_for_delivery'],
    [{ col: 'assigned_rider_id', value: null }],
    actor,
    'unassign_rider',
  );
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

/**
 * Mark a delivery order delivered. Optionally records a COD payment in the
 * same transaction — when `payment` is provided we transition straight from
 * `out_for_delivery` (or `ready`) through `delivered` to `paid`.
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
    if (input.payment) {
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
    // Cash on delivery brought back by the rider: a cash sale's drawer open.
    const drawerOpenId = input.payment ? recordCashSale(db, input.orderId, [input.payment], actor) : null;
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
 * part) on the other till, sent to FBR in production (any status, or a
 * paper that printed a production number). Same till only: its FBR queue,
 * website import, print jobs and shift cash are all on this till.
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

  const cashBy = new Map<string, number>();
  for (const p of payments) {
    if (p.method !== 'cash' || !p.shiftId) continue;
    cashBy.set(p.shiftId, (cashBy.get(p.shiftId) ?? 0) + p.amountCents);
  }
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
    paid,
    stockStatus,
    stockState,
    cash,
    web,
    kitchenSlip,
  };
  if (order.status === 'open') return { ok: false, refusal: TEST_DELETE_REFUSED.open, facts };
  if (row.device_id !== deviceId) return { ok: false, refusal: TEST_DELETE_REFUSED.otherTillOrder, facts };
  if (payments.some((p) => p.deviceId !== deviceId)) return { ok: false, refusal: TEST_DELETE_REFUSED.otherTillPayment, facts };
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
 *     so is a foodpanda order's kept terms row (order_channel_terms);
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
