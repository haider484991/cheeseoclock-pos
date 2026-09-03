import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { sql } from '@/lib/db';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';
import { selectBackupsToDelete } from '@/lib/backup-retention';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;
export const maxDuration = 30;

/** ~3MB binary after gzip → ~4MB base64, inside Vercel's 4.5MB body limit. */
const MAX_BASE64_CHARS = 4_000_000;

const UploadSchema = z.object({
  deviceId: z.string().min(1),
  fileName: z.string().min(1).max(200),
  /** gzipped SQLite file, base64-encoded. */
  dataBase64: z.string().min(1).max(MAX_BASE64_CHARS),
  /** SHA-256 of the gzip bytes as the POS computed it; must match what arrives. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** What the copy says about itself (device name, order count, audit chain head…). */
  meta: z.record(z.unknown()).optional(),
});

/**
 * Columns added after launch. Idempotent and run once per server instance,
 * so nobody has to run a migration by hand against the production database.
 */
let columnsReady: Promise<void> | null = null;
function ensureColumns(): Promise<void> {
  if (!columnsReady) {
    columnsReady = (async () => {
      await sql()`ALTER TABLE pos_backups ADD COLUMN IF NOT EXISTS sha256 TEXT`;
      await sql()`ALTER TABLE pos_backups ADD COLUMN IF NOT EXISTS meta_json JSONB`;
    })().catch((e) => {
      columnsReady = null;
      throw e;
    });
  }
  return columnsReady;
}

/**
 * Bridge: POS uploads a database backup. The server records its own SHA-256
 * of the bytes and its own clock for created_at; there is no endpoint to
 * modify or delete a copy, and rotation follows a policy a burst of uploads
 * cannot game (see lib/backup-retention.ts).
 */
export async function POST(req: Request): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    await ensureColumns();
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
    const { deviceId, fileName, dataBase64, meta } = parsed.data;
    const bytes = Buffer.from(dataBase64, 'base64');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (parsed.data.sha256 && parsed.data.sha256 !== digest) {
      return Response.json(
        { ok: false, error: 'checksum_mismatch', message: 'The upload arrived damaged; try again.' },
        { status: 400 },
      );
    }
    const id = uuidv7();
    const metaJson = JSON.stringify(meta ?? null);

    await sql()`
      INSERT INTO pos_backups (id, device_id, file_name, size_bytes, data_base64, sha256, meta_json)
      VALUES (${id}, ${deviceId}, ${fileName}, ${bytes.length}, ${dataBase64}, ${digest}, ${metaJson}::jsonb)
    `;

    const rows = (await sql()`
      SELECT id, created_at, meta_json->>'reason' AS reason
        FROM pos_backups
       WHERE device_id = ${deviceId}
    `) as Array<{ id: string; created_at: string; reason: string | null }>;
    const toDelete = selectBackupsToDelete(
      rows.map((r) => ({ id: r.id, createdAt: r.created_at, reason: r.reason })),
    );
    if (toDelete.length > 0) {
      await sql()`
        DELETE FROM pos_backups
         WHERE device_id = ${deviceId} AND id = ANY(${toDelete}::uuid[])
      `;
    }
    return Response.json({ ok: true, data: { id, sizeBytes: bytes.length, sha256: digest } });
  } catch (e) {
    console.error('POST /api/bridge/backups failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}

/**
 * Bridge: list every copy the site holds, from every till (metadata only — no
 * blobs). A reinstalled PC has a new device id and would otherwise never see
 * the copies its predecessor made.
 */
export async function GET(req: Request): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    await ensureColumns();
    const rows = (await sql()`
      SELECT id, device_id, file_name, size_bytes, created_at, sha256, meta_json
        FROM pos_backups
       ORDER BY created_at DESC
       LIMIT 200
    `) as Array<{
      id: string;
      device_id: string;
      file_name: string;
      size_bytes: number;
      created_at: string;
      sha256: string | null;
      meta_json: Record<string, unknown> | null;
    }>;
    return Response.json({
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        deviceId: r.device_id,
        fileName: r.file_name,
        sizeBytes: r.size_bytes,
        createdAt: r.created_at,
        sha256: r.sha256,
        meta: r.meta_json,
      })),
    });
  } catch (e) {
    console.error('GET /api/bridge/backups failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
