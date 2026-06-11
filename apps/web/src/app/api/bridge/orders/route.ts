import { sql } from '@/lib/db';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';

export const dynamic = 'force-dynamic';

/**
 * Bridge: POS polls for new (not-yet-imported) web orders.
 * Returns oldest-first so the kitchen sees them in placement order.
 */
export async function GET(req: Request): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    // Temporary diagnostic: ?debug=1 reports what THIS function's DB
    // connection actually sees (total rows + status breakdown + which DB
    // host), to explain why a correct query returns 0 while the rows exist.
    const url = new URL(req.url);
    if (url.searchParams.get('debug') === '1') {
      const total = (await sql()`SELECT count(*)::int AS n FROM web_orders`) as Array<{
        n: number;
      }>;
      const byStatus = (await sql()`
        SELECT status, count(*)::int AS n FROM web_orders GROUP BY status
      `) as Array<{ status: string; n: number }>;
      const dbHost = (await sql()`SELECT inet_server_addr()::text AS addr, current_database() AS db`) as Array<{
        addr: string | null;
        db: string;
      }>;
      return Response.json({
        ok: true,
        debug: { total: total[0]?.n ?? null, byStatus, db: dbHost[0] ?? null },
      });
    }
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
