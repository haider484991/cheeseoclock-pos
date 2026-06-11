import { sql } from '@/lib/db';
import type { PublishedMenu } from '@cheeseoclock/shared-types';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

/** Public: the currently-published menu (or 404 until the POS publishes). */
export async function GET(): Promise<Response> {
  try {
    const rows = (await sql()`
      SELECT menu_json, published_at FROM site_menu WHERE id = 1
    `) as Array<{ menu_json: PublishedMenu; published_at: string }>;
    const row = rows[0];
    if (!row) {
      return Response.json(
        { ok: false, error: 'menu_not_published' },
        { status: 404 },
      );
    }
    return Response.json(
      { ok: true, data: row.menu_json },
      // Cache at the CDN for 60s — menu changes are infrequent and the POS
      // republish simply overwrites; a stale minute is fine.
      { headers: { 'Cache-Control': 's-maxage=60, stale-while-revalidate=300' } },
    );
  } catch (e) {
    console.error('GET /api/menu failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
