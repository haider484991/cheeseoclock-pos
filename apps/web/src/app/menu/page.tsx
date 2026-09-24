import type { Metadata } from 'next';
import { readFile } from 'node:fs/promises';
import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { OrderingApp } from '@/components/OrderingApp';
import { BUSINESS } from '@/lib/business';
import { sql } from '@/lib/db';
import { JsonLd, menuNode, webPageNode } from '@/lib/seo';
import { getStoreStatus } from '@/lib/store-status';
import type { PublishedMenu } from '@cheeseoclock/shared-types';

export const metadata: Metadata = {
  title: 'Menu & Prices — Pizza, Burgers, Fries',
  description:
    "Full Cheese O'Clock menu with prices in PKR — five signature pizzas, regular pizzas in Medium 9\" and Large 12\", crispy chicken burgers, fries, wings and value deals. Cash on delivery across DHA & Clifton.",
  alternates: { canonical: '/menu' },
};

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

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
    return rows[0]?.menu_json ?? null;
  } catch (e) {
    console.error('menu load failed', e);
    return null;
  }
}

export default async function MenuPage() {
  const [menu, store] = await Promise.all([loadMenu(), getStoreStatus()]);
  const accepting = store.acceptingOrders;

  return (
    <>
      <SiteHeader />
      <main className="min-h-screen bg-paper text-ink">
        {menu ? (
          <OrderingApp menu={menu} acceptingOrders={accepting} />
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
              {BUSINESS.whatsappLines.map((l) => (
                <a
                  key={l.url}
                  href={`${l.url}?text=${encodeURIComponent("Hi Cheese O'Clock! I'd like to place an order: ")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-full bg-ink px-8 py-3.5 font-cond text-lg font-bold uppercase tracking-wide text-cheese transition-transform hover:scale-105"
                >
                  WhatsApp {l.display}
                </a>
              ))}
            </div>
            <p className="mt-4 text-sm text-ink-muted">{BUSINESS.hours}</p>
          </div>
        )}
      </main>
      <SiteFooter />
      <JsonLd
        nodes={[
          ...webPageNode({
            path: '/menu',
            name: "Cheese O'Clock Menu & Prices",
            description:
              'Full menu with prices in PKR — signature and regular pizzas, crispy chicken burgers, fries, wings and value deals, delivered across DHA & Clifton.',
            breadcrumb: [
              { name: 'Home', path: '/' },
              { name: 'Menu', path: '/menu' },
            ],
          }),
          ...(menu ? [menuNode(menu)] : []),
        ]}
      />
    </>
  );
}
