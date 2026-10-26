import { z } from 'zod';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';
import { noStore } from '@/lib/menu-deploy-auth';
import { WEBSITE_COPY_FORMAT, copyTable, restoreRows } from '@/lib/website-copy';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;
export const maxDuration = 30;

/** One batch of one table, under the host's 4.5 MB body limit (the till sends ≤ 1 MB: website-copy-client.ts). */
const BodySchema = z.object({
  format: z.literal(WEBSITE_COPY_FORMAT),
  table: z.string().min(1).max(64),
  rows: z.array(z.record(z.unknown())).max(5_000),
});

/**
 * Bridge: put a batch of the till's copy of the website's data back (lib/website-copy.ts). Only rows the database
 * does not have go in — never over a newer one — so a restore is safe on a database that has carried on since.
 * POST { format, table, rows } → { ok, data: { inserted } }.
 */
export async function POST(req: Request): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) return noStore({ ok: false, error: 'validation' }, 400);
    const table = copyTable(parsed.data.table);
    if (!table) return noStore({ ok: false, error: 'validation', message: 'Not a table the copy carries.' }, 400);
    return noStore({ ok: true, data: await restoreRows(table, parsed.data.rows) });
  } catch (e) {
    console.error('POST /api/bridge/website-copy/restore failed', e);
    return noStore({ ok: false, error: 'internal' }, 500);
  }
}
