import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';
import { noStore } from '@/lib/menu-deploy-auth';
import { copyTable, websiteCopyManifest, websiteCopyPage } from '@/lib/website-copy';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;
export const maxDuration = 30;

/**
 * Bridge: the website's own data for the till's nightly copy (lib/website-copy.ts).
 *
 * GET → { ok, data: CopyManifest }: this website's identity and each table's row count.
 * GET ?table=<name>&offset=<n> → { ok, data: { rows, next } }: one page of a table in key order; next = the offset of
 *   the next page, null at the end. Only the tables the copy carries.
 *
 * The bridge secret only: the rows include the phone dashboard's sign-ins and the customers' orders.
 */
export async function GET(req: Request): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    const url = new URL(req.url);
    const name = url.searchParams.get('table');
    if (name === null) return noStore({ ok: true, data: await websiteCopyManifest() });
    const table = copyTable(name);
    const offset = Number(url.searchParams.get('offset') ?? '0');
    if (!table || !Number.isInteger(offset) || offset < 0) return noStore({ ok: false, error: 'validation' }, 400);
    return noStore({ ok: true, data: await websiteCopyPage(table, offset) });
  } catch (e) {
    console.error('GET /api/bridge/website-copy failed', e);
    return noStore({ ok: false, error: 'internal' }, 500);
  }
}
