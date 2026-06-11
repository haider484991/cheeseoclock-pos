import { z } from 'zod';
import { sql } from '@/lib/db';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';

export const dynamic = 'force-dynamic';

const AckSchema = z.object({
  posOrderId: z.string().min(1),
  posOrderNumber: z.string().min(1),
});

/**
 * Bridge: POS confirms it imported the order. Flips 'new' → 'accepted' and
 * records the POS order id/number. The WHERE status='new' guard makes the
 * ack idempotent — a retry after a half-failed poll can't double-import
 * (the POS also dedupes by web order id on its side).
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    const parsed = AckSchema.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json({ ok: false, error: 'validation' }, { status: 400 });
    }
    const rows = (await sql()`
      UPDATE web_orders
         SET status = 'accepted',
             pos_order_id = ${parsed.data.posOrderId},
             pos_order_number = ${parsed.data.posOrderNumber},
             updated_at = now()
       WHERE id = ${params.id} AND status = 'new'
       RETURNING id
    `) as Array<{ id: string }>;
    return Response.json({ ok: true, data: { acked: rows.length === 1 } });
  } catch (e) {
    console.error('POST /api/bridge/orders/[id]/ack failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
