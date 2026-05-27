import type { AppDatabase } from '../db/connection.js';

/**
 * Reporting / analytics service. Pure read aggregations over orders,
 * order_items, payments, discounts, stock_movements. Date-range driven.
 *
 * Performance: all queries hit indexed columns. For very long ranges
 * (>1 year), the aggregations may need pre-roll tables — Phase 6.5.
 */

export interface DateRange {
  /** Inclusive lower bound, ISO 8601. */
  sinceIso: string;
  /** Exclusive upper bound, ISO 8601. */
  untilIso: string;
}

export interface SalesSummary {
  orderCount: number;
  itemCount: number;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  avgTicketCents: number;
  voidedCount: number;
  voidedCents: number;
}

export function getSalesSummary(db: AppDatabase, range: DateRange): SalesSummary {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS orderCount,
         COALESCE(SUM(subtotal_cents), 0) AS subtotalCents,
         COALESCE(SUM(discount_cents), 0) AS discountCents,
         COALESCE(SUM(tax_cents), 0) AS taxCents,
         COALESCE(SUM(total_cents), 0) AS totalCents,
         SUM(CASE WHEN status = 'void' THEN 1 ELSE 0 END) AS voidedCount,
         COALESCE(SUM(CASE WHEN status = 'void' THEN total_cents ELSE 0 END), 0) AS voidedCents
       FROM orders
       WHERE created_at >= ? AND created_at < ? AND deleted_at IS NULL AND status = 'paid'`,
    )
    .get(range.sinceIso, range.untilIso) as
    | {
        orderCount: number;
        subtotalCents: number;
        discountCents: number;
        taxCents: number;
        totalCents: number;
        voidedCount: number;
        voidedCents: number;
      }
    | undefined;

  const itemsRow = db
    .prepare(
      `SELECT COALESCE(SUM(oi.quantity), 0) AS itemCount
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE o.created_at >= ? AND o.created_at < ? AND oi.deleted_at IS NULL AND o.status = 'paid'`,
    )
    .get(range.sinceIso, range.untilIso) as { itemCount: number } | undefined;

  const r = row ?? {
    orderCount: 0,
    subtotalCents: 0,
    discountCents: 0,
    taxCents: 0,
    totalCents: 0,
    voidedCount: 0,
    voidedCents: 0,
  };
  return {
    ...r,
    itemCount: itemsRow?.itemCount ?? 0,
    avgTicketCents: r.orderCount > 0 ? Math.round(r.totalCents / r.orderCount) : 0,
  };
}

export interface SalesByDay {
  day: string;
  orderCount: number;
  totalCents: number;
}

export function getSalesByDay(db: AppDatabase, range: DateRange): SalesByDay[] {
  return db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day,
              COUNT(*) AS orderCount,
              SUM(total_cents) AS totalCents
         FROM orders
        WHERE created_at >= ? AND created_at < ? AND deleted_at IS NULL AND status = 'paid'
        GROUP BY day
        ORDER BY day`,
    )
    .all(range.sinceIso, range.untilIso) as SalesByDay[];
}

export interface SalesByHour {
  hour: number; // 0-23
  orderCount: number;
  totalCents: number;
}

export function getSalesByHour(db: AppDatabase, range: DateRange): SalesByHour[] {
  return db
    .prepare(
      `SELECT CAST(substr(created_at, 12, 2) AS INTEGER) AS hour,
              COUNT(*) AS orderCount,
              SUM(total_cents) AS totalCents
         FROM orders
        WHERE created_at >= ? AND created_at < ? AND deleted_at IS NULL AND status = 'paid'
        GROUP BY hour
        ORDER BY hour`,
    )
    .all(range.sinceIso, range.untilIso) as SalesByHour[];
}

export interface SalesByCategory {
  categoryId: string;
  categoryName: string;
  itemCount: number;
  revenueCents: number;
}

export function getSalesByCategory(db: AppDatabase, range: DateRange): SalesByCategory[] {
  return db
    .prepare(
      `SELECT c.id AS categoryId, c.name AS categoryName,
              SUM(oi.quantity) AS itemCount,
              SUM(oi.line_total_cents) AS revenueCents
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN menu_items mi ON mi.id = oi.menu_item_id
         JOIN categories c ON c.id = mi.category_id
        WHERE o.created_at >= ? AND o.created_at < ? AND o.deleted_at IS NULL AND o.status = 'paid'
          AND oi.deleted_at IS NULL
        GROUP BY c.id, c.name
        ORDER BY revenueCents DESC`,
    )
    .all(range.sinceIso, range.untilIso) as SalesByCategory[];
}

export interface TopItem {
  menuItemId: string;
  menuItemName: string;
  categoryName: string;
  quantity: number;
  revenueCents: number;
}

export function getTopItems(db: AppDatabase, range: DateRange, limit = 20): TopItem[] {
  return db
    .prepare(
      `SELECT mi.id AS menuItemId, mi.name AS menuItemName,
              c.name AS categoryName,
              SUM(oi.quantity) AS quantity,
              SUM(oi.line_total_cents) AS revenueCents
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN menu_items mi ON mi.id = oi.menu_item_id
         JOIN categories c ON c.id = mi.category_id
        WHERE o.created_at >= ? AND o.created_at < ? AND o.deleted_at IS NULL AND o.status = 'paid'
          AND oi.deleted_at IS NULL
        GROUP BY mi.id, mi.name, c.name
        ORDER BY quantity DESC, revenueCents DESC
        LIMIT ?`,
    )
    .all(range.sinceIso, range.untilIso, limit) as TopItem[];
}

export interface SalesByMode {
  mode: 'dine_in' | 'takeaway' | 'delivery' | 'online';
  orderCount: number;
  totalCents: number;
}

export function getSalesByMode(db: AppDatabase, range: DateRange): SalesByMode[] {
  return db
    .prepare(
      `SELECT mode, COUNT(*) AS orderCount, SUM(total_cents) AS totalCents
         FROM orders
        WHERE created_at >= ? AND created_at < ? AND deleted_at IS NULL AND status = 'paid'
        GROUP BY mode
        ORDER BY totalCents DESC`,
    )
    .all(range.sinceIso, range.untilIso) as SalesByMode[];
}

export interface SalesByPaymentMethod {
  method: string;
  paymentCount: number;
  amountCents: number;
}

export interface CashSummary {
  /** Per-method breakdown including refunds. */
  byMethod: Array<{
    method: string;
    salesCents: number; // sum of positive payments
    refundCents: number; // abs sum of negative payments
    netCents: number;
    paymentCount: number;
    refundCount: number;
  }>;
  cashSalesCents: number;
  cashRefundsCents: number;
  /** opening + cashSales - cashRefunds. Opening is supplied by caller. */
  expectedCashCents: number;
  totalRevenueCents: number;
  totalRefundsCents: number;
  netRevenueCents: number;
  paidOrderCount: number;
  refundedOrderCount: number;
}

/**
 * End-of-day cash reconciliation summary. Returns per-method totals
 * (positive payments vs negative refund entries), plus a cash-specific roll-up
 * for the drawer count screen.
 *
 * `openingCashCents` is added to expected cash (the float you started with).
 * Default 0.
 */
export function getCashSummary(
  db: AppDatabase,
  range: DateRange,
  openingCashCents = 0,
): CashSummary {
  const rows = db
    .prepare(
      `SELECT method,
              SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END) AS salesCents,
              SUM(CASE WHEN amount_cents < 0 THEN -amount_cents ELSE 0 END) AS refundCents,
              SUM(CASE WHEN amount_cents > 0 THEN 1 ELSE 0 END) AS paymentCount,
              SUM(CASE WHEN amount_cents < 0 THEN 1 ELSE 0 END) AS refundCount
         FROM payments
        WHERE paid_at >= ? AND paid_at < ? AND deleted_at IS NULL
        GROUP BY method
        ORDER BY SUM(ABS(amount_cents)) DESC`,
    )
    .all(range.sinceIso, range.untilIso) as Array<{
    method: string;
    salesCents: number | null;
    refundCents: number | null;
    paymentCount: number;
    refundCount: number;
  }>;
  const byMethod = rows.map((r) => ({
    method: r.method,
    salesCents: r.salesCents ?? 0,
    refundCents: r.refundCents ?? 0,
    netCents: (r.salesCents ?? 0) - (r.refundCents ?? 0),
    paymentCount: r.paymentCount,
    refundCount: r.refundCount,
  }));
  const cashLine = byMethod.find((m) => m.method === 'cash');
  const cashSalesCents = cashLine?.salesCents ?? 0;
  const cashRefundsCents = cashLine?.refundCents ?? 0;

  const totalRevenueCents = byMethod.reduce((s, m) => s + m.salesCents, 0);
  const totalRefundsCents = byMethod.reduce((s, m) => s + m.refundCents, 0);

  // Distinct paid orders + refunded orders in the range.
  const paidOrderCount = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM orders
        WHERE paid_at >= ? AND paid_at < ? AND deleted_at IS NULL AND status = 'paid'`,
    )
    .get(range.sinceIso, range.untilIso) as { n: number }).n;
  const refundedOrderCount = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM orders
        WHERE voided_at >= ? AND voided_at < ? AND deleted_at IS NULL AND status = 'refunded'`,
    )
    .get(range.sinceIso, range.untilIso) as { n: number }).n;

  return {
    byMethod,
    cashSalesCents,
    cashRefundsCents,
    expectedCashCents: openingCashCents + cashSalesCents - cashRefundsCents,
    totalRevenueCents,
    totalRefundsCents,
    netRevenueCents: totalRevenueCents - totalRefundsCents,
    paidOrderCount,
    refundedOrderCount,
  };
}

export function getSalesByPaymentMethod(
  db: AppDatabase,
  range: DateRange,
): SalesByPaymentMethod[] {
  return db
    .prepare(
      `SELECT p.method, COUNT(*) AS paymentCount, SUM(p.amount_cents) AS amountCents
         FROM payments p
         JOIN orders o ON o.id = p.order_id
        WHERE p.paid_at >= ? AND p.paid_at < ? AND p.deleted_at IS NULL AND o.status = 'paid'
        GROUP BY p.method
        ORDER BY amountCents DESC`,
    )
    .all(range.sinceIso, range.untilIso) as SalesByPaymentMethod[];
}

export interface SalesByCashier {
  cashierId: string;
  cashierName: string;
  orderCount: number;
  totalCents: number;
  voidedCount: number;
}

export function getSalesByCashier(db: AppDatabase, range: DateRange): SalesByCashier[] {
  return db
    .prepare(
      `SELECT u.id AS cashierId, u.full_name AS cashierName,
              SUM(CASE WHEN o.status = 'paid' THEN 1 ELSE 0 END) AS orderCount,
              COALESCE(SUM(CASE WHEN o.status = 'paid' THEN o.total_cents ELSE 0 END), 0) AS totalCents,
              SUM(CASE WHEN o.status = 'void' THEN 1 ELSE 0 END) AS voidedCount
         FROM orders o
         JOIN users u ON u.id = o.cashier_id
        WHERE o.created_at >= ? AND o.created_at < ? AND o.deleted_at IS NULL
        GROUP BY u.id, u.full_name
        ORDER BY totalCents DESC`,
    )
    .all(range.sinceIso, range.untilIso) as SalesByCashier[];
}

export interface DiscountSummary {
  count: number;
  totalAmountCents: number;
  byReason: Array<{ reason: string; count: number; amountCents: number }>;
}

export function getDiscountSummary(db: AppDatabase, range: DateRange): DiscountSummary {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(d.amount_cents), 0) AS totalAmountCents
         FROM order_discounts d
         JOIN orders o ON o.id = d.order_id
        WHERE o.created_at >= ? AND o.created_at < ? AND d.deleted_at IS NULL AND o.status = 'paid'`,
    )
    .get(range.sinceIso, range.untilIso) as { count: number; totalAmountCents: number } | undefined;

  const byReason = db
    .prepare(
      `SELECT COALESCE(d.reason, '(no reason)') AS reason,
              COUNT(*) AS count,
              SUM(d.amount_cents) AS amountCents
         FROM order_discounts d
         JOIN orders o ON o.id = d.order_id
        WHERE o.created_at >= ? AND o.created_at < ? AND d.deleted_at IS NULL AND o.status = 'paid'
        GROUP BY d.reason
        ORDER BY amountCents DESC`,
    )
    .all(range.sinceIso, range.untilIso) as Array<{
    reason: string;
    count: number;
    amountCents: number;
  }>;

  return {
    count: totals?.count ?? 0,
    totalAmountCents: totals?.totalAmountCents ?? 0,
    byReason,
  };
}

export interface LowStockItem {
  ingredientId: string;
  name: string;
  unit: string;
  currentQty: number;
  lowThreshold: number;
}

export function getLowStock(db: AppDatabase): LowStockItem[] {
  return db
    .prepare(
      `SELECT id AS ingredientId, name, unit, current_qty AS currentQty, low_threshold AS lowThreshold
         FROM ingredients
        WHERE deleted_at IS NULL AND is_active = 1 AND current_qty <= low_threshold
        ORDER BY (current_qty - low_threshold), name`,
    )
    .all() as LowStockItem[];
}

export interface CogsReport {
  totalCogsCents: number;
  byIngredient: Array<{
    ingredientId: string;
    name: string;
    unit: string;
    qtyConsumed: number;
    costCents: number;
  }>;
}

export function getCogs(db: AppDatabase, range: DateRange): CogsReport {
  // Sum sale movements per ingredient, value at cost_per_unit_cents (current snapshot — Phase 6
  // would store a snapshot cost on each movement for full historical accuracy).
  const rows = db
    .prepare(
      `SELECT m.ingredient_id AS ingredientId, i.name, i.unit, i.cost_per_unit_cents AS unitCost,
              SUM(-m.delta_qty) AS qtyConsumed
         FROM stock_movements m
         JOIN ingredients i ON i.id = m.ingredient_id
        WHERE m.reason = 'sale' AND m.occurred_at >= ? AND m.occurred_at < ?
              AND m.deleted_at IS NULL
        GROUP BY m.ingredient_id, i.name, i.unit, i.cost_per_unit_cents
        ORDER BY (SUM(-m.delta_qty) * i.cost_per_unit_cents) DESC`,
    )
    .all(range.sinceIso, range.untilIso) as Array<{
    ingredientId: string;
    name: string;
    unit: string;
    unitCost: number;
    qtyConsumed: number;
  }>;
  let total = 0;
  const byIngredient = rows.map((r) => {
    const cost = Math.round(r.qtyConsumed * r.unitCost);
    total += cost;
    return {
      ingredientId: r.ingredientId,
      name: r.name,
      unit: r.unit,
      qtyConsumed: r.qtyConsumed,
      costCents: cost,
    };
  });
  return { totalCogsCents: total, byIngredient };
}
