import { sql } from '@/lib/db';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';

export const dynamic = 'force-dynamic';
// Force every DB query in this route to hit the live database. Without this,
// Next/Vercel caches the Neon driver's fetch (keyed by the SQL string) in the
// persistent Data Cache and serves a stale empty result across deployments.
export const fetchCache = 'force-no-store';
export const revalidate = 0;

/**
 * Bridge: POS polls for new (not-yet-imported) web orders.
 * Returns oldest-first so the kitchen sees them in placement order.
 */
export async function GET(req: Request): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    const rows = (await sql()`
      SELECT id, status, customer_name, customer_phone, address_line, area,
             notes, items_json, subtotal_cents, tax_cents, total_cents,
             payment_method, created_at
        FROM web_orders
       WHERE status = 'new'
       ORDER BY created_at ASC
       LIMIT 25
    `) as Array<Record<string, unknown>>;
    const orders = rows.map((r) => ({
      id: r['id'],
      status: r['status'],
      customerName: r['customer_name'],
      customerPhone: r['customer_phone'],
      addressLine: r['address_line'],
      area: r['area'],
      notes: r['notes'],
      items: r['items_json'],
      subtotalCents: r['subtotal_cents'],
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
