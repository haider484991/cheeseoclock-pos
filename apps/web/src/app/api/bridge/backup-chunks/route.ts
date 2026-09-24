import { z } from 'zod';
import { sql } from '@/lib/db';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';
import {
  CHUNK_HASH_RE,
  MAX_CHUNK_BASE64_CHARS,
  MAX_UPLOAD_BATCH_BASE64_CHARS,
  checkChunk,
  ensureBackupSchema,
} from '@/lib/backup-store';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;
export const maxDuration = 30;

const BatchSchema = z.object({
  chunks: z
    .array(
      z.object({
        hash: z.string().regex(CHUNK_HASH_RE),
        /** gzip of the raw chunk bytes, base64. */
        dataBase64: z.string().min(1).max(MAX_CHUNK_BASE64_CHARS),
      }),
    )
    .min(1)
    .max(2_000)
    .refine((cs) => cs.reduce((n, c) => n + c.dataBase64.length, 0) <= MAX_UPLOAD_BATCH_BASE64_CHARS, {
      message: 'batch too large',
    }),
});

/**
 * Bridge: store a batch of chunks of a cloud copy. Every chunk is verified
 * against its name before anything is kept; storing a chunk that is already
 * here is a no-op. One bad chunk rejects the whole batch.
 */
export async function POST(req: Request): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    await ensureBackupSchema();
    const parsed = BatchSchema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'validation' }, { status: 400 });
    const checked = [];
    for (const c of parsed.data.chunks) {
      const check = checkChunk(c.hash, c.dataBase64);
      if (!check.ok) {
        return Response.json(
          { ok: false, error: check.error, message: 'A chunk arrived damaged; try again.', hash: c.hash },
          { status: 400 },
        );
      }
      checked.push({ ...c, rawBytes: check.rawBytes, storedBytes: check.gz.length });
    }
    for (const c of checked) {
      await sql()`
        INSERT INTO pos_backup_chunks (hash, size_raw, size_stored, data)
        VALUES (${c.hash}, ${c.rawBytes}, ${c.storedBytes}, decode(${c.dataBase64}, 'base64'))
        ON CONFLICT (hash) DO UPDATE SET last_used_at = now()
      `;
    }
    return Response.json({ ok: true, data: { stored: checked.length } });
  } catch (e) {
    console.error('POST /api/bridge/backup-chunks failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
