import { z } from 'zod';
import { sql } from '@/lib/db';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';
import {
  CHUNK_HASH_RE,
  FETCH_BATCH_STORED_BYTES,
  MAX_CHUNKS_PER_COPY,
  ensureBackupSchema,
} from '@/lib/backup-store';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;
export const maxDuration = 30;

const Schema = z.object({ hashes: z.array(z.string().regex(CHUNK_HASH_RE)).min(1).max(MAX_CHUNKS_PER_COPY) });

/**
 * Bridge: chunks of a cloud copy for a restore, as many (in the order asked)
 * as fit one response; `rest` is what to ask for next, `missing` is anything
 * not stored here. The POS re-checks every chunk's hash.
 */
export async function POST(req: Request): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    await ensureBackupSchema();
    const parsed = Schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'validation' }, { status: 400 });
    const hashes = [...new Set(parsed.data.hashes)];
    const sizes = (await sql()`
      SELECT hash, size_stored FROM pos_backup_chunks WHERE hash = ANY(${hashes}::text[])
    `) as Array<{ hash: string; size_stored: number }>;
    const sizeOf = new Map(sizes.map((r) => [r.hash, r.size_stored]));
    const missing = hashes.filter((h) => !sizeOf.has(h));
    const take: string[] = [];
    let bytes = 0;
    for (const h of hashes) {
      const size = sizeOf.get(h);
      if (size === undefined) continue;
      if (take.length > 0 && bytes + size > FETCH_BATCH_STORED_BYTES) break;
      take.push(h);
      bytes += size;
    }
    const rows = take.length
      ? ((await sql()`
          SELECT hash, encode(data, 'base64') AS data_base64
            FROM pos_backup_chunks WHERE hash = ANY(${take}::text[])
        `) as Array<{ hash: string; data_base64: string }>)
      : [];
    const taken = new Set(take);
    return Response.json({
      ok: true,
      data: {
        // Postgres wraps base64 at 76 columns.
        chunks: rows.map((r) => ({ hash: r.hash, dataBase64: r.data_base64.replace(/\s+/g, '') })),
        missing,
        rest: hashes.filter((h) => sizeOf.has(h) && !taken.has(h)),
      },
    });
  } catch (e) {
    console.error('POST /api/bridge/backup-chunks/fetch failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
