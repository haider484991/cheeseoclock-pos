import type { Metadata } from 'next';
import { readFile } from 'node:fs/promises';
import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { OrderingApp } from '@/components/OrderingApp';
import { sql } from '@/lib/db';
import { copyText, factsFromBlock } from '@/lib/delivery-facts';
import { MENU_DESCRIPTION, MENU_PAGE_NAME } from '@/lib/page-copy';
import { JsonLd, menuNode, webPageNode } from '@/lib/seo';
import { getStoreStatus } from '@/lib/store-status';
import { publicMenu, withDealsForSale } from '@/lib/public-menu';
import { lineOrderUrl, shopFactsFromBlock, shopHoursLine, whatsappLinesOf } from '@/lib/shop-facts';
import { getShopFacts, parseStoredSettings, parseStoredShop, requireStoredFacts } from '@/lib/site-facts';
import { closedNoticeInForce, type PublishedMenu } from '@cheeseoclock/shared-types';

/** The description names the shop (the owner's name; today's with none stored). */
export async function generateMetadata(): Promise<Metadata> {
  const shop = await getShopFacts();
  return {
    title: 'Menu & Prices — Pizza, Burgers, Fries',
    description: copyText(MENU_DESCRIPTION, { ...factsFromBlock(null), shop }),
    alternates: { canonical: '/menu' },
  };
}

/**
 * Kept by Next and the CDN (ISR), like the home page (24 Oct 2026: "the website's API is so slow" — rendered
 * on every visit, /menu took 1.3–2.6 s from Karachi). A till's publish refreshes it at once (api/bridge/menu
 * revalidates every page), and otherwise it is at most a minute old: whether the kitchen is taking orders, the
 * pick-up % and the closed notice are asked again by the page itself as soon as it opens (OrderingApp), and the
 * checkout checks them on the server whatever the page showed.
 */
export const dynamic = 'force-static';
export const revalidate = 60;

/**
 * Local preview only: `next dev` with DEV_MENU_FILE pointing at a published-
 * menu JSON renders that menu without a database (DEV_ACCEPTING_ORDERS=1 opens
 * the checkout — see lib/store-status). Ignored in production builds.
 */
const devMenuFile =
  process.env.NODE_ENV === 'development' ? process.env['DEV_MENU_FILE'] : undefined;

async function loadMenu(): Promise<PublishedMenu | null> {
  if (devMenuFile) {
    return JSON.parse(await readFile(devMenuFile, 'utf8')) as PublishedMenu;
  }
  try {
    const rows = (await sql()`
      SELECT menu_json FROM site_menu WHERE id = 1
    `) as Array<{ menu_json: PublishedMenu }>;
    // As stored: the page sends the browser publicMenu of it (no drink brand, no device id or stamps).
    return rows[0]?.menu_json ?? null;
  } catch (e) {
    console.error('menu load failed', e);
    // A kept page must not keep "Menu coming right up" for a minute because one read failed: throwing leaves the
    // last good page in place (site-facts requireStoredFacts). No database at all (a build without one): the
    // page's own words, as before, until the first heartbeat refreshes it.
    if (process.env['DATABASE_URL']) throw e;
    return null;
  }
}

export default async function MenuPage() {
  // As the other kept pages: the database unreadable with nothing read yet keeps the last good page.
  await requireStoredFacts();
  const [menu, store] = await Promise.all([loadMenu(), getStoreStatus()]);
  const accepting = store.acceptingOrders;
  const pickupAvailable = store.pickupAvailable;
  const pickupDiscountPercent = store.pickupDiscountPercent;
  // v0.7.37: the owner's % off a delivery's food (0 = none, as before).
  const deliveryDiscountPercent = store.deliveryDiscountPercent;
  // Where the owner delivers and what it costs: the settings block that came
  // with this menu, else the built-in areas (as before any block).
  const block = parseStoredSettings(menu?.settings ?? null);
  const deliveryFacts = factsFromBlock(block);
  // The owner's closed notice as it stands at this render (the page asks again as it opens, so its last day
  // ends on time). null = the page's own closed words, as before.
  const closedNotice = closedNoticeInForce(block?.closedNotice, Date.now());
  // Sent whole to the browser: the block's areas and pick-up only, never its device id or stamps — and no Buy 1 Get 1
  // deal while the owner has them switched off.
  const shown = menu ? withDealsForSale(publicMenu(menu), deliveryFacts.buy1Get1) : null;
  // The shop's details from the row this page read (sweep B2 + B4) — never the shop block's stamps
  // or device id; with no menu, the pages' own read (today's details with none stored).
  const shop = menu ? shopFactsFromBlock(parseStoredShop(menu.shop ?? null)) : await getShopFacts();

  return (
    <>
      <SiteHeader />
      <main className="min-h-screen bg-paper text-ink">
        {shown ? (
          <OrderingApp
            menu={shown}
            acceptingOrders={accepting}
            pickupAvailable={pickupAvailable}
            pickupDiscountPercent={pickupDiscountPercent}
            deliveryDiscountPercent={deliveryDiscountPercent}
            pickupCategoryPercents={store.pickupCategoryPercents}
            deliveryCategoryPercents={store.deliveryCategoryPercents}
            deliveryFacts={deliveryFacts}
            closedNotice={closedNotice}
            shop={shop}
          />
        ) : (
          <div className="mx-auto max-w-md px-4 py-24 text-center">
            <h1 className="font-display text-5xl uppercase tracking-wide text-ink">
              Menu coming right up
            </h1>
            <p className="mt-3 text-ink-muted">
              We&rsquo;re still loading today&rsquo;s menu. In the meantime, order
              directly on WhatsApp — we reply fast.
            </p>
            <div className="mt-6 flex flex-col items-center gap-2">
              {whatsappLinesOf(shop).map((l) => (
                <a
                  key={l.url}
                  href={lineOrderUrl(shop, l)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-full bg-ink px-8 py-3.5 font-cond text-lg font-bold uppercase tracking-wide text-cheese transition-transform hover:scale-105"
                >
                  WhatsApp {l.display}
                </a>
              ))}
            </div>
            <p className="mt-4 text-sm text-ink-muted">{shopHoursLine(shop)}</p>
          </div>
        )}
      </main>
      <SiteFooter />
      <JsonLd
        nodes={[
          ...webPageNode({
            path: '/menu',
            name: copyText(MENU_PAGE_NAME, { ...deliveryFacts, shop }),
            description:
              'Full menu with prices in PKR — signature and regular pizzas, crispy chicken burgers, fries, wings and value deals, delivered across DHA & Clifton.',
            breadcrumb: [
              { name: 'Home', path: '/' },
              { name: 'Menu', path: '/menu' },
            ],
          }),
          ...(shown ? [menuNode(shown, shop)] : []),
        ]}
      />
    </>
  );
}
