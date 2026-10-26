import type { PublishedMenu, PublishedMenuItem } from '@cheeseoclock/shared-types';
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

/**
 * The catalog's own photos for items the website shows without one (26 Oct 2026): the regular pizzas in the owner's
 * oven-baked style (the window posters' cut-outs, made from his photos: even golden crust, no char — the shop bakes
 * pan and thin crust, never wood-fired), the printed deal menus' cut-outs and the owner's own photos
 * (cheeseoclock-menu assets), keyed by the item's name (with its size, for the drinks) or its name without the size.
 * public/images/catalog/<slug>.jpg.
 */
const CATALOG_PHOTOS: Readonly<Record<string, string>> = {
  'fajita pizza': 'fajita-pizza',
  'classic supreme': 'classic-supreme',
  'malai supreme': 'malai-supreme',
  'classic pepperoni': 'classic-pepperoni',
  'chicken tikka pizza': 'chicken-tikka-pizza',
  'chicken tikka malai': 'chicken-tikka-malai',
  cheesalious: 'cheesalious',
  'veggie lovers': 'veggie-lovers',
  'classic crispy chicken': 'classic-crispy-chicken',
  'crispy signature': 'crispy-signature',
  'nashville authentic (hot)': 'nashville-authentic',
  fries: 'fries',
  'signature mayo masala fries': 'signature-mayo-masala-fries',
  // Gemini images (cheeseoclock-menu\catalog-ai, 26 Oct 2026): presentation only until there are real photos.
  'signature masala fries': 'signature-masala-fries',
  'signature loaded fries': 'signature-loaded-fries',
  nuggets: 'nuggets',
  'baked wings': 'baked-wings',
  'soft drink — 345 ml': 'soft-drink-345-ml',
  'soft drink — 1 litre': 'soft-drink-1-litre',
};

/** The item's photo as a catalog JPEG address — the website's, else the catalog's own; null when it has none. */
export function catalogPhotoFor(name: string): string | null {
  const base = splitSizedName(name).base;
  const web = dealPhotoFor(name) ?? shopPhotoFor(base);
  const m = web ? /\/images\/(?:deals|menu)\/([a-z0-9-]+)\.webp$/.exec(web) : null;
  const slug =
    m?.[1] ??
    CATALOG_PHOTOS[name.trim().toLowerCase()] ??
    CATALOG_PHOTOS[base.trim().toLowerCase()] ??
    // Every dip shares the dip cups' picture.
    (/\bdip$/i.test(base.trim()) ? 'dips' : undefined);
  return slug ? `${SITE_URL}/images/catalog/${slug}.jpg` : null;
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
