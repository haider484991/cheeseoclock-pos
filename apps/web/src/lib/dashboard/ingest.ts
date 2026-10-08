import { DASH_DAYS_KNOWN_MAX } from '@cheeseoclock/shared-types';
import type {
  DashCashMove,
  DashDayFigures,
  DashDrawerOpen,
  DashMenu,
  DashOrderDoc,
  DashPushBody,
  DashPushCursors,
  DashPushResult,
  DashPushState,
  DashShiftDoc,
  DashStockItem,
  DashStockMove,
} from '@cheeseoclock/shared-types';
import { sql } from '@/lib/db';
import { ensureDashSchema } from './schema';

/**
 * A till's push, kept (shared-types dashboard.ts DASHBOARD PUSH). Each kind
 * of row is ONE statement over the whole batch (jsonb_to_recordset), so a
 * batch is kept whole or not at all, and the till's row (its cursors) is
 * written LAST: the till moves on only once everything it sent is kept.
 * A failure part-way leaves the cursors where they were, and the till
 * sends the same rows again — every write is an upsert on the till's own
 * id, so a re-send overwrites, never doubles.
 *
 * Newest copy wins: an order or shift is replaced only by a copy at least as
 * new (doc_updated_at / updated_at), so two linked tills sending the same
 * order in either order end with the newer one.
 */

const json = (v: unknown) => JSON.stringify(v);

/** The newest copy of each id in the batch (one INSERT … ON CONFLICT can't touch a row twice). */
function newestById<T extends { id: string }>(rows: readonly T[], stamp: (r: T) => string): T[] {
  const by = new Map<string, T>();
  for (const r of rows) {
    const cur = by.get(r.id);
    if (!cur || Date.parse(stamp(r)) >= Date.parse(stamp(cur))) by.set(r.id, r);
  }
  return [...by.values()];
}

function itemCountOf(o: DashOrderDoc): number {
  return o.lines.reduce((n, l) => n + (l.isFee ? 0 : l.qty), 0);
}

async function keepOrders(orders: readonly DashOrderDoc[]): Promise<number> {
  if (orders.length === 0) return 0;
  const rows = newestById(orders, (o) => o.docUpdatedAt).map((o) => ({
    id: o.id,
    device_id: o.deviceId,
    number: o.number,
    status: o.status,
    mode: o.mode,
    source: o.source,
    channel: o.channel,
    came_by: o.cameBy,
    created_at: o.createdAt,
    paid_at: o.paidAt,
    trading_day: o.tradingDay,
    hour: o.hour,
    counted: o.counted,
    deleted: o.deleted,
    subtotal_cents: o.subtotalCents,
    discount_cents: o.discountCents,
    tax_cents: o.taxCents,
    total_cents: o.totalCents,
    refunded_cents: o.refundedCents,
    net_cents: o.netCents,
    customer_name: o.customer?.name ?? null,
    customer_phone: o.customer?.phone ?? null,
    area: o.customer?.area ?? null,
    cashier: o.cashier,
    rider: o.rider,
    shift_id: o.shiftId,
    item_count: itemCountOf(o),
    doc: o,
    doc_updated_at: o.docUpdatedAt,
  }));
  const out = (await sql()`
    WITH x AS (
      SELECT * FROM jsonb_to_recordset(${json(rows)}::jsonb) AS x(
        id text, device_id text, number text, status text, mode text, source text, channel text, came_by text,
        created_at timestamptz, paid_at timestamptz, trading_day date, hour smallint, counted boolean, deleted text,
        subtotal_cents bigint, discount_cents bigint, tax_cents bigint, total_cents bigint, refunded_cents bigint,
        net_cents bigint, customer_name text, customer_phone text, area text, cashier text, rider text, shift_id text,
        item_count int, doc jsonb, doc_updated_at timestamptz)
    ), up AS (
      INSERT INTO dash_orders AS d (
        id, device_id, number, status, mode, source, channel, came_by, created_at, paid_at, trading_day, hour,
        counted, deleted, subtotal_cents, discount_cents, tax_cents, total_cents, refunded_cents, net_cents,
        customer_name, customer_phone, area, cashier, rider, shift_id, item_count, doc, doc_updated_at)
      SELECT id, device_id, number, status, mode, source, channel, came_by, created_at, paid_at, trading_day, hour,
             counted, deleted, subtotal_cents, discount_cents, tax_cents, total_cents, refunded_cents, net_cents,
             customer_name, customer_phone, area, cashier, rider, shift_id, item_count, doc, doc_updated_at
        FROM x
      ON CONFLICT (id) DO UPDATE SET
        device_id = EXCLUDED.device_id, number = EXCLUDED.number, status = EXCLUDED.status, mode = EXCLUDED.mode,
        source = EXCLUDED.source, channel = EXCLUDED.channel, came_by = EXCLUDED.came_by,
        created_at = EXCLUDED.created_at, paid_at = EXCLUDED.paid_at, trading_day = EXCLUDED.trading_day,
        hour = EXCLUDED.hour, counted = EXCLUDED.counted, deleted = EXCLUDED.deleted,
        subtotal_cents = EXCLUDED.subtotal_cents, discount_cents = EXCLUDED.discount_cents,
        tax_cents = EXCLUDED.tax_cents, total_cents = EXCLUDED.total_cents, refunded_cents = EXCLUDED.refunded_cents,
        net_cents = EXCLUDED.net_cents, customer_name = EXCLUDED.customer_name,
        customer_phone = EXCLUDED.customer_phone, area = EXCLUDED.area, cashier = EXCLUDED.cashier,
        rider = EXCLUDED.rider, shift_id = EXCLUDED.shift_id, item_count = EXCLUDED.item_count, doc = EXCLUDED.doc,
        doc_updated_at = EXCLUDED.doc_updated_at, received_at = now()
      WHERE d.doc_updated_at <= EXCLUDED.doc_updated_at
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM up`) as Array<{ n: number }>;
  return out[0]?.n ?? 0;
}

async function keepShifts(shifts: readonly DashShiftDoc[]): Promise<number> {
  if (shifts.length === 0) return 0;
  const rows = newestById(shifts, (s) => s.updatedAt).map((s) => ({
    id: s.id,
    device_id: s.deviceId,
    opened_at: s.openedAt,
    closed_at: s.closedAt,
    opened_by: s.openedBy,
    closed_by: s.closedBy,
    opening_cash_cents: s.openingCashCents,
    expected_cash_cents: s.expectedCashCents,
    counted_cash_cents: s.countedCashCents,
    variance_cents: s.varianceCents,
    doc: s,
    updated_at: s.updatedAt,
  }));
  const out = (await sql()`
    WITH x AS (
      SELECT * FROM jsonb_to_recordset(${json(rows)}::jsonb) AS x(
        id text, device_id text, opened_at timestamptz, closed_at timestamptz, opened_by text, closed_by text,
        opening_cash_cents bigint, expected_cash_cents bigint, counted_cash_cents bigint, variance_cents bigint,
        doc jsonb, updated_at timestamptz)
    ), up AS (
      INSERT INTO dash_shifts AS d (id, device_id, opened_at, closed_at, opened_by, closed_by, opening_cash_cents,
                                    expected_cash_cents, counted_cash_cents, variance_cents, doc, updated_at)
      SELECT id, device_id, opened_at, closed_at, opened_by, closed_by, opening_cash_cents,
             expected_cash_cents, counted_cash_cents, variance_cents, doc, updated_at FROM x
      ON CONFLICT (id) DO UPDATE SET
        device_id = EXCLUDED.device_id, opened_at = EXCLUDED.opened_at, closed_at = EXCLUDED.closed_at,
        opened_by = EXCLUDED.opened_by, closed_by = EXCLUDED.closed_by,
        opening_cash_cents = EXCLUDED.opening_cash_cents, expected_cash_cents = EXCLUDED.expected_cash_cents,
        counted_cash_cents = EXCLUDED.counted_cash_cents, variance_cents = EXCLUDED.variance_cents,
        doc = EXCLUDED.doc, updated_at = EXCLUDED.updated_at, received_at = now()
      WHERE d.updated_at <= EXCLUDED.updated_at
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM up`) as Array<{ n: number }>;
  return out[0]?.n ?? 0;
}

async function keepCashMoves(moves: readonly DashCashMove[]): Promise<number> {
  if (moves.length === 0) return 0;
  const rows = newestById(moves, (m) => m.updatedAt).map((m) => ({
    id: m.id,
    shift_id: m.shiftId,
    device_id: m.deviceId,
    type: m.type,
    amount_cents: m.amountCents,
    reason: m.reason,
    by_name: m.by,
    approved_by: m.approvedBy,
    order_id: m.orderId,
    purchase: m.purchase,
    created_at: m.createdAt,
    deleted: m.deleted,
    updated_at: m.updatedAt,
  }));
  const out = (await sql()`
    WITH x AS (
      SELECT * FROM jsonb_to_recordset(${json(rows)}::jsonb) AS x(
        id text, shift_id text, device_id text, type text, amount_cents bigint, reason text, by_name text,
        approved_by text, order_id text, purchase boolean, created_at timestamptz, deleted boolean, updated_at timestamptz)
    ), up AS (
      INSERT INTO dash_cash_moves AS d (id, shift_id, device_id, type, amount_cents, reason, by_name, approved_by,
                                        order_id, purchase, created_at, deleted, updated_at)
      SELECT id, shift_id, device_id, type, amount_cents, reason, by_name, approved_by, order_id, purchase,
             created_at, deleted, updated_at FROM x
      ON CONFLICT (id) DO UPDATE SET
        shift_id = EXCLUDED.shift_id, device_id = EXCLUDED.device_id, type = EXCLUDED.type,
        amount_cents = EXCLUDED.amount_cents, reason = EXCLUDED.reason, by_name = EXCLUDED.by_name,
        approved_by = EXCLUDED.approved_by, order_id = EXCLUDED.order_id, purchase = EXCLUDED.purchase,
        created_at = EXCLUDED.created_at, deleted = EXCLUDED.deleted, updated_at = EXCLUDED.updated_at
      WHERE d.updated_at <= EXCLUDED.updated_at
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM up`) as Array<{ n: number }>;
  return out[0]?.n ?? 0;
}

async function keepDrawerOpens(opens: readonly DashDrawerOpen[]): Promise<number> {
  if (opens.length === 0) return 0;
  const rows = newestById(opens, (d) => d.updatedAt).map((d) => ({
    id: d.id,
    shift_id: d.shiftId,
    device_id: d.deviceId,
    kind: d.kind,
    reason: d.reason,
    by_name: d.by,
    approved_by: d.approvedBy,
    order_id: d.orderId,
    amount_cents: d.amountCents,
    outcome: d.outcome,
    created_at: d.createdAt,
    updated_at: d.updatedAt,
  }));
  const out = (await sql()`
    WITH x AS (
      SELECT * FROM jsonb_to_recordset(${json(rows)}::jsonb) AS x(
        id text, shift_id text, device_id text, kind text, reason text, by_name text, approved_by text,
        order_id text, amount_cents bigint, outcome text, created_at timestamptz, updated_at timestamptz)
    ), up AS (
      INSERT INTO dash_drawer_opens AS d (id, shift_id, device_id, kind, reason, by_name, approved_by, order_id,
                                          amount_cents, outcome, created_at, updated_at)
      SELECT id, shift_id, device_id, kind, reason, by_name, approved_by, order_id, amount_cents, outcome,
             created_at, updated_at FROM x
      ON CONFLICT (id) DO UPDATE SET
        shift_id = EXCLUDED.shift_id, device_id = EXCLUDED.device_id, kind = EXCLUDED.kind,
        reason = EXCLUDED.reason, by_name = EXCLUDED.by_name, approved_by = EXCLUDED.approved_by,
        order_id = EXCLUDED.order_id, amount_cents = EXCLUDED.amount_cents, outcome = EXCLUDED.outcome,
        created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at
      WHERE d.updated_at <= EXCLUDED.updated_at
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM up`) as Array<{ n: number }>;
  return out[0]?.n ?? 0;
}

async function keepStockMoves(moves: readonly DashStockMove[]): Promise<number> {
  if (moves.length === 0) return 0;
  const rows = newestById(moves, (m) => m.updatedAt).map((m) => ({
    id: m.id,
    device_id: m.deviceId,
    ingredient_id: m.ingredientId,
    ingredient: m.ingredient,
    delta: m.delta,
    unit: m.unit,
    reason: m.reason,
    detail: m.detail,
    value_cents: m.valueCents,
    order_id: m.orderId,
    note: m.note,
    by_name: m.by,
    at: m.at,
    deleted: m.deleted,
    updated_at: m.updatedAt,
  }));
  const out = (await sql()`
    WITH x AS (
      SELECT * FROM jsonb_to_recordset(${json(rows)}::jsonb) AS x(
        id text, device_id text, ingredient_id text, ingredient text, delta double precision, unit text,
        reason text, detail text, value_cents bigint, order_id text, note text, by_name text, at timestamptz,
        deleted boolean, updated_at timestamptz)
    ), up AS (
      INSERT INTO dash_stock_moves AS d (id, device_id, ingredient_id, ingredient, delta, unit, reason, detail,
                                         value_cents, order_id, note, by_name, at, deleted, updated_at)
      SELECT id, device_id, ingredient_id, ingredient, delta, unit, reason, detail, value_cents, order_id, note,
             by_name, at, deleted, updated_at FROM x
      ON CONFLICT (id) DO UPDATE SET
        device_id = EXCLUDED.device_id, ingredient_id = EXCLUDED.ingredient_id, ingredient = EXCLUDED.ingredient,
        delta = EXCLUDED.delta, unit = EXCLUDED.unit, reason = EXCLUDED.reason, detail = EXCLUDED.detail,
        value_cents = EXCLUDED.value_cents, order_id = EXCLUDED.order_id, note = EXCLUDED.note,
        by_name = EXCLUDED.by_name, at = EXCLUDED.at, deleted = EXCLUDED.deleted, updated_at = EXCLUDED.updated_at
      WHERE d.updated_at <= EXCLUDED.updated_at
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM up`) as Array<{ n: number }>;
  return out[0]?.n ?? 0;
}

/** This till's whole stock list: rows it no longer has are dropped (each till keeps its own count). */
async function replaceStock(deviceId: string, items: readonly DashStockItem[]): Promise<void> {
  const rows = newestById(items, () => '1970-01-01T00:00:00.000Z').map((i) => ({
    id: i.id,
    name: i.name,
    unit: i.unit,
    category: i.category,
    on_hand: i.onHand,
    low_at: i.lowAt,
    price_per_thousand_cents: i.pricePerThousandCents,
    price_kind: i.priceKind,
    key_item: i.keyItem,
    batch: i.batch,
    active: i.active,
  }));
  await sql()`
    WITH x AS (
      SELECT * FROM jsonb_to_recordset(${json(rows)}::jsonb) AS x(
        id text, name text, unit text, category text, on_hand double precision, low_at double precision,
        price_per_thousand_cents bigint, price_kind text, key_item boolean, batch boolean, active boolean)
    ), gone AS (
      DELETE FROM dash_stock WHERE device_id = ${deviceId}::text AND id NOT IN (SELECT id FROM x) RETURNING 1
    ), up AS (
      INSERT INTO dash_stock (device_id, id, name, unit, category, on_hand, low_at, price_per_thousand_cents,
                              price_kind, key_item, batch, active, updated_at)
      SELECT ${deviceId}::text, id, name, unit, category, on_hand, low_at, price_per_thousand_cents, price_kind,
             key_item, batch, active, now() FROM x
      ON CONFLICT (device_id, id) DO UPDATE SET
        name = EXCLUDED.name, unit = EXCLUDED.unit, category = EXCLUDED.category, on_hand = EXCLUDED.on_hand,
        low_at = EXCLUDED.low_at, price_per_thousand_cents = EXCLUDED.price_per_thousand_cents,
        price_kind = EXCLUDED.price_kind, key_item = EXCLUDED.key_item, batch = EXCLUDED.batch,
        active = EXCLUDED.active, updated_at = now()
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM up)::int AS kept, (SELECT count(*) FROM gone)::int AS dropped`;
}

async function keepMenu(deviceId: string, menu: DashMenu): Promise<void> {
  await sql()`
    INSERT INTO dash_menu (device_id, doc, updated_at)
    VALUES (${deviceId}::text, ${json(menu)}::jsonb, ${menu.updatedAt}::timestamptz)
    ON CONFLICT (device_id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = EXCLUDED.updated_at, received_at = now()`;
}

async function keepDays(deviceId: string, days: readonly DashDayFigures[]): Promise<number> {
  if (days.length === 0) return 0;
  const byDay = new Map(days.map((d) => [d.day, d]));
  const rows = [...byDay.values()].map((d) => ({
    day: d.day,
    shop_wide: d.shopWide,
    doc: d,
    worked_out_at: d.workedOutAt,
  }));
  const out = (await sql()`
    WITH x AS (
      SELECT * FROM jsonb_to_recordset(${json(rows)}::jsonb) AS x(day date, shop_wide boolean, doc jsonb, worked_out_at timestamptz)
    ), up AS (
      INSERT INTO dash_days AS d (device_id, day, shop_wide, doc, worked_out_at)
      SELECT ${deviceId}::text, day, shop_wide, doc, worked_out_at FROM x
      ON CONFLICT (device_id, day) DO UPDATE SET
        shop_wide = EXCLUDED.shop_wide, doc = EXCLUDED.doc, worked_out_at = EXCLUDED.worked_out_at
      WHERE d.worked_out_at <= EXCLUDED.worked_out_at
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM up`) as Array<{ n: number }>;
  return out[0]?.n ?? 0;
}

async function keepTill(body: DashPushBody): Promise<void> {
  const t = body.till;
  await sql()`
    INSERT INTO dash_tills (device_id, device_name, app_version, last_push_at, till_sent_at, live, cursors, caught_up)
    VALUES (${t.deviceId}::text, ${t.deviceName}::text, ${t.appVersion}::text, now(), ${t.sentAt}::timestamptz,
            ${json(body.live)}::jsonb, ${json(body.cursors)}::jsonb, ${body.caughtUp}::boolean)
    ON CONFLICT (device_id) DO UPDATE SET
      device_name = EXCLUDED.device_name, app_version = EXCLUDED.app_version, last_push_at = now(),
      till_sent_at = EXCLUDED.till_sent_at, live = EXCLUDED.live, cursors = EXCLUDED.cursors,
      caught_up = EXCLUDED.caught_up`;
}

/** Keep one push, the till's own row last (see the header). */
export async function keepPush(body: DashPushBody): Promise<DashPushResult> {
  await ensureDashSchema();
  const deviceId = body.till.deviceId;
  const stored = {
    orders: await keepOrders(body.orders ?? []),
    shifts: await keepShifts(body.shifts ?? []),
    cashMoves: await keepCashMoves(body.cashMoves ?? []),
    drawerOpens: await keepDrawerOpens(body.drawerOpens ?? []),
    stockMoves: await keepStockMoves(body.stockMoves ?? []),
    days: await keepDays(deviceId, body.days ?? []),
  };
  if (body.stock) await replaceStock(deviceId, body.stock);
  if (body.menu) await keepMenu(deviceId, body.menu);
  await keepTill(body);
  return { cursors: body.cursors, stored, serverTime: new Date().toISOString() };
}

/** Where the website is up to for this till (null: it has never heard from it), and the days it holds figures for. */
export async function stateFor(deviceId: string): Promise<DashPushState> {
  await ensureDashSchema();
  const [tills, days] = await Promise.all([
    sql()`SELECT cursors FROM dash_tills WHERE device_id = ${deviceId}::text`,
    sql()`SELECT to_char(day, 'YYYY-MM-DD') AS day FROM dash_days WHERE device_id = ${deviceId}::text
           ORDER BY day DESC LIMIT ${DASH_DAYS_KNOWN_MAX}::int`,
  ]);
  return {
    cursors: (tills as Array<{ cursors: DashPushCursors | null }>)[0]?.cursors ?? null,
    daysKnown: (days as Array<{ day: string }>).map((d) => d.day),
  };
}
