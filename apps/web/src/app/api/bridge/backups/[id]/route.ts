import { sql } from '@/lib/db';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';
import { ensureBackupSchema } from '@/lib/backup-store';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const maxDuration = 30;

/**
 * Bridge: download one backup (for cloud restore), with the checksum the
 * server recorded at upload so the POS can refuse a damaged or altered copy.
 * A one-blob copy comes back as dataBase64 (sha256 of the gzip); a chunked
 * copy as its chunk list (sha256 of the raw file) — the POS then fetches the
 * chunks from /api/bridge/backup-chunks/[hash].
 */
export async function GET(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    await ensureBackupSchema();
    const rows = (await sql()`
      SELECT id, device_id, file_name, size_bytes, data_base64, created_at,
             sha256, meta_json, format, chunk_hashes
        FROM pos_backups WHERE id = ${params.id}
    `) as Array<{
      id: string;
      device_id: string;
      file_name: string;
      size_bytes: number;
      data_base64: string | null;
      created_at: string;
      sha256: string | null;
      meta_json: Record<string, unknown> | null;
      format: string | null;
      chunk_hashes: string[] | null;
    }>;
    const row = rows[0];
    if (!row) {
      return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
    }
    return Response.json({
      ok: true,
      data: {
        id: row.id,
        deviceId: row.device_id,
        fileName: row.file_name,
        sizeBytes: row.size_bytes,
        dataBase64: row.data_base64,
        format: row.format ?? 'blob',
        chunks: row.chunk_hashes,
        createdAt: row.created_at,
        sha256: row.sha256,
        meta: row.meta_json,
      },
    });
  } catch (e) {
    console.error('GET /api/bridge/backups/[id] failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
