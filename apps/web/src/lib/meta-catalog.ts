import type { PublishedMenu, PublishedMenuItem } from '@cheeseoclock/shared-types';
import { formatCents } from './format';
import { dealPhotoFor, dealPhotoKey, shopPhotoFor, splitSizedName } from './menu-view';
import { SITE_URL } from './seo';

/**
 * The shop's Meta catalog (26 Oct 2026, the user: "the menu with photos inside WhatsApp"): the menu items that have a
 * shop photo — the deals and the signature pizzas and burger, as the website shows them (menu-view dealPhotoFor,
 * shopPhotoFor) — as a Meta product feed. Meta fetches it every day (api/meta/catalog), so prices follow the till; the
 * catalog is shown in WhatsApp, and a customer's cart from it comes to the ordering bot (lib/whatsapp-bot), which asks
 * each deal's choices. Items without a photo stay orderable through the bot's menu list.
 *
 * The photos are JPEG copies of the website's (public/images/catalog, square, on the cards' dark colour).
 */
export interface CatalogRow {
  id: string;
  title: string;
  description: string;
  availability: 'in stock';
  condition: 'new';
  price: string;
  link: string;
  image_link: string;
  brand: string;
}

/** The website photo for an item, as a catalog JPEG address; null when it has none. */
export function catalogPhotoFor(name: string): string | null {
  const web = dealPhotoFor(name) ?? shopPhotoFor(splitSizedName(name).base);
  const m = web ? /\/images\/(?:deals|menu)\/([a-z0-9-]+)\.webp$/.exec(web) : null;
  return m ? `${SITE_URL}/images/catalog/${m[1]}.jpg` : null;
}

function describe(item: PublishedMenuItem, category: string): string {
  const own = item.description?.replace(/\s+/g, ' ').trim();
  const tax = item.taxIncluded ? 'Tax included.' : 'Plus tax.';
  return `${own ? `${own} ` : ''}${category}. ${tax} Order on WhatsApp: send "menu".`.slice(0, 5000);
}

/** The feed's rows: one per menu item with a shop photo, priced as the till publishes it. */
export function catalogRows(menu: Pick<PublishedMenu, 'categories'>, brand: string): CatalogRow[] {
  const rows: CatalogRow[] = [];
  for (const c of menu.categories) {
    if (/delivery charge/i.test(c.name)) continue;
    for (const item of c.items) {
      const image = catalogPhotoFor(item.name);
      if (!image || !(item.basePriceCents > 0)) continue;
      rows.push({
        id: item.posItemId,
        title: item.name.slice(0, 150),
        description: describe(item, c.name),
        availability: 'in stock',
        condition: 'new',
        price: `${(item.basePriceCents / 100).toFixed(2)} PKR`,
        link: `${SITE_URL}/menu?deal=${encodeURIComponent(dealPhotoKey(item.name).replace(/ /g, '-'))}`,
        image_link: image,
        brand,
      });
    }
  }
  return rows;
}

const COLUMNS: ReadonlyArray<keyof CatalogRow> = ['id', 'title', 'description', 'availability', 'condition', 'price', 'link', 'image_link', 'brand'];

/** The rows as Meta's CSV feed (RFC 4180 quoting). */
export function catalogCsv(rows: readonly CatalogRow[]): string {
  const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((k) => cell(r[k])).join(','))].join('\n') + '\n';
}

/** "Rs 4,800" for a row's price, for the bot and the tests. */
export function rowPriceWords(row: CatalogRow): string {
  return formatCents(Math.round(Number(row.price.split(' ')[0]) * 100));
}
