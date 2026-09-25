import { v7 as uuidv7 } from 'uuid';
import log from 'electron-log/main';
import type { AppDatabase } from '../connection.js';
import { nowIso, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import { decrementForOrder, returnStockForOrder } from './stock-movement-repo.js';
import { computeTax } from '@cheeseoclock/pos-domain';
import {
  allocateDiscount,
  computeDiscountCents,
  validateOrderForTender,
  validateVoid,
  validateDiscountInput,
  requiresManagerApproval,
} from '@cheeseoclock/pos-domain';
import type {
  Order,
  OrderItem,
  OrderItemModifier,
  OrderMode,
  OrderStatus,
  Payment,
  PaymentMethod,
  OrderSnapshot,
  PrepStation,
  UUID,
} from '@cheeseoclock/shared-types';

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
  };
}

const ORDER_SELECT = `
  id, order_number, mode, status, table_id, customer_id, cashier_id, shift_id, source, notes,
  subtotal_cents, discount_cents, tax_cents, total_cents, paid_at, voided_at, voided_by, void_reason,
  customer_name_snapshot, customer_phone_snapshot, delivery_address_snapshot, delivery_notes,
  assigned_rider_id, dispatched_at, delivered_at,
  created_at, updated_at, device_id, version
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
 * Richer list for the Order History page: includes the customer/table name
 * snapshot, cashier name, item count, and payment method (first payment's).
 * Filters: text search across order#/customer name/phone, status/mode/date.
 */
export interface OrderHistoryRow {
  id: string;
  orderNumber: string;
  mode: OrderMode;
  status: OrderStatus;
  customerName: string | null;
  customerPhone: string | null;
  tableLabel: string | null;
  cashierName: string;
  itemCount: number;
  totalCents: number;
  paidAt: string | null;
  createdAt: string;
  primaryPaymentMethod: PaymentMethod | null;
}

export function listOrderHistory(
  db: AppDatabase,
  opts?: {
    search?: string;
    status?: OrderStatus | 'any';
    mode?: OrderMode | 'any';
    sinceIso?: string;
    untilIso?: string;
    limit?: number;
  },
): OrderHistoryRow[] {
  const conditions: string[] = ['o.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (opts?.status && opts.status !== 'any') {
    conditions.push('o.status = ?');
    params.push(opts.status);
  }
  if (opts?.mode && opts.mode !== 'any') {
    conditions.push('o.mode = ?');
    params.push(opts.mode);
  }
  if (opts?.sinceIso) {
    conditions.push('o.created_at >= ?');
    params.push(opts.sinceIso);
  }
  if (opts?.untilIso) {
    conditions.push('o.created_at <= ?');
    params.push(opts.untilIso);
  }
  if (opts?.search && opts.search.trim()) {
    const q = `%${opts.search.trim().toLowerCase()}%`;
    conditions.push(
      `(LOWER(o.order_number) LIKE ?
        OR LOWER(IFNULL(o.customer_name_snapshot, '')) LIKE ?
        OR LOWER(IFNULL(o.customer_phone_snapshot, '')) LIKE ?)`,
    );
    params.push(q, q, q);
  }
  const limit = opts?.limit ?? 200;
  const rows = db
    .prepare(
      `SELECT
         o.id, o.order_number, o.mode, o.status,
         o.customer_name_snapshot, o.customer_phone_snapshot,
         o.total_cents, o.paid_at, o.created_at,
         u.full_name AS cashier_name,
         t.label AS table_label,
         (SELECT COUNT(*) FROM order_items oi
            WHERE oi.order_id = o.id AND oi.deleted_at IS NULL) AS item_count,
         (SELECT method FROM payments p
            WHERE p.order_id = o.id AND p.deleted_at IS NULL
            ORDER BY p.paid_at LIMIT 1) AS first_payment_method
        FROM orders o
        LEFT JOIN users u ON u.id = o.cashier_id
        LEFT JOIN tables t ON t.id = o.table_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY o.created_at DESC
        LIMIT ?`,
    )
    .all(...params, limit) as Array<{
    id: string;
    order_number: string;
    mode: OrderMode;
    status: OrderStatus;
    customer_name_snapshot: string | null;
    customer_phone_snapshot: string | null;
    total_cents: number;
    paid_at: string | null;
    created_at: string;
    cashier_name: string | null;
    table_label: string | null;
    item_count: number;
    first_payment_method: PaymentMethod | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    orderNumber: r.order_number,
    mode: r.mode,
    status: r.status,
    customerName: r.customer_name_snapshot,
    customerPhone: r.customer_phone_snapshot,
    tableLabel: r.table_label,
    cashierName: r.cashier_name ?? 'Unknown',
    itemCount: r.item_count,
    totalCents: r.total_cents,
    paidAt: r.paid_at,
    createdAt: r.created_at,
    primaryPaymentMethod: r.first_payment_method,
  }));
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
function assertMethodFitsOrder(mode: OrderMode, method: PaymentMethod): void {
  if ((mode === 'foodpanda') === (method === 'foodpanda')) return;
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
  });
  tx();
  log.info('Order created', { id, mode: input.mode });
  return order;
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
    result = updated;
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
    const modRows = input.modifierIds.length
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
    if (modRows.length !== new Set(input.modifierIds).size) {
      throw new Error('One of the chosen options is no longer on the menu — publish the menu again');
    }

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

    // Insert modifier snapshots
    for (const mr of modRows) {
      const modOrderId = uuidv7();
      db.prepare(
        `INSERT INTO order_item_modifiers
           (id, order_item_id, modifier_id, modifier_name, price_delta_cents,
            created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(modOrderId, itemId, mr.id, mr.name, mr.price_delta_cents, now, now, actor.deviceId);
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

export function applyDiscount(
  db: AppDatabase,
  input: ApplyDiscountInput,
  actor: Actor & { userId: string },
): void {
  const tx = db.transaction(() => {
    const order = findOrder(db, input.orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'open') throw new Error(`This order is ${said(order.status)} — a discount can't be added now`);

    // Validate the discount input shape (percent 0-100, value >= 0).
    const v = validateDiscountInput({ discountType: input.discountType, value: input.value });
    if (!v.ok) throw new Error(v.missing.join('; '));

    // Repo-level approval guard — defense in depth even if a future caller
    // bypasses the IPC handler (which already enforces it via verifyManagerPin).
    if (
      requiresManagerApproval({ type: input.discountType, value: input.value }, order.subtotalCents) &&
      !input.approverUserId
    ) {
      throw new Error('Manager approval is required for this discount');
    }

    const amount = computeDiscountCents(order.subtotalCents, {
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

    const discountId = uuidv7();
    db.prepare(
      `INSERT INTO order_discounts
         (id, order_id, discount_type, value, reason, applied_by_user_id, approved_by_user_id,
          amount_cents, created_at, updated_at, device_id, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      discountId,
      input.orderId,
      input.discountType,
      input.value,
      input.reason ?? null,
      actor.userId,
      input.approverUserId ?? null,
      amount,
      now,
      now,
      actor.deviceId,
    );

    enqueueSync(db, {
      entityType: 'order_discounts',
      entityId: discountId,
      op: 'upsert',
      payload: { ...input, id: discountId, amountCents: amount },
    });
    writeAudit(db, {
      entityType: 'order_discounts',
      entityId: discountId,
      action: 'create',
      actorUserId: actor.userId,
      before: null,
      after: { ...input, amountCents: amount, approverUserId: input.approverUserId },
    });

    recomputeOrderTotals(db, input.orderId, actor);
  });
  tx();
}

export function clearDiscount(
  db: AppDatabase,
  orderId: string,
  actor: Actor & { userId: string },
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
        `SELECT id, discount_type, value, amount_cents
           FROM order_discounts WHERE order_id = ? AND deleted_at IS NULL`,
      )
      .all(orderId) as Array<{
      id: string;
      discount_type: string;
      value: number;
      amount_cents: number;
    }>;
    if (existing.length === 0) return; // nothing to clear, no audit noise
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
      after: null,
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
      `SELECT id, discount_type, value, amount_cents, approved_by_user_id FROM order_discounts
         WHERE order_id = ? AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
    )
    .get(orderId) as
    | { id: string; discount_type: 'percent' | 'flat'; value: number; amount_cents: number; approved_by_user_id: string | null }
    | undefined;
  let discount = 0;
  if (discountRow) {
    const d = { type: discountRow.discount_type, value: discountRow.value };
    const now = nowIso();
    if (requiresManagerApproval(d, subtotal) && !discountRow.approved_by_user_id) {
      // A flat discount that has become more than 10% of a shrunken cart now
      // needs a manager: take it off, the cashier re-applies it (with a PIN).
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
      discount = computeDiscountCents(subtotal, d);
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
  // to it exactly (allocateDiscount); the FBR mapper and the website's
  // estimate split it the same way. Lines in insertion order so all three agree.
  let tax = 0;
  const lineRows = db
    .prepare(
      `SELECT line_total_cents, tax_rate_bps_snapshot
         FROM order_items WHERE order_id = ? AND deleted_at IS NULL
        ORDER BY created_at, id`,
    )
    .all(orderId) as Array<{ line_total_cents: number; tax_rate_bps_snapshot: number }>;
  if (subtotal > 0) {
    const shares = allocateDiscount(lineRows.map((l) => l.line_total_cents), discount);
    lineRows.forEach((line, i) => {
      const lineNet = Math.max(0, line.line_total_cents - (shares[i] ?? 0));
      tax += computeTax(lineNet, line.tax_rate_bps_snapshot, 'exclusive').taxCents as number;
    });
  }

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

export function tenderOrder(
  db: AppDatabase,
  input: { orderId: string; payments: TenderInputItem[] },
  actor: Actor & { userId: string },
): Order {
  let result!: Order;
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

    const now = nowIso();
    const shiftId = input.payments.length > 0 ? shiftForPayment(db, actor.deviceId) : null;
    for (const p of input.payments) {
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

    result = finalized;
  });
  tx();
  log.info('Order tendered', { id: input.orderId, total: result.totalCents });
  return result;
}

// -----------------------------------------------------------------------------
// Void
// -----------------------------------------------------------------------------

export function voidOrder(
  db: AppDatabase,
  input: { orderId: string; reason: string; approverUserId: string },
  actor: Actor & { userId: string },
): Order {
  let result!: Order;
  const tx = db.transaction(() => {
    const order = findOrder(db, input.orderId);
    if (!order) throw new Error('Order not found');

    const v = validateVoid({ status: order.status, paidAt: order.paidAt, reason: input.reason });
    if (!v.ok) throw new Error(v.missing.join('; '));

    const now = nowIso();
    db.prepare(
      `UPDATE orders SET status = 'void', voided_at = ?, voided_by = ?, void_reason = ?,
                          updated_at = ?, version = version + 1
        WHERE id = ?`,
    ).run(now, input.approverUserId, input.reason, now, input.orderId);

    // Stock leaves when the kitchen gets the order. Cancelled before the
    // kitchen started on it, it goes back; once cooking has started it is gone.
    if (order.status === 'sent_to_kitchen') returnStockForOrder(db, input.orderId, actor);

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
    result = voided;
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
 *      per original positive payment so the books mirror perfectly. Status
 *      moves to 'refunded'.
 *   2. Partial refund (`amountCents` provided) — inserts a single negative
 *      payment with the supplied method (or the dominant payment method on
 *      the order if not specified). Status stays 'paid' until cumulative
 *      refunds equal the order total, at which point it flips to 'refunded'.
 *
 * Partial-refund accumulation is computed from the payments ledger, so
 * multiple partials add up correctly. Refund amount can't exceed the
 * remaining refundable balance.
 */
export function refundOrder(
  db: AppDatabase,
  input: {
    orderId: string;
    reason: string;
    approverUserId: string;
    amountCents?: number;
    method?: PaymentMethod;
  },
  actor: Actor & { userId: string },
): Order {
  let result!: Order;
  const tx = db.transaction(() => {
    const order = findOrder(db, input.orderId);
    if (!order) throw new Error('Order not found');
    if (order.status === 'refunded') throw new Error('Order already fully refunded');
    if (order.status === 'void') throw new Error('Cannot refund a voided order');
    if (order.paidAt === null) {
      throw new Error(`Nothing has been paid on this order yet (it is ${said(order.status)}) — cancel it instead`);
    }
    if (!input.reason.trim()) throw new Error('Refund reason is required');

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
      // All the money back before the kitchen started: the stock goes back too.
      if (fullyRefunded && order.status === 'sent_to_kitchen') returnStockForOrder(db, input.orderId, actor);

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
      result = after;
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
    // Refunded before the kitchen started on it: the stock goes back too.
    if (order.status === 'sent_to_kitchen') returnStockForOrder(db, input.orderId, actor);

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
    result = after;
  });
  tx();
  log.info('Order refunded', { id: input.orderId });
  return result;
}

// -----------------------------------------------------------------------------
// Snapshot (for receipt + reports)
// -----------------------------------------------------------------------------

export function getOrderSnapshot(db: AppDatabase, orderId: string): OrderSnapshot | null {
  const orderRow = db
    .prepare(`SELECT ${ORDER_SELECT} FROM orders WHERE id = ? AND deleted_at IS NULL`)
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

  // Fetch modifiers for all items in one query
  const modRows = itemRows.length
    ? (db
        .prepare(
          `SELECT id, order_item_id, modifier_id, modifier_name, price_delta_cents
             FROM order_item_modifiers
            WHERE order_item_id IN (${itemRows.map(() => '?').join(',')}) AND deleted_at IS NULL`,
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
              received_by_user_id, paid_at
         FROM payments WHERE order_id = ? AND deleted_at IS NULL ORDER BY paid_at`,
    )
    .all(orderId) as Array<{
    id: string;
    method: PaymentMethod;
    amount_cents: number;
    tendered_cents: number | null;
    reference_no: string | null;
    received_by_user_id: string;
    paid_at: string;
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
  }));

  const discountRows = db
    .prepare(
      `SELECT id, order_id, discount_type, value, reason, applied_by_user_id,
              approved_by_user_id, amount_cents
         FROM order_discounts WHERE order_id = ? AND deleted_at IS NULL`,
    )
    .all(orderId) as Array<{
    id: string;
    discount_type: 'percent' | 'flat';
    value: number;
    reason: string | null;
    applied_by_user_id: string;
    approved_by_user_id: string | null;
    amount_cents: number;
  }>;

  const discounts: OrderSnapshot['discounts'] = discountRows.map((d) => ({
    id: d.id as OrderSnapshot['discounts'][number]['id'],
    orderId: orderId as OrderSnapshot['discounts'][number]['orderId'],
    discountType: d.discount_type,
    value: d.value,
    reason: d.reason,
    appliedByUserId: d.applied_by_user_id as OrderSnapshot['discounts'][number]['appliedByUserId'],
    approvedByUserId: (d.approved_by_user_id ?? null) as OrderSnapshot['discounts'][number]['approvedByUserId'],
    amountCents: d.amount_cents as OrderSnapshot['discounts'][number]['amountCents'],
  }));

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
    rider,
  };
}

// -----------------------------------------------------------------------------
// Live order tracking — status transitions for the Live Orders board.
//
// State machine (legal transitions enforced here, in addition to UI):
//   open / sent_to_kitchen   → preparing
//   preparing                → ready
//   ready                    → out_for_delivery (delivery)  | served (dine-in/takeaway)
//   out_for_delivery         → delivered
//   delivered                → paid (via tenderOrder, COD case)
//   any active               → void (via voidOrder)
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
    ['open', 'sent_to_kitchen'],
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
    ['open', 'sent_to_kitchen', 'preparing'],
    [],
    actor,
    'mark_ready',
  );
}

/**
 * Assign a rider to a delivery order. Moves the status to `out_for_delivery`
 * and stamps `dispatched_at`. Allowed from `ready` (the usual path), but also
 * from earlier states if the dispatcher wants to pre-assign.
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
    ['open', 'sent_to_kitchen', 'preparing', 'ready', 'out_for_delivery'],
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
): Order {
  let result!: Order;
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
    result = after;
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
): Order {
  let result!: Order;
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
    result = after;
  });
  tx();
  log.info('Order delivered', {
    id: input.orderId,
    withPayment: !!input.payment,
  });
  return result;
}
