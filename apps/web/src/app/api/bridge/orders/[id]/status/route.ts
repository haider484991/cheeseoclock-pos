import { z } from 'zod';
import { sql } from '@/lib/db';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';

export const dynamic = 'force-dynamic';

const StatusSchema = z.object({
  status: z.enum([
    'accepted',
    'preparing',
    'ready',
    'out_for_delivery',
    'delivered',
    'cancelled',
  ]),
});

/** Bridge: POS pushes a status change so the customer's tracking page updates. */
export async function POST(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    const parsed = StatusSchema.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json({ ok: false, error: 'validation' }, { status: 400 });
    }
    const rows = (await sql()`
      UPDATE web_orders
         SET status = ${parsed.data.status}, updated_at = now()
       WHERE id = ${params.id}
       RETURNING id
    `) as Array<{ id: string }>;
    if (rows.length === 0) {
      return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
    }
    return Response.json({ ok: true, data: { updated: true } });
  } catch (e) {
    console.error('POST /api/bridge/orders/[id]/status failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
