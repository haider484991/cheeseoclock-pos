import { waitUntil } from '@vercel/functions';
import { sql } from '@/lib/db';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';
import { sweepComments } from '@/lib/comment-replies';
import { getShopFacts } from '@/lib/site-facts';
import { unconfirmedOrderCutoff } from '@/lib/store-status';
import { ensureWebOrderColumns } from '@/lib/web-order-columns';
import { readDiscountParts, type WebDiscountPart } from '@cheeseoclock/shared-types';

export const dynamic = 'force-dynamic';
// Force every DB query in this route to hit the live database. Without this,
// Next/Vercel caches the Neon driver's fetch (keyed by the SQL string) in the
// persistent Data Cache and serves a stale empty result across deployments.
export const fetchCache = 'force-no-store';
export const revalidate = 0;

/** A claim not acked in this long is released to any till (the first one went quiet). */
const CLAIM_TTL_SECONDS = 180;

/**
 * Bridge: POS polls for new (not-yet-imported) web orders.
 * Returns oldest-first so the kitchen sees them in placement order.
 *
 * Each order handed out is claimed for the asking till (`?device=`) in the
 * same statement. Two tills polling at once used to both get it, both import
 * it, and the kitchen cooked it twice; now the other till skips it until the
 * claim has gone stale (the first till died before acking). A till from before
 * this change sends no device and shares one claim — as before, one till.
 */
export async function GET(req: Request): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  // While the till is on it asks every few seconds: the comment auto-replies ride along, at most every 3 minutes,
  // after this answer has gone (lib/comment-replies).
  waitUntil(sweepComments(getShopFacts));
  try {
    await ensureWebOrderColumns();
    // Expire orders nobody confirmed in time BEFORE handing out the list, so
    // a till that comes back after a long outage never cooks a stale order.
    // The customer's tracker shows "couldn't confirm — please call".
    await sql()`
      UPDATE web_orders
         SET status = 'cancelled', updated_at = now()
       WHERE status = 'new' AND created_at < ${unconfirmedOrderCutoff()}
    `;
    const device = (new URL(req.url).searchParams.get('device') ?? '').slice(0, 100) || 'unknown';
    const claimed = (await sql()`
      UPDATE web_orders
         SET claimed_by = ${device}, claimed_at = now()
       WHERE id IN (
             SELECT id FROM web_orders
              WHERE status = 'new'
                AND (claimed_by IS NULL OR claimed_by = ${device}
                     OR claimed_at < now() - make_interval(secs => ${CLAIM_TTL_SECONDS}))
              ORDER BY created_at ASC
              LIMIT 25
              FOR UPDATE SKIP LOCKED)
       RETURNING id, status, customer_name, customer_phone, address_line, area,
                 notes, items_json, subtotal_cents, discount_cents, tax_cents,
                 total_cents, payment_method, fulfilment, created_at, discount_parts_json
    `) as Array<Record<string, unknown>>;
    const rows = claimed.sort(
      (a, b) => new Date(String(a['created_at'])).getTime() - new Date(String(b['created_at'])).getTime(),
    );
    const orders = rows.map((r) => ({
      ...orderFields(r),
      // v0.7.50: the parts of its discount, only on an order that has them (a till before 0.7.50 ignores the key;
      // the site only prices a category's own % while the listening till bills it).
      ...partsOf(r['discount_parts_json']),
    }));
    return Response.json({ ok: true, data: orders });
  } catch (e) {
    console.error('GET /api/bridge/orders failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}

/** The parts stored with an order (v0.7.50), as the till reads them; nothing when there are none. */
function partsOf(raw: unknown): { discountParts?: WebDiscountPart[] } {
  if (typeof raw !== 'string' || raw === '') return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return {};
  }
  const parts = readDiscountParts(v);
  return parts ? { discountParts: parts } : {};
}

/** An order as the till imports it (today's keys, in today's order). */
function orderFields(r: Record<string, unknown>) {
  return {
    id: r['id'],
    status: r['status'],
    customerName: r['customer_name'],
    customerPhone: r['customer_phone'],
    addressLine: r['address_line'],
    area: r['area'],
    notes: r['notes'],
    // A till from before pickup ignores these two; only a till that
    // announced 'pickup' is ever offered pickup orders (lib/store-status).
    fulfilment: r['fulfilment'],
    items: r['items_json'],
    subtotalCents: r['subtotal_cents'],
    discountCents: r['discount_cents'],
    taxCents: r['tax_cents'],
    totalCents: r['total_cents'],
    paymentMethod: r['payment_method'],
    createdAt: r['created_at'],
    posOrderId: null,
    posOrderNumber: null,
  };
}
