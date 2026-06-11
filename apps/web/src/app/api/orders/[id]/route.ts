import { sql } from '@/lib/db';
import { normalizePhone } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Public: order status for the tracking page. Requires the customer's phone
 * as a query param and matches it against the stored order — prevents
 * order-id enumeration from leaking other people's addresses.
 */
export async function GET(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  try {
    const url = new URL(req.url);
    const phone = normalizePhone(url.searchParams.get('phone') ?? '');
    if (!phone) {
      return Response.json({ ok: false, error: 'phone_required' }, { status: 400 });
    }
    const rows = (await sql()`
      SELECT id, status, customer_name, items_json, subtotal_cents, tax_cents,
             total_cents, pos_order_number, created_at, updated_at
        FROM web_orders
       WHERE id = ${params.id} AND customer_phone = ${phone}
    `) as Array<{
      id: string;
      status: string;
      customer_name: string;
      items_json: unknown;
      subtotal_cents: number;
      tax_cents: number;
      total_cents: number;
      pos_order_number: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const row = rows[0];
    if (!row) {
      return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
    }
    return Response.json({
      ok: true,
      data: {
        id: row.id,
        status: row.status,
        customerName: row.customer_name,
        items: row.items_json,
        subtotalCents: row.subtotal_cents,
        taxCents: row.tax_cents,
        totalCents: row.total_cents,
        posOrderNumber: row.pos_order_number,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    });
  } catch (e) {
    console.error('GET /api/orders/[id] failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
