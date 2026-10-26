import type { PublishedMenu } from '@cheeseoclock/shared-types';
import { sql } from '@/lib/db';
import { factsFromBlock } from '@/lib/delivery-facts';
import { catalogCsv, catalogRows } from '@/lib/meta-catalog';
import { menuWithoutDrinkBrand } from '@/lib/menu-view';
import { withDealsForSale } from '@/lib/public-menu';
import { getShopFacts, parseStoredSettings } from '@/lib/site-facts';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

/**
 * GET /api/meta/catalog — the shop's Meta product feed (lib/meta-catalog), as CSV: Meta fetches it every day for the
 * WhatsApp catalog. Prices are public, so the feed is too.
 */
export async function GET(): Promise<Response> {
  try {
    const rows = (await sql()`SELECT menu_json FROM site_menu WHERE id = 1`) as Array<{ menu_json: PublishedMenu }>;
    const stored = rows[0]?.menu_json;
    if (!stored) return new Response('menu not published', { status: 404 });
    const facts = factsFromBlock(parseStoredSettings(stored.settings ?? null));
    const menu = withDealsForSale(menuWithoutDrinkBrand(stored), facts.buy1Get1);
    const shop = await getShopFacts();
    return new Response(catalogCsv(catalogRows(menu, shop.profile.name)), {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store' },
    });
  } catch (e) {
    console.error('GET /api/meta/catalog failed', e);
    return new Response('error', { status: 500 });
  }
}
