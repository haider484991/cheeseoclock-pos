/**
 * Pure SQL building for the Order History page (`orders:history`). No
 * database handle here, so the rules are unit-tested in plain Vitest (the
 * better-sqlite3 build targets Electron's ABI and cannot open under node).
 *
 * Every fragment assumes `orders` is aliased `o`. Sub-queries use their own
 * aliases (`hp`, `ha`) so they never shadow an outer `payments p` join.
 */

import type {
  OrderHistoryChannel,
  OrderHistoryFilter,
  OrderHistoryStatusGroup,
  OrderStatus,
  PaymentMethod,
} from '@cheeseoclock/shared-types';

export const HISTORY_DEFAULT_LIMIT = 50;
export const HISTORY_MAX_LIMIT = 200;

/** With the kitchen or on the road. */
export const IN_PROGRESS_STATUSES: readonly OrderStatus[] = [
  'sent_to_kitchen',
  'preparing',
  'ready',
  'out_for_delivery',
];
/** Handed over to the customer. */
export const DONE_STATUSES: readonly OrderStatus[] = ['paid', 'served', 'delivered'];

const PAYMENT_METHODS: readonly PaymentMethod[] = [
  'cash',
  'card',
  'easypaisa',
  'jazzcash',
  'bank_transfer',
  'foodpanda',
];

/**
 * A PLACED order: anything past the till cart. `open` is a cart still being
 * rung up (tender and Send to kitchen both move it on), so it never shows.
 *
 * A cart that was voided while still open (older builds let Order History
 * cancel a cart) was never placed either; its void audit row records the
 * `open` status it came from. Orders synced from another till have no local
 * audit row and stay listed — showing too much beats hiding a real order.
 */
export const PLACED_ORDER_SQL = `o.deleted_at IS NULL AND o.status <> 'open'
  AND NOT (o.status = 'void' AND EXISTS (
    SELECT 1 FROM audit_log ha
     WHERE ha.entity_type = 'orders' AND ha.entity_id = o.id AND ha.action = 'void'
       AND (CASE WHEN json_valid(ha.before_json)
                 THEN json_extract(ha.before_json, '$.status') END) = 'open'))`;

/**
 * An order's total less any money handed back — the same rule Reports uses,
 * so History's "Sales" matches the Reports page for the same days.
 */
export const NET_TOTAL_SQL = `(o.total_cents + COALESCE((SELECT SUM(hp.amount_cents) FROM payments hp
  WHERE hp.order_id = o.id AND hp.amount_cents < 0 AND hp.deleted_at IS NULL), 0))`;

/** Paid, and not cancelled or refunded: a sale. */
export const IS_SALE_SQL = `(o.paid_at IS NOT NULL AND o.status NOT IN ('void', 'refunded'))`;
/** Placed, still owed. */
export const IS_NOT_PAID_SQL = `(o.paid_at IS NULL AND o.status NOT IN ('void', 'refunded'))`;

// ------------------------------------------------------------------ search --

export type HistorySearch =
  | { kind: 'none' }
  /** "42", "#42", "0042": the daily order number. */
  | { kind: 'orderNo'; n: number }
  /** Five or more digits: a phone number (any format), or an order-number prefix (a date). */
  | { kind: 'digits'; digits: string; phoneCore: string }
  /** Anything else: part of a name, a phone or a full order number. */
  | { kind: 'text'; text: string };

/**
 * The part of a Pakistani phone number every format shares: "0300 1234567",
 * "+92 300 1234567" and "923001234567" all become "3001234567".
 */
export function phoneCore(digits: string): string {
  if (digits.startsWith('0092')) return digits.slice(4);
  if (digits.startsWith('92') && digits.length >= 11) return digits.slice(2);
  if (digits.startsWith('0')) return digits.slice(1);
  return digits;
}

export function parseHistorySearch(raw: string | undefined): HistorySearch {
  const q = (raw ?? '').trim();
  if (!q) return { kind: 'none' };
  // A full order number as printed on the receipt ("20260926-0042").
  if (/^\d{8}-\d+$/.test(q)) return { kind: 'text', text: q };
  const noHash = q.replace(/^#\s*/, '');
  const compact = noHash.replace(/[\s\-()+.]/g, '');
  if (/^\d+$/.test(compact)) {
    if (compact.length <= 4) return { kind: 'orderNo', n: Number(compact) };
    return { kind: 'digits', digits: compact, phoneCore: phoneCore(compact) };
  }
  return { kind: 'text', text: q };
}

/** LIKE '%text%' with the user's own % _ \ taken literally (pair with ESCAPE '\'). */
export function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Phone column with spaces, dashes, + and brackets taken out. */
const PHONE_DIGITS_SQL = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
  IFNULL(o.customer_phone_snapshot, ''), ' ', ''), '-', ''), '+', ''), '(', ''), ')', ''), '.', '')`;

function searchCondition(s: HistorySearch): { sql: string; params: unknown[] } | null {
  switch (s.kind) {
    case 'none':
      return null;
    case 'orderNo':
      return {
        sql: `CAST(substr(o.order_number, instr(o.order_number, '-') + 1) AS INTEGER) = ?`,
        params: [s.n],
      };
    case 'digits':
      return {
        sql: `(${PHONE_DIGITS_SQL} LIKE ? OR o.order_number LIKE ?)`,
        params: [`%${s.phoneCore}%`, `${s.digits}%`],
      };
    case 'text': {
      const like = likeContains(s.text);
      return {
        sql: `(IFNULL(o.customer_name_snapshot, '') LIKE ? ESCAPE '\\'
           OR o.order_number LIKE ? ESCAPE '\\'
           OR IFNULL(o.customer_phone_snapshot, '') LIKE ? ESCAPE '\\')`,
        params: [like, like, like],
      };
    }
  }
}

// ----------------------------------------------------------------- filters --

function statusGroupCondition(g: OrderHistoryStatusGroup | undefined): { sql: string; params: unknown[] } | null {
  switch (g) {
    case 'in_progress':
      return { sql: `o.status IN (${IN_PROGRESS_STATUSES.map(() => '?').join(', ')})`, params: [...IN_PROGRESS_STATUSES] };
    case 'done':
      return { sql: `o.status IN (${DONE_STATUSES.map(() => '?').join(', ')})`, params: [...DONE_STATUSES] };
    case 'not_paid':
      return { sql: IS_NOT_PAID_SQL, params: [] };
    case 'cancelled':
      return { sql: `o.status = 'void'`, params: [] };
    case 'refunded':
      return {
        sql: `(o.status = 'refunded' OR EXISTS (SELECT 1 FROM payments hp
                WHERE hp.order_id = o.id AND hp.deleted_at IS NULL AND hp.amount_cents < 0))`,
        params: [],
      };
    default:
      // 'all', undefined, or anything unknown from the renderer.
      return null;
  }
}

function channelCondition(c: OrderHistoryChannel | undefined): { sql: string; params: unknown[] } | null {
  switch (c) {
    case 'takeaway':
    case 'delivery':
    case 'foodpanda':
      return { sql: 'o.mode = ?', params: [c] };
    case 'web':
      return { sql: `(o.source = 'web' OR o.mode = 'online')`, params: [] };
    default:
      return null;
  }
}

function paymentCondition(m: OrderHistoryFilter['paymentMethod']): { sql: string; params: unknown[] } | null {
  if (!m || m === 'all' || !PAYMENT_METHODS.includes(m)) return null;
  return {
    sql: `EXISTS (SELECT 1 FROM payments hp
            WHERE hp.order_id = o.id AND hp.deleted_at IS NULL AND hp.amount_cents > 0 AND hp.method = ?)`,
    params: [m],
  };
}

/** WHERE clause (without the keyword) + its parameters for a history filter. */
export function buildOrderHistoryWhere(filter: OrderHistoryFilter | undefined): {
  sql: string;
  params: unknown[];
} {
  const parts: string[] = [PLACED_ORDER_SQL];
  const params: unknown[] = [];
  const add = (c: { sql: string; params: unknown[] } | null): void => {
    if (!c) return;
    parts.push(c.sql);
    params.push(...c.params);
  };
  const f = filter ?? {};
  if (f.sinceIso) add({ sql: 'o.created_at >= ?', params: [f.sinceIso] });
  if (f.untilIso) add({ sql: 'o.created_at < ?', params: [f.untilIso] });
  add(statusGroupCondition(f.statusGroup));
  add(channelCondition(f.channel));
  add(paymentCondition(f.paymentMethod));
  add(searchCondition(parseHistorySearch(f.search)));
  return { sql: parts.join('\n   AND '), params };
}

/** Page size and offset, clamped to sane whole numbers. */
export function historyPage(filter: OrderHistoryFilter | undefined): { limit: number; offset: number } {
  const rawLimit = Math.floor(Number(filter?.limit ?? HISTORY_DEFAULT_LIMIT));
  const rawOffset = Math.floor(Number(filter?.offset ?? 0));
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), HISTORY_MAX_LIMIT) : HISTORY_DEFAULT_LIMIT;
  const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;
  return { limit, offset };
}

/**
 * "cash:120000,card:50000,cash:3000" (one entry per payment taken) → the
 * methods used, largest amount first.
 */
export function methodsFromLegs(legs: string | null | undefined): PaymentMethod[] {
  if (!legs) return [];
  const byMethod = new Map<PaymentMethod, number>();
  for (const leg of legs.split(',')) {
    const [method, amount] = leg.split(':');
    if (!method || !PAYMENT_METHODS.includes(method as PaymentMethod)) continue;
    const m = method as PaymentMethod;
    byMethod.set(m, (byMethod.get(m) ?? 0) + (Number(amount) || 0));
  }
  return [...byMethod.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
}
