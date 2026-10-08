import { createHash } from 'node:crypto';
import {
  DASH_STOCK_MOVES_DAYS,
  dashKarachiHour,
  dashTradingDay,
  isDeliveryChargeMenuItem,
  type DashCameBy,
  type DashCashMove,
  type DashDayFigures,
  type DashDiscount,
  type DashDrawerOpen,
  type DashLive,
  type DashMenu,
  type DashOrderDoc,
  type DashOrderLine,
  type DashOrderMode,
  type DashOrderStatus,
  type DashPayment,
  type DashPaymentMethod,
  type DashShiftDoc,
  type DashStockItem,
  type DashStockMove,
  type ReportTabFigures,
} from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import { readDeliveryFeeItemIds } from '../db/business-settings-read.js';
import { getCurrentShift, getShiftSummary } from '../db/repositories/shift-repo.js';
import { buildReportTab } from './analytics/report-tabs.js';
import { channelOf } from './analytics/sql.js';
import { getMenuCosts } from './costing-service.js';

/**
 * What the owner's phone dashboard is sent (shared-types dashboard.ts
 * DASHBOARD PUSH), read from this till's database. Reads only — nothing here
 * writes a row — and no Electron, so the tests run it on a real migrated
 * database (dashboard-docs.db.test.ts).
 *
 * The verdicts are the till's own: `counted` is Reports' COUNTED
 * (analytics/sql.ts), `netCents` is total − the order's refunds (REFUNDED),
 * the trading day and hour are created_at's (Reports date a sale by when the
 * order was started), `channel` is channelOf. The website only adds them up.
 */

/** Rows changed this long before the last push are looked at again: a write that committed late, a clock nudged back. */
export const DASH_OVERLAP_MS = 2 * 60_000;

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const iso = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/**
 * Where a look goes on from: the row after (at, id), in (updated_at, id)
 * order — a bookmark, so a batch never reads again what the last one sent
 * however many rows share one updated_at (a migration that stamped them all
 * at once, a busy minute).
 */
export interface LookKey {
  at: string;
  id: string;
}

/** The first key after a start, or a look back: DASH_OVERLAP_MS before the cursor (a late write, a clock nudged back), or the beginning. */
export function lookFrom(cursor: string | null): LookKey {
  if (!cursor) return { at: '', id: '' };
  const t = Date.parse(cursor);
  return { at: Number.isNaN(t) ? '' : new Date(t - DASH_OVERLAP_MS).toISOString(), id: '' };
}

/** A JSON list of ids for `json_each(?)` (one parameter, any length). */
const idList = (ids: readonly string[]) => JSON.stringify(ids);

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/**
 * Orders with anything in them changed after the key — the order, a line,
 * a choice, a payment, a discount, a kept cost, foodpanda's terms — oldest
 * change first, so the history goes in order and the key only moves on.
 * `at` is the newest change of each (an order changed again comes back
 * with its new `at`).
 */
export function changedOrders(db: AppDatabase, after: LookKey, limit: number): Array<{ id: string; at: string }> {
  return db
    .prepare(
      `SELECT order_id AS id, MAX(u) AS at FROM (
         SELECT id AS order_id, updated_at AS u FROM orders WHERE updated_at >= @at
         UNION ALL SELECT order_id, updated_at FROM order_items WHERE updated_at >= @at
         UNION ALL SELECT oi.order_id, m.updated_at FROM order_item_modifiers m
                     JOIN order_items oi ON oi.id = m.order_item_id WHERE m.updated_at >= @at
         UNION ALL SELECT order_id, updated_at FROM payments WHERE updated_at >= @at
         UNION ALL SELECT order_id, updated_at FROM order_discounts WHERE updated_at >= @at
         UNION ALL SELECT order_id, updated_at FROM order_item_costs WHERE updated_at >= @at
         UNION ALL SELECT order_id, updated_at FROM order_channel_terms WHERE updated_at >= @at
       )
       GROUP BY order_id
       HAVING MAX(u) > @at OR order_id > @id
       ORDER BY at, id
       LIMIT @limit`,
    )
    .all({ at: after.at, id: after.id, limit }) as Array<{ id: string; at: string }>;
}

/** Orders started on or after `sinceIso` (the recent days the push looks over again now and then). */
export function recentOrderIds(db: AppDatabase, sinceIso: string): string[] {
  return (db.prepare(`SELECT id FROM orders WHERE created_at >= ? ORDER BY created_at`).all(sinceIso) as Array<{ id: string }>).map((r) => r.id);
}

const MODES = new Set<DashOrderMode>(['dine_in', 'takeaway', 'delivery', 'online', 'foodpanda']);
const STATUSES = new Set<DashOrderStatus>(['open', 'sent_to_kitchen', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'served', 'paid', 'void', 'refunded']);
const CAME_BY = new Set<DashCameBy>(['walk_in', 'phone', 'whatsapp', 'website', 'foodpanda']);
const METHODS = new Set<DashPaymentMethod>(['cash', 'card', 'easypaisa', 'jazzcash', 'bank_transfer', 'foodpanda']);

/** The customer's delivery address as one line (the snapshot is JSON: label, addressLine, area, city, notes). */
function addressOf(raw: unknown): { address: string | null; area: string | null } {
  const text = str(raw);
  if (!text) return { address: null, area: null };
  try {
    const a = JSON.parse(text) as { addressLine?: unknown; area?: unknown; notes?: unknown };
    const line = [str(a.addressLine), str(a.notes)].filter(Boolean).join(' · ');
    return { address: line || null, area: str(a.area) };
  } catch {
    return { address: text.slice(0, 400), area: null };
  }
}

const clip = (s: string | null, max: number) => (s === null ? null : s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * Whole orders, as documents (DashOrderDoc), for these ids: six reads over
 * the lot, never one per order. An id with no order row is left out.
 */
export function buildOrderDocs(db: AppDatabase, ids: readonly string[]): DashOrderDoc[] {
  if (ids.length === 0) return [];
  const list = idList(ids);
  const feeItems = readDeliveryFeeItemIds(db);
  const orders = db
    .prepare(
      `SELECT o.*, uc.full_name AS cashier_name, r.name AS rider_name, uv.full_name AS voided_by_name,
              ud.full_name AS deleted_by_name
         FROM orders o
         LEFT JOIN users uc ON uc.id = o.cashier_id
         LEFT JOIN riders r ON r.id = o.assigned_rider_id
         LEFT JOIN users uv ON uv.id = o.voided_by
         LEFT JOIN users ud ON ud.id = o.deleted_by
        WHERE o.id IN (SELECT value FROM json_each(?))`,
    )
    .all(list) as Row[];
  if (orders.length === 0) return [];

  const items = db
    .prepare(
      `SELECT oi.id, oi.order_id, oi.menu_item_id, oi.menu_item_name, oi.quantity, oi.unit_price_cents,
              oi.line_total_cents, oi.notes, oi.updated_at, c.name AS category_name
         FROM order_items oi
         LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
         LEFT JOIN categories c ON c.id = mi.category_id
        WHERE oi.order_id IN (SELECT value FROM json_each(?)) AND oi.deleted_at IS NULL
        ORDER BY oi.created_at, oi.id`,
    )
    .all(list) as Row[];
  const mods = db
    .prepare(
      `SELECT m.order_item_id, m.modifier_name, m.price_delta_cents, m.updated_at
         FROM order_item_modifiers m
         JOIN order_items oi ON oi.id = m.order_item_id
        WHERE oi.order_id IN (SELECT value FROM json_each(?)) AND m.deleted_at IS NULL
        ORDER BY m.sort_order, m.created_at, m.id`,
    )
    .all(list) as Row[];
  const costs = db
    .prepare(
      `SELECT order_item_id, SUM(cost_cents) AS cost, MAX(updated_at) AS updated_at
         FROM order_item_costs
        WHERE order_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL AND status <> 'failed'
        GROUP BY order_item_id`,
    )
    .all(list) as Row[];
  const payments = db
    .prepare(
      `SELECT p.id, p.order_id, p.method, p.amount_cents, p.tendered_cents, p.paid_at, p.created_at, p.updated_at,
              p.shift_id, u.full_name AS by_name
         FROM payments p
         LEFT JOIN users u ON u.id = p.received_by_user_id
        WHERE p.order_id IN (SELECT value FROM json_each(?)) AND p.deleted_at IS NULL
        ORDER BY p.created_at, p.id`,
    )
    .all(list) as Row[];
  const discounts = db
    .prepare(
      `SELECT d.order_id, d.discount_type, d.value, d.amount_cents, d.reason, d.source, d.created_at, d.updated_at,
              ua.full_name AS by_name, up.full_name AS approved_name
         FROM order_discounts d
         LEFT JOIN users ua ON ua.id = d.applied_by_user_id
         LEFT JOIN users up ON up.id = d.approved_by_user_id
        WHERE d.order_id IN (SELECT value FROM json_each(?)) AND d.deleted_at IS NULL
        ORDER BY d.created_at, d.id`,
    )
    .all(list) as Row[];
  const terms = db
    .prepare(
      `SELECT order_id, commission_cents, fixed_fee_cents, commission_tax_cents, expected_payout_cents, deal_label, updated_at
         FROM order_channel_terms
        WHERE order_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL`,
    )
    .all(list) as Row[];

  const group = <T extends Row>(rows: T[], key: string) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const k = String(r[key]);
      const a = m.get(k);
      if (a) a.push(r);
      else m.set(k, [r]);
    }
    return m;
  };
  const itemsBy = group(items, 'order_id');
  const modsBy = group(mods, 'order_item_id');
  const costBy = new Map(costs.map((c) => [String(c['order_item_id']), c]));
  const paysBy = group(payments, 'order_id');
  const discBy = group(discounts, 'order_id');
  const termsBy = new Map(terms.map((t) => [String(t['order_id']), t]));

  return orders.map((o) => {
    const id = String(o['id']);
    const stamps: string[] = [String(o['updated_at'])];
    const lines: DashOrderLine[] = (itemsBy.get(id) ?? []).map((l) => {
      const lineId = String(l['id']);
      stamps.push(String(l['updated_at']));
      const choices = (modsBy.get(lineId) ?? []).map((m) => {
        stamps.push(String(m['updated_at']));
        return { name: clip(String(m['modifier_name'] ?? ''), 160) ?? '', priceDeltaCents: num(m['price_delta_cents']) };
      });
      const cost = costBy.get(lineId);
      if (cost) stamps.push(String(cost['updated_at']));
      const name = String(l['menu_item_name'] ?? '');
      return {
        id: lineId,
        name: clip(name, 200) ?? '',
        category: clip(str(l['category_name']), 120),
        menuItemId: str(l['menu_item_id']),
        qty: num(l['quantity']),
        unitPriceCents: num(l['unit_price_cents']),
        lineTotalCents: num(l['line_total_cents']),
        choices: choices.slice(0, 60),
        note: clip(str(l['notes']), 500),
        isFee: isDeliveryChargeMenuItem({ id: str(l['menu_item_id']) ?? '', name }, feeItems),
        costCents: cost ? num(cost['cost']) : null,
      };
    });
    const pays: DashPayment[] = (paysBy.get(id) ?? []).map((p) => {
      stamps.push(String(p['updated_at']));
      const method = String(p['method']) as DashPaymentMethod;
      return {
        id: String(p['id']),
        method: METHODS.has(method) ? method : 'cash',
        amountCents: num(p['amount_cents']),
        tenderedCents: numOrNull(p['tendered_cents']),
        at: iso(p['paid_at']) ?? iso(p['created_at']) ?? new Date(0).toISOString(),
        by: clip(str(p['by_name']), 80),
        shiftId: str(p['shift_id']) ?? str(o['shift_id']),
      };
    });
    const discs: DashDiscount[] = (discBy.get(id) ?? []).map((d) => {
      stamps.push(String(d['updated_at']));
      return {
        kind: String(d['discount_type'] ?? ''),
        value: Number(d['value'] ?? 0),
        amountCents: num(d['amount_cents']),
        reason: clip(str(d['reason']), 300),
        source: str(d['source']),
        by: clip(str(d['by_name']), 80),
        approvedBy: clip(str(d['approved_name']), 80),
        at: iso(d['created_at']) ?? new Date(0).toISOString(),
      };
    });
    const t = termsBy.get(id);
    if (t) stamps.push(String(t['updated_at']));

    const status = String(o['status']) as DashOrderStatus;
    const mode = String(o['mode']) as DashOrderMode;
    const source = o['source'] === 'web' ? 'web' : 'pos';
    const createdAt = iso(o['created_at']) ?? new Date(0).toISOString();
    const paidAt = iso(o['paid_at']);
    const deletedAt = str(o['deleted_at']);
    const refunded = pays.filter((p) => p.amountCents < 0).reduce((s, p) => s - p.amountCents, 0);
    const total = num(o['total_cents']);
    const cameBy = String(o['came_by'] ?? '') as DashCameBy;
    const { address, area } = addressOf(o['delivery_address_snapshot']);
    const customerName = str(o['customer_name_snapshot']);
    const customerPhone = str(o['customer_phone_snapshot']);
    const notes = [str(o['notes']), str(o['delivery_notes'])].filter(Boolean).join('\n');
    const docUpdatedAt = stamps.filter(Boolean).sort().at(-1) ?? createdAt;
    return {
      id,
      deviceId: String(o['device_id']),
      number: String(o['order_number']),
      status: STATUSES.has(status) ? status : 'open',
      mode: MODES.has(mode) ? mode : 'takeaway',
      source,
      channel: channelOf(mode, source),
      cameBy: CAME_BY.has(cameBy) ? cameBy : null,
      createdAt,
      sentAt: iso(o['sent_at']),
      paidAt,
      dispatchedAt: iso(o['dispatched_at']),
      deliveredAt: iso(o['delivered_at']),
      voidedAt: iso(o['voided_at']),
      docUpdatedAt: iso(docUpdatedAt) ?? createdAt,
      tradingDay: dashTradingDay(createdAt),
      hour: dashKarachiHour(createdAt),
      // Reports' COUNTED (analytics/sql.ts): live, paid, neither cancelled nor refunded in full.
      counted: deletedAt === null && paidAt !== null && status !== 'void' && status !== 'refunded',
      deleted: deletedAt === null ? null : o['delete_kind'] === 'test' ? 'test' : 'discarded',
      subtotalCents: num(o['subtotal_cents']),
      discountCents: num(o['discount_cents']),
      taxCents: num(o['tax_cents']),
      totalCents: total,
      refundedCents: refunded,
      netCents: total - refunded,
      digitalTotalCents: numOrNull(o['digital_total_cents']),
      riderKeepsCents: numOrNull(o['rider_keeps_cents']),
      customer:
        customerName || customerPhone || address || area
          ? { name: clip(customerName, 120), phone: clip(customerPhone, 40), address: clip(address, 400), area: clip(area, 120) }
          : null,
      notes: clip(notes || null, 1_000),
      cashier: source === 'web' ? null : clip(str(o['cashier_name']), 80),
      rider: clip(str(o['rider_name']), 80),
      voidedBy: clip(str(o['voided_by_name']), 80),
      voidReason: clip(str(o['void_reason']), 300),
      deletedBy: clip(str(o['deleted_by_name']), 80),
      deleteReason: clip(str(o['delete_reason']), 300),
      shiftId: str(o['shift_id']),
      lines: lines.slice(0, 200),
      payments: pays.slice(0, 50),
      discounts: discs.slice(0, 20),
      foodpanda: t
        ? {
            commissionCents:
              t['commission_cents'] === null && t['fixed_fee_cents'] === null
                ? null
                : num(t['commission_cents']) + num(t['fixed_fee_cents']) + num(t['commission_tax_cents']),
            expectedPayoutCents: numOrNull(t['expected_payout_cents']),
            dealLabel: clip(str(t['deal_label']), 120),
          }
        : null,
    };
  });
}

/** A short fingerprint of a document, so one unchanged since the last push is not sent again. */
export function docHash(doc: unknown): string {
  return createHash('sha1').update(JSON.stringify(doc)).digest('base64url');
}

// ---------------------------------------------------------------------------
// Shifts, cash, the drawer log, stock movements
// ---------------------------------------------------------------------------

function parseJson(raw: unknown): unknown {
  const text = str(raw);
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The key condition on a table's own rows (alias `t`): after (at, id) in (updated_at, id) order. */
const AFTER = (t: string) => `${t}.updated_at >= @at AND (${t}.updated_at > @at OR ${t}.id > @id)`;

export function changedShifts(db: AppDatabase, after: LookKey, limit: number): DashShiftDoc[] {
  const rows = db
    .prepare(
      `SELECT s.*, uo.full_name AS opened_name, uc.full_name AS closed_name
         FROM shifts s
         LEFT JOIN users uo ON uo.id = s.opened_by_user_id
         LEFT JOIN users uc ON uc.id = s.closed_by_user_id
        WHERE ${AFTER('s')} AND s.deleted_at IS NULL
        ORDER BY s.updated_at, s.id LIMIT @limit`,
    )
    .all({ at: after.at, id: after.id, limit }) as Row[];
  return rows.map((s) => ({
    id: String(s['id']),
    deviceId: String(s['device_id']),
    openedAt: iso(s['opened_at']) ?? new Date(0).toISOString(),
    openedBy: clip(str(s['opened_name']), 80),
    openingCashCents: num(s['opening_cash_cents']),
    closedAt: iso(s['closed_at']),
    closedBy: clip(str(s['closed_name']), 80),
    expectedCashCents: numOrNull(s['expected_cash_cents']),
    countedCashCents: numOrNull(s['counted_cash_cents']),
    varianceCents: numOrNull(s['variance_cents']),
    openNote: clip(str(s['notes']), 1_000),
    closeNote: clip(str(s['close_notes']), 1_000),
    carriedUnpaidCount: num(s['carried_unpaid_count']),
    carryOverReason: clip(str(s['carry_over_reason']), 500),
    countedNotes: parseJson(s['counted_notes_json']),
    closeReport: parseJson(s['close_report_json']),
    updatedAt: iso(s['updated_at']) ?? new Date(0).toISOString(),
  }));
}

export function changedCashMoves(db: AppDatabase, after: LookKey, limit: number): DashCashMove[] {
  const rows = db
    .prepare(
      `SELECT c.*, u.full_name AS by_name, a.full_name AS approved_name, s.device_id AS shift_device
         FROM cash_movements c
         LEFT JOIN users u ON u.id = c.user_id
         LEFT JOIN users a ON a.id = c.approved_by_user_id
         LEFT JOIN shifts s ON s.id = c.shift_id
        WHERE ${AFTER('c')}
        ORDER BY c.updated_at, c.id LIMIT @limit`,
    )
    .all({ at: after.at, id: after.id, limit }) as Row[];
  return rows.map((c) => ({
    id: String(c['id']),
    shiftId: String(c['shift_id']),
    deviceId: String(c['shift_device'] ?? c['device_id']),
    type: c['type'] === 'payin' ? 'payin' : c['type'] === 'tip_out' ? 'tip_out' : 'payout',
    amountCents: num(c['amount_cents']),
    reason: clip(String(c['reason'] ?? ''), 500) ?? '',
    by: clip(str(c['by_name']), 80),
    approvedBy: clip(str(c['approved_name']), 80),
    orderId: str(c['order_id']),
    purchase: str(c['ref_purchase_order_id']) !== null,
    createdAt: iso(c['created_at']) ?? new Date(0).toISOString(),
    deleted: str(c['deleted_at']) !== null,
    updatedAt: iso(c['updated_at']) ?? new Date(0).toISOString(),
  }));
}

export function changedDrawerOpens(db: AppDatabase, after: LookKey, limit: number): DashDrawerOpen[] {
  const rows = db
    .prepare(
      `SELECT d.*, u.full_name AS by_name, a.full_name AS approved_name
         FROM drawer_opens d
         LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN users a ON a.id = d.approved_by_user_id
        WHERE ${AFTER('d')} AND d.deleted_at IS NULL
        ORDER BY d.updated_at, d.id LIMIT @limit`,
    )
    .all({ at: after.at, id: after.id, limit }) as Row[];
  return rows.map((d) => ({
    id: String(d['id']),
    shiftId: str(d['shift_id']),
    deviceId: String(d['device_id']),
    kind: clip(String(d['kind'] ?? ''), 40) ?? '',
    reason: clip(str(d['reason']), 500),
    by: clip(str(d['by_name']), 80),
    approvedBy: clip(str(d['approved_name']), 80),
    orderId: str(d['order_id']),
    amountCents: numOrNull(d['amount_cents']),
    outcome: clip(str(d['outcome']), 40),
    createdAt: iso(d['created_at']) ?? new Date(0).toISOString(),
    updatedAt: iso(d['updated_at']) ?? new Date(0).toISOString(),
  }));
}

const STOCK_REASONS = new Set(['sale', 'delivery', 'waste', 'count', 'transfer', 'adjustment']);

/**
 * Stock movements changed after the key that happened in the last
 * DASH_STOCK_MOVES_DAYS (the history stops there: the dashboard lists recent
 * ones; on-hand counts come with the stock list).
 */
export function changedStockMoves(db: AppDatabase, after: LookKey, limit: number, now: Date): DashStockMove[] {
  const oldest = new Date(now.getTime() - DASH_STOCK_MOVES_DAYS * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT m.*, i.name AS ingredient_name, i.unit AS ingredient_unit, u.full_name AS by_name
         FROM stock_movements m
         LEFT JOIN ingredients i ON i.id = m.ingredient_id
         LEFT JOIN users u ON u.id = m.actor_user_id
        WHERE ${AFTER('m')} AND m.occurred_at >= @oldest
        ORDER BY m.updated_at, m.id LIMIT @limit`,
    )
    .all({ at: after.at, id: after.id, oldest, limit }) as Row[];
  return rows.map((m) => {
    const reason = String(m['reason']);
    return {
      id: String(m['id']),
      deviceId: String(m['device_id']),
      ingredientId: String(m['ingredient_id']),
      ingredient: clip(str(m['ingredient_name']), 200) ?? 'Ingredient',
      delta: Number(m['delta_qty'] ?? 0),
      unit: clip(str(m['unit']) ?? str(m['ingredient_unit']) ?? '', 20) ?? '',
      reason: (STOCK_REASONS.has(reason) ? reason : 'adjustment') as DashStockMove['reason'],
      detail: clip(str(m['detail']), 120),
      valueCents: numOrNull(m['value_cents']),
      orderId: str(m['ref_order_id']),
      note: clip(str(m['notes']), 500),
      by: clip(str(m['by_name']), 80),
      at: iso(m['occurred_at']) ?? iso(m['created_at']) ?? new Date(0).toISOString(),
      deleted: str(m['deleted_at']) !== null,
      updatedAt: iso(m['updated_at']) ?? new Date(0).toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Snapshots: this till's stock list and menu
// ---------------------------------------------------------------------------

/** Every ingredient with this till's own count (ingredients.current_qty is per till). */
export function stockSnapshot(db: AppDatabase): DashStockItem[] {
  const rows = db
    .prepare(
      `SELECT id, name, unit, category, current_qty, low_threshold, cost_per_unit_cents, pack_size, pack_price_cents,
              price_kind, count_weekly, batch_yield, is_active
         FROM ingredients WHERE deleted_at IS NULL ORDER BY name`,
    )
    .all() as Row[];
  return rows.map((i) => {
    const packSize = Number(i['pack_size'] ?? 0);
    const packPrice = numOrNull(i['pack_price_cents']);
    const perUnit = numOrNull(i['cost_per_unit_cents']);
    // The price book's exact pack (Rs 2,250 for 6 kg = Rs 375 a kg), else the old per-unit price.
    const perThousand =
      packPrice !== null && packSize > 0 ? Math.round((packPrice * 1000) / packSize) : perUnit !== null && perUnit > 0 ? perUnit * 1000 : null;
    return {
      id: String(i['id']),
      name: clip(String(i['name'] ?? ''), 200) ?? '',
      unit: clip(String(i['unit'] ?? ''), 20) ?? '',
      category: clip(str(i['category']), 120),
      onHand: Number(i['current_qty'] ?? 0),
      lowAt: i['low_threshold'] === null || i['low_threshold'] === undefined ? null : Number(i['low_threshold']),
      pricePerThousandCents: perThousand,
      priceKind: clip(str(i['price_kind']), 20),
      keyItem: num(i['count_weekly']) === 1,
      batch: i['batch_yield'] !== null && i['batch_yield'] !== undefined,
      active: num(i['is_active']) === 1,
    };
  });
}

/** The newest change to anything the stock list shows (a count moves with every movement row). */
export function stockChangedAt(db: AppDatabase): string | null {
  const row = db
    .prepare(
      `SELECT MAX(u) AS at FROM (
         SELECT MAX(updated_at) AS u FROM ingredients
         UNION ALL SELECT MAX(updated_at) FROM stock_movements
       )`,
    )
    .get() as { at: string | null } | undefined;
  return row?.at ?? null;
}

/** The newest change to the menu or to what its dishes cost (prices, recipes). */
export function menuChangedAt(db: AppDatabase): string | null {
  const row = db
    .prepare(
      `SELECT MAX(u) AS at FROM (
         SELECT MAX(updated_at) AS u FROM menu_items
         UNION ALL SELECT MAX(updated_at) FROM categories
         UNION ALL SELECT MAX(updated_at) FROM tax_categories
         UNION ALL SELECT MAX(updated_at) FROM recipes
         UNION ALL SELECT MAX(updated_at) FROM ingredient_costs
       )`,
    )
    .get() as { at: string | null } | undefined;
  return row?.at ?? null;
}

/**
 * The menu as this till holds it: every category and item (live rows), with
 * the item's tax rate and a typical plate's cost from Costing (null when the
 * dish can't be costed, or Costing could not be read).
 */
export function menuSnapshot(db: AppDatabase, now: Date): DashMenu {
  const cats = db
    .prepare(`SELECT id, name, display_order, is_active, is_on_website FROM categories WHERE deleted_at IS NULL`)
    .all() as Row[];
  const items = db
    .prepare(
      `SELECT mi.id, mi.category_id, mi.name, mi.base_price_cents, mi.is_active, mi.web_availability, mi.sort_order,
              t.rate_bps
         FROM menu_items mi
         LEFT JOIN tax_categories t ON t.id = mi.tax_category_id
        WHERE mi.deleted_at IS NULL`,
    )
    .all() as Row[];
  const cost = new Map<string, number>();
  try {
    for (const r of getMenuCosts(db, now).rows) if (r.hasRecipe && r.missingLines === 0) cost.set(r.menuItemId, r.costCents);
  } catch {
    // Costs are an extra: the menu goes without them.
  }
  return {
    categories: cats.map((c) => ({
      id: String(c['id']),
      name: clip(String(c['name'] ?? ''), 120) ?? '',
      displayOrder: num(c['display_order']),
      active: num(c['is_active']) === 1,
      onWebsite: c['is_on_website'] === null || c['is_on_website'] === undefined ? true : num(c['is_on_website']) === 1,
    })),
    items: items.map((i) => {
      const web = String(i['web_availability'] ?? 'on');
      return {
        id: String(i['id']),
        categoryId: str(i['category_id']),
        name: clip(String(i['name'] ?? ''), 200) ?? '',
        priceCents: num(i['base_price_cents']),
        active: num(i['is_active']) === 1,
        web: (web === 'off' || web === 'pickup_only' ? web : 'on') as 'on' | 'off' | 'pickup_only',
        taxRateBps: numOrNull(i['rate_bps']),
        sortOrder: num(i['sort_order']),
        costCents: cost.get(String(i['id'])) ?? null,
      };
    }),
    updatedAt: menuChangedAt(db) ?? now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Day figures: the till's own Reports for one trading day
// ---------------------------------------------------------------------------

/** The trading days this till has orders on (UTC dates), oldest first. */
export function daysWithOrders(db: AppDatabase): string[] {
  return (
    db.prepare(`SELECT DISTINCT substr(created_at, 1, 10) AS day FROM orders WHERE deleted_at IS NULL ORDER BY day`).all() as Array<{ day: string }>
  ).map((r) => r.day);
}

/**
 * One trading day's food cost, waste and profit, from the till's own Reports
 * builders (Food cost & stock; Profit) for that day alone: every figure kept
 * is a sum, so the website adds days. A day's Profit that fails leaves
 * `profit` null (the food figures still go).
 */
export function dayFigures(db: AppDatabase, day: string, now: Date, shopWide: boolean): DashDayFigures {
  const sinceIso = `${day}T00:00:00.000Z`;
  const untilIso = new Date(Date.parse(sinceIso) + 86_400_000).toISOString();
  const fs = buildReportTab(db, 'foodStock', { sinceIso, untilIso }, now) as ReportTabFigures<'foodStock'>;
  const f = fs.foodCost;
  let profit: DashDayFigures['profit'] = null;
  try {
    const p = buildReportTab(db, 'profit', { sinceIso, untilIso }, now) as ReportTabFigures<'profit'>;
    profit = {
      profitCents: p.profitCents,
      steps: p.steps.map((s) => ({ key: s.key, cents: s.cents })),
      unknownSalesCents: p.unknownSalesCents,
      estimatedOrders: p.estimatedOrders,
    };
  } catch {
    profit = null;
  }
  return {
    day,
    shopWide,
    food: {
      foodSalesCents: f.foodSalesCents,
      feeSalesCents: f.feeSalesCents,
      costOfSalesCents: f.costOfSalesCents,
      knownSalesCents: f.knownSalesCents,
      knownCostCents: f.knownCostCents,
      knownMenuSalesCents: f.knownMenuSalesCents,
      estimatedOrders: f.estimatedOrders,
      estimatedCostCents: f.estimatedCostCents,
      missingSalesCents: f.missingSalesCents,
      wasteCents: f.wasteCents,
      cancelledWasteCents: f.cancelledWasteCents,
      wasteByReason: f.wasteByReason.slice(0, 60).map((w) => ({ reason: String(w.reason), times: w.times, cents: w.cents })),
    },
    profit,
    purchasesCents: fs.purchases.spendCents,
    workedOutAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// The till right now
// ---------------------------------------------------------------------------

/**
 * This till's open shift with the close box's figures, its board, and its
 * low stock. The website switch and the unprinted tickets come from the
 * bridge (`web`, `notPrinted`), which knows them.
 */
export function liveBlock(
  db: AppDatabase,
  deviceId: string,
  now: Date,
  extra: { web: DashLive['web']; notPrinted: number },
): DashLive {
  let shift: DashLive['shift'] = null;
  const open = getCurrentShift(db, deviceId);
  if (open) {
    try {
      const s = getShiftSummary(db, open.id);
      shift = {
        id: open.id,
        openedAt: iso(open.openedAt) ?? now.toISOString(),
        openedBy: clip(open.openedByName ?? null, 80),
        openingCashCents: num(open.openingCashCents),
        cashSalesCents: num(s.cashSalesCents),
        cashRefundsCents: num(s.cashRefundsCents),
        cashInCents: num(s.cashInCents),
        cashOutCents: num(s.cashOutCents),
        expectedCashCents: num(s.expectedCashCents),
      };
    } catch {
      shift = null;
    }
  }
  const since = new Date(now.getTime() - 3 * 86_400_000).toISOString();
  const b = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status IN ('sent_to_kitchen', 'preparing') THEN 1 ELSE 0 END) AS kitchen,
         SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
         SUM(CASE WHEN status = 'out_for_delivery' THEN 1 ELSE 0 END) AS out_,
         SUM(CASE WHEN status IN ('served', 'delivered') AND paid_at IS NULL THEN 1 ELSE 0 END) AS unpaid,
         MIN(CASE WHEN status IN ('sent_to_kitchen', 'preparing', 'ready') THEN COALESCE(sent_at, created_at) END) AS oldest
        FROM orders
       WHERE deleted_at IS NULL AND created_at >= ?`,
    )
    .get(since) as { kitchen: number | null; ready: number | null; out_: number | null; unpaid: number | null; oldest: string | null };
  const low = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ingredients
        WHERE deleted_at IS NULL AND is_active = 1 AND low_threshold IS NOT NULL AND current_qty <= low_threshold`,
    )
    .get() as { n: number };
  return {
    shift,
    board: {
      kitchen: num(b.kitchen),
      ready: num(b.ready),
      out: num(b.out_),
      unpaidHandedOver: num(b.unpaid),
      oldestWaitingSince: iso(b.oldest),
    },
    web: extra.web,
    notPrinted: extra.notPrinted,
    lowStock: num(low.n),
  };
}
