import { z } from 'zod';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';
import { CHUNK_HASH_RE, MAX_CHUNKS_PER_COPY, ensureBackupSchema, missingChunks } from '@/lib/backup-store';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;
export const maxDuration = 30;

const Schema = z.object({ hashes: z.array(z.string().regex(CHUNK_HASH_RE)).max(MAX_CHUNKS_PER_COPY) });

/** Bridge: which of these chunks does the site not have yet? (Only those get uploaded.) */
export async function POST(req: Request): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    await ensureBackupSchema();
    const parsed = Schema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ ok: false, error: 'validation' }, { status: 400 });
    const missing = await missingChunks([...new Set(parsed.data.hashes)]);
    return Response.json({ ok: true, data: { missing } });
  } catch (e) {
    console.error('POST /api/bridge/backup-chunks/missing failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
