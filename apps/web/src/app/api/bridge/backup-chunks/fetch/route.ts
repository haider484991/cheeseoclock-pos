import { z } from 'zod';
import { sql } from '@/lib/db';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';
import { backupObjects } from '@/lib/backup-objects';
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
 * not stored here. The POS re-checks every chunk's hash. With a Blob store the
 * chunks come from there first; a copy made before it (its chunks still in the
 * database) is read from the database, while the database answers.
 */
export async function POST(req: Request): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    const parsed = Schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'validation' }, { status: 400 });
    const hashes = [...new Set(parsed.data.hashes)];
    const objects = backupObjects();
    const inBlob = objects ? await objects.chunks() : new Map();
    const notInBlob = hashes.filter((h) => !inBlob.has(h));
    let dbSize = new Map<string, number>();
    if (notInBlob.length > 0) {
      try {
        await ensureBackupSchema();
        const sizes = (await sql()`
          SELECT hash, size_stored FROM pos_backup_chunks WHERE hash = ANY(${notInBlob}::text[])
        `) as Array<{ hash: string; size_stored: number }>;
        dbSize = new Map(sizes.map((r) => [r.hash, r.size_stored]));
      } catch (e) {
        // No Blob store: the database is the only place, so its failure is the answer. With one, a database
        // that does not answer only hides the copies made before the store.
        if (!objects) throw e;
        console.warn('backup-chunks/fetch: the database did not answer; serving the Blob store only', e);
      }
    }
    const sizeOf = (h: string): number | undefined => inBlob.get(h)?.storedBytes ?? dbSize.get(h);
    const missing = hashes.filter((h) => sizeOf(h) === undefined);
    const take: string[] = [];
    let bytes = 0;
    for (const h of hashes) {
      const size = sizeOf(h);
      if (size === undefined) continue;
      if (take.length > 0 && bytes + size > FETCH_BATCH_STORED_BYTES) break;
      take.push(h);
      bytes += size;
    }
    const chunks: Array<{ hash: string; dataBase64: string }> = [];
    const fromDb = take.filter((h) => !inBlob.has(h));
    for (const h of take) {
      const c = inBlob.get(h);
      if (!c || !objects) continue;
      const gz = await objects.getChunk(c);
      if (gz) chunks.push({ hash: h, dataBase64: gz.toString('base64') });
    }
    if (fromDb.length > 0) {
      const rows = (await sql()`
        SELECT hash, encode(data, 'base64') AS data_base64
          FROM pos_backup_chunks WHERE hash = ANY(${fromDb}::text[])
      `) as Array<{ hash: string; data_base64: string }>;
      // Postgres wraps base64 at 76 columns.
      for (const r of rows) chunks.push({ hash: r.hash, dataBase64: r.data_base64.replace(/\s+/g, '') });
    }
    const taken = new Set(take);
    return Response.json({
      ok: true,
      data: {
        chunks,
        missing,
        rest: hashes.filter((h) => sizeOf(h) !== undefined && !taken.has(h)),
      },
    });
  } catch (e) {
    console.error('POST /api/bridge/backup-chunks/fetch failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
