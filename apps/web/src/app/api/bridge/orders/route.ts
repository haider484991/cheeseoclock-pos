import { sql } from '@/lib/db';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';
import { unconfirmedOrderCutoff } from '@/lib/store-status';
import { ensureWebOrderColumns } from '@/lib/web-order-columns';

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
                 total_cents, payment_method, fulfilment, created_at
    `) as Array<Record<string, unknown>>;
    const rows = claimed.sort(
      (a, b) => new Date(String(a['created_at'])).getTime() - new Date(String(b['created_at'])).getTime(),
    );
    const orders = rows.map((r) => ({
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
    }));
    return Response.json({ ok: true, data: orders });
  } catch (e) {
    console.error('GET /api/bridge/orders failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
