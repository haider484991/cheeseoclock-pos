import { sql } from '@/lib/db';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Bridge: download one backup blob (for cloud restore). */
export async function GET(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    const rows = (await sql()`
      SELECT id, file_name, size_bytes, data_base64, created_at
        FROM pos_backups WHERE id = ${params.id}
    `) as Array<{
      id: string;
      file_name: string;
      size_bytes: number;
      data_base64: string;
      created_at: string;
    }>;
    const row = rows[0];
    if (!row) {
      return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
    }
    return Response.json({
      ok: true,
      data: {
        id: row.id,
        fileName: row.file_name,
        sizeBytes: row.size_bytes,
        dataBase64: row.data_base64,
        createdAt: row.created_at,
      },
    });
  } catch (e) {
    console.error('GET /api/bridge/backups/[id] failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
