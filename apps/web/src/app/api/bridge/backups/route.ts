import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { sql } from '@/lib/db';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Keep only the newest N backups per device — bounds Neon storage. */
const KEEP_PER_DEVICE = 8;
/** ~3MB binary after gzip → ~4MB base64, inside Vercel's 4.5MB body limit. */
const MAX_BASE64_CHARS = 4_000_000;

const UploadSchema = z.object({
  deviceId: z.string().min(1),
  fileName: z.string().min(1).max(200),
  /** gzipped SQLite file, base64-encoded. */
  dataBase64: z.string().min(1).max(MAX_BASE64_CHARS),
});

/** Bridge: POS uploads a database backup. Rotates old ones in the same call. */
export async function POST(req: Request): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    const parsed = UploadSchema.safeParse(await req.json());
    if (!parsed.success) {
      const tooBig = parsed.error.errors.some((e) => e.code === 'too_big');
      return Response.json(
        {
          ok: false,
          error: tooBig ? 'backup_too_large' : 'validation',
          ...(tooBig
            ? { message: 'Backup exceeds the 3MB cloud limit — keep using local backups and contact support.' }
            : {}),
        },
        { status: 400 },
      );
    }
    const { deviceId, fileName, dataBase64 } = parsed.data;
    const sizeBytes = Math.floor((dataBase64.length * 3) / 4);
    const id = uuidv7();

    await sql()`
      INSERT INTO pos_backups (id, device_id, file_name, size_bytes, data_base64)
      VALUES (${id}, ${deviceId}, ${fileName}, ${sizeBytes}, ${dataBase64})
    `;
    // Rotate: delete everything older than the newest KEEP_PER_DEVICE.
    await sql()`
      DELETE FROM pos_backups
       WHERE device_id = ${deviceId}
         AND id NOT IN (
           SELECT id FROM pos_backups
            WHERE device_id = ${deviceId}
            ORDER BY created_at DESC
            LIMIT ${KEEP_PER_DEVICE}
         )
    `;
    return Response.json({ ok: true, data: { id, sizeBytes } });
  } catch (e) {
    console.error('POST /api/bridge/backups failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}

/** Bridge: list backups for a device (metadata only — no blobs). */
export async function GET(req: Request): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    const url = new URL(req.url);
    const deviceId = url.searchParams.get('deviceId') ?? '';
    const rows = (await sql()`
      SELECT id, file_name, size_bytes, created_at
        FROM pos_backups
       WHERE device_id = ${deviceId}
       ORDER BY created_at DESC
    `) as Array<{
      id: string;
      file_name: string;
      size_bytes: number;
      created_at: string;
    }>;
    return Response.json({
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        fileName: r.file_name,
        sizeBytes: r.size_bytes,
        createdAt: r.created_at,
      })),
    });
  } catch (e) {
    console.error('GET /api/bridge/backups failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
